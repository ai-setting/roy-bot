/**
 * @fileoverview task_tree tool tests
 *
 * Coverage for the new `task_tree` MCP tool that returns a hierarchical
 * (forest) view of tasks.
 *
 * TDD: written before `task-tree-tool.ts` implementation.
 *
 * Reference: Plan operation #15094 for Task #2075.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { TaskComponent } from "../task-component";
import { ConfigComponent } from "../../../config/config-component";
import { treeTasksTool } from "./task-tree-tool";
import { createTaskTool } from "./create-tool";

/**
 * Helper: build a fresh sqlite TaskComponent for each test (isolation).
 */
async function freshTaskComponent(): Promise<TaskComponent> {
  const configComponent = new ConfigComponent();
  const tc = new TaskComponent();
  await tc.init({
    options: {
      configComponent,
      config: {
        storage: {
          type: "sqlite",
          dbPath: join(tmpdir(), `task-tree-test-${Date.now()}-${Math.random()}.db`),
        },
      },
    },
  });
  return tc;
}

/**
 * Helper: create a task (bypass tool validation) and return its id.
 *
 * Note: store.createTask hardcodes status='todo' on insert, so we always
 * call updateTask afterwards to apply the requested status/priority/type.
 */
async function seedTask(
  tc: TaskComponent,
  fields: {
    title: string;
    parent_task_id?: number;
    type?: "normal" | "cycle" | "longterm";
    status?: "todo" | "active" | "completed" | "paused" | "cancelled" | "archived";
    priority?: "low" | "medium" | "high";
  }
): Promise<number> {
  const t = await (tc as any).store.createTask({
    title: fields.title,
    parent_task_id: fields.parent_task_id,
    type: fields.type ?? "normal",
    status: fields.status ?? "todo",
    priority: fields.priority ?? "medium",
    project_path: "unknown",
    context: "{}",
    sessionId: "sess_seed",
  });
  // Apply any non-default overrides via updateTask (store.createTask
  // hardcodes status/timestamps on insert).
  const overrides: Record<string, unknown> = {};
  if (fields.status !== undefined && fields.status !== "todo") {
    overrides.status = fields.status;
  }
  if (fields.type !== undefined && fields.type !== "normal") {
    overrides.type = fields.type;
  }
  if (fields.priority !== undefined && fields.priority !== "medium") {
    overrides.priority = fields.priority;
  }
  if (Object.keys(overrides).length > 0) {
    await (tc as any).store.updateTask(t.id, overrides);
  }
  return t.id as number;
}

/** Helper: count nodes (incl. descendants) in a TaskNode tree. */
function countNodes(nodes: any[]): number {
  let n = 0;
  for (const node of nodes) {
    n += 1 + countNodes(node.children || []);
  }
  return n;
}

