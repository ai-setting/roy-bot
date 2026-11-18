/**
 * @fileoverview AgentComponent persistSession Tests (TDD)
 *
 * 测试 AgentComponent.run() 的 persistSession 参数行为：
 * 1. persistSession: false → 不调用 recordSessionMessages（不写入 session DB）
 * 2. persistSession: true（默认）→ 正常调用 recordSessionMessages
 * 3. persistSession: false → 仍然加载 session history（读取逻辑不变）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentComponent } from "./agent-component";
import type { AgentContext } from "./types";
import type { Environment } from "../interface";
import { ConfigComponent } from "../../config/config-component";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

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
    // recordSessionMessages now uses addMessages(batch) instead of N×addMessage calls.
    // Mirror the same storage behavior so persistence-flag assertions still work.
    addMessages: vi.fn(async (sessionId: string, msgs: any[]) => {
      const sessionMessages = messages.get(sessionId) ?? [];
      const ids: string[] = [];
      for (const msg of msgs) {
        const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        sessionMessages.push({
          id,
          sessionID: sessionId,
          role: msg.role,
          content: msg.content,
          timestamp: Date.now(),
          parts: msg.parts,
          metadata: msg.metadata,
        });
        ids.push(id);
      }
      messages.set(sessionId, sessionMessages);
      return ids;
    }),
    getMessages: vi.fn(async (sessionId: string) => messages.get(sessionId) ?? []),
    getMessageCount: vi.fn(async (sessionId: string) => messages.get(sessionId)?.length ?? 0),
    getContext: vi.fn(async (sessionId: string) => ({
      messages: messages.get(sessionId) ?? [],
      checkpoint: undefined,
    })),
  };
  return mock;
}

function createMockLLMComponent() {
  return {
    invoke: vi.fn(() =>
      Promise.resolve({
        output: {
          content: "test response",
          toolCalls: [],
        },
      })
    ),
  };
}

function createMockEnv(
  sessionComponent: any,
  configComponent: ConfigComponent,
  llmComponent: any
): Environment {
  return {
    name: "test-env",
    version: "1.0.0",
    getConfig: vi.fn(() => ({ name: "test-env", version: "1.0.0", enabled: true })),
    registerComponent: vi.fn(),
    unregisterComponent: vi.fn(),
    getComponent: vi.fn((name: string) => {
      if (name === "session") return sessionComponent;
      if (name === "config") return configComponent;
      if (name === "llm") return llmComponent;
      return undefined;
    }),
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

describe("AgentComponent persistSession", () => {
  let agentComponent: AgentComponent;
  let mockEnv: Environment;
  let configComponent: ConfigComponent;
  let sessionComponent: any;
  let llmComponent: any;
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();

    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-persist-test-"));
    configComponent = new ConfigComponent();
    configComponent.setXdgDataHome(tempDir);
    await configComponent.set("agent.configDir", path.join(tempDir, "agents"));
    fsSync.mkdirSync(path.join(tempDir, "agents"), { recursive: true });

    sessionComponent = createMockSessionComponent();
    llmComponent = createMockLLMComponent();
    mockEnv = createMockEnv(sessionComponent, configComponent, llmComponent);

    agentComponent = new AgentComponent();
    await agentComponent.init({ env: mockEnv, options: { configComponent } } as any);

    agentComponent.registerAgent("test-agent", {
      type: "primary",
      systemPrompt: "You are a helpful assistant.",
      maxIterations: 3,
    });
  });

  afterEach(() => {
    try {
      fsSync.rmSync(tempDir, { recursive: true });
    } catch {}
  });

  describe("persistSession: false — 不持久化新消息到 session DB", () => {
    it("persistSession: false → 不调用 sessionComponent.addMessage", async () => {
      const result = await agentComponent.run("test-agent", "hello", {
        sessionId: "sess-no-persist",
        persistSession: false,
      } as AgentContext);

      expect(result).toBeDefined();
      expect(result.iterations).toBeGreaterThanOrEqual(1);

      // addMessages 不应被调用（不写入 session DB）
      expect(sessionComponent.addMessages).not.toHaveBeenCalled();
    });

    it("persistSession: false → 仍然从 session history 读取消息", async () => {
      // 预填充 session history
      await sessionComponent.addMessage("sess-history", {
        role: "user",
        content: "previous query",
      });
      await sessionComponent.addMessage("sess-history", {
        role: "assistant",
        content: "previous response",
      });

      // 使用 persistSession: false 运行 agent
      const result = await agentComponent.run("test-agent", "new query", {
        sessionId: "sess-history",
        persistSession: false,
      } as AgentContext);

      expect(result).toBeDefined();

      // getContext 应该被调用（读取 history）
      // 注意：agent-component 内部使用 getConversationHistory，它会调用 sessionComponent.getContext
      expect(sessionComponent.getContext).toHaveBeenCalled();
    });
  });

  describe("persistSession: true（默认）— 正常持久化", () => {
    it("不传 persistSession → 默认行为：调用 sessionComponent.addMessages", async () => {
      const result = await agentComponent.run("test-agent", "hello", {
        sessionId: "sess-default",
      } as AgentContext);

      expect(result).toBeDefined();

      // addMessages 应该被调用（正常持久化）
      expect(sessionComponent.addMessages).toHaveBeenCalled();
    });

    it("persistSession: true → 调用 sessionComponent.addMessages", async () => {
      const result = await agentComponent.run("test-agent", "hello", {
        sessionId: "sess-explicit-true",
        persistSession: true,
      } as AgentContext);

      expect(result).toBeDefined();

      // addMessages 应该被调用
      expect(sessionComponent.addMessages).toHaveBeenCalled();
    });
  });

  describe("persistSession 向后兼容性", () => {
    it("不传 sessionId → 不调用 addMessage（与现有行为一致）", async () => {
      const result = await agentComponent.run("test-agent", "hello");

      expect(result).toBeDefined();
      // 没有 sessionId，recordSessionMessages 会直接 return
      expect(sessionComponent.addMessages).not.toHaveBeenCalled();
    });
  });
});
