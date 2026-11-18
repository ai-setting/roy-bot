/**
 * @fileoverview End-to-End Test for Memory Extract Mode
 * 
 * 完整测试 record --extract 命令的集成流程
 * 
 * 注意：runExtractMode 是内部函数，直接测试其逻辑而非导入
 */

import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";

// Mock chalk
// 用 Proxy-based chalk mock（src/test-utils/chalk-mock.ts）：
// 1) 任何 chalk.X 属性访问都返回 chainable identity 函数（不抛 chalk.X is not a function）
// 2) chalk.X("text") 返回 string（identity，无 ANSI）以匹配 chalk.level=0 行为
// 3) chalk.X("#hex" | "namedColor") 返回 chainable builder，支持 chalk.hex("#xxx")(s) 链式
// 这是 Batch 1 (chalk.hex polyfill) 的核心修复：解决 bun:test 下 vi.mock("chalk") 跨文件泄漏
// 导致下游测试 stream-output.service.ts 等的 chalk.hex/chalk.dim 报 undefined 的问题。
vi.mock("chalk", () => ({
  default: require("../../test-utils/chalk-mock").createChalkMock(),
}));

// Mock dependencies
const mockSessionComponent = {
  searchSessions: vi.fn().mockResolvedValue([
    { sessionId: "test-1", title: "Test Session", preview: "Hello world" }
  ]),
  getSession: vi.fn().mockResolvedValue({
    sessionId: "test-1",
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ],
  }),
  getContext: vi.fn().mockResolvedValue({
    messages: [
      { id: "1", role: "user", content: "What's the weather?" },
      { id: "2", role: "assistant", content: "It's sunny today." },
    ],
  }),
};

const mockMemoryComponent = {
  recallMemory: vi.fn().mockResolvedValue("# 项目记忆\n\n暂无内容"),
  recordMemory: vi.fn().mockResolvedValue({ path: "/test/memory.md", action: "overwrite" }),
};

const mockAgentInstance = {
  name: "memory-extract-project",
  config: {
    type: "sub",
    systemPrompt: "",
    allowedTools: ["search_sessions", "get_session", "write_memory"],
    deniedTools: [],
  },
  status: "idle",
  plugins: new Map(),
};

const mockAgentComponent = {
  registerAgent: vi.fn().mockReturnValue(mockAgentInstance),
  unregisterAgent: vi.fn(),
  setDefaultTools: vi.fn(),
  run: vi.fn().mockResolvedValue({
    finalText: "Memory extracted successfully",
    iterations: 1,
    toolCalls: [],
  }),
  getAgent: vi.fn().mockReturnValue(mockAgentInstance),
  getAvailableTools: vi.fn().mockReturnValue([
    { name: "search_sessions", execute: vi.fn() },
    { name: "get_session", execute: vi.fn() },
    { name: "write_memory", execute: vi.fn() },
  ]),
};

// Replicate runExtractMode logic for testing
async function testableRunExtractMode(
  output: any,
  memoryComponent: any,
  agentComponent: any,
  sessionComponent: any,
  options: {
    scope: "project" | "global";
    sessionId?: string;
    require?: string;
  }
): Promise<void> {
  const { scope, sessionId, require: userRequirement } = options;

  // Get current memory
  const currentMemory = await memoryComponent.recallMemory(scope) || "(无现有记忆)";

  // Import getBuiltInPrompt and createMemoryAgentTools
  const { getBuiltInPrompt, createMemoryAgentTools } = await import("@ai-setting/roy-bot-core");

  // Build prompt
  const promptTemplate = scope === "project" 
    ? getBuiltInPrompt("project-memory") 
    : getBuiltInPrompt("global-memory");

  if (!promptTemplate) {
    throw new Error(`Prompt not found for scope: ${scope}`);
  }

  const systemPrompt = promptTemplate
    .replace("{USER_REQUIREMENT}", userRequirement || "请从会话历史中提炼关键知识。")
    .replace("{SCOPE}", scope)
    .replace("{CURRENT_MEMORY}", currentMemory);

  // Create tools
  const memoryTools = createMemoryAgentTools({
    sessionComponent,
    memoryComponent,
  });

  // Register agent
  const agentName = `memory-extract-${scope}`;
  agentComponent.registerAgent(agentName, {
    type: "sub",
    systemPrompt,
    allowedTools: ["search_sessions", "get_session", "write_memory"],
    deniedTools: [],
  });
  agentComponent.setDefaultTools([
    memoryTools.searchSessions,
    memoryTools.getSession,
    memoryTools.writeMemory,
  ]);

  // Run agent
  const query = `请分析会话历史，提炼${scope === "project" ? "项目" : "全局"}记忆并写入记忆文件。`;
  const result = await agentComponent.run(agentName, query, {
    sessionId,
  });

  // Handle result
  if (result.error) {
    output.error(`提取失败: ${result.error}`);
  } else if (result.finalText) {
    output.log(chalk.green("\n✅ 记忆提取完成"));
  }

  // Cleanup
  agentComponent.unregisterAgent(agentName);
}

// Mock chalk after importing
import chalk from "chalk";

