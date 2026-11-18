/**
 * @fileoverview Task #4620 — Laya 自托管决策服务的 DecisionPort 实现
 *
 * 背景：#4467 的 decision 检测最初接的是阿里百炼的 systemone（`ali-decision`
 * provider）。#4614 把一个 Laya 微调模型训到严格 held-out 81.8%，本文件把它
 * 封装成**标准 Jev 语义服务**后接进同一套 `DecisionPort` 抽象。
 *
 * ── 协议对照（与阿里百炼 systemone 同构，服务端实测） ────────────────────────
 *
 * | 维度           | 阿里百炼 systemone            | Laya laya-serve            |
 * |----------------|-------------------------------|----------------------------|
 * | 请求 URL       | baseURL 本身就是请求地址       | `{baseURL}/v1/systemone`   |
 * | 请求体顶层键   | state / questions              | state / questions          |
 * | body.model     | decision-model-preview         | task-decision              |
 * | 鉴权 header    | Authorization: Bearer <key>    | Authorization: Bearer <key>|
 * | 响应 answers   | { qid: {choice, confidence,     | 同构 + 额外字段             |
 * |                |   probabilities} }             |   x_jev_confidence         |
 * |                |                               |   answer_confidence        |
 * |                |                               |   action.act_probability   |
 * | usage          | { input_tokens }               | { input_tokens,            |
 * |                |                               |   state_tokens,            |
 * |                |                               |   state_tokens_dropped,    |
 * |                |                               |   truncated, ... }         |
 * | routing        | 无                            | { model, repo }            |
 *
 * ⚠️ **confidence 语义陷阱（#302）**：laya 返回两个置信度：
 *   - `confidence`         = 归一化熵（不是 Jev 公式置信度）
 *   - `x_jev_confidence`   = Jev 公式算出的置信度
 *   按 laya 源码注释，**从 Jev 移植阈值的客户端应读 `x_jev_confidence`**。
 *   本 port 默认用 `x_jev_confidence`，缺失时回退 `answer_confidence` → `confidence`。
 *   用 `confidencePref` 可强制指定来源（便于 A/B 对比）。
 *
 * ⚠️ **state 截断**：laya 的 usage 会报 `state_tokens_dropped` / `truncated`。
 *   本 port **不静默吞掉**这个信号 —— 它把 `truncated` 抬到 answer 的 `truncated`
 *   字段上，让调用方（插件）能降级或记录。截断意味着候选描述被部分丢弃，
 *   模型的判别力会下降，属于**必须观测**的状态。
 *
 * ── 与 `SystemOneDecisionPort` 的关系 ──────────────────────────────────────
 *
 * 二者实现同一套超时 / 熔断 / 泄漏断言语义，但：
 *   - SystemOne: baseURL **就是**请求地址；响应无 x_jev_confidence
 *   Laya:       baseURL 是**服务根**，请求地址是 `{baseURL}/v1/systemone`；
 *               多一层 x_jev_confidence 的解析与截断信号
 * 抽出一个共用的基类会引入"URL 拼不拼"的分支混乱，所以这里独立实现，
 * 共享的纯逻辑（超时判定、熔断计数）保持一致的语义约定。
 */

import { assertNoLeakage } from "../hooks/verdict";
import type { DecisionPort, DecisionRequest, DecisionResponse } from "./decision-port";

/** laya 的 answers 里多出来的字段（父接口只声明了 choice/confidence/probabilities） */
export interface LayaDecisionAnswer {
  choice: string;
  confidence: number;
  /** Jev 公式置信度 —— #302：从 Jev 移植阈值的客户端应读这个 */
  x_jev_confidence?: number;
  /** 温度缩放后的答案置信度 */
  answer_confidence?: number;
  probabilities?: Record<string, number>;
  action?: { act_probability?: number };
  /** laya 报 state 被截断时为 true —— 本 port 从 usage 抬升上来 */
  truncated?: boolean;
}

export interface LayaDecisionResponse extends DecisionResponse {
  answers: Record<string, LayaDecisionAnswer>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    state_tokens?: number;
    state_tokens_dropped?: number;
    truncated?: boolean;
    truncated_questions?: string[];
  };
  routing?: { model?: string; repo?: string };
}

