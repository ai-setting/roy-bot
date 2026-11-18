/**
 * @fileoverview TDD — WorkflowService.stopRun with reserved fallback runId
 * (Task #2275 Task 5 RED → GREEN → verification).
 *
 * Real-world scenario (2026-07-22 07:31 user report):
 *
 *   session_d8d23208-... chat
 *   └── workflow_1784705682574_fallback_au4pq9 workflow/roy-rd-with-trace (stopped)
 *       ├── agent_plan_1784705697999 agent        ← still alive after ESC
 *       └── agent_init-task_1784705682615 agent    ← still alive after ESC
 *
 * The workflow's `runId` carries the `_fallback_` marker because
 * `run-workflow.ts` synthesized it BEFORE `engine.runWorkflow()` resolved
 * (Task #2100/2106). The engine itself, after `createSession()`, uses that
 * exact fallback runId as the session id (Task #2106 GREEN-B), so
 * `engine.stop(fallbackRunId)` SHOULD find the session in `activeSessions`.
 *
 * The tests below pin down:
 *   - F1: stopRun(fallbackRunId) during in-flight window finds the running
 *         engine and resolves runWorkflow() with status=stopped.
 *   - F5: stopRun on parent A's fallback runId does NOT touch parent B's
 *         engine (parent isolation).
 */

