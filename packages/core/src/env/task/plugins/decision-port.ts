/**
 * @fileoverview Task #4467 — decision model 载体适配层（DecisionPort）
 *
 * 契约：/tmp/task-create-verdict-contract-v2.md §7
 *
 * 载体实测事实（#4107 踩过的坑，务必照抄）：
 *   - baseURL 本身就是请求地址，**不是** `{baseURL}/chat/completions`
 *   - **不能用标准 chat/completions 格式**：`state` / `questions` 必须是**顶层键**
 *     （标准 `messages:[...]` → 400 `Field required: state & Field required: questions`）
 *   - 响应形态：`{ answers: { <key>: { type, choice, confidence, probabilities } }, usage, latency_ms }`
 *   - API 硬限：`questions.<key>.criteria` 最多 255 个 choices
 *   - 超时是真实风险：实测 100ms ~ 13452ms
 */

import { assertNoLeakage } from "../hooks/verdict";
// Task #4494 — 决策端口 trace 插桩
import { TracedAs } from "../../log-trace/decorator";

// ========================================================================
// Types
// ========================================================================

export interface DecisionRequest {
  /**
   * 决策上下文。
   *
   * ⚠️ Task #4620：**可以是一段文本**。
   *   - systemone 载体（阿里百炼）：JSON 对象 `{task_to_route, similar_tasks}`
   *   - laya 载体（#4614 的微调模型）：中文文本
   *     `【新任务标题】…\n【新任务描述】…\n【候选任务】…`
   *
   *   两种形态都合法 —— 载体**只在训练分布内**才判得准（实测差 32.5 个百分点），
   *   见 `laya-train/scripts/format_probe.py`。
   *
   * ⚠️ 类型放宽到 `unknown` 而非 `Record<string, unknown>` —— 因为文本 state
   *   不是对象。**运行时按原样透传**（JSON.stringify 会把它序列化成字符串）。
   */
  state: unknown;
  questions: Record<string, unknown>;
}

export interface DecisionAnswer {
  choice: string;
  confidence: number;
  probabilities?: Record<string, number>;
  /**
   * Task #4627 — **Jev 公式置信度**（#302 的核心字段）。
   *
   * ⚠️ `confidence` 是**归一化熵**，**不是** Jev 公式置信度。
   *   laya 同时返回两个字段，60 条实测里 20 条差异 > 0.05。
   *   门禁**必须**读 `x_jev_confidence`（缺失时回退 `answer_confidence` → `confidence`）。
   *
   *   `LayaDecisionPort` 已在 normalize() 里把 `confidence` 覆盖成选源后的值，
   *   但那是**载体侧**的归一化 —— 判定层不能依赖它（换载体就失效）。
   *   所以判定层自己再选一次源，两层都指向 `x_jev_confidence`。
   */
  x_jev_confidence?: number;
  /** Jev 公式置信度的另一个别名（laya 返回） */
  answer_confidence?: number;
}

export interface DecisionResponse {
  answers: Record<string, DecisionAnswer>;
  usage?: { input_tokens?: number };
  latency_ms?: number;
}

export interface DecisionPort {
  /** 执行一次决策。失败抛错，调用方按契约 §8 降级。 */
  decide(req: DecisionRequest): Promise<DecisionResponse>;
  /** 供测试/熔断查询当前是否已自我禁用 */
  isDisabled(): boolean;
}

export interface SystemOneDecisionPortOptions {
  /** 端点（**本身就是请求地址**，不要拼 /chat/completions） */
  baseURL: string;
  apiKey: string;
  model: string;
  /** 硬超时（默认 2000ms，契约 P8） */
  timeoutMs?: number;
  /** 熔断计数的 session 维度（契约 P9） */
  sessionId?: string;
  /** 连续超时多少次后自我禁用（默认 3） */
  maxStrikes?: number;
  /** 注入 fetch（测试用） */
  fetchImpl?: typeof globalThis.fetch;
}

// ========================================================================
// SystemOneDecisionPort
// ========================================================================

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_MAX_STRIKES = 3;

export class SystemOneDecisionPort implements DecisionPort {
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly sessionId: string;
  private readonly maxStrikes: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  /** 同 session 连续超时计数 */
  private timeoutStrikes = 0;
  private disabled = false;

