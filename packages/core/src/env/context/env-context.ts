/**
 * @fileoverview EnvContext - 线程级事件上下文
 * 用于在异步调用链中传递所有相关上下文信息
 *
 * 解决的问题：
 * - EventSource 发出的 EnvEvent 信息需要传递到各 Hook 点
 * - 避免层层传递导致的接口污染
 *
 * 使用方式：
 * - 在 AgentComponent.run() 开始时设置 EnvContext
 * - 任何地方通过 getEnvContext() 获取
 * - Hook/Plugin 中使用 getEnvContextOrEmpty()
 */

import { AsyncLocalStorage } from "async_hooks";

// ========================================================================
import { createLogger } from "../log-trace/logger";
import { wrapFunction } from "../log-trace/decorator";
import {
  type EventEnvelope,
} from "./env-event";

// Re-export event types so callers can import everything from env-context
export {
  type EventEnvelope,
  type EventSource,
  EVENT_ENV_PREFIX,
  serializeEventToEnv,
  restoreEventFromEnv,
  // Source-specific helpers
  isLarkEvent,
  isGithubEvent,
  isJiraEvent,
  getLarkMessageId,
  getLarkChatId,
  getLarkUserId,
} from "./env-event";

const logger = createLogger("env:context:env-context");
// Types
// ========================================================================

/**
 * ReplyChannel - 回复通道接口
 *
 * 基于 lark-cli 接口设计：
 * - messages-send: 需要 userId/chatId + content + as
 * - messages-reply: 需要 messageId + content + as
 *
 * 使用示例：
 * ```typescript
 * // 发送消息到用户
 * await replyChannel.sendText("Hello!");
 * await replyChannel.sendMarkdown("**Bold** text");
 *
 * // 回复原消息
 * await replyChannel.reply({ text: "Reply content" });
 * ```
 */
export interface ReplyChannel {
  /** 渠道类型，如 "lark" */
  type: string;

  /** 消息 ID（用于回复，om_xxx 格式） */
  messageId?: string;

  /** 用户 ID（用于发送，ou_xxx 格式） */
  userId?: string;

  /** 聊天 ID（用于发送，oc_xxx 格式） */
  chatId?: string;

  /**
   * 飞书应用 ID（cli_xxx 格式，多 appId 场景用）
   *
   * ★ 用于在新建群聊时通过 --bots <appId> 把 bot 自动拉入群聊。
   * 例如 PerTaskGroupChatPlugin 创建 task 群聊时会读这个字段来决定邀请哪个 bot 加入群。
   *
   * 数据来源：lark-cli event header.app_id 或 eventsource config.appId。
   */
  appId?: string;

  /** 身份类型：bot | user */
  identity?: "bot" | "user";

  /**
   * lark-cli profile（多 appId 场景用，#1637）
   *
   * 飞书 openId 是 per-app 隔离的,不同 event-source 对应不同 appId,
   * 回复时必须用对应 app 的 lark-cli profile 才能成功。
   * 错误使用 profile 会导致 `open_id cross app` 错误(99992361)。
   *
   * 不设置时使用 lark-cli 的 active profile(默认行为)。
   */
  profile?: string;

  /**
   * 发送文本消息
   * 调用 lark-cli: im +messages-send --user-id/--chat-id --text
   */
  sendText(text: string): Promise<void>;

  /**
   * 发送 Markdown 消息
   * 调用 lark-cli: im +messages-send --user-id/--chat-id --markdown
   */
  sendMarkdown(markdown: string): Promise<void>;

  /**
   * 发送富文本消息（JSON content）
   * 调用 lark-cli: im +messages-send --content
   */
  sendMessage(message: unknown): Promise<void>;

  /**
   * 回复指定消息（使用 messageId）
   * 调用 lark-cli: im +messages-reply --message-id
   */
  reply(message: unknown): Promise<void>;
}

/**
 * EnvContext - 事件上下文
 *
 * 包含请求处理的所有相关信息，可在任意层级获取
 *
 * 设计原则：
 * 1. rawEvent 存储完整的 EnvEvent，Plugin 按需从其中提取字段
 * 2. replyChannel 由 EnvEvent 中的 replyChannel 构建
 * 3. sourceId、userId 等可作为快捷访问字段（从 EnvEvent 提取）
 */

