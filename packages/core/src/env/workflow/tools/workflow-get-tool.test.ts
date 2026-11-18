/**
 * @fileoverview workflow_get tool integration tests
 *
 * RED #8 — verifies that `createWorkflowGetTool` declares
 * `metadata.skipTruncation === true` and that a workflow definition larger
 * than the 5KB default truncation cap is returned in full by both the
 * tool factory and the central ToolComponent path.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { createWorkflowGetTool } from "./workflow-get-tool";
import { ToolComponent } from "../../tool/tool-component";
import { ConfigComponent } from "../../../config/config-component";
import type { ToolComponentOptions } from "../../tool/tool-component";
import type { Tool } from "../../tool/types";

// ========================================================================
// Mock WorkflowService — returns a deterministic, oversized workflow def.
// ========================================================================

/**
 * Build a workflow whose `definition` JSON exceeds 5KB so any default
 * truncation would visibly strip it.
 */
function buildLargeWorkflow(name: string): {
  name: string;
  version: string;
  description: string;
  inputs: any;
  definition: any;
  config: any;
  tags: string[];
  createdAt: string;
  updatedAt: string;
} {
  // Pad inputs schema with many fields to push the JSON past the 5KB cap.
  const inputsShape: Record<string, any> = {};
  for (let i = 0; i < 100; i++) {
    inputsShape[`field_${i}`] = {
      type: "string",
      description: `Field number ${i} carrying enough payload to inflate the workflow definition past the 5KB truncation cap.`,
    };
  }

  const definition = {
    name,
    version: "1.0.0",
    description: "Synthetic large workflow used in skipTruncation tests",
    inputs: { type: "object", properties: inputsShape },
    config: { tags: ["test", "skip-truncation"] },
    nodes: [
      { id: "n1", type: "tool", config: { tool: "echo", args: { message: "x" } } },
      { id: "n2", type: "tool", config: { tool: "echo", args: { message: "y" } } },
    ],
    edges: [{ from: "n1", to: "n2" }],
  };

  return {
    name,
    version: "1.0.0",
    description: definition.description,
    inputs: definition.inputs,
    definition,
    config: definition.config,
    tags: ["test"],
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
}

function createMockWorkflowService(workflow: any): any {
  return {
    getWorkflowByName: (name: string) => (name === workflow.name ? workflow : null),
    getSession: async (_runId: string) => null,
    getSessionMessages: async (_runId: string) => [],
  };
}

// ========================================================================
// Tests
// ========================================================================

describe("WorkflowGetTool — skipTruncation metadata opt-in", () => {
  let tool: Tool;

  beforeEach(() => {
    const workflow = buildLargeWorkflow("roy-rd-with-trace-test");
    const service = createMockWorkflowService(workflow);
    tool = createWorkflowGetTool(service as any);
  });

  test("declares metadata.skipTruncation === true", () => {
    // Tool authors opt in via metadata. The central ToolComponent path and
    // the inline bypass helpers both read this flag.
    expect(tool.metadata).toBeDefined();
    expect(tool.metadata?.skipTruncation).toBe(true);
  });

  test("factory execute returns the full large workflow definition (no truncation marker)", async () => {
    // Direct factory call — no ToolComponent wrapping. The output is JSON
    // and should round-trip parse cleanly without a `[OUTPUT TRUNCATED:`
    // marker anywhere in the string.
    const output = await tool.execute({ name: "roy-rd-with-trace-test" }, {});
    expect(output.success).toBe(true);

    const text = output.output as string;
    expect(text.length).toBeGreaterThan(5_120);
    expect(text).not.toContain("[OUTPUT TRUNCATED:");

    // Round-trip: the output is parseable JSON describing the workflow.
    const parsed = JSON.parse(text);
    expect(parsed.name).toBe("roy-rd-with-trace-test");
    expect(parsed.definition.inputs.properties.field_0).toBeDefined();
    expect(parsed.definition.inputs.properties.field_99).toBeDefined();
  });

  test("central ToolComponent.execute returns the full large workflow definition", async () => {
    // Same payload but routed through the central truncation path. This is
    // the contract that protects real-world workflow_get calls from the
    // 5KB cap when the tool opts in via metadata.
    const toolComponent = new ToolComponent();
    const configComponent = new ConfigComponent();
    await configComponent.init();
    // Cap the truncation limit to the default 5KB so any opt-out stands out.
    await configComponent.set("tool.execution.maxOutputSize", 5120);

    await toolComponent.init({
      options: {
        configComponent,
      } as ToolComponentOptions,
    } as any);
    toolComponent.register(tool);

    const result = await toolComponent.execute({
      name: "workflow_get",
      args: { name: "roy-rd-with-trace-test" },
      context: {},
    });

    expect(result.success).toBe(true);
    const text = result.output as string;
    expect(text.length).toBeGreaterThan(5_120);
    expect(text).not.toContain("[OUTPUT TRUNCATED:");

    // The opt-in must skip the temp-file fallback too.
    expect(result.metadata?.truncation_temp_file).toBeUndefined();
    expect(result.metadata?.output_truncated).toBeUndefined();

    // Output still parses as the workflow JSON.
    const parsed = JSON.parse(text);
    expect(parsed.name).toBe("roy-rd-with-trace-test");
    expect(parsed.definition.inputs.properties.field_99).toBeDefined();
  });

  test("does not modify the workflow inputs schema unnecessarily", async () => {
    // Defensive: ensure the factory still produces the same well-formed
    // output as before the metadata change. No accidental refactor.
    const output = await tool.execute({ name: "roy-rd-with-trace-test" }, {});
    expect(output.success).toBe(true);
    const parsed = JSON.parse(output.output as string);
    expect(parsed.inputs.properties.field_0.type).toBe("string");
    expect(parsed.definition.nodes).toHaveLength(2);
    expect(parsed.definition.edges).toHaveLength(1);
  });
});

describe("WorkflowGetTool — non-opt-in default behavior is preserved for run_id error path", () => {
  test("returns a structured error for an unknown run_id", async () => {
    const service = createMockWorkflowService(buildLargeWorkflow("n/a"));
    const tool = createWorkflowGetTool(service as any);

    const output = await tool.execute({ run_id: "missing" }, {});
    expect(output.success).toBe(false);
    expect(output.error).toContain("Run not found: missing");
  });
});