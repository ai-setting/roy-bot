/**
 * @fileoverview Query Executor - 查询执行共享逻辑
 * 
 * 从 act.ts 抽取的查询执行逻辑，供 interactive 复用
 * 
 * 功能：
 * - 初始化 SummaryAgent
 * - 订阅 LLM/上下文事件
 * - 流式输出
 * - ContextHandler 执行
 * - 支持 abort 流式输出
 */

import { OutputService } from "../../services/output.service";
import { StreamOutputService } from "../../services/stream-output.service";
import type { StreamChunkCallback } from "../../services/stream-output.service";
import { ContextHandlerService } from "../../services/context-handler.service";
import type {
  BaseEnvironment,
  SessionComponent,
  LLMComponent,
  PromptComponent,
  ContentPart,
} from "@ai-setting/roy-bot-core";
import { ContextError, ErrorCodes, TracedAs } from "@ai-setting/roy-bot-core";
// Task #4418: React 循环异常中断 → 飞书兜底 reply（默认通知器）
import { notifyReactFailure } from "@ai-setting/roy-bot-core/env/error-reply";
// ★ Task #4983: ask_user 问题的兜底直发（复用全仓统一发送口径）
import { deliverAskUserMessage } from "@ai-setting/roy-bot-core/env/error-reply";
import type { FailureReplyChannelLike } from "@ai-setting/roy-bot-core/env/error-reply";
import { createLogger } from "@ai-setting/roy-bot-core/env/log-trace/logger";

const logger = createLogger("cli:query-executor");

export interface QueryExecutorOptions {
  env: BaseEnvironment;
  sessionComponent: SessionComponent;
  output: OutputService;
  quiet: boolean;
  /**
   * Task #2286: silent 模式 — 透传到 StreamOutputService
   *
   * silent=true 时 StreamOutputService 不写 stdout，仅通过 chunk callback 输出。
   * ink REPL 模式必须设 true，否则 stdout 输出 + chunk callback 双源导致重复渲染。
   *
   * 默认 false（向后兼容 readline 路径）。
   */
  silent?: boolean;
  /**
   * Task #4418: React 循环异常中断的飞书兜底通知器（可注入，便于测试）。
   *
   * 默认用 core 的 `notifyReactFailure`（spawn lark-cli）。
   * 注入点存在的理由：单元测试不想真的 spawn lark-cli，也不想
   * 依赖 bun 的 `vi.mock` 局部覆盖（Bun 不支持 importOriginal）。
   */
  failureNotifier?: FailureNotifier;
  /**
   * ★ Task #4983 — `ask_user` 问题的**兜底投递器**（可注入，便于测试）。
   *
   * ## 为什么需要这一层（防御纵深，不是重复实现）
   *
   * 主修在 core 的 `ask_user` 工具层：抛错**之前**就把问题投到 IM 渠道。
   * 但工具层是**可选路径**：
   *   - 工具层投递依赖 EnvContext 里有 replyChannel；
   *   - 若 EnvContext 缺失 / replyChannel 不完整 / 工具层投递失败
   *     ⇒ 问题又会退回「异常冒泡 → 静默」。
   *
   * 本层是**最后一层网**：React 循环因 AskUserError 中断时，若本轮**确实有**
   * 可用 replyChannel，就把问题正文投出去。
   *
   * ## 为什么不会双发
   *
   * 工具层成功投递后，会把「已投递」标记写进 error 编码
   * （`__ASK_USER_ERROR__:{…,delivered:true}`）⇒ 本层读到 `delivered:true`
   * 就**跳过**。详见 core 侧 `agent-component.ts` 的 AskUserError 编码分支。
   */
  askUserNotifier?: AskUserNotifier;
}

/**
 * ★ Task #4983 — ask_user 兜底投递器签名。
 *
 * `delivered` 表示「工具层已经投递过了」⇒ 调用方应跳过（防双发）。
 */
export type AskUserNotifier = (options: {
  /** 问题正文 */
  query: string;
  /** 本轮触发事件（用于定位 replyChannel） */
  envEvent?: unknown;
  /** 工具层是否已经投递过（true ⇒ 跳过） */
  delivered: boolean;
  /** 会话 ID（日志用） */
  sessionId?: string;
}) => Promise<void>;

export interface StreamOptions {
  showReasoning: boolean;
  showToolCalls: boolean;
  showToolResults: boolean;
}

