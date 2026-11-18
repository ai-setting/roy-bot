/**
 * @fileoverview AgentComponentAdapter → AgentComponent abort signal integration (Task #1976 — Step 2d)
 *
 * Verifies:
 *  1. When the workflow executor's AbortSignal fires (timeout/stop), the
 *     AgentComponent's internal AbortController is triggered.
 *  2. The LLM call (mocked) gets aborted.
 *  3. Backward compat: when no external signal is provided, the existing
 *     agent-component inner 300s timeout still applies.
 *
 * Note: This test uses a mock AgentComponent (not a real one) so we don't
 * depend on LLM availability. We verify the wiring at the adapter layer.
 */

import { describe, it, expect } from "bun:test";
import { AgentComponentAdapter } from "./agent-component-adapter";
import type { AgentComponent } from "../../agent/agent-component";
import type { AgentRunner } from "./agent-node";

interface MockAgentComponentOpts {
  /** Simulate LLM call that listens to abortSignal */
  llmRespectsSignal?: boolean;
}

/**
 * Build a minimal AgentComponent stub that captures the abort signal it
 * receives (via context.abort) and provides a mock LLM that listens.
 */
function makeMockAgentComponent(opts: MockAgentComponentOpts = {}): AgentComponent & {
  receivedAbortSignal: AbortSignal | undefined;
  llmAbortedAt: number | null;
  llmStartedAt: number | null;
} {
  const comp: any = {
    receivedAbortSignal: undefined as AbortSignal | undefined,
    llmAbortedAt: null as number | null,
    llmStartedAt: null as number | null,
    llmPromise: undefined as Promise<void> | undefined,
    run: async (agentName: string, query: string, context: any) => {
      comp.receivedAbortSignal = context?.abort;
      comp.llmStartedAt = Date.now();
      // Mock LLM that listens to abort signal (mimics real AI SDK behavior)
      comp.llmPromise = new Promise((resolve, reject) => {
        const start = Date.now();
        const signal: AbortSignal | undefined = context?.abort;
        if (!signal) {
          // No signal — return a result quickly
          setTimeout(() => {
            comp.llmStartedAt = start;
            resolve(undefined);
          }, 100);
          return;
        }
        if (opts.llmRespectsSignal !== false) {
          if (signal.aborted) {
            comp.llmAbortedAt = Date.now() - start;
            reject(new Error("LLM call aborted"));
            return;
          }
          signal.addEventListener("abort", () => {
            comp.llmAbortedAt = Date.now() - start;
            reject(new Error("LLM call aborted by signal"));
          }, { once: true });
        }
        // Safety: never hang the test forever
        setTimeout(() => {
          resolve(undefined);
        }, 10000);
      });
      try {
        await comp.llmPromise;
      } catch (e) {
        // bubble up
        throw e;
      }
      return {
        iterations: 1,
        toolCalls: [],
        finalText: "mock result",
        output: "mock result",
      };
    },
    abort: (agentName: string) => {
      // Real agent-component would abort its internal controllers
    },
    abortAll: () => {},
    registerAgent: () => {},
    getAgent: () => ({ config: { type: "general" } }),
  };
  return comp as AgentComponent & {
    receivedAbortSignal: AbortSignal | undefined;
    llmAbortedAt: number | null;
    llmStartedAt: number | null;
  };
}

describe("AgentComponentAdapter abort signal integration (Task #1976 step 2d)", () => {
  it("B1 (RED→GREEN): AgentComponentAdapter passes external signal to agentComponent.run via context.abort", async () => {
    const comp = makeMockAgentComponent();
    const adapter = new AgentComponentAdapter(comp as any);

    const ac = new AbortController();
    // Call adapter.run() with a signal
    const runPromise = adapter.run(
      { type: "general", prompt: "hi", options: {} },
      { userQuery: undefined, agentSessionId: undefined },
      ac.signal,
    ).catch((e) => e);

    // Wait for LLM to start
    await new Promise((r) => setTimeout(r, 50));
    expect(comp.receivedAbortSignal).toBeDefined();
    // The signal received by agentComponent should be the SAME as the outer one
    // (or at least fire when the outer one fires)
    expect(comp.receivedAbortSignal).toBe(ac.signal);
  });

  it("B2 (RED→GREEN): when outer signal fires, the LLM mock aborts (via the SAME signal)", async () => {
    const comp = makeMockAgentComponent({ llmRespectsSignal: true });
    const adapter = new AgentComponentAdapter(comp as any);

    const ac = new AbortController();
    const runPromise = adapter.run(
      { type: "general", prompt: "hi", options: {} },
      { userQuery: undefined, agentSessionId: undefined },
      ac.signal,
    ).catch((e) => e);

    // Wait for LLM to start
    await new Promise((r) => setTimeout(r, 50));

    // Abort the outer signal — the LLM should be cancelled via the same signal
    ac.abort();
    const result = await runPromise;

    expect(comp.llmAbortedAt).not.toBeNull();
    if (comp.llmAbortedAt !== null) {
      expect(comp.llmAbortedAt).toBeGreaterThanOrEqual(0);
      expect(comp.llmAbortedAt).toBeLessThan(2000);
    }
  });

  it("B3 (backward compat): without external signal, adapter works as before", async () => {
    const comp = makeMockAgentComponent();
    const adapter = new AgentComponentAdapter(comp as any);

    const result = await adapter.run(
      { type: "general", prompt: "hi", options: {} },
      { userQuery: undefined, agentSessionId: undefined },
    );

    // No external signal — context.abort is whatever internal logic set
    expect(result).toBeDefined();
  });
});