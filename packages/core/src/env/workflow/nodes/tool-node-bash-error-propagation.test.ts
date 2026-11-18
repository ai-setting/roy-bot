/**
 * @fileoverview TDD RED — ToolNode must propagate bash tool {success:false, error:...} (Task #2900 P0-A)
 *
 * Module under test: `packages/core/src/env/workflow/nodes/tool-node.ts`
 *
 * Background (Task #2898 + Task #2900):
 *   Bash tool (packages/core/src/env/tool/built-in/bash.ts:180-184) returns:
 *     { success: false, output: "(no output)" | stderr, error: stderr | "timed out",
 *       metadata: { exit_code, timed_out, ... } }
 *   when command exits non-zero. But ToolNode.execute() at line 261-264 wraps
 *   the result as:
 *     { output: extractFromWrapper(output), error: undefined, durationMs }
 *   i.e. extractFromWrapper reads `.output` and discards `.success` and `.error`.
 *
 *   Net effect: when bash fails, executor.executeWithTimeout sees
 *   `result.error === undefined` → engine.ts validateAndExecute:1667 hits
 *   `if (result.error) return;` = false → scheduler.markCompleted(nodeId)
 *   → workflow status='completed' despite node failure (silent fail).
 *
 * Contract after GREEN:
 *   - When tool.execute() returns `{ success: false, error: "<msg>", ... }`,
 *     ToolNode.execute() must surface `error: <msg>` so executor can see it.
 *   - When `success === true` (or missing), behavior unchanged.
 *   - When `success === false` but `error` is empty/undefined, synthesize
 *     error from `metadata.exit_code` + `metadata.timed_out` so consumers
 *     can still detect failure.
 */

import { describe, it, expect } from "bun:test";
import { ToolNode, type Tool, type ToolRegistry } from "./tool-node";
import type { NodeDefinition, NodeExecutionContext } from "../types";

// =============================================================================
// Helpers
// =============================================================================

interface BashLikeTool extends Tool {
  name: string;
  execute: (input: any, context?: any) => Promise<any>;
}

/**
 * Builds a minimal ToolRegistry whose getTool returns the supplied tool.
 */
function makeRegistry(tool: BashLikeTool): ToolRegistry {
  return {
    getTool: (_name: string) => ({ tool, enabled: true, source: "test" }),
    hasTool: (_name: string) => true,
  };
}

function makeContext(): NodeExecutionContext {
  return {
    runId: "test-run",
    workflowName: "test-wf",
    nodeId: "get-jwt",
    input: {},
    previousOutputs: new Map(),
    nodeOutputs: new Map(),
    abortSignal: new AbortController().signal,
    config: { tool: "bash", command: "echo hi" },
  } as unknown as NodeExecutionContext;
}

function makeDefinition(): NodeDefinition {
  return {
    id: "get-jwt",
    type: "tool",
    name: "GET-JWT",
    config: { tool: "bash", command: "echo hi" },
  } as NodeDefinition;
}

// =============================================================================
// RED Tests
// =============================================================================

describe("ToolNode: bash {success:false, error:...} must propagate (Task #2900 P0-A)", () => {
  it("RED: bash tool returns success:false + error → result.error must be defined", async () => {
    // Mirrors what packages/core/src/env/tool/built-in/bash.ts returns on failure
    const bashTool: BashLikeTool = {
      name: "bash",
      async execute() {
        return {
          success: false,
          output: "(no output)",
          error: "FATAL: wiki-auth.sh lib not found",
          metadata: { exit_code: 9, timed_out: false, stderr: "FATAL: wiki-auth.sh lib not found" },
        };
      },
    };
    const node = new ToolNode(makeDefinition(), makeRegistry(bashTool));

    const result = await node.execute(makeContext());

    // ❌ Currently FAILS — ToolNode drops the wrapper's success/error field
    expect(result.error).toBeDefined();
    expect(String(result.error)).toContain("wiki-auth.sh");
  });

  it("RED: bash tool returns success:true → result.error stays undefined (regression guard)", async () => {
    const bashTool: BashLikeTool = {
      name: "bash",
      async execute() {
        return {
          success: true,
          output: "WIKI_DIR=/tmp/wiki-xyz\nJWT_FILE=/tmp/wiki-xyz/jwt.txt",
          error: undefined,
          metadata: { exit_code: 0, timed_out: false },
        };
      },
    };
    const node = new ToolNode(makeDefinition(), makeRegistry(bashTool));

    const result = await node.execute(makeContext());

    expect(result.error).toBeUndefined();
    expect(String(result.output)).toContain("WIKI_DIR=");
  });

  it("RED: bash tool returns success:false + timed_out → result.error must surface 'timed out'", async () => {
    const bashTool: BashLikeTool = {
      name: "bash",
      async execute() {
        return {
          success: false,
          output: "",
          error: "Command timed out after 60000ms",
          metadata: { exit_code: 124, timed_out: true },
        };
      },
    };
    const node = new ToolNode(makeDefinition(), makeRegistry(bashTool));

    const result = await node.execute(makeContext());

    expect(result.error).toBeDefined();
    expect(String(result.error)).toContain("timed out");
  });

  it("RED: bash tool throws (tool rejects) → result.error still surfaces (regression)", async () => {
    const bashTool: BashLikeTool = {
      name: "bash",
      async execute() {
        throw new Error("spawn ENOENT");
      },
    };
    const node = new ToolNode(makeDefinition(), makeRegistry(bashTool));

    const result = await node.execute(makeContext());

    expect(result.error).toBeDefined();
    expect(String(result.error)).toContain("spawn ENOENT");
  });
});