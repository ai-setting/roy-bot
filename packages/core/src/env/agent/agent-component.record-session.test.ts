/**
 * @fileoverview Record Session Messages Tests
 * 
 * TDD tests for recordSessionMessages
 * 
 * 需求：
 * 1. user 消息存储
 * 2. assistant 消息（无论有无tool call，包括思考过程）存储
 * 3. tool result 消息存储
 * 4. assistant 最终 text response 存储
 * 5. 避免去重逻辑
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentComponent } from "./agent-component";
import { ConfigComponent } from "../../config/config-component";
import type { SessionComponent } from "../session/session-component";
import type { ModelMessage } from "ai";
import type { Environment } from "../interface";

// ============================================================================
// Mock Helpers
// ============================================================================

function createMockSessionComponent() {
  const messages = new Map<string, any[]>();
  const mock: any = {
    _messages: messages,
    addMessage: vi.fn(async (sessionId: string, msg: any) => {
      const sessionMessages = messages.get(sessionId) ?? [];
      sessionMessages.push({
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        sessionID: sessionId,
        role: msg.role,
        content: msg.content,
        timestamp: Date.now(),
        parts: msg.parts,
        metadata: msg.metadata,
      });
      messages.set(sessionId, sessionMessages);
      return `msg_${Date.now()}`;
    }),
    addMessages: vi.fn(async (sessionId: string, msgs: any[]) => {
      const sessionMessages = messages.get(sessionId) ?? [];
      const ids: string[] = [];
      for (const msg of msgs) {
        const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        ids.push(id);
        sessionMessages.push({
          id,
          sessionID: sessionId,
          role: msg.role,
          content: msg.content,
          timestamp: Date.now(),
          parts: msg.parts,
          metadata: msg.metadata,
        });
      }
      messages.set(sessionId, sessionMessages);
      return ids;
    }),
    getMessages: vi.fn(async (sessionId: string) => messages.get(sessionId) ?? []),
    getMessageCount: vi.fn(async (sessionId: string) => messages.get(sessionId)?.length ?? 0),
  };
  return mock as SessionComponent;
}

function createMockEnv(sessionComponent: SessionComponent): Environment {
  const mockConfig: any = { get: vi.fn(() => undefined) };
  return {
    name: "test-env",
    version: "1.0.0",
    getComponent: vi.fn((name: string) => {
      if (name === "session") return sessionComponent;
      if (name === "config") return mockConfig;
      return undefined;
    }),
    pushEnvEvent: vi.fn(),
    subscribeTo: vi.fn(() => () => {}),
  };
}

// Helper to call private method
async function recordSessionMessages(
  agent: AgentComponent,
  sessionId: string,
  allMessages: ModelMessage[]
) {
  // @ts-ignore - accessing private method
  return agent.recordSessionMessages(sessionId, allMessages);
}

// ============================================================================
// Tests
// ============================================================================

describe("recordSessionMessages", () => {
  let sessionComponent: SessionComponent;
  let agentComponent: AgentComponent;

  beforeEach(async () => {
    vi.clearAllMocks();
    sessionComponent = createMockSessionComponent();
    agentComponent = new AgentComponent();
    const mockEnv = createMockEnv(sessionComponent);
    await agentComponent.init({ env: mockEnv, options: { configComponent: new ConfigComponent() } });
  });

  describe("1. user 消息存储", () => {
    it("应该存储 user 消息", async () => {
      const allMessages: ModelMessage[] = [
        { role: "user", content: "hello" },
      ];
      await recordSessionMessages(agentComponent, "session_1", allMessages);

      const storedMessages = (sessionComponent as any)._messages.get("session_1") ?? [];
      expect(storedMessages).toHaveLength(1);
      expect(storedMessages[0].role).toBe("user");
      expect(storedMessages[0].content).toBe("hello");
    });

    it("应该跳过空 user 消息（无需用户输入的 workflow agent）", async () => {
      const allMessages: ModelMessage[] = [
        { role: "user", content: "" },
        { role: "assistant", content: "started without user input" },
      ];

      await recordSessionMessages(agentComponent, "session_1", allMessages);

      const storedMessages = (sessionComponent as any)._messages.get("session_1") ?? [];
      expect(storedMessages.filter((m: any) => m.role === "user")).toHaveLength(0);
      expect(storedMessages.filter((m: any) => m.role === "assistant")).toHaveLength(1);
    });

    it("应该存储 allMessages 中的所有 user 消息", async () => {
      const allMessages: ModelMessage[] = [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "second question" },
      ];
      
      await recordSessionMessages(agentComponent, "session_1", allMessages);

      const storedMessages = (sessionComponent as any)._messages.get("session_1") ?? [];
      const userMessages = storedMessages.filter((m: any) => m.role === "user");
      
      expect(userMessages).toHaveLength(2);
      expect(userMessages[0].content).toBe("first question");
      expect(userMessages[1].content).toBe("second question");
      
      const assistantMessages = storedMessages.filter((m: any) => m.role === "assistant");
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0].content).toBe("first answer");
    });
  });

  describe("2. assistant 消息存储（包括思考过程）", () => {
    it("应该存储纯文本的 assistant 消息", async () => {
      const allMessages: ModelMessage[] = [
        { role: "assistant", content: "Hello! How can I help you?" },
      ];
      
      await recordSessionMessages(agentComponent, "session_1", allMessages);

      const storedMessages = (sessionComponent as any)._messages.get("session_1") ?? [];
      const assistantMessages = storedMessages.filter((m: any) => m.role === "assistant");
      
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0].content).toBe("Hello! How can I help you?");
    });

    it("应该存储带 reasoning 的 assistant 消息", async () => {
      const allMessages: ModelMessage[] = [
        { 
          role: "assistant", 
          content: [
            { type: "reasoning", text: "Let me think about this..." },
            { type: "text", text: "Here's my answer." },
          ]
        },
      ];
      
      await recordSessionMessages(agentComponent, "session_1", allMessages);

      const storedMessages = (sessionComponent as any)._messages.get("session_1") ?? [];
      const assistantMessages = storedMessages.filter((m: any) => m.role === "assistant");
      
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0].parts).toBeDefined();
      expect(assistantMessages[0].parts).toHaveLength(2);
      expect(assistantMessages[0].parts[0].type).toBe("reasoning");
      expect(assistantMessages[0].parts[1].type).toBe("text");
    });

    it("应该存储带 tool-call 的 assistant 消息", async () => {
      const allMessages: ModelMessage[] = [
        { 
          role: "assistant", 
          content: [
            { type: "text", text: "Let me search for that." },
            { type: "tool-call", toolCallId: "tc1", toolName: "web_search", input: { query: "AI" } },
          ]
        },
      ];
      
      await recordSessionMessages(agentComponent, "session_1", allMessages);

      const storedMessages = (sessionComponent as any)._messages.get("session_1") ?? [];
      const assistantMessages = storedMessages.filter((m: any) => m.role === "assistant");
      
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0].parts).toHaveLength(2);
      expect(assistantMessages[0].parts[0].type).toBe("text");
      expect(assistantMessages[0].parts[1].type).toBe("tool-call");
      expect(assistantMessages[0].parts[1].toolName).toBe("web_search");
    });

    it("应该存储只有 tool-call 没有 text 的 assistant 消息", async () => {
      const allMessages: ModelMessage[] = [
        { 
          role: "assistant", 
          content: [
            { type: "tool-call", toolCallId: "tc1", toolName: "search", input: {} },
          ]
        },
      ];
      
      await recordSessionMessages(agentComponent, "session_1", allMessages);

      const storedMessages = (sessionComponent as any)._messages.get("session_1") ?? [];
      const assistantMessages = storedMessages.filter((m: any) => m.role === "assistant");
      
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0].parts).toHaveLength(1);
      expect(assistantMessages[0].parts[0].type).toBe("tool-call");
    });
  });

  describe("3. tool result 消息存储", () => {
    it("应该存储 tool 消息", async () => {
      const allMessages: ModelMessage[] = [
        { role: "tool", content: "Search results here", toolCallId: "tc1", name: "web_search" },
      ];
      
      await recordSessionMessages(agentComponent, "session_1", allMessages);

      const storedMessages = (sessionComponent as any)._messages.get("session_1") ?? [];
      const toolMessages = storedMessages.filter((m: any) => m.role === "tool");
      
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0].role).toBe("tool");
      expect(toolMessages[0].content).toBe("Search results here");
    });

    it("应该存储 tool-result 格式的 tool 消息", async () => {
      const allMessages: ModelMessage[] = [
        { 
          role: "tool", 
          content: [
            { type: "tool-result", toolCallId: "tc1", toolName: "read_file", output: "File content" },
          ]
        },
      ];
      
      await recordSessionMessages(agentComponent, "session_1", allMessages);

      const storedMessages = (sessionComponent as any)._messages.get("session_1") ?? [];
      const toolMessages = storedMessages.filter((m: any) => m.role === "tool");
      
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0].parts[0].type).toBe("tool-result");
      expect(toolMessages[0].parts[0].output).toBe("File content");
    });
  });

  describe("4. 完整对话流程存储", () => {
    it("应该正确存储包含 tool-call 循环的完整对话", async () => {
      const allMessages: ModelMessage[] = [
        { role: "user", content: "research AI" },
        { role: "assistant", content: [
          { type: "text", text: "Let me search for that." },
          { type: "tool-call", toolCallId: "tc1", toolName: "web_search", input: { query: "AI" } },
        ]},
        { role: "tool", content: "Found results about AI", toolCallId: "tc1", name: "web_search" },
        { role: "assistant", content: "I've found the results." },
      ];
      
      await recordSessionMessages(agentComponent, "session_1", allMessages);

      const storedMessages = (sessionComponent as any)._messages.get("session_1") ?? [];
      
      // allMessages: user + 2 assistant + tool = 4条
      expect(storedMessages).toHaveLength(4);
      
      const userMessages = storedMessages.filter((m: any) => m.role === "user");
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0].content).toBe("research AI");
      
      const assistantMessages = storedMessages.filter((m: any) => m.role === "assistant");
      expect(assistantMessages).toHaveLength(2);
      
      const toolMessages = storedMessages.filter((m: any) => m.role === "tool");
      expect(toolMessages).toHaveLength(1);
    });

    it("应该正确存储只有文本的简单对话", async () => {
      const allMessages: ModelMessage[] = [
        { role: "user", content: "How are you?" },
        { role: "assistant", content: "Hello! I'm doing well, thanks for asking." },
      ];
      
      await recordSessionMessages(agentComponent, "session_1", allMessages);

      const storedMessages = (sessionComponent as any)._messages.get("session_1") ?? [];
      
      expect(storedMessages).toHaveLength(2);
      
      const userMessages = storedMessages.filter((m: any) => m.role === "user");
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0].content).toBe("How are you?");
      
      const assistantMessages = storedMessages.filter((m: any) => m.role === "assistant");
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0].content).toBe("Hello! I'm doing well, thanks for asking.");
    });
  });

  describe("5. 跳过空消息", () => {
    it("应该跳过空内容的 assistant 消息", async () => {
      const allMessages: ModelMessage[] = [
        { role: "assistant", content: "" },  // 空字符串
        { role: "assistant", content: [] },  // 空数组
        { role: "assistant", content: "Valid response" },
      ];
      
      await recordSessionMessages(agentComponent, "session_1", allMessages);

      const storedMessages = (sessionComponent as any)._messages.get("session_1") ?? [];
      const assistantMessages = storedMessages.filter((m: any) => m.role === "assistant");
      
      // 只有最后一条有效的 assistant 消息
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0].content).toBe("Valid response");
    });

    it("应该跳过 null/undefined 内容的 assistant 消息", async () => {
      const allMessages: ModelMessage[] = [
        { role: "assistant", content: null as any },
        { role: "assistant", content: "Valid" },
      ];
      
      await recordSessionMessages(agentComponent, "session_1", allMessages);

      const storedMessages = (sessionComponent as any)._messages.get("session_1") ?? [];
      const assistantMessages = storedMessages.filter((m: any) => m.role === "assistant");
      
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0].content).toBe("Valid");
    });
  });

  describe("6. 不存储 system 消息", () => {
    it("不应该存储 system 消息", async () => {
      const allMessages: ModelMessage[] = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "hi" },
        { role: "assistant", content: "Hello!" },
      ];
      
      await recordSessionMessages(agentComponent, "session_1", allMessages);

      const storedMessages = (sessionComponent as any)._messages.get("session_1") ?? [];
      const systemMessages = storedMessages.filter((m: any) => m.role === "system");
      
      expect(systemMessages).toHaveLength(0);
      
      // user 和 assistant 仍然存储
      expect(storedMessages).toHaveLength(2);
    });
  });
});
