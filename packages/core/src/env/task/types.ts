/**
 * @fileoverview Task Component Types
 */

import { z } from "zod";

// ============================================================================
// Enums
// ============================================================================

/**
 * Task status enum
 *
 * ★ Task #5073 — 新增 `to_validate`（待验证）。
 *
 * 两阶段验收（#5007 的机制化落地）：
 *   sub-agent 干完 → task_pre_complete → status=to_validate（待验证）
 *   default agent  → task_complete    → status=completed（正式完成）
 *
 * ⚠️ 其余 6 个旧状态（todo/active/completed/paused/cancelled/archived）
 *   **全部保留** —— 存量库有 paused/cancelled/archived 记录，
 *   不做状态迁移、不删任何旧值（用户 2026-11-06 明令修正）。
 *   to_validate 是唯一的**新增**状态，是「非终态」（可被 task_complete
 *   落成 completed，也可被 reopen 回 active）。
 */
export const TaskStatusEnum = z.enum(["todo", "active", "to_validate", "completed", "paused", "cancelled", "archived"]);
export type TaskStatus = z.infer<typeof TaskStatusEnum>;

/**
 * Task priority enum
 */
export const TaskPriorityEnum = z.enum(["low", "medium", "high"]);
export type TaskPriority = z.infer<typeof TaskPriorityEnum>;

/**
 * Task type enum
 * - normal: 常规任务，需要跟踪完成
 * - cycle: 周期任务（如写周报），无需 complete，定期执行
 * - longterm: 长期任务/愿景目标，无法一次性完成，持续跟进
 */
export const TaskTypeEnum = z.enum(["normal", "cycle", "longterm"]);
export type TaskType = z.infer<typeof TaskTypeEnum>;

/**
 * Action type for task operations
 */
export const ActionTypeEnum = z.enum([
  "create",
  "progress",
  "milestone",
  "problem",
  "solution",
  "decision",
  "review",
  "completed",
  "workflow_extracted",
]);
export type ActionType = z.infer<typeof ActionTypeEnum>;

// ============================================================================
// Task Entity
// ============================================================================

/**
 * Task entity
 */
export interface Task {
  id: number;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  type: TaskType;
  progress: number;
  current_status: string;
  goals_and_expected_deliverables: string;
  parent_task_id?: number;
  createdAt: string;
  updatedAt: string;
  due_date?: string;
  tags?: string[];
  /** Project root path for task positioning */
  project_path: string;
  /** JSON string with time-space positioning info (worktree, branch, etc.) */
  context: string;
  /**
   * 负责人（Task #5440）。
   *
   * 语义：这个任务的**人**（open_id / 用户名 / 邮箱，字符串，core 不解释格式）。
   * - 可空：`null` 表示未指派（新建任务的默认值）
   * - 多人协作场景下用来区分「谁在负责推进」，与 `sessionId`（谁在操作）
   *   和 `project_path`（在哪个项目）正交
   * - 与 task-service 后端的 `owner` 列同源，remote 模式下原样落库
   */
  owner?: string | null;
}

// ============================================================================
// TaskOperation Entity
// ============================================================================

/**
 * TaskOperation entity — 双维度操作记录（Task #2211 重构后版本）
 *
 * 每条 operation 描述任务生命周期中**某一时刻达到的里程碑/状态**
 * 与**达成该状态所采用的过程概要**——两个维度严格分工：
 *
 * 1. **状态/里程碑维度**（"达成的状态/结果"）：
 *    - `milestoneType`: 里程碑类型（ActionTypeEnum: create/progress/milestone/problem/...）
 *    - `milestoneTitle`: 里程碑标题（一行）
 *    - `milestoneDescription`: 达成状态/结果描述
 *
 * 2. **过程维度**（"如何达到"）：
 *    - `processDescription`: 过程概要（采取的策略 + 工具步骤概要，100-500 字符）
 *
 * ⚠️ **不要把 action 当状态**，也不要让 process 与 milestone_description 重复。
 *
 * ---
 * **向后兼容**（兼容窗口期，Task #2211 引入）：
 * - DB 列已重命名为 milestone_* (migration 004)；action_* 列已不存在。
 * - `actionType/actionTitle/actionDescription` 仍作为本接口的 @deprecated alias 保留，
 *   通过 getter/setter 自动代理到 milestone_* 字段，保证现有调用方代码不改也能工作。
 * - 旧调用方应尽快迁移到 milestone_* 主字段。
 */
