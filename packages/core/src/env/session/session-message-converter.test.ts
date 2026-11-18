/**
 * @fileoverview Session Message Converter Tests
 * 
 * Tests for SessionMessage <-> AI SDK ModelMessage conversion functions.
 * Following TDD: These tests define the expected behavior.
 */

import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import type {
  SessionMessage,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  ReasoningPart,
  FilePart,
  CheckpointPart,
  SessionPart,
  ImagePart,
} from "./types";

// ============================================================================
// Test Utilities
// ============================================================================

function createSessionMessage(overrides: Partial<SessionMessage> = {}): SessionMessage {
  return {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    sessionID: "session_test",
    role: "user",
    content: "",
    timestamp: Date.now(),
    ...overrides,
  };
}

// ============================================================================
// RED Phase: Write tests that define expected behavior
// ============================================================================

describe("Session Part Types", () => {
  describe("TextPart", () => {
    test("should have correct structure", () => {
      const textPart: TextPart = {
        type: "text",
        content: "Hello, world!",
        synthetic: false,
        ignored: false,
      };
      
      expect(textPart.type).toBe("text");
      expect(textPart.content).toBe("Hello, world!");
      expect(textPart.synthetic).toBe(false);
      expect(textPart.ignored).toBe(false);
    });
    
    test("should support optional fields", () => {
      const textPart: TextPart = {
        type: "text",
        content: "Simple text",
      };
      
      expect(textPart.type).toBe("text");
      expect(textPart.content).toBe("Simple text");
      expect(textPart.synthetic).toBeUndefined();
      expect(textPart.ignored).toBeUndefined();
    });
  });
  
  describe("ToolCallPart", () => {
    test("should have correct structure", () => {
      const toolCallPart: ToolCallPart = {
        type: "tool-call",
        toolCallId: "call_abc123",
        toolName: "grep",
        arguments: { pattern: "TODO", path: "/src" },
        state: "pending",
      };
      
      expect(toolCallPart.type).toBe("tool-call");
      expect(toolCallPart.toolCallId).toBe("call_abc123");
      expect(toolCallPart.toolName).toBe("grep");
      expect(toolCallPart.arguments).toEqual({ pattern: "TODO", path: "/src" });
      expect(toolCallPart.state).toBe("pending");
    });
    
    test("should support string arguments", () => {
      const toolCallPart: ToolCallPart = {
        type: "tool-call",
        toolCallId: "call_xyz",
        toolName: "bash",
        arguments: '{"command": "ls -la"}',
        state: "pending",
      };
      
      expect(typeof toolCallPart.arguments).toBe("string");
    });
    
    test("should support running state", () => {
      const toolCallPart: ToolCallPart = {
        type: "tool-call",
        toolCallId: "call_running",
        toolName: "search",
        arguments: {},
        state: "running",
      };
      
      expect(toolCallPart.state).toBe("running");
    });
  });
  
  describe("ToolResultPart", () => {
    test("should have correct structure", () => {
      const toolResultPart: ToolResultPart = {
        type: "tool-result",
        toolCallId: "call_abc123",
        toolName: "grep",
        output: "Found 3 matches",
        state: "completed",
      };
      
      expect(toolResultPart.type).toBe("tool-result");
      expect(toolResultPart.toolCallId).toBe("call_abc123");
      expect(toolResultPart.toolName).toBe("grep");
      expect(toolResultPart.output).toBe("Found 3 matches");
      expect(toolResultPart.state).toBe("completed");
    });
    
    test("should support error state", () => {
      const toolResultPart: ToolResultPart = {
        type: "tool-result",
        toolCallId: "call_error",
        toolName: "bash",
        output: "",
        error: "Command failed: exit code 1",
        state: "error",
      };
      
      expect(toolResultPart.error).toBe("Command failed: exit code 1");
      expect(toolResultPart.state).toBe("error");
    });
  });
  
  describe("ReasoningPart", () => {
    test("should have correct structure", () => {
      const reasoningPart: ReasoningPart = {
        type: "reasoning",
        content: "Let me think about this problem...",
        reasoningType: "core",
        state: "completed",
      };
      
      expect(reasoningPart.type).toBe("reasoning");
      expect(reasoningPart.content).toBe("Let me think about this problem...");
      expect(reasoningPart.reasoningType).toBe("core");
      expect(reasoningPart.state).toBe("completed");
    });
    
    test("should support optional metadata", () => {
      const reasoningPart: ReasoningPart = {
        type: "reasoning",
        content: "Thinking...",
        reasoningType: "effort",
        state: "thinking",
        isCollapsed: true,
        metadata: {
          tokenCount: 150,
          time: { start: Date.now(), end: Date.now() + 1000 },
        },
      };
      
      expect(reasoningPart.isCollapsed).toBe(true);
      expect(reasoningPart.metadata?.tokenCount).toBe(150);
    });
  });
  
  describe("FilePart", () => {
    test("should have correct structure", () => {
      const filePart: FilePart = {
        type: "file",
        mime: "image/png",
        url: "file:///path/to/image.png",
        filename: "screenshot.png",
      };
      
      expect(filePart.type).toBe("file");
      expect(filePart.mime).toBe("image/png");
      expect(filePart.url).toBe("file:///path/to/image.png");
      expect(filePart.filename).toBe("screenshot.png");
    });
  });
  
  describe("CheckpointPart", () => {
    test("should have correct structure", () => {
      const checkpointPart: CheckpointPart = {
        type: "checkpoint",
        checkpointId: "chk_abc123",
        summary: "Session compacted",
        processKeyPoints: ["Analyzed requirements", "Created test files"],
        currentState: "Implementing feature X",
        nextSteps: ["Write implementation", "Test edge cases"],
      };
      
      expect(checkpointPart.type).toBe("checkpoint");
      expect(checkpointPart.checkpointId).toBe("chk_abc123");
      expect(checkpointPart.summary).toBe("Session compacted");
      expect(checkpointPart.processKeyPoints).toHaveLength(2);
      expect(checkpointPart.nextSteps).toHaveLength(2);
    });
  });
  
  describe("SessionPart Union Type", () => {
    test("should allow all part types in union", () => {
      const parts: SessionPart[] = [
        { type: "text", content: "Hello" },
        { type: "tool-call", toolCallId: "c1", toolName: "t1", arguments: {}, state: "pending" },
        { type: "tool-result", toolCallId: "c1", toolName: "t1", output: "ok", state: "completed" },
        { type: "reasoning", content: "thinking" },
        { type: "file", mime: "text/plain", url: "file://test.txt" },
        { type: "checkpoint", checkpointId: "chk1", summary: "test" },
      ];
      
      expect(parts).toHaveLength(6);
    });
  });
});

