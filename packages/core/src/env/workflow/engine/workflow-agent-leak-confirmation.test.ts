/**
 * @fileoverview Research confirmation: does the agent Promise leak after timeout?
 *
 * Background (Task #1976, follow-up to Task #1974):
 * Engine-level state is now consistent on timeout (failed status, activeSessions
 * cleared, session metadata updated). But the underlying `node.execute()`
 * Promise is leaked — the agent process keeps running after the caller sees
 * 'failed'.
 *
 * This test pins down the symptom:
 *  - Mock AgentRunner deliberately hangs forever (long setTimeout).
 *  - Run a workflow with `timeout=100ms` so the engine returns 'failed'.
 *  - After the workflow returns, check whether the mock runner's run() promise
 *    is still pending. If yes → LEAK CONFIRMED (we need to plumb AbortSignal).
 *    If no  → already cancelled (no follow-up needed at the engine level).
 *
 * Task #1976 — Step 1: research confirmation.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { WorkflowEngine } from "./engine";
import { NodeRegistry } from "./node-registry";
import type {
  WorkflowDefinition,
  NodeDefinition,
} from "../types";
import type { AgentRunner, AgentConfig } from "../nodes/agent-node";
import type { SessionComponent } from "../../session/session-component";

interface HangingRunner extends AgentRunner {
  pending: boolean;
  runCalls: number;
  lastSignal: AbortSignal | undefined;
}

/**
 * Mock AgentRunner that hangs forever (does NOT listen to AbortSignal).
 * Returns a never-resolving Promise — perfect for proving the leak.
 * IMPORTANT: tracker IS the runner (same object), so runner.runCalls++
 * updates the same field we read from outside.
 */
function makeHangingRunner(): HangingRunner {
  const runner = {
    pending: false,
    runCalls: 0,
    lastSignal: undefined as AbortSignal | undefined,
    run: async (_config: AgentConfig, _resume: any, signal?: AbortSignal) => {
      runner.runCalls++;
      runner.lastSignal = signal;
      runner.pending = true;
      // Hang forever — never resolves
      await new Promise(() => {});
      // Unreachable but satisfies the type system
      runner.pending = false;
      return { output: "never" };
    },
  };
  return runner as unknown as HangingRunner;
}

/**
 * Minimal in-memory SessionComponent for engine plumbing.
 */
function makeMinimalSession(): {
  session: SessionComponent;
  records: Map<string, any>;
} {
  const records = new Map<string, any>();
  const session = {
    create: async (opts: any) => {
      records.set(opts.id, { metadata: opts.metadata ?? {}, messages: [] });
      return { id: opts.id, ...opts };
    },
    get: async (id: string) => {
      const r = records.get(id);
      if (!r) return null;
      return { id, title: "t", metadata: r.metadata, createdAt: new Date(), updatedAt: new Date() };
    },
    update: async (id: string, patch: any) => {
      const r = records.get(id);
      if (!r) return false;
      r.metadata = { ...r.metadata, ...(patch.metadata ?? {}) };
      return true;
    },
    addMessage: async (id: string, msg: any) => {
      const r = records.get(id);
      if (r) r.messages.push({ ...msg, id: `msg_${r.messages.length}` });
      return `msg_${Date.now()}`;
    },
    updateMessage: async (id: string, msgId: string, patch: any) => {
      const r = records.get(id);
      if (!r) return false;
      const idx = r.messages.findIndex((m: any) => m.id === msgId);
      if (idx < 0) return false;
      r.messages[idx] = { ...r.messages[idx], ...patch, metadata: { ...r.messages[idx].metadata, ...(patch.metadata ?? {}) } };
      return true;
    },
    getMessages: async (id: string) => records.get(id)?.messages ?? [],
    list: async () => [],
  } as unknown as SessionComponent;
  return { session, records };
}

