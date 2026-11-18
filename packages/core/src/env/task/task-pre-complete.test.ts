/**
 * @fileoverview Task #5073 — task_pre_complete 两阶段验收（RED → GREEN）
 *
 * 需求（用户 2026-11-06 飞书）：
 *   「给 subagent 添加一个跟 task_complete 类似的工具，比如 task_pre_complete，
 *     sub agent 觉得可以完成了就传入交付物等参数，task 状态变为待验证
 *     （to_validate），default agent 调用 task_complete 校验之后状态正式完成。」
 *
 * 需求修正（同日）：状态机 = 现有 6 态 + to_validate（7 态），不删任何旧状态。
 *
 * 设计调整 v2（用户 2026-11-06 二次补充）：
 *   ① task_complete 精简为纯验收 —— deliverable_storage_path 入参删除
 *     （交付物只在 pre_complete 提交），complete 只做状态落定验收；
 *   ② decision model（goal 检查 / AFTER_COMPLETE hook）从 task_complete
 *     挪到 task_pre_complete —— pre_complete 阶段触发 AFTER_COMPLETE
 *     （sub-agent 自查关）；complete 不再触发。
 *
 * 本测试守住 14 件事：
 *   1.  TaskStatusEnum 含 to_validate，且现有 6 态全部保留（7 态）
 *   2.  task_pre_complete 工具已注册（TaskComponent.registerTools）
 *   3.  pre_complete 后 status === "to_validate"，progress 不强制改
 *   4.  pre_complete 后 current_status 含「待验证」语义（同源锚点）
 *   5.  pre_complete 带 deliverable_storage_path ⇒ 写入 task.context
 *       + operation 记录含 Deliverable 行
 *   6.  pre_complete 写 operation 记录（待验证里程碑）
 *   7.  cycle 类型任务不能 pre_complete
 *   8.  task_complete 护栏：from cancelled/archived 拒绝（已终态不可验收）
 *   9.  task_complete 护栏：from to_validate 放行（规范路径）→ completed
 *   10. pre_complete 幂等/重复调用安全（重复提交覆盖同一语义）
 *   11. task_complete 不再接受 deliverable_storage_path 入参（设计调整①）
 *   12. pre_complete 触发 AFTER_COMPLETE（goal 检查自查关，设计调整②）
 *   13. completeTask（验收落定）不再触发 AFTER_COMPLETE（设计调整②）
 *   14. CLI completeTask(deliverable) 兼容保留（非 tool 通道不破坏）
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
import { TaskStatusEnum } from "./types";
import {
  TASK_TO_VALIDATE_STATUS_WORD,
  TASK_COMPLETED_STATUS_WORD,
} from "./tools/completion-copy";

describe("Task #5073 — task_pre_complete 两阶段验收", () => {
  let taskComponent: TaskComponent;
  let dbPath: string;

  beforeEach(async () => {
    const configComponent = new ConfigComponent();
    taskComponent = new TaskComponent();
    dbPath = join(
      tmpdir(),
      `task-5073-pre-complete-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
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
  });

  afterEach(async () => {
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
        title: "Task 5073",
        project_path: "unknown",
        context: "{}",
        ...extra,
      },
      { session_id: "sess_5073" },
    );
    expect(res.success).toBe(true);
    return res.metadata!.task_id as number;
  }

  it("1. TaskStatusEnum 含 to_validate，且现有 6 态全部保留（7 态）", () => {
    for (const s of [
      "todo",
      "active",
      "to_validate",
      "completed",
      "paused",
      "cancelled",
      "archived",
    ]) {
      expect(TaskStatusEnum.parse(s)).toBe(s);
    }
    // 旧状态没有被删（需求修正：不删 paused/cancelled/archived）
    expect(() => TaskStatusEnum.parse("paused")).not.toThrow();
    expect(() => TaskStatusEnum.parse("cancelled")).not.toThrow();
    expect(() => TaskStatusEnum.parse("archived")).not.toThrow();
  });

  it("2. task_pre_complete 工具已注册", async () => {
    const registered: string[] = [];
    const fakeToolComponent = {
      register: (t: any) => {
        registered.push(t.name);
      },
    };
    (taskComponent as any).toolComponent = fakeToolComponent;
    await (taskComponent as any).registerTools();
    expect(registered).toContain("task_pre_complete");
  });

  it("3. pre_complete 后 status === 'to_validate'", async () => {
    const taskId = await makeTask();
    const res = await preCompleteTaskTool(taskComponent).execute(
      { task_id: taskId },
      { session_id: "sess_5073" },
    );
    expect(res.success).toBe(true);
    const task = res.metadata!.task as any;
    expect(task.status).toBe("to_validate");
  });

  it("4. pre_complete 后 current_status 含「待验证」语义（同源锚点）", async () => {
    const taskId = await makeTask();
    const res = await preCompleteTaskTool(taskComponent).execute(
      { task_id: taskId, current_status: "实现完成，测试全绿" },
      { session_id: "sess_5073" },
    );
    expect(res.success).toBe(true);
    const task = res.metadata!.task as any;
    expect(task.current_status).toContain(TASK_TO_VALIDATE_STATUS_WORD);
    // 调用方给的补充说明保留
    expect(task.current_status).toContain("实现完成");
  });

  it("5. pre_complete 带 deliverable ⇒ context 持久化 + operation 含 Deliverable 行", async () => {
    const taskId = await makeTask();
    const deliverable = "/tmp/5073-deliverable.md";
    const res = await preCompleteTaskTool(taskComponent).execute(
      { task_id: taskId, deliverable_storage_path: deliverable },
      { session_id: "sess_5073" },
    );
    expect(res.success).toBe(true);

    const task = await taskComponent.getTask(taskId);
    expect(task).toBeDefined();
    const ctx = JSON.parse(task!.context || "{}");
    expect(ctx.deliverable_storage_path).toBe(deliverable);

    const ops = await taskComponent.listOperations({ taskId, limit: 200 });
    const deliverableOp = ops.find(
      (o) =>
        (o.milestoneDescription || "").includes("Deliverable:") &&
        (o.milestoneDescription || "").includes(deliverable),
    );
    expect(deliverableOp).toBeDefined();
  });

  it("6. pre_complete 写 operation 记录（待验证里程碑）", async () => {
    const taskId = await makeTask();
    await preCompleteTaskTool(taskComponent).execute(
      { task_id: taskId },
      { session_id: "sess_5073" },
    );
    const ops = await taskComponent.listOperations({ taskId, limit: 200 });
    const milestoneOp = ops.find(
      (o) =>
        (o.milestoneTitle || "").includes("待验证") ||
        (o.milestoneTitle || "").toLowerCase().includes("pre-complete"),
    );
    expect(milestoneOp).toBeDefined();
  });

  it("7. cycle 类型任务不能 pre_complete", async () => {
    const taskId = await makeTask({ type: "cycle" });
    const res = await preCompleteTaskTool(taskComponent).execute(
      { task_id: taskId },
      { session_id: "sess_5073" },
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/cycle/i);
  });

  it("8. task_complete 护栏：from cancelled/archived 拒绝（已终态不可验收）", async () => {
    const t1 = await makeTask();
    await cancelTaskTool(taskComponent).execute(
      { task_id: t1, reason: "用户明令" },
      { session_id: "sess_5073" },
    );
    const res1 = await completeTaskTool(taskComponent).execute(
      { task_id: t1 },
      { session_id: "sess_5073" },
    );
    expect(res1.success).toBe(false);
    expect(res1.error).toMatch(/terminal|终态/);

    const t2 = await makeTask();
    await taskComponent.updateTask(t2, { status: "archived" });
    const res2 = await completeTaskTool(taskComponent).execute(
      { task_id: t2 },
      { session_id: "sess_5073" },
    );
    expect(res2.success).toBe(false);
    expect(res2.error).toMatch(/terminal|终态/);
  });

  it("9. task_complete 护栏：from to_validate 放行（规范路径）→ completed", async () => {
    const taskId = await makeTask();
    await preCompleteTaskTool(taskComponent).execute(
      { task_id: taskId },
      { session_id: "sess_5073" },
    );
    const res = await completeTaskTool(taskComponent).execute(
      { task_id: taskId, deliverable_storage_path: "/tmp/d.md" },
      { session_id: "sess_5073" },
    );
    expect(res.success).toBe(true);
    const task = res.metadata!.task as any;
    expect(task.status).toBe("completed");
    expect(task.current_status).toContain(TASK_COMPLETED_STATUS_WORD);
  });

  it("10. pre_complete 重复提交安全（覆盖同一语义，不抛错）", async () => {
    const taskId = await makeTask();
    const r1 = await preCompleteTaskTool(taskComponent).execute(
      { task_id: taskId, current_status: "第一版" },
      { session_id: "sess_5073" },
    );
    expect(r1.success).toBe(true);
    const r2 = await preCompleteTaskTool(taskComponent).execute(
      { task_id: taskId, current_status: "第二版" },
      { session_id: "sess_5073" },
    );
    expect(r2.success).toBe(true);
    const task = await taskComponent.getTask(taskId);
    expect(task!.status).toBe("to_validate");
    expect(task!.current_status).toContain("第二版");
  });

  // ============================================================
  // 设计调整 v2（用户 2026-11-06 二次补充）
  // ============================================================

  it("11. task_complete 不再接受 deliverable_storage_path 入参（设计调整①）", async () => {
    const taskId = await makeTask();
    // pre_complete 提交交付物（交付物的唯一入口）
    await preCompleteTaskTool(taskComponent).execute(
      { task_id: taskId, deliverable_storage_path: "/tmp/only-at-pre.md" },
      { session_id: "sess_5073" },
    );
    // task_complete 的 schema 里不应再有 deliverable_storage_path
    const { CompleteTaskToolSchema } = await import("./tools/task-types");
    const parsed = CompleteTaskToolSchema.safeParse({
      task_id: taskId,
      deliverable_storage_path: "/tmp/only-at-pre.md",
    });
    // zod 默认剥离未知键 —— 用 shape 检查更精确：deliverable 键不该存在于 shape
    const shape = (CompleteTaskToolSchema as any)._def?.schema?.shape ??
      (CompleteTaskToolSchema as any).shape ?? {};
    expect(
      Object.prototype.hasOwnProperty.call(shape, "deliverable_storage_path"),
      "task_complete 的 schema 不应有 deliverable_storage_path 字段",
    ).toBe(false);
  });

  it("12. pre_complete 触发 AFTER_COMPLETE（goal 检查自查关，设计调整②）", async () => {
    const taskId = await makeTask();
    const fired: string[] = [];
    taskComponent.registerHook("task:after.complete" as any, {
      name: "test-5073-after-complete-probe",
      priority: 100,
      execute: async (ctx: any) => {
        const data = ctx && typeof ctx === "object" && "data" in ctx ? ctx.data : ctx;
        const t = data?.task;
        fired.push(String(t?.status ?? "?"));
      },
    });
    try {
      await preCompleteTaskTool(taskComponent).execute(
        { task_id: taskId },
        { session_id: "sess_5073" },
      );
      expect(fired).toContain("to_validate");
    } finally {
      try {
        taskComponent.unregisterHook("task:after.complete" as any, "test-5073-after-complete-probe");
      } catch { /* 清理失败不影响测试结论 */ }
    }
  });

  it("13. completeTask（验收落定）不再触发 AFTER_COMPLETE（设计调整②）", async () => {
    const taskId = await makeTask();
    await preCompleteTaskTool(taskComponent).execute(
      { task_id: taskId },
      { session_id: "sess_5073" },
    );
    const fired: string[] = [];
    taskComponent.registerHook("task:after.complete" as any, {
      name: "test-5073-complete-no-probe",
      priority: 100,
      execute: async () => { fired.push("fired"); },
    });
    try {
      await completeTaskTool(taskComponent).execute(
        { task_id: taskId },
        { session_id: "sess_5073" },
      );
      const task = await taskComponent.getTask(taskId);
      expect(task!.status).toBe("completed");
      expect(fired).toEqual([]);
    } finally {
      try {
        taskComponent.unregisterHook("task:after.complete" as any, "test-5073-complete-no-probe");
      } catch { /* 清理失败不影响测试结论 */ }
    }
  });

  it("14. CLI completeTask(deliverable) 兼容保留（非 tool 通道不破坏）", async () => {
    const taskId = await makeTask();
    // CLI `tasks complete` 走 TaskComponent.completeTask(id, sessionId, deliverable)
    const task = await taskComponent.completeTask(taskId, "sess_cli", "/tmp/cli-d.md");
    expect(task).toBeDefined();
    expect(task!.status).toBe("completed");
    const ctx = JSON.parse(task!.context || "{}");
    expect(ctx.deliverable_storage_path).toBe("/tmp/cli-d.md");
  });

  it("15. 终态护栏下沉到 TaskComponent.completeTask（DS review MAJOR-3）", async () => {
    // CLI `tasks complete` / TaskStoreBackend（MCP）不走 tool 层，
    // 护栏必须在组件层兜底 —— 已终态任务不可被验收翻转。
    const t1 = await makeTask();
    await cancelTaskTool(taskComponent).execute(
      { task_id: t1, reason: "用户明令" },
      { session_id: "sess_5073" },
    );
    await expect(
      taskComponent.completeTask(t1, "sess_cli"),
    ).rejects.toThrow(/already in terminal status "cancelled"/);

    const t2 = await makeTask();
    await taskComponent.updateTask(t2, { status: "archived" });
    await expect(
      taskComponent.completeTask(t2, "sess_cli"),
    ).rejects.toThrow(/already in terminal status "archived"/);
  });
});
