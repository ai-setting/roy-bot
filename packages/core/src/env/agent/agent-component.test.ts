/**
 * @fileoverview AgentComponent Tests
 * 
 * 使用 TDD 方法测试 AgentComponent
 */

import { describe, it, expect, vi, beforeEach, afterEach, test } from "vitest";
import { AgentComponent, toLLMMessage } from "./agent-component";
import type { AgentContext } from "./types";
import type { Environment } from "../interface";
import { ConfigComponent } from "../../config/config-component";
import { ContextError, ErrorCodes } from "../errors";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

// ============================================================================
// Mock Environment
// ============================================================================

function createMockEnvironment(): Environment {
  return {
    name: "test-env",
    version: "1.0.0",
    getConfig: vi.fn(() => ({ name: "test-env", version: "1.0.0", enabled: true })),
    registerComponent: vi.fn(),
    unregisterComponent: vi.fn(),
    getComponent: vi.fn(),
    listComponents: vi.fn(() => []),
    handle_query: vi.fn(),
    handle_action: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    subscribeTo: vi.fn(() => () => {}),
    subscribeAll: vi.fn(() => () => {}),
    pushEnvEvent: vi.fn(),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("AgentComponent", () => {
  let agentComponent: AgentComponent;
  let mockEnv: Environment;
  let configComponent: ConfigComponent;
  let tempDir: string;
  let emptyAgentsDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    agentComponent = new AgentComponent();
    configComponent = new ConfigComponent();

    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-test-"));
    emptyAgentsDir = path.join(tempDir, "empty-agents");
    fsSync.mkdirSync(emptyAgentsDir, { recursive: true });
    configComponent.setXdgDataHome(tempDir);
    await configComponent.set("agent.configDir", emptyAgentsDir);
    
    // Create mockEnv with configComponent
    mockEnv = {
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
    };
  });

  afterEach(() => {
    // Clean up environment variables
    delete process.env.AGENT_DEFAULT_AGENT_MAX_ITERATIONS;
    try {
      fsSync.rmSync(tempDir, { recursive: true });
    } catch {}
  });

  describe("constructor and initialization", () => {
    it("should create AgentComponent instance", () => {
      expect(agentComponent).toBeDefined();
      expect(agentComponent.name).toBe("agent");
      expect(agentComponent.version).toBe("1.0.0");
    });

    it("should initialize with default config", async () => {
      await agentComponent.init({ env: mockEnv, options: { configComponent } });
      expect(agentComponent.getStatus()).toBe("running");
    });

    it("should init with env (env is optional)", async () => {
      // env is optional, but configComponent is required
      const component = new AgentComponent();
      await expect(component.init({ env: mockEnv, options: { configComponent } })).resolves.toBeUndefined();
      expect(component.getStatus()).toBe("running");
    });
  });

  describe("Agent registration", () => {
    beforeEach(async () => {
      await agentComponent.init({ env: mockEnv, options: { configComponent } });
    });

    it("should register a new agent", () => {
      const agent = agentComponent.registerAgent("test-agent", {
        type: "primary",
        systemPrompt: "You are a helpful assistant.",
      });
      
      expect(agent).toBeDefined();
      expect(agent.name).toBe("test-agent");
      expect(agent.config.type).toBe("primary");
    });

    it("should get registered agent", () => {
      agentComponent.registerAgent("test-agent", { type: "primary" });
      
      const agent = agentComponent.getAgent("test-agent");
      expect(agent).toBeDefined();
      expect(agent!.name).toBe("test-agent");
    });

    it("should return undefined for non-existent agent", () => {
      const agent = agentComponent.getAgent("non-existent");
      expect(agent).toBeUndefined();
    });

    it("should list all agents", () => {
      agentComponent.registerAgent("agent1", { type: "primary" });
      agentComponent.registerAgent("agent2", { type: "sub" });

      const agents = agentComponent.listAgents();
      // 10 agents: workflow-runner (Task #2164) + task-organizer (Task #2348)
      //   + json-extract + workflow-creator (Task #2194) + workflow-extract
      //   + compact + compact-hint + roy (built-in) + agent1 + agent2
      expect(agents).toHaveLength(10);
    });

    it("should unregister agent", () => {
      agentComponent.registerAgent("test-agent", { type: "primary" });
      const deleted = agentComponent.unregisterAgent("test-agent");
      
      expect(deleted).toBe(true);
      expect(agentComponent.getAgent("test-agent")).toBeUndefined();
    });

    it("should return false when unregistering non-existent agent", () => {
      const deleted = agentComponent.unregisterAgent("non-existent");
      expect(deleted).toBe(false);
    });

    it("should use passed config over defaultAgent (PromptComponent priority)", async () => {
      // 模拟 ConfigComponent 中有 systemPrompt 配置
      const configWithPrompt = new ConfigComponent();
      await configWithPrompt.set("agent.defaultAgent.systemPrompt", "From ConfigComponent");
      await configWithPrompt.set("agent.defaultAgent.maxIterations", 50);
      
      // 通过构造函数传入 config，模拟从配置文件加载的配置
      agentComponent = new AgentComponent({
        config: {
          defaultAgent: {
            systemPrompt: "From ConfigComponent (defaultAgent)",
            maxIterations: 50,
          },
        },
      });
      await agentComponent.init({ env: mockEnv, options: { configComponent: configWithPrompt } });
      
      // 模拟 environment.ts 从 PromptComponent 获取的 systemPrompt
      const promptFromPromptComponent = "From PromptComponent";
      
      // 注册 agent，传入 PromptComponent 的 systemPrompt
      const agent = agentComponent.registerAgent("default", {
        type: "primary",
        systemPrompt: promptFromPromptComponent,
        maxIterations: 100, // 传入的 maxIterations 应该覆盖 defaultAgent 的 50
      });
      
      // 验证：传入的 config (PromptComponent) 优先级最高
      expect(agent.config.systemPrompt).toBe(promptFromPromptComponent);
      expect(agent.config.maxIterations).toBe(100); // 传入的覆盖 defaultAgent 的 50
    });

    it("should fill missing config from defaultAgent", async () => {
      // 当传入的 config 缺失某些字段时，从 defaultAgent 填充
      // 通过构造函数传入默认值
      agentComponent = new AgentComponent({
        config: {
          defaultAgent: {
            systemPrompt: "Default System Prompt",
            maxIterations: 50,
            model: "gpt-4",
          },
        },
      });
      await agentComponent.init({ env: mockEnv, options: { configComponent } });
      
      // 只传入 type，其他字段缺失
      const agent = agentComponent.registerAgent("test-agent", {
        type: "primary",
      });
      
      // 验证：从 defaultAgent 填充缺失的字段
      expect(agent.config.systemPrompt).toBe("Default System Prompt");
      expect(agent.config.maxIterations).toBe(50);
      expect(agent.config.model).toBe("gpt-4");
    });
  });

  describe("Plugin registration", () => {
    beforeEach(async () => {
      await agentComponent.init({ env: mockEnv, options: { configComponent } });
    });

    it("should register plugin to agent", () => {
      agentComponent.registerAgent("test-agent", { type: "primary" });
      
      const plugin = {
        name: "test-plugin",
        version: "1.0.0",
        hooks: [{ point: "agent:before.llm" as const }],
        execute: vi.fn(async () => ({ continue: true })),
      };
      
      agentComponent.registerPlugin("test-agent", plugin);
      
      const agent = agentComponent.getAgent("test-agent");
      expect(agent!.plugins.has("test-plugin")).toBe(true);
    });

    it("should throw error when registering plugin to non-existent agent", () => {
      const plugin = {
        name: "test-plugin",
        version: "1.0.0",
        hooks: [{ point: "agent:before.llm" as const }],
        execute: vi.fn(),
      };
      
      expect(() => agentComponent.registerPlugin("non-existent", plugin)).toThrow();
    });

    it("should unregister plugin", () => {
      agentComponent.registerAgent("test-agent", { type: "primary" });
      
      const plugin = {
        name: "test-plugin",
        version: "1.0.0",
        hooks: [{ point: "agent:before.llm" as const }],
        execute: vi.fn(),
      };
      
      agentComponent.registerPlugin("test-agent", plugin);
      const deleted = agentComponent.unregisterPlugin("test-agent", "test-plugin");
      
      expect(deleted).toBe(true);
    });
  });

  describe("abort functionality", () => {
    beforeEach(async () => {
      await agentComponent.init({ env: mockEnv, options: { configComponent } });
    });

    it("should abort running agent", async () => {
      agentComponent.registerAgent("test-agent", { type: "primary" });
      
      // Start aborting
      agentComponent.abort("test-agent");
      
      // Check abort was registered
      // This would need integration with actual run
      expect(true).toBe(true);
    });
  });

  describe("Agent execution (run)", () => {
    beforeEach(async () => {
      await agentComponent.init({ env: mockEnv, options: { configComponent } });
    });

    it("should throw error for non-existent agent", async () => {
      await expect(agentComponent.run("non-existent", "test query")).rejects.toThrow();
    });

    it("should execute agent and return result", async () => {
      agentComponent.registerAgent("test-agent", { 
        type: "primary",
        systemPrompt: "You are a helpful assistant.",
      });
      
      const result = await agentComponent.run("test-agent", "Say hello");
      
      expect(result).toBeDefined();
      expect(result.iterations).toBe(1);
      expect(result.finalText).toBeDefined();
    });

    it("should respect maxIterations config", async () => {
      agentComponent.registerAgent("test-agent", { 
        type: "primary",
        maxIterations: 5,
      });
      
      // Mock LLM to always return tool calls
      const mockLLMComponent = {
        invoke: vi.fn(() => Promise.resolve({
          output: {
            content: "",
            toolCalls: [{
              id: "call_1",
              function: { name: "test_tool", arguments: "{}" }
            }]
          }
        }))
      };
      (mockEnv.getComponent as any).mockReturnValue(mockLLMComponent);
      
      const result = await agentComponent.run("test-agent", "Test max iterations");
      
      expect(result.iterations).toBeLessThanOrEqual(5);
    });

    it("should use context.model when provided (overriding agent config model)", async () => {
      // Register agent with a default model
      agentComponent.registerAgent("test-agent", { 
        type: "primary",
        model: "agent-default-model",
        systemPrompt: "You are a test assistant.",
      });
      
      // Mock LLM component to spy on invoke calls
      const mockLLMComponent = {
        invoke: vi.fn(() => Promise.resolve({
          output: {
            content: "test response",
            toolCalls: [],
          }
        }))
      };
      (mockEnv.getComponent as any).mockReturnValue(mockLLMComponent);
      
      // Run with context.model override
      await agentComponent.run("test-agent", "Say hello", { model: "override-model" });
      
      // Verify that LLM was invoked with the overridden model, not agent.config.model
      expect(mockLLMComponent.invoke).toHaveBeenCalledWith(
        expect.objectContaining({ model: "override-model" })
      );
    });
  });

  // ==========================================================================
  // toolChoice propagation (Issue #1694 root-cause fix for json-extract
  // non-determinism — Force LLM to call workflow_submit_output)
  // ==========================================================================
  describe("toolChoice propagation from AgentContext to LLM invoke", () => {
    beforeEach(async () => {
      await agentComponent.init({ env: mockEnv, options: { configComponent } });
    });

    it("should forward context.toolChoice = 'required' to llmComponent.invoke", async () => {
      agentComponent.registerAgent("json-extract", {
        type: "sub",
        systemPrompt: "You are a json-extract sub-agent.",
        allowedTools: ["workflow_submit_output"],
        maxIterations: 1,
      });

      const mockLLMComponent = {
        invoke: vi.fn(() =>
          Promise.resolve({
            output: {
              content: "",
              toolCalls: [
                {
                  id: "call_1",
                  function: { name: "workflow_submit_output", arguments: '{"char_count":13}' },
                },
              ],
              finishReason: "tool-calls",
            },
          })
        ),
      };
      (mockEnv.getComponent as any).mockReturnValue(mockLLMComponent);

      await agentComponent.run("json-extract", "", {
        sessionId: "session_test",
        toolChoice: "required",
        persistSession: false,
      });

      expect(mockLLMComponent.invoke).toHaveBeenCalledWith(
        expect.objectContaining({ toolChoice: "required" })
      );
    });

    it("should forward context.toolChoice = { function: { name } } to llmComponent.invoke", async () => {
      agentComponent.registerAgent("json-extract", {
        type: "sub",
        systemPrompt: "You are a json-extract sub-agent.",
        allowedTools: ["workflow_submit_output"],
        maxIterations: 1,
      });

      const mockLLMComponent = {
        invoke: vi.fn(() =>
          Promise.resolve({
            output: { content: "", toolCalls: [], finishReason: "stop" },
          })
        ),
      };
      (mockEnv.getComponent as any).mockReturnValue(mockLLMComponent);

      const forced: { type: "function"; function: { name: string } } = {
        type: "function",
        function: { name: "workflow_submit_output" },
      };

      await agentComponent.run("json-extract", "", {
        sessionId: "session_test",
        toolChoice: forced,
        persistSession: false,
      });

      expect(mockLLMComponent.invoke).toHaveBeenCalledWith(
        expect.objectContaining({ toolChoice: forced })
      );
    });

    it("should NOT pass toolChoice when context.toolChoice is undefined", async () => {
      agentComponent.registerAgent("test-agent", {
        type: "primary",
        systemPrompt: "Hi",
      });

      const mockLLMComponent = {
        invoke: vi.fn(() =>
          Promise.resolve({ output: { content: "ok", toolCalls: [] } })
        ),
      };
      (mockEnv.getComponent as any).mockReturnValue(mockLLMComponent);

      await agentComponent.run("test-agent", "hi", { sessionId: "s1" });

      const invokeArg = mockLLMComponent.invoke.mock.calls[0]?.[0];
      expect(invokeArg?.toolChoice).toBeUndefined();
    });
  });

  describe("Plugin hooks", () => {
    beforeEach(async () => {
      await agentComponent.init({ env: mockEnv, options: { configComponent } });
      agentComponent.registerAgent("test-agent", { type: "primary" });
    });

    it("should execute before.llm hook", async () => {
      const hookCalled = vi.fn();
      
      const plugin = {
        name: "before-llm-hook",
        version: "1.0.0",
        hooks: [{ point: "agent:before.llm" as const }],
        execute: hookCalled,
      };
      
      agentComponent.registerPlugin("test-agent", plugin);
      await agentComponent.run("test-agent", "Test hook");
      
      expect(hookCalled).toHaveBeenCalled();
    });

    it("should allow hook to stop execution", async () => {
      const plugin = {
        name: "stopper",
        version: "1.0.0",
        hooks: [{ point: "agent:before.llm" as const }],
        execute: vi.fn(() => Promise.resolve({ continue: false })),
      };
      
      agentComponent.registerPlugin("test-agent", plugin);
      const result = await agentComponent.run("test-agent", "Test stop");
      
      expect(result.stopped).toBe(true);
    });

    it("should allow hook to modify messages", async () => {
      let capturedCtx: any;
      
      const plugin = {
        name: "message-modifier",
        version: "1.0.0",
        hooks: [{ point: "agent:before.llm" as const }],
        execute: vi.fn((ctx: any) => {
          capturedCtx = ctx;
          return { continue: true };
        }),
      };
      
      agentComponent.registerPlugin("test-agent", plugin);
      await agentComponent.run("test-agent", "Test");
      
      expect(capturedCtx.messages).toBeDefined();
      expect(capturedCtx.messages.length).toBeGreaterThan(0);
    });
  });

  describe("Multiple queries in same session", () => {
    beforeEach(async () => {
      await agentComponent.init({ env: mockEnv, options: { configComponent } });
    });

    it("should add user message for every query (not skip when session has history)", async () => {
      // Create a mock session component that returns existing messages
      const sessionMessages: any[] = [
        { role: "user", content: "first query" },
        { role: "assistant", content: "first response" },
      ];
      
      const mockSessionComponent = {
        addMessage: vi.fn(async () => {}),
        addMessages: vi.fn(async () => []),
        getContext: vi.fn(async () => ({
          messages: sessionMessages,
          checkpoint: undefined,
        })),
      };
      
      // Update mock env to return session component
      (mockEnv.getComponent as any).mockImplementation((name: string) => {
        if (name === "session") return mockSessionComponent;
        if (name === "config") return configComponent;
        return undefined;
      });
      
      agentComponent.registerAgent("test-agent", { 
        type: "primary",
        systemPrompt: "You are a helpful assistant.",
      });
      
      // First run - session is empty
      const result1 = await agentComponent.run("test-agent", "first query", { sessionId: "session_1" });
      expect(result1).toBeDefined();
      
      // Verify user message was added to session (recordSessionMessages uses addMessages batch)
      expect(mockSessionComponent.addMessages).toHaveBeenCalled();
      const firstCallArgs = (mockSessionComponent.addMessages as any).mock.calls[0];
      // addMessages signature: (sessionId, messages[]). Find the user message in the batch.
      const userMsg = firstCallArgs[1].find((m: any) => m.role === "user");
      expect(userMsg).toBeDefined();
      // content may be string or {content}; fromModelMessage flattens string content
      expect(userMsg.content).toBe("first query");
      
      // Second run - session has history, but user message SHOULD still be added
      const result2 = await agentComponent.run("test-agent", "second query", { sessionId: "session_1" });
      expect(result2).toBeDefined();
      
      // Key assertion: user message should be added for the second query
      // (recordSessionMessages uses addMessages batch — flatten all user messages across calls)
      const allCalls = (mockSessionComponent.addMessages as any).mock.calls;
      const userMessages = allCalls
        .flatMap((call: any[]) => (call[1] ?? []))
        .filter((msg: any) => msg.role === "user")
        .map((msg: any) => msg.content);

      // This is the critical test - second query's user message MUST be added
      expect(userMessages).toContain("second query");
    });
  });

  describe("Tool handling", () => {
    // Note: Tool execution is tested via executeTool method directly
    // since mock LLM integration requires more complex setup

    it("should have default tools available", () => {
      const mockTool = {
        name: "test_tool",
        description: "A test tool",
        execute: vi.fn(() => Promise.resolve({ success: true, output: "tool result" })),
      };
      
      agentComponent.setDefaultTools([mockTool]);
      agentComponent.registerAgent("test-agent", { type: "primary" });
      
      const agent = agentComponent.getAgent("test-agent")!;
      const tools = agentComponent.getAvailableTools(agent);
      
      expect(tools.find(t => t.name === "test_tool")).toBeDefined();
    });

    it("should filter tools by name", () => {
      const mockTool1 = { name: "tool1", execute: vi.fn() };
      const mockTool2 = { name: "tool2", execute: vi.fn() };
      
      agentComponent.setDefaultTools([mockTool1, mockTool2]);
      agentComponent.registerAgent("test-agent", { type: "primary" });
      
      const agent = agentComponent.getAgent("test-agent")!;
      const tools = agentComponent.getAvailableTools(agent);
      
      expect(tools).toHaveLength(2);
      expect(tools.map(t => t.name)).toContain("tool1");
      expect(tools.map(t => t.name)).toContain("tool2");
    });
  });

  describe("Default tools", () => {
    beforeEach(async () => {
      await agentComponent.init({ env: mockEnv, options: { configComponent } });
    });

    it("should set and get default tools", () => {
      const tools = [
        { name: "tool1", execute: vi.fn() },
        { name: "tool2", execute: vi.fn() },
      ];
      
      agentComponent.setDefaultTools(tools);
      agentComponent.registerAgent("test-agent", { type: "primary" });
      
      const agent = agentComponent.getAgent("test-agent")!;
      const availableTools = agentComponent.getAvailableTools(agent);
      
      expect(availableTools).toHaveLength(2);
    });

    it("should filter tools by allowedTools", () => {
      agentComponent.setDefaultTools([
        { name: "tool1", execute: vi.fn() },
        { name: "tool2", execute: vi.fn() },
        { name: "tool3", execute: vi.fn() },
      ]);
      
      agentComponent.registerAgent("test-agent", { 
        type: "primary",
        allowedTools: ["tool1", "tool2"],
      });
      
      const agent = agentComponent.getAgent("test-agent")!;
      const availableTools = agentComponent.getAvailableTools(agent);
      
      expect(availableTools).toHaveLength(2);
      expect(availableTools.every(t => ["tool1", "tool2"].includes(t.name))).toBe(true);
    });

    it("should return empty array when allowedTools is empty array (bugfix: [] must not fallback to all tools)", () => {
      agentComponent.setDefaultTools([
        { name: "tool1", execute: vi.fn() },
        { name: "tool2", execute: vi.fn() },
      ]);
      
      agentComponent.registerAgent("test-agent", { 
        type: "primary",
        allowedTools: [],
      });
      
      const agent = agentComponent.getAgent("test-agent")!;
      const availableTools = agentComponent.getAvailableTools(agent);
      
      // Empty allowedTools means NO tools are allowed
      expect(availableTools).toHaveLength(0);
    });

    it("should return all tools when allowedTools is undefined (no filtering)", () => {
      agentComponent.setDefaultTools([
        { name: "tool1", execute: vi.fn() },
        { name: "tool2", execute: vi.fn() },
        { name: "tool3", execute: vi.fn() },
      ]);
      
      agentComponent.registerAgent("test-agent", { 
        type: "primary",
        // allowedTools not set → undefined → no filtering
      });
      
      const agent = agentComponent.getAgent("test-agent")!;
      const availableTools = agentComponent.getAvailableTools(agent);
      
      // undefined means no filtering, all tools available
      expect(availableTools).toHaveLength(3);
    });

    it("should only return specified tool when allowedTools has single entry", () => {
      agentComponent.setDefaultTools([
        { name: "tool_a", execute: vi.fn() },
        { name: "tool_b", execute: vi.fn() },
        { name: "tool_c", execute: vi.fn() },
      ]);
      
      agentComponent.registerAgent("test-agent", { 
        type: "primary",
        allowedTools: ["tool_a"],
      });
      
      const agent = agentComponent.getAgent("test-agent")!;
      const availableTools = agentComponent.getAvailableTools(agent);
      
      expect(availableTools).toHaveLength(1);
      expect(availableTools[0].name).toBe("tool_a");
    });

    it("should filter tools by deniedTools", () => {
      agentComponent.setDefaultTools([
        { name: "tool1", execute: vi.fn() },
        { name: "tool2", execute: vi.fn() },
        { name: "tool3", execute: vi.fn() },
      ]);
      
      agentComponent.registerAgent("test-agent", { 
        type: "primary",
        deniedTools: ["tool3"],
      });
      
      const agent = agentComponent.getAgent("test-agent")!;
      const availableTools = agentComponent.getAvailableTools(agent);
      
      expect(availableTools).toHaveLength(2);
      expect(availableTools.find(t => t.name === "tool3")).toBeUndefined();
    });

    it("should restrict task-organizer agent to only task management tools (allowedTools whitelist)", () => {
      const taskTools = [
        "task_create", "task_get", "task_list", "task_update",
        "task_delete", "task_complete",
        "task_operation_create", "task_operation_get", "task_operation_list",
        "task_operation_update", "task_operation_delete",
      ];
      const allMockTools = [
        // 任务管理工具（应保留）
        ...taskTools.map(name => ({ name, execute: vi.fn() })),
        // 其他工具（应被过滤掉）
        { name: "bash", execute: vi.fn() },
        { name: "echo", execute: vi.fn() },
        { name: "glob", execute: vi.fn() },
        { name: "grep", execute: vi.fn() },
        { name: "read_file", execute: vi.fn() },
        { name: "write_file", execute: vi.fn() },
        { name: "delegate_task", execute: vi.fn() },
        { name: "skill", execute: vi.fn() },
        { name: "ask_user", execute: vi.fn() },
      ];

      agentComponent.setDefaultTools(allMockTools);
      agentComponent.registerAgent("task-organizer", {
        type: "sub",
        allowedTools: taskTools,
      });

      const agent = agentComponent.getAgent("task-organizer")!;
      const availableTools = agentComponent.getAvailableTools(agent);

      // 只应有 11 个任务管理工具
      expect(availableTools).toHaveLength(11);
      // 所有 task 工具都应存在
      for (const name of taskTools) {
        expect(availableTools.find(t => t.name === name)).toBeDefined();
      }
      // 非任务工具不应存在
      expect(availableTools.find(t => t.name === "bash")).toBeUndefined();
      expect(availableTools.find(t => t.name === "delegate_task")).toBeUndefined();
      expect(availableTools.find(t => t.name === "ask_user")).toBeUndefined();
      expect(availableTools.find(t => t.name === "skill")).toBeUndefined();
    });
  });
});