/**
 * LarkEventContext - DEPRECATED: 飞书事件 payload 容器 (Task #2326 → Task #2331)
 *
 * @deprecated Task #2331 重构：env context 已通用化为 EventEnvelope。
 * 请使用 EventEnvelope 替代，通过 source='lark' + payload 包含 lark 字段。
 * lark-cli plugin 内部用 getLarkMessageId()/getLarkChatId()/getLarkUserId() 提取字段。
 *
 * 保留这个 type alias 用于：
 * 1. 文档/迁移说明引用
 * 2. 第三方代码可能 import 这个类型
 *
 * 新代码请使用 EventEnvelope (来自 './env-event')。
 */
export interface LarkEventContext {
  /** 飞书消息 ID（om_xxx 格式） */
  messageId: string;
  /** 飞书聊天 ID（oc_xxx 格式） */
  chatId?: string;
  /** 用户 open_id（ou_xxx 格式） */
  userId?: string;
  /** 聊天类型：p2p | group | channel */
  chatType?: "p2p" | "group" | "channel" | string;
  /** 事件接收时间戳（毫秒） */
  receivedAt?: number;
  /** lark-cli profile 名（多 appId 场景） */
  profile?: string;
  /** 飞书 app ID（multi-appId 场景） */
  appId?: string;
}
export interface EnvContext {
  // ========== 原始事件（完整存储） ==========

  /**
   * 完整的 EnvEvent，包含所有事件信息
   *
   * 【优先级策略】effective 优先，parent 兜底
   * 在 AgentComponent 构建 EnvContext 时：
   * - 优先使用 effectiveContext.envEvent（当前层级显式传入的 envEvent）
   * - 如果 effectiveContext 未设置，则回退到 parentEnvContext.envEvent（继承父级 ALS 上下文）
   *
   * 参考实现：agent-component.ts 中 EnvContext 构建逻辑
   * ```
   * envEvent: effectiveContext.envEvent ?? parentEnvContext?.envEvent,
   * ```
   */
  envEvent: unknown;

  // ========== 快捷访问字段（从 envEvent 提取） ==========

  /** 事件源 ID（EventSource 配置的 ID） */
  sourceId: string;

  /** 事件源类型（EventSource 类型，如 lark-cli、bounty-im、timer 等） */
  sourceType?: string;

  /** 用户 ID（从 EnvEvent 提取） */
  userId: string;

  // ========== 飞书消息透传字段 (Task #2326) ==========

  /**
   * 飞书 messageId（om_xxx 格式，从 im.message.receive_v1 事件提取）
   *
   * 设计目的：
   * - 子 Agent（delegate_task 派生的 sub-agent）能拿到原 user query 的 messageId，
   *   让所有 sub-agent 的飞书回复都通过 +messages-reply 关联回原 query。
   * - 与 replyChannel.messageId 保持一致（冗余设计，简化访问）。
   *
   * 优先级（agent-component.ts 中构建子 EnvContext 时）：
   * - parentEnvContext.messageId 优先（继承父级 ALS 上下文）
   * - effectiveContext.metadata?.messageId 兜底
   *
   * ⚠️ 历史背景：之前只有 replyChannel.messageId，没有顶层 messageId，
   *    导致 delegate_task 派生的 sub-agent 读取 effectiveContext.metadata?.messageId
   *    拿不到原 messageId（sub-session metadata 不包含）。
   */
  messageId?: string;

  // ========== 追踪信息 ==========

  /** Trace ID（用于完整会话链路追踪） */
  traceId?: string;

  /** Request ID（每个请求唯一） */
  requestId?: string;

  // ========== 回复通道 ==========

