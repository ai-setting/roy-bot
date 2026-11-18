/**
 * @fileoverview TaskStoreBackend — roy 语义的唯一实现
 *
 * Task #4380。这个类把「roy 的 task 语义」从各 agent 插件里收回来，只留一份：
 *
 * - 建任务自动写 `create` operation（review B2）
 * - 完成任务把 deliverable merge 进 `context.deliverable_storage_path`（B3）
 * - operation 列表返回扁平数组（B4）
 * - `total` 是过滤后的真实条数（B5）
 * - 子树 BFS（B1）、`depth` 展开（Y1）
 * - 搜索的 8 个过滤项全部生效（Y2）
 * - `milestoneType` 过滤（Y3）
 * - 词汇单一来源：直接用 roy 的 `TaskStatusEnum` / `ActionTypeEnum`（Y4）
 *
 * 它只依赖 {@link TaskPersistencePort}（纯存取原语），所以：
 *
 * ```ts
 * // roy 自己
 * import { SQLiteTaskStore } from "@ai-setting/roy-bot-core/env/task/storage";
 * import { TaskStoreBackend, createSQLiteTaskPort } from "@ai-setting/roy-bot-core/env/task/backend";
 * const backend = new TaskStoreBackend(createSQLiteTaskPort(new SQLiteTaskStore()));
 *
 * // 任何 agent 插件（openCode / Claude Code / Codex …）
 * const backend = new TaskStoreBackend(myPortOverMyStore);
 * ```
 */

import type {
  Task,
  TaskListResult,
  TaskOperation,
  TaskPriority,
  TaskStatus,
  TaskType,
} from "../types";
import type {
  BackendCreateOperationOptions,
  BackendCreateTaskOptions,
  BackendListOperationsOptions,
  BackendListTasksOptions,
  BackendSearchTasksOptions,
  BackendUpdateOperationOptions,
  BackendUpdateTaskOptions,
  StoredOperationRecord,
  StoredTaskRecord,
  TaskBackend,
  TaskBackendOptions,
  TaskId,
  TaskPersistencePort,
} from "./types";
// Task #5060 (DS review M1) — 终态 current_status 措辞同源锚点
// （与 TaskComponent / cancel-tool 共用；completion-copy.ts 零依赖，无循环风险）
import {
  TASK_COMPLETED_STATUS_WORD,
  TASK_DELIVERABLE_RECORDED,
  TASK_TO_VALIDATE_STATUS_WORD,
} from "../tools/completion-copy";

/** roy Task #2778 v2: deliverable 在 operation 里的统一前缀。 */
export const DELIVERABLE_OPERATION_PREFIX = "Deliverable: ";

/** 把 deliverable 路径格式化成 operation 的 milestoneDescription。 */
export function formatDeliverableForOperation(
  deliverableStoragePath?: string,
): string | undefined {
  if (!deliverableStoragePath) return undefined;
  return `${DELIVERABLE_OPERATION_PREFIX}${deliverableStoragePath}`;
}

/** 全量扫描时用的「无限」分页大小（adapter 库实测 < 2k 行）。 */
const SCAN_ALL = 1_000_000;

export class TaskStoreBackend implements TaskBackend {
  constructor(
    private readonly port: TaskPersistencePort,
    private readonly options: TaskBackendOptions = {},
  ) {}

  private get defaultSessionId(): string {
    return this.options.sessionId ?? "unknown";
  }

  // ==========================================================================
  // id resolution / shape conversion
  // ==========================================================================

  /**
   * 把任意句柄解析成存储记录。
   *
   * - 数字（或全数字字符串）：先问 port 有没有 `getTaskByNum`，没有就扫全表
   * - 其它字符串：当作存储主键（uuid）
   */
  private async resolve(id: TaskId): Promise<StoredTaskRecord | null> {
    const asNum = toNumericHandle(id);
    if (asNum !== undefined) {
      if (typeof this.port.getTaskByNum === "function") {
        return await this.port.getTaskByNum(asNum);
      }
      return (await this.scanAllTasks()).find((t) => t.id === asNum) ?? null;
    }
    return await this.port.getTask(String(id));
  }

