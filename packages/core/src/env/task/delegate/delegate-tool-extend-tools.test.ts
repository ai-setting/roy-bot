/**
 * @fileoverview Task #5333 — delegate_task 透传父 run 的 extendTools
 *
 * ## 为什么需要
 *
 * `wecom_respond` 是 channelOnly 工具（Task #5333）：只有
 * `AgentContext.extendTools` 显式列出时才可见。企微事件驱动的父 agent
 * 拿到 `["wecom_respond"]`；但父 agent 用 `delegate_task` 派出去的子任务
 * 若拿不到这份名单，sub-agent 侧 `wecom_respond` 不可见 →
 * 子任务无法给企微用户回复（用户永远收不到结果）。
 *
 * ## 透传链（与 Task #5217 channel systemPrompt 继承同构）
 *
 *   parent AgentContext.extendTools
 *     → ToolContext.metadata.extendTools（agent-component.ts 写入）
 *     → delegate-tool execute(ctx) → handleBackgroundTask(..., extendTools)
 *     → createTask({ extendTools }) → BackgroundTask.extendTools
 *     → executeWithAbort → invokeHandleQuery → handle_query({ extendTools })
 *     → AgentComponent.getAvailableTools(agent, { extendTools }) 放行 channelOnly 工具
 *
 * 断言的是**可观测结果**：到达 `env.handle_query` 的 context.extendTools，
 * 而非某个中间字段。
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "bun:test";
import { BackgroundTaskManager, normalizeExtendTools } from "./delegate-tool";

describe("Task #5333 — delegate_task 透传父 run 的 extendTools", () => {
  let mockEnv: any;
  let mockSessionComponent: any;
  let mockAgentComponent: any;
  /** 每个传给 env.handle_query 的 context 对象 */
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

  test("RED: createTask({ extendTools }) → handle_query 的 context.extendTools 带上名单", async () => {
    const manager = new BackgroundTaskManager(mockEnv);

    await manager.createTask({
      parentSessionId: "parent-session-1",
      description: "sub task",
      prompt: "do the thing",
      subagentType: "general",
      extendTools: ["wecom_respond"],
    } as any);

    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(handleQueryContexts.length).toBeGreaterThan(0);
    expect(handleQueryContexts[0]?.extendTools).toEqual(["wecom_respond"]);
  });

  test("未传 extendTools → context.extendTools 保持 undefined（向后兼容）", async () => {
    const manager = new BackgroundTaskManager(mockEnv);

    await manager.createTask({
      parentSessionId: "parent-session-1",
      description: "no extend tools",
      prompt: "prompt",
      subagentType: "general",
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(handleQueryContexts.length).toBeGreaterThan(0);
    expect(handleQueryContexts[0]?.extendTools).toBeUndefined();
  });

  test("两次 delegate 各自使用自己的 extendTools（per-run，不残留）", async () => {
    const manager = new BackgroundTaskManager(mockEnv);

    await manager.createTask({
      parentSessionId: "parent-session-1",
      description: "first",
      prompt: "first prompt",
      subagentType: "general",
      extendTools: ["wecom_respond"],
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 120));

    await manager.createTask({
      parentSessionId: "parent-session-1",
      description: "second",
      prompt: "second prompt",
      subagentType: "general",
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(handleQueryContexts.length).toBeGreaterThanOrEqual(2);
    expect(handleQueryContexts[0]?.extendTools).toEqual(["wecom_respond"]);
    expect(handleQueryContexts[1]?.extendTools).toBeUndefined();
  });
});

/**
 * DS review 第 2 轮 MINOR-4：extendTools 从松散 metadata 取出时必须归一 ——
 * 否则对象/含非字符串的数组会让 `includes()` 静默永不命中
 * （表现为「名单写好了却不生效」）。
 */
describe("normalizeExtendTools — 松散来源归一（Task #5333 MINOR-4）", () => {
  test("非数组 → undefined（视为未放行）", () => {
    expect(normalizeExtendTools(undefined)).toBeUndefined();
    expect(normalizeExtendTools(null)).toBeUndefined();
    expect(normalizeExtendTools("wecom_respond")).toBeUndefined();
    expect(normalizeExtendTools({ 0: "wecom_respond" })).toBeUndefined();
  });

  test("保留字符串、trim、去重，丢弃非字符串与非空值", () => {
    expect(
      normalizeExtendTools(["  wecom_respond  ", 42, null, "", "wecom_respond", "x"]),
    ).toEqual(["wecom_respond", "x"]);
  });

  test("全被过滤掉 / 空数组 → undefined", () => {
    expect(normalizeExtendTools([1, 2, {}])).toBeUndefined();
    expect(normalizeExtendTools([])).toBeUndefined();
  });
});