  /**
   * 回复通道（由 EnvEvent 构建）
   *
   * 【优先级策略】parent 优先，effective 兜底
   * 在 AgentComponent 构建 EnvContext 时：
   * - 优先继承父级 ALS 上下文的 replyChannel（确保子 Agent 能通过父级通道回复）
   * - 仅在父级没有 replyChannel 时，尝试从 effectiveContext.envEvent.metadata 提取
   *
   * 与 envEvent 的优先级策略不同：
   * - envEvent: effective 优先（当前层级的 envEvent 覆盖父级）
   * - replyChannel: parent 优先（继承父级的回复通道，避免子 Agent 构建新通道丢失上下文）
   *
   * 参考实现：agent-component.ts 中 EnvContext 构建逻辑
   * ```
   * replyChannel: parentEnvContext?.replyChannel ?? (effectiveContext.envEvent as any)?.metadata?.replyChannel,
   * ```
   */
  replyChannel?: ReplyChannel;

  // ========== 插件信息 ==========

  /** 插件启用状态 { "sourceId:pluginName": true } */
  pluginEnabled?: Record<string, boolean>;

  /** 启用的插件列表 */
  plugins?: string[];

  // ========== Task 任务继承（Task #4023） ==========

  /**
   * 群聊绑定的父任务 ID
   *
   * 当 EventSource 收到的飞书消息来自 per-task 群聊时，handleEvent 会从
   * SessionComponent 查 chat_id → task_id 绑定并注入到这里。
   *
   * 用途：
   * - task_create tool 在用户没显式传 parent_task_id 时，自动用这个值
   *   作为新任务的父任务，让群消息触发的子任务挂到群绑定的任务下（避免根任务爆炸）
   * - delegate_task 派生 sub-agent 时透传给子 EnvContext
   *
   * 注意：
   * - undefined 表示无绑定（普通消息 / CLI 触发）
   * - 用户在 tool 调用里显式传 parent_task_id 优先于该字段
   */
  parentTaskId?: number;

  // ========== Tool 环境变量（Task #5659，方案 C） ==========

  /**
   * 工具子进程注入的环境变量（Task #5659）
   *
   * 来源：EventSourceConfig.toolEnv（如 wecom-bot-2 的
   * `{"WECOM_CLI_CONFIG_DIR": "~/.config/wecom/bot-2"}`），
   * handleEvent 写进 evt.metadata.toolEnv，createEnvContext /
   * buildRunEnvContext 映射到这里。
   *
   * 消费方：
   * - wecom-cli-sender.runCli()：spawn wecom-cli 时合并（解决 #5654
   *   跨组织泄漏 —— 不同 bot 的凭据目录隔离）
   * - bash tool：execute 时合并（用户显式传的 env 优先级最高）
   *
   * 优先级策略与 parentTaskId 同构：本次事件优先，父级 ALS 兜底
   * （delegate_task 派生的 sub-agent 继承父级 toolEnv）。
   */
  toolEnv?: Record<string, string>;

  // ========== 其他元数据 ==========

  /** 时间戳 */
  timestamp?: number;

  // ========== 飞书事件透传 (Task #2326) ==========

  /**
   * 通用 event envelope (Task #2331 重构)
   *
   * 设计目的：
   * - 把 lark 专属字段通用化,支持任意 event source (lark/github/jira/calendar/email)
   * - EnvContext 不再绑定 lark 字段, 避免未来加新 source 时污染环境
   * - lark-cli plugin 内部通过 getLarkMessageId()/getLarkChatId()/getLarkUserId() 做类型转换
   *
   * 字段说明：
   * - source: event 来源 ('lark' | 'github' | 'jira' | 'calendar' | 'email' | 'unknown')
   * - id: source 内 ID (lark message_id om_xxx, github issue number 等)
   * - receivedAt: ISO 8601 timestamp
   * - payload: 原始 payload (保持原样)
   * - metadata: 业务级扩展字段 (任意 source 可自定义)
   *
   * 与顶层 messageId 的关系：
   * - messageId 是顶层快速访问字段（从 event.id 推导, lark source 时有效）
   * - event 是完整 event envelope (任何 source 都有)
   * - 两者并存: event 提供 "事件是什么", messageId 提供 "lark 便捷访问"
   *
   * 通过 spread 父 EnvContext 自动传播, delegate_task sub-agent 也能拿到原 event 上下文。
   */
  event?: EventEnvelope;

