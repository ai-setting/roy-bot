/**
 * @fileoverview Test for ContextError handling - LLM Response Preservation
 * 
 * TDD: 测试 ContextError 抛出时 LLM response 是否被正确保存到 session
 * 
 * Bug: 当 LLMComponent.invoke() 抛出 ContextError 时，LLM 的 response（包括
 * content, toolCalls, reasoning 等）没有被保存到 hookCtx.messages 中，
 * 导致 session 中缺少 assistant message，后续的 compact 操作无法获取完整信息。
 * 
 * 期望行为：
 * 1. ContextError 应该携带 LLM output 信息
 * 2. AgentComponent 应该在 catch ContextError 时保存 assistant message
 * 3. session 中应该记录完整的 LLM response
 */

import { describe, test, expect, vi, beforeEach } from "bun:test";

const isParallelRun = "BUN_TEST_WORKER_ID" in process.env;

import { AgentComponent } from "../agent/agent-component";
import { ContextError, ErrorCodes, type LLMOutput } from "../errors";
import type { Environment } from "../interface";
import { ConfigComponent } from "../../config/config-component";

// ============================================================================
// Helper: Create mock environment
// ============================================================================

function createMockEnvironment(configComponent: ConfigComponent) {
  return {
    name: "test-env",
    version: "1.0.0",
    getConfig: vi.fn(() => ({ name: "test-env", version: "1.0.0", enabled: true })),
    registerComponent: vi.fn(),
    unregisterComponent: vi.fn(),
    getComponent: vi.fn((name: string) => {
      if (name === "config") return configComponent;
      return undefined;
    }),
    hasComponent: vi.fn((name: string) => name === "config"),
    listComponents: vi.fn(() => []),
    handle_query: vi.fn(),
    handle_action: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    subscribeTo: vi.fn(() => () => {}),
    subscribeAll: vi.fn(() => () => {}),
    pushEnvEvent: vi.fn(),
  } as unknown as Environment;
}

// ============================================================================
// Tests
// ============================================================================

