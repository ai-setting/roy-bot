/**
 * @fileoverview TagService Tests
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { DefaultTagService } from "./tag-service";
import { SQLiteTaskStore } from "./storage/sqlite-task-store";
import type { TaskStore } from "./storage/sqlite-task-store";

describe("TagService", () => {
  let store: TaskStore;
  let tagService: DefaultTagService;

  beforeEach(() => {
    store = new SQLiteTaskStore(":memory:");
    tagService = new DefaultTagService(store);
  });

  afterEach(async () => {
    await store.close();
  });

  describe("Tag CRUD", () => {
    test("should create a tag", async () => {
      const tag = await tagService.createTag("bug");
      
      expect(tag.id).toBeDefined();
      expect(tag.name).toBe("bug");
      expect(tag.taskCount).toBe(0);
    });

    test("should return existing tag if name already exists", async () => {
      const tag1 = await tagService.createTag("feature");
      const tag2 = await tagService.createTag("feature");
      
      expect(tag1.id).toBe(tag2.id);
      expect(tag2.name).toBe("feature");
    });

    test("should get tag by id", async () => {
      const created = await tagService.createTag("docs");
      const retrieved = await tagService.getTag(created.id);
      
      expect(retrieved?.name).toBe("docs");
    });

    test("should get tag by name", async () => {
      await tagService.createTag("refactor");
      const tag = await tagService.getTagByName("refactor");
      
      expect(tag?.name).toBe("refactor");
    });

    test("should list tags ordered by count", async () => {
      await tagService.createTag("tag1");
      await tagService.createTag("tag2");
      await tagService.createTag("tag3");
      
      const tags = await tagService.listTags({ orderBy: "count" });
      
      expect(tags).toHaveLength(3);
      expect(tags[0].name).toBe("tag1");
    });

    test("should search tags by name", async () => {
      await tagService.createTag("bug");
      await tagService.createTag("bug-fix");
      await tagService.createTag("feature");
      
      const results = await tagService.searchTags({ query: "bug" });
      
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results.some(t => t.name === "bug")).toBe(true);
      expect(results.some(t => t.name === "bug-fix")).toBe(true);
    });

    test("should delete tag", async () => {
      const tag = await tagService.createTag("to-delete");
      const result = await tagService.deleteTag(tag.id);
      
      expect(result).toBe(true);
      expect(await tagService.getTag(tag.id)).toBeUndefined();
    });
  });

  describe("Tag and Task Association", () => {
    test("should add tags to task", async () => {
      // Create task first
      const task = await store.createTask({
        parent_task_id: 1,
        title: "Test Task",
        sessionId: "test-session",
        project_path: "unknown",
        context: "{}",
      });
      
      const tag1 = await tagService.createTag("frontend");
      const tag2 = await tagService.createTag("ui");
      
      await tagService.addTagsToTask(task.id, [tag1.id, tag2.id]);
      
      const tags = await tagService.getTagsForTask(task.id);
      expect(tags).toHaveLength(2);
      expect(tags.map(t => t.name)).toContain("frontend");
      expect(tags.map(t => t.name)).toContain("ui");
    });

    test("should remove tags from task", async () => {
      const task = await store.createTask({
        parent_task_id: 1,
        title: "Test Task",
        sessionId: "test-session",
        project_path: "unknown",
        context: "{}",
      });
      
      const tag = await tagService.createTag("test");
      await tagService.addTagsToTask(task.id, [tag.id]);
      await tagService.removeTagsFromTask(task.id, [tag.id]);
      
      const tags = await tagService.getTagsForTask(task.id);
      expect(tags).toHaveLength(0);
    });

    test("should get task IDs by tag names", async () => {
      const task1 = await store.createTask({
        parent_task_id: 1,
        title: "Task 1",
        sessionId: "test-session",
        project_path: "unknown",
        context: "{}",
      });
      const task2 = await store.createTask({
        parent_task_id: 1,
        title: "Task 2",
        sessionId: "test-session",
        project_path: "unknown",
        context: "{}",
      });
      
      const tag = await tagService.createTag("common");
      await tagService.addTagsToTask(task1.id, [tag.id]);
      await tagService.addTagsToTask(task2.id, [tag.id]);
      
      const taskIds = await tagService.getTaskIdsByTags(["common"]);
      
      expect(taskIds).toContain(task1.id);
      expect(taskIds).toContain(task2.id);
    });

    test("should sync tags to task", async () => {
      const task = await store.createTask({
        parent_task_id: 1,
        title: "Test Task",
        sessionId: "test-session",
        project_path: "unknown",
        context: "{}",
      });
      
      await tagService.syncTagsToTask(task.id, ["new-tag1", "new-tag2"]);
      
      const tags = await tagService.getTagsForTask(task.id);
      expect(tags).toHaveLength(2);
      expect(tags.map(t => t.name)).toContain("new-tag1");
      expect(tags.map(t => t.name)).toContain("new-tag2");
    });
  });

  describe("Retrieval Capabilities", () => {
    // TODO: Skip until findSimilarTasks is implemented
    test.skip("should find similar tasks by tags", async () => {
      const task1 = await store.createTask({
        parent_task_id: 1,
        title: "Task 1",
        sessionId: "test-session",
        project_path: "unknown",
        context: "{}",
      });
      const task2 = await store.createTask({
        parent_task_id: 1,
        title: "Task 2",
        sessionId: "test-session",
        project_path: "unknown",
        context: "{}",
      });
      const task3 = await store.createTask({
        parent_task_id: 1,
        title: "Task 3",
        sessionId: "test-session",
        project_path: "unknown",
        context: "{}",
      });
      
      const tag1 = await tagService.createTag("bug");
      const tag2 = await tagService.createTag("frontend");
      
      await tagService.addTagsToTask(task1.id, [tag1.id, tag2.id]);
      await tagService.addTagsToTask(task2.id, [tag1.id]);
      await tagService.addTagsToTask(task3.id, [tag2.id]);
      
      const similar = await tagService.findSimilarTasks(task1.id, 5);
      
      // Should find task2 (1 tag match) before task3 (0 tag match)
      expect(similar.length).toBeGreaterThan(0);
      expect(similar[0].id).toBe(task2.id);
    });

    test("should search tasks by query", async () => {
      await store.createTask({
        parent_task_id: 1,
        title: "Fix login bug",
        description: "Users cannot login",
        sessionId: "test-session",
        project_path: "unknown",
        context: "{}",
      });
      await store.createTask({
        parent_task_id: 1,
        title: "Add feature",
        description: "New feature request",
        sessionId: "test-session",
        project_path: "unknown",
        context: "{}",
      });
      
      const results = await tagService.searchTasks("login");
      
      expect(results.length).toBe(1);
      expect(results[0].title).toContain("login");
    });
  });
});
