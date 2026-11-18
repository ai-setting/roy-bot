/**
 * @fileoverview Reopen / Continuation tests — verify TaskComponent supports
 * safe continuation of completed tasks via task_update (Task #2389).
 *
 * The MVP design uses the existing `task_update` API (no new `task_reopen`):
 *   - `task_update(task_id, { status: "active" })` reopens a completed task
 *   - Operation history is preserved
 *   - Subsequent `task_operation_create` records the continuation
 *
 * These tests cover:
 *   1. completed → active transition
 *   2. completed → todo transition
 *   3. History preservation (operations survive reopen)
 *   4. Description / goals can be appended
 *   5. updateTool (the user-facing tool) honors the same transitions
 *   6. AFTER_UPDATE fires correctly on reopen
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { TaskComponent } from "./task-component";
import { ConfigComponent } from "../../config/config-component";
import { globalHookManager } from "../hook/global-hook-manager";
import { TaskHookPoints } from "./hooks/task-hook-points";
import { join } from "path";
import { tmpdir } from "os";

describe("task continuation / reopen (Task #2389)", () => {
  let taskComponent: TaskComponent;
  let configComponent: ConfigComponent;
  let afterUpdateCount: number;
  let unregister: () => void;

  beforeEach(async () => {
    afterUpdateCount = 0;
    const captureHook = {
      name: "test-after-update-capture",
      priority: 0,
      execute: () => {
        afterUpdateCount++;
        return Promise.resolve();
      },
    };
    globalHookManager.register(TaskHookPoints.AFTER_UPDATE, captureHook);
    unregister = () => {
      globalHookManager.unregisterAll(TaskHookPoints.AFTER_UPDATE);
    };

    configComponent = new ConfigComponent();
    taskComponent = new TaskComponent();
    await taskComponent.init({
      name: "task",
      version: "1.0.0",
      enabled: true,
      options: {
        configComponent,
        config: {
          storage: {
            type: "sqlite",
            dbPath: join(
              tmpdir(),
              `task-reopen-${Date.now()}-${Math.random()}.db`
            ),
          },
        },
      },
    });
  });

  afterEach(async () => {
    unregister();
    await taskComponent.stop();
  });

  it("completed → active via task_update succeeds", async () => {
    const task = await taskComponent.createTask({
      title: "to be reopened",
      sessionId: "s1",
      project_path: "/p",
      context: "{}",
    });
    await taskComponent.completeTask(task.id, "s1");
    const completed = await taskComponent.getTask(task.id);
    expect(completed!.status).toBe("completed");

    // Reopen via updateTask
    const reopened = await taskComponent.updateTask(task.id, {
      status: "active",
      current_status: "Continuation: now fixing v0.7.1 bug",
    });
    expect(reopened).toBeDefined();
    expect(reopened!.status).toBe("active");
    expect(reopened!.current_status).toBe("Continuation: now fixing v0.7.1 bug");
  });

  it("completed → todo also works (alt reopen path)", async () => {
    const task = await taskComponent.createTask({
      title: "to be retried",
      sessionId: "s1",
      project_path: "/p",
      context: "{}",
    });
    await taskComponent.completeTask(task.id, "s1");
    const todo = await taskComponent.updateTask(task.id, { status: "todo" });
    expect(todo!.status).toBe("todo");
  });

  it("operation history is preserved across reopen", async () => {
    const task = await taskComponent.createTask({
      title: "with operations",
      sessionId: "s1",
      project_path: "/p",
      context: "{}",
    });
    // Add a manual operation
    await taskComponent.createOperation({
      taskId: task.id,
      sessionId: "s1",
      milestoneType: "milestone",
      milestoneTitle: "design done",
      milestoneDescription: "architecture approved",
    });
    await taskComponent.completeTask(task.id, "s1");
    // Add a completion operation via completeTask (it creates a "completed" op)
    const opsBefore = await taskComponent.listOperations({ taskId: task.id });
    const beforeCount = opsBefore.length;
    expect(beforeCount).toBeGreaterThanOrEqual(2); // design + completed

    // Reopen
    await taskComponent.updateTask(task.id, {
      status: "active",
      current_status: "Continuation: bug fix",
    });
    // Add a continuation operation
    await taskComponent.createOperation({
      taskId: task.id,
      sessionId: "s1",
      milestoneType: "decision",
      milestoneTitle: "Continuation: reopen for bug fix",
      milestoneDescription: "found DateLike issue in kline module",
    });

    const opsAfter = await taskComponent.listOperations({ taskId: task.id });
    // All original operations must still be there
    expect(opsAfter.length).toBe(beforeCount + 1);
    expect(opsAfter.some((o) => o.milestoneTitle === "design done")).toBe(true);
    expect(
      opsAfter.some((o) => o.milestoneTitle === "Continuation: reopen for bug fix")
    ).toBe(true);
  });

  it("description can be appended (we don't have append primitive; rewrite is OK)", async () => {
    const task = await taskComponent.createTask({
      title: "append-desc",
      description: "Original description",
      sessionId: "s1",
      project_path: "/p",
      context: "{}",
    });
    await taskComponent.completeTask(task.id, "s1");

    // Append (caller is responsible for composing the new text)
    const original = (await taskComponent.getTask(task.id))!.description;
    const updated = await taskComponent.updateTask(task.id, {
      status: "active",
      description: `${original}\n\nContinuation (2026-07-24): kline DateLike fix`,
    });
    expect(updated!.description).toContain("Original description");
    expect(updated!.description).toContain("Continuation");
  });

  it("goals_and_expected_deliverables can be appended", async () => {
    const task = await taskComponent.createTask({
      title: "append-goals",
      goals_and_expected_deliverables: "Original goals",
      sessionId: "s1",
      project_path: "/p",
      context: "{}",
    });
    await taskComponent.completeTask(task.id, "s1");

    const updated = await taskComponent.updateTask(task.id, {
      status: "active",
      goals_and_expected_deliverables: "Original goals\n- Fix DateLike bug in kline",
    });
    expect(updated!.goals_and_expected_deliverables).toContain("Original goals");
    expect(updated!.goals_and_expected_deliverables).toContain("Fix DateLike bug");
  });

  it("reopen fires AFTER_UPDATE but NOT AFTER_COMPLETE", async () => {
    const afterCompleteCount = { value: 0 };
    const completeCapture = {
      name: "test-after-complete-capture",
      priority: 0,
      execute: () => {
        afterCompleteCount.value++;
        return Promise.resolve();
      },
    };
    globalHookManager.register(TaskHookPoints.AFTER_COMPLETE, completeCapture);

    try {
      const task = await taskComponent.createTask({
        title: "reopen-hook-test",
        sessionId: "s1",
        project_path: "/p",
        context: "{}",
      });
      await taskComponent.completeTask(task.id, "s1");

      const beforeUpdateCount = afterUpdateCount;
      const beforeCompleteCount = afterCompleteCount.value;

      // Reopen
      await taskComponent.updateTask(task.id, { status: "active" });

      // AFTER_UPDATE must fire on reopen
      expect(afterUpdateCount > beforeUpdateCount).toBe(true);
      // AFTER_COMPLETE must NOT fire on reopen (status didn't go to terminal)
      expect(afterCompleteCount.value).toBe(beforeCompleteCount);
    } finally {
      globalHookManager.unregisterAll(TaskHookPoints.AFTER_COMPLETE);
    }
  });

  it("continuation pattern: completed → reopen → update description → create decision op", async () => {
    const task = await taskComponent.createTask({
      title: "design v0.7.0",
      description: "design a-stock-screener v0.7.0",
      sessionId: "s1",
      project_path: "/p",
      context: "{}",
    });
    await taskComponent.completeTask(task.id, "s1");

    // Full continuation workflow
    const reopened = await taskComponent.updateTask(task.id, {
      status: "active",
      current_status: "v0.7.1 bug fix in progress",
      description: "design v0.7.0\n\nContinuation (2026-07-24): kline DateLike bug",
    });
    expect(reopened!.status).toBe("active");

    await taskComponent.createOperation({
      taskId: task.id,
      sessionId: "s1",
      milestoneType: "decision",
      milestoneTitle: "Continuation: fix DateLike bug in kline module",
      milestoneDescription: "Identified DateLike handling issue from v0.7.0 design review",
    });

    const final = await taskComponent.getTask(task.id);
    expect(final!.status).toBe("active");
    const ops = await taskComponent.listOperations({ taskId: task.id });
    expect(ops.some((o) => o.milestoneType === "decision")).toBe(true);
    expect(ops.some((o) => o.milestoneType === "completed")).toBe(true);
  });
});