// ============================================================================
// SessionMessage Structure Tests
// ============================================================================

describe("SessionMessage Structure", () => {
  test("should support parts array", () => {
    const message = createSessionMessage({
      role: "assistant",
      parts: [
        { type: "text", content: "Hello!" },
        { type: "reasoning", content: "Let me think...", reasoningType: "core" },
      ],
    });
    
    expect(message.parts).toBeDefined();
    expect(message.parts).toHaveLength(2);
    expect(message.parts![0].type).toBe("text");
    expect(message.parts![1].type).toBe("reasoning");
  });
  
  test("should support metadata", () => {
    const message = createSessionMessage({
      role: "assistant",
      metadata: {
        model: "gpt-4",
        isCheckpoint: true,
        checkpointId: "chk_123",
      },
    });
    
    expect(message.metadata).toBeDefined();
    expect(message.metadata?.model).toBe("gpt-4");
    expect(message.metadata?.isCheckpoint).toBe(true);
  });
  
  test("should support backward compatibility with content field", () => {
    const message = createSessionMessage({
      role: "user",
      content: "Simple text message",
    });
    
    expect(message.content).toBe("Simple text message");
    expect(message.parts).toBeUndefined();
  });
});

// ============================================================================
// Import tests (will be implemented in GREEN phase)
// ============================================================================

describe("toModelMessage", () => {
  test("should convert user message to ModelMessage", async () => {
    const { toModelMessage } = await import("./session-message-converter");
    
    const sessionMsg = createSessionMessage({
      role: "user",
      content: "Hello, AI!",
    });
    
    const modelMsg = toModelMessage(sessionMsg);
    
    expect(modelMsg.role).toBe("user");
    expect(modelMsg.content).toBe("Hello, AI!");
  });
  
  test("should convert assistant text message to ModelMessage", async () => {
    const { toModelMessage } = await import("./session-message-converter");
    
    const sessionMsg = createSessionMessage({
      role: "assistant",
      content: "Hello, human!",
      parts: [{ type: "text", content: "Hello, human!" }],
    });
    
    const modelMsg = toModelMessage(sessionMsg);
    
    expect(modelMsg.role).toBe("assistant");
    expect(modelMsg.content).toHaveLength(1);
    expect(modelMsg.content[0]).toEqual({ type: "text", text: "Hello, human!" });
  });
  
  test("should convert reasoning part to ModelMessage", async () => {
    const { toModelMessage } = await import("./session-message-converter");
    
    const sessionMsg = createSessionMessage({
      role: "assistant",
      parts: [
        { type: "reasoning", content: "Let me analyze this...", reasoningType: "core" },
        { type: "text", content: "Here's my answer." },
      ],
    });
    
    const modelMsg = toModelMessage(sessionMsg);
    
    expect(modelMsg.role).toBe("assistant");
    expect(modelMsg.content).toHaveLength(2);
    expect(modelMsg.content[0]).toMatchObject({ 
      type: "reasoning", 
      text: "Let me analyze this..." 
    });
  });
  
  test("should convert tool-call part to ModelMessage", async () => {
    const { toModelMessage } = await import("./session-message-converter");
    
    const sessionMsg = createSessionMessage({
      role: "assistant",
      parts: [
        { type: "text", content: "Searching..." },
        { 
          type: "tool-call", 
          toolCallId: "call_123", 
          toolName: "grep", 
          arguments: { pattern: "TODO" },
          state: "pending",
        },
      ],
    });
    
    const modelMsg = toModelMessage(sessionMsg);
    
    expect(modelMsg.content).toHaveLength(2);
    const toolCall = modelMsg.content.find(c => c.type === "tool-call");
    expect(toolCall).toMatchObject({
      type: "tool-call",
      toolCallId: "call_123",
      toolName: "grep",
      input: { pattern: "TODO" },
    });
  });
  
  test("should convert tool message to ModelMessage", async () => {
    const { toModelMessage } = await import("./session-message-converter");
    
    const sessionMsg = createSessionMessage({
      role: "tool",
      content: "Found 5 matches",
      parts: [
        {
          type: "tool-result",
          toolCallId: "call_123",
          toolName: "grep",
          output: "Found 5 matches",
          state: "completed",
        },
      ],
    });
    
    const modelMsg = toModelMessage(sessionMsg);
    
    expect(modelMsg.role).toBe("tool");
    expect(modelMsg.content).toHaveLength(1);
    expect(modelMsg.content[0]).toMatchObject({
      type: "tool-result",
      toolCallId: "call_123",
      toolName: "grep",
      output: "Found 5 matches",
    });
  });
  
  test("should convert file part in assistant message", async () => {
    const { toModelMessage } = await import("./session-message-converter");
    
    const sessionMsg = createSessionMessage({
      role: "assistant",
      parts: [
        { type: "text", content: "Here's the file" },
        { type: "file", mime: "image/png", url: "file:///tmp/image.png", filename: "screenshot.png" },
      ],
    });
    
    const modelMsg = toModelMessage(sessionMsg);
    
    expect(modelMsg.role).toBe("assistant");
    expect(Array.isArray(modelMsg.content)).toBe(true);
    const content = modelMsg.content as any[];
    const filePart = content.find(c => c.type === "file");
    expect(filePart).toBeDefined();
    expect(filePart.url).toBe("file:///tmp/image.png");
    expect(filePart.mimeType).toBe("image/png");
  });
  
  test("should skip checkpoint parts in assistant message", async () => {
    const { toModelMessage } = await import("./session-message-converter");
    
    const sessionMsg = createSessionMessage({
      role: "assistant",
      parts: [
        { type: "text", content: "Response after checkpoint" },
        { type: "checkpoint", checkpointId: "chk_123", summary: "Checkpoint summary" },
      ],
    });
    
    const modelMsg = toModelMessage(sessionMsg);
    
    expect(modelMsg.role).toBe("assistant");
    expect(Array.isArray(modelMsg.content)).toBe(true);
    const content = modelMsg.content as any[];
    // Checkpoint should be skipped
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
  });
});

