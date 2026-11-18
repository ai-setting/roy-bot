/**
 * @fileoverview Concurrency regression in agent sub-session registration
 * (Task #4412 C1, found by cross-validation of the B1/B2 fix).
 *
 * ## The bug
 *
 * `AgentNode.createAgentSubSession()` registers the child agent session by
 * doing a bare read-modify-write on the *parent workflow session's* metadata:
 *
 * ```ts
 * const workflowSession = await sessionComponent.get(context.sessionId);   // read
 * const agentSessions = metadata.agentSessions ?? [];
 * agentSessions.push({ nodeId, sessionId: agentSessionId, status: 'active' });
 * await sessionComponent.update(context.sessionId, {                       // write
 *   metadata: { ...metadata, agentSessions },
 * });
 * ```
 *
 * That was safe while nodes ran one at a time (`main`: the `for … await
 * startNode()` loop). P0-1 (Task #4392) made dispatch concurrent, so N agent
 * nodes now enter this block simultaneously, each reading the *same* parent
 * metadata and each writing back its own array-with-one-extra-entry. The last
 * writer wins and every sibling's marker is lost.
 *
 * This is the same defect class as B1 (lost update on session metadata via a
 * stale snapshot) — it just lives in a different file, and it is not reachable
 * through the engine's `updateSessionMetadata()` queue because that queue is
 * private to `WorkflowEngine`.
 *
 * ## Why the stub must deep-copy
 *
 * `SessionComponent.get()` in production (SQLite store) materialises metadata
 * from a JSON column, so every call returns an independent deep copy. A naive
 * test stub that returns the same object reference lets the concurrent writers
 * share one array, which *masks* the race entirely. The fixture below mirrors
 * production by JSON round-tripping on read.
 */

import { describe, it, expect } from "bun:test";
import { WorkflowEngine } from "./engine";
import { NodeRegistry } from "./node-registry";
import type { WorkflowDefinition, NodeDefinition } from "../types";
import type { SessionComponent } from "../../session/session-component";

/**
 * In-memory session stub that round-trips metadata through JSON on every read
 * and write, matching the SQLite store's semantics (`JSON.stringify` on write,
 * `JSON.parse` on read → each `get()` is an independent copy).
 */
function makeDeepCopySession(): SessionComponent {
  const state = new Map<string, string>();

  const parse = (raw: string | undefined): any => (raw ? JSON.parse(raw) : null);
  const serialize = (value: any): string => JSON.stringify(value);

  return {
    create: async (opts: any) => {
      state.set(opts.id, serialize({ ...opts, metadata: { ...(opts.metadata ?? {}) } }));
      return { id: opts.id, ...opts };
    },
    get: async (id: string) => parse(state.get(id)),
    update: async (id: string, patch: any) => {
      const cur = parse(state.get(id)) ?? { id };
      const next = {
        ...cur,
        ...patch,
        metadata: { ...(cur.metadata ?? {}), ...(patch.metadata ?? {}) },
      };
      // Yield to the event loop so concurrent updaters genuinely interleave,
      // the way a real (synchronous SQLite but async-wrapped) write would.
      await new Promise((r) => setTimeout(r, 5));
      state.set(id, serialize(next));
      return true;
    },
    addMessage: async () => "msg-id",
    getMessages: async () => [],
    list: async () => [],
  } as unknown as SessionComponent;
}

/** A cooperative agent runner stub: returns immediately with a text output. */
function makeAgentRunner(counter: Map<string, number>) {
  return {
    async run(options: any) {
      const nodeId = options?.nodeId ?? options?.context?.nodeId ?? "?";
      counter.set(nodeId, (counter.get(nodeId) ?? 0) + 1);
      await new Promise((r) => setTimeout(r, 25));
      return { output: `agent-output-${nodeId}`, messages: [], usage: undefined };
    },
    async cancel() {},
  };
}

function agentNode(id: string, dependsOn?: string[]): NodeDefinition {
  return {
    id,
    type: "agent",
    name: id,
    ...(dependsOn ? { depends_on: dependsOn } : {}),
    config: {
      agent_type: "general",
      prompt: `run ${id}`,
      options: { model: "test-model" },
    },
  } as unknown as NodeDefinition;
}

function makeDef(
  name: string,
  nodes: NodeDefinition[],
  edges: Array<{ from: string; to: string }>
): WorkflowDefinition {
  return {
    name,
    version: "1.0.0",
    description: "agent sub-session registration fixture",
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
    },
  } as unknown as WorkflowDefinition;
}

describe("C1: concurrent agent nodes must all register their sub-session", () => {
  it("4 concurrent agent nodes leave 4 agentSessions markers on the parent", async () => {
    const sessions = makeDeepCopySession();
    const counter = new Map<string, number>();
    const runner = makeAgentRunner(counter);

    const registry = new NodeRegistry({
      agentRunner: runner as any,
      sessionComponent: sessions,
    });

    const engine = new WorkflowEngine(registry, sessions);

    // root agent → 3 sibling agent nodes, all dispatched in one round.
    const nodes = [
      agentNode("root"),
      agentNode("child-a", ["root"]),
      agentNode("child-b", ["root"]),
      agentNode("child-c", ["root"]),
    ];
    const def = makeDef("c1-agent-subsessions", nodes, []);

    const result = (await engine.runWorkflow(def, { parallelLimit: 4 } as any)) as any;
    expect(result.status).toBe("completed");

    // Find the workflow run session (the one that owns agentSessions).
    const all = await (sessions as any).list();
    const rows = Array.isArray(all) && all.length > 0 ? all : [];
    let markers: string[] = [];
    if (rows.length > 0) {
      const owner = rows.find((r: any) => Array.isArray(r?.metadata?.agentSessions));
      markers = (owner?.metadata?.agentSessions ?? []).map((s: any) => s.nodeId).sort();
    }
    if (markers.length === 0) {
      // Fall back to querying the run session directly.
      const runSession = await sessions.get(result.runId);
      markers = ((runSession?.metadata as any)?.agentSessions ?? [])
        .map((s: any) => s.nodeId)
        .sort();
    }

    // Every agent node ran...
    expect(counter.size).toBe(4);
    // ...and every one of them must have left a marker. Regression on
    // 30967e4a/adde56d2: only a subset survives (last writer wins).
    expect(markers).toEqual(["child-a", "child-b", "child-c", "root"]);
  }, 60000);
});