  // ========== 共享可变状态（agentContext） ==========

  /**
   * 共享可变状态——父子 Agent 持有同一引用
   * 
   * 子 Agent 通过 spread 展开父 context 时，agentContext 是引用共享而非值拷贝。
   * 因此子 Agent 对 agentContext 内部字段的修改（如 currentTaskId），
   * 父 Agent 立即可见。
   * 
   * 设计目的：
   * - 子 Agent 创建 Task 后，父 Agent 能感知到 currentTaskId
   * - workflow 的多个 agent node 之间共享 currentTaskId
   * - 替代旧的 _parentEnvContext 引用机制和 hasParentContextCycle 检测
   * 
   * @example
   * ```typescript
   * // 父 context 持有 agentContext 引用
   * const parentCtx = { ..., agentContext: {} };
   * // 子 context spread 父级，agentContext 是同一个引用
   * const childCtx = { ...parentCtx };
   * // 子写
   * childCtx.agentContext.currentTaskId = 42;
   * // 父读——立即可见！
   * parentCtx.agentContext.currentTaskId === 42  // true
   * ```
   */
  agentContext?: {
    /** 当前正在处理的 Task ID（由 task_create 设置，task_complete 清除） */
    currentTaskId?: number;
  };
}

// ========================================================================
// AsyncLocalStorage
// ========================================================================

const envContextStorage = new AsyncLocalStorage<EnvContext>();

export { envContextStorage };

// ========================================================================
// Functions
// ========================================================================

/**
 * 获取当前 EnvContext
 *
 * @returns 当前线程的 EnvContext，如果不存在则返回 undefined
 */
export function getEnvContext(): EnvContext | undefined {
  return envContextStorage.getStore();
}

/**
 * 获取当前 EnvContext，如果不存在则返回空对象（安全访问）
 *
 * @returns 当前线程的 EnvContext，从不返回 undefined
 */
export function getEnvContextOrEmpty(): Partial<EnvContext> {
  return envContextStorage.getStore() || {};
}

/**
 * 检查是否存在 EnvContext
 */
export function hasEnvContext(): boolean {
  return envContextStorage.getStore() !== undefined;
}

/**
 * 获取当前正在处理的 Task ID
 * 
 * 由 task_create 工具设置，task_complete 工具清除。
 * 在 LLM 调用时，additionInfo 会包含此信息，提醒 LLM 当前任务上下文。
 * 
 * 通过 agentContext 共享引用读取，父子 Agent 看到同一值。
 * 
 * @returns 当前 Task ID，如果不存在则返回 undefined
 */
export function getCurrentTaskId(): number | undefined {
  return envContextStorage.getStore()?.agentContext?.currentTaskId;
}

/**
 * 在指定 EnvContext 中执行函数
 *
 * @param context 要设置的 EnvContext
 * @param fn 要执行的函数
 * @returns 函数返回值
 */
export function runWithEnvContext<T>(
  context: EnvContext | undefined,
  fn: () => T
): T {
  if (context) {
    return envContextStorage.run(context, fn);
  }
  return fn();
}

/**
 * 在指定 EnvContext 中执行异步函数
 *
 * @param context 要设置的 EnvContext
 * @param fn 要执行的异步函数
 * @returns Promise resolving to 函数返回值
 */
export async function runWithEnvContextAsync<T>(
  context: EnvContext | undefined,
  fn: () => Promise<T>
): Promise<T> {
  if (context) {
    return envContextStorage.run(context, fn);
  }
  return fn();
}

/**
 * EnvContext 创建参数
 */
