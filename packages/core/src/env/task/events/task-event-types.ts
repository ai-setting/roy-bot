/**
 * @fileoverview Task Entity Event Types
 * 
 * 定义 TaskComponent 相关的 EnvEvent 类型
 */

// ============================================================================
// Task Entity Event Types
// ============================================================================

/**
 * Task Entity 事件类型枚举
 */
export const TaskEntityEventTypes = {
  /** Task 创建 */
  CREATED: "task.created",
  /** Task 更新 */
  UPDATED: "task.updated",
  /** Task 完成 */
  COMPLETED: "task.completed",
  /** Task 删除 */
  DELETED: "task.deleted",
  /** Operation 记录添加 */
  OPERATION_ADDED: "task.operation_added",
  /** Task 被委托 */
  DELEGATED: "task.delegated",
} as const;

export type TaskEntityEventType = (typeof TaskEntityEventTypes)[keyof typeof TaskEntityEventTypes];
