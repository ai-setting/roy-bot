/**
 * @fileoverview SQLite Task Store Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { SQLiteTaskStore, TaskStore } from "./sqlite-task-store";
import { tmpdir } from "os";
import { join } from "path";

describe("SQLiteTaskStore", () => {
  let store: TaskStore;
  
  beforeEach(async () => {
    // 每个测试使用唯一的数据库路径，确保隔离
    const testDbPath = join(tmpdir(), `task-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = new SQLiteTaskStore(testDbPath);
  });
  
  afterEach(async () => {
    await store.close();
  });
  
  describe("createTask", () => {
    it("should create a task with required fields", async () => {
      const task = await store.createTask({
        parent_task_id: 1,
        title: "Test Task",
        sessionId: "sess_123",
        project_path: "unknown",
        context: "{}",
      });
      
      expect(task.id).toBeGreaterThan(0);
      expect(task.title).toBe("Test Task");
      expect(task.status).toBe("todo");
      expect(task.priority).toBe("medium");
      expect(task.project_path).toBe("unknown");
      expect(task.context).toBe("{}");
    });
    
    it("should create task with all options", async () => {
      const task = await store.createTask({
        parent_task_id: 1,
        title: "Full Task",
        description: "Description",
        priority: "high",
        sessionId: "sess_123",
        tags: ["feature", "urgent"],
        project_path: "/home/user/project",
        context: '{"type": "feature", "branch": "main"}',
      });
      
      expect(task.description).toBe("Description");
      expect(task.priority).toBe("high");
      expect(task.tags).toEqual(["feature", "urgent"]);
      expect(task.project_path).toBe("/home/user/project");
      expect(task.context).toBe('{"type": "feature", "branch": "main"}');
    });
  });
  
  describe("CRUD operations", () => {
    it("should perform full CRUD cycle", async () => {
      // Create
      const created = await store.createTask({
        parent_task_id: 1, 
        title: "CRUD Test", 
        sessionId: "sess_123",
        project_path: "unknown",
        context: "{}"
      });
      expect(created.id).toBeGreaterThan(0);
      
      // Read
      const read = await store.getTask(created.id);
      expect(read?.title).toBe("CRUD Test");
      
      // Update
      const updated = await store.updateTask(created.id, { status: "active", progress: 50 });
      expect(updated?.status).toBe("active");
      expect(updated?.progress).toBe(50);
      
      // Delete
      const deleted = await store.deleteTask(created.id);
      expect(deleted).toBe(true);
      const notFound = await store.getTask(created.id);
      expect(notFound).toBeUndefined();
    });
    
    it("should update current_status field", async () => {
      const task = await store.createTask({
        parent_task_id: 1, 
        title: "Test", 
        sessionId: "sess_123",
        project_path: "unknown",
        context: "{}"
      });
      
      const updated = await store.updateTask(task.id, { 
        current_status: "正在实现登录功能" 
      });
      
      expect(updated?.current_status).toBe("正在实现登录功能");
    });
    
    it("should update parent_task_id to a valid parent task ID", async () => {
      // Create initial parent (dummy)
      const dummyTask = await store.createTask({
        parent_task_id: 1,
        title: "Dummy Parent",
        sessionId: "sess_123",
        project_path: "unknown",
        context: "{}"
      });
      
      // Create target parent
      const targetParent = await store.createTask({
        parent_task_id: 1,
        title: "Target Parent",
        sessionId: "sess_123",
        project_path: "unknown",
        context: "{}"
      });
      
      // Create child under dummy
      const childTask = await store.createTask({
        parent_task_id: dummyTask.id,
        title: "Child",
        sessionId: "sess_123",
        project_path: "unknown",
        context: "{}"
      });
      
      // Verify initial state
      expect(childTask.parent_task_id).toBe(dummyTask.id);
      
      // Update to target parent
      const updated = await store.updateTask(childTask.id, {
        parent_task_id: targetParent.id
      });
      
      expect(updated?.parent_task_id).toBe(targetParent.id);
    });
    
    it("should update parent_task_id to null to make it a root task", async () => {
      const parentTask = await store.createTask({
        parent_task_id: 1,
        title: "Parent",
        sessionId: "sess_123",
        project_path: "unknown",
        context: "{}"
      });
      
      const childTask = await store.createTask({
        parent_task_id: parentTask.id,
        title: "Child",
        sessionId: "sess_123",
        project_path: "unknown",
        context: "{}"
      });
      
      expect(childTask.parent_task_id).toBe(parentTask.id);
      
      const updated = await store.updateTask(childTask.id, {
        parent_task_id: null
      });
      
      expect(updated?.parent_task_id).toBeUndefined();
      expect(updated?.title).toBe("Child"); // 其他字段不受影响
    });
    
    it("should return undefined when updating non-existent task", async () => {
      const result = await store.updateTask(99999, {
        parent_task_id: 1
      });
      
      expect(result).toBeUndefined();
    });
  });
  
  describe("operations", () => {
    it("should create and list operations", async () => {
      const task = await store.createTask({
        parent_task_id: 1, 
        title: "Task", 
        sessionId: "sess_123",
        project_path: "unknown",
        context: "{}"
      });
      
      await store.createOperation({
        taskId: task.id,
        sessionId: "sess_123",
        actionType: "create",
        actionTitle: "Task created",
      });
      
      await store.createOperation({
        taskId: task.id,
        sessionId: "sess_456",
        project_path: "unknown",
        context: "{}",
        actionType: "progress",
        actionTitle: "Made progress",
      });
      
      const ops = await store.listOperations({ taskId: task.id });
      expect(ops.length).toBe(2);
    });
    
    it("should track sessionId for each operation", async () => {
      const task = await store.createTask({
        parent_task_id: 1, 
        title: "Task", 
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}"
      });
      
      await store.createOperation({
        taskId: task.id,
        sessionId: "sess_1",
        actionType: "create",
        actionTitle: "Started in session 1",
      });
      
      await store.createOperation({
        taskId: task.id,
        sessionId: "sess_2",
        project_path: "unknown",
        context: "{}",
        actionType: "progress",
        actionTitle: "Continued in session 2",
      });
      
      await store.createOperation({
        taskId: task.id,
        sessionId: "sess_3",
        project_path: "unknown",
        context: "{}",
        actionType: "milestone",
        actionTitle: "Reached milestone in session 3",
      });
      
      const ops = await store.listOperations({ taskId: task.id });
      const sessions = new Set(ops.map(op => op.sessionId));
      expect(sessions.has("sess_1")).toBe(true);
      expect(sessions.has("sess_2")).toBe(true);
      expect(sessions.has("sess_3")).toBe(true);
    });
    
    it("should filter operations by action type", async () => {
      const task = await store.createTask({
        parent_task_id: 1, 
        title: "Task", 
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}"
      });
      
      await store.createOperation({
        taskId: task.id,
        sessionId: "sess_1",
        actionType: "create",
        actionTitle: "Created",
      });
      
      await store.createOperation({
        taskId: task.id,
        sessionId: "sess_2",
        actionType: "progress",
        actionTitle: "Progress 1",
      });
      
      await store.createOperation({
        taskId: task.id,
        sessionId: "sess_3",
        actionType: "progress",
        actionTitle: "Progress 2",
      });
      
      const progressOps = await store.listOperations({ 
        taskId: task.id, 
        actionType: "progress" 
      });
      
      expect(progressOps.length).toBe(2);
      expect(progressOps.every(op => op.actionType === "progress")).toBe(true);
    });
    
    it("should support pagination", async () => {
      const task = await store.createTask({
        parent_task_id: 1, 
        title: "Task", 
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}"
      });
      
      // Create 5 operations
      for (let i = 0; i < 5; i++) {
        await store.createOperation({
          taskId: task.id,
          sessionId: `sess_${i}`,
          actionType: "progress",
          actionTitle: `Progress ${i}`,
        });
      }
      
      // Get first 2
      const firstPage = await store.listOperations({ 
        taskId: task.id, 
        limit: 2, 
        offset: 0 
      });
      expect(firstPage.length).toBe(2);
      
      // Get next 2
      const secondPage = await store.listOperations({ 
        taskId: task.id, 
        limit: 2, 
        offset: 2 
      });
      expect(secondPage.length).toBe(2);
    });
  });
  
  describe("listTasks", () => {
    it("should list tasks with default order", async () => {
      await store.createTask({
        parent_task_id: 1, 
        title: "Task 1", 
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}"
      });
      await store.createTask({
        parent_task_id: 1, 
        title: "Task 2", 
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}"
      });
      
      const result = await store.listTasks();
      expect(result.tasks.length).toBe(2);
      expect(result.total).toBe(2);
    });
    
    it("should filter by status", async () => {
      const task1 = await store.createTask({
        parent_task_id: 1, 
        title: "Active Task", 
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}"
      });
      const task2 = await store.createTask({
        parent_task_id: 1, 
        title: "Todo Task", 
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}"
      });
      
      await store.updateTask(task1.id, { status: "active" });
      
      const activeTasks = (await store.listTasks({ status: "active" })).tasks;
      expect(activeTasks.length).toBe(1);
      expect(activeTasks[0].title).toBe("Active Task");
    });
    
    it("should filter by priority", async () => {
      const task1 = await store.createTask({
        parent_task_id: 1, 
        title: "High Task", 
        sessionId: "sess_1", 
        priority: "high",
        project_path: "unknown",
        context: "{}"
      });
      const task2 = await store.createTask({
        parent_task_id: 1, 
        title: "Low Task", 
        sessionId: "sess_1", 
        priority: "low",
        project_path: "unknown",
        context: "{}"
      });
      
      const highTasks = (await store.listTasks({ priority: "high" })).tasks;
      expect(highTasks.length).toBe(1);
      expect(highTasks[0].title).toBe("High Task");
    });
    
    it("should filter by type", async () => {
      const task1 = await store.createTask({
        parent_task_id: 1,
        title: "Cycle Task",
        sessionId: "sess_1",
        type: "cycle",
        project_path: "unknown",
        context: "{}"
      });
      await store.createTask({
        parent_task_id: 1,
        title: "Normal Task",
        sessionId: "sess_1",
        type: "normal",
        project_path: "unknown",
        context: "{}"
      });
      
      const cycleTasks = (await store.listTasks({ type: "cycle" })).tasks;
      expect(cycleTasks.length).toBe(1);
      expect(cycleTasks[0].title).toBe("Cycle Task");
    });

    it("should return total before pagination", async () => {
      // Create 5 tasks
      for (let i = 0; i < 5; i++) {
        await store.createTask({
        parent_task_id: 1,
          title: `Task ${i}`,
          sessionId: "sess_1",
          project_path: "unknown",
          context: "{}",
        });
      }

      // List with limit=2, offset=0
      const page1 = await store.listTasks({ limit: 2, offset: 0 });
      expect(page1.tasks.length).toBe(2);
      expect(page1.total).toBe(5);

      // List with limit=2, offset=2
      const page2 = await store.listTasks({ limit: 2, offset: 2 });
      expect(page2.tasks.length).toBe(2);
      expect(page2.total).toBe(5);
    });
  });

  describe("type field", () => {
    it("should default type to normal when not provided", async () => {
      const task = await store.createTask({
        parent_task_id: 1,
        title: "Default Type Task",
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}"
      });
      
      expect(task.type).toBe("normal");
    });
    
    it("should create task with cycle type", async () => {
      const task = await store.createTask({
        parent_task_id: 1,
        title: "Cycle Task",
        sessionId: "sess_1",
        type: "cycle",
        project_path: "unknown",
        context: "{}"
      });
      
      expect(task.type).toBe("cycle");
    });
    
    it("should create task with longterm type", async () => {
      const task = await store.createTask({
        parent_task_id: 1,
        title: "Longterm Task",
        sessionId: "sess_1",
        type: "longterm",
        project_path: "unknown",
        context: "{}"
      });
      
      expect(task.type).toBe("longterm");
    });
    
    it("should update task type", async () => {
      const task = await store.createTask({
        parent_task_id: 1,
        title: "Updatable Task",
        sessionId: "sess_1",
        type: "normal",
        project_path: "unknown",
        context: "{}"
      });
      
      const updated = await store.updateTask(task.id, { type: "cycle" });
      expect(updated?.type).toBe("cycle");
    });
    
    it("should return type in getTask", async () => {
      const task = await store.createTask({
        parent_task_id: 1,
        title: "Gettable Task",
        sessionId: "sess_1",
        type: "longterm",
        project_path: "unknown",
        context: "{}"
      });
      
      const fetched = await store.getTask(task.id);
      expect(fetched?.type).toBe("longterm");
    });
  });
  
  describe("searchTasksByKeywords", () => {
    it("should limit results to specified limit", async () => {
      // Create 10 tasks with same tag
      for (let i = 0; i < 10; i++) {
        await store.createTask({
        parent_task_id: 1, 
          title: `Task ${i}`, 
          sessionId: "sess_1",
          tags: ["test-tag"],
          project_path: "unknown",
          context: "{}",
        });
      }
      
      // Search with limit=5
      const { tasks: results } = await store.searchTasksByKeywords(["test-tag"], { limit: 5 });
      expect(results.length).toBe(5);
    });
    
    it("should limit findSimilarTasksByKeywords to 5 by default", async () => {
      // Create 10 tasks with same tag
      for (let i = 0; i < 10; i++) {
        await store.createTask({
        parent_task_id: 1, 
          title: `Similar Task ${i}`, 
          sessionId: "sess_1",
          tags: ["feature"],
          project_path: "unknown",
          context: "{}",
        });
      }
      
      // Search without explicit limit - should use default 5
      const results = await store.findSimilarTasksByKeywords(["feature"]);
      expect(results.length).toBe(5);
    });
    
    it("should exclude specified taskId", async () => {
      const targetTask = await store.createTask({
        parent_task_id: 1, 
        title: "Target Task", 
        sessionId: "sess_1",
        tags: ["bug"],
        project_path: "unknown",
        context: "{}",
      });
      
      // Create some similar tasks
      await store.createTask({
        parent_task_id: 1, 
        title: "Bug 1", 
        sessionId: "sess_1", 
        tags: ["bug"],
        project_path: "unknown",
        context: "{}"
      });
      await store.createTask({
        parent_task_id: 1, 
        title: "Bug 2", 
        sessionId: "sess_1", 
        tags: ["bug"],
        project_path: "unknown",
        context: "{}"
      });
      
      // Search excluding target task
      const { tasks: results } = await store.searchTasksByKeywords(["bug"], {
        limit: 10,
        excludeTaskId: targetTask.id
      });

      // Should not contain target task
      expect(results.some(t => t.id === targetTask.id)).toBe(false);
    });
  });

  // ========================================================================
  // 层级检索（Phase 3）
  // ========================================================================

  describe("listTasks depth filter", () => {
    it("should return only root tasks when depth=0", async () => {
      const root = await store.createTask({
        title: "Root Task",
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}",
      });
      await store.createTask({
        parent_task_id: root.id,
        title: "Child Task",
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}",
      });
      // 另一个根任务
      const root2 = await store.createTask({
        title: "Another Root",
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}",
      });

      const { tasks, total } = await store.listTasks({ depth: 0 });
      expect(total).toBe(2);
      const ids = tasks.map(t => t.id);
      expect(ids).toContain(root.id);
      expect(ids).toContain(root2.id);
    });

    it("should include one level of children when depth=1", async () => {
      const root = await store.createTask({
        title: "Root",
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}",
      });
      const child = await store.createTask({
        parent_task_id: root.id,
        title: "Child",
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}",
      });
      const grand = await store.createTask({
        parent_task_id: child.id,
        title: "Grandchild",
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}",
      });

      const { tasks, total } = await store.listTasks({ depth: 1 });
      const ids = tasks.map(t => t.id);
      expect(ids).toContain(root.id);
      expect(ids).toContain(child.id);
      expect(ids).not.toContain(grand.id);
      expect(total).toBe(2);
    });

    it("should include multi-level subtree when depth>=2", async () => {
      const root = await store.createTask({
        title: "Root",
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}",
      });
      const child = await store.createTask({
        parent_task_id: root.id,
        title: "Child",
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}",
      });
      const grand = await store.createTask({
        parent_task_id: child.id,
        title: "Grand",
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}",
      });

      const { tasks, total } = await store.listTasks({ depth: 2 });
      const ids = tasks.map(t => t.id);
      expect(ids).toContain(root.id);
      expect(ids).toContain(child.id);
      expect(ids).toContain(grand.id);
      expect(total).toBe(3);
    });

    it("should not apply depth filter when depth is undefined (backward compat)", async () => {
      const root = await store.createTask({
        title: "Root",
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}",
      });
      const child = await store.createTask({
        parent_task_id: root.id,
        title: "Child",
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}",
      });

      const { total } = await store.listTasks({});
      expect(total).toBe(2); // 全部
    });
  });

  describe("getTaskTree", () => {
    it("should return all descendants of a task (BFS, unlimited depth)", async () => {
      const root = await store.createTask({
        title: "Root",
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}",
      });
      const c1 = await store.createTask({
        title: "C1",
        parent_task_id: root.id,
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}",
      });
      const c2 = await store.createTask({
        title: "C2",
        parent_task_id: root.id,
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}",
      });
      const g1 = await store.createTask({
        title: "G1",
        parent_task_id: c1.id,
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}",
      });
      const gg1 = await store.createTask({
        title: "GG1",
        parent_task_id: g1.id,
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}",
      });

      const tree = await store.getTaskTree(root.id);
      const ids = tree.map(t => t.id);
      expect(ids).toContain(c1.id);
      expect(ids).toContain(c2.id);
      expect(ids).toContain(g1.id);
      expect(ids).toContain(gg1.id);
      expect(ids).not.toContain(root.id); // 不含自己
      expect(tree.length).toBe(4);
    });

    it("should respect depth limit", async () => {
      const root = await store.createTask({
        title: "Root",
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}",
      });
      const c1 = await store.createTask({
        title: "C1",
        parent_task_id: root.id,
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}",
      });
      await store.createTask({
        title: "G1",
        parent_task_id: c1.id,
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}",
      });

      const tree = await store.getTaskTree(root.id, 1);
      expect(tree.length).toBe(1);
      expect(tree[0].id).toBe(c1.id);
    });

    it("should return empty array for leaf task", async () => {
      const leaf = await store.createTask({
        title: "Leaf",
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}",
      });
      const tree = await store.getTaskTree(leaf.id);
      expect(tree).toEqual([]);
    });
  });

  describe("getChildTasks", () => {
    it("should return only direct children", async () => {
      const root = await store.createTask({
        title: "Root",
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}",
      });
      const c1 = await store.createTask({
        title: "C1",
        parent_task_id: root.id,
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}",
      });
      const c2 = await store.createTask({
        title: "C2",
        parent_task_id: root.id,
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}",
      });
      const g1 = await store.createTask({
        title: "G1",
        parent_task_id: c1.id,
        sessionId: "sess_1",
        project_path: "unknown",
        context: "{}",
      });

      const { tasks } = await store.getChildTasks(root.id);
      const ids = tasks.map(t => t.id);
      expect(ids).toContain(c1.id);
      expect(ids).toContain(c2.id);
      expect(ids).not.toContain(g1.id); // 不含孙子
    });
  });

  /**
   * Bug 修复 #4033：`roy-bot tasks list` 在遇到损坏的 tags 数据时崩溃
   * (`JSON.parse` on CSV-style string)。
   *
   * 复现：tags 字段存的是 CSV 字符串 `'html-styling, css-refactor, v34, feishu, slides'`
   * 而不是合法的 JSON 数组 `["html-styling", ...]`。
   *
   * 旧实现：`tags: row.tags ? JSON.parse(row.tags) : undefined`
   *  → 整个 listTasks 抛 SyntaxError，CLI 不显示任何任务（ORDER BY updated_at DESC
   *    把 #4033 排在第一）。
   *
   * 新实现：`parseTagsSafely(row.tags)`，对非法 JSON fallback 为单元素数组，
   * 不抛错，保证 CLI 可用。
   */
  describe("rowToTask tags fallback (Bug 修复 #4033)", () => {
    /**
     * 直接注入损坏数据到 DB：模拟历史写入了 CSV / 纯文本 / 损坏数据的情况。
     * 注意：必须绕开 syncTaskTagsJson（它在 getTask/updateTask 后会把 tags
     * 重新 JSON 化），所以我们用 SQLite 直连。
     */
    async function seedBadTagsAndSeedTasks(s: TaskStore, badTagsByTaskId: Record<number, string | null>) {
      // 通过 createTask 让 store 自己初始化 DB
      for (const [tid, raw] of Object.entries(badTagsByTaskId)) {
        await s.createTask({
          parent_task_id: 1,
          title: `corrupt-${tid}`,
          sessionId: "sess_corrupt",
          project_path: "unknown",
          context: "{}",
          tags: ["placeholder"],
        });
      }
      // 注入损坏数据 — 直接通过 better-sqlite3 句柄
      const internalDb = (s as any).db;
      for (const [tid, raw] of Object.entries(badTagsByTaskId)) {
        internalDb.prepare("UPDATE task SET tags = ? WHERE title = ?").run(raw, `corrupt-${tid}`);
      }
    }

    it("rowToTask should NOT throw when tags is a CSV string (Task #4033 case)", async () => {
      await seedBadTagsAndSeedTasks(store, { "1": "html-styling, css-refactor, v34, feishu, slides" });
      // 必须不抛错
      let result;
      expect(() => {
        result = store.listTasks({ limit: 100 });
      }).not.toThrow();
      const { tasks } = await store.listTasks({ limit: 100 });
      const corrupt = tasks.find(t => t.title === "corrupt-1");
      expect(corrupt).toBeDefined();
      // 保守 fallback：整段 CSV 包成单元素数组
      expect(corrupt!.tags).toEqual(["html-styling, css-refactor, v34, feishu, slides"]);
    });

    it("should return undefined for null tags", async () => {
      await store.createTask({
        parent_task_id: 1,
        title: "no-tags",
        sessionId: "sess_x",
        project_path: "unknown",
        context: "{}",
      });
      const read = await store.getTask((await store.listTasks({ limit: 1 })).tasks[0].id);
      expect(read?.tags === null || read?.tags === undefined).toBe(true);
    });

    it("should preserve well-formed JSON array of tags", async () => {
      const t = await store.createTask({
        parent_task_id: 1,
        title: "good-array",
        sessionId: "sess_g",
        project_path: "unknown",
        context: "{}",
        tags: ["alpha", "beta", "gamma"],
      });
      const read = await store.getTask(t.id);
      expect(read?.tags).toEqual(["alpha", "beta", "gamma"]);
    });
  });
});
