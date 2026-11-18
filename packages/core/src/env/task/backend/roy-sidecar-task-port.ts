/**
 * @fileoverview Roy-sidecar task port — 通用 duck-typed 存储适配器
 *
 * Task #4380。有些 agent 插件的任务存储**已经有自己的业务模型**（自己的
 * status 词表、自己的 uuid 主键、自己的 audit log），但愿意额外存一个
 * roy 侧车（sidecar）字段来保留 roy 的全部语义。这类存储的共同形状是稳定
 * 的，所以适配逻辑不该在每个 agent 插件里重写一遍。
 *
 * 本模块把这个形状抽象成 {@link RoySidecarTaskStore}，并给出唯一实现
 * {@link createRoySidecarTaskPort}。插件侧因此只剩「词表映射」这一件真正
 * 属于它自己的事（business status ↔ roy status）。
 *
 * ```
 *   TaskStoreBackend            roy 语义（shared，唯一实现）
 *        ↓ TaskPersistencePort
 *   createRoySidecarTaskPort(store, vocabulary)   ← 本文件（shared）
 *        ↓ RoySidecarTaskStore
 *   plugin TaskStore            （openCode / Claude / Codex 各自的业务库）
 * ```
 */

import type {
  PortCreateOperationInput,
  PortCreateTaskInput,
  PortUpdateOperationInput,
  PortUpdateTaskInput,
  StoredOperationRecord,
  StoredTaskRecord,
  TaskPersistencePort,
} from "./types";

// ============================================================================
// Duck-typed store contract
// ============================================================================

/**
 * 一条「带 roy 侧车」的存储记录。
 *
 * - `id`：存储自己的主键（uuid / 十进制字符串）
 * - `num`：数值句柄（rowid），roy 用它做 task id
 * - `roy`：roy 侧车（type / progress / project_path / context …）
 * - `data`：operation 的 JSON payload（roy 的 milestone 字段住在这里）
 */
export interface SidecarTask {
  id: string;
  num?: number;
  title: string;
  description?: string;
  status: string;
  priority: number;
  tags?: string;
  parent_id: string | null;
  session_id?: string | null;
  /**
   * 负责人（Task #5440）。业务 store 自己的 owner 列（string）；
   * create 时由 port 写入（显式 owner 优先，缺省回落 `agent`），
   * update 时透传（undefined = 不改；null = 清空）。
   */
  owner?: string | null;
  roy?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SidecarOperation {
  id: string;
  num?: number;
  task_id: string | null;
  type: string;
  data: Record<string, unknown>;
  created_at: string;
}

/** 带 roy 侧车的存储最小契约（各 agent 插件的 store 都长这样）。 */
export interface RoySidecarTaskStore {
  createTask(input: {
    title: string;
    description?: string;
    priority?: number;
    owner?: string;
    tags?: string;
    parent_id?: string | null;
    session_id?: string | null;
    roy?: Record<string, unknown>;
  }): Promise<SidecarTask>;

  updateTask(
    id: string,
    input: {
      title?: string;
      description?: string;
      status?: string;
      priority?: number;
      tags?: string;
      /** 负责人（Task #5440）：undefined = 不改；null = 清空；字符串 = 改派。 */
      owner?: string | null;
      roy?: Record<string, unknown>;
    },
  ): Promise<SidecarTask | null>;

  getTask(id: string): Promise<SidecarTask | null>;
  /** 按数值句柄读（O(1)）；没实现就退化成全表扫描。 */
  getTaskByNum?(num: number): Promise<SidecarTask | null>;

  /**
   * 纯分页读取（不做语义过滤 —— 那些由 `TaskStoreBackend` 统一负责）。
   *
   * 刻意**不**声明 `status` / `parent_id`：backend 从不需要它们，而声明一个
   * 用不到的过滤字段只会让签名的结构兼容性变差（业务 store 的 status 通常是
   * 自己的联合类型，`string` 反而不兼容 —— CV round 1）。
   */
  listTasks(filter?: { limit?: number; offset?: number }): Promise<{
    tasks: SidecarTask[];
    total: number;
  }>;

  deleteTask(id: string): Promise<boolean>;
  /** 重挂父任务（`null` = 提升为根）。 */
  setParentId?(id: string, parentId: string | null): Promise<void>;

  appendOperation(input: {
    task_id: string | null;
    type: string;
    data: Record<string, unknown>;
  }): Promise<SidecarOperation>;

