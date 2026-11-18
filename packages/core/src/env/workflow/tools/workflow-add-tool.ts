/**
 * @fileoverview Workflow Add Tool
 *
 * MCP tool for creating a new workflow.
 * Tags are required (1-3), validated at multiple levels:
 *   - Zod schema (count bounds, type)
 *   - Per-element: empty string / contains comma (post-parse)
 *   - Name consistency between `name` and `definition.name`
 *
 * v2: works with TagRepository via service.createWorkflow (transactional);
 * returns available_tags from the tag table.
 *
 * v3: Soft-prompt description encourages agents to call `workflow_tag_list`
 * FIRST to discover existing tags, then prefer reusing them for semantic
 * consistency. New tags are still auto-created (Strategy A: no hard validation).
 */

import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../../tool/types";
import type { WorkflowService } from "../service/workflow-service";
import { TAG_MIN_COUNT, TAG_MAX_COUNT } from "../service/workflow-service";
import { createLogger } from "../../log-trace/logger";
import { validateWorkflowDefinition } from "../utils/validate-workflow-definition";
import yaml from "yaml";

const logger = createLogger("workflow-add-tool");

/**
 * Input schema for workflow_add tool.
 * Note: `tags` is required (Zod enforces 1-3 min/max bounds).
 */
export const WorkflowAddInputSchema = z.object({
  definition: z
    .any()
    .optional()
    .describe("Workflow definition object (alternative to definition_yaml)"),
  definition_yaml: z
    .string()
    .optional()
    .describe("Workflow definition as YAML or JSON string"),
  name: z
    .string()
    .min(1)
    .optional()
    .describe("Workflow name (must match definition.name when both provided)"),
  description: z
    .string()
    .optional()
    .describe("Workflow description (overrides definition_yaml description)"),
  tags: z
    .array(z.string())
    .min(TAG_MIN_COUNT, `Workflow requires at least ${TAG_MIN_COUNT} tag`)
    .max(TAG_MAX_COUNT, `Workflow supports at most ${TAG_MAX_COUNT} tags`)
    .describe(
      `Tags (${TAG_MIN_COUNT}-${TAG_MAX_COUNT} required). ` +
        `STRONGLY RECOMMENDED: select from existing tag pool via workflow_tag_list ` +
        `to ensure semantic consistency. ` +
        `Format: lowercase or kebab-case preferred (e.g. "ai", "data-pipeline").`
    ),
});

export type WorkflowAddInput = z.infer<typeof WorkflowAddInputSchema>;

/**
 * Parse a definition from either YAML or JSON string.
 */
