/**
 * @fileoverview PluginComponent Integration Tests
 * 
 * 测试 PluginComponent 与 PluginEnv 的集成
 * 验证 Plugin 能正确访问组件和注册 Hooks/Agents/Tools
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "bun:test";
import { PluginComponent } from "./plugin-component";
import { BasePlugin, type PluginEnv } from "./types";
import { globalHookManager } from "../hook/global-hook-manager";

// Mock logger
vi.mock("../log-trace/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ========================================================================
// Test Plugins
// ========================================================================

/**
 * 注册 Agent 的插件
 */
class AgentPlugin extends BasePlugin {
  readonly name = "agent-plugin";
  agentRegistered: any = null;
  
  init(env: PluginEnv): void {
    const config = {
      name: "plugin-agent",
      description: "Agent from plugin",
      systemPrompt: "You are a test agent",
    };
    env.registerAgent(config);
    this.agentRegistered = config;
  }
}

/**
 * 注册 Tool 的插件
 */
class ToolPlugin extends BasePlugin {
  readonly name = "tool-plugin";
  toolRegistered: any = null;
  
  init(env: PluginEnv): void {
    const tool = {
      name: "plugin-tool",
      description: "Tool from plugin",
      handler: vi.fn(),
    };
    env.registerTool(tool);
    this.toolRegistered = tool;
  }
}

/**
 * 注册 Hook 的插件
 */
class HookPlugin extends BasePlugin {
  readonly name = "hook-plugin";
  hookRegistered = false;
  
  init(env: PluginEnv): void {
    env.registerHook({
      point: "test.integration.hook",
      priority: 50,
      handler: vi.fn(),
    });
    this.hookRegistered = true;
  }
}

/**
 * 访问多个组件的插件
 */
class MultiComponentPlugin extends BasePlugin {
  readonly name = "multi-component-plugin";
  componentsAccessed = false;
  
  init(env: PluginEnv): void {
    const agent = env.getComponent("agent");
    const tool = env.getComponent("tool");
    const memory = env.getComponent("memory");
    
    // 所有组件都应该能访问到（即使为 undefined）
    this.componentsAccessed = true;
  }
}

// ========================================================================
// Tests
// ========================================================================

