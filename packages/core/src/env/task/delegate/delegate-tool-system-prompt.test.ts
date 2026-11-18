/**
 * @fileoverview TDD tests for Task #5217 fix 2 — the parent run's
 * channel systemPrompt (context.metadata.systemPrompt, e.g. the lean
 * lark channel prompt) must reach the sub-agent spawned via
 * `delegate_task`.
 *
 * ## RED phase (before the fix)
 *
 * `delegate-tool.ts` `invokeHandleQuery` calls `env.handle_query(q, {…})`
 * WITHOUT `metadata.systemPrompt`, so `AgentComponent._run` reads
 * `context?.metadata?.systemPrompt` as undefined for the sub-agent —
 * the third broken injection path in the Task #5210 report.
 *
 * ## 透传链（仿 Task #4623 model 继承链）
 *
 *   parent AgentContext.metadata.systemPrompt
 *     → ToolContext.metadata.systemPrompt（agent-component.ts 已带）
 *     → delegate-tool execute(ctx) → handleBackgroundTask(..., systemPrompt)
 *     → createTask({ systemPrompt }) → BackgroundTask.systemPrompt
 *     → executeWithAbort → invokeHandleQuery → handle_query({ metadata: { systemPrompt } })
 *     → AgentComponent._run 追加到 sub-agent system message
 *
 * The test asserts the *observable* behaviour — the systemPrompt that
 * reaches `env.handle_query` for the sub-agent — rather than an
 * intermediate field.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "bun:test";
import { BackgroundTaskManager } from "./delegate-tool";

const CHANNEL_PROMPT = "## 文档交付规范：产出物存飞书云盘";

describe("Task #5217 fix 2 — delegate_task 透传父 run 的 channel systemPrompt", () => {
  let mockEnv: any;
  let mockSessionComponent: any;
  let mockAgentComponent: any;
  /** Every `context` object passed to `env.handle_query`. */
  let handleQueryContexts: any[];

  beforeEach(() => {
    handleQueryContexts = [];

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
      registerAgent: vi.fn((name: string, config: any) => ({
        name,
        config,
        status: "idle",
        plugins: new Map(),
      })),
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

  test("RED: createTask({ systemPrompt }) → handle_query receives metadata.systemPrompt", async () => {
    const manager = new BackgroundTaskManager(mockEnv);

    await manager.createTask({
      parentSessionId: "parent-session-1",
      description: "sub task",
      prompt: "do the thing",
      subagentType: "general",
      systemPrompt: CHANNEL_PROMPT,
    } as any);

    // Wait for the async execution to reach handle_query.
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(handleQueryContexts.length).toBeGreaterThan(0);
    expect(handleQueryContexts[0]?.metadata?.systemPrompt).toBe(CHANNEL_PROMPT);
  });

  test("RED: no systemPrompt → handle_query receives none (backward compatible)", async () => {
    const manager = new BackgroundTaskManager(mockEnv);

    await manager.createTask({
      parentSessionId: "parent-session-1",
      description: "no channel prompt",
      prompt: "prompt",
      subagentType: "general",
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(handleQueryContexts.length).toBeGreaterThan(0);
    expect(handleQueryContexts[0]?.metadata?.systemPrompt).toBeUndefined();
  });

  test("RED: second delegate with a different systemPrompt uses the NEW value", async () => {
    const manager = new BackgroundTaskManager(mockEnv);

    await manager.createTask({
      parentSessionId: "parent-session-1",
      description: "first",
      prompt: "first prompt",
      subagentType: "general",
      systemPrompt: "PROMPT_V1",
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 120));

    await manager.createTask({
      parentSessionId: "parent-session-1",
      description: "second",
      prompt: "second prompt",
      subagentType: "general",
      systemPrompt: "PROMPT_V2",
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(handleQueryContexts.length).toBeGreaterThanOrEqual(2);
    expect(handleQueryContexts[0]?.metadata?.systemPrompt).toBe("PROMPT_V1");
    expect(handleQueryContexts[1]?.metadata?.systemPrompt).toBe("PROMPT_V2");
  });
});
