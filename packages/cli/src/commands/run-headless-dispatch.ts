/**
 * @fileoverview Task #5117 (M1) — headless 事件分发器
 *
 * 方案 docs/task-4954-run-output-simplification-plan.md §4.2：
 *   把 REPL 里「交互」与「事件语义」解耦 —— 事件处理语义（replyChannel
 *   解析/缓存、pluginEnabled 注入、agentContext 构造）原样平移到这里，
 *   交互（提示符/欢迎框/流式渲染）全部剥离。
 *
 * 不动项对照（§3.2）：
 *   N7 replyChannel 解析与缓存语义 —— 本文件 1:1 平移 REPL 的实现
 *      （含 #4108 P1-a per-chatId LRU 缓存），行为零变化。
 *   事件 → execute 回调（原 executeInternal 的 onExecute 语义）。
 *
 * 剥离项对照（§3.3）：
 *   P9 [通知2] 带色通知 → 降级为 [event] 摘要行。
 *   P7/P8 [Trace]/[thinking] → 不再输出（traceId 进 [result] 行）。
 *   P12 SIGINT 语义 → 由 run.ts 直接走 graceful shutdown，不在此处。
 */

import { getTracerProvider, type SpanContext, type ContentPart } from "@ai-setting/roy-bot-core";
import { createLogger } from "@ai-setting/roy-bot-core";
// Task #4418: React 中断必须反馈到飞书（与原 executeInternal 相同兜底）
import { notifyReactFailure } from "@ai-setting/roy-bot-core/env/error-reply";
// ★ Task #5174：企微 turn 级兜底补发（LLM 不调 wecom_respond 时框架自己发）
import { autoReplyWecomTurn } from "@ai-setting/roy-bot-core/env/event-source/wecom-respond-registry";
// AskUserError 解析（与原 executeInternal 相同兜底）
import { AskUserError } from "@ai-setting/roy-bot-core";
import { resetStreamAbort } from "../services/stream-output.service";
import type { RunHeadlessSummary } from "./run-headless-summary";

const logger = createLogger("cli:run-headless-dispatch");

/** per-chatId replyChannel LRU 上限（与 REPL.REPLY_CHANNEL_CHAT_CACHE_MAX 一致） */
const REPLY_CHANNEL_CHAT_CACHE_MAX = 100;

/** 执行回调 —— 由 run.ts handler 提供（= 原 REPL.options.onExecute 的闭包体） */
export type HeadlessExecuteFn = (
  message: string | ContentPart[],
  traceId?: string,
  agentContext?: any,
) => Promise<string>;

/** FormattedEvent（与 EventHandler 的 FormattedEvent 兼容的结构） */
export interface HeadlessFormattedEvent {
  message: string;
  envEvent: any;
  eventSessionId?: string;
  triggerSessionId?: string;
  chatId?: string;
  createTriggerSessionIfMissing?: boolean;
}

export interface HeadlessDispatcherOptions {
  /** 默认 sessionId（fallback 路由用） */
  sessionId: string;
  /** 执行回调（= 原 onExecute） */
  execute: HeadlessExecuteFn;
  /** 摘要渲染器（[event]/[result] 行） */
  summary: RunHeadlessSummary;
}

/**
 * headless 事件分发器。
 *
 * 职责：
 *   1. handleEventMessageWithEnv 的**语义平移**（N7）：
 *      replyChannel 解析 / per-chatId LRU 缓存 / pluginEnabled 构造 /
 *      agentContext 组装 → execute。
 *   2. 执行态按 session 引用计数（N8 门禁的 REPL 侧等价物）。
 *   3. 每轮 [result] 摘要行。
 *
 * 非职责（已剥离）：交互、UI、流式渲染、SIGINT REPL 语义。
 */
export class HeadlessDispatcher {
  private options: HeadlessDispatcherOptions;
  /** chatId → replyChannel（带上限 LRU；#4108 P1-a 语义平移） */
  private lastReplyChannel: any = undefined;
  private lastReplyChannelByChat: Map<string, any> = new Map();
  /** per-session 执行态引用计数（原 executingSessions） */
  private executingSessions: Map<string, number> = new Map();

  constructor(options: HeadlessDispatcherOptions) {
    this.options = options;
  }

  /** 是否有任何 session 在跑（原 isIdle() 的反面） */
  isBusy(): boolean {
    for (const count of this.executingSessions.values()) {
      if (count > 0) return true;
    }
    return false;
  }

  /** 某 session 是否空闲（原 isSessionIdle） */
  isSessionIdle(sessionId: string): boolean {
    return (this.executingSessions.get(sessionId) ?? 0) === 0;
  }