describe("fromModelMessage", () => {
  test("should convert text ModelMessage to SessionMessage", async () => {
    const { fromModelMessage } = await import("./session-message-converter");
    
    const modelMsg = {
      role: "user" as const,
      content: "Hello!",
    };
    
    const sessionMsg = fromModelMessage(modelMsg);
    
    expect(sessionMsg.role).toBe("user");
    expect(sessionMsg.content).toBe("Hello!");
    expect(sessionMsg.parts).toEqual([{ type: "text", content: "Hello!" }]);
  });
  
  test("should convert assistant ModelMessage with multiple parts", async () => {
    const { fromModelMessage } = await import("./session-message-converter");
    
    const modelMsg = {
      role: "assistant" as const,
      content: [
        { type: "reasoning", text: "Thinking..." },
        { type: "text", text: "Here's my response." },
        { type: "tool-call", toolCallId: "c1", toolName: "bash", input: { cmd: "ls" } },
      ],
    };
    
    const sessionMsg = fromModelMessage(modelMsg);
    
    expect(sessionMsg.role).toBe("assistant");
    expect(sessionMsg.parts).toHaveLength(3);
    expect(sessionMsg.parts![0]).toMatchObject({ type: "reasoning", content: "Thinking..." });
    expect(sessionMsg.parts![1]).toMatchObject({ type: "text", content: "Here's my response." });
    expect(sessionMsg.parts![2]).toMatchObject({ 
      type: "tool-call", 
      toolCallId: "c1", 
      toolName: "bash",
      arguments: { cmd: "ls" },
    });
  });
  
  test("should convert tool-result ModelMessage to SessionMessage", async () => {
    const { fromModelMessage } = await import("./session-message-converter");
    
    const modelMsg = {
      role: "tool" as const,
      content: [
        {
          type: "tool-result" as const,
          toolCallId: "call_abc",
          toolName: "grep",
          output: "Match 1\nMatch 2",
        },
      ],
    };
    
    const sessionMsg = fromModelMessage(modelMsg);
    
    expect(sessionMsg.role).toBe("tool");
    expect(sessionMsg.parts![0]).toMatchObject({
      type: "tool-result",
      toolCallId: "call_abc",
      toolName: "grep",
      output: "Match 1\nMatch 2",
      state: "completed",
    });
    // tool messages should have metadata.type = "tool_result"
    expect(sessionMsg.metadata).toEqual({ type: "tool_result" });
  });
  
  test("should set metadata.type to tool_call for assistant messages with tool-call parts", async () => {
    const { fromModelMessage } = await import("./session-message-converter");
    
    const modelMsg = {
      role: "assistant" as const,
      content: [
        { type: "text", text: "I'll search for that." },
        { type: "tool-call", toolCallId: "c1", toolName: "search", input: { query: "test" } },
      ],
    };
    
    const sessionMsg = fromModelMessage(modelMsg);
    
    expect(sessionMsg.role).toBe("assistant");
    expect(sessionMsg.metadata).toEqual({ type: "tool_call" });
  });
  
  test("should not set metadata.type for assistant messages without tool-call parts", async () => {
    const { fromModelMessage } = await import("./session-message-converter");
    
    const modelMsg = {
      role: "assistant" as const,
      content: "Just a regular text response.",
    };
    
    const sessionMsg = fromModelMessage(modelMsg);
    
    expect(sessionMsg.role).toBe("assistant");
    expect(sessionMsg.metadata).toBeUndefined();
  });
  
  test("should set metadata.type to tool_result for tool messages", async () => {
    const { fromModelMessage } = await import("./session-message-converter");
    
    const modelMsg = {
      role: "tool" as const,
      content: [
        { type: "tool-result", toolCallId: "c1", toolName: "search", output: "result" },
      ],
    };
    
    const sessionMsg = fromModelMessage(modelMsg);
    
    expect(sessionMsg.metadata).toEqual({ type: "tool_result" });
  });
  
  test("should wrap string input from double-stringified tool-call arguments safely", async () => {
    const { fromModelMessage } = await import("./session-message-converter");
    
    // Simulate MiniMax-M3 double-stringify: input is a JSON string, not an object
    const modelMsg = {
      role: "assistant" as const,
      content: [
        {
          type: "tool-call" as const,
          toolCallId: "call_double_str",
          toolName: "task_operation_create",
          input: '{"task_id": 410, "action_type": "milestone", "action_type": "',// <-- string! not object
        },
      ],
    };
    
    const sessionMsg = fromModelMessage(modelMsg);
    
    expect(sessionMsg.role).toBe("assistant");
    expect(sessionMsg.parts).toHaveLength(1);
    
    const toolCallPart = sessionMsg.parts![0] as any;
    expect(toolCallPart.type).toBe("tool-call");
    // arguments should be an object, NOT a string
    expect(typeof toolCallPart.arguments).toBe("object");
    expect(toolCallPart.arguments).not.toBeNull();
    // Corrupted string should not leak _raw - returns empty object
    expect(toolCallPart.arguments).toEqual({});
    expect(toolCallPart.arguments).not.toHaveProperty("_raw");
  });
  
  test("toModelMessage should handle corrupted string arguments from legacy session data", async () => {
    const { toModelMessage } = await import("./session-message-converter");
    
    // Simulate legacy session data where arguments is a string (from before the fix)
    const sessionMsg: SessionMessage = {
      id: "msg_legacy",
      sessionID: "session_test",
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      parts: [
        {
          type: "tool-call",
          toolCallId: "call_legacy",
          toolName: "bash",
          arguments: '{"cmd": "ls"}', // JSON string, not parsed object
          state: "pending",
        } as any,
      ],
    };
    
    const modelMsg = toModelMessage(sessionMsg);
    
    expect(modelMsg.role).toBe("assistant");
    const content = modelMsg.content as any[];
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("tool-call");
    // input should be a parsed object, not a string or a _raw wrapper
    expect(typeof content[0].input).toBe("object");
    expect(content[0].input).not.toHaveProperty("_raw");
    expect(content[0].input).toEqual({ cmd: "ls" });
  });
});

