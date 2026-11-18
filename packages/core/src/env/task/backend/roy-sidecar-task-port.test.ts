/**
 * @fileoverview RoySidecarTaskPort Tests
 *
 * Task #4380. The generic sidecar port is what lets a *new* agent adapter
 * (Claude Code, Codex, …) reuse every roy semantic by supplying only a
 * vocabulary mapping. These tests pin that contract against an in-memory
 * duck-typed store whose shape mirrors `roy_task_plugin_for_opencode`'s
 * `TaskStore` (uuid primary key, numeric rowid handle, roy sidecar blob,
 * JSON operations log) — i.e. exactly the shape the next adapter will have.
 */

import { describe, expect, test } from "bun:test";
import { createRoySidecarTaskPort } from "./roy-sidecar-task-port";
import type {
  RoySidecarTaskStore,
  SidecarOperation,
  SidecarTask,
  SidecarVocabulary,
} from "./roy-sidecar-task-port";
import { TaskStoreBackend } from "./task-store-backend";
import type { TaskBackend } from "./types";

/** A store shaped like the opencode plugin's, minus SQLite. */
function createFakeStore(): RoySidecarTaskStore {
  const tasks: SidecarTask[] = [];
  const operations: SidecarOperation[] = [];
  let nextNum = 1;

  return {
    async createTask(input) {
      const num = nextNum++;
      const now = new Date().toISOString();
      const task: SidecarTask = {
        id: `uuid-${num}`,
        num,
        title: input.title,
        description: input.description,
        status: input.roy?.type === "longterm" ? "in_progress" : "pending",
        priority: input.priority ?? 3,
        tags: input.tags,
        parent_id: input.parent_id ?? null,
        session_id: input.session_id,
        roy: input.roy,
        created_at: now,
        updated_at: now,
      };
      tasks.push(task);
      return task;
    },
    async updateTask(id, input) {
      const task = tasks.find((t) => t.id === id);
      if (!task) return null;
      Object.assign(task, {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.roy !== undefined ? { roy: { ...task.roy, ...input.roy } } : {}),
        updated_at: new Date().toISOString(),
      });
      return task;
    },
    async getTask(id) {
      return tasks.find((t) => t.id === id) ?? null;
    },
    async getTaskByNum(num) {
      return tasks.find((t) => t.num === num) ?? null;
    },
    async listTasks(filter) {
      const limit = filter?.limit ?? 20;
      const offset = filter?.offset ?? 0;
      return { tasks: tasks.slice(offset, offset + limit), total: tasks.length };
    },
    async deleteTask(id) {
      const i = tasks.findIndex((t) => t.id === id);
      if (i < 0) return false;
      tasks.splice(i, 1);
      return true;
    },
    async setParentId(id, parentId) {
      const task = tasks.find((t) => t.id === id);
      if (task) task.parent_id = parentId;
    },
    async appendOperation(input) {
      const num = operations.length + 1;
      const op: SidecarOperation = {
        id: `op-uuid-${num}`,
        num,
        task_id: input.task_id,
        type: input.type,
        data: input.data,
        created_at: new Date().toISOString(),
      };
      operations.push(op);
      return op;
    },
    async listOperations(filter) {
      const limit = filter?.limit ?? 1_000_000;
      const offset = filter?.offset ?? 0;
      const hits = operations.filter(
        (o) =>
          (filter?.task_id === undefined || o.task_id === filter.task_id) &&
          (filter?.type === undefined || o.type === filter.type),
      );
      return { operations: hits.slice(offset, offset + limit), total: hits.length };
    },
    async getOperationByNum(num) {
      return operations.find((o) => o.num === num) ?? null;
    },
    async updateOperation(num, patch) {
      const op = operations.find((o) => o.num === num);
      if (!op) return null;
      if (patch.data !== undefined) op.data = patch.data;
      return op;
    },
    async deleteOperation(num) {
      const i = operations.findIndex((o) => o.num === num);
      if (i < 0) return false;
      operations.splice(i, 1);
      return true;
    },
  };
}

/**
 * A deliberately *lossy, different* vocabulary — this is the whole point: an
 * adapter supplies only this, and roy semantics still hold.
 */
const VOCABULARY: SidecarVocabulary = {
  toRoyStatus: (s) =>
    ({ pending: "todo", in_progress: "active", blocked: "paused", review: "active", done: "completed", cancelled: "cancelled", archived: "archived" })[s] as never ?? "todo",
  toStoreStatus: (s) =>
    ({ todo: "pending", active: "in_progress", completed: "done", paused: "blocked", cancelled: "cancelled", archived: "archived" })[s] as never ?? "pending",
  toRoyPriority: (p) => (p === undefined ? "medium" : p <= 2 ? "high" : p === 3 ? "medium" : "low"),
  toStorePriority: (p) => (p === "high" ? 1 : p === "low" ? 5 : 3),
  toRoyTags: (t) => (t ? t.split(",").map((x) => x.trim()).filter(Boolean) : []),
  toStoreTags: (t) => (t && t.length > 0 ? t.join(",") : undefined),
};

function makeBackend(): TaskBackend {
  return new TaskStoreBackend(createRoySidecarTaskPort(createFakeStore(), VOCABULARY), {
    sessionId: "ses_sidecar",
  });
}

