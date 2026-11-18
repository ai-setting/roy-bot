/**
 * @fileoverview EventEnvelope - 通用 event source envelope (Task #2331)
 *
 * 设计目的：
 * - 把 env context 的 lark-specific 字段通用化，支持任意 event source
 * - 让 EnvContext 不再绑定 lark 专属字段，将来加 github/jira/calendar/email 不污染
 * - lark-cli plugin 自己在内部做类型转换 (extractLarkFields helper)
 *
 * 与 Task #2326 LarkEventContext 的关系：
 * - LarkEventContext 是 lark 专属字段（messageId/chatId/userId/chatType/...）
 * - EventEnvelope 是通用 envelope，source 标识 event 来源，payload 是原始 payload
 * - Lark 事件通过 source='lark' + payload 是 lark message payload 来表达
 *
 * 与 replyChannel 的关系：
 * - replyChannel 是 runtime 通道抽象（sendText/sendMarkdown/reply 等方法）
 * - event 是 event metadata（用于 prompt 渲染、event 关联、subprocess env 序列化等）
 * - 两者并存：replyChannel 提供 "怎么回复"，event 提供 "事件是什么"
 *
 * 使用示例：
 * ```typescript
 * // event-source-handlers.ts 注入 lark event
 * setEnvContext({
 *   event: {
 *     source: 'lark',
 *     id: messageId,
 *     receivedAt: new Date().toISOString(),
 *     payload: rawLarkEvent,
 *     metadata: { chatType: 'p2p', profile: 'myapp' },
 *   },
 * });
 *
 * // lark-cli plugin 内部提取 lark 字段
 * const { messageId, chatId, userId } = extractLarkFields(env);
 * ```
 */

// ========================================================================
// Types
// ========================================================================

/**
 * EventSource - 事件来源标识
 *
 * 设计原则：
 * - 字符串字面量而非 enum，方便第三方 plugin 扩展自定义 source
 * - 已知的 source 列举在这里供 IDE 自动补全，未知 source 用 "unknown"
 * - 未来加 github/jira/calendar/email 时扩展这个 union
 */
export type EventSource =
  | "lark"
  | "github"
  | "jira"
  | "calendar"
  | "email"
  | "unknown";

/**
 * EventEnvelope - 通用 event 容器
 *
 * 字段说明：
 * - source: event 来源类型（如 'lark'、'github'、'unknown'）
 * - id: source 内的 event 唯一标识（lark 用 message_id om_xxx，github 用 issue number 等）
 * - receivedAt: event 接收时间（ISO 8601 字符串，便于跨进程序列化）
 * - payload: 原始 payload（保持原样，不做类型转换）
 * - metadata: 业务级扩展字段（任意 source 可自定义的额外信息）
 *
 * 不在 envelope 中的字段：
 * - userId/chatId 等 source-specific 字段：放在 payload 或 metadata 里
 * - replyChannel: 由 EventSource 单独构建，不混入 envelope
 */
export interface EventEnvelope {
  /** Event 来源标识 */
  source: EventSource;

  /** Source 内的 event 唯一 ID（lark message_id、github issue number 等） */
  id: string;

  /** Event 接收时间，ISO 8601 格式 */
  receivedAt: string;

  /** 原始 payload（不解析，保持原样） */
  payload?: unknown;

  /** 业务级扩展字段 */
  metadata?: Record<string, unknown>;
}

// ========================================================================
// Source-specific helpers
// ========================================================================

/**
 * 判断 envelope 是否来自 lark
 */
export function isLarkEvent(
  event: EventEnvelope | undefined
): event is EventEnvelope {
  return event?.source === "lark";
}

/**
 * 判断 envelope 是否来自 github
 */
export function isGithubEvent(
  event: EventEnvelope | undefined
): event is EventEnvelope {
  return event?.source === "github";
}

/**
 * 判断 envelope 是否来自 jira
 */
export function isJiraEvent(
  event: EventEnvelope | undefined
): event is EventEnvelope {
  return event?.source === "jira";
}

/**
 * 从 lark envelope 提取 messageId (om_xxx 格式)
 *
 * 优先级：
 * 1. event.id（推荐，所有 event source 都用 id 字段存 source-specific ID）
 * 2. event.payload.message_id（兼容老 payload 嵌套结构）
 *
 * 返回 undefined 如果 envelope 不是 lark 来源。
 */
export function getLarkMessageId(
  event: EventEnvelope | undefined
): string | undefined {
  if (!isLarkEvent(event)) return undefined;
  if (event.id) return event.id;
  // 兼容旧 payload 结构：payload.message.message_id / payload.message_id
  const payload = event.payload as
    | { message_id?: string; message?: { message_id?: string } }
    | undefined;
  return payload?.message?.message_id ?? payload?.message_id;
}

