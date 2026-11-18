/**
 * @fileoverview Remote Task Port — 让 MCP / 插件侧的 `TaskStoreBackend` 走 task-service
 *
 * Task #5440（方案 v3 §2.2 / M4）。
 *
 * ## 为什么需要这一层
 *
 * `TaskComponent`（agent 自己的工具链）与 MCP（`TaskStoreBackend`）是**两条
 * 独立**的存储接线路径：
 *
 * ```
 *  agent 工具 (task_create …) ──► TaskComponent ──► initStore 分支 ──► store
 *  MCP 工具 (task_create …)   ──► TaskStoreBackend ──► TaskPersistencePort ──► store
 * ```
 *
 * `TaskStoreBackend` 的构造参数是 `TaskPersistencePort`（纯存取原语），**不是**
 * `TaskStore`。所以 remote 覆盖必须落在 port 工厂这一层，而不是靠 initStore
 * 分支（两条路径互不经过）。
 *
 * ## 语义边界（重要）
 *
 * 这里**只做形状翻译**，不做任何 roy 语义：
 * - `TaskStore` 的数字 id ↔ port 的 `nativeId`（十进制字符串）
 * - port 的「纯分页 listTasks」← `TaskStore.listTasks`（不传语义过滤）
 * - `total` 由 port 诚实计算（`listOperations` 不返回总数）
 *
 * BFS / depth / deliverable / create-operation 全部仍在 `TaskStoreBackend`，
 * 保证 remote 与本地跑的是**同一套**语义。
 */

import type { TaskStore } from "../storage/sqlite-task-store";
import { RemoteTaskStore } from "../storage/remote-task-store";
import { SQLiteTaskStore } from "../storage/sqlite-task-store";
import { createSQLiteTaskPort } from "./sqlite-task-port";
import { createLogger } from "../../log-trace/logger";
import type {
  PortCreateOperationInput,
  PortCreateTaskInput,
  PortUpdateOperationInput,
  PortUpdateTaskInput,
  StoredOperationRecord,
  StoredTaskRecord,
  TaskPersistencePort,
} from "./types";

/** 全量扫描用的「无限」分页大小（与 backend 的 SCAN_ALL 对齐）。 */
const SCAN_ALL = 1_000_000;

const defaultLog = createLogger("task-remote-port") as {
  warn?(message: string): void;
};

/**
 * 把任意 `TaskStore`（本地或远端）接成 `TaskPersistencePort`。
 *
 * 与 {@link createSQLiteTaskPort} 的区别：那个是「本地专用」的现成适配
 * （`store.listTasks` 自带 include_archived 透传等本地细节），本函数面向
 * **remote** 场景，且刻意保持最小契约（remote 的 HTTP 层语义与本地完全
 * 1:1，不需要本地特化）。
 */