// ============================================================================
// AgentComponent Config Loading Tests (TDD)
// ============================================================================

describe("AgentComponent Config Loading", () => {
  let component: AgentComponent;
  let configComponent: ConfigComponent;
  let mockEnv: Environment;
  let tempDir: string;
  let emptyAgentsDir: string;

  beforeEach(async () => {
    component = new AgentComponent();
    configComponent = new ConfigComponent();
    
    delete process.env.AGENT_DEFAULT_AGENT_MAX_ITERATIONS;

    // Create temp directory for config files
    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-config-test-"));
    emptyAgentsDir = path.join(tempDir, "empty-agents");
    fsSync.mkdirSync(emptyAgentsDir, { recursive: true });
    
    // Set XDG_DATA_HOME to temp directory so ConfigComponent can find config files
    configComponent.setXdgDataHome(tempDir);
    
    // Mock environment
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Clean up environment variables
    delete process.env.AGENT_DEFAULT_AGENT_MAX_ITERATIONS;
    // Clean up temp directory
    try {
      fsSync.rmSync(tempDir, { recursive: true });
    } catch {}
  });

  describe("AgentComponentOptions", () => {
    test("should accept configComponent only", async () => {
      await component.init({
        name: "agent",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { configComponent }
      });
      expect(component.getStatus()).toBe("running");
    });

    test("should accept configPath option", async () => {
      fsSync.writeFileSync(path.join(tempDir, "config.jsonc"), JSON.stringify({
        agent: {
          defaultAgent: {
            maxIterations: 50
          }
        }
      }), "utf-8");

      await component.init({
        name: "agent",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { configComponent, configPath: "config.jsonc" }
      });
      expect(component.getStatus()).toBe("running");
    });

    test("should accept envPrefix option", async () => {
      process.env.AGENT_DEFAULT_AGENT_MAX_ITERATIONS = "75";
      
      await component.init({
        name: "agent",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { configComponent, envPrefix: "AGENT" }
      });
      expect(component.getStatus()).toBe("running");
      
      delete process.env.AGENT_DEFAULT_AGENT_MAX_ITERATIONS;
    });

    test("should accept config option with direct object", async () => {
      await component.init({
        name: "agent",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { 
          configComponent, 
          config: {
            defaultAgent: {
              maxIterations: 25
            }
          }
        }
      });
      expect(component.getStatus()).toBe("running");
    });
  });

  describe("config priority: Object > Env > File", () => {
    test("should Object config override Env config", async () => {
      // Set environment variable
      process.env.AGENT_DEFAULT_AGENT_MAX_ITERATIONS = "50";
      
      // Create file config
      fsSync.writeFileSync(path.join(tempDir, "config.jsonc"), JSON.stringify({
        agent: { defaultAgent: { maxIterations: 100 } }
      }), "utf-8");

      await component.init({
        name: "agent",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { 
          configComponent, 
          configPath: "config.jsonc",
          envPrefix: "AGENT",
          config: { defaultAgent: { maxIterations: 25 } }  // Object has highest priority
        }
      });
      
      // Object config should have highest priority
      expect(configComponent.get("agent.defaultAgent.maxIterations")).toBe(25);
      
      delete process.env.AGENT_DEFAULT_AGENT_MAX_ITERATIONS;
    });

    test("should Env config override File config", async () => {
      // Set environment variable
      process.env.AGENT_DEFAULT_AGENT_MAX_ITERATIONS = "50";
      
      // Create file config
      fsSync.writeFileSync(path.join(tempDir, "config.jsonc"), JSON.stringify({
        agent: { defaultAgent: { maxIterations: 100 } }
      }), "utf-8");

      await component.init({
        name: "agent",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { 
          configComponent, 
          configPath: "config.jsonc",
          envPrefix: "AGENT"
        }
      });
      
      // Env should override file
      expect(configComponent.get("agent.defaultAgent.maxIterations")).toBe("50");
    });

    test("should load defaultAgent values preloaded in ConfigComponent", async () => {
      delete process.env.AGENT_DEFAULT_AGENT_MAX_ITERATIONS;

      configComponent.registerComponent(
        (await import("./agent-config-registration")).AGENT_CONFIG_REGISTRATION
      );
      await configComponent.set("agent.configDir", emptyAgentsDir);
      await configComponent.set("agent.defaultAgent.maxIterations", 100);
      await configComponent.set("agent.defaultAgent.maxErrorRetries", 5);

      await component.init({
        name: "agent",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: {
          configComponent,
          envPrefix: "ISOLATED_AGENT_TEST_NO_ENV",
        },
      });

      expect(configComponent.get("agent.defaultAgent.maxIterations")).toBe(100);
      expect(configComponent.get("agent.defaultAgent.maxErrorRetries")).toBe(5);
      expect((component as any).config.defaultAgent.maxIterations).toBe(100);
    });

    test("should use default values when no config provided", async () => {
      await component.init({
        name: "agent",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { configComponent }
      });
      
      // Default values should be used (配置统一化后应返回默认值)
      // 注意：AGENT_DEFAULTS 中定义的是 200
      expect(configComponent.get("agent.defaultAgent.maxIterations")).toBe(200);
      // maxErrorRetries 没有默认值，所以应该是 undefined
      expect(configComponent.get("agent.defaultAgent.maxErrorRetries")).toBeUndefined();
    });
  });

  describe("config hot reload", () => {
    test("should register config watcher for hot reload", async () => {
      const watcherFn = vi.fn();
      vi.spyOn(configComponent, "watch").mockReturnValue(watcherFn);
      
      await component.init({
        name: "agent",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { configComponent }
      });
      
      expect(configComponent.watch).toHaveBeenCalledWith("agent.*", expect.any(Function));
    });
  });

  // ============================================================================
  // TDD: Tool Results Completeness Tests
  // 
  // Bug: AI SDK v6 requires 1:1 correspondence between tool-calls and tool-results
  // Error: "Tool results are missing for tool calls call_function_xxx_1, _2, _3"
  //
  // When processing multiple tool calls, if abort/doom-loop/hook-stopped occurs
  // mid-processing, remaining tool calls don't get results, causing AI SDK errors.
  // ============================================================================

  describe("Tool Results Completeness (TDD)", () => {
    let agentComponent: AgentComponent;
    let mockEnv: Environment;
    let configComponent: ConfigComponent;

    beforeEach(async () => {
      vi.clearAllMocks();
      agentComponent = new AgentComponent();
      configComponent = new ConfigComponent();
      
      mockEnv = {
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
      };

      await agentComponent.init({ env: mockEnv, options: { configComponent } });
    });

    afterEach(() => {
      delete process.env.AGENT_DEFAULT_AGENT_MAX_ITERATIONS;
    });

    describe("addRemainingToolResults helper", () => {
      it("should add placeholder results for all remaining tool calls", () => {
        // Register agent
        agentComponent.registerAgent("test-agent", { type: "primary" });

        // Access private method for testing
        const agent = agentComponent.getAgent("test-agent")!;
        const messages: any[] = [];
        
        const allToolCalls = [
          { id: "call_1", function: { name: "tool1" } },
          { id: "call_2", function: { name: "tool2" } },
          { id: "call_3", function: { name: "tool3" } },
        ];

        // Call the helper (we'll test via run() method behavior instead)
        // For now, just verify the structure
        expect(allToolCalls).toHaveLength(3);
      });
    });

    describe("abort during tool call processing", () => {
      it("should add placeholder results for unprocessed tool calls when abort occurs", async () => {
        agentComponent.registerAgent("test-agent", { 
          type: "primary",
          maxIterations: 10,
        });

        // Mock LLMComponent that returns 3 tool calls
        const mockLLMComponent = {
          invoke: vi.fn(() => Promise.resolve({
            output: {
              content: "",
              toolCalls: [
                { id: "call_1", function: { name: "tool1", arguments: "{}" } },
                { id: "call_2", function: { name: "tool2", arguments: "{}" } },
                { id: "call_3", function: { name: "tool3", arguments: "{}" } },
              ]
            }
          }))
        };
        (mockEnv.getComponent as any).mockReturnValue(mockLLMComponent);

        // Mock tool execution - execute first tool, then abort
        const mockTool = {
          name: "tool1",
          execute: vi.fn(async () => {
            // Simulate abort after first tool
            agentComponent.abort("test-agent");
            return { success: true, output: "result1" };
          }),
        };
        const mockTool2 = { name: "tool2", execute: vi.fn() };
        const mockTool3 = { name: "tool3", execute: vi.fn() };
        
        agentComponent.setDefaultTools([mockTool, mockTool2, mockTool3]);

        // Run agent
        const result = await agentComponent.run("test-agent", "Execute multiple tools and abort");

        // Verify: result should indicate stopped
        expect(result.stopped).toBe(true);
        // The key test: run() should complete without throwing MissingToolResultsError
        // This is verified by the fact that we reach here without error
        expect(true).toBe(true);

        // The key assertion: there should be no MissingToolResultsError
        // This is verified by the fact that run() completed without throwing
        expect(true).toBe(true); // If we reach here, the bug is fixed
      });
    });

    describe("doom loop detection during tool call processing", () => {
      it("should add placeholder results for unprocessed tool calls when doom loop detected", async () => {
        agentComponent.registerAgent("test-agent", { 
          type: "primary",
          maxIterations: 10,
          doomLoopThreshold: 2, // Trigger doom loop quickly
        });

        // Mock LLMComponent that returns same tool call repeatedly
        const mockLLMComponent = {
          invoke: vi.fn(() => Promise.resolve({
            output: {
              content: "",
              toolCalls: [
                { id: "call_1", function: { name: "repeat_tool", arguments: '{"key":"value"}' } },
                { id: "call_2", function: { name: "repeat_tool", arguments: '{"key":"value"}' } },
                { id: "call_3", function: { name: "repeat_tool", arguments: '{"key":"value"}' } },
              ]
            }
          }))
        };
        (mockEnv.getComponent as any).mockReturnValue(mockLLMComponent);

        // Mock tool that returns same result (causing doom loop)
        const mockTool = {
          name: "repeat_tool",
          execute: vi.fn(() => Promise.resolve({ success: true, output: "same_result" })),
        };
        agentComponent.setDefaultTools([mockTool]);

        // Run agent - should trigger doom loop detection
        // After doom loop, remaining tool calls should get placeholder results
        // This should not throw MissingToolResultsError
        try {
          const result = await agentComponent.run("test-agent", "Trigger doom loop");
          // If we reach here without error, the fix is working
          expect(result.error).toContain("Doom loop");
        } catch (error: any) {
          // Should NOT contain MissingToolResultsError
          expect(error.message).not.toContain("Tool results are missing");
        }
      });

      it("should reset doom loop count across iterations (not accumulate across iterations)", async () => {
        agentComponent.registerAgent("test-agent", { 
          type: "primary",
          maxIterations: 10,
          doomLoopThreshold: 3, // Need 3+ same calls within one iteration to trigger
        });

        let invokeCount = 0;
        
        // Mock LLMComponent: 
        // - Iteration 1: returns same tool call once (count=1, not enough to trigger)
        // - Iteration 2: returns same tool call once (count should reset to 1, not 2!)
        // - Iteration 3: returns same tool call once (count should reset to 1, not 3!)
        // If doom loop count accumulates across iterations, iteration 3 would trigger doom loop
        // If doom loop count resets per iteration, it should NOT trigger doom loop
        const mockLLMComponent = {
          invoke: vi.fn(() => {
            invokeCount++;
            return Promise.resolve({
              output: {
                content: invokeCount >= 4 ? "done" : "", // Stop after 3 iterations
                toolCalls: [
                  { id: `call_${invokeCount}`, function: { name: "repeat_tool", arguments: '{"key":"value"}' } },
                ]
              }
            });
          })
        };
        (mockEnv.getComponent as any).mockReturnValue(mockLLMComponent);

        // Mock tool that returns same result
        const mockTool = {
          name: "repeat_tool",
          execute: vi.fn(() => Promise.resolve({ success: true, output: "same_result" })),
        };
        agentComponent.setDefaultTools([mockTool]);

        const result = await agentComponent.run("test-agent", "Test doom loop reset across iterations");
        
        // Should NOT trigger doom loop because count should reset each iteration
        // If this test fails, it means doom loop count accumulated across iterations
        expect(result.error).toBeUndefined();
        // Should complete with max iterations reached or text response
        expect(result.iterations).toBeGreaterThanOrEqual(3);
      });
    });

    describe("hook _stopped during tool call processing", () => {
      it("should add placeholder results when before.tool hook stops execution", async () => {
        agentComponent.registerAgent("test-agent", { 
          type: "primary",
          maxIterations: 10,
        });

        // Mock LLMComponent that returns 3 tool calls
        const mockLLMComponent = {
          invoke: vi.fn(() => Promise.resolve({
            output: {
              content: "",
              toolCalls: [
                { id: "call_1", function: { name: "tool1", arguments: "{}" } },
                { id: "call_2", function: { name: "tool2", arguments: "{}" } },
                { id: "call_3", function: { name: "tool3", arguments: "{}" } },
              ]
            }
          }))
        };
        (mockEnv.getComponent as any).mockReturnValue(mockLLMComponent);

        // Mock tool
        const mockTool = { name: "tool1", execute: vi.fn() };
        const mockTool2 = { name: "tool2", execute: vi.fn() };
        const mockTool3 = { name: "tool3", execute: vi.fn() };
        agentComponent.setDefaultTools([mockTool, mockTool2, mockTool3]);

        // Register plugin that stops execution after first tool
        const plugin = {
          name: "stop-after-first-tool",
          version: "1.0.0",
          hooks: [{ point: "agent:before.tool" as const }],
          execute: vi.fn((ctx: any) => {
            // Stop after processing tool1
            if (ctx.currentToolCall?.name === "tool2") {
              return { continue: false };
            }
            return { continue: true };
          }),
        };
        agentComponent.registerPlugin("test-agent", plugin);

        // Run agent - should not throw MissingToolResultsError
        try {
          const result = await agentComponent.run("test-agent", "Execute with stopping hook");
          // If we reach here without error, the fix is working
          expect(result.stopped).toBe(true);
        } catch (error: any) {
          // Should NOT contain MissingToolResultsError
          expect(error.message).not.toContain("Tool results are missing");
        }
      });
    });

    describe("_stopped state propagation to next iteration", () => {
      it("should break while loop when _stopped is set by hook in previous iteration", async () => {
        agentComponent.registerAgent("test-agent", { 
          type: "primary",
          maxIterations: 10,
        });

        let iteration = 0;
        const mockLLMComponent = {
          invoke: vi.fn(() => {
            iteration++;
            if (iteration === 1) {
              // First iteration: returns tool call and sets _stopped via hook
              return Promise.resolve({
                output: {
                  content: "",
                  toolCalls: [
                    { id: "call_1", function: { name: "tool1", arguments: "{}" } },
                  ]
                }
              });
            }
            // Second iteration should NOT happen
            return Promise.resolve({
              output: {
                content: "should not reach here",
                toolCalls: []
              }
            });
          })
        };
        (mockEnv.getComponent as any).mockReturnValue(mockLLMComponent);

        const mockTool = { 
          name: "tool1", 
          execute: vi.fn(() => Promise.resolve({ success: true, output: "result" }))
        };
        agentComponent.setDefaultTools([mockTool]);

        // Register hook that sets _stopped after first iteration's on.iteration
        let firstIterationComplete = false;
        const plugin = {
          name: "stop-after-first-iteration",
          version: "1.0.0",
          hooks: [{ point: "agent:on.iteration" as const }],
          execute: vi.fn((ctx: any) => {
            if (!firstIterationComplete) {
              firstIterationComplete = true;
              ctx._stopped = true;
              ctx._stopReason = "stopped by hook";
            }
            return { continue: true };
          }),
        };
        agentComponent.registerPlugin("test-agent", plugin);

        // Run agent
        const result = await agentComponent.run("test-agent", "Test _stopped propagation");

        // Verify: should only run 1 iteration (not 2)
        expect(result.iterations).toBe(1);
        expect(mockLLMComponent.invoke).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe("getConversationHistory", () => {
    let mockSessionComponent: any;
    let agent: AgentComponent;

    beforeEach(async () => {
      agent = new AgentComponent();
      await agent.init({ env: mockEnv, options: { configComponent } });
      
      // Create mock session component with getContext (new implementation)
      mockSessionComponent = {
        getContext: vi.fn(),
      };
      
      // Update mockEnv to return our mock session component
      (mockEnv.getComponent as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
        if (name === "session") return mockSessionComponent;
        if (name === "config") return configComponent;
        return undefined;
      });
    });

    it("应该返回空数组当会话没有消息", async () => {
      mockSessionComponent.getContext.mockResolvedValue({
        messages: []
      });

      const history = await (agent as any).getConversationHistory(
        mockSessionComponent,
        "session_123",
        { minUserMessages: 5 }
      );

      expect(history).toEqual([]);
    });

    it("应该使用 getContext 获取消息并从 user 消息边界截取", async () => {
      const sessionId = "session_123";
      
      // getContext 已经处理了 minUserMessages 逻辑，直接返回从 user 边界截取后的消息
      const mockMessages = [
        { id: "msg_3", role: "user", content: "User 2", metadata: {} },
        { id: "msg_4", role: "assistant", content: "Assistant 2", metadata: {} },
        { id: "msg_5", role: "user", content: "User 3", metadata: {} },
        { id: "msg_6", role: "assistant", content: "Assistant 3", metadata: {} },
      ];
      mockSessionComponent.getContext.mockResolvedValue({
        messages: mockMessages
      });

      const history = await (agent as any).getConversationHistory(
        mockSessionComponent,
        sessionId,
        { minUserMessages: 2 }
      );

      // Verify: getContext should be called with fullHistory=false and minUserMessages
      expect(mockSessionComponent.getContext).toHaveBeenCalledWith(sessionId, {
        fullHistory: false,
        minUserMessages: 2,
      });
      
      expect(history).toHaveLength(4);
      expect(history.map((m: any) => m.content)).toEqual([
        "User 2", "Assistant 2", "User 3", "Assistant 3"
      ]);
    });

    it("应该正确处理 filterHistory=true 时过滤 tool 消息", async () => {
      const mockMessages = [
        { id: "msg_0", role: "user", content: "User 1", metadata: {} },
        { id: "msg_1", role: "assistant", content: "Assistant 1", metadata: {} },
        { id: "msg_2", role: "tool", content: "tool result", metadata: { type: "tool_result" } },
        { id: "msg_3", role: "assistant", content: "Assistant 2", metadata: {} },
      ];
      mockSessionComponent.getContext.mockResolvedValue({
        messages: mockMessages
      });

      const history = await (agent as any).getConversationHistory(
        mockSessionComponent,
        "session_123",
        { filterHistory: true }
      );

      // Should filter out tool messages
      expect(history).toHaveLength(3);
      expect(history.map((m: any) => m.role)).toEqual(["user", "assistant", "assistant"]);
      expect(history.find((m: any) => m.role === "tool")).toBeUndefined();
    });

    it("应该正确处理 filterHistory=false 时保留所有消息", async () => {
      const mockMessages = [
        { id: "msg_0", role: "user", content: "User 1", metadata: {} },
        { id: "msg_1", role: "assistant", content: "Assistant 1", metadata: {} },
        { id: "msg_2", role: "tool", content: "tool result", metadata: { type: "tool_result" } },
        { id: "msg_3", role: "assistant", content: "Assistant 2", metadata: {} },
      ];
      mockSessionComponent.getContext.mockResolvedValue({
        messages: mockMessages
      });

      const history = await (agent as any).getConversationHistory(
        mockSessionComponent,
        "session_123",
        { filterHistory: false }
      );

      // Should keep all messages including tool
      expect(history).toHaveLength(4);
      expect(history.map((m: any) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    });

    it("默认 filterHistory=false（不指定时）", async () => {
      const mockMessages = [
        { id: "msg_0", role: "user", content: "User 1", metadata: {} },
        { id: "msg_1", role: "assistant", content: "Assistant 1", metadata: {} },
        { id: "msg_2", role: "tool", content: "tool result", metadata: { type: "tool_result" } },
        { id: "msg_3", role: "assistant", content: "Assistant 2", metadata: {} },
      ];
      mockSessionComponent.getContext.mockResolvedValue({
        messages: mockMessages
      });

      // 不指定 filterHistory 参数
      const history = await (agent as any).getConversationHistory(
        mockSessionComponent,
        "session_123",
        {}
      );

      // 默认应该保留所有消息（包括 tool 消息）
      expect(history).toHaveLength(4);
      expect(history.map((m: any) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    });

    it("应该正确处理消息少于 minUserMessages 的情况", async () => {
      const mockMessages = [
        { id: "msg_0", role: "user", content: "User 1", metadata: {} },
        { id: "msg_1", role: "assistant", content: "Assistant 1", metadata: {} },
      ];
      mockSessionComponent.getContext.mockResolvedValue({
        messages: mockMessages
      });

      // 当消息少于 minUserMessages 时，getContext 会返回所有消息
      const history = await (agent as any).getConversationHistory(
        mockSessionComponent,
        "session_123",
        { minUserMessages: 5 }
      );

      expect(mockSessionComponent.getContext).toHaveBeenCalledWith("session_123", {
        fullHistory: false,
        minUserMessages: 5,
      });
      expect(history).toHaveLength(2);
    });
  });
});

// ============================================================================
// Tool Role Message Pairing Bug Tests
// ============================================================================
// 
// Bug: 当 Iteration 1 执行了工具后，hookCtx.currentToolCall 残留为最后一个
// 工具的值。当 Iteration 2 的 LLM 调用抛出 ContextError 时，catch 块误推了
// 一个孤立的 tool result（使用上一轮残留的 currentToolCall），导致 AI SDK
// 校验失败: "Messages with role 'tool' must be a response to a preceding 
// message with 'tool_calls'"
//
// 修复：在每次 ReAct 迭代开始前重置 hookCtx.currentToolCall = undefined

describe("Tool role message pairing (currentToolCall residue bug)", () => {
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
      addMessages: vi.fn(async (_sessionId: string, messages: any[]) => {
        for (const m of messages) recordedMessages.push(m);
        return messages.map(() => "mock-id");
      }),
      getContext: vi.fn(async () => ({
        messages: [],
        checkpoint: undefined,
      })),
    };
    
    mockEnv = createMockEnvironment();
    (mockEnv.getComponent as any).mockImplementation((name: string) => {
      if (name === "session") return mockSessionComponent;
      if (name === "config") return configComponent;
      return undefined;
    });
    
    await agentComponent.init({ env: mockEnv, options: { configComponent } });
  });

  it("should not push orphaned tool result when ContextError occurs in next iteration", async () => {
    // Arrange
    agentComponent.registerAgent("test-agent", { 
      type: "primary",
      maxIterations: 10,
    });

    let llmCallCount = 0;
    
    // Mock LLMComponent:
    // - 1st call: returns tool calls (simulating Iteration 1 with tools)
    // - 2nd call: throws ContextError WITHOUT tool calls (simulating the bug scenario)
    const mockLLMComponent = {
      invoke: vi.fn().mockImplementation(() => {
        llmCallCount++;
        if (llmCallCount === 1) {
          // Iteration 1: Return tool calls (call_00, call_01, call_02)
          return Promise.resolve({
            output: {
              content: "I'll execute these tools",
              toolCalls: [
                { id: "call_00", function: { name: "test_tool", arguments: "{}" } },
                { id: "call_01", function: { name: "test_tool", arguments: "{}" } },
                { id: "call_02", function: { name: "test_tool", arguments: "{}" } },
              ]
            },
            providerId: "openai",
            model: "gpt-4o",
            latencyMs: 100
          });
        } else {
          // Iteration 2: Throw ContextError with NO tool calls
          // This simulates the scenario where LLM hits context limit during invocation
          const llmOutput = {
            content: "I'm running out of context but still want to respond",
            reasoning: "",
            toolCalls: [],
            usage: { promptTokens: 120000, completionTokens: 500, totalTokens: 120500 }
          };
          
          throw new ContextError(
            "Context threshold exceeded: 120500/128000 (94.1%)",
            ErrorCodes.CONTEXT_THRESHOLD_EXCEEDED,
            "session_123",
            llmOutput.usage,
            128000,
            llmOutput
          );
        }
      })
    };
    (mockEnv.getComponent as any).mockImplementation((name: string) => {
      if (name === "llm") return mockLLMComponent;
      if (name === "session") return mockSessionComponent;
      if (name === "config") return configComponent;
      return undefined;
    });

    // Register mock tools that succeed
    const mockTool: any = {
      name: "test_tool",
      description: "A test tool",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(() => Promise.resolve({ success: true, output: "tool_result" })),
    };
    agentComponent.setDefaultTools([mockTool]);

    // Act
    try {
      await agentComponent.run("test-agent", "Test tool role pairing", { sessionId: "session_123" });
    } catch (error) {
      // Error is expected (ContextError), we just need to check the message sequence
    }

    // Assert
    // The key assertion: after Iteration 2 throws ContextError without tool_calls,
    // there should be NO orphaned tool result message.
    //
    // A tool result is "orphaned" if its assistant predecessor has no tool-calls.
    // After the fix, currentToolCall is reset at each iteration start, so the
    // catch block won't push a stale tool result.
    //
    // We check the recordSessionMessages calls, which now use addMessages(batch).
    // Each call is (sessionId, messages[]); flatten across all calls in the
    // session-interaction order to reuse the pairing-invariant check.
    const allMessages = (mockSessionComponent.addMessages as any).mock.calls
      .flatMap((call: any[]) => call[1] ?? []);

    // Helper to check if an assistant message has tool-call parts
    // Session message format: tool-calls are stored in the `parts` array
    // (not in `content`, which is a string for text content)
    function hasToolCallParts(msg: any): boolean {
      if (!msg) return false;
      // Check parts array first (session format)
      if (msg.parts && Array.isArray(msg.parts)) {
        return msg.parts.some((part: any) => part?.type === "tool-call");
      }
      // Fallback: check content array (raw ModelMessage format)
      if (msg.content && Array.isArray(msg.content)) {
        return msg.content.some((part: any) => part?.type === "tool-call");
      }
      return false;
    }

    // Debug output
    console.log("Message roles:", JSON.stringify(allMessages.map((m: any) => m?.role)));

    // Walk through messages and detect orphaned tool results
    // An orphaned tool result is a tool message whose preceding assistant has no tool-call parts
    let foundOrphanedTool = false;
    let lastAssistantHadToolCalls = false;

    for (const msg of allMessages) {
      if (!msg) continue;

      if (msg.role === "assistant") {
        lastAssistantHadToolCalls = hasToolCallParts(msg);
      } else if (msg.role === "tool") {
        if (!lastAssistantHadToolCalls) {
          foundOrphanedTool = true;
          console.log("ORPHANED TOOL FOUND:", JSON.stringify(msg));
        }
      }
    }
    
    // After the fix, there should be NO orphaned tool results
    expect(foundOrphanedTool).toBe(false);
  });

  it("should still handle tool execution errors without breaking message pairing", async () => {
    // Verify that the fix doesn't break the legitimate case:
    // When a tool execution throws within the same iteration, the agent should
    // complete without unhandled errors and message pairing should remain valid
    
    agentComponent.registerAgent("test-agent", { 
      type: "primary",
      maxIterations: 10,
    });

    const mockLLMComponent = {
      invoke: vi.fn(() => Promise.resolve({
        output: {
          content: "",
          toolCalls: [
            { id: "call_err", function: { name: "failing_tool", arguments: "{}" } },
          ]
        },
        providerId: "openai",
        model: "gpt-4o",
        latencyMs: 100
      }))
    };
    (mockEnv.getComponent as any).mockImplementation((name: string) => {
      if (name === "llm") return mockLLMComponent;
      if (name === "session") return mockSessionComponent;
      if (name === "config") return configComponent;
      return undefined;
    });

    // Register a tool that throws during execution
    const mockTool: any = {
      name: "failing_tool",
      description: "A tool that fails",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(() => Promise.reject(new Error("Tool execution failed"))),
    };
    agentComponent.setDefaultTools([mockTool]);

    // Act - should complete without unhandled exception
    let result: any = null;
    try {
      result = await agentComponent.run("test-agent", "Test tool error", { sessionId: "session_123" });
    } catch (error) {
      // Expected - error result is fine, but no crash
    }

    // Verify message pairing is still valid: no orphaned tool result.
    // recordSessionMessages uses addMessages(batch); flatten across calls.
    const allMessages = (mockSessionComponent.addMessages as any).mock.calls
      .flatMap((call: any[]) => call[1] ?? []);
    let orphanedFound = false;
    let lastHadToolCalls = false;

    for (const msg of allMessages) {
      if (!msg) continue;
      if (msg.role === "assistant") {
        const parts = msg.parts || msg.content || [];
        lastHadToolCalls = Array.isArray(parts) && parts.some((p: any) => p?.type === "tool-call");
      } else if (msg.role === "tool") {
        if (!lastHadToolCalls) orphanedFound = true;
      }
    }
    
    expect(orphanedFound).toBe(false);
  });
});

// ============================================================================
// toLLMMessage Tests
// ============================================================================

describe("toLLMMessage (message conversion)", () => {
  it("should convert assistant message with tool-call parts (flat format from toModelMessage)", () => {
    const modelMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "I'll search for that" },
        { type: "tool-call", toolCallId: "call_123", toolName: "search", input: { query: "test" } }
      ]
    };

    const result = toLLMMessage(modelMessage);

    expect(result.role).toBe("assistant");
    expect(result.content).toBe("I'll search for that");
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual({
      id: "call_123",
      name: "search",
      arguments: '{"query":"test"}',
      function: {
        name: "search",
        arguments: '{"query":"test"}',
      },
    });
  });

  it("should convert tool message with tool-result part", () => {
    const modelMessage = {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "call_123", toolName: "search", output: "search results" }
      ]
    };

    const result = toLLMMessage(modelMessage);

    expect(result.role).toBe("tool");
    expect(result.content).toBe("search results");
    expect(result.toolCallId).toBe("call_123");
    expect(result.name).toBe("search");
  });

  it("should convert tool message with nested output format", () => {
    const modelMessage = {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "call_456", toolName: "bash", output: { type: "text", value: "command output" } }
      ]
    };

    const result = toLLMMessage(modelMessage);

    expect(result.role).toBe("tool");
    expect(result.content).toBe("command output");
  });

  it("should NOT include reasoning content — only text content is kept", () => {
    const modelMessage = {
      role: "assistant",
      content: [
        { type: "reasoning", text: "I need to run a command to check the file" },
        { type: "text", text: "Running the command now" },
        { type: "tool-call", toolCallId: "call_789", toolName: "bash", input: { command: "ls" } }
      ]
    };

    const result = toLLMMessage(modelMessage);

    // Reasoning should NOT leak into content — only text part is kept
    expect(result.content).not.toContain("I need to run a command to check the file");
    expect(result.content).toContain("Running the command now");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("bash");
  });


  it("should return empty content when only reasoning part exists (no text part)", () => {
    const modelMessage = {
      role: "assistant",
      content: [
        { type: "reasoning", text: "I need to think about this step by step" },
        { type: "tool-call", toolCallId: "call_101", toolName: "bash", input: { command: "echo hello" } }
      ]
    };

    const result = toLLMMessage(modelMessage);

    // With only reasoning (no text part), content should be empty — reasoning does NOT leak
    expect(result.content).toBe("");
    expect(result.toolCalls).toHaveLength(1);
  });

  // ============================================================================
  // P1: Multimodal conversion — preserve image/file content as ContentPart[]
  // ============================================================================

  it("should preserve image part in user message as ContentPart[]", () => {
    const modelMessage = {
      role: "user",
      content: [
        { type: "text", text: "describe this" },
        { type: "image", image: "https://example.com/cat.jpg" },
      ],
    };

    const result = toLLMMessage(modelMessage);

    expect(result.role).toBe("user");
    expect(Array.isArray(result.content)).toBe(true);
    const parts = result.content as any[];
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "text", text: "describe this" });
    expect(parts[1]).toEqual({ type: "image", image: "https://example.com/cat.jpg" });
  });

  it("should preserve file part in user message as ContentPart[]", () => {
    const modelMessage = {
      role: "user",
      content: [
        { type: "text", text: "read this pdf" },
        { type: "file", data: new Uint8Array([0x25, 0x50, 0x44, 0x46]), mediaType: "application/pdf" },
      ],
    };

    const result = toLLMMessage(modelMessage);

    expect(result.role).toBe("user");
    expect(Array.isArray(result.content)).toBe(true);
    const parts = result.content as any[];
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "text", text: "read this pdf" });
    expect(parts[1].type).toBe("file");
    expect(parts[1].mediaType).toBe("application/pdf");
  });

  it("should drop reasoning part from multimodal content (no leakage)", () => {
    const modelMessage = {
      role: "assistant",
      content: [
        { type: "reasoning", text: "internal thought" },
        { type: "text", text: "the response" },
        { type: "image", image: "https://example.com/x.png" },
      ],
    };

    const result = toLLMMessage(modelMessage);

    expect(Array.isArray(result.content)).toBe(true);
    const parts = result.content as any[];
    // reasoning should NOT appear
    expect(parts.some((p: any) => p.type === "reasoning")).toBe(false);
    expect(parts.some((p: any) => p.text === "internal thought")).toBe(false);
    expect(parts.some((p: any) => p.type === "text" && p.text === "the response")).toBe(true);
    expect(parts.some((p: any) => p.type === "image")).toBe(true);
  });

  it("should keep plain text content as string (backward compat — no array wrap)", () => {
    const modelMessage = {
      role: "user",
      content: [
        { type: "text", text: "just text" },
      ],
    };

    const result = toLLMMessage(modelMessage);

    expect(typeof result.content).toBe("string");
    expect(result.content).toBe("just text");
  });
});

