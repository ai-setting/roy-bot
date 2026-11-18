/**
 * @fileoverview TDD RED — `validateWorkflowDefinition` Layer 3: shell dialect lint
 * (Task #4392 P0-3).
 *
 * Contract under test:
 *   - Layer 3 runs ONLY when the structure (Layer 1) is sound — a broken DAG
 *     already has enough noise.
 *   - Findings land in `warnings`, NEVER in `errors`: they must not flip
 *     `valid` to false. 76 workflows are already registered and must not be
 *     invalidated by a heuristic.
 *   - `lintShellDialect: false` disables Layer 3 (used by callers that only want
 *     structural validity).
 *   - The warning text names the node id and the rule so it is actionable.
 *   - Only tool nodes with a string `config.command` / `config.args.command`
 *     are scanned; agent prompts containing `set -o pipefail` as *documentation*
 *     must not be flagged.
 */

import { describe, it, expect } from "bun:test";
import { validateWorkflowDefinition } from "./validate-workflow-definition";

function wf(nodes: unknown[]): Record<string, unknown> {
  return { name: "dialect-test", version: "1.0.0", nodes };
}

function toolNode(id: string, command: string, dependsOn?: string[]) {
  return {
    id,
    type: "tool",
    name: id,
    config: { tool: "bash", command },
    ...(dependsOn ? { depends_on: dependsOn } : {}),
  };
}

describe("validateWorkflowDefinition — Layer 3 shell dialect lint (Task #4392 P0-3)", () => {
  it("RED: bash-only command yields a warning (not an error) and stays valid", () => {
    const result = validateWorkflowDefinition(
      wf([toolNode("build", "set -o pipefail; npm test | tee /tmp/out.log")])
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings ?? []).toHaveLength(1);
    expect((result.warnings ?? [])[0]).toContain('[shell-dialect]');
    expect((result.warnings ?? [])[0]).toContain('"build"');
    expect((result.warnings ?? [])[0]).toContain("pipefail");
    // The fix hint must be present so the author can act on it.
    expect((result.warnings ?? [])[0]).toContain("RC=$?");
  });

  it("RED: portable command yields zero warnings", () => {
    const result = validateWorkflowDefinition(
      wf([toolNode("build", 'cd dist && find . -maxdepth 2 -name "*.whl" -print')])
    );

    expect(result.valid).toBe(true);
    expect(result.warnings ?? []).toEqual([]);
  });

  it("RED: multiple bad nodes each produce their own warning", () => {
    const result = validateWorkflowDefinition(
      wf([
        toolNode("a", "set -o pipefail; ./x.sh"),
        toolNode("b", 'source /tmp/s.env && echo ok', ["a"]),
      ])
    );

    const warnings = result.warnings ?? [];
    expect(warnings.length).toBe(2);
    expect(warnings.some((w) => w.includes('"a"'))).toBe(true);
    expect(warnings.some((w) => w.includes('"b"'))).toBe(true);
    expect(result.valid).toBe(true);
  });

  it("RED: one node with two bash-isms produces two warnings", () => {
    const result = validateWorkflowDefinition(
      wf([toolNode("multi", 'set -o pipefail\nif [[ -f x ]]; then echo y; fi')])
    );

    expect((result.warnings ?? []).length).toBe(2);
  });

  it("RED: agent node prompt mentioning pipefail is NOT scanned", () => {
    const result = validateWorkflowDefinition(
      wf([
        {
          id: "review",
          type: "agent",
          name: "review",
          config: {
            agent_type: "reviewer",
            prompt: "Check that the script avoids `set -o pipefail` because dash rejects it.",
          },
        },
      ])
    );

    expect(result.warnings ?? []).toEqual([]);
  });

  it("RED: tool node whose command is a non-string (e.g. array) is skipped safely", () => {
    const result = validateWorkflowDefinition(
      wf([
        {
          id: "weird",
          type: "tool",
          name: "weird",
          config: { tool: "bash", command: ["set", "-o", "pipefail"] },
        },
      ])
    );

    expect(result.valid).toBe(true);
    expect(result.warnings ?? []).toEqual([]);
  });

  it("RED: broken DAG structure suppresses Layer 3 (no noise on top of errors)", () => {
    const result = validateWorkflowDefinition(
      wf([toolNode("a", "set -o pipefail; ./x.sh", ["does-not-exist"])])
    );

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.warnings ?? []).toEqual([]);
  });

  it("RED: lintShellDialect:false disables Layer 3", () => {
    const result = validateWorkflowDefinition(
      wf([toolNode("build", "set -o pipefail; ./x.sh")]),
      { lintShellDialect: false }
    );

    expect(result.valid).toBe(true);
    expect(result.warnings ?? []).toEqual([]);
  });

  it("RED: `config.args.command` (the alias shape) is also scanned", () => {
    const result = validateWorkflowDefinition(
      wf([
        {
          id: "aliased",
          type: "tool",
          name: "aliased",
          config: { tool: "bash", args: { command: "echo $RANDOM" } },
        },
      ])
    );

    expect((result.warnings ?? []).length).toBe(1);
    expect((result.warnings ?? [])[0]).toContain("RANDOM");
  });

  it("RED: structural error message is unaffected by Layer 3 presence", () => {
    const result = validateWorkflowDefinition(
      wf([
        toolNode("a", "set -o pipefail; ./x.sh"),
        toolNode("a", "echo dup"),
      ])
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /duplicate/i.test(e))).toBe(true);
  });
});
