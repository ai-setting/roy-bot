/**
 * @fileoverview BackgroundTaskManager workflow propagation TDD tests (Task #2144)
 *
 * 验证 stop_task 停 sub-session 时，它启动的所有 workflow_run 也跟着 stop：
 * 1. AC-1: stop_task 触发 workflowService.stopRun 传播
 * 2. AC-2: 单 sub-session 多个 workflow_run 全部 stop
 * 3. AC-3a: workflow 已完成后 stop_task 不报错（幂等）
 * 4. AC-3b: workflow 启动后手动 detach，stop_task 不重复 stop
 * 5. AC-4: 隔离 — 不同 bgTask 的 workflow 互不影响
 * 6. AC-9: @TracedAs 装饰器不破坏 stopTask 调用
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 */

import { describe, test, expect, beforeEach } from "bun:test";

import { BackgroundTaskManager } from "./delegate-tool";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockEnv {
  handle_query: (...args: any[]) => Promise<string>;
  getComponent: (name: string) => any;
  publishEvent?: any;
  pushEnvEvent?: any;
  [key: string]: any;
}

function buildMockEnv(opts: {
  /**
   * Default: block until released (so createTask → executeTask stays in "running"
   * state until the test calls `release()`). This lets tests safely attach
   * workflow runs after createTask returns.
   */
  blockHandleQuery?: boolean;
} = {}): { env: MockEnv; release: () => void } {
  let releaseFn: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });

  const subSession = {
    id: "sub_session_1",
    info: { metadata: { subagent_type: "general", task_description: "mock" } },
  };
  const parentSession = {
    id: "parent_session_1",
    info: { metadata: {} },
  };

  const env: MockEnv = {
    handle_query: opts.blockHandleQuery === false
      ? async () => "done"
      : async () => {
          await released;
          return "done";
        },
    getComponent: (name: string) => {
      if (name === "session") {
        return {
          get: async (id: string) => (id === "sub_session_1" ? subSession : parentSession),
          create: async (_opts: any) => subSession,
          update: async (_id: string, _patch: any) => ({}),
        };
      }
      if (name === "agent") {
        return {
          getRegistry: () => undefined,
          getAgent: () => undefined,
          registerAgent: () => undefined,
          abort: () => {},
        };
      }
      return undefined;
    },
    pushEnvEvent: () => {},
    publishEvent: () => {},
  };

  return { env, release: releaseFn };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BackgroundTaskManager workflow propagation (Task #2144)", () => {
  let mockEnv: MockEnv;
  let releaseHandle: () => void;
  let stopRunCalls: Array<{ runId: string; reason: string | undefined }>;
  let mgr: BackgroundTaskManager;

  beforeEach(() => {
    const built = buildMockEnv({ blockHandleQuery: true });
    mockEnv = built.env;
    releaseHandle = built.release;
    stopRunCalls = [];
    mgr = new BackgroundTaskManager(mockEnv as any);
    // Inject mock workflow service
    mgr.setWorkflowService({
      stopRun: async (runId: string, reason?: string) => {
        stopRunCalls.push({ runId, reason });
      },
    });
  });

  test("AC-1: stop_task on sub-session triggers workflowService.stopRun on attached runs", async () => {
    const { taskId } = await mgr.createTask({
      parentSessionId: "parent_session_1",
      description: "test workflow propagate",
      prompt: "x",
      subagentType: "general",
      timeout: 5000,
    });

    mgr.attachWorkflowRun(taskId, "wf_run_aaa");
    mgr.attachWorkflowRun(taskId, "wf_run_bbb");

    const result = await mgr.stopTask(taskId);
    releaseHandle(); // unblock handle_query so test cleanup is fast

    expect(result.success).toBe(true);
    expect(stopRunCalls).toHaveLength(2);
    expect(stopRunCalls).toContainEqual({ runId: "wf_run_aaa", reason: expect.any(String) });
    expect(stopRunCalls).toContainEqual({ runId: "wf_run_bbb", reason: expect.any(String) });
  });

  test("AC-2: single sub-session with multiple workflow_run all stopped", async () => {
    const { taskId } = await mgr.createTask({
      parentSessionId: "parent_session_1",
      description: "multi workflow",
      prompt: "x",
      subagentType: "general",
      timeout: 5000,
    });
    mgr.attachWorkflowRun(taskId, "wf_run_x1");
    mgr.attachWorkflowRun(taskId, "wf_run_x2");
    mgr.attachWorkflowRun(taskId, "wf_run_x3");

    await mgr.stopTask(taskId);
    releaseHandle();

    expect(stopRunCalls).toHaveLength(3);
    const ids = stopRunCalls.map((c) => c.runId);
    expect(ids).toContain("wf_run_x1");
    expect(ids).toContain("wf_run_x2");
    expect(ids).toContain("wf_run_x3");
  });

  test("AC-3a: workflow already stopped → stopRun throws → stop_task still succeeds (idempotent)", async () => {
    // Replace with throwing stopRun
    mgr.setWorkflowService({
      stopRun: async () => {
        throw new Error("Session not found");
      },
    });

    const { taskId } = await mgr.createTask({
      parentSessionId: "parent_session_1",
      description: "idempotent",
      prompt: "x",
      subagentType: "general",
      timeout: 5000,
    });
    mgr.attachWorkflowRun(taskId, "wf_run_done");

    const result = await mgr.stopTask(taskId);
    releaseHandle();

    // Even though stopRun threw, stopTask still returns success=true
    expect(result.success).toBe(true);
  });

  test("AC-3b: workflow manually detached before stop_task → stopRun not called", async () => {
    const { taskId } = await mgr.createTask({
      parentSessionId: "parent_session_1",
      description: "detached",
      prompt: "x",
      subagentType: "general",
      timeout: 5000,
    });
    mgr.attachWorkflowRun(taskId, "wf_run_xxx");
    mgr.detachWorkflowRun(taskId, "wf_run_xxx");

    await mgr.stopTask(taskId);
    releaseHandle();

    expect(stopRunCalls).toHaveLength(0);
  });

  test("AC-4: isolation — different bgTasks have independent workflow registries", async () => {
    const a = await mgr.createTask({
      parentSessionId: "parent_session_1",
      description: "a",
      prompt: "x",
      subagentType: "general",
      timeout: 5000,
    });
    const b = await mgr.createTask({
      parentSessionId: "parent_session_1",
      description: "b",
      prompt: "x",
      subagentType: "general",
      timeout: 5000,
    });
    mgr.attachWorkflowRun(a.taskId, "wf_A_1");
    mgr.attachWorkflowRun(b.taskId, "wf_B_1");

    await mgr.stopTask(a.taskId);
    releaseHandle();

    const stopped = stopRunCalls.map((c) => c.runId);
    expect(stopped).toContain("wf_A_1");
    expect(stopped).not.toContain("wf_B_1");
  });

  test("AC-9: @TracedAs instrumentation — decorated stopTask still works (smoke)", async () => {
    const { taskId } = await mgr.createTask({
      parentSessionId: "parent_session_1",
      description: "trace smoke",
      prompt: "x",
      subagentType: "general",
      timeout: 5000,
    });
    mgr.attachWorkflowRun(taskId, "wf_trace_test");
    // No exception → decorator wrapped method is callable.
    await expect(mgr.stopTask(taskId)).resolves.toMatchObject({ success: true });
    releaseHandle();
  });
});
