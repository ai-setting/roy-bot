/**
 * @fileoverview P1-#8 + P1-#10 tests (Task #2245 Claude Code Review)
 *
 * P1-#8: forceStopAllAcrossParents rename (deprecated alias forceStopAll kept)
 * P1-#10: BL-3 runtime verification (replace source-grep test)
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 */

import { describe, test, expect, beforeEach } from "bun:test";

import { BackgroundTaskManager } from "./delegate-tool";

interface MockEnv {
  handle_query: (...args: any[]) => Promise<string>;
  getComponent: (name: string) => any;
  pushEnvEvent?: any;
  publishEvent?: any;
  [key: string]: any;
}

function buildMockEnv(): { env: MockEnv; release: () => void } {
  let releaseFn: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });

  const subSession = {
    id: "sub_session_x",
    info: { metadata: { subagent_type: "general", task_description: "mock" } },
  };

  const env: MockEnv = {
    handle_query: async () => {
      await released;
      return "done";
    },
    getComponent: (name: string) => {
      if (name === "session") {
        return {
          get: async () => subSession,
          create: async () => subSession,
          update: async () => ({}),
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
// P1-#8: forceStopAllAcrossParents rename
// ---------------------------------------------------------------------------

describe("P1-#8: forceStopAllAcrossParents rename (Task #2245)", () => {
  let mockEnv: MockEnv;
  let mgr: BackgroundTaskManager;
  let release: () => void;

  beforeEach(() => {
    const built = buildMockEnv();
    mockEnv = built.env;
    release = built.release;
    mgr = new BackgroundTaskManager(mockEnv as any);
  });

  test("P1-8a: BackgroundTaskManager 暴露 forceStopAllAcrossParents 方法", () => {
    expect(typeof (mgr as any).forceStopAllAcrossParents).toBe("function");
  });

  test("P1-8b: forceStopAll 是 forceStopAllAcrossParents 的 deprecated alias", async () => {
    const t = await mgr.createTask({
      parentSessionId: "p1",
      description: "task",
      prompt: "test",
      subagentType: "general",
    } as any);

    // Call deprecated alias
    await mgr.forceStopAll();

    // Should mark task as stopped (proves alias works)
    expect(mgr.getTask(t.taskId)?.status).toBe("stopped");
  });

  test("P1-8c: forceStopAllAcrossParents 调 workflowService.stopRun（cascade 正确性）", async () => {
    const stopRunCalls: string[] = [];
    mgr.setWorkflowService({
      stopRun: async (runId: string) => {
        stopRunCalls.push(runId);
      },
    });

    const t = await mgr.createTask({
      parentSessionId: "p1",
      description: "task",
      prompt: "test",
      subagentType: "general",
    } as any);
    (mgr as any).attachWorkflowRun(t.taskId, "wf_renamed_test");

    await (mgr as any).forceStopAllAcrossParents();

    expect(stopRunCalls).toContain("wf_renamed_test");
  });
});