export function createRemoteTaskPortFromStore(store: TaskStore): TaskPersistencePort {
  return {
    async createTask(input: PortCreateTaskInput): Promise<StoredTaskRecord> {
      const task = await store.createTask({
        title: input.title,
        description: input.description,
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.parent_task_id !== undefined
          ? { parent_task_id: input.parent_task_id }
          : {}),
        ...(input.goals_and_expected_deliverables !== undefined
          ? { goals_and_expected_deliverables: input.goals_and_expected_deliverables }
          : {}),
        ...(input.due_date !== undefined ? { due_date: input.due_date } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        sessionId: input.sessionId ?? "unknown",
        project_path: input.project_path,
        context: input.context,
        // Task #5440 — owner 原样透传（service 端落 owner 列）
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

    async listTasks(options?: { limit?: number; offset?: number; includeArchived?: boolean }) {
      // 纯分页原语：语义过滤由 TaskStoreBackend 在内存里做。
      // `include_archived` 是存储层可见性开关，必须透传（否则 archived 行
      // 在 SQL 层就消失，backend 的 include_archived 永远返回空）。
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

    async updateTask(
      nativeId: string,
      patch: PortUpdateTaskInput,
    ): Promise<StoredTaskRecord | null> {
      const num = Number(nativeId);
      if (!Number.isFinite(num)) return null;
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
      // listOperations 不返回总数 → 先取全量算 total，再切页（total 诚实）
      const all = await store.listOperations({ taskId: num, limit: SCAN_ALL, offset: 0 });
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? all.length;
      return {
        operations: all
          .slice(offset, offset + limit)
          .map((o) => ({ ...o, nativeId: String(o.id) })),
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
        ...(patch.milestoneTitle !== undefined
          ? { milestoneTitle: patch.milestoneTitle }
          : {}),
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

// ============================================================================
// 工厂
// ============================================================================

export interface RemoteTaskPortOptions {
  /** service 地址，如 `http://127.0.0.1:7820` */
  endpoint: string;
  /** Bearer token（与服务端 TASK_AUTH_TOKEN 一致） */
  authToken?: string;
  /** 单请求超时（毫秒） */
  timeoutMs?: number;
  /** 最大重试次数 */
  maxRetries?: number;
  /** 注入已有 store（测试/复用连接配置） */
  store?: TaskStore;
}

/**
 * 建一个走 task-service 的 port。
 *
 * ```ts
 * const backend = new TaskStoreBackend(createRemoteTaskPort({ endpoint, authToken }));
 * const server  = createTaskMcpServer(backend);
 * ```
 */
export function createRemoteTaskPort(options: RemoteTaskPortOptions): TaskPersistencePort {
  if (!options?.endpoint && !options.store) {
    throw new Error(
      "[createRemoteTaskPort] endpoint is required (task.storage.endpoint). " +
        "Point it at the running roy-task-service, e.g. http://127.0.0.1:7820.",
    );
  }
  const store =
    options.store ??
    new RemoteTaskStore({
      endpoint: options.endpoint,
      authToken: options.authToken,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    });
  return createRemoteTaskPortFromStore(store);
}

/** `createTaskPortFromConfig` 的返回：port + 实际选中的引擎类型（便于日志/诊断）。 */
export interface TaskPortFromConfig {
  port: TaskPersistencePort;
  kind: "sqlite" | "remote";
  /** 选中引擎背后的 store 实例（宿主需要 close 时用）。 */
  store: TaskStore;
}

/**
 * 按 `task.storage.*` 配置构造 port —— MCP / 插件宿主接线用。
 *
 * - `type=sqlite`（默认）→ 本地 `SQLiteTaskStore` + {@link createSQLiteTaskPort}
 * - `type=remote`        → `RemoteTaskStore` + {@link createRemoteTaskPortFromStore}
 *
 * ⚠️ `type=remote` 缺 `endpoint` 时**明确抛错**（与 `TaskComponent.initStore`
 * 同语义：不猜默认值、不静默退回本地库）。
 *
 * @param config 具备 `get(key)` 的配置对象（通常是 `ConfigComponent`）
 * @param defaults `sqlite` 分支的 dbPath 等本地选项
 */
export async function createTaskPortFromConfig(
  config: { get(key: string): unknown },
  defaults: { dbPath?: string } = {},
): Promise<TaskPortFromConfig> {
  const type = (config.get("task.storage.type") as string | undefined) ?? "sqlite";

  if (type === "remote") {
    const endpoint = config.get("task.storage.endpoint") as string | undefined;
    const authToken = config.get("task.storage.authToken") as string | undefined;
    if (!endpoint) {
      throw new Error(
        "[createTaskPortFromConfig] task.storage.type=remote requires task.storage.endpoint " +
          "(e.g. http://127.0.0.1:7820). No local fallback is performed by design.",
      );
    }
    const store = new RemoteTaskStore({ endpoint, authToken });
    return { port: createRemoteTaskPortFromStore(store), kind: "remote", store };
  }

  if (type !== "sqlite") {
    // ★ CV round 2 MINOR-2：未知 type（拼错 / 未来新增引擎）必须明确告警，
    // 不能像第一版那样静默走本地库 —— 那与「不允许静默降级」的验收标准相悖。
    // 与 TaskComponent.buildStore 的告警保持同语义。
    defaultLog.warn?.(
      `[createTaskPortFromConfig] Unknown task.storage.type="${String(type)}", ` +
        `falling back to default SQLite storage. Supported: "sqlite" | "remote".`,
    );
  }

  const store = new SQLiteTaskStore(defaults.dbPath);
  return { port: createSQLiteTaskPort(store), kind: "sqlite", store };
}
