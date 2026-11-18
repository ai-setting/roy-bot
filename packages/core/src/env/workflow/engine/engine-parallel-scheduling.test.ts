/**
 * @fileoverview Engine parallel scheduling (Task #4392 P0-1).
 *
 * ## The bug (proven in Task #4385 §3.6)
 *
 * `scheduleAndExecute` had:
 *
 * ```ts
 * for (const nodeId of readyNodes) {
 *   if (!scheduler.canStartMore()) break;
 *   await this.startNode(sessionState, nodeId, input);   // ← serializes the DAG
 *   scheduled++;
 * }
 * ```
 *
 * `startNode` → `validateAndExecute` → `await executor.executeNode(...)` does
 * not return until the node has **finished**, so every "ready" node in a round
 * ran strictly one-after-another even though the DAG allowed fan-out and
 * `parallel_limit` allowed it too.
 *
 * Measured in production trace `wheel-build-upload-validate` v1.2.0: 6 build
 * nodes that only depend on `init-folder` started at t+0.1 / 827.3 / 1639.5 /
 * 2464.5 / 3277.8s — perfectly back-to-back, zero overlap, ~61.5 minutes of
 * pure waiting on a `parallel_limit=6` DAG.
 *
 * ## What this suite pins
 *
 * 1. **Overlap actually happens** — N independent nodes with a T-ms body must
 *    finish in materially less than N*T wall time.
 * 2. **Nothing is lost** — every node's output is present in the final result,
 *    and the node ran exactly once (no double-scheduling).
 * 3. **`parallel_limit` is still honored** — the fix must not turn the DAG
 *    into unbounded fan-out; peak concurrency must respect the limit.
 * 4. **fail-fast still converges** — when one node fails, no dangling promise
 *    is left behind and the run still resolves (this is the risk that made
 *    P0-1 "highest risk" in the plan).
 * 5. **Serial DAGs stay serial** — the fix must not break dependency ordering.
 */

import { describe, it, expect } from "bun:test";
import { WorkflowEngine } from "./engine";
import { NodeRegistry } from "./node-registry";
import type { WorkflowDefinition, NodeDefinition } from "../types";
import type { SessionComponent } from "../../session/session-component";

/**
 * Minimal in-memory session stub. A fresh instance per test keeps runs
 * isolated (the engine keys sessions by id).
 */
function makeStubSession(): SessionComponent {
  const state = new Map<string, any>();
  return {
    create: async (opts: any) => {
      state.set(opts.id, { ...opts });
      return { id: opts.id, ...opts };
    },
    get: async (id: string) => state.get(id) ?? null,
    update: async (id: string, patch: any) => {
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
}

interface ProbeStats {
  /** Peak simultaneous in-flight bodies. */
  peakConcurrency: number;
  /** Per-node start/end timestamps (ms, relative to the first start). */
  spans: Map<string, { start: number; end: number }>;
  /** How many times each node body ran (must be exactly 1). */
  executions: Map<string, number>;
}

interface ProbeOptions {
  /** Body duration in ms. */
  durationMs: number;
  /** Optional node ids that should reject (fail-fast test). */
  failing?: Set<string>;
  /** Optional per-node delay override. */
  delayFor?: (nodeId: string) => number;
}

/**
 * Build a fan-out workflow: `root` (instant) → N independent `leaf-*` nodes.
 *
 * Using a root keeps the fixture honest: it proves the parallel round is a
 * *dependency-satisfied* round, not just "multiple entry nodes".
 */
function buildFanOut(count: number): WorkflowDefinition {
  const nodes: NodeDefinition[] = [
    {
      id: "root",
      type: "tool",
      name: "root",
      config: { tool: "probe", input: { nodeId: "root" } },
    },
  ];
  for (let i = 0; i < count; i++) {
    nodes.push({
      id: `leaf-${i}`,
      type: "tool",
      name: `leaf-${i}`,
      depends_on: ["root"],
      config: { tool: "probe", input: { nodeId: `leaf-${i}` } },
    });
  }
  return {
    name: `fanout-${count}`,
    version: "1.0.0",
    description: `fan-out fixture with ${count} leaves`,
    nodes,
    edges: [],
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
    },
  };
}

/** Build a linear chain A → B → C (nothing may overlap). */
function buildChain(count: number): WorkflowDefinition {
  const nodes: NodeDefinition[] = [];
  for (let i = 0; i < count; i++) {
    nodes.push({
      id: `step-${i}`,
      type: "tool",
      name: `step-${i}`,
      ...(i > 0 ? { depends_on: [`step-${i - 1}`] } : {}),
      config: { tool: "probe", input: { nodeId: `step-${i}` } },
    } as NodeDefinition);
  }
  return {
    name: `chain-${count}`,
    version: "1.0.0",
    description: `linear fixture with ${count} steps`,
    nodes,
    edges: [],
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
    },
  };
}

