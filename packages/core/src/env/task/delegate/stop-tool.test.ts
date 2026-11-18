/**
 * @fileoverview stop_task Tool Tests
 * 
 * TDD: 红色阶段 - 编写失败的测试
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import type { Tool, ToolContext, ToolResult } from "../../tool/types";

// Mock the tool factory
const createStopTool = async (backgroundTaskManager: any): Promise<Tool> => {
  const module = await import("./stop-tool");
  return module.createStopTool(backgroundTaskManager);
};

describe("stop_task Tool", () => {
  let mockBackgroundTaskManager: any;
  let tool: Tool;

  beforeEach(async () => {
    // Mock BackgroundTaskManager
    mockBackgroundTaskManager = {
      stopTask: vi.fn(),
      getTask: vi.fn(),
    };
    
    tool = await createStopTool(mockBackgroundTaskManager);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("Tool Definition", () => {
    test("should have correct tool name", () => {
      expect(tool.name).toBe("stop_task");
    });

    test("should have description", () => {
      expect(tool.description).toBeDefined();
      expect(tool.description.length).toBeGreaterThan(0);
    });

    test("should have parameters schema", () => {
      expect(tool.parameters).toBeDefined();
      expect(tool.parameters.shape).toBeDefined();
    });

    test("should have task_id field in parameters", () => {
      const shape = tool.parameters.shape;
      expect(shape.task_id).toBeDefined();
    });
  });

  describe("Execution", () => {
    test("should stop a running task successfully", async () => {
      const mockTask = {
        id: "task_123",
        description: "Test task",
        status: "running",
        startedAt: Date.now() - 60000,
      };
      
      mockBackgroundTaskManager.stopTask.mockReturnValue({
        success: true,
        task: mockTask,
        message: "Task has been stopped",
      });

      const result = await tool.execute(
        { task_id: "task_123" },
        { session_id: "test-session" }
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain("Task stopped successfully");
      expect(mockBackgroundTaskManager.stopTask).toHaveBeenCalledWith("task_123");
    });

    test("should return error when task not found", async () => {
      mockBackgroundTaskManager.stopTask.mockReturnValue({
        success: false,
        message: "Task not found",
      });

      const result = await tool.execute(
        { task_id: "non-existent-task" },
        { session_id: "test-session" }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Task not found");
    });

    test("should return error when task already completed", async () => {
      const mockTask = {
        id: "task_456",
        description: "Completed task",
        status: "completed",
      };
      
      mockBackgroundTaskManager.stopTask.mockReturnValue({
        success: false,
        task: mockTask,
        message: "Cannot stop task with status: completed",
      });

      const result = await tool.execute(
        { task_id: "task_456" },
        { session_id: "test-session" }
      );

      expect(result.success).toBe(false);
      expect(result.output).toContain("Cannot stop task");
    });

    test("should include task info in output", async () => {
      const mockTask = {
        id: "task_789",
        description: "Running task",
        status: "running",
        startedAt: Date.now() - 120000,
      };
      
      mockBackgroundTaskManager.stopTask.mockReturnValue({
        success: true,
        task: mockTask,
        message: "Task has been stopped",
      });

      const result = await tool.execute(
        { task_id: "task_789" },
        { session_id: "test-session" }
      );

      expect(result.output).toContain("task_789");
      expect(result.output).toContain("Running task");
    });
  });
});
