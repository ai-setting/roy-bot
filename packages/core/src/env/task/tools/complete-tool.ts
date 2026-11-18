/**
 * @fileoverview Task Complete Tool
 *
 * Task #2778: 新增 deliverable_storage_path 参数 + 增强 description
 */

import type { Tool, ToolContext, ToolResult } from "../../tool/types";
import { CompleteTaskToolSchema } from "./task-types";
import type { TaskComponent } from "../task-component";
import { setCurrentTaskId } from "../../context/env-context";
import { createLogger } from "../../log-trace/logger";
// Task #4834 — F3: 与 prompts-index.ts 共用同一组验收文案锚点
import {
  TASK_COMPLETE_ITEM_BY_ITEM,
  TASK_COMPLETION_HINT_ANCHOR,
  TASK_COMPLETE_VERIFY_DUTY,
  TERMINAL_NON_ACCEPTABLE_STATUSES,
} from "./completion-copy";

const logger = createLogger("task:tools:complete");

/**
 * task_complete 工具描述（导出便于单测和未来 reuse）
 */
export const TASK_COMPLETE_DESCRIPTION = `
Final acceptance of a submitted task: set status=completed, progress=100
(two-phase acceptance, Task #5073).

**Who should call this** — the **acceptance side** (default agent). The
executor (sub-agent) has NO permission to call it (deniedTools, Task #5007).

**Before calling this tool**, you MUST:

1. Read the task's \`goal\` (description) and \`delivery\` (goals_and_expected_deliverables) fields.
   - Use \`task_get(task_id=<id>)\` to fetch the full task record.
2. **Validate whether each goal sub-item was achieved** (${TASK_COMPLETE_ITEM_BY_ITEM}).
   - Goals should be numbered sub-items (编号子项, see task_create rules). Check
     each sub-item against the operation-record chain (操作记录链) and the
     deliverable evidence (context.deliverable_storage_path).
   - The completion hook (task:after.complete) judges the whole goal vs.
     deliverables; numbered sub-items give it finer-grained evidence to
     reason with (逐条对照的证据粒度). If it detects that the goal or
     deliverables appear unmet, the task context will carry a
     \`[${TASK_COMPLETION_HINT_ANCHOR}]\`.
   - **If you receive a [${TASK_COMPLETION_HINT_ANCHOR}]**, you MUST verify it
     (${TASK_COMPLETE_VERIFY_DUTY}): re-read the task via \`task_get\`, then do exactly one of:
     (a) 确认未完成 → \`task_update(task_id=<id>, status=todo)\` reopen and continue; or
     (b) 确认已完成 → \`task_operation_create\` (milestone_type=decision,
         milestone_title=<一行结论>) state why the sub-items are actually
         met (说明理由).
     Never ignore it (不允许无视).
   - If the goal and delivery mismatch **without** a hint, either:
     (a) extend the task via \`task_update\`, or
     (b) record the discrepancy via \`task_operation_create\`
         (milestone_type=decision) — the reason **must** land in the
         operation record (必须落到操作记录里), not merely a line in
         your final report (不能只在报告里带一句).
3. Deliverables were already submitted by the executor via
   \`task_pre_complete\` (they live in \`context.deliverable_storage_path\`
   and the operation trail — Task #5073 design: task_complete takes **no**
   deliverable parameter). Cross-check them in step 2; do NOT ask the
   executor to resubmit.

**Restrictions**:
- Cannot complete cycle-type tasks (they are periodic). Use \`task_update\` to reset progress instead.
- Marks the task as 100% complete; use \`task_update\` to record partial progress first if needed.

**Side effects**:
- Sets \`status = "completed"\`, \`progress = 100\` **and refreshes \`current_status\`**
  to the completed wording. You do **NOT** need a follow-up
  \`task_update(current_status=...)\` call — a task must never keep a stale
  pre-completion progress sentence (e.g. "paused, not committed") that would
  contradict \`status = "completed"\`.
- The goal-check decision model does **NOT** run here — it already ran at
  \`task_pre_complete\` time (Task #5073 design v2). This tool is the final
  state commit by the acceptance side.
- Cannot complete a task that is already in a terminal state (cancelled /
  archived) — reopen it first via \`task_update(status="active")\`.
`.trim();

export function completeTaskTool(taskComponent: TaskComponent): Tool {
  return {
    name: "task_complete",
    description: TASK_COMPLETE_DESCRIPTION,
    parameters: CompleteTaskToolSchema,
    execute: async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const params = CompleteTaskToolSchema.parse(args);
      const sessionId = ctx.session_id || "unknown";

      try {
        // Check if task exists and is not a cycle type
        const currentTask = await taskComponent.getTask(params.task_id);
        if (!currentTask) {
          return {
            success: false,
            output: "",
            error: `Task not found: ${params.task_id}`,
            metadata: { execution_time_ms: 0 },
          };
        }

        // Cycle-type tasks cannot be completed (they are periodic)
        if (currentTask.type === "cycle") {
          return {
            success: false,
            output: "",
            error: `Cannot complete a cycle-type task (id: ${params.task_id}). Cycle tasks are periodic (e.g., weekly reports) and should not be marked as completed. Use task_update to reset progress instead.`,
            metadata: { execution_time_ms: 0 },
          };
        }

        // ★ Task #5073 — 终态护栏（两阶段验收）：
        //   已终态（cancelled / archived）的任务**不可**被"验收通过"。
        //   - cancelled：已取消的事实不该被验收抹掉（要恢复走 reopen：
        //     task_update(status=active)）
        //   - archived：历史归档同样不可翻转成 completed
        //   规范路径 to_validate → completed 与兜底路径 active → completed
        //   （#5054 补验收）都放行 —— 护栏只拦「对已终态任务二次验收」。
        //
        //   ★ DS review MAJOR-3 修复：护栏同时落在 TaskComponent
        //   .completeTask（tool + CLI 的汇聚点，组件层抛错兜底），
        //   此处为友好报错（走 tool result 而非异常）。
        //   TaskStoreBackend（MCP）不经 TaskComponent —— 靠本 tool
        //   层拦截覆盖（backend 直连通道留档 r4 MINOR-2）。
        const TERMINAL_NON_ACCEPTABLE = new Set([
          ...TERMINAL_NON_ACCEPTABLE_STATUSES,
        ]);
        if (TERMINAL_NON_ACCEPTABLE.has(currentTask.status)) {
          return {
            success: false,
            output: "",
            error: `Cannot complete task #${params.task_id}: it is already in terminal status "${currentTask.status}". Reopen it first via task_update(status="active") if acceptance should proceed.`,
            metadata: { execution_time_ms: 0 },
          };
        }

        // ★ Task #5073 设计调整① — 不再传 deliverable_storage_path。
        //   交付物在 pre_complete 阶段落库（context + operation），
        //   complete 只是验收落定。
        const task = await taskComponent.completeTask(params.task_id, sessionId);
        if (!task) {
          return {
            success: false,
            output: "",
            error: `Task not found: ${params.task_id}`,
            metadata: { execution_time_ms: 0 },
          };
        }

        // Clear currentTaskId from EnvContext since task is now completed
        setCurrentTaskId(undefined);
        logger.info(
          `[completeTask] Trace: Task #${params.task_id} completed (acceptance committed), currentTaskId cleared from EnvContext`
        );

        return {
          success: true,
          output: `Task completed: #${task.id} - ${task.title}`,
          metadata: { execution_time_ms: 0, task },
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