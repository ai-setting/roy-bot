/**
 * @fileoverview WorkflowService.stopAllForParent + forceStopAll TDD tests (Task #2245)
 *
 * 验证 ESC cascade:
 * - stopAllForParent(parentA) 只 stopRun A 的 workflow session，不动 B
 * - forceStopAll() 跨 parent 强 mark 所有 running/paused workflow session 为 stopped
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 */

import { describe, test, expect, beforeEach } from "bun:test";

import { WorkflowService, type SessionInfo, type WorkflowSessionMetadata } from "./workflow-service";
import { MockWorkflowRepository, MockWorkflowEngine } from "../storage/mock-repositories";
import type { Workflow } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mock session list — captures parentSessionId at the Session level (Task #1739)
 * and stores type/workflowName/status in metadata.
 */
interface MockSession extends SessionInfo {
  parentSessionId?: string | null;
}

function buildSession(opts: {
  id: string;
  title?: string;
  parentSessionId?: string | null;
  type: "workflow";
  workflowName: string;
  status: WorkflowSessionMetadata["status"];
}): MockSession {
  const now = new Date();
  return {
    id: opts.id,
    title: opts.title ?? opts.id,
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

function buildWorkflowServiceWithMock(opts: {
  sessions?: MockSession[];
  engineStopCalls?: Array<{ sessionId: string; reason?: string }>;
  workflowName?: string;
}): {
  svc: WorkflowService;
  sessions: MockSession[];
  engineStopCalls: Array<{ sessionId: string; reason?: string }>;
} {
  const sessions = opts.sessions ?? [];
  const engineStopCalls = opts.engineStopCalls ?? [];
  const repo = new MockWorkflowRepository();
  const workflowName = opts.workflowName ?? "test-wf";

  // Pre-register workflow via service.createWorkflow so config/metadata defaults
  // (maxIterations, loopEnabled, tags) are populated correctly per the Workflow
  // schema. Otherwise MockWorkflowRepository.create() requires fully-typed fields.
  const mockEngine = new MockWorkflowEngine();
  const engineFactory = (_workflow: Workflow, _opts?: any) => mockEngine as any;
  // Hijack engine.stop to record calls
  const originalStop = (mockEngine as any).stop?.bind(mockEngine);
  (mockEngine as any).stop = async (sessionId: string, reason?: string) => {
    engineStopCalls.push({ sessionId, reason });
    if (typeof originalStop === "function") {
      try {
        await originalStop(sessionId, reason);
      } catch (_) {}
    }
  };

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

  // Async pre-register; we'll let tests `await built.ready` before exercising
  // stopRun/stopAllForParent paths that need a workflow lookup.
  const ready = svc.createWorkflow(
    {
      name: workflowName,
      version: "1.0",
      description: "test",
      nodes: [
        {
          id: "node1",
          type: "tool",
          config: { tool: "test-tool" },
        },
      ],
    },
    { tags: ["test"] },
  );

  return {
    get ready() {
      // expose promise to await when needed
      return ready;
    },
    svc,
    sessions,
    engineStopCalls,
  } as any;
}

// ---------------------------------------------------------------------------
// AC-2: stopAllForParent(parentSessionId) tests
// ---------------------------------------------------------------------------

describe("WorkflowService.stopAllForParent (Task #2245 ESC cascade)", () => {
  let sessions: MockSession[];
  let svc: WorkflowService;
  let engineStopCalls: Array<{ sessionId: string; reason?: string }>;

  beforeEach(() => {
    sessions = [
      buildSession({
        id: "wf_a1",
        parentSessionId: "parentA",
        type: "workflow",
        workflowName: "test-wf",
        status: "running",
      }),
      buildSession({
        id: "wf_a2",
        parentSessionId: "parentA",
        type: "workflow",
        workflowName: "test-wf",
        status: "paused",
      }),
      buildSession({
        id: "wf_b1",
        parentSessionId: "parentB",
        type: "workflow",
        workflowName: "test-wf",
        status: "running",
      }),
    ];
    const built = buildWorkflowServiceWithMock({ sessions });
    svc = built.svc;
    engineStopCalls = built.engineStopCalls;
  });

  test("AC-2a: stopAllForParent(parentA) 只 stopRun A 的 workflow session，不动 B", async () => {
    const result = await svc.stopAllForParent("parentA");

    expect(result.stoppedSessionIds).toEqual(expect.arrayContaining(["wf_a1", "wf_a2"]));
    expect(result.stoppedSessionIds).not.toContain("wf_b1");
    // engine.stop 收到 A 的两个 id，未收到 B 的
    expect(engineStopCalls.map((c) => c.sessionId)).toEqual(
      expect.arrayContaining(["wf_a1", "wf_a2"]),
    );
    expect(engineStopCalls.find((c) => c.sessionId === "wf_b1")).toBeUndefined();
  });

  test("AC-2b: stopAllForParent(unknownParent) 返回空数组", async () => {
    const result = await svc.stopAllForParent("unknownParent");

    expect(result.stoppedSessionIds).toEqual([]);
    expect(engineStopCalls).toHaveLength(0);
  });

  test("AC-2c: 已 completed 的 workflow session 被 stopAllForParent 跳过", async () => {
    // 替换一个为 completed
    sessions[0].metadata.status = "completed";
    sessions[0].id = "wf_a_done";

    const result = await svc.stopAllForParent("parentA");

    expect(result.stoppedSessionIds).not.toContain("wf_a_done");
    expect(result.stoppedSessionIds).toEqual(["wf_a2"]);
  });
});

// ---------------------------------------------------------------------------
// AC-5: forceStopAll() tests
// ---------------------------------------------------------------------------

describe("WorkflowService.forceStopAll (Task #2245 ESC force cascade)", () => {
  let sessions: MockSession[];
  let svc: WorkflowService;

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
      buildSession({
        id: "wf_done",
        parentSessionId: "pA",
        type: "workflow",
        workflowName: "test-wf",
        status: "completed",
      }),
    ];
    const built = buildWorkflowServiceWithMock({ sessions });
    svc = built.svc;
  });

  test("AC-5a: forceStopAll mark all running/paused workflow sessions stopped (regardless of parent)", async () => {
    await svc.forceStopAll();

    expect(sessions.find((s) => s.id === "wf_a")?.metadata.status).toBe("stopped");
    expect(sessions.find((s) => s.id === "wf_b")?.metadata.status).toBe("stopped");
    // completed 不变
    expect(sessions.find((s) => s.id === "wf_done")?.metadata.status).toBe("completed");
  });

  test("AC-5b: forceStopAll 对空 session 列表无副作用", async () => {
    const emptyBuilt = buildWorkflowServiceWithMock({ sessions: [] });
    await expect(emptyBuilt.svc.forceStopAll()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Task #2245 — Code review back-edge (Step 4.0.4.b): same-engine guarantee
// ---------------------------------------------------------------------------

/**
 * BL-1 — `WorkflowService.stopRun(sessionId)` must operate on the SAME
 * `WorkflowEngine` instance that `runWorkflow()` created. Otherwise the running
 * engine's `activeSessions` map doesn't contain the session, and the stop call
 * only updates the database without aborting the in-flight execution.
 *
 * Construct a custom engineFactory that returns a fresh engine every call,
 * with each engine tracking its own stop calls. The test then verifies that
 * after `runWorkflow()` and `stopRun()` the SAME engine instance received
 * the stop call.
 */
describe("WorkflowService engine instance caching (Task #2245 BL-1)", () => {
  test("BL-1: stopRun 操作的 engine 与 runWorkflow 创建的 engine 是同一实例", async () => {
    const sessions: MockSession[] = [];
    const engines: any[] = []; // Track all engine instances ever created

    const sessionComponent = {
      create: async (opts: any) => {
        const id = opts?.id ?? `wf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const now = new Date();
        const sess: MockSession = {
          id,
          title: opts.title || "wf",
          parentSessionId: opts.metadata?.parentSessionId ?? null,
          metadata: opts.metadata,
          createdAt: now,
          updatedAt: now,
        };
        sessions.push(sess);
        return { id };
      },
      get: async (id: string) => sessions.find((s) => s.id === id) ?? null,
      list: async (opts?: { limit?: number; offset?: number }) => {
        let out = [...sessions];
        if (opts?.offset) out = out.slice(opts.offset);
        if (opts?.limit) out = out.slice(0, opts.limit);
        return out;
      },
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

    // Build a fake engine that tracks its own stop() calls AND creates sessions via sessionComponent
    function makeFakeEngine() {
      const stopCalls: string[] = [];
      const instance: any = {
        runWorkflow: async (_workflow: any, _opts: any) => {
          // Simulate the engine calling sessionComponent.create() like a real engine
          const id = "wf_test_001";
          const now = new Date();
          const existing = sessions.find((s) => s.id === id);
          if (!existing && sessionComponent.create) {
            const meta = { type: "workflow", workflowName: "test-wf-bl1", status: "running" };
            const created = await sessionComponent.create({ id, title: "wf", metadata: meta });
            // Also push to local list
            const sess: MockSession = {
              id: created.id,
              title: "wf",
              parentSessionId: null,
              metadata: meta,
              createdAt: now,
              updatedAt: now,
            };
            sessions.push(sess);
          }
          return { runId: id, sessionId: id };
        },
        stop: async (sessionId: string, _reason?: string) => {
          stopCalls.push(sessionId);
        },
        pause: async () => {},
        resume: async () => ({ runId: "", sessionId: "" }),
        activeSessions: new Map(),
        stopCalls,
      };
      engines.push(instance);
      return instance;
    }

    const repo = new MockWorkflowRepository();
    const engineFactory = (_workflow: any, _opts?: any) => {
      const eng = makeFakeEngine();
      return eng;
    };

    const svc = new WorkflowService(repo, engineFactory, sessionComponent);

    // Pre-create workflow
    await svc.createWorkflow(
      {
        name: "test-wf-bl1",
        version: "1.0",
        description: "test",
        nodes: [{ id: "n1", type: "tool", config: { tool: "x" } }],
      },
      { tags: ["test"] },
    );

    // Run workflow — this creates engine #0
    await svc.runWorkflow("test-wf-bl1", {}, {} as any);
    expect(engines).toHaveLength(1);

    // Stop run — should NOT create a new engine, should reuse engine #0
    await svc.stopRun("wf_test_001", "test stop");

    // Critical: only ONE engine ever created (cache hit)
    expect(engines).toHaveLength(1);
    // The (only) engine received the stop call
    expect(engines[0].stopCalls).toContain("wf_test_001");
  });
});