export interface LayaDecisionPortOptions {
  /** 服务根地址，例如 http://127.0.0.1:8901（**不带** /v1/systemone） */
  baseURL: string;
  apiKey: string;
  /** 注册在服务上的模型名（默认 task-decision） */
  model?: string;
  /** 硬超时（默认 2000ms） */
  timeoutMs?: number;
  /** 连续超时多少次后自我禁用（默认 3） */
  maxStrikes?: number;
  /** 注入 fetch（测试用） */
  fetchImpl?: typeof globalThis.fetch;
  /**
   * 置信度来源：auto（默认，优先 x_jev_confidence）/ jev / entropy
   * - auto：x_jev_confidence → answer_confidence → confidence
   * - jev：只用 x_jev_confidence（缺失则视为 0）
   * - entropy：只用 confidence（归一化熵）
   */
  confidencePref?: "auto" | "jev" | "entropy";
}

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_MAX_STRIKES = 3;
const DEFAULT_MODEL = "task-decision";
/** CV MINOR-3（DS 复审 v4）：goal 用途的兜底模型必须是 completion 侧 ——
 *  若 laya-goal-decision 条目漏写 model，用 task-decision 会让
 *  completion hook 静默跑成 create 侧模型（v3-tags）。 */
const DEFAULT_GOAL_MODEL = "task-completion";
/** laya 的 systemone 路径 */
const SYSTEMONE_PATH = "/v1/systemone";

export class LayaDecisionPort implements DecisionPort {
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxStrikes: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly confidencePref: "auto" | "jev" | "entropy";

  /** 同 session 连续超时计数 */
  private timeoutStrikes = 0;
  private disabled = false;

  constructor(options: LayaDecisionPortOptions) {
    this.baseURL = options.baseURL.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxStrikes = options.maxStrikes ?? DEFAULT_MAX_STRIKES;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.confidencePref = options.confidencePref ?? "auto";
  }

  isDisabled(): boolean {
    return this.disabled || this.timeoutStrikes >= this.maxStrikes;
  }

  /** 请求地址：baseURL 是服务根 → 拼 /v1/systemone */
  get endpoint(): string {
    // 已经是完整 systemone 地址的 baseURL 就不要再拼一次
    if (this.baseURL.endsWith(SYSTEMONE_PATH)) return this.baseURL;
    return `${this.baseURL}${SYSTEMONE_PATH}`;
  }

  async decide(req: DecisionRequest): Promise<LayaDecisionResponse> {
    if (this.isDisabled()) {
      throw new Error("[LayaDecisionPort] port self-disabled (3 consecutive timeouts)");
    }

    // ⚠️ 泄漏断言在**发请求之前**执行 —— 泄漏的 payload 永远不会被发出去
    assertNoLeakage(req.state, req.questions);

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      const fetchPromise = this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        // ⚠️ state / questions 必须是顶层键（不能包在 messages 里）
        body: JSON.stringify({
          model: this.model,
          state: req.state,
          questions: req.questions,
        }),
        signal: controller.signal,
      });

      // ⚠️ Promise.race：即使 fetch 实现忽略 AbortSignal，硬超时依然生效
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        const onTimeout = () => {
          const err = new Error(`[LayaDecisionPort] request timed out after ${this.timeoutMs}ms`);
          err.name = "TimeoutError";
          reject(err);
        };
        if (timedOut) onTimeout();
        else {
          const t = setTimeout(onTimeout, this.timeoutMs);
          t.unref?.();
        }
      });

      const res = await Promise.race([fetchPromise, timeoutPromise]);

      if (!res.ok) {
        throw new Error(`[LayaDecisionPort] HTTP ${res.status}`);
      }

      const body = (await res.json()) as LayaDecisionResponse;
      this.timeoutStrikes = 0;
      return this.normalize(body);
    } catch (err) {
      if (timedOut || isTimeoutError(err)) {
        this.timeoutStrikes += 1;
        if (this.timeoutStrikes >= this.maxStrikes) {
          this.disabled = true;
        }
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 归一化响应：
   *   1. 把 usage 里的截断信号抬到每个 answer 的 `truncated` 上
   *   2. 统一置信度字段（`confidence` 保持原义，另给 `jevConfidence`）
   */
  private normalize(body: LayaDecisionResponse): LayaDecisionResponse {
    const usage = body?.usage;
    const dropped = usage?.state_tokens_dropped ?? 0;
    const truncated = Boolean(usage?.truncated) || dropped > 0;
    const answers: Record<string, LayaDecisionAnswer> = {};
    for (const [qid, a] of Object.entries(body?.answers ?? {})) {
      answers[qid] = {
        ...a,
        truncated: truncated || Boolean(a?.truncated),
        // 归一化后的置信度：按 confidencePref 选源，写回 `confidence`
        confidence: this.pickConfidence(a),
      };
    }
    return { ...body, answers };
  }

  /**
   * 置信度选取（#302 的核心）。
   *
   * auto 顺序：x_jev_confidence → answer_confidence → confidence
   * jev 顺序：只用 x_jev_confidence（没有则 0）
   * entropy 顺序：只用 confidence
   */
  private pickConfidence(a: LayaDecisionAnswer | undefined): number {
    if (!a) return 0;
    const jev = numberOrUndefined(a.x_jev_confidence);
    const answerConf = numberOrUndefined(a.answer_confidence);
    const entropy = numberOrUndefined(a.confidence);
    switch (this.confidencePref) {
      case "jev":
        return jev ?? 0;
      case "entropy":
        return entropy ?? 0;
      case "auto":
      default:
        return jev ?? answerConf ?? entropy ?? 0;
    }
  }
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function isTimeoutError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") return true;
    if (/timeout|timed out|abort/i.test(err.message)) return true;
  }
  return false;
}

