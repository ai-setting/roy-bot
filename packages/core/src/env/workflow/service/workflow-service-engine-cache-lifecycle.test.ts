/**
 * @fileoverview WorkflowService engine cache lifecycle (Task #2245 Codex P0-2)
 *
 * Verifies that engineInstances and sessionToEngine caches don't leak:
 *  - P0-2a: 100 runWorkflow calls produce 1 engine entry (workflowName-cached)
 *  - P0-2b: stopRun evicts sessionToEngine entry
 *  - P0-2c: dispose() clears both engineInstances and sessionToEngine
 *  - P0-2d: pruneStaleEngines() drops engines with empty activeSessions
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 */

import { describe, test, expect, beforeEach } from "bun:test";

import { WorkflowService } from "./workflow-service";
import { MockWorkflowRepository, MockWorkflowEngine } from "../storage/mock-repositories";

describe("P0-2: WorkflowService engine cache lifecycle (Task #2245)", () => {
  let engines: MockWorkflowEngine[];
  let svc: WorkflowService;

  beforeEach(() => {
    engines = [];
    const repo = new MockWorkflowRepository();
    const sessionStore = new Map<string, any>();

    const sessionComponent: any = {
      create: async (opts: any) => {
        const id = opts?.id ?? `wf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const session = {
          id,
          title: "wf",
          parentSessionId: null,
          metadata: opts?.metadata ?? { type: "workflow" },
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        sessionStore.set(id, session);
        return session;
      },
      get: async (id: string) => sessionStore.get(id) ?? null,
      list: async () => Array.from(sessionStore.values()),
      update: async (id: string, updates: { metadata?: any }): Promise<boolean> => {
        const prev = sessionStore.get(id);
        if (!prev) return false;
        sessionStore.set(id, {
          ...prev,
          metadata: updates.metadata ? { ...prev.metadata, ...updates.metadata } : prev.metadata,
          updatedAt: new Date(),
        });
        return true;
      },
      addMessage: async () => "msg_id",
      getMessages: async () => [],
    };

    const engineFactory = (_w: any) => {
      const e = new MockWorkflowEngine();
      // Ensure engine has activeSessions Map
      (e as any).activeSessions = (e as any).activeSessions ?? new Map();
      // Mock engine.runWorkflow should call sessionComponent.create
      (e as any).runWorkflow = async (workflow: any, options: any) => {
        const meta = {
          type: "workflow",
          workflowName: workflow?.name ?? "test",
          status: "running",
        };
        const created = await sessionComponent.create({ title: workflow?.name, metadata: meta });
        const sid = created.id;
        (e as any).activeSessions.set(sid, { id: sid, status: "running" });
        return { runId: sid, sessionId: sid };
      };
      (e as any).run = async (runId: string) => {
        (e as any).activeSessions.set(runId, { id: runId, status: "running" });
        return { runId, sessionId: runId, status: "running" };
      };
      engines.push(e);
      return e as any;
    };

    svc = new WorkflowService(repo, engineFactory, sessionComponent);
  });

  test("P0-2a: 100 runWorkflow 同 workflowName → 1 个 engine 实例（cache hit）", async () => {
    await svc.createWorkflow(
      {
        name: "test-wf-100",
        version: "1.0",
        description: "test",
        nodes: [{ id: "n1", type: "tool", config: { tool: "x" } }],
      } as any,
      { tags: ["test"] }
    );

    for (let i = 0; i < 100; i++) {
      await svc.runWorkflow("test-wf-100", {}, {} as any);
    }

    // All 100 sessions should reuse the same engine (cached by workflowName)
    expect(engines.length).toBe(1);
  });

  test("P0-2b: stopRun 后 sessionToEngine entry 被 evict", async () => {
    await svc.createWorkflow(
      {
        name: "test-wf-evict",
        version: "1.0",
        description: "test",
        nodes: [{ id: "n1", type: "tool", config: { tool: "x" } }],
      } as any,
      { tags: ["test"] }
    );
    const result = await svc.runWorkflow("test-wf-evict", {}, {} as any);
    const sessionId = result.sessionId;

    // Pre-condition: sessionToEngine has the entry
    expect((svc as any).sessionToEngine.has(sessionId)).toBe(true);

    await svc.stopRun(sessionId, "test stop");

    // Post-condition: entry evicted
    expect((svc as any).sessionToEngine.has(sessionId)).toBe(false);
  });

  test("P0-2c: dispose() 清空 engineInstances 和 sessionToEngine", async () => {
    await svc.createWorkflow(
      {
        name: "test-wf-dispose",
        version: "1.0",
        description: "test",
        nodes: [{ id: "n1", type: "tool", config: { tool: "x" } }],
      } as any,
      { tags: ["test"] }
    );
    await svc.runWorkflow("test-wf-dispose", {}, {} as any);

    expect((svc as any).engineInstances.size).toBeGreaterThan(0);

    await svc.dispose();

    expect((svc as any).engineInstances.size).toBe(0);
    expect((svc as any).sessionToEngine.size).toBe(0);
  });

  test("P0-2d: pruneStaleEngines() 删除 activeSessions 为空的 entry", async () => {
    await svc.createWorkflow(
      {
        name: "test-wf-prune",
        version: "1.0",
        description: "test",
        nodes: [{ id: "n1", type: "tool", config: { tool: "x" } }],
      } as any,
      { tags: ["test"] }
    );
    await svc.runWorkflow("test-wf-prune", {}, {} as any);

    // Manually clear engine's activeSessions
    engines[0].activeSessions.clear();

    // Call prune
    (svc as any).pruneStaleEngines();

    expect((svc as any).engineInstances.has("test-wf-prune")).toBe(false);
  });
});
