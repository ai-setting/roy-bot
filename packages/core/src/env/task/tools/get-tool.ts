/**
 * @fileoverview Task Get Tool
 */

import type { Tool, ToolContext, ToolResult } from "../../tool/types";
import { GetTaskToolSchema, type GetTaskToolParams } from "./task-types";
import type { TaskComponent } from "../task-component";

export function getTaskTool(taskComponent: TaskComponent): Tool {
  return {
    name: "task_get",
    description: "Get task details by ID. Optionally include operation records.",
    parameters: GetTaskToolSchema,
    execute: async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const params = GetTaskToolSchema.parse(args) as GetTaskToolParams;
      
      try {
        if (params.include_operations) {
          const result = await taskComponent.getTaskWithOperations(params.task_id);
          if (!result) {
            return {
              success: false,
              output: "",
              error: `Task not found: ${params.task_id}`,
              metadata: { execution_time_ms: 0 },
            };
          }
          // Task #4619 (cross-validation M-2): the response is **flat** —
          // `{ ...task, operations }`.
          //
          // The old plugin's `taskGet` returned exactly that, and it is what
          // every client written against the published plugin reads
          // (`task.title`, `task.operations`). Nesting would move every task
          // field one level down — just as breaking as dropping the
          // operations.
          //
          // Both backends now agree on the flat shape
          // (`TaskComponent.getTaskWithOperations` and
          // `TaskStoreBackend.getTaskWithOperations`). The `task` property
          // is tolerated for a backend that still nests, so a host that binds
          // its own port cannot silently lose the task fields.
          const nested = (result as { task?: unknown }).task;
          const flat =
            nested && typeof nested === "object"
              ? { ...(nested as Record<string, unknown>), operations: result.operations }
              : (result as unknown as Record<string, unknown>);
          return {
            success: true,
            output: JSON.stringify(flat, null, 2),
            metadata: { execution_time_ms: 0 },
          };
        } else {
          const task = await taskComponent.getTask(params.task_id);
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
            output: JSON.stringify(task, null, 2),
            metadata: { execution_time_ms: 0 },
          };
        }
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