// ========================================================================
// Factory — 从 auth.json 读取 laya-decision provider
// ========================================================================

export interface LayaAuthConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

/**
 * Task #4804 — provider 名常量（provider 分离）：
 *   - create hook（task:before.create，判新建 vs 复用）→ laya-decision
 *   - completion hook（task:after.complete，判目标 vs 交付物）→ laya-goal-decision
 *     （缺失时保守回退 laya-decision —— fail-open 语义不变）
 */
export const LAYA_DECISION_PROVIDER = "laya-decision";
export const LAYA_GOAL_DECISION_PROVIDER = "laya-goal-decision";

/** hook 用途 → provider 名（Task #4804 provider 分离的唯一映射点） */
export type LayaHookPurpose = "create" | "goal";

export function providerNameForPurpose(purpose: LayaHookPurpose): string {
  return purpose === "goal"
    ? LAYA_GOAL_DECISION_PROVIDER
    : LAYA_DECISION_PROVIDER;
}

/**
 * 从 `~/.roy-bot/auth.json` 的 `providers["laya-decision"]` 读取端点配置。
 *
 * 路径：~/.roy-bot/auth.json → providers["laya-decision"].baseURL
 *                                  → providers["laya-decision"].apiKey
 *                                  → providers["laya-decision"].model（可选）
 *
 * ⚠️ 读不到就返回 null —— 调用方必须 fail-open（不提示、不报错）。
 *
 * Task #4804 — 向后兼容：默认仍读 laya-decision（create hook 语义）。
 *   completion hook 侧请用 `loadLayaAuthForPurpose(path, "goal")`。
 */
export async function loadLayaAuth(
  authPath: string = `${process.env.HOME ?? "~"}/.roy-bot/auth.json`,
): Promise<LayaAuthConfig | null> {
  return loadLayaAuthForPurpose(authPath, "create");
}

/**
 * Task #4804 — 按用途读 provider：
 *   - "create" → providers["laya-decision"]
 *   - "goal"   → providers["laya-goal-decision"]，缺失时保守回退
 *                providers["laya-decision"]（共享共享配置，fail-open 不变）
 *
 * ⚠️ 读不到就返回 null —— 调用方必须 fail-open（不提示、不报错）。
 */
export async function loadLayaAuthForPurpose(
  authPath: string = `${process.env.HOME ?? "~"}/.roy-bot/auth.json`,
  purpose: LayaHookPurpose = "create",
): Promise<LayaAuthConfig | null> {
  try {
    const fs = await import("fs/promises");
    const raw = await fs.readFile(authPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      providers?: Record<string, { baseURL?: string; apiKey?: string; model?: string }>;
    };
    // CV MINOR-1：primary 真正参与逻辑 —— goal 用途时
    // 专用 provider 在前、共享 provider 兜底
    const primary = providerNameForPurpose(purpose);
    const candidates =
      purpose === "goal"
        ? [primary, LAYA_DECISION_PROVIDER]
        : [primary];
    for (const name of candidates) {
      const p = parsed.providers?.[name];
      if (p?.baseURL && p?.apiKey) {
        return {
          baseURL: p.baseURL,
          apiKey: p.apiKey,
          // CV MINOR-3（DS 复审 v4）：按用途选兜底模型 ——
          // goal 用途读到的是 goal provider（或回退的共享 provider），
          // 漏写 model 时不能回落到 create 侧的 task-decision。
          model:
            p.model ??
            (name === LAYA_GOAL_DECISION_PROVIDER
              ? DEFAULT_GOAL_MODEL
              : DEFAULT_MODEL),
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}
