/**
 * @fileoverview TDD: tool exception + multi tool-call leaves orphan tool-call in session
 *
 * ## 根因
 *
 * Task #1967/#1973 已经实现 ask_user 2 分钟超时（释放 REPL/Feishu 主 session），
 * 但当 LLM 单次 ReAct 迭代里返回**多个 tool calls**（典型场景：reader + ask_user + plan），
 * 任意 tool 抛出异常（AskUserError / 业务异常 / abort 等）时 catch 块只 add 一条
 * tool-result（针对 currentToolCall = 失败的那个），其余**排在失败之后的**未执行
 * tool calls **没有**走 `addRemainingToolResults`。
 *
 * 后果：session 历史变成
 *   user → assistant(tool-call call_1, call_2(=throw), call_3) → tool(call_1) → tool(call_2)
 * 其中 call_3 没有匹配的 tool-result。
 *
 * 用户在异常后输入新消息，新一轮 agent 加载历史 → AI SDK v6 的
 * `convertToLanguageModelPrompt` 检测到 toolCallIds.size > 0 → 抛
 * `MissingToolResultsError`，CLI 显示：
 *   AI_MissingToolResultsError: Tool results are missing for tool calls call_xxx, call_xxx, call_xxx
 *
 * ## 测试范围 (RED)
 *
 * AskUserError 路径（4 tests）：
 * 1. RED-1: 多 tool call + ask_user 在中间 → 全部 tool-call 都应有 tool-result
 * 2. RED-2: ask_user 在第一个 tool call → 后续 tool calls 也应有 placeholder tool-result
 * 3. RED-3 (control): ask_user 在最后一个 tool call → 不需要 placeholder（向后兼容）
 * 4. RED-4: 持久化到 session 的消息配对完整（call_3 也要被记录，且 call_1 不被覆盖）
 *
 * 任意 tool exception 路径（3 tests，验证修复不仅覆盖 AskUserError）：
 * 5. RED-5: 任意 tool 在中间 throw（非 AskUserError）→ 后续 tool 也必须有 placeholder
 * 6. RED-6: 任意 tool 在第一个 throw → 后续所有 tool 都必须有 placeholder
 * 7. RED-7 (control): 任意 tool 在最后一个 throw → 不需要额外 placeholder
 *
 * 消息配对完整性（1:1 mapping, no duplicates, no orphans）：
 * 8. RED-8: 每个 assistant tool-call 都恰好匹配一个 tool-result，且 toolCallId 唯一无重复
 * 9. RED-9: 异常发生在中间时，前面成功 tool 的 output 严格保留，不被任何 placeholder 覆盖
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentComponent } from "./agent-component";
import type { Environment } from "../interface";
import { ConfigComponent } from "../../config/config-component";
import { AskUserError } from "../workflow/types/workflow-hil";
import { z } from "zod";

// ============================================================================
// Mock Environment Factory
// ============================================================================

function createMockEnvironment(components: Record<string, any> = {}): Environment {
  return {
    name: "test-env",
    version: "1.0.0",
    getConfig: vi.fn(() => ({ name: "test-env", version: "1.0.0", enabled: true })),
    registerComponent: vi.fn(),
    unregisterComponent: vi.fn(),
    getComponent: vi.fn((name: string) => components[name]),
    listComponents: vi.fn(() => Object.keys(components)),
    handle_query: vi.fn(),
    handle_action: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    subscribeTo: vi.fn(() => () => {}),
    subscribeAll: vi.fn(() => () => {}),
    pushEnvEvent: vi.fn(),
  } as unknown as Environment;
}

/**
 * Build a mock LLM that returns `toolCalls` on the first call and a final
 * text response on subsequent calls (so multi-turn agent can finish cleanly).
 */
function makeMockLLM(firstResponse: any) {
  return {
    invoke: vi.fn(async () => ({
      output: firstResponse,
    })),
  };
}

/**
 * Build a mock tool that records its call and returns the configured result.
 */
function makeMockTool(name: string, output: string, throws?: Error) {
  return {
    name,
    description: `${name} mock tool`,
    parameters: z.object({}),
    execute: vi.fn(async () => {
      if (throws) {
        throw throws;
      }
      return { success: true, output };
    }),
  } as any;
}

