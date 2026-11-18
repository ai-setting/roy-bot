/**
 * Guards the parallelism outcomes that Task #4411 independently verified on the
 * P0-1 branch, so a future change to dispatch/claim/finalize cannot silently
 * give back the speedup (or reintroduce a deadlock) while the concurrency
 * regression tests stay green.
 *
 * Measured here (8 leaves, 120ms body): limit=1 → ~2060ms / peak 1;
 * limit=4 → ~550ms / peak 4 (~3.7x). Peak is measured with a
 * increment-on-entry / decrement-on-exit counter, so it is real overlap rather
 * than "finished fast enough".
 */
import { describe, it, expect } from "bun:test";
import { WorkflowEngine } from "./engine";
import { NodeRegistry } from "./node-registry";
import type { WorkflowDefinition, NodeDefinition } from "../types";
import type { SessionComponent } from "../../session/session-component";

function makeStubSession(): SessionComponent {
  const state = new Map<string, any>();
  return {
    create: async (opts: any) => {
      state.set(opts.id, { ...opts, metadata: { ...(opts.metadata ?? {}) } });
      return { id: opts.id, ...opts };
    },
    get: async (id: string) => {
      const c = state.get(id);
      return c ? { ...c, metadata: { ...(c.metadata ?? {}) } } : null;
    },
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

interface Stats {
  peak: number;
  active: number;
  runs: Map<string, number>;
  spans: Map<string, { start: number; end: number }>;
}

function makeEngine(stub: SessionComponent, stats: Stats, bodyMs: number) {
  const registry = new NodeRegistry();
  const probe = {
    name: "probe",
    execute: async (input: any) => {
      const id = String(input?.nodeId);
      stats.runs.set(id, (stats.runs.get(id) ?? 0) + 1);
      const start = Date.now();
      stats.active += 1;
      stats.peak = Math.max(stats.peak, stats.active);
      await new Promise((r) => setTimeout(r, bodyMs));
      stats.active -= 1;
      const end = Date.now();
      if (!stats.spans.has(id)) stats.spans.set(id, { start, end });
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
  return new WorkflowEngine(registry, stub);
}

function fanOut(n: number, name: string): WorkflowDefinition {
  const nodes: NodeDefinition[] = [
    { id: "root", type: "tool", name: "root", config: { tool: "probe", input: { nodeId: "root" } } } as any,
  ];
  for (let i = 0; i < n; i++) {
    nodes.push({
      id: `leaf-${i}`,
      type: "tool",
      name: `leaf-${i}`,
      depends_on: ["root"],
      config: { tool: "probe", input: { nodeId: `leaf-${i}` } },
    } as any);
  }
  return {
    name, version: "1.0.0", description: "d", nodes, edges: [],
    entry: "__default_entry__", outputs: [], inputs: {}, metadata: { tags: [] },
    config: { timeout: null, debug: false, strict: false, maxIterations: 100, loopEnabled: false },
  } as any;
}

async function timed(engine: WorkflowEngine, def: any, limit: number): Promise<number> {
  const t0 = Date.now();
  await engine.runWorkflow(def, { parallelLimit: limit } as any);
  return Date.now() - t0;
}

describe("GOOD OUTCOMES (from #4411) still hold after the B1/B2 fix", () => {
  it("8-node fan-out: limit=4 is materially faster than limit=1", async () => {
    const N = 8;
    const BODY = 120;

    const s1: Stats = { peak: 0, active: 0, runs: new Map(), spans: new Map() };
    const e1 = makeEngine(makeStubSession(), s1, BODY);
    const serial = await timed(e1, fanOut(N, "good-serial"), 1);

    const s4: Stats = { peak: 0, active: 0, runs: new Map(), spans: new Map() };
    const e4 = makeEngine(makeStubSession(), s4, BODY);
    const parallel = await timed(e4, fanOut(N, "good-parallel"), 4);

    const speedup = serial / parallel;
    console.log(
      `[GOOD] N=${N} body=${BODY}ms | limit=1 → ${serial}ms (peak ${s1.peak}) | limit=4 → ${parallel}ms (peak ${s4.peak}) | speedup ${speedup.toFixed(2)}x`
    );

    expect(speedup).toBeGreaterThan(3);
    expect(s4.peak).toBeGreaterThanOrEqual(2);
    // parallel_limit hard cap
    expect(s4.peak).toBeLessThanOrEqual(4);
    // every node ran exactly once
    for (const [id, n] of s4.runs) expect(`${id}=${n}`).toBe(`${id}=1`);
    expect(s4.runs.size).toBe(N + 1);
  }, 120000);

  it("parallel_limit is a hard cap at 2 and 3", async () => {
    for (const limit of [2, 3]) {
      const s: Stats = { peak: 0, active: 0, runs: new Map(), spans: new Map() };
      const e = makeEngine(makeStubSession(), s, 80);
      await timed(e, fanOut(6, `good-cap-${limit}`), limit);
      console.log(`[GOOD] limit=${limit} → peak ${s.peak}`);
      expect(s.peak).toBeLessThanOrEqual(limit);
      for (const [id, n] of s.runs) expect(`${id}=${n}`).toBe(`${id}=1`);
    }
  }, 120000);

  it("double-parent (diamond) node never re-runs", async () => {
    for (const limit of [1, 2, 3]) {
      const s: Stats = { peak: 0, active: 0, runs: new Map(), spans: new Map() };
      const e = makeEngine(makeStubSession(), s, 60);
      const def: WorkflowDefinition = {
        name: `good-diamond-${limit}`, version: "1.0.0", description: "d",
        nodes: [
          { id: "root", type: "tool", name: "root", config: { tool: "probe", input: { nodeId: "root" } } },
          { id: "A", type: "tool", name: "A", depends_on: ["root"], config: { tool: "probe", input: { nodeId: "A" } } },
          { id: "B", type: "tool", name: "B", depends_on: ["root"], config: { tool: "probe", input: { nodeId: "B" } } },
          { id: "D", type: "tool", name: "D", depends_on: ["A", "B"], config: { tool: "probe", input: { nodeId: "D" } } },
        ] as any,
        edges: [], entry: "__default_entry__", outputs: [], inputs: {}, metadata: { tags: [] },
        config: { timeout: null, debug: false, strict: false, maxIterations: 100, loopEnabled: false },
      } as any;
      await timed(e, def, limit);
      console.log(`[GOOD] diamond limit=${limit} → runs ${JSON.stringify([...s.runs])}`);
      for (const [id, n] of s.runs) expect(`${id}=${n}`).toBe(`${id}=1`);
    }
  }, 180000);

  it("no deadlock: 5 independent engines concurrently, limit=1", async () => {
    const engines = Array.from({ length: 5 }, () => {
      const s: Stats = { peak: 0, active: 0, runs: new Map(), spans: new Map() };
      return { engine: makeEngine(makeStubSession(), s, 40), stats: s };
    });
    const results = await Promise.all(
      engines.map(({ engine }, i) => timed(engine, fanOut(4, `good-concurrent-${i}`), 1))
    );
    console.log(`[GOOD] 5 concurrent engines, limit=1 → walls ${JSON.stringify(results)}ms`);
    results.forEach((ms) => expect(ms).toBeLessThan(60000));
  }, 180000);
});
