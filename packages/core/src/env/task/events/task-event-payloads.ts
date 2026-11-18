/**
 * @fileoverview Task Event Payloads
 * 
 * 定义所有 Task 相关事件的 Payload 结构
 */

import type { Task, TaskOperation } from "../types";

// ============================================================================
// Task Entity Event Payloads
// ============================================================================

/**
 * task.created 事件负载
 */
export interface TaskCreatedPayload {
  task: Task;
  sessionId: string;
}

/**
 * task.updated 事件负载
 */
export interface TaskUpdatedPayload {
  task: Task;
  changes: Partial<Task>;
  sessionId: string;
}

/**
 * task.completed 事件负载
 */
export interface TaskCompletedPayload {
  task: Task;
  sessionId: string;
}

/**
 * task.deleted 事件负载
 */
export interface TaskDeletedPayload {
  taskId: number;
  sessionId: string;
}

/**
 * task.operation_added 事件负载
 */
export interface TaskOperationAddedPayload {
  operation: TaskOperation;
  taskId: number;
}

/**
 * task.delegated 事件负载
 */
export interface TaskDelegatedPayload {
  taskId: number;
  backgroundTaskId: string;
  subSessionId: string;
  parentSessionId: string;
  description: string;
  subagentType: string;
}

// ============================================================================
// Background Task Event Payloads (保持现有结构)
// ============================================================================

/**
 * task.background.started 事件负载
 */
export interface BackgroundTaskStartedPayload {
  taskId: string;
  subSessionId: string;
  parentSessionId: string;
  description: string;
  subagentType: string;
  associatedTaskId?: number;
}

/**
 * task.background.progress 事件负载
 */
export interface BackgroundTaskProgressPayload {
  taskId: string;
  subSessionId: string;
  parentSessionId: string;
  status: string;
  progress?: number;
  progressMessage?: string;
  description?: string;
  subagentType?: string;
  associatedTaskId?: number;
}

/**
 * task.background.completed/failed/timeout/stopped 事件负载
 */
export interface BackgroundTaskCompletedPayload {
  taskId: string;
  subSessionId: string;
  parentSessionId: string;
  status: "completed" | "failed" | "timeout" | "stopped";
  result?: string;
  error?: string;
  executionTimeMs: number;
  associatedTaskId?: number;
  description?: string;
  subagentType?: string;
}

// ============================================================================
// Union Types
// ============================================================================

/**
 * 所有 Task Entity 事件负载的联合类型
 */
export type TaskEntityEventPayload = 
  | TaskCreatedPayload
  | TaskUpdatedPayload
  | TaskCompletedPayload
  | TaskDeletedPayload
  | TaskOperationAddedPayload
  | TaskDelegatedPayload;

/**
 * 所有 Background Task 事件负载的联合类型
 */
export type BackgroundTaskEventPayload = 
  | BackgroundTaskStartedPayload
  | BackgroundTaskProgressPayload
  | BackgroundTaskCompletedPayload;
