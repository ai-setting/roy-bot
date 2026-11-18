/**
 * @fileoverview Task Backend Contract + Persistence Port
 *
 * Task #4380 — 「roy 语义上移」的接口层。
 *
 * ## 为什么需要这一层
 *
 * roy 的工具工厂（`createTaskTool` / `listTasksTool` / …）只依赖一个
 * **duck-typed** 的对象：它们只调用 14 个方法，并不关心底层是不是
 * `TaskComponent`。历史上有两个实现：
 *
 * 1. `TaskComponent`（roy-bot 自己）—— SQLite + hooks + events + tags
 * 2. `roy_task_plugin_for_opencode` 的 `facade.ts`（869 行）—— 把同样的
 *    14 个方法落到插件自己的 store 上
 *
 * 第 2 个实现里混着大量 **roy 语义**（子树 BFS、depth 展开、deliverable 落
 * context、create operation 自动写、扁平 operation 列表、真实 total、搜索
 * 的 8 个过滤…）。这些语义本不属于任何 agent 框架，却因为写着"opencode
 * 插件"而无法被 claude / codex 复用。
 *
 * 本模块把它们收回 core，拆成两层：
 *
 * ```
 *   @ai-setting/roy-bot-core/env/task/backend
 *     ├── TaskBackend           roy 语义（BFS / depth / deliverable / total …）
 *     │                          ← 本文件定义契约，task-store-backend.ts 实现
 *     └── TaskPersistencePort   纯粹的存取原语（不含量级语义）
 *                                ← roy 的 SQLite 与各 agent 插件的 store 各实现一份
 *
 *   plugin-opencode / plugin-claude / plugin-codex
 *     └── 只实现 TaskPersistencePort（约 100 行形状对接）→ 自动获得全部 roy 语义
 * ```
 *
 * ## 设计约束
 *
 * - **类型全部来自 roy 自己**（`Task` / `TaskOperation` / `TaskStatusEnum` …），
 *   不手抄、不 re-declare —— 单一词汇来源（review finding Y4）。
 * - 入参直接复用 roy 的 `CreateTaskOptions` / `ListTasksOptions` /
 *   `SearchTasksOptions`（只把 `sessionId` 放宽为可选，因为 adapter 有默认值）。
 * - **语义只写一次**：adapter 里不许再出现 BFS / depth / total 之类的逻辑，
 *   这些一律由 `TaskStoreBackend` 负责。
 */

import type {
  ActionType,
  CreateOperationOptions,
  CreateTaskOptions,
  ListOperationsOptions,
  ListTasksOptions,
  SearchTasksOptions,
  Task,
  TaskListResult,
  TaskOperation,
  UpdateTaskOptions,
} from "../types";

// ============================================================================
// TaskBackend — roy 语义契约
// ============================================================================

/**
 * roy 工具工厂实际调用的方法集合。
 *
 * ⚠️ 这是**契约**，不是建议：`TaskComponent` 与所有 adapter 都必须满足它。
 * 任何缺失的方法都会让工具在运行时抛 `is not a function`（review finding
 * B1 就是这么来的：`task_tree` 子树模式直接崩）。
 */
export interface TaskBackend {
  // ---------- task CRUD ----------

  /**
   * 创建任务。
   *
   * 契约（与 `TaskComponent.createTask` 对齐，review finding B2）：
   * 成功后会**自动**写入一条 `milestoneType: "create"` 的 operation。
   */
  createTask(input: BackendCreateTaskOptions): Promise<Task>;

  /** 按 id 读取。id 可以是 roy 数字 id，也可以是 adapter 认得的其它句柄（如 uuid）。 */
  getTask(id: TaskId): Promise<Task | null>;

  /**
   * 任务 + 它的 operations。
   *
   * ⚠️ 返回形状必须是 `Task & { operations }`（扁平展开），
   * **不是** `{ task, operations }` —— `task_get` 工具直接 JSON.stringify 它。
   */
  getTaskWithOperations(id: TaskId): Promise<(Task & { operations: TaskOperation[] }) | null>;

  /** 列表 + 真实总数（`total` 必须是过滤后的真实 COUNT，不能是当前页长度）。 */
  listTasks(options?: BackendListTasksOptions): Promise<TaskListResult>;

  updateTask(id: TaskId, input: BackendUpdateTaskOptions): Promise<Task | null>;

  deleteTask(id: TaskId): Promise<boolean>;

  /**
   * 完成任务。
   *
   * 契约（review finding B3）：
   * - `status` → `completed`，`progress` → 100
   * - 若给了 `deliverable`，merge 进 `context.deliverable_storage_path`
   *   并写入 completion operation 的 `milestoneDescription`
   * - `cycle` 类型任务拒绝完成（roy 语义）
   */
  completeTask(id: TaskId, sessionId?: string, deliverable?: string): Promise<Task | null>;

