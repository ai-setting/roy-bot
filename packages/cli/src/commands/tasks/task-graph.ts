/**
 * @fileoverview Task Graph — pure functions for hierarchical task display
 *
 * Provides two pure functions used by:
 *  - `tasks list --graph`  (new — added in Task #1943)
 *  - `tasks tree`          (refactored to reuse this module)
 *
 * The functions are pure (no I/O, no console) so they can be unit-tested
 * in isolation. This mirrors the `session-graph.ts` pattern.
 *
 *  - `buildTaskTree(tasks)` walks the `parent_task_id` links in a flat list
 *    of tasks and returns a forest of roots (orphan tasks are promoted to
 *    root level).
 *  - `renderTaskTree(built, options)` formats the forest as an ASCII tree.
 *
 * Sort order (mirrors `tasks/tree.ts`): roots and children are sorted by
 * `updatedAt` DESC so the most-recently-changed tasks surface first.
 */

import chalk from "chalk";
import type { Task, TaskComponent } from "@ai-setting/roy-bot-core";

// ============================================================================
// Types
// ============================================================================

/** A node in the built tree, holding a task and its children. */
export interface TaskNode {
  task: Task;
  children: TaskNode[];
}

/** Options controlling how the tree is rendered. */
export interface RenderTaskTreeOptions {
  /**
   * Maximum depth to render.
   *  - `0`             → render only roots (no children).
   *  - `>= 1`          → render roots + that many levels of children
   *                     (e.g. `1` = roots + their direct children).
   *  - `< 0` or unset  → render every level (no cap).
   *
   * Negative values are normalized to "no limit" at the top of
   * {@link renderTaskTree}, which makes `--depth -1` in `tasks list`
   * behave consistently with its documented semantics
   * ("-1 或忽略=全部").
   */
  maxDepth?: number;

  /**
   * When the tree is a subtree of a specific root (set by
   * `tasks tree --root-id`), this appends "— subtree of #N" to the header.
   */
  rootId?: number;
}

// ============================================================================
// buildTaskTree
// ============================================================================

/**
 * Build a forest from a flat list of tasks.
 *
 * Rules (mirrors `tasks/tree.ts`):
 *  - A task with `parent_task_id` undefined/null is a ROOT.
 *  - A task whose `parent_task_id` points to a task NOT in the input
 *    is promoted to ROOT (orphan) — same as legacy `tree.ts` behavior.
 *  - Roots and each level of children are sorted by `updatedAt` DESC.
 *
 * @param tasks Flat list of tasks (no requirement for parents to come
 *              before children).
 */
export function buildTaskTree(tasks: Task[]): TaskNode[] {
  const nodeById = new Map<number, TaskNode>();
  const byParent = new Map<number, Task[]>();
  const roots: Task[] = [];

  // 1) Node map: every task gets a node; children array is built later.
  for (const t of tasks) {
    nodeById.set(t.id, { task: t, children: [] });
  }

  // 2) Parent-child linking. A task with no resolvable parent becomes a root.
  for (const t of tasks) {
    const pid = t.parent_task_id;
    if (pid !== undefined && pid !== null && nodeById.has(pid)) {
      const list = byParent.get(pid) || [];
      list.push(t);
      byParent.set(pid, list);
    } else {
      roots.push(t);
    }
  }

  // 3) Sort children within each parent (updatedAt DESC, id DESC tie-breaker)
  // and attach. The id tie-breaker keeps the sort deterministic when two
  // siblings share the same updatedAt (e.g. tasks created in the same tick).
  for (const [parentId, children] of byParent.entries()) {
    const parentNode = nodeById.get(parentId)!;
    children.sort(compareTasksDesc);
    parentNode.children = children.map((c) => nodeById.get(c.id)!);
  }

  // 4) Sort roots (updatedAt DESC, id DESC tie-breaker) and return.
  roots.sort(compareTasksDesc);
  return roots.map((r) => nodeById.get(r.id)!);
}

/**
 * Sort comparator: primary key `updatedAt` DESC, tie-breaker `id` DESC.
 * Tasks with equal updatedAt are ordered by id (newest/most recently
 * registered first), which is a stable, deterministic order.
 */
function compareTasksDesc(a: Task, b: Task): number {
  if (a.updatedAt < b.updatedAt) return 1;
  if (a.updatedAt > b.updatedAt) return -1;
  if (a.id < b.id) return 1;
  if (a.id > b.id) return -1;
  return 0;
}

