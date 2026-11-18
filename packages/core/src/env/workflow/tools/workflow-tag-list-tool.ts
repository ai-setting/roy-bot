/**
 * @fileoverview Workflow Tag List Tool (v3)
 *
 * MCP tool for listing all existing workflow tags from the workflow_tags table.
 *
 * Design goal: Let agents discover the existing tag pool BEFORE calling
 * `workflow_add`, so they can:
 *   1. Reuse existing tags for semantic consistency
 *   2. Avoid accidental fragmentation (many near-duplicate tags)
 *
 * Strategy A (soft prompt): We do NOT hard-reject new tags. This tool only
 * exposes what's already in the pool. The agent decides whether to reuse or
 * create new tags, guided by the soft prompt in `workflow_add` description.
 *
 * Sort options:
 *   - usage_count (default DESC) — most-used tags first
 *   - name (default ASC) — alphabetical
 *   - created_at (default DESC) — newest first
 */

import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../../tool/types";
import type { WorkflowService } from "../service/workflow-service";
import { createLogger } from "../../log-trace/logger";
import { TracedAs } from "../../log-trace/decorator";

const logger = createLogger("workflow-tag-list-tool");

/**
 * Input schema for workflow_tag_list tool.
 *
 * All options have defaults so the agent can call with `{}` to get the
 * default top-100 most-used tags.
 */
export const WorkflowTagListInputSchema = z.object({
  sort_by: z
    .enum(["usage_count", "name", "created_at"])
    .default("usage_count")
    .describe("Sort field: usage_count (default), name, or created_at"),
  order: z
    .enum(["asc", "desc"])
    .default("desc")
    .describe("Sort order: desc (default) or asc"),
  limit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .describe("Max number of tags to return (default 100, max 1000)"),
});

export type WorkflowTagListInput = z.infer<typeof WorkflowTagListInputSchema>;

/**
 * Output structure returned to the agent.
 */
export interface WorkflowTagListOutput {
  tags: Array<{
    name: string;
    usage_count: number;
    created_at: string;
    updated_at: string;
  }>;
  total: number;
  hint: string;
}

/**
 * Helper class so we can attach @TracedAs as a method decorator.
 *
 * The decorator only works on class methods; we wrap the call into a method
 * to enable observability without altering the public Tool signature.
 */
class WorkflowTagListRunner {
  constructor(private service: WorkflowService) {}

  /**
   * Traced wrapper around WorkflowService.listTags.
   *
   * Falls back gracefully when the service does not have listTags
   * (e.g. older in-memory service instance).
   */
  @TracedAs("workflow.tool.tag_list", {
    recordParams: true,
    recordResult: false,
    log: false,
  })
  async run(options: {
    sortBy: "usage_count" | "name" | "created_at";
    order: "asc" | "desc";
    limit?: number;
  }): Promise<{
    tags: Array<{
      name: string;
      usage_count: number;
      created_at: string;
      updated_at: string;
    }>;
    total: number;
  }> {
    if (typeof this.service.listTags !== "function") {
      return { tags: [], total: 0 };
    }
    return await this.service.listTags(options);
  }
}

/**
 * Create a workflow_tag_list tool with the given WorkflowService.
 */
export function createWorkflowTagListTool(workflowService: WorkflowService): Tool {
  const runner = new WorkflowTagListRunner(workflowService);

  return {
    name: "workflow_tag_list",
    description:
      `List all existing workflow tags from the workflow_tags tag pool. ` +
      `⚠️ IMPORTANT: Call this tool BEFORE workflow_add to see available tags. ` +
      `When adding a new workflow, you should select tags from this pool to ensure ` +
      `semantic consistency. New tags will be auto-created if needed, but prefer existing ones. ` +
      `Returns tags sorted by usage_count DESC by default (most-used first).`,
    parameters: WorkflowTagListInputSchema,
    execute: async (args: unknown, _ctx: ToolContext): Promise<ToolResult> => {
      try {
        const params = WorkflowTagListInputSchema.parse(args) as WorkflowTagListInput;

        const result = await runner.run({
          sortBy: params.sort_by,
          order: params.order,
          limit: params.limit,
        });

        const output: WorkflowTagListOutput = {
          tags: result.tags,
          total: result.total,
          hint:
            "Select 1-3 tags from this list when calling workflow_add. Existing tags ensure semantic consistency across workflows.",
        };

        return {
          success: true,
          output: JSON.stringify(output, null, 2),
          metadata: { execution_time_ms: 0 },
        };
      } catch (error) {
        logger.error("Failed to list workflow tags", { error });
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