describe("RoySidecarTaskPort — a new adapter only supplies a vocabulary", () => {
  test("status / priority / type survive the (lossy) vocabulary round trip", async () => {
    const backend = makeBackend();
    const t = await backend.createTask({
      title: "vocab",
      priority: "high",
      type: "longterm",
      project_path: "/repo",
      context: "{}",
    });
    expect(t.status).toBe("active"); // store "in_progress" -> roy "active"
    expect(t.priority).toBe("high");
    expect(t.type).toBe("longterm");

    const paused = await backend.updateTask(t.id, { status: "paused" });
    expect(paused!.status).toBe("paused"); // store "blocked" -> roy "paused"
  });

  test("B2 — createTask still auto-writes the create milestone", async () => {
    const backend = makeBackend();
    const t = await backend.createTask({
      title: "sidecar lifecycle",
      description: "desc",
      project_path: "/repo",
      context: "{}",
    });
    const ops = await backend.listOperations({ taskId: t.id });
    expect(ops.length).toBe(1);
    expect(ops[0].milestoneType).toBe("create");
    expect(ops[0].milestoneTitle).toBe("Task created: sidecar lifecycle");
  });

  test("B1 — subtree BFS works on uuid parents via the numeric handle map", async () => {
    const backend = makeBackend();
    const root = await backend.createTask({ title: "R", project_path: "/r", context: "{}" });
    const child = await backend.createTask({
      title: "C",
      parent_task_id: root.id,
      project_path: "/r",
      context: "{}",
    });
    await backend.createTask({
      title: "GC",
      parent_task_id: child.id,
      project_path: "/r",
      context: "{}",
    });

    expect((await backend.getTaskTree(root.id)).map((t) => t.title).sort()).toEqual(["C", "GC"]);
    expect((await backend.getTaskTree(root.id, 1)).map((t) => t.title)).toEqual(["C"]);
  });

  test("Y1 — depth works through the sidecar port", async () => {
    const backend = makeBackend();
    const root = await backend.createTask({ title: "R", project_path: "/r", context: "{}" });
    await backend.createTask({
      title: "C",
      parent_task_id: root.id,
      project_path: "/r",
      context: "{}",
    });

    expect((await backend.listTasks({ depth: 0 })).tasks.map((t) => t.title)).toEqual(["R"]);
    expect((await backend.listTasks({ depth: -1 })).total).toBe(2);
  });

  test("B3 — deliverable lands in context.deliverable_storage_path", async () => {
    const backend = makeBackend();
    const t = await backend.createTask({
      title: "deliverable",
      project_path: "/repo",
      context: JSON.stringify({ branch: "feat/x" }),
    });
    const done = await backend.completeTask(t.id, "ses_sidecar", "/tmp/report.md");
    const ctx = JSON.parse(done!.context) as Record<string, unknown>;
    expect(ctx.deliverable_storage_path).toBe("/tmp/report.md");
    expect(ctx.branch).toBe("feat/x");

    const ops = await backend.listOperations({ taskId: t.id, milestoneType: "completed" });
    expect(ops[0].milestoneDescription).toBe("Deliverable: /tmp/report.md");
  });

  test("B4 / Y3 — flat operation list, filtered by milestoneType", async () => {
    const backend = makeBackend();
    const t = await backend.createTask({ title: "ops", project_path: "/r", context: "{}" });
    await backend.createOperation({
      taskId: t.id,
      milestoneType: "problem",
      milestoneTitle: "p1",
    });
    const problems = await backend.listOperations({ taskId: t.id, milestoneType: "problem" });
    expect(Array.isArray(problems)).toBe(true);
    expect(problems.map((o) => o.milestoneTitle)).toEqual(["p1"]);
  });

  test("B5 — total is the real count even though the port paginates", async () => {
    const backend = makeBackend();
    for (let i = 0; i < 12; i++) {
      await backend.createTask({ title: `bulk ${i}`, project_path: "/r", context: "{}" });
    }
    const page = await backend.listTasks({ limit: 3, offset: 0 });
    expect(page.tasks.length).toBe(3);
    expect(page.total).toBe(12);
  });

  test("Y2 — search filters apply through the sidecar port", async () => {
    const backend = makeBackend();
    await backend.createTask({ title: "alpha one", priority: "high", project_path: "/r", context: "{}" });
    await backend.createTask({ title: "alpha two", priority: "low", project_path: "/r", context: "{}" });

    const high = await backend.searchTasksByKeywords(["alpha"], { priority: "high" });
    expect(high.tasks.map((t) => t.title)).toEqual(["alpha one"]);
    expect(high.total).toBe(1);
  });

  test("operation CRUD goes through the sidecar port", async () => {
    const backend = makeBackend();
    const t = await backend.createTask({ title: "crud", project_path: "/r", context: "{}" });
    const created = await backend.createOperation({
      taskId: t.id,
      milestoneType: "progress",
      milestoneTitle: "before",
    });
    const updated = await backend.updateOperation(created.id, { milestoneTitle: "after" });
    expect(updated!.milestoneTitle).toBe("after");
    expect(await backend.deleteOperation(created.id)).toBe(true);
    expect(await backend.getOperation(created.id)).toBeNull();
  });

  test("re-parenting translates roy num → store uuid", async () => {
    const backend = makeBackend();
    const a = await backend.createTask({ title: "A", project_path: "/r", context: "{}" });
    const b = await backend.createTask({ title: "B", project_path: "/r", context: "{}" });
    const child = await backend.createTask({
      title: "C",
      parent_task_id: a.id,
      project_path: "/r",
      context: "{}",
    });
    expect(child.parent_task_id).toBe(a.id);

    const moved = await backend.updateTask(child.id, { parent_task_id: b.id });
    expect(moved!.parent_task_id).toBe(b.id);

    const detached = await backend.updateTask(child.id, { parent_task_id: null });
    expect(detached!.parent_task_id).toBeUndefined();
  });

  test("a missing parent is rejected, not silently dropped", async () => {
    const backend = makeBackend();
    await expect(
      backend.createTask({
        title: "orphan",
        parent_task_id: 999,
        project_path: "/r",
        context: "{}",
      }),
    ).rejects.toThrow(/parent/i);
  });
});
