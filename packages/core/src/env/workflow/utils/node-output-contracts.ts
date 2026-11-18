/**
 * @fileoverview Node output contracts — what a node's stored output looks like
 * at runtime, expressed as the set of first-level fields that a downstream
 * template (`{{nodes.<id>.<field>}}`) can legally navigate into.
 *
 * ## Why this exists (Task #4296 / #4298)
 *
 * A real incident: `wheels-validate-v1` v1.3.0 shipped a workflow whose final
 * `report-results` (agent) node built its prompt from
 * `{{nodes.run-validation-tests.result}}`. But `run-validation-tests` is a
 * **tool** node, and the workflow engine stores `result.output` into
 * `sessionState.nodeOutputs` (engine.ts `nodeOutputs.set(nodeId, result.output)`),
 * i.e. the stored value is the tool's *output*, **never** a `{ result, ... }`
 * envelope.
 *
 * Consequences of the mismatch (all silent):
 *   - `template-resolver.navigateTokens()` does property access on a string → `undefined`
 *   - `stringify(undefined)` → `''` (Task #2912 behavior)
 *   - the engine's non-strict pre-execute validation only `warn`s
 *     (`Node "report-results" has unresolved templates: [...]`)
 *
 * Net effect: the agent received an empty string, mis-judged the run and wrote
 * 0/0/0 while the workflow reported `completed`. Nothing failed, nothing was
 * blocked — the definition was semantically wrong but structurally fine.
 *
 * This module supplies the missing *semantic* contract so `workflow_validate`
 * can reject such definitions up-front with an actionable message.
 *
 * ## The contract table (derived from source, not guessed)
 *
 * Every node's `execute()` returns a `NodeExecutionResult`
 * (`{ success?, output, error?, durationMs?/duration? }`) — see
 * `types/run.ts` `NodeExecutionResult`. The engine then stores **only
 * `result.output`** into the shared outputs map. Therefore the fields a
 * downstream template can reach are the fields of that *inner* `output` value
 * (plus the virtual `.output` prefix, which `template-resolver` treats as
 * "unwrap the stored value").
 *
 * | node type      | node returns (`output`)                        | reachable first-level fields        |
 * |----------------|-----------------------------------------------|-------------------------------------|
 * | `tool`         | tool result (`output`, usually a string)       | `output`                            |
 * | `python_call`  | JSON-parsed stdout (object / scalar / string)  | `output`                            |
 * | `skill`        | `skill.invoke()` return value                  | `output`                            |
 * | `condition`    | `{ success, condition }`                       | `output`, `success`, `condition`    |
 * | `merge`        | `{ strategy, results, count }`                 | `output`, `strategy`, `results`, `count` |
 * | `agent`        | `{ result, metadata, workflowHistory, ...json }` | `result`, `output`, `metadata`, `workflowHistory`, + declared JSON schema fields |
 * | `workflow`     | child workflow's top-level output (unknown)     | `output`, `result` (both tolerated) |
 * | `ask_user`     | never returns (always throws to pause)          | (none)                              |
 *
 * Source anchors:
 *   - `tool-node.ts` (returns `{ output: extractedOutput, error, durationMs }`)
 *   - `python-call-node.ts` (`{ output, error: undefined, durationMs }`)
 *   - `skill-node.ts` (`{ output, error: undefined, durationMs }`)
 *   - `condition-node.ts` (`output: { success, condition }`)
 *   - `merge-node.ts` (`output: { strategy, results, count }`)
 *   - `agent-node.ts` + `build-agent-node-output.ts` (`{ result, ...json }`)
 *   - `workflow-node.ts` (`output: result.output` of the child run)
 */

/** Fields that are always reachable because `.output` is a virtual prefix
 *  (template-resolver treats `{{nodes.X.output}}` as "unwrap the stored value"). */
export const VIRTUAL_OUTPUT_FIELD = "output";

export interface NodeOutputContract {
  /**
   * First-level fields reachable via `{{nodes.<id>.<field>}}` **in addition to**
   * the virtual `output` prefix (`VIRTUAL_OUTPUT_FIELD` is always allowed).
   */
  fields: string[];
  /**
   * `true` when the field set is *closed* — i.e. any other first-level field is
   * provably unresolvable at runtime and should be flagged.
   * `false` when the shape is open/unknown (agent free-text, child workflow),
   * in which case only a best-effort hint is produced.
   */
  closed: boolean;
  /** Human-readable description of the stored value, used in error messages. */
  description: string;
  /**
   * Suggested replacement field when an unresolvable one is referenced. Used to
   * mint the "Did you mean ...?" hint.
   *
   * Note: for `.result` misuse on a *structured* node (condition / merge) the
   * validator prefers `canonicalField` over this generic fallback — see
   * `getSuggestionFieldForResultMisuse()`.
   */
  suggestedField?: string;
  /**
   * The field that actually carries the node's *answer* (CV-4298 P2#2). Used to
   * make the "Did you mean ...?" hint point at the useful field rather than the
   * generic `.output` wrapper.
   *
   * e.g. a `condition` node's answer is `.condition`; a `merge` node's is
   * `.results`. Leaving it undefined means "no better answer than `.output`".
   */
  canonicalField?: string;
}