/**
 * Task #4418: 失败兜底通知器签名。
 *
 * 与 core 的 `notifyReactFailure` 完全一致，但**返回值放宽为 void**，
 * 因为调用方不关心投递结果（best-effort，永不抛）。
 */
export type FailureNotifier = (options: {
  error: unknown;
  envEvent?: unknown;
  replyChannel?: FailureReplyChannelLike;
  query?: string;
  sessionId?: string;
  dedupKey?: string;
}) => Promise<unknown>;

/**
 * Task #4418: 判断是否为 AskUserError（= 正常交互流，不是失败）。
 *
 * 三种形态都要识别（与 interactive.ts:parseAskUserError 对齐）：
 * 1. `name === "AskUserError"` 的 Error 实例
 * 2. message 含 `__ASK_USER_ERROR__:` 前缀（agent-component 的编码形式）
 * 3. 有 `type === "ask-user"` 标记的对象
 */
function isAskUserError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as Record<string, unknown>;
  if (e.name === "AskUserError") return true;
  if (e.type === "ask-user") return true;
  if (typeof e.message === "string" && e.message.includes("__ASK_USER_ERROR__:")) {
    return true;
  }
  return false;
}

/**
 * ★ Task #4983 — 解析 AskUserError 载荷（问题正文 + 是否已投递）。
 *
 * 三种形态都要识别（与 core 侧 `agent-component.ts` 的编码对齐）：
 * 1. `__ASK_USER_ERROR__:{JSON}` 前缀（env.handle_query 路径，**生产主路径**）
 * 2. Error 实例带 `query` 字段
 * 3. `type === "ask-user"` 的对象
 *
 * `delivered` 字段由 core 的 ask_user 工具层写入：
 *   - `true`  → 工具层已经把问题投到 IM 渠道了 ⇒ CLI 层**不**能再投（防双发）
 *   - `false` / 缺失 → 工具层没投成 ⇒ CLI 层兜底投
 */