describe("sessionToHistory", () => {
  test("should convert session messages to ModelMessage array", async () => {
    const { sessionToHistory } = await import("./session-message-converter");
    
    const messages: SessionMessage[] = [
      createSessionMessage({ role: "user", content: "Hello!" }),
      createSessionMessage({ 
        role: "assistant", 
        parts: [{ type: "text", content: "Hi there!" }] 
      }),
    ];
    
    const history = sessionToHistory(messages);
    
    expect(history).toHaveLength(2);
    expect(history[0].role).toBe("user");
    expect(history[1].role).toBe("assistant");
  });
  
  test("should filter out archived messages", async () => {
    const { sessionToHistory } = await import("./session-message-converter");
    
    const messages: SessionMessage[] = [
      createSessionMessage({ role: "user", content: "Message 1" }),
      createSessionMessage({ role: "user", content: "Message 2", isArchived: true }),
      createSessionMessage({ role: "user", content: "Message 3" }),
    ];
    
    const history = sessionToHistory(messages);
    
    expect(history).toHaveLength(2);
    expect(history[0].content).toBe("Message 1");
    expect(history[1].content).toBe("Message 3");
  });
});

describe("extractProviderOptions", () => {
  test("should extract reasoning options from reasoning parts", async () => {
    const { extractProviderOptions } = await import("./session-message-converter");
    
    const message = createSessionMessage({
      role: "assistant",
      parts: [
        { type: "reasoning", content: "Thinking...", reasoningType: "core" },
      ],
    });
    
    const options = extractProviderOptions(message);
    
    expect(options).toHaveProperty("openai");
    expect(options.openai).toHaveProperty("thinking");
  });
});

