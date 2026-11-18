/**
 * @fileoverview Task Tree Tool
 *
 * Returns a hierarchical (forest) view of tasks. Used by callers to decide
 * where to mount a new task via `task_create(parent_task_id=...)`.
 *
 * This is the MCP-equivalent of the CLI command `roy-bot tasks tree`.
 *
 * Implementation notes:
 *  - Output is a JSON envelope (see {@link TreeTasksResult}) so the response
 *    matches the shape used by `task_list` (total / truncated / nodes).
 *  - `total` is intentionally the FIRST field in the JSON output so that
 *    tail-truncation by ToolComponent.truncateOutput cannot strip it.
 *  - `buildTaskNodes` is a pure function that converts a flat Task list to
 *    a forest of `TaskNode`. Orphan tasks (parent missing from input) are
 *    promoted to root level — matches the CLI `task-graph.ts` behavior.
 *  - Sibling order: `updatedAt` DESC, `id` DESC tie-breaker.
 */

import type { Tool, ToolContext, ToolResult } from "../../tool/types";
import { TreeTasksToolSchema, type TreeTasksToolParams } from "./task-types";
import type { TaskComponent } from "../task-component";
import type { Task } from "../types";

// ============================================================================
// Public Types (response shape)
// ============================================================================

/**
 * Lean node in the tree output. We deliberately exclude description,
 * goals_and_expected_deliverables, context, etc. to keep tree views compact.
 * Callers can fetch details via `task_get(task_id)` for any node.
 */
export interface TaskNode {
  id: number;
  title: string;
  status: Task["status"];
  type: Task["type"];
  priority: Task["priority"];
  progress: number;
  children: TaskNode[];
}

/**
 * Top-level response shape. `total` is FIRST for truncation safety.
 */
export interface TreeTasksResult {
  total: number;
  truncated: boolean;
  depth: number;
  parent_task_id: number | null;
  nodes: TaskNode[];
}

// ============================================================================
// Pure Helpers
// ============================================================================

/**
 * Sort comparator: primary key `updatedAt` DESC, tie-breaker `id` DESC.
 * Mirrors the ordering used by the CLI's `task-graph.ts` for stable,
 * deterministic output.
 */
function compareTasksDesc(a: Task, b: Task): number {
  if (a.updatedAt < b.updatedAt) return 1;
  if (a.updatedAt > b.updatedAt) return -1;
  if (a.id < b.id) return 1;
  if (a.id > b.id) return -1;
  return 0;
}

/**
 * Trim a tree to the given depth cap.
 *
 * Depth semantics (matches `task_list` / `task-graph.ts`):
 *  - `depth >= 0`: roots + `depth` levels of children.
 *      e.g. `depth=2` → root + 1 level + 2 levels = 3 levels rendered.
 *  - `depth < 0`:  no limit (return the full tree).
 *
 * Returns a NEW array of NEW node objects (no shared references).
 *
 * Implementation note: we must distinguish `depth === 0` ("render only
 * roots, no children") from `depth < 0` ("render everything"). If we
 * naively recurse with `depth - 1` from `0`, we end up calling
 * `trimToDepth(_, -1)` which keeps everything — wrong.
 */
function trimToDepth(nodes: TaskNode[], depth: number): TaskNode[] {
  if (depth < 0) return nodes;
  if (depth === 0) {
    // Render this level but DO NOT recurse into children.
    return nodes.map((n) => ({ ...n, children: [] }));
  }
  // depth >= 1: render this level + `depth - 1` more levels.
  return nodes.map((n) => ({
    ...n,
    children: trimToDepth(n.children, depth - 1),
  }));
}

/**
 * Count nodes (root + all descendants) in a forest.
 */
function countNodes(nodes: TaskNode[]): number {
  let n = 0;
  for (const node of nodes) n += 1 + countNodes(node.children);
  return n;
}

// ============================================================================
// buildTaskNodes
// ============================================================================

/**
 * Convert a flat list of tasks into a forest of `TaskNode`.
 *
 * Rules:
 *  - Task with no `parent_task_id` → root.
 *  - Task whose `parent_task_id` points to a task NOT in the input set
 *    (orphan) is promoted to root (mirrors CLI `task-graph.ts`).
 *  - Roots and each level of children are sorted by `updatedAt` DESC
 *    (id DESC tie-breaker).
 *
 * Pure: no I/O, no console. Easy to unit-test in isolation.
 */
export function buildTaskNodes(tasks: Task[]): TaskNode[] {
  const nodeById = new Map<number, TaskNode>();
  const byParent = new Map<number, Task[]>();
  const roots: Task[] = [];

  // 1) Build node map (every task becomes a TaskNode)
  for (const t of tasks) {
    nodeById.set(t.id, {
      id: t.id,
      title: t.title,
      status: t.status,
      type: t.type,
      priority: t.priority,
      progress: t.progress,
      children: [],
    });
  }

  // 2) Parent-child linking. Orphans become roots.
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

  // 3) Sort children and attach
  for (const [parentId, children] of byParent.entries()) {
    const parentNode = nodeById.get(parentId)!;
    children.sort(compareTasksDesc);
    parentNode.children = children.map((c) => nodeById.get(c.id)!);
  }

  // 4) Sort roots and return
  roots.sort(compareTasksDesc);
  return roots.map((r) => nodeById.get(r.id)!);
}

