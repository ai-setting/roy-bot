/**
 * @fileoverview TaskCreationRegistry — Subtree summary + project context
 *                 tests (Task #2395 enhancement).
 *
 * Covers:
 *  - getSubtreeSummary(parentId) → { descendantCount, activeCount, completedCount, maxDepth }
 *  - record() captures project_path + parsed project context (branch/worktree)
 *  - sortedByActiveChildFirst: completed parent + active child ranks higher
 *  - excludeSelfOrDescendant filter
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { TaskCreationRegistry } from "./task-creation-registry";
import type { Task } from "./types";

function makeTask(overrides: Partial<Task> & { id: number }): Task {
  return {
    id: overrides.id,
    title: overrides.title ?? `Task #${overrides.id}`,
    description: overrides.description ?? "",
    status: overrides.status ?? "active",
    priority: overrides.priority ?? "medium",
    type: overrides.type ?? "normal",
    progress: overrides.progress ?? 0,
    current_status: overrides.current_status ?? "",
    goals_and_expected_deliverables:
      overrides.goals_and_expected_deliverables ?? "",
    parent_task_id: overrides.parent_task_id,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
    tags: overrides.tags ?? [],
    project_path: overrides.project_path ?? "/test/proj",
    context: overrides.context ?? '{"type":"feature"}',
  };
}

describe("TaskCreationRegistry — subtree summary (Task #2395)", () => {
  let registry: TaskCreationRegistry;
  beforeEach(() => {
    registry = new TaskCreationRegistry({ maxEntries: 100, ttlMs: 60_000 });
  });

  test("getSubtreeSummary returns zeros for parent with no children", () => {
    registry.record(makeTask({ id: 1 }), { subagentType: "roy" });
    const summary = registry.getSubtreeSummary(1);
    expect(summary).toEqual({
      descendantCount: 0,
      activeCount: 0,
      completedCount: 0,
      maxDepth: 0,
    });
  });

  test("getSubtreeSummary counts direct children and statuses", () => {
    registry.record(makeTask({ id: 1 }), { subagentType: "roy" });
    registry.record(makeTask({ id: 2, parent_task_id: 1, status: "active" }));
    registry.record(makeTask({ id: 3, parent_task_id: 1, status: "completed" }));
    registry.record(makeTask({ id: 4, parent_task_id: 1, status: "todo" }));
    const summary = registry.getSubtreeSummary(1);
    expect(summary.descendantCount).toBe(3);
    expect(summary.activeCount).toBe(1);
    expect(summary.completedCount).toBe(1);
    expect(summary.maxDepth).toBe(1);
  });

  test("getSubtreeSummary tracks multi-level depth", () => {
    registry.record(makeTask({ id: 1 }), { subagentType: "roy" });
    registry.record(makeTask({ id: 2, parent_task_id: 1, status: "active" }));
    registry.record(makeTask({ id: 3, parent_task_id: 2, status: "active" }));
    registry.record(makeTask({ id: 4, parent_task_id: 3, status: "completed" }));
    const summary = registry.getSubtreeSummary(1);
    expect(summary.descendantCount).toBe(3);
    expect(summary.maxDepth).toBe(3);
    expect(summary.activeCount).toBe(2);
    expect(summary.completedCount).toBe(1);
  });

  test("getSubtreeSummary returns null/zeros for unknown parent", () => {
    const summary = registry.getSubtreeSummary(999);
    expect(summary).toEqual({
      descendantCount: 0,
      activeCount: 0,
      completedCount: 0,
      maxDepth: 0,
    });
  });

  test("subtree summary excludes archived by default (matches recent() policy)", () => {
    registry.record(makeTask({ id: 1 }), { subagentType: "roy" });
    registry.record(
      makeTask({ id: 2, parent_task_id: 1, status: "archived" })
    );
    const summary = registry.getSubtreeSummary(1, { includeArchived: false });
    expect(summary.descendantCount).toBe(0);
    const includeArchived = registry.getSubtreeSummary(1, {
      includeArchived: true,
    });
    expect(includeArchived.descendantCount).toBe(1);
  });
});

describe("TaskCreationRegistry — project context capture", () => {
  let registry: TaskCreationRegistry;
  beforeEach(() => {
    registry = new TaskCreationRegistry({ maxEntries: 100, ttlMs: 60_000 });
  });

  test("record() captures project_path and parses branch/worktree from context", () => {
    const task = makeTask({
      id: 1,
      project_path: "/repo",
      context: JSON.stringify({
        worktree_path: "/repo/.worktrees/feat-x",
        branch: "feat/x",
        parent_branch: "main",
        type: "feature",
      }),
    });
    registry.record(task, { subagentType: "roy" });
    const rec = registry.getById(1)!;
    expect(rec.project_path).toBe("/repo");
    expect(rec.branch).toBe("feat/x");
    expect(rec.worktree_path).toBe("/repo/.worktrees/feat-x");
    expect(rec.parentBranch).toBe("main");
  });

  test("record() tolerates malformed context gracefully", () => {
    const task = makeTask({ id: 1, context: "not json" });
    registry.record(task, { subagentType: "roy" });
    const rec = registry.getById(1)!;
    expect(rec.branch).toBeUndefined();
    expect(rec.worktree_path).toBeUndefined();
  });

  test("record() does NOT expose prior_context.commit", () => {
    const task = makeTask({
      id: 1,
      context: JSON.stringify({
        branch: "feat/x",
        prior_context: { prev_task: 50, commit: "abc123def456" },
      }),
    });
    registry.record(task, { subagentType: "roy" });
    const rec = registry.getById(1)!;
    // commit is stripped — rec.context is now stripped object, but the
    // sanitized JSON string form must not contain the commit hash.
    const contextStr = JSON.stringify(rec.context ?? {});
    expect(contextStr).not.toContain("abc123def456");
    expect(contextStr).toContain("prev_task");
  });
});

describe("TaskCreationRegistry — recentChildrenFirst option", () => {
  let registry: TaskCreationRegistry;
  beforeEach(() => {
    registry = new TaskCreationRegistry({ maxEntries: 100, ttlMs: 60_000 });
  });

  test("completed parent with active child ranks higher than completed-only", async () => {
    registry.record(
      makeTask({ id: 1, status: "completed" }),
      { subagentType: "roy" }
    );
    await new Promise((r) => setTimeout(r, 5));
    // id=2 is an ACTIVE child of parent #1 — should boost #1 in the sort
    registry.record(
      makeTask({ id: 2, status: "active", parent_task_id: 1 }),
      { subagentType: "roy" }
    );
    await new Promise((r) => setTimeout(r, 5));
    // id=3 is a standalone completed task (no children) — no boost
    registry.record(makeTask({ id: 3, status: "completed" }), {
      subagentType: "roy",
    });

    // Without children-first: ordering is by updatedAt DESC
    const all = registry.recent({});
    expect(all.map((r) => r.taskId)).toEqual([3, 2, 1]);

    // With activeChildFirst: id=1 has active child id=2, so #1 is boosted
    // to the front (despite oldest updatedAt).
    const sorted = registry.recent({ activeChildFirst: true });
    expect(sorted[0].taskId).toBe(1);
  });

  test("without activeChildFirst option, ordering is unchanged", () => {
    registry.record(makeTask({ id: 1, status: "completed" }));
    registry.record(
      makeTask({ id: 2, status: "active", parent_task_id: 1 })
    );
    registry.record(makeTask({ id: 3, status: "completed" }));
    const all = registry.recent({});
    expect(all[0].taskId).toBe(3); // most recent
  });
});

describe("TaskCreationRegistry — excludeSelfOrDescendant", () => {
  let registry: TaskCreationRegistry;
  beforeEach(() => {
    registry = new TaskCreationRegistry({ maxEntries: 100, ttlMs: 60_000 });
  });

  test("excludeSelfOrDescendant filters out the given id and its subtree", () => {
    registry.record(makeTask({ id: 1 }));
    registry.record(makeTask({ id: 2, parent_task_id: 1 }));
    registry.record(makeTask({ id: 3, parent_task_id: 2 }));
    registry.record(makeTask({ id: 4 }));
    const result = registry.recent({ excludeSelfOrDescendant: 1 });
    const ids = result.map((r) => r.taskId);
    expect(ids).not.toContain(1);
    expect(ids).not.toContain(2);
    expect(ids).not.toContain(3);
    expect(ids).toContain(4);
  });
});