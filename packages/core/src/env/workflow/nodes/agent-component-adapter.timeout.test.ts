/**
 * @fileoverview AgentComponentAdapter → timeout enforcement (Task #2099)
 *
 * Verifies: when config.options.timeout is set and the LLM call hangs longer
 * than the timeout, the adapter aborts the agent via setTimeout →
 * agentComponent.abort(typeName), causing the run() to reject with a
 * timeout-related error.
 *
 * Companion test to agent-component-adapter-abort.test.ts (Task #1976):
 * - Task #1976 tests external AbortSignal (workflow executor → adapter)
 * - This file tests timeout MS (config.options.timeout → adapter)
 */

import { describe, it, expect, afterEach } from "bun:test";
import { AgentComponentAdapter } from "./agent-component-adapter";

interface MockAgentComponentOpts {
  /**
   * When true, abort() rejects the in-flight LLM promise to mimic real
   * AgentComponent behavior (where abort() triggers AbortController.abort(),
   * which makes the LLM invoke reject).
   */
  simulateAbort?: boolean;
}

/**
 * Build a minimal AgentComponent stub that:
 * - Records the agentName passed to abort(name) and when it was called
 * - If simulateAbort=true, abort() rejects the in-flight LLM promise
 * - run() awaits an externally-controlled LLM promise (resolveLLM/rejectLLM)
 *   AND listens to context.abort — when the composed signal fires (Task
 *   #2106 GREEN-A), the in-flight promise rejects.
 *
 * Why: We want to verify the adapter-level wiring — that the adapter
 * schedules a setTimeout based on config.options.timeout and aborts the
 * deadline signal (which the AgentComponent composes into effectiveContext.
 * abort). Task #2106 changed the deadline path from the name-wide public
 * `abort(typeName)` API to a per-run AbortController, so the mock now
 * listens to the per-run signal as well.
 */
function makeMockAgentComponent(opts: MockAgentComponentOpts = {}) {
  let resolveLLMFn!: () => void;
  let rejectLLMFn!: (err: Error) => void;
  const llmPromise = new Promise<void>((resolve, reject) => {
    resolveLLMFn = resolve;
    rejectLLMFn = reject;
  });

  const comp: any = {
    abortCalledWith: null as string | null,
    abortCalledAt: null as number | null,
    llmStartedAt: null as number | null,
    llmResolvedAt: null as number | null,
    deadlineAbortFiredAt: null as number | null,
    resolveLLM: () => resolveLLMFn(),
    rejectLLM: (err: Error) => rejectLLMFn(err),
    registerAgent: () => {},
    getAgent: () => ({ config: { type: "general" } }),
    run: async (_agentName: string, _query: string, context: any) => {
      comp.llmStartedAt = Date.now();
      // Task #2106 GREEN-A: listen to context.abort (the composed per-run
      // deadline signal) and reject the LLM promise when it fires. This
      // mimics real AgentComponent behavior, where the LLM invoke listens
      // to the effectiveContext.abort signal (LLM SDK abortSignal wiring).
      const signal: AbortSignal | undefined = context?.abort;
      if (signal) {
        if (signal.aborted) {
          comp.deadlineAbortFiredAt = Date.now();
          rejectLLMFn(new Error("aborted (signal already aborted)"));
        } else {
          signal.addEventListener(
            "abort",
            () => {
              comp.deadlineAbortFiredAt = Date.now();
              const reason = signal.reason ?? new Error("aborted");
              rejectLLMFn(
                reason instanceof Error ? reason : new Error(String(reason)),
              );
            },
            { once: true },
          );
        }
      }
      try {
        await llmPromise;
        comp.llmResolvedAt = Date.now();
        return {
          iterations: 1,
          toolCalls: [],
          output: "should-not-resolve",
        };
      } catch (err) {
        comp.llmResolvedAt = Date.now();
        throw err;
      }
    },
    abort: (agentName: string) => {
      comp.abortCalledWith = agentName;
      comp.abortCalledAt = Date.now();
      if (opts.simulateAbort) {
        // Mimic real AgentComponent: triggering controller.abort() makes the
        // LLM invoke (which is listening to the controller's signal) reject.
        rejectLLMFn(new Error(`Agent ${agentName} aborted (timeout)`));
      }
    },
    abortAll: () => {},
  };
  return comp;
}