  /** 去掉 port 的 `nativeId`，还原成纯 roy `Task`。 */
  private toTask(record: StoredTaskRecord): Task {
    const { nativeId: _nativeId, ...task } = record;
    return task;
  }

  private toOperation(record: StoredOperationRecord): TaskOperation {
    const { nativeId: _nativeId, ...operation } = record;
    return operation;
  }

  /**
   * Read every row, **including archived** ones.
   *
   * `includeArchived: true` is mandatory here: most stores hide archived rows by
   * default (roy's SQLite appends `status != 'archived'`), so without it
   * `status:"archived"` and `include_archived` would silently match nothing.
   */
  private async scanAllTasks(): Promise<StoredTaskRecord[]> {
    const res = await this.port.listTasks({
      limit: SCAN_ALL,
      offset: 0,
      includeArchived: true,
    });
    return res.tasks;
  }

  // ==========================================================================
  // task CRUD
  // ==========================================================================

  async createTask(input: BackendCreateTaskOptions): Promise<Task> {
    const sessionId = input.sessionId ?? this.defaultSessionId;

    // parent 必须先存在（roy 语义：不允许孤儿）；port 负责 num → nativeId 的转换
    let parentNum: number | undefined;
    if (input.parent_task_id !== undefined && input.parent_task_id !== null) {
      const parent = await this.resolve(input.parent_task_id);
      if (!parent) {
        throw new Error(`Parent task #${input.parent_task_id} not found.`);
      }
      parentNum = parent.id;
    }

    // ⚠️ `status` / `progress` / `current_status` are NOT part of roy's
    // `CreateTaskOptions` (a new task is always `todo` / 0 / ""), and the port
    // applies those defaults. Re-listing them here was dead, type-unsound code
    // (CV round 1).
    const created = await this.port.createTask({
      title: input.title,
      description: input.description,
      priority: input.priority,
      type: input.type,
      goals_and_expected_deliverables: input.goals_and_expected_deliverables,
      ...(parentNum !== undefined ? { parent_task_id: parentNum } : {}),
      due_date: input.due_date,
      tags: input.tags,
      project_path: input.project_path,
      context: input.context,
      sessionId,
      // Task #5440 — owner 原样交给 port（roy 自己的 port 忽略，带业务模型的 adapter 落自己的列）
      ...(input.owner !== undefined && input.owner !== null ? { owner: input.owner } : {}),
    });

    // review B2: roy 的生命周期第一条必须存在，否则 task_get 立刻返回空
    // operations，task_complete 也没有可读的历史。刻意**不** try/catch 吞掉：
    // 静默失败会无声重建这个 bug（#4375 交叉验证结论）。
    await this.createOperation({
      taskId: created.id,
      sessionId,
      milestoneType: "create",
      milestoneTitle: `Task created: ${created.title}`,
      milestoneDescription: created.description ?? "",
    });

    return this.toTask(created);
  }

  async getTask(id: TaskId): Promise<Task | null> {
    const record = await this.resolve(id);
    return record ? this.toTask(record) : null;
  }

  async getTaskWithOperations(
    id: TaskId,
  ): Promise<(Task & { operations: TaskOperation[] }) | null> {
    const task = await this.getTask(id);
    if (!task) return null;
    const operations = await this.listOperations({ taskId: task.id, limit: SCAN_ALL, offset: 0 });
    return { ...task, operations };
  }

  async listTasks(options: BackendListTasksOptions = {}): Promise<TaskListResult> {
    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;

    // ⚠️ Every filter is applied in memory, deliberately. An earlier version
    // let the port answer a page directly when "no memory filter was needed",
    // but that path silently dropped `status` (the port has no such parameter)
    // and could never see archived rows (roy's SQLite store appends
    // `status != 'archived'` unless asked otherwise) — CV round 1, D1/D2.
    // Correctness first: the adapter tables are small (< 2k rows) and a wrong
    // `total` or a self-defeating `status:"archived"` is far more expensive.
    let views = (await this.scanAllTasks()).map((t) => this.toTask(t));
    views = this.applyFilters(views, options);
    return { tasks: views.slice(offset, offset + limit), total: views.length };
  }

