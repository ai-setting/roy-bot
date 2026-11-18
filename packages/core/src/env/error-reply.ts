/**
 * @fileoverview Task #4418: React 循环异常中断 → 给飞书发 reply
 *
 * ## 问题（用户飞书 p2p 2026-10-21）
 *
 * ```
 * RetryError [AI_RetryError]: Failed after 4 attempts.
 * Last error: Upstream request failed: Endpoint is unavailable.
 * statusCode: 429 / isRetryable: true
 * ```
 *
 * 上游 429 不是 roy-bot 的 bug；但**异常中断后飞书侧完全静默**是。
 * 用户原话：「这个失败导致的 react 中断，也需要找到对应的 triggerEvent
 * 构建 response 让飞书方知道（送一个 reply 哈）」。
 *
 * ## 为什么必须由框架直接发（不能靠 prompt 引导 agent）
 *
 * 正常路径的 reply 是 **LLM 自己调 lark-cli**（prompt 由
 * `buildNotifyHandlePrompt` / event-source-handlers 生成，告诉 agent
 * 用 `recommendedAction.replyTo` 回消息）。
 *
 * 但异常路径的根本问题是：**LLM 调用本身失败了**，React 循环从未拿到
 * 一个可用的 assistant turn，自然也不可能再调工具发消息。所以框架必须
 * 自己 spawn `lark-cli`，这是与正常路径的本质区别。
 *
 * ## 断点（为什么曾经没 reply）
 *
 * 1. `agent-component.ts:2096` 捕获异常 → `result.error` + `result.originalError`
 * 2. `environment.ts:430` 非 ContextError → `throw new Error(result.error)`
 *    ⚠️ 类型在这里丢掉，下游只能拿到字符串
 * 3. `context-handler.service.ts:224` 直接 rethrow
 * 4. `query-executor.ts:287` 只处理 ContextError，其余 rethrow
 * 5. `interactive.ts:1301` / `event-handler.ts:620` 的 catch **只 console.error**
 *    → 静默丢失
 *
 * ## 现在的接线（四处，去重保证不重复）
 *
 * 1. `QueryExecutor.execute` 的 catch —— 唯一执行入口，覆盖
 *    interactive / run / run --es 三种模式，带完整 `agentContext.envEvent`
 * 2. `EventHandler.processQueue` 的 catch —— 兜住「还没走到 QueryExecutor
 *    就失败」的路径（session 解析 / 事件分发），并作为 TUI 层吞异常时的
 *    最后一道防线
 * 3. REPL `executeInternal` 的 catch —— 兜住 agentContext 组装 / plugin
 *    加载 / REPL 包装层（这些异常会被 REPL 自己吞掉，到不了 EventHandler）
 * 4. `LarkCliInstance.handleEvent` 的 catch —— event-source 自身的解析 /
 *    落库 / 分发失败
 *
 * 四处都调用本模块，意味着**任何 React 中断都至少有一个出口到飞书**。
 *
 * ## 设计原则
 *
 * - **规则表驱动（rule base）**：错误分类 + 是否通知 + 用户文案收敛成
 *   `FAILURE_RULES` 有序表；表尾 `UNKNOWN_RULE` 是 `notify: true` 的
 *   catch-all —— 结构上保证**任何未分类错误也不会沉默**。只有
 *   `ask_user`（正常交互）显式 `notify: false`
 * - **best-effort**：任何异常（spawn 失败 / lark-cli 非 0 / 库挂了）
 *   都不得向上抛，绝不污染原始错误传播链
 * - **有硬超时**：兜底 reply 在 5s 内一定 settle（超时 kill 子进程）。
 *   否则 lark-cli 卡住会把 `QueryExecutor` 的 rethrow 拖死 → 事件队列堵死
 * - **复用现有机制**：spawn 参数形态与 `event-source-handlers.sendLarkMessage`
 *   / `lark-card-patch-notifier.buildSendCardArgs` / `telemetry-notice.buildLarkSendArgs`
 *   保持一致（`--profile` 前置、messageId → `+messages-reply`、
 *   chatId → `+messages-send`、**两支都显式 `--as bot`**）
 * - **去重**：同一 triggerEvent（messageId）只回一次；chat-only 通道走
 *   5 分钟窗口，**不会**把整个群永久封锁；发送失败回滚去重标记
 * - **无 channel 不崩但也不静默**：本地 REPL / `act` 没有飞书上下文 → debug；
 *   有 triggerEvent 却拿不到 replyChannel = 衔接 bug → warn
 * - **用户可读**：给用户看中文原因，技术细节单独放 `technical` 字段（截断）
 */

import { spawn } from "node:child_process";
import { createLogger } from "./log-trace/logger";
import { redactSecrets } from "./llm/redact";
import { normalizeLarkAtMentions } from "./lark-mention-utils";

const logger = createLogger("env:error-reply");

// ============================================================================
// 类型
// ============================================================================

/**
 * 失败分类。
 *
 * 顺序即优先级：越具体的越先匹配。
 */
export type ReactFailureKind =
  | "ask_user" // 正常交互流（agent 主动提问），不是失败，不应发失败说明
  | "quota_exhausted" // 账号/免费额度用尽（429 + 长 Retry-After），重试无用
  | "upstream_retry" // 上游 429 / 5xx / 网络：重试后仍失败
  | "timeout" // 硬超时（withTimeout / deadline / AbortSignal.timeout）
  | "upstream_aborted" // 传输层中止（连接被掐断），不是用户取消
  | "aborted" // 用户中断 / 进程 shutdown
  | "context_overflow" // 上下文超限且压缩也救不回来
  | "unknown"; // 其余

export interface ReactFailureInfo {
  kind: ReactFailureKind;
  /** 命中的规则 id（可观测性 / 测试锚点） */
  ruleId: string;
  /** 一行标题（中文，给用户看） */
  title: string;
  /** 可读原因（中文，不含 stack trace） */
  reason: string;
  /** 是否值得用户稍后重试 */
  retryable: boolean;
  /**
   * 是否应该把这条失败反馈到飞书。
   *
   * 只有 `ask_user`（正常交互）为 false —— **所有真正的失败/中断都必须通知**，
   * 这是 #4418 的硬契约：不允许静默。
   */
  notify: boolean;
  /** 技术细节（截断，供定位；不直接展示给用户） */
  technical?: string;
  /** 上游声明的恢复窗口（秒），来自 `Retry-After`。无法判定时 undefined */
  retryAfterSeconds?: number;
  /**
   * 「你可以怎么办」的替代建议。
   *
   * 默认由 `retryable` 推导（true → 重发；false → 压缩/新开会话），但有些
   * 失败两者都不对 —— 例如额度用尽：重发无用，压缩会话也无用，唯一出路
   * 是换模型 / 充值 / 等。规则可以在这里覆盖默认文案。
   */
  suggestion?: string;
}

