/**
 * @fileoverview TaskComponent Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { TaskComponent } from "./task-component";
import { ConfigComponent } from "../../config/config-component";
import { tmpdir } from "os";
import { join } from "path";

describe("TaskComponent", () => {
  let taskComponent: TaskComponent;
  let configComponent: ConfigComponent;
  let parentTaskId: number;
  
  beforeEach(async () => {
    configComponent = new ConfigComponent();
    taskComponent = new TaskComponent();
    await taskComponent.init({
      options: {
        configComponent,
        config: {
          storage: {
            type: "sqlite",
            dbPath: join(tmpdir(), `task-component-test-${Date.now()}.db`),
          },
        },
      },
    });
    
    // Create a parent task for use in tests
    // Use store directly to bypass parent_task_id validation
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
  
  describe("createTask", () => {
    it("should create a task", async () => {
      const task = await taskComponent.createTask({
        parent_task_id: parentTaskId,
        title: "Test Task",
        sessionId: "sess_123",
        project_path: "unknown",
        context: "{}",
      });
      
      expect(task.id).toBeGreaterThan(0);
      expect(task.title).toBe("Test Task");
      expect(task.status).toBe("todo");
    });
    
    it("should auto-create operation record", async () => {
      const task = await taskComponent.createTask({
        parent_task_id: parentTaskId,
        title: "Test Task",
        sessionId: "sess_123",
        project_path: "unknown",
        context: "{}",
      });
      
      const ops = await taskComponent.listOperations({ taskId: task.id });
      expect(ops.length).toBe(1);
      expect(ops[0].actionType).toBe("create");
      expect(ops[0].sessionId).toBe("sess_123");
    });
  });
  
  describe("getTask", () => {
    it("should get task by id", async () => {
      const created = await taskComponent.createTask({
        parent_task_id: parentTaskId,
        title: "Test Task",
        sessionId: "sess_123",
        project_path: "unknown",
        context: "{}",
      });
      
      const task = await taskComponent.getTask(created.id);
      expect(task?.title).toBe("Test Task");
    });
    
    it("should return undefined for non-existent task", async () => {
      const task = await taskComponent.getTask(99999);
      expect(task).toBeUndefined();
    });
  });
  
  describe("updateTask", () => {
    it("should update task", async () => {
      const task = await taskComponent.createTask({
        parent_task_id: parentTaskId,
        title: "Test Task",
        sessionId: "sess_123",
        project_path: "unknown",
        context: "{}",
      });
      
      const updated = await taskComponent.updateTask(task.id, {
        status: "active",
        progress: 50,
        current_status: "正在实现功能",
      });
      
      expect(updated?.status).toBe("active");
      expect(updated?.progress).toBe(50);
      expect(updated?.current_status).toBe("正在实现功能");
    });
  });
  
  describe("completeTask", () => {
    it("should complete task with operation record", async () => {
      const task = await taskComponent.createTask({
        parent_task_id: parentTaskId,
        title: "Test Task",
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}",
      });
      
      await taskComponent.updateTask(task.id, { status: "active" });
      
      const completed = await taskComponent.completeTask(task.id, "sess_2");
      expect(completed?.status).toBe("completed");
      expect(completed?.progress).toBe(100);
      
      // Check operation record
      const ops = await taskComponent.listOperations({ taskId: task.id });
      const completedOp = ops.find(op => op.actionType === "completed");
      expect(completedOp?.sessionId).toBe("sess_2");
    });
  });
  
  describe("listTasks", () => {
    it("should list tasks", async () => {
      await taskComponent.createTask({
        parent_task_id: parentTaskId, title: "Task 1", sessionId: "sess_1",
        project_path: "unknown",
        context: "{}" });
      await taskComponent.createTask({
        parent_task_id: parentTaskId, title: "Task 2", sessionId: "sess_1",
        project_path: "unknown",
        context: "{}" });
      
      const result = await taskComponent.listTasks();
      expect(result.tasks.length).toBe(3); // 1 parent + 2 created
      expect(result.total).toBe(3);
    });
    
    it("should filter by status", async () => {
      const task1 = await taskComponent.createTask({
        parent_task_id: parentTaskId, title: "Task 1", sessionId: "sess_1",
        project_path: "unknown",
        context: "{}" });
      await taskComponent.createTask({
        parent_task_id: parentTaskId, title: "Task 2", sessionId: "sess_1",
        project_path: "unknown",
        context: "{}" });
      await taskComponent.updateTask(task1.id, { status: "active" });
      
      const result = await taskComponent.listTasks({ status: "active" });
      expect(result.tasks.length).toBe(1);
      expect(result.total).toBe(1);
    });
    
    it("should filter by type", async () => {
      await taskComponent.createTask({
        parent_task_id: parentTaskId,
        title: "Cycle Task",
        sessionId: "sess_1",
        type: "cycle",
        project_path: "unknown",
        context: "{}",
      });
      await taskComponent.createTask({
        parent_task_id: parentTaskId,
        title: "Normal Task",
        sessionId: "sess_1",
        type: "normal",
        project_path: "unknown",
        context: "{}",
      });
      
      const result = await taskComponent.listTasks({ type: "cycle" });
      expect(result.tasks.length).toBe(1);
      expect(result.total).toBe(1);
      expect(result.tasks[0].title).toBe("Cycle Task");
    });

    it("should return total before pagination", async () => {
      for (let i = 0; i < 5; i++) {
        await taskComponent.createTask({
        parent_task_id: parentTaskId,
          title: `Task ${i}`,
          sessionId: "sess_1",
          project_path: "unknown",
          context: "{}",
        });
      }

      const page1 = await taskComponent.listTasks({ limit: 2, offset: 0 });
      expect(page1.tasks.length).toBe(2);
      expect(page1.total).toBe(6); // 5 created + 1 parent

      const page2 = await taskComponent.listTasks({ limit: 2, offset: 2 });
      expect(page2.tasks.length).toBe(2);
      expect(page2.total).toBe(6); // 5 created + 1 parent
    });
  });
  
  describe("type field", () => {
    it("should default type to normal when not provided", async () => {
      const task = await taskComponent.createTask({
        parent_task_id: parentTaskId,
        title: "Default Type",
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}",
      });
      expect(task.type).toBe("normal");
    });
    
    it("should create task with cycle type", async () => {
      const task = await taskComponent.createTask({
        parent_task_id: parentTaskId,
        title: "Cycle Task",
        sessionId: "sess_1",
        type: "cycle",
        project_path: "unknown",
        context: "{}",
      });
      expect(task.type).toBe("cycle");
    });
    
    it("should create task with longterm type", async () => {
      const task = await taskComponent.createTask({
        parent_task_id: parentTaskId,
        title: "Longterm Task",
        sessionId: "sess_1",
        type: "longterm",
        project_path: "unknown",
        context: "{}",
      });
      expect(task.type).toBe("longterm");
    });
    
    it("should update task type", async () => {
      const task = await taskComponent.createTask({
        parent_task_id: parentTaskId,
        title: "Updatable Task",
        sessionId: "sess_1",
        type: "normal",
        project_path: "unknown",
        context: "{}",
      });
      
      const updated = await taskComponent.updateTask(task.id, { type: "cycle" });
      expect(updated?.type).toBe("cycle");
    });
    
    it("should return type in getTask", async () => {
      const task = await taskComponent.createTask({
        parent_task_id: parentTaskId,
        title: "Gettable Task",
        sessionId: "sess_1",
        type: "longterm",
        project_path: "unknown",
        context: "{}",
      });
      
      const fetched = await taskComponent.getTask(task.id);
      expect(fetched?.type).toBe("longterm");
    });
  });
  
  describe("cross-session operations", () => {
    it("should track operations from different sessions", async () => {
      const task = await taskComponent.createTask({
        parent_task_id: parentTaskId,
        title: "Cross-Session Task",
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}",
      });
      
      await taskComponent.createOperation({
        taskId: task.id,
        sessionId: "sess_2",
        project_path: "unknown",
        context: "{}",
        actionType: "progress",
        actionTitle: "Started working",
      });
      
      await taskComponent.createOperation({
        taskId: task.id,
        sessionId: "sess_2",
        project_path: "unknown",
        context: "{}",
        actionType: "progress",
        actionTitle: "Made progress in session 2",
      });
      
      await taskComponent.createOperation({
        taskId: task.id,
        sessionId: "sess_3",
        project_path: "unknown",
        context: "{}",
        actionType: "milestone",
        actionTitle: "Reached milestone in session 3",
      });
      
      const ops = await taskComponent.listOperations({ taskId: task.id });
      expect(ops.length).toBe(4);  // 1 create + 1 progress update + 2 manual
      
      // Check session distribution
      const sessions = new Set(ops.map(op => op.sessionId));
      expect(sessions.has("sess_1")).toBe(true);
      expect(sessions.has("sess_2")).toBe(true);
      expect(sessions.has("sess_3")).toBe(true);
    });
  });
  
  describe("getTaskWithOperations", () => {
    it("should return task with all operations", async () => {
      const task = await taskComponent.createTask({
        parent_task_id: parentTaskId,
        title: "Task with Ops",
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}",
      });
      
      await taskComponent.createOperation({
        taskId: task.id,
        sessionId: "sess_2",
        project_path: "unknown",
        context: "{}",
        actionType: "progress",
        actionTitle: "Made progress",
      });
      
      const result = await taskComponent.getTaskWithOperations(task.id);
      // Task #4619: the result is FLAT — `{ ...task, operations }` — so the
      // task fields live at the top level, not under a `task` key.
      expect(result?.title).toBe("Task with Ops");
      expect(result?.id).toBe(task.id);
      expect(result?.operations.length).toBe(2);
    });
  });
});