  async updateTask(id: TaskId, input: BackendUpdateTaskOptions): Promise<Task | null> {
    const record = await this.resolve(id);
    if (!record) return null;

    let parentNum: number | null | undefined;
    if (input.parent_task_id !== undefined) {
      if (input.parent_task_id === null) {
        parentNum = null;
      } else {
        const parent = await this.resolve(input.parent_task_id);
        if (!parent) throw new Error(`Parent task #${input.parent_task_id} not found.`);
        parentNum = parent.id;
      }
    }

    const updated = await this.port.updateTask(record.nativeId, {
      title: input.title,
      description: input.description,
      status: input.status,
      priority: input.priority,
      type: input.type,
      progress: input.progress,
      current_status: input.current_status,
      goals_and_expected_deliverables: input.goals_and_expected_deliverables,
      due_date: input.due_date,
      tags: input.tags,
      project_path: input.project_path,
      context: input.context,
      ...(parentNum !== undefined ? { parent_task_id: parentNum } : {}),
      // Task #5440 — owner：undefined = 不改；null = 清空；字符串 = 改派
      ...(input.owner !== undefined ? { owner: input.owner } : {}),
    });
    return updated ? this.toTask(updated) : null;
  }

  async deleteTask(id: TaskId): Promise<boolean> {
    const record = await this.resolve(id);
    if (!record) return false;
    return await this.port.deleteTask(record.nativeId);
  }

  async completeTask(
    id: TaskId,
    sessionId?: string,
    deliverable?: string,
  ): Promise<Task | null> {
    const record = await this.resolve(id);
    if (!record) return null;

    // roy 语义：cycle 任务（周报之类）不该被"完成"
    if (record.type === "cycle") {
      throw new Error(
        `Cannot complete cycle task: #${record.id} - ${record.title}. Cycle tasks are not meant to be completed.`,
      );
    }

    // review B3: deliverable 落到 `context.deliverable_storage_path`（roy Task
    // #2778 契约），不要在 sidecar 顶层另起 key —— 下游（CLI / TUI / audit）
    // 只认这个字段。
    //
    // ★ Task #5060 (DS review M1): **同时写 current_status** —— 与
    // TaskComponent.completeTask 同一类缺陷。原来只设 status/progress ⇒
    // 走本 backend 完成任务同样会留下「status=completed 但描述说没做完」的
    // 矛盾状态。措辞同源锚点见 ../tools/completion-copy.ts。
    const patch: BackendUpdateTaskOptions = {
      status: "completed",
      progress: 100,
      current_status: deliverable
        ? `${TASK_COMPLETED_STATUS_WORD}（${TASK_DELIVERABLE_RECORDED}：${deliverable}）`
        : TASK_COMPLETED_STATUS_WORD,
    };
    if (deliverable) {
      patch.context = mergeDeliverableIntoContext(record.context, deliverable);
    }

    const updated = await this.port.updateTask(record.nativeId, patch);
    if (!updated) return null;

    const formatted = formatDeliverableForOperation(deliverable);
    await this.createOperation({
      taskId: updated.id,
      sessionId: sessionId ?? this.defaultSessionId,
      milestoneType: "completed",
      milestoneTitle: `Completed: ${updated.title}`,
      milestoneDescription: formatted ?? "Task completed",
      ...(deliverable ? { mdPath: deliverable } : {}),
    });

    const reread = await this.resolve(record.nativeId);
    return this.toTask(reread ?? updated);
  }

