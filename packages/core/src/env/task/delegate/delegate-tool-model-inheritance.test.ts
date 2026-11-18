/**
 * @fileoverview TDD tests for Task #4623 requirement A — the parent's `--model`
 * must reach the sub-agent spawned via `delegate_task`.
 *
 * RED phase. The current implementation drops the model:
 *
 *   - `agent-component.ts:2875` builds the `ToolContext` WITHOUT a `model`
 *     field (the `ToolContext` type has no such field at all).
 *   - `delegate-tool.ts` `invokeHandleQuery` calls `env.handle_query(q, {…})`
 *     without a `model`, so `AgentComponent._run` falls back to
 *     `agent.config.model` (the configured default) for the sub-agent.
 *
 * The test asserts the *observable* behaviour — the `model` that reaches the
 * LLM invocation of the sub-agent — rather than an intermediate field, so it
 * cannot pass by accident.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "bun:test";
import { BackgroundTaskManager } from "./delegate-tool";

describe("Task #4623 — delegate_task inherits the parent model", () => {
  let mockEnv: any;
  let mockSessionComponent: any;
  let mockAgentComponent: any;
  /** Every `context` object passed to `env.handle_query`. */
  let handleQueryContexts: any[];
  /** Every agent config passed to `agentComponent.registerAgent`. */
  let registeredAgentConfigs: Array<{ name: string; config: any }>;

  beforeEach(() => {
    handleQueryContexts = [];
    registeredAgentConfigs = [];

    mockSessionComponent = {
      get: vi.fn(async (id: string) => ({ id, metadata: {} })),
      create: vi.fn(async (opts: any) => ({
        id: "sub-session-1",
        parentSessionId: opts.parentSessionId ?? null,
        metadata: opts.metadata || {},
      })),
      addMessage: vi.fn(),
      update: vi.fn(async () => true),
    };

    mockAgentComponent = {
      getAgent: vi.fn(() => undefined),
      registerAgent: vi.fn((name: string, config: any) => {
        registeredAgentConfigs.push({ name, config });
        return { name, config, status: "idle", plugins: new Map() };
      }),
      getRegistry: vi.fn(() => undefined),
      abort: vi.fn(),
      abortRun: vi.fn(() => true),
    };

    mockEnv = {
      getComponent: vi.fn((name: string) => {
        if (name === "session") return mockSessionComponent;
        if (name === "agent") return mockAgentComponent;
        return undefined;
      }),
      pushEnvEvent: vi.fn(),
      handle_query: vi.fn(async (_query: string, context?: any) => {
        handleQueryContexts.push(context);
        return "sub agent done";
      }),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("RED: the parent's model reaches env.handle_query for the sub-agent", async () => {
    const manager = new BackgroundTaskManager(mockEnv);

    await manager.createTask({
      parentSessionId: "parent-session-1",
      description: "sub task",
      prompt: "do the thing",
      subagentType: "general",
      model: "tong/GLM-5.3-Flash",
    } as any);

    // Wait for the async execution to reach handle_query.
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(handleQueryContexts.length).toBeGreaterThan(0);
    expect(handleQueryContexts[0]?.model).toBe("tong/GLM-5.3-Flash");
  });

  test("RED: a second delegate with a different model uses the NEW model (no stale registration)", async () => {
    const manager = new BackgroundTaskManager(mockEnv);

    await manager.createTask({
      parentSessionId: "parent-session-1",
      description: "first",
      prompt: "first prompt",
      subagentType: "general",
      model: "tong/GLM-5.3-Flash",
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 120));

    await manager.createTask({
      parentSessionId: "parent-session-1",
      description: "second",
      prompt: "second prompt",
      subagentType: "general",
      model: "minimax/MiniMax-M3",
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(handleQueryContexts.length).toBeGreaterThanOrEqual(2);
    expect(handleQueryContexts[0]?.model).toBe("tong/GLM-5.3-Flash");
    // The second delegate must NOT reuse the first model's value.
    expect(handleQueryContexts[1]?.model).toBe("minimax/MiniMax-M3");
  });

  test("RED: no model configured → handle_query receives no model (backward compatible)", async () => {
    const manager = new BackgroundTaskManager(mockEnv);

    await manager.createTask({
      parentSessionId: "parent-session-1",
      description: "no model",
      prompt: "prompt",
      subagentType: "general",
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(handleQueryContexts.length).toBeGreaterThan(0);
    expect(handleQueryContexts[0]?.model).toBeUndefined();
  });

  test("RED: the fallback model also reaches the sub-agent", async () => {
    const manager = new BackgroundTaskManager(mockEnv);

    await manager.createTask({
      parentSessionId: "parent-session-1",
      description: "with fallback",
      prompt: "prompt",
      subagentType: "general",
      model: "tong/GLM-5.3-Flash",
      fallbackModel: "minimax/MiniMax-M3",
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(handleQueryContexts.length).toBeGreaterThan(0);
    expect(handleQueryContexts[0]?.fallbackModel).toBe("minimax/MiniMax-M3");
  });
});