  /**
   * 提交待验证（Task #5073 两阶段验收的第一阶段，Task #5078）。
   *
   * 契约（与 `TaskComponent.preCompleteTask` 语义同构，MCP/
   * 插件侧共用）：
   * - `status` → `to_validate`（**非终态**：只进验收队列）
   * - `current_status` → 「待验证」措辞（progressSummary 拼接：
   *   「待验证：<summary>」）
   * - 若给了 `deliverable`，merge 进 `context.deliverable_storage_path`
   *   并写入 submission operation 的 `milestoneDescription`
   * - 写一条 `milestoneType: "milestone"` 的提交留痕 operation
   *   （与 TaskComponent.preCompleteTask 的细微增强：deliverable
   *   同时落在 operation 的 `mdPath` 字段，便于寻址）
   * - `cycle` 类型任务拒绝提交（roy 语义，同 completeTask）
   * - **不 fire 任何钩子**：`TaskStoreBackend` 没有 hook 链，
   *   goal 判定由上层（MCP withGoalCheck / TaskComponent 钩子）
   *   负责 —— 本方法只是状态落库。
   */
  preCompleteTask(
    id: TaskId,
    sessionId?: string,
    deliverable?: string,
    progressSummary?: string,
  ): Promise<Task | null>;

  /** 子树（所有后代，**不含** root），BFS 按层展开，`depth` 限制层数。 */
  getTaskTree(id: TaskId, depth?: number): Promise<Task[]>;

  /** 关键词检索 + 全部 roy 过滤项（review finding Y2）。 */
  searchTasksByKeywords(
    keywords: string[],
    options?: BackendSearchTasksOptions,
  ): Promise<TaskListResult>;

  // ---------- operation CRUD ----------

  /** 写一条 operation。`action_*` 别名会被映射到 `milestone_*`。 */
  createOperation(input: BackendCreateOperationOptions): Promise<TaskOperation>;

  /**
   * 读 operation 列表。
   *
   * ⚠️ 返回**扁平数组**（review finding B4）。`task_operation_list` 工具会做
   * `JSON.stringify({ operations, count: operations.length })`，任何额外嵌套
   * 都会让模型读到 `{"operations":{"operations":[…]}}`。
   */
  listOperations(options?: BackendListOperationsOptions): Promise<TaskOperation[]>;

  getOperation(id: number): Promise<TaskOperation | null>;

  updateOperation(
    id: number,
    patch: BackendUpdateOperationOptions,
  ): Promise<TaskOperation | null>;

  deleteOperation(id: number): Promise<boolean>;
}

/**
 * 任务 / operation 句柄。
 *
 * roy 自己用数字 id；插件 store 用 uuid 主键 + rowid 数值句柄。adapter 负责
 * 把两者都接受进来（全数字字符串按数字处理）。
 */
export type TaskId = number | string;

/** `createTask` 放宽版：`sessionId` 可由 backend 的默认值补上。 */
export type BackendCreateTaskOptions = Omit<CreateTaskOptions, "sessionId"> & {
  sessionId?: string;
};

/** `listTasks` 放宽版：`depth` 语义与 roy 一致。 */
export type BackendListTasksOptions = ListTasksOptions;

/** `updateTask` 放宽版。 */
export type BackendUpdateTaskOptions = UpdateTaskOptions;

/** `searchTasksByKeywords` 放宽版。 */
export type BackendSearchTasksOptions = SearchTasksOptions;

/** `createOperation` 放宽版：`sessionId` 可省略。 */
export type BackendCreateOperationOptions = Omit<CreateOperationOptions, "sessionId"> & {
  sessionId?: string;
};

/** `listOperations` 放宽版：`taskId` 接受任意句柄。 */
export interface BackendListOperationsOptions extends Omit<ListOperationsOptions, "taskId"> {
  taskId?: TaskId;
}

/**
 * operation 更新 payload。
 *
 * 比 `UpdateOperationOptions` 多了 `sessionId` / `mdPath` / `milestoneType`，
 * 因为 adapter 需要能重写整条 operation 的 data blob（插件的 operation 是
 * 一个 JSON 列，roy 的是独立列）。
 */
export interface BackendUpdateOperationOptions {
  sessionId?: string;
  milestoneType?: ActionType;
  milestoneTitle?: string;
  milestoneDescription?: string;
  processDescription?: string;
  mdPath?: string;
  /** @deprecated 旧别名，映射到 milestoneType。 */
  actionType?: ActionType;
  /** @deprecated 旧别名，映射到 milestoneTitle。 */
  actionTitle?: string;
  /** @deprecated 旧别名，映射到 milestoneDescription。 */
  actionDescription?: string;
}

/** 构造 backend 时的可选配置。 */
export interface TaskBackendOptions {
  /** 创建 task / operation 时默认写入的 session id（缺省 `"unknown"`）。 */
  sessionId?: string;
}

// ============================================================================
// TaskPersistencePort — 纯存取原语
// ============================================================================

/**
 * 一条已持久化的任务记录：roy `Task` + 存储自己的主键。
 *
 * - `nativeId` 是存储的主键（uuid / 字符串 rowid），adapter 内部用
 * - `id` / `parent_task_id` 是 roy 的数字句柄，adapter 负责转换
 */
