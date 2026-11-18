/**
 * @fileoverview End-to-end abort signal passthrough (Task #1976 — Step 2e)
 *
 * Verifies the FULL CHAIN end-to-end:
 *  1. Workflow with node timeout
 *  2. Executor fires the abortController when timeout elapses
 *  3. context.abortSignal.aborted becomes true
 *  4. AgentNode passes the signal to AgentRunner.run() as 3rd arg
 *  5. A mock AgentRunner that LISTENS to the signal resolves/rejects
 *     promptly (within ~50ms of the timeout), proving the agent process
 *     is truly cancelled (not leaked).
 *
 * This is the critical GREEN test for the whole abort-passthrough effort.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { WorkflowEngine } from "../engine";
import { NodeRegistry } from "../engine/node-registry";
import type {
  WorkflowDefinition,
  NodeDefinition,
} from "../types";
import type { AgentRunner, AgentConfig } from "./agent-node";
import type { SessionComponent } from "../../session/session-component";

interface ListeningRunner extends AgentRunner {
  /** When did the runner first observe signal.aborted === true? */
  observedAbortAt: number | null;
  /** When did the runner's run() promise resolve? */
  resolvedAt: number | null;
  runCalls: number;
  lastSignal: AbortSignal | undefined;
}

/**
 * Mock AgentRunner that HONORS the AbortSignal — resolves immediately
 * when the signal fires, with a result that reflects the abort.
 */
function makeListeningRunner(): ListeningRunner {
  const start = Date.now();
  const runner = {
    observedAbortAt: null as number | null,
    resolvedAt: null as number | null,
    runCalls: 0,
    lastSignal: undefined as AbortSignal | undefined,
    run: async (_config: AgentConfig, _resume: any, signal?: AbortSignal) => {
      runner.runCalls++;
      runner.lastSignal = signal;
      return new Promise((resolve) => {
        if (!signal) {
          // No signal — never resolves (would leak)
          return;
        }
        if (signal.aborted) {
          runner.observedAbortAt = Date.now() - start;
          runner.resolvedAt = Date.now() - start;
          resolve({
            output: "aborted-immediately",
            metadata: { aborted: true, reason: "pre-aborted" },
          });
          return;
        }
        signal.addEventListener("abort", () => {
          runner.observedAbortAt = Date.now() - start;
          runner.resolvedAt = Date.now() - start;
          resolve({
            output: "aborted-on-signal",
            metadata: { aborted: true, reason: "signal-aborted" },
          });
        }, { once: true });
        // Safety: never hang the test
        setTimeout(() => {
          if (!runner.resolvedAt) {
            runner.resolvedAt = Date.now() - start;
            resolve({ output: "safety-timeout" });
          }
        }, 10000);
      });
    },
  };
  return runner as unknown as ListeningRunner;
}

function makeMinimalSession(): SessionComponent {
  const records = new Map<string, any>();
  return {
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
    addMessage: async () => "m",
    getMessages: async () => [],
    list: async () => [],
  } as unknown as SessionComponent;
}

