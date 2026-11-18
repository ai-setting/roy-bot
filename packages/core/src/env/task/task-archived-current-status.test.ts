/**
 * @fileoverview Task #5063 — 终态 current_status 收口（archived / cancelled 出口）
 *
 * 背景（Task #5060 的 follow-up，DS review 留档 MINOR m2）：
 *   #5060 修掉了 `task_complete` / `task_cancel` 不写 `current_status` 的缺陷，
 *   但 **`archived` 是同一 bug 的第四个出口**，且**通用入口没修**：
 *
 *   1. `packages/cli/src/commands/tasks/complete.ts` — `tasks complete --archive`
 *      → `updateTask(id, { status: "archived" })`，**不写** current_status
 *   2. `packages/core/src/env/task/tools/batch-archive-tool.ts` — 批量归档
 *      → `updateTask(taskId, { status: "archived" })`，**不写**
 *   3. `packages/core/src/env/task/tools/update-tool.ts` — **通用更新工具**
 *      （zod enum 直接允许 archived/cancelled），原样透传，**不写**
 *
 *   ⇒ 走 archived 路径的任务，完成后 `current_status` 仍停在归档前的旧文案
 *     （如「调研中：检索 GitHub…」），与 #5060 修掉的 bug 一模一样，只是入口不同。
 *
 * 本测试守住 7 件事：
 *   1. `updateTask(id, { status: "archived" })` → current_status 含「已归档」语义
 *   2. `updateTask(id, { status: "cancelled" })` → current_status 含「已取消」语义
 *   3. 回归保护：非终态（active）+ 调用方显式传 current_status ⇒ **不被工具改写**
 *   4. 回归保护：只传 progress（不带 status）⇒ current_status **完全不变**
 *   5. 回归保护：`task_complete` 路径仍正常（已完成 + deliverable）
 *   6. 回归保护：`task_cancel` 路径仍正常（已取消 + reason）
 *   7. 端到端：`tasks complete --archive` → status=archived 且 current_status 含「已归档」
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { TaskComponent } from "./task-component";
import { ConfigComponent } from "../../config/config-component";
import { tmpdir } from "os";
import { join } from "path";
import { existsSync, unlinkSync } from "fs";
import { createTaskTool } from "./tools/create-tool";
import { completeTaskTool } from "./tools/complete-tool";
import { preCompleteTaskTool } from "./tools/pre-complete-tool";
import { cancelTaskTool } from "./tools/cancel-tool";
import { updateTaskTool } from "./tools/update-tool";
import { batchArchiveTaskTool } from "./tools/batch-archive-tool";
import { TASK_ARCHIVED_STATUS_WORD } from "./tools/completion-copy";
import { TaskHookPoints } from "./hooks/task-hook-points";

describe("Task #5063 — 终态 current_status 收口（archived / cancelled）", () => {
  let taskComponent: TaskComponent;
  let parentTaskId: number;
  let dbPath: string;
  /**
   * 本文件注册的 hook 名（用于 afterEach 清理）。
   * ⚠️ TaskComponent.registerHook 注册到**全局** hookManager，
   *    不注销会泄漏到同进程后续运行的其它测试文件。
   */
  const registeredHookNames: string[] = [];

  beforeEach(async () => {
    const configComponent = new ConfigComponent();
    taskComponent = new TaskComponent();
    dbPath = join(
      tmpdir(),
      `task-5063-archived-status-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    await taskComponent.init({
      options: {
        configComponent,
        config: {
          storage: {
            type: "sqlite",
            dbPath,
          },
        },
      },
    });

    const parentTask = await (taskComponent as any).store.createTask({
      title: "Parent Task",
      project_path: "unknown",
      context: "{}",
      sessionId: "sess_init",
    });
    parentTaskId = parentTask.id;
  });

  afterEach(async () => {
    // ⚠️ 必须在 stop() 之前注销本文件注册的 hook ——
    //    registerHook 写的是**全局** hookManager，不清理会污染同进程的其它测试文件。
    for (const hookName of registeredHookNames.splice(0)) {
      try {
        taskComponent.unregisterHook(TaskHookPoints.BEFORE_UPDATE, hookName);
      } catch {
        // 清理失败不影响测试结论
      }
    }
    await taskComponent.stop();
    // 清理临时 DB（sqlite 还会带 -wal / -shm 副文件）
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = `${dbPath}${suffix}`;
      if (existsSync(p)) {
        try {
          unlinkSync(p);
        } catch {
          // 清理失败不影响测试结论
        }
      }
    }
  });

  async function makeTask(extra: Record<string, unknown> = {}): Promise<number> {
    const res = await createTaskTool(taskComponent).execute(
      {
        parent_task_id: parentTaskId,
        title: "Task 5063",
        project_path: "unknown",
        context: "{}",
        ...extra,
      },
      { session_id: "sess_123" },
    );
    expect(res.success).toBe(true);
    return res.metadata!.task_id as number;
  }

  /** 模拟真实场景：先写一句「还在推进」的中间态文案，再落终态 */
  async function seedStaleCurrentStatus(
    taskId: number,
    stale: string,
  ): Promise<void> {
    const res = await updateTaskTool(taskComponent).execute(
      { task_id: taskId, current_status: stale },
      { session_id: "sess_123" },
    );
    expect(res.success).toBe(true);
  }

  it("1. updateTask(status=archived) 后 current_status 含「已归档」语义", async () => {
    const taskId = await makeTask();
    await seedStaleCurrentStatus(taskId, "调研中：检索 GitHub 仓库");

    const task = await taskComponent.updateTask(taskId, { status: "archived" });
    expect(task).toBeDefined();

    expect(task!.current_status).toBeDefined();
    expect(typeof task!.current_status).toBe("string");
    expect(task!.current_status.length).toBeGreaterThan(0);
    expect(task!.current_status).toContain(TASK_ARCHIVED_STATUS_WORD);
    expect(task!.current_status).not.toContain("调研中");
    // 回归保护：status 仍是 archived
    expect(task!.status).toBe("archived");
  });

  it("2. updateTask(status=cancelled) 后 current_status 含「已取消」语义", async () => {
    const taskId = await makeTask();
    await seedStaleCurrentStatus(taskId, "调研中：检索 GitHub 仓库");

    const task = await taskComponent.updateTask(taskId, { status: "cancelled" });
    expect(task).toBeDefined();

    expect(task!.current_status).toContain("已取消");
    expect(task!.current_status).not.toContain("调研中");
    expect(task!.status).toBe("cancelled");
  });

  it("3. 回归保护：非终态 + 调用方显式传 current_status 时不被工具改写", async () => {
    const taskId = await makeTask();

    const task = await taskComponent.updateTask(taskId, {
      status: "active",
      current_status: "推进中",
    });
    expect(task).toBeDefined();

    // 调用方显式传的值必须原样保留
    expect(task!.current_status).toBe("推进中");
    expect(task!.current_status).not.toContain("已归档");
    expect(task!.current_status).not.toContain("已取消");
    expect(task!.status).toBe("active");
  });

  it("4. 回归保护：只传 progress（不带 status）时 current_status 完全不变", async () => {
    const taskId = await makeTask();
    await seedStaleCurrentStatus(taskId, "原始文案");

    const task = await taskComponent.updateTask(taskId, { progress: 50 });
    expect(task).toBeDefined();

    expect(task!.current_status).toBe("原始文案");
    expect(task!.progress).toBe(50);
  });

  it("4b. 回归保护：非终态迁移时不得引入 current_status 键（字段存在性，非仅取值）", async () => {
    const taskId = await makeTask();

    // 直接调内部辅助方法，断言「非终态时 options 里根本没有 current_status 键」。
    // 只断言取值不变是不够的 —— 塞 `current_status: undefined` 也能让取值不变，
    // 但某些 store/port 用 `"current_status" in options` 判断字段存在性，
    // 会误判成「调用方要求清空 current_status」。
    const withTerminal = (taskComponent as any).withTerminalCurrentStatus.bind(
      taskComponent,
    );

    for (const nonTerminal of ["todo", "active", "paused"] as const) {
      const effective = withTerminal({ status: nonTerminal });
      expect(Object.prototype.hasOwnProperty.call(effective, "current_status")).toBe(
        false,
      );
      expect(effective.current_status).toBeUndefined();
    }

    // 没传 status ⇒ 也不该引入 current_status 键
    const noStatus = withTerminal({ progress: 10 });
    expect(
      Object.prototype.hasOwnProperty.call(noStatus, "current_status"),
    ).toBe(false);

    // 对照组：终态 ⇒ 必须有 current_status 键
    const archived = withTerminal({ status: "archived" });
    expect(
      Object.prototype.hasOwnProperty.call(archived, "current_status"),
    ).toBe(true);
    expect(archived.current_status).toBe(TASK_ARCHIVED_STATUS_WORD);
  });

  it("5. 回归保护：pre_complete → task_complete 验收路径（已完成 + deliverable 落 context）", async () => {
    const taskId = await makeTask();
    const deliverable = "/tmp/task5063-deliverable-report.md";

    // ★ #5073 设计调整①：交付物通道 = task_pre_complete；
    //   task_complete 只做验收落定（schema 已无 deliverable 入参）。
    const preRes = await preCompleteTaskTool(taskComponent).execute(
      { task_id: taskId, deliverable_storage_path: deliverable },
      { session_id: "sess_123" },
    );
    expect(preRes.success).toBe(true);

    const res = await completeTaskTool(taskComponent).execute(
      { task_id: taskId },
      { session_id: "sess_123" },
    );
    expect(res.success).toBe(true);

    const task = res.metadata!.task as any;
    expect(task.current_status).toContain("已完成");
    expect(task.status).toBe("completed");
    expect(task.progress).toBe(100);
    const ctx = JSON.parse(task.context || "{}");
    expect(ctx.deliverable_storage_path).toBe(deliverable);
  });

  it("6. 回归保护：task_cancel 路径仍正常（已取消 + reason）", async () => {
    const taskId = await makeTask();

    const res = await cancelTaskTool(taskComponent).execute(
      { task_id: taskId, reason: "用户明令中止" },
      { session_id: "sess_123" },
    );
    expect(res.success).toBe(true);

    const task = res.metadata!.task as any;
    expect(task.current_status).toContain("已取消");
    expect(task.current_status).toContain("用户明令中止");
    expect(task.status).toBe("cancelled");
  });

  it("7. 端到端：批量归档工具 → status=archived 且 current_status 含「已归档」", async () => {
    const taskId = await makeTask();
    await seedStaleCurrentStatus(taskId, "整理历史任务中");

    const res = await batchArchiveTaskTool(taskComponent).execute(
      { task_ids: [taskId], reason: "任务整理" },
      { session_id: "sess_123" },
    );
    expect(res.success).toBe(true);

    const task = await taskComponent.getTask(taskId);
    expect(task).toBeDefined();
    expect(task!.status).toBe("archived");
    expect(task!.current_status).toContain(TASK_ARCHIVED_STATUS_WORD);
    expect(task!.current_status).not.toContain("整理历史任务中");
    // 归档原因（reason）本身就是有用的终态文案 —— 必须带进 current_status
    expect(task!.current_status).toContain("任务整理");
  });

  it("8. 通用 task_update 工具直接设 archived/cancelled 也同步 current_status", async () => {
    const taskId = await makeTask();

    const archivedRes = await updateTaskTool(taskComponent).execute(
      { task_id: taskId, status: "archived" },
      { session_id: "sess_123" },
    );
    expect(archivedRes.success).toBe(true);
    expect((archivedRes.metadata!.task as any).current_status).toContain(
      TASK_ARCHIVED_STATUS_WORD,
    );

    const cancelledRes = await updateTaskTool(taskComponent).execute(
      { task_id: taskId, status: "cancelled" },
      { session_id: "sess_123" },
    );
    expect(cancelledRes.success).toBe(true);
    expect((cancelledRes.metadata!.task as any).current_status).toContain(
      "已取消",
    );
  });

  it("9. 回归保护：调用方显式传 current_status 时，终态也不被覆盖", async () => {
    const taskId = await makeTask();

    const task = await taskComponent.updateTask(taskId, {
      status: "archived",
      current_status: "已归档（任务整理批量清理）",
    });
    expect(task).toBeDefined();

    // 调用方显式给了文案 ⇒ 尊重调用方，不覆盖
    expect(task!.current_status).toBe("已归档（任务整理批量清理）");
  });

  /**
   * 10. 回归保护（DS review MAJOR M1）：task:before.update 钩子对 options 的
   *     修改必须能落库。
   *
   *     背景：hooks/contexts.ts:82 明确文档化「Plugin 可直接修改 options 来
   *     干预更新行为」—— 这是已文档化的公共扩展点。收口 current_status 时若
   *     在 hook **之前**快照派生（effectiveOptions = withTerminalCurrentStatus(
   *     options)），hook 的修改会被整包丢弃 ⇒ 静默废掉该扩展点。
   *
   *     本用例锁死：派生必须基于 hook 处理过的 updateCtx.options。
   *
   *     ⚠️ 注意：TaskComponent.registerHook 注册到**全局** hookManager，
   *        不注销会泄漏到同进程后续跑的其它测试文件（实测污染 task-tools.test.ts）。
   *        故本用例必须在 afterEach 里 unregisterHook 清理。
   */
  it("10. 回归保护：before.update 钩子修改 options 后能落库（DS review MAJOR M1）", async () => {
    const taskId = await makeTask();

    // 注册一个 BEFORE_UPDATE 钩子，模拟插件修改 options
    taskComponent.registerHook(TaskHookPoints.BEFORE_UPDATE, {
      name: "test-before-update-mutator",
      priority: 100,
      execute: async (ctx: any) => {
        const data =
          ctx && typeof ctx === "object" && "data" in ctx ? ctx.data : ctx;
        if (data && data.options) {
          data.options.title = "标题被钩子改写";
        }
      },
    } as any);
    registeredHookNames.push("test-before-update-mutator");

    await taskComponent.updateTask(taskId, { progress: 10 });

    const reread = await taskComponent.getTask(taskId);
    expect(reread).toBeDefined();
    // 钩子的修改必须真的落库（MAJOR M1 的核心断言）
    expect(reread!.title).toBe("标题被钩子改写");
  });

  /**
   * 11. 回归保护：钩子与终态收口同时生效 ——
   *     钩子改了 options（title）且本次更新是终态迁移 ⇒ 两边都要生效：
   *     钩子的 title 落库 + 本层派生的 current_status 落库。
   */
  it("11. 回归保护：钩子改 options + 终态迁移，两者同时生效", async () => {
    const taskId = await makeTask();

    taskComponent.registerHook(TaskHookPoints.BEFORE_UPDATE, {
      name: "test-before-update-mutator-terminal",
      priority: 100,
      execute: async (ctx: any) => {
        const data =
          ctx && typeof ctx === "object" && "data" in ctx ? ctx.data : ctx;
        if (data && data.options) {
          data.options.title = "标题被钩子改写（终态）";
        }
      },
    } as any);
    registeredHookNames.push("test-before-update-mutator-terminal");

    const task = await taskComponent.updateTask(taskId, { status: "archived" });
    expect(task).toBeDefined();
    expect(task!.title).toBe("标题被钩子改写（终态）");
    // 本层派生的终态文案仍然生效
    expect(task!.current_status).toContain(TASK_ARCHIVED_STATUS_WORD);
  });
});
