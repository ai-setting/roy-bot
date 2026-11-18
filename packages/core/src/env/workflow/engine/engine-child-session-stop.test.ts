/**
 * @fileoverview TDD RED — Child agent session metadata must be marked
 * "stopped" when WorkflowEngine.stop fires (Task #2275 Task 4 + Gap 2).
 *
 * Background:
 *   The user's real-world session tree shows:
 *     session_d8d23208 chat
 *     └── workflow_1784705682574_fallback_au4pq9 workflow/roy-rd-with-trace (stopped)
 *         ├── agent_plan_1784705697999 agent
 *         └── agent_init-task_1784705682615 agent
 *
 *   After ESC, the workflow shows "stopped" but the agent sessions
 *   (agent_plan, agent_init-task) don't reflect a stopped state.
 *
 * What happens today:
 *   - WorkflowEngine.stop updates workflow session metadata.status=stopped
 *     and agentSessions[] refs → "stopped".
 *   - BUT the actual child session record (agent_xxx_yyy) — the Session
 *     object created via sessionComponent.create({id: 'agent_xxx_yyy'})
 *     — never gets its metadata.status updated.
 *
 * Tests below pin the contract:
 *   - CS-1: after engine.stop, each child session referenced in
 *     metadata.agentSessions MUST have its own metadata.status === "stopped"
 *     (or be already terminal — preserved).
 *   - CS-2: an already-completed child session is preserved (not overwritten).
 *   - CS-3: stop is idempotent — second stop doesn't re-trigger updates.
 *   - CS-4: force stop escalates each child session to "stopped".
 *
 * RED state: prior to GREEN, CS-1 fails because engine.stop never
 * touches child sessions.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { WorkflowEngine } from "./engine";
import { NodeRegistry } from "./node-registry";
import type {
  AgentRunner,
  AgentResult,
} from "../nodes/agent-node";
import type { WorkflowDefinition } from "../types/workflow";

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

interface BlockingRunner extends AgentRunner {
  pending: boolean;
  runCalls: number;
  run: (cfg: any, resume: any, signal?: AbortSignal) => Promise<AgentResult>;
}

function makeBlockingRunner(): BlockingRunner {
  const runner: BlockingRunner = {
    pending: false,
    runCalls: 0,
    run: async (_cfg: any, _resume: any, signal?: AbortSignal) => {
      runner.runCalls++;
      runner.pending = true;
      // Simulate agent sub-session creation (matching real AgentNode behavior).
      const agentSessionId = _cfg?.agentSessionId as string | undefined;
      await new Promise<void>((resolve) => {
        if (!signal) return;
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      runner.pending = false;
      return { output: "completed", metadata: { agentSessionId } } as AgentResult;
    },
  };
  return runner;
}

function makeOneAgentWorkflow(name = "child-session-stop"): WorkflowDefinition {
  return {
    name,
    version: "1.0.0",
    description: "single blocking agent for child session stop test",
    config: {},
    nodes: [
      {
        id: "plan",
        type: "agent",
        config: {
          agent_type: "general",
          prompt: "echo",
          options: { model: "test-model" },
        },
      },
      {
        id: "init-task",
        type: "agent",
        config: {
          agent_type: "general",
          prompt: "echo",
          options: { model: "test-model" },
        },
      },
    ],
    edges: [{ from: "plan", to: "init-task" }],
    entry: "plan",
  } as any;
}

// =============================================================================
// Tests
// =============================================================================

describe("[Task #2275 RED] Child agent sessions marked stopped on engine.stop", () => {
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

  it("CS-1: after engine.stop, child sessions in agentSessions[] are marked 'stopped'", async () => {
    const wf = makeOneAgentWorkflow();

    // Pre-create the workflow session.
    const workflowSessionId = `workflow_${Date.now()}_fallback_cs1`;
    await sessions.create({
      id: workflowSessionId,
      title: "Workflow: child-session-stop",
      metadata: {
        type: "workflow",
        runId: workflowSessionId,
        workflowName: wf.name,
        status: "running",
      },
    });

    // Run workflow — DON'T await (in-flight).
    const runPromise = engine.runWorkflow(wf as any, {
      runId: workflowSessionId,
      input: {},
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(runner.pending).toBe(true);

    // Wait for AgentNode to create child session for "plan" node.
    await new Promise((r) => setTimeout(r, 30));
    const childSessions = Array.from(sessions._store.values()).filter(
      (r) => r.parentSessionId === workflowSessionId,
    );
    expect(childSessions.length).toBeGreaterThanOrEqual(1);
    const planChild = childSessions[0];
    // Child session must currently have no status (or status='running').
    expect(["running", undefined].includes(planChild.metadata?.status)).toBe(true);

    // Fire graceful stop.
    await engine.stop(workflowSessionId, "ESC cascade");

    // Wait for run to settle.
    await Promise.race([
      runPromise.catch(() => {}),
      new Promise((r) => setTimeout(r, 1000)),
    ]);

    // Child session MUST now have status="stopped".
    const updatedChild = sessions._store.get(planChild.id);
    expect(updatedChild).toBeDefined();
    expect(updatedChild!.metadata?.status).toBe("stopped");
  });

  it("CS-2: already-completed child session is NOT overwritten", async () => {
    const wf = makeOneAgentWorkflow();

    const workflowSessionId = `workflow_${Date.now()}_fallback_cs2`;
    await sessions.create({
      id: workflowSessionId,
      title: "Workflow: cs2",
      metadata: {
        type: "workflow",
        runId: workflowSessionId,
        workflowName: wf.name,
        status: "running",
      },
    });

    const runPromise = engine.runWorkflow(wf as any, {
      runId: workflowSessionId,
      input: {},
    });
    await new Promise((r) => setTimeout(r, 30));

    // Manually mark the child session as "completed" (simulating a node
    // that finished before the stop).
    const childSessions = Array.from(sessions._store.values()).filter(
      (r) => r.parentSessionId === workflowSessionId,
    );
    if (childSessions.length > 0) {
      await sessions.update(childSessions[0].id, { metadata: { status: "completed" } });
    }

    await engine.stop(workflowSessionId, "ESC cascade");
    await Promise.race([
      runPromise.catch(() => {}),
      new Promise((r) => setTimeout(r, 1000)),
    ]);

    if (childSessions.length > 0) {
      const updated = sessions._store.get(childSessions[0].id);
      // Must remain "completed", not overwritten to "stopped".
      expect(updated?.metadata?.status).toBe("completed");
    }
  });

  it("CS-3: stop is idempotent — second stop doesn't change child state", async () => {
    const wf = makeOneAgentWorkflow();
    const workflowSessionId = `workflow_${Date.now()}_fallback_cs3`;
    await sessions.create({
      id: workflowSessionId,
      title: "Workflow: cs3",
      metadata: { type: "workflow", runId: workflowSessionId, workflowName: wf.name, status: "running" },
    });
    const runPromise = engine.runWorkflow(wf as any, { runId: workflowSessionId, input: {} });
    await new Promise((r) => setTimeout(r, 30));

    await engine.stop(workflowSessionId, "first ESC");
    await new Promise((r) => setTimeout(r, 50));

    // Capture child states after first stop.
    const childSessions = Array.from(sessions._store.values()).filter(
      (r) => r.parentSessionId === workflowSessionId,
    );
    const firstStates = new Map<string, string | undefined>();
    for (const c of childSessions) {
      firstStates.set(c.id, c.metadata?.status);
    }

    // Second stop — must not throw.
    await engine.stop(workflowSessionId, "second ESC");
    await new Promise((r) => setTimeout(r, 30));

    // Final invariant: every child session is in a terminal state.
    // (Either already-stopped (preserved by idempotency), or freshly stopped
    //  by the latest propagate if the previous run missed it.)
    const finalChildren = Array.from(sessions._store.values()).filter(
      (r) => r.parentSessionId === workflowSessionId,
    );
    for (const c of finalChildren) {
      const status = c.metadata?.status;
      expect(["stopped", "completed", "failed"]).toContain(status);
    }

    // And idempotency for sessions that first stop already marked: their
    // status is unchanged (still "stopped", not "running" or undefined).
    for (const [id, firstStatus] of firstStates) {
      if (firstStatus === "stopped") {
        expect(sessions._store.get(id)?.metadata?.status).toBe("stopped");
      }
    }

    await runPromise.catch(() => {});
  });

  it("CS-4: force stop escalates child session status to 'stopped'", async () => {
    const wf = makeOneAgentWorkflow();
    const workflowSessionId = `workflow_${Date.now()}_fallback_cs4`;
    await sessions.create({
      id: workflowSessionId,
      title: "Workflow: cs4",
      metadata: { type: "workflow", runId: workflowSessionId, workflowName: wf.name, status: "running" },
    });
    const runPromise = engine.runWorkflow(wf as any, { runId: workflowSessionId, input: {} });
    await new Promise((r) => setTimeout(r, 30));

    // Force stop with the new force option.
    await engine.stop(workflowSessionId, "force stop", { force: true });
    await Promise.race([
      runPromise.catch(() => {}),
      new Promise((r) => setTimeout(r, 1000)),
    ]);

    const childSessions = Array.from(sessions._store.values()).filter(
      (r) => r.parentSessionId === workflowSessionId,
    );
    for (const c of childSessions) {
      // Either already terminal (completed/failed) or "stopped".
      const status = c.metadata?.status;
      expect(["stopped", "completed", "failed", "running"]).toContain(status);
      // Pending active children must be marked stopped.
      if (status !== "completed" && status !== "failed") {
        expect(status).toBe("stopped");
      }
    }
  });
});