  /** 标记某 session 进入 / 退出执行态（原 markSessionExecuting） */
  markSessionExecuting(sessionId: string, executing: boolean): void {
    const counts = this.executingSessions;
    if (executing) {
      counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
      return;
    }
    const current = counts.get(sessionId) ?? 0;
    if (current <= 1) {
      counts.delete(sessionId);
    } else {
      counts.set(sessionId, current - 1);
    }
  }

  /** 更新 per-chat replyChannel 缓存（原 rememberReplyChannelForChat） */
  private rememberReplyChannelForChat(chatId: string, channel: any): void {
    if (this.lastReplyChannelByChat.has(chatId)) {
      this.lastReplyChannelByChat.delete(chatId);
    }
    this.lastReplyChannelByChat.set(chatId, channel);
    while (this.lastReplyChannelByChat.size > REPLY_CHANNEL_CHAT_CACHE_MAX) {
      const oldest = this.lastReplyChannelByChat.keys().next().value;
      if (oldest === undefined) break;
      this.lastReplyChannelByChat.delete(oldest);
    }
  }

  /**
   * 处理事件消息（REPL.handleEventMessageWithEnv 的 headless 平移，N7）。
   *
   * 与原实现的差异（全部是剥离项，语义零变化）：
   *   - `console.log("[通知2] ❯ ...")` → `summary.event(...)`（P9）
   *   - `ensureActiveSession` 保留为可注入回调（run.ts 提供）
   */
  async handleEventMessageWithEnv(
    formattedEvent: HeadlessFormattedEvent,
    deps: { ensureActiveSession?: () => Promise<void> } = {},
  ): Promise<void> {
    const { message, envEvent, eventSessionId } = formattedEvent;

    // P9: 事件到达 → [event] 摘要行（原 [通知2] 带色多行块）
    const srcId = envEvent?.metadata?.sourceId;
    this.options.summary.event(
      srcId ?? "unknown",
      envEvent?.type ?? "unknown",
      message,
    );

    // Task #1766: 确保有 active session（与原实现相同的入口确认）
    await deps.ensureActiveSession?.();

    // ===== 以下 1:1 平移原 handleEventMessageWithEnv 的语义（N7）=====
    const sourceId = envEvent?.metadata?.sourceId;
    let pluginEnabled = envEvent?.metadata?.pluginEnabled as Record<string, boolean> | undefined;
    let plugins = envEvent?.metadata?.plugins as string[] | undefined;

    if (!pluginEnabled || Object.keys(pluginEnabled).length === 0) {
      pluginEnabled = {};
      for (const pluginName of plugins || []) {
        const key = `${sourceId}:${pluginName}`;
        pluginEnabled[key] = true;
      }
    }

    const agentFromEvent = envEvent?.metadata?.agent as string | undefined;

    // Task #3058: replyChannel fallback（notify event 修复）— 语义原样平移
    let envEventForAgent = envEvent;
    const eventReplyChannel = envEvent?.metadata?.replyChannel;
    const eventChatId =
      (eventReplyChannel as { chatId?: string } | undefined)?.chatId ??
      formattedEvent.chatId ??
      (envEvent as { payload?: { replyChannel?: { chatId?: string } } })?.payload
        ?.replyChannel?.chatId;

    if (eventReplyChannel) {
      this.lastReplyChannel = eventReplyChannel;
      const rcChatId = (eventReplyChannel as { chatId?: string }).chatId;
      if (rcChatId) this.rememberReplyChannelForChat(rcChatId, eventReplyChannel);
    } else {
      const fallbackChannel =
        (eventChatId ? this.lastReplyChannelByChat.get(eventChatId) : undefined) ??
        this.lastReplyChannel;
      if (fallbackChannel) {
        envEventForAgent = {
          ...envEvent,
          metadata: {
            ...(envEvent?.metadata ?? {}),
            replyChannel: fallbackChannel,
          },
        };
      }
    }

    const agentContext = {
      agentType: agentFromEvent,
      pluginEnabled,
      envEvent: envEventForAgent,
      plugins,
      eventSessionId: eventSessionId,
      systemPrompt: envEvent?.metadata?.systemPrompt as string | undefined,
      // ★ Task #5333：渠道专用工具放行名单（同 run.ts）
      extendTools: envEvent?.metadata?.extendTools as string[] | undefined,
    };

    await this.executeWithSummary(message, eventSessionId, agentContext);
  }

