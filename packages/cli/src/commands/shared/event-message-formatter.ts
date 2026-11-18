/**
 * @fileoverview Event Message Formatter
 * 
 * 将 EnvEvent 格式化为用户可读的消息
 */

import type { EnvEvent } from "@ai-setting/roy-bot-core";

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 格式化结果
 */
export interface FormattedEvent {
  /** 用户可读的消息 */
  message: string;
  /** 原始 EnvEvent */
  envEvent: EnvEvent;
  /** 事件处理共享 session ID（由 EventHandler 注入） */
  eventSessionId?: string;
  /**
   * 父 session ID（从 envEvent.metadata.trigger_session_id 提取）
   * - 如果存在且对应 session 仍在，EventHandler 会复用该父 session 处理事件
   * - 如果不存在或父 session 已消失，fallback 创建新 session
   * 用途: 让 delegate_task 触发的通知处理继承父 session 的对话上下文
   */
  triggerSessionId?: string;
  /**
   * 飞书 chat_id（p2p / 群聊 / task 子群都对应一个 oc_xxx / oc_xxx 群组 ID）
   *
   * 从 envEvent.metadata.replyChannel.chatId 或 envEvent.payload.replyChannel.chatId 提取。
   *
   * - 存在时：EventHandler 会用 chat_id 作为 session 隔离键,
   *   找/建 chat-keyed session, 实现"不同飞书会话 → 不同 session"的对话内容分离
   * - 不存在或非 lark 事件 → undefined
   *
   * 用途: 跟飞书 app robot 私聊会触发任务创建, 每个任务会创建一个独立飞书群聊,
   * 在对应的群聊里聊天时 EventHandler 找到/创建该群聊对应的 session,
   * 让推进任务对话和 bot 私聊互不干扰。
   */
  chatId?: string;
  /**
   * ★ Task #4815：trigger session 不存在时**按该 ID 创建**
   *
   * 从 envEvent.metadata.createSessionIfMissing 提取（boolean）。
   *
   * 用途：让 timer 事件路由到**独立 session**（如"每日总结"专属 session），
   * 而不是 fallback 到 REPL 主会话。
   *
   * - true  → trigger session 不存在时用该 ID 创建（复用 trigger 维度缓存）
   * - false/undefined → 保持既有行为（fallback 到主会话 / 新建随机 ID session）
   */
  createTriggerSessionIfMissing?: boolean;
}

// ============================================================================
// Event Type Mapping
// ============================================================================

/**
 * 任务事件类型（来自 BackgroundTaskManager）
 * 使用 task.background.* 前缀
 */
export const TaskEventTypes = {
  TASK_STARTED: "task.background.started",
  TASK_PROGRESS: "task.background.progress",
  TASK_COMPLETED: "task.background.completed",
  TASK_FAILED: "task.background.failed",
  TASK_TIMEOUT: "task.background.timeout",
  TASK_STOPPED: "task.background.stopped",
  /**
   * Task #3xxx — sub-agent ask_user cascade
   * 当 delegate_task 触发的 sub-agent 内部调用 ask_user tool 时，
   * BackgroundTaskManager 发布此事件，REPL 收到后向用户提问。
   */
  TASK_ASK_USER: "task.background.ask_user",
} as const;

/**
 * EventSource 事件类型
 */
export const EventSourceEventTypes = {
  EVENT_SOURCE_STARTED: "event-source.started",
  EVENT_SOURCE_STOPPED: "event-source.stopped",
  EVENT_SOURCE_EVENT_PREFIX: "event-source.event.",
} as const;

/**
 * 事件元信息接口
 */
export interface EventMetadata {
  eventType?: string;
  appId?: string;
  chatId?: string;
  chatType?: string;
  messageId?: string;
  messageType?: string;
  senderId?: string;
  tenantKey?: string;
  [key: string]: unknown;
}

/**
 * 推荐动作接口
 */
export interface RecommendedAction {
  action: string;
  replyTo?: {
    appId?: string;
    chatId?: string;
    messageId?: string;
  };
  rawCommand?: string;
}

/**
 * EventSource 事件负载接口
 */
export interface EventSourceEventPayload {
  sourceId: string;
  sourceType: string;
  rawEvent: unknown;
  message: string;
  metadata: EventMetadata;
  recommendedAction?: RecommendedAction;
  timestamp: number;
}

