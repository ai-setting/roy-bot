/**
 * @fileoverview Task Tools Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { TaskComponent } from "../task-component";
import { ConfigComponent } from "../../../config/config-component";
import { tmpdir } from "os";
import { join } from "path";
import { createTaskTool, getTaskTool, listTasksTool, searchTasksTool, updateTaskTool, deleteTaskTool, completeTaskTool } from "./index";

describe("Task Tools", () => {
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
            dbPath: join(tmpdir(), `task-tools-test-${Date.now()}.db`),
          },
        },
      },
    });
    
    // Create a parent task for use in tests (bypass tool validation via store)
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
  
  describe("task_create", () => {
    it("should create a task", async () => {
      const tool = createTaskTool(taskComponent);
      const result = await tool.execute(
        { 
          parent_task_id: parentTaskId,
          title: "Test Task", 
          description: "Test description",
          project_path: "unknown",
          context: "{}"
        },
        { session_id: "sess_123" }
      );
      
      expect(result.success).toBe(true);
      expect(result.output).toContain("Test Task");
      expect(result.metadata?.task_id).toBeGreaterThan(0);
    });
    
    it("should create task with priority", async () => {
      const tool = createTaskTool(taskComponent);
      const result = await tool.execute(
        { 
          parent_task_id: parentTaskId,
          title: "High Priority Task", 
          priority: "high",
          project_path: "unknown",
          context: '{"type": "feature"}'
        },
        { session_id: "sess_123" }
      );
      
      expect(result.success).toBe(true);
    });

    it("should create task with project_path and context", async () => {
      const tool = createTaskTool(taskComponent);
      const result = await tool.execute(
        { 
          parent_task_id: parentTaskId,
          title: "Coding Task",
          project_path: "/home/user/project",
          context: '{"worktree_path": "/path/worktree", "branch": "feature/test", "type": "feature"}'
        },
        { session_id: "sess_123" }
      );
      
      expect(result.success).toBe(true);
      expect(result.output).toContain("Coding Task");
    });
  });
  
  describe("task_create with type", () => {
    it("should create a task with cycle type", async () => {
      const tool = createTaskTool(taskComponent);
      const result = await tool.execute(
        { 
          parent_task_id: parentTaskId,
          title: "Cycle Task", 
          type: "cycle",
          project_path: "unknown",
          context: "{}"
        },
        { session_id: "sess_123" }
      );
      
      expect(result.success).toBe(true);
      expect(result.output).toContain("Cycle Task");
    });
    
    it("should default type to normal when not provided", async () => {
      const tool = createTaskTool(taskComponent);
      const result = await tool.execute(
        { 
          parent_task_id: parentTaskId,
          title: "Normal Task",
          project_path: "unknown",
          context: "{}"
        },
        { session_id: "sess_123" }
      );
      
      expect(result.success).toBe(true);
      
      // Verify the task was created with normal type
      const getTool = getTaskTool(taskComponent);
      const getResult = await getTool.execute(
        { task_id: result.metadata?.task_id as number },
        { session_id: "sess_123" }
      );
      const task = JSON.parse(getResult.output as string);
      expect(task.type).toBe("normal");
    });
  });
  
  describe("task_get", () => {
    it("should get task by id", async () => {
      // First create a task
      const createTool = createTaskTool(taskComponent);
      const createResult = await createTool.execute(
        { 
          parent_task_id: parentTaskId,
          title: "Get Test Task",
          project_path: "unknown",
          context: "{}"
        },
        { session_id: "sess_123" }
      );
      
      const taskId = createResult.metadata?.task_id as number;
      
      // Then get it
      const getTool = getTaskTool(taskComponent);
      const result = await getTool.execute(
        { task_id: taskId },
        { session_id: "sess_123" }
      );
      
      expect(result.success).toBe(true);
      const task = JSON.parse(result.output as string);
      expect(task.title).toBe("Get Test Task");
      expect(task.project_path).toBe("unknown");
      // Task #2325: 上下文现在会自动注入 created_at + worktree_path (时空增强)
      const ctx = JSON.parse(task.context);
      expect(ctx.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
    
    it("should return error for non-existent task", async () => {
      const tool = getTaskTool(taskComponent);
      const result = await tool.execute(
        { task_id: 99999 },
        { session_id: "sess_123" }
      );
      
      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });
  });
  
  describe("task_list", () => {
    it("should list tasks", async () => {
      // Create some tasks
      const createTool = createTaskTool(taskComponent);
      await createTool.execute({parent_task_id: parentTaskId, title: "Task 1", project_path: "unknown", context: "{}" }, { session_id: "sess_123" });
      await createTool.execute({parent_task_id: parentTaskId, title: "Task 2", project_path: "unknown", context: "{}" }, { session_id: "sess_123" });
      
      // List them
      const tool = listTasksTool(taskComponent);
      const result = await tool.execute({}, { session_id: "sess_123" });
      
      expect(result.success).toBe(true);
      const data = JSON.parse(result.output as string);
      expect(data.count).toBeGreaterThanOrEqual(2);
      // 新增 total 字段
      expect(typeof data.total).toBe("number");
      expect(data.total).toBeGreaterThanOrEqual(2);
      expect(data.limit).toBe(20);
      expect(data.offset).toBe(0);
    });
    
    it("should filter by status", async () => {
      const createTool = createTaskTool(taskComponent);
      const createResult = await createTool.execute(
        {parent_task_id: parentTaskId, title: "Active Task", project_path: "unknown", context: "{}" }, 
        { session_id: "sess_123" }
      );
      
      // Update to active
      const updateTool = updateTaskTool(taskComponent);
      await updateTool.execute(
        { task_id: createResult.metadata?.task_id, status: "active" },
        { session_id: "sess_123" }
      );
      
      // List only active
      const listTool = listTasksTool(taskComponent);
      const result = await listTool.execute({ status: "active" }, { session_id: "sess_123" });
      
      expect(result.success).toBe(true);
      const data = JSON.parse(result.output as string);
      expect(data.tasks.every((t: any) => t.status === "active")).toBe(true);
      expect(typeof data.total).toBe("number");
    });

    it("should return total before pagination via limit/offset", async () => {
      // Create 5 tasks
      for (let i = 0; i < 5; i++) {
        const createTool = createTaskTool(taskComponent);
        await createTool.execute(
          {parent_task_id: parentTaskId, title: `Task ${i}`, project_path: "unknown", context: "{}" },
          { session_id: "sess_123" }
        );
      }

      const listTool = listTasksTool(taskComponent);
      const result = await listTool.execute({ limit: 2, offset: 0 }, { session_id: "sess_123" });

      expect(result.success).toBe(true);
      const data = JSON.parse(result.output as string);
      expect(data.tasks.length).toBe(2);
      expect(data.total).toBe(6); // 5 created + 1 parent task
      expect(data.limit).toBe(2);
      expect(data.offset).toBe(0);
    });
  });
  
  describe("task_update", () => {
    it("should update task", async () => {
      // Create a task
      const createTool = createTaskTool(taskComponent);
      const createResult = await createTool.execute(
        {parent_task_id: parentTaskId, title: "Original Title", project_path: "unknown", context: "{}" }, 
        { session_id: "sess_123" }
      );
      
      // Update it
      const tool = updateTaskTool(taskComponent);
      const result = await tool.execute(
        { 
          task_id: createResult.metadata?.task_id, 
          title: "Updated Title",
          status: "active",
          progress: 50,
          current_status: "正在实现功能"
        },
        { session_id: "sess_123" }
      );
      
      expect(result.success).toBe(true);
      expect(result.output).toContain("Updated Title");
    });
    it("should reject setting parent_task_id to self (direct cycle)", async () => {
      const createTool = createTaskTool(taskComponent);
      const createResult = await createTool.execute(
        {parent_task_id: parentTaskId, title: "Self Cycle", project_path: "unknown", context: "{}" },
        { session_id: "sess_123" }
      );
      const taskId = createResult.metadata?.task_id;

      const tool = updateTaskTool(taskComponent);
      const result = await tool.execute(
        { task_id: taskId, parent_task_id: taskId },
        { session_id: "sess_123" }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Circular reference");
      expect(result.error).toContain("cycle");
    });

    it("should reject setting parent_task_id to descendant (indirect cycle)", async () => {
      const createTool = createTaskTool(taskComponent);
      const parentResult = await createTool.execute(
        {parent_task_id: parentTaskId, title: "Grandparent", project_path: "unknown", context: "{}" },
        { session_id: "sess_123" }
      );
      const childResult = await createTool.execute(
        {parent_task_id: parentResult.metadata?.task_id, title: "Parent", project_path: "unknown", context: "{}" },
        { session_id: "sess_123" }
      );
      const grandchildResult = await createTool.execute(
        {parent_task_id: childResult.metadata?.task_id, title: "Child", project_path: "unknown", context: "{}" },
        { session_id: "sess_123" }
      );

      // 尝试把 grandparent 的父节点设为 child（形成 grandparent→parent→child→grandparent 循环）
      const tool = updateTaskTool(taskComponent);
      const result = await tool.execute(
        { task_id: parentResult.metadata?.task_id, parent_task_id: grandchildResult.metadata?.task_id },
        { session_id: "sess_123" }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Circular reference");
    });

    it("should allow setting parent_task_id to a valid ancestor", async () => {
      const createTool = createTaskTool(taskComponent);
      const rootResult = await createTool.execute(
        {parent_task_id: parentTaskId, title: "Root", project_path: "unknown", context: "{}" },
        { session_id: "sess_123" }
      );
      const branchResult = await createTool.execute(
        {parent_task_id: rootResult.metadata?.task_id, title: "Branch", project_path: "unknown", context: "{}" },
        { session_id: "sess_123" }
      );
      const leafResult = await createTool.execute(
        {parent_task_id: branchResult.metadata?.task_id, title: "Leaf", project_path: "unknown", context: "{}" },
        { session_id: "sess_123" }
      );

      // 把 leaf 从 branch 下移到 root 下（安全操作）
      const tool = updateTaskTool(taskComponent);
      const result = await tool.execute(
        { task_id: leafResult.metadata?.task_id, parent_task_id: rootResult.metadata?.task_id },
        { session_id: "sess_123" }
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain("updated");
    });
  });

  describe("task_search", () => {
    it("should search tasks by keywords and return total", async () => {
      const createTool = createTaskTool(taskComponent);
      await createTool.execute(
        {parent_task_id: parentTaskId, title: "Fix login bug", description: "Auth issues", tags: ["bug", "auth"], project_path: "unknown", context: "{}" },
        { session_id: "sess_123" }
      );
      await createTool.execute(
        {parent_task_id: parentTaskId, title: "Add new feature", description: "Implement feature", tags: ["feature"], project_path: "unknown", context: "{}" },
        { session_id: "sess_123" }
      );

      const tool = searchTasksTool(taskComponent);
      const result = await tool.execute(
        { keywords: ["login"] },
        { session_id: "sess_123" }
      );

      expect(result.success).toBe(true);
      const data = JSON.parse(result.output as string);
      expect(data.tasks.length).toBe(1);
      expect(data.total).toBe(1);
      expect(data.tasks[0].title).toContain("login");
    });

    it("should support multi-keyword AND search", async () => {
      const createTool = createTaskTool(taskComponent);
      await createTool.execute(
        {parent_task_id: parentTaskId, title: "Fix login bug", description: "Login page", tags: ["bug", "auth"], project_path: "unknown", context: "{}" },
        { session_id: "sess_123" }
      );
      await createTool.execute(
        {parent_task_id: parentTaskId, title: "Add login feature", description: "New login", project_path: "unknown", context: "{}" },
        { session_id: "sess_123" }
      );

      const tool = searchTasksTool(taskComponent);
      const result = await tool.execute(
        { keywords: ["fix", "login"] },
        { session_id: "sess_123" }
      );

      expect(result.success).toBe(true);
      const data = JSON.parse(result.output as string);
      expect(data.total).toBe(1);
      expect(data.tasks[0].title).toContain("Fix login bug");
    });

    it("should support status filter", async () => {
      const createTool = createTaskTool(taskComponent);
      const createResult = await createTool.execute(
        {parent_task_id: parentTaskId, title: "Active login task", description: "Login issues", project_path: "unknown", context: "{}" },
        { session_id: "sess_123" }
      );
      const updateTool = updateTaskTool(taskComponent);
      await updateTool.execute(
        { task_id: createResult.metadata?.task_id, status: "active" },
        { session_id: "sess_123" }
      );

      const tool = searchTasksTool(taskComponent);
      const result = await tool.execute(
        { keywords: ["login"], status: "active" },
        { session_id: "sess_123" }
      );

      expect(result.success).toBe(true);
      const data = JSON.parse(result.output as string);
      expect(data.total).toBe(1);
      expect(data.tasks[0].status).toBe("active");
    });

    it("should support exclude_task_id", async () => {
      const createTool = createTaskTool(taskComponent);
      const createResult = await createTool.execute(
        {parent_task_id: parentTaskId, title: "Login feature 1", description: "Desc", project_path: "unknown", context: "{}" },
        { session_id: "sess_123" }
      );
      await createTool.execute(
        {parent_task_id: parentTaskId, title: "Login feature 2", description: "Desc", project_path: "unknown", context: "{}" },
        { session_id: "sess_123" }
      );

      const tool = searchTasksTool(taskComponent);
      const result = await tool.execute(
        { keywords: ["login"], exclude_task_id: createResult.metadata?.task_id },
        { session_id: "sess_123" }
      );

      expect(result.success).toBe(true);
      const data = JSON.parse(result.output as string);
      expect(data.total).toBe(1);
      expect(data.tasks[0].id).not.toBe(createResult.metadata?.task_id);
    });

    it("should return empty results for empty keywords", async () => {
      const tool = searchTasksTool(taskComponent);
      const result = await tool.execute(
        { keywords: [] },
        { session_id: "sess_123" }
      );

      expect(result.success).toBe(true);
      const data = JSON.parse(result.output as string);
      expect(data.tasks).toEqual([]);
      expect(data.total).toBe(0);
    });
  });
  
  describe("task_delete", () => {
    it("should delete task", async () => {
      // Create a task
      const createTool = createTaskTool(taskComponent);
      const createResult = await createTool.execute(
        {parent_task_id: parentTaskId, title: "Delete Me", project_path: "unknown", context: "{}" }, 
        { session_id: "sess_123" }
      );
      
      // Delete it
      const tool = deleteTaskTool(taskComponent);
      const result = await tool.execute(
        { task_id: createResult.metadata?.task_id },
        { session_id: "sess_123" }
      );
      
      expect(result.success).toBe(true);
      expect(result.output).toContain("deleted");
      
      // Verify it's gone
      const getTool = getTaskTool(taskComponent);
      const getResult = await getTool.execute(
        { task_id: createResult.metadata?.task_id },
        { session_id: "sess_123" }
      );
      expect(getResult.success).toBe(false);
    });
  });
  
  describe("task_complete", () => {
    it("should complete task", async () => {
      // Create a task
      const createTool = createTaskTool(taskComponent);
      const createResult = await createTool.execute(
        {parent_task_id: parentTaskId, title: "Complete Me", project_path: "unknown", context: "{}" }, 
        { session_id: "sess_123" }
      );
      
      // Complete it
      const tool = completeTaskTool(taskComponent);
      const result = await tool.execute(
        { task_id: createResult.metadata?.task_id },
        { session_id: "sess_123" }
      );
      
      expect(result.success).toBe(true);
      expect(result.output).toContain("completed");
      
      // Verify status
      const task = result.metadata?.task as any;
      expect(task.status).toBe("completed");
      expect(task.progress).toBe(100);
    });

    it("should reject completing a cycle type task", async () => {
      const createTool = createTaskTool(taskComponent);
      const createResult = await createTool.execute(
        { 
          parent_task_id: parentTaskId,
          title: "Cycle Task",
          type: "cycle",
          project_path: "unknown",
          context: "{}"
        }, 
        { session_id: "sess_123" }
      );
      
      const tool = completeTaskTool(taskComponent);
      const result = await tool.execute(
        { task_id: createResult.metadata?.task_id },
        { session_id: "sess_123" }
      );
      
      expect(result.success).toBe(false);
      expect(result.error).toContain("cycle");
    });
  });
});
