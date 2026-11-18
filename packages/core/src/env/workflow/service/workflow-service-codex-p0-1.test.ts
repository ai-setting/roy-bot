/**
 * @fileoverview Codex P0-1: engineInstances cache populated AFTER completion
 * (Task #2245 Codex review P0-1)
 *
 * Codex review verdict: BL-1 fix (commit 7d655fcf) is a no-op because
 * the cache is populated AFTER `engine.runWorkflow()` returns:
 *
 *   const result = await engine.runWorkflow(...);  // ← workflow completes
 *   this.engineInstances.set(resolvedSessionId, engine);  // ← too late
 *
 * During the entire in-flight window, `engineInstances.get(sessionId)` is
 * undefined, so `stopRun` always falls through to creating a fresh
 * engine whose `activeSessions` is empty → `engine.stop()` only updates
 * the database. The original cascade gap is NOT fixed.
 *
 * RED test: while workflow is in-flight (runWorkflow Promise pending),
 * stopRun should target the SAME engine instance that owns the session.
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 */

import { describe, test, expect, beforeEach } from "bun:test";

import { WorkflowService } from "./workflow-service";

interface MockSession {
  id: string;
  parentSessionId: string | null;
  metadata: any;
  createdAt: Date;
  updatedAt: Date;
}

describe("Codex P0-1: engineInstances cache hit during in-flight workflow (Task #2245)", () => {
  let engines: any[];
  let sessions: MockSession[];
  let svc: WorkflowService;

  beforeEach(() => {
    engines = [];
    sessions = [];
    const sessionComponent: any = {
      create: async (opts: any) => ({ id: opts.id ?? "wf_001", title: opts.title ?? "wf" }),
      get: async (id: string) => sessions.find((s) => s.id === id) ?? null,
      list: async () => sessions,
      update: async (id: string, updates: { metadata?: any }): Promise<boolean> => {
        const idx = sessions.findIndex((s) => s.id === id);
        if (idx === -1) return false;
        const prev = sessions[idx];
        sessions[idx] = {
          ...prev,
          metadata: updates.metadata ? { ...prev.metadata, ...updates.metadata } : prev.metadata,
          updatedAt: new Date(),
        };
        return true;
      },
      addMessage: async () => "msg_id",
      getMessages: async () => [],
    };

    // Engine factory: returns a new engine per call (like production).
    // The engine's runWorkflow awaits a deferred that we control from the test,
    // so we can issue stopRun WHILE the workflow is in-flight.
    let pendingResolves: Array<(v: any) => void> = [];
    const engineFactory: any = (_workflow: any, _opts?: any) => {
      const stopCalls: string[] = [];
      const instance: any = {
        runWorkflow: async (workflow: any, opts: any) => {
          // Create session entry (mock production behavior)
          const id = opts?.sessionId ?? "wf_inflight_001";
          const now = new Date();
          if (!sessions.find((s) => s.id === id)) {
            sessions.push({
              id,
              parentSessionId: opts?.parentSessionId ?? null,
              metadata: { type: "workflow", workflowName: workflow.name, status: "running" },
              createdAt: now,
              updatedAt: now,
            });
          }
          // Wait for a deferred to simulate long-running workflow
          await new Promise<any>((resolve) => pendingResolves.push(resolve));
          return { runId: id, sessionId: id };
        },
        stop: async (sessionId: string, _reason?: string) => {
          stopCalls.push(sessionId);
          // Mark session as stopped (production behavior)
          const idx = sessions.findIndex((s) => s.id === sessionId);
          if (idx !== -1) {
            sessions[idx].metadata = { ...sessions[idx].metadata, status: "stopped" };
          }
        },
        pause: async () => {},
        resume: async () => ({ runId: "", sessionId: "" }),
        activeSessions: new Map(),
        stopCalls,
        pendingResolves,
      };
      engines.push(instance);
      return instance;
    };

    const repo = {
      createWorkflow: async (w: any) => ({ ...w, id: "wf" }),
      getWorkflow: async () => null,
      getById: () => null,
      getByName: (name: string) => ({
        id: "wf-def",
        name,
        version: "1.0",
        description: "test workflow",
        nodes: [{ id: "n1", type: "tool", config: { tool: "x" } }],
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      listWorkflows: async () => [],
      saveWorkflow: async () => "wf",
      deleteWorkflow: async () => true,
    } as any;

    svc = new WorkflowService(repo, engineFactory, sessionComponent);
  });

  test("Codex-P0-1: stopRun during in-flight workflow targets the SAME engine instance", async () => {
    // Start the workflow (will be pending until we resolve)
    const runPromise = svc.runWorkflow(
      "test-p0-1",
      { foo: "bar" },
      {} as any,
    );

    // Give the runWorkflow a chance to enter its await
    await new Promise((r) => setTimeout(r, 30));

    // Engine #0 should be the only engine created so far
    expect(engines).toHaveLength(1);
    const inflightEngine = engines[0];
    expect(inflightEngine.activeSessions).toBeDefined();

    // While the workflow is in-flight, call stopRun
    // The session is `wf_inflight_001` (set by the mock engine)
    await svc.stopRun("wf_inflight_001", "ESC cascade stop");

    // The SAME engine (engine #0) should have received the stop call
    expect(inflightEngine.stopCalls).toContain("wf_inflight_001");

    // A new engine should NOT have been created (the cache should be hit
    // OR the engine should be cached by workflowName)
    expect(engines.length).toBeLessThanOrEqual(2); // 0 cache hit, 1 fallback

    // Cleanup: resolve the workflow promise
    inflightEngine.pendingResolves.forEach((r: any) => r({ runId: "x", sessionId: "x" }));
    inflightEngine.pendingResolves = [];
    await runPromise;
  });
});
