/**
 * @fileoverview Task #5060 — task_complete / task_cancel 必须内部同步写 `current_status`
 *
 * 背景（用户实测到的真缺陷）：
 *   `TaskComponent.completeTask()` 只设 status=completed + progress=100，
 *   **完全不碰 current_status** ⇒ 任务落终态后 current_status 仍停留在
 *   完成前的旧文案（如「按用户方案 X 决定暂停：改动已落盘未 commit」），
 *   出现 **status=completed / progress=100 / current_status=「还没做完」**
 *   的自相矛盾状态。为修 6 个任务不得不额外调 task_update(current_status=...)
 *   手工补 —— 这就是全局记忆里那条错误的 workaround 的来源。
 *
 * 本测试守住 5 件事：
 *   1. completeTask 后 current_status 非空且含「已完成」语义
 *   2. completeTask(id, sessionId, deliverable) 后 current_status 含该 deliverable 路径
 *   3. status === "completed" 且 progress === 100（回归保护）
 *   4. task_operation_list 仍能看到 completed operation（回归保护）
 *   5. task_cancel 后 current_status 含「已取消」语义（同类缺陷一并修）
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
import { listOperationsTool } from "./tools/operation/list-tool";
import { updateTaskTool } from "./tools/update-tool";

describe("Task #5060 — task_complete / task_cancel 同步写 current_status", () => {
  let taskComponent: TaskComponent;
  let parentTaskId: number;
  let dbPath: string;

  beforeEach(async () => {
    const configComponent = new ConfigComponent();
    taskComponent = new TaskComponent();
    dbPath = join(
      tmpdir(),
      `task-5060-current-status-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
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
    await taskComponent.stop();
    // Task #5060 review MINOR m4: 清理临时 DB（sqlite 还会带 -wal / -shm 副文件）
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
        title: "Task 5060",
        project_path: "unknown",
        context: "{}",
        ...extra,
      },
      { session_id: "sess_123" },
    );
    expect(res.success).toBe(true);
    return res.metadata!.task_id as number;
  }

  /** 模拟真实场景：先写一句「还没做完」的中间态文案，再完成 */
  async function seedStaleCurrentStatus(taskId: number, stale: string): Promise<void> {
    const res = await updateTaskTool(taskComponent).execute(
      { task_id: taskId, current_status: stale },
      { session_id: "sess_123" },
    );
    expect(res.success).toBe(true);
  }

  it("1. completeTask 后 current_status 非空且含「已完成」语义（覆盖 stale 文案）", async () => {
    const taskId = await makeTask();
    // 复现用户实测场景：完成前 current_status 是一句「还没做完」的中间态文案
    await seedStaleCurrentStatus(taskId, "按用户方案 3 决定暂停：改动已落盘未 commit");

    const res = await completeTaskTool(taskComponent).execute(
      { task_id: taskId },
      { session_id: "sess_123" },
    );
    expect(res.success).toBe(true);

    const task = res.metadata!.task as any;
    expect(task.current_status).toBeDefined();
    expect(typeof task.current_status).toBe("string");
    expect(task.current_status.length).toBeGreaterThan(0);
    // 终态语义：不能再留着「暂停 / 未 commit」这类中间态措辞
    expect(task.current_status).toContain("已完成");
    expect(task.current_status).not.toContain("决定暂停");
    expect(task.current_status).not.toContain("未 commit");
  });

  it("2. 交付物通道已迁移至 task_pre_complete（#5073 设计调整①）", async () => {
    const taskId = await makeTask();
    const deliverable = "/tmp/task5060-deliverable-report.md";

    // ★ #5073 设计调整①：deliverable_storage_path 从 task_complete
    //   移除 —— 交付物在 pre_complete 提交，complete 只做验收落定。
    //   验收通过路径：pre_complete（提交交付物）→ complete（落定）。
    //   complete 时 current_status 刷成「已完成」（deliverable 已在
    //   pre_complete 写进 context，complete 的已完成措辞覆盖即可）。
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

    // 交付物仍在 context（pre_complete 写入，complete 不丢失）
    const ctx = JSON.parse(task.context || "{}");
    expect(ctx.deliverable_storage_path).toBe(deliverable);
  });

  it("3. 回归保护：completeTask 后 status=completed 且 progress=100", async () => {
    const taskId = await makeTask();

    const res = await completeTaskTool(taskComponent).execute(
      { task_id: taskId },
      { session_id: "sess_123" },
    );
    expect(res.success).toBe(true);

    const task = res.metadata!.task as any;
    expect(task.status).toBe("completed");
    expect(task.progress).toBe(100);
  });

  it("4. 回归保护：current_status 更新后 task_operation_list 仍见 completed operation", async () => {
    const taskId = await makeTask();

    const res = await completeTaskTool(taskComponent).execute(
      { task_id: taskId, deliverable_storage_path: "/tmp/task5060-op.md" },
      { session_id: "sess_123" },
    );
    expect(res.success).toBe(true);

    const opsRes = await listOperationsTool(taskComponent).execute(
      { task_id: taskId },
      { session_id: "sess_123" },
    );
    expect(opsRes.success).toBe(true);

    const payload = JSON.parse(opsRes.output as string);
    expect(payload.count).toBeGreaterThan(0);
    const completed = payload.operations.filter(
      (op: any) => (op.milestoneType ?? op.actionType) === "completed",
    );
    expect(completed.length).toBeGreaterThan(0);
  });

  it("5. task_cancel 后 current_status 含「已取消」语义（同类缺陷一并修）", async () => {
    const taskId = await makeTask();
    await seedStaleCurrentStatus(taskId, "进度 80%，等评审结果");

    const res = await cancelTaskTool(taskComponent).execute(
      { task_id: taskId, reason: "用户明令取消" },
      { session_id: "sess_123" },
    );
    expect(res.success).toBe(true);

    const task = res.metadata!.task as any;
    expect(task.status).toBe("cancelled");
    expect(task.current_status).toBeDefined();
    expect(task.current_status).toContain("已取消");
    // Task #5060 review MINOR m3: reason 本身也要被守住 —— 丢掉 reason 会静默变绿
    expect(task.current_status).toContain("用户明令取消");
    // stale 文案必须被覆盖，不能与终态自相矛盾
    expect(task.current_status).not.toContain("等评审结果");
  });

  it("5b. task_cancel 无 reason 时 current_status 仍含「已取消」语义", async () => {
    const taskId = await makeTask();

    const res = await cancelTaskTool(taskComponent).execute(
      { task_id: taskId },
      { session_id: "sess_123" },
    );
    expect(res.success).toBe(true);

    const task = res.metadata!.task as any;
    expect(task.current_status).toContain("已取消");
  });

  it("6. 工具描述说明「工具会自己刷新 current_status」（避免使用者以为还要手工补）", () => {
    const completeDesc = completeTaskTool(taskComponent).description;
    expect(completeDesc).toContain("current_status");
    expect(completeDesc).toMatch(/do \*\*NOT\*\* need|无需|不需要/i);

    const cancelDesc = cancelTaskTool(taskComponent).description;
    expect(cancelDesc).toContain("current_status");
  });
});
