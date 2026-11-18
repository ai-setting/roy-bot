/**
 * @fileoverview Concurrency regressions found by cross-validating Task #4392
 * P0-1 (the parallel scheduler). Promoted into permanent regression tests by
 * Task #4412 from the ad-hoc probes in `/tmp/review-tests/`.
 *
 * Both defects are *only* reachable once dispatch is concurrent; `main`
 * (serial dispatch) passes them, which is exactly why they survived the
 * original P0-1 test suite.
 *
 * ## B1 — terminal `metadata.status` gets overwritten back to `running`
 *
 * P0-1 added `updateSessionMetadata()` to serialize the metadata
 * read-modify-write cycle, but only *node event handlers* were routed through
 * it. The terminal writes in `completeWorkflow()` / `failWorkflow()` still did
 * a bare get → spread → update. With N nodes completing concurrently, the
 * queue still holds writes that were computed from a **pre-terminal snapshot**;
 * those land *after* `status: 'completed'` and revert it to `'running'`.
 *
 * User-visible: `sessions list --graph` (reads `metadata.status`) shows a
 * finished workflow as forever running; `agentSessions[]` terminal markers are
 * lost to the same stale snapshot.
 *
 * ## B2 — back-edge loop body executes 3× per iteration, `loop_guard` bypassed
 *
 * `scheduler.resetNodeForReEntry()` pushes the node back into `pending` and
 * clears `running`. The engine then `await`s `checkLoopGuardWithSnapshot()`,
 * which spawns a real subprocess (tens to hundreds of ms). During that window
 * the node is DAG-ready again, so the main scheduling loop's poll can
 * `dispatchNode()` it. The edge path then runs it *again* via
 * `await startNode()` — a call that bypasses `dispatchNode`'s claim guard.
 *
 * User-visible: `loop_guard` refuses to trip when it should (`a=3` instead of
 * `a=1`), and every surplus execution is a real LLM / tool call.
 */

import { describe, it, expect } from "bun:test";
import { WorkflowEngine } from "./engine";
import { NodeRegistry } from "./node-registry";
import type { WorkflowDefinition, NodeDefinition } from "../types";
import type { SessionComponent } from "../../session/session-component";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface StubSession {
  comp: SessionComponent;
  /** Every `update()` call, in order, with a deep copy of `metadata`. */
  writes: Array<{ id: string; at: number; metadata: Record<string, any> }>;
}

/**
 * In-memory session stub that records each metadata write.
 *
 * `updateDelayMs` matters: with an instant stub the RMW race window closes and
 * B1 is not reproducible. A realistic small DB latency is what lets the queued
 * stale snapshots land *after* the terminal write.
 */
function makeStubSession(updateDelayMs = 0): StubSession {
  const state = new Map<string, any>();
  const writes: StubSession["writes"] = [];

  const comp = {
    create: async (opts: any) => {
      state.set(opts.id, { ...opts, metadata: { ...(opts.metadata ?? {}) } });
      return { id: opts.id, ...opts };
    },
    get: async (id: string) => {
      const cur = state.get(id);
      return cur ? { ...cur, metadata: { ...(cur.metadata ?? {}) } } : null;
    },
    update: async (id: string, patch: any) => {
      if (patch?.metadata) {
        writes.push({
          id,
          at: Date.now(),
          metadata: JSON.parse(JSON.stringify(patch.metadata)),
        });
      }
      // Simulate a real (asynchronous) DB write.
      if (updateDelayMs > 0) {
        await new Promise((r) => setTimeout(r, updateDelayMs));
      }
      const cur = state.get(id) ?? { id };
      state.set(id, {
        ...cur,
        ...patch,
        metadata: { ...(cur.metadata ?? {}), ...(patch.metadata ?? {}) },
      });
      return true;
    },
    addMessage: async () => "msg-id",
    getMessages: async () => [],
    list: async () => [],
  } as unknown as SessionComponent;

  return { comp, writes };
}

function toolNode(id: string, dependsOn?: string[]): NodeDefinition {
  return {
    id,
    type: "tool",
    name: id,
    ...(dependsOn ? { depends_on: dependsOn } : {}),
    config: { tool: "probe", input: { nodeId: id } },
  } as unknown as NodeDefinition;
}

function makeDef(
  name: string,
  nodes: NodeDefinition[],
  edges: Array<{ from: string; to: string }>,
  config: Partial<WorkflowDefinition["config"]> = {}
): WorkflowDefinition {
  return {
    name,
    version: "1.0.0",
    description: "regression fixture",
    nodes,
    edges: edges as any,
    entry: "__default_entry__",
    outputs: [],
    inputs: {},
    metadata: { tags: [] },
    config: {
      timeout: null,
      debug: false,
      strict: false,
      maxIterations: 100,
      loopEnabled: false,
      ...config,
    },
  } as unknown as WorkflowDefinition;
}