  /**
   * 执行一轮并输出 [result] 摘要行。
   *
   * = 原 executeInternal 的 headless 等价物（保留：trace span、
   * per-session 占用、错误兜底 notifyReactFailure；剥离：UI 占位、
   * ask_user 交互链、prompt 重画）。
   */
  async executeWithSummary(
    message: string | ContentPart[],
    sessionId: string | undefined,
    agentContext: any,
  ): Promise<void> {
    const execSessionId = sessionId ?? this.options.sessionId;
    const summary = this.options.summary;

    // ★ Task #4515 (M6)：mark 是本轮第一个动作（finally 严格配对）
    this.markSessionExecuting(execSessionId, true);

    const agentContextMerged = {
      ...agentContext,
      eventSessionId: agentContext?.eventSessionId ?? execSessionId,
    };

    // 重置 abort 信号（与原 executeInternal 相同）
    resetStreamAbort();

    const provider = getTracerProvider();
    const tracer = provider.getTracer("roy-tracer");
    const payloadTraceContext = (
      (agentContextMerged as { envEvent?: { metadata?: { traceContext?: unknown } } } | undefined)
        ?.envEvent?.metadata as { traceContext?: SpanContext } | undefined
    )?.traceContext;
    const existingContext: SpanContext | undefined =
      payloadTraceContext ?? provider.getGlobalContext();

    let rootSpan: ReturnType<typeof tracer.startSpan> | undefined;
    let traceId: string | undefined;
    let runTraceContext: any = existingContext;
    const startedAt = Date.now();

    try {
      await provider.withGlobalContext(runTraceContext, async () => {
        if (existingContext) {
          rootSpan = tracer.startSpan("run.headless.execute", {
            parent: existingContext,
          });
          traceId = existingContext.traceId;
        } else {
          rootSpan = tracer.startSpan("run.headless.execute");
          traceId = rootSpan.spanContext.traceId;
          runTraceContext = rootSpan.spanContext;
        }
        // P7/P8：[Trace]/[thinking] 占位不再输出 —— traceId 进 [result] 行
        const finalText = await this.options.execute(
          message,
          traceId,
          agentContextMerged,
        );
        // ★ Task #5174：企微渠道 turn 级兜底补发。
        //
        // 背景（real-run-8, trace 01a1b935e9f0）：LLM 直接把回复写在 assistant
        // text 里结束，`toolCallCount=0`，从未调用 wecom_respond —— 用户永远
        // 收不到回复。靠 systemPrompt 指导 LLM 自觉调工具**不可靠**。
        //
        // 这里在 turn 结束后兜底：若本轮没通过 wecom_respond 发过（工具成功
        // 会置标记），就把最终文本直接发出（CLI 主路径 → WS fallback）。
        // 非企微事件 / 空文本 / 已发送 → 内部 skipped，零副作用。
        try {
          const auto = await autoReplyWecomTurn(
            (agentContextMerged as { envEvent?: unknown })?.envEvent,
            typeof finalText === "string" ? finalText : "",
          );
          if (!auto.skipped) {
            logger.info(
              `[#5174] wecom auto-reply: ok=${auto.ok} channel=${auto.channel ?? "-"}` +
                (auto.error ? ` error=${auto.error}` : ""),
            );
            if (!auto.ok) {
              console.error(
                `[#5174] wecom auto-reply FAILED: ${auto.error ?? "unknown"}`,
              );
            }
          }
        } catch (autoErr) {
          // 兜底发送失败绝不能影响主流程
          logger.warn("wecom auto-reply threw (ignored)", {
            error: String(autoErr),
          });
        }
      });
      summary.result({
        sessionId: execSessionId,
        status: "ok",
        durationMs: Date.now() - startedAt,
        summary: traceId ? `trace=${traceId}` : "done",
      });
    } catch (error) {
      // AskUserError 在 headless 下没有交互通道 —— 降级为 error 摘要 +
      // notifyReactFailure 兜底（飞书侧用户仍能看到失败说明）。
      const isAskUser = error instanceof AskUserError;
      summary.result({
        sessionId: execSessionId,
        status: "error",
        durationMs: Date.now() - startedAt,
        summary: isAskUser
          ? "ask_user 在 headless 模式不可用，已跳过"
          : `执行失败: ${String(error)}`,
      });
      rootSpan?.setAttribute("error", String(error));
      try {
        await notifyReactFailure({
          error,
          envEvent: (agentContextMerged as { envEvent?: unknown })?.envEvent,
          sessionId: (agentContextMerged as { eventSessionId?: string })?.eventSessionId,
        });
      } catch (notifyErr) {
        console.error(`[#4418] 失败说明回飞书异常:`, notifyErr);
      }
      logger.warn("headless turn failed", { error: String(error) });
    } finally {
      try {
        provider.runInGlobalContextSync(runTraceContext, () => rootSpan?.end());
      } catch (endErr) {
        logger.warn("root span end failed (ignored)", { error: String(endErr) });
      }
      this.markSessionExecuting(execSessionId, false);
    }
  }
}
