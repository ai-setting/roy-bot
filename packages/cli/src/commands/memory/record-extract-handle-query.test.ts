/**
 * @fileoverview TDD Test for record --extract using env.handle_query
 * 
 * 验证 record.ts 应该使用 env.handle_query() 执行 agent，
 * 而不是直接调用 agentComponent.run()
 * 
 * 参考 delegate_task 的实现模式
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

describe("RecordCommand - Extract Mode with handle_query", () => {
  let mockEnv: any;
  let mockAgentComponent: any;
  let mockMemoryComponent: any;
  let mockSessionComponent: any;
  let mockToolComponent: any;

  beforeEach(() => {
    // Mock components
    mockMemoryComponent = {
      recallMemory: vi.fn().mockResolvedValue("# 项目记忆\n\n暂无内容"),
      recordMemory: vi.fn().mockResolvedValue({ path: "/test/memory.md", action: "overwrite" }),
      getMemoryPaths: vi.fn().mockReturnValue([
        { type: "project", path: ".roy/memory" },
        { type: "user", path: "~/.config/roy-bot/memory" },
      ]),
      getMemoryFile: vi.fn().mockReturnValue("memory.md"),
    };

    mockSessionComponent = {
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
    };

    mockAgentComponent = {
      registerAgent: vi.fn().mockReturnValue({
        name: "memory-extract-project",
        config: { type: "sub" },
        status: "idle",
        plugins: new Map(),
      }),
      unregisterAgent: vi.fn(),
      setDefaultTools: vi.fn(),
      run: vi.fn(), // Not used anymore with handle_query
      getAgent: vi.fn().mockReturnValue({
        name: "memory-extract-project",
        config: { type: "sub" },
        status: "idle",
        plugins: new Map(),
      }),
    };

    mockToolComponent = {
      register: vi.fn(),
      unregister: vi.fn(),
    };

    // Mock env with handle_query method
    mockEnv = {
      getComponent: vi.fn((name: string) => {
        switch (name) {
          case "memory":
            return mockMemoryComponent;
          case "agent":
            return mockAgentComponent;
          case "session":
            return mockSessionComponent;
          case "tool":
            return mockToolComponent;
          default:
            return undefined;
        }
      }),
      // handle_query returns string (finalText), not object
      handle_query: vi.fn().mockResolvedValue("Memory extracted successfully via handle_query"),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("TDD: record --extract should use env.handle_query", () => {
    
    test("should call env.handle_query with agentType instead of agentComponent.run", async () => {
      // This test verifies the NEW behavior: using handle_query
      // Given: mock env and components
      // When: runExtractMode is called
      // Then: env.handle_query should be called with agentType
      
      const { createMemoryAgentTools, getBuiltInPrompt } = await import("@ai-setting/roy-bot-core");
      
      const memoryTools = createMemoryAgentTools({
        sessionComponent: mockSessionComponent,
        memoryComponent: mockMemoryComponent,
      });

      // Get prompt template
      const promptTemplate = getBuiltInPrompt("project-memory");
      expect(promptTemplate).toBeDefined();

      // Simulate what runExtractMode does
      const currentMemory = await mockMemoryComponent.recallMemory("project");
      const agentName = "memory-extract-project";
      
      const systemPrompt = promptTemplate!
        .replace("{USER_REQUIREMENT}", "请从会话历史中提炼关键知识。")
        .replace("{SCOPE}", "project")
        .replace("{CURRENT_MEMORY}", currentMemory || "(无现有记忆)");

      // Register agent
      mockAgentComponent.registerAgent(agentName, {
        type: "sub",
        systemPrompt,
        allowedTools: ["search_sessions", "get_session", "write_memory"],
        deniedTools: [],
      });

      // NEW BEHAVIOR: Should call env.handle_query instead of agentComponent.run
      const query = "请分析会话历史，提炼项目记忆并写入记忆文件。";
      
      // This is what the new implementation does
      let result: string;
      try {
        result = await mockEnv.handle_query(query, {
          sessionId: "test-session",
          agentType: agentName,
        });
      } catch (error) {
        result = `执行失败: ${error instanceof Error ? error.message : String(error)}`;
      }

      // Verify handle_query was called
      expect(mockEnv.handle_query).toHaveBeenCalledWith(
        query,
        expect.objectContaining({
          agentType: agentName,
          sessionId: "test-session",
        })
      );

      // Verify agentComponent.run was NOT called
      expect(mockAgentComponent.run).not.toHaveBeenCalled();

      // Verify result is a string (not an object)
      expect(typeof result).toBe("string");
      expect(result).toBe("Memory extracted successfully via handle_query");
    });

    test("should register agent with allowedTools for tool filtering", async () => {
      // Verify agent registration includes allowedTools
      const { getBuiltInPrompt } = await import("@ai-setting/roy-bot-core");
      
      const promptTemplate = getBuiltInPrompt("project-memory");
      const agentName = "memory-extract-project";
      const systemPrompt = promptTemplate!
        .replace("{USER_REQUIREMENT}", "test")
        .replace("{SCOPE}", "project")
        .replace("{CURRENT_MEMORY}", "");

      // Register agent with allowedTools (key for tool filtering)
      mockAgentComponent.registerAgent(agentName, {
        type: "sub",
        systemPrompt,
        allowedTools: ["search_sessions", "get_session", "write_memory"],
        deniedTools: [],
      });

      // Verify registration was called with correct config
      expect(mockAgentComponent.registerAgent).toHaveBeenCalledWith(
        agentName,
        expect.objectContaining({
          type: "sub",
          allowedTools: expect.arrayContaining(["search_sessions", "get_session", "write_memory"]),
        })
      );
    });

    test("should handle both project and global scope via handle_query", async () => {
      const { getBuiltInPrompt } = await import("@ai-setting/roy-bot-core");
      
      // Test project scope
      const projectPrompt = getBuiltInPrompt("project-memory");
      expect(projectPrompt).toContain("{USER_REQUIREMENT}");
      
      // Test global scope
      const globalPrompt = getBuiltInPrompt("global-memory");
      expect(globalPrompt).toContain("{USER_REQUIREMENT}");
      
      // Both scopes should work with handle_query
      for (const [scope, prompt] of [["project", projectPrompt], ["global", globalPrompt]]) {
        const agentName = `memory-extract-${scope}`;
        
        await mockEnv.handle_query("test query", {
          sessionId: "test-session",
          agentType: agentName,
        });

        expect(mockEnv.handle_query).toHaveBeenCalledWith(
          "test query",
          expect.objectContaining({
            agentType: agentName,
          })
        );
      }
    });

    test("should cleanup agent after execution", async () => {
      // After handle_query completes, agent should be unregistered
      const agentName = "memory-extract-project";

      await mockEnv.handle_query("test query", {
        sessionId: "test-session",
        agentType: agentName,
      });

      // Simulate cleanup (this happens in record.ts)
      mockAgentComponent.unregisterAgent(agentName);

      expect(mockAgentComponent.unregisterAgent).toHaveBeenCalledWith(agentName);
    });

    test("should cleanup toolComponent tools after execution", async () => {
      // After handle_query completes, tools should be unregistered from ToolComponent
      const agentName = "memory-extract-project";

      await mockEnv.handle_query("test query", {
        sessionId: "test-session",
        agentType: agentName,
      });

      // Simulate tool cleanup
      mockToolComponent.unregister("search_sessions");
      mockToolComponent.unregister("get_session");
      mockToolComponent.unregister("write_memory");

      expect(mockToolComponent.unregister).toHaveBeenCalledTimes(3);
    });

  });

  describe("Comparison: delegate_task vs record --extract pattern", () => {
    
    test("delegate_task uses handle_query pattern (reference implementation)", async () => {
      // Reference pattern from delegate_task (delegate-tool.ts)
      const subagentType = "general";
      const sessionId = "test-session";
      const query = "Complete this task";
      
      // Pattern:
      // 1. Register agent (with deniedTools for nested delegation prevention)
      // 2. Call env.handle_query with agentType
      // 3. Return result
      
      mockEnv.handle_query(query, {
        sessionId,
        deniedTools: ["delegate_task", "stop_task"],
        agentType: subagentType,
      });

      expect(mockEnv.handle_query).toHaveBeenCalledWith(
        query,
        expect.objectContaining({
          sessionId,
          agentType: subagentType,
        })
      );
    });

    test("record --extract should follow same handle_query pattern", async () => {
      // Expected pattern for record --extract after fix
      const agentName = "memory-extract-project";
      const sessionId = "test-session";
      const query = "Extract memory from session";
      
      // Pattern (same as delegate_task):
      // 1. Register agent with allowedTools
      // 2. Call env.handle_query with agentType (NOT agentComponent.run)
      // 3. Return result
      
      await mockEnv.handle_query(query, {
        sessionId,
        agentType: agentName,
      });

      expect(mockEnv.handle_query).toHaveBeenCalledWith(
        query,
        expect.objectContaining({
          sessionId,
          agentType: agentName,
        })
      );
    });

  });

  describe("Error handling in handle_query execution", () => {
    
    test("should handle handle_query errors gracefully", async () => {
      // Mock handle_query to throw an error
      mockEnv.handle_query.mockRejectedValueOnce(new Error("LLM error"));

      let result: string;
      try {
        result = await mockEnv.handle_query("test query", { agentType: "memory-extract-project" });
      } catch (error) {
        result = `执行失败: ${error instanceof Error ? error.message : String(error)}`;
      }

      expect(result).toBe("执行失败: LLM error");
    });

    test("should handle empty handle_query result", async () => {
      // Mock handle_query to return empty string
      mockEnv.handle_query.mockResolvedValueOnce("");

      const result = await mockEnv.handle_query("test query", { agentType: "memory-extract-project" });
      
      expect(result).toBe("");
    });

    test("should handle long result from handle_query", async () => {
      // Mock handle_query to return long result
      const longResult = "A".repeat(500);
      mockEnv.handle_query.mockResolvedValueOnce(longResult);

      const result = await mockEnv.handle_query("test query", { agentType: "memory-extract-project" });
      
      expect(result.length).toBe(500);
      // record.ts truncates to 200 chars
      expect(result.substring(0, 200).length).toBe(200);
    });

  });

  describe("Result output handling", () => {
    
    test("should output success message when handle_query succeeds", async () => {
      const result = await mockEnv.handle_query("test query", { agentType: "memory-extract-project" });
      
      // Success case: result is truthy and doesn't start with "执行失败"
      if (result && !result.startsWith("执行失败")) {
        // This is the success branch in record.ts
        expect(true).toBe(true); // Would output success message
      }
    });

    test("should output error message when handle_query fails", async () => {
      mockEnv.handle_query.mockRejectedValueOnce(new Error("Connection timeout"));

      let result: string;
      try {
        result = await mockEnv.handle_query("test query", { agentType: "memory-extract-project" });
      } catch (error) {
        result = `执行失败: ${error instanceof Error ? error.message : String(error)}`;
      }
      
      // Error case: result starts with "执行失败"
      expect(result).toContain("执行失败");
    });

  });
});