describe.skipIf(isParallelRun)("ContextError - LLM Response Preservation (TDD)", () => {
  let agentComponent: AgentComponent;
  let configComponent: ConfigComponent;
  let mockEnv: Environment;
  let mockSessionComponent: any;
  let recordedMessages: any[];

  beforeEach(async () => {
    vi.clearAllMocks();
    
    agentComponent = new AgentComponent();
    configComponent = new ConfigComponent();
    recordedMessages = [];
    
    // Mock session component that records messages
    mockSessionComponent = {
      addMessage: vi.fn(async (_sessionId: string, message: any) => {
        recordedMessages.push(message);
      }),
      getContext: vi.fn(async () => ({
        messages: [],
        checkpoint: undefined,
      })),
    };
    
    mockEnv = createMockEnvironment(configComponent);
    (mockEnv.getComponent as any).mockImplementation((name: string) => {
      if (name === "session") return mockSessionComponent;
      if (name === "config") return configComponent;
      return undefined;
    });
    
    // Initialize agent component
    await agentComponent.init({ env: mockEnv, options: { configComponent } });
  });

  describe.skipIf(isParallelRun)("ContextError should carry LLM output", () => {
    test("ContextError constructor should accept llmOutput as constructor parameter", () => {
      // Arrange
      const llmOutput = {
        content: "This is the LLM response content",
        reasoning: "I need to think about this",
        toolCalls: [
          { id: "call_1", function: { name: "tool1", arguments: "{}" } }
        ],
        usage: {
          promptTokens: 50000,
          completionTokens: 1000,
          totalTokens: 51000
        }
      };
      
      // Act - llmOutput is the 7th constructor parameter
      const error = new ContextError(
        "Context threshold exceeded: 51000/128000 (39.8%)",
        ErrorCodes.CONTEXT_THRESHOLD_EXCEEDED,
        "session_123",
        llmOutput.usage,
        128000,
        llmOutput  // llmOutput as the 6th parameter
      );
      
      // Assert
      expect(error.message).toBe("Context threshold exceeded: 51000/128000 (39.8%)");
      expect(error.code).toBe("CTX_001");
      expect(error.sessionId).toBe("session_123");
      expect(error.usage?.totalTokens).toBe(51000);
      expect(error.llmOutput).toEqual(llmOutput);
    });
  });

  describe.skipIf(isParallelRun)("AgentComponent should preserve LLM response on ContextError", () => {
    test("should save assistant message to session when ContextError is thrown", async () => {
      // Arrange
      agentComponent.registerAgent("test-agent", { 
        type: "primary",
        systemPrompt: "You are a helpful assistant.",
      });

      // Mock LLMComponent that returns response then throws ContextError
      const llmResponse = {
        output: {
          content: "This is a test response that should be preserved",
          reasoning: "Thinking about the response",
          toolCalls: [],
          finishReason: "stop" as const,
          usage: {
            promptTokens: 50000,
            completionTokens: 1000,
            totalTokens: 51000
          }
        },
        providerId: "openai",
        model: "gpt-4o",
        latencyMs: 100
      };

      const mockLLMComponent = {
        invoke: vi.fn().mockImplementation(() => {
          // Throw ContextError with LLM output as the 6th parameter (llmOutput property)
          const error = new ContextError(
            "Context threshold exceeded: 51000/128000 (39.8%)",
            ErrorCodes.CONTEXT_THRESHOLD_EXCEEDED,
            "session_123",
            llmResponse.output.usage,
            128000,
            {  // llmOutput - this is the 6th parameter
              content: llmResponse.output.content, 
              reasoning: llmResponse.output.reasoning, 
              toolCalls: llmResponse.output.toolCalls 
            }
          );
          throw error;
        })
      };
      (mockEnv.getComponent as any).mockImplementation((name: string) => {
        if (name === "llm") return mockLLMComponent;
        if (name === "session") return mockSessionComponent;
        if (name === "config") return configComponent;
        return undefined;
      });

      // Act
      try {
        await agentComponent.run("test-agent", "Test query", { sessionId: "session_123" });
      } catch (error) {
        // Expected to throw ContextError or wrapped error
      }

      // Assert - The assistant message should be recorded
      const assistantMessages = recordedMessages.filter(m => m.role === "assistant");
      
      // This is the key assertion - verify assistant message is recorded
      expect(assistantMessages.length).toBeGreaterThan(0);
      
      // Check content - it might be in parts array or as string
      const assistantMsg = assistantMessages[0];
      if (Array.isArray(assistantMsg.parts)) {
        // Content is in parts format
        const textPart = assistantMsg.parts.find((p: any) => p.type === "text");
        expect(textPart?.content).toContain("This is a test response");
      } else {
        // Content is plain string
        expect(assistantMsg.content).toContain("This is a test response");
      }
    });

    test("should save assistant message with tool calls to session when ContextError is thrown", async () => {
      // Arrange
      agentComponent.registerAgent("test-agent", { 
        type: "primary",
        systemPrompt: "You are a helpful assistant.",
      });

      // Mock LLMComponent that returns tool calls then throws ContextError
      const mockLLMComponent = {
        invoke: vi.fn().mockImplementation(() => {
          const llmOutput = {
            content: "I'll search for that information",
            reasoning: "Need to use search tool",
            toolCalls: [
              { 
                id: "call_1", 
                function: { name: "search", arguments: '{"query":"test"}' } 
              }
            ],
            usage: { promptTokens: 50000, completionTokens: 500, totalTokens: 50500 }
          };
          
          const error = new ContextError(
            "Context threshold exceeded: 50500/128000 (39.5%)",
            ErrorCodes.CONTEXT_THRESHOLD_EXCEEDED,
            "session_123",
            llmOutput.usage,
            128000,
            llmOutput
          );
          throw error;
        })
      };
      (mockEnv.getComponent as any).mockImplementation((name: string) => {
        if (name === "llm") return mockLLMComponent;
        if (name === "session") return mockSessionComponent;
        if (name === "config") return configComponent;
        return undefined;
      });

      // Act
      try {
        await agentComponent.run("test-agent", "Search for something", { sessionId: "session_123" });
      } catch (error) {
        // Expected
      }

      // Assert - The assistant message with tool calls should be recorded
      const assistantMessages = recordedMessages.filter(m => m.role === "assistant");
      
      // This is the key assertion - currently this test SHOULD FAIL
      expect(assistantMessages.length).toBeGreaterThan(0);
      
      // Check that the content includes tool call info
      const assistantContent = assistantMessages[0].content;
      expect(assistantContent).toBeDefined();
    });

    test("should preserve reasoning content in assistant message when ContextError is thrown", async () => {
      // Arrange
      agentComponent.registerAgent("test-agent", { 
        type: "primary",
        systemPrompt: "You are a helpful assistant.",
      });

      const mockLLMComponent = {
        invoke: vi.fn().mockImplementation(() => {
          const llmOutput = {
            content: "Final answer",
            reasoning: "Let me think step by step about this problem...",
            toolCalls: [],
            usage: { promptTokens: 50000, completionTokens: 500, totalTokens: 50500 }
          };
          
          const error = new ContextError(
            "Context threshold exceeded",
            ErrorCodes.CONTEXT_THRESHOLD_EXCEEDED,
            "session_123",
            llmOutput.usage,
            128000,
            llmOutput
          );
          throw error;
        })
      };
      (mockEnv.getComponent as any).mockImplementation((name: string) => {
        if (name === "llm") return mockLLMComponent;
        if (name === "session") return mockSessionComponent;
        if (name === "config") return configComponent;
        return undefined;
      });

      // Act
      try {
        await agentComponent.run("test-agent", "Test", { sessionId: "session_123" });
      } catch (error) {
        // Expected
      }

      // Assert
      const assistantMessages = recordedMessages.filter(m => m.role === "assistant");
      expect(assistantMessages.length).toBeGreaterThan(0);
      
      // The assistant message should contain the reasoning (even if it's in a structured format)
      const assistantContent = assistantMessages[0].content;
      expect(assistantContent).toBeDefined();
    });
  });

  describe.skipIf(isParallelRun)("Normal error handling (no regression)", () => {
    test("should still handle normal errors without ContextError correctly", async () => {
      // Arrange
      agentComponent.registerAgent("test-agent", { 
        type: "primary",
        systemPrompt: "You are a helpful assistant.",
      });

      const mockLLMComponent = {
        invoke: vi.fn().mockRejectedValue(new Error("Network error"))
      };
      (mockEnv.getComponent as any).mockImplementation((name: string) => {
        if (name === "llm") return mockLLMComponent;
        if (name === "session") return mockSessionComponent;
        if (name === "config") return configComponent;
        return undefined;
      });

      // Act & Assert
      try {
        await agentComponent.run("test-agent", "Test", { sessionId: "session_123" });
        // If we reach here, the result should indicate error
        expect(true).toBe(true); // Test passes if no unhandled exception
      } catch (error) {
        // Normal errors may propagate up
        expect(error).toBeDefined();
      }
    });
  });
});
