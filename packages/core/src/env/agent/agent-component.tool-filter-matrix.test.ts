/**
 * @fileoverview Tool Filter Matrix Tests for AgentComponent
 *
 * 覆盖目标 (Task #2024)：
 * 验证 AgentComponent.getAvailableTools() 在所有 (agentType × toolSource × filter) 组合下
 * 都正确消费 registerAgent() 传入的 allowedTools / deniedTools。
 *
 * 设计矩阵：
 *   toolSource ∈ { setDefaultTools, toolComponent.listTools, AgentContext.extraTools }
 *   filter ∈ { allowedTools, deniedTools, both, contextOverride }
 *   agentType ∈ { primary, sub, workflow }
 *
 * Bug 假设：
 *   1. 某些 registerAgent 调用路径漏传 allowedTools / deniedTools
 *   2. AgentContext.allowedTools 不能覆盖 agent.config.allowedTools
 *   3. allowedTools + deniedTools 同时设置时组合逻辑错乱
 *   4. toolComponent 路径的过滤缺失
 *   5. AgentRegistry → AgentComponent 的传递链路丢字段
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentComponent } from "./agent-component";
import type { AgentContext } from "./types";
import type { Environment } from "../interface";
import type { Tool, ToolListFilter } from "../tool/types";
import { ToolComponent } from "../tool/tool-component";
import { ConfigComponent } from "../../config/config-component";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

// ============================================================================
// Test Fixtures
// ============================================================================

/** 标准工具集（默认路径 + 组件路径 都使用同一组以便对比） */
const TOOL_NAMES = ["tool_a", "tool_b", "tool_c", "tool_d", "tool_e"];

function makeTool(name: string): Tool {
  return {
    name,
    description: `test tool ${name}`,
    execute: vi.fn(() => Promise.resolve({ success: true, output: `${name}_result` })),
  } as unknown as Tool;
}

function makeTools(names: string[]): Tool[] {
  return names.map(makeTool);
}

/** Mock ToolComponent：listTools 返回给定工具集，可被 allowedAgent 等 filter 影响 */
function makeMockToolComponent(tools: Tool[]): ToolComponent {
  return {
    listTools: vi.fn((_filter?: ToolListFilter) => {
      // 模拟真实的 listTools：返回传入的工具集（不做额外过滤，保持简单）
      return tools;
    }),
    getTool: vi.fn((name: string) => tools.find(t => t.name === name)),
    execute: vi.fn(),
  } as unknown as ToolComponent;
}

/** Mock Environment with configComponent + (optional) toolComponent */
function makeMockEnv(configComponent: ConfigComponent, toolComponent?: ToolComponent): Environment {
  return {
    name: "test-env",
    version: "1.0.0",
    getConfig: vi.fn(() => ({ name: "test-env", version: "1.0.0", enabled: true })),
    registerComponent: vi.fn(),
    unregisterComponent: vi.fn(),
    getComponent: vi.fn((name: string) => {
      if (name === "config") return configComponent;
      if (name === "tool") return toolComponent;
      return undefined;
    }),
    hasComponent: vi.fn((name: string) => name === "config" || (!!toolComponent && name === "tool")),
    listComponents: vi.fn(() => []),
    handle_query: vi.fn(),
    handle_action: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    subscribeTo: vi.fn(() => () => {}),
    subscribeAll: vi.fn(() => () => {}),
    pushEnvEvent: vi.fn(),
  } as unknown as Environment;
}

async function initAgentComponent(
  agentComponent: AgentComponent,
  env: Environment,
  configComponent: ConfigComponent,
) {
  await agentComponent.init({
    name: "agent",
    version: "1.0.0",
    enabled: true,
    env,
    options: { configComponent },
  });
}

// ============================================================================
// Test Suite
// ============================================================================

