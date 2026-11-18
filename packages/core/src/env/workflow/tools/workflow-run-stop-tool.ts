/**
 * @fileoverview Workflow Run Stop Tool
 * 
 * Stop a running workflow by run/session ID.
 */

import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../../tool/types";
import type { WorkflowService } from "../service/workflow-service";
import { createLogger } from "../../log-trace/logger";

const logger = createLogger("workflow-run-stop-tool");

/**
 * Input schema for workflow_run_stop tool
 */
export const WorkflowRunStopInputSchema = z.object({
  run_id: z.string().describe("Run/session ID to stop"),
  reason: z.string().optional().describe("Optional reason for stopping the workflow"),
});

export type WorkflowRunStopInput = z.infer<typeof WorkflowRunStopInputSchema>;

/**
 * Create a workflow_run_stop tool with the given WorkflowService
 * 
 * @param workflowService - The WorkflowService instance for stopping workflow runs
 * @returns A Tool instance for stopping workflow runs
 */
export function createWorkflowRunStopTool(workflowService: WorkflowService): Tool {
  return {
    name: "workflow_run_stop",
    description: "Stop a running workflow by run_id. Optionally provide a reason. Returns success status.",
    parameters: WorkflowRunStopInputSchema,
    execute: async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const params = WorkflowRunStopInputSchema.parse(args) as WorkflowRunStopInput;

      try {
        await workflowService.stopRun(params.run_id, params.reason);

        return {
          success: true,
          output: JSON.stringify({
            success: true,
            run_id: params.run_id,
            status: "stopped",
            reason: params.reason || undefined,
          }, null, 2),
          metadata: { execution_time_ms: 0 },
        };
      } catch (error) {
        logger.error("Failed to stop workflow run", { error });
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