describe("migrateMessage", () => {
  test("should migrate old format message to new format", async () => {
    const { migrateMessage } = await import("./session-message-converter");
    
    // Old format: content is plain text, no parts
    const oldMsg = {
      id: "msg_old",
      sessionID: "session_test",
      role: "user" as const,
      content: "Hello, old world!",
      timestamp: Date.now(),
    };
    
    const migrated = migrateMessage(oldMsg);
    
    expect(migrated.content).toBe("Hello, old world!");
    expect(migrated.parts).toBeDefined();
    expect(migrated.parts).toHaveLength(1);
    expect(migrated.parts![0]).toEqual({ type: "text", content: "Hello, old world!" });
  });
  
  test("should keep new format message as is", async () => {
    const { migrateMessage } = await import("./session-message-converter");
    
    // New format: already has proper parts
    const newMsg = {
      id: "msg_new",
      sessionID: "session_test",
      role: "assistant" as const,
      content: "Hello!",
      timestamp: Date.now(),
      parts: [
        { type: "text", content: "Hello!" },
        { type: "reasoning", content: "Thinking...", reasoningType: "core" as const },
      ],
    };
    
    const migrated = migrateMessage(newMsg);
    
    expect(migrated.parts).toHaveLength(2);
    expect(migrated.parts![0].type).toBe("text");
    expect(migrated.parts![1].type).toBe("reasoning");
  });
  
  test("should migrate message with empty parts array", async () => {
    const { migrateMessage } = await import("./session-message-converter");
    
    // Old format with empty parts (malformed)
    const oldMsg = {
      id: "msg_empty_parts",
      sessionID: "session_test",
      role: "user" as const,
      content: "Content without parts field",
      timestamp: Date.now(),
      parts: [],
    };
    
    const migrated = migrateMessage(oldMsg);
    
    expect(migrated.content).toBe("Content without parts field");
    expect(migrated.parts).toHaveLength(1);
    expect(migrated.parts![0]).toEqual({ type: "text", content: "Content without parts field" });
  });
});

describe("Storage Integration", () => {
  test("SQLite storage should handle new part format", async () => {
    const { SQLiteSessionStore } = await import("./storage/sqlite");
    const { toModelMessage } = await import("./session-message-converter");
    
    const store = new SQLiteSessionStore(":memory:");
    
    // Create session
    const session = await store.create({ title: "Test Storage" });
    
    // Add message with new format parts
    await store.addMessage(session.id, {
      role: "user",
      content: "Test message",
      parts: [
        { type: "text", content: "Test message" },
      ],
    });
    
    // Add assistant message with reasoning
    await store.addMessage(session.id, {
      role: "assistant",
      content: "I'll help you!",
      parts: [
        { type: "reasoning", content: "Analyzing the request...", reasoningType: "core" },
        { type: "text", content: "I'll help you!" },
      ],
    });
    
    // Retrieve and verify
    const messages = await store.getMessages(session.id);
    
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].parts).toHaveLength(1);
    
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].parts).toHaveLength(2);
    expect(messages[1].parts![0].type).toBe("reasoning");
    expect(messages[1].parts![1].type).toBe("text");
    
    // Convert to ModelMessage
    const modelMsg = toModelMessage(messages[1]);
    expect(modelMsg.role).toBe("assistant");
    expect(modelMsg.content).toHaveLength(2);
    
    await store.close();
  });
  
  test("Memory storage should handle new part format", async () => {
    const { MemorySessionStore } = await import("./storage/memory");
    const { sessionToHistory } = await import("./session-message-converter");
    
    const store = new MemorySessionStore();
    
    // Create session
    const session = await store.create({ title: "Test Memory" });
    
    // Add user message
    await store.addMessage(session.id, {
      role: "user",
      content: "Find TODO comments",
    });
    
    // Add assistant message with tool call
    await store.addMessage(session.id, {
      role: "assistant",
      content: "Let me search...",
      parts: [
        { type: "text", content: "Let me search..." },
        { type: "tool-call", toolCallId: "call_1", toolName: "grep", arguments: { pattern: "TODO" }, state: "pending" as const },
      ],
    });
    
    await store.addMessage(session.id, {
      role: "tool",
      content: "Found 3 matches",
      parts: [
        { type: "tool-result", toolCallId: "call_1", toolName: "grep", output: "Found 3 matches", state: "completed" as const },
      ],
    });
    
    // Retrieve and convert to history
    const messages = await store.getMessages(session.id);
    const history = sessionToHistory(messages);
    
    expect(messages).toHaveLength(3);
    expect(history).toHaveLength(3);
    expect(history[1].role).toBe("assistant");
    expect(history[1].content).toHaveLength(2);
    
    const toolCall = history[1].content.find((c: any) => c.type === "tool-call");
    expect(toolCall).toBeDefined();
    expect(toolCall.toolCallId).toBe("call_1");
    expect(toolCall.toolName).toBe("grep");
  });
});

// ============================================================================
// Image Part Round-Trip Tests (RED Phase)
// 
// Bug: session-message-converter does NOT recognize `image` part type.
// Symptom: when a user message contains an image part (multimodal input),
// the image is silently dropped when stored to SessionMessage and rehydrated
// back to ModelMessage. This breaks multi-turn conversations that include images.
// 
// These 4 tests define the expected behavior:
//   1. fromModelMessage preserves image parts from LLM -> SessionMessage
//   2. toModelMessage rehydrates image parts from SessionMessage -> LLM
//   3. full round-trip preserves image data byte-for-byte (data: URL)
//   4. no more "Unknown part type: image" debug warnings
// ============================================================================

