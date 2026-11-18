/**
 * @fileoverview TaskStoreBackend Tests
 *
 * Task #4380 — every behaviour asserted here is one of the findings from the
 * architecture review of `roy_task_plugin_for_opencode` (Task #4371), or a
 * finding raised by the Day-1 fix (Task #4375). Moving the roy *semantics*
 * into `@ai-setting/roy-bot-core` is only worth it if those semantics are
 * pinned by tests **here**, next to the tool factories that consume them.
 *
 * Finding → test map (see the report for the full table):
 *
 *  B1  subtree mode                → "getTaskTree — BFS subtree"
 *  B2  create ⇒ auto `create` op   → "createTask writes the create milestone"
 *  B3  deliverable ⇒ context       → "completeTask merges the deliverable"
 *  B4  flat operation list         → "listOperations returns a flat array"
 *  B5  honest total                → "listTasks reports the real total"
 *  Y1  depth                       → "listTasks honours depth"
 *  Y2  search filters              → "searchTasksByKeywords honours …"
 *  Y3  milestoneType filter        → "listOperations filters by milestoneType"
 *  Y4  single vocabulary source    → "vocabulary comes from roy's own enums"
 *  +   cycle-task guard            → "completeTask refuses cycle tasks"
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { SQLiteTaskStore } from "../storage/sqlite-task-store";
import { ActionTypeEnum, TaskPriorityEnum, TaskStatusEnum, TaskTypeEnum } from "../types";
import { createSQLiteTaskPort } from "./sqlite-task-port";
import { TaskStoreBackend } from "./task-store-backend";
import type { TaskBackend } from "./types";

let store: SQLiteTaskStore;
let backend: TaskBackend;

beforeEach(async () => {
  const dbPath = join(
    tmpdir(),
    `task-backend-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  store = new SQLiteTaskStore(dbPath);
  backend = new TaskStoreBackend(createSQLiteTaskPort(store), { sessionId: "ses_backend" });
});

afterEach(async () => {
  await store.close();
});

// ---------------------------------------------------------------------------
// Y4 — vocabulary single source
// ---------------------------------------------------------------------------

describe("vocabulary comes from roy's own enums (Y4)", () => {
  test("status / priority / type round-trip through the enums", async () => {
    const created = await backend.createTask({
      title: "vocab",
      status: undefined as never,
      priority: "high",
      type: "longterm",
      project_path: "/repo",
      context: "{}",
    });

    expect(TaskStatusEnum.safeParse(created.status).success).toBe(true);
    expect(TaskPriorityEnum.safeParse(created.priority).success).toBe(true);
    expect(TaskTypeEnum.safeParse(created.type).success).toBe(true);
  });

  test("every roy status is storable and readable back", async () => {
    for (const status of TaskStatusEnum.options) {
      const t = await backend.createTask({
        title: `status ${status}`,
        project_path: "/repo",
        context: "{}",
      });
      const updated = await backend.updateTask(t.id, { status });
      expect(updated!.status).toBe(status);
      expect((await backend.getTask(t.id))!.status).toBe(status);
    }
  });

  test("every ActionType is a legal milestoneType", async () => {
    const t = await backend.createTask({
      title: "op vocab",
      project_path: "/repo",
      context: "{}",
    });
    for (const milestoneType of ActionTypeEnum.options) {
      const op = await backend.createOperation({
        taskId: t.id,
        milestoneType,
        milestoneTitle: `type ${milestoneType}`,
      });
      expect(op.milestoneType).toBe(milestoneType);
    }
  });
});

// ---------------------------------------------------------------------------
// B2 — createTask writes the create milestone
// ---------------------------------------------------------------------------

describe("createTask writes the create milestone (B2)", () => {
  test("a fresh task already has exactly one `create` operation", async () => {
    const t = await backend.createTask({
      title: "lifecycle host",
      description: "desc",
      project_path: "/repo",
      context: "{}",
    });

    const ops = await backend.listOperations({ taskId: t.id });
    expect(ops.length).toBe(1);
    expect(ops[0].milestoneType).toBe("create");
    expect(ops[0].milestoneTitle).toBe("Task created: lifecycle host");
    expect(ops[0].milestoneDescription).toBe("desc");
    expect(ops[0].taskId).toBe(t.id);
    expect(ops[0].sessionId).toBe("ses_backend");
  });

  test("getTaskWithOperations exposes it without a second round-trip", async () => {
    const t = await backend.createTask({
      title: "with ops",
      project_path: "/repo",
      context: "{}",
    });
    const withOps = await backend.getTaskWithOperations(t.id);
    expect(withOps).not.toBeNull();
    expect(withOps!.operations.length).toBe(1);
    expect(withOps!.operations[0].milestoneTitle).toContain("Task created:");
  });
});

// ---------------------------------------------------------------------------
// B1 / Y1 — subtree + depth
// ---------------------------------------------------------------------------

describe("getTaskTree — BFS subtree (B1)", () => {
  test("returns every descendant, root excluded, flattened", async () => {
    const root = await backend.createTask({ title: "R", project_path: "/r", context: "{}" });
    const c1 = await backend.createTask({
      title: "C1",
      parent_task_id: root.id,
      project_path: "/r",
      context: "{}",
    });
    const gc = await backend.createTask({
      title: "GC",
      parent_task_id: c1.id,
      project_path: "/r",
      context: "{}",
    });

    const tree = await backend.getTaskTree(root.id);
    expect(tree.map((t) => t.title).sort()).toEqual(["C1", "GC"]);
    expect(tree.every((t) => t.id !== root.id)).toBe(true);
    expect(tree.map((t) => t.id)).toContain(gc.id);
  });

  test("depth limits the number of levels below the root", async () => {
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

    expect((await backend.getTaskTree(root.id, 1)).map((t) => t.title)).toEqual(["C"]);
    expect((await backend.getTaskTree(root.id, 2)).map((t) => t.title).sort()).toEqual([
      "C",
      "GC",
    ]);
    expect(await backend.getTaskTree(root.id, 0)).toEqual([]);
    expect((await backend.getTaskTree(root.id, -1)).length).toBe(2);
  });

  test("unknown root ⇒ empty list (never throws)", async () => {
    expect(await backend.getTaskTree(999_999)).toEqual([]);
  });
});

describe("listTasks honours depth (Y1)", () => {
  test("depth=0 returns roots only, depth=-1 returns everything", async () => {
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

    const depth0 = await backend.listTasks({ depth: 0 });
    expect(depth0.tasks.map((t) => t.title)).toEqual(["R"]);
    expect(depth0.total).toBe(1);

    const depth1 = await backend.listTasks({ depth: 1 });
    expect(depth1.tasks.map((t) => t.title).sort()).toEqual(["C", "R"]);
    expect(depth1.total).toBe(2);

    const all = await backend.listTasks({ depth: -1 });
    expect(all.tasks.map((t) => t.title).sort()).toEqual(["C", "GC", "R"]);
    expect(all.total).toBe(3);
  });

  test("depth composes with parent_task_id (parent wins as the subtree root)", async () => {
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

    const res = await backend.listTasks({ parent_task_id: child.id });
    expect(res.tasks.map((t) => t.title)).toEqual(["GC"]);
    expect(res.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// B5 — honest total
// ---------------------------------------------------------------------------

describe("listTasks reports the real total (B5)", () => {
  test("total counts every match, not just the returned page", async () => {
    for (let i = 0; i < 25; i++) {
      await backend.createTask({
        title: `bulk ${i}`,
        project_path: "/r",
        context: "{}",
      });
    }
    const page = await backend.listTasks({ limit: 5, offset: 0 });
    expect(page.tasks.length).toBe(5);
    expect(page.total).toBe(25);

    const tail = await backend.listTasks({ limit: 5, offset: 20 });
    expect(tail.tasks.length).toBe(5);
    expect(tail.total).toBe(25);
  });

  test("total stays honest with filters applied", async () => {
    await backend.createTask({ title: "a", priority: "high", project_path: "/r", context: "{}" });
    await backend.createTask({ title: "b", priority: "high", project_path: "/r", context: "{}" });
    await backend.createTask({ title: "c", priority: "low", project_path: "/r", context: "{}" });

    const res = await backend.listTasks({ priority: "high", limit: 1 });
    expect(res.tasks.length).toBe(1);
    expect(res.total).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// B3 — deliverable lands in context
// ---------------------------------------------------------------------------

describe("completeTask merges the deliverable into context (B3)", () => {
  test("deliverable_storage_path is set and sibling keys survive", async () => {
    const t = await backend.createTask({
      title: "deliverable host",
      project_path: "/repo",
      context: JSON.stringify({ branch: "feat/x", type: "feature" }),
    });

    const done = await backend.completeTask(t.id, "ses_done", "/tmp/report.md");
    expect(done).not.toBeNull();
    expect(done!.status).toBe("completed");
    expect(done!.progress).toBe(100);

    const ctx = JSON.parse(done!.context) as Record<string, unknown>;
    expect(ctx.deliverable_storage_path).toBe("/tmp/report.md");
    expect(ctx.branch).toBe("feat/x");
    expect(ctx.type).toBe("feature");
  });

  test("the completion operation carries the deliverable in milestoneDescription", async () => {
    const t = await backend.createTask({
      title: "deliverable op",
      project_path: "/repo",
      context: "{}",
    });
    await backend.completeTask(t.id, "ses_done", "/tmp/report.md");

    const ops = await backend.listOperations({ taskId: t.id, milestoneType: "completed" });
    expect(ops.length).toBe(1);
    expect(ops[0].milestoneDescription).toBe("Deliverable: /tmp/report.md");
    expect(ops[0].mdPath).toBe("/tmp/report.md");
  });

  test("corrupt context does not abort completion", async () => {
    const t = await backend.createTask({
      title: "corrupt ctx",
      project_path: "/repo",
      context: "{not json",
    });
    const done = await backend.completeTask(t.id, "ses_done", "/tmp/x.md");
    expect(done).not.toBeNull();
    const ctx = JSON.parse(done!.context) as Record<string, unknown>;
    expect(ctx.deliverable_storage_path).toBe("/tmp/x.md");
  });

  test("no deliverable ⇒ context untouched, no `Deliverable: undefined`", async () => {
    const t = await backend.createTask({
      title: "no deliverable",
      project_path: "/repo",
      context: JSON.stringify({ keep: 1 }),
    });
    const done = await backend.completeTask(t.id, "ses_done");
    expect(JSON.parse(done!.context)).toEqual({ keep: 1 });

    const ops = await backend.listOperations({ taskId: t.id, milestoneType: "completed" });
    expect(ops[0].milestoneDescription ?? "").not.toContain("undefined");
  });
});

// NOTE (CV round 1): this guard is NEW relative to the old plugin facade — roy's
// `TaskComponent.completeTask` has it, the plugin's facade did not. So a plugin
// caller that used to "complete" a cycle task now gets an error. That is the
// intended roy alignment, and it is pinned here rather than only at the plugin
// layer.
describe("completeTask refuses cycle tasks", () => {
  test("a completed-then-rejected cycle task keeps its previous state", async () => {
    const t = await backend.createTask({
      title: "weekly",
      type: "cycle",
      project_path: "/repo",
      context: "{}",
    });
    await expect(backend.completeTask(t.id, "ses")).rejects.toThrow(/cycle/i);
    // no partial write: status and progress are untouched
    const after = await backend.getTask(t.id);
    expect(after!.status).toBe("todo");
    expect(after!.progress).toBe(0);
    // and no completion operation was appended
    const ops = await backend.listOperations({ taskId: t.id, milestoneType: "completed" });
    expect(ops).toEqual([]);
  });

  test("cycle tasks cannot be completed", async () => {
    const t = await backend.createTask({
      title: "weekly report",
      type: "cycle",
      project_path: "/repo",
      context: "{}",
    });
    await expect(backend.completeTask(t.id, "ses_done")).rejects.toThrow(/cycle/i);
  });
});

// ---------------------------------------------------------------------------
// B4 / Y3 — operations
// ---------------------------------------------------------------------------

describe("listOperations returns a flat array (B4)", () => {
  test("the return value is an array, not { operations, total }", async () => {
    const t = await backend.createTask({ title: "flat", project_path: "/r", context: "{}" });
    const ops = await backend.listOperations({ taskId: t.id });
    expect(Array.isArray(ops)).toBe(true);
    expect(ops.length).toBe(1);
    // the tool JSON.stringify({operations, count}) shape needs a flat array
    expect(JSON.parse(JSON.stringify({ operations: ops, count: ops.length })).operations.length).toBe(1);
  });
});

describe("listOperations filters by milestoneType (Y3)", () => {
  test("only the requested milestone type comes back", async () => {
    const t = await backend.createTask({ title: "filter", project_path: "/r", context: "{}" });
    await backend.createOperation({
      taskId: t.id,
      milestoneType: "milestone",
      milestoneTitle: "m1",
    });
    await backend.createOperation({
      taskId: t.id,
      milestoneType: "problem",
      milestoneTitle: "p1",
    });

    const milestones = await backend.listOperations({ taskId: t.id, milestoneType: "milestone" });
    expect(milestones.map((o) => o.milestoneTitle)).toEqual(["m1"]);

    const problems = await backend.listOperations({ taskId: t.id, milestoneType: "problem" });
    expect(problems.map((o) => o.milestoneTitle)).toEqual(["p1"]);

    // pagination applies AFTER the filter
    const limited = await backend.listOperations({
      taskId: t.id,
      milestoneType: "milestone",
      limit: 1,
      offset: 0,
    });
    expect(limited.length).toBe(1);
  });

  test("deprecated action_* aliases still map onto milestone_*", async () => {
    const t = await backend.createTask({ title: "alias", project_path: "/r", context: "{}" });
    const op = await backend.createOperation({
      taskId: t.id,
      actionType: "decision",
      actionTitle: "legacy title",
      actionDescription: "legacy desc",
    });
    expect(op.milestoneType).toBe("decision");
    expect(op.milestoneTitle).toBe("legacy title");
    expect(op.milestoneDescription).toBe("legacy desc");
    // and the compatibility aliases are mirrored back out
    expect(op.actionType).toBe("decision");
    expect(op.actionTitle).toBe("legacy title");
    expect(op.actionDescription).toBe("legacy desc");
  });

  test("operation CRUD round-trips", async () => {
    const t = await backend.createTask({ title: "crud", project_path: "/r", context: "{}" });
    const created = await backend.createOperation({
      taskId: t.id,
      milestoneType: "progress",
      milestoneTitle: "before",
    });

    const read = await backend.getOperation(created.id);
    expect(read?.milestoneTitle).toBe("before");

    const updated = await backend.updateOperation(created.id, {
      milestoneTitle: "after",
      processDescription: "did the thing",
    });
    expect(updated?.milestoneTitle).toBe("after");
    expect(updated?.processDescription).toBe("did the thing");

    expect(await backend.deleteOperation(created.id)).toBe(true);
    expect(await backend.getOperation(created.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Y2 — search filters
// ---------------------------------------------------------------------------

describe("searchTasksByKeywords honours every roy option (Y2)", () => {
  async function seed() {
    const root = await backend.createTask({
      title: "alpha root",
      priority: "high",
      type: "normal",
      project_path: "/repo",
      context: "{}",
    });
    const child = await backend.createTask({
      title: "alpha child",
      parent_task_id: root.id,
      priority: "low",
      type: "normal",
      project_path: "/repo",
      context: "{}",
    });
    const other = await backend.createTask({
      title: "beta notes",
      description: "mentions alpha in passing",
      priority: "medium",
      type: "longterm",
      project_path: "/repo",
      context: "{}",
    });
    await backend.completeTask(other.id, "ses_backend");
    return { root, child, other };
  }

  test("baseline keyword match (title OR description)", async () => {
    await seed();
    // "alpha root" + "alpha child" match by title, "beta notes" by description
    const hit = await backend.searchTasksByKeywords(["alpha"]);
    expect(hit.total).toBe(3);
    expect(hit.tasks.length).toBe(3);
  });

  test("status filter is applied", async () => {
    await seed();
    const done = await backend.searchTasksByKeywords(["alpha"], { status: "completed" });
    expect(done.tasks.map((t) => t.title)).toEqual(["beta notes"]);
    const todo = await backend.searchTasksByKeywords([], { status: "todo" });
    expect(todo.total).toBe(2);
  });

  test("priority filter is applied", async () => {
    await seed();
    const high = await backend.searchTasksByKeywords(["alpha"], { priority: "high" });
    expect(high.tasks.map((t) => t.title)).toEqual(["alpha root"]);
  });

  test("type filter is applied", async () => {
    await seed();
    const longterm = await backend.searchTasksByKeywords(["alpha"], { type: "longterm" });
    expect(longterm.tasks.map((t) => t.title)).toEqual(["beta notes"]);
  });

  test("excludeTaskId is applied", async () => {
    const { root } = await seed();
    const res = await backend.searchTasksByKeywords(["alpha"], { excludeTaskId: root.id });
    expect(res.tasks.map((t) => t.title)).not.toContain("alpha root");
    expect(res.total).toBe(2);
  });

  test("depth is applied", async () => {
    await seed();
    const roots = await backend.searchTasksByKeywords([], { depth: 0 });
    expect(roots.tasks.map((t) => t.title).sort()).toEqual(["alpha root", "beta notes"]);
  });

  test("limit / offset paginate after filtering, total stays honest", async () => {
    await seed();
    const page = await backend.searchTasksByKeywords(["alpha"], { limit: 1, offset: 0 });
    expect(page.tasks.length).toBe(1);
    expect(page.total).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// General CRUD contract (shape roy's tool factories rely on)
// ---------------------------------------------------------------------------

describe("backend surface", () => {
  test("implements every method roy's tool factories call", () => {
    for (const m of [
      "createTask",
      "getTask",
      "getTaskWithOperations",
      "listTasks",
      "updateTask",
      "deleteTask",
      "completeTask",
      "createOperation",
      "listOperations",
      "getOperation",
      "updateOperation",
      "deleteOperation",
      "getTaskTree",
      "searchTasksByKeywords",
    ]) {
      expect(typeof (backend as unknown as Record<string, unknown>)[m]).toBe("function");
    }
  });

  test("getTaskWithOperations returns a roy Task plus a flat operations array", async () => {
    const t = await backend.createTask({
      title: "shape",
      project_path: "/repo",
      context: "{}",
    });
    const withOps = await backend.getTaskWithOperations(t.id);
    // ⚠️ roy's get-tool spreads this straight into JSON, so it must be
    // `Task & { operations }` — NOT `{ task, operations }` (that nesting was
    // finding B-shape in the review).
    expect(withOps!.title).toBe("shape");
    expect(Array.isArray(withOps!.operations)).toBe(true);
  });

  test("createTask validates the parent exists", async () => {
    await expect(
      backend.createTask({
        title: "orphan",
        parent_task_id: 999_999,
        project_path: "/repo",
        context: "{}",
      }),
    ).rejects.toThrow(/parent/i);
  });

  test("updateTask can reparent to null (root promotion)", async () => {
    const root = await backend.createTask({ title: "R", project_path: "/r", context: "{}" });
    const child = await backend.createTask({
      title: "C",
      parent_task_id: root.id,
      project_path: "/r",
      context: "{}",
    });
    const promoted = await backend.updateTask(child.id, { parent_task_id: null });
    expect(promoted!.parent_task_id).toBeUndefined();
  });

  test("deleteTask removes the row", async () => {
    const t = await backend.createTask({ title: "gone", project_path: "/r", context: "{}" });
    expect(await backend.deleteTask(t.id)).toBe(true);
    expect(await backend.getTask(t.id)).toBeNull();
    expect(await backend.deleteTask(t.id)).toBe(false);
  });

  test("updateTask returns null for a missing task", async () => {
    expect(await backend.updateTask(999_999, { title: "nope" })).toBeNull();
  });

  test("completeTask returns null for a missing task", async () => {
    expect(await backend.completeTask(999_999, "ses")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Round-1 cross-validation regressions (2026-10-20)
//
// The validator found that `createSQLiteTaskPort` — the port the module
// docstring tells new adapters to use — silently dropped `status` and could
// never see archived rows, because:
//   1. `needsMemoryFilter` did not include `status`, so the fast path asked the
//      port for a page while the port has no `status` parameter at all;
//   2. the full scan went through `port.listTasks()` which forwards no
//      `include_archived`, and roy's SQLite store then appends
//      `status != 'archived'` — so archived rows were gone before any filter ran.
// Both are the exact bug class this task exists to eliminate, so they get
// tests at the *canonical* layer (SQLite port), not just the plugin layer.
// ---------------------------------------------------------------------------

describe("listTasks forwards `status` to the filter (CV round 1, D1)", () => {
  test("status=completed returns only completed tasks", async () => {
    const done = await backend.createTask({ title: "done one", project_path: "/r", context: "{}" });
    await backend.completeTask(done.id, "ses_backend");
    await backend.createTask({ title: "todo one", project_path: "/r", context: "{}" });

    const res = await backend.listTasks({ status: "completed" });
    expect(res.tasks.map((t) => t.title)).toEqual(["done one"]);
    expect(res.total).toBe(1);

    const todo = await backend.listTasks({ status: "todo" });
    expect(todo.tasks.map((t) => t.title)).toEqual(["todo one"]);
    expect(todo.total).toBe(1);
  });

  test("status filter paginates against the filtered set, not the whole table", async () => {
    for (const title of ["c1", "c2", "c3"]) {
      const t = await backend.createTask({ title, project_path: "/r", context: "{}" });
      await backend.completeTask(t.id, "ses_backend");
    }
    await backend.createTask({ title: "open", project_path: "/r", context: "{}" });

    const page = await backend.listTasks({ status: "completed", limit: 2, offset: 0 });
    expect(page.tasks.length).toBe(2);
    expect(page.total).toBe(3);
  });
});

describe("archived rows are reachable (CV round 1, D2)", () => {
  async function seedArchived() {
    const live = await backend.createTask({ title: "live", project_path: "/r", context: "{}" });
    const dead = await backend.createTask({ title: "arch", project_path: "/r", context: "{}" });
    await backend.updateTask(dead.id, { status: "archived" });
    return { live, dead };
  }

  test("an explicit status='archived' query is not self-defeating", async () => {
    const { dead } = await seedArchived();
    const res = await backend.listTasks({ status: "archived" });
    expect(res.tasks.map((t) => t.title)).toEqual(["arch"]);
    expect(res.total).toBe(1);
    expect(res.tasks[0].id).toBe(dead.id);
  });

  test("include_archived exposes live + archived, with an honest total", async () => {
    await seedArchived();
    const res = await backend.listTasks({ include_archived: true });
    expect(res.tasks.map((t) => t.title).sort()).toEqual(["arch", "live"]);
    expect(res.total).toBe(2);
  });

  test("archived stays excluded by default", async () => {
    await seedArchived();
    const res = await backend.listTasks({});
    expect(res.tasks.map((t) => t.title)).toEqual(["live"]);
    expect(res.total).toBe(1);
  });

  test("search honours include_archived and status='archived'", async () => {
    const { dead } = await seedArchived();
    const withArchived = await backend.searchTasksByKeywords([], { include_archived: true });
    expect(withArchived.total).toBe(2);

    const onlyArchived = await backend.searchTasksByKeywords([], { status: "archived" });
    expect(onlyArchived.tasks.map((t) => t.id)).toEqual([dead.id]);
  });

  test("getTaskTree is not blind to archived descendants", async () => {
    const root = await backend.createTask({ title: "R", project_path: "/r", context: "{}" });
    const child = await backend.createTask({
      title: "C",
      parent_task_id: root.id,
      project_path: "/r",
      context: "{}",
    });
    await backend.updateTask(child.id, { status: "archived" });

    // The tree is a structural query: an archived child still exists, so it
    // must show up (the old plugin facade listed everything it could see).
    expect((await backend.getTaskTree(root.id)).map((t) => t.title)).toEqual(["C"]);
  });
});

// ---------------------------------------------------------------------------
// CV round 3 (final): pin the interaction between depth and excludeTaskId.
//
// The pre-refactor facade applied `excludeTaskId` BEFORE `depth`; the core
// backend applies depth first (inside `applyFilters`). The new order matches
// roy's own `SQLiteTaskStore` — which computes the depth set over the whole
// table before filtering — so it is a correction, not a regression. But
// nothing pinned it, so a future edit to either filter had no regression net.
// ---------------------------------------------------------------------------

describe("search: depth and excludeTaskId compose the way roy does", () => {
  test("excluding the parent BEFORE depth would promote its children to roots", async () => {
    const root = await backend.createTask({ title: "R", project_path: "/r", context: "{}" });
    await backend.createTask({
      title: "C",
      parent_task_id: root.id,
      project_path: "/r",
      context: "{}",
    });

    // depth=0 keeps roots only. `C` is not a root while its parent is visible,
    // so excluding R must NOT promote C into the result — that is roy's
    // behaviour (depth set computed over the full table, then filtered).
    const res = await backend.searchTasksByKeywords([], {
      depth: 0,
      excludeTaskId: root.id,
    });
    expect(res.tasks.map((t) => t.title)).toEqual([]);
    expect(res.total).toBe(0);

    // Sanity: without excludeTaskId, depth=0 returns the root.
    const roots = await backend.searchTasksByKeywords([], { depth: 0 });
    expect(roots.tasks.map((t) => t.title)).toEqual(["R"]);
  });
});