/**
 * 后台任务事件负载接口（来自 BackgroundTaskManager）
 */
export interface BackgroundTaskEventPayload {
  backgroundTaskId: string;
  subSessionId: string;
  parentSessionId: string;
  description: string;
  subagentType: string;
  status?: string;
  progress?: number;
  progressMessage?: string;
  result?: string;
  error?: string;
  executionTimeMs?: number;
  associatedTaskId?: number;
}

/**
 * Task #3147 — task.background.ask_user 事件专用 payload（标准 notify 流程）
 *
 * 继承自 BackgroundTaskEventPayload，新增 ask_user 解码后的字段。
 *
 * 关键：hints 是 rule-based 提示数组，由 BackgroundTaskManager 在构造 ASK_USER
 * 事件时填充（事件自带）。formatter 只负责渲染（[🤖 Agent 操作提示] 块），
 * handler 端零特殊化——事件跟其他 task.background.* 一样走 notify → executeInternal。
 *
 * 主 agent 看到 formatted message 后会：
 *   1. 用 ask_user tool 把 query 展示给用户并等答复
 *   2. 拿到用户答复后用 delegate_task(subagentType, sub_session_id, ...)
 *      复用 sub-session 让 sub-agent 继承消息历史继续推进
 */
export interface BackgroundTaskAskUserEventPayload extends BackgroundTaskEventPayload {
  query: string;
  sessionId: string;
  nodeId: string;
  nodeType: string;
  agentSessionId?: string;
  /** Task #3147 — Rule-based hints（事件自带，由 BackgroundTaskManager 填充） */
  hints?: string[];
}

/**
 * 格式化选项
 */
export interface EventMessageFormatterOptions {
  /** 消息前缀 */
  prefix?: string;
  /** 是否显示详细时间 */
  showTimestamp?: boolean;
}

// ============================================================================
// EventMessageFormatter
// ============================================================================

/**
 * 事件消息格式化器
 * 
 * 将 EnvEvent 转换为用户可读的文本消息
 */
export class EventMessageFormatter {
  private prefix: string;
  private showTimestamp: boolean;

  constructor(options: EventMessageFormatterOptions = {}) {
    this.prefix = options.prefix ?? "[通知]";
    this.showTimestamp = options.showTimestamp ?? false;
  }

  /**
   * 格式化事件为用户消息
   */
  format(event: EnvEvent): string {
    const { type, payload } = event;
    
    // 根据事件类型格式化
    switch (type) {
      case TaskEventTypes.TASK_STARTED:
        return this.formatTaskStarted(payload as BackgroundTaskEventPayload);
      case TaskEventTypes.TASK_PROGRESS:
        return this.formatTaskProgress(payload as BackgroundTaskEventPayload);
      case TaskEventTypes.TASK_COMPLETED:
        return this.formatTaskCompleted(payload as BackgroundTaskEventPayload);
      case TaskEventTypes.TASK_FAILED:
        return this.formatTaskFailed(payload as BackgroundTaskEventPayload);
      case TaskEventTypes.TASK_TIMEOUT:
        return this.formatTaskTimeout(payload as BackgroundTaskEventPayload);
      case TaskEventTypes.TASK_STOPPED:
        return this.formatTaskStopped(payload as BackgroundTaskEventPayload);
      case TaskEventTypes.TASK_ASK_USER:
        return this.formatTaskAskUser(payload as BackgroundTaskAskUserEventPayload);
      case EventSourceEventTypes.EVENT_SOURCE_STARTED:
        return this.formatEventSourceStarted(payload as EventSourceEventPayload);
      case EventSourceEventTypes.EVENT_SOURCE_STOPPED:
        return this.formatEventSourceStopped(payload as EventSourceEventPayload);
      default:
        // 处理 event-source.event.* 类型的事件
        if (type.startsWith(EventSourceEventTypes.EVENT_SOURCE_EVENT_PREFIX)) {
          return this.formatEventSourceEvent(event);
        }
        return this.formatGeneric(event);
    }
  }

  /**
   * 格式化任务开始事件
   */
  private formatTaskStarted(payload: BackgroundTaskEventPayload): string {
    const desc = payload.description || "未命名任务";
    return `${this.prefix} 📢 后台任务「${desc}」已启动`;
  }

