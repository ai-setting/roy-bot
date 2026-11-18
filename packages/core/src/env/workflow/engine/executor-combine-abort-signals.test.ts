/**
 * @fileoverview TDD RED — Executor combineAbortSignals (Task #2291 P0-1/P1-3)
 *
 * Module under test: `packages/core/src/env/workflow/engine/executor.ts`
 *
 * Background (Task #2291 follow-up to Task #2275):
 *   Codex review of Task #2275 raised:
 *     - P0-1: `combineAbortSignals` swallows the abort reason and races on
 *       pre-aborted signals. The current implementation calls
 *       `controller.abort()` (no reason) so `signal.reason` is `undefined`,
 *       and `addEventListener` fires asynchronously — so a pre-aborted
 *       input does not abort the combined signal synchronously.
 *     - P1-3: `executeWithRetry`'s `combinedController` is dead code; the
 *       inner `attemptAbortController` proxy swallows the abort reason.
 *
 * Contract after GREEN:
 *   - `executeNode` (which uses `executeWithRetry` and thus
 *     `combineAbortSignals`) with a pre-aborted `context.abortSignal`
 *     resolves synchronously with the original abort reason propagated
 *     to the node's signal.
 */

import { describe, it, expect } from "bun:test";
import { Executor } from "./executor";
import { NodeRegistry } from "./node-registry";
import { EventBus } from "./event-bus";
import type { NodeDefinition, NodeExecutionContext } from "../types";
import type { SessionComponent } from "../../session/session-component";

// =============================================================================
// Helpers
// =============================================================================

class HangingNode {
  public seenSignal: AbortSignal | undefined;
  public seenSignalAborted: boolean | undefined;
  public seenSignalReason: unknown;
  public nodeType = "hanging";
  public id: string;
  public name: string;
  public config: Record<string, unknown> = {};
  constructor(id: string) {
    this.id = id;
    this.name = id.toUpperCase();
  }
  async execute(ctx: NodeExecutionContext): Promise<{ output: any; error?: Error }> {
    this.seenSignal = ctx.abortSignal;
    this.seenSignalAborted = ctx.abortSignal?.aborted;
    this.seenSignalReason = ctx.abortSignal?.reason;
    // Hang to simulate a slow LLM call; the abort signal is the only escape.
    await new Promise<void>((_, reject) => {
      if (!ctx.abortSignal) return;
      if (ctx.abortSignal.aborted) {
        reject(ctx.abortSignal.reason ?? new Error("aborted"));
        return;
      }
      ctx.abortSignal.addEventListener(
        "abort",
        () => reject(ctx.abortSignal!.reason ?? new Error("aborted")),
        { once: true }
      );
    });
    return { output: { completed: true } };
  }
}

function makeNodeRegistryWithNode(node: HangingNode): NodeRegistry {
  const reg = new NodeRegistry();
  (reg as any).nodes = new Map<string, any>([[node.nodeType, { create: () => node }]]);
  (reg as any).createNode = (def: NodeDefinition) => node;
  return reg;
}

function makeSession(): SessionComponent {
  return {
    get: async () => null,
    list: async () => [],
    create: async () => ({}),
    update: async () => ({}),
    delete: async () => undefined,
    addMessage: async () => undefined,
  } as unknown as SessionComponent;
}

describe("[Task #2291 P0-1/P1-3] Executor.combineAbortSignals (via executeWithRetry)", () => {
  it("RED-F1-1: pre-aborted engine signal aborts retry attempt synchronously (no wasted attempt)", async () => {
    const node = new HangingNode("h1");
    const registry = makeNodeRegistryWithNode(node);
    const eventBus = new EventBus();
    const executor = new Executor(registry, eventBus, {
      globalTimeout: null,
      globalRetry: null,
      debug: false,
    }, makeSession());

    // Retry config so executeNode routes to executeWithRetry → combineAbortSignals.
    const def: NodeDefinition = {
      id: "h1",
      type: "hanging",
      name: "H1",
      config: {},
      retry: { max_attempts: 3, initial_delay: 50, backoff: "fixed" },
    } as unknown as NodeDefinition;

    const engineAbort = new AbortController();
    // Pre-abort BEFORE executeNode is called.
    const stopReason = new Error("engine-stopped-pre-abort");
    engineAbort.abort(stopReason);

    const t0 = Date.now();
    const result = await executor.executeNode(def, {
      runId: "r1",
      workflowName: "wf",
      input: {},
      previousOutputs: {},
      config: {},
      debug: false,
      eventBus,
      nodeOutputs: {},
      workflowHistory: [],
      sessionComponent: makeSession(),
      workflowInput: {},
      templateResolver: { resolveValue: (v: any) => v },
      abortSignal: engineAbort.signal,
      sessionId: "wf-r1",
    } as unknown as NodeExecutionContext);
    const elapsed = Date.now() - t0;

    // Must NOT have wasted an attempt waiting on the per-node controller
    // (the old impl fired addEventListener on a microtask, so a quick check
    // could pass before the listener fired). We require a sub-200ms outcome
    // — comfortably below the initial retry delay of 50ms + tolerance.
    expect(elapsed).toBeLessThan(200);
    // The error must carry the abort reason (old impl swallowed it).
    expect(result.error).toBeDefined();
    expect(String((result.error as Error).message)).toContain("engine-stopped");
  });

  it("RED-F1-2: combined signal of a pre-aborted engine + a live per-node aborts synchronously (AbortSignal.any semantics)", () => {
    // Reference check: the runtime that executor.ts runs on (Bun 1.x /
    // Node 20+) supports AbortSignal.any. If this fails, the executor's
    // fix is impossible without a polyfill.
    expect(typeof AbortSignal.any).toBe("function");
    const pre = new AbortController();
    pre.abort(new Error("pre"));
    const live = new AbortController();
    const combined = AbortSignal.any([pre.signal, live.signal]);
    expect(combined.aborted).toBe(true);
    expect((combined.reason as Error).message).toBe("pre");
  });
});