/** replyChannel 的最小形态（同时兼容 EnvReplyChannel / event-source ReplyChannel） */
export interface FailureReplyChannelLike {
  type?: string;
  chatId?: string;
  messageId?: string;
  profile?: string;
  appId?: string;
  userId?: string;
  /**
   * Task #5311：渠道自定义参数（event-source ReplyChannel.params 的透传）。
   * 企微通道用 `params.sourceId`（WS fallback 实例定位）与
   * `params.reqId`（WS 被动回帧）。lark 通道不读它。
   */
  params?: Record<string, unknown>;
}

export interface NotifyReactFailureOptions {
  /** 触发 React 中断的错误（任意类型，内部会做类型安全处理） */
  error: unknown;
  /**
   * 触发本次执行的 EnvEvent。
   *
   * 从中提取 replyChannel（优先 `metadata.replyChannel`，
   * 兼容 `payload.replyChannel`），这就是用户说的「找到对应的 triggerEvent」。
   */
  envEvent?: unknown;
  /** 显式 replyChannel（优先级最高，便于调用方直接指定） */
  replyChannel?: FailureReplyChannelLike;
  /** 原始 query 摘要（会被截断后放进 reply，便于用户对上号） */
  query?: string;
  /** 会话 ID（仅用于日志 / 去重兜底） */
  sessionId?: string;
  /** 去重 key 覆盖（默认从 messageId/chatId 推导） */
  dedupKey?: string;
  /**
   * 兜底 reply 的硬超时（ms）。
   *
   * 生产默认 5s；仅测试注入短值用。超时后 kill 子进程并按失败返回，
   * 保证 `QueryExecutor` 的 catch 不会被 lark-cli 挂住。
   */
  replyTimeoutMs?: number;
}

export interface NotifyReactFailureResult {
  /** 是否成功投递到飞书 */
  sent: boolean;
  /** 失败分类（即使没发送也会返回，调用方可记日志） */
  kind: ReactFailureKind;
  /** 结构化失败信息 */
  info: ReactFailureInfo;
  /** 跳过原因（sent=false 时有值） */
  skipped?: "no_channel" | "duplicate" | "not_a_failure";
  /** 投递错误（sent=false 且确实尝试过时有值） */
  error?: string;
}

// ============================================================================
// 1. 错误分类
// ============================================================================

/** 上游可重试特征词（大小写不敏感） */
const UPSTREAM_RETRY_PATTERNS: readonly RegExp[] = [
  /failed after \d+ attempts/i,
  /endpoint is unavailable/i,
  /upstream request failed/i,
  /rate.?limit/i,
  /\b429\b/,
  /\b50[0234]\b/,
  /service (is )?(temporarily )?unavailable/i,
  /\beconn(reset|refused|aborted)\b/i,
  /socket hang up/i,
  /fetch failed/i,
  /network error/i,
  /overloaded/i,
];

/**
 * 额度用尽特征词（Task #4625）。
 *
 * 与普通 429 限流的区别：这里的额度是按小时/天恢复的，`Retry-After` 往往是
 * 数万秒。所以「稍后重发一次即可」是**错误建议**，必须单独分类。
 *
 * 只认上游明确说自己额度没了的话术，不靠 429 + 长 Retry-After 反推 ——
 * 否则一条 `Retry-After: 3600` 的普通限流也会被误判成"等一天"。
 */
const QUOTA_EXHAUSTED_PATTERNS: readonly RegExp[] = [
  /free usage limit (reached|exceeded)/i,
  /free (model )?(usage|quota).{0,20}(limit|exhaust)/i,
  /usage limit (reached|exceeded)/i,
  /quota (exceeded|exhausted|reached)/i,
  /insufficient[_ ]?(quota|balance|credit)/i,
  /(credit|balance) (is )?(exhausted|insufficient)/i,
  /billing (hard )?limit/i,
];

/** 超时特征词（先于 abort 判定：AbortSignal.timeout 也会报 "aborted"） */
const TIMEOUT_PATTERNS: readonly RegExp[] = [
  /timeout/i,
  /timed out/i,
  /deadline exceeded/i,
  /etimedout/i,
  /aborted due to timeout/i,
];

/**
 * 传输层中止特征词 —— **不是用户取消**。
 *
 * undici / Node 把连接被掐断、请求被对端 abort 都报成 `*AbortedError`，
 * 如果按「用户中断」告知用户，会让人以为自己点了取消。
 */
const TRANSPORT_ABORT_PATTERNS: readonly RegExp[] = [
  /requestabortederror/i,
  /econnaborted/i,
  /connection (was )?(aborted|reset|closed)/i,
  /premature close/i,
];

/** 中止特征词（用户主动取消 / 进程收到停止信号） */
const ABORT_PATTERNS: readonly RegExp[] = [
  /\babort(?:ed|ing)?\b/i,
  /operation was cancelled/i,
  /operation was canceled/i,
  /sigint/i,
  /\binterrupted\b/i,
  /exiting due to (signal|shutdown)/i,
];

/** 上下文超限特征词 */
const CONTEXT_PATTERNS: readonly RegExp[] = [
  /context threshold/i,
  /context (window|length|limit)/i,
  /token limit/i,
  /maximum context/i,
  /ctrieve\b/,
  /CTX_001/,
];

/**
 * `ask_user` 不是失败：它是 agent 主动向用户提问的正常交互流，
 * 由 `handleAskUserInteraction` 负责，绝不能回一条「执行失败」。
 */
const ASK_USER_PATTERNS: readonly RegExp[] = [/__ASK_USER_ERROR__/];


