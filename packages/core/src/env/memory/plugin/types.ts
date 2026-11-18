/**
 * @fileoverview Memory Plugin Types (Simplified)
 *
 * MemoryPlugin 相关类型定义
 *
 * 简化设计：
 * - 移除 Draft 相关的类型
 * - 移除 AccessLog 相关的类型
 */

import type { HookContext } from "../../hook/types";
import type { ModelMessage } from "ai";

// ============================================================================
// Config
// ============================================================================

/**
 * MemoryPlugin configuration
 */
export interface MemoryPluginConfig {
  /** Enable memory plugin */
  enabled?: boolean;
}

/**
 * Default MemoryPlugin configuration
 */
export const DEFAULT_MEMORY_PLUGIN_CONFIG: MemoryPluginConfig = {
  enabled: true,
};

// ============================================================================
// Tasks
// ============================================================================

/**
 * Memory task types
 */
export type MemoryTaskType =
  | "extract_memory";   // Extract from messages

/**
 * Memory task
 */
export interface MemoryTask {
  id: string;
  type: MemoryTaskType;
  payload: unknown;
  timestamp: number;
  priority: number;
}

/**
 * Extract memory payload
 */
export interface ExtractMemoryPayload {
  messages: ModelMessage[];
  sessionId?: string;
  /** Hook context for Memory Agent */
  ctx?: MemoryHookContext;
}

// ============================================================================
// SessionMessage Interface
// ============================================================================

/**
 * SessionMessage 接口
 */
export interface SessionMessage {
  /** 消息角色 */
  role: "user" | "assistant" | "system" | "tool";
  /** 消息内容 */
  content: string | Array<{ type: string; [key: string]: unknown }>;
  /** 工具调用 ID（仅 tool 角色） */
  toolCallId?: string;
  /** 工具名称（仅 tool 角色） */
  toolName?: string;
  /** 时间戳 */
  timestamp?: number;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook context data for agent:after.react
 */
export interface MemoryHookContext {
  /** Current messages for memory extraction */
  messages: ModelMessage[];
  /** Current session ID */
  sessionId?: string;
  /** Project summaries (populated by project agent) */
  projectSummaries?: unknown[];
}

// Re-export for convenience
export type { HookContext };
