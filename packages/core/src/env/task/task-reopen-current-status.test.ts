/**
 * @fileoverview Task #5067 — reopen 反向迁移的 current_status 陈旧文案收口
 *
 * 背景（Task #5063 DS review 留档 MINOR m1）：
 *   #5063 在 TaskComponent 层统一收口了「status 迁移到**终态**时刷新
 *   current_status」，三条规则：①只在迁入终态时刷 ②调用方显式传了
 *   current_status 就尊重调用方 ③status 缺省时一律不动。
 *
 *   但**反向**路径没覆盖：「任务从终态被 reopen 回非终态」时，
 *   current_status 仍停在终态文案（"已归档" / "已取消" / "已完成"），
 *   于是又出现同一类矛盾：
 *
 *       status: active
 *       current_status: "已归档"     ← 说反了
 *
 *   m1 属 main 既有行为、**非 #5063 引入的回归**（#5063 验收标准 2/4
 *   明确要求「非终态迁移不碰 current_status」），本任务单独收口。
 *
 * ⚠️ 与规则 1/2 的边界（必须保持，测试锁死）：
 *   - 规则 1 说的「非终态迁移不碰 current_status」指的是**普通进度更新**
 *     （如 `task_update(current_status="推进中")`）—— 那必须**保留调用方
 *     显式传的值**。
 *   - 但**从终态 reopen 回非终态**时，current_status 里留着的是
 *     **系统自己写的终态文案**，不是调用方的意图 ⇒ 这种情况**应该**被刷新。
 *
 * 修法（落在 withTerminalCurrentStatus 内，不在调用点打补丁）：
 *   **A 增强版 = 值比对（startsWith 终态锚点）+ 前态 status 必须是终态**
 *   两个条件同时成立才替换成 reopen 措辞。为什么要加「前态 status」条件：
 *     只看值的话，active 任务上手写的「已完成的部分：A/B/C」会被误判成
 *     陈旧终态文案而被冲掉。加上前态判定后，只有**真的从终态迁出**时才动。
 *
 * 本测试守住 8 件事：
 *   1. archived → active ⇒ current_status 不再是「已归档」
 *   2. cancelled → active ⇒ current_status 不再是「已取消」
 *   3. completed → active ⇒ current_status 不再是「已完成」
 *   4. 回归保护：调用方显式传 current_status ⇒ **不被覆盖**
 *   5. 回归保护：只传 progress（不带 status）⇒ current_status 完全不变
 *   6. 回归保护：迁入终态的行为不变（#5063 的三条终态断言仍成立）
 *   7. 回归保护：before.update 钩子改 options 仍能落库（#5063 的 M1 教训）
 *   8. 回归保护：前态**非终态**时，形似终态文案的 current_status 不被误冲
 *      （锁住「值比对 + 前态 status」双条件里的**前态条件**本身）
 *   9. 回归保护：终态 current_status 是**调用方自己写的**时，reopen 不覆盖
 *      （锁住「值比对 + 前态 status」双条件里的**值比对条件**本身）
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { TaskComponent } from "./task-component";
import { ConfigComponent } from "../../config/config-component";
import { tmpdir } from "os";
import { join } from "path";
import { existsSync, unlinkSync } from "fs";
import { createTaskTool } from "./tools/create-tool";
import { updateTaskTool } from "./tools/update-tool";
import { completeTaskTool } from "./tools/complete-tool";
import {
  TASK_ARCHIVED_STATUS_WORD,
  TASK_CANCELLED_STATUS_WORD,
  TASK_COMPLETED_STATUS_WORD,
  TASK_REOPENED_STATUS_WORD,
} from "./tools/completion-copy";
import { TaskHookPoints } from "./hooks/task-hook-points";

describe("Task #5067 — reopen 反向迁移的 current_status 收口", () => {
  let taskComponent: TaskComponent;
  let parentTaskId: number;
  let dbPath: string;
  /**
   * 本文件注册的 hook 名（用于 afterEach 清理）。
   * ⚠️ TaskComponent.registerHook 注册到**全局** hookManager，
   *    不注销会泄漏到同进程后续运行的其它测试文件（#5063 r2 实测污染）。
   */
  const registeredHookNames: string[] = [];

  beforeEach(async () => {
    const configComponent = new ConfigComponent();
    taskComponent = new TaskComponent();
    dbPath = join(
      tmpdir(),
      `task-5067-reopen-status-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
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
        title: "Task 5067",
        project_path: "unknown",
        context: "{}",
        ...extra,
      },
      { session_id: "sess_123" },
    );
    expect(res.success).toBe(true);
    return res.metadata!.task_id as number;
  }

  /** 先写一句中间态文案（模拟真实推进中的任务） */
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

  /** 把任务推进到终态（archived 走 updateTask，cancelled/completed 走工具） */
  async function driveToTerminal(
    taskId: number,
    terminal: "archived" | "cancelled" | "completed",
  ): Promise<void> {
    if (terminal === "archived") {
      const res = await taskComponent.updateTask(taskId, { status: "archived" });
      expect(res).toBeDefined();
      return;
    }
    if (terminal === "cancelled") {
      const res = await updateTaskTool(taskComponent).execute(
        { task_id: taskId, status: "cancelled" },
        { session_id: "sess_123" },
      );
      expect(res.success).toBe(true);
      return;
    }
    const res = await completeTaskTool(taskComponent).execute(
      { task_id: taskId },
      { session_id: "sess_123" },
    );
    expect(res.success).toBe(true);
  }

  it("1. archived → active：current_status 不再是「已归档」", async () => {
    const taskId = await makeTask();
    await seedStaleCurrentStatus(taskId, "调研中：检索 GitHub 仓库");
    await driveToTerminal(taskId, "archived");

    const before = await taskComponent.getTask(taskId);
    expect(before!.status).toBe("archived");
    expect(before!.current_status).toContain(TASK_ARCHIVED_STATUS_WORD);

    // reopen：终态 → 非终态
    const reopened = await taskComponent.updateTask(taskId, { status: "active" });
    expect(reopened).toBeDefined();

    expect(reopened!.status).toBe("active");
    // 核心断言：不再是陈旧的终态文案
    expect(reopened!.current_status).not.toContain(TASK_ARCHIVED_STATUS_WORD);
    // 且渲染出来不是空白
    expect(reopened!.current_status.trim().length).toBeGreaterThan(0);
    // 措辞是 reopen 语义
    expect(reopened!.current_status).toBe(TASK_REOPENED_STATUS_WORD);
  });

  it("2. cancelled → active：current_status 不再是「已取消」", async () => {
    const taskId = await makeTask();
    await seedStaleCurrentStatus(taskId, "调研中：检索 GitHub 仓库");
    await driveToTerminal(taskId, "cancelled");

    const before = await taskComponent.getTask(taskId);
    expect(before!.status).toBe("cancelled");
    expect(before!.current_status).toContain(TASK_CANCELLED_STATUS_WORD);

    const reopened = await taskComponent.updateTask(taskId, { status: "active" });
    expect(reopened).toBeDefined();

    expect(reopened!.status).toBe("active");
    expect(reopened!.current_status).not.toContain(TASK_CANCELLED_STATUS_WORD);
    expect(reopened!.current_status.trim().length).toBeGreaterThan(0);
    expect(reopened!.current_status).toBe(TASK_REOPENED_STATUS_WORD);
  });

  it("3. completed → active：current_status 不再是「已完成」", async () => {
    const taskId = await makeTask();
    await seedStaleCurrentStatus(taskId, "调研中：检索 GitHub 仓库");
    await driveToTerminal(taskId, "completed");

    const before = await taskComponent.getTask(taskId);
    expect(before!.status).toBe("completed");
    expect(before!.current_status).toContain(TASK_COMPLETED_STATUS_WORD);

    const reopened = await taskComponent.updateTask(taskId, { status: "active" });
    expect(reopened).toBeDefined();

    expect(reopened!.status).toBe("active");
    expect(reopened!.current_status).not.toContain(TASK_COMPLETED_STATUS_WORD);
    expect(reopened!.current_status.trim().length).toBeGreaterThan(0);
    expect(reopened!.current_status).toBe(TASK_REOPENED_STATUS_WORD);
  });

  it("4. 回归保护：reopen 时调用方显式传 current_status ⇒ 不被覆盖", async () => {
    const taskId = await makeTask();
    await driveToTerminal(taskId, "archived");

    const reopened = await taskComponent.updateTask(taskId, {
      status: "active",
      current_status: "推进中",
    });
    expect(reopened).toBeDefined();

    // 调用方显式传的值必须原样保留
    expect(reopened!.current_status).toBe("推进中");
    expect(reopened!.status).toBe("active");
  });

  it("5. 回归保护：只传 progress（不带 status）⇒ current_status 完全不变", async () => {
    const taskId = await makeTask();
    await seedStaleCurrentStatus(taskId, "原始文案");

    const updated = await taskComponent.updateTask(taskId, { progress: 50 });
    expect(updated).toBeDefined();

    expect(updated!.current_status).toBe("原始文案");
    expect(updated!.progress).toBe(50);
  });

  it("6. 回归保护：迁入终态的行为不变（#5063 三条终态断言）", async () => {
    // 6a. archived
    const archivedId = await makeTask();
    await seedStaleCurrentStatus(archivedId, "调研中：检索 GitHub 仓库");
    const archived = await taskComponent.updateTask(archivedId, {
      status: "archived",
    });
    expect(archived!.status).toBe("archived");
    expect(archived!.current_status).toBe(TASK_ARCHIVED_STATUS_WORD);

    // 6b. cancelled
    const cancelledId = await makeTask();
    await seedStaleCurrentStatus(cancelledId, "调研中：检索 GitHub 仓库");
    const cancelled = await taskComponent.updateTask(cancelledId, {
      status: "cancelled",
    });
    expect(cancelled!.status).toBe("cancelled");
    expect(cancelled!.current_status).toBe(TASK_CANCELLED_STATUS_WORD);

    // 6c. completed
    const completedId = await makeTask();
    await seedStaleCurrentStatus(completedId, "调研中：检索 GitHub 仓库");
    const completed = await taskComponent.updateTask(completedId, {
      status: "completed",
    });
    expect(completed!.status).toBe("completed");
    expect(completed!.current_status).toBe(TASK_COMPLETED_STATUS_WORD);
  });

  it("9. 回归保护：终态文案是**调用方自己写的**时，reopen 不覆盖（锁住「值比对」条件）", async () => {
    // 这条锁住「值比对 + 前态 status」双条件里的**值比对条件**本身。
    // 场景：归档时调用方显式传了自己的 current_status（「调研完成，等评审」），
    //   它不是系统写的终态文案 ⇒ reopen 时**不该**被系统措辞覆盖。
    //   （否则会破坏规则 2「尊重调用方显式传的值」的语义。）
    const taskId = await makeTask();
    await taskComponent.updateTask(taskId, {
      status: "archived",
      current_status: "调研完成，等评审",
    });

    const before = await taskComponent.getTask(taskId);
    expect(before!.status).toBe("archived");
    expect(before!.current_status).toBe("调研完成，等评审"); // 非系统终态文案

    const reopened = await taskComponent.updateTask(taskId, { status: "active" });
    expect(reopened).toBeDefined();

    expect(reopened!.status).toBe("active");
    expect(reopened!.current_status).toBe("调研完成，等评审");
  });

  it("8. 回归保护：前态**不是**终态时，即使 current_status 形似终态文案也不动（误判边界）", async () => {
    // 这条锁住「值比对 + 前态 status」双条件里的**前态条件**。
    // 场景：任务当前是 active（非终态），用户手动写了「已完成的部分：A/B/C」
    //   —— 它以终态锚点「已完成」开头，**只**靠值比对会被误判成陈旧终态文案
    //   而被冲掉。加上「前态 status 必须是终态」后，这种情况必须原样保留。
    const taskId = await makeTask();
    await seedStaleCurrentStatus(taskId, "已完成的部分：A/B/C");

    const before = await taskComponent.getTask(taskId);
    expect(before!.status).toBe("todo"); // 前态非终态（新建任务默认 todo）

    const updated = await taskComponent.updateTask(taskId, { status: "todo" });
    expect(updated).toBeDefined();

    expect(updated!.status).toBe("todo");
    // 调用方自己写的文案必须原样保留，不能被系统措辞冲掉
    expect(updated!.current_status).toBe("已完成的部分：A/B/C");
  });

  it("7. 回归保护：before.update 钩子改 options 仍能落库（#5063 M1 教训）", async () => {
    const taskId = await makeTask();

    taskComponent.registerHook(TaskHookPoints.BEFORE_UPDATE, {
      name: "test-5067-before-update-mutator",
      priority: 100,
      execute: async (ctx: any) => {
        const data =
          ctx && typeof ctx === "object" && "data" in ctx ? ctx.data : ctx;
        if (data && data.options) {
          data.options.title = "标题被钩子改写";
        }
      },
    } as any);
    registeredHookNames.push("test-5067-before-update-mutator");

    const updated = await taskComponent.updateTask(taskId, {
      status: "active",
      title: "原标题",
    });
    expect(updated).toBeDefined();

    // 钩子的修改必须落库 —— 派生不能基于 hook 之前的快照
    expect(updated!.title).toBe("标题被钩子改写");
  });
});