/**
 * Wire an engine whose `probe` tool records real concurrency.
 *
 * The tool body is a plain `setTimeout` sleep, so the recorded overlap is
 * genuine event-loop concurrency (exactly what the production bash/tool nodes
 * do while waiting on a subprocess).
 */
function makeEngine(options: ProbeOptions): {
  engine: WorkflowEngine;
  stats: ProbeStats;
} {
  const stats: ProbeStats = {
    peakConcurrency: 0,
    spans: new Map(),
    executions: new Map(),
  };

  let inFlight = 0;
  let epoch: number | undefined;

  const registry = new NodeRegistry();
  const probeTool = {
    name: "probe",
    execute: async (input: any) => {
      const nodeId = String(input?.nodeId ?? "unknown");

      stats.executions.set(nodeId, (stats.executions.get(nodeId) ?? 0) + 1);

      const now = Date.now();
      if (epoch === undefined) epoch = now;
      const start = now - epoch;

      inFlight++;
      if (inFlight > stats.peakConcurrency) stats.peakConcurrency = inFlight;

      const delay = options.delayFor ? options.delayFor(nodeId) : options.durationMs;
      await new Promise((resolve) => setTimeout(resolve, delay));

      inFlight--;
      // Record the span before any failure, so failing nodes are measured too
      // (they are still dispatched concurrently — that's the property under
      // test for fail-fast).
      stats.spans.set(nodeId, { start, end: Date.now() - epoch });

      if (options.failing?.has(nodeId)) {
        // ToolNode treats a thrown error as node failure.
        throw new Error(`intentional failure in ${nodeId}`);
      }
      return `out-${nodeId}`;
    },
  };

  registry.register("tool", (definition) => {
    // Reuse the real ToolNode so scheduling/validation paths stay authentic.
    const { ToolNode } = require("../nodes/tool-node");
    const toolRegistry = {
      getToolByName: (name: string) => (name === "probe" ? probeTool : undefined),
      hasTool: (name: string) => name === "probe",
    };
    return new ToolNode(definition, toolRegistry as any);
  });

  return { engine: new WorkflowEngine(registry, makeStubSession()), stats };
}

/** True when [aStart,aEnd] and [bStart,bEnd] overlap by at least 1ms. */
function overlaps(
  a: { start: number; end: number },
  b: { start: number; end: number }
): boolean {
  return a.start < b.end && b.start < a.end;
}