export interface CreateEnvContextOptions {
  /** 完整的 EnvEvent（必填） */
  envEvent: unknown;
  /** 事件源 ID（必填） */
  sourceId: string;
  /** 用户 ID（必填） */
  userId: string;
  /**
   * 飞书 messageId（可选，Task #2326）
   *
   * 从 lark `im.message.receive_v1` 事件提取的 messageId（om_xxx 格式）。
   * 透传到 EnvContext 后，子 Agent 通过 `getEnvContext()?.messageId` 拿到，
   * 让飞书回复优先用 `+messages-reply --message-id` 关联回原 user query。
   *
   * 传值时同时存入 EnvContext.messageId 和 replyChannel.messageId（如果 replyChannel 已有 messageId 则不覆盖）。
   */
  messageId?: string;
  /**
   * 通用 event envelope (Task #2331 重构)
   *
   * 推荐用此字段替代单独的 messageId —— 保留完整 event 上下文,
   * 子 Agent 可按需访问任何 source-specific 字段。
   *
   * 如果传了 event, 同时会从 event.id 提取 messageId (顶层字段 + replyChannel.messageId).
   * 如果 event.source === 'lark' 且 payload 是 lark message, messageId 等于 om_xxx 格式.
   */
  event?: EventEnvelope;
  /** Trace ID（可选，自动生成） */
  traceId?: string;
  /** Request ID（可选，自动生成） */
  requestId?: string;
  /** 回复通道（可选，从 envEvent 构建） */
  replyChannel?: ReplyChannel;
  /** 插件启用状态（可选，从 envEvent.metadata 构建） */
  pluginEnabled?: Record<string, boolean>;
  /** 启用的插件列表（可选） */
  plugins?: string[];
  /** 时间戳（可选，自动生成） */
  timestamp?: number;
  /**
   * 父任务 ID（可选，Task #4023）
   *
   * 由 EventSource 在 handleEvent 阶段从 chat_id → task_id 绑定注入。
   * task_create tool 在用户没显式传 parent_task_id 时优先使用此值。
   */
  parentTaskId?: number;
  /**
   * 工具子进程注入的环境变量（可选，Task #5659）
   *
   * 未传时从 envEvent.metadata.toolEnv 提取（event-source
   * handler 注入的权威来源）。显式传值优先。
   */
  toolEnv?: Record<string, string>;
}

/**
 * 规范化 chat↔task 绑定注入的父任务 ID（Task #4023）。
 *
 * 只接受正整数：task id 从 1 开始，0 / 负数 / 非整数 / 字符串 / null /
 * undefined 一律视为"无绑定"（返回 undefined）。event-source-handlers 与
 * agent-component 共用同一套校验，避免两侧判定不一致导致注入断链。
 */
export function normalizeParentTaskId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

/**
 * 规范化 toolEnv（Task #5659）。
 *
 * 只接受「字符串 → 字符串」的非空普通对象；数组 / 非对象 /
 * 空对象 / 值非字符串的键一律过滤，避免手改 JSON 的类型漂移
 * 把垃圾值注入子进程 env。
 */
export function normalizeToolEnv(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([k, v]) => typeof k === "string" && k.length > 0 && typeof v === "string",
  );
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

/**
 * 解析本次 Agent run 生效的 toolEnv（Task #5659）。
 *
 * 优先级（高 → 低）：
 *   1. 本次事件 `envEvent.metadata.toolEnv`（event-source-handlers /
 *      wecom-cli-handler 从 EventSourceConfig.toolEnv 注入）
 *   2. 上游 ALS EnvContext 的 `toolEnv`（delegate_task 派生的
 *      sub-agent 继承父级）
 *
 * 两侧都有时合并，本次事件键优先。
 */
export const resolveToolEnv = wrapFunction(
  function _resolveToolEnv(
    envEvent: unknown,
    parentEnvContext?: Partial<EnvContext> | undefined,
  ): Record<string, string> | undefined {
    const fromEvent = normalizeToolEnv(
      (envEvent as { metadata?: Record<string, unknown> } | undefined)?.metadata
        ?.toolEnv,
    );
    const fromParent = normalizeToolEnv(parentEnvContext?.toolEnv);
    if (!fromEvent) return fromParent;
    if (!fromParent) return fromEvent;
    return { ...fromParent, ...fromEvent };
  },
  // 该 span 是 toolEnv 链路的检测锚点：trace 里出现即证明
  // envEvent.metadata.toolEnv → EnvContext.toolEnv 映射生效。
  "env-context.resolveToolEnv",
  {
    recordParams: false,
    recordResult: false,
    log: false,
  },
);

