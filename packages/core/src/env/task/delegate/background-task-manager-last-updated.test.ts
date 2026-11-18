import { afterEach, describe, expect, test, vi } from "vitest";
import {
  BackgroundTaskEventTypes,
  BackgroundTaskManager,
  PROGRESS_INTERVAL,
  type BackgroundTask,
} from "./delegate-tool";

// Task #4888: PROGRESS_INTERVAL is 20 min again (it was temporarily lowered to
// 10 min by #4720, then reverted because 10 min was too chatty).
// The test advances the reporter 3 times and expects exactly 3 events,
// so it must use the real interval instead of a hardcoded 1_200_000.
const PROGRESS_INTERVAL_MS = PROGRESS_INTERVAL;

describe("BackgroundTaskManager lastUpdatedAt", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("tracks the timestamp of the third progress notification", () => {
    vi.useFakeTimers();

    const publishedEvents: any[] = [];
    const manager = new BackgroundTaskManager({
      pushEnvEvent: (event: any) => publishedEvents.push(event),
    });
    const task: BackgroundTask = {
      id: "process_progress_timestamp",
      subSessionId: "sub-progress",
      parentSessionId: "parent-progress",
      description: "long-running progress timestamp test",
      subagentType: "roy",
      status: "running",
      createdAt: Date.now(),
      startedAt: Date.now(),
      lastUpdatedAt: Date.now(),
    };

    // Exercise the manager's real progress reporter while avoiding unrelated
    // session/agent execution wiring.
    (manager as any).tasks.set(task.id, task);
    (manager as any).startProgressReporter(task.id, task.parentSessionId);

    const notificationTimes: number[] = [];
    for (let notification = 0; notification < 3; notification++) {
      vi.advanceTimersByTime(PROGRESS_INTERVAL_MS);
      notificationTimes.push(Date.now());
    }

    const progressEvents = publishedEvents.filter(
      (event) => event.type === BackgroundTaskEventTypes.PROGRESS,
    );
    expect(progressEvents).toHaveLength(3);
    expect((manager.getTask(task.id) as any).lastUpdatedAt).toBe(
      notificationTimes[2],
    );

    (manager as any).stopProgressReporter(task.id);
  });
});
