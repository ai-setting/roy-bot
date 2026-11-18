/**
 * @fileoverview AgentComponent.getAvailableTools × allowedAgentTypes filter
 *  (Real AgentComponent, covers ALL entry points)
 *
 * TDD: 验证 allowedAgentTypes 过滤在 getAvailableTools() 的**所有入口**
 * 都被统一应用：
 *   1. defaultTools (setDefaultTools 注入的 tools) — 之前未过滤
 *   2. componentTools (ToolComponent.listTools 返回) — 已通过 listTools(allowedAgent) 过滤
 *   3. extraTools (AgentContext.extraTools) — 之前未过滤
 *
 * 修复前：defaultTools 和 extraTools 路径会绕过 allowedAgentTypes 检查
 *   → tool 声明了 allowedAgentTypes:["default"] 但通过 setDefaultTools 或
 *     extraTools 注入后，roy 等其他 agent 也能看到它。
 *
 * 修复后：抽出 filterToolsByAgent(tools, agent) 工具，在三个入口都应用
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { z } from "zod";
import type { AgentInstance, AgentContext } from "./types";
import type { Tool } from "../tool/types";
import { AgentComponent } from "./agent-component";
import { ToolComponent } from "../tool/tool-component";
import { ConfigComponent } from "../../config/config-component";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

// ============================================================================
// Helpers
// ============================================================================

function makeTool(name: string, allowedAgentTypes?: string[]): Tool {
  return {
    name,
    description: `${name} tool`,
    parameters: z.object({}),
    execute: async () => ({ success: true, output: "ok", metadata: { execution_time_ms: 0 } }),
    ...(allowedAgentTypes !== undefined
      ? { metadata: { allowedAgentTypes } }
      : {}),
  };
}

function makeAgentInstance(name: string, type: "primary" | "sub" = "primary"): AgentInstance {
  return {
    name,
    config: {
      type,
      name,
      maxIterations: 10,
      maxErrorRetries: 0,
      doomLoopThreshold: 0,
      toolTimeout: 0,
      toolRetries: 0,
      systemPrompt: "",
      model: "",
      behaviorSpecId: "",
      allowedTools: undefined,
      deniedTools: undefined,
      filterHistory: false,
    },
    status: "idle",
    plugins: new Map(),
  } as unknown as AgentInstance;
}

/**
 * Create a real AgentComponent wired to a real ToolComponent.
 * Returns a ready-to-use instance with empty config dir.
 */
async function createWiredAgentComponent(): Promise<{
  agentComponent: AgentComponent;
  toolComponent: ToolComponent;
  configComponent: ConfigComponent;
  tempDir: string;
}> {
  const tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-vis-"));
  const configComponent = new ConfigComponent();
  configComponent.setXdgDataHome(tempDir);
  // Empty agents dir so built-in agents are the only ones registered
  const emptyAgentsDir = path.join(tempDir, "empty-agents");
  fsSync.mkdirSync(emptyAgentsDir, { recursive: true });
  await configComponent.set("agent.configDir", emptyAgentsDir);

  const mockEnv = {
    name: "test-env",
    version: "1.0.0",
    getConfig: () => ({ name: "test-env", version: "1.0.0", enabled: true }),
    getComponent: (n: string) => (n === "config" ? configComponent : undefined),
    hasComponent: (n: string) => n === "config",
    registerComponent: () => {},
    unregisterComponent: () => {},
    listComponents: () => [],
    handle_query: async () => ({}),
    handle_action: async () => ({}),
    subscribe: () => () => {},
    subscribeTo: () => () => {},
    subscribeAll: () => () => {},
    pushEnvEvent: () => {},
  };

  const toolComponent = new ToolComponent();
  await toolComponent.init({
    name: "tool",
    version: "1.0.0",
    enabled: true,
    env: mockEnv as any,
    options: { configComponent },
  });

  const agentComponent = new AgentComponent();
  await agentComponent.init({
    name: "agent",
    version: "1.0.0",
    enabled: true,
    env: mockEnv as any,
    options: { configComponent },
  });

  // Wire the tool component to the agent component
  (agentComponent as any).toolComponent = toolComponent;

  return { agentComponent, toolComponent, configComponent, tempDir };
}

function cleanup(tempDir: string) {
  try {
    fsSync.rmSync(tempDir, { recursive: true });
  } catch {}
}

// ============================================================================
// Tests
// ============================================================================