/**
 * 解析本次 Agent run 生效的父任务 ID（Task #4023）。
 *
 * 优先级（高 → 低）：
 *   1. 本次事件 `envEvent.metadata.parentTaskId`（event-source-handlers 从
 *      chat↔task 绑定注入，是"本次消息属于哪个群任务"的权威来源）
 *   2. 上游 ALS EnvContext 的 `parentTaskId`（delegate_task 派生的 sub-agent
 *      继承父级绑定）
 *
 * 提取出来作为纯函数，便于单测覆盖"envEvent → EnvContext.parentTaskId"这一
 * 曾断链的映射（此前该映射不存在，导致 task_create 永远拿不到绑定父任务）。
 */
export const resolveEnvParentTaskId = wrapFunction(
  function _resolveEnvParentTaskId(
    envEvent: unknown,
    parentEnvContext?: Partial<EnvContext> | undefined,
  ): number | undefined {
    const fromEvent = normalizeParentTaskId(
      (envEvent as { metadata?: Record<string, unknown> } | undefined)?.metadata
        ?.parentTaskId,
    );
    return fromEvent ?? normalizeParentTaskId(parentEnvContext?.parentTaskId);
  },
  // 这个 span 是 P0 断链的"检测验证"锚点：只要它在 trace 里出现且
  // parentTaskId 非 null，就证明 envEvent → EnvContext 的映射生效。
  "env-context.resolveEnvParentTaskId",
  {
    recordParams: false,
    recordResult: false,
    log: false,
    resultFilter: (parentTaskId: number | undefined) => ({
      parentTaskId: parentTaskId ?? null,
    }),
  },
);

/**
 * 创建 EnvContext（便捷函数）
 *
 * @param options 创建参数
 * @returns 完整的 EnvContext，自动生成 traceId、requestId 和 timestamp
 */
export function createEnvContext(options: CreateEnvContextOptions): EnvContext {
  // ★ Task #2326: 如果提供了 messageId 选项，且 replyChannel 已有但缺少 messageId，
  // 把 messageId 也注入 replyChannel（保持两个字段一致，简化下游 plugin 访问）。
  let replyChannel: ReplyChannel | undefined = options.replyChannel;
  if (replyChannel && options.messageId && !replyChannel.messageId) {
    replyChannel = { ...replyChannel, messageId: options.messageId };
  }

  // ★ Task #2331: 处理 EventEnvelope
  // - 接受 event 字段（通用 event source）
  // - 兼容旧 messageId: 如果没有 event 但有 messageId，构造 lark event envelope
  //   (向后兼容旧 API 调用, lark-cli 仍是主要使用场景)
  let event: EventEnvelope | undefined = options.event;
  if (!event && options.messageId) {
    // 旧 API fallback: 从 messageId + replyChannel 构造 lark event envelope
    event = {
      source: "lark",
      id: options.messageId,
      receivedAt: new Date().toISOString(),
      payload: undefined,
      metadata: {
        chatId: replyChannel?.chatId,
        userId: replyChannel?.userId,
        profile: replyChannel?.profile,
      },
    };
  }

  return {
    // 必填字段
    envEvent: options.envEvent,
    sourceId: options.sourceId,
    userId: options.userId,
    // ★ Task #2331: 顶层 messageId 保留作为 backward compat (Task #2326 字段)
    // 优先级: options.messageId > event.id (lark source) > replyChannel.messageId
    messageId:
      options.messageId ??
      (event?.source === "lark" ? event.id : undefined) ??
      replyChannel?.messageId,
    // ★ Task #2331: 通用 event envelope (替代 larkEvent)
    event,
    // 自动生成追踪 ID
    traceId: options.traceId ?? crypto.randomUUID(),
    requestId: options.requestId ?? crypto.randomUUID(),
    // 可选字段
    replyChannel,
    pluginEnabled: options.pluginEnabled,
    plugins: options.plugins,
    // 自动设置时间戳（可覆盖）
    timestamp: options.timestamp ?? Date.now(),
    // ★ Task #4023: 父任务 ID（来自 chat_id → task_id 绑定）
    parentTaskId: options.parentTaskId,
    // ★ Task #5659: 工具子进程 env（ES config toolEnv → metadata.toolEnv）
    // 显式 options 优先，否则从 envEvent.metadata 提取。
    toolEnv: options.toolEnv ?? resolveToolEnv(options.envEvent),
  };
}