describe("AgentComponent.getAvailableTools() - Tool Filter Matrix (Task #2024)", () => {
  let agentComponent: AgentComponent;
  let configComponent: ConfigComponent;
  let mockEnv: Environment;
  let tempDir: string;
  let emptyAgentsDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    agentComponent = new AgentComponent();
    configComponent = new ConfigComponent();

    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-filter-matrix-"));
    emptyAgentsDir = path.join(tempDir, "empty-agents");
    fsSync.mkdirSync(emptyAgentsDir, { recursive: true });
    configComponent.setXdgDataHome(tempDir);
    await configComponent.set("agent.configDir", emptyAgentsDir);

    mockEnv = makeMockEnv(configComponent);
    await initAgentComponent(agentComponent, mockEnv, configComponent);
  });

  // ==========================================================================
  // Group A: toolComponent.listTools 路径的过滤
  // ==========================================================================
  describe("A. toolComponent.listTools 路径下的过滤", () => {
    let toolComponent: ToolComponent;
    let envWithTool: Environment;

    beforeEach(() => {
      toolComponent = makeMockToolComponent(makeTools(TOOL_NAMES));
      envWithTool = makeMockEnv(configComponent, toolComponent);
    });

    it("A1: allowedTools 在 toolComponent 路径下生效（白名单）", async () => {
      const ac = new AgentComponent();
      await initAgentComponent(ac, envWithTool, configComponent);
      await ac.refreshDependencies();

      ac.registerAgent("a1-agent", {
        type: "primary",
        allowedTools: ["tool_a", "tool_b"],
      });

      const agent = ac.getAgent("a1-agent")!;
      const tools = ac.getAvailableTools(agent);
      const names = tools.map(t => t.name).sort();

      expect(names).toEqual(["tool_a", "tool_b"]);
    });

    it("A2: deniedTools 在 toolComponent 路径下生效（黑名单）", async () => {
      const ac = new AgentComponent();
      await initAgentComponent(ac, envWithTool, configComponent);
      await ac.refreshDependencies();

      ac.registerAgent("a2-agent", {
        type: "primary",
        deniedTools: ["tool_c", "tool_d"],
      });

      const agent = ac.getAgent("a2-agent")!;
      const tools = ac.getAvailableTools(agent);
      const names = tools.map(t => t.name).sort();

      expect(names).toEqual(["tool_a", "tool_b", "tool_e"]);
    });

    it("A3: 同时设 allowedTools + deniedTools 时，allowedTools 先生效，deniedTools 再过滤", async () => {
      const ac = new AgentComponent();
      await initAgentComponent(ac, envWithTool, configComponent);
      await ac.refreshDependencies();

      ac.registerAgent("a3-agent", {
        type: "primary",
        allowedTools: ["tool_a", "tool_b", "tool_c"],
        deniedTools: ["tool_b"],
      });

      const agent = ac.getAgent("a3-agent")!;
      const tools = ac.getAvailableTools(agent);
      const names = tools.map(t => t.name).sort();

      // tool_b 先被 allowedTools 允许，再被 deniedTools 排除 → 应只有 tool_a, tool_c
      expect(names).toEqual(["tool_a", "tool_c"]);
    });

    it("A4: 无任何过滤时返回 toolComponent 提供的全部工具", async () => {
      const ac = new AgentComponent();
      await initAgentComponent(ac, envWithTool, configComponent);
      await ac.refreshDependencies();

      ac.registerAgent("a4-agent", { type: "primary" });

      const agent = ac.getAgent("a4-agent")!;
      const tools = ac.getAvailableTools(agent);
      const names = tools.map(t => t.name).sort();

      expect(names).toEqual([...TOOL_NAMES].sort());
    });
  });

  // ==========================================================================
  // Group B: AgentContext 覆盖 agent.config 优先级
  // ==========================================================================
  describe("B. AgentContext 覆盖 agent.config 优先级", () => {
    let toolComponent: ToolComponent;
    let envWithTool: Environment;

    beforeEach(() => {
      toolComponent = makeMockToolComponent(makeTools(TOOL_NAMES));
      envWithTool = makeMockEnv(configComponent, toolComponent);
    });

    it("B1: context.allowedTools 覆盖 agent.config.allowedTools", async () => {
      const ac = new AgentComponent();
      await initAgentComponent(ac, envWithTool, configComponent);
      await ac.refreshDependencies();

      ac.registerAgent("b1-agent", {
        type: "primary",
        allowedTools: ["tool_a", "tool_b"],  // agent.config.allowedTools
      });

      const agent = ac.getAgent("b1-agent")!;
      const ctx: AgentContext = {
        sessionId: "test-session",
        allowedTools: ["tool_d", "tool_e"],  // context 覆盖
      };

      const tools = ac.getAvailableTools(agent, ctx);
      const names = tools.map(t => t.name).sort();

      // context 应当覆盖 config
      expect(names).toEqual(["tool_d", "tool_e"]);
    });

    it("B2: context.deniedTools 覆盖 agent.config.deniedTools", async () => {
      const ac = new AgentComponent();
      await initAgentComponent(ac, envWithTool, configComponent);
      await ac.refreshDependencies();

      ac.registerAgent("b2-agent", {
        type: "primary",
        deniedTools: ["tool_a", "tool_b"],
      });

      const agent = ac.getAgent("b2-agent")!;
      const ctx: AgentContext = {
        sessionId: "test-session",
        deniedTools: ["tool_d"],  // context 覆盖
      };

      const tools = ac.getAvailableTools(agent, ctx);
      const names = tools.map(t => t.name).sort();

      expect(names).toEqual(["tool_a", "tool_b", "tool_c", "tool_e"]);
    });

    it("B3: context 中同时给 allowedTools 和 deniedTools 应一并生效", async () => {
      const ac = new AgentComponent();
      await initAgentComponent(ac, envWithTool, configComponent);
      await ac.refreshDependencies();

      ac.registerAgent("b3-agent", { type: "primary" });

      const agent = ac.getAgent("b3-agent")!;
      const ctx: AgentContext = {
        sessionId: "test-session",
        allowedTools: ["tool_a", "tool_b", "tool_c"],
        deniedTools: ["tool_b"],
      };

      const tools = ac.getAvailableTools(agent, ctx);
      const names = tools.map(t => t.name).sort();

      expect(names).toEqual(["tool_a", "tool_c"]);
    });

    it("B4: context.allowedTools = [] 覆盖 config 的 allowedTools，强制空列表", async () => {
      const ac = new AgentComponent();
      await initAgentComponent(ac, envWithTool, configComponent);
      await ac.refreshDependencies();

      ac.registerAgent("b4-agent", {
        type: "primary",
        allowedTools: ["tool_a", "tool_b"],
      });

      const agent = ac.getAgent("b4-agent")!;
      const ctx: AgentContext = {
        sessionId: "test-session",
        allowedTools: [],  // 空数组覆盖
      };

      const tools = ac.getAvailableTools(agent, ctx);

      expect(tools).toHaveLength(0);
    });

    it("B5: 无 context 时使用 agent.config 的过滤", async () => {
      const ac = new AgentComponent();
      await initAgentComponent(ac, envWithTool, configComponent);
      await ac.refreshDependencies();

      ac.registerAgent("b5-agent", {
        type: "primary",
        allowedTools: ["tool_a"],
      });

      const agent = ac.getAgent("b5-agent")!;
      const tools = ac.getAvailableTools(agent);  // 无 context

      expect(tools.map(t => t.name)).toEqual(["tool_a"]);
    });
  });

  // ==========================================================================
  // Group C: agentType 矩阵
  // ==========================================================================
  describe("C. agentType 矩阵 (primary / sub / workflow)", () => {
    let toolComponent: ToolComponent;
    let envWithTool: Environment;

    beforeEach(() => {
      toolComponent = makeMockToolComponent(makeTools(TOOL_NAMES));
      envWithTool = makeMockEnv(configComponent, toolComponent);
    });

    it("C1: type=primary + allowedTools 白名单生效", async () => {
      const ac = new AgentComponent();
      await initAgentComponent(ac, envWithTool, configComponent);
      await ac.refreshDependencies();

      ac.registerAgent("c1-agent", {
        type: "primary",
        allowedTools: ["tool_a", "tool_b"],
      });

      const agent = ac.getAgent("c1-agent")!;
      const tools = ac.getAvailableTools(agent);

      expect(tools.map(t => t.name).sort()).toEqual(["tool_a", "tool_b"]);
    });

    it("C2: type=sub + deniedTools 黑名单生效", async () => {
      const ac = new AgentComponent();
      await initAgentComponent(ac, envWithTool, configComponent);
      await ac.refreshDependencies();

      ac.registerAgent("c2-agent", {
        type: "sub",
        deniedTools: ["tool_c"],
      });

      const agent = ac.getAgent("c2-agent")!;
      const tools = ac.getAvailableTools(agent);

      expect(tools.map(t => t.name).sort()).toEqual(["tool_a", "tool_b", "tool_d", "tool_e"]);
    });

    it("C3: type=summary + allowedTools 白名单生效（限制 summary agent 工具范围）", async () => {
      const ac = new AgentComponent();
      await initAgentComponent(ac, envWithTool, configComponent);
      await ac.refreshDependencies();

      ac.registerAgent("c3-agent", {
        type: "summary",
        allowedTools: ["tool_a", "tool_b"],
      });

      const agent = ac.getAgent("c3-agent")!;
      const tools = ac.getAvailableTools(agent);

      expect(tools.map(t => t.name).sort()).toEqual(["tool_a", "tool_b"]);
    });

    it("C4: type=summary + allowedTools 提供的工作流工具被允许", async () => {
      const wfToolComp = makeMockToolComponent([
        ...makeTools(TOOL_NAMES),
        makeTool("workflow_get"),
        makeTool("workflow_list"),
      ]);
      const envWF = makeMockEnv(configComponent, wfToolComp);

      const ac = new AgentComponent();
      await initAgentComponent(ac, envWF, configComponent);
      await ac.refreshDependencies();

      ac.registerAgent("c4-agent", {
        type: "summary",
        allowedTools: ["workflow_get", "workflow_list"],
      });

      const agent = ac.getAgent("c4-agent")!;
      const tools = ac.getAvailableTools(agent);

      expect(tools.map(t => t.name).sort()).toEqual(["workflow_get", "workflow_list"]);
    });
  });

  // ==========================================================================
  // Group D: AgentRegistry → AgentComponent 链路
  // ==========================================================================
  describe("D. AgentRegistry → AgentComponent 传递链路", () => {
    let toolComponent: ToolComponent;
    let envWithTool: Environment;

    beforeEach(() => {
      toolComponent = makeMockToolComponent(makeTools(TOOL_NAMES));
      envWithTool = makeMockEnv(configComponent, toolComponent);
    });

    it("D1: AgentRegistry 中定义 allowedTools，注册到 AgentComponent 后生效", async () => {
      const ac = new AgentComponent();
      await initAgentComponent(ac, envWithTool, configComponent);
      await ac.refreshDependencies();

      // 通过 AgentRegistry.register() 注册一个带 allowedTools 的 agent
      const registry = ac.getRegistry();
      expect(registry).toBeDefined();

      // 直接用 AgentRegistry 接口测试更纯粹
      registry!.register({
        name: "d1-registry-agent",
        type: "sub",
        systemPrompt: "test prompt",
        allowedTools: ["tool_a", "tool_c"],
        deniedTools: [],
      });

      // 模拟 AgentComponent 的初始化流程：把 registry agent 注册到 component
      const agentDef = registry!.get("d1-registry-agent");
      expect(agentDef).toBeDefined();
      expect(agentDef?.allowedTools).toEqual(["tool_a", "tool_c"]);

      ac.registerAgent("d1-registry-agent", {
        type: agentDef!.type as "primary" | "sub",
        systemPrompt: agentDef!.systemPrompt,
        allowedTools: agentDef!.allowedTools,
        deniedTools: agentDef!.deniedTools,
      });

      const agent = ac.getAgent("d1-registry-agent")!;
      const tools = ac.getAvailableTools(agent);

      expect(tools.map(t => t.name).sort()).toEqual(["tool_a", "tool_c"]);
    });

    it("D2: AgentRegistry 中定义 deniedTools，注册到 AgentComponent 后生效", async () => {
      const ac = new AgentComponent();
      await initAgentComponent(ac, envWithTool, configComponent);
      await ac.refreshDependencies();

      const registry = ac.getRegistry();
      registry!.register({
        name: "d2-registry-agent",
        type: "sub",
        systemPrompt: "test prompt",
        allowedTools: undefined,
        deniedTools: ["tool_b", "tool_d"],
      });

      const agentDef = registry!.get("d2-registry-agent");
      ac.registerAgent("d2-registry-agent", {
        type: agentDef!.type as "primary" | "sub",
        systemPrompt: agentDef!.systemPrompt,
        allowedTools: agentDef!.allowedTools,
        deniedTools: agentDef!.deniedTools,
      });

      const agent = ac.getAgent("d2-registry-agent")!;
      const tools = ac.getAvailableTools(agent);

      expect(tools.map(t => t.name).sort()).toEqual(["tool_a", "tool_c", "tool_e"]);
    });

    it("D3: AgentRegistry 同时定义 allowedTools + deniedTools，注册后组合生效", async () => {
      const ac = new AgentComponent();
      await initAgentComponent(ac, envWithTool, configComponent);
      await ac.refreshDependencies();

      const registry = ac.getRegistry();
      registry!.register({
        name: "d3-registry-agent",
        type: "sub",
        systemPrompt: "test prompt",
        allowedTools: ["tool_a", "tool_b", "tool_c"],
        deniedTools: ["tool_b"],
      });

      const agentDef = registry!.get("d3-registry-agent");
      ac.registerAgent("d3-registry-agent", {
        type: (agentDef!.type === "workflow" ? "sub" : agentDef!.type) as "primary" | "sub",
        systemPrompt: agentDef!.systemPrompt,
        allowedTools: agentDef!.allowedTools,
        deniedTools: agentDef!.deniedTools,
      });

      const agent = ac.getAgent("d3-registry-agent")!;
      const tools = ac.getAvailableTools(agent);

      expect(tools.map(t => t.name).sort()).toEqual(["tool_a", "tool_c"]);
    });
  });

  // ==========================================================================
  // Group E: 边界情况
  // ==========================================================================
  describe("E. 边界情况", () => {
    let toolComponent: ToolComponent;
    let envWithTool: Environment;

    beforeEach(() => {
      toolComponent = makeMockToolComponent(makeTools(TOOL_NAMES));
      envWithTool = makeMockEnv(configComponent, toolComponent);
    });

    it("E1: deniedTools = [] (空数组) 不应过滤任何工具", async () => {
      const ac = new AgentComponent();
      await initAgentComponent(ac, envWithTool, configComponent);
      await ac.refreshDependencies();

      ac.registerAgent("e1-agent", {
        type: "primary",
        deniedTools: [],
      });

      const agent = ac.getAgent("e1-agent")!;
      const tools = ac.getAvailableTools(agent);

      expect(tools.map(t => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    });

    it("E2: allowedTools 引用的工具不存在时，结果为空数组", async () => {
      const ac = new AgentComponent();
      await initAgentComponent(ac, envWithTool, configComponent);
      await ac.refreshDependencies();

      ac.registerAgent("e2-agent", {
        type: "primary",
        allowedTools: ["nonexistent_tool"],
      });

      const agent = ac.getAgent("e2-agent")!;
      const tools = ac.getAvailableTools(agent);

      expect(tools).toHaveLength(0);
    });

    it("E3: registerAgent 不传 allowedTools 也不传 deniedTools 时，返回全部工具", async () => {
      const ac = new AgentComponent();
      await initAgentComponent(ac, envWithTool, configComponent);
      await ac.refreshDependencies();

      ac.registerAgent("e3-agent", { type: "primary" });

      const agent = ac.getAgent("e3-agent")!;
      const tools = ac.getAvailableTools(agent);

      expect(tools.map(t => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    });

    it("E4: setDefaultTools + toolComponent 路径混合时，allowedTools 对两者都生效", async () => {
      const ac = new AgentComponent();
      await initAgentComponent(ac, envWithTool, configComponent);
      await ac.refreshDependencies();

      ac.setDefaultTools(makeTools(["mem_tool_a", "mem_tool_b"]));

      ac.registerAgent("e4-agent", {
        type: "primary",
        allowedTools: ["tool_a", "mem_tool_a"],
      });

      const agent = ac.getAgent("e4-agent")!;
      const tools = ac.getAvailableTools(agent);
      const names = tools.map(t => t.name).sort();

      expect(names).toEqual(["mem_tool_a", "tool_a"]);
    });

    it("E5: AgentContext.extraTools 不受 allowedTools 过滤影响（按实现语义）", async () => {
      const ac = new AgentComponent();
      await initAgentComponent(ac, envWithTool, configComponent);
      await ac.refreshDependencies();

      ac.registerAgent("e5-agent", {
        type: "primary",
        allowedTools: ["tool_a"],  // 严格白名单
      });

      const agent = ac.getAgent("e5-agent")!;
      const extraTool = makeTool("extra_tool");
      const ctx: AgentContext = {
        sessionId: "test-session",
        extraTools: [extraTool],  // context 级额外工具
      };

      const tools = ac.getAvailableTools(agent, ctx);
      const names = tools.map(t => t.name).sort();

      // 实现：allowedTools 过滤 componentTools + defaultTools，
      // 然后 extraTools 追加（不受 allowedTools 过滤）
      // 所以结果应是 ["extra_tool", "tool_a"]
      expect(names).toEqual(["extra_tool", "tool_a"]);
    });
  });
});