/** 从任意 error 抽取尽可能多的可搜索文本 */
function collectErrorText(error: unknown, depth = 0): string {
  const parts: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.length > 0) parts.push(v);
  };

  if (error === null || error === undefined) return "";

  if (typeof error === "string") {
    push(error);
    return parts.join("\n");
  }

  if (typeof error !== "object") {
    push(String(error));
    return parts.join("\n");
  }

  const e = error as Record<string, unknown>;
  push(e.name);
  push(e.message);

  // 常见状态码字段（429 等）
  for (const key of ["statusCode", "status", "code"]) {
    const v = e[key];
    if (typeof v === "number" || typeof v === "string") push(String(v));
  }

  if (depth < 3) {
    // AI SDK RetryError 把真实错误放在 lastError / errors[] / cause
    const nested = collectErrorText(e.lastError, depth + 1);
    if (nested) parts.push(nested);

    if (Array.isArray(e.errors)) {
      for (const inner of e.errors.slice(-3)) {
        const s = collectErrorText(inner, depth + 1);
        if (s) parts.push(s);
      }
    }

    const cause = collectErrorText(e.cause, depth + 1);
    if (cause) parts.push(cause);
  }

  return parts.join("\n");
}

/**
 * 从任意错误对象里挖出 `Retry-After`（秒）。
 *
 * 上游把窗口放在哪一层并不统一：
 * - `error.headers["retry-after"]`            (openai SDK 挂在 error 上)
 * - `error.responseHeaders["retry-after"]`    (AI SDK APICallError)
 * - `error.data.error.retry_after`            (自定义 body)
 * - `error.retryAfter` / `error.retry_after`  (扁平形态)
 *
 * 也会处理 HTTP-date 形态（`Wed, 21 Oct 2026 07:28:00 GMT`），因为它合法。
 * 返回值单位是秒，无法判定时返回 undefined（**绝不猜**）。
 */
export function extractRetryAfterSeconds(error: unknown, depth = 0): number | undefined {
  // Depth budget (review MINOR-1): the production chain nests 4 hops —
  // thrown Error → AI_RetryError.errors[] → APICallError → cause — so the old
  // limit of 3 could drop the window entirely. 6 keeps a bound without
  // risking a miss on a plausible (non-cyclic) chain.
  if (!error || typeof error !== "object" || depth > 6) return undefined;
  const e = error as Record<string, any>;

  const candidates: unknown[] = [
    e.retryAfter,
    e.retry_after,
    e.retryAfterSeconds,
    e.headers?.["retry-after"],
    e.headers?.["Retry-After"],
    e.responseHeaders?.["retry-after"],
    e.responseHeaders?.["Retry-After"],
    e.headers?.get?.("retry-after"),
    e.data?.error?.retry_after,
    e.data?.error?.retryAfter,
  ];

  for (const raw of candidates) {
    const seconds = toSeconds(raw);
    if (seconds !== undefined) return seconds;
  }

  // 嵌套：RetryError → errors[] / lastError / cause
  const nested: unknown[] = [e.lastError, e.cause];
  if (Array.isArray(e.errors)) nested.push(...e.errors.slice(-2));
  for (const inner of nested) {
    const seconds = extractRetryAfterSeconds(inner, depth + 1);
    if (seconds !== undefined) return seconds;
  }

  return undefined;
}

/** `Retry-After` 单值 → 秒（支持数字秒 与 HTTP-date 两种合法形态） */
function toSeconds(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber) && asNumber >= 0) return asNumber;

  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    const delta = Math.max(0, asDate - Date.now());
    return Math.round(delta / 1000);
  }
  return undefined;
}

/**
 * 把秒数说成人话（"约 22 小时后恢复"）。
 *
 * 只在**粗粒度**上承诺时间：22.008h 说成 "约 22 小时"，避免给出虚假精度。
 * < 90s 说明「很快」，分钟级/小时级分别取整。
 */
export function humanizeRetryAfter(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined;
  if (seconds < 90) return "约 1 分钟内";
  const minutes = seconds / 60;
  if (minutes < 90) return `约 ${Math.round(minutes)} 分钟后`;
  const hours = minutes / 60;
  if (hours < 36) return `约 ${Math.round(hours)} 小时后`;
  const days = hours / 24;
  return `约 ${Math.round(days)} 天后`;
}

/** 安全截断 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

/**
 * 失败分类规则。
 *
 * ## 为什么是「规则表」而不是 if/else 链
 *
 * #4418 的用户诉求是「React 循环的**任何**中断都不能沉默」。散落的
 * if/else 一旦漏一个分支就是静默黑洞，而且新增错误形态时没人知道该改哪。
 * 这里把「匹配 → 分类 → 是否通知 → 给用户看的文案」收敛成一张**有序表**：
 *
 *   - `FAILURE_RULES` 从上到下匹配，**第一个命中**的规则胜出
 *   - 表尾的 `UNKNOWN_RULE` 是 catch-all：`notify: true`
 *     —— 任何未分类异常也一定会反馈到飞书，结构上不可能静默
 *   - 只有 `ask_user`（正常交互，不是失败）显式 `notify: false`
 *
 * 新增错误形态 = 往表里加一条规则 + 一个测试，不需要改执行逻辑。
 *
 * ## 顺序敏感点
 *
 * `timeout` **必须在** `aborted` 之前：`AbortSignal.timeout()` /
 * undici 超时都会抛 `AbortError: ... aborted due to timeout`，
 * 先匹配 abort 会把真实超时说成「用户取消了」。
 */
interface FailureRule {
  /** 稳定 id（日志 / 测试锚点） */
  id: string;
  kind: ReactFailureKind;
  /** 命中 `error.name`（大小写不敏感，完全相等） */
  names?: readonly string[];
  /** 命中错误文本（message / name / cause / statusCode 等聚合文本） */
  patterns?: readonly RegExp[];
  /** 任何一条命中则跳过本规则（更强的信号优先） */
  unless?: readonly RegExp[];
  /** 是否反馈到飞书。只有 ask_user 为 false。 */
  notify: boolean;
  title: string;
  reason: string;
  retryable: boolean;
  /** 覆盖 buildFailureReplyMarkdown 的默认「你可以：」建议 */
  suggestion?: string;
}