// ============================================================================
// expandParentChain (Task #1951)
//
// `tasks list --limit N --graph` only returns N tasks. If a returned task
// points to a parent that is OUTSIDE that --limit window, `buildTaskTree`
// will promote the child to root (orphan), and the tree loses its
// hierarchy.
//
// `expandParentChain` fixes this by BFS-fetching any missing ancestors
// referenced via `parent_task_id`. It returns a new array: the original
// tasks PLUS the newly fetched ancestors, suitable for handing to
// `buildTaskTree` to produce a complete tree.
//
// Cycle protection: a `visited: Set<number>` ensures we never re-fetch
// an ancestor we've already pulled (and never infinite-loop on data
// that has a cycle like A→B→A).
// ============================================================================

/**
 * Expand a flat task list by fetching any missing ancestors referenced
 * via `parent_task_id`. Returns a new array containing the original
 * tasks PLUS any newly fetched ancestors.
 *
 * The BFS starts from the seed `tasks` and walks the `parent_task_id`
 * pointers in increasing-distance order. If an ancestor's grandparent is
 * still missing, that one is fetched next, and so on — until the chain
 * either resolves to a root, an already-known task, or to a parent that
 * does not exist in the store (in which case `getTask` returns null/undefined
 * and we skip silently).
 *
 * The returned array order is "original tasks first (in original input
 * order), then any newly fetched ancestors appended". This is *not* used
 * for sorting or display — `buildTaskTree` handles ordering.
 *
 * Side effects: calls `taskComponent.getTask(id)` at most N times, where
 * N is the number of distinct missing ancestors reachable from the
 * input via the `parent_task_id` chain.
 *
 * @param taskComponent The TaskComponent instance to fetch parents from.
 * @param tasks         Flat list of tasks to expand.
 * @returns             New array: input tasks ∪ fetched ancestors.
 */
export async function expandParentChain(
  taskComponent: TaskComponent,
  tasks: Task[]
): Promise<Task[]> {
  // 1) Build a working map keyed by id. We mutate the Map through the
  //    BFS but produce a fresh array at the end so we never alter the
  //    caller's reference.
  const taskById = new Map<number, Task>();
  for (const t of tasks) taskById.set(t.id, t);

  // 2) Seed queue with parent ids that are MISSING from the seed list.
  //    `visited` doubles as both a "do not re-enqueue" guard AND the
  //    cycle-breaker: if A→B→A appears, the second time we see A it's
  //    already in `visited` so it won't be pushed again.
  const queue: number[] = [];
  const visited = new Set<number>();

  for (const t of tasks) {
    const pid = t.parent_task_id;
    if (
      pid !== undefined &&
      pid !== null &&
      !taskById.has(pid) &&
      !visited.has(pid)
    ) {
      queue.push(pid);
      visited.add(pid);
    }
  }

  // 3) BFS fetch. For each queued id, ask the store for the task. If the
  //    store returns null/undefined (parent deleted, bad data), skip
  //    silently — don't crash the user's tree view. Newly fetched tasks
  //    that themselves have a parent we don't know yet get enqueued.
  while (queue.length > 0) {
    const id = queue.shift()!;
    const parent = await taskComponent.getTask(id);
    if (!parent) continue; // parent was deleted or never existed
    taskById.set(parent.id, parent);
    const ppid = parent.parent_task_id;
    if (
      ppid !== undefined &&
      ppid !== null &&
      !taskById.has(ppid) &&
      !visited.has(ppid)
    ) {
      queue.push(ppid);
      visited.add(ppid);
    }
  }

  // 4) Return values. We seed the result with the ORIGINAL input order so
  //    that any consumer that relied on input order sees the same first
  //    N tasks in the same positions; newly fetched ancestors follow.
  const orderedIds: number[] = [];
  for (const t of tasks) {
    if (!orderedIds.includes(t.id)) orderedIds.push(t.id);
  }
  for (const id of taskById.keys()) {
    if (!orderedIds.includes(id)) orderedIds.push(id);
  }
  return orderedIds.map((id) => taskById.get(id)!);
}

// ============================================================================
// renderTaskTree
// ============================================================================

const TASK_TREE_BRANCH = "├─ ";
const TASK_TREE_LAST = "└─ ";
const TASK_TREE_VERTICAL = "│  ";
const TASK_TREE_EMPTY = "   ";

