/**
 * @fileoverview TDD tests — query_background_process reflects real sub-agent activity
 *
 * Bug (Task #4720, 2026-10-30):
 *   query_background_process reported `alive:true, status:"running"` with a
 *   `lastUpdatedAt` frozen at the task creation time for up to 20 minutes
 *   (PROGRESS_INTERVAL = 20 min in delegate-tool.ts). Observers could not
 *   distinguish "sub-agent is actively working" from "sub-agent is wedged".
 *
 * Fix B:
 *   When the task is still alive, the tool additionally reads the sub-session's
 *   live state (messageCount + updatedAt) and reports:
 *     - lastUpdatedAt  = max(task.lastUpdatedAt, subSession.updatedAt)
 *     - messageCount   = sub-session message count (new field)
 *     - subSessionUpdatedAt = sub-session updatedAt (new field)
 *
 *   With Fix A (incremental persistence) the sub-session's updatedAt advances
 *   on every ReAct iteration, so this becomes a true liveness signal.
 *
 * Expected behavior:
 *   - alive task with a progressing sub-session → fresh lastUpdatedAt + messageCount > 0
 *   - manager without the optional API (or session lookup failure) → degraded but
 *     still valid output (old fields present, new fields undefined)
 *   - terminal task → unchanged behavior (no session lookup needed)
 */

import { describe, test, expect } from "bun:test";
import { createQueryBackgroundProcessTool } from "./query-background-process-tool";
import type { BackgroundTask, BackgroundTaskManager } from "../../task/delegate/delegate-tool";

const PARENT_SESSION = "session_parent";
const SUB_SESSION = "session_sub";

function buildMockManager(
  tasks: BackgroundTask[],
  activity?: { messageCount: number; updatedAt: number },
  sessionLookupThrows = false,
): BackgroundTaskManager {
  const map = new Map<string, BackgroundTask>();
  for (const t of tasks) map.set(t.id, { ...t });

  const manager = {
    getTask: (taskId: string): BackgroundTask | undefined => {
      const t = map.get(taskId);
      return t ? { ...t } : undefined;
    },
    listTasks: (): BackgroundTask[] => Array.from(map.values()).map((t) => ({ ...t })),
    getSubSessionActivity: async (taskId: string) => {
      if (sessionLookupThrows) throw new Error("session store unavailable");
      const t = map.get(taskId);
      if (!t || !activity) return undefined;
      return activity;
    },
  } as unknown as BackgroundTaskManager;

  return manager;
}

function makeRunningTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "process_1",
    subSessionId: SUB_SESSION,
    parentSessionId: PARENT_SESSION,
    description: "long running task",
    subagentType: "roy",
    status: "running",
    createdAt: 1_000_000,
    startedAt: 1_000_000,
    lastUpdatedAt: 1_000_000,
    ...overrides,
  } as BackgroundTask;
}

describe("query_background_process — live sub-agent activity (Task #4720)", () => {
  test("alive task reports sub-session messageCount and a fresh lastUpdatedAt", async () => {
    // task.lastUpdatedAt frozen at creation (no 20-min heartbeat yet)
    const task = makeRunningTask({ lastUpdatedAt: 1_000_000 });
    // sub-session progressed: 42 messages, updated recently
    const activity = { messageCount: 42, updatedAt: 1_500_000 };

    const tool = createQueryBackgroundProcessTool(buildMockManager([task], activity));
    const result = await tool.execute(
      { bgProcessId: "process_1" },
      { session_id: PARENT_SESSION } as any,
    );

    expect(result.success).toBe(true);
    const out = JSON.parse(result.output);
    expect(out.alive).toBe(true);
    expect(out.status).toBe("running");
    // lastUpdatedAt must reflect the fresher of the two signals
    expect(out.lastUpdatedAt).toBe(1_500_000);
    // new fields expose real progress
    expect(out.messageCount).toBe(42);
    expect(out.subSessionUpdatedAt).toBe(1_500_000);
  });

  test("task heartbeat newer than sub-session wins for lastUpdatedAt", async () => {
    const task = makeRunningTask({ lastUpdatedAt: 2_000_000 });
    const activity = { messageCount: 5, updatedAt: 1_500_000 };

    const tool = createQueryBackgroundProcessTool(buildMockManager([task], activity));
    const result = await tool.execute(
      { bgProcessId: "process_1" },
      { session_id: PARENT_SESSION } as any,
    );

    const out = JSON.parse(result.output);
    expect(out.lastUpdatedAt).toBe(2_000_000);
    expect(out.messageCount).toBe(5);
  });

  test("manager without the activity API degrades gracefully (old fields intact)", async () => {
    const task = makeRunningTask({ lastUpdatedAt: 1_000_000 });
    const map = new Map<string, BackgroundTask>([[task.id, task]]);
    const bareManager = {
      getTask: (id: string) => (map.get(id) ? { ...map.get(id)! } : undefined),
      listTasks: () => [],
    } as unknown as BackgroundTaskManager;

    const tool = createQueryBackgroundProcessTool(bareManager);
    const result = await tool.execute(
      { bgProcessId: "process_1" },
      { session_id: PARENT_SESSION } as any,
    );

    expect(result.success).toBe(true);
    const out = JSON.parse(result.output);
    expect(out.alive).toBe(true);
    expect(out.status).toBe("running");
    expect(out.lastUpdatedAt).toBe(1_000_000);
    // new fields simply absent — no crash
    expect(out.messageCount).toBeUndefined();
  });

  test("session lookup failure does not break the query", async () => {
    const task = makeRunningTask({ lastUpdatedAt: 1_000_000 });
    const tool = createQueryBackgroundProcessTool(
      buildMockManager([task], { messageCount: 3, updatedAt: 1_400_000 }, true),
    );
    const result = await tool.execute(
      { bgProcessId: "process_1" },
      { session_id: PARENT_SESSION } as any,
    );

    expect(result.success).toBe(true);
    const out = JSON.parse(result.output);
    expect(out.alive).toBe(true);
    expect(out.lastUpdatedAt).toBe(1_000_000);
    expect(out.messageCount).toBeUndefined();
  });

  test("terminal task is unchanged (no session lookup needed)", async () => {
    const task = makeRunningTask({ status: "completed", result: "done" });
    const tool = createQueryBackgroundProcessTool(
      buildMockManager([task], { messageCount: 9, updatedAt: 1_500_000 }),
    );
    const result = await tool.execute(
      { bgProcessId: "process_1" },
      { session_id: PARENT_SESSION } as any,
    );

    const out = JSON.parse(result.output);
    expect(out.alive).toBe(false);
    expect(out.status).toBe("completed");
    expect(out.result).toBe("done");
    expect(out.messageCount).toBeUndefined();
  });
});