interface ProbeOptions {
  /** Optional per-node body duration (ms). */
  durationFor?: (nodeId: string) => number;
  /** Optional per-node return payload (defaults to `{ out: 'out-<id>' }`). */
  outputFor?: (nodeId: string) => unknown;
  /** Records per-node execution counts. */
  executions: Map<string, number>;
}

/** Wire an engine whose `probe` tool records execution counts. */
function makeEngine(stub: StubSession, options: ProbeOptions): WorkflowEngine {
  const registry = new NodeRegistry();
  const probe = {
    name: "probe",
    execute: async (input: any) => {
      const id = String(input?.nodeId);
      options.executions.set(id, (options.executions.get(id) ?? 0) + 1);
      const ms = options.durationFor?.(id) ?? 30;
      if (ms > 0) await new Promise((r) => setTimeout(r, ms));
      return options.outputFor ? options.outputFor(id) : { out: `out-${id}` };
    },
  };
  registry.register("tool", (definition) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ToolNode } = require("../nodes/tool-node");
    const toolRegistry = {
      getToolByName: (n: string) => (n === "probe" ? probe : undefined),
      hasTool: (n: string) => n === "probe",
    };
    return new ToolNode(definition, toolRegistry as any);
  });
  return new WorkflowEngine(registry, stub.comp);
}

/**
 * Fan-out topology used by B1.
 *
 * Edges (not `depends_on`) are deliberate: they are what the cross-validation
 * report identified as the condition under which the stale snapshot lands last.
 */
function buildEdgeFanOut(leafCount: number): WorkflowDefinition {
  const nodes: NodeDefinition[] = [toolNode("root")];
  const edges: Array<{ from: string; to: string }> = [];
  for (let i = 0; i < leafCount; i++) {
    nodes.push(toolNode(`leaf-${i}`));
    edges.push({ from: "root", to: `leaf-${i}` });
  }
  return makeDef(`b1-fanout-${leafCount}`, nodes, edges);
}

// ---------------------------------------------------------------------------
// B1 — terminal metadata status
// ---------------------------------------------------------------------------

describe("B1: terminal metadata.status must not be reverted to 'running'", () => {
  it("a completed parallel run leaves metadata.status === 'completed'", async () => {
    const stub = makeStubSession(40);
    const executions = new Map<string, number>();
    const engine = makeEngine(stub, { executions, durationFor: () => 30 });

    const result = await engine.runWorkflow(buildEdgeFanOut(4), {
      parallelLimit: 4,
    } as any);

    // Let any trailing queued writes land before inspecting.
    await new Promise((r) => setTimeout(r, 400));

    expect((result as any).status).toBe("completed");

    const statuses = stub.writes
      .map((w) => w.metadata?.status)
      .filter(Boolean) as string[];
    const lastStatus = statuses[statuses.length - 1];

    // The regression: the final write reverts 'completed' → 'running'.
    expect(lastStatus).toBe("completed");

    // The persisted record (what `sessions --graph` actually reads) must agree.
    const sessions = await (stub.comp as any).list();
    const persisted = sessions.find?.((s: any) => s?.metadata?.status);
    if (persisted) {
      expect(persisted.metadata.status).toBe("completed");
    }
  }, 30000);

  it("a failed parallel run leaves metadata.status === 'failed'", async () => {
    const stub = makeStubSession(40);
    const executions = new Map<string, number>();
    const engine = makeEngine(stub, { executions, durationFor: () => 30 });

    const def = buildEdgeFanOut(4);
    // Fail the LAST leaf so at least one queued sibling write is still pending
    // when the terminal write lands.
    const failing = new Set(["leaf-3"]);
    const registry = new NodeRegistry();
    const probe = {
      name: "probe",
      execute: async (input: any) => {
        const id = String(input?.nodeId);
        executions.set(id, (executions.get(id) ?? 0) + 1);
        await new Promise((r) => setTimeout(r, 30));
        if (failing.has(id)) throw new Error(`boom-${id}`);
        return { out: `out-${id}` };
      },
    };
    registry.register("tool", (definition) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ToolNode } = require("../nodes/tool-node");
      const toolRegistry = {
        getToolByName: (n: string) => (n === "probe" ? probe : undefined),
        hasTool: (n: string) => n === "probe",
      };
      return new ToolNode(definition, toolRegistry as any);
    });
    const failingEngine = new WorkflowEngine(registry, stub.comp);

    const result = await failingEngine.runWorkflow(def, {
      parallelLimit: 4,
    } as any);

    await new Promise((r) => setTimeout(r, 400));

    expect((result as any).status).toBe("failed");

    const statuses = stub.writes
      .map((w) => w.metadata?.status)
      .filter(Boolean) as string[];
    const lastStatus = statuses[statuses.length - 1];

    // Terminal status must survive the trailing queued writes. Either the
    // failure status sticks, or a stop/completed path won — but 'running'
    // means the terminal marker was clobbered.
    expect(lastStatus).not.toBe("running");
    expect(statuses).toContain("failed");
  }, 30000);
});

