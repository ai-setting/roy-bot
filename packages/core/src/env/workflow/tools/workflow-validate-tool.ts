/**
 * @fileoverview Workflow Validate Tool
 *
 * MCP tool for validating a workflow definition (YAML or JSON) without
 * persisting it.
 *
 * Layer 1 — DAG structure (DAGManager.validate()):
 *   - duplicate node IDs
 *   - missing dependencies
 *   - cycles
 *   - empty node IDs
 *
 * Layer 2 — Template-reference **contracts** (Task #4298):
 *   - does `{{nodes.X.<field>}}` match the output shape of node `X`?
 *   - e.g. `.result` on a `tool` node is an ERROR (the tool's stored output has
 *     no `result` field → the engine silently substitutes `''`), while `.output`
 *     is correct. Also reports unknown fields on nodes with a closed output
 *     contract (warning) and references to non-upstream nodes (info).
 *
 * Used by:
 * 1. The built-in 'workflow-extract' agent — iterative generate→validate→fix loop
 * 2. The built-in 'workflow-creator' agent — the same loop, driven by the
 *    actionable `errors` / `warnings` this tool returns
 * 3. task-tag-plugin — pre-flight check before workflowRepo.create() to avoid
 *    polluting the database with invalid workflows extracted from chat history
 *
 * The tool does NOT require a WorkflowService — it only parses the YAML and
 * runs the validator. The signature accepts WorkflowService for API consistency
 * with other workflow tools (workflow_get, workflow_list, etc.) but ignores it.
 */

import { z } from "zod";
import yaml from "yaml";
import type { Tool, ToolContext, ToolResult } from "../../tool/types";
import type { WorkflowService } from "../service/workflow-service";
import { createLogger } from "../../log-trace/logger";
import { validateWorkflowDefinition } from "../utils/validate-workflow-definition";

const logger = createLogger("workflow-validate-tool");

/**
 * Input schema for workflow_validate tool.
 *
 * Accepts `file` (path), `yaml`/`definition_yaml` (string) or `definition`
 * (object). Precedence: `definition` > `file` > `yaml` / `definition_yaml`.
 *
 * Task #4392 P0-4: `file` was added because the tool performs **no shell
 * expansion**, yet LLMs kept passing `yaml: "$(cat /tmp/x.yaml)"`. That string
 * is literal, YAML.parse returns a *string*, and the tool replied
 * `Parsed definition is not an object` — 30 of the 31 measured validate
 * failures in #4385 §2 C2.
 */
export const WorkflowValidateInputSchema = z.object({
  definition: z
    .any()
    .optional()
    .describe("Workflow definition object (alternative to definition_yaml)"),
  definition_yaml: z
    .string()
    .optional()
    .describe("Workflow definition as YAML or JSON string"),
  yaml: z
    .string()
    .optional()
    .describe("Alias for definition_yaml — workflow definition as YAML or JSON string"),
  file: z
    .string()
    .optional()
    .describe(
      "Path to a YAML/JSON file to validate. Use this INSTEAD of passing " +
        "`$(cat /path)` — shell substitutions are NOT expanded by this tool."
    ),
});

export type WorkflowValidateInput = z.infer<typeof WorkflowValidateInputSchema>;

/**
 * Directories a `file` argument is allowed to point at: the process CWD and its
 * descendants, plus `/tmp` (where agent-authored drafts live).
 */
function isAllowedPath(absPath: string): boolean {
  const cwd = process.cwd();
  const normalized = absPath.replace(/\\/g, "/");
  if (normalized === cwd || normalized.startsWith(`${cwd}/`)) return true;
  if (normalized === "/tmp" || normalized.startsWith("/tmp/")) return true;
  return false;
}

/**
 * Detect the `$(cat ...)` / backtick-cat anti-pattern in a YAML string.
 *
 * @returns A human-readable hint when detected, otherwise undefined.
 */
