/**
 * @fileoverview Environment types and interfaces
 * 
 * 定义 Environment 的核心类型，包括：
 * - Environment 配置
 * - EnvEvent 事件类型
 */

// ============================================================================
// Environment Types
// ============================================================================

/**
 * Environment Config
 */
export interface EnvironmentConfig {
  /** 环境名称 */
  name: string;
  /** 环境版本 */
  version: string;
  /** 是否启用 */
  enabled: boolean;
}

/**
 * BaseEnvironment 配置
 */
export interface BaseEnvironmentConfig {
  /** 环境名称 */
  name?: string;
  /** 环境版本 */
  version?: string;
  /** 是否启用 */
  enabled?: boolean;
}

// ============================================================================
// EnvEvent Types
// ============================================================================

/**
 * EnvEvent 元信息
 */
export interface EnvEventMetadata {
  /** 触发事件的 session ID */
  trigger_session_id?: string;
  /** 触发事件的 agent ID */
  trigger_agent_id?: string;
  /** Agent 名称 */
  trigger_agent_name?: string;
  /** 环境名称 */
  env_name?: string;
  /** 事件来源（如 "event-source"） */
  source?: string;
  /**
   * Task #4042 (ESPlugin v2 Phase 2)：trigger event ID
   *
   * 当 event 是由 delegate_task sub-agent 完成触发的 notify event 时，
   * 此字段指向触发整个 delegate_task 调用的原始 event（由 EventStore
   * insertTriggerEvent 返回）。下游 consumer 用此 ID 反查 EventStore
   * 拿到原始 chatId / messageId 等 ES info。
   *
   * 不存在时：notify event 由非 ES 触发的场景，consumer 应 fallback 到
   * lastReplyChannel / metadata.replyChannel。
   */
  triggerEventId?: string;
  
  // ===== EventSource 扩展字段 =====
  
  /** 事件源 ID */
  sourceId?: string;
  
  /** 反馈通道（用于事件处理完成后回复） */
  replyChannel?: {
    /** 渠道类型，如 lark-cli, bounty-im */
    type: string;
    /** 发送目标的 app ID */
    appId?: string;
    /** 发送目标的会话 ID */
    chatId?: string;
    /** 原始消息 ID（用于回复） */
    messageId?: string;
    /** 原始回复指令 */
    rawCommand?: string;
    /** 其他自定义参数 */
    params?: Record<string, unknown>;
  };
  
  /** 启用的插件列表（用于 pluginEnabled 构建） */
  plugins?: string[];
  
  /** 其他元数据 */
  [key: string]: unknown;
}

/**
 * EnvEvent
 * 
 * 统一的事件机制，用于：
 * - Stream 事件（stream.start, stream.text, stream.completed 等）
 * - 工具调用事件（tool.call, tool.result 等）
 * - 会话事件（session.created, session.updated 等）
 * - Agent 事件（agent.thinking, agent.acting 等）
 */
export interface EnvEvent<T = unknown> {
  /** 事件 ID */
  id: string;
  /** 事件类型 */
  type: string;
  /** 时间戳 */
  timestamp: number;
  /** 元信息 */
  metadata: EnvEventMetadata;
  /** 事件负载 */
  payload: T;
}

/**
 * EnvEvent Handler
 */
export type EnvEventHandler = (event: EnvEvent) => void | Promise<void>;

/**
 * EnvEvent 创建参数（部分属性，可选）
 * 
 * 用于 pushEnvEvent 方法，允许传入部分属性，自动补全必填字段
 */
export interface EnvEventInput {
  /** 事件类型（必填） */
  type: string;
  /** 事件 ID（可选，自动生成） */
  id?: string;
  /** 时间戳（可选，自动生成） */
  timestamp?: number;
  /** 元信息（可选，自动创建） */
  metadata?: EnvEventMetadata;
  /** 事件负载（可选） */
  payload?: unknown;
}

// ============================================================================
// Context Types
// ============================================================================

/**
 * Action 类型
 */
export interface Action {
  /** Action 类型 */
  type: string;
  /** Action 参数 */
  params?: Record<string, unknown>;
}

/**
 * Tool Result
 */
export interface ToolResult {
  /** 是否成功 */
  success: boolean;
  /** 输出内容 */
  output: string | Record<string, unknown>;
  /** 错误信息 */
  error?: string;
}

/**
 * Context
 */
export interface Context {
  /** 会话 ID */
  sessionId?: string;
  /** 用户 ID */
  userId?: string;
  /** 工作目录 */
  workdir?: string;
  /** 中断信号 */
  abort?: AbortSignal;
  /** 元数据 */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Hook Context Types
// ============================================================================

/**
 * Session Hook 上下文
 */
export interface SessionHookContext {
  /** Session 对象 */
  session?: {
    id: string;
    title?: string;
    metadata?: Record<string, unknown>;
  };
  /** 操作选项 */
  options?: Record<string, unknown>;
}

/**
 * Log Context（日志上下文）
 */
export interface LogContext {
  /** 日志级别 */
  level: string;
  /** 日志类别 */
  category: string;
  /** 日志消息 */
  message: string;
  /** 时间戳 */
  timestamp: number;
  /** 调用位置 */
  callerLocation?: string;
  /** 其他元数据 */
  [key: string]: unknown;
}