  /**
   * 格式化任务进度事件
   *
   * 注意：不再渲染 `payload.progress` 百分比。
   * 后台任务的真实进度由子代理通过 task_get / task_list 等工具主动查询，
   * 这里只提示"任务还在进行中"。如果子代理主动调用 task_update 设置了
   * progressMessage，可附加显示，否则不渲染任何百分比。
   */
  private formatTaskProgress(payload: BackgroundTaskEventPayload): string {
    const desc = payload.description || "未命名任务";
    const message = payload.progressMessage || "";
    const taskId = payload.associatedTaskId;

    let result = `${this.prefix} 🔄 后台任务「${desc}」`;
    if (taskId !== undefined) {
      result += `[Task #${taskId}] `;
    }
    result += `还在进行中，请耐心等待。需查询具体进度可调用 task_get / task_operation_list 等工具`;
    if (message) result += ` - ${message}`;

    return result;
  }

  /**
   * 格式化任务完成事件
   */
  private formatTaskCompleted(payload: BackgroundTaskEventPayload): string {
    const desc = payload.description || "未命名任务";
    const result = payload.result;
    const time = payload.executionTimeMs ? `(${this.formatDuration(payload.executionTimeMs)})` : "";
    const bgProcessId = payload.backgroundTaskId || "";
    const taskId = payload.associatedTaskId;

    let message = `${this.prefix} ✅ 后台任务「${desc}」已完成 ${time}`;
    if (bgProcessId) {
      message += `\nbgprocess: ${bgProcessId}`;
    }
    if (taskId !== undefined) {
      message += `\nTask #${taskId}`;
    }
    if (result) {
      // ★ 2026-07-17（Task #2102）：按用户要求「后台进程任务的通知不允许截断」，
      //   直接保留完整 result。原代码有 typo（阈值 10000 但截断到 100），
      //   导致任何超过 100 字符的 result 都被截断到只剩 100 字符。
      message += `\n结果: ${result}`;
    }
    // ★ 2026-07-10（Task #1752）：附加 subSessionId，便于 default agent 在重试时复用 sub session
    message += this.appendSubSessionId(payload);

    return message;
  }

  /**
   * 格式化任务失败事件
   */
  private formatTaskFailed(payload: BackgroundTaskEventPayload): string {
    const desc = payload.description || "未命名任务";
    const error = payload.error || "未知错误";
    const time = payload.executionTimeMs ? `(${this.formatDuration(payload.executionTimeMs)})` : "";
    const bgProcessId = payload.backgroundTaskId || "";
    const taskId = payload.associatedTaskId;

    let message = `${this.prefix} ❌ 后台任务「${desc}」失败 ${time}`;
    if (bgProcessId) {
      message += `\nbgprocess: ${bgProcessId}`;
    }
    if (taskId !== undefined) {
      message += `\nTask #${taskId}`;
    }
    if (error) {
      // 截断过长错误信息
      const truncatedError = error.length > 100
        ? error.substring(0, 100) + "..."
        : error;
      message += `\n错误: ${truncatedError}`;
    }
    // ★ 2026-07-10（Task #1752）：附加 subSessionId，便于 default agent 在重试时复用 sub session
    message += this.appendSubSessionId(payload);

    return message;
  }

  /**
   * 格式化任务超时事件
   */
  private formatTaskTimeout(payload: BackgroundTaskEventPayload): string {
    const desc = payload.description || "未命名任务";
    const time = payload.executionTimeMs ? `(${this.formatDuration(payload.executionTimeMs)})` : "";
    const bgProcessId = payload.backgroundTaskId || "";
    const taskId = payload.associatedTaskId;

    let message = `${this.prefix} ⏱️ 后台任务「${desc}」超时 ${time}`;
    if (bgProcessId) {
      message += `\nbgprocess: ${bgProcessId}`;
    }
    if (taskId !== undefined) {
      message += `\nTask #${taskId}`;
    }
    // ★ 2026-07-10（Task #1752）：附加 subSessionId（重试重用的关键字段）
    message += this.appendSubSessionId(payload);

    return message;
  }