export interface TaskOperation {
  id: number;
  taskId: number;
  sessionId: string;  // 必填！标记在哪发生
  /** 里程碑类型（create / progress / milestone / problem / solution / decision / review / completed / workflow_extracted） */
  milestoneType: ActionType;
  /** 里程碑标题（一行） */
  milestoneTitle: string;
  /** 状态/结果描述（保留原义，可长可短；过程概要应放在 processDescription） */
  milestoneDescription: string;
  /**
   * 过程概要：采取了什么策略 + 工具步骤达成的概要描述。
   *
   * 设计哲学：操作记录只承担节点阶段 milestone 摘要。
   * 字符范围硬约束 100-500（Task #4764 放宽），应用层 schema 校验。
   * 完整过程通过 sessionId 回查 session。
   */
  processDescription: string;
  timestamp: string;
  mdPath?: string;

  /**
   * @deprecated 旧命名，已重命名为 milestoneType。仍可读写（自动代理），
   * 旧调用方应尽快迁移到 milestoneType。
   */
  actionType?: ActionType;
  /** @deprecated 已重命名为 milestoneTitle。 */
  actionTitle?: string;
  /** @deprecated 已重命名为 milestoneDescription。 */
  actionDescription?: string;
}

// ============================================================================
// TaskTag Entity
// ============================================================================

/**
 * TaskTag entity
 * 
 * Tag 池中的单个 Tag
 */
export interface TaskTag {
  id: number;
  name: string;
  createdAt: string;
  taskCount: number;
}

// ============================================================================
// Config Schema
// ============================================================================

export const TaskConfigSchema = z.object({
  storage: z.object({
    type: z.enum(["memory", "sqlite"]).default("sqlite"),
    dbPath: z.string().optional(),
  }).default({}),
}).default({});

export type TaskConfig = z.infer<typeof TaskConfigSchema>;

// ============================================================================
// Operation Options
// ============================================================================

export interface CreateTaskOptions {
  title: string;
  description?: string;
  priority?: TaskPriority;
  type?: TaskType;
  /**
   * 父任务 ID（可选）。
   * - 不传 / undefined / null：创建根任务（root task，无父任务）
   * - 传 number：作为指定父任务的子任务
   */
  parent_task_id?: number | null;
  goals_and_expected_deliverables?: string;
  due_date?: string;
  tags?: string[];
  sessionId: string;  // 必填
  /** Project root path for task positioning. Use 'unknown' if unknown. */
  project_path: string;
  /**
   * JSON string with time-space positioning info.
   * - For coding tasks: include worktree_path, branch, type
   * - For other tasks: use '{}' or '{"type":"unknown"}'
   * Must be a valid JSON string.
   */
  context: string;
  /** 负责人（可选，不传即 null；参见 Task.owner）。 */
  owner?: string | null;
}

export interface UpdateTaskOptions {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  type?: TaskType;
  progress?: number;
  current_status?: string;
  goals_and_expected_deliverables?: string;
  due_date?: string;
  tags?: string[];
  /** 项目路径，标识任务所属的项目 */
  project_path?: string;
  /** 任务上下文信息，用于存储额外上下文 */
  context?: string;
  /**
   * 负责人（可选）。传 `null` 或 `""` 表示清空；传字符串表示改为该负责人；
   * **字段省略**表示不改（与 status/progress 等字段语义一致）。
   */
  owner?: string | null;
  /** 父任务 ID，null = 设为根任务（无父任务） */
  parent_task_id?: number | null;
}

