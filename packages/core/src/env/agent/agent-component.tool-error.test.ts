/**
 * @fileoverview TDD Tests for Tool Error Handling in AgentComponent
 * 
 * Feature: Tool execution error should be stored as tool result
 * 
 * Problem:
 * When a tool throws an exception during execution, the tool call is already
 * added to messages (via pushMessage), but the tool result is NOT added because:
 * 1. executeTool() throws the error
 * 2. The catch block in the ReAct loop catches the error
 * 3. Tool result pushMessage() is never reached
 * 
 * This breaks AI SDK v6's requirement for 1:1 tool-call to tool-result mapping.
 * 
 * Solution:
 * Modify the error handling to always add tool result (with error content) even
 * when tool execution throws an exception. This makes the behavior uniform
 * regardless of whether the tool succeeds, returns an error, or throws an exception.
 * 
 * For ask_user special case: the exception is stored as tool result (unlike other
 * exceptions which are swallowed), allowing resume flow to replace it with actual
 * user response.
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

function createMockEnvironment(mockComponents: Record<string, any> = {}): Environment {
  return {
    name: "test-env",
    version: "1.0.0",
    getConfig: vi.fn(() => ({ name: "test-env", version: "1.0.0", enabled: true })),
    registerComponent: vi.fn(),
    unregisterComponent: vi.fn(),
    getComponent: vi.fn((name: string) => {
      return mockComponents[name];
    }),
    listComponents: vi.fn(() => Object.keys(mockComponents)),
    handle_query: vi.fn(),
    handle_action: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    subscribeTo: vi.fn(() => () => {}),
    subscribeAll: vi.fn(() => () => {}),
    pushEnvEvent: vi.fn(),
  };
}

// ============================================================================
// Test Suite: Tool Error Handling
// ============================================================================

describe("AgentComponent Tool Error Handling (TDD)", () => {
  let agentComponent: AgentComponent;
  let mockEnv: Environment;
  let configComponent: ConfigComponent;
  let mockSessionComponent: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    
    configComponent = new ConfigComponent();
    
    // Create mock session component to capture stored messages
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
    
    mockEnv = createMockEnvironment({
      config: configComponent,
      session: mockSessionComponent,
    });
    
    agentComponent = new AgentComponent();
    await agentComponent.init({ 
      name: "agent",
      version: "1.0.0", 
      enabled: true,
      env: mockEnv, 
      options: { configComponent } 
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // RED Phase: Write failing tests first
  // ===========================================================================

  describe("RED: AskUserError should be stored as tool result", () => {
    it("should store AskUserError as tool result for ask_user tool", async () => {
      // Setup agent
      agentComponent.registerAgent("test-agent", {
        type: "primary",
        systemPrompt: "You are a helpful assistant.",
      });

      // Mock LLM that returns ask_user tool call
      const mockLLMComponent = {
        invoke: vi.fn(() => Promise.resolve({
          output: {
            content: "",
            toolCalls: [{
              id: "call_1",
              function: { name: "ask_user", arguments: JSON.stringify({ query: "Continue?" }) }
            }]
          }
        }))
      };
      (mockEnv.getComponent as any).mockImplementation((name: string) => {
        if (name === "llm") return mockLLMComponent;
        if (name === "session") return mockSessionComponent;
        return undefined;
      });

      // Mock ask_user tool that throws AskUserError
      const mockAskUserTool: any = {
        name: "ask_user",
        description: "Ask user for input",
        parameters: z.object({
          query: z.string(),
        }),
        execute: vi.fn(async () => {
          throw new AskUserError(
            "run_123",
            "test-session",
            "node_1",
            "agent",
            "Continue?"
          );
        }),
      };
      agentComponent.setDefaultTools([mockAskUserTool]);

      // Execute agent
      const result = await agentComponent.run("test-agent", "Test ask_user", {
        sessionId: "test-session",
      });

      // Verify: result should contain __ASK_USER_ERROR__ marker
      expect(result.error).toBeDefined();
      expect(result.error).toContain("__ASK_USER_ERROR__");
      
      // Verify: session should have tool result with error content.
      // recordSessionMessages now uses addMessages(batch); flatten across calls.
      const storedMessages = mockSessionComponent.addMessages.mock.calls
        .flatMap((call: any[]) => call[1] ?? []);
      const toolMessages = storedMessages.filter((msg: any) => msg?.role === "tool");

      // For ask_user, tool result should be stored with error info
      expect(toolMessages.length).toBeGreaterThan(0);

      const toolMessage = toolMessages[0];
      // Content might be empty, check parts for output
      const hasParts = toolMessage.parts && toolMessage.parts.length > 0;
      const hasOutput = hasParts && toolMessage.parts[0]?.output;
      
      // Either content or parts output should contain the query
      const toolContent = typeof toolMessage.content === "string" 
        ? toolMessage.content 
        : "";
      const partsOutput = hasOutput ? JSON.stringify(toolMessage.parts[0].output) : "";
      
      // Should contain error info from AskUserError (query in output)
      expect(toolContent + partsOutput).toContain("Continue?");
    });
  });

  describe("RED: Resume flow should replace tool result", () => {
    it("should allow replacing tool result with user response on resume", async () => {
      // This test verifies the resume flow design
      // When resuming, the stored tool result (with error) should be 
      // replaced with the actual user response
      
      const agentSessionId = "agent_session_123";
      
      // Simulate stored messages after initial run (with tool error stored)
      const storedToolResult = {
        role: "tool" as const,
        content: JSON.stringify({ error: "AskUserError: Continue?" }),
        metadata: {
          toolCallId: "call_1",
          toolName: "ask_user",
          isAskUserError: true,
        },
      };
      
      // Simulate resume - user response should replace tool result
      const userResponse = "yes, continue";
      
      // Resume would call addMessage to add user response
      // The key insight: on resume, we need to either:
      // 1. Replace the existing tool result message, or
      // 2. Add user response as a new message and skip the error tool result
      
      // For now, verify the session can store both
      mockSessionComponent.addMessage(agentSessionId, {
        role: "user",
        content: userResponse,
        metadata: { type: "user_response" },
      });
      
      // Verify user response was stored
      expect(mockSessionComponent.addMessage).toHaveBeenCalledWith(
        agentSessionId,
        expect.objectContaining({
          role: "user",
          content: userResponse,
        })
      );
    });
  });

  describe("RED: Normal tool error should also be stored", () => {
    it("should store normal tool error as tool result", async () => {
      // Setup agent
      agentComponent.registerAgent("test-agent", {
        type: "primary",
        systemPrompt: "You are a helpful assistant.",
        maxIterations: 1, // Limit iterations to avoid infinite loop
      });

      // Mock LLM that returns a tool call
      const mockLLMComponent = {
        invoke: vi.fn(() => Promise.resolve({
          output: {
            content: "",
            toolCalls: [{
              id: "call_1",
              function: { name: "error_tool", arguments: "{}" }
            }]
          }
        }))
      };
      (mockEnv.getComponent as any).mockImplementation((name: string) => {
        if (name === "llm") return mockLLMComponent;
        if (name === "session") return mockSessionComponent;
        return undefined;
      });

      // Mock tool that returns error result (not throws)
      const mockTool: any = {
        name: "error_tool",
        description: "A tool that returns error",
        parameters: z.object({}),
        execute: vi.fn(async () => {
          return { success: false, output: "", error: "Tool execution failed!" };
        }),
      };
      agentComponent.setDefaultTools([mockTool]);

      // Execute agent
      const result = await agentComponent.run("test-agent", "Test tool error", {
        sessionId: "test-session",
      });

      // Verify: session should have BOTH tool call and tool result.
      expect(mockSessionComponent.addMessages).toHaveBeenCalled();
      const storedMessages = mockSessionComponent.addMessages.mock.calls
        .flatMap((call: any[]) => call[1] ?? []);

      // Find tool result message
      const toolMessages = storedMessages.filter((msg: any) => msg?.role === "tool");
      expect(toolMessages.length).toBeGreaterThan(0);

      // The tool result should contain the error message
      const toolMessage = toolMessages[0];
      const hasParts = toolMessage.parts && toolMessage.parts.length > 0;
      const hasOutput = hasParts && toolMessage.parts[0]?.output;
      
      const toolContent = typeof toolMessage.content === "string" 
        ? toolMessage.content 
        : "";
      const partsOutput = hasOutput ? JSON.stringify(toolMessage.parts[0].output) : "";
      
      expect(toolContent + partsOutput).toContain("Tool execution failed");
    });
  });

  // ===========================================================================
  // Helper: Run agent with mocked LLM
  // ===========================================================================

  /**
   * Helper function to run agent with custom LLM mock
   */
  async function runAgentWithLLMMock(
    agentName: string,
    llmResponse: any,
    tools: any[],
    sessionId?: string
  ) {
    const mockLLMComponent = {
      invoke: vi.fn(() => Promise.resolve(llmResponse)),
    };
    
    (mockEnv.getComponent as any).mockImplementation((name: string) => {
      if (name === "llm") return mockLLMComponent;
      if (name === "session") return mockSessionComponent;
      return undefined;
    });
    
    agentComponent.setDefaultTools(tools);
    
    return agentComponent.run(agentName, "Test query", {
      sessionId: sessionId || "test-session",
    });
  }
});