function detectShellSubstitution(text: string): string | undefined {
  const trimmed = text.trim();
  const looksLikeSubstitution =
    /^\$\(.*\)$/.test(trimmed) ||
    /^`.*`$/.test(trimmed) ||
    /\$\(\s*cat\s+/.test(trimmed) ||
    /`\s*cat\s+/.test(trimmed);

  if (!looksLikeSubstitution) return undefined;

  return (
    "Shell substitutions such as `$(cat /path)` are NOT expanded by this tool — the " +
    "string is passed to the YAML parser verbatim, which is why you saw " +
    "`Parsed definition is not an object`. Pass the path directly instead: " +
    'workflow_validate({ file: "/tmp/x.yaml" }).'
  );
}

/**
 * Create a workflow_validate tool with the given WorkflowService.
 *
 * Note: WorkflowService is required for API consistency with other workflow
 * tools but is NOT used by this tool — validation is pure (no DB lookup).
 */
export function createWorkflowValidateTool(_workflowService: WorkflowService): Tool {
  return {
    name: "workflow_validate",
    description:
      `Validate a workflow definition (YAML or JSON) without persisting it. ` +
      `Checks (1) DAG structure: duplicate node IDs, missing dependencies, cycles, empty node IDs; ` +
      `(2) template-reference contracts: whether {{nodes.X.<field>}} matches node X's output shape ` +
      `(e.g. {{nodes.<toolNode>.result}} is an ERROR — tool nodes expose ".output", not ".result"). ` +
      `Returns { valid, errors: string[], warnings?: string[], infos?: string[], workflowName?, ` +
      `nodeCount, errorCount, warningCount }. ` +
      `Use this BEFORE workflow_add; fix EVERY error (and evaluate each warning) before registering.`,
    parameters: WorkflowValidateInputSchema,
    execute: async (args: unknown, _ctx: ToolContext): Promise<ToolResult> => {
      try {
        const params = WorkflowValidateInputSchema.parse(args) as WorkflowValidateInput;

        // Resolve definition from object / file / yaml / definition_yaml.
        // Precedence (Task #4392 P0-4): definition > file > yaml/definition_yaml.
        let definition: any;
        if (params.definition && typeof params.definition === "object") {
          definition = params.definition;
        } else if (params.file && typeof params.file === "string") {
          const fs = await import("node:fs/promises");
          const nodePath = await import("node:path");
          const abs = nodePath.resolve(params.file);

          if (!isAllowedPath(abs)) {
            return {
              success: false,
              output: "",
              error:
                `Refusing to read outside the working directory or /tmp: ${abs}. ` +
                `Copy the file into CWD or /tmp first.`,
              metadata: { execution_time_ms: 0 },
            };
          }

          let raw: string;
          try {
            raw = await fs.readFile(abs, "utf-8");
          } catch (readErr) {
            const code = (readErr as NodeJS.ErrnoException)?.code;
            return {
              success: false,
              output: "",
              error:
                code === "ENOENT"
                  ? `Workflow file not found: ${abs}. Check the path (it is resolved against CWD: ${process.cwd()}).`
                  : `Failed to read workflow file ${abs}: ${
                      readErr instanceof Error ? readErr.message : String(readErr)
                    }`,
              metadata: { execution_time_ms: 0 },
            };
          }

          try {
            definition = yaml.parse(raw);
          } catch (yamlErr) {
            return {
              success: false,
              output: "",
              error: `Invalid YAML in ${abs}: ${
                yamlErr instanceof Error ? yamlErr.message : String(yamlErr)
              }`,
              metadata: { execution_time_ms: 0 },
            };
          }
        } else {
          const yamlText = params.yaml ?? params.definition_yaml;
          if (!yamlText || typeof yamlText !== "string") {
            return {
              success: false,
              output: "",
              error:
                "Must provide either 'definition' (object), 'file' (path), 'definition_yaml', or 'yaml' (string)",
              metadata: { execution_time_ms: 0 },
            };
          }

          // Catch the `$(cat ...)` anti-pattern before it surfaces as the
          // misleading "Parsed definition is not an object" (Task #4392 P0-4).
          const substitutionHint = detectShellSubstitution(yamlText);
          if (substitutionHint) {
            return {
              success: false,
              output: "",
              error: substitutionHint,
              metadata: { execution_time_ms: 0 },
            };
          }

          try {
            definition = yaml.parse(yamlText);
          } catch (yamlErr) {
            return {
              success: false,
              output: "",
              error: `Invalid YAML: ${yamlErr instanceof Error ? yamlErr.message : String(yamlErr)}`,
              metadata: { execution_time_ms: 0 },
            };
          }
        }

        if (!definition || typeof definition !== "object") {
          return {
            success: false,
            output: "",
            error:
              "Parsed definition is not an object (got " +
              `${definition === null ? "null" : typeof definition}). ` +
              "If you passed a file path as a string, use workflow_validate({ file: \"/path/to.yaml\" }) " +
              "instead of embedding `$(cat ...)` — shell substitutions are not expanded here.",
            metadata: { execution_time_ms: 0 },
          };
        }

        // Delegate to shared validateWorkflowDefinition helper — single source
        // of truth for validation:
        //   Layer 1 — DAG structure (duplicates, missing deps, cycles, empty IDs)
        //   Layer 2 — template-reference contracts (Task #4298)
        const result = validateWorkflowDefinition(definition);
        const nodeCount = Array.isArray(definition.nodes) ? definition.nodes.length : 0;

        const warnings = result.warnings ?? [];
        const infos = result.infos ?? [];

        const output = {
          valid: result.valid,
          errors: result.errors,
          warnings,
          infos,
          workflowName: definition.name,
          nodeCount,
          errorCount: result.errors.length,
          warningCount: warnings.length,
        };

        // Human-readable single-line error, listing each error AND the
        // actionable fix so the caller (workflow-creator) can iterate without
        // re-parsing JSON.
        const errorText = result.valid
          ? undefined
          : `Validation failed (${result.errors.length} error(s)):\n` +
            result.errors.map((e, i) => `  ${i + 1}. ${e}`).join("\n") +
            (warnings.length > 0
              ? `\n\nAdvisory warnings (${warnings.length}) — evaluate and fix where sensible:\n` +
                warnings.map((w, i) => `  - ${w}`).join("\n")
              : "");

        return {
          success: result.valid,
          output: JSON.stringify(output, null, 2),
          error: errorText,
          metadata: { execution_time_ms: 0 },
        };
      } catch (error) {
        logger.error("[workflow_validate] failed", { error });
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