// ============================================================================
// Test Suite: AskUserError + Multi-Tool-Call Orphan Tool-Call
// ============================================================================

describe("AgentComponent AskUserError + Multi-Tool-Call (orphan tool-call bug)", () => {
  let configComponent: ConfigComponent;
  let mockSessionComponent: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    configComponent = new ConfigComponent();
    mockSessionComponent = {
      name: "session",
      create: vi.fn(async () => ({ id: "test-session", title: "Test" })),
      get: vi.fn(async () => ({ id: "test-session" })),
      addMessage: vi.fn(async () => "msg_id"),
      // recordSessionMessages uses addMessages(batch); mirror addMessage's per-id return
      // shape so any test that flattens across calls still gets a string id.
      addMessages: vi.fn(async (_sessionId: string, _msgs: any[]) => ["msg_id"]),
      getMessages: vi.fn(async () => []),
      getContext: vi.fn(async () => ({
        session: { id: "test-session" },
        messages: [],
      })),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Helper: build an AgentComponent with the given LLM mock response wired up.
   * Returns the agent component + mock LLM + mock session for inspection.
   */
  async function makeAgent(llmFirstResponse: any) {
    const mockLLM = makeMockLLM(llmFirstResponse);
    const mockEnv = createMockEnvironment({
      config: configComponent,
      session: mockSessionComponent,
      llm: mockLLM,
    });
    const agentComponent = new AgentComponent();
    await agentComponent.init({
      name: "agent",
      version: "1.0.0",
      enabled: true,
      env: mockEnv,
      options: { configComponent },
    });
    agentComponent.registerAgent("test-agent", {
      type: "primary",
      systemPrompt: "Test",
    });
    return { agentComponent, mockLLM };
  }

  // ==========================================================================
  // RED-1: ask_user 在中间，前面有 1 个成功 tool call，后面有 1 个未执行
  // ==========================================================================
  it("RED-1: ask_user 在中间时，排在后面的未执行 tool-call 也必须有 tool-result", async () => {
    const { agentComponent } = await makeAgent({
      content: "",
      toolCalls: [
        { id: "call_1", function: { name: "read_file", arguments: "{}" } },
        { id: "call_2", function: { name: "ask_user", arguments: JSON.stringify({ query: "Continue?" }) } },
        { id: "call_3", function: { name: "write_file", arguments: "{}" } },
      ],
    });

    const readTool = makeMockTool("read_file", "file contents");
    const askUserTool = makeMockTool(
      "ask_user",
      "",
      new AskUserError("run_1", "test-session", "node_1", "agent", "Continue?"),
    );
    const writeTool = makeMockTool("write_file", "ok");

    agentComponent.setDefaultTools([readTool, askUserTool, writeTool]);

    const result = await agentComponent.run("test-agent", "multi-tool test", {
      sessionId: "test-session",
    });

    // 验证 1: agent 应当识别 AskUserError
    expect(result.error).toContain("__ASK_USER_ERROR__");

    // 验证 2: ask_user tool 已被调用（说明 LLM 输出的多 tool-call 路径走到 ask_user）
    expect(askUserTool.execute).toHaveBeenCalledTimes(1);

    // 验证 3: read_file 在 ask_user 之前完成（说明 processedCount=1 状态）
    expect(readTool.execute).toHaveBeenCalledTimes(1);

    // 验证 4: 持久化到 session 的消息中，tool-result 必须 ≥ tool-call 数
    const storedMessages = mockSessionComponent.addMessages.mock.calls
      .flatMap((call: any[]) => call[1] ?? []);

    const assistantToolCallParts = storedMessages
      .filter((msg: any) => msg?.role === "assistant")
      .flatMap((msg: any) =>
        (msg?.parts ?? []).filter((p: any) => p?.type === "tool-call"),
      );
    const toolResultParts = storedMessages
      .filter((msg: any) => msg?.role === "tool")
      .flatMap((msg: any) =>
        (msg?.parts ?? []).filter((p: any) => p?.type === "tool-result"),
      );

    // 3 个 tool-call 必须有 3 个 tool-result（1:1 配对）
    // 当前 bug：只有 2 个 tool-result（call_1, call_2），call_3 缺失
    expect(assistantToolCallParts).toHaveLength(3);
    expect(toolResultParts).toHaveLength(3);
  });

  // ==========================================================================
  // RED-2: ask_user 在第一个，后面两个都被吃
  // ==========================================================================
  it("RED-2: ask_user 在第一个时，后面所有 tool-call 都必须有 placeholder tool-result", async () => {
    const { agentComponent } = await makeAgent({
      content: "",
      toolCalls: [
        { id: "call_ask", function: { name: "ask_user", arguments: JSON.stringify({ query: "Pick one?" }) } },
        { id: "call_b", function: { name: "write_file", arguments: "{}" } },
        { id: "call_c", function: { name: "read_file", arguments: "{}" } },
      ],
    });

    const askUserTool = makeMockTool(
      "ask_user",
      "",
      new AskUserError("run_1", "test-session", "node_1", "agent", "Pick one?"),
    );
    const writeTool = makeMockTool("write_file", "ok");
    const readTool = makeMockTool("read_file", "ok");

    agentComponent.setDefaultTools([askUserTool, writeTool, readTool]);

    const result = await agentComponent.run("test-agent", "ask first test", {
      sessionId: "test-session",
    });

    expect(result.error).toContain("__ASK_USER_ERROR__");

    const storedMessages = mockSessionComponent.addMessages.mock.calls
      .flatMap((call: any[]) => call[1] ?? []);

    const toolResultParts = storedMessages
      .filter((msg: any) => msg?.role === "tool")
      .flatMap((msg: any) =>
        (msg?.parts ?? []).filter((p: any) => p?.type === "tool-result"),
      );

    // 必须有 3 个 tool-result（call_ask + call_b + call_c 各 1）
    // 当前 bug：只有 1 个（call_ask），call_b 和 call_c 缺失
    expect(toolResultParts).toHaveLength(3);

    // 验证：3 个 toolCallId 都应被覆盖到
    const resultIds = new Set(
      toolResultParts.map((p: any) => p?.toolCallId),
    );
    expect(resultIds.has("call_ask")).toBe(true);
    expect(resultIds.has("call_b")).toBe(true);
    expect(resultIds.has("call_c")).toBe(true);
  });

  // ==========================================================================
  // RED-3 (control): ask_user 在最后一个时，不应该添加额外 placeholder
  // ==========================================================================
  it("RED-3 (control): ask_user 在最后一个时，tool-result 数量应正好等于 tool-call 数量", async () => {
    const { agentComponent } = await makeAgent({
      content: "",
      toolCalls: [
        { id: "call_1", function: { name: "read_file", arguments: "{}" } },
        { id: "call_2", function: { name: "write_file", arguments: "{}" } },
        { id: "call_ask", function: { name: "ask_user", arguments: JSON.stringify({ query: "Continue?" }) } },
      ],
    });

    const readTool = makeMockTool("read_file", "ok");
    const writeTool = makeMockTool("write_file", "ok");
    const askUserTool = makeMockTool(
      "ask_user",
      "",
      new AskUserError("run_1", "test-session", "node_1", "agent", "Continue?"),
    );

    agentComponent.setDefaultTools([readTool, writeTool, askUserTool]);

    await agentComponent.run("test-agent", "ask last test", {
      sessionId: "test-session",
    });

    const storedMessages = mockSessionComponent.addMessages.mock.calls
      .flatMap((call: any[]) => call[1] ?? []);

    const toolResultParts = storedMessages
      .filter((msg: any) => msg?.role === "tool")
      .flatMap((msg: any) =>
        (msg?.parts ?? []).filter((p: any) => p?.type === "tool-result"),
      );

    // 3 个 tool-call 应该都有 tool-result
    // call_1, call_2 走正常路径，call_ask 走 AskUserError 路径
    expect(toolResultParts).toHaveLength(3);
  });

  // ==========================================================================
  // RED-4: 持久化消息必须 1:1 配对（防止重复添加 / 误删既有 tool-result）
  // ==========================================================================
  it("RED-4: 多 tool-call 持久化时，已经存在的 tool-result 不被误删/覆盖", async () => {
    const { agentComponent } = await makeAgent({
      content: "",
      toolCalls: [
        { id: "call_1", function: { name: "read_file", arguments: "{}" } },
        { id: "call_ask", function: { name: "ask_user", arguments: JSON.stringify({ query: "Continue?" }) } },
      ],
    });

    const readTool = makeMockTool("read_file", "ok");
    const askUserTool = makeMockTool(
      "ask_user",
      "",
      new AskUserError("run_1", "test-session", "node_1", "agent", "Continue?"),
    );

    agentComponent.setDefaultTools([readTool, askUserTool]);

    await agentComponent.run("test-agent", "preserve existing test", {
      sessionId: "test-session",
    });

    const storedMessages = mockSessionComponent.addMessages.mock.calls
      .flatMap((call: any[]) => call[1] ?? []);

    // 检查 call_1 的 tool-result 保留原始内容（不应被 placeholder 覆盖）
    const call1Result = storedMessages
      .filter((msg: any) => msg?.role === "tool")
      .flatMap((msg: any) =>
        (msg?.parts ?? []).filter((p: any) => p?.type === "tool-result"),
      )
      .find((p: any) => p?.toolCallId === "call_1");

    expect(call1Result).toBeDefined();
    // call_1 的原始 tool result 是 "ok"，不应被 AskUserError placeholder 覆盖
    const call1OutputStr = JSON.stringify(call1Result?.output ?? "");
    expect(call1OutputStr).toContain("ok");

    // call_ask 的 tool-result 应包含 AskUserError 结构化信息
    const callAskResult = storedMessages
      .filter((msg: any) => msg?.role === "tool")
      .flatMap((msg: any) =>
        (msg?.parts ?? []).filter((p: any) => p?.type === "tool-result"),
      )
      .find((p: any) => p?.toolCallId === "call_ask");

    expect(callAskResult).toBeDefined();
    const callAskOutputStr = JSON.stringify(callAskResult?.output ?? "");
    expect(callAskOutputStr).toContain("AskUserError");
    expect(callAskOutputStr).toContain("Continue?");
  });

  // ==========================================================================
  // RED-8: 严格 1:1 mapping（toolCallId ↔ toolResultId 唯一配对，无重复）
  // 覆盖：异常在中间，多个后续 tool-call（3 个 trailing）
  // ==========================================================================
  it("RED-8: 异常在中间 + 多个后续 tool-call 时，tool_call_id ↔ tool_result_id 严格一一匹配且无重复", async () => {
    const { agentComponent } = await makeAgent({
      content: "",
      toolCalls: [
        { id: "call_a", function: { name: "read_file", arguments: "{}" } },
        { id: "call_ask", function: { name: "ask_user", arguments: JSON.stringify({ query: "Confirm?" }) } },
        { id: "call_x", function: { name: "write_file", arguments: "{}" } },
        { id: "call_y", function: { name: "exec_cmd", arguments: "{}" } },
        { id: "call_z", function: { name: "read_file", arguments: "{}" } },
      ],
    });

    const readTool = makeMockTool("read_file", "file contents");
    const askUserTool = makeMockTool(
      "ask_user",
      "",
      new AskUserError("run_1", "test-session", "node_1", "agent", "Confirm?"),
    );
    const writeTool = makeMockTool("write_file", "ok");
    const execTool = makeMockTool("exec_cmd", "ok");
    const readTool2 = makeMockTool("read_file", "ok");

    agentComponent.setDefaultTools([readTool, askUserTool, writeTool, execTool, readTool2]);

    await agentComponent.run("test-agent", "many trailing calls", {
      sessionId: "test-session",
    });

    const storedMessages = mockSessionComponent.addMessages.mock.calls
      .flatMap((call: any[]) => call[1] ?? []);

    const assistantToolCallIds = storedMessages
      .filter((msg: any) => msg?.role === "assistant")
      .flatMap((msg: any) =>
        (msg?.parts ?? []).filter((p: any) => p?.type === "tool-call"),
      )
      .map((p: any) => p?.toolCallId);
    const toolResultIds = storedMessages
      .filter((msg: any) => msg?.role === "tool")
      .flatMap((msg: any) =>
        (msg?.parts ?? []).filter((p: any) => p?.type === "tool-result"),
      )
      .map((p: any) => p?.toolCallId);

    // 5 个 tool-call 全部需要 5 个 tool-result
    expect(assistantToolCallIds).toHaveLength(5);
    expect(toolResultIds).toHaveLength(5);

    // 严格 1:1 mapping: toolCallId 集合 = toolResultId 集合
    expect(new Set(toolResultIds)).toEqual(new Set(assistantToolCallIds));

    // 每个 toolCallId 都恰好出现一次（无重复）
    const toolResultCount = new Map<string, number>();
    for (const id of toolResultIds) {
      toolResultCount.set(id, (toolResultCount.get(id) ?? 0) + 1);
    }
    for (const [, count] of toolResultCount) {
      expect(count).toBe(1);
    }

    // 验证 3 个 trailing calls (call_x, call_y, call_z) 的 placeholder 都是 cancellation
    for (const trailingId of ["call_x", "call_y", "call_z"]) {
      const result = storedMessages
        .filter((msg: any) => msg?.role === "tool")
        .flatMap((msg: any) =>
          (msg?.parts ?? []).filter((p: any) => p?.type === "tool-result"),
        )
        .find((p: any) => p?.toolCallId === trailingId);
      expect(result).toBeDefined();
      const output = JSON.stringify(result?.output ?? "");
      // 不能伪造真实业务输出
      expect(output).not.toContain("file contents");
      // 必须说明原因是前面的工具异常 / cancelled / skipped
      expect(output.toLowerCase()).toMatch(/abort|error|not executed|skipped|cancelled/);
    }
  });

  // ==========================================================================
  // RED-9: 已有 tool-result 严格不被任何 placeholder 覆盖
  // ==========================================================================
  it("RED-9: 异常在中间时，前面成功的 tool-result 内容严格保留，不被 placeholder 覆盖", async () => {
    const { agentComponent } = await makeAgent({
      content: "",
      toolCalls: [
        { id: "call_1", function: { name: "read_file", arguments: "{}" } },
        { id: "call_2", function: { name: "exec_cmd", arguments: "{}" } },
        { id: "call_ask", function: { name: "ask_user", arguments: JSON.stringify({ query: "OK?" }) } },
      ],
    });

    // call_1 和 call_2 都成功，call_ask 抛 AskUserError
    const readTool = makeMockTool("read_file", "REAL_READ_OUTPUT");
    const execTool = makeMockTool("exec_cmd", "REAL_EXEC_OUTPUT");
    const askUserTool = makeMockTool(
      "ask_user",
      "",
      new AskUserError("run_1", "test-session", "node_1", "agent", "OK?"),
    );

    agentComponent.setDefaultTools([readTool, execTool, askUserTool]);

    await agentComponent.run("test-agent", "preserve outputs", {
      sessionId: "test-session",
    });

    const storedMessages = mockSessionComponent.addMessages.mock.calls
      .flatMap((call: any[]) => call[1] ?? []);

    const toolResultsById = new Map<string, any>();
    for (const msg of storedMessages) {
      if (msg?.role !== "tool") continue;
      for (const part of msg.parts ?? []) {
        if (part?.type === "tool-result") {
          toolResultsById.set(part.toolCallId, part);
        }
      }
    }

    // call_1 和 call_2 必须各只有 1 个 tool-result（无重复添加）
    const call1Results = storedMessages
      .filter((msg: any) => msg?.role === "tool")
      .flatMap((msg: any) =>
        (msg?.parts ?? []).filter((p: any) => p?.type === "tool-result"),
      )
      .filter((p: any) => p?.toolCallId === "call_1");
    expect(call1Results).toHaveLength(1);
    expect(JSON.stringify(call1Results[0]?.output ?? "")).toContain("REAL_READ_OUTPUT");

    const call2Results = storedMessages
      .filter((msg: any) => msg?.role === "tool")
      .flatMap((msg: any) =>
        (msg?.parts ?? []).filter((p: any) => p?.type === "tool-result"),
      )
      .filter((p: any) => p?.toolCallId === "call_2");
    expect(call2Results).toHaveLength(1);
    expect(JSON.stringify(call2Results[0]?.output ?? "")).toContain("REAL_EXEC_OUTPUT");
  });
});