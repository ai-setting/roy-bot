/**
 * @fileoverview Tests for task-graph pure functions (TDD for Task #1943)
 *
 * `buildTaskTree` + `renderTaskTree` handle:
 *  - empty input
 *  - roots (parent_task_id === null/undefined)
 *  - children attached to correct parent
 *  - orphans (parent_task_id points to missing task)
 *  - sort order: children and roots sorted by updatedAt DESC (matches tree.ts)
 *  - render: header line, indentation, branch chars (├─/└─/│)
 *  - maxDepth option: caps rendered depth; `< 0` is treated as "no limit"
 *
 * `formatTaskLabel` always emits `#id` and progress (when > 0); there are no
 * showId/showProgress toggles in `RenderTaskTreeOptions`.
 *
 * Functions are pure (no I/O) so they can be unit-tested in isolation.
 */

import { describe, it, expect, mock } from "bun:test";
import {
  buildTaskTree,
  renderTaskTree,
  formatTaskLabel,
  colorByStatus,
  expandParentChain,
} from "./task-graph";
import type { Task, TaskComponent } from "@ai-setting/roy-bot-core";

function mkTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: "Sample Task",
    description: "",
    status: "todo",
    priority: "medium",
    type: "normal",
    progress: 0,
    current_status: "",
    goals_and_expected_deliverables: "",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    project_path: "unknown",
    context: "{}",
    ...overrides,
  };
}

describe("buildTaskTree", () => {
  it("returns empty array for empty input", () => {
    expect(buildTaskTree([])).toEqual([]);
  });

  it("treats a single task with no parent_task_id as a root", () => {
    const t = mkTask({ id: 1 });
    const roots = buildTaskTree([t]);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.task.id).toBe(1);
    expect(roots[0]!.children).toEqual([]);
  });

  it("treats parent_task_id === null as a root", () => {
    // Cast: in practice the DB may store null even though the type says
    // `number | undefined`. The original tree.ts also handles null.
    const t = mkTask({ id: 1, parent_task_id: null as unknown as number });
    const roots = buildTaskTree([t]);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.task.id).toBe(1);
  });

  it("treats parent_task_id === undefined as a root (legacy data)", () => {
    const t = mkTask({ id: 1, parent_task_id: undefined });
    const roots = buildTaskTree([t]);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.task.id).toBe(1);
  });

  it("groups child tasks under their parent", () => {
    const p = mkTask({ id: 1 });
    const c1 = mkTask({ id: 2, parent_task_id: 1 });
    const c2 = mkTask({ id: 3, parent_task_id: 1 });
    const g = mkTask({ id: 4, parent_task_id: 2 });

    const roots = buildTaskTree([p, c1, c2, g]);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.task.id).toBe(1);
    expect(roots[0]!.children.map((c) => c.task.id).sort()).toEqual([2, 3]);
    const c1Node = roots[0]!.children.find((c) => c.task.id === 2)!;
    expect(c1Node.children.map((c) => c.task.id)).toEqual([4]);
  });

  it("handles multiple independent roots", () => {
    const a = mkTask({ id: 1 });
    const b = mkTask({ id: 2 });
    const c1 = mkTask({ id: 3, parent_task_id: 1 });

    const roots = buildTaskTree([a, b, c1]);
    expect(roots.map((n) => n.task.id).sort()).toEqual([1, 2]);
  });

  it("promotes orphan tasks (parent not in input) to root level", () => {
    const orphan = mkTask({ id: 5, parent_task_id: 999 });
    const roots = buildTaskTree([orphan]);
    // The orphan has no parent in input, so it should appear as a root.
    expect(roots).toHaveLength(1);
    expect(roots[0]!.task.id).toBe(5);
  });

  it("sorts children within a parent by updatedAt DESC (newest first)", () => {
    const p = mkTask({ id: 1, updatedAt: "2025-01-01T00:00:00Z" });
    const c1 = mkTask({ id: 2, parent_task_id: 1, updatedAt: "2025-01-01T00:00:00Z" });
    const c2 = mkTask({ id: 3, parent_task_id: 1, updatedAt: "2025-01-02T00:00:00Z" });
    const c3 = mkTask({ id: 4, parent_task_id: 1, updatedAt: "2024-12-31T00:00:00Z" });

    const roots = buildTaskTree([p, c1, c2, c3]);
    expect(roots[0]!.children.map((c) => c.task.id)).toEqual([3, 2, 4]);
  });

  it("sorts roots by updatedAt DESC (newest first)", () => {
    const a = mkTask({ id: 1, updatedAt: "2025-01-01T00:00:00Z" });
    const b = mkTask({ id: 2, updatedAt: "2025-01-05T00:00:00Z" });
    const c = mkTask({ id: 3, updatedAt: "2025-01-03T00:00:00Z" });

    const roots = buildTaskTree([a, b, c]);
    expect(roots.map((n) => n.task.id)).toEqual([2, 3, 1]);
  });

  it("handles deep nesting (3+ levels)", () => {
    const a = mkTask({ id: 1 });
    const b = mkTask({ id: 2, parent_task_id: 1 });
    const c = mkTask({ id: 3, parent_task_id: 2 });
    const d = mkTask({ id: 4, parent_task_id: 3 });

    const roots = buildTaskTree([a, b, c, d]);
    expect(roots).toHaveLength(1);
    let cur = roots[0]!;
    expect(cur.task.id).toBe(1);
    cur = cur.children[0]!;
    expect(cur.task.id).toBe(2);
    cur = cur.children[0]!;
    expect(cur.task.id).toBe(3);
    cur = cur.children[0]!;
    expect(cur.task.id).toBe(4);
    expect(cur.children).toEqual([]);
  });
});