  /**
   * 格式化任务停止事件
   */
  private formatTaskStopped(payload: BackgroundTaskEventPayload): string {
    const desc = payload.description || "未命名任务";
    const time = payload.executionTimeMs ? `(${this.formatDuration(payload.executionTimeMs)})` : "";
    const bgProcessId = payload.backgroundTaskId || "";
    const taskId = payload.associatedTaskId;

    let message = `${this.prefix} 🛑 后台任务「${desc}」已停止 ${time}`;
    if (bgProcessId) {
      message += `\nbgprocess: ${bgProcessId}`;
    }
    if (taskId !== undefined) {
      message += `\nTask #${taskId}`;
    }
    // ★ 2026-07-10（Task #1752）：附加 subSessionId
    message += this.appendSubSessionId(payload);

    return message;
  }

  /**
   * Task #3147 — 格式化 ask_user 通知事件（标准 notify event）
   *
   * 渲染内容：
   *   1. `[通知] ❓ 后台子代理「desc」请求用户输入` 前缀 + bgprocess + subSessionId
   *   2. 原始 query（透传给用户/LLM）
   *   3. **[🤖 Agent 操作提示]** 块：内容来自 payload.hints（rule-based），
   *      由 BackgroundTaskManager 在构造 ASK_USER 事件时填充。
   *
   * 关键：formatter 不再硬编码 Agent 操作提示文案，只渲染 payload.hints。
   * 这样 handler 端零特殊化——事件跟其他 task.background.* 一样走
   * notify → executeInternal 路径。
   *
   * run 模式（RunTui.handleNotification）会把 format 结果直接塞进 LLM；
   * REPL 模式（handleEventMessageWithEnv → executeInternal）同样。
   * LLM 看到 hint 后会：
   *   1. 用 ask_user tool 把 query 展示给用户并等待回复
   *   2. 拿到用户回复后用 delegate_task(subagentType=payload.subagentType,
   *      sub_session_id=payload.subSessionId, prompt=<基于用户回复>)
   *      复用 sub-session 让 sub-agent 继承消息历史继续推进。
   *
   * 选 ours (Task #3147 决定)：formatter 只渲染 payload.hints，不硬编码操作提示。
   */
  private formatTaskAskUser(payload: BackgroundTaskAskUserEventPayload): string {
    const desc = payload.description || "未命名任务";
    const bgProcessId = payload.backgroundTaskId || "";
    const subSessionId = payload.subSessionId || "";
    const query = payload.query || "(空问题)";

    let message = `${this.prefix} ❓ 后台子代理「${desc}」请求用户输入`;
    if (bgProcessId) {
      message += `\nbgprocess: ${bgProcessId}`;
    }
    if (subSessionId) {
      message += `\nsubSessionId: ${subSessionId}`;
    }
    message += `\n\n${query}`;

    // Task #3147 — Agent 操作提示来自 payload.hints（rule-based 事件自带）。
    // formatter 只渲染，handler 端零特殊化。
    if (payload.hints && payload.hints.length > 0) {
      message += `\n\n[🤖 Agent 操作提示]`;
      for (const hint of payload.hints) {
        message += `\n${hint}`;
      }
    }

    return message;
  }

  /**
   * 追加 subSessionId 行（2026-07-10 新增，Task #1752 subSessionId 复用机制）
   *
   * 用于任务通知中显示 sub session ID，方便 default agent 复制用于重试。
   * 仅在 payload.subSessionId 存在时追加。
   */
  private appendSubSessionId(payload: BackgroundTaskEventPayload): string {
    if (payload.subSessionId) {
      return `\nsubSessionId: ${payload.subSessionId}`;
    }
    return "";
  }

  /**
   * 格式化通用事件
   */
  private formatGeneric(event: EnvEvent): string {
    return `${this.prefix} 收到事件: ${event.type}`;
  }

  // ============================================================================
  // EventSource 事件格式化
  // ============================================================================

  /**
   * 格式化事件源启动事件
   */
  private formatEventSourceStarted(payload: EventSourceEventPayload): string {
    return `${this.prefix} 📡 事件源「${payload.sourceId}」(类型: ${payload.sourceType}) 已启动`;
  }

  /**
   * 格式化事件源停止事件
   */
  private formatEventSourceStopped(payload: EventSourceEventPayload): string {
    return `${this.prefix} 📡 事件源「${payload.sourceId}」(类型: ${payload.sourceType}) 已停止`;
  }

