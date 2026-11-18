/**
 * @fileoverview Tests for TaskStore searchTasksByKeywords functionality
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SQLiteTaskStore } from "./sqlite-task-store";

describe("TaskStore.searchTasks with keywords", () => {
  let store: SQLiteTaskStore;

  beforeEach(async () => {
    store = new SQLiteTaskStore(":memory:");
  });

  afterEach(async () => {
    await store.close();
  });

  // ========================================================================
  // 基本搜索
  // ========================================================================

  test("should find tasks by keyword (single keyword)", async () => {
    // Create tasks
    await store.createTask({
        parent_task_id: 1,
        title: "Fix login bug",
      description: "Login page has issues",
      tags: ["bug", "authentication"],
      sessionId: "test",
      project_path: "unknown",
      context: "{}",
    });
    await store.createTask({
        parent_task_id: 1,
        title: "Add new feature",
      description: "Implement new feature",
      tags: ["feature"],
      sessionId: "test",
      project_path: "unknown",
      context: "{}",
    });

    const { tasks: results } = await store.searchTasksByKeywords(["login"]);

    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Fix login bug");
  });

  test("should support multi-keyword AND search", async () => {
    await store.createTask({
        parent_task_id: 1,
        title: "Fix login bug",
      description: "Login page has issues",
      tags: ["bug", "authentication"],
      sessionId: "test",
      project_path: "unknown",
      context: "{}",
    });
    await store.createTask({
        parent_task_id: 1,
        title: "Fix register bug",
      description: "Register page has issues",
      tags: ["bug"],
      sessionId: "test",
      project_path: "unknown",
      context: "{}",
    });

    const { tasks: results } = await store.searchTasksByKeywords(["fix", "login"]);

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].title).toContain("login");
  });

  // ========================================================================
  // 关键字列表搜索
  // ========================================================================

  test("should support keywords array parameter", async () => {
    await store.createTask({
        parent_task_id: 1,
        title: "Implement user authentication",
      description: "User login and logout",
      tags: ["auth", "security"],
      sessionId: "test",
      project_path: "unknown",
      context: "{}",
    });

    const { tasks: results } = await store.searchTasksByKeywords(["auth", "user", "security"]);

    expect(results.length).toBe(1);
    expect(results[0].title).toContain("authentication");
  });

  test("should search in tags field", async () => {
    await store.createTask({
        parent_task_id: 1,
        title: "Task 1",
      description: "Description",
      tags: ["typescript", "backend"],
      sessionId: "test",
      project_path: "unknown",
      context: "{}",
    });

    const { tasks: results } = await store.searchTasksByKeywords(["typescript"]);

    expect(results.length).toBe(1);
    expect(results[0].tags).toContain("typescript");
  });

  test("should search in description field", async () => {
    await store.createTask({
        parent_task_id: 1,
        title: "Task without keyword in title",
      description: "This is about database optimization",
      sessionId: "test",
      project_path: "unknown",
      context: "{}",
    });

    const { tasks: results } = await store.searchTasksByKeywords(["database"]);

    expect(results.length).toBe(1);
    expect(results[0].description).toContain("database");
  });

  test("should search in goals_and_expected_deliverables field", async () => {
    await store.createTask({
        parent_task_id: 1,
        title: "Task without keyword in title",
      description: "General description",
      goals_and_expected_deliverables: "Improve API performance by 50%",
      sessionId: "test",
      project_path: "unknown",
      context: "{}",
    });

    const { tasks: results } = await store.searchTasksByKeywords(["performance"]);

    expect(results.length).toBe(1);
    expect(results[0].goals_and_expected_deliverables).toContain("performance");
  });

  test("should search in operation records", async () => {
    const task = await store.createTask({
        parent_task_id: 1,
        title: "Task with operation",
      description: "Description",
      sessionId: "test",
      project_path: "unknown",
      context: "{}",
    });

    await store.createOperation({
      taskId: task.id,
      sessionId: "test",
      project_path: "unknown",
      context: "{}",
      actionType: "solution",
      actionTitle: "Implemented caching mechanism",
      actionDescription: "Added Redis caching for API responses",
    });

    const { tasks: results } = await store.searchTasksByKeywords(["caching", "redis"]);

    expect(results.length).toBe(1);
    expect(results[0].id).toBe(task.id);
  });

  test("should exclude specified task ID", async () => {
    const task1 = await store.createTask({
        parent_task_id: 1,
        title: "Duplicate task",
      description: "Same description",
      tags: ["test"],
      sessionId: "test",
      project_path: "unknown",
      context: "{}",
    });
    await store.createTask({
        parent_task_id: 1,
        title: "Another task",
      description: "Same description",
      tags: ["test"],
      sessionId: "test",
      project_path: "unknown",
      context: "{}",
    });

    const { tasks: results } = await store.searchTasksByKeywords(["test"], { excludeTaskId: task1.id });

    expect(results.length).toBe(1);
    expect(results[0].id).not.toBe(task1.id);
  });

  test("should support limit parameter", async () => {
    // Create 5 tasks with same tag
    for (let i = 0; i < 5; i++) {
      await store.createTask({
        parent_task_id: 1,
        title: `Task ${i}`,
        description: "Same description with keyword",
        tags: ["test"],
        sessionId: "test",
      project_path: "unknown",
      context: "{}",
      });
    }

    const { tasks: results } = await store.searchTasksByKeywords(["keyword"], { limit: 2 });

    expect(results.length).toBeLessThanOrEqual(2);
  });

  // ========================================================================
  // 类似任务查找
  // ========================================================================

  test("should find similar tasks by tags", async () => {
    const task1 = await store.createTask({
        parent_task_id: 1,
        title: "Task 1",
      description: "Description",
      tags: ["bug", "backend"],
      sessionId: "test",
      project_path: "unknown",
      context: "{}",
    });
    const task2 = await store.createTask({
        parent_task_id: 1,
        title: "Task 2",
      description: "Description",
      tags: ["bug", "frontend"],
      sessionId: "test",
      project_path: "unknown",
      context: "{}",
    });
    await store.createTask({
        parent_task_id: 1,
        title: "Task 3",
      description: "Description",
      tags: ["feature"],
      sessionId: "test",
      project_path: "unknown",
      context: "{}",
    });

    const results = await store.findSimilarTasksByKeywords(["bug"], { excludeTaskId: task1.id });

    expect(results.length).toBe(1);
    expect(results[0].id).toBe(task2.id);
  });

  test("should exclude itself from results", async () => {
    const task = await store.createTask({
        parent_task_id: 1,
        title: "My task",
      description: "My description",
      tags: ["test"],
      sessionId: "test",
      project_path: "unknown",
      context: "{}",
    });

    const results = await store.findSimilarTasksByKeywords(["test"], { excludeTaskId: task.id });

    expect(results.length).toBe(0);
  });

  test("should sort by relevance", async () => {
    const task1 = await store.createTask({
        parent_task_id: 1,
        title: "Task 1",
      description: "Description with bug",
      tags: ["bug"],
      sessionId: "test",
      project_path: "unknown",
      context: "{}",
    });
    const task2 = await store.createTask({
        parent_task_id: 1,
        title: "Task 2",
      description: "Description",
      tags: ["bug", "backend", "api"],
      sessionId: "test",
      project_path: "unknown",
      context: "{}",
    });

    const results = await store.findSimilarTasksByKeywords(["bug"]);
    // With single keyword "bug", both tasks match but task1 has more relevance (bug in description + tags)
    expect(results[0].id).toBe(task1.id);  // task1 has higher matchCount (description=1 + tags=2 = 3)
    expect(results[1].id).toBe(task2.id);  // task2 only matches tags (matchCount=2)
  });

  // ========================================================================
  // 向后兼容
  // ========================================================================

  test("original query parameter should still work", async () => {
    await store.createTask({
        parent_task_id: 1,
        title: "Login feature",
      description: "Implement login",
      sessionId: "test",
      project_path: "unknown",
      context: "{}",
    });

    const results = await store.searchTasks("login");

    expect(results.length).toBe(1);
    expect(results[0].title).toContain("Login");
  });

  // ========================================================================
  // 边界情况
  // ========================================================================

  test("should return empty array when no results", async () => {
    const { tasks: results } = await store.searchTasksByKeywords(["nonexistent"]);

    expect(results.length).toBe(0);
  });

  test("should return empty array for empty keywords list", async () => {
    await store.createTask({
        parent_task_id: 1,
        title: "Test task",
      description: "Description",
      sessionId: "test",
      project_path: "unknown",
      context: "{}",
    });

    const { tasks: results } = await store.searchTasksByKeywords([]);

    expect(results.length).toBe(0);
  });

  test("should handle case insensitivity", async () => {
    await store.createTask({
        parent_task_id: 1,
        title: "BUG FIX",
      description: "Description",
      tags: ["BACKEND"],
      sessionId: "test",
      project_path: "unknown",
      context: "{}",
    });

    const { tasks: results } = await store.searchTasksByKeywords(["bug", "backend"]);

    expect(results.length).toBe(1);
  });

  // ========================================================================
  // 层级过滤（Phase 3）
  // ========================================================================

  describe("searchTasksByKeywords with depth", () => {
    test("depth=0 should only return root tasks", async () => {
      const root = await store.createTask({
        title: "SearchRoot",
        tags: ["depth-test"],
        sessionId: "test",
        project_path: "unknown",
        context: "{}",
      });
      const child = await store.createTask({
        title: "SearchChild",
        tags: ["depth-test"],
        parent_task_id: root.id,
        sessionId: "test",
        project_path: "unknown",
        context: "{}",
      });

      const { tasks, total } = await store.searchTasksByKeywords(
        ["depth-test"],
        { depth: 0 }
      );
      const ids = tasks.map(t => t.id);
      expect(ids).toContain(root.id);
      expect(ids).not.toContain(child.id);
      expect(total).toBe(1);
    });

    test("depth=1 should include root and direct children", async () => {
      const root = await store.createTask({
        title: "Root",
        tags: ["d"],
        sessionId: "test",
        project_path: "unknown",
        context: "{}",
      });
      const child = await store.createTask({
        title: "Child",
        tags: ["d"],
        parent_task_id: root.id,
        sessionId: "test",
        project_path: "unknown",
        context: "{}",
      });
      const grand = await store.createTask({
        title: "Grand",
        tags: ["d"],
        parent_task_id: child.id,
        sessionId: "test",
        project_path: "unknown",
        context: "{}",
      });

      const { tasks, total } = await store.searchTasksByKeywords(["d"], {
        depth: 1,
      });
      const ids = tasks.map(t => t.id);
      expect(ids).toContain(root.id);
      expect(ids).toContain(child.id);
      expect(ids).not.toContain(grand.id);
      expect(total).toBe(2);
    });

    test("depth undefined should include all matching tasks", async () => {
      const root = await store.createTask({
        title: "RootX",
        tags: ["dx"],
        sessionId: "test",
        project_path: "unknown",
        context: "{}",
      });
      const child = await store.createTask({
        title: "ChildX",
        tags: ["dx"],
        parent_task_id: root.id,
        sessionId: "test",
        project_path: "unknown",
        context: "{}",
      });
      const grand = await store.createTask({
        title: "GrandX",
        tags: ["dx"],
        parent_task_id: child.id,
        sessionId: "test",
        project_path: "unknown",
        context: "{}",
      });

      const { total } = await store.searchTasksByKeywords(["dx"]);
      expect(total).toBe(3);
    });
  });
});
