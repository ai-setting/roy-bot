/**
 * @fileoverview Task Pre-Complete Tool (Task #5073 — 两阶段验收)
 *
 * 需求（用户 2026-11-06 飞书原话）：
 *   「给 subagent 添加一个跟 task_complete 类似的工具，比如
 *     task_pre_complete，sub agent 觉得可以完成了就传入交付物等参数，
 *     task 状态变为待验证（to_validate），default agent 调用
 *     task_complete 校验之后状态正式完成。」
 *
 * 职责边界（沿用 #5007「执行与验收分离」架构）：
 *   - **执行方（roy sub-agent）**：干完活 → task_pre_complete 提交待验证
 *     （status → to_validate + 交付物落 context/operation）
 *   - **验收方（default agent）**：task_complete 逐条验收 → completed
 *
 * 与 task_complete 的关系：
 *   - 参数同构（deliverable_storage_path），调用体验一致
 *   - 语义不同：这里只是「提交待验证」，不是终态 —— 会 fire 一次
 *     AFTER_COMPLETE（terminalStatus="to_validate"）作为 goal 检查
 *     自查关（design v2 #38603），卡片保持 running 更新态
 *
 * current_status 同步：走 TaskComponent.preCompleteTask →
 * updateTask（withTerminalCurrentStatus 收口模式之外的本层显式文案，
 * 措辞同源锚点 TASK_TO_VALIDATE_STATUS_WORD = 「待验证」，
 * 见 tools/completion-copy.ts —— 与 #5060 的 completed/cancelled 同模式）。
 */

import type { Tool, ToolContext, ToolResult } from "../../tool/types";
import { PreCompleteTaskToolSchema } from "./task-types";
import type { TaskComponent } from "../task-component";
import { createLogger } from "../../log-trace/logger";
import { TASK_TO_VALIDATE_STATUS_WORD } from "./completion-copy";

const logger = createLogger("task:tools:pre-complete");

/**
 * task_pre_complete 工具描述（导出便于单测和 reuse）
 */
export const TASK_PRE_COMPLETE_DESCRIPTION = `
Submit a task for acceptance (two-phase acceptance, Task #5073).

**Who should call this** — the **executor** (sub-agent) when it believes
the work is done and deliverables are ready.

**What it does**:
- Sets \`status = "to_validate"\` (待验证) — the task enters the
  acceptance queue. This is **NOT** a terminal state.
- Persists \`deliverable_storage_path\` to \`task.context.deliverable_storage_path\`
  and writes a \`Deliverable: <path>\` line into the operation trail.
- Refreshes \`current_status\` to the to-validate wording
  (with your progress summary appended when given).
- Creates an operation record so the submission stays auditable.

**What it does NOT do**:
- It does **NOT** mark the task completed — final acceptance
  (\`task_complete\`) belongs to the **default agent** (验收权分离, Task #5007).

**Goal self-check (design v2)**:
- Submitting **does** fire the completion goal-check hook once
  (\`terminalStatus="to_validate"\`) as a self-check gate — the
  decision model reviews your goals/operations at submission time.
  If it produces a hint, read it and address the gaps **before**
  ending your turn. The final acceptance (\`task_complete\`) does
  **not** re-run the goal check.

**After calling**:
- Push progress to 100 via \`task_update(progress=100)\` if not already,
  then **end your turn and return the result** to the main agent.
- The default agent will pick up the notification, verify the goals
  item-by-item, and call \`task_complete\` (or re-delegate on gaps).

**Parameters**:
- \`task_id\` (required): the task to submit
- \`deliverable_storage_path\` (optional): where the work product lives
  (file path / Feishu doc URL / git branch / PR URL ...)
- \`current_status\` (optional): a one-line progress summary shown to the
  acceptance side (e.g. "实现完成，测试全绿")

**Restrictions**:
- Cannot pre-complete cycle-type tasks (they are periodic).
`.trim();

export function preCompleteTaskTool(taskComponent: TaskComponent): Tool {
  return {
    name: "task_pre_complete",
    description: TASK_PRE_COMPLETE_DESCRIPTION,
    parameters: PreCompleteTaskToolSchema,
    execute: async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const params = PreCompleteTaskToolSchema.parse(args);
      const sessionId = ctx.session_id || "unknown";

      try {
        const task = await taskComponent.preCompleteTask(
          params.task_id,
          sessionId,
          params.deliverable_storage_path,
          params.current_status,
        );
        if (!task) {
          return {
            success: false,
            output: "",
            error: `Task not found: ${params.task_id}`,
            metadata: { execution_time_ms: 0 },
          };
        }

        return {
          success: true,
          output: params.deliverable_storage_path
            ? `Task submitted for acceptance (to_validate): #${task.id} - ${task.title}\nDeliverable (context + operation): ${params.deliverable_storage_path}`
            : `Task submitted for acceptance (to_validate): #${task.id} - ${task.title}\nDeliverable: (no path provided)`,
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
