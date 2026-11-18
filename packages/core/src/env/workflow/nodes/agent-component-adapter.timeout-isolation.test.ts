/**
 * @fileoverview RED probes for Task #2106 — Track A (AgentComponentAdapter timeout isolation)
 *
 * These three probes demonstrate the range-introduced defects called out by
 * the post-6bab7146 verification plan:
 *
 *   - A1: the scheduled setTimeout is never cleared, so a stale timer can
 *        abort a later run of the same agent type.
 *   - A2: agentComponent.abort(typeName) is agent-name-wide; timing out
 *        one run also aborts a concurrent run of the same agent type.
 *   - A3: the adapter currently falls back to the agent-name-wide
 *        agentComponent.abort(typeName) on timeout, instead of using a
 *        per-run AbortController that would only cancel the deadline
 *        controller for the one run that timed out.
 *
 * Each probe is expected to FAIL on the current branch (commit range
 * 6bab7146..HEAD) and PASS after the corresponding fix lands.
 */

import { describe, it, expect } from "bun:test";
import { AgentComponentAdapter } from "./agent-component-adapter";

interface MockAgentComponentOpts {
  simulateAbort?: boolean;
}

function makeMockAgentComponent(opts: MockAgentComponentOpts = {}) {
  // Per-run LLM promises (so concurrent runs have independent LLM state).
  const runResolvers = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  const runOutputs = new Map<number, { finalText: string; iterations: number; toolCalls: unknown[] }>();
  const abortCalls: Array<{ name: string; at: number }> = [];
  const isPending = new Set<number>();
  let runCounter = 0;

  const comp: any = {
    abortCalls,
    isPending: (id: number) => isPending.has(id),
    resolveRun: (id: number, result: any) => {
      isPending.delete(id);
      runOutputs.set(id, result);
      runResolvers.get(id)?.resolve();
    },
    rejectRun: (id: number, err: Error) => {
      isPending.delete(id);
      runResolvers.get(id)?.reject(err);
    },
    registerAgent: () => {},
    getAgent: () => ({ config: { type: "general" } }),
    run: async (_agentName: string, _query: string, context: any) => {
      const id = ++runCounter;
      isPending.add(id);

      // Per-run LLM promise (independent of concurrent runs).
      let localResolve!: () => void;
      let localReject!: (e: Error) => void;
      const localPromise = new Promise<void>((resolve, reject) => {
        localResolve = resolve;
        localReject = reject;
      });
      runResolvers.set(id, { resolve: localResolve, reject: localReject });

      // Listen to context.abort — when the deadline signal (or any other
      // composed abort) fires, reject the local promise to mimic real
      // AgentComponent behavior (LLM invoke rejects on abort).
      const signal: AbortSignal | undefined = context?.abort;
      if (signal) {
        if (signal.aborted) {
          localReject(new Error("aborted (signal already aborted)"));
        } else {
          signal.addEventListener(
            "abort",
            () => {
              const reason = signal.reason ?? new Error("aborted");
              localReject(reason instanceof Error ? reason : new Error(String(reason)));
            },
            { once: true },
          );
        }
      }

      try {
        await localPromise;
        isPending.delete(id);
        const stored = runOutputs.get(id) ?? { finalText: `ok-${id}`, iterations: 1, toolCalls: [] };
        return {
          iterations: stored.iterations,
          toolCalls: stored.toolCalls,
          output: stored.finalText,
        };
      } catch (err) {
        isPending.delete(id);
        throw err;
      }
    },
    abort: (agentName: string) => {
      abortCalls.push({ name: agentName, at: Date.now() });
      if (opts.simulateAbort) {
        // Name-wide abort API: would abort every active run with key
        // starting with `${agentName}:`. This is the bug Track A exposes.
        for (const id of isPending) {
          runResolvers.get(id)?.reject(
            new Error(`Agent ${agentName} aborted (timeout)`),
          );
        }
      }
    },
    abortAll: () => {},
  };
  return comp;
}

