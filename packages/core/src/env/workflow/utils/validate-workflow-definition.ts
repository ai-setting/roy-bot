/**
 * @fileoverview Shared validateWorkflowDefinition helper.
 *
 * Single entry point for validating a workflow definition:
 *
 *   Layer 1 — DAG structure (delegated to DAGManager.validate()):
 *     duplicate node IDs, missing dependencies, cycles, empty node IDs.
 *
 *   Layer 2 — Template-reference **contracts** (Task #4298, see
 *     `template-contract-validator.ts`): does a `{{nodes.X.<field>}}`
 *     reference actually match the output shape of node `X`? This is what
 *     catches the `wheels-validate-v1` class of bug where an agent prompt
 *     read `.result` off a **tool** node (which has no such field) and the
 *     engine silently substituted an empty string.
 *
 *   Layer 3 — **Shell dialect lint** (Task #4392 P0-3, see
 *     `shell-dialect-lint.ts`): the `bash` tool spawns with `shell: true`,
 *     i.e. `/bin/sh` = dash. bash-only constructs (`set -o pipefail`,
 *     `${PIPESTATUS[0]}`, `[[ ]]`, `source`, arrays, `$RANDOM`, `echo -e`, ...)
 *     either fail loudly or -- worse -- silently no-op. Reported as **warning**
 *     only: existing registered workflows must not be invalidated by a
 *     heuristic regex.
 *
 * Wraps everything in a defensive try/catch so callers (workflow_add tool,
 * `workflow add` CLI, workflow_validate tool, TaskTagPlugin.extractWorkflow)
 * always get a consistent `{ valid, errors, warnings, infos }` shape — even
 * when the input is garbage.
 *
 * Backward compatibility: the original `{ valid, errors }` shape is preserved;
 * `warnings` / `infos` are additive. Only `error`-severity findings affect
 * `valid`.
 */

import { DAGManager } from "../engine/dag-manager";
import {
  validateTemplateContracts,
  formatTemplateContractFindings,
  type TemplateContractFinding,
} from "./template-contract-validator";
import {
  lintShellDialect,
  formatShellDialectFindings,
} from "./shell-dialect-lint";

export interface ValidateWorkflowResult {
  valid: boolean;
  /** Blocking problems. Non-empty ⟺ `valid === false`. */
  errors: string[];
  /**
   * Advisory problems (Task #4298). These do NOT make the definition invalid,
   * but the workflow-creator loop is expected to address them.
   */
  warnings?: string[];
  /** Informational hints (e.g. references to non-upstream nodes). */
  infos?: string[];
  /** Structured findings, for callers that want machine-readable detail. */
  findings?: TemplateContractFinding[];
}

export interface ValidateWorkflowOptions {
  /**
   * Skip the Layer-2 template-contract checks. Defaults to `false`.
   *
   * Provided for callers that only care about structural validity (e.g. a
   * pre-flight DAG sanity check while a definition is still being authored
   * incrementally).
   */
  skipTemplateContracts?: boolean;
  /**
   * Skip the Layer-3 shell-dialect lint. Defaults to `false`.
   *
   * Layer 3 emits **warnings only**, so there is rarely a reason to disable it;
   * this switch exists for corpus/regression tests that pin the exact warning
   * set of already-registered workflows.
   */
  lintShellDialect?: boolean;
}

/**
 * Validate a workflow definition (structure + template contracts).
 *
 * @param definition - The workflow definition object (must have a `nodes` array).
 * @param options - Optional behaviour switches.
 * @returns `{ valid, errors, warnings, infos, findings }` — never throws.
 */