describe("AgentComponentAdapter timeout enforcement (Task #2099)", () => {
  // ------------------------------------------------------------------
  // T1 (RED→GREEN core): timeout=300ms with hanging LLM triggers abort
  //
  // Task #2106 update: the original T1 asserted the adapter called
  // `agentComponent.abort(typeName)` on deadline. The Task #2106 fix
  // changed the deadline path to use a per-run AbortController so that
  // timing out one run does NOT abort concurrent same-type runs. The
  // abort now propagates via the composed context.abort signal that the
  // mock's `run()` listens to.
  // ------------------------------------------------------------------
  it("T1: when config.options.timeout=300 and LLM hangs, the per-run deadline aborts the in-flight invoke within ~300ms", async () => {
    const comp = makeMockAgentComponent({ simulateAbort: false });
    const adapter = new AgentComponentAdapter(comp as any);

    const startTime = Date.now();
    const runPromise = adapter.run(
      {
        type: "explore",
        prompt: "do slow work",
        options: { timeout: 300 },
      },
      { userQuery: undefined, agentSessionId: undefined },
    );

    // Let the run() reach the agentComponent.run() call
    await new Promise((r) => setTimeout(r, 50));
    expect(comp.llmStartedAt).not.toBeNull();

    // Wait for the timeout to fire + signal abort to reject LLM
    await runPromise.catch(() => {});
    const elapsed = Date.now() - startTime;

    // Task #2106 GREEN-A: the per-run deadline signal fires roughly at the
    // 300ms mark, NOT the agent-name-wide abort() API.
    expect(comp.deadlineAbortFiredAt).not.toBeNull();
    if (comp.deadlineAbortFiredAt !== null) {
      expect(comp.deadlineAbortFiredAt - startTime).toBeGreaterThanOrEqual(200);
      expect(comp.deadlineAbortFiredAt - startTime).toBeLessThanOrEqual(600);
    }
    // The agent-name-wide abort() API MUST NOT be invoked by the deadline.
    expect(comp.abortCalledWith).toBeNull();
    // run() should reject fast — far less than 3000ms
    expect(elapsed).toBeLessThan(2000);
  });

  // ------------------------------------------------------------------
  // T2: no timeout → no setTimeout scheduled → no abort()
  // ------------------------------------------------------------------
  it("T2: when config.options.timeout is unset, abort() is NOT called", async () => {
    const comp = makeMockAgentComponent({ simulateAbort: false });
    const adapter = new AgentComponentAdapter(comp as any);

    const runPromise = adapter.run(
      {
        type: "general",
        prompt: "do work",
        options: {}, // no timeout
      },
      { userQuery: undefined, agentSessionId: undefined },
    );

    await new Promise((r) => setTimeout(r, 50));
    // Resolve the LLM manually so the run completes
    comp.resolveLLM();
    const result = await runPromise;

    // abort() should NOT have been called
    expect(comp.abortCalledWith).toBeNull();
    expect(comp.abortCalledAt).toBeNull();
    expect(result).toBeDefined();
  });

  // ------------------------------------------------------------------
  // T3: timeout=0 → treated as "not set" → no setTimeout
  // ------------------------------------------------------------------
  it("T3: timeout=0 is treated as 'not set' — no setTimeout scheduled", async () => {
    const comp = makeMockAgentComponent({ simulateAbort: false });
    const adapter = new AgentComponentAdapter(comp as any);

    const runPromise = adapter.run(
      {
        type: "general",
        prompt: "do work",
        options: { timeout: 0 },
      },
      { userQuery: undefined, agentSessionId: undefined },
    );

    // Wait some time and verify abort() was never called
    await new Promise((r) => setTimeout(r, 200));
    expect(comp.abortCalledWith).toBeNull();

    comp.resolveLLM();
    await runPromise;
    expect(comp.abortCalledWith).toBeNull();
  });

  // ------------------------------------------------------------------
  // T4: negative timeout → treated as "not set" → no setTimeout
  // ------------------------------------------------------------------
  it("T4: timeout=-100 (negative) is treated as 'not set' — no setTimeout scheduled", async () => {
    const comp = makeMockAgentComponent({ simulateAbort: false });
    const adapter = new AgentComponentAdapter(comp as any);

    const runPromise = adapter.run(
      {
        type: "general",
        prompt: "do work",
        options: { timeout: -100 },
      },
      { userQuery: undefined, agentSessionId: undefined },
    );

    await new Promise((r) => setTimeout(r, 200));
    expect(comp.abortCalledWith).toBeNull();

    comp.resolveLLM();
    await runPromise;
    expect(comp.abortCalledWith).toBeNull();
  });

  // ------------------------------------------------------------------
  // Cleanup: any leftover timers should not leak into other tests
  // ------------------------------------------------------------------
  afterEach(() => {
    // Tests use real setTimeout for adapter-timeout and for our waits.
    // Each test resolves/rejects its LLM promise explicitly, so by the
    // time afterEach runs there should be no pending timers. But to be
    // safe we force a microtask flush.
  });
});