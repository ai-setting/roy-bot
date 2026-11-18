/**
 * @fileoverview Task Hook Contexts - Hook 上下文类型定义
 */

import type { CreateTaskOptions, UpdateTaskOptions, Task, TaskOperation, CreateOperationOptions } from "../types";
import type { TagService } from "../tag-service";
import type { DelegateToolResult } from "../delegate/delegate-tool";

// ========================================================================
// Task CRUD Contexts
// ========================================================================

/**
 * Task Create Hook Context
 * 
 * 触发时机：createTask() 方法调用后，实际创建前
 * 
 * Plugin 可直接修改 options 来干预创建行为
 */
export interface TaskCreateContext {
  /** 创建选项（Plugin 可直接修改） */
  options: CreateTaskOptions;
  /** Session ID */
  sessionId: string;
  /** Tag 服务引用 */
  tagService: TagService;
  /**
   * TaskComponent 句柄（**只读能力**）。
   *
   * ⚠️ Task #4620：决策检测插件需要按 `similar_task_ids` 取候选任务详情，
   *   而候选详情只有 TaskComponent 能给（store 是私有的）。这就是 #4467
   *   契约里「实在需要就只加 1 行 `taskComponent: this`」的那一行。
   *
   *   插件**只读**它（getTask / listTasks / searchTasksByKeywords /
   *   getChildTasks），不写、不删、不改任何任务 —— 决策是**只提示不拦截**。
   *
   *   可选（`?`）：老插件 / 测试里不注入时插件应自行跳过（fail-open）。
   */
  taskComponent?: TaskComponentReadonlyHandle;
}

/**
 * TaskCreateContext.taskComponent 的最小只读能力面。
 *
 * 单独定义接口（而不是直接用 TaskComponent）是为了**避免类型循环依赖** ——
 * TaskComponent 也引用 hook contexts。
 */
export interface TaskComponentReadonlyHandle {
  getTask(id: number): Promise<any>;
  listTasks(options?: any): Promise<{ tasks: any[]; total: number }>;
  searchTasksByKeywords(
    keywords: string[],
    options?: any,
  ): Promise<{ tasks: any[]; total: number }>;
  getChildTasks(taskId: number, options?: any): Promise<{ tasks: any[]; total: number }>;
}

/**
 * Task Create Result Hook Context
 * 
 * 触发时机：Task 创建成功后
 * 
 * Plugin 可在此 Hook 中：
 * - 同步 Tag 到数据库
 * - 创建关联资源
 * - 发送通知
 */
export interface TaskCreateResultContext {
  /** 创建后的 Task（已包含生成 ID） */
  task: Task;
  /** Session ID */
  sessionId: string;
  /** Tag 服务引用 */
  tagService: TagService;
}

/**
 * Task Update Hook Context
 * 
 * 触发时机：updateTask() 方法调用后，实际更新前
 * 
 * Plugin 可直接修改 options 来干预更新行为
 */
export interface TaskUpdateContext {
  /** Task ID */
  id: number;
  /** 更新选项（Plugin 可直接修改） */
  options: UpdateTaskOptions;
  /** Tag 服务引用 */
  tagService: TagService;
}

/**
 * Task Update Result Hook Context
 * 
 * 触发时机：Task 更新成功后
 */
export interface TaskUpdateResultContext {
  /** 更新后的 Task */
  task: Task;
  /** 变更的字段 */
  changes: Partial<UpdateTaskOptions>;
  /** Tag 服务引用 */
  tagService: TagService;
}

/**
 * Task Delete Hook Context
 * 
 * 触发时机：deleteTask() 方法调用后，实际删除前
 */
export interface TaskDeleteContext {
  /** Task ID */
  id: number;
}

/**
 * Task Delete Result Hook Context
 * 
 * 触发时机：Task 删除成功后
 * 
 * 注意：删除成功后无法获取 Task 的详细信息
 */
export interface TaskDeleteResultContext {
  /** 被删除的 Task ID */
  id: number;
  /** 是否成功删除 */
  deleted: boolean;
}

// ========================================================================
// Delegate Contexts
// ========================================================================

/**
 * Delegate Before Hook Context
 * 
 * 触发时机：delegate_task 工具执行前
 * 
 * Plugin 可直接修改 prompt 来注入上下文
 */