describe("SessionMessageConverter - image part round-trip", () => {
  const SAMPLE_PNG_DATA_URL =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

  test("fromModelMessage: user message with image part should preserve image", async () => {
    const { SessionMessageConverter } = await import("./session-message-converter");
    const converter = new SessionMessageConverter();

    const aiMsg = {
      role: "user" as const,
      content: [
        { type: "text", text: "看这张图" },
        { type: "image", image: SAMPLE_PNG_DATA_URL },
      ],
    };

    const sessionMsg = converter.fromModelMessage(aiMsg);

    expect(sessionMsg.parts).toBeDefined();
    const imagePart = sessionMsg.parts!.find((p) => p.type === "image") as any;
    expect(imagePart).toBeDefined();
    expect(imagePart.type).toBe("image");
    expect(imagePart.image).toBe(SAMPLE_PNG_DATA_URL);
  });

  test("toModelMessage: SessionMessage with image part should rehydrate", async () => {
    const { SessionMessageConverter } = await import("./session-message-converter");
    const converter = new SessionMessageConverter();

    const sessionMsg: SessionMessage = {
      id: "msg_img_1",
      sessionID: "session_test",
      role: "user",
      content: "看这张图",
      timestamp: Date.now(),
      parts: [
        { type: "text", content: "看这张图" },
        { type: "image", image: SAMPLE_PNG_DATA_URL } as any,
      ],
    };

    const aiMsg = converter.toModelMessage(sessionMsg);

    // Content must be an array (not a string) for multimodal user messages
    expect(Array.isArray(aiMsg.content)).toBe(true);
    const content = aiMsg.content as any[];
    const imagePart = content.find((c) => c.type === "image");
    expect(imagePart).toBeDefined();
    expect(imagePart.image).toBe(SAMPLE_PNG_DATA_URL);
  });

  test("round-trip: image data preserved through both directions", async () => {
    const { SessionMessageConverter } = await import("./session-message-converter");
    const converter = new SessionMessageConverter();

    const originalAiMsg = {
      role: "user" as const,
      content: [
        { type: "text", text: "描述这张图" },
        { type: "image", image: SAMPLE_PNG_DATA_URL },
      ],
    };

    // Round-trip 1: LLM -> SessionMessage
    const sessionMsg = converter.fromModelMessage(originalAiMsg);

    // Round-trip 2: SessionMessage -> LLM
    const rehydratedAiMsg = converter.toModelMessage(sessionMsg);

    // The rehydrated message must contain the same image data
    expect(Array.isArray(rehydratedAiMsg.content)).toBe(true);
    const content = rehydratedAiMsg.content as any[];
    const imagePart = content.find((c) => c.type === "image");
    expect(imagePart).toBeDefined();
    expect(imagePart.image).toBe(SAMPLE_PNG_DATA_URL);

    // The text part should also survive
    const textPart = content.find((c) => c.type === "text");
    expect(textPart).toBeDefined();
    expect(textPart.text).toBe("描述这张图");
  });

  test("does NOT log 'Unknown part type: image' warning", async () => {
    const { SessionMessageConverter } = await import("./session-message-converter");
    const converter = new SessionMessageConverter();

    const debugSpy = spyOn(console, "debug").mockImplementation(() => {});

    try {
      // Forward direction: LLM -> Session (this used to log "Unknown part type: image")
      converter.fromModelMessage({
        role: "user" as const,
        content: [{ type: "image", image: SAMPLE_PNG_DATA_URL }],
      });

      // Reverse direction: Session -> LLM (this used to log "Skipping unsupported part type in assistant: image")
      // Build a session message that contains an image part on an assistant role
      converter.toModelMessage({
        id: "msg_dbg",
        sessionID: "session_test",
        role: "assistant",
        content: "",
        timestamp: Date.now(),
        parts: [
          { type: "image", image: SAMPLE_PNG_DATA_URL } as any,
        ],
      });

      const calledForImage = debugSpy.mock.calls.some((c) =>
        String(c[0]).includes("Unknown part type: image")
      );
      const calledSkipping = debugSpy.mock.calls.some((c) =>
        String(c[0]).includes("Skipping unsupported part type in assistant: image")
      );

      expect(calledForImage).toBe(false);
      expect(calledSkipping).toBe(false);
    } finally {
      debugSpy.mockRestore();
    }
  });
});

// ============================================================================
// B1 Regression Tests: image Buffer round-trip through SQLite JSON
//
// Root cause: `JSON.stringify(Buffer)` serializes to `{type:"Buffer", data:[byte1,...]}`.
// On reload, `JSON.parse` produces a plain object, NOT a `Uint8Array`.
// AI SDK v6 `userModelMessageSchema` only accepts
//   `image: string | URL | DataContent | Uint8Array`
// so the plain object fails validation → `InvalidPromptError`.
//
// These 4 tests pin the fix:
//   1. fromModelMessage: Buffer image → data URL (so storage is clean)
//   2. toModelMessage: legacy `{type:Buffer, data:[]}` → Uint8Array (backward compat)
//   3. full round-trip through JSON.stringify/parse → image bytes preserved
//   4. reloaded multimodal message has no plain `{type:Buffer}` object
//
// See `.roy/code-review/review-final-merge-readiness.md` Blocker B1.
// ============================================================================

