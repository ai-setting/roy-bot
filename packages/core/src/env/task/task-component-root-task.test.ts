/**
 * @fileoverview Regression tests for TaskComponent.createTask supporting root tasks
 *
 * Bug: 之前 TaskComponent.createTask 在 parent_task_id 缺省 / null / undefined 时
 *      抛出 "parent_task_id is required" 错误，导致无法创建根任务。
 *
 * 修复后应允许 root task 创建，并通过 store.createTask 持久化（parent_task_id 为 null）。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { TaskComponent } from "./task-component";
import { ConfigComponent } from "../../config/config-component";
import { tmpdir } from "os";
import { join } from "path";

describe("TaskComponent.createTask root task support", () => {
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
            dbPath: join(tmpdir(), `task-comp-root-${Date.now()}-${Math.random()}.db`),
          },
        },
      },
    });
  });

  afterEach(async () => {
    await taskComponent.stop();
  });

  it("should create a root task when parent_task_id is omitted", async () => {
    const task = await taskComponent.createTask({
      title: "Root Task via Component",
      sessionId: "sess_root_comp_1",
      project_path: "unknown",
      context: '{"type": "general"}',
    });

    expect(task.id).toBeGreaterThan(0);
    expect(task.title).toBe("Root Task via Component");
    expect(task.parent_task_id).toBeUndefined();
    expect(task.status).toBe("todo");

    // Verify persistence: re-fetch from store
    const fetched = await taskComponent.getTask(task.id);
    expect(fetched).toBeDefined();
    expect(fetched!.parent_task_id).toBeUndefined();
  });

  it("should create a root task when parent_task_id is explicitly null", async () => {
    const task = await taskComponent.createTask({
      parent_task_id: null,
      title: "Root Task Null Parent",
      sessionId: "sess_root_comp_2",
      project_path: "unknown",
      context: "{}",
    });
    expect(task.id).toBeGreaterThan(0);
    expect(task.parent_task_id).toBeUndefined();
  });

  it("should create a root task when parent_task_id is explicitly undefined", async () => {
    const task = await taskComponent.createTask({
      parent_task_id: undefined,
      title: "Root Task Undefined Parent",
      sessionId: "sess_root_comp_3",
      project_path: "unknown",
      context: "{}",
    });
    expect(task.id).toBeGreaterThan(0);
    expect(task.parent_task_id).toBeUndefined();
  });

  it("should still throw when parent_task_id is provided but not found", async () => {
    await expect(
      taskComponent.createTask({
        parent_task_id: 99999,
        title: "Orphan Child",
        sessionId: "sess_root_comp_4",
        project_path: "unknown",
        context: "{}",
      })
    ).rejects.toThrow(/Parent task #99999 not found/);
  });
});