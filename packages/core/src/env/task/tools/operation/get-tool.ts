/**
 * @fileoverview Operation Get Tool
 */

import type { Tool, ToolContext, ToolResult } from "../../../tool/types";
import { GetOperationToolSchema, type GetOperationToolParams } from "./operation-types";
import type { TaskComponent } from "../../task-component";

export function getOperationTool(taskComponent: TaskComponent): Tool {
  return {
    name: "task_operation_get",
    description: "Get a single operation record by ID.",
    parameters: GetOperationToolSchema,
    execute: async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const params = GetOperationToolSchema.parse(args) as GetOperationToolParams;
      
      try {
        const operation = await taskComponent.getOperation(params.operation_id);
        if (!operation) {
          return { 
            success: false, 
            output: "", 
            error: `Operation not found: ${params.operation_id}`,
            metadata: { execution_time_ms: 0 },
          };
        }
        
        return { 
          success: true, 
          output: JSON.stringify(operation, null, 2),
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