describe("treeTasksTool - output structure", () => {
  let tc: TaskComponent;

  beforeEach(async () => {
    tc = await freshTaskComponent();
  });

  afterEach(async () => {
    await tc.stop();
  });

  it("should return empty forest when no tasks exist", async () => {
    const tool = treeTasksTool(tc);
    const result = await tool.execute({}, { session_id: "s1" });

    expect(result.success).toBe(true);
    const data = JSON.parse(result.output as string);

    expect(data.total).toBe(0);
    expect(data.truncated).toBe(false);
    expect(data.nodes).toEqual([]);
  });

  it("should place `total` as the FIRST key in the raw JSON (truncation-safe)", async () => {
    await seedTask(tc, { title: "Root" });
    const tool = treeTasksTool(tc);
    const result = await tool.execute({}, { session_id: "s1" });

    expect(result.success).toBe(true);
    const raw = result.output as string;
    // Tail-truncation safety: `total` must come before `nodes`/`depth`/etc.
    expect(raw.startsWith('{"total":')).toBe(true);
  });

  it("should include the resolved depth and parent_task_id in the response", async () => {
    const rootId = await seedTask(tc, { title: "Root" });
    const tool = treeTasksTool(tc);
    const result = await tool.execute(
      { parent_task_id: rootId, depth: 1 },
      { session_id: "s1" }
    );

    const data = JSON.parse(result.output as string);
    expect(data.depth).toBe(1);
    expect(data.parent_task_id).toBe(rootId);
  });

  it("should default depth to 2 (roots + 2 levels of children)", async () => {
    // Build a 3-level chain: root → child → grand → great
    const root = await seedTask(tc, { title: "L0-root" });
    const child = await seedTask(tc, { title: "L1-child", parent_task_id: root });
    const grand = await seedTask(tc, { title: "L2-grand", parent_task_id: child });
    await seedTask(tc, { title: "L3-great", parent_task_id: grand });

    const tool = treeTasksTool(tc);
    const result = await tool.execute({}, { session_id: "s1" });

    const data = JSON.parse(result.output as string);
    expect(data.depth).toBe(2);
    // The great-grandchild (L3) is below default depth=2, should NOT appear
    expect(data.total).toBe(3); // root + child + grand
    expect(countNodes(data.nodes)).toBe(3);
  });

  it("should respect depth=0 (return only roots, no children array populated)", async () => {
    const root = await seedTask(tc, { title: "Root" });
    await seedTask(tc, { title: "Child", parent_task_id: root });

    const tool = treeTasksTool(tc);
    const result = await tool.execute({ depth: 0 }, { session_id: "s1" });

    const data = JSON.parse(result.output as string);
    expect(data.depth).toBe(0);
    expect(data.nodes).toHaveLength(1);
    expect(data.nodes[0].id).toBe(root);
    expect(data.nodes[0].children).toEqual([]);
    // total counts ALL returned nodes (here just the root)
    expect(data.total).toBe(1);
  });

  it("should respect explicit depth=3", async () => {
    const root = await seedTask(tc, { title: "L0" });
    const child = await seedTask(tc, { title: "L1", parent_task_id: root });
    const grand = await seedTask(tc, { title: "L2", parent_task_id: child });
    await seedTask(tc, { title: "L3", parent_task_id: grand });

    const tool = treeTasksTool(tc);
    const result = await tool.execute({ depth: 3 }, { session_id: "s1" });

    const data = JSON.parse(result.output as string);
    expect(data.total).toBe(4);
  });

  it("should return subtree when parent_task_id is specified", async () => {
    const a = await seedTask(tc, { title: "A" });
    const b = await seedTask(tc, { title: "B" });
    const aChild = await seedTask(tc, { title: "A-child", parent_task_id: a });
    const bChild = await seedTask(tc, { title: "B-child", parent_task_id: b });

    const tool = treeTasksTool(tc);
    const result = await tool.execute(
      { parent_task_id: a, depth: -1 },
      { session_id: "s1" }
    );

    const data = JSON.parse(result.output as string);
    expect(data.parent_task_id).toBe(a);
    // Subtree should contain A + A-child (not B or B-child)
    const ids = data.nodes[0].children.map((n: any) => n.id);
    expect(ids).toContain(aChild);
    expect(ids).not.toContain(bChild);
    expect(ids).not.toContain(b);
  });

  it("should handle non-existent parent_task_id gracefully (empty forest)", async () => {
    await seedTask(tc, { title: "Real" });
    const tool = treeTasksTool(tc);
    const result = await tool.execute(
      { parent_task_id: 999999, depth: -1 },
      { session_id: "s1" }
    );

    // Non-existent parent → empty forest, but success=true (graceful)
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output as string);
    expect(data.total).toBe(0);
    expect(data.nodes).toEqual([]);
  });

  it("should filter by status", async () => {
    const a = await seedTask(tc, { title: "Active", status: "active" });
    await seedTask(tc, { title: "Todo", status: "todo" });

    const tool = treeTasksTool(tc);
    const result = await tool.execute(
      { status: "active", depth: 0 },
      { session_id: "s1" }
    );

    const data = JSON.parse(result.output as string);
    expect(data.nodes).toHaveLength(1);
    expect(data.nodes[0].id).toBe(a);
    expect(data.nodes[0].status).toBe("active");
  });

  it("should filter by type", async () => {
    const a = await seedTask(tc, { title: "Longterm", type: "longterm" });
    await seedTask(tc, { title: "Normal", type: "normal" });

    const tool = treeTasksTool(tc);
    const result = await tool.execute(
      { type: "longterm", depth: 0 },
      { session_id: "s1" }
    );

    const data = JSON.parse(result.output as string);
    expect(data.nodes).toHaveLength(1);
    expect(data.nodes[0].id).toBe(a);
    expect(data.nodes[0].type).toBe("longterm");
  });

  it("should exclude archived by default (include_archived default false)", async () => {
    const active = await seedTask(tc, { title: "Active", status: "active" });
    await seedTask(tc, { title: "Archived", status: "archived" });

    const tool = treeTasksTool(tc);
    const result = await tool.execute({ depth: 0 }, { session_id: "s1" });

    const data = JSON.parse(result.output as string);
    expect(data.nodes).toHaveLength(1);
    expect(data.nodes[0].id).toBe(active);
  });

  it("should include archived when include_archived=true", async () => {
    const a = await seedTask(tc, { title: "Active", status: "active" });
    const b = await seedTask(tc, { title: "Archived", status: "archived" });

    const tool = treeTasksTool(tc);
    const result = await tool.execute(
      { include_archived: true, depth: 0 },
      { session_id: "s1" }
    );

    const data = JSON.parse(result.output as string);
    expect(data.nodes).toHaveLength(2);
    const ids = data.nodes.map((n: any) => n.id).sort();
    expect(ids).toEqual([a, b].sort());
  });

  it("should sort children by updatedAt DESC (newest first)", async () => {
    const root = await seedTask(tc, { title: "Root" });
    // Update root first so all children are created after
    await new Promise((r) => setTimeout(r, 5));
    const older = await seedTask(tc, { title: "Older child", parent_task_id: root });
    await new Promise((r) => setTimeout(r, 5));
    const newer = await seedTask(tc, { title: "Newer child", parent_task_id: root });

    const tool = treeTasksTool(tc);
    const result = await tool.execute({ depth: 1 }, { session_id: "s1" });

    const data = JSON.parse(result.output as string);
    const children = data.nodes[0].children;
    expect(children[0].id).toBe(newer);
    expect(children[1].id).toBe(older);
  });

  it("should promote orphan tasks (parent_task_id points outside input set) to root", async () => {
    // Create a task with parent_task_id pointing to a non-existent id.
    // The store allows this; the tree builder must surface it as a root
    // (orphan) rather than dropping it silently.
    const orphan = await seedTask(tc, { title: "Orphan", parent_task_id: 888888 });
    const tool = treeTasksTool(tc);
    const result = await tool.execute({ depth: 0 }, { session_id: "s1" });

    const data = JSON.parse(result.output as string);
    expect(data.nodes).toHaveLength(1);
    expect(data.nodes[0].id).toBe(orphan);
  });

  it("each TaskNode should include id, title, status, type, priority, progress, children", async () => {
    const root = await seedTask(tc, { title: "Root" });
    const tool = treeTasksTool(tc);
    const result = await tool.execute({ depth: 0 }, { session_id: "s1" });

    const node = JSON.parse(result.output as string).nodes[0];
    expect(node).toEqual(
      expect.objectContaining({
        id: expect.any(Number),
        title: expect.any(String),
        status: expect.any(String),
        type: expect.any(String),
        priority: expect.any(String),
        progress: expect.any(Number),
        children: expect.any(Array),
      })
    );
    expect(node.id).toBe(root);
  });

  it("should be exposed via task_create tool creation flow (integration sanity)", async () => {
    // Sanity: tree tool is callable on a TaskComponent that already has
    // tasks created via createTaskTool (the typical real-world flow).
    const createTool = createTaskTool(tc);
    const rootRes = await createTool.execute(
      { title: "Root via tool", project_path: "unknown", context: "{}" },
      { session_id: "s1" }
    );
    expect(rootRes.success).toBe(true);
    const rootId = rootRes.metadata?.task_id as number;

    await createTool.execute(
      { parent_task_id: rootId, title: "Child via tool", project_path: "unknown", context: "{}" },
      { session_id: "s1" }
    );

    const treeTool = treeTasksTool(tc);
    const treeRes = await treeTool.execute({ depth: -1 }, { session_id: "s1" });
    const data = JSON.parse(treeRes.output as string);

    expect(data.total).toBe(2);
    expect(data.nodes[0].id).toBe(rootId);
    expect(data.nodes[0].children).toHaveLength(1);
  });
});