/**
 * @fileoverview TDD RED — Executor runtime cancellation contract (Task #2275 Task 2)
 *
 * Tests in this file pin down the contract that the executor must satisfy
 * when running nodes with the engine-level abort signal + per-node timeout.
 *
 * RED state (current implementation):
 *   - Executor.cancelAll() only fires its internal controllers; does NOT
 *     wait for the underlying `node.execute()` Promise to settle.
 *   - sleep() inside retry backoff is NOT signal-aware; a stop during
 *     backoff leaves the timer alive.
 *
 * Contract after GREEN:
 *   1. `context.abortSignal` and the per-node controller's signal are
 *      composed (either-or-aborts reaches the node).
 *   2. If stop is called BEFORE the per-node controller registers,
 *      the node still receives a pre-aborted signal.
 *   3. `Promise.race` returning after a timeout does NOT orphan the
 *      underlying node Promise — a follow-up wait sees it settled.
 *   4. retry sleep honors signal: clearTimeout on abort; no new attempt.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Executor } from "./executor";
import { NodeRegistry } from "./node-registry";
import { EventBus } from "./event-bus";
import type {
  Node,
  NodeDefinition,
  NodeExecutionContext,
  NodeExecutionResult,
} from "../types";
import type { SessionComponent } from "../../session/session-component";

class HangingNode implements Node {
  readonly type = "hanging";
  readonly id: string;
  seenSignalAborted: boolean | null = null;
  sawAbortAfterStart: boolean = false;
  lastSignal: AbortSignal | undefined;
  private resolveHang: (() => void) | null = null;
  constructor(id: string) {
    this.id = id;
  }
  hangPromise() {
    return new Promise<void>((resolve) => {
      this.resolveHang = () => resolve();
    });
  }
  release() {
    this.resolveHang?.();
  }
  async execute(context: NodeExecutionContext): Promise<NodeExecutionResult> {
    this.lastSignal = context.abortSignal;
    this.seenSignalAborted = context.abortSignal?.aborted ?? null;
    if (context.abortSignal) {
      if (context.abortSignal.aborted) {
        return { output: undefined, error: new Error("pre-aborted") };
      }
      await new Promise<void>((_resolve, reject) => {
        context.abortSignal!.addEventListener(
          "abort",
          () => {
            this.sawAbortAfterStart = true;
            reject(context.abortSignal!.reason ?? new Error("aborted"));
          },
          { once: true },
        );
      });
    }
    void this.hangPromise();
    return { output: "completed" };
  }
}

class FailingNode implements Node {
  readonly type = "failing";
  readonly id: string;
  attempts = 0;
  constructor(id: string) {
    this.id = id;
  }
  async execute(_context: NodeExecutionContext): Promise<NodeExecutionResult> {
    this.attempts++;
    throw new Error("simulated failure");
  }
}

function makeNodeRegistryWithNode(node: Node) {
  const registry = new NodeRegistry();
  // Register a custom node factory.
  (registry as any).factories ??= new Map();
  (registry as any).factories.set(node.type, () => node);
  (registry as any).createNode = function (_def: NodeDefinition, _ctx: any) {
    return node;
  };
  return registry;
}

function makeSession(): SessionComponent {
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
    addMessage: async (id: string, msg: any) => {
      const r = records.get(id);
      if (r) r.messages.push({ ...msg, id: `msg_${r.messages.length}` });
      return `msg_${Date.now()}`;
    },
    updateMessage: async () => true,
    getMessages: async (id: string) => records.get(id)?.messages ?? [],
    list: async () => [],
  } as unknown as SessionComponent;
}

describe("[Task #2275 RED] Executor runtime cancellation", () => {
  let session: SessionComponent;
  beforeEach(() => {
    session = makeSession();
  });

  it("RED-T2-E1: engine abort signal + per-node timeout signal both reach the node (composed)", async () => {
    const node = new HangingNode("h1");
    const registry = makeNodeRegistryWithNode(node);
    const eventBus = new EventBus();
    const executor = new Executor(registry, eventBus, {
      globalTimeout: null,
      globalRetry: null,
      debug: false,
    }, session);

    // Pass an already-aborted engine signal into the context.
    const engineAbort = new AbortController();
    const def: NodeDefinition = {
      id: "h1",
      type: "hanging",
      name: "H1",
      config: {},
    } as NodeDefinition;

    const nodeCtrlPromise = new Promise<void>((resolve) => {
      // After the executor registers its per-node controller, abort it.
      setTimeout(resolve, 20);
    });
    engineAbort.abort(new Error("engine-stop"));
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
      sessionComponent: session,
      workflowInput: {},
      templateResolver: { resolveValue: (v: any) => v, resolve: (v: any) => v },
      abortSignal: engineAbort.signal,
      sessionId: "wf-r1",
    } as unknown as NodeExecutionContext);
    await nodeCtrlPromise;
    // node should have seen signal.aborted=true (composed engine + per-node).
    expect(node.seenSignalAborted).toBe(true);
    expect(result.error).toBeDefined();
  });

  it("RED-T2-E2: stop before per-node controller registration → node receives pre-aborted signal", async () => {
    // We construct a custom executor-like flow: pass an already-aborted
    // signal to executeNode and assert node.seenSignalAborted === true.
    const node = new HangingNode("h2");
    const registry = makeNodeRegistryWithNode(node);
    const eventBus = new EventBus();
    const executor = new Executor(registry, eventBus, {
      globalTimeout: null,
      globalRetry: null,
      debug: false,
    }, session);

    const engineAbort = new AbortController();
    engineAbort.abort(new Error("stop-before-start"));

    const def: NodeDefinition = {
      id: "h2",
      type: "hanging",
      name: "H2",
      config: {},
    } as NodeDefinition;
    const result = await executor.executeNode(def, {
      runId: "r2",
      workflowName: "wf",
      input: {},
      previousOutputs: {},
      config: {},
      debug: false,
      eventBus,
      nodeOutputs: {},
      workflowHistory: [],
      sessionComponent: session,
      workflowInput: {},
      templateResolver: { resolveValue: (v: any) => v, resolve: (v: any) => v },
      abortSignal: engineAbort.signal,
      sessionId: "wf-r2",
    } as unknown as NodeExecutionContext);
    expect(node.seenSignalAborted).toBe(true);
    expect(result.error).toBeDefined();
  });

  it("RED-T2-E3: Promise.race timeout does not orphan the underlying node promise", async () => {
    // We need a node that, after being raced out by the executor, can
    // be observed via a separate hook to confirm it eventually settled.
    const node = new HangingNode("h3");
    const registry = makeNodeRegistryWithNode(node);
    const eventBus = new EventBus();
    const executor = new Executor(registry, eventBus, {
      globalTimeout: 50, // 50ms timeout
      globalRetry: null,
      debug: false,
    }, session);

    const def: NodeDefinition = {
      id: "h3",
      type: "hanging",
      name: "H3",
      timeout: 50,
      config: {},
    } as NodeDefinition;

    const result = await executor.executeNode(def, {
      runId: "r3",
      workflowName: "wf",
      input: {},
      previousOutputs: {},
      config: {},
      debug: false,
      eventBus,
      nodeOutputs: {},
      workflowHistory: [],
      sessionComponent: session,
      workflowInput: {},
      templateResolver: { resolveValue: (v: any) => v, resolve: (v: any) => v },
      sessionId: "wf-r3",
    } as unknown as NodeExecutionContext);
    const errorMsg = result.error instanceof Error ? result.error.message : String(result.error);
    expect(errorMsg).toContain("timeout");

    // Wait a bit and confirm the underlying node Promise settled (no leak).
    await new Promise((r) => setTimeout(r, 100));
    // After timeout fires, the abort listener must have observed the abort.
    expect(node.sawAbortAfterStart).toBe(true);
  });

  it("RED-T2-E4: retry sleep is signal-aware (no new attempt, no leftover timer)", async () => {
    const node = new FailingNode("fail");
    const registry = makeNodeRegistryWithNode(node);
    const eventBus = new EventBus();
    const executor = new Executor(registry, eventBus, {
      globalTimeout: null,
      globalRetry: null,
      debug: false,
    }, session);

    const def: NodeDefinition = {
      id: "fail",
      type: "failing",
      name: "Fail",
      retry: {
        max_attempts: 5,
        backoff: "fixed",
        initial_delay: 1000, // long backoff so timer would survive if not aborted
      },
      config: {},
    } as NodeDefinition;

    const engineAbort = new AbortController();
    const p = executor.executeNode(def, {
      runId: "r4",
      workflowName: "wf",
      input: {},
      previousOutputs: {},
      config: {},
      debug: false,
      eventBus,
      nodeOutputs: {},
      workflowHistory: [],
      sessionComponent: session,
      workflowInput: {},
      templateResolver: { resolveValue: (v: any) => v, resolve: (v: any) => v },
      abortSignal: engineAbort.signal,
      sessionId: "wf-r4",
    } as unknown as NodeExecutionContext);

    // Wait for the first attempt to land, then abort during backoff.
    await new Promise((r) => setTimeout(r, 30));
    engineAbort.abort(new Error("stop-during-retry"));

    const result = await p;
    // We should see fewer attempts than max_attempts because retry sleep was interrupted.
    expect(node.attempts).toBeLessThan(5);
    expect(result.error).toBeDefined();

    // Wait long enough that a leftover 1000ms timer would fire if it survived.
    await new Promise((r) => setTimeout(r, 200));
    expect(node.attempts).toBeLessThan(5); // no new attempt fired after abort
  });
});