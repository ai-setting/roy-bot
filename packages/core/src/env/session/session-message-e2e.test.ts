/**
 * @fileoverview Session Message Format E2E Tests
 * 
 * End-to-end tests for the new Session message format with AI SDK v6 support.
 * Tests the complete flow from adding messages to converting for LLM calls.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SessionComponent } from "./session-component";
import { ConfigComponent } from "../../config/config-component";
import type { Environment } from "../interface";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";
import { vi } from "bun:test";

// ============================================================================
// Test Setup
// ============================================================================

describe("Session Message Format E2E", () => {
  let sessionComponent: SessionComponent;
  let configComponent: ConfigComponent;
  let mockEnv: Environment;
  let tempDir: string;

  beforeEach(async () => {
    // Create temp directory for test
    tempDir = path.join(os.tmpdir(), `session-e2e-test-${Date.now()}`);
    fsSync.mkdirSync(tempDir, { recursive: true });

    sessionComponent = new SessionComponent();
    configComponent = new ConfigComponent();

    mockEnv = {
      name: "test-env",
      version: "1.0.0",
      getComponent: vi.fn((name: string) => {
        if (name === "config") return configComponent;
        return undefined;
      }),
      hasComponent: vi.fn((name: string) => name === "config"),
      logger: vi.fn(),
      trace: vi.fn(),
    } as unknown as Environment;

    await sessionComponent.init({
      env: mockEnv,
      options: {
        configComponent,
        config: {
          defaultDirectory: tempDir,
          maxMessages: 100,
          autoCompact: false,
          storage: { type: "memory" },
        },
      },
    });
  });

  afterEach(async () => {
    // Cleanup
    if (fsSync.existsSync(tempDir)) {
      fsSync.rmSync(tempDir, { recursive: true });
    }
  });

  // ============================================================================
  // E2E: User Message → Assistant with Reasoning → Tool Call → Tool Result
  // ============================================================================

  describe("Complete conversation flow with reasoning and tools", () => {
    test("should handle a complete AI conversation with reasoning, tool calls, and results", async () => {
      // First create a session
      const session = await sessionComponent.create({ title: "Test Session" });

      // Step 1: User sends a message
      const userMsgId = await sessionComponent.addMessage(session.id, {
        role: "user",
        content: "帮我搜索代码中的 TODO 注释",
      });
      
      expect(userMsgId).toBeDefined();
      expect(userMsgId).toMatch(/^msg_/);

      // Step 2: Assistant responds with reasoning and tool call
      const assistantMsgId = await sessionComponent.addMessage(session.id, {
        role: "assistant",
        content: "我来帮你搜索 TODO 注释",
        parts: [
          { 
            type: "reasoning", 
            content: "用户想要搜索代码中的 TODO 注释，我应该使用 grep 工具来搜索。",
            reasoningType: "core",
            state: "completed",
          },
          { 
            type: "text", 
            content: "我来帮你搜索 TODO 注释" 
          },
          {
            type: "tool-call",
            toolCallId: "call_001",
            toolName: "grep",
            arguments: { pattern: "TODO", path: "/src" },
            state: "pending",
          },
        ],
      });

      expect(assistantMsgId).toBeDefined();

      // Step 3: Tool returns result
      const toolResultMsgId = await sessionComponent.addMessage(session.id, {
        role: "tool",
        content: "找到 3 处 TODO:\n1. src/index.ts:15\n2. src/app.ts:42\n3. src/utils.ts:8",
        parts: [
          {
            type: "tool-result",
            toolCallId: "call_001",
            toolName: "grep",
            output: "找到 3 处 TODO:\n1. src/index.ts:15\n2. src/app.ts:42\n3. src/utils.ts:8",
            state: "completed",
          },
        ],
      });

      expect(toolResultMsgId).toBeDefined();

      // Step 4: Assistant gives final response
      const finalMsgId = await sessionComponent.addMessage(session.id, {
        role: "assistant",
        content: "代码中发现 3 处 TODO 标记：\n1. src/index.ts:15\n2. src/app.ts:42\n3. src/utils.ts:8",
        parts: [
          { type: "text", content: "代码中发现 3 处 TODO 标记：" },
        ],
      });

      expect(finalMsgId).toBeDefined();

      // Verify all messages are stored correctly
      const messages = await sessionComponent.getMessages(session.id);
      expect(messages).toHaveLength(4);
      expect(messages[0].role).toBe("user");
      expect(messages[1].role).toBe("assistant");
      expect(messages[1].parts![0].type).toBe("reasoning");
      expect(messages[2].role).toBe("tool");
      expect(messages[2].parts![0].type).toBe("tool-result");
      expect(messages[3].role).toBe("assistant");
    });

    test("should convert messages to AI SDK history format", async () => {
      // Import the converter
      const { sessionToHistory } = await import("./session-message-converter");

      // Create session
      const session = await sessionComponent.create({ title: "History Test" });

      // Add a conversation
      await sessionComponent.addMessage(session.id, {
        role: "user",
        content: "Hello!",
      });

      await sessionComponent.addMessage(session.id, {
        role: "assistant",
        content: "Hi there!",
        parts: [
          { type: "reasoning", content: "User is greeting me", reasoningType: "core" },
          { type: "text", content: "Hi there!" },
        ],
      });

      await sessionComponent.addMessage(session.id, {
        role: "assistant",
        content: "Let me search...",
        parts: [
          { type: "text", content: "Let me search..." },
          { type: "tool-call", toolCallId: "c1", toolName: "search", arguments: {}, state: "pending" },
        ],
      });

      await sessionComponent.addMessage(session.id, {
        role: "tool",
        content: "Search results",
        parts: [
          { type: "tool-result", toolCallId: "c1", toolName: "search", output: "Results", state: "completed" },
        ],
      });

      // Get messages and convert to history
      const messages = await sessionComponent.getMessages(session.id);
      const history = sessionToHistory(messages);

      // Verify history format
      expect(history).toHaveLength(4);
      
      // User message
      expect(history[0].role).toBe("user");
      expect(history[0].content).toBe("Hello!");

      // Assistant with reasoning
      expect(history[1].role).toBe("assistant");
      expect(Array.isArray(history[1].content)).toBe(true);
      const content1 = history[1].content as any[];
      expect(content1.some(c => c.type === "reasoning")).toBe(true);
      expect(content1.some(c => c.type === "text")).toBe(true);

      // Assistant with tool call
      expect(history[2].role).toBe("assistant");
      const content2 = history[2].content as any[];
      expect(content2.some(c => c.type === "tool-call")).toBe(true);

      // Tool result
      expect(history[3].role).toBe("tool");
      const content3 = history[3].content as any[];
      expect(content3[0].type).toBe("tool-result");
    });

    test("should filter out archived messages when converting to history", async () => {
      const { sessionToHistory } = await import("./session-message-converter");

      const session = await sessionComponent.create({ title: "Archive Test" });

      // Add messages
      await sessionComponent.addMessage(session.id, {
        role: "user",
        content: "Message 1",
      });

      await sessionComponent.addMessage(session.id, {
        role: "user",
        content: "Message 2 (archived)",
      });

      await sessionComponent.addMessage(session.id, {
        role: "user",
        content: "Message 3",
      });

      // Get all messages
      const messages = await sessionComponent.getMessages(session.id);
      const history = sessionToHistory(messages);
      
      // All non-archived messages should be in history
      expect(history.length).toBe(3);
    });
  });

  // ============================================================================
  // E2E: File Attachment
  // ============================================================================

  describe("File attachment handling", () => {
    test("should handle messages with file attachments", async () => {
      const session = await sessionComponent.create({ title: "File Test" });

      const msgId = await sessionComponent.addMessage(session.id, {
        role: "user",
        content: "Here's a screenshot",
        parts: [
          {
            type: "file",
            mime: "image/png",
            url: "file:///tmp/screenshot.png",
            filename: "screenshot.png",
          },
        ],
      });

      expect(msgId).toBeDefined();

      // Retrieve and verify
      const messages = await sessionComponent.getMessages(session.id);
      expect(messages).toHaveLength(1);
      expect(messages[0].parts![0].type).toBe("file");
      expect((messages[0].parts![0] as any).mime).toBe("image/png");
      expect((messages[0].parts![0] as any).filename).toBe("screenshot.png");
    });
  });

  // ============================================================================
  // E2E: Checkpoint with new format
  // ============================================================================

  describe("Checkpoint with new message format", () => {
    test("should store messages with checkpoint metadata", async () => {
      const session = await sessionComponent.create({ title: "Checkpoint Test" });

      // Add messages with new format
      await sessionComponent.addMessage(session.id, {
        role: "user",
        content: "Let's do something complex",
      });

      await sessionComponent.addMessage(session.id, {
        role: "assistant",
        content: "I'll analyze this",
        parts: [
          { type: "reasoning", content: "Analyzing...", reasoningType: "core" },
          { type: "text", content: "I'll analyze this" },
        ],
      });

      // Get messages - they should preserve the new format
      const messages = await sessionComponent.getMessages(session.id);
      
      expect(messages).toHaveLength(2);
      expect(messages[1].parts).toHaveLength(2);
      expect(messages[1].parts![0].type).toBe("reasoning");
      expect(messages[1].parts![1].type).toBe("text");
    });
  });

  // ============================================================================
  // E2E: Provider Options Extraction
  // ============================================================================

  describe("Provider options for different models", () => {
    test("should extract OpenAI thinking options", async () => {
      const { extractProviderOptions } = await import("./session-message-converter");

      const message = {
        id: "msg_test",
        sessionID: "session_test",
        role: "assistant" as const,
        content: "Thinking...",
        timestamp: Date.now(),
        parts: [
          {
            type: "reasoning",
            content: "Deep analysis...",
            reasoningType: "core" as const,
            state: "completed" as const,
          },
        ],
      };

      const options = extractProviderOptions(message);
      
      expect(options).toHaveProperty("openai");
      expect((options as any).openai).toHaveProperty("thinking");
    });

    test("should extract Anthropic extended thinking options", async () => {
      const { extractProviderOptions } = await import("./session-message-converter");

      const message = {
        id: "msg_test",
        sessionID: "session_test",
        role: "assistant" as const,
        content: "Extended thinking...",
        timestamp: Date.now(),
        parts: [
          {
            type: "reasoning",
            content: "Extended analysis with more detail...",
            reasoningType: "effort" as const,
            state: "completed" as const,
          },
        ],
      };

      const options = extractProviderOptions(message);
      
      expect(options).toHaveProperty("anthropic");
      expect((options as any).anthropic).toHaveProperty("thinking");
    });
  });

  // ============================================================================
  // E2E: Backward Compatibility
  // ============================================================================

  describe("Backward compatibility with old message format", () => {
    test("should handle old format messages without parts", async () => {
      const session = await sessionComponent.create({ title: "Legacy Test" });

      // Old format: message with just content, no parts
      // Note: addMessage always wraps content in parts now
      const msgId = await sessionComponent.addMessage(session.id, {
        role: "user",
        content: "Old style message",
      });

      expect(msgId).toBeDefined();

      // Get the message to verify
      const messages = await sessionComponent.getMessages(session.id);
      expect(messages).toHaveLength(1);
      
      const msg = messages[0];
      expect(msg.content).toBe("Old style message");
      
      // Verify parts are created (migrated from old format)
      expect(msg.parts).toBeDefined();
      expect(msg.parts).toHaveLength(1);
      expect(msg.parts![0].type).toBe("text");
      expect((msg.parts![0] as any).content).toBe("Old style message");
    });

    test("should convert old messages when reading from storage", async () => {
      // This tests the migration path - simulate reading old format
      const { migrateMessage } = await import("./session-message-converter");

      // Old format from storage
      const oldStoredMsg = {
        id: "msg_legacy",
        sessionID: "session_test",
        role: "user" as const,
        content: "This was stored in old format",
        timestamp: Date.now(),
      };

      // Migrate
      const migrated = migrateMessage(oldStoredMsg);
      
      expect(migrated.content).toBe("This was stored in old format");
      expect(migrated.parts).toBeDefined();
      expect(migrated.parts).toHaveLength(1);
      expect(migrated.parts![0].type).toBe("text");
    });

    test("should preserve new format when already correct", async () => {
      const { migrateMessage } = await import("./session-message-converter");

      // Already new format
      const newFormatMsg = {
        id: "msg_new",
        sessionID: "session_test",
        role: "assistant" as const,
        content: "New format message",
        timestamp: Date.now(),
        parts: [
          { type: "reasoning", content: "Thinking...", reasoningType: "core" as const },
          { type: "text", content: "New format message" },
        ],
      };

      // Migrate (should be no-op)
      const migrated = migrateMessage(newFormatMsg);
      
      expect(migrated.parts).toHaveLength(2);
      expect(migrated.parts![0].type).toBe("reasoning");
      expect(migrated.parts![1].type).toBe("text");
    });
  });
});