/**
 * 合并 EnvContext 到当前上下文
 *
 * 🛡️ agentContext 保护：如果传入 partial.agentContext 且当前上下文已有
 * agentContext，不会替换引用，而是合并属性到现有对象中。
 * 这是为了确保父子 Agent 间的 agentContext 引用共享不被意外破坏。
 *
 * @param partial 要合并的部分 EnvContext
 *
 * @example
 * ```typescript
 * // ✅ 正确：通过 setCurrentTaskId 修改 currentTaskId
 * setCurrentTaskId(42);
 *
 * // ✅ 安全：mergeEnvContext 处理其他非 agentContext 字段
 * mergeEnvContext({ sessionId: "xxx" });
 *
 * // ⚠️ 不会破坏：agentContext 不会被替换，而是合并
 * mergeEnvContext({ agentContext: { currentTaskId: 99 } });
 * // 实际等价于：current.agentContext.currentTaskId = 99
 * ```
 */
export function mergeEnvContext(partial: Partial<EnvContext>): void {
  const current = envContextStorage.getStore();
  if (current) {
    // 🛡️ agentContext 保护：不替换引用，合并到已有对象中
    if (partial.agentContext && current.agentContext) {
      Object.assign(current.agentContext, partial.agentContext);
      delete partial.agentContext;
    }
    Object.assign(current, partial);
  }
}

/**
 * 设置当前正在处理的 Task ID（便捷函数，带 @TracedAs 追踪）
 * 
 * 通过 wrapFunction 包装，自动创建 OTel Span，
 * 可在 debug trace / debug span 中查看 currentTaskId 的设置路径
 * 
 * 写入 agentContext 共享引用，父子 Agent 立即可见。
 */
export const setCurrentTaskId = wrapFunction(
  function _setCurrentTaskId(taskId: number | undefined): void {
    const prev = getCurrentTaskId();
    const ctx = envContextStorage.getStore();

    if (ctx) {
      // 自动创建 agentContext 容器
      if (!ctx.agentContext) {
        ctx.agentContext = {};
      }
      ctx.agentContext.currentTaskId = taskId;
    }

    logger.info(
      `[setCurrentTaskId] taskId=${taskId ?? "undefined"} (was: ${prev ?? "undefined"})`
    );
  },
  "env-context.setCurrentTaskId",
  { recordParams: true, recordResult: false, log: true }
);

// ========================================================================
// EventContext 序列化/恢复 (Task #2331 通用化, 替代 Task #2326 LarkContext helpers)
// ========================================================================

/**
 * 从 EnvContext 提取 EventEnvelope (Task #2331)
 *
 * 优先级: event > replyChannel.messageId (兼容 lark source, 因为 replyChannel 仅含 messageId)
 *
 * 如果当前 EnvContext 没有 event 上下文, 返回 undefined.
 */
export function getEventFromEnvContext(
  ctx: Partial<EnvContext> | undefined
): EventEnvelope | undefined {
  if (!ctx) return undefined;
  if (ctx.event) return ctx.event;
  // Backward compat: 从 replyChannel.messageId 构造 lark event envelope
  const replyMessageId = ctx.replyChannel?.messageId;
  if (replyMessageId) {
    return {
      source: "lark",
      id: replyMessageId,
      receivedAt: new Date().toISOString(),
      payload: undefined,
      metadata: {
        chatId: ctx.replyChannel?.chatId,
        userId: ctx.replyChannel?.userId,
        profile: ctx.replyChannel?.profile,
      },
    };
  }
  // Backward compat: 从顶层 messageId 构造 lark event envelope
  if (ctx.messageId) {
    return {
      source: "lark",
      id: ctx.messageId,
      receivedAt: new Date().toISOString(),
      payload: undefined,
    };
  }
  return undefined;
}


