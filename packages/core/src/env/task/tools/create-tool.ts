/**
 * @fileoverview Task Create Tool
 */

import type { Tool, ToolContext, ToolResult } from "../../tool/types";
import { CreateTaskToolSchema, type CreateTaskToolParams, UNKNOWN_PROJECT_PATH, UNKNOWN_TASK_CONTEXT } from "./task-types";
import type { TaskComponent } from "../task-component";
import { getEnvContextOrEmpty, setCurrentTaskId } from "../../context/env-context";
import { createLogger } from "../../log-trace/logger";
import { execSync } from "child_process";
import { inheritChildContext } from "../task-child-context";
import { NEW_TASK_ID_PLACEHOLDER, NEW_TASK_ID_HASH_PLACEHOLDER } from "../hooks/verdict";
import { TASK_DISCIPLINE_GOALS } from "../prompt/task-discipline";

const logger = createLogger("task:tools:create");

// Task #4889 — goals 规则从 task-discipline 单一真相源取用，
// 按工具描述的 6 空格缩进排版（原文是 6 空格缩进的模板块）。
const TASK_DISCIPLINE_GOALS_INDENTED = TASK_DISCIPLINE_GOALS.split("\n")
  .map((l) => (l.trim() ? "      " + l : l))
  .join("\n");

/**
 * Task #4467 — 从 task.context 里取出 decision 检测的 hint。
 *
 * context 是 JSON 字符串，hint 在 `decision_hint` 字段里。
 * 解析失败 → 返回 undefined（不产生 hint，output 与原来完全一致）。
 */
