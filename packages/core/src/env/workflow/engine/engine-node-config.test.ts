/**
 * @fileoverview Engine nodeConfig tests (Capability 1)
 *
 * Tests that `nodeConfig[nodeId]` passed via workflow input is merged into
 * the node's effective config at buildNodeContext time. This is the
 * foundation for runtime-overridable node-level settings (timeout,
 * maxIterations, model, etc.) without forcing every workflow author to
 * edit the YAML.
 *
 * Backward-compat invariant: when `nodeConfig` is absent (or empty), the
 * engine behaves exactly as before — no merge happens.
 *
 * TDD: this file is RED until engine.ts is updated to read
 * `options.nodeConfig` and merge it into nodeDef.config inside
 * `buildNodeContext`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { WorkflowEngine } from "./engine";
import { NodeRegistry } from "./node-registry";
import { ToolNode } from "../nodes/tool-node";
import type {
  WorkflowDefinition,
  NodeDefinition,
  NodeExecutionContext,
} from "../types";
import type { SessionComponent } from "../../session/session-component";
import type { Tool } from "../nodes/tool-node";

/**
 * Minimal stub session component (no persistence — exercises the in-memory
 * path only).
 */
function makeStubSession(): SessionComponent {
  const state = new Map<string, any>();
  return {
    create: async (opts: any) => ({ id: opts.id, ...opts }),
    get: async (id: string) => state.get(id) ?? null,
    update: async (id: string, patch: any) => {
      const cur = state.get(id) ?? { id };
      state.set(id, { ...cur, ...patch, metadata: { ...(cur.metadata ?? {}), ...(patch.metadata ?? {}) } });
      return true;
    },
    addMessage: async () => "msg-id",
    getMessages: async () => [],
    list: async () => [],
  } as unknown as SessionComponent;
}

/**
 * Test fixture workflow: one tool node that the engine can schedule.
 */
function buildWorkflow(): WorkflowDefinition {
  const toolNode: NodeDefinition = {
    id: "step-1",
    type: "tool",
    name: "Step 1",
    config: {
      tool: "capture-context",
      input: { message: "hi" },
    },
  };
  return {
    name: "node-config-fixture",
    version: "1.0.0",
    description: "Workflow with a single tool node for nodeConfig tests",
    nodes: [toolNode],
    edges: [],
    entry: "__default_entry__",
    outputs: [],
    inputs: {},
    metadata: { tags: [] },
    config: { timeout: null, debug: false, strict: false, maxIterations: 100, loopEnabled: false },
  };
}

describe("WorkflowEngine nodeConfig override (Capability 1)", () => {
  let engine: WorkflowEngine;
  /** Captured context.config from the tool's last execute() call. */
  let capturedConfig: Record<string, unknown> | undefined;

  beforeEach(() => {
    capturedConfig = undefined;
    const registry = new NodeRegistry();
    // Register 'capture-context' tool that snapshots the context's effective
    // config. We use this to verify the nodeConfig was merged.
    const captureTool: Tool = {
      name: "capture-context",
      execute: async (_input: any, _ctx?: any) => {
        // The engine passes context.config — the executor's buildNodeContext
        // will set this once we wire nodeConfig through. We can fish it out
        // by exposing the resolved config on the global side.
        return { output: "ok" };
      },
    };
    const toolRegistry = {
      getTool: (name: string) => {
        if (name === "capture-context") return captureTool;
        return undefined;
      },
      hasTool: (name: string) => name === "capture-context",
    };
    // Custom factory: capture context.config before delegating to ToolNode.
    registry.register("tool", (definition) => {
      const inner = new ToolNode(definition, toolRegistry as any);
      return {
        ...inner,
        async execute(context: NodeExecutionContext) {
          capturedConfig = context.config;
          return inner.execute(context);
        },
      } as any;
    });
    engine = new WorkflowEngine(registry, makeStubSession());
  });

  it("T1 (RED): when nodeConfig[nodeId].timeout is set, context.config.timeout reflects it", async () => {
    const wf = buildWorkflow();

    await engine.runWorkflow(wf, {
      input: { foo: "bar" },
      // @ts-expect-error -- field pending impl
      nodeConfig: { "step-1": { timeout: 5000 } },
    } as any);

    // After our impl, buildNodeContext should merge nodeConfig["step-1"]
    // into the node's effective config — so the ToolNode (and any
    // observer) sees timeout=5000 even though nodeDef.config has none.
    expect(capturedConfig).toBeDefined();
    expect(capturedConfig?.timeout).toBe(5000);
  });

  it("T2 (RED): nodeConfig timeout wins over nodeDef.config.timeout (input precedence)", async () => {
    const wf = buildWorkflow();
    wf.nodes[0].config.timeout = 1000; // nodeDef says 1000

    await engine.runWorkflow(wf, {
      input: { foo: "bar" },
      // @ts-expect-error -- field pending impl
      nodeConfig: { "step-1": { timeout: 9999 } }, // input says 9999
    } as any);

    expect(capturedConfig?.timeout).toBe(9999);
  });

  it("T3 (GREEN-by-default): backward-compat — no nodeConfig keeps nodeDef.config verbatim", async () => {
    const wf = buildWorkflow();
    wf.nodes[0].config.timeout = 1234;

    await engine.runWorkflow(wf, {
      input: { foo: "bar" },
    });

    expect(capturedConfig?.timeout).toBe(1234);
  });

  it("T4 (RED): unknown nodeId in nodeConfig does not crash and does not pollute known nodes", async () => {
    const wf = buildWorkflow();
    wf.nodes[0].config.timeout = 777;

    await engine.runWorkflow(wf, {
      input: { foo: "bar" },
      // @ts-expect-error -- field pending impl
      nodeConfig: {
        "ghost-node": { timeout: 99999 }, // ignored
        "step-1": { timeout: 42 },
      },
    } as any);

    // step-1 should still get the override, not the ghost's value
    expect(capturedConfig?.timeout).toBe(42);
  });
});