describe("renderTaskTree", () => {
  it("returns 'No tasks to display.' for empty input", () => {
    expect(renderTaskTree([])).toBe("No tasks to display.");
  });

  it("renders a header line with task count and root count", () => {
    const t1 = mkTask({ id: 1 });
    const t2 = mkTask({ id: 2 });
    const out = renderTaskTree(buildTaskTree([t1, t2]));
    expect(out).toContain("Task Tree");
    expect(out).toContain("2 tasks");
    expect(out).toContain("2 roots");
  });

  it("renders root task with #id and title", () => {
    const t = mkTask({ id: 42, title: "Hello World" });
    const out = renderTaskTree(buildTaskTree([t]));
    expect(out).toContain("#42");
    expect(out).toContain("Hello World");
  });

  it("renders child tasks indented under parent", () => {
    const p = mkTask({ id: 1, title: "Parent" });
    const c = mkTask({ id: 2, parent_task_id: 1, title: "Child" });

    const out = renderTaskTree(buildTaskTree([p, c]));
    const lines = out.split("\n");
    // The child line should have indentation + branch char.
    const childLine = lines.find((l) => l.includes("#2"))!;
    expect(childLine).toMatch(/[├└]─/);
  });

  it("uses ├─ for non-last child and └─ for last child", () => {
    // Use explicit updatedAt so the order is deterministic: c1 first, c2 last.
    const p = mkTask({ id: 1, updatedAt: "2025-01-01T00:00:00Z" });
    const c1 = mkTask({ id: 2, parent_task_id: 1, updatedAt: "2025-01-02T00:00:00Z" });
    const c2 = mkTask({ id: 3, parent_task_id: 1, updatedAt: "2025-01-01T00:00:00Z" });

    const out = renderTaskTree(buildTaskTree([p, c1, c2]));
    const lines = out.split("\n");
    // c1 is non-last → ├─
    const c1Line = lines.find((l) => l.includes("#2"))!;
    expect(c1Line).toContain("├─");
    // c2 is last → └─
    const c2Line = lines.find((l) => l.includes("#3"))!;
    expect(c2Line).toContain("└─");
  });

  it("uses │ for non-last sibling's subtree continuation", () => {
    // c1 (non-last under p) → its subtree uses │ prefix.
    // c2 (last under p) → its subtree uses empty prefix.
    const p = mkTask({ id: 1, updatedAt: "2025-01-01T00:00:00Z" });
    const c1 = mkTask({ id: 2, parent_task_id: 1, updatedAt: "2025-01-02T00:00:00Z" });
    const g1 = mkTask({ id: 4, parent_task_id: 2 });
    const c2 = mkTask({ id: 3, parent_task_id: 1, updatedAt: "2025-01-01T00:00:00Z" });

    const out = renderTaskTree(buildTaskTree([p, c1, g1, c2]));
    const lines = out.split("\n");
    // g1 is the only child of c1, so the prefix under c1 is `│  ` (from c1's
    // non-last position), and g1 itself is rendered as `└─ `.
    const g1Line = lines.find((l) => l.includes("#4"))!;
    expect(g1Line).toContain("│");
    expect(g1Line).toContain("└─");
  });

  it("includes the task type in the label when type is set", () => {
    const t = mkTask({ id: 1, type: "cycle" });
    const out = renderTaskTree(buildTaskTree([t]));
    expect(out).toContain("[cycle]");
  });

  it("includes the progress percentage when progress > 0", () => {
    const t = mkTask({ id: 1, progress: 50 });
    const out = renderTaskTree(buildTaskTree([t]));
    expect(out).toContain("(50%)");
  });

  it("does NOT include progress when progress === 0", () => {
    const t = mkTask({ id: 1, progress: 0 });
    const out = renderTaskTree(buildTaskTree([t]));
    expect(out).not.toContain("(0%)");
  });

  it("includes the status in the label", () => {
    const t = mkTask({ id: 1, status: "active" });
    const out = renderTaskTree(buildTaskTree([t]));
    expect(out).toContain("active");
  });

  it("respects maxDepth option (depth=0 shows only roots)", () => {
    const p = mkTask({ id: 1, title: "P" });
    const c = mkTask({ id: 2, parent_task_id: 1, title: "C" });
    const g = mkTask({ id: 3, parent_task_id: 2, title: "G" });

    const out = renderTaskTree(buildTaskTree([p, c, g]), { maxDepth: 0 });
    expect(out).toContain("P");
    expect(out).not.toContain("C");
    expect(out).not.toContain("G");
  });

  it("respects maxDepth option (depth=1 shows roots + 1 level)", () => {
    const p = mkTask({ id: 1, title: "P" });
    const c = mkTask({ id: 2, parent_task_id: 1, title: "C" });
    const g = mkTask({ id: 3, parent_task_id: 2, title: "G" });

    const out = renderTaskTree(buildTaskTree([p, c, g]), { maxDepth: 1 });
    expect(out).toContain("P");
    expect(out).toContain("C");
    expect(out).not.toContain("G");
  });

  it("treats negative maxDepth as undefined (renders all levels)", () => {
    // Regression test for Task #1943 code review: `tasks list --depth -1 --graph`
    // used to print only the header with 0 task lines because the recursive
    // guard `currentDepth > maxDepth` evaluated `0 > -1 === true` and bailed
    // before rendering the root. Negative maxDepth now means "no limit",
    // matching `--depth -1` semantics in list.ts ("-1 或忽略=全部").
    const p = mkTask({ id: 1, title: "P" });
    const c = mkTask({ id: 2, parent_task_id: 1, title: "C" });
    const g = mkTask({ id: 3, parent_task_id: 2, title: "G" });

    const out = renderTaskTree(buildTaskTree([p, c, g]), { maxDepth: -1 });
    expect(out).toContain("P");
    expect(out).toContain("C");
    expect(out).toContain("G");
  });

  it("annotation: includes '— subtree of #N' when rootId is provided", () => {
    const p = mkTask({ id: 1 });
    const c = mkTask({ id: 2, parent_task_id: 1 });

    const out = renderTaskTree(buildTaskTree([p, c]), { rootId: 1 });
    expect(out).toContain("subtree of #1");
  });
});