function extractDecisionHint(contextJson: string | undefined): string | undefined {
  if (!contextJson) return undefined;
  try {
    const parsed = JSON.parse(contextJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const hint = (parsed as Record<string, unknown>).decision_hint;
    return typeof hint === "string" && hint.length > 0 ? hint : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Detect current worktree path by comparing `git rev-parse --show-toplevel`
 * with the current working directory.
 *
 * - Returns the cwd if cwd is inside a worktree (different from the toplevel
 *   or contains a `.worktrees/ .worktree/` subdir).
 * - Returns null if cwd is at the toplevel of the main checkout.
 * - Returns null if git is not available or cwd is not in a git repo.
 *
 * The detection is intentionally defensive: any error → null (caller will
 * simply skip auto-injection rather than fail task creation).
 *
 * Task #2325: 让 task_create 自动填充 worktree_path, 减少人工遗漏。
 */
function detectWorktree(): string | null {
  try {
    const toplevel = execSync("git rev-parse --show-toplevel", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    const cwd = process.cwd();
    if (!toplevel) return null;
    // 在 worktree 里: cwd 是 toplevel 的子目录
    if (cwd !== toplevel) return cwd;
    // cwd === toplevel: 这是主 checkout, 不是 worktree
    // 但有些项目把 main checkout 命名为 `.worktrees/<name>` 也是合法的,
    // 这里保守不自动检测, 留给用户手动填。
    if (cwd.includes(".worktrees/") || cwd.includes(".worktree/")) {
      return cwd;
    }
    return null;
  } catch {
    return null;
  }
}

export function createTaskTool(taskComponent: TaskComponent): Tool {
  return {
    name: "task_create",
    description: `
      Create a new task for tracking work.

      ## ⚠️ CALL task_tree(depth=1) BEFORE THIS TOOL

      Before calling \`task_create\`, you **MUST** first call
      \`task_tree(depth=1)\` to inspect the existing task hierarchy.
      This is critical because:

      1. Avoid duplicating root tasks (root tasks should stay ≤ 10).
      2. Find the right \`parent_task_id\` to attach under.
      3. Avoid creating stranded/orphan tasks.

      Workflow:
        step 1: task_tree({depth: 1})
        step 2: read the tree, then decide per "Decision Tree" below
        step 3: task_create({...})

      ## ⚠️ STEP 1 — FIND SIMILAR TASKS FIRST (Task #4467)

      Before creating a task, you **MUST** first look for existing tasks
      that cover the same ground, and record them in
      \`context.similar_task_ids\`. This lets the decision model detect
      duplicates and suggest reusing / reopening an existing task instead
      of piling up another root.

      Workflow:
        step 1: task_search({keywords: [...]}) or task_get(...) to find
                existing tasks related to this request
        step 2: collect the relevant task ids (0 or more)
        step 3: task_create({..., context: {..., similar_task_ids: [id1, id2]}})

      \`context.similar_task_ids\` is **required** (may be an empty array \`[]\`
      if you searched and found nothing related). It is an array of task ids.

      The decision check runs on \`task:before.create\` and only **advises** —
      the task is always created. If the output contains a
      \`[TASK_CREATE_HINT]\` section, you **MUST** read and verify it:
      verify with \`task_get\`, then either execute the suggested
      \`task_update\` (reusing / reopening / re-parenting) or explicitly
      state why it was not adopted. Never ignore it.

      ## Decision Tree — How to choose parent_task_id

      Walk these paths in order:

      **Path A — Attach under a longterm root.**
        The task belongs to a theme whose longterm root already exists
        (e.g. "[Longterm] X ecosystem"). Set \`parent_task_id\` to that
        root's id. This is the **preferred** path for incremental work
        inside an established theme.

      **Path B — Attach under an existing topic cluster.**
        A non-longterm root already aggregates similar tasks and yours
        belongs in the same cluster. Set \`parent_task_id\` to that root.

      **Path C — Create a new root.**
        Neither A nor B fits (cross-cutting work, or root count already
        ≥ ~10). **Omit** \`parent_task_id\` (or pass \`null\`) and the
        task becomes a new root.

      ## Tree Hygiene Principles

      Apply these when deciding parent_task_id:

        - Root tasks ≤ 10 (keep tree width manageable)
        - Depth ≤ 5 (avoid deep nesting)
        - Same-theme tasks cluster under one parent
        - Long-tail/stranded tasks should be archived or merged
      ${TASK_DISCIPLINE_GOALS_INDENTED}

      ## ⚠️ Spatial + Temporal Context (Task #2325)

      A task MUST carry spatio-temporal context so it survives task-handoff
      across Agent sessions, worktrees and time. Two orthogonal axes:

      - **Space (project_path + worktree_path)**:
        - \`project_path\` (required): git repo root path (always the top-level repo)
        - \`worktree_path\` (in context): current worktree path if in a worktree
          - **Auto-detected by createTask** via \`git rev-parse --show-toplevel\`
            — you don't need to fill it manually (see "worktree_path detection
            logic" in the implementation).
          - You may **override** by passing it in \`context.worktree_path\`.

      - **Time (context field)**:
        - \`created_at\` (in context): ISO 8601 timestamp **auto-injected**
          at creation time. Manual override is preserved if provided.
        - \`time_dimension\` (in context, optional): the task's "time anchor"
          — e.g. a release tag, sprint window or iteration id.
        - \`work_period\` (in context, optional): planned start/end dates
          if known.
        - \`prior_context\` (in context, optional): the previous task id
          / commit hash this work continues from. Helps the next Agent
          pick up the trail via \`task_get\`.

      Example context for code development task:

      \`\`\`json
      {"project_path": "<git-repo-root>",
       "worktree_path": "<git-repo-root>/.worktrees/<branch-name>",
       "branch": "feat/<branch-name>",
       "type": "feature",
       "parent_branch": "main",
       "created_at": "<ISO-8601-timestamp>",
       "prior_context": {"prev_task": "<task-id>", "commit": "<commit-hash>"}}
      \`\`\`

      ## IMPORTANT: Task Continuity Fields

      This tool creates persistent task records that can be picked up by a
      Task Manager Agent to continue advancing unfinished work.

      The following fields are critical for task context preservation:

      - project_path: The project root path where this task belongs.
        Used to locate the project space for this task.
        If unknown, use 'unknown'.

      - context: A JSON string containing time-space positioning information.
        This field is crucial for Agent task handoff.

        **Required format**: Valid JSON string (parseable).

        **Core fields**:
        - worktree_path: Git worktree path (for code development). Auto-detected.
        - branch: Current branch name
        - type: Work type classification (feature/bug/refactor/chore).
          ⚠️ NOTE: This is the **context.type** (work classification), NOT the
          task's type field (normal/cycle/longterm). They are independent concepts.
        - created_at: ISO 8601 timestamp. Auto-injected if missing.

        **Example for coding tasks**:
        {"worktree_path": "<worktree-path>", "branch": "<branch-name>", "type": "feature", "parent_branch": "main"}

        **Example for other tasks**:
        {"type": "general"}

        If unable to fill in details, use at minimum:
        {"type": "unknown"}

        **DO NOT leave this as plain text** - it must be valid JSON!

        **Note**: malformed JSON (non-parseable) will be preserved as-is
        rather than rejected, to preserve backward compatibility. The
        auto-injection of \`created_at\` / \`worktree_path\` is best-effort.

      ## Task Binding Inheritance (Task #4023)

      When this tool is called from inside a per-task group chat, the
      event-source handler resolves the chat↔task binding and injects the
      bound task id into \`EnvContext.parentTaskId\`. This tool reads that
      value and uses it as the default \`parent_task_id\`, so the LLM
      doesn't need to know the task tree to attach subtasks to the
      correct parent.

      Priority order (highest → lowest):
        1. Caller's explicit \`parent_task_id\` (always wins)
        2. \`EnvContext.parentTaskId\` injected from chat binding
        3. No parent (creates a root task, as before)

      When the env-injected parent doesn't exist in the DB, the tool
      fails fast (does not silently create an orphan). When the
      env-injected value is 0 / negative / non-integer, it's treated as
      missing — only positive integers are honored.

    `,
    parameters: CreateTaskToolSchema,
    execute: async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const params = CreateTaskToolSchema.parse(args) as CreateTaskToolParams;
      const sessionId = ctx.session_id || "unknown";

      // Task #2325: auto-detect worktree + auto-inject created_at.
      // Manual overrides in params.context take precedence over auto-detection.
      const detectedWorktree = detectWorktree();
      let enrichedContext = params.context;

      // Task #2395 — when parent_task_id is supplied, automatically merge
      // the parent's project_path / worktree_path / branch / etc. into the
      // child's payload via `inheritChildContext`. Caller fields (title /
      // project_path / tags / context overrides) always win. This keeps
      // child tasks correctly positioned even when the LLM forgets to
      // copy the spatial fields manually. We fetch the parent up front to
      // ensure parent_task_id is valid; failure here is bubbled up by
      // taskComponent.createTask, but the fetch is also useful for the
      // inheritance helper.

      // Task #4023 — resolve effective parent_task_id with priority:
      //   1. caller-supplied parent_task_id (explicit user choice)
      //   2. EnvContext.parentTaskId injected from chat↔task binding
      //   3. undefined (create a root task)
      // This lets group-chat messages auto-attach subtasks to the bound
      // task without requiring the LLM to know the task tree.
      const envParentTaskId = getEnvContextOrEmpty().parentTaskId;
      const effectiveParentTaskId: number | undefined =
        params.parent_task_id !== undefined && params.parent_task_id !== null
          ? params.parent_task_id
          : envParentTaskId !== undefined &&
              envParentTaskId !== null &&
              Number.isInteger(envParentTaskId) &&
              envParentTaskId > 0
            ? envParentTaskId
            : undefined;

      // Task #4619: `project_path` / `context` are no longer required by the
      // schema — they fall back to the documented sentinels ("unknown" /
      // '{"type":"unknown"}'). A sentinel means "the caller said nothing",
      // so it must NOT be treated as an explicit override: it would mask the
      // parent-task inheritance below (Task #2395) and the child would be
      // pinned to "unknown" instead of the parent's real project path.
      //
      // Measured before the fix: a child created without `project_path`
      // stored "unknown" instead of the parent's "/repo/parent".
      const callerProjectPath =
        params.project_path && params.project_path.trim() !== ""
          ? params.project_path
          : undefined;
      const callerProjectPathIsExplicit =
        callerProjectPath !== undefined && callerProjectPath !== UNKNOWN_PROJECT_PATH;

      let inheritedProjectPath: string | undefined = callerProjectPathIsExplicit
        ? callerProjectPath
        : undefined;
      let inheritedTags: string[] | undefined = params.tags;
      let inheritedContext: string | undefined;

      if (effectiveParentTaskId !== undefined) {
        try {
          const parent = await taskComponent.getTask(effectiveParentTaskId);
          if (parent) {
            const inherited = inheritChildContext({
              parent: {
                taskId: parent.id,
                projectPath: parent.project_path,
                contextJson: parent.context ?? "",
                tags: parent.tags,
              },
              overrides: {
                projectPath: inheritedProjectPath,
                branch: undefined,
                worktreePath: undefined,
                inheritTags: params.tags === undefined,
                contextInherit: true,
              },
            });
            if (inheritedProjectPath === undefined) {
              inheritedProjectPath = inherited.project_path;
            }
            if (params.tags === undefined) inheritedTags = inherited.inheritedTags;
            // Merge into the caller-provided context JSON when present;
            // the helper returns the *final* JSON string.
            inheritedContext = inherited.context;
          }
        } catch (err) {
          // Defensive: a parent fetch failure should not block creation.
          // taskComponent.createTask will still validate and throw if
          // parent_task_id is genuinely invalid.
          logger.debug(
            `[task_create] failed to pre-load parent #${
              effectiveParentTaskId
            } for context inheritance: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }

      try {
        // Task #4619: the schema default for `context` is the documented
        // sentinel '{"type":"unknown"}'. A sentinel means "the caller said
        // nothing", so it must NOT shadow the inherited parent context —
        // otherwise the child's inherited `type` (and any other inherited
        // field) would be overwritten by the sentinel.
        const rawContext =
          params.context === UNKNOWN_TASK_CONTEXT ? undefined : params.context;
        const ctxObj = rawContext ? JSON.parse(rawContext) : {};
        const obj = typeof ctxObj === "object" && ctxObj !== null && !Array.isArray(ctxObj)
          ? ctxObj
          : {};

        // Task #2395 — merge inherited parent context FIRST (when
        // parent_task_id was provided AND the caller did NOT override
        // fields we manage). We do this before the auto-detection so the
        // inherited worktree_path/branch take precedence over the
        // runtime-detected cwd.
        if (inheritedContext) {
          try {
            const inheritedObj = JSON.parse(inheritedContext);
            if (
              inheritedObj &&
              typeof inheritedObj === "object" &&
              !Array.isArray(inheritedObj)
            ) {
              // Caller's `obj` wins over inherited (already populated above).
              for (const [k, v] of Object.entries(inheritedObj)) {
                if (obj[k] === undefined) obj[k] = v;
              }
            }
          } catch {
            // ignore parse errors — helper always produces valid JSON
          }
        }

        // Auto-inject created_at if missing
        if (!obj.created_at) {
          obj.created_at = new Date().toISOString();
        }

        // Auto-inject worktree_path if missing and detection succeeded
        if (!obj.worktree_path && detectedWorktree) {
          obj.worktree_path = detectedWorktree;
        }

        enrichedContext = JSON.stringify(obj);
      } catch {
        // Malformed JSON: preserve as-is (backward compatible).
        // We don't throw here because the field is optional and the
        // schema allows arbitrary strings.
        enrichedContext = params.context;
      }

      try {
        const task = await taskComponent.createTask({
          parent_task_id: effectiveParentTaskId,
          title: params.title,
          description: params.description,
          priority: params.priority,
          type: params.type || "normal",
          goals_and_expected_deliverables: params.goals_and_expected_deliverables,
          due_date: params.due_date,
          tags: inheritedTags,
          sessionId,
          // Task #4619: fall back to the documented sentinel when neither the
          // caller nor the parent supplied one. (`CreateTaskOptions.project_path`
          // is a required string, so it must never be undefined.)
          project_path:
            inheritedProjectPath ??
            (callerProjectPathIsExplicit ? callerProjectPath : UNKNOWN_PROJECT_PATH),
          context: enrichedContext,
          // Task #5440 — 负责人（可选；不传即 null）
          owner: params.owner ?? null,
        });

        // Set currentTaskId in EnvContext for LLM awareness
        setCurrentTaskId(task.id);
        logger.info(`[createTask] Trace: Task #${task.id} created, currentTaskId=${task.id} set in EnvContext`);

        // Task #4467 — decision 检测的 hint（只提示，不拦截）。
        // hint 由 task:before.create 插件写进 context.decision_hint，
        // 里面的新任务 id 是占位符（写入时新任务还没有 id）→ 这里替换成真实 id。
        const decisionHint = extractDecisionHint(task.context);
        const renderedHint = decisionHint
          ? decisionHint
              .replaceAll(NEW_TASK_ID_HASH_PLACEHOLDER, `#${task.id}`)
              .replaceAll(NEW_TASK_ID_PLACEHOLDER, String(task.id))
          : "";
        const output =
          `Task created successfully: #${task.id} - ${task.title}` +
          (renderedHint ? `\n\n${renderedHint}` : "");

        return {
          success: true,
          output,
          metadata: {
            execution_time_ms: 0,
            task_id: task.id,
            status: task.status,
            createdAt: task.createdAt,
          },
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
