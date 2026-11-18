/**
 * @fileoverview TDD RED — Graceful engine.stop must eventually evict
 * sessionState from activeSessions (Task #2291 Codex P1-2 / Claude P2-3).
 *
 * Background (Task #2291 follow-up to Task #2275):
 *   Both reviewers flagged the same memory leak:
 *   - Codex P1-2: "Graceful `stop()` leaks `activeSessions` entry forever
 *     (memory leak in long REPL sessions)"
 *   - Claude P2-3: "Graceful-with-scope `stop()` leaks `activeSessions`
 *     entries (no cleanup)"
 *
 *   The current engine.stop() (after the Task #2275 changes) keeps the
 *   sessionState in `activeSessions` so a subsequent stop({force:true})
 *   can locate it and escalate. The entry is "leaked but inert" — every
 *   ESC accumulates a sessionState plus its cancellationScope closure.
 *   `isSessionActive` returns false for status='stopped' so callers can't
 *   see the leak, but the Map itself never shrinks.
 *
 * Contract after GREEN:
 *   - After a bounded grace period (matching SessionTreeStopper's ESC
 *     double-press window, default 2s), the sessionState is evicted from
 *     activeSessions and the per-session cancellationScope becomes
 *     eligible for GC.
 *   - Until the grace period elapses, isSessionActive must still return
 *     false (so a force-escalation stop within the window can find it).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { WorkflowEngine } from "./engine";
import { NodeRegistry } from "./node-registry";
import type { AgentRunner, AgentResult } from "../nodes/agent-node";

// =============================================================================
// Helpers
// =============================================================================

interface SessionRow {
  id: string;
  title: string;
  metadata: any;
  parentSessionId?: string | null;
  messages?: unknown[];
}

function makeSessionComponent() {
  const store = new Map<string, SessionRow>();
  return {
    _store: store,
    async create(row: { id?: string; title: string; metadata: any; parentSessionId?: string | null }) {
      const id = row.id ?? `sess_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      store.set(id, { ...row, id, messages: row.metadata?.messages ?? [] });
      return { id };
    },
    async get(id: string): Promise<SessionRow | null> {
      return store.get(id) ?? null;
    },
    async update(id: string, patch: { metadata?: any }): Promise<boolean> {
      const row = store.get(id);
      if (!row) return false;
      if (patch.metadata) row.metadata = { ...row.metadata, ...patch.metadata };
      store.set(id, row);
      return true;
    },
    async list(opts?: { limit?: number; offset?: number; parentSessionId?: string }) {
      let rows = Array.from(store.values());
      if (opts?.parentSessionId !== undefined) {
        rows = rows.filter((r) => r.parentSessionId === opts.parentSessionId);
      }
      const offset = opts?.offset ?? 0;
      const limit = opts?.limit ?? rows.length;
      return rows.slice(offset, offset + limit);
    },
    async addMessage(_id: string, _msg: unknown) { return "msg"; },
    async getMessages(id: string) { return store.get(id)?.messages ?? []; },
  };
}

interface BlockingRunner extends AgentRunner {
  pending: boolean;
}

function makeBlockingRunner(): BlockingRunner {
  const runner: BlockingRunner = {
    pending: false,
    run: async (_cfg: any, _resume: any, signal?: AbortSignal): Promise<AgentResult> => {
      runner.pending = true;
      await new Promise<void>((resolve) => {
        if (!signal) return;
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      runner.pending = false;
      return { output: "completed" };
    },
  };
  return runner;
}

describe("[Task #2291 P1-2] Graceful stop evicts session from activeSessions", () => {
  let sessions: ReturnType<typeof makeSessionComponent>;
  let runner: BlockingRunner;
  let engine: WorkflowEngine;

  beforeEach(() => {
    sessions = makeSessionComponent();
    runner = makeBlockingRunner();
    const registry = new NodeRegistry({
      agentRunner: runner as any,
      sessionComponent: sessions as any,
    });
    engine = new WorkflowEngine(registry, sessions as any);
  });

  it("RED-F4-1: after graceful stop + 2.5s grace window, activeSessions.size does not include the stopped session", async () => {
    const workflowSessionId = `workflow_${Date.now()}_f4_1`;
    await sessions.create({
      id: workflowSessionId,
      title: "Workflow: f4-1",
      metadata: { type: "workflow", runId: workflowSessionId, workflowName: "f4", status: "running" },
    });

    // Fire a workflow run and stop it gracefully (no force).
    const runPromise = engine.runWorkflow(
      {
        name: "f4",
        version: "1.0.0",
        description: "leak test",
        config: {},
        nodes: [
          {
            id: "n1",
            type: "agent",
            name: "N1",
            config: { agent_type: "general", prompt: "echo", options: { model: "test" } },
          } as any,
        ],
        edges: [],
        entry: "n1",
      } as any,
      { runId: workflowSessionId, input: {} }
    );

    // Wait for the runner to be live in the agent node.
    await new Promise((r) => setTimeout(r, 50));
    expect(runner.pending).toBe(true);

    // Fire graceful stop.
    await engine.stop(workflowSessionId, "ESC graceful");

    // Immediately after stop, the session is still in activeSessions
    // (force-escalation window). isSessionActive must report false.
    expect(engine.isSessionActive(workflowSessionId)).toBe(false);

    // Drain the run promise.
    await Promise.race([
      runPromise.catch(() => {}),
      new Promise((r) => setTimeout(r, 500)),
    ]);

    // After the grace window (2s + tolerance), the sessionState must be
    // evicted from activeSessions. The simplest observable: a NEW
    // engine.stop with the same sessionId reaches the 'not in memory'
    // branch (which only logs / no in-memory work) — measured here by
    // checking that isSessionActive is still false AND that the engine
    // does not have the sessionState attached to its (internal) cleanup
    // closure for that id. We rely on the public `isSessionActive`
    // contract: it returns false for both 'stopped' and 'not in map'.
    // The leak-specific assertion is that the map did not retain an
    // entry whose status is 'stopped' past the grace window. We test
    // this by directly inspecting (engine as any).activeSessions.
    await new Promise((r) => setTimeout(r, 2500));
    const activeSessions: Map<string, any> = (engine as any).activeSessions;
    const entry = activeSessions.get(workflowSessionId);
    // After grace, the entry must be gone (evicted) — not present with
    // status='stopped'.
    expect(entry).toBeUndefined();
  });
});
