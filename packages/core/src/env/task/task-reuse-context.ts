/**
 * @fileoverview TaskReuseContext — Build the "reuse candidate" markdown
 * section injected into sub-agent delegate prompts.
 *
 * The section lists recently-active tasks (from TaskCreationRegistry) so the
 * sub-agent can decide whether to:
 *   - Reuse the existing task via `task_get` → `task_update` (reopen +
 *     append description/goals + create a continuation operation record).
 *   - Or — only if clearly different — call `task_create` for a new task.
 *
 * Critical invariants:
 *   - Candidates are *suggestions*, never auto-merged.
 *   - The section dedupes against the caller's `similar_task_ids` so the
 *     sub-agent doesn't see the same task twice in two different sections.
 *   - Output is bounded by `maxChars` and `maxDescriptionChars` to avoid
 *     consuming the prompt token budget.
 *   - Secret-like strings are redacted again at the boundary, as a second
 *     line of defense (the registry already sanitizes on write).
 */

import type {
  TaskCreationRegistry,
  RecentQueryOptions,
  SubtreeSummary,
} from "./task-creation-registry";
import type { TaskStatus } from "./types";

// ============================================================================
// Public API
// ============================================================================

export interface ReuseCandidatePromptOptions {
  registry: TaskCreationRegistry;
  /** IDs supplied by caller via similar_task_ids — skip in this section. */
  similarTaskIds?: number[];
  /** Scope override (e.g. { subagentType: "roy" }). */
  scope?: RecentQueryOptions["scope"];
  /** Default 5 */
  limit?: number;
  /** Hard cap on total markdown length. Default 2000. */
  maxChars?: number;
  /** Per-candidate description length. Default 240. */
  maxDescriptionChars?: number;
  /** Filter statuses. Default = all non-archived. */
  statuses?: TaskStatus[];
  /** Exclude the subtree rooted at this task id. */
  excludeAncestorOf?: number;
  /** Custom prefix label. Default: "Recent task context (reuse candidates)" */
  heading?: string;
}

export interface ReuseCandidatePromptSection {
  /** Full markdown block (heading + candidates + instructions). */
  markdown: string;
  /** Candidate task ids actually included (after excludeIds). */
  candidateIds: number[];
  isEmpty: boolean;
}

// ============================================================================
// Token redaction (defense in depth; registry already sanitizes)
// ============================================================================