/**
 * Render a built forest as an ASCII tree.
 *
 * Returns a multi-line string. The first line is the header
 *   `Task Tree (N tasks, M roots)`
 * followed by a blank line, then each node on its own line.
 *
 * Empty input returns "No tasks to display." (no header).
 *
 * `maxDepth` semantics (see {@link RenderTaskTreeOptions}):
 *  - `0`             → render only roots (no children).
 *  - `>= 1`          → render roots + that many levels of children.
 *  - `< 0` or unset  → render every level (no cap).
 */
export function renderTaskTree(
  roots: TaskNode[],
  options: RenderTaskTreeOptions = {}
): string {
  if (roots.length === 0) {
    return "No tasks to display.";
  }

  // Treat negative maxDepth as "no limit" — `tasks list --depth -1` is the
  // CLI way to say "all" (matches the `--depth -1 或忽略=全部` semantics
  // documented in list.ts). Without this normalization, the recursive
  // guard `currentDepth > maxDepth` evaluates `0 > -1 === true` and bails
  // before rendering the root, leaving the user staring at a header
  // with no task lines beneath it.
  const maxDepth = options.maxDepth !== undefined && options.maxDepth < 0
    ? undefined
    : options.maxDepth;

  // Count total tasks in the forest.
  const totalCount = countDeep(roots);
  const headerSuffix = options.rootId !== undefined
    ? chalk.gray(` — subtree of #${options.rootId}`)
    : "";

  const lines: string[] = [
    chalk.bold(`Task Tree (${totalCount} tasks, ${roots.length} roots)`) + headerSuffix,
    "",
  ];

  for (let i = 0; i < roots.length; i++) {
    const isLast = i === roots.length - 1;
    renderNode(roots[i]!, "", true, isLast, lines, 0, maxDepth);
  }

  return lines.join("\n");
}

function renderNode(
  node: TaskNode,
  prefix: string,
  isRoot: boolean,
  isLast: boolean,
  lines: string[],
  currentDepth: number,
  maxDepth: number | undefined
): void {
  // maxDepth check: at the root level currentDepth === 0; we only check
  // before recursing INTO children, so roots are always rendered.
  // `maxDepth` has already been normalized in `renderTaskTree` so that
  // negative values are treated as "no limit" (=== undefined here).
  if (maxDepth !== undefined && currentDepth > maxDepth) {
    return;
  }

  const connector = isRoot
    ? ""
    : isLast
      ? TASK_TREE_LAST
      : TASK_TREE_BRANCH;
  const statusColor = colorByStatus(node.task.status);
  const label = statusColor(formatTaskLabel(node.task));
  lines.push(prefix + connector + label);

  if (node.children.length > 0) {
    const childPrefix = isRoot
      ? prefix
      : prefix + (isLast ? TASK_TREE_EMPTY : TASK_TREE_VERTICAL);
    for (let i = 0; i < node.children.length; i++) {
      const isChildLast = i === node.children.length - 1;
      renderNode(
        node.children[i]!,
        childPrefix,
        false,
        isChildLast,
        lines,
        currentDepth + 1,
        maxDepth
      );
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function countDeep(roots: TaskNode[]): number {
  let count = 0;
  function walk(n: TaskNode) {
    count++;
    for (const c of n.children) walk(c);
  }
  for (const r of roots) walk(r);
  return count;
}

/**
 * Format a single task's display label (no color, no branch char).
 *   `#<id> [type] <title> [status] (progress%)`
 * Type and progress are omitted when not meaningful.
 */
export function formatTaskLabel(task: Task): string {
  const idStr = `#${task.id}`;
  const typeLabel = task.type && task.type !== "normal" ? ` [${task.type}]` : "";
  const progressLabel = task.progress > 0 ? ` (${task.progress}%)` : "";
  return `${idStr}${typeLabel} ${task.title} ${chalk.gray("[" + task.status + "]")}${progressLabel}`;
}

/**
 * Map a task status to a chalk color function.
 * Mirrors the helper in `tasks/tree.ts` (extracted here for reuse).
 */
export function colorByStatus(status: string): (s: string) => string {
  switch (status) {
    case "completed":
      return chalk.green;
    case "active":
      return chalk.blue;
    // ★ Task #5073 — 待验证（两阶段验收的中间态）：青色可辨识
    case "to_validate":
      return chalk.cyan;
    case "paused":
      return chalk.yellow;
    case "cancelled":
      return chalk.strikethrough;
    default:
      return chalk.gray;
  }
}
