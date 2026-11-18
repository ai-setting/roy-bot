/**
 * @fileoverview Static **template-reference contract** validation for workflow
 * definitions (Task #4298).
 *
 * ## The problem
 *
 * `workflow_validate` (and `workflow_add`) historically only ran DAG-structure
 * checks (duplicate IDs / missing deps / cycles / empty IDs). It could not
 * notice that a node's prompt referenced a field its upstream node can never
 * produce — which is exactly how `wheels-validate-v1` v1.3.0 shipped a
 * workflow whose `report-results` agent received an *empty string* for
 * `{{nodes.run-validation-tests.result}}` (a **tool** node has no `result`)
 * and then reported `completed` anyway.
 *
 * ## What this module does
 *
 * Walks every node's `config`, extracts *pure* `{{ ... }}` template paths, and
 * checks each one against:
 *
 *   1. **R1** — the referenced source node actually exists            → error
 *   2. **R2** — `.result` is an **agent-only** idiom; using it on a data
 *      node (tool / python_call / skill / condition / merge / askUser)
 *      is the canonical bug above                                    → error
 *   3. **R3** — a first-level field that is not in the source node's
 *      *closed* contract field set (may still resolve if the node's
 *      `output` happens to be an object carrying that key)          → warning
 *   4. **R4** — a deep path (`.output.<x>`) into a `tool` node whose
 *      output is usually a plain string                              → info
 *   5. **R5** — a field that contradicts an agent's **declared JSON
 *      schema** (`config.output.schema.properties`)                   → warning
 *   6. **R6** — the source node is not upstream of the consumer
 *      (loops / forward refs legitimately consume prior-round output) → info
 *
 * Severity policy: only R1/R2 are `error` (blocking). R3/R5 are `warning`
 * (advisory). R4/R6 are `info` (hint). This keeps the existing corpus clean —
 * a scan of all 75 registered workflows yields **2 errors, both in
 * `wheels-validate-v1`**, i.e. precisely the bug we set out to catch.
 *
 * ## Parsing rules (deliberately conservative)
 *
 * A `{{ ... }}` body is only considered a node reference when it is a *pure dot
 * path* (`^[A-Za-z_][A-Za-z0-9_-]*(\\.[A-Za-z0-9_-]+|\\[-?\\d+\\])*$`). This
 * excludes, in one stroke:
 *   - scoped refs: `{{input.x}}` / `{{inputs.x}}` / `{{config.x}}` / `{{env.X}}`
 *   - docker Go-templates: `{{index .RepoDigests 0}}`
 *   - handlebars-ish conditionals: `{{#if input.x}}` / `{{/if}}`
 *   - documentation placeholders: `{{nodes.<source-id>.<field>}}`
 *   - shell parameter expansions and any prose containing a space
 *
 * It also explicitly ignores the `{{X | default ''}}` filter suffix used by a
 * few workflows (the path is taken up to the first space or `|`).
 */

import {
  VIRTUAL_OUTPUT_FIELD,
  RESULT_INVALID_NODE_TYPES,
  getNodeOutputContract,
  getSuggestionFieldForResultMisuse,
  getAgentDeclaredJsonFields,
} from "./node-output-contracts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TemplateContractSeverity = "error" | "warning" | "info";

export type TemplateContractRule =
  | "R1-node-not-found"
  | "R2-result-on-non-agent"
  | "R3-unknown-field-on-closed"
  | "R4-deep-path-into-tool"
  | "R5-agent-schema-field"
  | "R6-not-upstream";

export interface TemplateContractFinding {
  /** `error` blocks `workflow_add`; `warning` / `info` are advisory. */
  severity: TemplateContractSeverity;
  rule: TemplateContractRule;
  /** The node whose config contains the reference. */
  nodeId: string;
  /** The verbatim template, e.g. `{{nodes.run-validation-tests.result}}`. */
  template: string;
  /** The referenced source node id. */
  sourceNodeId?: string;
  /** The referenced source node type (when it exists). */
  sourceNodeType?: string;
  /** Human-readable, actionable explanation. */
  message: string;
  /** Suggested replacement template (when we can compute one). */
  suggestion?: string;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Matches `{{ ... }}` with a non-greedy inner body. */
const TEMPLATE_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * A body is a candidate node reference only if the *whole* body (before any
 * `| default ...` filter) is a pure dot/bracket path.
 */
const PURE_PATH_RE = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+|\[-?\d+\])*$/;

/** Scopes that are never node references. */
const NON_NODE_SCOPES = new Set(["input", "inputs", "config", "env", "workflow", "vars", "secrets"]);

function isPurePath(body: string): boolean {
  return PURE_PATH_RE.test(body);
}

/** Walk every string inside a nested value (objects / arrays). */
function walkStrings(value: unknown, visit: (s: string) => void): void {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkStrings(item, visit);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) walkStrings(v, visit);
  }
}

interface ParsedRef {
  template: string;
  sourceNodeId: string;
  /** Path segments after the source node id (may be empty). */
  rest: string[];
}