const TOKEN_PATTERNS: ReadonlyArray<RegExp> = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}\b/g,
  /\bghp_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._\-+/=]{12,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

function redact(s: string): string {
  let out = s;
  for (const pat of TOKEN_PATTERNS) out = out.replace(pat, "<redacted>");
  return out;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  return s.slice(0, max - 1) + "…";
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Build a markdown section listing recent task candidates. Caller is
 * responsible for deciding whether to append it to the prompt.
 */
export function buildReuseCandidateSection(
  options: ReuseCandidatePromptOptions
): ReuseCandidatePromptSection {
  const limit = options.limit ?? 5;
  const maxChars = options.maxChars ?? 2000;
  const maxDescChars = options.maxDescriptionChars ?? 240;
  const heading = options.heading ?? "Recent task context (reuse candidates)";

  const recent = options.registry.recent({
    scope: options.scope,
    limit,
    statuses: options.statuses,
    excludeIds: options.similarTaskIds ?? [],
    excludeAncestorOf: options.excludeAncestorOf,
  });

  if (recent.length === 0) {
    return { markdown: "", candidateIds: [], isEmpty: true };
  }

  const lines: string[] = [];
  lines.push(`## ${heading}`);
  lines.push("");
  lines.push(
    "The following tasks were recently created in this process / session and may be related to your current work. " +
      "Before creating a brand-new task, check whether one of these is the same work continuing. " +
      "The list is a *suggestion only* — confirm with `task_get <id>` before reusing."
  );
  lines.push("");

  for (const rec of recent) {
    lines.push(`### Task #${rec.taskId}: ${rec.title}`);
    lines.push(`- Status: ${rec.status}`);
    if (rec.parentTaskId !== undefined && rec.parentTaskId !== null) {
      lines.push(`- Parent: #${rec.parentTaskId}`);
    }
    if (rec.source.subagentType) {
      lines.push(`- Created by: ${rec.source.subagentType}`);
    }
    lines.push(`- Updated: ${rec.updatedAt}`);

    // Task #2395 — project context lines (safe; omitted if undefined).
    if (rec.project_path) {
      lines.push(`- Project: ${rec.project_path}`);
    }
    if (rec.worktree_path) {
      lines.push(`- Worktree: ${rec.worktree_path}`);
    }
    if (rec.branch) {
      lines.push(`- Branch: ${rec.branch}`);
    }
    if (rec.parentBranch) {
      lines.push(`- Parent branch: ${rec.parentBranch}`);
    }

    // Task #2395 — subtree summary (children count + active/completed split).
    let summary: SubtreeSummary | undefined;
    try {
      summary = options.registry.getSubtreeSummary(rec.taskId);
    } catch {
      summary = undefined;
    }
    if (summary && summary.descendantCount > 0) {
      lines.push(
        `- Children: ${summary.descendantCount} ` +
          `(active: ${summary.activeCount}, completed: ${summary.completedCount}, max depth: ${summary.maxDepth})`
      );
    }

    // Task #2395 — warn when a completed parent still has an active child
    // (avoid blind reopen — prefer child task creation).
    const hasActiveChild =
      summary !== undefined && summary.activeCount > 0;
    if (rec.status === "completed" && hasActiveChild) {
      lines.push(
        `- ⚠ Has active child — reopening this parent will conflict with running work; prefer creating a child task.`
      );
    }

    const safeDesc = redact(
      truncate(rec.description, maxDescChars)
    );
    if (safeDesc) {
      lines.push(`- Description: ${safeDesc}`);
    }
    if (rec.tags && rec.tags.length > 0) {
      lines.push(`- Tags: ${rec.tags.join(", ")}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("### Reuse instructions");
  lines.push("");
  lines.push(
    "1. **First** call `task_get <id>` on the most relevant candidate to read its description, goals, and recent operations."
  );
  lines.push(
    "2. **If it is the same work continuing** — prefer `task_update` over `task_create`:"
  );
  lines.push("   - Set `status` back to `active` (or `todo`) to reopen a completed task.");
  lines.push("   - Append new context to `description` and `goals_and_expected_deliverables` (do not replace).");
  lines.push(
    "   - Update `current_status` to reflect the new scope, then call `task_operation_create` with `milestone_type: \"decision\"` to record the continuation."
  );
  lines.push(
    "3. **Only** if the candidate is clearly a different task, call `task_create` with a distinguishing title and `parent_task_id` if appropriate."
  );
  lines.push(
    "4. Do **not** create a duplicate task merely because the existing one is already `completed` — reopen it instead."
  );
  lines.push(
    "5. Do **not** reuse an unrelated candidate just to fill this list. Empty reuse is a valid outcome."
  );

  // --------------------------------------------------------------------------
  // Task #2395 — three-path decision matrix + operation audit templates.
  // The matrix tells the sub-agent EXACTLY which paths are legal and what
  // payload / operation records to emit for each.
  // --------------------------------------------------------------------------
  lines.push("");
  lines.push("### Decision matrix — three legal paths");
  lines.push("");
  lines.push(
    "Pick exactly **one** of these paths before calling `task_create`. Reopen-first"
  );
  lines.push(
    "remains the default, but the matrix adds two new paths for independent work."
  );
  lines.push("");
  lines.push(
    "**Path A — Continuation (reopen existing task).** The new work is the SAME"
  );
  lines.push(
    "logical task. Use `task_update(task_id=<id>, { status: \"active\", ... })` and"
  );
  lines.push(
    "append description/goals. Do **not** create a new task id."
  );
  lines.push("");
  lines.push("```");
  lines.push(
    "task_update(task_id=<parent_id>, { status: \"active\", current_status: \"...\" })"
  );
  lines.push("task_operation_create({ task_id=<parent_id>, milestone_type: \"decision\",");
  lines.push(
    "  milestone_title: \"Reopened for <new-scope>\","
  );
  lines.push("  milestone_description: \"<why this is the same work>\" })");
  lines.push("```");
  lines.push("");
  lines.push(
    "**Path B — Child task (parent_task_id=<id>).** The new work is related but"
  );
  lines.push(
    "distinct: an independent bug fix, optimization, parallel delivery or"
  );
  lines.push(
    "independent acceptance item under the same feature. Create a child task so"
  );
  lines.push(
    "the audit trail is preserved. Always pair with an audit operation."
  );
  lines.push("");
  lines.push("```");
  for (const rec of recent) {
    const safeProj = rec.project_path ?? "<project_path>";
    lines.push(
      `task_create(parent_task_id=${rec.taskId}, title="<distinguishing title>", ` +
        `project_path="${safeProj}", context=<inherit or override>)`
    );
    break; // one template per section is enough — agent picks the matching id
  }
  lines.push(
    "task_operation_create({ task_id=<new_id>, milestone_type: \"milestone\","
  );
  lines.push(
    "  milestone_title: \"Child of #<parent_id>: <new-scope>\","
  );
  lines.push("  milestone_description: \"<why this is a sibling/child, not a reopen>\" })");
  lines.push("```");
  lines.push("");
  lines.push(
    "**Path C — New root (no parent_task_id).** The new work is unrelated to any"
  );
  lines.push(
    "existing task. Create a brand-new root task. Use this sparingly — root count"
  );
  lines.push(
    "should stay ≤ ~10 to keep the tree readable."
  );
  lines.push("");
  lines.push("```");
  lines.push(
    "task_create(parent_task_id=undefined, title=\"<distinct topic>\", project_path=\"<project_path>\", context=<json>)"
  );
  lines.push(
    "task_operation_create({ task_id=<new_id>, milestone_type: \"create\","
  );
  lines.push(
    "  milestone_title: \"New root: <topic>\","
  );
  lines.push("  milestone_description: \"<why this is not a child of any existing task>\" })");
  lines.push("```");
  lines.push("");
  lines.push(
    "**Operation audit templates.** Every `task_create`/`task_update` call MUST be"
  );
  lines.push(
    "followed by a `task_operation_create` so the next agent sees *why* the path was"
  );
  lines.push(
    "chosen. Use the appropriate `milestone_type`:"
  );
  lines.push(
    "  - continuation → `decision` (and `progress` once the new scope makes headway)"
  );
  lines.push(
    "  - child task → `milestone` (then `progress` as the child advances)"
  );
  lines.push(
    "  - new root → `create` (then `progress` per phase)"
  );
  lines.push("");
  lines.push(
    "**Project + context inheritance.** For Path B/C, prefer inheriting the"
  );
  lines.push(
    "candidate's `project_path`, `context.worktree_path`, `context.branch` and"
  );
  lines.push(
    "`context.parent_branch` from the parent task. Sensitive keys (commits,"
  );
  lines.push(
    "tokens, secrets) are stripped automatically. Use the helper:"
  );
  lines.push("");
  lines.push("```");
  lines.push(
    "inheritChildContext({ parent: { taskId, projectPath, contextJson, tags }, overrides: {...} })"
  );
  lines.push("```");
  lines.push("");

  let markdown = lines.join("\n");

  // Hard cap — truncate the body while keeping heading + instructions tail.
  if (markdown.length > maxChars) {
    markdown = truncate(markdown, maxChars);
  }

  return {
    markdown,
    candidateIds: recent.map((r) => r.taskId),
    isEmpty: false,
  };
}