/**
 * TDD tests for the template-reference **contract** validation
 * (Task #4298, follow-up of the `wheels-validate-v1` `.result` bug #4296).
 *
 * ## The bug being locked down
 *
 * `wheels-validate-v1` v1.3.0's `report-results` (agent) node built its prompt
 * from `{{nodes.run-validation-tests.result}}`. `run-validation-tests` is a
 * **tool** node: the engine stores its *output* (a plain string) into
 * `nodeOutputs`, so `.result` is unresolvable → template-resolver yields
 * `undefined` → `stringify` → `''` → the agent received an empty string and the
 * workflow still reported `completed`.
 *
 * `workflow_validate` (and `workflow_add`) must catch this class of error
 * **before** registration.
 *
 * ## What the contract table is derived from (source, not guesses)
 *
 * | node type     | reachable first-level fields                              |
 * |---------------|-----------------------------------------------------------|
 * | `tool`        | `.output` only                                            |
 * | `python_call` | `.output` only                                            |
 * | `skill`       | `.output` only                                            |
 * | `condition`   | `.output`, `.success`, `.condition`                       |
 * | `merge`       | `.output`, `.strategy`, `.results`, `.count`              |
 * | `agent`       | `.result`, `.metadata`, `.workflowHistory`, + JSON schema fields |
 * | `workflow`    | `.output` / `.result` (child output is opaque)            |
 *
 * `.output` is a *virtual prefix* in template-resolver (it unwraps the stored
 * value), which is why it is universally legal.
 *
 * ## Regression guard
 *
 * A full scan of the 75 registered workflows (see the task report) shows the
 * ONLY `error`-level hit is `wheels-validate-v1` (2 templates). Immediately
 * after this suite we assert zero false positives against the real DB.
 */

import { describe, it, expect } from "bun:test";
import {
  validateTemplateContracts,
  type TemplateContractFinding,
} from "./template-contract-validator";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function errsOf(fs: TemplateContractFinding[]) {
  return fs.filter((f) => f.severity === "error");
}
function warnsOf(fs: TemplateContractFinding[]) {
  return fs.filter((f) => f.severity === "warning");
}
function rulesOf(fs: TemplateContractFinding[]) {
  return fs.map((f) => f.rule);
}

// ---------------------------------------------------------------------------
// RED #1 — the canonical bug: `.result` on a tool node (wheels-validate-v1)
// ---------------------------------------------------------------------------

