/**
 * @fileoverview Task Delete Tool
 */

import type { Tool, ToolContext, ToolResult } from "../../tool/types";
import { DeleteTaskToolSchema, type DeleteTaskToolParams } from "./task-types";
import type { TaskComponent } from "../task-component";

export function deleteTaskTool(taskComponent: TaskComponent): Tool {
  return {
    name: "task_delete",
    description: "Delete a task and all its operation records.",
    parameters: DeleteTaskToolSchema,
    execute: async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const params = DeleteTaskToolSchema.parse(args) as DeleteTaskToolParams;
      
      try {
        const deleted = await taskComponent.deleteTask(params.task_id);
        if (!deleted) {
          return { 
            success: false, 
            output: "", 
            error: `Task not found: ${params.task_id}`,
            metadata: { execution_time_ms: 0 },
          };
        }
        
        return {
          success: true,
          output: `Task deleted: #${params.task_id}`,
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