export interface StoredTaskRecord extends Task {
  /** 存储自己的主键（uuid / 十进制字符串）。 */
  nativeId: string;
}

/**
 * 一条已持久化的 operation 记录：roy `TaskOperation` + 存储自己的主键。
 */
export interface StoredOperationRecord extends TaskOperation {
  /** 存储自己的主键（uuid / 十进制字符串）。 */
  nativeId: string;
}

/** port 的建任务入参（roy 实体 + 可选的 owner）。 */
export interface PortCreateTaskInput {
  title: string;
  description?: string;
  status?: Task["status"];
  priority?: Task["priority"];
  type?: Task["type"];
  progress?: number;
  current_status?: string;
  goals_and_expected_deliverables?: string;
  parent_task_id?: number;
  due_date?: string;
  tags?: string[];
  project_path: string;
  context: string;
  sessionId?: string;
  /**
   * 记录创建者。**可选**，roy 自己的 store 忽略它；带业务模型的 adapter
   * （插件）用它写自己的 `owner` 列。放这里是刻意的：port 已经是"桥接层"，
   * 与其让每个 adapter 在闭包里偷偷注入，不如显式声明。
   */
  owner?: string;
}

/** port 的更新入参。`null` 表示显式置空（用于把子任务提升为根）。 */
export interface PortUpdateTaskInput {
  title?: string;
  description?: string;
  status?: Task["status"];
  priority?: Task["priority"];
  type?: Task["type"];
  progress?: number;
  current_status?: string;
  goals_and_expected_deliverables?: string;
  due_date?: string;
  tags?: string[];
  project_path?: string;
  context?: string;
  /** `null` = 提升为根任务。 */
  parent_task_id?: number | null;
  /**
   * 负责人（Task #5440）。`undefined` = 不改；`null` = 清空；字符串 = 改派。
   * 与 `PortCreateTaskInput.owner` 同语义，roy 自己的 port 直接落到 owner 列。
   */
  owner?: string | null;
}

/** port 的建 operation 入参。 */
export interface PortCreateOperationInput {
  taskId: number;
  /** 存储主键（adapter 用；缺省时由 port 从 taskId 反查）。 */
  taskNativeId?: string;
  sessionId: string;
  milestoneType: ActionType;
  milestoneTitle: string;
  milestoneDescription: string;
  processDescription: string;
  mdPath?: string;
}

/** port 的更新 operation 入参。 */
export interface PortUpdateOperationInput {
  sessionId?: string;
  milestoneType?: ActionType;
  milestoneTitle?: string;
  milestoneDescription?: string;
  processDescription?: string;
  mdPath?: string;
}

/**
 * 纯存取原语。
 *
 * 这里**不允许**出现任何 roy 语义：
 * - 不解释 `depth`（那是 backend 的事）
 * - 不拼 `Deliverable: …`（那是 backend 的事）
 * - 不自动写 create operation（那是 backend 的事）
 * - 不做 total 收敛（原样返回存储自己的 COUNT / 长度）
 *
 * 只有 `num ↔ nativeId` 的解析是 port 的职责，因为只有它知道自己的主键。
 */
export interface TaskPersistencePort {
  // ---------- task ----------

  createTask(input: PortCreateTaskInput): Promise<StoredTaskRecord>;

  /** 按存储主键读取。 */
  getTask(nativeId: string): Promise<StoredTaskRecord | null>;

  /** 按 roy 数字句柄读取。没实现时 backend 会退回全表扫描。 */
  getTaskByNum?(num: number): Promise<StoredTaskRecord | null>;

  /**
   * 列任务（**纯分页原语**）。
   *
   * 不带任何语义过滤：需要 status / depth / priority 等过滤时由 backend
   * 自行在内存里做（adapter 的库都很小，实测 < 2k 行）。
   *
   * ⚠️ `includeArchived` 不是语义过滤，而是「让 archived 行可见」这条存储层
   * 开关：很多 store（含 roy 自己的 SQLite）默认在 SQL 里排除它们。backend
   * 在做全量扫描时必须传 `true`，否则 `status="archived"` 之类的查询永远空。
   */
  listTasks(options?: { limit?: number; offset?: number; includeArchived?: boolean }): Promise<{
    tasks: StoredTaskRecord[];
    total: number;
  }>;

  updateTask(nativeId: string, patch: PortUpdateTaskInput): Promise<StoredTaskRecord | null>;

  deleteTask(nativeId: string): Promise<boolean>;

  // ---------- operation ----------

  createOperation(input: PortCreateOperationInput): Promise<StoredOperationRecord>;

  listOperations(options?: {
    taskNativeId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ operations: StoredOperationRecord[]; total: number }>;

  getOperationByNum?(num: number): Promise<StoredOperationRecord | null>;
  updateOperationByNum?(
    num: number,
    patch: PortUpdateOperationInput,
  ): Promise<StoredOperationRecord | null>;
  deleteOperationByNum?(num: number): Promise<boolean>;
}

/** `TaskBackend` 的方法名（编译期守卫用）。 */
export type TaskBackendMethodName = keyof TaskBackend;
