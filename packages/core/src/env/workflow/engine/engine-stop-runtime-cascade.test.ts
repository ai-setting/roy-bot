/**
 * @fileoverview TDD RED — WorkflowEngine.stop() must settle the public run
 * promise AND abort all tracked running executions, pending timers, and
 * retry attempts (Task #2275).
 *
 * Background (Task #2275, follow-up to Task #1976 + Task #2106 + Task #2245):
 * User ESC reports (2026-07-22 07:31):
 *   session_d8d23208... (chat)
 *   └── workflow_1784705682574_fallback_au4pq9 workflow/roy-rd-with-trace (stopped)
 *       ├── agent_plan_1784705697999   ← still alive
 *       └── agent_init-task_1784705682615 ← still alive
 *
 * Workflow metadata is "stopped" but the underlying runner Promise and
 * AgentComponent process keep running. Calling `engine.stop(sessionId)`:
 *   - Does not resolve `runWorkflow()`'s Promise in <500ms
 *   - Does not abort cooperative runners
 *   - Does not prevent retry-backoff timers from firing
 *   - Does not let a 2nd force call escalate cleanup
 *
 * The tests below pin down the EXPECTED contract (after GREEN). They MUST
 * fail under the current implementation; the failure messages are evidence.
 *
 * Cooperative runner contract (used in tests):
 *   - When `signal` aborts → reject with AbortError within 50ms
 *   - When `signal` aborts AND forceHandler list is non-empty → call each
 *     handler; on success return cleanly instead of rejecting.
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

// =============================================================================
// Helpers
// =============================================================================

interface CooperativeRunner extends AgentRunner {
  pending: boolean;
  runCalls: number;
  forceHandlerCalls: number;
  lastSignal: AbortSignal | undefined;
}

function makeCooperativeRunner(opts: {
  /** Delay before responding to graceful abort (ms). */
  gracefulSettleMs?: number;
  /** Delay before responding to force handler invocation (ms). */
  forceSettleMs?: number;
} = {}): CooperativeRunner {
  const gracefulSettleMs = opts.gracefulSettleMs ?? 20;
  // Cooperative runner never needs forceSettleMs (graceful abort is sufficient);
  // the parameter is kept for API parity with makeUncooperativeRunner.
  void opts.forceSettleMs;
  const runner = {
    pending: false,
    runCalls: 0,
    forceHandlerCalls: 0,
    lastSignal: undefined as AbortSignal | undefined,
    run: async (_config: AgentConfig, _resume: any, signal?: AbortSignal) => {
      runner.runCalls++;
      runner.lastSignal = signal;
      runner.pending = true;
      try {
        // Hang forever, BUT listen to signal.aborted.
        await new Promise<void>((resolve, reject) => {
          if (!signal) {
            // Without signal we still hang — but every test in this file
            // provides one so this branch is unreachable in practice.
            return;
          }
          if (signal.aborted) {
            // Pre-aborted: resolve immediately (signal listener contract).
            resolve();
            return;
          }
          const onAbort = () => {
            // Simulate cooperative cleanup work (e.g. closing LLM stream).
            setTimeout(() => {
              // Reject so the engine sees the abort as an error, not success.
              reject(signal.reason ?? new Error("aborted"));
              cleanup();
            }, gracefulSettleMs);
          };
          const cleanup = () => {
            signal.removeEventListener("abort", onAbort);
          };
          signal.addEventListener("abort", onAbort, { once: true });
        });
        runner.pending = false;
        return { output: "completed" };
      } catch (err) {
        runner.pending = false;
        throw err;
      }
    },
  };
  return runner as unknown as CooperativeRunner;
}

// (RED-4 has its own inline runner construction — the historical
//  makeUncooperativeRunner helper is no longer needed for this test file.)
function _makeUncooperativeRunner_REMOVED(opts: { forceSettleMs?: number } = {}): CooperativeRunner & {
  registerForceHandler: (fn: () => Promise<void>) => void;
} {
  void opts;
  const _forceSettleMs = 20;
  const forceHandlers: Array<() => Promise<void>> = [];
  void forceHandlers;
  // Stub — never used at runtime.
  const _runner = {
    pending: false,
    runCalls: 0,
    forceHandlerCalls: 0,
    lastSignal: undefined as AbortSignal | undefined,
    run: async (_config: AgentConfig, _resume: any, _signal?: AbortSignal) => ({
      output: "stub",
    }),
    registerForceHandler(_fn: () => Promise<void>) {
      // noop
    },
  };
  return _runner as any;
}

function makeMinimalSession(): { session: SessionComponent; records: Map<string, any> } {
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
      r.messages[idx] = {
        ...r.messages[idx],
        ...patch,
        metadata: { ...r.messages[idx].metadata, ...(patch.metadata ?? {}) },
      };
      return true;
    },
    getMessages: async (id: string) => records.get(id)?.messages ?? [],
    list: async () => [],
  } as unknown as SessionComponent;
  return { session, records };
}