  /**
   * Task #5078 — 提交待验证（两阶段验收 #5073 的 backend 实现）。
   *
   * 语义与 `TaskComponent.preCompleteTask` 同构：
   * status → to_validate、current_status → 待验证措辞、
   * deliverable merge 进 context、milestone operation 留痕。
   *
   * 与 TaskComponent 的唯一差别：**不 fire AFTER_COMPLETE 钩子** ——
   * backend 没有 hook 链（#5035 已确认），goal 判定由上层负责
   * （MCP 侧 = 插件 withGoalCheck；TaskComponent 侧 = 插件链）。
   */
  async preCompleteTask(
    id: TaskId,
    sessionId?: string,
    deliverable?: string,
    progressSummary?: string,
  ): Promise<Task | null> {
    const record = await this.resolve(id);
    if (!record) return null;

    // roy 语义：cycle 任务是周期性的，不收尾也不提交验收
    // （与 completeTask / TaskComponent.preCompleteTask 同规则）
    if (record.type === "cycle") {
      throw new Error(
        `Cannot pre-complete cycle task: #${record.id} - ${record.title}. Cycle tasks are not meant to be completed or submitted for acceptance.`,
      );
    }

    // current_status：措辞同源锚点 TASK_TO_VALIDATE_STATUS_WORD，
    // 带摘要时拼接（与 TaskComponent.preCompleteTask 一致）
    const toValidateWording = progressSummary
      ? `${TASK_TO_VALIDATE_STATUS_WORD}：${progressSummary}`
      : TASK_TO_VALIDATE_STATUS_WORD;

    const patch: BackendUpdateTaskOptions = {
      status: "to_validate",
      current_status: toValidateWording,
    };
    if (deliverable) {
      // #2778 契约：deliverable 落 context.deliverable_storage_path，
      // 保留兄弟 key（与 completeTask 同款 merge）
      patch.context = mergeDeliverableIntoContext(record.context, deliverable);
    }

    const updated = await this.port.updateTask(record.nativeId, patch);
    if (!updated) return null;

    // 提交留痕：Deliverable 行 + 可选摘要（与 TaskComponent 同格式）
    const descParts: string[] = [];
    const deliverableLine = formatDeliverableForOperation(deliverable);
    if (deliverableLine) descParts.push(deliverableLine);
    if (progressSummary) descParts.push(progressSummary);

    await this.createOperation({
      taskId: updated.id,
      sessionId: sessionId ?? this.defaultSessionId,
      milestoneType: "milestone",
      milestoneTitle: `${TASK_TO_VALIDATE_STATUS_WORD}（to_validate）：Task #${updated.id} submitted for acceptance`,
      milestoneDescription: descParts.join(" / ") || TASK_TO_VALIDATE_STATUS_WORD,
      ...(deliverable ? { mdPath: deliverable } : {}),
    });

    const reread = await this.resolve(record.nativeId);
    return this.toTask(reread ?? updated);
  }


  /**
   * review B1 — roy 的 `task-tree-tool.ts` 在子树模式下调这个方法；
   * 老 facade 缺它导致 `task_tree(parent_task_id=…)` 直接抛
   * `taskComponent.getTaskTree is not a function`。
   *
   * @returns 所有后代（**不含** root 自身），BFS 按层展开并扁平化
   */
  async getTaskTree(id: TaskId, depth = -1): Promise<Task[]> {
    const root = await this.resolve(id);
    if (!root) return [];
    if (depth === 0) return [];

    const views = (await this.scanAllTasks()).map((t) => this.toTask(t));
    const byParent = new Map<number, Task[]>();
    for (const t of views) {
      if (t.parent_task_id === undefined) continue;
      const bucket = byParent.get(t.parent_task_id) ?? [];
      bucket.push(t);
      byParent.set(t.parent_task_id, bucket);
    }

    const collected: Task[] = [];
    const seen = new Set<number>([root.id]);
    let frontier: number[] = [root.id];
    let level = 0;
    while (frontier.length > 0) {
      if (depth !== -1 && level >= depth) break;
      const next: number[] = [];
      for (const parentId of frontier) {
        for (const child of byParent.get(parentId) ?? []) {
          if (seen.has(child.id)) continue;
          seen.add(child.id);
          collected.push(child);
          next.push(child.id);
        }
      }
      frontier = next;
      level++;
    }
    return collected;
  }

  async searchTasksByKeywords(
    keywords: string[],
    options: BackendSearchTasksOptions = {},
  ): Promise<TaskListResult> {
    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;

    let candidates = (await this.scanAllTasks()).map((t) => this.toTask(t));
    candidates = this.applyFilters(candidates, options);
    if (options.excludeTaskId !== undefined) {
      candidates = candidates.filter((t) => t.id !== options.excludeTaskId);
    }

    const needles = keywords.map((k) => k.toLowerCase()).filter((k) => k.length > 0);
    const hits =
      needles.length === 0
        ? candidates
        : candidates.filter((t) => {
            const haystack = [
              t.title,
              t.description,
              t.goals_and_expected_deliverables,
              t.current_status,
              (t.tags ?? []).join(" "),
              t.project_path,
            ]
              .join(" ")
              .toLowerCase();
            return needles.every((n) => haystack.includes(n));
          });

    return { tasks: hits.slice(offset, offset + limit), total: hits.length };
  }

