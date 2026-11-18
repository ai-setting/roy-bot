/**
 * @fileoverview Task Batch Archive Tool
 *
 * 批量归档任务工具。将多个任务一次性设为 archived 状态。
 * 用于任务整理场景（如 task-organizer agent）快速清理已完成的历史任务。
 */

import type { Tool, ToolContext, ToolResult } from "../../tool/types";
import { BatchArchiveToolSchema, type BatchArchiveToolParams } from "./task-types";
import type { TaskComponent } from "../task-component";
// ★ Task #5063 — 归档态 current_status 措辞同源锚点（与 TaskComponent 共用）
import { TASK_ARCHIVED_STATUS_WORD } from "./completion-copy";

export function batchArchiveTaskTool(taskComponent: TaskComponent): Tool {
  return {
    name: "task_batch_archive",
    description:
      "Batch archive multiple tasks at once. Sets all specified tasks to " +
      "'archived' status and creates operation records for each.\n\n" +
      "Use this when you need to quickly archive a group of completed, " +
      "obsolete, or historical tasks (e.g., during task organization).\n\n" +
      "Returns summary of how many tasks were successfully archived " +
      "and any errors encountered.",
    parameters: BatchArchiveToolSchema,
    execute: async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const params = BatchArchiveToolSchema.parse(args) as BatchArchiveToolParams;
      const taskIds = params.task_ids;
      const sessionId = ctx.session_id || "batch-archive";

      if (!taskIds || taskIds.length === 0) {
        return {
          success: true,
          output: JSON.stringify({ archived_count: 0, errors: [] }),
          metadata: { execution_time_ms: 0 },
        };
      }

      const results: { id: number; success: boolean; error?: string }[] = [];
      let archivedCount = 0;

      for (const taskId of taskIds) {
        try {
          // ★ Task #5063 — 归档时**显式**同步 current_status。
          // TaskComponent.updateTask 已能兜底派生（终态收口），但批量归档
          // 是「任务整理」场景 —— 归档原因（reason）本身就是有用的终态文案，
          // 在这里显式写出来，比兜底的裸「已归档」信息量更大。
          // 措辞同源锚点见 tools/completion-copy.ts。
          const task = await taskComponent.updateTask(taskId, {
            status: "archived",
            current_status: params.reason
              ? `${TASK_ARCHIVED_STATUS_WORD}：${params.reason}`
              : TASK_ARCHIVED_STATUS_WORD,
          });
          if (task) {
            await taskComponent.createOperation({
              taskId,
              sessionId,
              actionType: "completed",
              actionTitle: "Batch archived",
              actionDescription: params.reason || "批量归档（任务整理）",
            });
            archivedCount++;
            results.push({ id: taskId, success: true });
          } else {
            results.push({ id: taskId, success: false, error: "Task not found" });
          }
        } catch (error) {
          results.push({
            id: taskId,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const hasErrors = results.some(r => !r.success);

      return {
        success: !hasErrors,
        output: JSON.stringify({
          archived_count: archivedCount,
          total: taskIds.length,
          errors: results.filter(r => !r.success).map(r => ({ id: r.id, error: r.error })),
          results,
        }, null, 2),
        metadata: { execution_time_ms: 0 },
      };
    },
  };
}
