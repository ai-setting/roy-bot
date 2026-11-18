/**
 * @fileoverview Regression tests for: task_create parent_task_id 应可选
 *
 * Bug: 之前 `parent_task_id` 在 CreateTaskToolSchema 中是必填项，导致无法创建
 *      根任务（root task）。修复后该字段应为 optional，缺省时创建根任务。
 *
 * TDD: 先写失败测试（缺 parent_task_id 时应成功创建任务，且任务 parent_task_id 为 undefined）。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { TaskComponent } from "../task-component";
import { ConfigComponent } from "../../../config/config-component";
import { tmpdir } from "os";
import { join } from "path";
import { createTaskTool, getTaskTool } from "./index";

describe("task_create root task (parent_task_id optional)", () => {
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
            dbPath: join(tmpdir(), `task-create-root-${Date.now()}-${Math.random()}.db`),
          },
        },
      },
    });
  });

  afterEach(async () => {
    await taskComponent.stop();
  });

  it("should create a root task when parent_task_id is omitted", async () => {
    const tool = createTaskTool(taskComponent);
    const result = await tool.execute(
      {
        title: "Root Task Without Parent",
        project_path: "unknown",
        context: '{"type": "general"}',
      },
      { session_id: "sess_root_001" }
    );

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    const taskId = result.metadata?.task_id as number;
    expect(taskId).toBeGreaterThan(0);

    // 验证：task 持久化为根任务（parent_task_id 应为 undefined）
    const getTool = getTaskTool(taskComponent);
    const getResult = await getTool.execute(
      { task_id: taskId },
      { session_id: "sess_root_001" }
    );
    expect(getResult.success).toBe(true);
    const task = JSON.parse(getResult.output as string);
    expect(task.title).toBe("Root Task Without Parent");
    expect(task.parent_task_id).toBeUndefined();
    expect(task.status).toBe("todo");
  });

  it("should create a root task when parent_task_id is explicitly null", async () => {
    const tool = createTaskTool(taskComponent);
    const result = await tool.execute(
      {
        title: "Root Task With Null Parent",
        parent_task_id: null,
        project_path: "unknown",
        context: '{"type": "general"}',
      },
      { session_id: "sess_root_002" }
    );

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("should still create a child task when parent_task_id is provided", async () => {
    // 先创建一个根任务（parent_task_id 缺省）
    const createTool = createTaskTool(taskComponent);
    const parentRes = await createTool.execute(
      { title: "Parent", project_path: "unknown", context: "{}" },
      { session_id: "sess_root_003" }
    );
    expect(parentRes.success).toBe(true);
    const parentId = parentRes.metadata?.task_id as number;

    // 再创建子任务
    const childRes = await createTool.execute(
      {
        parent_task_id: parentId,
        title: "Child",
        project_path: "unknown",
        context: "{}",
      },
      { session_id: "sess_root_003" }
    );
    expect(childRes.success).toBe(true);
    const childId = childRes.metadata?.task_id as number;

    // 验证父子关系
    const getTool = getTaskTool(taskComponent);
    const getChild = await getTool.execute(
      { task_id: childId },
      { session_id: "sess_root_003" }
    );
    const child = JSON.parse(getChild.output as string);
    expect(child.parent_task_id).toBe(parentId);
  });
});