/**
 * @fileoverview Workflow Get Tool
 * 
 * Get workflow definition details or run status by name or run_id.
 */

import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../../tool/types";
import type { WorkflowService } from "../service/workflow-service";
import { createLogger } from "../../log-trace/logger";

const logger = createLogger("workflow-get-tool");

/**
 * Input schema for workflow_get tool
 */
export const WorkflowGetInputSchema = z.object({
  name: z.string().optional().describe("Workflow name to get definition details"),
  run_id: z.string().optional().describe("Run/session ID to get run status"),
});

export type WorkflowGetInput = z.infer<typeof WorkflowGetInputSchema>;

/**
 * Create a workflow_get tool with the given WorkflowService
 * 
 * @param workflowService - The WorkflowService instance for querying workflows
 * @returns A Tool instance for getting workflow details
 */
export function createWorkflowGetTool(workflowService: WorkflowService): Tool {
  return {
    name: "workflow_get",
    description: "Get workflow definition details by name, or run status by run_id. Returns workflow name, version, description, inputs schema, and node list.",
    parameters: WorkflowGetInputSchema,
    // workflow_get returns the complete workflow definition. The default 5KB
    // truncation cap would silently destroy payloads like the roy-rd
    // pipeline definitions (>60KB), so opt out via metadata.
    metadata: { skipTruncation: true },
    execute: async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const params = WorkflowGetInputSchema.parse(args) as WorkflowGetInput;

      try {
        if (params.run_id) {
          // Get run/session status
          const session = await workflowService.getSession(params.run_id);
          if (!session) {
            return {
              success: false,
              output: "",
              error: `Run not found: ${params.run_id}`,
              metadata: { execution_time_ms: 0 },
            };
          }

          // Get messages for additional context
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
              status: session.metadata?.status,
              workflow_name: session.metadata?.workflowName,
              workflow_version: session.metadata?.workflowVersion,
              input: session.metadata?.input,
              created_at: session.createdAt,
              updated_at: session.updatedAt,
              message_count: messages.length,
            }, null, 2),
            metadata: { execution_time_ms: 0 },
          };
        }

        if (params.name) {
          // Get workflow definition
          const workflow = workflowService.getWorkflowByName(params.name);
          if (!workflow) {
            return {
              success: false,
              output: "",
              error: `Workflow not found: ${params.name}`,
              metadata: { execution_time_ms: 0 },
            };
          }

          return {
            success: true,
            output: JSON.stringify({
              name: workflow.name,
              version: workflow.version,
              description: workflow.description,
              inputs: workflow.definition.inputs,
              definition: workflow.definition,
              config: workflow.definition.config,
              tags: workflow.tags,
              created_at: workflow.createdAt,
              updated_at: workflow.updatedAt,
            }, null, 2),
            metadata: { execution_time_ms: 0 },
          };
        }

        return {
          success: false,
          output: "",
          error: "Either 'name' or 'run_id' must be provided",
          metadata: { execution_time_ms: 0 },
        };
      } catch (error) {
        logger.error("Failed to get workflow info", { error });
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