import { describe, it, expect } from "bun:test";
import { WorkflowService } from "./workflow-service";
import { WorkflowEngine } from "../engine/engine";
import { NodeRegistry } from "../engine/node-registry";
import type {
  Workflow,
  WorkflowDefinition,
  RunResult,
  RunOptions,
} from "../types";

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
    async create(row: { id?: string; title: string; metadata: any; parentSessionId?: string | null }): Promise<{ id: string }> {
      const id = row.id ?? `sess_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      store.set(id, { id, title: row.title, metadata: row.metadata, parentSessionId: row.parentSessionId, messages: [] });
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
    async list(opts?: { limit?: number; offset?: number; parentSessionId?: string }): Promise<SessionRow[]> {
      let rows = Array.from(store.values());
      if (opts?.parentSessionId !== undefined) {
        rows = rows.filter((r) => r.parentSessionId === opts.parentSessionId);
      }
      const offset = opts?.offset ?? 0;
      const limit = opts?.limit ?? rows.length;
      return rows.slice(offset, offset + limit);
    },
    async addMessage(_id: string, _msg: unknown): Promise<string> {
      return "msg";
    },
    async getMessages(id: string): Promise<unknown[]> {
      return store.get(id)?.messages ?? [];
    },
  };
}

interface CooperativeRunner {
  pending: boolean;
  runCalls: number;
  lastSignal: AbortSignal | undefined;
  run: (cfg: any, resume: any, signal?: AbortSignal) => Promise<any>;
}

function makeCooperativeRunner(): CooperativeRunner {
  const r: CooperativeRunner = {
    pending: false,
    runCalls: 0,
    lastSignal: undefined,
    run: async (_cfg: any, _resume: any, signal?: AbortSignal) => {
      r.runCalls++;
      r.lastSignal = signal;
      r.pending = true;
      try {
        await new Promise<void>((resolve) => {
          if (!signal) return;
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        r.pending = false;
        return { output: "completed-cooperatively" };
      } catch (err) {
        r.pending = false;
        throw err;
      }
    },
  };
  return r;
}

function makeOneAgentWorkflow(name = "esc-fallback-test"): WorkflowDefinition {
  return {
    name,
    version: "1.0.0",
    description: "single blocking agent for ESC fallback runId stop test",
    config: {},
    nodes: [
      {
        id: "hang-step",
        type: "agent",
        config: {
          agent_type: "general",
          prompt: "echo",
          options: { model: "test-model" },
        },
      },
    ],
    edges: [],
    entry: "hang-step",
  } as any;
}

function makeWorkflow(def: WorkflowDefinition): Workflow {
  return {
    id: `wf_${def.name}`,
    name: def.name,
    version: def.version,
    description: def.description,
    definition: def,
    config: def.config ?? {},
    metadata: { tags: ["esc-test"] },
    tags: ["esc-test"],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeWorkflowRepository(wf: Workflow) {
  return {
    create: (s: any) => ({ ...s, id: s.id ?? wf.id, createdAt: new Date(), updatedAt: new Date() }),
    getById: () => null,
    getByName: () => wf,
    list: () => [wf],
    update: () => wf,
    delete: () => true,
    transaction: (fn: () => unknown) => fn(),
    countAll: () => 1,
  } as any;
}

function makeService(opts: {
  wf: WorkflowDefinition;
  sessionComponent: ReturnType<typeof makeSessionComponent>;
  runners: CooperativeRunner[];
}) {
  const wf = makeWorkflow(opts.wf);
  const sessions = opts.sessionComponent as any;
  let factoryIdx = 0;
  return new WorkflowService(
    makeWorkflowRepository(wf),
    (() => {
      const runner = opts.runners[factoryIdx++ % opts.runners.length];
      const registry = new NodeRegistry({
        agentRunner: runner as any,
        sessionComponent: sessions,
      });
      return new WorkflowEngine(registry, sessions);
    }) as any,
    sessions,
  );
}

// =============================================================================
// Tests
// =============================================================================

describe("[Task #2275] WorkflowService stopRun with reserved fallback runId", () => {
  it("F1: stopRun(fallbackRunId) during in-flight window finds the running engine and resolves runWorkflow", async () => {
    const sessions = makeSessionComponent();
    const runner = makeCooperativeRunner();
    const wf = makeOneAgentWorkflow();
    const service = makeService({ wf, sessionComponent: sessions, runners: [runner] });

    const parentSessionId = "session_d8d23208-fake-chat";
    const reservedFallbackId = `workflow_${Date.now()}_fallback_f1`;
    await sessions.create({
      id: reservedFallbackId,
      title: `Workflow: ${wf.name} (${reservedFallbackId})`,
      parentSessionId,
      metadata: {
        type: "workflow",
        runId: reservedFallbackId,
        workflowName: wf.name,
        workflowVersion: wf.version,
        status: "running",
      },
    });

    // Kick off runWorkflow — DON'T await yet (simulate in-flight window).
    const runPromise = service.runWorkflow(wf.name, {}, {
      parentSessionId,
      runId: reservedFallbackId,
    } as RunOptions);

    // Wait briefly so the engine actually starts the agent node.
    await new Promise((r) => setTimeout(r, 30));
    expect(runner.pending).toBe(true);

    // stopRun with the fallback runId while runWorkflow is still pending.
    const t0 = Date.now();
    await service.stopRun(reservedFallbackId, "ESC cascade");
    expect(Date.now() - t0).toBeLessThan(3000);

    // runWorkflow should resolve with status=stopped.
    const result = await Promise.race([
      runPromise,
      new Promise<RunResult>((_, rej) =>
        setTimeout(() => rej(new Error("RUN_PROMISE_TIMEOUT")), 4000),
      ),
    ]);
    expect(result.status).toBe("stopped");

    // Wait a tick for the runner to react.
    await new Promise((r) => setTimeout(r, 50));
    expect(runner.pending).toBe(false);
  });

  it("F5: stopRun on parent A's workflow does NOT touch parent B's different workflow engine", async () => {
    const sessions = makeSessionComponent();
    const runnerA = makeCooperativeRunner();
    const runnerB = makeCooperativeRunner();
    const wfA = makeOneAgentWorkflow("workflow-A");
    const wfB = makeOneAgentWorkflow("workflow-B");
    const serviceA = makeService({ wf: wfA, sessionComponent: sessions, runners: [runnerA] });
    const serviceB = makeService({ wf: wfB, sessionComponent: sessions, runners: [runnerB] });

    const parentA = "session_parent_A";
    const parentB = "session_parent_B";
    const reservedA = `workflow_${Date.now()}_fallback_A`;
    const reservedB = `workflow_${Date.now()}_fallback_B`;

    await sessions.create({
      id: reservedA,
      title: `Workflow: A`,
      parentSessionId: parentA,
      metadata: { type: "workflow", runId: reservedA, workflowName: wfA.name, status: "running" },
    });
    await sessions.create({
      id: reservedB,
      title: `Workflow: B`,
      parentSessionId: parentB,
      metadata: { type: "workflow", runId: reservedB, workflowName: wfB.name, status: "running" },
    });

    const runA = serviceA.runWorkflow(wfA.name, {}, {
      parentSessionId: parentA,
      runId: reservedA,
    } as RunOptions);
    await new Promise((r) => setTimeout(r, 30));
    expect(runnerA.pending).toBe(true);

    const runB = serviceB.runWorkflow(wfB.name, {}, {
      parentSessionId: parentB,
      runId: reservedB,
    } as RunOptions);
    await new Promise((r) => setTimeout(r, 30));
    expect(runnerB.pending).toBe(true);

    await serviceA.stopRun(reservedA, "ESC A only");
    await new Promise((r) => setTimeout(r, 80));
    expect(runnerA.pending).toBe(false);
    // B's runner MUST remain running because B has a different engine instance.
    expect(runnerB.pending).toBe(true);

    await serviceB.stopRun(reservedB, "ESC B cleanup");
    await new Promise((r) => setTimeout(r, 80));
    expect(runnerB.pending).toBe(false);

    await Promise.allSettled([runA, runB]);
  });
});
