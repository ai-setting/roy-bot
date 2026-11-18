/**
 * @fileoverview TDD tests — BackgroundTaskManager.getSubSessionActivity (real impl)
 *
 * Task #4720 (DS review MINOR 1):
 *   The Fix B tests in query-background-process-tool-activity.test.ts all STUB
 *   `getSubSessionActivity`, so the real implementation in delegate-tool.ts
 *   (sessionComponent.get → messageCount / updatedAt) was never executed.
 *   This file exercises the real code path directly.
 */

import { describe, expect, test, vi } from "vitest";
import { BackgroundTaskManager, type BackgroundTask } from "./delegate-tool";

const BG_ID = "process_activity_1";
const SUB_SESSION = "sub-session-activity";

function makeTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: BG_ID,
    subSessionId: SUB_SESSION,
    parentSessionId: "parent-session-activity",
    description: "activity probe",
    subagentType: "roy",
    status: "running",
    createdAt: 1_000_000,
    startedAt: 1_000_000,
    lastUpdatedAt: 1_100_000,
    ...overrides,
  } as BackgroundTask;
}

function buildManager(sessionComponent: any, task?: BackgroundTask) {
  const env: any = {
    getComponent: vi.fn((name: string) =>
      name === "session" ? sessionComponent : undefined,
    ),
    pushEnvEvent: vi.fn(),
  };
  const manager = new BackgroundTaskManager(env);
  if (task) {
    (manager as any).tasks.set(task.id, task);
  }
  return manager;
}

describe("BackgroundTaskManager.getSubSessionActivity (Task #4720)", () => {
  test("returns messageCount and updatedAt from the sub-session", async () => {
    const sessionComponent = {
      get: vi.fn(async (sessionId: string) => ({
        id: sessionId,
        messageCount: 42,
        updatedAt: 1_500_000,
      })),
    };
    const manager = buildManager(sessionComponent, makeTask());

    const activity = await manager.getSubSessionActivity(BG_ID);

    expect(activity).toEqual({ messageCount: 42, updatedAt: 1_500_000 });
    // must look up the SUB-session, not the parent session
    expect(sessionComponent.get).toHaveBeenCalledWith(SUB_SESSION);
  });

  test("falls back to task.lastUpdatedAt when session has no updatedAt", async () => {
    const sessionComponent = {
      get: vi.fn(async () => ({ id: SUB_SESSION, messageCount: 7 })),
    };
    const manager = buildManager(sessionComponent, makeTask({ lastUpdatedAt: 1_100_000 }));

    const activity = await manager.getSubSessionActivity(BG_ID);

    expect(activity).toEqual({ messageCount: 7, updatedAt: 1_100_000 });
  });

  test("falls back to task.createdAt when neither session nor task has updatedAt", async () => {
    const sessionComponent = {
      get: vi.fn(async () => ({ id: SUB_SESSION, messageCount: 0 })),
    };
    const task = makeTask({ lastUpdatedAt: undefined as any, createdAt: 1_000_000 });
    const manager = buildManager(sessionComponent, task);

    const activity = await manager.getSubSessionActivity(BG_ID);

    expect(activity).toEqual({ messageCount: 0, updatedAt: 1_000_000 });
  });

  test("returns undefined when the task does not exist", async () => {
    const sessionComponent = { get: vi.fn() };
    const manager = buildManager(sessionComponent);

    expect(await manager.getSubSessionActivity("no-such-process")).toBeUndefined();
    expect(sessionComponent.get).not.toHaveBeenCalled();
  });

  test("returns undefined when there is no session component", async () => {
    const manager = buildManager(undefined, makeTask());

    expect(await manager.getSubSessionActivity(BG_ID)).toBeUndefined();
  });

  test("returns undefined when the session does not exist", async () => {
    const sessionComponent = { get: vi.fn(async () => undefined) };
    const manager = buildManager(sessionComponent, makeTask());

    expect(await manager.getSubSessionActivity(BG_ID)).toBeUndefined();
  });

  test("returns undefined (does not throw) when the session store throws", async () => {
    const sessionComponent = {
      get: vi.fn(async () => {
        throw new Error("SQLITE_BUSY");
      }),
    };
    const manager = buildManager(sessionComponent, makeTask());

    expect(await manager.getSubSessionActivity(BG_ID)).toBeUndefined();
  });
});
