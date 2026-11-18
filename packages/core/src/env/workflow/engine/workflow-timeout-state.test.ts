/**
 * @fileoverview Workflow timeout → stopped/failed state tests (Capabilities 2 + 4)
 *
 * These tests pin down the contract for "what happens when a workflow node
 * times out" — namely:
 *
 *  1. After the workflow_run tool returns a timeout failure to its caller,
 *     the in-memory workflow run instance is FULLY STOPPED. No more events
 *     fire, no more messages get written, no agent process keeps running
 *     after the caller thinks it is done.
 *
 *  2. The session component metadata records status='failed' (or 'stopped'),
 *     NOT 'running'. This is what `workflow status <runId>` reads.
 *
 *  3. Calling workflow_run_stop on a run that is mid-flight returns
 *     success: true and transitions the session to status='stopped'.
 *
 *  4. Calling workflow_run_stop on a run that already failed is a safe
 *     no-op (idempotent), not a throw.
 *
 * Task #1974 — Capability 2 + 4.
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
 * In-memory session component with simple status tracking — enough to
 * verify the engine's failure path actually persists a non-running status.
 */
function makeTrackingSession(): {
  session: SessionComponent;
  records: Map<string, { metadata: any; messages: any[] }>;
} {
  const records = new Map<string, { metadata: any; messages: any[] }>();
  const session: SessionComponent = {
    create: async (opts: any) => {
      records.set(opts.id, { metadata: opts.metadata ?? {}, messages: [] });
      return { id: opts.id, ...opts };
    },
    get: async (id: string) => {
      const r = records.get(id);
      if (!r) return null;
      return {
        id,
        title: "test",
        metadata: r.metadata,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    },
    update: async (id: string, patch: any) => {
      const r = records.get(id);
      if (!r) return false;
      r.metadata = { ...r.metadata, ...(patch.metadata ?? {}) };
      records.set(id, r);
      return true;
    },
    addMessage: async (id: string, msg: any) => {
      const r = records.get(id);
      if (r) r.messages.push(msg);
      return "msg";
    },
    getMessages: async (id: string) => records.get(id)?.messages ?? [],
    list: async () => [],
  } as unknown as SessionComponent;
  return { session, records };
}

/**
 * Build a workflow with a single tool node that sleeps for `sleepMs` so
 * we can deterministically trigger a timeout via `definition.timeout`.
 */
function buildSlowWorkflow(sleepMs: number, timeoutMs: number): WorkflowDefinition {
  const slowToolNode: NodeDefinition = {
    id: "slow-step",
    type: "tool",
    name: "Slow Step",
    timeout: timeoutMs, // top-level NodeDefinition.timeout
    config: {
      tool: "sleep-tool",
      input: { sleep_ms: sleepMs },
    },
  };
  return {
    name: "slow-workflow",
    version: "1.0.0",
    description: "Workflow with one slow tool node",
    nodes: [slowToolNode],
    edges: [],
    entry: "__default_entry__",
    outputs: [],
    inputs: {},
    metadata: { tags: [] },
    config: { timeout: null, debug: false, strict: false, maxIterations: 100, loopEnabled: false },
  };
}

describe("Workflow timeout → failed/stopped state (Capabilities 2 + 4)", () => {
  let registry: NodeRegistry;
  let engine: WorkflowEngine;
  let records: Map<string, { metadata: any; messages: any[] }>;
  let capturedStartTime: number;

  beforeEach(() => {
    capturedStartTime = 0;
    registry = new NodeRegistry();
    const sleepTool: Tool = {
      name: "sleep-tool",
      execute: async (input: any) => {
        capturedStartTime = Date.now();
        const ms = (input?.sleep_ms as number) ?? 0;
        await new Promise((resolve) => setTimeout(resolve, ms));
        return { output: "slept" };
      },
    };
    const toolRegistry = {
      getTool: (name: string) => (name === "sleep-tool" ? sleepTool : undefined),
      hasTool: (name: string) => name === "sleep-tool",
    };
    registry.register("tool", (definition) => new ToolNode(definition, toolRegistry as any));
    const sessionInfo = makeTrackingSession();
    records = sessionInfo.records;
    engine = new WorkflowEngine(registry, sessionInfo.session);
  });

  it("S1 (RED→GREEN): after node timeout, runWorkflow resolves with status='failed'", async () => {
    // Tool sleeps 1000ms, timeout is 100ms → guaranteed timeout
    const wf = buildSlowWorkflow(1000, 100);

    const result = await engine.runWorkflow(wf, {
      input: { foo: "bar" },
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("timeout");
  });

  it("S2 (RED→GREEN): after node timeout, session metadata.status === 'failed'", async () => {
    const wf = buildSlowWorkflow(1000, 100);

    const result = await engine.runWorkflow(wf, { input: {} });

    // The session id is also the run id (Task #1837)
    const rec = records.get(result.runId);
    expect(rec).toBeDefined();
    expect(rec?.metadata.status).toBe("failed");
  });

  it("S3 (RED→GREEN): isSessionActive(runId) is false after timeout (cleaned up)", async () => {
    const wf = buildSlowWorkflow(1000, 100);

    const result = await engine.runWorkflow(wf, { input: {} });

    expect(engine.isSessionActive(result.runId)).toBe(false);
  });

  it("S4 (RED→GREEN): stop on already-failed workflow is a safe no-op (no throw)", async () => {
    const wf = buildSlowWorkflow(1000, 100);

    const result = await engine.runWorkflow(wf, { input: {} });
    expect(result.status).toBe("failed");

    // Calling stop on an already-failed run must not throw — only throws
    // for active running/paused sessions in the current engine contract.
    expect(() => engine.stop(result.runId, "test no-op")).not.toThrow();
  });
});