  // ==========================================================================
  // operation CRUD
  // ==========================================================================

  async createOperation(input: BackendCreateOperationOptions): Promise<TaskOperation> {
    const task = await this.resolve(input.taskId);
    if (!task) throw new Error(`Task not found: ${input.taskId}`);

    // 双维度规范（Task #2211）：action_* 是 @deprecated 别名，映射到 milestone_*
    const milestoneType = input.milestoneType ?? input.actionType ?? "progress";
    const milestoneTitle = input.milestoneTitle ?? input.actionTitle ?? "";
    const milestoneDescription = input.milestoneDescription ?? input.actionDescription ?? "";

    const created = await this.port.createOperation({
      taskId: task.id,
      taskNativeId: task.nativeId,
      sessionId: input.sessionId ?? this.defaultSessionId,
      milestoneType,
      milestoneTitle,
      milestoneDescription,
      processDescription: input.processDescription ?? "",
      ...(input.mdPath ? { mdPath: input.mdPath } : {}),
    });
    return this.toOperation(created);
  }

  async listOperations(options: BackendListOperationsOptions = {}): Promise<TaskOperation[]> {
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    const filterType = options.milestoneType ?? options.actionType;

    if (options.taskId === undefined) {
      // roy 的 listOperations 永远带 taskId（`task_operation_list` schema 必填），
      // 没给就当作"没有匹配"而不是偷偷返回全部。
      return [];
    }

    const task = await this.resolve(options.taskId);
    if (!task) return [];

    // milestoneType 可能落在 adapter 的 JSON blob 里（插件侧），所以过滤
    // 请求时先过量取再内存过滤，最后才分页 —— 否则过滤后的页面会接近空。
    const res = await this.port.listOperations({
      taskNativeId: task.nativeId,
      limit: filterType ? SCAN_ALL : limit,
      offset: filterType ? 0 : offset,
    });

    let operations = res.operations.map((o) => this.toOperation(o));
    if (filterType) {
      operations = operations.filter((o) => o.milestoneType === filterType);
      operations = operations.slice(offset, offset + limit);
    }
    return operations;
  }

  async getOperation(id: number): Promise<TaskOperation | null> {
    if (typeof this.port.getOperationByNum === "function") {
      const op = await this.port.getOperationByNum(id);
      return op ? this.toOperation(op) : null;
    }
    // 退化路径：port 没提供 O(1) 句柄时逐 task 扫（adapter 库很小）。
    // 单次全量 listOperations 不可行 —— port 原语按 taskNativeId 取，
    // 这里故意保持简单，避免在 port 上再加一个"全表 operation"接口。
    const tasks = await this.scanAllTasks();
    for (const task of tasks) {
      const res = await this.port.listOperations({ taskNativeId: task.nativeId, limit: SCAN_ALL });
      const found = res.operations.find((o) => o.id === id);
      if (found) return this.toOperation(found);
    }
    return null;
  }

  async updateOperation(
    id: number,
    patch: BackendUpdateOperationOptions,
  ): Promise<TaskOperation | null> {
    const existing = await this.getOperation(id);
    if (!existing) return null;
    if (typeof this.port.updateOperationByNum !== "function") return existing;

    const updated = await this.port.updateOperationByNum(id, {
      sessionId: patch.sessionId ?? existing.sessionId,
      milestoneType: patch.milestoneType ?? patch.actionType ?? existing.milestoneType,
      milestoneTitle: patch.milestoneTitle ?? patch.actionTitle ?? existing.milestoneTitle,
      milestoneDescription:
        patch.milestoneDescription ?? patch.actionDescription ?? existing.milestoneDescription,
      processDescription: patch.processDescription ?? existing.processDescription,
      ...(patch.mdPath !== undefined ? { mdPath: patch.mdPath } : {}),
    });
    return updated ? this.toOperation(updated) : null;
  }

  async deleteOperation(id: number): Promise<boolean> {
    if (typeof this.port.deleteOperationByNum !== "function") return false;
    return await this.port.deleteOperationByNum(id);
  }

  // ==========================================================================
  // shared filtering
  // ==========================================================================

