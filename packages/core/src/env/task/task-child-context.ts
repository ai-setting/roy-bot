/**
 * @fileoverview Task Child Context — Pure helper for safely inheriting context
 *                 from a parent task when creating a child task.
 *
 * Used by `task_create` (and by delegate prompt builders) to suggest a
 * sensible default payload for a child task. The caller may override any
 * field; the helper never silently drops required fields.
 *
 * Inheritance rules (v1):
 *
 *   1. project_path — ALWAYS inherited from parent unless overridden.
 *   2. worktree_path, branch, parent_branch, type — inherited from parent
 *      `context` JSON when present and the caller doesn't override.
 *   3. tags — NOT inherited by default (caller may opt in via `inheritTags`).
 *      Why: tags often encode the parent feature/iteration; children may
 *      want different tagging to track their own scope.
 *   4. prior_context.commit — NEVER copied (security: avoid leaking private
 *      commit SHAs). prior_context.prev_task IS preserved (helpful trail).
 *   5. created_at — always auto-injected with current timestamp unless
 *      the caller overrides it.
 *   6. Sensitive fields — token redaction is the responsibility of the
 *      caller (TaskCreationRegistry already redacts on storage). This
 *      helper additionally strips known commit-SHA leakage patterns.
 *
 * If parent.contextJson is malformed, we fall back gracefully:
 *   - project_path still inherited
 *   - context still produced (as minimal JSON)
 *   - all other inherited fields absent
 */

import { createLogger } from "../log-trace/logger";

const logger = createLogger("task-child-context");

// ============================================================================
// Public types
// ============================================================================

/**
 * Snapshot of the parent task's stored context. Sourced from
 * `taskComponent.getTask(parentId)` + `parent.context` JSON.
 */
export interface ParentContextSnapshot {
  taskId: number;
  projectPath: string;
  /** Raw JSON string of the parent's context field. */
  contextJson: string;
  tags?: string[];
}

/**
 * Caller-provided overrides. `undefined` = "use inherited value".
 */
export interface ChildContextOverrides {
  /** Replace inherited project_path. */
  projectPath?: string;
  /** Replace inherited branch (in context.branch). */
  branch?: string;
  /** Replace inherited worktree_path (in context.worktree_path). */
  worktreePath?: string;
  /** If true, inherit parent's tags. Default false. */
  inheritTags?: boolean;
  /** If false, skip all inherited context fields. Default true. */
  contextInherit?: boolean;
  /** Override auto-injected created_at. */
  createdAt?: string;
}

export interface InheritedChildContext {
  /** Resolved project_path to use for the child task. */
  project_path: string;
  /** Serialized JSON `context` field ready for the child task. */
  context: string;
  /** Tags inherited from parent (only populated when `inheritTags=true`). */
  inheritedTags: string[];
}

// ============================================================================
// Sensitive key stripping
// ============================================================================

/**
 * Keys that must NEVER be copied from a parent's context to a child.
 * `prior_context.commit` is excluded by design; `prior_context.prev_task`
 * is preserved (helpful trail).
 */
const STRIPPED_KEYS: ReadonlyArray<string> = ["commit", "token", "secret", "password", "api_key"];

/**
 * ★ Task #5392 — one-shot hint 字段：只对「写入它的那个任务」有意义，
 * 绝不继承给子任务。
 *
 * - `decision_hint`：task:before.create 写的「本次新建任务的挂载/复用建议」。
 *   继承给子任务 → 子任务的 task_create 会投递一条引用**父任务** parent/root
 *   判断的提示，且子任务还得再「补答」一次（用户 #5392 实测的现象）。
 * - `decision_hint_delivered_at` / `decision_hint_digest`：上面那条的投递审计锚点
 *   （面向未来的等价字段，当前不写入）。继承过去会谎称子任务「曾经提示过」。
 * - `completion_hint`：父任务自己的「目标 vs 交付物」判定结果，与子任务无关。
 *
 * 注意：这里只做「不继承」，不做「投递即消费 / 读侧剥离」——
 * hint 留在原任务 context 里是正确行为（它是 task_create 工具输出的一部分）。
 */
const ONE_SHOT_HINT_KEYS: ReadonlyArray<string> = [
  "decision_hint",
  "decision_hint_delivered_at",
  "decision_hint_digest",
  "completion_hint",
];

