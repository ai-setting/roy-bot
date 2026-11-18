/**
 * @fileoverview Task #5007 — task_cancel 工具 TDD 测试
 *
 * 背景（架构调整：验收权从 roy sub-agent 移交 default agent）：
 *   default agent（接待员）承担**任务验收**职责 —— 收到 sub-agent 完成通知后
 *   核对实际产出，决定 task_complete / 重新委托 / task_cancel。
 *   「取消一个 Task」此前没有对应工具（只有 task_update 的 status 字段，
 *   以及 stop_task 用于停**后台进程**而非 Task 本身）。
 *
 * 本测试守住：
 *   1. 工具名 = task_cancel，参数 = task_id (+ 可选 reason)
 *   2. 取消后 task.status === "cancelled"
 *   3. 取消会落一条 operation 记录（审计痕迹）
 *   4. 任务不存在 → success=false + 明确错误
 *   5. 已终态任务（completed/cancelled）→ 拒绝重复取消
 *   6. cycle 类型任务可取消（周期任务只是不该 complete，不该禁止 cancel）
 *   7. reason 会写入 operation 记录（供验收方追溯取消原因）
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { TaskComponent } from "../task-component";
import { ConfigComponent } from "../../../config/config-component";
import { tmpdir } from "os";
import { join } from "path";
import { createTaskTool } from "./create-tool";
import { cancelTaskTool } from "./cancel-tool";

describe("task_cancel tool (Task #5007)", () => {
  let taskComponent: TaskComponent;
  let parentTaskId: number;

  beforeEach(async () => {
    const configComponent = new ConfigComponent();
    taskComponent = new TaskComponent();
    await taskComponent.init({
      options: {
        configComponent,
        config: {
          storage: {
            type: "sqlite",
            dbPath: join(tmpdir(), `task-cancel-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`),
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
  });

  async function makeTask(extra: Record<string, unknown> = {}) {
    const tool = createTaskTool(taskComponent);
    const res = await tool.execute(
      {
        parent_task_id: parentTaskId,
        title: "Cancel Me",
        project_path: "unknown",
        context: "{}",
        ...extra,
      },
      { session_id: "sess_123" },
    );
    expect(res.success).toBe(true);
    return res.metadata!.task_id as number;
  }

  it("1. 工具名与参数 schema 正确", () => {
    const tool = cancelTaskTool(taskComponent);
    expect(tool.name).toBe("task_cancel");
    // withLegacyTaskId 用 z.preprocess 包裹 ⇒ 是 ZodEffects，shape 在 _def.schema
    const inner = (tool.parameters as any)._def?.schema ?? tool.parameters;
    const shape = inner.shape ?? {};
    expect(shape).toHaveProperty("task_id");
    expect(shape).toHaveProperty("reason");
  });

  it("2. 取消后 status === cancelled", async () => {
    const taskId = await makeTask();
    const tool = cancelTaskTool(taskComponent);
    const res = await tool.execute({ task_id: taskId }, { session_id: "sess_123" });

    expect(res.success).toBe(true);
    expect(res.output).toContain("cancelled");

    const task = await taskComponent.getTask(taskId);
    expect(task!.status).toBe("cancelled");
  });

  it("3. 取消会落一条 operation 记录（审计痕迹）", async () => {
    const taskId = await makeTask();
    const tool = cancelTaskTool(taskComponent);
    await tool.execute({ task_id: taskId, reason: "user requested" }, { session_id: "sess_123" });

    const ops = await taskComponent.listOperations({ taskId, limit: 100 });
    const cancelOps = ops.filter((op: any) =>
      String(op.milestoneTitle ?? op.actionTitle ?? "").toLowerCase().includes("cancel"),
    );
    expect(cancelOps.length).toBeGreaterThan(0);
  });

  it("4. reason 写入 operation 记录", async () => {
    const taskId = await makeTask();
    const tool = cancelTaskTool(taskComponent);
    await tool.execute({ task_id: taskId, reason: "验收未通过，用户要求取消" }, { session_id: "sess_123" });

    const ops = await taskComponent.listOperations({ taskId, limit: 100 });
    const blob = JSON.stringify(ops);
    expect(blob).toContain("验收未通过");
  });

  it("5. 任务不存在 → success=false + 明确错误", async () => {
    const tool = cancelTaskTool(taskComponent);
    const res = await tool.execute({ task_id: 99999999 }, { session_id: "sess_123" });

    expect(res.success).toBe(false);
    expect(res.error).toContain("99999999");
  });

  it("6. 已完成的任务拒绝重复取消", async () => {
    const taskId = await makeTask();
    await taskComponent.updateTask(taskId, { status: "completed", progress: 100 });

    const tool = cancelTaskTool(taskComponent);
    const res = await tool.execute({ task_id: taskId }, { session_id: "sess_123" });

    expect(res.success).toBe(false);
    expect(res.error?.toLowerCase()).toContain("completed");
  });

  it("7. 已取消的任务拒绝重复取消", async () => {
    const taskId = await makeTask();
    const tool = cancelTaskTool(taskComponent);
    await tool.execute({ task_id: taskId }, { session_id: "sess_123" });

    const res2 = await tool.execute({ task_id: taskId }, { session_id: "sess_123" });
    expect(res2.success).toBe(false);
  });

  it("8. cycle 类型任务可以取消（周期任务只是不该 complete）", async () => {
    const taskId = await makeTask({ type: "cycle" });
    const tool = cancelTaskTool(taskComponent);
    const res = await tool.execute({ task_id: taskId }, { session_id: "sess_123" });

    expect(res.success).toBe(true);
    const task = await taskComponent.getTask(taskId);
    expect(task!.status).toBe("cancelled");
  });
});
