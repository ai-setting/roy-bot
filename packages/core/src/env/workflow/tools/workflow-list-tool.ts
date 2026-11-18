/**
 * @fileoverview Workflow List Tool
 *
 * List all registered workflows with optional filtering.
 * v2: 返回 available_tags（按 usage_count DESC, name ASC）
 *
 * JSON output shape (Code Review #1479 follow-up — aligned with CLI path):
 *
 *   {
 *     "total":          <number>,         // FIRST so it survives tail-truncation
 *     "count":          <number>,
 *     "truncated":      <boolean>,        // total > count
 *     "limit":          <number>,         // requested page size
 *     "offset":         <number>,
 *     "page":           <number>,         // 1-based page number (passthrough or default 1)
 *     "available_tags": [...],            // metadata block tail
 *     "workflows":      [...]             // LAST so the array is the truncation target
 *   }
 *
 * Keep this shape in sync with:
 *   - packages/cli/src/commands/workflow/commands/list.ts (CLI path: buildListWorkflowsJson)
 */

import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../../tool/types";
import type { WorkflowService, ListOptions } from "../service/workflow-service";
import type { Workflow } from "../types/workflow";
import { createLogger } from "../../log-trace/logger";

const logger = createLogger("workflow-list-tool");

/**
 * Input schema for workflow_list tool
 */
export const WorkflowListInputSchema = z.object({
  tag: z.string().optional().describe("Filter by single tag (legacy single-tag filter)"),
  tags: z.array(z.string()).optional().describe("Filter by multiple tags (AND)"),
  search: z.string().optional().describe("Search workflows by keyword"),
  limit: z.number().positive().optional().describe("Maximum number of results to return"),
  offset: z.number().min(0).optional().describe("Offset for pagination"),
  page: z.number().int().min(1).optional().describe("1-based page number (optional; defaults to 1)"),
});

export type WorkflowListInput = z.infer<typeof WorkflowListInputSchema>;

/**
 * Project a Workflow (service layer) to the wire shape used in tool output.
 */
function projectWorkflow(w: Workflow) {
  return {
    name: w.name,
    version: w.version,
    description: w.description,
    tags: w.tags,
    created_at: w.createdAt,
  };
}

/**
 * Build the canonical JSON output object for the workflow_list tool.
 *
 * Pure function — does NOT touch stdout; the caller wraps it in
 * `JSON.stringify(...)`. Kept in one place so the key order is
 * auditable in code (not just enforced by tests).
 *
 * @param result       - Service result containing workflows, available_tags, total.
 * @param params       - Resolved tool input params (limit/offset/page).
 */
function buildListToolOutput(result: {
  workflows: any[];
  available_tags: { name: string; count: number }[];
  total: number;
}, params: WorkflowListInput) {
  // IMPORTANT: `total` MUST be the first key in the JSON output.
  // ToolComponent.truncateOutput tail-truncates long outputs
  // (configurable via tool.execution.maxOutputSize). If `total`
  // were at the end, it could be lost when the result is large
  // (>20 workflows), causing LLM/CLI to misjudge workflow list size.
  return {
    total: result.total,
    count: result.workflows.length,
    truncated: result.total > result.workflows.length,
    limit: params.limit,
    offset: params.offset,
    // `page` is a new optional passthrough. Defaults to 1 when the caller
    // (e.g. legacy CLI or direct agent call) doesn't supply it.
    page: params.page ?? 1,
    available_tags: result.available_tags,
    // IMPORTANT: `workflows` is last so it's the truncation target, not
    // the summary metadata that precedes it.
    workflows: result.workflows.map(projectWorkflow),
  };
}

/**
 * Create a workflow_list tool with the given WorkflowService
 */
export function createWorkflowListTool(workflowService: WorkflowService): Tool {
  return {
    name: "workflow_list",
    description:
      "List all registered workflows with optional filtering. " +
      "Returns canonical JSON shape (Code Review #1479 follow-up): " +
      "`total` (filtered count BEFORE pagination), `count` (returned count), `truncated` (true when total > count), " +
      "`limit`, `offset`, `page` (1-based page number; defaults to 1), `available_tags` (sorted by usage_count DESC), " +
      "and `workflows` (the array, always LAST so downstream tail-truncation strips it rather than the metadata). " +
      "Multi-tag filter uses AND logic. " +
      "💡 TIP: The `available_tags` field tells you what tags already exist. " +
      "Before calling `workflow_add` with new tags, call `workflow_tag_list` to discover " +
      "existing tags and prefer reusing them for semantic consistency " +
      "(e.g. reuse 'ci-cd' rather than creating 'continuous-integration'). " +
      "Avoid tag proliferation is a design goal — limit the number of distinct tags in the pool.",
    parameters: WorkflowListInputSchema,
    execute: async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const params = WorkflowListInputSchema.parse(args) as WorkflowListInput;

      try {
        // Fix #1: derive effective offset from `page` (1-based) so that
        // passing { page: 3, limit: 10 } actually returns the third page,
        // not just the first 10 items with a misleading `page: 3` in the
        // response. If `page` is not supplied, fall back to `offset`.
        const effectivePage = params.page ?? 1;
        const effectiveOffset =
          params.offset !== undefined
            ? params.offset
            : (effectivePage - 1) * (params.limit ?? 20);

        const options: ListOptions = {};
        if (params.tag !== undefined) options.tag = params.tag;
        if (params.search !== undefined) options.search = params.search;
        if (params.limit !== undefined) options.limit = params.limit;
        if (effectiveOffset !== 0) options.offset = effectiveOffset;

        // v2: 使用 listWorkflowsWithTags 同时返回 available_tags
        // 当 tags[] 给出时，service 走 searchWorkflowsWithTags 路径（AND）
        if (params.tags && params.tags.length > 0) {
          const result = workflowService.searchWorkflowsWithTags
            ? await workflowService.searchWorkflowsWithTags({
                tags: params.tags,
                limit: params.limit,
                offset: effectiveOffset,
              })
            : {
                // Fix #2: fallback path must use the SAME filtering as
                // searchWorkflowsWithTags and report a real `total` so the
                // `truncated` flag is meaningful. We use the limit-less
                // result length as the global filtered count.
                workflows: workflowService.searchWorkflows({
                  tags: params.tags,
                  limit: params.limit,
                  offset: effectiveOffset,
                }),
                available_tags: [],
                total: workflowService.searchWorkflows({
                  tags: params.tags,
                }).length,
              };
          return {
            success: true,
            output: JSON.stringify(buildListToolOutput(result, params), null, 2),
            metadata: { execution_time_ms: 0 },
          };
        }

        const result = workflowService.listWorkflowsWithTags
          ? await workflowService.listWorkflowsWithTags(options)
          : {
              // Fix #2: same as above — fallback total must reflect the
              // un-paginated filtered count, not 0.
              workflows: workflowService.listWorkflows(options),
              available_tags: [],
              total: workflowService.listWorkflows({
                tag: options.tag,
                search: options.search,
              }).length,
            };

        return {
          success: true,
          output: JSON.stringify(buildListToolOutput(result, params), null, 2),
          metadata: { execution_time_ms: 0 },
        };
      } catch (error) {
        logger.error("Failed to list workflows", { error });
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