describe("P0-1 engine parallel scheduling — fan-out actually overlaps", () => {
  const NODE_MS = 120;
  const NODES = 4;

  it("RED: 4 independent nodes with a 120ms body finish well under 4x120ms", async () => {
    // Measure against a *serial* baseline built from the same fixture rather
    // than an absolute millisecond budget. Wall-clock thresholds are flaky
    // under `--parallel 4` (measured: the same assertion took 1.2s instead of
    // 0.35s purely from sibling-file contention). Comparing two runs of the
    // same machine/loader gives a stable, environment-independent signal.
    const serial = makeEngine({ durationMs: NODE_MS });
    const serialStart = Date.now();
    await serial.engine.runWorkflow(buildFanOut(NODES) as any, {
      // parallelLimit=1 is the pre-fix behaviour writ explicit: strictly serial.
      parallelLimit: 1,
      strict: false,
    } as any);
    const serialWallMs = Date.now() - serialStart;

    const parallel = makeEngine({ durationMs: NODE_MS });
    const parallelStart = Date.now();
    const result = await parallel.engine.runWorkflow(buildFanOut(NODES) as any, {
      parallelLimit: NODES,
      strict: false,
    } as any);
    const parallelWallMs = Date.now() - parallelStart;

    // Sanity: the run must succeed, otherwise the timing assertion is moot.
    expect((result as any).status).toBe("completed");

    // The leaves dominate the run, so a real fan-out must be materially faster
    // than the serial baseline. 0.75 leaves generous headroom for engine
    // bookkeeping while still failing loudly if dispatch goes back to serial
    // (that would make the ratio ~1.0).
    expect(parallelWallMs).toBeLessThan(serialWallMs * 0.75);

    // Strongest signal: at least two leaves were in flight at the same moment.
    expect(parallel.stats.peakConcurrency).toBeGreaterThanOrEqual(2);
  });

  it("RED: leaf spans genuinely interleave (not just 'fast enough')", async () => {
    const { engine, stats } = makeEngine({ durationMs: NODE_MS });
    const def = buildFanOut(NODES);

    await engine.runWorkflow(def as any, {
      parallelLimit: NODES,
      strict: false,
    } as any);

    const leaves = Array.from({ length: NODES }, (_, i) => stats.spans.get(`leaf-${i}`));
    // Every leaf must have run.
    expect(leaves.every((s) => s !== undefined)).toBe(true);

    const defined = leaves as Array<{ start: number; end: number }>;

    // At least one pair overlaps in real time. Under the serial bug this is
    // provably false: each leaf's start == previous leaf's end.
    let anyOverlap = false;
    for (let i = 0; i < defined.length && !anyOverlap; i++) {
      for (let j = i + 1; j < defined.length; j++) {
        if (overlaps(defined[i], defined[j])) {
          anyOverlap = true;
          break;
        }
      }
    }
    expect(anyOverlap).toBe(true);
  });

  it("RED: every node output is preserved and each node executes exactly once", async () => {
    const { engine, stats } = makeEngine({ durationMs: 20 });
    const def = buildFanOut(NODES);

    const result = await engine.runWorkflow(def as any, {
      parallelLimit: NODES,
      strict: false,
    } as any);

    expect((result as any).status).toBe("completed");

    const output = (result as any).output ?? {};
    expect(output.root).toBe("out-root");
    for (let i = 0; i < NODES; i++) {
      expect(output[`leaf-${i}`]).toBe(`out-leaf-${i}`);
      expect(stats.executions.get(`leaf-${i}`)).toBe(1);
    }
    expect(stats.executions.get("root")).toBe(1);
  });
});

describe("P0-1 parallel_limit is still enforced after parallelization", () => {
  it("RED: with parallelLimit=2 the peak concurrency never exceeds 2", async () => {
    const NODES = 6;
    const { engine, stats } = makeEngine({ durationMs: 60 });
    const def = buildFanOut(NODES);

    const result = await engine.runWorkflow(def as any, {
      parallelLimit: 2,
      strict: false,
    } as any);

    expect((result as any).status).toBe("completed");
    // The whole point: parallelization must NOT bypass the semaphore.
    expect(stats.peakConcurrency).toBeLessThanOrEqual(2);
    // And it must be > 1, otherwise the limit is trivially "honored" by
    // staying serial (i.e. the bug is still present).
    expect(stats.peakConcurrency).toBeGreaterThanOrEqual(2);

    // All 6 leaves still ran exactly once.
    for (let i = 0; i < NODES; i++) {
      expect(stats.executions.get(`leaf-${i}`)).toBe(1);
    }
  });

  it("RED: with parallelLimit=1 execution stays strictly serial", async () => {
    const NODES = 3;
    const { engine, stats } = makeEngine({ durationMs: 40 });
    const def = buildFanOut(NODES);

    const result = await engine.runWorkflow(def as any, {
      parallelLimit: 1,
      strict: false,
    } as any);

    expect((result as any).status).toBe("completed");
    expect(stats.peakConcurrency).toBe(1);

    // No pair may overlap.
    const leaves = Array.from({ length: NODES }, (_, i) => stats.spans.get(`leaf-${i}`)) as Array<{
      start: number;
      end: number;
    }>;
    for (let i = 0; i < leaves.length; i++) {
      for (let j = i + 1; j < leaves.length; j++) {
        expect(overlaps(leaves[i], leaves[j])).toBe(false);
      }
    }
  });
});