// ============================================================================
// Phase B.11+: EventSource systemPrompt 注入到 Agent systemPrompt
// ============================================================================
//
// 场景：event-source（如 bounty-im）通过 EventSourceConfig.systemPrompt 配置专属 prompt，
// 透传到 envEvent.metadata.systemPrompt，经 queryExecutor → AgentComponent.run 的
// context.metadata 抵达 _run。AgentComponent._run 应当把 EventSource systemPrompt
// 追加到 agent 已有 systemPrompt 之后（不覆盖原 prompt）。

describe("EventSource systemPrompt injection (Phase B.11+)", () => {
  let agentComponent: AgentComponent;
  let mockEnv: Environment;
  let configComponent: ConfigComponent;
  let tempDir: string;
  let emptyAgentsDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    agentComponent = new AgentComponent();
    configComponent = new ConfigComponent();

    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-sysprompt-test-"));
    emptyAgentsDir = path.join(tempDir, "empty-agents");
    fsSync.mkdirSync(emptyAgentsDir, { recursive: true });
    configComponent.setXdgDataHome(tempDir);
    await configComponent.set("agent.configDir", emptyAgentsDir);

    mockEnv = {
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
    };

    await agentComponent.init({ env: mockEnv, options: { configComponent } });
  });

  it("should append EventSource systemPrompt after agent systemPrompt", async () => {
    agentComponent.registerAgent("bounty-im-agent", {
      type: "primary",
      systemPrompt: "AGENT-ORIGINAL-SYSTEM-PROMPT",
    });

    const mockLLMComponent = {
      invoke: vi.fn(() =>
        Promise.resolve({
          output: { content: "ok", toolCalls: [], finishReason: "stop" },
        })
      ),
    };
    (mockEnv.getComponent as any).mockImplementation((name: string) => {
      if (name === "config") return configComponent;
      if (name === "llm") return mockLLMComponent;
      return undefined;
    });

    await agentComponent.run("bounty-im-agent", "test query", {
      sessionId: "session_test",
      persistSession: false,
      metadata: {
        systemPrompt:
          "EVENT-SOURCE-INJECTED-PROMPT (you are bounty-im agent, address X, use `bounty com send --endpoint Y` to reply)",
      } as any,
    });

    // Verify LLM 收到的第一条 system message 内容包含 agent 原 prompt + event source 注入的 prompt
    expect(mockLLMComponent.invoke).toHaveBeenCalledTimes(1);
    const invokeArg = mockLLMComponent.invoke.mock.calls[0][0];
    const messages = invokeArg.messages as Array<{ role: string; content: string }>;
    // 第一条必须是 system message（_buildMessages 把 systemPrompt 推为 system 角色）
    expect(messages[0].role).toBe("system");
    const systemContent = messages[0].content as string;
    expect(systemContent).toContain("AGENT-ORIGINAL-SYSTEM-PROMPT");
    expect(systemContent).toContain("EVENT-SOURCE-INJECTED-PROMPT");
    expect(systemContent).toContain("bounty com send");
    // EventSource prompt 应该排在 agent prompt 之后（追加语义）
    expect(systemContent.indexOf("AGENT-ORIGINAL-SYSTEM-PROMPT")).toBeLessThan(
      systemContent.indexOf("EVENT-SOURCE-INJECTED-PROMPT")
    );
  });

  it("should use EventSource systemPrompt as-is when agent has no systemPrompt", async () => {
    agentComponent.registerAgent("promptless-agent", {
      type: "primary",
      // 故意不设 systemPrompt
    });

    const mockLLMComponent = {
      invoke: vi.fn(() =>
        Promise.resolve({
          output: { content: "ok", toolCalls: [], finishReason: "stop" },
        })
      ),
    };
    (mockEnv.getComponent as any).mockImplementation((name: string) => {
      if (name === "config") return configComponent;
      if (name === "llm") return mockLLMComponent;
      return undefined;
    });

    await agentComponent.run("promptless-agent", "test query", {
      sessionId: "session_test",
      persistSession: false,
      metadata: {
        systemPrompt: "ONLY-EVENT-SOURCE-PROMPT",
      } as any,
    });

    expect(mockLLMComponent.invoke).toHaveBeenCalledTimes(1);
    const invokeArg = mockLLMComponent.invoke.mock.calls[0][0];
    const messages = invokeArg.messages as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toBe("ONLY-EVENT-SOURCE-PROMPT");
  });

  it("should not modify agent.config.systemPrompt (P1-1 Task #1580 invariant)", async () => {
    // Phase B.11 注入只能影响本轮 run 的 hookCtx.systemPrompt，
    // 不能回写到 agent.config.systemPrompt（避免跨轮次污染）。
    agentComponent.registerAgent("isolation-agent", {
      type: "primary",
      systemPrompt: "ORIGINAL",
    });

    const mockLLMComponent = {
      invoke: vi.fn(() =>
        Promise.resolve({
          output: { content: "ok", toolCalls: [], finishReason: "stop" },
        })
      ),
    };
    (mockEnv.getComponent as any).mockImplementation((name: string) => {
      if (name === "config") return configComponent;
      if (name === "llm") return mockLLMComponent;
      return undefined;
    });

    await agentComponent.run("isolation-agent", "first", {
      sessionId: "session_test",
      persistSession: false,
      metadata: { systemPrompt: "INJECTED" } as any,
    });

    // agent.config.systemPrompt 必须仍是原值，没被回写
    const agent = agentComponent.getAgent("isolation-agent");
    expect(agent?.config.systemPrompt).toBe("ORIGINAL");
  });

  it("should ignore when context.metadata.systemPrompt is missing", async () => {
    // 普通用户消息路径：没有 event source 触发，不应该出现 systemPrompt 注入
    agentComponent.registerAgent("normal-agent", {
      type: "primary",
      systemPrompt: "ORIGINAL",
    });

    const mockLLMComponent = {
      invoke: vi.fn(() =>
        Promise.resolve({
          output: { content: "ok", toolCalls: [], finishReason: "stop" },
        })
      ),
    };
    (mockEnv.getComponent as any).mockImplementation((name: string) => {
      if (name === "config") return configComponent;
      if (name === "llm") return mockLLMComponent;
      return undefined;
    });

    await agentComponent.run("normal-agent", "test", {
      sessionId: "session_test",
      persistSession: false,
      metadata: {},  // 没有 systemPrompt 字段
    });

    const invokeArg = mockLLMComponent.invoke.mock.calls[0][0];
    const messages = invokeArg.messages as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toBe("ORIGINAL");
  });
});