  /**
   * roy 的过滤语义，一处实现，`listTasks` 与 `searchTasksByKeywords` 共用。
   *
   * 关键点：
   * - 默认排除 `archived`，但**显式** `status="archived"` 时豁免（否则那个
   *   过滤器自相矛盾、永远返回 0 —— #4375 交叉验证 nit #3）
   * - `depth` 的根 = 「父不在可见集合里」的任务，与 roy 的孤儿提升规则一致
   * - `parent_task_id` 只有 `listTasks` 会传（roy 的 `SearchTasksOptions` 没有
   *   这个字段），`searchTasksByKeywords` 永远走不到那个分支
   */
  private applyFilters<
    T extends {
      id: number;
      status: TaskStatus;
      priority: TaskPriority;
      type: TaskType;
      parent_task_id?: number;
    },
  >(
    views: T[],
    options: {
      status?: TaskStatus;
      priority?: TaskPriority;
      type?: TaskType;
      parent_task_id?: number;
      depth?: number;
      include_archived?: boolean;
    },
  ): T[] {
    let out = views;

    const excludeArchived =
      options.include_archived !== true && options.status !== "archived";
    if (excludeArchived) out = out.filter((t) => t.status !== "archived");

    if (options.status !== undefined) out = out.filter((t) => t.status === options.status);
    if (options.priority !== undefined) out = out.filter((t) => t.priority === options.priority);
    if (options.type !== undefined) out = out.filter((t) => t.type === options.type);
    if (options.parent_task_id !== undefined) {
      out = out.filter((t) => t.parent_task_id === options.parent_task_id);
    }
    if (options.depth !== undefined && options.depth >= 0) {
      const allowed = allowedIdsByDepth(out, options.depth);
      out = out.filter((t) => allowed.has(t.id));
    }
    return out;
  }
}

// ============================================================================
// helpers
// ============================================================================

/** `3` / `"3"` → `3`；其它（uuid、非数字串）→ `undefined`。 */
export function toNumericHandle(id: TaskId): number | undefined {
  if (typeof id === "number") {
    return Number.isFinite(id) ? id : undefined;
  }
  return /^\d+$/.test(id) ? Number(id) : undefined;
}

/**
 * roy 的 `depth` 语义：`0` 只根 / `1` 根+一层 / `N` N 层 / `-1` 全部。
 *
 * 根的定义：父不在可见集合里（孤儿提升，避免某任务因为父被过滤掉而消失）。
 */
export function allowedIdsByDepth<T extends { id: number; parent_task_id?: number }>(
  views: T[],
  depth: number,
): Set<number> {
  if (depth < 0) return new Set(views.map((t) => t.id));

  const ids = new Set(views.map((t) => t.id));
  const byParent = new Map<number, T[]>();
  for (const t of views) {
    const key = t.parent_task_id;
    if (key === undefined || !ids.has(key)) continue;
    const bucket = byParent.get(key) ?? [];
    bucket.push(t);
    byParent.set(key, bucket);
  }

  const allowed = new Set<number>();
  let frontier = views.filter((t) => t.parent_task_id === undefined || !ids.has(t.parent_task_id));
  for (const t of frontier) allowed.add(t.id);

  for (let level = 1; level <= depth; level++) {
    const next: T[] = [];
    for (const parent of frontier) {
      for (const child of byParent.get(parent.id) ?? []) {
        if (allowed.has(child.id)) continue;
        allowed.add(child.id);
        next.push(child);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return allowed;
}

/**
 * roy Task #2778 契约：`context` 是 JSON 对象，deliverable 作为
 * `deliverable_storage_path` merge 进去，保留所有兄弟 key。
 * 坏 JSON ⇒ 从空对象开始（绝不抛错：完成任务不能被脏 context 打断）。
 */
export function mergeDeliverableIntoContext(rawContext: unknown, deliverable: string): string {
  let parsed: Record<string, unknown> = {};
  if (typeof rawContext === "string" && rawContext.trim().length > 0) {
    try {
      const candidate = JSON.parse(rawContext);
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        parsed = candidate as Record<string, unknown>;
      }
    } catch {
      // corrupt context — fall through with {}
    }
  }
  parsed.deliverable_storage_path = deliverable;
  return JSON.stringify(parsed);
}
