/**
 * @fileoverview Task Cancel Tool (Task #5007)
 *
 * 架构背景 —— 验收权从 roy sub-agent 移交 default agent（接待员）：
 *
 *   原本「验收」与「执行」都在 roy sub-agent 手里（裁判和运动员同一人），
 *   且 sub-agent 超时 / 未更新状态时任务状态会长期不同步。
 *   调整后 default agent 承担验收：
 *     - task_complete —— 核对产出后判定完成（触发 goal 检查 decision model）
 *     - task_cancel   —— **仅在用户明令取消时**取消任务
 *
 * 语义边界（Task #5055，用户明令）：
 *   task_cancel 是**用户明令**才能调的 —— 用户说"取消 / 停掉这个任务"。
 *   失败 / 超时 ≠ 取消：正确的出路是找根因 → 提修复方案 → 重新委托
 *   （可用 sub_session_id 续跑）→ 实在推不动就如实告知用户、等用户决定，
 *   **不自行 cancel**。
 *
 * 本工具的职责边界：
 *   - **取消 Task 本身**（task.status = "cancelled"）
 *   - **不是**停后台进程 —— 那是 `stop_task` 的职责（stop_task 停 bg process，
 *     task_cancel 停 Task 记录）。两者正交，default agent 可能需要连用：
 *     先 stop_task 掐掉还在跑的 sub-agent，再 task_cancel 取消任务记录。
 *
 * 终态 hook：`cancelled` 属于 TASK_COMPLETE_TERMINAL_STATUSES。
 *   ⚠️ Task #5073 设计调整②：updateTask **不再** fire
 *   AFTER_COMPLETE —— 终态通知走 task:after.update
 *   （lark-card 状态机 cardStatusOf 覆盖 completed/cancelled/
 *   archived 等），本工具无需额外接线。
 */

import type { Tool, ToolContext, ToolResult } from "../../tool/types";
import { CancelTaskToolSchema, type CancelTaskToolParams } from "./task-types";
import type { TaskComponent } from "../task-component";
import { createLogger } from "../../log-trace/logger";
// Task #5060 — 取消态 current_status 措辞同源锚点（与 task-component 共用）
import { TASK_CANCELLED_STATUS_WORD } from "./completion-copy";

const logger = createLogger("tool:cancel-task");

/**
 * 已终态、不可再取消的状态。
 *
 * - completed：已完成的任务不该被"取消"（那是抹掉已完成事实）
 * - cancelled：重复取消是 no-op 语义，直接报错更清晰
 * - archived：已归档属于历史事实
 */
const NON_CANCELLABLE_STATUSES = new Set(["completed", "cancelled", "archived"]);

/**
 * task_cancel 工具描述（导出便于单测和未来 reuse）
 */
export const TASK_CANCEL_DESCRIPTION = `
Cancel a task (task.status = "cancelled"). This is the **acceptance-side** cancel.

**When to use** — ONLY when the user explicitly asks (用户明令):
- The user asks to cancel / stop / drop the task (用户明令取消 / 停掉 / 放弃这个任务)

**When NOT to use**:
- ❌ A sub-agent failed / timed out / went off-track — that is NOT a cancellation.
  Find the root cause, propose a fix, and re-delegate (with \`sub_session_id\` to resume).
  If it truly cannot be moved forward, report the situation to the user and **wait for
  the user's decision** — do NOT cancel it on your own.
- ❌ Acceptance found gaps but re-delegation is still possible — re-delegate instead.

**What it does NOT do**:
- It does **NOT** stop a running background process — that is \`stop_task\`
  (which takes a bg-process id from \`delegate_task\`). If the sub-agent is still
  running, call \`stop_task\` **first**, then \`task_cancel\` to close the record.

**Side effects**:
- Sets \`status = "cancelled"\` and fires the task terminal-state hooks
  (notifications / card state machine converge to the cancelled state).
- Also refreshes \`current_status\` to the cancelled wording (with your \`reason\`
  appended when given) — the task no longer keeps a stale pre-cancel progress
  sentence that would contradict \`status = "cancelled"\`.
- Writes an operation record so the cancellation reason stays auditable.
- A cancelled task can be reopened later with \`task_update(status="active")\`.

**Parameters**:
- \`task_id\` (required): the task to cancel
- \`reason\` (optional): why it is being cancelled — recorded in the operation trail
`.trim();

export function cancelTaskTool(taskComponent: TaskComponent): Tool {
  return {
    name: "task_cancel",
    description: TASK_CANCEL_DESCRIPTION,
    parameters: CancelTaskToolSchema,
    execute: async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const params = CancelTaskToolSchema.parse(args) as CancelTaskToolParams;
      const sessionId = ctx.session_id || "unknown";

      try {
        const current = await taskComponent.getTask(params.task_id);
        if (!current) {
          return {
            success: false,
            output: "",
            error: `Task not found: ${params.task_id}`,
            metadata: { execution_time_ms: 0 },
          };
        }

        if (NON_CANCELLABLE_STATUSES.has(current.status)) {
          return {
            success: false,
            output: "",
            error: `Cannot cancel task #${params.task_id}: it is already in terminal status "${current.status}".`,
            metadata: { execution_time_ms: 0, task_id: params.task_id },
          };
        }

        // 走 updateTask 而非 store 直写 —— 让 BEFORE_UPDATE / AFTER_UPDATE /
        // AFTER_COMPLETE 钩子链正常收敛（终态通知、卡片状态机）。
        //
        // ★ Task #5060: **同时写 current_status** —— 与 completeTask 同类缺陷。
        // 原来只设 status="cancelled" ⇒ current_status 仍留着取消前的旧文案
        // （如「进度 80%，等评审结果」），出现「status=cancelled 但描述说还在推进」
        // 的自相矛盾状态。措辞同源锚点见 tools/completion-copy.ts。
        const task = await taskComponent.updateTask(params.task_id, {
          status: "cancelled",
          current_status: params.reason
            ? `${TASK_CANCELLED_STATUS_WORD}：${params.reason}`
            : TASK_CANCELLED_STATUS_WORD,
        });

        if (!task) {
          return {
            success: false,
            output: "",
            error: `Task not found: ${params.task_id}`,
            metadata: { execution_time_ms: 0 },
          };
        }

        // 审计痕迹：取消原因 + 终态，与 task_update 的 progress 记录同构。
        await taskComponent.createOperation({
          taskId: params.task_id,
          sessionId,
          milestoneType: "decision",
          milestoneTitle: `Task cancelled: #${params.task_id}`,
          milestoneDescription: params.reason
            ? `Cancelled by acceptance side. Reason: ${params.reason}`
            : "Cancelled by acceptance side (no reason given).",
        });

        logger.info(
          `[cancelTask] Task #${params.task_id} cancelled (previous status: ${current.status})`,
        );

        return {
          success: true,
          output: `Task cancelled: #${params.task_id} - ${task.title}`,
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
