/**
 * @fileoverview Workflow Search Tool (v2)
 *
 * Search workflows by keyword + multi-tag AND filter.
 * Returns available_tags so the caller knows what tags exist.
 */

import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../../tool/types";
import type { WorkflowService } from "../service/workflow-service";
import { createLogger } from "../../log-trace/logger";

const logger = createLogger("workflow-search-tool");

/**
 * Input schema for workflow_search tool
 */
export const WorkflowSearchInputSchema = z.object({
  keyword: z.string().optional().describe("Search keyword in name and description (case-insensitive substring)"),
  tags: z.array(z.string()).optional().describe("Filter by tags (ALL must match - AND filter)"),
  limit: z.number().positive().optional().describe("Maximum number of results"),
  offset: z.number().min(0).optional().describe("Pagination offset"),
});

export type WorkflowSearchInput = z.infer<typeof WorkflowSearchInputSchema>;

/**
 * Create a workflow_search tool with the given WorkflowService
 */
export function createWorkflowSearchTool(workflowService: WorkflowService): Tool {
  return {
    name: "workflow_search",
    description: "Search workflows by keyword and/or tags. Multiple tags use AND filter. v2: returns available_tags so the caller knows what tags exist.",
    parameters: WorkflowSearchInputSchema,
    execute: async (args: unknown, _ctx: ToolContext): Promise<ToolResult> => {
      try {
        const params = WorkflowSearchInputSchema.parse(args) as WorkflowSearchInput;

        if (!params.keyword && (!params.tags || params.tags.length === 0)) {
          return {
            success: false,
            output: "",
            error: "At least one of 'keyword' or 'tags' must be provided",
            metadata: { execution_time_ms: 0 },
          };
        }

        const result = await workflowService.searchWorkflowsWithTags({
          keyword: params.keyword,
          tags: params.tags,
          limit: params.limit,
          offset: params.offset,
        });

        return {
          success: true,
          output: JSON.stringify({
            workflows: result.workflows.map(w => ({
              name: w.name,
              version: w.version,
              description: w.description,
              tags: w.tags,
              createdAt: w.createdAt,
              updatedAt: w.updatedAt,
            })),
            available_tags: result.available_tags,
            total: result.total,
            count: result.workflows.length,
            keyword: params.keyword,
            tags: params.tags,
            limit: params.limit,
            offset: params.offset,
          }, null, 2),
          metadata: { execution_time_ms: 0 },
        };
      } catch (error) {
        logger.error("Failed to search workflows", { error });
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