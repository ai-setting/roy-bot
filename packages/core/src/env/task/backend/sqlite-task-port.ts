/**
 * @fileoverview SQLite Task Port — roy 自己的 store 的 port 实现
 *
 * Task #4380。`SQLiteTaskStore` 已经实现了 roy 的完整 `TaskStore` 接口（含
 * depth / search / tags 等原生能力）。这个 adapter 只做两件事：
 *
 * 1. 把 `TaskStore` 的入参/出参翻译成 {@link TaskPersistencePort} 的纯原语
 * 2. 补齐 `StoredTaskRecord.nativeId`（roy 的数字 id 直接当 nativeId 用）
 *
 * 语义（BFS / depth / deliverable / create-operation / total …）一律**不在**
 * 这里实现 —— 那些由 `TaskStoreBackend` 统一负责，保证 roy 自己与所有
 * agent 插件跑的是同一套逻辑。
 */

import type { TaskStore } from "../storage/sqlite-task-store";
import type { ActionType, TaskOperation } from "../types";
import type {
  PortCreateOperationInput,
  PortCreateTaskInput,
  PortUpdateOperationInput,
  PortUpdateTaskInput,
  StoredOperationRecord,
  StoredTaskRecord,
  TaskPersistencePort,
} from "./types";

/** 让 `TaskOperation.milestoneType` 与 port 的 `ActionType` 对齐。 */
function asActionType(value: string): ActionType {
  return value as ActionType;
}

/**
 * 把 roy 的 `TaskStore`（`SQLiteTaskStore`）接成一个 port。
 *
 * ```ts
 * const store = new SQLiteTaskStore();
 * const backend = new TaskStoreBackend(createSQLiteTaskPort(store));
 * ```
 */
export function createSQLiteTaskPort(store: TaskStore): TaskPersistencePort {
  return {
    async createTask(input: PortCreateTaskInput): Promise<StoredTaskRecord> {
      const task = await store.createTask({
        title: input.title,
        description: input.description,
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.parent_task_id !== undefined ? { parent_task_id: input.parent_task_id } : {}),
        ...(input.goals_and_expected_deliverables !== undefined
          ? { goals_and_expected_deliverables: input.goals_and_expected_deliverables }
          : {}),
        ...(input.due_date !== undefined ? { due_date: input.due_date } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        sessionId: input.sessionId ?? "unknown",
        project_path: input.project_path,
        context: input.context,
        ...(input.owner !== undefined ? { owner: input.owner } : {}),
      });
      return { ...task, nativeId: String(task.id) };
    },

    async getTask(nativeId: string): Promise<StoredTaskRecord | null> {
      const num = Number(nativeId);
      if (!Number.isFinite(num)) return null;
      const task = await store.getTask(num);
      return task ? { ...task, nativeId: String(task.id) } : null;
    },

    async getTaskByNum(num: number): Promise<StoredTaskRecord | null> {
      const task = await store.getTask(num);
      return task ? { ...task, nativeId: String(task.id) } : null;
    },

    async listTasks(options?: {
      limit?: number;
      offset?: number;
      includeArchived?: boolean;
    }) {
      // ⚠️ 刻意**不**把 status/priority/depth 透传给 store：port 是纯分页
      // 原语，语义过滤由 TaskStoreBackend 统一做，避免两处逻辑漂移。
      // 但 `include_archived` 必须透传 —— 它是存储层的可见性开关，不是语义
      // 过滤；不传的话 archived 行在 SQL 层就消失了（CV round 1, D2）。
      const res = await store.listTasks({
        limit: options?.limit ?? 20,
        offset: options?.offset ?? 0,
        ...(options?.includeArchived ? { include_archived: true } : {}),
      });
      return {
        tasks: res.tasks.map((t) => ({ ...t, nativeId: String(t.id) })),
        total: res.total,
      };
    },

    async updateTask(nativeId: string, patch: PortUpdateTaskInput): Promise<StoredTaskRecord | null> {
      const num = Number(nativeId);
      if (!Number.isFinite(num)) return null;
      // patch 已是 UpdateTaskOptions 超集（含 owner），直传即可
      const task = await store.updateTask(num, patch);
      return task ? { ...task, nativeId: String(task.id) } : null;
    },

    async deleteTask(nativeId: string): Promise<boolean> {
      const num = Number(nativeId);
      if (!Number.isFinite(num)) return false;
      return await store.deleteTask(num);
    },

    async createOperation(input: PortCreateOperationInput): Promise<StoredOperationRecord> {
      const op = await store.createOperation({
        taskId: input.taskId,
        sessionId: input.sessionId,
        milestoneType: input.milestoneType,
        milestoneTitle: input.milestoneTitle,
        milestoneDescription: input.milestoneDescription,
        processDescription: input.processDescription,
        ...(input.mdPath ? { mdPath: input.mdPath } : {}),
      });
      return { ...op, nativeId: String(op.id) };
    },

    async listOperations(options?: {
      taskNativeId?: string;
      limit?: number;
      offset?: number;
    }) {
      const num = Number(options?.taskNativeId);
      if (!Number.isFinite(num)) return { operations: [], total: 0 };
      // 先取全量来算 total（store 的 listOperations 不返回总数），
      // 再按 limit/offset 切页 —— port 负责"诚实总数"，切页语义在 backend。
      const all = await store.listOperations({ taskId: num, limit: 1_000_000, offset: 0 });
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? all.length;
      return {
        operations: all
          .slice(offset, offset + limit)
          .map((o: TaskOperation) => ({ ...o, nativeId: String(o.id) })),
        total: all.length,
      };
    },

    async getOperationByNum(num: number): Promise<StoredOperationRecord | null> {
      const op = await store.getOperation(num);
      return op ? { ...op, nativeId: String(op.id) } : null;
    },

    async updateOperationByNum(
      num: number,
      patch: PortUpdateOperationInput,
    ): Promise<StoredOperationRecord | null> {
      const op = await store.updateOperation(num, {
        ...(patch.milestoneTitle !== undefined ? { milestoneTitle: patch.milestoneTitle } : {}),
        ...(patch.milestoneDescription !== undefined
          ? { milestoneDescription: patch.milestoneDescription }
          : {}),
        ...(patch.processDescription !== undefined
          ? { processDescription: patch.processDescription }
          : {}),
      });
      return op ? { ...op, nativeId: String(op.id) } : null;
    },

    async deleteOperationByNum(num: number): Promise<boolean> {
      return await store.deleteOperation(num);
    },
  };
}

export { asActionType };