// ============================================================================
// Tool Factory
// ============================================================================

/**
 * Create the `task_tree` tool.
 *
 * Schema: see `TreeTasksToolSchema`.
 * Output: see {@link TreeTasksResult}.
 */
export function treeTasksTool(taskComponent: TaskComponent): Tool {
  return {
    name: "task_tree",
    description:
      "View the task tree (forest) with optional filters. " +
      "Use this BEFORE task_create to decide whether to create a root task " +
      "(omit parent_task_id) or attach to an existing parent. " +
      "depth: 0=只根任务, 1=根+一层子任务, 2=根+二层子任务 (default), " +
      "-1 or omitted as -1=无限层级. " +
      "Returns { total, truncated, depth, parent_task_id, nodes } where:\n" +
      "  - total: count of ALL tasks in the returned tree (incl. descendants)\n" +
      "  - truncated: always false for now (no pagination cap on tree)\n" +
      "  - depth: the resolved depth value\n" +
      "  - parent_task_id: the root's id, or null for forest mode\n" +
      "  - nodes: TaskNode[] with { id, title, status, type, priority, progress, children }\n" +
      "Note: `total` is the FIRST field in the response so it survives " +
      "tail-truncation by ToolComponent.truncateOutput.",
    parameters: TreeTasksToolSchema,
    execute: async (args: unknown, _ctx: ToolContext): Promise<ToolResult> => {
      const params = TreeTasksToolSchema.parse(args) as TreeTasksToolParams;

      try {
        let flat: Task[] = [];
        let parent_task_id: number | null = params.parent_task_id ?? null;

        if (params.parent_task_id !== undefined && params.parent_task_id !== null) {
          // ----- Subtree mode -----
          // Gracefully handle non-existent parent: empty forest, no error.
          const root = await taskComponent.getTask(params.parent_task_id);
          if (!root) {
            flat = [];
          } else {
            const descendants = await taskComponent.getTaskTree(
              params.parent_task_id,
              params.depth === -1 ? -1 : Math.max(0, params.depth - 1)
              // getTaskTree returns descendants WITHOUT the root, so we
              // subtract 1 from depth (the root itself counts as depth 0).
              // depth=-1 is preserved as-is (full subtree).
            );
            flat = [root, ...descendants];
          }
        } else {
          // ----- Forest mode -----
          // Fetch all tasks matching status/priority/type/include_archived.
          // We deliberately do NOT propagate `depth` to listTasks because:
          //  (a) listTasksByDepth hardcodes `parent_task_id IS NULL` at
          //      depth=0, which would drop legitimate orphans (tasks whose
          //      parent_task_id points to a missing parent). The whole
          //      point of the tree view is to surface those as roots via
          //      buildTaskNodes's orphan-promotion rule.
          //  (b) Depth here means "how deep to RENDER the tree", which is
          //      applied by trimToDepth() below — not "how to filter".
          // We pass include_archived directly; status/priority/type are
          // also pushed to listTasks so the data layer can short-circuit.
          const result = await taskComponent.listTasks({
            status: params.status,
            priority: params.priority,
            type: params.type,
            include_archived: params.include_archived,
            limit: 9999,
            offset: 0,
          });
          flat = result.tasks;
        }

        // Apply status/priority/type/include_archived filters in subtree
        // mode (in forest mode they were applied by listTasks above).
        // Note: status filters are OR-like for the *included* set but we
        // also want descendants that match to be included even if the
        // root doesn't match. For simplicity here, we filter the FLAT
        // list post-hoc; buildTaskNodes will keep ancestors of matched
        // descendants only if the ancestor itself is also in flat.
        // This matches the "filter at the data layer" contract of
        // task_list.
        if (params.parent_task_id !== undefined && params.parent_task_id !== null) {
          if (params.status) {
            flat = flat.filter((t) => t.status === params.status);
          }
          if (params.priority) {
            flat = flat.filter((t) => t.priority === params.priority);
          }
          if (params.type) {
            flat = flat.filter((t) => t.type === params.type);
          }
          // For include_archived: default false mirrors task_list.
          if (!params.include_archived) {
            flat = flat.filter((t) => t.status !== "archived");
          }
        }

        // Build forest, then trim to requested depth (forest mode only —
        // subtree mode already accounts for depth in getTaskTree call).
        let nodes = buildTaskNodes(flat);
        if (
          params.parent_task_id === undefined ||
          params.parent_task_id === null
        ) {
          // Forest mode: depth governs how deep we render.
          // depth=0 → only roots (no children); depth=-1 → no limit.
          nodes = trimToDepth(nodes, params.depth);
        }

        const total = countNodes(nodes);

        return {
          success: true,
          output: JSON.stringify({
            // IMPORTANT: `total` MUST be the first key in the JSON output.
            // Tail-truncation safety (see task_list for the same pattern).
            total,
            truncated: false,
            depth: params.depth,
            parent_task_id,
            nodes,
          }),
          metadata: { execution_time_ms: 0 },
        };
      } catch (error) {
        return {
          success: false,
          output: "",
          error: error instanceof Error ? error.message : String(error),
          metadata: { execution_time_ms: 0 },
        };
      }
    },
  };
}