/**
 * Canonical contracts keyed by node `type`.
 *
 * NOTE on `python_call`: the YAML type token is `pythonCall` in some docs but
 * the registered node type is `python_call` (`python-call-node.ts`:
 * `readonly type = 'python_call'`). Both spellings are registered here so the
 * validator is robust to either.
 */
export const NODE_OUTPUT_CONTRACTS: Record<string, NodeOutputContract> = {
  tool: {
    fields: [],
    closed: true,
    description: "a tool node's stored value is its result (usually a string)",
    suggestedField: VIRTUAL_OUTPUT_FIELD,
  },
  python_call: {
    fields: [],
    closed: true,
    description: "a pythonCall node's stored value is its JSON-parsed stdout",
    suggestedField: VIRTUAL_OUTPUT_FIELD,
  },
  pythonCall: {
    fields: [],
    closed: true,
    description: "a pythonCall node's stored value is its JSON-parsed stdout",
    suggestedField: VIRTUAL_OUTPUT_FIELD,
  },
  skill: {
    fields: [],
    closed: true,
    description: "a skill node's stored value is the skill's return value",
    suggestedField: VIRTUAL_OUTPUT_FIELD,
  },
  condition: {
    fields: ["success", "condition"],
    closed: true,
    description: "a condition node's stored value is { success, condition }",
    suggestedField: VIRTUAL_OUTPUT_FIELD,
    // The boolean branch decision lives in `.condition` — that is what a caller
    // who mistakenly wrote `.result` almost certainly wanted.
    canonicalField: "condition",
  },
  merge: {
    fields: ["strategy", "results", "count"],
    closed: true,
    description:
      "a merge node's stored value is { strategy, results, count }",
    suggestedField: VIRTUAL_OUTPUT_FIELD,
    // The merged payload lives in `.results`.
    canonicalField: "results",
  },
  agent: {
    fields: ["result", "metadata", "workflowHistory"],
    canonicalField: "result",
    closed: false,
    description:
      "an agent node's stored value is { result, metadata, workflowHistory, ...<json output fields> }",
    suggestedField: "result",
  },
  workflow: {
    fields: ["result"],
    closed: false,
    description:
      "a workflow node's stored value is the child workflow's top-level output",
    suggestedField: VIRTUAL_OUTPUT_FIELD,
  },
  ask_user: {
    fields: [],
    closed: true,
    description: "an askUser node never produces output (it always pauses)",
  },
  askUser: {
    fields: [],
    closed: true,
    description: "an askUser node never produces output (it always pauses)",
  },
};

/**
 * Resolve the contract for a node type. Unknown/custom node types get an
 * open-ended contract (`closed: false`) so the validator never false-positives
 * on node types it does not know about.
 */
export function getNodeOutputContract(nodeType: string): NodeOutputContract {
  return (
    NODE_OUTPUT_CONTRACTS[nodeType] ?? {
      fields: [],
      closed: false,
      description: `unknown node type "${nodeType}" (output shape unknown)`,
    }
  );
}

/**
 * Pick the field to recommend when a `.result` reference is invalid on this node
 * type (CV-4298 P2#2).
 *
 * Order of preference:
 *   1. `canonicalField` — the field that carries the node's answer
 *      (condition → `condition`, merge → `results`).
 *   2. `suggestedField` — generic fallback (usually `.output`).
 *   3. `.output` — always resolvable (the virtual unwrap prefix).
 */
export function getSuggestionFieldForResultMisuse(nodeType: string): string {
  const contract = getNodeOutputContract(nodeType);
  return contract.canonicalField ?? contract.suggestedField ?? VIRTUAL_OUTPUT_FIELD;
}

/** Whether a contracted node type has a *closed* (fully enumerable) field set. */
export function hasClosedOutputContract(nodeType: string): boolean {
  return getNodeOutputContract(nodeType).closed;
}

/**
 * Node types whose stored value is *definitely not* an `{ result, ... }`
 * envelope. Referencing `.result` on these is the canonical "agent idiom
 * misapplied to a data node" bug — treated as an **error**.
 */
export const RESULT_INVALID_NODE_TYPES = new Set([
  "tool",
  "python_call",
  "pythonCall",
  "skill",
  "condition",
  "merge",
  "ask_user",
  "askUser",
]);

/**
 * Extract the declared JSON output field names from an agent node's config
 * (`config.output.schema.properties`), when `output.mode === "json"`.
 *
 * Returns `undefined` when the node does not declare a structured schema — in
 * which case the agent's field set is unknowable and the validator stays lenient.
 */
export function getAgentDeclaredJsonFields(
  config: Record<string, unknown> | undefined
): string[] | undefined {
  const output = config?.output as
    | { mode?: unknown; schema?: { properties?: unknown } }
    | undefined;
  const properties = output?.schema?.properties;
  if (!properties || typeof properties !== "object") return undefined;
  const keys = Object.keys(properties as Record<string, unknown>);
  return keys.length > 0 ? keys : undefined;
}