export interface TaskDelegateContext {
  /** 关联的 Task ID */
  taskId?: number;
  /** 执行提示词（Plugin 可直接修改以注入上下文） */
  prompt: string;
  /** SubAgent 类型 */
  subagentType: string;
  /** 超时时间 */
  timeout?: number;
  /** 清理策略 */
  cleanup?: "delete" | "keep";
  /** 执行原因 */
  reason?: string;
  /** Tag 服务引用 */
  tagService: TagService;
}

/**
 * Delegate After Hook Context
 * 
 * 触发时机：delegate_task 工具执行后
 */
export interface TaskDelegateResultContext {
  /** 关联的 Task ID */
  taskId?: number;
  /** 执行结果 */
  result: DelegateToolResult;
  /** Tag 服务引用 */
  tagService: TagService;
}


// ========================================================================
// Complete Contexts (added 2026-07-10)
// ========================================================================

/**
 * Terminal Status Set — 触发 AFTER_COMPLETE 的 status 集合
 *
 * 仅 `completed` 是用户预期的"任务完成"事件，但 `failed` / `cancelled` /
 * `timeout` 也算 task 终结（不应继续等待结果）。
 */
export const TASK_COMPLETE_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "timeout",
] as const;

/**
 * ★ Task #5073（设计调整②）— to_validate 也走 AFTER_COMPLETE：
 *
 * AFTER_COMPLETE 的语义从「泛终态事件」收窄为「goal 检查触发点」：
 *   - to_validate：sub-agent 提交待验证（自查关）—— decision model
 *     在此判定「目标 vs 交付物」
 *   - completed：验收落定（default agent 复检）
 * failed/cancelled/timeout 仍保留在类型里（历史兼容），
 * 但 updateTask 已**不再**触发 AFTER_COMPLETE（见 task-component.ts），
 * 实际能看到的触发点唯一 = preCompleteTask（to_validate）。
 */
export type TaskCompleteTerminalStatus =
  | typeof TASK_COMPLETE_TERMINAL_STATUSES[number]
  | "to_validate";

/**
 * Task Complete Result Hook Context
 *
 * 触发时机：task 进入 terminal status (completed / failed / cancelled / timeout)
 *
 * 与 AFTER_UPDATE 的区别：AFTER_UPDATE 在每次 update 后触发，AFTER_COMPLETE 仅在
 * status 进入 terminal 集合内时触发，语义更精确。
 */
export interface TaskCompleteResultContext {
  /** Task 更新后的最终状态 */
  task: Task;
  /** 触发完成的 status 变更 (例如 { status: "completed" }) */
  changes: Partial<UpdateTaskOptions>;
  /** 进入的 terminal status */
  terminalStatus: TaskCompleteTerminalStatus;
  /** 触发 session ID (例如发起 complete task 的 agent session) */
  sessionId: string;
  /** Tag 服务引用 */
  tagService: TagService;
}

// ========================================================================
// Operation Contexts
// ========================================================================


/**
 * Operation Create Hook Context
 * 
 * 触发时机：createOperation() 方法调用后，实际创建前
 * 
 * Plugin 可直接修改 options 来干预操作记录创建
 */
export interface TaskOperationCreateContext {
  /** 创建选项（Plugin 可直接修改） */
  options: CreateOperationOptions;
}

/**
 * Operation Create Result Hook Context
 * 
 * 触发时机：操作记录创建成功后
 */
export interface TaskOperationCreateResultContext {
  /** 创建后的操作记录 */
  operation: TaskOperation;
}

// ========================================================================
// Context Map（用于泛型推导）
// ========================================================================

/**
 * TaskHookContextMap - Hook 点与 Context 类型的映射
 * 
 * 用于 Hook 执行时类型安全的 Context 获取
 */
export interface TaskHookContextMap {
  "task:before.create": TaskCreateContext;
  "task:after.create": TaskCreateResultContext;
  "task:before.update": TaskUpdateContext;
  "task:after.update": TaskUpdateResultContext;
  "task:before.delete": TaskDeleteContext;
  "task:after.delete": TaskDeleteResultContext;
  "task:after.complete": TaskCompleteResultContext;
  "task:delegate:before": TaskDelegateContext;
  "task:delegate:after": TaskDelegateResultContext;
  "task:operation:before.create": TaskOperationCreateContext;
  "task:operation:after.create": TaskOperationCreateResultContext;
}