/**
 * Extract node-scoped template references from a config blob.
 *
 * Skips non-node scopes, non-pure-path bodies, and handlebars conditionals.
 */
function extractNodeRefs(config: unknown): ParsedRef[] {
  const refs: ParsedRef[] = [];
  walkStrings(config, (s) => {
    TEMPLATE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TEMPLATE_RE.exec(s)) !== null) {
      const raw = m[0];
      // Strip an optional `| default ...` filter used in some workflows, then
      // require the *whole* remainder to be a single path token. Any embedded
      // whitespace means this is NOT a workflow template — it is something else
      // that merely reuses `{{ }}` syntax (docker Go-templates like
      // `{{index .RepoDigests 0}}`, handlebars conditionals, prose, shell).
      const body = m[1].split("|")[0].trim();
      if (!body || /\s/.test(body) || !isPurePath(body)) continue;

      // Skip handlebars-style directive bodies (`#if`, `/if`) — not pure paths
      // anyway, but be explicit for readability.
      if (body.startsWith("#") || body.startsWith("/")) continue;

      const parts = body.split(".");
      let sourceNodeId: string;
      let rest: string[];

      if (parts[0] === "nodes") {
        // `{{nodes.<id>...}}`
        if (parts.length < 2) continue;
        sourceNodeId = parts[1];
        rest = parts.slice(2);
      } else {
        sourceNodeId = parts[0];
        rest = parts.slice(1);
      }

      if (!sourceNodeId) continue;
      if (NON_NODE_SCOPES.has(sourceNodeId)) continue;

      refs.push({ template: raw, sourceNodeId, rest });
    }
  });
  return refs;
}

/** Normalize a possibly-bracketed segment: `commits[-1]` → `commits`. */
function baseSegment(seg: string | undefined): string {
  if (!seg) return "";
  return seg.replace(/\[-?\d+\]$/, "");
}

// ---------------------------------------------------------------------------
// Graph helpers (self-contained: never throws on malformed input)
// ---------------------------------------------------------------------------

interface MiniGraph {
  /** node id → node definition */
  byId: Map<string, { id: string; type: string; config?: Record<string, unknown>; depends_on?: string[] }>;
  /** node id → transitive upstream node ids */
  upstream: Map<string, Set<string>>;
}