describe("PluginComponent Integration", () => {
  let pluginComponent: PluginComponent;
  let mockEnv: any;
  let mockAgentComponent: any;
  let mockToolComponent: any;
  let mockConfigComponent: any;
  
  beforeEach(() => {
    pluginComponent = new PluginComponent();
    
    // 创建模拟组件
    mockAgentComponent = {
      registerAgent: vi.fn(),
    };
    mockToolComponent = {
      register: vi.fn(),
    };
    mockConfigComponent = {
      get: vi.fn().mockReturnValue(undefined),
    };
    
    // 创建模拟 Environment
    mockEnv = {
      getComponent: vi.fn((name: string) => {
        if (name === "agent") return mockAgentComponent;
        if (name === "tool") return mockToolComponent;
        if (name === "config") return mockConfigComponent;
        return null;
      }),
    };
    
    // 注入 env 到 pluginComponent
    (pluginComponent as any).env = mockEnv;
  });
  
  afterEach(() => {
    // 清理 globalHookManager 中注册的 hooks
    globalHookManager.clear();
  });
  
  test("should allow plugin to register agents", async () => {
    const plugin = new AgentPlugin();
    await pluginComponent.register(plugin);
    
    expect(pluginComponent.has("agent-plugin")).toBe(true);
    expect(mockAgentComponent.registerAgent).toHaveBeenCalledWith(
      "plugin-agent",  // name
      expect.objectContaining({
        name: "plugin-agent",
        description: "Agent from plugin",
      })
    );
  });
  
  test("should allow plugin to register tools", async () => {
    const plugin = new ToolPlugin();
    await pluginComponent.register(plugin);
    
    expect(pluginComponent.has("tool-plugin")).toBe(true);
    expect(mockToolComponent.register).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "plugin-tool",
      })
    );
  });
  
  test("should allow plugin to register hooks", async () => {
    const registerSpy = vi.spyOn(globalHookManager, 'register');
    
    const plugin = new HookPlugin();
    await pluginComponent.register(plugin);
    
    expect(pluginComponent.has("hook-plugin")).toBe(true);
    expect(plugin.hookRegistered).toBe(true);
    
    // 验证 hook 被注册到 globalHookManager
    expect(registerSpy).toHaveBeenCalledWith(
      "test.integration.hook",
      expect.objectContaining({
        name: "hook-plugin:test.integration.hook",
        priority: 50,
      })
    );
    
    registerSpy.mockRestore();
  });
  
  test("should allow plugin to access multiple components", async () => {
    const plugin = new MultiComponentPlugin();
    await pluginComponent.register(plugin);
    
    expect(pluginComponent.has("multi-component-plugin")).toBe(true);
    expect(plugin.componentsAccessed).toBe(true);
    
    // 验证 getComponent 被调用
    expect(mockEnv.getComponent).toHaveBeenCalledWith("agent");
    expect(mockEnv.getComponent).toHaveBeenCalledWith("tool");
    expect(mockEnv.getComponent).toHaveBeenCalledWith("memory");
  });
  
  test("should unregister plugin and cleanup", async () => {
    const plugin = new AgentPlugin();
    await pluginComponent.register(plugin);
    
    expect(pluginComponent.has("agent-plugin")).toBe(true);
    
    const result = pluginComponent.unregister("agent-plugin");
    
    expect(result).toBe(true);
    expect(pluginComponent.has("agent-plugin")).toBe(false);
  });
  
  test("should list all registered plugins", async () => {
    await pluginComponent.register(new AgentPlugin());
    await pluginComponent.register(new ToolPlugin());
    await pluginComponent.register(new HookPlugin());
    
    const plugins = pluginComponent.list();
    
    expect(plugins).toHaveLength(3);
    expect(plugins.map(p => p.name)).toContain("agent-plugin");
    expect(plugins.map(p => p.name)).toContain("tool-plugin");
    expect(plugins.map(p => p.name)).toContain("hook-plugin");
  });
  
  test("should prevent duplicate registration", async () => {
    const plugin1 = new AgentPlugin();
    const plugin2 = new AgentPlugin();
    
    await pluginComponent.register(plugin1);

    await expect(pluginComponent.register(plugin2)).rejects.toThrow(
      'Plugin "agent-plugin" is already registered'
    );
  });
  
  test("should get plugin config", () => {
    // 直接设置 configComponent
    (pluginComponent as any).configComponent = mockConfigComponent;
    mockConfigComponent.get.mockReturnValue({ option1: "value1" });
    
    const config = pluginComponent.getConfig("any-plugin");
    expect(config).toEqual({ option1: "value1" });
  });
  
  test("should register multiple plugins", async () => {
    const plugins = [
      new AgentPlugin(),
      new ToolPlugin(),
      new HookPlugin(),
    ];

    await pluginComponent.registerAll(plugins);

    expect(pluginComponent.list()).toHaveLength(3);
  });
  
  test("should use plugin priority for hook registration", async () => {
    const registerSpy = vi.spyOn(globalHookManager, 'register');
    
    class PriorityPlugin extends BasePlugin {
      readonly name = "priority-plugin";
      readonly priority = 100;
      
      init(env: PluginEnv): void {
        env.registerHook({
          point: "priority.test.hook",
          handler: vi.fn(),
        });
      }
    }
    
    const plugin = new PriorityPlugin();
    await pluginComponent.register(plugin);
    
    // 验证 hook 的 priority 等于插件的 priority
    expect(registerSpy).toHaveBeenCalledWith(
      "priority.test.hook",
      expect.objectContaining({
        name: "priority-plugin:priority.test.hook",
        priority: 100,
      })
    );
    
    registerSpy.mockRestore();
  });
});