const FAILURE_RULES: readonly FailureRule[] = [
  // ---- 0. ask_user：正常交互流，不是失败（绝不能回「执行失败」）
  {
    id: "ask_user",
    kind: "ask_user",
    names: ["AskUserError"],
    patterns: ASK_USER_PATTERNS,
    notify: false,
    title: "等待用户回答",
    reason: "agent 正在等待用户回答，不是失败。",
    retryable: false,
  },

  // ---- 1. context_overflow：有专门处理路径，不该被说成「重试失败」
  {
    id: "context_overflow",
    kind: "context_overflow",
    names: ["ContextError"],
    patterns: CONTEXT_PATTERNS,
    notify: true,
    title: "上下文超出限制",
    reason:
      "这次对话的上下文超出模型窗口，自动压缩也未能恢复。建议新开一个会话继续，或先让我压缩当前会话。",
    retryable: false,
  },

  // ---- 2. timeout：硬超时（必须先于 abort）
  {
    id: "timeout",
    kind: "timeout",
    names: ["TimeoutError"],
    patterns: TIMEOUT_PATTERNS,
    notify: true,
    title: "执行超时",
    reason:
      "本次执行等待响应超时（上游长时间未返回或网络卡住）。建议稍后重试，或把任务拆小一些。",
    retryable: true,
  },

  // ---- 3. quota_exhausted：账号额度用尽（Task #4625）
  //
  // 必须排在 upstream_retry 之前：额度用尽也是 429，但「稍后重发一次即可」
  // 这条建议对它是有害的 —— 用户会一直重发、一直失败。真实案例：
  // `opencode/deepseek-v4.1-flash-free` 免费额度用尽后 Retry-After 79229s，
  // 重发在 22 小时内不可能成功。
  {
    id: "quota_exhausted",
    kind: "quota_exhausted",
    names: ["FreeUsageLimitError"],
    patterns: QUOTA_EXHAUSTED_PATTERNS,
    notify: true,
    title: "模型额度已用尽",
    reason:
      "本次调用被上游拒绝：该模型的额度（或免费额度）已经用完。这不是你的操作问题，" +
      "也不是仓库代码的问题 —— 重发同一个模型不会恢复，需要换模型或等额度重置。",
    retryable: false,
    suggestion:
      "换一个模型（例如 `--model <provider>/<付费模型>`），或等额度重置后再试。",
  },

  // ---- 4. upstream_retry：429 / 5xx / 网络（普通限流在这里）
  {
    id: "upstream_retry",
    kind: "upstream_retry",
    names: ["AI_RetryError", "RetryError", "APICallError", "AI_APICallError"],
    patterns: UPSTREAM_RETRY_PATTERNS,
    notify: true,
    title: "模型服务暂时不可用（重试已用尽）",
    reason:
      "调用模型时上游持续返回错误（如 429 限流 / 503 不可用），自动重试多次后仍未成功。" +
      "这不是你的操作问题，也不是仓库代码的问题 —— 稍后重发一次即可。",
    retryable: true,
  },

  // ---- 4. upstream_aborted：传输层被掐断，不是用户取消
  {
    id: "upstream_aborted",
    kind: "upstream_aborted",
    names: ["RequestAbortedError"],
    patterns: TRANSPORT_ABORT_PATTERNS,
    unless: TIMEOUT_PATTERNS,
    notify: true,
    title: "与模型服务的连接中断",
    reason:
      "请求在传输过程中被中断（连接被重置 / 代理提前关闭），不是你的操作问题。稍后重发一次即可。",
    retryable: true,
  },

  // ---- 5. aborted：用户主动取消 / 进程收到停止信号
  {
    id: "aborted",
    kind: "aborted",
    names: ["AbortError", "AbortSignal"],
    patterns: ABORT_PATTERNS,
    unless: [...TIMEOUT_PATTERNS, ...TRANSPORT_ABORT_PATTERNS],
    notify: true,
    title: "执行被中断",
    reason:
      "本次执行在完成前被中断（可能你手动取消了，或进程收到了停止信号）。你可以直接让我重新执行。",
    retryable: true,
  },
];

/** catch-all：任何规则都没命中时也必须通知（结构上杜绝静默）。 */
const UNKNOWN_RULE: FailureRule = {
  id: "unknown",
  kind: "unknown",
  notify: true,
  title: "执行异常失败",
  reason:
    "本次执行遇到了未预期的异常，已中止。你可以重试；如果持续失败，请把这条消息里的技术细节发我。",
  retryable: true,
};

function ruleMatches(rule: FailureRule, name: string, text: string): boolean {
  const lowered = name.toLowerCase();
  const nameHit = rule.names?.some((n) => n.toLowerCase() === lowered) ?? false;
  const patternHit = rule.patterns?.some((p) => p.test(text)) ?? false;
  if (!nameHit && !patternHit) return false;
  if (rule.unless?.some((p) => p.test(text))) return false;
  return true;
}

/** 当前生效的规则 id 列表（供可观测性 / 文档 / 测试锚定顺序）。 */
export function getFailureRuleIds(): string[] {
  return [...FAILURE_RULES.map((r) => r.id), UNKNOWN_RULE.id];
}

/**
 * 把任意错误分类成结构化、用户可读的失败信息。
 *
 * ⚠️ 关键：必须能处理**类型已丢失**的场景 —— 真实调用链上
 * `environment.ts` 会把 RetryError 字符串化成普通 `Error`，所以只能靠
 * message 文本特征识别，不能依赖 `instanceof RetryError`。
 */
export function classifyReactFailure(error: unknown): ReactFailureInfo {
  const text = collectErrorText(error);
  const name =
    error && typeof error === "object"
      ? String((error as Record<string, unknown>).name ?? "")
      : "";

  // Task #4625 (review MAJOR-1): the `technical` line is rendered into the
  // user-facing failure reply. `collectErrorText()` walks `cause`, and since
  // #4625 that `cause` is the *raw* upstream Error — the one `invoke.ts`
  // deliberately redacts before exposing it as a string. Redacting again here
  // closes that side door; it is the sink for both CLI and Feishu output, so
  // one call covers both.
  const technical = text
    ? truncate(redactSecrets(text.replace(/\s*\n\s*/g, " | ")), 400)
    : undefined;

  const rule = FAILURE_RULES.find((r) => ruleMatches(r, name, text)) ?? UNKNOWN_RULE;

  // Task #4625: for quota failures the recovery window is the single most
  // useful fact for the user, so it is lifted out of the technical blob and
  // restated in the human-readable reason ("约 22 小时后恢复").
  const retryAfterSeconds =
    rule.kind === "quota_exhausted" ? extractRetryAfterSeconds(error) : undefined;
  const window = humanizeRetryAfter(retryAfterSeconds);

  return {
    kind: rule.kind,
    ruleId: rule.id,
    title: rule.title,
    reason: window ? `${rule.reason}上游提示：额度${window}恢复。` : rule.reason,
    retryable: rule.retryable,
    notify: rule.notify,
    technical,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    ...(rule.suggestion ? { suggestion: rule.suggestion } : {}),
  };
}

// ============================================================================
// 2. reply 正文
// ============================================================================

const MAX_QUERY_PREVIEW = 200;

