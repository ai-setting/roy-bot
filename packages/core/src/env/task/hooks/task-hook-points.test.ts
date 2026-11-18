/**
 * @fileoverview Task Hook Points Tests
 */

import { describe, test, expect } from "vitest";
import { TaskHookPoints } from "./task-hook-points";

describe("TaskHookPoints", () => {
  test("should export all task CRUD hook points", () => {
    expect(TaskHookPoints.BEFORE_CREATE).toBe("task:before.create");
    expect(TaskHookPoints.AFTER_CREATE).toBe("task:after.create");
    expect(TaskHookPoints.BEFORE_UPDATE).toBe("task:before.update");
    expect(TaskHookPoints.AFTER_UPDATE).toBe("task:after.update");
    expect(TaskHookPoints.BEFORE_DELETE).toBe("task:before.delete");
    expect(TaskHookPoints.AFTER_DELETE).toBe("task:after.delete");
  });

  test("should export delegate hook points", () => {
    expect(TaskHookPoints.DELEGATE_BEFORE).toBe("task:delegate:before");
    expect(TaskHookPoints.DELEGATE_AFTER).toBe("task:delegate:after");
  });

  test("should export operation hook points", () => {
    expect(TaskHookPoints.OPERATION_BEFORE_CREATE).toBe("task:operation:before.create");
    expect(TaskHookPoints.OPERATION_AFTER_CREATE).toBe("task:operation:after.create");
  });

  test("should export task complete hook point (added 2026-07-10)", () => {
    // AFTER_COMPLETE 是语义级别更高的完成 hook，区别于 AFTER_UPDATE（后者每次更新都触发）
    expect(TaskHookPoints.AFTER_COMPLETE).toBe("task:after.complete");
  });

  test("should have 11 hook points total", () => {
    const hookPoints = Object.values(TaskHookPoints);
    expect(hookPoints).toHaveLength(11);
  });
});
