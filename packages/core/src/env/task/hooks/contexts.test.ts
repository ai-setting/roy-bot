/**
 * @fileoverview Task Hook Contexts Tests
 */

import { describe, test, expect } from "vitest";
import type {
  TaskCreateContext,
  TaskUpdateContext,
  TaskDeleteContext,
  TaskDelegateContext,
  TaskOperationCreateContext,
  TaskHookContextMap,
} from "./contexts";

describe("Task Hook Contexts", () => {
  test("TaskCreateContext should have required fields", () => {
    const ctx: TaskCreateContext = {
      options: {
        title: "Test Task",
        sessionId: "test-session",
      },
      sessionId: "test-session",
      tagService: {} as any,
    };
    
    expect(ctx.options.title).toBe("Test Task");
    expect(ctx.sessionId).toBe("test-session");
    expect(ctx.tagService).toBeDefined();
  });

  test("TaskUpdateContext should have required fields", () => {
    const ctx: TaskUpdateContext = {
      id: 1,
      options: { title: "Updated Task" },
      tagService: {} as any,
    };
    
    expect(ctx.id).toBe(1);
    expect(ctx.options.title).toBe("Updated Task");
  });

  test("TaskDeleteContext should have required fields", () => {
    const ctx: TaskDeleteContext = { id: 1 };
    expect(ctx.id).toBe(1);
  });

  test("TaskDelegateContext should have required fields", () => {
    const ctx: TaskDelegateContext = {
      taskId: 1,
      prompt: "Do something",
      subagentType: "general",
      tagService: {} as any,
    };

    expect(ctx.taskId).toBe(1);
    expect(ctx.prompt).toBe("Do something");
    expect(ctx.subagentType).toBe("general");
  });

  test("TaskOperationCreateContext should have required fields", () => {
    const ctx: TaskOperationCreateContext = {
      options: {
        taskId: 1,
        sessionId: "test-session",
        actionType: "create",
        actionTitle: "Test",
      },
    };
    
    expect(ctx.options.taskId).toBe(1);
    expect(ctx.options.actionType).toBe("create");
  });

  test("TaskHookContextMap should map all hook points", () => {
    const map: TaskHookContextMap = {
      "task:before.create": {} as any,
      "task:after.create": {} as any,
      "task:before.update": {} as any,
      "task:after.update": {} as any,
      "task:before.delete": {} as any,
      "task:after.delete": {} as any,
      "task:delegate:before": {} as any,
      "task:delegate:after": {} as any,
      "task:operation:before.create": {} as any,
      "task:operation:after.create": {} as any,
    };
    
    expect(Object.keys(map)).toHaveLength(10);
  });
});
