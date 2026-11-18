/**
 * @fileoverview ConfigLayer Consumption Tests for allowedTools/deniedTools
 *
 * 覆盖目标 (Task #2024)：验证 defaultAgent 的 allowedTools/deniedTools 配置
 * 从以下三个来源能正确传递到 AgentComponent.registerAgent() 的 fallback：
 *   1. 环境变量 (AGENT_DEFAULT_AGENT_ALLOWED_TOOLS / AGENT_DEFAULT_AGENT_DENIED_TOOLS)
 *   2. 配置文件 (agent.defaultAgent.allowedTools / deniedTools)
 *   3. 直接 config 对象 ({ defaultAgent: { allowedTools: [...] } })
 *
 * Bug 假设：
 *   - AGENT_CONFIG_REGISTRATION.keys 缺失 allowedTools/deniedTools
 *   - this.config.defaultAgent 初始化时未读取这两个字段
 *   - 导致 registerAgent(name, { type: 'primary' }) 时 fallback 到 undefined
 *
 * 期望：以上三个来源任一设置后，未在 registerAgent() 显式传 allowedTools/deniedTools
 *      的 agent，应自动继承 defaultAgent 配置。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentComponent } from "./agent-component";
import type { Tool } from "../tool/types";
import { ToolComponent } from "../tool/tool-component";
import { ConfigComponent } from "../../config/config-component";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

// ============================================================================
// Test Helpers
// ============================================================================

function makeTool(name: string): Tool {
  return {
    name,
    description: `test tool ${name}`,
    execute: vi.fn(),
  } as unknown as Tool;
}

function makeMockToolComponent(tools: Tool[]): ToolComponent {
  return {
    listTools: vi.fn(() => tools),
    getTool: vi.fn((name: string) => tools.find(t => t.name === name)),
    execute: vi.fn(),
  } as unknown as ToolComponent;
}

function makeMockEnv(configComponent: ConfigComponent, toolComponent?: ToolComponent) {
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
  } as unknown as ReturnType<typeof Object> & { getComponent: ReturnType<typeof vi.fn> };
}

// ============================================================================
// Test Suite
// ============================================================================

describe("AgentComponent - ConfigLayer Consumption (Task #2024)", () => {
  let tempDir: string;
  let emptyAgentsDir: string;
  let configComponent: ConfigComponent;

  beforeEach(async () => {
    vi.clearAllMocks();

    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-configlayer-"));
    emptyAgentsDir = path.join(tempDir, "empty-agents");
    fsSync.mkdirSync(emptyAgentsDir, { recursive: true });

    configComponent = new ConfigComponent();
    configComponent.setXdgDataHome(tempDir);
    await configComponent.set("agent.configDir", emptyAgentsDir);
  });

  afterEach(() => {
    delete process.env.AGENT_DEFAULT_AGENT_ALLOWED_TOOLS;
    delete process.env.AGENT_DEFAULT_AGENT_DENIED_TOOLS;
    delete process.env.AGENT_DEFAULT_AGENT_ALLOWED_TOOLS;
    delete process.env.AGENT_DEFAULT_AGENT_DENIED_TOOLS;
    try { fsSync.rmSync(tempDir, { recursive: true }); } catch {}
  });

  // ==========================================================================
  // F1: 直接 config 对象传递 allowedTools
  // ==========================================================================
  describe("F1: 直接 config 对象 (constructor options.config)", () => {
    it("F1.1: 通过 constructor config.defaultAgent.allowedTools 配置白名单应生效", async () => {
      const toolComp = makeMockToolComponent([
        makeTool("tool_a"),
        makeTool("tool_b"),
        makeTool("tool_c"),
      ]);
      const env = makeMockEnv(configComponent, toolComp);

      const ac = new AgentComponent();
      await ac.init({
        name: "agent",
        version: "1.0.0",
        enabled: true,
        env,
        options: {
          configComponent,
          config: {
            defaultAgent: {
              type: "primary",
              // 系统应该让这个 fallback 到所有 agent 的默认 allowedTools
              allowedTools: ["tool_a", "tool_b"],
            },
          },
        },
      });
      await ac.refreshDependencies();

      // 注册时不显式传 allowedTools/deniedTools，应自动继承 defaultAgent 配置
      ac.registerAgent("f1-agent", { type: "primary" });

      const agent = ac.getAgent("f1-agent")!;
      const tools = ac.getAvailableTools(agent);
      const names = tools.map(t => t.name).sort();

      // 期望：tool_a, tool_b 通过白名单，tool_c 被白名单排除（deniedTools 也排除）
      // 但如果 defaultAgent.allowedTools 没生效，则 3 个工具都在
      expect(names).toEqual(["tool_a", "tool_b"]);
    });

    it("F1.2: 通过 constructor config.defaultAgent.deniedTools 配置黑名单应生效", async () => {
      const toolComp = makeMockToolComponent([
        makeTool("tool_a"),
        makeTool("tool_b"),
        makeTool("tool_c"),
      ]);
      const env = makeMockEnv(configComponent, toolComp);

      const ac = new AgentComponent();
      await ac.init({
        name: "agent",
        version: "1.0.0",
        enabled: true,
        env,
        options: {
          configComponent,
          config: {
            defaultAgent: {
              type: "primary",
              deniedTools: ["tool_b"],
            },
          },
        },
      });
      await ac.refreshDependencies();

      ac.registerAgent("f1-denied-agent", { type: "primary" });

      const agent = ac.getAgent("f1-denied-agent")!;
      const tools = ac.getAvailableTools(agent);
      const names = tools.map(t => t.name).sort();

      expect(names).toEqual(["tool_a", "tool_c"]);
    });
  });

  // ==========================================================================
  // F2: 环境变量配置
  // ==========================================================================
  describe("F2: 环境变量 (AGENT_* env vars)", () => {
    it("F2.1: AGENT_DEFAULT_AGENT_ALLOWED_TOOLS 环境变量应能配置默认白名单", async () => {
      // 注意：环境变量扫描通过 envKeyToConfigKey 转成 agent.defaultAgent.allowedTools
      process.env.AGENT_DEFAULT_AGENT_ALLOWED_TOOLS = "tool_a,tool_b";

      const toolComp = makeMockToolComponent([
        makeTool("tool_a"),
        makeTool("tool_b"),
        makeTool("tool_c"),
      ]);
      const env = makeMockEnv(configComponent, toolComp);

      const ac = new AgentComponent();
      await ac.init({
        name: "agent",
        version: "1.0.0",
        enabled: true,
        env,
        options: { configComponent },
      });
      await ac.refreshDependencies();

      // registerAgent 时不显式传 allowedTools
      ac.registerAgent("f2-env-agent", { type: "primary" });

      const agent = ac.getAgent("f2-env-agent")!;
      const tools = ac.getAvailableTools(agent);
      const names = tools.map(t => t.name).sort();

      expect(names).toEqual(["tool_a", "tool_b"]);
    });

    it("F2.2: AGENT_DEFAULT_AGENT_DENIED_TOOLS 环境变量应能配置默认黑名单", async () => {
      process.env.AGENT_DEFAULT_AGENT_DENIED_TOOLS = "tool_b";

      const toolComp = makeMockToolComponent([
        makeTool("tool_a"),
        makeTool("tool_b"),
        makeTool("tool_c"),
      ]);
      const env = makeMockEnv(configComponent, toolComp);

      const ac = new AgentComponent();
      await ac.init({
        name: "agent",
        version: "1.0.0",
        enabled: true,
        env,
        options: { configComponent },
      });
      await ac.refreshDependencies();

      ac.registerAgent("f2-denied-agent", { type: "primary" });

      const agent = ac.getAgent("f2-denied-agent")!;
      const tools = ac.getAvailableTools(agent);
      const names = tools.map(t => t.name).sort();

      expect(names).toEqual(["tool_a", "tool_c"]);
    });
  });
});