/**
 * @fileoverview AFTER_COMPLETE hook 端到端集成测试
 *
 * ★ Task #5073（设计调整②）语义迁移：
 *   AFTER_COMPLETE 从「泛终态事件」收窄为「goal 检查触发点」，
 *   触发点唯一 = preCompleteTask（status=to_validate）。
 *   updateTask / completeTask **不再**触发它。
 *
 * 覆盖场景（按新语义重写）：
 *  - preCompleteTask 触发 AFTER_COMPLETE（terminalStatus=to_validate）
 *  - updateTask({status: 'completed'}) 不触发（设计调整②）
 *  - updateTask({status: 'failed'/'cancelled'/'timeout'}) 不触发
 *  - completeTask()（验收落定）不触发
 *  - updateTask({status: 'active'}) / progress-only 不触发
 *  - AFTER_UPDATE 仍正常触发
 *  - hook context 包含 task + changes + terminalStatus + sessionId
 *  - cycle 任务不能 pre_complete 也不触发
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { TaskComponent } from "./task-component";
import { ConfigComponent } from "../../config/config-component";
import { globalHookManager } from "../hook/global-hook-manager";
import { TaskHookPoints } from "./hooks/task-hook-points";
import type { TaskCompleteResultContext } from "./hooks/contexts";
import { join } from "path";
import { tmpdir } from "os";

interface HookCall {
  ctx: TaskCompleteResultContext;
  metadata: Record<string, unknown>;
  phase: "before" | "after";
  hookPoint: string;
}

describe("AFTER_COMPLETE hook (task:after.complete)", () => {
  let taskComponent: TaskComponent;
  let configComponent: ConfigComponent;
  let parentTaskId: number;
  let captured: HookCall[];
  let unregister: () => void;

  beforeEach(async () => {
    captured = [];

    // capture every AFTER_COMPLETE invocation
    const captureHook = {
      name: "test-after-complete-capture",
      priority: 0,
      execute: (rawCtx: any) => {
        // globalHookManager.execute wraps data as { data: ..., metadata: ..., phase: ..., hookPoint: ... }
        captured.push({
          ctx: rawCtx?.data ?? rawCtx,
          metadata: rawCtx?.metadata ?? {},
          phase: rawCtx?.phase ?? "after",
          hookPoint: rawCtx?.hookPoint ?? TaskHookPoints.AFTER_COMPLETE,
        });
        return Promise.resolve();
      },
    };

    globalHookManager.register(TaskHookPoints.AFTER_COMPLETE, captureHook);
    unregister = () => {
      globalHookManager.unregisterAll(TaskHookPoints.AFTER_COMPLETE);
    };

    configComponent = new ConfigComponent();
    taskComponent = new TaskComponent();
    await taskComponent.init({
      options: {
        configComponent,
        config: {
          storage: {
            type: "sqlite",
            dbPath: join(tmpdir(), `task-complete-hook-${Date.now()}-${Math.random()}.db`),
          },
        },
      },
    });

    const parentTask = await (taskComponent as any).store.createTask({
      title: "Parent",
      project_path: "unknown",
      context: "{}",
      sessionId: "init",
    });
    parentTaskId = parentTask.id;
  });

  afterEach(async () => {
    unregister();
    await taskComponent.stop();
  });

  // ===== GREEN 1: preCompleteTask fires AFTER_COMPLETE (goal-check) =====
  it("preCompleteTask fires AFTER_COMPLETE with terminalStatus='to_validate'", async () => {
    const task = await taskComponent.createTask({
      parent_task_id: parentTaskId,
      title: "to-be-submitted",
      sessionId: "sess-A",
      project_path: "/repo",
      context: "{}",
    });

    await taskComponent.preCompleteTask(task.id, "sess-A");

    expect(captured).toHaveLength(1);
    expect(captured[0]!.ctx.task.id).toBe(task.id);
    expect(captured[0]!.ctx.terminalStatus).toBe("to_validate");
    expect(captured[0]!.ctx.task.status).toBe("to_validate");
    expect(captured[0]!.hookPoint).toBe("task:after.complete");
  });

  // ===== GREEN 2: updateTask no longer fires AFTER_COMPLETE (any status) =====
  it.each([
    ["completed"],
    ["failed"],
    ["cancelled"],
    ["timeout"],
  ] as const)("updateTask(status=%s) does NOT fire AFTER_COMPLETE (design v2)", async (status) => {
    const task = await taskComponent.createTask({
      parent_task_id: parentTaskId,
      title: `no-fire-${status}`,
      sessionId: "sess-X",
      project_path: "/repo",
      context: "{}",
    });

    await taskComponent.updateTask(task.id, { status });

    expect(captured).toHaveLength(0);
  });

  it("does NOT fire AFTER_COMPLETE when status is 'active'", async () => {
    const task = await taskComponent.createTask({
      parent_task_id: parentTaskId,
      title: "active-stay",
      sessionId: "sess",
      project_path: "/repo",
      context: "{}",
    });
    await taskComponent.updateTask(task.id, { status: "active" });
    expect(captured).toHaveLength(0);
  });

  it("does NOT fire AFTER_COMPLETE on progress-only update", async () => {
    const task = await taskComponent.createTask({
      parent_task_id: parentTaskId,
      title: "progress-only",
      sessionId: "sess",
      project_path: "/repo",
      context: "{}",
    });
    await taskComponent.updateTask(task.id, { progress: 42 });
    expect(captured).toHaveLength(0);
  });

  // ===== GREEN 3: completeTask (acceptance commit) does NOT fire =====
  it("completeTask() (acceptance commit) does NOT fire AFTER_COMPLETE", async () => {
    const task = await taskComponent.createTask({
      parent_task_id: parentTaskId,
      title: "via-completeTask",
      sessionId: "sess-hl",
      project_path: "/repo",
      context: "{}",
    });
    // two-phase: submit first, then accept
    await taskComponent.preCompleteTask(task.id, "sess-hl");
    captured.length = 0;
    const completed = await taskComponent.completeTask(task.id, "sess-hl");
    expect(completed?.status).toBe("completed");
    expect(captured).toHaveLength(0);
  });

  // ===== GREEN 4: AFTER_UPDATE still fires =====
  it("AFTER_UPDATE still fires on status change", async () => {
    let updateCount = 0;
    const upHook = {
      name: "test-after-update-count",
      execute: () => { updateCount++; return Promise.resolve(); },
    };
    globalHookManager.register(TaskHookPoints.AFTER_UPDATE, upHook);
    try {
      const task = await taskComponent.createTask({
        parent_task_id: parentTaskId,
        title: "update-still-fires",
        sessionId: "sess",
        project_path: "/repo",
        context: "{}",
      });
      await taskComponent.updateTask(task.id, { status: "to_validate" });
      expect(updateCount).toBe(1);
      // AFTER_COMPLETE 不随 updateTask 触发（设计调整②：触发点唯一=
      // preCompleteTask）；updateTask 直接置 to_validate 只是普通状态迁移
      expect(captured).toHaveLength(0);
    } finally {
      globalHookManager.unregisterAll(TaskHookPoints.AFTER_UPDATE);
    }
  });

  // ===== GREEN 5: sessionId populated when env-context is set =====
  it("sessionId reflects env-context session when available", async () => {
    const { runWithEnvContext } = await import("../context/env-context");
    const task = await taskComponent.createTask({
      parent_task_id: parentTaskId,
      title: "env-ctx",
      sessionId: "env-session-xyz",
      project_path: "/repo",
      context: "{}",
    });

    await runWithEnvContext({ envEvent: { metadata: {} }, sessionId: "env-session-xyz" } as any, async () => {
      await taskComponent.preCompleteTask(task.id, "env-session-xyz");
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.ctx.sessionId).toBe("env-session-xyz");
  });

  // ===== GREEN 6: cycle-type task cannot be pre-completed =====
  it("does NOT fire AFTER_COMPLETE for a cycle task pre_complete", async () => {
    const cycle = await (taskComponent as any).store.createTask({
      title: "cycle-task",
      project_path: "/repo",
      context: "{}",
      sessionId: "sess",
      type: "cycle",
    });
    expect(() => taskComponent.preCompleteTask(cycle.id, "sess")).toThrow(/cycle/);
    expect(captured).toHaveLength(0);
  });
});
