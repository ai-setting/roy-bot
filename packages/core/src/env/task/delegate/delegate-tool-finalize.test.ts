/**
 * @fileoverview BackgroundTaskManager 终态联动释放 (Task #2539 / #2532 round 2)
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 *
 * 用户要求：
 *   sub session 终态（success / error / cancel / timeout 任意一种）触发后，
 *   必须联动释放 sub session 相关 transient registry，而不是只在全局 dispose() 时清理：
 *   - abortControllers / workflowRunRegistries / tasks Map 中本 task 自己的 entry
 *   - processRegistries 暂时保留（BL-4c force-stop 重试 contract），仅在 size==0 时 delete map 入口
 *
 * 该文件仅放 BackgroundTaskManager 单元测试；sub-session side cleanup（messages /
 * checkpoints 释放）由 MemorySessionStore.endSessionCleanup 测试覆盖。
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";

import { BackgroundTaskManager } from "./delegate-tool";
import { ProcessRegistry } from "./process-registry";

// ---------------------------------------------------------------------------
// Mock killProcessTree so the registry doesn't try to touch real PIDs.
// ---------------------------------------------------------------------------
const killProcessTreeMock = mock(async (_pid: number, _opts: any) => ({
  stillAlive: false,
  attempts: 1,
  pids: [],
}));

mock.module("../../../util/process/process-tree-killer", () => ({
  killProcessTree: killProcessTreeMock,
  isProcessAlive: async () => false,
  default: { killProcessTree: killProcessTreeMock },
}));

interface MockEnv {
  handle_query: (...args: any[]) => Promise<string>;
  getComponent: (name: string) => any;
  pushEnvEvent?: any;
  [key: string]: any;
}

function buildMockEnv(handleQueryImpl: () => Promise<string> = async () => "ok"): MockEnv {
  const subSession = {
    id: "sub_session_x",
    info: { metadata: { subagent_type: "general" } },
  };
  const parentSession = {
    id: "parent_session_x",
    info: { metadata: {} },
  };
  return {
    handle_query: handleQueryImpl,
    getComponent: (name: string) => {
      if (name === "session") {
        return {
          get: async (id: string) => (id === "sub_session_x" ? subSession : parentSession),
          create: async () => subSession,
          update: async () => ({}),
        };
      }
      if (name === "agent") {
        return { getRegistry: () => undefined, getAgent: () => undefined, registerAgent: () => undefined, abort: () => {} };
      }
      return undefined;
    },
    pushEnvEvent: () => {},
  };
}

// ---------------------------------------------------------------------------
// Helpers — internal Map access
// ---------------------------------------------------------------------------
function tasksOf(mgr: BackgroundTaskManager): Map<string, unknown> {
  return (mgr as any).tasks as Map<string, unknown>;
}
function abortCtrlsOf(mgr: BackgroundTaskManager): Map<string, unknown> {
  return (mgr as any).abortControllers as Map<string, unknown>;
}
function wfRunsOf(mgr: BackgroundTaskManager): Map<string, unknown> {
  return (mgr as any).workflowRunRegistries as Map<string, unknown>;
}
function procRegsOf(mgr: BackgroundTaskManager): Map<string, ProcessRegistry> {
  return (mgr as any).processRegistries as Map<string, ProcessRegistry>;
}

// ---------------------------------------------------------------------------
// 1. finalizeTask internal contract — terminal state releases transient entries
// ---------------------------------------------------------------------------
describe("BackgroundTaskManager.finalizeTask (Task #2539)", () => {
  let mockEnv: MockEnv;
  let mgr: BackgroundTaskManager;

  beforeEach(() => {
    killProcessTreeMock.mockReset();
    mockEnv = buildMockEnv();
    mgr = new BackgroundTaskManager(mockEnv as any);
  });

  test("Tasks 终态成功：tasks/abortControllers/workflowRunRegistries 全部 delete；processRegistries 保留（BL-4c）", async () => {
    const { taskId } = await mgr.createTask({
      parentSessionId: "parent_session_x",
      description: "ok task",
      prompt: "do work",
      subagentType: "general",
    } as any);

    // 预置一个 attachWorkflowRun
    mgr.attachWorkflowRun(taskId, "wf_run_1");
    expect(wfRunsOf(mgr).get(taskId)).toBeDefined();

    // 等到执行完成
    await new Promise((r) => setTimeout(r, 50));

    // success 路径下 executeTask 应已自动触发 finalizeTask
    expect(tasksOf(mgr).has(taskId)).toBe(false);
    expect(abortCtrlsOf(mgr).has(taskId)).toBe(false);
    expect(wfRunsOf(mgr).has(taskId)).toBe(false);
    // processRegistries 默认 spawn 时为空，size==0；但 BL-4c 要求保留 map entry，
    // 真正的清理走 dispose() / cleanupEmptyProcessRegistries()。
    expect(procRegsOf(mgr).has(taskId)).toBe(true);
    expect(procRegsOf(mgr).get(taskId)!.size()).toBe(0);
  });

  test("error 终态：终态触发后 transient registry 全部释放（除 processRegistries 残留 PID contract）", async () => {
    const failingEnv = buildMockEnv(async () => {
      throw new Error("sub-agent blew up");
    });
    const failingMgr = new BackgroundTaskManager(failingEnv as any);

    const { taskId } = await failingMgr.createTask({
      parentSessionId: "parent_session_x",
      description: "fail task",
      prompt: "do work",
      subagentType: "general",
    } as any);

    // 等到执行失败
    await new Promise((r) => setTimeout(r, 50));

    expect(tasksOf(failingMgr).has(taskId)).toBe(false);
    expect(abortCtrlsOf(failingMgr).has(taskId)).toBe(false);
    expect(wfRunsOf(failingMgr).has(taskId)).toBe(false);
  });

  test("cancel (stopped) 终态：transient registry 全部释放", async () => {
    // 立即 stopTask 制造 cancelled
    const env = buildMockEnv(async () => "ok");
    const m = new BackgroundTaskManager(env as any);
    const { taskId } = await m.createTask({
      parentSessionId: "parent_session_x",
      description: "cancel target",
      prompt: "do work",
      subagentType: "general",
    } as any);

    m.attachWorkflowRun(taskId, "wf_run_cancel");

    await m.stopTask(taskId);

    expect(tasksOf(m).has(taskId)).toBe(false);
    expect(abortCtrlsOf(m).has(taskId)).toBe(false);
    expect(wfRunsOf(m).has(taskId)).toBe(false);
  });

  test("timeout 终态：transient registry 全部释放", async () => {
    // 让 sub-agent 卡死，再用短 timeout 触发 timeout 路径
    const hangingEnv = buildMockEnv(() => new Promise<string>(() => {})); // never resolves
    const m = new BackgroundTaskManager(hangingEnv as any);

    const { taskId } = await m.createTask({
      parentSessionId: "parent_session_x",
      description: "timeout target",
      prompt: "do work",
      subagentType: "general",
      timeout: 50, // 50ms
    } as any);

    // 等到 timeout 触发
    await new Promise((r) => setTimeout(r, 200));

    expect(tasksOf(m).has(taskId)).toBe(false);
    expect(abortCtrlsOf(m).has(taskId)).toBe(false);
    expect(wfRunsOf(m).has(taskId)).toBe(false);
  });

  test("BL-4c contract 仍通过：processRegistries 有残留 PID 时 map entry 保留供 force-stop 重试", async () => {
    // 模拟 killProcessTree 永远返回 stillAlive=true，残留 PID 留在 registry 里
    killProcessTreeMock.mockImplementation(async (pid: number) => ({
      stillAlive: true,
      attempts: 3,
      pids: [pid],
    }));

    const { taskId } = await mgr.createTask({
      parentSessionId: "parent_session_x",
      description: "bleed pid",
      prompt: "spawn",
      subagentType: "general",
    } as any);

    // 手动往 registry 里塞一个 PID（mock env 的 handle_query 不走 bash 工具）
    procRegsOf(mgr).get(taskId)!.register(99999);

    // 等 success 路径完成
    await new Promise((r) => setTimeout(r, 50));

    // tasks/abort/wfRuns 应被释放（移到 terminalTasks / 清掉 transient）
    expect(tasksOf(mgr).has(taskId)).toBe(false);
    expect(abortCtrlsOf(mgr).has(taskId)).toBe(false);
    expect(wfRunsOf(mgr).has(taskId)).toBe(false);
    // processRegistries map entry 仍存在（BL-4c 保留，让 force-stop 可以重试）
    expect(procRegsOf(mgr).has(taskId)).toBe(true);
    expect(procRegsOf(mgr).get(taskId)!.size()).toBe(1);

    // killAll 失败（stillAlive=true），PID 保留
    await procRegsOf(mgr).get(taskId)!.killAll();
    expect(procRegsOf(mgr).get(taskId)!.size()).toBe(1);

    // finalizeTask 重复调用仍是 no-op（map entry 一直保留）
    (mgr as any).finalizeTask(taskId, "force-retry");
    expect(procRegsOf(mgr).has(taskId)).toBe(true);

    // 当 PID 真正被清掉（killAll 二次调用成功）→ size==0
    killProcessTreeMock.mockImplementationOnce(async (pid: number) => ({
      stillAlive: false,
      attempts: 1,
      pids: [pid],
    }));
    await procRegsOf(mgr).get(taskId)!.killAll();
    expect(procRegsOf(mgr).get(taskId)!.size()).toBe(0);

    // 即便 size==0，finalizeTask 也不会主动删除 map entry（BL-4c 保留）
    (mgr as any).finalizeTask(taskId, "force-retry-success");
    expect(procRegsOf(mgr).has(taskId)).toBe(true);

    // 显式 cleanupEmptyProcessRegistries 才清理
    (mgr as any).cleanupEmptyProcessRegistries();
    expect(procRegsOf(mgr).has(taskId)).toBe(false);
  });

  test("processRegistries 容量可观测 + 上限：getProcessRegistrySize / getMaxProcessRegistries / cleanupEmptyProcessRegistries", () => {
    expect(typeof (mgr as any).getProcessRegistrySize).toBe("function");
    expect(typeof (mgr as any).getMaxProcessRegistries).toBe("function");
    expect(typeof (mgr as any).cleanupEmptyProcessRegistries).toBe("function");
    expect((mgr as any).getProcessRegistrySize()).toBe(0);
    // 上限默认 ≥ 100（足够日常使用，又不至于无限增长）
    expect((mgr as any).getMaxProcessRegistries()).toBeGreaterThanOrEqual(100);

    // 手动塞 3 个空 registry
    procRegsOf(mgr).set("a", new ProcessRegistry());
    procRegsOf(mgr).set("b", new ProcessRegistry());
    procRegsOf(mgr).set("c", new ProcessRegistry());
    expect((mgr as any).getProcessRegistrySize()).toBe(3);
    // cleanupEmptyProcessRegistries 应清掉 size==0 的 map entries
    (mgr as any).cleanupEmptyProcessRegistries();
    expect((mgr as any).getProcessRegistrySize()).toBe(0);
  });

  test("processRegistries 超上限时新任务创建拒绝并告警", async () => {
    // 通过 constructor 注入一个极小上限
    const small = new (class extends BackgroundTaskManager {
      constructor(env: any) {
        super(env);
        (this as any).maxProcessRegistries = 1;
      }
    })(mockEnv as any);

    // 预先塞入 1 个带残留 PID 的 registry，让 processRegistries.size() === 1
    const stuck = new ProcessRegistry();
    stuck.register(99999);
    (small as any).processRegistries.set("stuck_task", stuck);
    expect((small as any).getProcessRegistrySize()).toBe(1);

    // 此时再 createTask 应被拒绝（size 已达上限）
    await expect(
      small.createTask({
        parentSessionId: "parent_session_x",
        description: "would exceed cap",
        prompt: "x",
        subagentType: "general",
      } as any)
    ).rejects.toThrow(/processRegistries|上限|max/);
  });
});

// ---------------------------------------------------------------------------
// 2. dispose() 全量清理仍生效（与之前行为一致）
// ---------------------------------------------------------------------------
describe("BackgroundTaskManager.dispose (Task #2539)", () => {
  test("dispose 后所有 map 都为空", async () => {
    const env = buildMockEnv();
    const mgr = new BackgroundTaskManager(env as any);
    await mgr.createTask({
      parentSessionId: "parent_session_x",
      description: "x",
      prompt: "x",
      subagentType: "general",
    } as any);
    await new Promise((r) => setTimeout(r, 30));
    await mgr.dispose();

    expect((mgr as any).tasks.size).toBe(0);
    expect((mgr as any).abortControllers.size).toBe(0);
    expect((mgr as any).processRegistries.size).toBe(0);
    expect((mgr as any).workflowRunRegistries.size).toBe(0);
  });
});