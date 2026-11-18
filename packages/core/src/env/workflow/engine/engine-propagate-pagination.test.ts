/**
 * @fileoverview TDD RED — propagateStopToChildSessions must paginate
 * (Task #2291 Codex P1-1 / Claude P1-1).
 *
 * Background (Task #2291 follow-up to Task #2275):
 *   Both reviewers (Codex P1-1, Claude P1-1) flagged the same bug:
 *   `engine.propagateStopToChildSessions` fetches children via a single
 *   `list({ limit: 10_000 })` call, silently dropping any children past
 *   index 10K. WorkflowService.listAllSessions (introduced in Task #2245
 *   Codex P1-2 to fix exactly this class of bug) paginates correctly
 *   (PAGE=1000, HARD_CAP=50_000) — the engine path was missed.
 *
 * Contract after GREEN:
 *   - propagateStopToChildSessions paginates `sessionComponent.list`
 *     (PAGE=1000, HARD_CAP=50_000) so children past 10K are still
 *     propagated as 'stopped'.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { WorkflowEngine } from "./engine";
import { NodeRegistry } from "./node-registry";
import type { AgentRunner, AgentConfig, AgentResult } from "../nodes/agent-node";

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

function makeSessionComponentWithManyChildren() {
  const store = new Map<string, SessionRow>();
  let listCallCount = 0;
  let listOptionsSeen: Array<{ limit?: number; offset?: number }> = [];
  return {
    _store: store,
    _listCallCount: () => listCallCount,
    _listOptionsSeen: () => listOptionsSeen,
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
    /**
     * Paginated list — returns up to `limit` rows starting at `offset`.
     * Records the (limit, offset) of every call so the test can assert
     * pagination behavior.
     */
    async list(opts?: { limit?: number; offset?: number; parentSessionId?: string }) {
      listCallCount++;
      listOptionsSeen.push({ limit: opts?.limit, offset: opts?.offset });
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

function makeCompletingRunner(): AgentRunner {
  return {
    run: async (_config: AgentConfig, _resume: any, _signal?: AbortSignal): Promise<AgentResult> => {
      return { output: { done: true } };
    },
  };
}

describe("[Task #2291 P1-1] propagateStopToChildSessions paginates", () => {
  let sessions: ReturnType<typeof makeSessionComponentWithManyChildren>;
  let engine: WorkflowEngine;

  beforeEach(() => {
    sessions = makeSessionComponentWithManyChildren();
    const runner = makeCompletingRunner();
    const registry = new NodeRegistry({
      agentRunner: runner as any,
      sessionComponent: sessions as any,
    });
    engine = new WorkflowEngine(registry, sessions as any);
  });

  it("RED-F3-1: when >10K children exist, all of them are marked stopped (no silent drop)", async () => {
    // Pre-create a workflow session and 12,500 child sessions linked to it.
    // The old implementation's `list({limit: 10_000})` would drop the
    // last 2,500. After GREEN, paginated fetch (PAGE=1000, HARD_CAP=50K)
    // must catch all 12,500.
    const workflowSessionId = `workflow_${Date.now()}_f3_1`;
    await sessions.create({
      id: workflowSessionId,
      title: "Workflow: f3-1",
      metadata: {
        type: "workflow",
        runId: workflowSessionId,
        workflowName: "f3-pagination",
        status: "running",
      },
    });

    const TOTAL = 12_500;
    for (let i = 0; i < TOTAL; i++) {
      await sessions.create({
        id: `child_${i}_${Date.now()}`,
        title: `child-${i}`,
        metadata: { status: "running" },
        parentSessionId: workflowSessionId,
      });
    }

    // Trigger the propagation path via engine.stop. The workflow session
    // is not in activeSessions, so engine.stop falls through to the
    // 'not in memory' branch which calls propagateStopToChildSessions.
    await engine.stop(workflowSessionId, "ESC-cascade-pagination-test");

    // Count children that ended up as 'stopped'.
    let stoppedCount = 0;
    for (const row of sessions._store.values()) {
      if (row.parentSessionId === workflowSessionId && row.metadata?.status === "stopped") {
        stoppedCount++;
      }
    }
    // Must propagate to ALL children, not just the first 10K.
    expect(stoppedCount).toBe(TOTAL);

    // Pagination must have been used: more than one list() call.
    expect(sessions._listCallCount()).toBeGreaterThan(1);
    // No single call may request more than 10K (the previous limit).
    for (const opts of sessions._listOptionsSeen()) {
      expect(opts.limit ?? 0).toBeLessThanOrEqual(1000);
    }
  });
});