/**
 * 从 lark envelope 提取 chatId (oc_xxx 格式)
 *
 * 返回 undefined 如果 envelope 不是 lark 来源。
 */
export function getLarkChatId(
  event: EventEnvelope | undefined
): string | undefined {
  if (!isLarkEvent(event)) return undefined;
  const payload = event.payload as
    | { chat_id?: string; message?: { chat_id?: string } }
    | undefined;
  return payload?.chat_id ?? payload?.message?.chat_id;
}

/**
 * 从 lark envelope 提取 userId (ou_xxx 格式)
 *
 * 飞书 sender_id.open_id 嵌套在 payload.event.sender.sender_id 中。
 *
 * 返回 undefined 如果 envelope 不是 lark 来源。
 */
export function getLarkUserId(
  event: EventEnvelope | undefined
): string | undefined {
  if (!isLarkEvent(event)) return undefined;
  const payload = event.payload as
    | {
        sender_id?: string;
        event?: {
          sender?: { sender_id?: { open_id?: string; user_id?: string } };
        };
        sender?: { sender_id?: { open_id?: string; user_id?: string } };
      }
    | undefined;
  const senderId =
    payload?.event?.sender?.sender_id ??
    payload?.sender?.sender_id ??
    undefined;
  return senderId?.open_id ?? senderId?.user_id;
}

// ========================================================================
// Subprocess env serialization (Task #2326 概念, 通用化)
// ========================================================================

/**
 * ROY_EVENT_* 环境变量前缀。
 *
 * 当前架构用 ALS (AsyncLocalStorage) 透传, delegate_task 不真正 spawn subprocess.
 * 但保留这些 env 变量约定, 未来若需要 subprocess 隔离可直接使用, 无需改协议.
 *
 * 字段映射:
 * - source      → ROY_EVENT_SOURCE
 * - id          → ROY_EVENT_ID
 * - receivedAt  → ROY_EVENT_RECEIVED_AT
 * - payload     → ROY_EVENT_PAYLOAD (JSON 序列化)
 * - metadata    → ROY_EVENT_METADATA (JSON 序列化)
 */
export const EVENT_ENV_PREFIX = "ROY_EVENT_";

/**
 * 序列化 EventEnvelope 为环境变量字典
 *
 * 使用方式 (假设有 subprocess spawn):
 * ```ts
 * const env = { ...process.env, ...serializeEventToEnv(event) };
 * spawn(command, { env });
 * ```
 *
 * 返回空对象当 envelope 缺失。
 */
export function serializeEventToEnv(
  event: EventEnvelope | undefined
): Record<string, string> {
  if (!event) return {};
  const env: Record<string, string> = {
    [`${EVENT_ENV_PREFIX}SOURCE`]: event.source,
    [`${EVENT_ENV_PREFIX}ID`]: event.id,
    [`${EVENT_ENV_PREFIX}RECEIVED_AT`]: event.receivedAt,
  };
  if (event.payload !== undefined) {
    env[`${EVENT_ENV_PREFIX}PAYLOAD`] = JSON.stringify(event.payload);
  }
  if (event.metadata !== undefined) {
    env[`${EVENT_ENV_PREFIX}METADATA`] = JSON.stringify(event.metadata);
  }
  return env;
}

/**
 * 从 process.env 恢复 EventEnvelope
 *
 * 使用方式 (subprocess 入口):
 * ```ts
 * const event = restoreEventFromEnv(process.env);
 * if (event) setEnvContext({ event });
 * ```
 *
 * 返回 undefined 当环境变量中没有 ROY_EVENT_SOURCE (表示不是 event-driven 触发)。
 */
export function restoreEventFromEnv(
  env: NodeJS.ProcessEnv = process.env
): EventEnvelope | undefined {
  const source = env[`${EVENT_ENV_PREFIX}SOURCE`];
  const id = env[`${EVENT_ENV_PREFIX}ID`];
  if (!source || !id) return undefined;
  const payloadStr = env[`${EVENT_ENV_PREFIX}PAYLOAD`];
  const metadataStr = env[`${EVENT_ENV_PREFIX}METADATA`];
  let payload: unknown;
  let metadata: Record<string, unknown> | undefined;
  try {
    if (payloadStr) payload = JSON.parse(payloadStr);
  } catch {
    // 忽略解析错误，保留 payload 为 undefined
  }
  try {
    if (metadataStr) metadata = JSON.parse(metadataStr);
  } catch {
    // 忽略解析错误，保留 metadata 为 undefined
  }
  return {
    source: source as EventSource,
    id,
    receivedAt:
      env[`${EVENT_ENV_PREFIX}RECEIVED_AT`] ?? new Date().toISOString(),
    payload,
    metadata,
  };
}