describe("B1 regression: image Buffer round-trip through SQLite", () => {
  const SAMPLE_JPEG = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
    0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);

  test("fromModelMessage: Buffer image is serialized to a base64 data URL", async () => {
    const { SessionMessageConverter } = await import("./session-message-converter");
    const converter = new SessionMessageConverter();

    // Simulates what `parseImageInput` returns for a local file path.
    const aiMsg = {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "对比这两张图" },
        { type: "image" as const, image: SAMPLE_JPEG, mimeType: "image/jpeg" },
      ],
    };

    const sessionMsg = converter.fromModelMessage(aiMsg);

    const imagePart = sessionMsg.parts!.find(
      (p) => p.type === "image"
    ) as ImagePart;
    expect(imagePart).toBeDefined();
    // After fix: the part's `image` field must be a string (data URL) so that
    // a subsequent `JSON.stringify` produces a JSON-safe value, not a Buffer
    // (which serializes to `{type:"Buffer", data:[...]}`, breaking AI SDK v6).
    expect(typeof imagePart.image).toBe("string");
    expect(imagePart.image).toMatch(/^data:image\/jpeg;base64,/);

    // Sanity: data URL decodes back to the original bytes
    const base64 = (imagePart.image as string).split(",")[1];
    expect(Buffer.from(base64, "base64").equals(SAMPLE_JPEG)).toBe(true);

    // And the JSON.stringify of the whole message is clean (no nested
    // `{type:"Buffer"}` artifact for the image field).
    const json = JSON.parse(JSON.stringify(sessionMsg));
    const persistedImage = json.parts.find((p: any) => p.type === "image");
    expect(persistedImage.image).toBe(imagePart.image);
  });

  test("toModelMessage: legacy {type:Buffer, data:[]} image is converted to Uint8Array", async () => {
    const { SessionMessageConverter } = await import("./session-message-converter");
    const converter = new SessionMessageConverter();

    // Simulate what `JSON.parse` produces from an old SQLite row that was
    // written before this fix (i.e. before storage switched to data URL).
    const legacyBytes = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
    const legacySessionMsg: SessionMessage = {
      id: "msg_legacy_1",
      sessionID: "session_legacy",
      role: "user",
      content: "看图",
      timestamp: 0,
      parts: [
        { type: "text", content: "看图" } as TextPart,
        {
          type: "image",
          // ← this is the bug shape: plain object, NOT Uint8Array
          image: { type: "Buffer", data: legacyBytes } as any,
          mimeType: "image/jpeg",
        } as any,
      ],
    };

    const modelMsg = converter.toModelMessage(legacySessionMsg);

    expect(Array.isArray(modelMsg.content)).toBe(true);
    const content = modelMsg.content as any[];
    const imagePart = content.find((c) => c.type === "image");
    expect(imagePart).toBeDefined();

    // After fix: image must be a legal type for AI SDK v6
    // (string | URL | Uint8Array) — NOT a plain object.
    expect(["string", "object"]).toContain(typeof imagePart.image);
    if (typeof imagePart.image === "object") {
      // Must be a real typed array, not the plain Buffer-serialized shape
      expect(imagePart.image).toBeInstanceOf(Uint8Array);
      expect(Array.from(imagePart.image as Uint8Array)).toEqual(legacyBytes);
    } else {
      // If we chose to convert to data URL instead, decode and check
      const base64 = (imagePart.image as string).split(",")[1];
      expect(Buffer.from(base64, "base64")).toEqual(Buffer.from(legacyBytes));
    }
  });

  test("full round-trip: fromModelMessage → JSON → toModelMessage preserves image bytes", async () => {
    const { SessionMessageConverter } = await import("./session-message-converter");
    const converter = new SessionMessageConverter();

    // Start with a Buffer (the production path: `parseImageInput` returns Buffer)
    const aiMsg = {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "描述这张图" },
        { type: "image" as const, image: SAMPLE_JPEG, mimeType: "image/jpeg" },
      ],
    };

    // Round-trip 1: AI SDK → Session (Buffer → must be converted to data URL)
    const sessionMsg = converter.fromModelMessage(aiMsg);

    // Round-trip 2: simulate SQLite persistence (JSON.stringify → JSON.parse)
    const persistedJson = JSON.parse(JSON.stringify(sessionMsg));
    const rehydratedSessionMsg: SessionMessage = {
      ...sessionMsg,
      parts: persistedJson.parts as SessionPart[],
    };

    // Round-trip 3: Session → AI SDK (must still produce a valid image field)
    const rehydratedAiMsg = converter.toModelMessage(rehydratedSessionMsg);

    expect(Array.isArray(rehydratedAiMsg.content)).toBe(true);
    const content = rehydratedAiMsg.content as any[];
    const imagePart = content.find((c) => c.type === "image");
    expect(imagePart).toBeDefined();

    // The image survives the full round-trip. Bytes must round-trip exactly
    // (whether we chose to keep it as data URL string or convert to Uint8Array).
    if (typeof imagePart.image === "string") {
      const base64 = imagePart.image.split(",")[1];
      expect(Buffer.from(base64, "base64").equals(SAMPLE_JPEG)).toBe(true);
    } else {
      expect(imagePart.image).toBeInstanceOf(Uint8Array);
      expect(Buffer.from(imagePart.image as Uint8Array).equals(SAMPLE_JPEG)).toBe(true);
    }
  });

  test("does NOT leave a plain {type:Buffer} object on reloaded multimodal message", async () => {
    const { SessionMessageConverter } = await import("./session-message-converter");
    const converter = new SessionMessageConverter();

    // Mirror the exact production scenario: a multimodal user message loaded
    // from a DB row whose `parts` JSON has the legacy Buffer shape.
    const legacyBytes = [255, 216, 255, 225, 0, 16, 74, 70, 73, 70];
    const reloadedSessionMsg: SessionMessage = {
      id: "msg_reload_1",
      sessionID: "session_reload",
      role: "user",
      content: "对比这两张图有什么不同",
      timestamp: 0,
      parts: [
        { type: "text", content: "对比这两张图有什么不同" } as TextPart,
        {
          type: "image",
          image: { type: "Buffer", data: legacyBytes } as any,
          mimeType: "image/jpeg",
        } as any,
      ],
    };

    // The bug: this would silently return a plain object that AI SDK rejects
    // at the network boundary with
    // `InvalidPromptError: ... do not match the ModelMessage[] schema`.
    let modelMsg: any;
    expect(() => {
      modelMsg = converter.toModelMessage(reloadedSessionMsg);
    }).not.toThrow();

    const imagePart = (modelMsg.content as any[]).find(
      (c) => c.type === "image"
    );
    // Must NOT be the legacy plain object shape — AI SDK v6 rejects that.
    const looksLikeLegacy = (v: any) =>
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      !(v instanceof Uint8Array) &&
      !(v instanceof URL) &&
      (v as any).type === "Buffer" &&
      Array.isArray((v as any).data);

    expect(looksLikeLegacy(imagePart.image)).toBe(false);
  });
});