export function validateWorkflowDefinition(
  definition: unknown,
  options: ValidateWorkflowOptions = {}
): ValidateWorkflowResult {
  if (!definition || typeof definition !== "object") {
    return {
      valid: false,
      errors: ["Workflow definition must be an object"],
    };
  }

  const def = definition as { nodes?: unknown };
  if (!Array.isArray(def.nodes)) {
    return {
      valid: false,
      errors: ["Workflow definition must have a 'nodes' array"],
    };
  }

  // ---- Layer 1: DAG structure ----
  let structural: { valid: boolean; errors: string[] };
  try {
    const dag = new DAGManager(definition as any, { allowCycles: false });
    structural = dag.validate();
  } catch (error) {
    structural = {
      valid: false,
      errors: [
        `Validation error: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }

  // If the structure is broken, template contracts are noise — but they can
  // still be *reported* (findings reference node ids that may be duplicated).
  // To keep messages focused, only run Layer 2 when the structure is sound.
  let findings: TemplateContractFinding[] = [];
  if (structural.valid && !options.skipTemplateContracts) {
    try {
      findings = validateTemplateContracts(definition);
    } catch {
      // Defensive: contract validation must never turn a valid workflow invalid.
      findings = [];
    }
  }

  const contractErrors = findings.filter((f) => f.severity === "error");
  const contractWarnings = findings.filter((f) => f.severity === "warning");
  const contractInfos = findings.filter((f) => f.severity === "info");

  // ---- Layer 3: shell dialect lint (Task #4392 P0-3) ----
  // The `bash` tool runs /bin/sh (dash). Detect bash-only syntax that will
  // either crash (exit 2 / 127) or silently no-op (`source`, `$RANDOM`,
  // `echo -e`). WARNING severity by design — never invalidates a workflow.
  const dialectWarnings: string[] = [];
  if (structural.valid && options.lintShellDialect !== false) {
    try {
      dialectWarnings.push(
        ...collectShellDialectWarnings(definition as DgDefinitionShape)
      );
    } catch {
      // Defensive: the lint must never turn a valid workflow invalid.
    }
  }

  const errors = [...structural.errors, ...formatTemplateContractFindings(contractErrors)];
  const warnings = [
    ...formatTemplateContractFindings(contractWarnings),
    ...dialectWarnings,
  ];
  const infos = formatTemplateContractFindings(contractInfos);

  return {
    valid: structural.valid && contractErrors.length === 0,
    errors,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(infos.length > 0 ? { infos } : {}),
    ...(findings.length > 0 ? { findings } : {}),
  };
}

// =============================================================================
// Layer 3 helpers
// =============================================================================

/** Minimal structural view of a definition, used only by the Layer-3 walker. */
interface DgDefinitionShape {
  nodes?: Array<{
    id?: unknown;
    type?: unknown;
    config?: Record<string, unknown>;
  }>;
}

/**
 * Extract every shell command string a `tool` node could execute.
 *
 * The 76 workflows in `workflows.db` use four distinct config shapes for tool
 * nodes (measured, Task #4392):
 *
 * | shape                                 | count |
 * | ------------------------------------- | ----: |
 * | `{ tool, inputs: {...} }`              |   108 |
 * | `{ tool, command }`                    |    73 |
 * | `{ tool, input: {...} }`               |    41 |
 * | `{ tool, message }`                    |    25 |
 * | `{ tool, input, timeout }`             |    18 |
 * | `{ tool, command, description }`       |     1 |
 * | `{ tool, message, description }`       |     1 |
 *
 * Only `command` / `cmd` keys are shell-interpreted (`message` is the echo
 * tool's payload and must never be linted). Both the flat shape
 * (`config.command`) and the nested shape (`config.inputs.command`,
 * `config.args.command`) are covered.
 */
function extractToolCommands(config: Record<string, unknown> | undefined): string[] {
  if (!config || typeof config !== "object") return [];

  const out: string[] = [];
  const COMMAND_KEYS = ["command", "cmd"] as const;
  const CONTAINER_KEYS = ["input", "inputs", "args"] as const;

  for (const key of COMMAND_KEYS) {
    const v = config[key];
    if (typeof v === "string") out.push(v);
  }

  for (const key of CONTAINER_KEYS) {
    const container = config[key];
    if (!container || typeof container !== "object" || Array.isArray(container)) continue;
    for (const cmdKey of COMMAND_KEYS) {
      const v = (container as Record<string, unknown>)[cmdKey];
      if (typeof v === "string") out.push(v);
    }
  }

  return out;
}

/**
 * Walk every `tool` node of a definition and lint its shell command(s).
 *
 * @returns Formatted, actionable warning lines (empty when clean).
 */
export function collectShellDialectWarnings(definition: unknown): string[] {
  const def = definition as DgDefinitionShape;
  if (!def || !Array.isArray(def.nodes)) return [];

  const warnings: string[] = [];

  for (const node of def.nodes) {
    // Only `tool` nodes execute a shell command; agent prompts merely *describe*
    // shell and must never be linted (that would flag every doc snippet).
    if (node?.type !== "tool") continue;

    const nodeId = typeof node.id === "string" ? node.id : String(node.id ?? "<unnamed>");

    for (const command of extractToolCommands(node.config)) {
      const findings = lintShellDialect(command);
      if (findings.length > 0) {
        warnings.push(...formatShellDialectFindings(nodeId, findings));
      }
    }
  }

  return warnings;
}
