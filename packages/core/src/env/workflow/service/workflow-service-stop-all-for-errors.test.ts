/**
 * @fileoverview WorkflowService.stopAllForParent errors array (Task #2245 P1-#7/#11)
 *
 * P1-#7: stopAllForParent returns errors array in addition to stoppedSessionIds
 * P1-#11: stopRun cascade error injection test (stopRun throws → stopAllForParent
 *         captures per-item error in returned errors array)
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

describe("P1-#7: WorkflowService.stopAllForParent returns errors (Task #2245)", () => {
  let stopRunCalls: Array<{ runId: string; reason: string }>;
  let sessions: MockSession[];
  let svc: WorkflowService;

  beforeEach(() => {
    stopRunCalls = [];
    sessions = [];
    const sessionComponent: any = {
      create: async () => ({ id: "ignored" }),
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

    const engineFactory: any = (_workflow: any) => ({
      run: async () => ({ runId: "wf", sessionId: "wf", status: "running" as const }),
      runWorkflow: async () => ({ runId: "wf", sessionId: "wf" }),
      stop: async (runId: string) => {
        // Some sessions fail to stop
        if (runId === "wf_fail") {
          throw new Error("simulated stopRun failure for wf_fail");
        }
        stopRunCalls.push({ runId, reason: "ESC cascade stop" });
      },
      pause: async () => {},
      resume: async () => ({ runId: "", sessionId: "" }),
      activeSessions: new Map(),
    });

    const repo = {
      createWorkflow: async (w: any) => ({ ...w, id: "wf" }),
      getWorkflow: async () => null,
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

    svc = new WorkflowService(repo, engineFactory, sessionComponent as any);
  });

  test("P1-7a: stopAllForParent 返回 { stoppedSessionIds, errors } schema（errors 字段存在）", async () => {
    const result = await svc.stopAllForParent("p1");
    expect(result).toHaveProperty("stoppedSessionIds");
    expect(result).toHaveProperty("errors");
    expect(Array.isArray(result.stoppedSessionIds)).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
  });

  test("P1-11: stopRun throws → stopAllForParent 捕获到 errors 数组", async () => {
    // Two sessions, one fails stopRun
    sessions.push({
      id: "wf_ok",
      parentSessionId: "p1",
      metadata: { type: "workflow", workflowName: "test-wf", status: "running" },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    sessions.push({
      id: "wf_fail",
      parentSessionId: "p1",
      metadata: { type: "workflow", workflowName: "test-wf", status: "running" },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await svc.stopAllForParent("p1");

    // wf_ok stopped, wf_fail captured in errors
    expect(result.stoppedSessionIds).toContain("wf_ok");
    expect(result.stoppedSessionIds).not.toContain("wf_fail");
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].sessionId).toBe("wf_fail");
    expect(result.errors[0].error).toMatch(/simulated stopRun failure/);
  });

  test("P1-7b: 所有 stopRun 都成功时 errors 数组为空", async () => {
    sessions.push({
      id: "wf_a",
      parentSessionId: "p1",
      metadata: { type: "workflow", workflowName: "test-wf", status: "running" },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await svc.stopAllForParent("p1");

    expect(result.stoppedSessionIds).toEqual(["wf_a"]);
    expect(result.errors).toEqual([]);
  });
});
