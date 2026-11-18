/**
 * @fileoverview ProcessRegistry retention + forceStopAll retry (Task #2245 BL-4)
 *
 * Reviewer found:
 * - `ProcessRegistry.killAll()` calls `this.pids.clear()` at the end, so PIDs
 *   that `killProcessTree` failed to kill are LOST. A second ESC cannot retry
 *   on leaked PIDs.
 * - `BackgroundTaskManager.forceStopAll()` only iterates running/pending
 *   tasks. After graceful `stopTask()` marked the task `stopped`, force path
 *   skips it, so leaked PIDs from the graceful attempt can never be cleaned.
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";

import { BackgroundTaskManager } from "./delegate-tool";
import { ProcessRegistry } from "./process-registry";

// ---------------------------------------------------------------------------
// Mock killProcessTree so we can control stillAlive/cleanup behavior
// ---------------------------------------------------------------------------
const killProcessTreeMock = mock(async (_pid: number, _opts: any) => ({
  stillAlive: false,
  attempts: 1,
  pids: [],
}));

mock.module("../../../util/process/process-tree-killer", () => ({
  killProcessTree: killProcessTreeMock,
  // Preserve any other exports as no-ops so callers don't break
  isProcessAlive: async () => false,
  default: { killProcessTree: killProcessTreeMock },
}));

interface MockEnv {
  handle_query: (...args: any[]) => Promise<string>;
  getComponent: (name: string) => any;
  pushEnvEvent?: any;
  publishEvent?: any;
  [key: string]: any;
}

function buildMockEnv(): MockEnv {
  const subSession = {
    id: "sub_session_x",
    info: { metadata: { subagent_type: "general" } },
  };
  const parentSession = {
    id: "parent_session_x",
    info: { metadata: {} },
  };
  return {
    handle_query: async () => "done",
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
    publishEvent: () => {},
  };
}

describe("ProcessRegistry killAll retention (Task #2245 BL-4)", () => {
  beforeEach(() => {
    killProcessTreeMock.mockReset();
  });

  test("BL-4a: killAll 保留 stillAlive PIDs（不清空），允许二次强杀", async () => {
    killProcessTreeMock.mockImplementation(async (pid: number) => ({
      stillAlive: pid === 12345, // 12345 still alive, 67890 killed
      attempts: pid === 12345 ? 3 : 1,
      pids: [pid],
    }));

    const reg = new ProcessRegistry();
    reg.register(12345);
    reg.register(67890);

    await reg.killAll();

    // After killAll: 67890 should be removed (killed), 12345 RETAINED (stillAlive)
    expect(reg.size()).toBe(1);
  });

  test("BL-4b: killAll 第二次调用能重试 stillAlive PID", async () => {
    let callCount = 0;
    killProcessTreeMock.mockImplementation(async (pid: number) => {
      callCount++;
      // First call: stillAlive. Second call: killed.
      if (callCount === 1) {
        return { stillAlive: true, attempts: 3, pids: [pid] };
      }
      return { stillAlive: false, attempts: 1, pids: [pid] };
    });

    const reg = new ProcessRegistry();
    reg.register(12345);

    // 第一次调用：PID 12345 标记 stillAlive，保留
    await reg.killAll();
    expect(reg.size()).toBe(1);

    // 第二次调用：应该再次尝试 killAll(12345)，这次成功
    await reg.killAll();
    expect(reg.size()).toBe(0);
  });
});

describe("BackgroundTaskManager.forceStopAll retry on graceful-failed tasks (Task #2245 BL-4)", () => {
  let mockEnv: MockEnv;
  let mgr: BackgroundTaskManager;
  let killAllCalls: Array<{ taskId: string; callCount: number }>;

  beforeEach(() => {
    mockEnv = buildMockEnv();
    mgr = new BackgroundTaskManager(mockEnv as any);
    killAllCalls = [];
    killProcessTreeMock.mockReset();
  });

  test("BL-4c: forceStopAll 对已 stopped 但 processRegistries 还有残留 PID 的 task 也调 killAll", async () => {
    killProcessTreeMock.mockImplementation(async (pid: number) => ({
      stillAlive: false,
      attempts: 1,
      pids: [pid],
    }));

    const t = await mgr.createTask({
      parentSessionId: "parentA",
      description: "task",
      prompt: "test",
      subagentType: "general",
    } as any);

    const registry = (mgr as any).processRegistries.get(t.taskId) as ProcessRegistry;
    let killAllCallCount = 0;
    const origKillAll = registry.killAll.bind(registry);
    registry.killAll = async () => {
      killAllCallCount++;
      killAllCalls.push({ taskId: t.taskId, callCount: killAllCallCount });
      return origKillAll();
    };

    const callCountAfterStop = killAllCallCount;
    await mgr.stopTask(t.taskId);
    const callsFromStop = killAllCallCount - callCountAfterStop;
    expect(callsFromStop).toBeGreaterThanOrEqual(1);

    await mgr.forceStopAll();
    const callsAfterForce = killAllCallCount;
    expect(callsAfterForce).toBeGreaterThanOrEqual(callsFromStop + 1);
  });
});