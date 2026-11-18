/**
 * @fileoverview Task Hook Points - Hook 点常量定义
 * 
 * 定义 Task Component 生命周期中的所有 Hook 点
 */

export const TaskHookPoints = {
  // ========================================================================
  // Task CRUD Hooks
  // ========================================================================
  
  /** 创建 Task 前 - 可干预 options */
  BEFORE_CREATE: "task:before.create",
  
  /** 创建 Task 后 - 观察或触发副作用 */
  AFTER_CREATE: "task:after.create",
  
  /** 更新 Task 前 - 可干预 options */
  BEFORE_UPDATE: "task:before.update",
  
  /** 更新 Task 后 - 观察变更 */
  AFTER_UPDATE: "task:after.update",
  
  /** 删除 Task 前 - 观察 */
  BEFORE_DELETE: "task:before.delete",
  
  /** 删除 Task 后 - 清理关联资源 */
  AFTER_DELETE: "task:after.delete",
  
  // ========================================================================
  // Task Completion Hook (added 2026-07-10)
  // ========================================================================
  
  /**
   * Task 完成 hook —— 当任务进入「完成语义状态」时触发。
   * 触发点（Task #5073 两阶段验收后）：
   *   - task_pre_complete：terminalStatus="to_validate"
   *     （sub-agent 提交待验证时的 goal 自查关）
   *   - updateTask：仅 status 迁入 TASK_COMPLETE_TERMINAL_STATUSES
   *     (completed / failed / cancelled / timeout) 时触发
   * 语义级别比 AFTER_UPDATE 更精确，plugin 可用于实现"任务完成时"的副作用
   * (例如发送通知、刷新看板、上传结果等)。
   *
   * 注意：AFTER_COMPLETE 与 AFTER_UPDATE 不互斥。
   *   - AFTER_UPDATE 在每一次 update 成功后触发，包括 status 变更、progress 变更等
   *   - AFTER_COMPLETE 仅在上述「完成语义」迁移时触发
   * 一个更新操作可能同时触发两个 hook。
   */
  AFTER_COMPLETE: "task:after.complete",
  
  // ========================================================================
  // Delegate Hooks
  // ========================================================================
  
  /** 委派任务前 - 可干预 prompt、参数 */
  DELEGATE_BEFORE: "task:delegate:before",
  
  /** 委派任务后 - 观察结果 */
  DELEGATE_AFTER: "task:delegate:after",
  
  // ========================================================================
  // Operation Hooks
  // ========================================================================
  
  /** 创建操作记录前 - 可干预 options */
  OPERATION_BEFORE_CREATE: "task:operation:before.create",
  
  /** 创建操作记录后 - 观察或触发副作用 */
  OPERATION_AFTER_CREATE: "task:operation:after.create",
} as const;

/**
 * Task Hook 点类型
 */
export type TaskHookPoint = typeof TaskHookPoints[keyof typeof TaskHookPoints];