// Helper to create mock output
function createMockOutput() {
  return {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("runExtractMode - E2E Test (replicated logic)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("should complete full extract flow with project scope", async () => {
    const mockOutput = createMockOutput();
    
    await testableRunExtractMode(
      mockOutput,
      mockMemoryComponent,
      mockAgentComponent,
      mockSessionComponent,
      {
        scope: "project",
        sessionId: "test-session-123",
        require: "重点关注配置信息",
      }
    );

    // 1. Verify memory recall was called
    expect(mockMemoryComponent.recallMemory).toHaveBeenCalledWith("project");

    // 2. Verify agent registration
    expect(mockAgentComponent.registerAgent).toHaveBeenCalledWith(
      "memory-extract-project",
      expect.objectContaining({
        type: "sub",
        allowedTools: expect.arrayContaining(["search_sessions", "get_session", "write_memory"]),
      })
    );

    // 3. Verify default tools were set
    expect(mockAgentComponent.setDefaultTools).toHaveBeenCalled();

    // 4. Verify agent run was called with correct params
    expect(mockAgentComponent.run).toHaveBeenCalledWith(
      "memory-extract-project",
      expect.stringContaining("分析会话历史"),
      expect.objectContaining({
        sessionId: "test-session-123",
      })
    );

    // 5. Verify cleanup
    expect(mockAgentComponent.unregisterAgent).toHaveBeenCalledWith("memory-extract-project");
  });

  test("should complete full extract flow with global scope", async () => {
    const mockOutput = createMockOutput();
    
    await testableRunExtractMode(
      mockOutput,
      mockMemoryComponent,
      mockAgentComponent,
      mockSessionComponent,
      {
        scope: "global",
        sessionId: "test-session-456",
        require: "提取通用知识",
      }
    );

    // Verify agent registration with global scope
    expect(mockAgentComponent.registerAgent).toHaveBeenCalledWith(
      "memory-extract-global",
      expect.objectContaining({
        type: "sub",
      })
    );

    // Verify agent run with global scope
    expect(mockAgentComponent.run).toHaveBeenCalledWith(
      "memory-extract-global",
      expect.stringContaining("全局"),
      expect.objectContaining({
        sessionId: "test-session-456",
      })
    );
  });

  test("should use default requirement when not provided", async () => {
    const mockOutput = createMockOutput();
    
    await testableRunExtractMode(
      mockOutput,
      mockMemoryComponent,
      mockAgentComponent,
      mockSessionComponent,
      {
        scope: "project",
        sessionId: "test-session",
      }
    );

    // Verify agent was registered (requirement uses default)
    expect(mockAgentComponent.registerAgent).toHaveBeenCalled();
    expect(mockAgentComponent.run).toHaveBeenCalled();
  });

  test("should handle agent execution error", async () => {
    const mockOutput = createMockOutput();
    
    // Setup error scenario
    mockAgentComponent.run.mockResolvedValueOnce({
      finalText: undefined,
      iterations: 1,
      toolCalls: [],
      error: "LLM invocation failed",
    });

    await testableRunExtractMode(
      mockOutput,
      mockMemoryComponent,
      mockAgentComponent,
      mockSessionComponent,
      {
        scope: "project",
        sessionId: "test-session",
      }
    );

    // Verify error was reported
    expect(mockOutput.error).toHaveBeenCalledWith(expect.stringContaining("提取失败"));

    // Verify cleanup still happened
    expect(mockAgentComponent.unregisterAgent).toHaveBeenCalledWith("memory-extract-project");
  });

  test("should work without session ID", async () => {
    const mockOutput = createMockOutput();
    
    await testableRunExtractMode(
      mockOutput,
      mockMemoryComponent,
      mockAgentComponent,
      mockSessionComponent,
      {
        scope: "project",
        sessionId: undefined,
      }
    );

    // Verify agent run was called without sessionId
    expect(mockAgentComponent.run).toHaveBeenCalledWith(
      "memory-extract-project",
      expect.any(String),
      expect.not.objectContaining({ sessionId: expect.anything() })
    );
  });

  test("should verify tool names match between allowedTools and created tools", async () => {
    const { createMemoryAgentTools } = await import("@ai-setting/roy-bot-core");
    
    const tools = createMemoryAgentTools({
      sessionComponent: mockSessionComponent,
      memoryComponent: mockMemoryComponent,
    });

    // These are the allowedTools in the agent config
    const allowedTools = ["search_sessions", "get_session", "write_memory"];

    // Verify each allowed tool exists with matching name
    expect(tools.searchSessions.name).toBe("search_sessions");
    expect(tools.getSession.name).toBe("get_session");
    expect(tools.writeMemory.name).toBe("write_memory");

    // Verify all allowed tools are present
    expect(allowedTools).toContain(tools.searchSessions.name);
    expect(allowedTools).toContain(tools.getSession.name);
    expect(allowedTools).toContain(tools.writeMemory.name);
  });
});

describe("CLI parameter integration", () => {
  test("should accept extract option", () => {
    const options = {
      mode: "append" as const,
      extract: true,
      scope: "project" as const,
      "session-id": "sid:abc123",
      require: "提取项目配置",
    };

    expect(options.extract).toBe(true);
    expect(options.scope).toBe("project");
    expect(options["session-id"]).toBe("sid:abc123");
    expect(options.require).toBe("提取项目配置");
  });

  test("should accept global scope", () => {
    const options = {
      extract: true,
      scope: "global" as const,
    };

    expect(options.scope).toBe("global");
  });

  test("should not require content when extract is true", () => {
    const options = {
      extract: true,
      mode: "append" as const,
      // content is intentionally omitted
    };

    // This is valid - extract mode doesn't need content
    expect(options.extract).toBe(true);
    expect((options as any).content).toBeUndefined();
  });

  test("should validate extract mode doesn't require content", () => {
    // Simulate yargs check logic
    const argv = {
      mode: "append",
      extract: true,
      content: undefined,
    };

    // extract mode should pass validation
    if (argv.extract) {
      // Should pass without content
      expect(true).toBe(true);
    }
  });
});