function parseDefinitionYaml(content: string): any {
  try {
    const parsed = yaml.parse(content);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch {
    // fall through to JSON
  }
  try {
    return JSON.parse(content);
  } catch {
    throw new Error("definition_yaml is not valid YAML or JSON");
  }
}

/**
 * Create a workflow_add tool with the given WorkflowService.
 */
export function createWorkflowAddTool(workflowService: WorkflowService): Tool {
  return {
    name: "workflow_add",
    description:
      `Create a new workflow. Tags are required (${TAG_MIN_COUNT}-${TAG_MAX_COUNT}). ` +
      `⚠️ IMPORTANT: Before calling this tool, you MUST call workflow_tag_list first ` +
      `to retrieve the existing tag pool. ` +
      `Select tags from this pool to ensure semantic consistency across workflows. ` +
      `New tags will be auto-created if not in the pool, but prefer existing ones when possible.`,
    parameters: WorkflowAddInputSchema,
    execute: async (args: unknown, _ctx: ToolContext): Promise<ToolResult> => {
      try {
        const params = WorkflowAddInputSchema.parse(args) as WorkflowAddInput;

        // Per-element validation (empty string / contains comma) — produce friendly errors.
        // Also handle "tags missing entirely" as a clearer error before Zod's generic message.
        if (!Array.isArray(params.tags) || params.tags.length === 0) {
          return {
            success: false,
            output: "",
            error: "Workflow requires at least 1 tag (got empty)",
            metadata: { execution_time_ms: 0 },
          };
        }
        for (let i = 0; i < params.tags.length; i++) {
          const t = params.tags[i] ?? "";
          if (typeof t !== "string" || t.trim().length === 0) {
            return {
              success: false,
              output: "",
              error: `tag at index ${i} is empty`,
              metadata: { execution_time_ms: 0 },
            };
          }
          if (t.includes(",")) {
            return {
              success: false,
              output: "",
              error: `tag "${t}" contains comma; pass them as separate --tags`,
              metadata: { execution_time_ms: 0 },
            };
          }
        }

        // Resolve definition (object > YAML > none)
        let definition: any = {};
        if (params.definition && typeof params.definition === "object") {
          // Validate name consistency BEFORE assignment
          if (
            params.definition.name &&
            params.name &&
            params.definition.name !== params.name
          ) {
            return {
              success: false,
              output: "",
              error: `definition.name ('${params.definition.name}') does not match name ('${params.name}')`,
              metadata: { execution_time_ms: 0 },
            };
          }
          definition = params.definition;
        } else if (params.definition_yaml) {
          try {
            definition = parseDefinitionYaml(params.definition_yaml);
          } catch (e) {
            return {
              success: false,
              output: "",
              error: e instanceof Error ? e.message : String(e),
              metadata: { execution_time_ms: 0 },
            };
          }
        } else {
          return {
            success: false,
            output: "",
            error:
              "definition is required (provide `definition` object, `definition_yaml`, or just `name`)",
            metadata: { execution_time_ms: 0 },
          };
        }

        // Apply top-level overrides only if they don't conflict
        if (params.name && !definition.name) {
          definition.name = params.name;
        }
        if (params.description && !definition.description) {
          definition.description = params.description;
        }

        // Final sanity check
        if (!definition.name) {
          return {
            success: false,
            output: "",
            error: "definition must have a `name` field",
            metadata: { execution_time_ms: 0 },
          };
        }

        // DAG validation gate: refuse to create workflows with structural errors
        // (duplicate node IDs, missing dependencies, cycles, empty node IDs).
        // Defense-in-depth: callers should have already validated via workflow_validate,
        // but this prevents pollution of the database from any path that bypasses it.
        const validation = validateWorkflowDefinition(definition);
        if (!validation.valid) {
          return {
            success: false,
            output: "",
            error: `Validation failed: ${validation.errors.join("; ")}`,
            metadata: { execution_time_ms: 0 },
          };
        }

        // Invoke service (runs in a transaction: workflow create + tag upsert)
        const workflow = await workflowService.createWorkflow(definition, {
          tags: params.tags,
        });

        // Read available_tags from tag table via service
        const availableTags =
          (workflowService as any).tagRepository?.list?.()?.map(
            (t: { name: string; usage_count: number }) => ({
              name: t.name,
              count: t.usage_count,
            })
          ) ?? [];

        return {
          success: true,
          output: JSON.stringify(
            {
              workflow: {
                name: workflow.name,
                version: workflow.version,
                description: workflow.description,
                tags: workflow.tags,
                created_at: workflow.createdAt,
              },
              available_tags: availableTags,
            },
            null,
            2
          ),
          metadata: { execution_time_ms: 0 },
        };
      } catch (error) {
        // Zod validation errors — extract friendly messages
        if (
          error &&
          typeof error === "object" &&
          "issues" in error &&
          Array.isArray((error as any).issues)
        ) {
          const zodError = error as any;
          const messages = zodError.issues.map(
            (i: any) => i.message ?? "validation failed"
          );
          return {
            success: false,
            output: "",
            error: messages.join("; "),
            metadata: { execution_time_ms: 0 },
          };
        }
        logger.error("Failed to add workflow", { error });
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