describe("Research confirmation: agent Promise leak after timeout (Task #1976 step 1)", () => {
  let registry: NodeRegistry;
  let runner: HangingRunner;
  let session: SessionComponent;

  beforeEach(() => {
    runner = makeHangingRunner();
    session = makeMinimalSession().session;
    registry = new NodeRegistry({ agentRunner: runner, sessionComponent: session });
  });

  it("CONFIRM: when workflow times out, does the underlying agent.run() promise settle?", async () => {
    // Workflow has one agent node that hangs forever; engine-level timeout=100ms.
    const wf: WorkflowDefinition = {
      name: "leak-check",
      version: "1.0.0",
      description: "leak confirmation",
      nodes: [
        {
          id: "hang-step",
          type: "agent",
          name: "Hang Step",
          timeout: 100,
          config: {
            agent_type: "general",
            prompt: "echo {{input.q}}",
            options: { model: "test-model" },
          },
        } as NodeDefinition,
      ],
      edges: [],
      entry: "__default_entry__",
      outputs: [],
      inputs: {},
      metadata: { tags: [] },
      config: { timeout: null, debug: false, strict: false, maxIterations: 100, loopEnabled: false },
    };

    const engine = new WorkflowEngine(registry, session);

    // Run with timeout to allow the engine call itself to return
    const result = await Promise.race([
      engine.runWorkflow(wf, { input: { q: "hi" } }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("engine call itself hung")), 3000)),
    ]);

    // The engine should return failed (Task #1974 already proven).
    expect(result.status).toBe("failed");
    expect(runner.runCalls).toBe(1);

    // Now wait 200ms and check if the agent promise has settled.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const leakConfirmed = runner.pending === true;

    if (leakConfirmed) {
      console.log(
        "[RESEARCH] LEAK CONFIRMED: agent runner's run() is still pending " +
        "after engine returned 'failed'. Task #1976 follow-up required: " +
        "plumb AbortSignal through NodeExecutionContext → AgentRunner.",
      );
    } else {
      console.log(
        "[RESEARCH] NO LEAK: agent runner already settled. Engine-level " +
        "cancellation is sufficient; no AbortSignal plumbing needed.",
      );
    }

    // Diagnostic: log the state. We do NOT fail the test here —
    // this is a diagnostic test that documents the symptom.
    expect(typeof leakConfirmed).toBe("boolean");
  });

  it("CONFIRM-2: workflow_run_stop should also cancel hanging agent (DIAGNOSTIC)", async () => {
    // Even without a timeout, workflow_run_stop on a hanging run should
    // propagate cancellation to the runner.
    //
    // IMPORTANT: This test uses a mock runner that DOES NOT listen to
    // AbortSignal — it intentionally hangs forever. This proves the fix
    // works at the engine layer (signal IS plumbed end-to-end), but the
    // actual cancellation requires the runner to honor the signal. Real
    // production runners (AgentComponentAdapter via agent-component) do
    // honor it — see abort-passthrough-e2e.test.ts for the GREEN case.
    //
    // This is a DIAGNOSTIC test — no hard assertions. It just logs the
    // observed state to document the chain.
    const wf: WorkflowDefinition = {
      name: "stop-check",
      version: "1.0.0",
      description: "stop leak confirmation (diagnostic)",
      nodes: [
        {
          id: "hang-step",
          type: "agent",
          name: "Hang Step",
          timeout: 10000,
          config: {
            agent_type: "general",
            prompt: "echo",
            options: { model: "test-model" },
          },
        } as NodeDefinition,
      ],
      edges: [],
      entry: "__default_entry__",
      outputs: [],
      inputs: {},
      metadata: { tags: [] },
      config: { timeout: null, debug: false, strict: false, maxIterations: 100, loopEnabled: false },
    };

    const engine = new WorkflowEngine(registry, session);

    const wfPromise = engine.runWorkflow(wf, { input: {} });
    await new Promise((r) => setTimeout(r, 50));
    const sessionIds = Array.from((engine as any).activeSessions?.keys?.() ?? []) as string[];
    if (sessionIds.length > 0) {
      engine.stop(sessionIds[0], "test cancel");
    }

    // Race: give it 500ms to settle if signal honored, then proceed.
    const result: any = await Promise.race([
      wfPromise.catch(() => "rejected"),
      new Promise((r) => setTimeout(() => r("timeout-window"), 500)),
    ]);

    // Diagnostic: log what we observed
    await new Promise((resolve) => setTimeout(resolve, 100));
    const runnerPending = runner.pending === true;
    const runnerReceivedSignal = runner.lastSignal !== undefined;
    console.log(
      `[DIAGNOSTIC-2] After workflow_run_stop, runner.pending=${runner.pending}, ` +
      `runnerReceivedSignal=${runnerReceivedSignal}, ` +
      `engineSettled=${result !== "timeout-window"}. ` +
      `Note: runnerPending=true means the mock runner DOES NOT honor AbortSignal — ` +
      `real runners (AgentComponentAdapter) do. See abort-passthrough-e2e.test.ts.`,
    );

    // The runner MUST have received the signal (proves the plumbing works)
    expect(runnerReceivedSignal).toBe(true);
  });
});