export function parseAskUserErrorPayload(error: unknown): {
  query: string;
  delivered: boolean;
} | null {
  if (!error || typeof error !== "object") return null;
  const e = error as Record<string, unknown>;

  // 1) __ASK_USER_ERROR__: 前缀（生产主路径）
  const message = typeof e.message === "string" ? e.message : "";
  const prefix = "__ASK_USER_ERROR__:";
  if (message.includes(prefix)) {
    try {
      const jsonPart = message.substring(message.indexOf(prefix) + prefix.length);
      const parsed = JSON.parse(jsonPart) as { query?: unknown; delivered?: unknown };
      if (typeof parsed.query === "string") {
        return {
          query: parsed.query,
          delivered: parsed.delivered === true,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  // 2) 直接的 AskUserError 实例 / 2) type === 'ask-user' 的对象
  if (typeof e.query === "string") {
    return {
      query: e.query,
      delivered: (e as { delivered?: unknown }).delivered === true,
    };
  }

  return null;
}

/**
 * ★ Task #4983 — 默认的 ask_user 兜底投递器。
 *
 * 走 core 的 `deliverAskUserMessage`（复用全仓统一发送口径：`--as bot` /
 * profile / 硬超时 / @-mention 规范化）。
 *
 * ⚠️ 与工具层的区别：工具层拿得到 EnvContext.replyChannel（带发送实现），
 * 本层只有 envEvent —— 所以要先从 envEvent 里解析出 chatId/messageId/profile。
 */
async function defaultAskUserNotifier(options: {
  query: string;
  envEvent?: unknown;
  delivered: boolean;
  sessionId?: string;
}): Promise<void> {
  if (options.delivered) return;

  const channel = extractReplyChannelFromEnvEvent(options.envEvent);
  if (!channel) {
    logger.warn(
      "[#4983] ask_user 兜底投递失败：无法定位 replyChannel（本地执行无事件源，或事件缺 metadata.replyChannel）",
    );
    return;
  }

  const text = buildAskUserFallbackText(options.query);
  const result = await deliverAskUserMessage({
    chatId: channel.chatId,
    messageId: channel.messageId,
    profile: channel.profile,
    content: text,
  });

  if (!result.sent) {
    logger.warn("[#4983] ask_user 兜底投递失败（已忽略）", {
      error: result.error,
      chatId: channel.chatId,
    });
  }
}

/** 从 envEvent 里解析 replyChannel（metadata → payload）。 */
function extractReplyChannelFromEnvEvent(envEvent: unknown): {
  chatId?: string;
  messageId?: string;
  profile?: string;
} | undefined {
  if (!envEvent || typeof envEvent !== "object") return undefined;
  const e = envEvent as Record<string, any>;
  const candidates = [e.metadata?.replyChannel, e.payload?.replyChannel];
  for (const c of candidates) {
    if (c && typeof c === "object") {
      const ch = c as { chatId?: string; messageId?: string; profile?: string };
      if (ch.chatId || ch.messageId) {
        return {
          chatId: ch.chatId,
          messageId: ch.messageId,
          profile: ch.profile,
        };
      }
    }
  }
  return undefined;
}

/**
 * ★ Task #4983 — 兜底投递的正文。
 *
 * 硬要求：含问题正文 + 答复指引（用户要能对上号、要知道怎么答）。
 */
export function buildAskUserFallbackText(query: string): string {
  return [
    "❓ **需要您确认**",
    "",
    query.trim(),
    "",
    "👉 直接在本会话回复文字即可（例如「是」/「否」/具体说明）。",
  ].join("\n");
}

/**
 * ★ Task #5217 — 构建传给 handleQueryWithContext 的 context（纯函数，可测）。
 *
 * ## 为什么抽出来（Task #5210 排查 → #5217 修复）
 *
 * 原 context 构造内联在 execute() 里，构造顺序是
 *   `{ sessionId, metadata: {...systemPrompt}, ...restAgentContext }`
 * —— `...restAgentContext` 在 metadata 字面量**之后**展开。而
 * buildInteractiveMergedContext / handleEventMessageWithEnv 构造的
 * agentContext **自带 metadata key**（run.ts / interactive.ts），
 * restAgentContext.metadata 整体覆盖前面的 metadata 字面量
 * → metadata.systemPrompt（lean 渠道 prompt）丢失
 * → AgentComponent._run 读 `context?.metadata?.systemPrompt` 得 undefined
 * → 三条注入路径中的「新主 session」路径全断。
 *
 * ## 修复语义
 *
 * - metadata 字面量**最后**展开，systemPrompt / originalQuery / traceId
 *   三键是本层的权威写入（不丢）
 * - agentContext.metadata 的其余字段 **浅合并保留**（如 defaultAgentName）
 * - 其余 agentContext 字段（pluginEnabled / envEvent / agentType 等）
 *   保持顶层 spread（行为不变）
 *
 * @param sessionId       会话 ID
 * @param message         用户消息（originalQuery）
 * @param traceId         本次执行的 trace id
 * @param agentContext    上层构造的 agent context（可 undefined）
 */
export function buildQueryContext(
  sessionId: string,
  message: string | ContentPart[],
  traceId: string | undefined,
  agentContext?: any,
): any {
  const {
    systemPrompt: agentContextSystemPrompt,
    eventSourceSystemPrompt: agentContextPreloadedPrompts,
    ...restAgentContext
  } = agentContext ?? {};

  // 优先级: event-time systemPrompt > 预加载 systemPrompts > null
  // - event-time: 单个 event 触发的 source prompt (Phase B.11+, single string)
  // - preloaded: --es 启动时 resolve 出来的所有 source prompts (Phase 3, single 拼接字符串)
  // 调用方如果同时提供两者，event-time 覆盖 preloaded（向后兼容）。
  let eventSourceFinalPrompt: string | undefined;
  if (typeof agentContextSystemPrompt === "string" && agentContextSystemPrompt.length > 0) {
    eventSourceFinalPrompt = agentContextSystemPrompt;
  } else if (typeof agentContextPreloadedPrompts === "string" && agentContextPreloadedPrompts.length > 0) {
    eventSourceFinalPrompt = agentContextPreloadedPrompts;
  }

  const { metadata: agentContextMetadata, ...restWithoutMetadata } =
    restAgentContext as {
      metadata?: Record<string, unknown>;
      [key: string]: unknown;
    };

  return {
    sessionId,
    // 合并 agentContext 其余字段（如 pluginEnabled, envEvent, agentType 等）
    ...restWithoutMetadata,
    // ★ Task #5217：metadata 字面量**最后**展开 —— 本层三键
    //   （originalQuery / traceId / systemPrompt）权威写入，
    //   agentContext.metadata 的其余字段浅合并保留。
    //   修复前 metadata 在 ...restAgentContext 之前展开，被
    //   agentContext 自带的 metadata 整体覆盖 → systemPrompt 丢失。
    metadata: {
      ...(agentContextMetadata ?? {}),
      originalQuery: message,
      traceId,
      // EventSource systemPrompt（Phase B.11 + Phase 3）：
      // - event-time：EventSourceConfig.systemPrompt → event.metadata.systemPrompt → handleEventMessageWithEnv → 当前 AgentContext.systemPrompt
      // - preload: --es 启动时 resolve → onExecute 注入 eventSourceSystemPrompt
      // 这里搬到 context.metadata.systemPrompt 喂给 AgentComponent._run。
      systemPrompt: eventSourceFinalPrompt,
    },
  };
}

/**
 * QueryExecutor - 查询执行器
 * 
 * 封装查询执行的完整流程
 */
export class QueryExecutor {
  private env: BaseEnvironment;
  private sessionComponent: SessionComponent;
  private output: OutputService;
  private quiet: boolean;
  /** Task #2286: silent 模式 — 透传到 StreamOutputService */
  private silent: boolean = false;
  private streamService: StreamOutputService | null = null;
  private unsubscribe: (() => void) | null = null;
  private streamOptions: StreamOptions = {
    showReasoning: true,
    showToolCalls: true,
    showToolResults: false,
  };
  private _pendingContextConfig: { contextWindow: number; thresholdRatio: number } | null = null;
  /**
   * Task #4486 Phase 3: 本 executor 归属的 session。
   *
   * 并发多 session 时，一个 QueryExecutor 实例只应渲染自己 session 的
   * llm / tool 事件（StreamOutputService session 过滤），并且只响应对应
   * run 的 abort（per-run abort 隔离）。
   *
   * 可能在 streamService 创建之前设置 → 与 _pendingChunkCallback 一样缓存。
   */
  private _pendingSessionScope: string | undefined = undefined;
  /**
   * ★ Task #4515 (M2 × H3): pending「是否接收无 sessionId 事件」策略。
   * undefined = 没设置过（沿用 StreamOutputService 默认 true）。
   */
  private _pendingAcceptsSideless: boolean | undefined = undefined;
  /**
   * ★ Task #4515 (M2 × H3): 调用方**是否显式配置过** sideless 策略。
   *
   * 为什么不能用 `_pendingAcceptsSideless === undefined` 判断：那个 pending 值
   * 在 `subscribeToEvents()` 应用后就**被清成 undefined** 了，于是 `execute()`
   * 无法区分「从没配过」和「配过 false 已经应用了」—— 结果把 per-session
   * executor 的 false 覆盖回 true（生产顺序：opt-out → execute），扇出回归。
   *
   * 这个标志一旦置位就不再复位，专门给 `execute()` 做"是否该套默认值"的判据。
   */
  private _sidelessPolicyExplicit = false;
  /**
   * Task #2283: pending chunk callback.
   *
   * QueryExecutor.setChunkCallback 可能在 streamService 创建之前被调用
   * （interactive.ts handler 闭包调用顺序：先 setChunkCallback, 第一次 execute 才创建 streamService）。
   * 跟 _pendingContextConfig 一样，缓存到 streamService 创建时再应用。
   */
  private _pendingChunkCallback: StreamChunkCallback | undefined = undefined;

  /**
   * Task #4418: 失败兜底通知器（默认 core 的 notifyReactFailure）。
   * 见 QueryExecutorOptions.failureNotifier。
   */
  private failureNotifier: FailureNotifier;

  /**
   * ★ Task #4983: ask_user 兜底投递器（默认 `defaultAskUserNotifier`）。
   * 见 QueryExecutorOptions.askUserNotifier。
   */
  private askUserNotifier: AskUserNotifier;

  constructor(options: QueryExecutorOptions) {
    this.env = options.env;
    this.sessionComponent = options.sessionComponent;
    this.output = options.output;
    this.quiet = options.quiet;
    this.silent = options.silent ?? false;
    this.failureNotifier = options.failureNotifier ?? (notifyReactFailure as FailureNotifier);
    this.askUserNotifier = options.askUserNotifier ?? defaultAskUserNotifier;
  }

  /**
   * 把 summary 用的 prompt + llm 组件挂到 session 上，供后续 SummaryAgent 使用。
   * 调用方传入 llm、prompt 顺序；这里转成 sessionComponent 期望的 (prompt, llm) 顺序。
   */
  initSummaryAgent(llmComponent: LLMComponent, promptComponent: PromptComponent): void {
    const session = this.sessionComponent as unknown as {
      setSummaryComponents?: (prompt: PromptComponent, llm: LLMComponent) => void;
    };
    if (typeof session.setSummaryComponents === "function") {
      session.setSummaryComponents(promptComponent, llmComponent);
    }
  }

  /**
   * 初始化流式输出配置（设置 context window 信息）
   */
  initStreamOutput(llmComponent: LLMComponent | null, providerId: string = "minimax"): void {
    if (llmComponent) {
      const contextConfig = llmComponent.getContextThresholdConfig(providerId);
      // 延迟设置：在 subscribeToEvents 时设置
      this._pendingContextConfig = contextConfig;
    }
  }

  /**
   * 订阅事件（用于流式输出）
   */
  subscribeToEvents(options: StreamOptions): void {
    this.streamOptions = options;

    if (this.streamService) {
      this.streamService.setOptions(options);
    }

    // 只订阅一次
    if (this.unsubscribe) {
      return;
    }

    this.streamService = new StreamOutputService({
      ...options,
      // Task #2286: 透传 silent 选项
      silent: this.silent ?? false,
    });

    // Task #2283 fix: 应用 pending chunk callback (如果 streamService 创建前调过 setChunkCallback)
    if (this._pendingChunkCallback !== undefined) {
      this.streamService.setChunkCallback(this._pendingChunkCallback);
      this._pendingChunkCallback = undefined;
    }

    // ★ Task #4515 (M2 × H3): 应用 pending "无 sessionId 事件"策略
    if (this._pendingAcceptsSideless !== undefined) {
      this.streamService.setAcceptsSidelessEvents(this._pendingAcceptsSideless);
      this._pendingAcceptsSideless = undefined;
    }

    // ★ Task #4486 Phase 3: 应用 pending session scope（session 过滤 + per-run abort）
    if (this._pendingSessionScope !== undefined) {
      this.streamService.setSessionFilter(this._pendingSessionScope);
      this.streamService.setRunId(this._pendingSessionScope);
    }

    // 设置 context window 信息
    if (this._pendingContextConfig) {
      this.streamService.setContextInfo(
        this._pendingContextConfig.contextWindow,
        this._pendingContextConfig.contextWindow * this._pendingContextConfig.thresholdRatio
      );
      this._pendingContextConfig = null;
    }

    this.unsubscribe = this.env.subscribeTo(
      [
        "llm.start",
        "llm.text",
        "llm.reasoning",
        "llm.completed",
        "llm.error",
        "tool.call",
        "tool.result",
        "tool.error",
        "context.threshold_exceeded",
        "context.compacting",
        "context.compacted",
      ],
      (event) => this.handleEvent(event)
    );
  }

  /**
   * Task #2280: 设置外部 chunk 回调（ink REPL 集成用）。
   * 透传到 StreamOutputService.setChunkCallback。
   *
   * Task #2283 fix: streamService 可能还未创建（第一次 execute 之前调用）。
   * 用 _pendingChunkCallback 缓存，subscribeToEvents 创建 streamService 时再应用。
   * 传 undefined 等于关闭（默认行为，向后兼容）。
   */
  setChunkCallback(cb: StreamChunkCallback | undefined): void {
    if (this.streamService) {
      this.streamService.setChunkCallback(cb);
    } else {
      this._pendingChunkCallback = cb;
    }
  }

  /**
   * ★ Task #4486 Phase 3: 设置本 executor 的 session 作用域。
   *
   * 效果（同时作用于 StreamOutputService）：
   * 1. session 过滤 —— 只渲染该 session 的 llm / tool 事件
   * 2. runId 绑定 —— per-run abort 隔离（别的 run 被 abort 不影响本 run）
   *
   * 传 undefined 等于解除（回到旧的全局语义，向后兼容）。
   *
   * 可能在 streamService 创建前调用（同 setChunkCallback 的时序约束），
   * 用 _pendingSessionScope 缓存，subscribeToEvents 创建时再应用。
   */
  setSessionScope(sessionId: string | undefined): void {
    this._pendingSessionScope = sessionId;
    if (this.streamService) {
      this.streamService.setSessionFilter(sessionId);
      this.streamService.setRunId(sessionId);
    }
  }

  /**
   * ★ Task #4515 (M2 × H3): 设置是否接收"没有 sessionId"的事件。
   *
   * 主 executor（兜底主人）→ true；per-session executor → false。
   * 不设时 StreamOutputService 默认 true（向后兼容）。
   *
   * 必须在 `subscribeToEvents()` 之前或 streamService 已创建之后调用；
   * 未创建时缓存到 `_pendingAcceptsSideless`，创建时应用。
   */
  setAcceptsSidelessEvents(accepts: boolean): void {
    this._pendingAcceptsSideless = accepts;
    this._sidelessPolicyExplicit = true;
    this.streamService?.setAcceptsSidelessEvents(accepts);
  }

  /**
   * 处理事件
   */
  protected handleEvent(event: any): void {
    // 上下文事件
    if (event.type === "context.threshold_exceeded" && !this.quiet) {
      const payload = event.payload as any;
      this.output.warn(`⚙ 上下文阈值 (${payload.totalTokens}/${payload.contextWindow})`);
    }
    if (event.type === "context.compacting" && !this.quiet) {
      this.output.info("⚙ 压缩中...");
    }
    if (event.type === "context.compacted" && !this.quiet) {
      this.output.success(`✓ 已压缩 (${event.payload.checkpointId})`);
    }

    // 其他事件交给 streamService
    this.streamService?.handleEvent(event);
  }

  /**
   * 执行查询
   */
  @TracedAs("cli.query-executor.execute", { recordParams: true, log: true })
  async execute(
    message: string | ContentPart[],
    sessionId: string,
    streamOptions?: Partial<StreamOptions>,
    traceId?: string,
    agentContext?: any
  ): Promise<string> {
    // 合并流式选项
    const options: StreamOptions = {
      showReasoning: streamOptions?.showReasoning ?? this.streamOptions.showReasoning,
      showToolCalls: streamOptions?.showToolCalls ?? this.streamOptions.showToolCalls,
      showToolResults: streamOptions?.showToolResults ?? this.streamOptions.showToolResults,
    };

    // 订阅并刷新流式选项（仅 env 订阅一次，选项与状态每次 execute 重置）
    this.subscribeToEvents(options);

    // ★ Task #4515 (H3): **结构性**绑定本次执行的 session 过滤。
    //
    //   修复前：主 executor（用户输入用）从不调 setSessionScope，于是
    //   StreamOutputService 的 sessionFilter 是 undefined（不过滤）→ 它会把
    //   **别 session 的 llm.* / tool.* 事件也渲染一遍**。而事件驱动 turn 又用
    //   per-session executor 渲染了同一批事件 → 重复渲染。
    //
    //   为什么放在 execute() 而不是只在 interactive.ts 接线：`execute()` 的
    //   `sessionId` 参数就是本次执行的权威 session，在这里绑定的收益是
    //   「任何调用方都不可能忘记绑」—— 结构性保证，而非约定。每轮 execute 都刷
    //   新一次，同一个 executor 复用给不同 session 时也不会残留旧 scope。
    //
    //   与 setSessionScope() 的区别：那是「显式覆盖」，会被这里的每轮刷新覆盖
    //   掉。所以 `setSessionScope(undefined)` 的含义是"回到由 execute(sessionId)
    //   自动绑定"，而不是"永久解绑"。
    if (sessionId) {
      this.streamService?.setSessionFilter(sessionId);
      this.streamService?.setRunId(sessionId);
      // ★ Task #4515 (M2 × H3): execute() 自己驱动的这个 executor 默认是"主人"，
      //   无 sessionId 的事件由它渲染（否则 M2 修完会变成所有 executor 各渲染一份）。
      //
      //   ⚠️ 必须用 `_sidelessPolicyExplicit` 判断，**不能**看 pending 值是否
      //   undefined —— pending 在 subscribeToEvents() 应用后就被清空了。
      //   生产顺序是「setAcceptsSidelessEvents(false) → execute()」，用 pending
      //   判断会把 per-session executor 的 opt-out 覆盖回 true（扇出回归，
      //   交叉验证实测 3 份）。
      if (!this._sidelessPolicyExplicit) {
        this.streamService?.setAcceptsSidelessEvents(true);
      }
    }

    this.streamService?.reset();

    if (!this.quiet) {
      this.output.info(`执行: ${message}`);
    }

    // 创建 Context Handler
    const contextHandler = new ContextHandlerService(
      this.env,
      this.sessionComponent,
      { maxRetries: 1, autoCompact: true }
    );

    // 构建 context（携带 trace id 和 agentContext）
    //
    // Phase B.11+: EventSource systemPrompt 字段（如 bounty-im 默认 prompt）通过
    // agentContext.systemPrompt 传递，需要放进 context.metadata.systemPrompt
    // 才能被 AgentComponent._run 注入到 agent system prompt（_run 读的是
    // context.metadata.systemPrompt，不是 context.systemPrompt）。
    //
    // 其他 agentContext 字段（pluginEnabled / envEvent / agentType 等）保持顶层 spread。
    //
    // ★ Task #5217：构造逻辑抽成纯函数 buildQueryContext ——
    //   修复 metadata 字面量被 ...restAgentContext（含 agentContext.metadata）
    //   整体覆盖导致 systemPrompt 丢失的 bug（Task #5210 排查根因链）。
    const context = buildQueryContext(sessionId, message, traceId, agentContext);

    // 执行查询
    // @TracedAs("cli.query-executor.execute") 装饰器会创建 span
    let result: string;
    try {
      result = await contextHandler.handleQueryWithContext(message, context);
    } catch (error) {
      // ★ Task #4418: React 循环异常中断 → 尽最大努力给飞书发一条失败说明。
      //
      // 用户诉求（2026-10-21）：「这个失败导致的 react 中断，也需要找到对应的
      // triggerEvent 构建 response 让飞书方知道（送一个 reply 哈）」。
      //
      // 为什么在这里兜底（而不是 interactive.ts / RunTui.tsx）：
      // - 这里是**唯一**执行入口，一处覆盖 interactive / run / run --es 三种模式
      // - 位于 ContextHandlerService（已做 context compact retry）下游，
      //   只兜底真正救不回来的失败，不跟 ContextError 的重试逻辑打架
      // - 不依赖各调用方的私有状态
      //
      // 契约：**绝不吞掉原始错误**、**绝不让 reply 失败影响传播**。
      await this.replyOnReactFailure(error, message, context);

      if (error instanceof ContextError && error.code === ErrorCodes.CONTEXT_THRESHOLD_EXCEEDED) {
        this.output.error(
          `上下文阈值超出限制: ${error.usage?.totalTokens}/${error.contextWindow}`
        );
        this.output.info(
          "请手动压缩会话: roy-bot sessions compact " + sessionId
        );
      }
      throw error;
    }

    if (!this.quiet) {
      this.output.success("执行完成");
    }

    return result;
  }

  /**
   * ★ Task #4983 — ask_user 的**兜底投递**（最后一层网）。
   *
   * 触发条件：React 循环因 AskUserError 中断，且**工具层没有投递过**。
   *
   * 「工具层有没有投递过」怎么知道？
   *   - core 的 `agent-component.ts` 在编码 AskUserError 时会把
   *     `delivered` 标记写进 `__ASK_USER_ERROR__:{…}` JSON 里；
   *   - 工具层投递成功后写 `delivered:true`（未投递/投递失败写 false）。
   *
   * ⚠️ **绝不抛**：本方法是 best-effort 兜底，失败只记 warn。
   *   （抛了会掩盖原始 AskUserError，让上层以为是别的问题。）
   */
  private async notifyAskUserIfNeeded(
    error: unknown,
    context?: any,
  ): Promise<void> {
    try {
      const parsed = parseAskUserErrorPayload(error);
      if (!parsed) return;

      // 工具层已投递 ⇒ 绝不双发
      if (parsed.delivered) return;

      const notifier = this.askUserNotifier;
      await notifier({
        query: parsed.query,
        envEvent: context?.envEvent ?? context?.metadata?.envEvent,
        delivered: false,
        sessionId: context?.sessionId,
      });
    } catch (err) {
      logger.warn("[#4983] ask_user 兜底投递失败（已忽略）", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Task #4418: React 循环异常中断时的飞书兜底回复。
   *
   * **永不抛异常** —— 内部完全吞掉所有错误，只记日志：
   * 兜底回复失败绝不能掩盖或替换原始错误，否则用户会看到
   * 「notify 失败」而不是「真正的失败原因」。
   *
   * @param error     原始错误（可能是 RetryError / ContextError / AbortError / 任意）
   * @param query     原始 query（会被截断后放进 reply，便于用户对上号）
   * @param context   AgentContext，从里面取 envEvent（= 对应的 triggerEvent）
   */
  private async replyOnReactFailure(
    error: unknown,
    query: string | ContentPart[],
    context?: any,
  ): Promise<void> {
    try {
      // AskUserError 是**正常交互流**（agent 主动询问用户），不是失败。
      // 它有自己的 handleAskUserInteraction 路径（interactive.ts:1303），
      // 这里必须排除，否则每次 agent 提问都会误发一条「执行失败」。
      //
      // ★ Task #4983：**但 headless 场景不能就这么静默丢掉**。
      //
      // 背景（生产 traceId 01a1a686…，2026-11-04 20:55:38 → 20:56:09）：
      // sub-agent 的 ask_user 请求正确发布为 `task.background.ask_user` 事件
      // （triggerEventId + replyChannel 都齐），但主 agent 那一轮的 ask_user
      // 抛出的 AskUserError **没人接** ⇒ 这里 `return` 之后异常继续冒泡
      // ⇒ 问题正文从未离开进程 ⇒ 用户零感知（用户原话：「被淹没了」）。
      //
      // 现在 core 的 ask_user 工具层会**优先**把问题投出去（主修）；
      // 本层是**兜底**：只有「工具层没投成」时才补投。
      if (isAskUserError(error)) {
        await this.notifyAskUserIfNeeded(error, context);
        return;
      }

      const envEvent = context?.envEvent ?? context?.metadata?.envEvent;

      await this.failureNotifier({
        error,
        envEvent,
        // 多模态 query 压成文本摘要（Buffer 不能进 reply）
        query: typeof query === "string" ? query : undefined,
        sessionId: context?.sessionId,
      });
    } catch (notifyErr) {
      // best-effort：绝不影响原始错误传播
      logger.warn("[#4418] React 中断兜底回复失败（已忽略）", {
        error: String(notifyErr),
      });
    }
  }

  /**
   * 清理资源
   */
  dispose(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /**
   * 获取流式输出服务的完整文本
   */
  getFullText(): string {
    return this.streamService?.getFullText() ?? "";
  }

  /**
   * 获取最近一次 LLM 调用的 usage 信息。
   *
   * F1: REPL 在每次 `onExecute` 返回后调用此方法，渲染
   * `💰 Cache: read X / write Y (...)` 一行（基于 Anthropic 公开定价
   * 估算节省的 USD 成本）。`null` 表示当前 LLM 调用没有上报 cache 字段
   * （非 Anthropic provider 或不支持 prompt cache 的 endpoint）。
   */
  getLastUsage(): {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cacheRead?: number;
    cacheWrite?: number;
  } | null {
    return this.streamService?.getUsageInfo() ?? null;
  }

  /**
   * 重置流式输出状态（供测试和 query 之间复用）
   */
  resetStream(): void {
    this.streamService?.reset();
  }

  /**
   * 手动压缩会话上下文
   * 
   * 复用 ContextHandlerService.compactSession 逻辑
   */
  async compact(sessionId: string): Promise<{
    success: boolean;
    checkpoint?: any;
    deletedMessageCount?: number;
    error?: string;
  }> {
    try {
      // 发布压缩开始事件
      const envCore = this.env.getComponent("core") as any;
      if (envCore?.pushEnvEvent) {
        envCore.pushEnvEvent({
          type: "context.compacting",
          metadata: { sessionId },
          payload: {},
        });
      }

      // 执行 compact
      // ★ Task #4933（C 方案）：CompactOptions 只剩 scenarioHint。
      //   旧的 summary 字段在 compact() 中从未被读取 —— 不再传递。
      const result = await this.sessionComponent.compact(sessionId, {});

      // 发布压缩完成事件
      if (envCore?.pushEnvEvent) {
        envCore.pushEnvEvent({
          type: "context.compacted",
          metadata: { sessionId },
          payload: {
            checkpointId: result.checkpoint.id,
            messagesCompacted: result.deletedMessageCount,
          },
        });
      }

      return {
        success: true,
        checkpoint: result.checkpoint,
        deletedMessageCount: result.deletedMessageCount,
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.output.error(`压缩失败: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }
}