/**
 * 生成发给用户的 reply 正文（Markdown）。
 *
 * 契约：
 * - 不含裸 stack trace（`    at `）
 * - 含「怎么办」的可操作建议
 * - 总长度远小于飞书 4096 单条上限
 */
export function buildFailureReplyMarkdown(
  info: ReactFailureInfo,
  opts?: { query?: string; sessionId?: string },
): string {
  const lines: string[] = [];

  lines.push(`❌ **${info.title}**`);
  lines.push("");
  lines.push(info.reason);

  const query = opts?.query?.trim();
  if (query) {
    lines.push("");
    lines.push(`> 原始请求：${truncate(query.replace(/\s+/g, " "), MAX_QUERY_PREVIEW)}`);
  }

  lines.push("");
  if (info.suggestion) {
    // 规则显式给出了替代建议 —— 优先用它。
    // 典型是额度用尽：既不该"重发"，也不该"压缩会话"。
    lines.push(`**你可以：** ${info.suggestion}`);
  } else if (info.retryable) {
    lines.push("**你可以：** 直接再发一次（重发即可，无需额外操作）。");
  } else {
    lines.push("**你可以：** 新开一个会话，或先让我压缩当前会话。");
  }

  const technical = info.technical;
  if (technical) {
    lines.push("");
    // 用引用块而不是 HTML <font>：飞书 IM 的 markdown 子集不保证渲染 font 标签，
    // 否则用户会看到字面量 `<font ...>`，反而更难看懂。
    lines.push(`> 技术细节：${truncate(technical, 300)}`);
  }

  return lines.join("\n");
}

/** 安全取错误类名（非对象 / 缺失时返回空串）。 */
function errorName(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const n = (error as Record<string, unknown>).name;
  return typeof n === "string" ? n : "";
}

/**
 * Task #4625：把任意失败压成**一行**给 CLI 用户看的说明。
 *
 * ## 为什么 CLI 需要这个（而飞书不需要）
 *
 * 飞书路径走 `buildFailureReplyMarkdown`，正文可以有标题/建议/技术细节。
 * CLI 路径（`act.ts` catch）只有一行 `output.error("执行失败: " + message)`，
 * 而 `message` 是上游原文 + AI SDK 的 `RetryError` 前缀：
 *
 *     ✗ 执行失败: Failed after 4 attempts. Last error: Free usage limit
 *       reached. Free models work in OpenCode (https://opencode.ai); ...
 *
 * 对额度用尽这种"重试无用"的失败，这句话既没说清是什么问题，也没说
 * 多久能恢复 —— 用户唯一能做的就是反复重试。
 *
 * ## 产出契约
 *
 * - **单行**、无 `\n`、长度 < 300（不进 stack）
 * - 额度类失败必须带恢复窗口（"约 22 小时后"）
 * - 其他失败退回分类规则的 `title`，保证**任何**错误都不空串
 */
export function formatCliFailureLine(error: unknown): string {
  const info = classifyReactFailure(error);

  if (info.kind === "quota_exhausted") {
    const window = humanizeRetryAfter(info.retryAfterSeconds);
    const head = `${info.title}（${window ? window.replace(/^约 /, "约 ") + "恢复" : "恢复时间未知"}）`;
    const advice = info.suggestion ? ` 建议：${info.suggestion}` : "";
    return `${head} —— 重发同一模型无效。${advice}`.trim();
  }

  // 其余失败：一行标题 + 最有信息量的那句。
  //
  // `technical` 是 `"name | message | statusCode"` 的聚合串，直接取第一段
  // 会拿到 `"Error"` 这种零信息量的名字 —— 所以要挑一段真正有内容的：
  // 优先取包含状态码/数字的段（"429 Too Many Requests"），否则取最长段。
  const segments = (info.technical ?? "")
    .split("|")
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0 && seg.toLowerCase() !== (errorName(error) || "").toLowerCase());

  // Copy before sorting (review MINOR-2): `segments` is freshly built here so
  // in-place would be harmless today, but sorting a caller-visible array in
  // place is a trap for the next edit.
  const informative =
    segments.find((seg) => /\d/.test(seg)) ??
    [...segments].sort((a, b) => b.length - a.length)[0] ??
    "";

  const summary = informative.slice(0, 200);
  return summary ? `${info.title}：${summary}` : info.title;
}

// ============================================================================
// 3. replyChannel 提取
// ============================================================================

/**
 * 从 EnvEvent 提取 replyChannel。
 *
 * 两条路径（与 `event-message-formatter.ts:541-549` 保持一致）：
 * 1. `event.metadata.replyChannel.chatId` — EnvEvent 标配位置
 * 2. `event.payload.replyChannel.chatId`  — EventSourceEvent 兼容位置
 */
function extractReplyChannelFromEvent(envEvent: unknown): FailureReplyChannelLike | undefined {
  if (!envEvent || typeof envEvent !== "object") return undefined;
  const e = envEvent as Record<string, any>;

  const candidates: unknown[] = [
    e.metadata?.replyChannel,
    e.payload?.replyChannel,
  ];

  for (const c of candidates) {
    if (c && typeof c === "object") {
      const ch = c as FailureReplyChannelLike;
      if (ch.chatId || ch.messageId) return ch;
    }
  }

  return undefined;
}

/** replyChannel 是否可用（能定位到触发方目标） */
function isUsableChannel(ch: FailureReplyChannelLike | undefined): boolean {
  if (!ch) return false;
  if (!ch.chatId && !ch.messageId) return false;
  // type 缺省时也接受（老数据可能没有 type，但有 chatId 就能发）
  if (!ch.type) return true;
  const t = ch.type.toLowerCase();
  // ★ Task #5311：白名单 = lark（飞书）+ wecom（企业微信）。
  //   旧实现 `includes("lark")` 把企微 type="wecom-cli" 过滤掉
  //   → 企微群失败零通知（2026-11-11 真实故障）。
  return t.includes("lark") || t.startsWith("wecom");
}

// ============================================================================
// 4. 去重
// ============================================================================

/**
 * 已回复过的 trigger 标记。
 *
 * ## 为什么要带 TTL
 *
 * 早期实现用 `chat:${chatId}` 作为永久 key —— 但同一个飞书群（尤其 p2p）
 * 的 chatId 是**长期不变**的：群里第一次失败回复之后，该群**后续所有失败**
 * 都会被判成 duplicate 而永远沉默，直接违背「不允许静默」的契约。
 *
 * 现在的语义：
 *   - 有 `messageId` → `msg:<id>`（一次 trigger 只回一次，重放/重试不重复）
 *   - 只有 `chatId`  → `chat:<id>:<kind>:<5min bucket>`（同群同类型 5 分钟内
 *     最多回一次，既防重放刷屏，又不会把该群永久封锁）
 */