describe("formatTaskLabel", () => {
  it("includes id (#N), title, status", () => {
    const t = mkTask({ id: 7, title: "T", status: "active" });
    const label = formatTaskLabel(t);
    expect(label).toContain("#7");
    expect(label).toContain("T");
    expect(label).toContain("active");
  });

  it("appends type label only when type is non-normal", () => {
    const tNormal = mkTask({ id: 1, type: "normal" });
    const tCycle = mkTask({ id: 2, type: "cycle" });
    const tLongterm = mkTask({ id: 3, type: "longterm" });
    expect(formatTaskLabel(tNormal)).not.toContain("[normal]");
    expect(formatTaskLabel(tCycle)).toContain("[cycle]");
    expect(formatTaskLabel(tLongterm)).toContain("[longterm]");
  });

  it("appends progress only when > 0", () => {
    expect(formatTaskLabel(mkTask({ progress: 0 }))).not.toContain("(0%)");
    expect(formatTaskLabel(mkTask({ progress: 25 }))).toContain("(25%)");
  });
});

describe("colorByStatus", () => {
  it("returns a function for known statuses", () => {
    expect(typeof colorByStatus("completed")).toBe("function");
    expect(typeof colorByStatus("active")).toBe("function");
    expect(typeof colorByStatus("paused")).toBe("function");
    expect(typeof colorByStatus("cancelled")).toBe("function");
    expect(typeof colorByStatus("todo")).toBe("function");
    expect(typeof colorByStatus("unknown")).toBe("function");
  });
});

