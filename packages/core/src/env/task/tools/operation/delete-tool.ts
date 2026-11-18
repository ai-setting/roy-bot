/**
 * @fileoverview Operation Delete Tool
 */

import type { Tool, ToolContext, ToolResult } from "../../../tool/types";
import { DeleteOperationToolSchema, type DeleteOperationToolParams } from "./operation-types";
import type { TaskComponent } from "../../task-component";

export function deleteOperationTool(taskComponent: TaskComponent): Tool {
  return {
    name: "task_operation_delete",
    description: "Delete an operation record.",
    parameters: DeleteOperationToolSchema,
    execute: async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const params = DeleteOperationToolSchema.parse(args) as DeleteOperationToolParams;
      
      try {
        const deleted = await taskComponent.deleteOperation(params.operation_id);
        if (!deleted) {
          return { 
            success: false, 
            output: "", 
            error: `Operation not found: ${params.operation_id}`,
            metadata: { execution_time_ms: 0 },
          };
        }
        
        return {
          success: true,
          output: `Operation deleted: #${params.operation_id}`,
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
