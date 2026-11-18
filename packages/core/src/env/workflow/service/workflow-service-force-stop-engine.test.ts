/**
 * @fileoverview P0-1 RED test: WorkflowService.forceStopAll must actually
 * call `engine.stop()` for in-flight workflow sessions (not just update DB).
 *
 * Task #2265 (dual-model review) — both Codex and Claude independently
 * flagged this as P0 blocking. The current `forceStopAll()` only updates
 * the database row and evicts cache; it does NOT invoke the running
 * engine's `stop()` method. The engine's `abortController` is never
 * triggered, so LLM calls / agentNode children / nested workflows
 * continue running. The DB shows "stopped" but the engine is still live.
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 */

import { describe, test, expect, beforeEach } from "bun:test";

import { WorkflowService, type SessionInfo, type WorkflowSessionMetadata } from "./workflow-service";
import { MockWorkflowRepository, MockWorkflowEngine } from "../storage/mock-repositories";
import type { Workflow } from "../types";

// ---------------------------------------------------------------------------
// Mock session shape (matches Task #2245 test conventions)
// ---------------------------------------------------------------------------

interface MockSession extends SessionInfo {
  parentSessionId?: string | null;
}

function buildSession(opts: {
  id: string;
  parentSessionId?: string | null;
  type: "workflow";
  workflowName: string;
  status: WorkflowSessionMetadata["status"];
}): MockSession {
  const now = new Date();
  return {
    id: opts.id,
    title: opts.id,
    parentSessionId: opts.parentSessionId ?? null,
    metadata: {
      type: opts.type,
      workflowName: opts.workflowName,
      status: opts.status,
    },
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Build a WorkflowService backed by mock storage + mock engine.
 * The engine exposes a public `stop` we can hijack to record call
 * arguments; we also expose a way to push entries into the engine's
 * `activeSessions` map (so we can simulate a "live" engine that holds
 * an in-flight session).
 */
function buildWorkflowServiceWithEngineTracking(opts: {
  sessions: MockSession[];
  workflowName?: string;
}): {
  svc: WorkflowService;
  sessions: MockSession[];
  engineStopCalls: Array<{ sessionId: string; reason?: string }>;
  mockEngine: MockWorkflowEngine;
  // Helper to register a sessionId into the engine's `activeSessions` map,
  // simulating "this engine is the one currently running the session".
  registerActiveOnEngine: (sessionId: string) => void;
} {
  const engineStopCalls: Array<{ sessionId: string; reason?: string }> = [];
  const repo = new MockWorkflowRepository();
  const workflowName = opts.workflowName ?? "test-wf";
  const mockEngine = new MockWorkflowEngine();
  // Hijack engine.stop to record calls
  const originalStop = (mockEngine as any).stop?.bind(mockEngine);
  (mockEngine as any).stop = async (sessionId: string, reason?: string) => {
    engineStopCalls.push({ sessionId, reason });
    if (typeof originalStop === "function") {
      try { await originalStop(sessionId, reason); } catch (_e) { /* ignore */ }
    }
  };

  const engineFactory = (_workflow: Workflow, _opts?: any) => mockEngine as any;

  const sessions = opts.sessions;
  const sessionComponent = {
    create: async (_opts: any) => ({ id: "created" }),
    get: async (id: string) => sessions.find((s) => s.id === id) ?? null,
    list: async (listOpts?: { limit?: number; offset?: number }) => {
      let out = [...sessions];
      if (listOpts?.offset) out = out.slice(listOpts.offset);
      if (listOpts?.limit) out = out.slice(0, listOpts.limit);
      return out;
    },
    update: async (id: string, updates: { metadata?: any }): Promise<boolean> => {
      const idx = sessions.findIndex((s) => s.id === id);
      if (idx === -1) return false;
      const prev = sessions[idx];
      const merged: MockSession = {
        ...prev,
        metadata: updates.metadata
          ? { ...prev.metadata, ...updates.metadata }
          : prev.metadata,
        updatedAt: new Date(),
      };
      sessions[idx] = merged;
      return true;
    },
    addMessage: async (_id: string, _msg: any) => "msg_id",
    getMessages: async (_id: string) => [],
  };

  const svc = new WorkflowService(repo, engineFactory, sessionComponent);

  const registerActiveOnEngine = (sessionId: string) => {
    // MockWorkflowEngine has an `activeSessions` Map; populate it directly.
    // (We treat the mock engine the same way the real WorkflowEngine behaves:
    // when `runWorkflow` is called, it inserts the new sessionId into
    // `activeSessions`.)
    const anyEngine = mockEngine as any;
    if (!anyEngine.activeSessions) anyEngine.activeSessions = new Map();
    anyEngine.activeSessions.set(sessionId, { status: "running" });
    // ALSO inject the engine into the service's internal cache so
    // sessionToEngine lookup finds the engine (mirrors what
    // `runWorkflow()` would do after returning).
    (svc as any).engineInstances.set(workflowName, mockEngine);
    (svc as any).sessionToEngine.set(sessionId, mockEngine);
  };

  return { svc, sessions, engineStopCalls, mockEngine, registerActiveOnEngine };
}

// ---------------------------------------------------------------------------
// P0-1 RED tests
// ---------------------------------------------------------------------------

describe("P0-1: WorkflowService.forceStopAll must invoke engine.stop() (Task #2265)", () => {
  let sessions: MockSession[];
  let svc: WorkflowService;
  let engineStopCalls: Array<{ sessionId: string; reason?: string }>;
  let registerActiveOnEngine: (sessionId: string) => void;
  let mockEngine: any;

  beforeEach(() => {
    sessions = [
      buildSession({
        id: "wf_a",
        parentSessionId: "pA",
        type: "workflow",
        workflowName: "test-wf",
        status: "running",
      }),
      buildSession({
        id: "wf_b",
        parentSessionId: "pB",
        type: "workflow",
        workflowName: "test-wf",
        status: "running",
      }),
    ];
    const built = buildWorkflowServiceWithEngineTracking({ sessions });
    svc = built.svc;
    engineStopCalls = built.engineStopCalls;
    registerActiveOnEngine = built.registerActiveOnEngine;
    mockEngine = built.mockEngine;
  });

  test("P0-1.a: forceStopAll calls engine.stop() for each running session", async () => {
    // Register both sessions as live on the cached engine.
    registerActiveOnEngine("wf_a");
    registerActiveOnEngine("wf_b");

    await svc.forceStopAll();

    // engine.stop must have been called for each session — NOT just DB updated.
    const stoppedIds = engineStopCalls.map((c) => c.sessionId);
    expect(stoppedIds).toEqual(expect.arrayContaining(["wf_a", "wf_b"]));
    // DB still marked stopped (regression check on existing behavior).
    expect(sessions.find((s) => s.id === "wf_a")?.metadata.status).toBe("stopped");
    expect(sessions.find((s) => s.id === "wf_b")?.metadata.status).toBe("stopped");
  });

  test("P0-1.b: forceStopAll evicts engine.activeSessions entry for stopped session", async () => {
    registerActiveOnEngine("wf_a");
    registerActiveOnEngine("wf_b");

    await svc.forceStopAll();

    // After forceStopAll, the engine's activeSessions map should no longer
    // contain the stopped sessionIds (proves engine.stop() actually ran the
    // cleanup path, not just DB update). Access the mock engine directly
    // since pruneStaleEngines() may have evicted it from engineInstances.
    expect(mockEngine.activeSessions).toBeDefined();
    expect(mockEngine.activeSessions.has("wf_a")).toBe(false);
    expect(mockEngine.activeSessions.has("wf_b")).toBe(false);
  });

  test("P0-1.c: forceStopAll passes a force-related reason to engine.stop()", async () => {
    registerActiveOnEngine("wf_a");

    await svc.forceStopAll();

    const stopCall = engineStopCalls.find((c) => c.sessionId === "wf_a");
    expect(stopCall).toBeDefined();
    expect(stopCall?.reason).toBeDefined();
    // Reason should mention "force" so logs can distinguish from graceful.
    expect(String(stopCall?.reason).toLowerCase()).toContain("force");
  });

  test("P0-1.d: forceStopAll continues for other sessions when engine.stop throws for one", async () => {
    registerActiveOnEngine("wf_a");
    registerActiveOnEngine("wf_b");
    // Make engine.stop throw ONLY for wf_a (call order is the listing order)
    const originalStop = (svc as any).engineInstances.get("test-wf").stop;
    (svc as any).engineInstances.get("test-wf").stop = async (sid: string, reason?: string) => {
      if (sid === "wf_a") throw new Error("simulated engine.stop failure");
      return originalStop(sid, reason);
    };

    await svc.forceStopAll();

    // Both should still be marked stopped in DB (no swallow, no abort entire force).
    expect(sessions.find((s) => s.id === "wf_a")?.metadata.status).toBe("stopped");
    expect(sessions.find((s) => s.id === "wf_b")?.metadata.status).toBe("stopped");
    // wf_b should still have its engine.stop called.
    expect(engineStopCalls.find((c) => c.sessionId === "wf_b")).toBeDefined();
  });

  test("P0-1.e: forceStopAll is safe when engine is not cached (DB-only mark still works)", async () => {
    // No registerActiveOnEngine — engine is NOT in sessionToEngine cache.
    await svc.forceStopAll();

    // DB still marked stopped (regression on the existing DB-mark path).
    expect(sessions.find((s) => s.id === "wf_a")?.metadata.status).toBe("stopped");
    expect(sessions.find((s) => s.id === "wf_b")?.metadata.status).toBe("stopped");
    // engine.stop not called (no engine to call).
    expect(engineStopCalls).toHaveLength(0);
  });
});