describe("P0-1 dependency ordering is preserved", () => {
  it("RED: a linear chain never overlaps and completes in order", async () => {
    const STEPS = 4;
    const { engine, stats } = makeEngine({ durationMs: 30 });
    const def = buildChain(STEPS);

    const result = await engine.runWorkflow(def as any, {
      parallelLimit: 8,
      strict: false,
    } as any);

    expect((result as any).status).toBe("completed");
    expect(stats.peakConcurrency).toBe(1);

    // Each step must start after its predecessor ended.
    for (let i = 1; i < STEPS; i++) {
      const prev = stats.spans.get(`step-${i - 1}`)!;
      const cur = stats.spans.get(`step-${i}`)!;
      expect(cur.start).toBeGreaterThanOrEqual(prev.end);
    }

    // Outputs intact and in order.
    const output = (result as any).output ?? {};
    for (let i = 0; i < STEPS; i++) {
      expect(output[`step-${i}`]).toBe(`out-step-${i}`);
    }
  });
});

describe("P0-1 fail-fast converges without dangling promises", () => {
  // Explicit timeout (CV-4392 A.ii). This test deliberately lets 200ms siblings
  // sleep while a 10ms node fails, plus engine overhead — comfortably inside
  // bun's 5s default in isolation, but under `--parallel 4` sibling-file CPU
  // contention the *engine's own* polling interval can stretch and brush the
  // default budget. Raising the ceiling removes that flake without weakening a
  // single assertion (all of which are structural, not wall-clock).
  it("RED: one failing node fails the run and no in-flight node is left unawaited", async () => {
    const NODES = 4;
    // leaf-0 fails fast; the others sleep long enough that a naive
    // fire-and-forget implementation would leave them running past resolution.
    const { engine, stats } = makeEngine({
      durationMs: 200,
      failing: new Set(["leaf-0"]),
      delayFor: (nodeId) => (nodeId === "leaf-0" ? 10 : 200),
    });
    const def = buildFanOut(NODES);

    const result = await engine.runWorkflow(def as any, {
      parallelLimit: NODES,
      strict: false,
    } as any);

    // The run must resolve (not hang) and report failure.
    expect((result as any).status).toBe("failed");

    // fail-fast must NOT degenerate into a serial drain of every sibling.
    //
    // Assert this *structurally* rather than with a wall-clock budget: under
    // `--parallel 4` sibling test files steal CPU and any absolute timing
    // threshold becomes flaky. The structural signal is stronger anyway:
    // concurrent dispatch means every sibling is *started* before leaf-0's
    // 10ms body fails, whereas a serial drain would start them only after the
    // failure had already settled.
    const failing = stats.spans.get("leaf-0");
    expect(failing).toBeDefined();

    // Every sibling must have been dispatched (executed) — fail-fast cancels
    // them, so they may legitimately never *finish* and therefore have no
    // span. Dispatch evidence lives in `stats.executions`.
    for (let i = 1; i < NODES; i++) {
      expect(stats.executions.get(`leaf-${i}`)).toBe(1);
    }

    // Those that did finish started concurrently with the failing node, i.e.
    // before the failure could have been observed. A serial drain would have
    // sequenced them after it.
    const finishedSiblings = [];
    for (let i = 1; i < NODES; i++) {
      const span = stats.spans.get(`leaf-${i}`);
      if (span) finishedSiblings.push(span);
    }
    for (const span of finishedSiblings) {
      expect(span.start).toBeLessThan(failing!.end + 100);
    }

    // Every node was dispatched at most once (no duplicate scheduling).
    for (const [nodeId, count] of stats.executions) {
      expect(count).toBe(1);
      expect(nodeId.length).toBeGreaterThan(0);
    }
  }, 20000);
});