function buildGraph(nodes: any[], edges: any[]): MiniGraph {
  const byId: MiniGraph["byId"] = new Map();
  const direct = new Map<string, string[]>();

  for (const n of nodes) {
    if (!n || typeof n !== "object" || typeof n.id !== "string" || !n.id) continue;
    byId.set(n.id, n);
    const deps = Array.isArray(n.depends_on) ? n.depends_on.filter((d: unknown) => typeof d === "string") : [];
    direct.set(n.id, [...deps]);
  }

  // edges: from → to means `to` depends on `from` (mirrors DAGManager).
  for (const e of Array.isArray(edges) ? edges : []) {
    if (!e || typeof e.from !== "string" || typeof e.to !== "string") continue;
    const to = direct.get(e.to);
    if (!to) continue;
    if (!to.includes(e.from)) to.push(e.from);
  }

  const upstream = new Map<string, Set<string>>();
  for (const id of byId.keys()) {
    const seen = new Set<string>();
    const stack = [...(direct.get(id) ?? [])];
    while (stack.length > 0) {
      const d = stack.pop()!;
      if (seen.has(d)) continue;
      seen.add(d);
      for (const dd of direct.get(d) ?? []) stack.push(dd);
    }
    upstream.set(id, seen);
  }

  return { byId, upstream };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Validate every template reference in a workflow definition against the
 * source node's output contract.
 *
 * Never throws — malformed input yields `[]`.
 *
 * @param definition - Workflow definition (needs a `nodes` array)
 * @returns Findings, in node-declaration order
 */
export function validateTemplateContracts(definition: unknown): TemplateContractFinding[] {
  if (!definition || typeof definition !== "object") return [];
  const def = definition as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(def.nodes)) return [];

  const nodes = def.nodes as any[];
  const { byId, upstream } = buildGraph(nodes, Array.isArray(def.edges) ? def.edges : []);
  const findings: TemplateContractFinding[] = [];

  for (const node of nodes) {
    if (!node || typeof node !== "object" || typeof node.id !== "string" || !node.id) continue;
    const nodeId: string = node.id;
    const refs = extractNodeRefs(node.config);
    const upOfNode = upstream.get(nodeId) ?? new Set<string>();

    for (const ref of refs) {
      const { template, sourceNodeId, rest } = ref;
      const src = byId.get(sourceNodeId);

      // ---- R1: source node does not exist ----
      if (!src) {
        findings.push({
          severity: "error",
          rule: "R1-node-not-found",
          nodeId,
          template,
          sourceNodeId,
          message:
            `Node "${nodeId}" references "${template}", but no node with id ` +
            `"${sourceNodeId}" exists in this workflow.`,
          suggestion: `Remove the reference, or add a node with id "${sourceNodeId}".`,
        });
        continue;
      }

      const srcType: string = src.type;
      const contract = getNodeOutputContract(srcType);
      const allowed = new Set<string>([VIRTUAL_OUTPUT_FIELD, ...contract.fields]);
      // Condition/merge expose structured children directly on the stored value.
      const first = baseSegment(rest[0]);

      // ---- R2: `.result` used on a non-agent node (the canonical bug) ----
      if (first === "result" && RESULT_INVALID_NODE_TYPES.has(srcType)) {
        // CV-4298 P2#2: prefer the node's canonical answer field over the
        // generic `.output` (condition → `.condition`, merge → `.results`).
        const suggestedField = getSuggestionFieldForResultMisuse(srcType);
        const fixed = template.replace(
          new RegExp(`(nodes\\.${escapeRegExp(sourceNodeId)}|^\\{\\{${escapeRegExp(sourceNodeId)})\\.result`),
          `$1.${suggestedField}`,
        );
        findings.push({
          severity: "error",
          rule: "R2-result-on-non-agent",
          nodeId,
          template,
          sourceNodeId,
          sourceNodeType: srcType,
          message:
            `Node "${nodeId}" references "${template}", but "${sourceNodeId}" is a ` +
            `"${srcType}" node — ${contract.description}. The ".result" field only ` +
            `exists on agent nodes; the value will silently resolve to an empty ` +
            `string at runtime. Use ".output" instead.`,
          suggestion: fixed !== template ? fixed : undefined,
        });
        continue;
      }

      // ---- R3: unknown first-level field on a *closed* contract ----
      if (first && contract.closed && !allowed.has(first)) {
        findings.push({
          severity: "warning",
          rule: "R3-unknown-field-on-closed",
          nodeId,
          template,
          sourceNodeId,
          sourceNodeType: srcType,
          message:
            `Node "${nodeId}" references "${template}"; "${sourceNodeId}" is a ` +
            `"${srcType}" node whose output is ${contract.description} — "${first}" ` +
            `is not one of [${[...allowed].join(", ")}]. It may resolve only if the ` +
            `node's output object happens to contain "${first}".`,
          suggestion: contract.suggestedField
            ? template.replace(
                new RegExp(`\\.${escapeRegExp(first)}(?=\\.|\\[|\\}\\}|$)`),
                `.${contract.suggestedField}`,
              )
            : undefined,
        });
      }

      // ---- R4: deep path into a `tool` node (output is usually a string) ----
      if (srcType === "tool" && first === VIRTUAL_OUTPUT_FIELD && rest.length > 1) {
        findings.push({
          severity: "info",
          rule: "R4-deep-path-into-tool",
          nodeId,
          template,
          sourceNodeId,
          sourceNodeType: srcType,
          message:
            `Node "${nodeId}" references "${template}" — a deep path into a "tool" ` +
            `node. Tool outputs are frequently plain strings, in which case ` +
            `".${rest.slice(1).join(".")}" cannot be navigated. Verify the tool ` +
            `returns a structured object.`,
        });
      }

      // ---- R5: contradicting an agent's declared JSON schema ----
      if (srcType === "agent" && first) {
        const declared = getAgentDeclaredJsonFields(src.config);
        if (declared && first && !allowed.has(first) && !declared.includes(first)) {
          findings.push({
            severity: "warning",
            rule: "R5-agent-schema-field",
            nodeId,
            template,
            sourceNodeId,
            sourceNodeType: srcType,
            message:
              `Node "${nodeId}" references "${template}", but agent node ` +
              `"${sourceNodeId}" declares a JSON output schema with fields ` +
              `[${declared.join(", ")}]. "${first}" is not among them ` +
              `(nor the generic "result"/"output"/"metadata"/"workflowHistory").`,
          });
        }
      }

      // ---- R6: source node is not upstream (loop / forward reference) ----
      if (sourceNodeId !== nodeId && !upOfNode.has(sourceNodeId)) {
        findings.push({
          severity: "info",
          rule: "R6-not-upstream",
          nodeId,
          template,
          sourceNodeId,
          sourceNodeType: srcType,
          message:
            `Node "${nodeId}" references "${template}", but "${sourceNodeId}" is not ` +
            `in its upstream dependency closure. This is valid for loop back-edges ` +
            `(consuming the previous round's output) but otherwise may resolve to an ` +
            `empty value on the first execution.`,
        });
      }
    }
  }

  return findings;
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Convenience: only the blocking findings. */
export function getTemplateContractErrors(
  definition: unknown
): TemplateContractFinding[] {
  return validateTemplateContracts(definition).filter((f) => f.severity === "error");
}

/** Convenience: only the advisory findings. */
export function getTemplateContractWarnings(
  definition: unknown
): TemplateContractFinding[] {
  return validateTemplateContracts(definition).filter((f) => f.severity === "warning");
}

/** Render findings as `string[]` for the `{ valid, errors }` callers. */
export function formatTemplateContractFindings(
  findings: TemplateContractFinding[]
): string[] {
  return findings.map((f) => {
    const head = `[template-contract:${f.rule}] Node "${f.nodeId}": ${f.message}`;
    return f.suggestion ? `${head} — Did you mean "${f.suggestion}"?` : head;
  });
}
