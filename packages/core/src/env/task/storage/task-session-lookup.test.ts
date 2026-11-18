/**
 * @fileoverview getTaskIdBySessionId — sub-session → task 确定性反查回归测试
 *
 * 背景（Task #4039 独立问题）：task.background.completed 的 associatedTaskId 原先
 * 依赖易失的 EnvContext.currentTaskId（被 sub-agent 的 task_complete 清空）+
 * 结果文本正则 `/Task\s+#?(\d+)/`，会把报告里提到的任意 "Task #N" 误当成本任务
 * （实测 #4076 的报告里引用 "Task #627" → associatedTaskId 错成 627）。
 *
 * 修复：按 sub-session id 反查该 session 创建的第一个 task（sub-agent 的
 * task_create 用 sessionId=sub-session id）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { TaskComponent } from "../task-component";
import { ConfigComponent } from "../../../config/config-component";
import { tmpdir } from "os";
import { join } from "path";

describe("TaskComponent.getTaskIdBySessionId (Task #4039)", () => {
  let taskComponent: TaskComponent;

  beforeEach(async () => {
    const configComponent = new ConfigComponent();
    taskComponent = new TaskComponent();
    await taskComponent.init({
      options: {
        configComponent,
        config: {
          storage: {
            type: "sqlite",
            dbPath: join(
              tmpdir(),
              `task-session-lookup-${Date.now()}-${Math.random()}.db`,
            ),
          },
        },
      },
    } as any);
  });

  afterEach(async () => {
    await taskComponent.stop();
  });

  test("返回该 session 创建的第一个 task", async () => {
    const t = await taskComponent.createTask({
      title: "sub-agent 建的任务",
      project_path: "unknown",
      context: "{}",
      sessionId: "session_sub_xyz",
    } as any);

    const found = await taskComponent.getTaskIdBySessionId("session_sub_xyz");
    expect(found).toBe(t.id);
  });

  test("未知 session → undefined", async () => {
    expect(await taskComponent.getTaskIdBySessionId("session_nope")).toBeUndefined();
  });

  test("空 sessionId → undefined", async () => {
    expect(await taskComponent.getTaskIdBySessionId("")).toBeUndefined();
  });

  test("同一 session 建多个 task → 返回最早的（sub-agent 主任务）", async () => {
    const first = await taskComponent.createTask({
      title: "主任务",
      project_path: "unknown",
      context: "{}",
      sessionId: "session_multi",
    } as any);
    await taskComponent.createTask({
      title: "子任务",
      project_path: "unknown",
      context: "{}",
      sessionId: "session_multi",
      parent_task_id: first.id,
    } as any);

    expect(await taskComponent.getTaskIdBySessionId("session_multi")).toBe(first.id);
  });
});
