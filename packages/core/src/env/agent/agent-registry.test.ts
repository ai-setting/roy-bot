/**
 * @fileoverview AgentRegistry 测试
 * 
 * TDD: 先写测试，再实现功能
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { AgentRegistry, AgentDefinition, DEFAULT_SUBAGENT_PROMPT, AgentConfigSchema } from "./agent-registry";

// Mock fs objects passed via constructor DI
const mockFs = {
  existsSync: vi.fn(),
};
const mockFsPromises = {
  readdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  unlink: vi.fn(),
};

// Mock ConfigComponent
const createMockConfigComponent = (config: Record<string, unknown> = {}) => ({
  get: vi.fn((key: string) => config[key]),
  set: vi.fn(),
  registerSource: vi.fn(),
  load: vi.fn(),
  watch: vi.fn(),
});

// Mock PromptComponent
const createMockPromptComponent = () => ({
  get: vi.fn((name: string) => {
    if (name === "subagent/explore") {
      return "You are an explore agent specialized for exploring codebases.";
    }
    return undefined;
  }),
  getPrompt: vi.fn((name: string) => {
    if (name === "subagent/explore") {
      return Promise.resolve("You are an explore agent.");
    }
    return Promise.resolve(undefined);
  }),
});

describe("AgentRegistry", () => {
  let registry: AgentRegistry;
  let mockConfigComponent: any;
  let mockPromptComponent: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFsPromises.readdir.mockReset();
    mockFsPromises.readFile.mockReset();
    mockFsPromises.writeFile.mockReset();
    mockFsPromises.mkdir.mockReset();
    mockFsPromises.unlink.mockReset();
    mockFs.existsSync.mockReset();
    mockFs.existsSync.mockReturnValue(false);
    
    mockConfigComponent = createMockConfigComponent({
      "agent.configDir": "",
    });
    
    mockPromptComponent = createMockPromptComponent();
    
    registry = new AgentRegistry({
      configComponent: mockConfigComponent,
      promptComponent: mockPromptComponent as any,
      baseDir: "/tmp/test-roy-bot",
      fs: mockFs,
      fsPromises: mockFsPromises,
    });
  });

  describe("constructor", () => {
    it("should create AgentRegistry instance", () => {
      expect(registry).toBeDefined();
      expect(registry).toBeInstanceOf(AgentRegistry);
    });

    it("should use default config dir when not specified", () => {
      const r = new AgentRegistry({
        configComponent: mockConfigComponent,
        promptComponent: mockPromptComponent as any,
        baseDir: "/tmp/test",
        fs: mockFs,
        fsPromises: mockFsPromises,
      });
      // baseDir 会拼接 roy-bot/agents
      // baseDir 直接拼接 agents（不使用 getXDGPath）
      expect(r.getConfigDir()).toBe("/tmp/test/agents");
    });

    it("should use custom config dir when specified", () => {
      const customConfig = createMockConfigComponent({
        "agent.configDir": "/custom/path/agents",
      });
      
      const r = new AgentRegistry({
        configComponent: customConfig,
        promptComponent: mockPromptComponent as any,
        baseDir: "/tmp/test",
        fs: mockFs,
        fsPromises: mockFsPromises,
      });
      expect(r.getConfigDir()).toBe("/custom/path/agents");
    });
  });

  describe("list()", () => {
    it("should return empty array initially", () => {
      expect(registry.list()).toEqual([]);
    });
  });

  describe("get()", () => {
    it("should return undefined for non-existent agent", () => {
      expect(registry.get("non-existent")).toBeUndefined();
    });
  });

  describe("register()", () => {
    it("should register a new agent", () => {
      const agent: AgentDefinition = {
        name: "test-agent",
        type: "sub",
        description: "Test agent",
        systemPrompt: "You are a test agent.",
      };
      
      registry.register(agent);
      
      const retrieved = registry.get("test-agent");
      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe("test-agent");
      expect(retrieved?.type).toBe("sub");
    });

    it("should allow updating existing agent", () => {
      const agent1: AgentDefinition = {
        name: "test-agent",
        type: "sub",
        systemPrompt: "Version 1",
      };
      
      const agent2: AgentDefinition = {
        name: "test-agent",
        type: "sub",
        systemPrompt: "Version 2",
      };
      
      registry.register(agent1);
      registry.register(agent2);
      
      const retrieved = registry.get("test-agent");
      expect(retrieved?.systemPrompt).toBe("Version 2");
    });
  });

  describe("unregister()", () => {
    it("should unregister existing agent", () => {
      const agent: AgentDefinition = {
        name: "test-agent",
        type: "sub",
      };
      
      registry.register(agent);
      expect(registry.get("test-agent")).toBeDefined();
      
      const result = registry.unregister("test-agent");
      expect(result).toBe(true);
      expect(registry.get("test-agent")).toBeUndefined();
    });

    it("should return false for non-existent agent", () => {
      const result = registry.unregister("non-existent");
      expect(result).toBe(false);
    });
  });

  describe("listAgentsByType()", () => {
    it("should list agents by type", () => {
      registry.register({ name: "primary-agent", type: "primary" });
      registry.register({ name: "sub-agent-1", type: "sub" });
      registry.register({ name: "sub-agent-2", type: "sub" });
      
      const primaryAgents = registry.listAgentsByType("primary");
      const subAgents = registry.listAgentsByType("sub");
      
      expect(primaryAgents).toHaveLength(1);
      expect(primaryAgents[0].name).toBe("primary-agent");
      
      expect(subAgents).toHaveLength(2);
      expect(subAgents.map(a => a.name)).toContain("sub-agent-1");
      expect(subAgents.map(a => a.name)).toContain("sub-agent-2");
    });
  });

  describe("getSystemPrompt()", () => {
    it("should return inline systemPrompt as-is", async () => {
      registry.register({
        name: "test-agent",
        type: "sub",
        systemPrompt: "You are a test agent.",
      });
      
      const prompt = await registry.getSystemPrompt("test-agent");
      expect(prompt).toBe("You are a test agent.");
    });

    it("should resolve systemPromptRef from PromptComponent", async () => {
      registry.register({
        name: "explore-agent",
        type: "sub",
        systemPromptRef: "subagent/explore",
      });
      
      const prompt = await registry.getSystemPrompt("explore-agent");
      // getPrompt() 优先于 get()，因为 getPrompt() 触发 render() + hooks
      expect(prompt).toBe("You are an explore agent.");
    });

    it("should resolve systemPromptRef via lazy prompt resolver", async () => {
      const lazyRegistry = new AgentRegistry({
        configComponent: mockConfigComponent,
        resolvePromptComponent: () => mockPromptComponent as any,
        fs: mockFs,
        fsPromises: mockFsPromises,
      });
      lazyRegistry.register({
        name: "lazy-agent",
        type: "sub",
        systemPromptRef: "subagent/explore",
      });

      const prompt = await lazyRegistry.getSystemPrompt("lazy-agent");
      // getPrompt() 优先于 get()，因为 getPrompt() 触发 render() + hooks
      expect(prompt).toBe("You are an explore agent.");
    });

    it("should return undefined for non-existent agent", async () => {
      const prompt = await registry.getSystemPrompt("non-existent");
      expect(prompt).toBeUndefined();
    });

    it("should prefer systemPromptRef when both are specified", async () => {
      registry.register({
        name: "test-agent",
        type: "sub",
        systemPrompt: "Inline prompt.",
        systemPromptRef: "subagent/explore",
      });
      
      const prompt = await registry.getSystemPrompt("test-agent");
      // 根据设计，优先使用 systemPromptRef
      // getPrompt() 优先于 get()，因为 getPrompt() 触发 render() + hooks
      expect(prompt).toBe("You are an explore agent.");
    });

    it("should fall back to inline when systemPromptRef not found", async () => {
      registry.register({
        name: "test-agent",
        type: "sub",
        systemPrompt: "Inline fallback.",
        systemPromptRef: "non-existent/prompt",
      });
      
      const prompt = await registry.getSystemPrompt("test-agent");
      expect(prompt).toBe("Inline fallback.");
    });
  });

  describe("loadFromDirectory()", () => {
    it("should load YAML files from directory", async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFsPromises.readdir.mockResolvedValueOnce([
        { isFile: () => true, isDirectory: () => false, name: "explore.yaml" },
      ] as any);
      
      mockFsPromises.readFile.mockResolvedValueOnce(`
name: explore
type: sub
description: Explore agent
systemPromptRef: subagent/explore
allowedTools:
  - glob
  - grep
deniedTools:
  - delegate_task
`);
      
      mockFs.existsSync.mockResolvedValueOnce(true);
      const loaded = await registry.loadFromDirectory("/tmp/agents");
      
      expect(loaded).toBe(1);
      const agent = registry.get("explore");
      expect(agent).toBeDefined();
      expect(agent?.name).toBe("explore");
      expect(agent?.type).toBe("sub");
      expect(agent?.systemPromptRef).toBe("subagent/explore");
      expect(agent?.allowedTools).toEqual(["glob", "grep"]);
    });

    it("should skip non-YAML files", async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFsPromises.readdir.mockResolvedValueOnce([
        { isFile: () => true, isDirectory: () => false, name: "explore.yaml" },
        { isFile: () => true, isDirectory: () => false, name: "readme.md" },
        { isFile: () => true, isDirectory: () => false, name: "explore.json" },
      ] as any);
      
      mockFsPromises.readFile.mockResolvedValueOnce(`
name: explore
type: sub
`);
      
      mockFs.existsSync.mockReturnValueOnce(true);
      const loaded = await registry.loadFromDirectory("/tmp/agents");
      
      expect(loaded).toBe(1);
    });

    it("should return 0 when directory does not exist", async () => {
      mockFsPromises.readdir.mockRejectedValueOnce(new Error("ENOENT"));
      
      const loaded = await registry.loadFromDirectory("/non/existent");
      
      expect(loaded).toBe(0);
    });

    it("should parse multiline systemPrompt block scalar", async () => {
      registry.clear();
      mockFs.existsSync.mockReturnValue(true);
      mockFsPromises.readdir.mockResolvedValueOnce([
        { isFile: () => true, isDirectory: () => false, name: "custom.yaml" },
      ] as any);

      mockFsPromises.readFile.mockResolvedValueOnce(`
name: custom
type: sub
systemPrompt: |
  Line one
  Line two
`);

      const loaded = await registry.loadFromDirectory("/tmp/agents");

      expect(loaded).toBe(1);
      const agent = registry.get("custom");
      expect(agent?.systemPrompt).toBe("Line one\nLine two\n");
    });

    it("should round-trip save and load multiline systemPrompt", async () => {
      registry.clear();
      mockFs.existsSync.mockReturnValue(true);
      mockFsPromises.writeFile.mockResolvedValue(undefined);

      const agent: AgentDefinition = {
        name: "roundtrip",
        type: "sub",
        systemPrompt: "First line\nSecond line",
      };

      await registry.saveAgent(agent);

      const written = mockFsPromises.writeFile.mock.calls[0][1] as string;
      mockFsPromises.readdir.mockResolvedValueOnce([
        { isFile: () => true, isDirectory: () => false, name: "roundtrip.yaml" },
      ] as any);
      mockFsPromises.readFile.mockResolvedValueOnce(written);

      const freshRegistry = new AgentRegistry({
        configComponent: mockConfigComponent,
        promptComponent: mockPromptComponent as any,
        baseDir: "/tmp/test-roy-bot",
        fs: mockFs,
        fsPromises: mockFsPromises,
      });
      const loaded = await freshRegistry.loadFromDirectory("/tmp/test-roy-bot/agents");

      expect(loaded).toBe(1);
      expect(freshRegistry.get("roundtrip")?.systemPrompt).toBe("First line\nSecond line");
    });

    it("should skip invalid YAML without registering agent", async () => {
      registry.clear();
      mockFs.existsSync.mockReturnValue(true);
      mockFsPromises.readdir.mockResolvedValueOnce([
        { isFile: () => true, isDirectory: () => false, name: "bad.yaml" },
      ] as any);
      mockFsPromises.readFile.mockResolvedValueOnce("name: broken\ntype: invalid-type\n");

      const loaded = await registry.loadFromDirectory("/tmp/agents");

      expect(loaded).toBe(0);
      expect(registry.get("broken")).toBeUndefined();
    });
  });

  describe("saveAgent()", () => {
    it("should save agent to YAML file", async () => {
      mockFs.existsSync.mockReturnValueOnce(true);
      mockFsPromises.writeFile.mockResolvedValueOnce(undefined);
      
      const agent: AgentDefinition = {
        name: "new-agent",
        type: "sub",
        description: "A new agent",
        systemPrompt: "You are new.",
      };
      
      const saved = await registry.saveAgent(agent);
      
      expect(saved).toBe(true);
      expect(mockFsPromises.writeFile).toHaveBeenCalled();
      
      const writeCall = mockFsPromises.writeFile.mock.calls[0];
      expect(writeCall[0]).toBe("/tmp/test-roy-bot/agents/new-agent.yaml");
      
      // Verify YAML content
      const content = writeCall[1] as string;
      expect(content).toContain("name: new-agent");
      expect(content).toContain("type: sub");
      expect(content).toContain("description: A new agent");
      expect(content).toContain("systemPrompt:");
      expect(content).toContain("You are new.");
    });

    it("should create directory if not exists", async () => {
      mockFs.existsSync.mockReturnValueOnce(false);
      mockFsPromises.mkdir.mockResolvedValueOnce(undefined);
      mockFsPromises.writeFile.mockResolvedValueOnce(undefined);
      
      const agent: AgentDefinition = {
        name: "new-agent",
        type: "sub",
      };
      
      await registry.saveAgent(agent);
      
      // mkdir should be called with parents option
      expect(mockFsPromises.mkdir).toHaveBeenCalled();
    });
  });

  describe("deleteAgent()", () => {
    it("should delete agent file", async () => {
      registry.register({ name: "explore", type: "sub" });
      mockFs.existsSync.mockReturnValueOnce(true);
      mockFsPromises.unlink.mockResolvedValueOnce(undefined);
      
      const deleted = await registry.deleteAgent("explore");
      
      expect(deleted).toBe(true);
      expect(mockFsPromises.unlink).toHaveBeenCalledWith("/tmp/test-roy-bot/agents/explore.yaml");
      expect(registry.get("explore")).toBeUndefined();
    });

    it("should return false for non-existent agent", async () => {
      const deleted = await registry.deleteAgent("non-existent");
      expect(deleted).toBe(false);
    });
  });

  describe("hasAgent()", () => {
    it("should return true for existing agent", () => {
      registry.register({ name: "test-agent", type: "sub" });
      expect(registry.hasAgent("test-agent")).toBe(true);
    });

    it("should return false for non-existing agent", () => {
      expect(registry.hasAgent("non-existent")).toBe(false);
    });
  });

  describe("clear()", () => {
    it("should clear all registered agents", () => {
      registry.register({ name: "agent-1", type: "sub" });
      registry.register({ name: "agent-2", type: "sub" });
      
      expect(registry.list()).toHaveLength(2);
      
      registry.clear();
      
      expect(registry.list()).toHaveLength(0);
    });
  });

  describe("exportAgents()", () => {
    it("should export all agents as array", () => {
      registry.register({ name: "agent-1", type: "sub", description: "First" });
      registry.register({ name: "agent-2", type: "primary", description: "Second" });
      
      const exported = registry.exportAgents();
      
      expect(exported).toHaveLength(2);
      expect(exported[0].name).toBe("agent-1");
      expect(exported[1].name).toBe("agent-2");
    });

    it("should export as JSON string", () => {
      registry.register({ name: "agent-1", type: "sub" });
      
      const exported = registry.exportAgentsAsJson();
      
      expect(typeof exported).toBe("string");
      const parsed = JSON.parse(exported);
      expect(parsed).toHaveLength(1);
    });
  });

  describe("getAgentFilePath()", () => {
    it("should return correct file path", () => {
      const filePath = registry.getAgentFilePath("test-agent");
      expect(filePath).toBe("/tmp/test-roy-bot/agents/test-agent.yaml");
    });
  });

  describe("configDirExists()", () => {
    it("should return true when directory exists", () => {
      mockFs.existsSync.mockReturnValueOnce(true);
      expect(registry.configDirExists()).toBe(true);
    });

    it("should return false when directory does not exist", () => {
      mockFs.existsSync.mockReturnValueOnce(false);
      expect(registry.configDirExists()).toBe(false);
    });
  });

  describe("size()", () => {
    it("should return correct size", () => {
      expect(registry.size()).toBe(0);
      registry.register({ name: "agent-1", type: "sub" });
      expect(registry.size()).toBe(1);
      registry.register({ name: "agent-2", type: "sub" });
      expect(registry.size()).toBe(2);
    });
  });
});

describe("AgentDefinition interface", () => {
  it("should have required fields", () => {
    const agent: AgentDefinition = {
      name: "test",
      type: "sub",
    };
    
    expect(agent.name).toBe("test");
    expect(agent.type).toBe("sub");
  });

  it("should allow optional fields", () => {
    const agent: AgentDefinition = {
      name: "test",
      type: "primary",
      description: "Test description",
      systemPromptRef: "my/prompt",
      systemPrompt: "Inline prompt",
      model: "gpt-4",
      maxIterations: 100,
      allowedTools: ["tool1", "tool2"],
      deniedTools: ["tool3"],
    };
    
    expect(agent.description).toBe("Test description");
    expect(agent.systemPromptRef).toBe("my/prompt");
    expect(agent.allowedTools).toEqual(["tool1", "tool2"]);
  });
});

describe("DEFAULT_SUBAGENT_PROMPT", () => {
  it("should be a non-empty string", () => {
    expect(DEFAULT_SUBAGENT_PROMPT).toBeDefined();
    expect(typeof DEFAULT_SUBAGENT_PROMPT).toBe("string");
    expect(DEFAULT_SUBAGENT_PROMPT.length).toBeGreaterThan(0);
  });

  it("should contain key instructions", () => {
    expect(DEFAULT_SUBAGENT_PROMPT).toContain("subagent");
    expect(DEFAULT_SUBAGENT_PROMPT).toContain("task");
    expect(DEFAULT_SUBAGENT_PROMPT).toContain("delegate_task");
  });
});

describe("workflow type agent", () => {
  let workflowRegistry: AgentRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFsPromises.readdir.mockReset();
    mockFsPromises.readFile.mockReset();
    mockFsPromises.writeFile.mockReset();
    mockFsPromises.mkdir.mockReset();
    mockFsPromises.unlink.mockReset();
    mockFs.existsSync.mockReset();
    mockFs.existsSync.mockReturnValue(false);

    const mockConfig = createMockConfigComponent({ "agent.configDir": "" });
    workflowRegistry = new AgentRegistry({
      configComponent: mockConfig,
      promptComponent: createMockPromptComponent() as any,
      fs: mockFs,
      fsPromises: mockFsPromises,
    });
  });

  it("应该拒绝 type=workflow 但没有 workflow 字段的配置", () => {
    const result = AgentConfigSchema.safeParse({
      name: "bad-workflow-agent",
      type: "workflow",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("workflow");
    }
  });

  it("应该接受 type=workflow 且带有 workflow 字段的配置", () => {
    const result = AgentConfigSchema.safeParse({
      name: "weekly-report",
      type: "workflow",
      workflow: "weekly-report-workflow",
      description: "自动生成周报",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("workflow");
      expect(result.data.workflow).toBe("weekly-report-workflow");
    }
  });

  it("应该保持 primary/sub 类型向后兼容", () => {
    const primaryResult = AgentConfigSchema.safeParse({
      name: "explore", type: "primary",
    });
    expect(primaryResult.success).toBe(true);

    const subResult = AgentConfigSchema.safeParse({
      name: "explorer", type: "sub",
    });
    expect(subResult.success).toBe(true);
  });

  it("注册 workflow 类型 agent 应该包含 workflow 字段", () => {
    workflowRegistry.register({
      name: "weekly-report",
      type: "workflow",
      workflow: "weekly-report-workflow",
      description: "自动生成周报",
    });

    const agent = workflowRegistry.get("weekly-report");
    expect(agent).toBeDefined();
    expect(agent!.type).toBe("workflow");
    expect(agent!.workflow).toBe("weekly-report-workflow");
  });

  it("getWorkflowName 应该返回 workflow 字段", () => {
    workflowRegistry.register({
      name: "weekly-report",
      type: "workflow",
      workflow: "weekly-report-workflow",
    });

    const workflowName = workflowRegistry.getWorkflowName("weekly-report");
    expect(workflowName).toBe("weekly-report-workflow");
  });

  it("非 workflow 类型 agent 的 getWorkflowName 应返回 undefined", () => {
    workflowRegistry.register({
      name: "explorer",
      type: "sub",
    });

    const workflowName = workflowRegistry.getWorkflowName("explorer");
    expect(workflowName).toBeUndefined();
  });

  it("listAgentsByType('workflow') 应该只返回 workflow 类型 agent", () => {
    workflowRegistry.register({ name: "wf1", type: "workflow", workflow: "w1" });
    workflowRegistry.register({ name: "wf2", type: "workflow", workflow: "w2" });
    workflowRegistry.register({ name: "sub1", type: "sub" });

    const workflows = workflowRegistry.listAgentsByType("workflow");
    expect(workflows).toHaveLength(2);
    expect(workflows.every((a: any) => a.type === "workflow")).toBe(true);
  });

  it("register 应拒绝 type=workflow 但缺少 workflow 的配置", () => {
    expect(() =>
      workflowRegistry.register({
        name: "bad-workflow",
        type: "workflow",
      })
    ).toThrow(/workflow/i);
  });

  it("saveAgent 应拒绝无效 workflow agent 配置", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFsPromises.writeFile.mockResolvedValue(undefined);

    const saved = await workflowRegistry.saveAgent({
      name: "bad-workflow",
      type: "workflow",
    });

    expect(saved).toBe(false);
    expect(mockFsPromises.writeFile).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // TDD RED: entryAgent field (workflow subagent entry-agent pattern)
  // ==========================================================================
  // When a workflow type agent is delegated to via delegate_task, we should
  // route through an entry-agent (default: "workflow-agent") rather than
  // executing the workflow directly. The entryAgent field overrides the
  // default. See .roy/design/2026-06-29-workflow-subagent-entry-agent-design.md
  describe("entryAgent field (workflow subagent entry-agent pattern)", () => {
    it("AgentConfigSchema 应接受 type=workflow + entryAgent 字段", () => {
      const result = AgentConfigSchema.safeParse({
        name: "weekly-report",
        type: "workflow",
        workflow: "weekly-report-workflow",
        entryAgent: "custom-entry",
        description: "自动生成周报",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.entryAgent).toBe("custom-entry");
      }
    });

    it("AgentConfigSchema 应允许 entryAgent 缺省（type=workflow 也行）", () => {
      const result = AgentConfigSchema.safeParse({
        name: "weekly-report",
        type: "workflow",
        workflow: "weekly-report-workflow",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.entryAgent).toBeUndefined();
      }
    });

    it("AgentConfigSchema 应允许 type=primary/sub 也有 entryAgent 字段（不强制）", () => {
      const result = AgentConfigSchema.safeParse({
        name: "explore",
        type: "primary",
        entryAgent: "some-entry",
      });
      // entryAgent 是 workflow 路由设计，但 schema 不应限制非 workflow 类型
      // （因为这是可选覆盖字段，主要语义是 workflow 类型使用）
      // 这里我们允许任何 type 都能配置 entryAgent（向后兼容）
      expect(result.success).toBe(true);
    });

    it("register 应保留 entryAgent 字段", () => {
      workflowRegistry.register({
        name: "weekly-report",
        type: "workflow",
        workflow: "weekly-report-workflow",
        entryAgent: "custom-entry",
      });

      const agent = workflowRegistry.get("weekly-report");
      expect(agent).toBeDefined();
      expect(agent!.entryAgent).toBe("custom-entry");
    });

    it("register 应允许 entryAgent 缺省（默认 undefined）", () => {
      workflowRegistry.register({
        name: "weekly-report",
        type: "workflow",
        workflow: "weekly-report-workflow",
      });

      const agent = workflowRegistry.get("weekly-report");
      expect(agent).toBeDefined();
      expect(agent!.entryAgent).toBeUndefined();
    });

    it("getEntryAgent 应返回 entryAgent 字段", () => {
      workflowRegistry.register({
        name: "weekly-report",
        type: "workflow",
        workflow: "weekly-report-workflow",
        entryAgent: "custom-entry",
      });

      const entryAgent = workflowRegistry.getEntryAgent("weekly-report");
      expect(entryAgent).toBe("custom-entry");
    });

    it("getEntryAgent 对未配置 entryAgent 的 agent 应返回 undefined", () => {
      workflowRegistry.register({
        name: "weekly-report",
        type: "workflow",
        workflow: "weekly-report-workflow",
      });

      const entryAgent = workflowRegistry.getEntryAgent("weekly-report");
      expect(entryAgent).toBeUndefined();
    });

    it("getEntryAgent 对非 workflow 类型 agent 应返回 undefined", () => {
      workflowRegistry.register({
        name: "explorer",
        type: "sub",
        entryAgent: "should-not-apply",
      });

      const entryAgent = workflowRegistry.getEntryAgent("explorer");
      // 非 workflow 类型不应该返回 entryAgent（语义无意义）
      expect(entryAgent).toBeUndefined();
    });

    it("getEntryAgent 对不存在的 agent 应返回 undefined", () => {
      const entryAgent = workflowRegistry.getEntryAgent("nonexistent");
      expect(entryAgent).toBeUndefined();
    });
  });
});

// ============================================================================
// Built-in agent registration: task-organizer (Task #2348)
// ============================================================================
//
// task-organizer is the new built-in sub-agent specialized in
// task-tree hygiene: re-parenting non-longterm roots, merging duplicates,
// archiving/deleting obsolete tasks. The registration must:
//
// - 暴露 type="sub" 的 task-organizer agent
// - systemPromptRef 指向 "task-organizer"（builtInPrompts 里的 key）
// - allowedTools 是 15 个任务管理工具的白名单（含 task_tree / task_search /
//   task_batch_archive / task_batch_delete，与 Task #2310 的 11 工具不同）
// - id 稳定 + 重复注册幂等
//
describe("AgentRegistry.registerTaskOrganizer (Task #2348)", () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFsPromises.readdir.mockReset();
    mockFsPromises.readFile.mockReset();
    mockFsPromises.writeFile.mockReset();
    mockFsPromises.mkdir.mockReset();
    mockFsPromises.unlink.mockReset();
    mockFs.existsSync.mockReset();
    mockFs.existsSync.mockReturnValue(false);

    const mockConfig = createMockConfigComponent({ "agent.configDir": "" });
    registry = new AgentRegistry({
      configComponent: mockConfig,
      promptComponent: createMockPromptComponent() as any,
      baseDir: "/tmp/test-roy-bot-task-organizer",
      fs: mockFs,
      fsPromises: mockFsPromises,
    });
  });

  it("必须把 task-organizer 注册为 type=sub 的内置 agent", () => {
    registry.registerTaskOrganizer();

    const agent = registry.get("task-organizer");
    expect(agent).toBeDefined();
    expect(agent!.type).toBe("sub");
  });

  it("systemPromptRef 必须指向 builtInPrompts['task-organizer']", () => {
    registry.registerTaskOrganizer();

    const agent = registry.get("task-organizer");
    expect(agent!.systemPromptRef).toBe("task-organizer");
  });

  it("allowedTools 必须包含 15 个任务管理工具（含 task_tree / task_search / task_batch_*）", () => {
    registry.registerTaskOrganizer();

    const agent = registry.get("task-organizer");
    const expected = [
      "task_create", "task_get", "task_list", "task_update",
      "task_delete", "task_complete",
      "task_tree", "task_search",
      "task_batch_archive", "task_batch_delete",
      "task_operation_create", "task_operation_get", "task_operation_list",
      "task_operation_update", "task_operation_delete",
    ];
    expect(agent!.allowedTools).toEqual(expect.arrayContaining(expected));
    expect(agent!.allowedTools).toHaveLength(expected.length);
  });

  it("deniedTools 必须禁止递归委托（防止整理器自己再起子代理）", () => {
    registry.registerTaskOrganizer();

    const agent = registry.get("task-organizer");
    expect(agent!.deniedTools).toEqual(expect.arrayContaining(["delegate_task", "stop_task"]));
  });

  it("重复注册应幂等（不报错、不覆盖已有配置）", () => {
    registry.registerTaskOrganizer();
    const first = registry.get("task-organizer");

    registry.registerTaskOrganizer();
    const second = registry.get("task-organizer");

    expect(second).toBe(first);
  });
});
