/**
 * @fileoverview Type-level tests for NodeExecutionContext.abortSignal
 *
 * Task #1976 — Step 2a: Plumb AbortSignal through NodeExecutionContext.
 * This test verifies the TYPE CONTRACT — that NodeExecutionContext has an
 * `abortSignal?: AbortSignal` field. The runtime plumbing is tested in
 * executor-abort-passthrough.test.ts.
 */

import { describe, it, expect } from "bun:test";
import type { NodeExecutionContext } from "./run";
import type { NodeDefinition } from "./workflow";

describe("NodeExecutionContext type — abortSignal (Task #1976 step 2a)", () => {
  it("T1: NodeExecutionContext must declare abortSignal?: AbortSignal field", () => {
    // Build a sample context with abortSignal. If the field is missing,
    // this object literal will fail typecheck.
    const ctx: NodeExecutionContext = {
      runId: "test-run",
      sessionId: "test-session",
      workflowName: "test",
      nodeId: "node-1",
      input: {},
      previousOutputs: new Map(),
      nodeOutputs: new Map(),
      config: {},
      debug: false,
      eventBus: undefined as any,
      askUser: ((_q: string) => {
        throw new Error("not implemented");
      }) as any,
      // The new field — if missing, this line fails typecheck
      abortSignal: undefined,
    };

    // The runtime assertion is secondary; the typecheck is the real test.
    expect(ctx.abortSignal).toBeUndefined();
  });

  it("T2: abortSignal accepts a real AbortSignal (smoke)", () => {
    const ac = new AbortController();
    const ctx: NodeExecutionContext = {
      runId: "r",
      sessionId: "s",
      workflowName: "w",
      nodeId: "n",
      input: {},
      previousOutputs: new Map(),
      nodeOutputs: new Map(),
      config: {},
      debug: false,
      eventBus: undefined as any,
      askUser: ((_q: string) => {
        throw new Error("not implemented");
      }) as any,
      abortSignal: ac.signal,
    };
    expect(ctx.abortSignal?.aborted).toBe(false);
    ac.abort();
    expect(ctx.abortSignal?.aborted).toBe(true);
  });

  it("T3: backward compat — context WITHOUT abortSignal is still valid (optional)", () => {
    // This verifies the field is OPTIONAL — backward compatibility is preserved.
    const ctx: NodeExecutionContext = {
      runId: "r",
      sessionId: "s",
      workflowName: "w",
      nodeId: "n",
      input: {},
      previousOutputs: new Map(),
      nodeOutputs: new Map(),
      config: {},
      debug: false,
      eventBus: undefined as any,
      askUser: ((_q: string) => {
        throw new Error("not implemented");
      }) as any,
      // No abortSignal — must compile
    };
    expect(ctx.abortSignal).toBeUndefined();
  });

  it("T4: NodeDefinition is unchanged (only context grew)", () => {
    // Sanity: NodeDefinition still has the same shape, no abortSignal there.
    const def: NodeDefinition = {
      id: "n",
      type: "tool",
      name: "Test",
    };
    expect(def.id).toBe("n");
    expect(def.type).toBe("tool");
  });
});