const repliedTriggers = new Map<string, number>();

/** chat-only 去重的窗口（ms） */
const CHAT_DEDUP_WINDOW_MS = 5 * 60_000;

/** 上限，防止长期运行进程内存无界增长 */
const MAX_DEDUP_ENTRIES = 1000;

function makeDedupKey(
  channel: FailureReplyChannelLike,
  info: ReactFailureInfo,
  explicit?: string,
  now = Date.now(),
): string {
  if (explicit) return explicit;
  if (channel.messageId) return `msg:${channel.messageId}`;
  if (channel.chatId) {
    const bucket = Math.floor(now / CHAT_DEDUP_WINDOW_MS);
    return `chat:${channel.chatId}:${info.kind}:${bucket}`;
  }
  return "unknown";
}

function isDuplicate(key: string, now = Date.now()): boolean {
  const at = repliedTriggers.get(key);
  if (at === undefined) return false;
  // msg: 永不刚过期（同一 messageId 就是同一 trigger）；chat: 随 bucket 自然换 key
  if (key.startsWith("chat:") && now - at >= CHAT_DEDUP_WINDOW_MS) {
    repliedTriggers.delete(key);
    return false;
  }
  return true;
}

function rememberTrigger(key: string, now = Date.now()): void {
  if (repliedTriggers.size >= MAX_DEDUP_ENTRIES) {
    // 淘汰最旧的一条（Map 迭代顺序 = 插入顺序）
    const oldest = repliedTriggers.keys().next().value;
    if (oldest !== undefined) repliedTriggers.delete(oldest);
  }
  repliedTriggers.set(key, now);
}

/** 测试用：清空去重状态 */
export function __resetFailureReplyDedupForTest(): void {
  repliedTriggers.clear();
}

// ============================================================================
// 5. spawn lark-cli（复用现有参数约定）
// ============================================================================

/**
 * 兜底 reply 的硬超时。
 *
 * ★ 这个超时不是「优化」而是**正确性要求**：`QueryExecutor` 在 rethrow 前
 * `await` 兜底 reply。lark-cli 一旦卡住（网络 / 长轮询 / 二进制异常），
 * 没有超时就会让 `execute()` 永不返回 → 原始错误永不抛出 →
 * `EventHandler.waitForIdle()` 永不放行 → 整条事件队列堵死。
 * 这比「静默丢失」更糟。
 */
const DEFAULT_REPLY_TIMEOUT_MS = 5_000;

/**
 * Task #4983 — `ask_user` 问题的**直连投递**（无 TTY 场景专用）。
 *
 * ## 为什么需要独立出口（而不是复用 notifyReactFailure）
 *
 * `notifyReactFailure` 是**失败回执**语义：
 *   - 走 `FAILURE_RULES` 分类，`ask_user` 规则明确 `notify:false`（不发）
 *   - 走去重表（同一 triggerEvent 只回一次）
 *   - 文案是「执行失败 + 建议」
 *
 * 而 ask_user 要发的是「**问题 + 选项 + 答复指引**」—— 是**问用户**，不是回执。
 * 两者语义完全不同，共用一套会互相污染（去重键会撞 / 文案会错）。
 *
 * ## 为什么不 spawn 在 ask_user 工具层
 *
 * `ask_user` 工具在 core 层，拿得到 EnvContext 的 replyChannel：
 *   - **带发送实现**（`sendMarkdown` / `reply`）→ 直接调，不 spawn lark-cli
 *   - **裸快照**（event-cascade 场景，`task.background.ask_user` 的
 *     `metadata.replyChannel` 只有 chatId/messageId/profile，没有函数）
 *     → 必须自己 spawn lark-cli 才有 delivery 能力
 *
 * 两条路都在这里收敛：本函数负责「裸快照 → spawn lark-cli」这一段，
 * 复用本模块已有的 `spawnLarkReply`（已带 `--as bot` / profile / 硬超时 /
 * @-mention 规范化，是全仓口径统一的那一支）。
 *
 * ## 契约
 *
 * - **永不抛**：投递失败只返回 `{sent:false, error}`，调用方自行决定怎么办。
 *   理由：投递故障绝不能掩盖 `ask_user` 的原始中断语义（AskUserError）。
 * - 有 messageId → `+messages-reply`（保持话题线索）；只有 chatId → `+messages-send`。
 */
