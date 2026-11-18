/**
 * @fileoverview Task Search Tool
 *
 * Searches tasks by keywords across title, description, goals, tags, and
 * operation records. Returns `{ tasks, total }` for pagination.
 */

import type { Tool, ToolContext, ToolResult } from "../../tool/types";
import { SearchTasksToolSchema, type SearchTasksToolParams } from "./task-types";
import type { TaskComponent } from "../task-component";

export function searchTasksTool(taskComponent: TaskComponent): Tool {
  return {
    name: "task_search",
    description:
      "Search tasks by keywords across title, description, goals, tags, and " +
      "operation records. Use this when you need to find tasks related to a " +
      "topic, feature, bug, or area of work — even when the keyword is only " +
      "in description / goals / tags / past operation logs.\n\n" +
      "Returns { tasks, total, limit, offset } so you can paginate large result sets.\n\n" +
      "If `keywords` is empty, returns no results.",
    parameters: SearchTasksToolSchema,
    execute: async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const params = SearchTasksToolSchema.parse(args) as SearchTasksToolParams;

      try {
        const result = await taskComponent.searchTasksByKeywords(
          params.keywords,
          {
            limit: params.limit,
            offset: params.offset,
            excludeTaskId: params.exclude_task_id,
            status: params.status,
            priority: params.priority,
            type: params.type,
            depth: params.depth,
            include_archived: params.include_archived,
          }
        );

        return {
          success: true,
          output: JSON.stringify({
            tasks: result.tasks,
            total: result.total,
            limit: params.limit,
            offset: params.offset,
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