/**
 * Recursively strip sensitive keys from a parsed context object.
 * Operates on a deep clone so it doesn't mutate the parent.
 */
function stripSensitiveKeys(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(stripSensitiveKeys);
  if (typeof obj !== "object") return obj;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const lower = k.toLowerCase();
    if (STRIPPED_KEYS.some((s) => lower.includes(s))) continue;
    out[k] = stripSensitiveKeys(v);
  }
  return out;
}

// ============================================================================
// Implementation
// ============================================================================

export interface InheritArgs {
  parent: ParentContextSnapshot;
  overrides?: ChildContextOverrides;
}

export function inheritChildContext(args: InheritArgs): InheritedChildContext {
  const { parent, overrides = {} } = args;
  const contextInherit = overrides.contextInherit !== false; // default true
  const inheritTags = overrides.inheritTags === true; // default false

  // 1) Resolve project_path (always inherit unless override)
  const project_path = overrides.projectPath ?? parent.projectPath ?? "unknown";

  // 2) Parse parent context (defensive)
  let parentCtx: Record<string, unknown> = {};
  if (parent.contextJson && parent.contextJson.trim().length > 0) {
    try {
      const parsed = JSON.parse(parent.contextJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        parentCtx = parsed as Record<string, unknown>;
      }
    } catch (err) {
      logger.debug(
        `[task-child-context] parent #${parent.taskId} context is malformed JSON; ` +
          `continuing with empty inherited context (${err instanceof Error ? err.message : String(err)})`
      );
      parentCtx = {};
    }
  }

  // 3) Build child context
  const childCtx: Record<string, unknown> = {};

  if (contextInherit) {
    // Inherit safe fields
    if (parentCtx.worktree_path !== undefined && overrides.worktreePath === undefined) {
      childCtx.worktree_path = parentCtx.worktree_path;
    }
    if (parentCtx.branch !== undefined && overrides.branch === undefined) {
      childCtx.branch = parentCtx.branch;
    }
    if (parentCtx.parent_branch !== undefined) {
      childCtx.parent_branch = parentCtx.parent_branch;
    }
    if (parentCtx.type !== undefined) {
      childCtx.type = parentCtx.type;
    }

    // prior_context: keep prev_task, drop commit
    if (parentCtx.prior_context && typeof parentCtx.prior_context === "object") {
      const pc = parentCtx.prior_context as Record<string, unknown>;
      const safe: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(pc)) {
        if (k.toLowerCase() === "commit") continue;
        safe[k] = v;
      }
      if (Object.keys(safe).length > 0) {
        childCtx.prior_context = safe;
      }
    }

    // Pass through other custom fields (excluding sensitive keys)
    const reserved = new Set([
      "worktree_path",
      "branch",
      "parent_branch",
      "type",
      "prior_context",
      "created_at",
      // ★ Task #5392 — 一次性提示（one-shot signals）不得继承给子任务。
      //   decision_hint 是「本次新建任务的挂载/复用建议」，写于父任务创建期的
      //   task:before.create；completion_hint 是父任务自己的交付物判定结果。
      //   两者都属于「对某个具体任务的瞬时提示」，继承到子任务就会：
      //   ① 在子任务 task_create 输出里投递一条语义错位的 hint（引用父任务的
      //      parent/root 判断、父任务的交付物）；
      //   ② 让子任务再「补答」一次父任务的旧提示（正是 #5392 用户看到的现象）。
      ...ONE_SHOT_HINT_KEYS,
    ]);
    for (const [k, v] of Object.entries(parentCtx)) {
      if (reserved.has(k)) continue;
      childCtx[k] = v;
    }
  }

  // 4) Apply overrides (always win)
  if (overrides.worktreePath !== undefined) childCtx.worktree_path = overrides.worktreePath;
  if (overrides.branch !== undefined) childCtx.branch = overrides.branch;

  // 5) Auto-inject created_at
  const createdAt = overrides.createdAt ?? new Date().toISOString();
  childCtx.created_at = createdAt;

  // 6) Tag the child with parent reference (light marker)
  childCtx.child_of = parent.taskId;

  // 7) Final sanitize pass on the merged context (defense in depth)
  const sanitized = stripSensitiveKeys(childCtx) as Record<string, unknown>;

  return {
    project_path,
    context: JSON.stringify(sanitized),
    inheritedTags: inheritTags ? parent.tags ?? [] : [],
  };
}