export interface ListTasksOptions {
  status?: TaskStatus;
  priority?: TaskPriority;
  type?: TaskType;
  parent_task_id?: number;
  limit?: number;
  offset?: number;
  /**
   * 检索层级深度：
   * - undefined / null：不做层级过滤（默认行为，向后兼容）
   * - 0：只查询根任务（`parent_task_id IS NULL`）
   * - 1：根 + 一层子任务
   * - 2：根 + 二层子任务，依此类推
   * - -1 或负数：不限制层级（全部）
   *
   * 注意：与 `parent_task_id` 一起使用时，`parent_task_id` 优先
   * （即深度过滤从指定父节点开始计算）。
   */
  depth?: number;
  /**
   * 是否包含已归档任务。默认 false（向后兼容）。
   * 当前 task 系统尚未实现归档字段，保留接口位以便 Phase 5 接入。
   */
  include_archived?: boolean;
}

export interface CreateOperationOptions {
  taskId: number;
  sessionId: string;  // 必填
  /** 里程碑类型（主命名，替代旧 actionType） */
  milestoneType: ActionType;
  /** 里程碑标题（主命名，替代旧 actionTitle） */
  milestoneTitle: string;
  /** 里程碑描述/状态/结果（主命名，替代旧 actionDescription） */
  milestoneDescription?: string;
  /**
   * 过程概要（采取的策略 + 工具步骤），可选；如提供，应用层会校验 100-500 字符。
   * 字符范围外会由 tool schema 拒绝（不在 DB 层强约束）。
   */
  processDescription?: string;
  mdPath?: string;

  /**
   * @deprecated 兼容旧调用方。如提供，自动映射到 milestoneType。
   * 建议尽快迁移到 milestoneType。
   */
  actionType?: ActionType;
  /** @deprecated 已重命名为 milestoneTitle。 */
  actionTitle?: string;
  /** @deprecated 已重命名为 milestoneDescription。 */
  actionDescription?: string;
}

export interface ListOperationsOptions {
  taskId: number;
  /** 过滤里程碑类型（主命名） */
  milestoneType?: ActionType;
  /** @deprecated 已重命名为 milestoneType。仍可读写，自动代理。 */
  actionType?: ActionType;
  limit?: number;
  offset?: number;
}

/**
 * Operation update payload — 兼容 milestone_* 与 action_* 两种字段。
 *
 * 双维度：
 * - milestone_* 字段描述状态/结果
 * - processDescription 描述过程
 */
export interface UpdateOperationOptions {
  milestoneTitle?: string;
  milestoneDescription?: string;
  processDescription?: string;
  /** @deprecated 已重命名为 milestoneTitle。 */
  actionTitle?: string;
  /** @deprecated 已重命名为 milestoneDescription。 */
  actionDescription?: string;
}

// ============================================================================
// List Result (with total for pagination)
// ============================================================================

/**
 * 任务列表结果（带分页总数）
 * 
 * 用于 listTasks / searchTasksByKeywords 等分页接口。
 * - tasks: 当前页的任务列表
 * - total: 满足筛选条件的总任务数（分页前）
 */
export interface TaskListResult {
  tasks: Task[];
  total: number;
}

/**
 * 搜索选项（searchTasksByKeywords 专用）
 */
export interface SearchTasksOptions {
  limit?: number;
  offset?: number;
  excludeTaskId?: number;
  status?: TaskStatus;
  priority?: TaskPriority;
  type?: TaskType;
  /**
   * 检索层级深度（与 ListTasksOptions.depth 语义一致）：
   * - undefined：不过滤
   * - 0：只根任务
   * - 1：根 + 一层子任务
   * - 2：根 + 二层子任务，依此类推
   * - -1 或负数：不限制
   */
  depth?: number;
  /**
   * 是否包含已归档任务。默认 false。
   */
  include_archived?: boolean;
}
