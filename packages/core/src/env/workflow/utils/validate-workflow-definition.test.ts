/**
 * @fileoverview Tests for shared validateWorkflowDefinition helper.
 *
 * The helper wraps DAGManager.validate() and provides a single entry point
 * for validating workflow definitions across:
 *   - workflow_add tool
 *   - workflow add CLI command
 *   - workflow-validate tool
 *   - TaskTagPlugin.extractWorkflow
 *
 * Return shape matches DAGManager.validate(): { valid: boolean; errors: string[] }.
 *
 * TDD: these tests must FAIL before validate-workflow-definition.ts is implemented.
 */

import { describe, it, expect } from "bun:test";
import { validateWorkflowDefinition } from "./validate-workflow-definition";

describe("validateWorkflowDefinition", () => {
  describe("valid definitions", () => {
    it("should return valid:true for a minimal linear 2-node workflow", () => {
      const definition = {
        name: "linear-2",
        version: "1.0",
        nodes: [
          { id: "a", type: "tool", config: { tool: "echo" } },
          { id: "b", type: "tool", config: { tool: "echo" }, depends_on: ["a"] },
        ],
      };
      const result = validateWorkflowDefinition(definition);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("should return valid:true for a single-node workflow with no dependencies", () => {
      const definition = {
        name: "single",
        version: "1.0",
        nodes: [{ id: "only", type: "tool", config: { tool: "echo" } }],
      };
      const result = validateWorkflowDefinition(definition);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });
  });

  describe("invalid definitions", () => {
    it("should detect duplicate node IDs", () => {
      const definition = {
        name: "dup-ids",
        nodes: [
          { id: "a", type: "tool", config: { tool: "echo" } },
          { id: "a", type: "tool", config: { tool: "echo" } }, // duplicate
        ],
      };
      const result = validateWorkflowDefinition(definition);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.toLowerCase().includes("duplicate"))).toBe(true);
    });

    it("should detect missing dependencies", () => {
      const definition = {
        name: "missing-dep",
        nodes: [
          { id: "a", type: "tool", config: { tool: "echo" }, depends_on: ["ghost"] },
        ],
      };
      const result = validateWorkflowDefinition(definition);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.toLowerCase().includes("ghost") || e.toLowerCase().includes("non-existent"))).toBe(true);
    });

    it("should detect cycles", () => {
      const definition = {
        name: "cycle",
        nodes: [
          { id: "a", type: "tool", config: { tool: "echo" }, depends_on: ["b"] },
          { id: "b", type: "tool", config: { tool: "echo" }, depends_on: ["a"] },
        ],
      };
      const result = validateWorkflowDefinition(definition);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.toLowerCase().includes("cycle"))).toBe(true);
    });

    it("should detect empty node IDs", () => {
      const definition = {
        name: "empty-id",
        nodes: [
          { id: "", type: "tool", config: { tool: "echo" } },
        ],
      };
      const result = validateWorkflowDefinition(definition);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.toLowerCase().includes("empty"))).toBe(true);
    });
  });

  describe("defensive error handling", () => {
    it("should return valid:false (not throw) when DAGManager constructor throws on garbage input", () => {
      // null / non-object inputs should not crash; they should be reported as invalid.
      const result = validateWorkflowDefinition(null);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("should return valid:false when input is not an object", () => {
      const result = validateWorkflowDefinition("not-a-workflow");
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });
});

// ============================================================================
// Task #4298 — Layer-2 template-reference contract checks
// ============================================================================

describe("validateWorkflowDefinition — template contracts (Task #4298)", () => {
  it("rejects a definition where an agent prompt reads .result off a tool node", () => {
    const def = {
      name: "wheels-like",
      nodes: [
        { id: "run", type: "tool", config: { tool: "bash", command: "echo hi" } },
        {
          id: "report",
          type: "agent",
          depends_on: ["run"],
          config: { prompt: "result={{nodes.run.result}}" },
        },
      ],
    };
    const result = validateWorkflowDefinition(def);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("R2-result-on-non-agent"))).toBe(true);
    expect(result.errors.some((e) => e.includes("{{nodes.run.output}}"))).toBe(true);
  });

  it("keeps the corrected .output form valid and exposes no warnings", () => {
    const def = {
      name: "fixed",
      nodes: [
        { id: "run", type: "tool", config: { tool: "bash", command: "echo hi" } },
        {
          id: "report",
          type: "agent",
          depends_on: ["run"],
          config: { prompt: "{{nodes.run.output}}" },
        },
      ],
    };
    const result = validateWorkflowDefinition(def);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings ?? []).toEqual([]);
  });

  it("reports advisory agent-schema mismatches as warnings (still valid)", () => {
    const def = {
      name: "agent-schema",
      nodes: [
        {
          id: "judge",
          type: "agent",
          config: {
            prompt: "x",
            output: { mode: "json", schema: { type: "object", properties: { verdict: { type: "string" } } } },
          },
        },
        { id: "use", type: "agent", depends_on: ["judge"], config: { prompt: "{{nodes.judge.nope}}" } },
      ],
    };
    const result = validateWorkflowDefinition(def);
    expect(result.valid).toBe(true);
    expect((result.warnings ?? []).some((w) => w.includes("R5-agent-schema-field"))).toBe(true);
  });

  it("surfaces non-upstream references as infos only", () => {
    const def = {
      name: "fwd",
      nodes: [
        { id: "a", type: "agent", config: { prompt: "{{nodes.b.result}}" } },
        { id: "b", type: "agent", depends_on: ["a"], config: { prompt: "hi" } },
      ],
    };
    const result = validateWorkflowDefinition(def);
    expect(result.valid).toBe(true);
    expect((result.infos ?? []).some((i) => i.includes("R6-not-upstream"))).toBe(true);
    expect(result.warnings ?? []).toEqual([]);
  });

  it("can skip contract checks via options", () => {
    const def = {
      name: "skippable",
      nodes: [
        { id: "run", type: "tool", config: { tool: "bash", command: "echo hi" } },
        { id: "report", type: "agent", depends_on: ["run"], config: { prompt: "{{nodes.run.result}}" } },
      ],
    };
    expect(validateWorkflowDefinition(def, { skipTemplateContracts: true }).valid).toBe(true);
  });

  it("does not run contract checks when the structure is already invalid", () => {
    const def = {
      name: "broken-structure",
      nodes: [
        { id: "a", type: "tool", config: { tool: "bash", command: "{{nodes.ghost.result}}" }, depends_on: ["nope"] },
      ],
    };
    const result = validateWorkflowDefinition(def);
    expect(result.valid).toBe(false);
    // structural error present; contract noise suppressed
    expect(result.errors.some((e) => e.toLowerCase().includes("nope") || e.toLowerCase().includes("non-existent"))).toBe(true);
    expect(result.errors.some((e) => e.includes("R2-result-on-non-agent"))).toBe(false);
  });
});