describe("AgentComponent.getAvailableTools — allowedAgentTypes filter on all entry points", () => {
  let agentComponent: AgentComponent;
  let toolComponent: ToolComponent;
  let tempDir: string;
  let configComponent: ConfigComponent;

  beforeEach(async () => {
    const ctx = await createWiredAgentComponent();
    agentComponent = ctx.agentComponent;
    toolComponent = ctx.toolComponent;
    configComponent = ctx.configComponent;
    tempDir = ctx.tempDir;
  });

  // Cleanup temp dir after each test
  test("cleanup", () => {
    cleanup(tempDir);
  });

  describe("defaultTools entry (via setDefaultTools)", () => {
    test("default-only defaultTool should be visible to default agent", () => {
      agentComponent.setDefaultTools([makeTool("default_only_memory_tool", ["default"])]);
      const tools = agentComponent.getAvailableTools(makeAgentInstance("default"));
      const names = tools.map((t) => t.name);
      expect(names).toContain("default_only_memory_tool");
    });

    test("default-only defaultTool should be HIDDEN from roy agent", () => {
      // This is the BUG that the review identified:
      // Before fix: roy could see default-only tools injected via setDefaultTools
      agentComponent.setDefaultTools([makeTool("default_only_memory_tool", ["default"])]);
      const tools = agentComponent.getAvailableTools(makeAgentInstance("roy"));
      const names = tools.map((t) => t.name);
      expect(names).not.toContain("default_only_memory_tool");
    });

    test("roy-only defaultTool should be visible to roy agent", () => {
      agentComponent.setDefaultTools([makeTool("roy_only_memory_tool", ["roy"])]);
      const tools = agentComponent.getAvailableTools(makeAgentInstance("roy"));
      const names = tools.map((t) => t.name);
      expect(names).toContain("roy_only_memory_tool");
    });

    test("universal defaultTool (no allowedAgentTypes) should be visible to all agents", () => {
      agentComponent.setDefaultTools([makeTool("universal_memory_tool")]);
      const defaultTools = agentComponent.getAvailableTools(makeAgentInstance("default"));
      const royTools = agentComponent.getAvailableTools(makeAgentInstance("roy"));
      expect(defaultTools.map((t) => t.name)).toContain("universal_memory_tool");
      expect(royTools.map((t) => t.name)).toContain("universal_memory_tool");
    });
  });

  describe("extraTools entry (via context.extraTools)", () => {
    test("default-only extraTool should be visible to default agent", () => {
      const extraTool = makeTool("default_only_extra_tool", ["default"]);
      const ctx: AgentContext = { extraTools: [extraTool] };
      const tools = agentComponent.getAvailableTools(makeAgentInstance("default"), ctx);
      expect(tools.map((t) => t.name)).toContain("default_only_extra_tool");
    });

    test("default-only extraTool should be HIDDEN from roy agent", () => {
      // Same bug: extraTools path also bypassed filter before the fix
      const extraTool = makeTool("default_only_extra_tool", ["default"]);
      const ctx: AgentContext = { extraTools: [extraTool] };
      const tools = agentComponent.getAvailableTools(makeAgentInstance("roy"), ctx);
      expect(tools.map((t) => t.name)).not.toContain("default_only_extra_tool");
    });

    test("roy-only extraTool should be visible to roy agent", () => {
      const extraTool = makeTool("roy_only_extra_tool", ["roy"]);
      const ctx: AgentContext = { extraTools: [extraTool] };
      const tools = agentComponent.getAvailableTools(makeAgentInstance("roy"), ctx);
      expect(tools.map((t) => t.name)).toContain("roy_only_extra_tool");
    });

    test("universal extraTool (no allowedAgentTypes) should be visible to all agents", () => {
      const extraTool = makeTool("universal_extra_tool");
      const ctx: AgentContext = { extraTools: [extraTool] };
      const defaultTools = agentComponent.getAvailableTools(makeAgentInstance("default"), ctx);
      const royTools = agentComponent.getAvailableTools(makeAgentInstance("roy"), ctx);
      expect(defaultTools.map((t) => t.name)).toContain("universal_extra_tool");
      expect(royTools.map((t) => t.name)).toContain("universal_extra_tool");
    });
  });

  describe("componentTools entry (via ToolComponent.listTools) — should already work", () => {
    test("default-only tool in ToolComponent is visible to default", () => {
      const tool = makeTool("component_default_only", ["default"]);
      toolComponent.register(tool);
      const tools = agentComponent.getAvailableTools(makeAgentInstance("default"));
      expect(tools.map((t) => t.name)).toContain("component_default_only");
    });

    test("default-only tool in ToolComponent is HIDDEN from roy (sanity check)", () => {
      const tool = makeTool("component_default_only_roy_view", ["default"]);
      toolComponent.register(tool);
      const tools = agentComponent.getAvailableTools(makeAgentInstance("roy"));
      expect(tools.map((t) => t.name)).not.toContain("component_default_only_roy_view");
    });
  });
});