  constructor(options: SystemOneDecisionPortOptions) {
    this.baseURL = options.baseURL;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sessionId = options.sessionId ?? "default";
    this.maxStrikes = options.maxStrikes ?? DEFAULT_MAX_STRIKES;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  isDisabled(): boolean {
    return this.disabled || this.timeoutStrikes >= this.maxStrikes;
  }

  /**
   * 执行一次决策。
   *
   * Task #4494 trace 插桩 —— **这是整条链路最关键的可观测点**（真调模型）。
   *
   * ⚠️ 安全硬约束：`paramFilter` 只输出**结构摘要**，绝不输出
   *    - `req.state` 全量（200 候选可达 47KB）
   *    - `req.questions` 的 criteria 全量（每个候选一条渲染串）
   *    - **apiKey**（它在 `this.apiKey` 上，args 里本来就没有，但绝不能
   *      顺手把 `this` 记录下来 —— paramFilter 只用 args，不碰 this）
   *
   * ⚠️ 延迟观测：`resultFilter` 记录 `latency_ms`（载体自己返回）+
   *    `answers` 的 choice/confidence。P50/P95 统计靠这个字段。
   */
  @TracedAs("task.decision.port.decide", {
    recordParams: true,
    recordResult: true,
    log: false,
    paramFilter: (args) => {
      const req = (args[0] ?? {}) as DecisionRequest;
      const state = (req.state ?? {}) as Record<string, unknown>;
      const questions = (req.questions ?? {}) as Record<string, unknown>;
      const criteriaCounts: Record<string, number> = {};
      for (const [qKey, qVal] of Object.entries(questions)) {
        const criteria = (qVal as { criteria?: Record<string, unknown> })?.criteria;
        criteriaCounts[qKey] = criteria ? Object.keys(criteria).length : 0;
      }
      return {
        stateKeys: Object.keys(state),
        questionKeys: Object.keys(questions),
        criteriaCounts,
        stateBytes: JSON.stringify(state).length,
        questionsBytes: JSON.stringify(questions).length,
      };
    },
    resultFilter: (res: DecisionResponse) => {
      const answers = res?.answers ?? {};
      const summary: Record<string, string> = {};
      for (const [qKey, a] of Object.entries(answers)) {
        summary[qKey] = `${a?.choice ?? "?"}@${a?.confidence ?? "?"}`;
      }
      return {
        answersSummary: JSON.stringify(summary),
        latencyMs: res?.latency_ms ?? -1,
        inputTokens: res?.usage?.input_tokens ?? -1,
      };
    },
    // 决策失败（超时/自禁用/HTTP 错误）必须让 span 变 ERROR，否则
    // 「一直静默降级」在 trace --list 里永远显示 ok
    errorIf: (res: DecisionResponse) =>
      res && res.answers && Object.keys(res.answers).length > 0
        ? undefined
        : new Error("decision response has no answers"),
  })
  async decide(req: DecisionRequest): Promise<DecisionResponse> {
    if (this.isDisabled()) {
      throw new Error("[SystemOneDecisionPort] port self-disabled (3 consecutive timeouts)");
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
      // ⚠️ Promise.race：即使 fetch 实现忽略 AbortSignal，硬超时依然生效
      const fetchPromise = this.fetchImpl(this.baseURL, {
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

      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        const onTimeout = () => {
          const err = new Error(`[SystemOneDecisionPort] request timed out after ${this.timeoutMs}ms`);
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
        throw new Error(`[SystemOneDecisionPort] HTTP ${res.status}`);
      }

      const body = (await res.json()) as DecisionResponse;
      this.timeoutStrikes = 0;
      return body;
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
}

function isTimeoutError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") return true;
    if (/timeout|timed out|abort/i.test(err.message)) return true;
  }
  return false;
}

// ========================================================================
// Factory — 从 auth.json 读取 ali-decision provider
// ========================================================================

export interface DecisionAuthConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

/**
 * 从 `~/.roy-bot/auth.json` 的 `providers.ali-decision` 读取端点配置。
 *
 * 路径与字段（实测）：
 *   ~/.roy-bot/auth.json → providers["ali-decision"].baseURL
 *                          → providers["ali-decision"].apiKey
 */
export async function loadSystemOneAuth(
  authPath: string = `${process.env.HOME ?? "~"}/.roy-bot/auth.json`,
): Promise<DecisionAuthConfig | null> {
  try {
    const fs = await import("fs/promises");
    const raw = await fs.readFile(authPath, "utf-8");
    const parsed = JSON.parse(raw) as { providers?: Record<string, { baseURL?: string; apiKey?: string }> };
    const p = parsed.providers?.["ali-decision"];
    if (!p?.baseURL || !p?.apiKey) return null;
    return {
      baseURL: p.baseURL,
      apiKey: p.apiKey,
      model: "decision-model-preview",
    };
  } catch {
    return null;
  }
}