export async function deliverAskUserMessage(options: {
  /** 目标 chat（oc_xxx） */
  chatId?: string;
  /** 目标消息（om_xxx）—— 有则用 reply 保持话题线索 */
  messageId?: string;
  /** lark-cli profile（多 appId 场景必需，否则 99992361 open_id cross app） */
  profile?: string;
  /** 要投递的正文（问题 + 选项 + 指引） */
  content: string;
  /** 硬超时（ms），默认同失败回执 */
  timeoutMs?: number;
}): Promise<{ sent: boolean; error?: string }> {
  const { chatId, messageId, profile, content } = options;
  if (!chatId && !messageId) {
    return { sent: false, error: "no-target" };
  }
  try {
    await spawnLarkReply({
      chatId,
      messageId,
      content,
      profile,
      timeoutMs: options.timeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS,
    });
    return { sent: true };
  } catch (err) {
    return {
      sent: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * spawn `lark-cli im +messages-{reply,send}`。
 *
 * 参数约定对齐仓里**已带 `--as bot` 的那一半**实现
 * （`event-source-handlers.sendLarkMessage` /
 * `lark-card-patch-notifier.buildSendCardArgs` /
 * `telemetry-notice.buildLarkSendArgs`）：
 * - `--profile <name>` **前置**
 * - 有 messageId → `+messages-reply --message-id <id> --as bot`
 * - 只有 chatId  → `+messages-send --chat-id <id> --as bot`
 *
 * ## ★ Task #4557：chatId 分支**必须**显式 `--as bot`
 *
 * 原实现这一支没带 flag（历史原因：抄的是
 * `LarkCliNotificationChannel` 那一支，而它同样漏了）。后果：
 *
 * 1. 不带 `--as` → lark-cli 用**默认身份 = user（真人账号）**发出
 * 2. `lark-cli event consume im.message.receive_v1` 只看「是不是 user 发的」
 *    → 我们自己发出的失败回执被**同一个 consumer 当成用户消息回灌**
 * 3. 回灌事件再触发一次**完整 agent run** → 又失败 → 又发回执 → 有循环风险
 *
 * 这不是理论：Task #4552 在 telemetry 提示上实测到**回灌率 5/11 = 45%**
 * （token 一点没省还翻倍），补上 `--as bot` 后 **0/5 = 0%**。
 * 证据：本机 E2E 报告 `reports/4552-a1-real-e2e.md` §6（`reports/` 被 .gitignore 忽略，未入库）。本模块是同 bug 类的遗留点
 * （该报告 MINOR #1 已点名）。
 *
 * ## 为什么「失败就 reject」而不是「降级 user」（用户明令）
 *
 * 降级看着更"稳"，但在这条链路上有三个致命问题：
 * 1. **降级就等于回灌** —— user 身份发出去必然被 consumer 吃回来（本 bug 本体），
 *    静默降级 = 偷偷把 bug 放回来，还烧 token
 * 2. **回执本身会变成一条"用户消息"** —— 用户看到的错误信息更混乱，
 *    甚至触发再一轮失败 + 再一条回执
 * 3. **掩盖配置问题** —— 230002（bot 不在会话里）是**需要修**的状态，
 *    不是该绕过的东西
 *
 * 所以：失败 → `finish(err)` → 调用方 swallow + log（本模块已有该层）。
 * 绝不实现「先试 bot 失败降级 user」。
 *
 * 保证：**在 `timeoutMs` 内一定 settle**（成功 / 失败 / 超时 kill），
 * 永远不会挂住调用方。
 */
function spawnLarkReply(options: {
  chatId?: string;
  messageId?: string;
  content: string;
  profile?: string;
  timeoutMs?: number;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const { chatId, messageId, content, profile } = options;
    const timeoutMs = options.timeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };

    const normalizedContent = normalizeLarkAtMentions(content);

    let args: string[];
    if (messageId) {
      args = [
        "im",
        "+messages-reply",
        "--message-id",
        messageId,
        "--markdown",
        normalizedContent,
        "--as",
        "bot",
      ];
    } else if (chatId) {
      args = [
        "im",
        "+messages-send",
        "--chat-id",
        chatId,
        "--markdown",
        normalizedContent,
        // ★ Task #4557：显式 bot 身份。缺了它默认是 user → 失败回执会被
        // lark-cli 自己的 event consume 回灌成「用户消息」→ 再跑一次完整
        // agent run（Task #4552 实测回灌率 45%，修好后 0%）。
        // 失败即 reject，绝不降级成 user（降级 = 把本 bug 放回来）。
        "--as",
        "bot",
      ];
    } else {
      finish(new Error("No target specified for failure reply"));
      return;
    }

    if (profile) {
      args.unshift("--profile", profile);
    }

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("lark-cli", args, {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    // ★ 超时兜底：先 kill 再 settle，避免留下僵尸子进程
    timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* 进程可能已退出 */
      }
      finish(new Error(`lark-cli timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // 允许进程正常退出（不要因为这个定时器把进程留住）
    timer.unref?.();

    let stderr = "";
    proc.stdout?.on("data", () => {
      /* drain */
    });
    proc.stderr?.on("data", (data: Buffer | string) => {
      stderr += data.toString();
    });

    proc.on("close", (code: number | null) => {
      if (code === 0) finish();
      else finish(new Error(`lark-cli exited with code ${code}: ${stderr}`));
    });

    proc.on("error", (err: Error) => finish(err));
  });
}

// ============================================================================
// 5b. 企微 sender（Task #5311 —— 薄封装 sendWecomReply，不重写出站）
// ============================================================================

/**
 * 企微失败回执 sender。
 *
 * ## 为什么是薄封装
 *
 * 企微出站的唯一权威实现在
 * `event-source/wecom-respond-registry.ts` 的 `sendWecomReply`
 * （CLI 主路径 + WS 被动回帧 fallback，**永不抛**，Task #5174 确立）。
 * 这里**只做适配**，不复制任何 CLI 逻辑。
 *
 * ## 契约
 *
 * - **永不抛**：`sendWecomReply` 自身永不抛；本函数再兜一层
 *   （import 失败 / 参数异常），与 `spawnLarkReply` 的 fail-open 一致。
 * - 失败 reject（带 error 文本），由 `notifyReactFailure` 统一吞掉 +
 *   回滚去重标记。
 * - **不等回执确认**（R4 防御）：`sendWecomReply` 返回即认为已投递
 *   （CLI 退出码 / WS send 完成）；企微 bot 消息回灌风险未实测
 *   （Task #5308 R4），故失败通知正文带「⚠️ 系统失败通知」前缀，
 *   即使被回灌也能一眼识别并丢弃。
 */
async function spawnWecomReply(options: {
  chatId?: string;
  messageId?: string;
  content: string;
  /** 企微通道不使用 profile（多 appId 靠 sourceId 区分） */
  profile?: string;
  timeoutMs?: number;
  /** Task #5311：企微扩展参数（sourceId / reqId），从 channel.params 透传 */
  params?: Record<string, unknown>;
}): Promise<void> {
  const { chatId, content, params } = options;
  if (!chatId) {
    throw new Error("No chatId specified for wecom failure reply");
  }

  try {
    // 动态 import：避免 error-reply（hot path，被 cli 包静态依赖）
    // 在模块加载期硬依赖 event-source 模块图（R2 循环依赖防御）。
    const { sendWecomReply } = await import(
      "./event-source/wecom-respond-registry"
    );

    const result = await sendWecomReply({
      // sourceId：WS fallback 实例定位；缺了只影响 fallback 通道
      sourceId:
        (typeof params?.sourceId === "string" && params.sourceId) ||
        "unknown",
      // rawChatId：CLI 侧会经 resolveWecomCliChatId 解析（带缓存）
      rawChatId: chatId,
      reqId: typeof params?.reqId === "string" ? params.reqId : undefined,
      content,
    });

    if (!result.ok) {
      throw new Error(result.error ?? "sendWecomReply failed");
    }
  } catch (err) {
    // fail-open：sendWecomReply 理论上不抛，这里防 import 失败等意外
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * 失败回执 sender 的公共签名（Task #5311 CV M2：显式联合类型，
 * 不用 `as` 强转 —— 让编译器检查两个 sender 的入参兼容性）。
 *
 * `params` 是企微扩展字段（sourceId / reqId），lark sender 忽略它。
 */
type FailureSender = (options: {
  chatId?: string;
  messageId?: string;
  content: string;
  profile?: string;
  timeoutMs?: number;
  params?: Record<string, unknown>;
}) => Promise<void>;

/**
 * 按 channel.type 选择 sender（Task #5311 多通道分流）。
 *
 * - type 以 "wecom" 开头 → 企微（`spawnWecomReply`）
 * - 其余（含 type 缺省的老数据）→ lark（`spawnLarkReply`，原逻辑不动）
 */
function pickSender(channel: FailureReplyChannelLike): FailureSender {
  const t = (channel.type ?? "").toLowerCase();
  if (t.startsWith("wecom")) return spawnWecomReply;
  return spawnLarkReply;
}

// ============================================================================
// 6. 主入口
// ============================================================================

/**
 * React 循环异常中断时，尽最大努力给飞书发一条失败说明。
 *
 * **绝不抛异常** —— 所有错误都被吞掉并记日志，保证不污染原始错误传播。
 *
 * @example
 * ```ts
 * // interactive.ts executeInternal 的 catch 分支
 * } catch (error) {
 *   await notifyReactFailure({
 *     error,
 *     envEvent: this.currentAgentContext?.envEvent,
 *     sessionId: agentContext?.eventSessionId,
 *   });
 *   // …原有错误处理继续
 * }
 * ```
 */
export async function notifyReactFailure(
  options: NotifyReactFailureOptions,
): Promise<NotifyReactFailureResult> {
  const info = classifyReactFailure(options.error);

  // ---- 0. 正常交互（ask_user）不是失败 —— 唯一允许不发的情形
  if (!info.notify) {
    logger.debug(
      `[#4418] 命中规则 ${info.ruleId}（非失败），不发失败说明` +
        (options.sessionId ? ` (session=${options.sessionId})` : ""),
    );
    return { sent: false, kind: info.kind, info, skipped: "not_a_failure" };
  }

  // ---- 1. 定位 replyChannel（显式 > envEvent.metadata > envEvent.payload）
  const channel =
    (isUsableChannel(options.replyChannel) ? options.replyChannel : undefined) ??
    extractReplyChannelFromEvent(options.envEvent);

  if (!isUsableChannel(channel)) {
    // ★ 不允许静默：**有 triggerEvent 却找不到 replyChannel** 是配置/衔接
    //    bug（触发方会一直等不到回复），必须 warn 出来；本地 REPL / act
    //   根本没有事件，只是 debug，避免刷屏。
    //   ★ Task #5311：文案区分两种情形 —— 旧文案统一说「缺少
    //   metadata.replyChannel」，把「channel 存在但 type 不支持」
    //   也说成缺字段，误导排障（2026-11-11 企微故障实录）。
    const hasTrigger = Boolean(options.envEvent);
    const hasChannelObj =
      !hasTrigger ||
      (() => {
        const e = options.envEvent as Record<string, any> | undefined;
        const rc =
          e?.metadata?.replyChannel ?? e?.payload?.replyChannel ?? options.replyChannel;
        return Boolean(rc && typeof rc === "object");
      })();
    const noChannelMsg = hasChannelObj
      ? `[#4418] React 中断（${info.kind}/${info.ruleId}）replyChannel.type 不在支持列表（lark*/wecom*），` +
        `触发方收不到失败说明` +
        (hasTrigger
          ? ` —— channel 存在但 type=${String(
              (options.envEvent as Record<string, any>)?.metadata?.replyChannel?.type ??
                (options.envEvent as Record<string, any>)?.payload?.replyChannel?.type ??
                options.replyChannel?.type ??
                "unknown",
            )} 未被放行`
          : "") +
        (options.sessionId ? ` (session=${options.sessionId})` : "")
      : `[#4418] React 中断（${info.kind}/${info.ruleId}）无法定位 replyChannel，` +
        `触发方收不到失败说明` +
        (hasTrigger
          ? " —— triggerEvent 存在但缺少 metadata.replyChannel"
          : "（本地执行，无 triggerEvent）") +
        (options.sessionId ? ` (session=${options.sessionId})` : "");
    // 注意：不要 `const log = logger.warn` 这样摘方法，logger 方法依赖 `this`
    if (hasTrigger) logger.warn(noChannelMsg);
    else logger.debug(noChannelMsg);
    return { sent: false, kind: info.kind, info, skipped: "no_channel" };
  }

  // ---- 2. 去重（同一 triggerEvent 只回一次；chat-only 走 5 分钟窗口）
  const dedupKey = makeDedupKey(channel!, info, options.dedupKey);
  if (isDuplicate(dedupKey)) {
    logger.info(`[#4418] React 中断（${info.kind}）已回复过 ${dedupKey}，跳过`);
    return { sent: false, kind: info.kind, info, skipped: "duplicate" };
  }

  // ---- 3. 抢占去重标记（先占位，失败再回滚 —— 避免并发重复发送）
  rememberTrigger(dedupKey);

  // ---- 4. 投递（best-effort，但**有硬超时**，见 spawnLarkReply / spawnWecomReply）
  const isWecom = (channel!.type ?? "").toLowerCase().startsWith("wecom");
  const baseContent = buildFailureReplyMarkdown(info, { query: options.query });
  // ★ Task #5311 R4 防御：企微 bot 消息回灌未实测 —— 正文加醒目前缀，
  //   即使被 aibot_message 回调回灌成用户消息，也能一眼识别并丢弃。
  const content = isWecom ? `⚠️ 系统失败通知\n\n${baseContent}` : baseContent;

  try {
    await pickSender(channel!)({
      chatId: channel!.chatId,
      messageId: channel!.messageId,
      content,
      profile: channel!.profile,
      timeoutMs: options.replyTimeoutMs,
      // 企微扩展参数（sourceId / reqId），lark sender 忽略
      params: channel!.params,
    });

    logger.info(
      `[#4418] React 中断（${info.kind}/${info.ruleId}）已回${isWecom ? "企微" : "飞书"} ` +
        `(${channel!.messageId ?? channel!.chatId})`,
    );
    return { sent: true, kind: info.kind, info };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    // ★ 失败必须回滚去重标记 —— 否则一次瞬时失败（CLI 未装 / 网络抖动）
    //    会封锁该 triggerEvent，后续重试永远发不出去
    repliedTriggers.delete(dedupKey);

    logger.warn(
      `[#4418] React 中断（${info.kind}/${info.ruleId}）回${isWecom ? "企微" : "飞书"}失败（已忽略）: ${errorMsg}`,
    );
    return { sent: false, kind: info.kind, info, error: errorMsg };
  }
}