  listOperations(filter?: {
    task_id?: string;
    type?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ operations: SidecarOperation[]; total: number }>;

  getOperationByNum?(num: number): Promise<SidecarOperation | null>;
  updateOperation?(
    num: number,
    patch: { type?: string; data?: Record<string, unknown> },
  ): Promise<SidecarOperation | null>;
  deleteOperation?(num: number): Promise<boolean>;
}

/**
 * 业务词表 ↔ roy 词表的映射。
 *
 * 这是**唯一**需要每个 agent 插件自己提供的东西：它的业务 status 叫什么，
 * priority 怎么编码。roy 的语义（BFS / depth / deliverable / total …）不需要管。
 */
export interface SidecarVocabulary {
  /** 存储 status → roy status。 */
  toRoyStatus(storeStatus: string): StoredTaskRecord["status"];
  /** roy status → 存储 status。 */
  toStoreStatus(royStatus: string): string;
  /** 存储数值 priority → roy priority 桶。 */
  toRoyPriority(storePriority?: number): StoredTaskRecord["priority"];
  /** roy priority → 存储数值 priority。 */
  toStorePriority(royPriority?: string): number;
  /** 存储逗号串 tags → roy string[]。 */
  toRoyTags(storeTags?: string | null): string[];
  /** roy string[] tags → 存储逗号串。 */
  toStoreTags(royTags?: string[]): string | undefined;
}

export interface RoySidecarPortOptions {
  /** audit log 里表示 roy milestone 的 type 值。 */
  operationType?: string;
  /** 建任务时写入的 owner。 */
  agent?: string;
  /** 全量扫描的分页大小。 */
  scanLimit?: number;
}

// ============================================================================
// Helpers
// ============================================================================

const DEFAULT_SCAN = 1_000_000;

type RoySidecarFields = {
  type?: string;
  progress?: number;
  current_status?: string;
  goals_and_expected_deliverables?: string;
  project_path?: string;
  context?: string;
  due_date?: string;
};

/** roy 实体字段 → 侧车 patch（只取调用方真的给了的）。 */
function toSidecarPatch(patch: PortUpdateTaskInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (patch.type !== undefined) out.type = patch.type;
  if (patch.progress !== undefined) out.progress = patch.progress;
  if (patch.current_status !== undefined) out.current_status = patch.current_status;
  if (patch.goals_and_expected_deliverables !== undefined) {
    out.goals_and_expected_deliverables = patch.goals_and_expected_deliverables;
  }
  if (patch.project_path !== undefined) out.project_path = patch.project_path;
  if (patch.context !== undefined) out.context = patch.context;
  if (patch.due_date !== undefined) out.due_date = patch.due_date;
  return out;
}

/** 存储记录 → roy `StoredTaskRecord`。 */
function toStoredTask(record: SidecarTask, vocabulary: SidecarVocabulary, parentNum?: number): StoredTaskRecord {
  if (typeof record.num !== "number") {
    throw new Error(`store did not expose a numeric handle for task ${record.id}`);
  }
  const side = (record.roy ?? {}) as RoySidecarFields;
  return {
    id: record.num,
    nativeId: record.id,
    title: record.title,
    description: record.description ?? "",
    status: vocabulary.toRoyStatus(record.status),
    priority: vocabulary.toRoyPriority(record.priority),
    type: (side.type ?? "normal") as StoredTaskRecord["type"],
    progress:
      typeof side.progress === "number" ? side.progress : record.status === "done" ? 100 : 0,
    current_status: side.current_status ?? "",
    goals_and_expected_deliverables: side.goals_and_expected_deliverables ?? "",
    ...(parentNum !== undefined ? { parent_task_id: parentNum } : {}),
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    ...(side.due_date ? { due_date: side.due_date } : {}),
    tags: vocabulary.toRoyTags(record.tags),
    project_path: side.project_path ?? "unknown",
    context: side.context ?? "{}",
    // Task #5440 — owner 原样回读（业务 store 的 owner 列）。
    // `null` 是「未指派」的合法值，必须原样带出（不能吞成 undefined）。
    ...(record.owner !== undefined ? { owner: record.owner } : {}),
  };
}

/** 存储 operation → roy `StoredOperationRecord`（含 @deprecated 别名镜像）。 */
function toStoredOperation(record: SidecarOperation): StoredOperationRecord {
  const data = record.data ?? {};
  const milestoneType = String(data.milestoneType ?? data.actionType ?? "progress");
  const milestoneTitle = String(data.milestoneTitle ?? data.actionTitle ?? "");
  const milestoneDescription = String(data.milestoneDescription ?? data.actionDescription ?? "");
  const taskIdRaw = data.taskId ?? record.task_id;
  const taskId =
    typeof taskIdRaw === "number"
      ? taskIdRaw
      : typeof taskIdRaw === "string" && /^\d+$/.test(taskIdRaw)
        ? Number(taskIdRaw)
        : 0;

  return {
    id: typeof record.num === "number" ? record.num : 0,
    nativeId: record.id,
    taskId,
    sessionId: String(data.sessionId ?? record.task_id ?? "unknown"),
    milestoneType: milestoneType as StoredOperationRecord["milestoneType"],
    milestoneTitle,
    milestoneDescription,
    processDescription: String(data.processDescription ?? ""),
    timestamp: record.created_at,
    ...(data.mdPath ? { mdPath: String(data.mdPath) } : {}),
    actionType: milestoneType as StoredOperationRecord["milestoneType"],
    actionTitle: milestoneTitle,
    actionDescription: milestoneDescription,
  };
}

// ============================================================================
// Port factory
// ============================================================================

/**
 * 把任意「带 roy 侧车」的存储接成一个 {@link TaskPersistencePort}。
 *
 * ⚠️ 只做形状翻译 + num↔nativeId 解析：不做 BFS、不做 depth、不拼
 * `Deliverable:`、不自动写 create operation —— 那些是 `TaskStoreBackend`
 * 的职责，所有 agent 插件共享同一份。
 */
export function createRoySidecarTaskPort(
  store: RoySidecarTaskStore,
  vocabulary: SidecarVocabulary,
  options: RoySidecarPortOptions = {},
): TaskPersistencePort {
  const operationType = options.operationType ?? "roy.milestone";
  const agent = options.agent ?? "roy";
  const scanLimit = options.scanLimit ?? DEFAULT_SCAN;

  /** uuid → num 缓存：store 用 uuid 表达父任务，roy 要数字句柄。 */
  async function parentNumMap(): Promise<Map<string, number>> {
    const all = await store.listTasks({ limit: scanLimit });
    return new Map(
      all.tasks.filter((t) => typeof t.num === "number").map((t) => [t.id, t.num as number]),
    );
  }

  async function resolveByNum(num: number): Promise<SidecarTask | null> {
    if (typeof store.getTaskByNum === "function") return await store.getTaskByNum(num);
    const all = await store.listTasks({ limit: scanLimit });
    return all.tasks.find((t) => t.num === num) ?? null;
  }

  /** roy 数字句柄 → 存储主键（找不到就抛，父任务必须存在）。 */
  async function nativeIdOf(num: number): Promise<string> {
    const nums = await parentNumMap();
    const hit = [...nums.entries()].find(([, n]) => n === num);
    if (!hit) throw new Error(`parent task not found: ${num}`);
    return hit[0];
  }

  return {
    async createTask(input: PortCreateTaskInput): Promise<StoredTaskRecord> {
      const parentId =
        input.parent_task_id !== undefined ? await nativeIdOf(input.parent_task_id) : null;

      const sidecar: RoySidecarFields = {
        type: input.type ?? "normal",
        progress: input.progress ?? 0,
        current_status: input.current_status ?? "",
        goals_and_expected_deliverables: input.goals_and_expected_deliverables ?? "",
        project_path: input.project_path,
        context: input.context,
        ...(input.due_date ? { due_date: input.due_date } : {}),
      };

      const created = await store.createTask({
        title: input.title,
        description: input.description,
        priority: vocabulary.toStorePriority(input.priority),
        // Task #5440 — 显式 owner 优先（backend 透传），缺省回落 agent。
        owner: input.owner ?? agent,
        tags: vocabulary.toStoreTags(input.tags),
        parent_id: parentId,
        session_id: input.sessionId ?? "unknown",
        roy: sidecar as Record<string, unknown>,
      });
      return toStoredTask(created, vocabulary, input.parent_task_id);
    },

    async getTask(nativeId: string): Promise<StoredTaskRecord | null> {
      const task = await store.getTask(nativeId);
      if (!task) return null;
      const nums = await parentNumMap();
      return toStoredTask(task, vocabulary, task.parent_id ? nums.get(task.parent_id) : undefined);
    },

    async getTaskByNum(num: number): Promise<StoredTaskRecord | null> {
      const task = await resolveByNum(num);
      if (!task) return null;
      const nums = await parentNumMap();
      return toStoredTask(task, vocabulary, task.parent_id ? nums.get(task.parent_id) : undefined);
    },

    async listTasks(request?: { limit?: number; offset?: number; includeArchived?: boolean }) {
      // This store keeps archived rows visible (no SQL-level exclusion), so
      // `includeArchived` needs no translation — it is honoured implicitly.
      const res = await store.listTasks({
        limit: request?.limit ?? 20,
        offset: request?.offset ?? 0,
      });
      const nums = await parentNumMap();
      return {
        tasks: res.tasks.map((t) =>
          toStoredTask(t, vocabulary, t.parent_id ? nums.get(t.parent_id) : undefined),
        ),
        total: res.total,
      };
    },

    async updateTask(
      nativeId: string,
      patch: PortUpdateTaskInput,
    ): Promise<StoredTaskRecord | null> {
      const sidePatch = toSidecarPatch(patch);
      const updated = await store.updateTask(nativeId, {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.status !== undefined ? { status: vocabulary.toStoreStatus(patch.status) } : {}),
        ...(patch.priority !== undefined
          ? { priority: vocabulary.toStorePriority(patch.priority) }
          : {}),
        ...(patch.tags !== undefined ? { tags: vocabulary.toStoreTags(patch.tags) } : {}),
        // Task #5440 — owner：undefined = 不改；null = 清空；字符串 = 改派。
        ...(patch.owner !== undefined ? { owner: patch.owner } : {}),
        ...(Object.keys(sidePatch).length > 0 ? { roy: sidePatch } : {}),
      });
      if (!updated) return null;

      let parentNum: number | undefined;
      if (patch.parent_task_id !== undefined) {
        const newParent =
          patch.parent_task_id === null ? null : await nativeIdOf(patch.parent_task_id);
        if (typeof store.setParentId === "function") {
          await store.setParentId(nativeId, newParent);
        }
        parentNum = patch.parent_task_id === null ? undefined : patch.parent_task_id;
      }
      const reread = (await store.getTask(nativeId)) ?? updated;
      if (parentNum === undefined && reread.parent_id) {
        const nums = await parentNumMap();
        parentNum = nums.get(reread.parent_id);
      }
      return toStoredTask(reread, vocabulary, parentNum);
    },

    async deleteTask(nativeId: string): Promise<boolean> {
      return await store.deleteTask(nativeId);
    },

    async createOperation(input: PortCreateOperationInput): Promise<StoredOperationRecord> {
      const op = await store.appendOperation({
        task_id: input.taskNativeId ?? String(input.taskId),
        type: operationType,
        data: {
          taskId: input.taskId,
          sessionId: input.sessionId,
          milestoneType: input.milestoneType,
          milestoneTitle: input.milestoneTitle,
          milestoneDescription: input.milestoneDescription,
          processDescription: input.processDescription,
          ...(input.mdPath ? { mdPath: input.mdPath } : {}),
        },
      });
      return toStoredOperation(op);
    },

    async listOperations(request?: { taskNativeId?: string; limit?: number; offset?: number }) {
      const res = await store.listOperations({
        ...(request?.taskNativeId ? { task_id: request.taskNativeId } : {}),
        type: operationType,
        limit: request?.limit ?? scanLimit,
        offset: request?.offset ?? 0,
      });
      return { operations: res.operations.map(toStoredOperation), total: res.total };
    },

    async getOperationByNum(num: number): Promise<StoredOperationRecord | null> {
      if (typeof store.getOperationByNum !== "function") return null;
      const op = await store.getOperationByNum(num);
      return op ? toStoredOperation(op) : null;
    },

    async updateOperationByNum(
      num: number,
      patch: PortUpdateOperationInput,
    ): Promise<StoredOperationRecord | null> {
      if (typeof store.updateOperation !== "function") return null;
      if (typeof store.getOperationByNum !== "function") return null;
      const existing = await store.getOperationByNum(num);
      if (!existing) return null;
      const previous = toStoredOperation(existing);

      const updated = await store.updateOperation(num, {
        data: {
          taskId: previous.taskId,
          sessionId: patch.sessionId ?? previous.sessionId,
          // The backend has already resolved the @deprecated action_* aliases
          // into the milestone_* fields, so re-reading them here would be dead
          // code (CV round 1). Keep the port's payload strictly canonical.
          milestoneType: patch.milestoneType ?? previous.milestoneType,
          milestoneTitle: patch.milestoneTitle ?? previous.milestoneTitle,
          milestoneDescription: patch.milestoneDescription ?? previous.milestoneDescription,
          processDescription: patch.processDescription ?? previous.processDescription,
          ...(patch.mdPath ?? previous.mdPath ? { mdPath: patch.mdPath ?? previous.mdPath } : {}),
        },
      });
      return updated ? toStoredOperation(updated) : null;
    },

    async deleteOperationByNum(num: number): Promise<boolean> {
      if (typeof store.deleteOperation !== "function") return false;
      return await store.deleteOperation(num);
    },
  };
}