describe("template contract validation — RED #1: .result on a tool node", () => {
  const wheelsLike = {
    name: "wheels-validate-v1-minimal",
    nodes: [
      { id: "run-validation-tests", type: "tool", config: { tool: "bash", command: "echo ok" } },
      {
        id: "enforce-evidence-gate",
        type: "tool",
        config: { tool: "bash", command: "echo gate", depends_on: [] },
        depends_on: ["run-validation-tests"],
      },
      {
        id: "report-results",
        type: "agent",
        depends_on: ["enforce-evidence-gate"],
        config: {
          agent_type: "general",
          prompt:
            "Upstream results:\n- tests: {{nodes.run-validation-tests.result}}\n" +
            "- gate: {{nodes.enforce-evidence-gate.result}}\n",
        },
      },
    ],
  };

  it("flags {{nodes.<tool>.result}} as an error", () => {
    const fs = validateTemplateContracts(wheelsLike);
    const errors = errsOf(fs);
    expect(errors.length).toBe(2);
    expect(errors.every((e) => e.rule === "R2-result-on-non-agent")).toBe(true);
    expect(errors.map((e) => e.nodeId)).toEqual(["report-results", "report-results"]);
  });

  it("names the offending template verbatim", () => {
    const fs = validateTemplateContracts(wheelsLike);
    const templates = fs.map((f) => f.template);
    expect(templates).toContain("{{nodes.run-validation-tests.result}}");
    expect(templates).toContain("{{nodes.enforce-evidence-gate.result}}");
  });

  it("suggests the .output replacement (actionable fix for the creator loop)", () => {
    const fs = validateTemplateContracts(wheelsLike);
    const f = fs.find((x) => x.template === "{{nodes.run-validation-tests.result}}")!;
    expect(f.suggestion).toBeDefined();
    expect(f.suggestion).toContain("{{nodes.run-validation-tests.output}}");
    // message must explain *why*: source is a tool node
    expect(f.message).toContain("tool");
  });

  it("does NOT flag the corrected .output form (GREEN sanity)", () => {
    const fixed = JSON.parse(JSON.stringify(wheelsLike));
    fixed.nodes[2].config.prompt =
      "tests: {{nodes.run-validation-tests.output}} gate: {{nodes.enforce-evidence-gate.output}}";
    const fs = validateTemplateContracts(fixed);
    expect(errsOf(fs)).toEqual([]);
    expect(warnsOf(fs)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RED #2 — known field sets for closed contracts (condition / merge)
// ---------------------------------------------------------------------------

describe("template contract validation — RED #2: closed contracts", () => {
  it("accepts condition's real fields (.success / .condition) and rejects .result", () => {
    const def = {
      name: "cond",
      nodes: [
        { id: "gate", type: "condition", config: { when: "{{input.x}} > 1" } },
        {
          id: "use",
          type: "agent",
          depends_on: ["gate"],
          config: {
            prompt:
              "branch={{nodes.gate.condition}} ok={{nodes.gate.success}} bad={{nodes.gate.result}}",
          },
        },
      ],
    };
    const fs = validateTemplateContracts(def);
    const errors = errsOf(fs);
    expect(errors.length).toBe(1);
    expect(errors[0].template).toBe("{{nodes.gate.result}}");
    expect(rulesOf(warnsOf(fs))).toEqual([]);
  });

  it("accepts merge's real fields (.strategy / .results / .count)", () => {
    const def = {
      name: "merged",
      nodes: [
        { id: "m", type: "merge", config: {} },
        {
          id: "use",
          type: "agent",
          depends_on: ["m"],
          config: {
            prompt:
              "s={{nodes.m.strategy}} r={{nodes.m.results}} c={{nodes.m.count}} o={{nodes.m.output}}",
          },
        },
      ],
    };
    expect(errsOf(validateTemplateContracts(def))).toEqual([]);
    expect(warnsOf(validateTemplateContracts(def))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RED #2b — the suggested fix prefers the source node's CANONICAL answer field
// (CV-4298 P2#2): a `.result` typo on `condition` / `merge` should point at the
// field that actually carries the answer, not just at the generic `.output`.
// ---------------------------------------------------------------------------

describe("template contract validation — RED #2b: canonical-field suggestions", () => {
  it("suggests .condition for a condition node (not merely .output)", () => {
    const def = {
      name: "cond-suggest",
      nodes: [
        { id: "gate", type: "condition", config: { when: "{{input.x}} > 1" } },
        { id: "use", type: "agent", depends_on: ["gate"], config: { prompt: "{{nodes.gate.result}}" } },
      ],
    };
    const f = errsOf(validateTemplateContracts(def))[0];
    expect(f).toBeDefined();
    expect(f.suggestion).toContain("{{nodes.gate.condition}}");
  });

  it("suggests .results for a merge node", () => {
    const def = {
      name: "merge-suggest",
      nodes: [
        { id: "m", type: "merge", config: {} },
        { id: "use", type: "agent", depends_on: ["m"], config: { prompt: "{{nodes.m.result}}" } },
      ],
    };
    const f = errsOf(validateTemplateContracts(def))[0];
    expect(f).toBeDefined();
    expect(f.suggestion).toContain("{{nodes.m.results}}");
  });

  it("still suggests .output for data nodes (unchanged behaviour)", () => {
    const def = {
      name: "tool-suggest",
      nodes: [
        { id: "t", type: "tool", config: { tool: "bash", command: "echo ok" } },
        { id: "use", type: "agent", depends_on: ["t"], config: { prompt: "{{nodes.t.result}}" } },
      ],
    };
    expect(errsOf(validateTemplateContracts(def))[0].suggestion).toContain("{{nodes.t.output}}");
  });
});

// ---------------------------------------------------------------------------
// RED #3 — source node does not exist
// ---------------------------------------------------------------------------

describe("template contract validation — RED #3: source node not found", () => {
  it("flags {{nodes.ghost.output}} as an error when node 'ghost' is absent", () => {
    const def = {
      name: "ghost-ref",
      nodes: [
        {
          id: "only",
          type: "agent",
          config: { prompt: "x={{nodes.ghost.output}}" },
        },
      ],
    };
    const fs = validateTemplateContracts(def);
    const errors = errsOf(fs);
    expect(errors.length).toBe(1);
    expect(errors[0].rule).toBe("R1-node-not-found");
    expect(errors[0].message).toContain("ghost");
  });

  it("does not treat input/config/env scopes as nodes", () => {
    const def = {
      name: "scoped",
      nodes: [
        {
          id: "only",
          type: "agent",
          config: {
            prompt: "a={{input.task}} b={{inputs.task}} c={{env.HOME}} d={{workflow.name}}",
          },
        },
      ],
    };
    const fs = validateTemplateContracts(def);
    expect(rulesOf(fs)).not.toContain("R1-node-not-found");
    expect(errsOf(fs)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RED #4 — agent nodes are LENIENT (free-form output) unless a schema is declared
// ---------------------------------------------------------------------------

describe("template contract validation — RED #4: agent leniency", () => {
  it("does not flag arbitrary agent fields when no JSON schema is declared", () => {
    const def = {
      name: "agent-open",
      nodes: [
        { id: "a", type: "agent", config: { prompt: "hi" } },
        {
          id: "b",
          type: "agent",
          depends_on: ["a"],
          config: {
            prompt: "x={{nodes.a.result}} y={{nodes.a.some_free_field}} z={{nodes.a.feedback}}",
          },
        },
      ],
    };
    const fs = validateTemplateContracts(def);
    expect(errsOf(fs)).toEqual([]);
    expect(warnsOf(fs)).toEqual([]);
  });

  it("accepts .result on an agent node (the idiom we must NOT break)", () => {
    const def = {
      name: "agent-result",
      nodes: [
        { id: "a", type: "agent", config: { prompt: "hi" } },
        { id: "b", type: "agent", depends_on: ["a"], config: { prompt: "{{nodes.a.result}}" } },
      ],
    };
    expect(errsOf(validateTemplateContracts(def))).toEqual([]);
  });

  it("flags a field that contradicts an EXPLICIT agent JSON schema", () => {
    const def = {
      name: "agent-schema",
      nodes: [
        {
          id: "a",
          type: "agent",
          config: {
            prompt: "hi",
            output: {
              mode: "json",
              schema: {
                type: "object",
                properties: { verdict: { type: "string" }, score: { type: "number" } },
              },
            },
          },
        },
        {
          id: "b",
          type: "agent",
          depends_on: ["a"],
          config: { prompt: "v={{nodes.a.verdict}} ok={{nodes.a.score}} bad={{nodes.a.nonexistent}}" },
        },
      ],
    };
    const fs = validateTemplateContracts(def);
    const warns = warnsOf(fs);
    expect(warns.length).toBe(1);
    expect(warns[0].template).toBe("{{nodes.a.nonexistent}}");
    expect(warns[0].message).toContain("verdict");
  });
});

// ---------------------------------------------------------------------------
// RED #5 — non-template braces must NOT be misread as node references
// ---------------------------------------------------------------------------

describe("template contract validation — RED #5: non-template braces are ignored", () => {
  it("ignores docker Go-templates ({{index .X 0}}) and doc placeholders", () => {
    const def = {
      name: "braces",
      nodes: [
        {
          id: "dockerish",
          type: "tool",
          config: {
            tool: "bash",
            command:
              "docker inspect --format='{{index .RepoDigests 0}}' img\n" +
              "echo '{{nodes.<source-id>.<field>}}'  # doc placeholder\n",
          },
        },
        {
          id: "coder",
          type: "agent",
          depends_on: ["dockerish"],
          config: { prompt: "see {{nodes.<source-id>.<field>}} for how to consume" },
        },
      ],
    };
    const fs = validateTemplateContracts(def);
    expect(errsOf(fs)).toEqual([]);
    expect(rulesOf(fs)).not.toContain("R1-node-not-found");
  });

  it("ignores handlebars-ish conditionals like {{#if input.x}} / {{/if}}", () => {
    const def = {
      name: "handlebars",
      nodes: [
        {
          id: "n",
          type: "agent",
          config: { prompt: "tags: {{#if input.task_tags}}{{input.task_tags}}{{/if}}" },
        },
      ],
    };
    expect(rulesOf(validateTemplateContracts(def))).not.toContain("R1-node-not-found");
  });
});

// ---------------------------------------------------------------------------
// RED #6 — upstream/ordering information is INFO only (never blocks)
// ---------------------------------------------------------------------------

describe("template contract validation — RED #6: upstream check is info-only", () => {
  it("reports not-upstream references as info, not error/warning", () => {
    const def = {
      name: "forward-ref",
      nodes: [
        { id: "a", type: "agent", config: { prompt: "{{nodes.b.result}}" } },
        { id: "b", type: "agent", depends_on: ["a"], config: { prompt: "hi" } },
      ],
    };
    const fs = validateTemplateContracts(def);
    expect(errsOf(fs)).toEqual([]);
    expect(warnsOf(fs)).toEqual([]);
    const info = fs.filter((f) => f.severity === "info");
    expect(info.length).toBe(1);
    expect(info[0].rule).toBe("R6-not-upstream");
  });

  it("exempts self-references (loop back-edges deliberately consume the previous round)", () => {
    const def = {
      name: "selfref",
      nodes: [
        {
          id: "loop",
          type: "agent",
          config: { prompt: "prev={{nodes.loop.result}}" },
        },
      ],
    };
    expect(rulesOf(validateTemplateContracts(def))).not.toContain("R6-not-upstream");
  });
});

// ---------------------------------------------------------------------------
// RED #7 — an empty / malformed definition never throws
// ---------------------------------------------------------------------------

describe("template contract validation — RED #7: defensive", () => {
  it("returns [] for null / non-object / nodes-less input", () => {
    expect(validateTemplateContracts(null)).toEqual([]);
    expect(validateTemplateContracts("nope")).toEqual([]);
    expect(validateTemplateContracts({})).toEqual([]);
    expect(validateTemplateContracts({ nodes: "not-an-array" })).toEqual([]);
  });
});
