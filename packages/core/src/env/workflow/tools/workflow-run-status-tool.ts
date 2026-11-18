/**
 * @fileoverview Workflow Run Status Tool
 * 
 * Query the status of a workflow run by run/session ID.
 */

import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../../tool/types";
import type { WorkflowService } from "../service/workflow-service";
import type { WorkflowSessionMetadata } from "../service/workflow-service";
import { createLogger } from "../../log-trace/logger";

const logger = createLogger("workflow-run-status-tool");

/**
 * Input schema for workflow_run_status tool
 */
export const WorkflowRunStatusInputSchema = z.object({
  run_id: z.string().describe("Run/session ID to query status"),
});

export type WorkflowRunStatusInput = z.infer<typeof WorkflowRunStatusInputSchema>;

/**
 * Create a workflow_run_status tool with the given WorkflowService
 * 
 * @param workflowService - The WorkflowService instance for querying run status
 * @returns A Tool instance for checking workflow run status
 */
export function createWorkflowRunStatusTool(workflowService: WorkflowService): Tool {
  return {
    name: "workflow_run_status",
    description: "Query the status of a workflow run by run_id. Returns run_id, status, output, error, and progress information.",
    parameters: WorkflowRunStatusInputSchema,
    execute: async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const params = WorkflowRunStatusInputSchema.parse(args) as WorkflowRunStatusInput;

      try {
        const session = await workflowService.getSession(params.run_id);
        if (!session) {
          return {
            success: false,
            output: "",
            error: `Run not found: ${params.run_id}`,
            metadata: { execution_time_ms: 0 },
          };
        }

        const metadata = session.metadata as WorkflowSessionMetadata | undefined;

        // Get messages for progress estimation
        let messages: any[] = [];
        try {
          messages = await workflowService.getSessionMessages(params.run_id);
        } catch {
          // messages are optional
        }

        return {
          success: true,
          output: JSON.stringify({
            run_id: session.id,
            title: session.title,
            status: metadata?.status || "unknown",
            workflow_name: metadata?.workflowName,
            workflow_version: metadata?.workflowVersion,
            input: metadata?.input,
            created_at: session.createdAt,
            updated_at: session.updatedAt,
            message_count: messages.length,
          }, null, 2),
          metadata: { execution_time_ms: 0 },
        };
      } catch (error) {
        logger.error("Failed to get run status", { error });
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
