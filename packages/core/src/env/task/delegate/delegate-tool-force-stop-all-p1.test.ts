/**
 * @fileoverview forceStopAll P1 cascade fixes (Task #2245 Claude Code Review)
 *
 * P1-#2: forceStopAllAcrossParents publishes STOPPED event for newly marked tasks
 * P1-#4: forceStopAllAcrossParents concurrent mutation lock
 * P1-#5: force path captures workflowRunRegistries errors
 * P1-#8: rename forceStopAll → forceStopAllAcrossParents (deprecated alias)
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
// P1-#2: forceStopAll publishes STOPPED event
// ---------------------------------------------------------------------------

describe("P1-#2: forceStopAll publishes STOPPED event (Task #2245)", () => {
  let mockEnv: MockEnv;
  let mgr: BackgroundTaskManager;
  let release: () => void;
  let publishedEvents: Array<{ type: string; payload: any; parentSessionId?: string }>;

  beforeEach(() => {
    const built = buildMockEnv();
    mockEnv = built.env;
    release = built.release;
    publishedEvents = [];
    mockEnv.pushEnvEvent = (evt: any) => {
      publishedEvents.push({
        type: evt.type ?? evt.eventType ?? "unknown",
        payload: evt,
      });
    };
    mockEnv.publishEvent = (type: string, payload: any, parentSessionId?: string) => {
      publishedEvents.push({ type, payload, parentSessionId });
    };
    mgr = new BackgroundTaskManager(mockEnv as any);
  });

  test("P1-2a: forceStopAll 对每个 task 发 STOPPED 事件（含 'force stop all' 标识）", async () => {
    const t1 = await mgr.createTask({
      parentSessionId: "p1",
      description: "task 1",
      prompt: "test",
      subagentType: "general",
    } as any);

    await mgr.forceStopAll();

    // Find STOPPED events with "force stop all" error string
    const forceStopEvents = publishedEvents.filter(
      (e) =>
        e.type.includes("stopped") &&
        JSON.stringify(e.payload).includes("force stop all")
    );
    expect(forceStopEvents.length).toBeGreaterThanOrEqual(1);
    // 至少一个事件包含 t1.taskId
    const hasT1 = forceStopEvents.some((e) =>
      JSON.stringify(e.payload).includes(t1.taskId)
    );
    expect(hasT1).toBe(true);
  });

  test("P1-2b: forceStopAll 对已 stopped 的 task 不重复发 'force stop all' 事件（去重）", async () => {
    const t = await mgr.createTask({
      parentSessionId: "p1",
      description: "task",
      prompt: "test",
      subagentType: "general",
    } as any);

    // graceful stop first
    await mgr.stopTask(t.taskId);
    const eventsAfterStop = publishedEvents.length;

    // force stop — should NOT publish another "force stop all" STOPPED event
    await mgr.forceStopAll();

    // Filter only events published AFTER stopTask completed
    const newEvents = publishedEvents.slice(eventsAfterStop);
    const forceStopEvents = newEvents.filter(
      (e) =>
        e.type.includes("stopped") &&
        JSON.stringify(e.payload).includes("force stop all")
    );
    expect(forceStopEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// P1-#4: forceStopAll concurrent mutation lock
// ---------------------------------------------------------------------------

describe("P1-#4: forceStopAll concurrent mutation lock (Task #2245)", () => {
  let mockEnv: MockEnv;
  let mgr: BackgroundTaskManager;
  let release: () => void;

  beforeEach(() => {
    const built = buildMockEnv();
    mockEnv = built.env;
    release = built.release;
    mgr = new BackgroundTaskManager(mockEnv as any);
  });

  test("P1-4a: 并发调 forceStopAll 100 次，最终状态一致", async () => {
    const taskIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const t = await mgr.createTask({
        parentSessionId: `p${i}`,
        description: `task ${i}`,
        prompt: "test",
        subagentType: "general",
      } as any);
      taskIds.push(t.taskId);
    }

    // 100 concurrent forceStopAll
    const promises = Array.from({ length: 100 }, () => mgr.forceStopAll());
    await Promise.all(promises);

    // All tasks should be stopped
    for (const id of taskIds) {
      const status = mgr.getTask(id)?.status;
      expect(status).toBe("stopped");
    }
  });
});

// ---------------------------------------------------------------------------
// P1-#5: force path captures workflowRunRegistries errors
// ---------------------------------------------------------------------------

describe("P1-#5: forceStopAll captures workflowRunRegistries errors (Task #2245)", () => {
  let mockEnv: MockEnv;
  let mgr: BackgroundTaskManager;
  let release: () => void;

  beforeEach(() => {
    const built = buildMockEnv();
    mockEnv = built.env;
    release = built.release;
    mgr = new BackgroundTaskManager(mockEnv as any);
  });

  test("P1-5a: forceStopAll workflowService.stopRun 抛错时不崩溃 task mark stopped", async () => {
    // Inject a workflowService that throws
    (mgr as any).workflowService = {
      stopRun: async () => {
        throw new Error("simulated stopRun failure");
      },
    };

    const t = await mgr.createTask({
      parentSessionId: "p1",
      description: "task",
      prompt: "test",
      subagentType: "general",
    } as any);
    (mgr as any).attachWorkflowRun(t.taskId, "wf_bad");

    // forceStopAll 不应抛错
    await mgr.forceStopAll();

    // task 应被 mark stopped (即使 workflow run 失败)
    expect(mgr.getTask(t.taskId)?.status).toBe("stopped");
  });
});