// ============================================================================
// expandParentChain (Task #1951)
//
// Used by `tasks list --graph` so the tree stays complete even when the
// `--limit/--offset` window excludes the ancestors themselves.
// Without this, `buildTaskTree` would treat those children as orphans
// (promoted to root) and the tree would appear flat.
//
// Test scope: pure async function over a mocked TaskComponent (no fs, no
// chalk dep, no console output — verifiable in isolation).
// ============================================================================

describe("expandParentChain", () => {
  it("returns an empty array for empty input", async () => {
    const fake = { getTask: mock(async () => undefined) } as unknown as TaskComponent;
    const out = await expandParentChain(fake, []);
    expect(out).toEqual([]);
    // No fetches on empty input.
    expect((fake.getTask as any).mock.calls.length).toBe(0);
  });

  it("returns the original array (no fetches) when no task has a parent_task_id", async () => {
    const t1 = mkTask({ id: 1 });
    const t2 = mkTask({ id: 2 });
    const fake = { getTask: mock(async () => undefined) } as unknown as TaskComponent;
    const out = await expandParentChain(fake, [t1, t2]);
    expect(out).toHaveLength(2);
    expect(out.map((t) => t.id)).toEqual([1, 2]);
    expect((fake.getTask as any).mock.calls.length).toBe(0);
  });

  it("returns the original array when every parent_task_id resolves locally (no fetches needed)", async () => {
    // parent=1 is in the list, so no expansion needed.
    const p = mkTask({ id: 1, title: "Parent" });
    const c = mkTask({ id: 2, title: "Child", parent_task_id: 1 });
    const fake = { getTask: mock(async () => undefined) } as unknown as TaskComponent;
    const out = await expandParentChain(fake, [p, c]);
    expect(out.map((t) => t.id).sort()).toEqual([1, 2]);
    expect((fake.getTask as any).mock.calls.length).toBe(0);
  });

  it("fetches exactly one missing parent when one child points outside the list (calls getTask 1x)", async () => {
    const parent = mkTask({ id: 100, title: "Outside Parent" });
    const child = mkTask({ id: 2, title: "Child", parent_task_id: 100 });
    const fake = {
      getTask: mock(async (id: number) => (id === 100 ? parent : undefined)),
    } as unknown as TaskComponent;
    const out = await expandParentChain(fake, [child]);
    expect(out.map((t) => t.id).sort((a, b) => a - b)).toEqual([2, 100]);
    expect((fake.getTask as any).mock.calls.length).toBe(1);
    expect((fake.getTask as any).mock.calls[0]).toEqual([100]);
  });

  it("chains multi-level missing ancestors via repeated getTask calls", async () => {
    // Seed list contains c (parent=10) — only c is visible. We need to fetch
    // 10, then 10's parent (1), and verify both are added.
    const grand = mkTask({ id: 1, title: "Grand" });
    const parent = mkTask({ id: 10, title: "Parent", parent_task_id: 1 });
    const child = mkTask({ id: 100, title: "Child", parent_task_id: 10 });
    const fake = {
      getTask: mock(async (id: number) => {
        if (id === 10) return parent;
        if (id === 1) return grand;
        return undefined;
      }),
    } as unknown as TaskComponent;

    const out = await expandParentChain(fake, [child]);
    expect(out.map((t) => t.id).sort((a, b) => a - b)).toEqual([1, 10, 100]);
    // Should have called getTask for 10 (the child's missing parent)
    // then 1 (the parent's missing parent).
    expect((fake.getTask as any).mock.calls.length).toBe(2);
    expect((fake.getTask as any).mock.calls[0]).toEqual([10]);
    expect((fake.getTask as any).mock.calls[1]).toEqual([1]);
  });

  it("cycles safely (A.parent=B, B.parent=A) — does not infinite loop", async () => {
    const a = mkTask({ id: 1, title: "A", parent_task_id: 2 });
    const b = mkTask({ id: 2, title: "B", parent_task_id: 1 });
    const fake = {
      getTask: mock(async (id: number) => (id === 2 ? b : id === 1 ? a : undefined)),
    } as unknown as TaskComponent;
    // Should resolve quickly (cycle protection via visited Set).
    const out = await expandParentChain(fake, [a]); // a's parent (2) will fetch
    // We started with [a]; the chain brings in [b] (id=2). b's parent is 1
    // which is already in the map, so BFS stops.
    expect(out.map((t) => t.id).sort((a2, b2) => a2 - b2)).toEqual([1, 2]);
    // Should be at most 2 calls: one for the seed missing parent (2),
    // and at most one extra if the next parent is still missing — here
    // it's already known, so exactly 1 fetch.
    expect((fake.getTask as any).mock.calls.length).toBe(1);
  });

  it("does not refetch a parent already present locally (dedup)", async () => {
    const parent = mkTask({ id: 1, title: "Local Parent" });
    const c1 = mkTask({ id: 2, parent_task_id: 1 });
    const c2 = mkTask({ id: 3, parent_task_id: 1 });
    const c3 = mkTask({ id: 4, parent_task_id: 1 });
    const fake = { getTask: mock(async () => undefined) } as unknown as TaskComponent;
    const out = await expandParentChain(fake, [parent, c1, c2, c3]);
    expect(out.map((t) => t.id).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect((fake.getTask as any).mock.calls.length).toBe(0);
  });

  it("treats parent_task_id === null/undefined as no parent (no fetch)", async () => {
    const t1 = mkTask({ id: 1, parent_task_id: undefined });
    const t2 = mkTask({ id: 2, parent_task_id: null as unknown as number });
    const fake = { getTask: mock(async () => undefined) } as unknown as TaskComponent;
    const out = await expandParentChain(fake, [t1, t2]);
    expect(out).toHaveLength(2);
    expect((fake.getTask as any).mock.calls.length).toBe(0);
  });

  it("skips silently when getTask returns null/undefined for a missing parent", async () => {
    // child points at parent id=999 which doesn't exist in the store.
    // We should NOT throw and we should still return the original child.
    const child = mkTask({ id: 5, parent_task_id: 999 });
    const fake = {
      getTask: mock(async () => undefined),
    } as unknown as TaskComponent;
    const out = await expandParentChain(fake, [child]);
    expect(out.map((t) => t.id)).toEqual([5]);
    expect((fake.getTask as any).mock.calls.length).toBe(1);
  });
});