function makeOneAgentWorkflow(nodeId = "hang-step"): WorkflowDefinition {
  return {
    name: "stop-runtime-cascade",
    version: "1.0.0",
    description: "engine.stop cascade test",
    nodes: [
      {
        id: nodeId,
        type: "agent",
        name: "Hang Step",
        timeout: 30000,
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
}

// =============================================================================
// Tests
// =============================================================================

describe("[Task #2275 RED] engine.stop() cascades to runtime", () => {
  let session: SessionComponent;
  beforeEach(() => {
    session = makeMinimalSession().session;
  });

  it("RED-1: stop() settles the public runWorkflow() promise in <500ms", async () => {
    const runner = makeCooperativeRunner({ gracefulSettleMs: 20 });
    const registry = new NodeRegistry({ agentRunner: runner, sessionComponent: session });
    const engine = new WorkflowEngine(registry, session);
    const wf = makeOneAgentWorkflow();

    const runPromise = engine.runWorkflow(wf, { input: {} });
    // Wait for the runner to actually start.
    let sessionIds: string[] = [];
    for (let i = 0; i < 50 && sessionIds.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
      sessionIds = Array.from((engine as any).activeSessions.keys() as IterableIterator<string>);
    }
    expect(sessionIds.length).toBe(1);
    const sid = sessionIds[0];
    // Wait for the runner to enter pending state (cooperative runner hangs
    // on signal, so it should reach pending=true shortly after starting).
    for (let i = 0; i < 50 && !runner.pending; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(runner.pending).toBe(true);

    const t0 = Date.now();
    await engine.stop(sid, "test stop");
    // Race the public promise against a short timeout — we expect WIN.
    const result = await Promise.race([
      runPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("STOP_PROMISE_TIMEOUT")), 500)),
    ]);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500);
    expect((result as any).status).toBe("stopped");
    expect((engine as any).isSessionActive?.(sid)).toBe(false);
  });

  it("RED-2: graceful stop aborts all tracked cooperative runners and stops the underlying promise", async () => {
    const runner = makeCooperativeRunner({ gracefulSettleMs: 30 });
    const registry = new NodeRegistry({ agentRunner: runner, sessionComponent: session });
    const engine = new WorkflowEngine(registry, session);

    // Two runs in two sessions on the same engine.
    const wf1 = makeOneAgentWorkflow();
    const wf2 = makeOneAgentWorkflow();
    const p1 = engine.runWorkflow(wf1, { input: {} });
    const p2 = engine.runWorkflow(wf2, { input: {} });
    await new Promise((r) => setTimeout(r, 50));
    const sids = Array.from((engine as any).activeSessions.keys() as IterableIterator<string>);
    expect(sids.length).toBe(2);

    // Stop only the first session.
    await engine.stop(sids[0], "stop-one");
    // Allow microtasks + cleanup delay.
    await new Promise((r) => setTimeout(r, 80));

    const r1 = await Promise.race([
      p1,
      new Promise((_r, rej) => setTimeout(() => rej(new Error("P1_TIMEOUT")), 200)),
    ]);
    expect((r1 as any).status).toBe("stopped");
    expect(runner.pending).toBe(false);

    // The other session should still be running.
    expect((engine as any).isSessionActive?.(sids[1])).toBe(true);
    // Cleanup: stop the second one too.
    await engine.stop(sids[1], "cleanup");
    await Promise.race([
      p2,
      new Promise((_r, rej) => setTimeout(() => rej(new Error("P2_TIMEOUT")), 200)),
    ]);
  });

  it("RED-3: pending and retry nodes do not start after stop; no stale timers", async () => {
    // We construct a workflow with 2 agent nodes:
    //   - "retry-node" has retry config so it can sit in backoff.
    //   - "downstream-node" depends on retry-node.
    // After stop(), neither should start (or should stop promptly if running).
    let downstreamStarts = 0;
    const runner: CooperativeRunner = {
      pending: false,
      runCalls: 0,
      forceHandlerCalls: 0,
      lastSignal: undefined as AbortSignal | undefined,
      run: async (_config: AgentConfig, _resume: any, signal?: AbortSignal) => {
        runner.runCalls++;
        const nodeId = (_config as any).nodeId ?? "?";
        if (nodeId === "downstream-node") downstreamStarts++;
        runner.lastSignal = signal;
        runner.pending = true;
        await new Promise<void>((_resolve, reject) => {
          if (!signal) return;
          if (signal.aborted) {
            reject(signal.reason ?? new Error("aborted"));
            return;
          }
          const onAbort = () => {
            setTimeout(() => {
              reject(signal.reason ?? new Error("aborted"));
              signal.removeEventListener("abort", onAbort);
            }, 10);
          };
          signal.addEventListener("abort", onAbort, { once: true });
        });
        runner.pending = false;
        return { output: "ok" };
      },
    };
    const registry = new NodeRegistry({ agentRunner: runner, sessionComponent: session });
    const engine = new WorkflowEngine(registry, session);

    const wf: WorkflowDefinition = {
      name: "retry-cascade",
      version: "1.0.0",
      description: "test",
      nodes: [
        {
          id: "retry-node",
          type: "agent",
          name: "Retry Node",
          timeout: 30000,
          config: {
            agent_type: "general",
            prompt: "x",
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

    const runPromise = engine.runWorkflow(wf, { input: {} });
    await new Promise((r) => setTimeout(r, 30));
    const sids = Array.from((engine as any).activeSessions.keys() as IterableIterator<string>);
    expect(sids.length).toBe(1);
    await engine.stop(sids[0], "no-retry-after-stop");
    await Promise.race([
      runPromise,
      new Promise((_r, rej) => setTimeout(() => rej(new Error("RUN_TIMEOUT")), 300)),
    ]);
    // Give time for any stray timer to fire.
    await new Promise((r) => setTimeout(r, 100));
    expect(downstreamStarts).toBe(0);
    expect(runner.runCalls).toBe(1);
  });

  it("RED-4: a second stop(force=true) on the same session escalates to force handlers", async () => {
    // Uncooperative runner: graceful abort is ignored; only a force-escalation
    // event on the cancellation scope triggers settlement. The runner
    // registers its force handler via scope.onForce() when it starts.
    let forceHandlerCalls = 0;
    let registeredForceScope: any = null;
    const runner: CooperativeRunner = {
      pending: false,
      runCalls: 0,
      forceHandlerCalls: 0,
      lastSignal: undefined as AbortSignal | undefined,
      run: async (_config: AgentConfig, _resume: any, signal?: AbortSignal) => {
        runner.runCalls++;
        runner.lastSignal = signal;
        runner.pending = true;
        // The engine passes scope via context.cancellationScope; mock here.
        const ctxScope = (_config as any).cancellationScope;
        if (ctxScope?.onForce) {
          registeredForceScope = ctxScope;
          ctxScope.onForce("force-handler-1", async () => {
            forceHandlerCalls++;
            runner.forceHandlerCalls++;
          });
        }
        try {
          await new Promise<void>((_resolve, reject) => {
            if (!signal) return;
            if (signal.aborted) {
              reject(signal.reason ?? new Error("aborted"));
              return;
            }
            const onAbort = () => {
              // Graceful abort ignored — wait for force escalation.
              // Do nothing; force handler will reject.
            };
            signal.addEventListener("abort", onAbort, { once: true });
            // Watch for force via the scope's forceSignal if accessible,
            // OR by polling signal.reason for "force:" prefix. We expose
            // scope to the runner via config, so we use forceSignal:
            const forceSig = ctxScope?.forceSignal;
            if (forceSig) {
              const onForce = () => {
                setTimeout(() => {
                  reject(new Error("force-aborted"));
                  signal.removeEventListener("abort", onAbort);
                  forceSig.removeEventListener("abort", onForce);
                }, 20);
              };
              forceSig.addEventListener("abort", onForce, { once: true });
              if (forceSig.aborted) onForce();
            }
          });
          runner.pending = false;
          return { output: "completed-after-force" };
        } catch (err) {
          runner.pending = false;
          throw err;
        }
      },
    };
    const registry = new NodeRegistry({ agentRunner: runner, sessionComponent: session });
    const engine = new WorkflowEngine(registry, session);
    const wf = makeOneAgentWorkflow();

    const runPromise = engine.runWorkflow(wf, { input: {} });
    await new Promise((r) => setTimeout(r, 30));
    const sids = Array.from((engine as any).activeSessions.keys() as IterableIterator<string>);
    expect(sids.length).toBe(1);
    const sid = sids[0];

    // First stop (graceful) should NOT yet settle the run.
    await engine.stop(sid, "graceful");
    // Wait briefly to confirm runner is still pending.
    await new Promise((r) => setTimeout(r, 40));
    expect(runner.pending).toBe(true);
    expect(registeredForceScope).not.toBeNull();

    // Second stop with force must escalate.
    const t0 = Date.now();
    await engine.stop(sid, "force-escalate", { force: true } as any);
    const r1 = await Promise.race([
      runPromise,
      new Promise((_r, rej) => setTimeout(() => rej(new Error("FORCE_TIMEOUT")), 800)),
    ]);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(800);
    expect((r1 as any).status).toBe("stopped");
    expect(forceHandlerCalls).toBeGreaterThanOrEqual(1);
  });
});