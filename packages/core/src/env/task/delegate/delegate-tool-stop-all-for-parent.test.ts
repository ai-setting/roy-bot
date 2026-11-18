/**
 * @fileoverview BackgroundTaskManager.stopAllForParent TDD tests (Task #2245)
 *
 * 验证 ESC cascade: stopAllForParent(parentA) 只停 parent=A 的 BackgroundTask，
 * 不影响 parent=B 的。forceStopAll() 跨 parent 强杀所有 running 的 task。
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
  pushEnvEvent?: any;
  publishEvent?: any;
  [key: string]: any;
}

function buildMockEnv(opts: {
  blockHandleQuery?: boolean;
} = {}): { env: MockEnv; release: () => void } {
  let releaseFn: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });

  const subSession = {
    id: "sub_session_x",
    info: { metadata: { subagent_type: "general", task_description: "mock" } },
  };
  const parentSession = {
    id: "parent_session_x",
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
          get: async (id: string) => (id === "sub_session_x" ? subSession : parentSession),
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
// AC-1: stopAllForParent(parentSessionId) tests
// ---------------------------------------------------------------------------

describe("BackgroundTaskManager.stopAllForParent (Task #2245 ESC cascade)", () => {
  let mockEnv: MockEnv;
  let mgr: BackgroundTaskManager;
  let release: () => void;

  beforeEach(() => {
    const built = buildMockEnv({ blockHandleQuery: true });
    mockEnv = built.env;
    release = built.release;
    mgr = new BackgroundTaskManager(mockEnv as any);
  });

  test("AC-1a: stopAllForParent(parentA) 只停 parent=A 的 task，不动 parent=B 的", async () => {
    // Arrange: 3 task for parentA, 2 task for parentB
    const aTaskIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const t = await mgr.createTask({
        parentSessionId: "parentA",
        description: `A task ${i}`,
        prompt: "test",
        subagentType: "general",
      } as any);
      aTaskIds.push(t.taskId);
    }
    const bTaskIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const t = await mgr.createTask({
        parentSessionId: "parentB",
        description: `B task ${i}`,
        prompt: "test",
        subagentType: "general",
      } as any);
      bTaskIds.push(t.taskId);
    }

    // Act
    const result = await mgr.stopAllForParent("parentA");

    // Assert: A 全部 stopped, B 仍 running
    expect(result.stoppedTaskIds).toHaveLength(3);
    expect(result.stoppedTaskIds.every((id: string) => aTaskIds.includes(id))).toBe(true);
    for (const id of aTaskIds) {
      expect(mgr.getTask(id)?.status).toBe("stopped");
    }
    for (const id of bTaskIds) {
      expect(mgr.getTask(id)?.status).not.toBe("stopped");
    }

    // Cleanup
    release();
  });

  test("AC-1b: 已 stopped 的 task 不再被 stopAllForParent 处理（幂等）", async () => {
    // Arrange: 1 task for parentA, already stopped via stopTask
    const t = await mgr.createTask({
      parentSessionId: "parentA",
      description: "task",
      prompt: "test",
      subagentType: "general",
    } as any);
    await mgr.stopTask(t.taskId);

    // Act: stopAllForParent 应 no-op（已 stopped）
    const result = await mgr.stopAllForParent("parentA");

    // Assert: 不返回已 stopped 的 id（因为 stopAllForParent 只处理 running/pending）
    expect(result.stoppedTaskIds).toEqual([]);
    expect(mgr.getTask(t.taskId)?.status).toBe("stopped");

    // Cleanup
    release();
  });

  test("AC-1c: stopAllForParent(unknownParent) 返回空数组，不报错", async () => {
    // Arrange: 1 task for parentA
    await mgr.createTask({
      parentSessionId: "parentA",
      description: "A task",
      prompt: "test",
      subagentType: "general",
    } as any);

    // Act
    const result = await mgr.stopAllForParent("unknownParent");

    // Assert
    expect(result.stoppedTaskIds).toEqual([]);

    // Cleanup
    release();
  });
});

// ---------------------------------------------------------------------------
// AC-4: forceStopAll() tests
// ---------------------------------------------------------------------------

describe("BackgroundTaskManager.forceStopAll (Task #2245 ESC force cascade)", () => {
  let mockEnv: MockEnv;
  let mgr: BackgroundTaskManager;
  let release: () => void;

  beforeEach(() => {
    const built = buildMockEnv({ blockHandleQuery: true });
    mockEnv = built.env;
    release = built.release;
    mgr = new BackgroundTaskManager(mockEnv as any);
  });

  test("AC-4a: forceStopAll() 跨 parent 强杀所有 running/pending 的 task", async () => {
    // Arrange: 2 task for parentA + 1 task for parentB
    const aIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const t = await mgr.createTask({
        parentSessionId: "parentA",
        description: `A ${i}`,
        prompt: "test",
        subagentType: "general",
      } as any);
      aIds.push(t.taskId);
    }
    const bId = (await mgr.createTask({
      parentSessionId: "parentB",
      description: "B",
      prompt: "test",
      subagentType: "general",
    } as any)).taskId;

    // Act
    await mgr.forceStopAll();

    // Assert: 所有 task 都 stopped（跨 parent）
    for (const id of aIds) {
      expect(mgr.getTask(id)?.status).toBe("stopped");
    }
    expect(mgr.getTask(bId)?.status).toBe("stopped");

    // Cleanup
    release();
  });

  test("AC-4b: forceStopAll() 对空 manager 无副作用", async () => {
    // Act + Assert: 不抛错
    await expect(mgr.forceStopAll()).resolves.toBeUndefined();
  });
});