// ============================================================
// I3 (review-cache-stability.md Important 3):
// normalizeImagePayload Uint8Array branch must convert to base64 data
// URL — same as the Buffer branch — to keep the persisted image JSON-safe
// (otherwise JSON.stringify of a raw Uint8Array produces
// {0:1,1:2,...} which breaks AI SDK v6's userModelMessageSchema on
// reload from non-Node runtimes / SQLite).
// ============================================================

describe("I3: normalizeImagePayload Uint8Array branch converts to data URL", () => {
  test("Uint8Array input → base64 data URL (mirror of Buffer behavior)", async () => {
    const { SessionMessageConverter } = await import("./session-message-converter");
    const converter = new SessionMessageConverter();

    // Construct a non-Buffer Uint8Array (simulates a future runtime that
    // hands us typed-array bytes directly, e.g. Bun's native Uint8Array,
    // browser FileReader result, or Deno).
    const u8 = new Uint8Array([1, 2, 3]);
    const aiMsg = {
      role: "user" as const,
      content: [{ type: "image" as const, image: u8, mimeType: "image/png" }],
    };

    const sessionMsg = converter.fromModelMessage(aiMsg);
    const imagePart = (sessionMsg.parts ?? []).find((p: any) => p.type === "image") as any;
    expect(imagePart).toBeDefined();

    // I3: must be a data URL string, NOT a Uint8Array passthrough.
    expect(typeof imagePart.image).toBe("string");
    expect(imagePart.image).toBe("data:image/png;base64,AQID");
  });

  test("Uint8Array → data URL round-trip preserves bytes byte-for-byte", async () => {
    const { SessionMessageConverter } = await import("./session-message-converter");
    const converter = new SessionMessageConverter();

    const original = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    const aiMsg = {
      role: "user" as const,
      content: [{ type: "image" as const, image: original, mimeType: "image/png" }],
    };

    // fromModelMessage: Uint8Array → string (data URL) in session storage
    const sessionMsg = converter.fromModelMessage(aiMsg);
    const sessionImage = (sessionMsg.parts ?? []).find((p: any) => p.type === "image") as any;
    expect(typeof sessionImage.image).toBe("string");
    expect(sessionImage.image).toMatch(/^data:image\/png;base64,/);

    // Decode and confirm bytes match
    const base64 = (sessionImage.image as string).split(",")[1];
    const decoded = Buffer.from(base64, "base64");
    expect(decoded).toEqual(Buffer.from(original));
  });

  test("Uint8Array path makes the persisted SessionMessage JSON-safe (no {0:1,1:2,...})", async () => {
    const { SessionMessageConverter } = await import("./session-message-converter");
    const converter = new SessionMessageConverter();

    const u8 = new Uint8Array([1, 2, 3, 4, 5]);
    const aiMsg = {
      role: "user" as const,
      content: [{ type: "image" as const, image: u8, mimeType: "image/jpeg" }],
    };

    const sessionMsg = converter.fromModelMessage(aiMsg);
    const json = JSON.parse(JSON.stringify(sessionMsg));
    const persistedImage = json.parts.find((p: any) => p.type === "image");

    // I3 contract: image must be a string (data URL), not an object.
    // Otherwise non-Node runtimes that reload this row will feed an
    // {0:1,1:2,...} shape to AI SDK's userModelMessageSchema and trigger
    // InvalidPromptError.
    expect(typeof persistedImage.image).toBe("string");
    expect(persistedImage.image).toMatch(/^data:image\/jpeg;base64,/);
  });

  test("Uint8Array without mimeType falls back to image/jpeg (mirror of Buffer path)", async () => {
    const { SessionMessageConverter } = await import("./session-message-converter");
    const converter = new SessionMessageConverter();

    const u8 = new Uint8Array([255, 216, 255]); // JPEG magic bytes
    const aiMsg = {
      role: "user" as const,
      content: [{ type: "image" as const, image: u8 }], // no mimeType
    };

    const sessionMsg = converter.fromModelMessage(aiMsg);
    const imagePart = (sessionMsg.parts ?? []).find((p: any) => p.type === "image") as any;
    expect(typeof imagePart.image).toBe("string");
    expect(imagePart.image).toMatch(/^data:image\/jpeg;base64,/);
  });
});
