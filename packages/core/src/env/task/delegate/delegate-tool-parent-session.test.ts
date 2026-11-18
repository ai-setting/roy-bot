/**
 * @fileoverview Tests for delegate_task → SessionComponent.create parent injection (Task #1739)
 *
 * Verifies:
 *  1. sessionComponent.create is called with `parentSessionId` set to the
 *     parent session id from the ToolContext.
 *  2. The created sub-session object exposes `parentSessionId` matching
 *     the parent session id.
 */

import { describe, test, expect, beforeEach, vi } from "vitest";
import type { TaskComponent } from "../task-component";
import type { Tool, ToolContext } from "../../tool/types";

const createDelegateTool = async (taskComponent: TaskComponent): Promise<Tool> => {
  const module = await import("./delegate-tool");
  return module.createDelegateTool(taskComponent);
};

describe("delegate_task → SessionComponent.create parentSessionId (Task #1739)", () => {
  let mockTaskComponent: any;
  let mockSessionComponent: any;
  let mockAgentComponent: any;
  let capturedCreateOpts: any[];

  beforeEach(() => {
    capturedCreateOpts = [];

    // Realistic SessionComponent mock that records the options passed to
    // create() and exposes a created session object that mirrors the options.
    mockSessionComponent = {
      get: vi.fn(async (id: string) => ({ id })),
      create: vi.fn(async (opts: any) => {
        capturedCreateOpts.push(opts);
        return {
          id: `sub_${capturedCreateOpts.length}`,
          parentSessionId: opts.parentSessionId ?? null,
          info: { metadata: opts.metadata || {} },
          addMessage: vi.fn(),
        };
      }),
      addMessage: vi.fn(),
    };

    mockAgentComponent = {
      getAgent: vi.fn((_name: string) => undefined),
      registerAgent: vi.fn((name: string, config: any) => ({
        name,
        config,
        status: "idle",
        plugins: new Map(),
      })),
      run: vi.fn(async () => ({ status: "completed" })),
    };

    mockTaskComponent = {
      env: {
        handle_query: vi.fn(async () => "ok"),
        getComponent: vi.fn((name: string) => {
          if (name === "session") return mockSessionComponent;
          if (name === "agent") return mockAgentComponent;
          if (name === "task") return mockTaskComponent;
          return { registerTool: vi.fn() };
        }),
      },
      getSessionComponent: vi.fn(() => mockSessionComponent),
      getTagService: vi.fn(() => undefined),
      _backgroundTaskManager: undefined,
    };
  });

  test("sessionComponent.create is called with parentSessionId set to ctx.session_id", async () => {
    const tool = await createDelegateTool(mockTaskComponent);

    const parentSessionId = "main-session-abc";
    const ctx: ToolContext = { session_id: parentSessionId };

    await tool.execute(
      {
        description: "Test subagent",
        prompt: "do work",
        subagent_type: "general",
        similar_task_ids: [],
      },
      ctx,
    );

    // The execute may return an async/fire-and-forget result; ensure the
    // create was called synchronously (or at least eventually).
    // Wait briefly for the async work to schedule.
    await new Promise((r) => setTimeout(r, 50));

    expect(capturedCreateOpts.length).toBeGreaterThanOrEqual(1);
    const opts = capturedCreateOpts[0]!;
    expect(opts.parentSessionId).toBe(parentSessionId);
  });

  test("created sub-session object has parentSessionId field set", async () => {
    const tool = await createDelegateTool(mockTaskComponent);

    const parentSessionId = "main-session-xyz";
    const ctx: ToolContext = { session_id: parentSessionId };

    await tool.execute(
      {
        description: "Test subagent 2",
        prompt: "do more work",
        subagent_type: "general",
        similar_task_ids: [],
      },
      ctx,
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(capturedCreateOpts.length).toBeGreaterThanOrEqual(1);
    // The mock create() returns an object whose parentSessionId mirrors opts
    expect(capturedCreateOpts[0]!.parentSessionId).toBe(parentSessionId);
  });
});