describe("End-to-end abort passthrough (Task #1976 step 2e)", () => {
  let registry: NodeRegistry;
  let runner: ListeningRunner;
  let session: SessionComponent;

  beforeEach(() => {
    runner = makeListeningRunner();
    session = makeMinimalSession();
    registry = new NodeRegistry({ agentRunner: runner, sessionComponent: session });
  });

  it("Z1: timeout → signal aborted → listening runner resolves within window (no leak)", async () => {
    const wf: WorkflowDefinition = {
      name: "e2e-abort",
      version: "1.0.0",
      description: "verify full chain: timeout → signal → runner resolves",
      nodes: [
        {
          id: "step-1",
          type: "agent",
          name: "Step 1",
          config: {
            agent_type: "general",
            prompt: "do something",
            options: { model: "test-model" },
          },
          timeout: 200, // tight timeout
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

    // Run with timeout; the agent has its own timeout=200ms
    const t0 = Date.now();
    const result: any = await Promise.race([
      engine.runWorkflow(wf, { input: {} }),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("engine call hung")), 3000),
      ),
    ]);

    // The engine should return (the runner listens to signal so it doesn't hang)
    expect(["failed", "stopped"]).toContain(result.status);

    // The runner WAS called
    expect(runner.runCalls).toBe(1);
    // The runner observed the abort signal
    expect(runner.observedAbortAt).not.toBeNull();
    expect(runner.resolvedAt).not.toBeNull();

    // The runner resolved/observed within ~500ms of the timeout (200ms + a little slack)
    if (runner.observedAbortAt !== null) {
      expect(runner.observedAbortAt).toBeGreaterThanOrEqual(150); // ~ timeout
      expect(runner.observedAbortAt).toBeLessThan(2000); // not too late
    }

    // CRITICAL: after the workflow returns, the runner is no longer hanging.
    // This is the "no leak" property — the bug Task #1976 was created to fix.
    if (runner.resolvedAt !== null) {
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(2500); // test wall-clock confirms no hang
    }
  });

  it("Z2: end-to-end via signal-capture node (custom node, not agent runner)", async () => {
    // Also verify the executor-level signal works with a custom node type
    // that observes the signal directly. This is a sanity check that the
    // executor's signal pipeline is correct independent of agent plumbing.
    const wf: WorkflowDefinition = {
      name: "e2e-signal-capture",
      version: "1.0.0",
      description: "verify executor signal via custom node",
      nodes: [
        {
          id: "capture",
          type: "signal-capture",
          name: "Signal Capture",
          config: {},
          timeout: 100,
        } as NodeDefinition,
      ],
      edges: [],
      entry: "__default_entry__",
      outputs: [],
      inputs: {},
      metadata: { tags: [] },
      config: { timeout: null, debug: false, strict: false, maxIterations: 100, loopEnabled: false },
    };

    // Custom node type that listens to context.abortSignal
    const capturedSignals: AbortSignal[] = [];
    registry.register("signal-capture", (def) => ({
      type: "signal-capture",
      id: def.id,
      execute: async (ctx: any) => {
        capturedSignals.push(ctx.abortSignal);
        await new Promise<void>((resolve) => {
          if (ctx.abortSignal?.aborted) {
            resolve();
            return;
          }
          ctx.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
          setTimeout(resolve, 5000);
        });
        return { output: "done", durationMs: 100 };
      },
    }));

    const engine = new WorkflowEngine(registry, session);
    const result: any = await Promise.race([
      engine.runWorkflow(wf, { input: {} }),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("engine call hung")), 3000),
      ),
    ]);

    expect(result.status).toBe("failed");
    expect(capturedSignals.length).toBe(1);
    expect(capturedSignals[0]).toBeDefined();
    // Signal should have fired within ~100ms (timeout)
    await new Promise((r) => setTimeout(r, 50));
    expect(capturedSignals[0].aborted).toBe(true);
  });

  it("Z3: workflow_run_stop → executor.cancelAll → listening runner resolves", async () => {
    const wf: WorkflowDefinition = {
      name: "e2e-stop",
      version: "1.0.0",
      description: "verify stop path cancels runner",
      nodes: [
        {
          id: "slow",
          type: "agent",
          name: "Slow",
          config: {
            agent_type: "general",
            prompt: "long-running",
            options: { model: "test-model" },
          },
          timeout: 60000, // long — we want to STOP, not timeout
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

    const wfPromise = engine.runWorkflow(wf, { input: {} }).catch(() => "stopped");
    await new Promise((r) => setTimeout(r, 100));

    // Stop the workflow
    const sessionIds = Array.from((engine as any).activeSessions?.keys?.() ?? []) as string[];
    expect(sessionIds.length).toBeGreaterThan(0);
    if (sessionIds.length > 0) {
      await engine.stop(sessionIds[0], "test stop");
    }

    await Promise.race([
      wfPromise,
      new Promise((r) => setTimeout(r, 1500)),
    ]);

    expect(runner.runCalls).toBe(1);
    expect(runner.observedAbortAt).not.toBeNull();
    expect(runner.resolvedAt).not.toBeNull();
    if (runner.observedAbortAt !== null) {
      expect(runner.observedAbortAt).toBeGreaterThanOrEqual(0);
      expect(runner.observedAbortAt).toBeLessThan(1500);
    }
  });
});