// ---------------------------------------------------------------------------
// B2 — back-edge loop body execution count
// ---------------------------------------------------------------------------

/**
 * Loop topology used by B2: `a` has a self back-edge plus a `loop_guard`
 * whose check inevitably reports no progress, and `b` depends on `a`.
 *
 * `b` is essential: it keeps the main scheduling loop in **polling** mode
 * (a permanently pending node), which is what lets a poll slip into the
 * `resetNodeForReEntry → markStarted` window and dispatch `a` a second time.
 */
function buildGuardedLoop(maxIterations: number): WorkflowDefinition {
  const a = {
    id: "a",
    type: "tool",
    name: "a",
    config: {
      tool: "probe",
      input: { nodeId: "a" },
      loop_guard: {
        type: "value_unchanged",
        previous_signal: "{{nodes.a.out}}",
        // Always a different value ⇒ no progress on every re-entry.
        // Cross-validation note (Task #4412 §七): `sleep 0.3` only just
        // clears the main loop's 100ms poll timer, so on a loaded CI box the
        // poll may never land inside the window and the test would pass on a
        // buggy build (false green). 0.6s makes the window unambiguously open.
        current_signal_command: "sleep 0.6; echo probe",
        cwd: "/tmp",
        max_consecutive_no_progress: 1,
        fail_message: "guard tripped",
      },
    },
  } as unknown as NodeDefinition;

  const b = toolNode("b", ["a"]);

  return makeDef("b2-guarded-loop", [a, b], [{ from: "a", to: "a" }], {
    loopEnabled: true,
    maxIterations,
  });
}

describe("B2: back-edge loop body must execute exactly once per iteration", () => {
  it("loop_guard trips before the first re-entry runs the body again", async () => {
    const stub = makeStubSession();
    const executions = new Map<string, number>();
    const engine = makeEngine(stub, {
      executions,
      durationFor: () => 40,
      // `a` must report the SAME signal the guard command prints, otherwise
      // the guard legitimately sees progress and never trips.
      outputFor: () => ({ out: "probe" }),
    });

    const MAX_ITERATIONS = 10;
    const result = (await Promise.race([
      engine.runWorkflow(buildGuardedLoop(MAX_ITERATIONS), {
        parallelLimit: 1,
      } as any),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("TIMEOUT(b2-guard)")), 30000)
      ),
    ])) as any;

    const aRuns = executions.get("a") ?? 0;

    // `max_consecutive_no_progress: 1` ⇒ the guard must trip on the very first
    // no-progress re-entry, i.e. the body runs once and is never re-executed.
    // Regression on 30967e4a: aRuns === 3.
    expect(aRuns).toBe(1);
    expect(result.status).toBe("failed");
    expect(String(result.error ?? "")).toContain("guard tripped");
  }, 40000);

  it("does not deadlock with parallelLimit=1 (self back-edge + pending sibling)", async () => {
    const stub = makeStubSession();
    const executions = new Map<string, number>();
    const engine = makeEngine(stub, { executions, durationFor: () => 20 });

    // Guard never trips (progress detected each round) so the loop must
    // iterate until maxIterations, exercising repeated re-entry.
    const a = {
      id: "a",
      type: "tool",
      name: "a",
      config: {
        tool: "probe",
        input: { nodeId: "a" },
        loop_guard: {
          type: "value_unchanged",
          previous_signal: "{{nodes.a.out}}",
          current_signal_command: "sleep 0.4; echo probe2",
          cwd: "/tmp",
          max_consecutive_no_progress: 99,
          fail_message: "never",
        },
      },
    } as unknown as NodeDefinition;

    const def = makeDef(
      "b2-iterating-loop",
      [a, toolNode("b", ["a"])],
      [{ from: "a", to: "a" }],
      { loopEnabled: true, maxIterations: 3 }
    );

    const result = (await Promise.race([
      engine.runWorkflow(def, { parallelLimit: 1 } as any),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("TIMEOUT(b2-iterate)")), 40000)
      ),
    ])) as any;

    // No deadlock: the run must settle (converge on max-iterations failure).
    expect(result.status).toBe("failed");
    expect(String(result.error ?? "")).toContain("maximum loop iterations");

    // Every iteration executes the body exactly once — no surplus double
    // dispatch. Initial run + maxIterations re-entries.
    const aRuns = executions.get("a") ?? 0;
    // initial run + maxIterations(3) re-entries = 4, exactly one body run each.
    expect(aRuns).toBe(4);
  }, 60000);
});
