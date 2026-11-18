/**
 * @fileoverview TDD RED — engine.stop must NOT overwrite a terminal
 * "completed"/"failed" status (Task #2291 Codex P1-4 / Claude P0-2).
 *
 * Background (Task #2291 follow-up to Task #2275):
 *   Codex review of Task #2275 raised P1-4:
 *     "engine.stop() race: `sessionState.status = 'stopped'` set BEFORE
 *     `scope.cancel()` may cause `completeWorkflow` to overwrite or
 *     `failWorkflow` to short-circuit inconsistently"
 *
 *   Claude raised P0-2:
 *     "Scheduler loop only observes legacy `abortController`, not
 *      `cancellationScope.signal` — silent hang risk"
 *
 * Contract after GREEN:
 *   1. engine.stop() called on a session whose status is already terminal
 *      (completed/failed) returns immediately and does NOT overwrite the
 *      status (in-memory OR in DB).
 *   2. The scheduler loop exits when EITHER abortController.signal.aborted
 *      OR cancellationScope.signal.aborted fires.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { WorkflowEngine } from "./engine";
import { NodeRegistry } from "./node-registry";
import type { WorkflowDefinition } from "../types/workflow";
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

function makeSessionComponent() {
  const store = new Map<string, SessionRow>();
  return {
    _store: store,
    async create(row: { id?: string; title: string; metadata: any; parentSessionId?: string | null }) {
      const id = row.id ?? `sess_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const fullRow = { ...row, id, messages: row.metadata?.messages ?? [] };
      store.set(id, fullRow);
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

function makeCompletingRunner(): AgentRunner {
  return {
    run: async (_config: AgentConfig, _resume: any, _signal?: AbortSignal): Promise<AgentResult> => {
      return { output: { done: true } };
    },
  };
}

function makeOneAgentWorkflow(name = "f2-status-race"): WorkflowDefinition {
  return {
    name,
    version: "1.0.0",
    description: "single agent for status race test",
    config: {},
    nodes: [
      {
        id: "n1",
        type: "agent",
        name: "N1",
        config: {
          agent_type: "general",
          prompt: "echo",
          options: { model: "test-model" },
        },
      } as any,
    ],
    edges: [],
    entry: "n1",
  } as any;
}

describe("[Task #2291 P1-4/P0-2] engine.stop must not overwrite terminal status", () => {
  let sessions: ReturnType<typeof makeSessionComponent>;
  let engine: WorkflowEngine;

  beforeEach(() => {
    sessions = makeSessionComponent();
    const runner = makeCompletingRunner();
    const registry = new NodeRegistry({
      agentRunner: runner as any,
      sessionComponent: sessions as any,
    });
    engine = new WorkflowEngine(registry, sessions as any);
  });

  it("RED-F2-1: engine.stop on a session already at 'completed' status is a no-op (does not overwrite)", async () => {
    const wf = makeOneAgentWorkflow();
    const workflowSessionId = `workflow_${Date.now()}_f2_1`;
    await sessions.create({
      id: workflowSessionId,
      title: "Workflow: f2-1",
      metadata: {
        type: "workflow",
        runId: workflowSessionId,
        workflowName: wf.name,
        status: "running",
      },
    });

    // Run the workflow to natural completion (single node, completing runner).
    await engine.runWorkflow(wf as any, {
      runId: workflowSessionId,
      input: {},
    });

    // The DB row should be 'completed' after the run settles.
    const rowAfterRun = sessions._store.get(workflowSessionId);
    expect(rowAfterRun?.metadata?.status).toBe("completed");

    // Now hit engine.stop. This is the call that races with completeWorkflow
    // and would, before GREEN, overwrite status to 'stopped'.
    await engine.stop(workflowSessionId, "user-esc-after-completion");

    // The DB row metadata.status must remain 'completed' (not overwritten to 'stopped').
    const row = sessions._store.get(workflowSessionId);
    expect(row?.metadata?.status).toBe("completed");
  });

  it("RED-F2-2: scheduler loop observes cancellationScope.signal (not just legacy abortController)", async () => {
    // Pin the contract: the while guard in runWithResume (engine.ts:1279)
    // must include a check on cancellationScope.signal.aborted (or an
    // equivalent observation) so that scope-only cancel paths don't hang.
    const engineSrc = await Bun.file(
      new URL("./engine.ts", import.meta.url).pathname
    ).text();
    const hasScopeGuard =
      /cancellationScope\.signal\.aborted/.test(engineSrc) ||
      /sessionState\.cancellationScope\?\.signal\.aborted/.test(engineSrc);
    expect(hasScopeGuard).toBe(true);
  });
});
