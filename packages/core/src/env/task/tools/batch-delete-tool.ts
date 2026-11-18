/**
 * @fileoverview Task Batch Delete Tool
 *
 * 批量删除工具。将多个任务一次性删除。
 * 用于任务整理场景（如 task-organizer agent）快速清理测试/临时任务。
 */

import type { Tool, ToolContext, ToolResult } from "../../tool/types";
import { BatchDeleteToolSchema, type BatchDeleteToolParams } from "./task-types";
import type { TaskComponent } from "../task-component";

export function batchDeleteTaskTool(taskComponent: TaskComponent): Tool {
  return {
    name: "task_batch_delete",
    description:
      "Batch delete multiple tasks at once. Deletes each task and all its " +
      "operation records.\n\n" +
      "Use this when you need to quickly remove a group of test, temporary, " +
      "or otherwise worthless tasks (e.g., during task organization).\n\n" +
      "Returns summary of how many tasks were successfully deleted " +
      "and any errors encountered.",
    parameters: BatchDeleteToolSchema,
    execute: async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const params = BatchDeleteToolSchema.parse(args) as BatchDeleteToolParams;
      const taskIds = params.task_ids;

      if (!taskIds || taskIds.length === 0) {
        return {
          success: true,
          output: JSON.stringify({ deleted_count: 0, errors: [] }),
          metadata: { execution_time_ms: 0 },
        };
      }

      const results: { id: number; success: boolean; error?: string }[] = [];
      let deletedCount = 0;

      for (const taskId of taskIds) {
        try {
          const deleted = await taskComponent.deleteTask(taskId);
          if (deleted) {
            deletedCount++;
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
          deleted_count: deletedCount,
          total: taskIds.length,
          errors: results.filter(r => !r.success).map(r => ({ id: r.id, error: r.error })),
          results,
        }, null, 2),
        metadata: { execution_time_ms: 0 },
      };
    },
  };
}
