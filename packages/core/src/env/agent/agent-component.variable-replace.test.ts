/**
 * @fileoverview AgentComponent Variable Replacement Tests (TDD RED)
 *
 * 测试 agentComponent.run() 中 _run() 方法对 {{workspace_dir}} 和 {{memory}}
 * 变量的替换行为。
 *
 * 背景：
 * - environment.ts handle_query 已有变量注入逻辑，但 agentComponent.run() 直接
 *   启动 agent 时绕过 handle_query，所以 _run() 中需要独立处理变量替换。
 * - 这些替换确保通过 agentComponent.run() 启动的 agent（如 task-agent）也能正确
 *   解析 prompt 中的占位符。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentComponent } from "./agent-component";
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
  return {
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
    getMessages: vi.fn(async (sessionId: string) => messages.get(sessionId) ?? []),
    getMessageCount: vi.fn(async (sessionId: string) => messages.get(sessionId)?.length ?? 0),
    getContext: vi.fn(async (sessionId: string) => ({
      messages: messages.get(sessionId) ?? [],
      checkpoint: undefined,
    })),
  };
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

function createMockMemoryComponent(recallResult?: string) {
  return {
    recallMemory: vi.fn(async () => recallResult ?? "Project summary: test project\nKey files: src/index.ts"),
  };
}

function createMockEnv(
  sessionComponent: any,
  configComponent: ConfigComponent,
  llmComponent: any,
  memoryComponent?: any
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
      if (name === "memory") return memoryComponent;
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

describe("AgentComponent _run() — {{workspace_dir}} 和 {{memory}} 变量替换", () => {
  let agentComponent: AgentComponent;
  let mockEnv: Environment;
  let configComponent: ConfigComponent;
  let sessionComponent: any;
  let llmComponent: any;
  let memoryComponent: any;
  let tempDir: string;
  const testWorkspaceDir = "/home/test/workspace";

  beforeEach(async () => {
    vi.clearAllMocks();

    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-variable-replace-test-"));
    configComponent = new ConfigComponent();
    configComponent.setXdgDataHome(tempDir);
    await configComponent.set("agent.configDir", path.join(tempDir, "agents"));
    await configComponent.set("workspace_dir", testWorkspaceDir);
    fsSync.mkdirSync(path.join(tempDir, "agents"), { recursive: true });

    sessionComponent = createMockSessionComponent();
    llmComponent = createMockLLMComponent();
    memoryComponent = createMockMemoryComponent();
    mockEnv = createMockEnv(sessionComponent, configComponent, llmComponent, memoryComponent);

    agentComponent = new AgentComponent();
    await agentComponent.init({ env: mockEnv, options: { configComponent } } as any);
  });

  afterEach(() => {
    try {
      fsSync.rmSync(tempDir, { recursive: true });
    } catch {}
  });

  /**
   * Helper: 从 LLM 调用中提取注入的 system prompt 内容。
   * P1-1 修复（Task #1580）后，agent.config.systemPrompt 不再被原地修改，
   * 解析后的 systemPrompt 通过 hookCtx → buildMessages → messages[0] 传递给 LLM。
   */
  function getLLMSystemPrompt(llm: any): string {
    if (!llm.invoke.mock || !llm.invoke.mock.calls.length) return "";
    const lastCall = llm.invoke.mock.calls[llm.invoke.mock.calls.length - 1][0];
    const messages = lastCall?.messages || [];
    const systemMsg = messages.find((m: any) => m.role === "system");
    if (!systemMsg) return "";
    if (typeof systemMsg.content === "string") return systemMsg.content;
    if (Array.isArray(systemMsg.content))
      return systemMsg.content.map((p: any) => p.text || "").join("");
    return "";
  }

  describe("{{workspace_dir}} 替换", () => {
    it("注入到 LLM 的 systemPrompt 中 {{workspace_dir}} 被替换为实际的工作目录", async () => {
      const originalPrompt = "工作目录: {{workspace_dir}}\n请基于此目录分析。";
      agentComponent.registerAgent("test-agent", {
        type: "primary",
        systemPrompt: originalPrompt,
        maxIterations: 1,
      });

      await agentComponent.run("test-agent", "hello");

      // P1-1 修复后：agent.config.systemPrompt 保持原模板
      const agent = (agentComponent as any).getAgent("test-agent");
      expect(agent.config.systemPrompt).toBe(originalPrompt);

      // 验证 LLM 收到的 system message 中占位符被替换
      const injectedPrompt = getLLMSystemPrompt(llmComponent);
      expect(injectedPrompt).toContain(testWorkspaceDir);
      expect(injectedPrompt).not.toContain("{{workspace_dir}}");
    });

    it("多个 {{workspace_dir}} 占位符都被替换（replaceAll）", async () => {
      const originalPrompt = "目录1: {{workspace_dir}}\n目录2: {{workspace_dir}}\n结束。";
      agentComponent.registerAgent("test-agent", {
        type: "primary",
        systemPrompt: originalPrompt,
        maxIterations: 1,
      });

      await agentComponent.run("test-agent", "hello");

      const agent = (agentComponent as any).getAgent("test-agent");
      expect(agent.config.systemPrompt).toBe(originalPrompt);

      const injectedPrompt = getLLMSystemPrompt(llmComponent);
      expect(injectedPrompt).not.toContain("{{workspace_dir}}");
      const occurrences = injectedPrompt.match(new RegExp(testWorkspaceDir, "g"));
      expect(occurrences).toHaveLength(2);
    });

    it("没有 {{workspace_dir}} 占位符时不影响", async () => {
      const originalPrompt = "你好，请帮我分析项目。";
      agentComponent.registerAgent("test-agent", {
        type: "primary",
        systemPrompt: originalPrompt,
        maxIterations: 1,
      });

      await agentComponent.run("test-agent", "hello");

      const agent = (agentComponent as any).getAgent("test-agent");
      expect(agent.config.systemPrompt).toBe(originalPrompt);
    });

    it("config 中未设置 workspace_dir 时回退到 process.cwd()", async () => {
      const originalPrompt = "工作目录: {{workspace_dir}}";
      // 创建一个没有 workspace_dir 的 config
      const configNoDir = new ConfigComponent();
      configNoDir.setXdgDataHome(tempDir);
      await configNoDir.set("agent.configDir", path.join(tempDir, "agents"));

      const llmNoDir = createMockLLMComponent();
      const envNoDir = createMockEnv(sessionComponent, configNoDir, llmNoDir, memoryComponent);
      const ac = new AgentComponent();
      await ac.init({ env: envNoDir, options: { configComponent: configNoDir } } as any);

      ac.registerAgent("test-agent", {
        type: "primary",
        systemPrompt: originalPrompt,
        maxIterations: 1,
      });

      await ac.run("test-agent", "hello");

      // P1-1 修复后：template 不被修改
      const agent = (ac as any).getAgent("test-agent");
      expect(agent.config.systemPrompt).toBe(originalPrompt);

      // 注入到 LLM 的 systemPrompt 应回退到 process.cwd()
      const injectedPrompt = getLLMSystemPrompt(llmNoDir);
      expect(injectedPrompt).toContain(process.cwd());
      expect(injectedPrompt).not.toContain("{{workspace_dir}}");
    });
  });

  describe("{{memory}} 替换", () => {
    it("注入到 LLM 的 systemPrompt 中 {{memory}} 被替换为 memory 内容", async () => {
      const memoryContent = "Project: roy-bot\nStatus: active\nLast commit: fix bugs";
      const originalPrompt = "项目记忆: {{memory}}";
      memoryComponent = createMockMemoryComponent(memoryContent);
      const llmMem = createMockLLMComponent();
      mockEnv = createMockEnv(sessionComponent, configComponent, llmMem, memoryComponent);
      const ac = new AgentComponent();
      await ac.init({ env: mockEnv, options: { configComponent } } as any);

      ac.registerAgent("test-agent", {
        type: "primary",
        systemPrompt: originalPrompt,
        maxIterations: 1,
      });

      await ac.run("test-agent", "hello");

      // P1-1 修复后：template 不被修改
      const agent = (ac as any).getAgent("test-agent");
      expect(agent.config.systemPrompt).toBe(originalPrompt);

      const injectedPrompt = getLLMSystemPrompt(llmMem);
      expect(injectedPrompt).toContain(memoryContent);
      expect(injectedPrompt).not.toContain("{{memory}}");
    });

    it("没有 memory component 时替换为 '(Memory component not available)'", async () => {
      const originalPrompt = "记忆: {{memory}}";
      // 不提供 memory component
      const envNoMem = createMockEnv(sessionComponent, configComponent, llmComponent, undefined);
      const ac = new AgentComponent();
      await ac.init({ env: envNoMem, options: { configComponent } } as any);

      ac.registerAgent("test-agent", {
        type: "primary",
        systemPrompt: originalPrompt,
        maxIterations: 1,
      });

      await ac.run("test-agent", "hello");

      const agent = (ac as any).getAgent("test-agent");
      expect(agent.config.systemPrompt).toBe(originalPrompt);

      const injectedPrompt = getLLMSystemPrompt(llmComponent);
      expect(injectedPrompt).toContain("(Memory component not available)");
      expect(injectedPrompt).not.toContain("{{memory}}");
    });

    it("{{memory}} 返回空内容时替换为 '(No memory)'", async () => {
      const originalPrompt = "记忆: {{memory}}";
      memoryComponent = createMockMemoryComponent("");
      const llmEmpty = createMockLLMComponent();
      mockEnv = createMockEnv(sessionComponent, configComponent, llmEmpty, memoryComponent);
      const ac = new AgentComponent();
      await ac.init({ env: mockEnv, options: { configComponent } } as any);

      ac.registerAgent("test-agent", {
        type: "primary",
        systemPrompt: originalPrompt,
        maxIterations: 1,
      });

      await ac.run("test-agent", "hello");

      const agent = (ac as any).getAgent("test-agent");
      expect(agent.config.systemPrompt).toBe(originalPrompt);

      const injectedPrompt = getLLMSystemPrompt(llmEmpty);
      expect(injectedPrompt).toContain("(No memory)");
    });
  });

  describe("{{workspace_dir}} 和 {{memory}} 同时替换", () => {
    it("两个变量都被正确替换", async () => {
      const originalPrompt = "工作目录: {{workspace_dir}}\n项目记忆: {{memory}}\n请开始工作。";
      agentComponent.registerAgent("test-agent", {
        type: "primary",
        systemPrompt: originalPrompt,
        maxIterations: 1,
      });

      await agentComponent.run("test-agent", "hello");

      // P1-1 修复后：template 不被修改
      const agent = (agentComponent as any).getAgent("test-agent");
      expect(agent.config.systemPrompt).toBe(originalPrompt);

      const injectedPrompt = getLLMSystemPrompt(llmComponent);
      expect(injectedPrompt).toContain(testWorkspaceDir);
      expect(injectedPrompt).toContain("Project summary: test project");
      expect(injectedPrompt).not.toContain("{{workspace_dir}}");
      expect(injectedPrompt).not.toContain("{{memory}}");
    });
  });
});