describe("RED probes — Task #2106 Track A (timeout isolation)", () => {
  // ----------------------------------------------------------------------
  // RED-A1: stale timer aborts a later run of the same agent type.
  //
  // Setup: run #1 with timeout=120ms completes normally within ~30ms.
  // The timer scheduled at run() entry is NEVER cleared by the adapter's
  // finally block. ~90ms later the timer fires and calls
  // agentComponent.abort("general"), which on the current implementation
  // also aborts the in-flight run #2 (started later with timeout=0, which
  // means no setTimeout). Run #2 should survive but does not.
  //
  // Fix expectation: after GREEN-A the finally block calls
  // clearTimeout(timeoutHandle); abort("general") is therefore never
  // invoked past run #1's deadline.
  // ----------------------------------------------------------------------
  it("A1 RED: a completed short run's timer must NOT abort a later run of the same type", async () => {
    const comp = makeMockAgentComponent({ simulateAbort: true });
    const adapter = new AgentComponentAdapter(comp as any);

    // Run #1: short deadline, completes long before timer would fire.
    const first = adapter.run(
      { type: "general", prompt: "first", options: { timeout: 120 } },
      { userQuery: undefined, agentSessionId: undefined },
    );
    await new Promise((r) => setTimeout(r, 30));
    comp.resolveRun(1, { finalText: "first", iterations: 1, toolCalls: [] });
    await first.catch(() => {});
    expect(comp.abortCalls).toEqual([]);

    // Run #2: started later, no timeout (would rely on inner 300s).
    const second = adapter.run(
      { type: "general", prompt: "second", options: { timeout: 250 } },
      { userQuery: undefined, agentSessionId: undefined },
    );
    await new Promise((r) => setTimeout(r, 120));
    expect(comp.abortCalls).toEqual([]);

    // The stale timer from run #1 must not abort run #2.
    comp.resolveRun(2, { finalText: "second", iterations: 1, toolCalls: [] });
    expect((await second).output).toBe("second");
  });

  // ----------------------------------------------------------------------
  // RED-A2: timing out one run aborts a concurrent same-type run.
  //
  // Two concurrent "general" runs. Run #1 has 60ms timeout, run #2 has
  // 300ms timeout. After 100ms the 60ms timer fires. On the current
  // implementation agentComponent.abort("general") aborts BOTH controllers
  // (the bug). Run #2 should remain pending.
  //
  // Fix expectation: after GREEN-A the adapter uses a per-run
  // AbortController for the deadline; only the deadline-fired controller
  // is aborted, not the agent-name-wide abort API.
  // ----------------------------------------------------------------------
  it("A2 RED: timing out one run must NOT abort a concurrent same-type run", async () => {
    const comp = makeMockAgentComponent({ simulateAbort: true });
    const adapter = new AgentComponentAdapter(comp as any);

    const short = adapter.run(
      { type: "general", prompt: "short", options: { timeout: 60 } },
      { userQuery: undefined, agentSessionId: undefined },
    );
    const long = adapter.run(
      { type: "general", prompt: "long", options: { timeout: 300 } },
      { userQuery: undefined, agentSessionId: undefined },
    );

    await new Promise((r) => setTimeout(r, 100));
    // The short run timed out, but the long run must still be pending.
    const shortResult = await short;
    expect(shortResult.metadata?.error).toContain("timed out");
    expect(comp.isPending(1)).toBe(false);
    expect(comp.isPending(2)).toBe(true);

    comp.resolveRun(2, { finalText: "long-ok", iterations: 1, toolCalls: [] });
    expect((await long).output).toBe("long-ok");
  });

  // ----------------------------------------------------------------------
  // RED-A3: per-run deadline must not invoke the agent-name-wide abort API.
  //
  // The current implementation (see agent-component-adapter.ts:273-282)
  // uses `this.agentComponent.abort(config.type || "general")` for the
  // deadline path. That public API iterates ALL active runs whose key
  // starts with `${agentName}:` and aborts them all — i.e., it is
  // agent-name-wide, not run-scoped.
  //
  // Observable consequence: any single-run deadline causes the adapter
  // to call `abort(typeName)` exactly once, even when multiple same-type
  // runs are in flight. After GREEN-A the adapter uses a per-run
  // AbortController for the deadline and never calls
  // `agentComponent.abort(typeName)` from the timeout path.
  //
  // Fix expectation: this probe asserts that on a single deadline, the
  // adapter does NOT call `agentComponent.abort("general")`.
  // ----------------------------------------------------------------------
  it("A3 RED: a single deadline must NOT invoke the agent-name-wide abort() API", async () => {
    const comp = makeMockAgentComponent({ simulateAbort: true });
    const adapter = new AgentComponentAdapter(comp as any);

    const runPromise = adapter.run(
      { type: "general", prompt: "x", options: { timeout: 60 } },
      { userQuery: undefined, agentSessionId: undefined },
    );

    await new Promise((r) => setTimeout(r, 100));
    await runPromise.catch(() => {});

    // The agent-name-wide abort API must NOT be invoked on a single
    // per-run timeout. With the deadline signal wired through context,
    // the run rejects via its own signal without the adapter calling
    // abort(typeName).
    expect(comp.abortCalls).toEqual([]);
  });
});