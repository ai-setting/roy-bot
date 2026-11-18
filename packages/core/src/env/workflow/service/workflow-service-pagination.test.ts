/**
 * @fileoverview Codex P1-2: paginated session fetch (Task #2245)
 *
 * Verifies that stopAllForParent and forceStopAll handle > 1000
 * workflow sessions without silently dropping the tail.
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 */

import { describe, test, expect, beforeEach } from "bun:test";

import { WorkflowService } from "./workflow-service";
import { MockWorkflowRepository, MockWorkflowEngine } from "../storage/mock-repositories";

interface MockSession {
  id: string;
  title: string;
  parentSessionId: string | null;
  metadata: any;
  createdAt: Date;
  updatedAt: Date;
}

describe("Codex P1-2: paginated session fetch (Task #2245)", () => {
  let sessions: MockSession[];
  let stopRunCalls: string[];
  let sessionComponent: any;
  let svc: WorkflowService;

  beforeEach(() => {
    sessions = [];
    stopRunCalls = [];
    const repo = new MockWorkflowRepository();

    sessionComponent = {
      create: async (opts: any) => {
        const id = opts?.id ?? `wf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const s: MockSession = {
          id,
          title: opts?.title ?? "wf",
          parentSessionId: opts?.parentSessionId ?? null,
          metadata: opts?.metadata ?? { type: "workflow" },
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        sessions.push(s);
        return s;
      },
      get: async (id: string) => sessions.find((s) => s.id === id) ?? null,
      // Simulate a real DB that respects limit/offset
      list: async (options?: { limit?: number; offset?: number }) => {
        const limit = options?.limit ?? 100;
        const offset = options?.offset ?? 0;
        return sessions.slice(offset, offset + limit);
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

    const engineFactory = (_w: any) => {
      const e = new MockWorkflowEngine();
      (e as any).activeSessions = new Map();
      (e as any).runWorkflow = async () => {
        const sid = `wf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        (e as any).activeSessions.set(sid, { id: sid, status: "running" });
        return { runId: sid, sessionId: sid };
      };
      (e as any).stop = async (sessionId: string) => {
        stopRunCalls.push(sessionId);
        (e as any).activeSessions.delete(sessionId);
      };
      return e as any;
    };

    svc = new WorkflowService(repo, engineFactory, sessionComponent);
  });

  test("Codex P1-2a: stopAllForParent 处理 > 1000 个 session（不分页会漏掉）", async () => {
    // Pre-populate 1500 sessions with parentId="p1" and status=running
    for (let i = 0; i < 1500; i++) {
      await sessionComponent.create({
        id: `wf_paginated_${i}`,
        title: `wf_${i}`,
        parentSessionId: "p1",
        metadata: { type: "workflow", workflowName: "test-wf", status: "running" },
      });
    }

    await svc.createWorkflow(
      {
        name: "test-wf",
        version: "1.0",
        description: "test",
        nodes: [{ id: "n1", type: "tool", config: { tool: "x" } }],
      } as any,
      { tags: ["test"] }
    );

    const result = await svc.stopAllForParent("p1");

    // All 1500 sessions should be stopped
    // (Without pagination, only the first 1000 would be returned)
    expect(result.stoppedSessionIds.length).toBe(1500);
  });

  test("Codex P1-2b: forceStopAll 处理 > 1000 个 session", async () => {
    for (let i = 0; i < 1500; i++) {
      await sessionComponent.create({
        id: `wf_force_paginated_${i}`,
        title: `wf_${i}`,
        parentSessionId: "p_diff",
        metadata: { type: "workflow", workflowName: "test-wf", status: "running" },
      });
    }

    const result = await svc.forceStopAll();

    // 1500 sessions should be marked stopped
    const runningCount = sessions.filter(
      (s) => s.metadata?.status === "running"
    ).length;
    expect(runningCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Codex P1-1: forceStopAll evicts engineInstances cache entries
// ---------------------------------------------------------------------------

describe("Codex P1-1: forceStopAll evicts engine cache (Task #2245)", () => {
  let sessions: any[];
  let stopRunCalls: string[];
  let sessionComponent: any;
  let svc: WorkflowService;

  beforeEach(() => {
    sessions = [];
    stopRunCalls = [];
    const repo = new MockWorkflowRepository();

    sessionComponent = {
      create: async (opts: any) => {
        const id = opts?.id ?? `wf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const s = {
          id,
          title: opts?.title ?? "wf",
          parentSessionId: opts?.parentSessionId ?? null,
          metadata: opts?.metadata ?? { type: "workflow" },
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        sessions.push(s);
        return s;
      },
      get: async (id: string) => sessions.find((s) => s.id === id) ?? null,
      list: async (options?: { limit?: number; offset?: number }) => {
        const limit = options?.limit ?? 100;
        const offset = options?.offset ?? 0;
        return sessions.slice(offset, offset + limit);
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

    const engineFactory = (_w: any) => {
      const e = new MockWorkflowEngine();
      (e as any).activeSessions = new Map();
      (e as any).runWorkflow = async () => {
        const sid = `wf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        (e as any).activeSessions.set(sid, { id: sid, status: "running" });
        return { runId: sid, sessionId: sid };
      };
      (e as any).stop = async (sessionId: string) => {
        stopRunCalls.push(sessionId);
        (e as any).activeSessions.delete(sessionId);
      };
      return e as any;
    };

    svc = new WorkflowService(repo, engineFactory, sessionComponent);
  });

  test("Codex P1-1a: forceStopAll 后 sessionToEngine cache 不残留", async () => {
    await svc.createWorkflow(
      {
        name: "test-wf-p1-1",
        version: "1.0",
        description: "test",
        nodes: [{ id: "n1", type: "tool", config: { tool: "x" } }],
      } as any,
      { tags: ["test"] }
    );

    // Run a workflow so engineInstances + sessionToEngine are populated
    const result = await svc.runWorkflow("test-wf-p1-1", {}, {} as any);
    const sid = result.sessionId;

    // Pre-condition: cache populated
    expect((svc as any).sessionToEngine.has(sid)).toBe(true);
    expect((svc as any).engineInstances.size).toBe(1);

    // Manually inject this session into the sessionComponent so
    // forceStopAll's list filter (status=running) picks it up.
    // (The mock engine doesn't create a DB session, so we patch it in.)
    await sessionComponent.create({
      id: sid,
      title: "test-wf-p1-1",
      parentSessionId: null,
      metadata: {
        type: "workflow",
        workflowName: "test-wf-p1-1",
        status: "running",
      },
    });

    await svc.forceStopAll();

    // After forceStopAll, the session should NOT still be in cache
    // (avoids DB/engine drift where DB says stopped but cache says active)
    expect((svc as any).sessionToEngine.has(sid)).toBe(false);
  });
});
