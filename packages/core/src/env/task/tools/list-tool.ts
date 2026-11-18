/**
 * @fileoverview Task List Tool
 */

import type { Tool, ToolContext, ToolResult } from "../../tool/types";
import { ListTasksToolSchema, type ListTasksToolParams } from "./task-types";
import type { TaskComponent } from "../task-component";

export function listTasksTool(taskComponent: TaskComponent): Tool {
  return {
    name: "task_list",
    description:
      "List tasks with optional filters for status, priority, type, parent_task_id, " +
      "and depth (hierarchy level). " +
      "depth: 0=只根任务（无父任务），1=根+一层子任务，2=根+二层子任务，-1 或忽略=全部。\n" +
      "Returns { total, count, truncated, limit, offset, depth, tasks } where:\n" +
      "  - total: count of all matching tasks BEFORE pagination\n" +
      "  - count: count of tasks in the returned `tasks` array (after pagination)\n" +
      "  - truncated: true when total > count (data was truncated by pagination)\n" +
      "Note: `total` is the FIRST field in the response so it survives tail-truncation " +
      "by ToolComponent.truncateOutput.",
    parameters: ListTasksToolSchema,
    execute: async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const params = ListTasksToolSchema.parse(args) as ListTasksToolParams;

      try {
        const result = await taskComponent.listTasks({
          status: params.status,
          priority: params.priority,
          type: params.type,
          limit: params.limit,
          offset: params.offset,
          depth: params.depth,
          include_archived: params.include_archived,
        });

        return {
          success: true,
          output: JSON.stringify({
            // IMPORTANT: `total` MUST be the first key in the JSON output.
            // ToolComponent.truncateOutput tail-truncates long outputs
            // (configurable via tool.execution.maxOutputSize). If `total`
            // were at the end, it could be lost when the result is large
            // (>20 tasks), causing LLM/CLI to misjudge task list size.
            total: result.total,
            count: result.tasks.length,
            truncated: result.total > result.tasks.length,
            limit: params.limit,
            offset: params.offset,
            depth: params.depth,
            tasks: result.tasks,
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