  /**
   * 格式化事件源收到的事件（如飞书消息）
   * 
   * 泛化处理：直接序列化事件为可读文本，不依赖特定字段
   */
  private formatEventSourceEvent(event: EnvEvent): string {
    const payload = event.payload as any;
    const sourceType = payload?.sourceType || "unknown";
    const message = payload?.message || "";
    
    // 直接使用 EventSourceComponent 格式化好的 message
    if (message) {
      return `[${sourceType}] ${message}`;
    }
    
    // 如果没有预格式化的 message，整个事件序列化
    return `[${sourceType}] ${JSON.stringify(payload, null, 2)}`;
  }

  // ============================================================================
  // 辅助方法
  // ============================================================================

  /**
   * 格式化时长
   */
  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}秒`;
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}分${seconds}秒`;
  }

  /**
   * 格式化事件并返回完整的事件对象
   *
   * 同时从 event.metadata.trigger_session_id 提取父 session ID，
   * 从 event.metadata.replyChannel.chatId 提取飞书 chat_id。
   * EventHandler 会用它们来决定 session 复用：
   * - trigger_session_id → 复用父 session (delegate_task 通知继承上下文)
   * - chat_id → 复用/创建 chat-keyed session (不同飞书会话 → 不同 session)
   *
   * @param event EnvEvent
   * @returns FormattedEvent 包含消息和原始事件
   */
  formatWithEvent(event: EnvEvent): FormattedEvent {
    const triggerSessionId = extractTriggerSessionId(event);
    const chatId = extractChatId(event);
    const createTriggerSessionIfMissing = extractCreateSessionIfMissing(event);
    return {
      message: this.format(event),
      envEvent: event,
      triggerSessionId,
      chatId,
      createTriggerSessionIfMissing,
    };
  }
}

/**
 * ★ Task #4815：从 EnvEvent.metadata.createSessionIfMissing 提取标记
 *
 * 返回 true 当且仅当 metadata.createSessionIfMissing === true。
 */
export function extractCreateSessionIfMissing(event: EnvEvent): boolean | undefined {
  const flag = event?.metadata?.createSessionIfMissing;
  return flag === true ? true : undefined;
}

/**
 * 从 EnvEvent.metadata.trigger_session_id 提取父 session ID
 *
 * 返回 undefined 当：
 * - metadata 为空
 * - metadata.trigger_session_id 不存在
 * - metadata.trigger_session_id 不是非空字符串
 *
 * @param event EnvEvent
 * @returns 父 session ID 或 undefined
 */
export function extractTriggerSessionId(event: EnvEvent): string | undefined {
  const triggerSessionId = event?.metadata?.trigger_session_id;
  if (typeof triggerSessionId === "string" && triggerSessionId.length > 0) {
    return triggerSessionId;
  }
  return undefined;
}

/**
 * 从 EnvEvent.metadata.replyChannel.chatId 提取飞书 chat_id
 *
 * lark-cli event 的 replyChannel 结构:
 *   { type: 'lark-cli', chatId: 'oc_xxx', messageId: 'om_xxx', ... }
 *
 * 提取顺序（第一个有效值即返回）：
 * 1. event.metadata.replyChannel.chatId (EnvEventMetadata 标配位置)
 * 2. event.payload.replyChannel.chatId (EventSourceEvent 兼容位置)
 *
 * 返回 undefined 当：
 * - replyChannel 不存在
 * - chatId 不是非空字符串
 *
 * @param event EnvEvent
 * @returns 飞书 chat_id (e.g., "oc_xxx") 或 undefined
 */
export function extractChatId(event: EnvEvent): string | undefined {
  // 路径 1: event.metadata.replyChannel.chatId (EnvEvent 通用位置)
  const metaChannel = event?.metadata?.replyChannel as { chatId?: string } | undefined;
  if (metaChannel?.chatId && typeof metaChannel.chatId === "string" && metaChannel.chatId.length > 0) {
    return metaChannel.chatId;
  }
  // 路径 2: event.payload.replyChannel.chatId (EventSourceEvent 兼容位置)
  const payload = event?.payload as { replyChannel?: { chatId?: string } } | undefined;
  const payloadChannel = payload?.replyChannel;
  if (payloadChannel?.chatId && typeof payloadChannel.chatId === "string" && payloadChannel.chatId.length > 0) {
    return payloadChannel.chatId;
  }
  return undefined;
}
