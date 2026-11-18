/**
 * @fileoverview Task Types Tests
 */

import { describe, it, expect } from "bun:test";
import {
  TaskStatusEnum,
  TaskPriorityEnum,
  ActionTypeEnum,
  Task,
  TaskOperation,
} from "./types";

describe("Task Types", () => {
  describe("TaskStatusEnum", () => {
    it("should accept valid status values", () => {
      expect(TaskStatusEnum.parse("todo")).toBe("todo");
      expect(TaskStatusEnum.parse("active")).toBe("active");
      expect(TaskStatusEnum.parse("completed")).toBe("completed");
      expect(TaskStatusEnum.parse("paused")).toBe("paused");
      expect(TaskStatusEnum.parse("cancelled")).toBe("cancelled");
    });

    it("should reject invalid status values", () => {
      expect(() => TaskStatusEnum.parse("invalid")).toThrow();
      expect(() => TaskStatusEnum.parse("pending")).toThrow();
    });
  });

  describe("TaskPriorityEnum", () => {
    it("should accept valid priority values", () => {
      expect(TaskPriorityEnum.parse("low")).toBe("low");
      expect(TaskPriorityEnum.parse("medium")).toBe("medium");
      expect(TaskPriorityEnum.parse("high")).toBe("high");
    });

    it("should reject invalid priority values", () => {
      expect(() => TaskPriorityEnum.parse("urgent")).toThrow();
      expect(() => TaskPriorityEnum.parse("critical")).toThrow();
    });
  });

  describe("ActionTypeEnum", () => {
    it("should accept valid action types", () => {
      expect(ActionTypeEnum.parse("create")).toBe("create");
      expect(ActionTypeEnum.parse("progress")).toBe("progress");
      expect(ActionTypeEnum.parse("milestone")).toBe("milestone");
      expect(ActionTypeEnum.parse("problem")).toBe("problem");
      expect(ActionTypeEnum.parse("solution")).toBe("solution");
      expect(ActionTypeEnum.parse("decision")).toBe("decision");
      expect(ActionTypeEnum.parse("review")).toBe("review");
      expect(ActionTypeEnum.parse("completed")).toBe("completed");
    });

    it("should reject invalid action types", () => {
      expect(() => ActionTypeEnum.parse("update")).toThrow();
      expect(() => ActionTypeEnum.parse("delete")).toThrow();
    });
  });

  describe("Task interface", () => {
    it("should have correct structure", () => {
      const task: Task = {
        id: 1,
        title: "Test Task",
        description: "Description",
        status: "todo",
        priority: "high",
        type: "normal",
        progress: 0,
        current_status: "",
        goals_and_expected_deliverables: "",
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:00.000Z",
        project_path: "unknown",
        context: "{}",
      };

      expect(task.id).toBe(1);
      expect(task.title).toBe("Test Task");
      expect(task.status).toBe("todo");
    });

    it("should allow optional fields", () => {
      const task: Task = {
        id: 1,
        title: "Test Task",
        description: "",
        status: "todo",
        priority: "medium",
        type: "normal",
        progress: 0,
        current_status: "",
        goals_and_expected_deliverables: "",
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:00.000Z",
        parent_task_id: 5,
        due_date: "2026-04-30T00:00:00.000Z",
        tags: ["feature", "urgent"],
        project_path: "unknown",
        context: "{}",
      };

      expect(task.parent_task_id).toBe(5);
      expect(task.due_date).toBe("2026-04-30T00:00:00.000Z");
      expect(task.tags).toEqual(["feature", "urgent"]);
    });
  });

  describe("TaskTypeEnum", () => {
  it("should have normal, cycle, longterm values", () => {
    const { TaskTypeEnum } = require("./types");
    const result = TaskTypeEnum.safeParse("normal");
    expect(result.success).toBe(true);
    expect(result.data).toBe("normal");
    
    const cycle = TaskTypeEnum.safeParse("cycle");
    expect(cycle.success).toBe(true);
    
    const longterm = TaskTypeEnum.safeParse("longterm");
    expect(longterm.success).toBe(true);
  });

  it("should reject invalid values", () => {
    const { TaskTypeEnum } = require("./types");
    const result = TaskTypeEnum.safeParse("invalid");
    expect(result.success).toBe(false);
  });
});

describe("TaskOperation interface", () => {
    it("should have correct structure with required sessionId", () => {
      const op: TaskOperation = {
        id: 1,
        taskId: 100,
        sessionId: "sess_abc123",  // 必填！
        actionType: "create",
        actionTitle: "Task created",
        actionDescription: "",
        timestamp: "2026-04-01T00:00:00.000Z",
      };

      expect(op.id).toBe(1);
      expect(op.taskId).toBe(100);
      expect(op.sessionId).toBe("sess_abc123");
      expect(op.actionType).toBe("create");
    });

    it("should allow optional mdPath", () => {
      const op: TaskOperation = {
        id: 1,
        taskId: 100,
        sessionId: "sess_abc123",
        actionType: "progress",
        actionTitle: "Made progress",
        actionDescription: "Completed feature X",
        timestamp: "2026-04-01T00:00:00.000Z",
        mdPath: "/path/to/operation.md",
      };

      expect(op.mdPath).toBe("/path/to/operation.md");
    });
  });
});
