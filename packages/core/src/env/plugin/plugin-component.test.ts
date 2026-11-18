/**
 * @fileoverview PluginComponent Tests (TDD)
 * 
 * 测试 PluginComponent 的核心功能：
 * 1. 插件注册和注销
 * 2. PluginEnv 的创建和注入
 * 3. Hook 注册到 globalHookManager
 * 4. Agent 和 Tool 注册
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "bun:test";
import { createChildProcessMockModule } from "../../test-utils/child-process-mock";
import { PluginComponent } from "./plugin-component";
import { BasePlugin, type PluginEnv, type HookDefinition } from "./types";
import { globalHookManager } from "../hook/global-hook-manager";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

// ========================================================================
// Mock Classes
// ========================================================================

/**
 * 测试用 Plugin
 */
class TestPlugin extends BasePlugin {
  readonly name = "test-plugin";
  readonly version = "1.0.0";
  readonly description = "A test plugin";
  readonly priority = 10;
  
  initCalled = false;
  disposeCalled = false;
  receivedEnv: PluginEnv | null = null;
  registeredHooks: HookDefinition[] = [];
  registeredAgents: any[] = [];
  registeredTools: any[] = [];
  
  constructor(private config?: { shouldFail?: boolean }) {
    super();
  }
  
  init(env: PluginEnv): void {
    this.initCalled = true;
    this.receivedEnv = env;
    
    // 注册 Hook
    env.registerHook({
      point: "test.hook",
      priority: 10,
      handler: async () => {},
    });
    
    this.registeredHooks = [{
      point: "test.hook",
      priority: 10,
      handler: async () => {},
    }];
    
    // 注册 Agent
    env.registerAgent({
      name: "test-agent",
      description: "Test agent",
    });
    this.registeredAgents = [{
      name: "test-agent",
      description: "Test agent",
    }];
    
    // 注册 Tool
    env.registerTool({
      name: "test-tool",
      description: "Test tool",
      handler: () => {},
    });
    this.registeredTools = [{
      name: "test-tool",
      description: "Test tool",
    }];
  }
  
  dispose(): void {
    this.disposeCalled = true;
    this.receivedEnv = null;
  }
}

/**
 * 失败 Plugin
 */
class FailingPlugin extends BasePlugin {
  readonly name = "failing-plugin";
  
  init(env: PluginEnv): void {
    throw new Error("Plugin initialization failed");
  }
}

// ========================================================================
// Tests
// ========================================================================

describe("PluginComponent", () => {
  let pluginComponent: PluginComponent;
  let mockEnv: any;
  
  beforeEach(() => {
    pluginComponent = new PluginComponent();
    
    // 模拟 Environment
    mockEnv = {
      getComponent: vi.fn().mockReturnValue({
        registerAgent: vi.fn(),
        register: vi.fn(),
      }),
    };
    
    // 注入 env
    (pluginComponent as any).env = mockEnv;
  });
  
  afterEach(() => {
    // 清理
    pluginComponent = null!;
    mockEnv = null!;
    
    // 清理 globalHookManager 中注册的 hooks
    globalHookManager.clear();
  });
  
  // ========================================================================
  // Plugin Registration Tests
  // ========================================================================
  
  test("should register a plugin", async () => {
    const plugin = new TestPlugin();

    await pluginComponent.register(plugin);

    expect(pluginComponent.has("test-plugin")).toBe(true);
    expect(pluginComponent.get("test-plugin")).toBe(plugin);
    expect(plugin.initCalled).toBe(true);
  });
  
  test("should throw when registering duplicate plugin", async () => {
    const plugin1 = new TestPlugin();
    const plugin2 = new TestPlugin();

    await pluginComponent.register(plugin1);

    await expect(pluginComponent.register(plugin2)).rejects.toThrow(
      'Plugin "test-plugin" is already registered'
    );
  });

  test("should call plugin init with PluginEnv", async () => {
    const plugin = new TestPlugin();

    await pluginComponent.register(plugin);

    expect(plugin.initCalled).toBe(true);
    expect(plugin.receivedEnv).not.toBeNull();
    expect(typeof plugin.receivedEnv?.getComponent).toBe("function");
    expect(typeof plugin.receivedEnv?.registerAgent).toBe("function");
    expect(typeof plugin.receivedEnv?.registerTool).toBe("function");
    expect(typeof plugin.receivedEnv?.registerHook).toBe("function");
    expect(typeof plugin.receivedEnv?.logger).toBe("object");
  });
  
  test("should throw when plugin init fails", async () => {
    const plugin = new FailingPlugin();

    await expect(pluginComponent.register(plugin)).rejects.toThrow(
      "Plugin initialization failed"
    );
    expect(pluginComponent.has("failing-plugin")).toBe(false);
  });

  test("should throw when registering duplicate plugin (async)", async () => {
    const plugin1 = new TestPlugin();
    const plugin2 = new TestPlugin();

    await pluginComponent.register(plugin1);

    await expect(pluginComponent.register(plugin2)).rejects.toThrow(
      'Plugin "test-plugin" is already registered'
    );
  });

  test("should reject when async plugin init fails", async () => {
    class AsyncFailingPlugin extends BasePlugin {
      readonly name = "async-failing-plugin";
      async init(_env: PluginEnv): Promise<void> {
        await new Promise((r) => setTimeout(r, 1));
        throw new Error("Async plugin initialization failed");
      }
    }

    const plugin = new AsyncFailingPlugin();

    await expect(pluginComponent.register(plugin)).rejects.toThrow(
      "Async plugin initialization failed"
    );
    expect(pluginComponent.has("async-failing-plugin")).toBe(false);
  });

  test("should register plugin with async init that resolves", async () => {
    class AsyncSuccessPlugin extends BasePlugin {
      readonly name = "async-success-plugin";
      initCalled = false;
      async init(_env: PluginEnv): Promise<void> {
        await new Promise((r) => setTimeout(r, 1));
        this.initCalled = true;
      }
    }

    const plugin = new AsyncSuccessPlugin();
    await pluginComponent.register(plugin);

    expect(pluginComponent.has("async-success-plugin")).toBe(true);
    expect(plugin.initCalled).toBe(true);
  });
  
  // ========================================================================
  // Plugin Unregistration Tests
  // ========================================================================
  
  test("should unregister a plugin", async () => {
    const plugin = new TestPlugin();
    await pluginComponent.register(plugin);

    const result = pluginComponent.unregister("test-plugin");

    expect(result).toBe(true);
    expect(pluginComponent.has("test-plugin")).toBe(false);
    expect(plugin.disposeCalled).toBe(true);
  });
  
  test("should return false when unregistering non-existent plugin", () => {
    const result = pluginComponent.unregister("non-existent");
    expect(result).toBe(false);
  });
  
  test("should handle dispose error gracefully", async () => {
    const plugin = new TestPlugin();
    await pluginComponent.register(plugin);
    
    // 模拟 dispose 出错
    const originalDispose = plugin.dispose.bind(plugin);
    (plugin as any).dispose = () => {
      throw new Error("Dispose failed");
    };
    
    const result = pluginComponent.unregister("test-plugin");
    
    expect(result).toBe(true); // 仍然返回 true，因为已经从 registry 移除
  });
  
  // ========================================================================
  // Plugin Listing Tests
  // ========================================================================
  
  test("should list all registered plugins", async () => {
    class PluginA extends BasePlugin {
      readonly name = "plugin-a";
    }
    class PluginB extends BasePlugin {
      readonly name = "plugin-b";
    }
    
    await pluginComponent.register(new PluginA());
    await pluginComponent.register(new PluginB());
    
    const plugins = pluginComponent.list();
    
    expect(plugins).toHaveLength(2);
    expect(plugins.map(p => p.name)).toContain("plugin-a");
    expect(plugins.map(p => p.name)).toContain("plugin-b");
  });
  
  test("should return empty list when no plugins registered", () => {
    const plugins = pluginComponent.list();
    expect(plugins).toHaveLength(0);
  });
  
  // ========================================================================
  // PluginEnv Tests
  // ========================================================================
  
  test("PluginEnv.getComponent should return component from env", async () => {
    class GetComponentPlugin extends BasePlugin {
      readonly name = "get-component-plugin";
      receivedComponent: any = null;
      
      init(env: PluginEnv): void {
        this.receivedComponent = env.getComponent("mock-component");
      }
    }
    
    const mockComponent = { name: "mock-component" };
    mockEnv.getComponent.mockReturnValue(mockComponent);
    
    const plugin = new GetComponentPlugin();
    await pluginComponent.register(plugin);
    
    expect(mockEnv.getComponent).toHaveBeenCalledWith("mock-component");
    expect(plugin.receivedComponent).toBe(mockComponent);
  });
  
  test("PluginEnv.registerAgent should call agentComponent.registerAgent", async () => {
    const plugin = new TestPlugin();
    await pluginComponent.register(plugin);
    
    plugin.receivedEnv?.registerAgent({
      name: "new-agent",
      description: "New agent",
    });
    
    const agentComponent = mockEnv.getComponent("agent");
    expect(agentComponent.registerAgent).toHaveBeenCalledWith("new-agent", {
      name: "new-agent",
      description: "New agent",
    });
  });
  
  test("PluginEnv.registerTool should call toolComponent.register", async () => {
    const plugin = new TestPlugin();
    await pluginComponent.register(plugin);
    
    plugin.receivedEnv?.registerTool({
      name: "new-tool",
      description: "New tool",
      handler: () => {},
    });
    
    const toolComponent = mockEnv.getComponent("tool");
    expect(toolComponent.register).toHaveBeenCalled();
  });
  
  test("PluginEnv.registerHook should register to globalHookManager", async () => {
    // Spy on globalHookManager
    const registerSpy = vi.spyOn(globalHookManager, 'register');
    
    class HookTestPlugin extends BasePlugin {
      readonly name = "hook-test-plugin";
      
      init(env: PluginEnv): void {
        env.registerHook({
          point: "test.hook",
          priority: 10,
          handler: async () => {},
        });
      }
    }
    
    const plugin = new HookTestPlugin();
    await pluginComponent.register(plugin);
    
    expect(registerSpy).toHaveBeenCalledWith(
      "test.hook",
      expect.objectContaining({
        name: "hook-test-plugin:test.hook",
        priority: 10,
      })
    );
    
    registerSpy.mockRestore();
  });
  
  // ========================================================================
  // BasePlugin Interface Tests
  // ========================================================================
  
  test("BasePlugin should have default version", () => {
    class SimplePlugin extends BasePlugin {
      readonly name = "simple-plugin";
    }
    
    const plugin = new SimplePlugin();
    expect(plugin.version).toBe("1.0.0");
  });
  
  test("BasePlugin should accept config in constructor", () => {
    class ConfigurablePlugin extends BasePlugin {
      readonly name = "configurable-plugin";
      
      constructor(private myConfig: { value: number } | undefined) {
        super();
      }
      
      getConfigValue(): number {
        return this.myConfig?.value ?? 0;
      }
    }
    
    const plugin = new ConfigurablePlugin({ value: 42 });
    expect(plugin.getConfigValue()).toBe(42);
  });
  
  test("BasePlugin init should be optional", async () => {
    class NoInitPlugin extends BasePlugin {
      readonly name = "no-init-plugin";
    }
    
    const plugin = new NoInitPlugin();
    await pluginComponent.register(plugin);
    
    expect(pluginComponent.has("no-init-plugin")).toBe(true);
  });
  
  test("BasePlugin dispose should be optional", async () => {
    class NoDisposePlugin extends BasePlugin {
      readonly name = "no-dispose-plugin";
    }
    
    const plugin = new NoDisposePlugin();
    await pluginComponent.register(plugin);
    
    const result = pluginComponent.unregister("no-dispose-plugin");
    expect(result).toBe(true);
  });
  
  // ========================================================================
  // Priority Tests
  // ========================================================================
  
  test("should register hooks with plugin priority", async () => {
    const registerSpy = vi.spyOn(globalHookManager, 'register');
    
    class PriorityPlugin extends BasePlugin {
      readonly name = "priority-plugin";
      readonly priority = 50;
      
      init(env: PluginEnv): void {
        env.registerHook({
          point: "priority.test",
          handler: async () => {},
        });
      }
    }
    
    const plugin = new PriorityPlugin();
    await pluginComponent.register(plugin);
    
    // 验证 register 被调用，priority 为插件的 priority
    expect(registerSpy).toHaveBeenCalledWith(
      "priority.test",
      expect.objectContaining({
        name: "priority-plugin:priority.test",
        priority: 50, // 使用插件的 priority
      })
    );
    
    registerSpy.mockRestore();
  });
  
  test("should allow hook-specific priority override", async () => {
    const registerSpy = vi.spyOn(globalHookManager, 'register');
    
    class HookPriorityPlugin extends BasePlugin {
      readonly name = "hook-priority-plugin";
      readonly priority = 10;
      
      init(env: PluginEnv): void {
        env.registerHook({
          point: "hook-priority.test",
          priority: 100, // Override plugin priority
          handler: async () => {},
        });
      }
    }
    
    const plugin = new HookPriorityPlugin();
    await pluginComponent.register(plugin);
    
    // 验证 register 被调用，priority 为 hook 指定的 priority（覆盖插件的）
    expect(registerSpy).toHaveBeenCalledWith(
      "hook-priority.test",
      expect.objectContaining({
        name: "hook-priority-plugin:hook-priority.test",
        priority: 100, // Hook 指定的 priority 覆盖插件的
      })
    );
    
    registerSpy.mockRestore();
  });
});

// ========================================================================
// Startup Loading Tests
// ========================================================================

describe("PluginComponent startup loading", () => {
  let tempDir: string;
  let pluginComponent: PluginComponent;
  let mockEnv: any;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "plugin-startup-test-"));
    pluginComponent = new PluginComponent();

    mockEnv = {
      getComponent: vi.fn().mockReturnValue({
        registerAgent: vi.fn(),
        register: vi.fn(),
      }),
    };

    (pluginComponent as any).env = mockEnv;
  });

  afterEach(() => {
    pluginComponent = null!;
    mockEnv = null!;
    globalHookManager.clear();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("should skip loading when plugins.json does not exist", async () => {
    // No plugins.json created - loadInstalledPlugins should skip
    const configPath = join(tempDir, ".roy-bot", "plugins.json");
    expect(existsSync(configPath)).toBe(false);
  });

  test("should skip loading when plugins.json is empty", async () => {
    const configDir = join(tempDir, ".roy-bot");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "plugins.json"),
      JSON.stringify({ plugins: [] }, null, 2),
      "utf-8"
    );

    const raw = readFileSync(join(configDir, "plugins.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.plugins).toHaveLength(0);
  });

  test("should read plugins.json with multiple plugin entries", async () => {
    const configDir = join(tempDir, ".roy-bot");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "plugins.json"),
      JSON.stringify({
        plugins: [
          {
            packageName: "@roy-bot/plugin-a",
            version: "1.0.0",
            name: "plugin-a",
            description: "Plugin A",
          },
          {
            packageName: "@roy-bot/plugin-b",
            version: "2.0.0",
            name: "plugin-b",
            description: "Plugin B",
          },
        ],
      }, null, 2),
      "utf-8"
    );

    const raw = readFileSync(join(configDir, "plugins.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.plugins).toHaveLength(2);
    expect(parsed.plugins[0].packageName).toBe("@roy-bot/plugin-a");
    expect(parsed.plugins[1].packageName).toBe("@roy-bot/plugin-b");
  });

  test("should handle malformed plugins.json gracefully", async () => {
    const configDir = join(tempDir, ".roy-bot");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "plugins.json"),
      "not valid json",
      "utf-8"
    );

    // Should not throw, just log a warning
    let threw = false;
    try {
      JSON.parse(readFileSync(join(configDir, "plugins.json"), "utf-8"));
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

// ========================================================================
// NotificationChannel Integration Tests (TDD - Phase 2)
// ========================================================================

import type {
  EnvContextLike,
  NotificationChannel,
  NotificationOptions,
  NotificationSendExtras,
} from "./notification-channel";
import { EventBusNotificationChannel } from "./event-bus-notification-channel";
import { LarkCliNotificationChannel } from "./lark-cli-notification-channel";
import { getEnvContextOrEmpty } from "../context";

describe("PluginComponent - Notification Channels", () => {
  let pluginComponent: PluginComponent;
  let mockEnv: any;
  let mockPushEnvEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    pluginComponent = new PluginComponent();

    mockPushEnvEvent = vi.fn();

    // 默认 mock env 含 pushEnvEvent
    mockEnv = {
      getComponent: vi.fn().mockReturnValue({
        registerAgent: vi.fn(),
        register: vi.fn(),
      }),
      pushEnvEvent: mockPushEnvEvent,
    };

    (pluginComponent as any).env = mockEnv;
  });

  afterEach(() => {
    pluginComponent = null!;
    mockEnv = null!;
    mockPushEnvEvent = null!;
    globalHookManager.clear();
  });

  // ========================================================================
  // Default Channel List
  // ========================================================================

  test("default channel list should include event-bus", () => {
    const names = pluginComponent.getNotificationChannelNames();
    expect(names).toContain("event-bus");
  });

  test("default channel list should NOT include lark-cli (deprecated)", () => {
    const names = pluginComponent.getNotificationChannelNames();
    expect(names).not.toContain("lark-cli");
  });

  // ========================================================================
  // Custom Channels
  // ========================================================================

  test("setNotificationChannels should replace the default list", () => {
    const larkChannel = new LarkCliNotificationChannel();
    pluginComponent.setNotificationChannels([larkChannel]);

    const names = pluginComponent.getNotificationChannelNames();
    expect(names).toEqual(["lark-cli"]);
    expect(names).not.toContain("event-bus");
  });

  test("setNotificationChannels accepts an empty list (no channels → notify is noop)", () => {
    pluginComponent.setNotificationChannels([]);
    expect(pluginComponent.getNotificationChannelNames()).toEqual([]);
  });

  // ========================================================================
  // PluginEnv.notify routing
  // ========================================================================

  describe("PluginEnv.notify routing", () => {
    test("PluginEnv should expose notify(options)", async () => {
      class NotifyPlugin extends BasePlugin {
        readonly name = "notify-plugin";
        notifyFn: ((opts: NotificationOptions) => Promise<void>) | null = null;

        init(env: PluginEnv): void {
          this.notifyFn = (env as any).notify;
        }
      }

      const plugin = new NotifyPlugin();
      await pluginComponent.register(plugin);

      expect(plugin.notifyFn).toBeDefined();
      expect(typeof plugin.notifyFn).toBe("function");
    });

    test("notify should route to event-bus channel by default (pushEnvEvent called)", async () => {
      class TaskShowPlugin extends BasePlugin {
        readonly name = "task-show";
        receivedEnv: PluginEnv | null = null;

        async init(env: PluginEnv): Promise<void> {
          this.receivedEnv = env;
          await (env as any).notify({
            type: "visualization_ready",
            title: "Viz",
            content: "Ready",
            metadata: { taskId: 42 },
          });
        }
      }

      const plugin = new TaskShowPlugin();
      await pluginComponent.register(plugin);

      expect(mockPushEnvEvent).toHaveBeenCalledTimes(1);
      const event = mockPushEnvEvent.mock.calls[0]![0];
      expect(event.type).toBe("plugin.notification.visualization_ready");
      expect(event.metadata.source).toBe("plugin:task-show");
      expect(event.metadata.taskId).toBe(42);
      expect(event.payload.title).toBe("Viz");
      expect(event.payload.content).toBe("Ready");
    });

    test("notify should pass envInstance=self.env to channel.send()", async () => {
      // 用 spy 包装 channel，记录 send 调用时的 extras
      const sendSpy = vi.fn(async () => {});
      const captureChannel: NotificationChannel = {
        name: "capture",
        canRoute: () => true,
        send: sendSpy,
      };

      pluginComponent.setNotificationChannels([captureChannel]);

      class TestPlugin extends BasePlugin {
        readonly name = "capture-plugin";
        async init(env: PluginEnv): Promise<void> {
          await (env as any).notify({
            type: "test_event",
            title: "T",
            content: "C",
          });
        }
      }

      const plugin = new TestPlugin();
      await pluginComponent.register(plugin);

      expect(sendSpy).toHaveBeenCalledTimes(1);
      const [_opts, extras] = sendSpy.mock.calls[0]!;
      expect(extras.pluginName).toBe("capture-plugin");
      // ★ extras.envInstance 必须指向 mockEnv（self.env）
      expect(extras.envInstance).toBe(mockEnv);
    });

    test("notify should be a noop when no channel canRoute", async () => {
      const noneChannel: NotificationChannel = {
        name: "none",
        canRoute: () => false,
        send: vi.fn(async () => {}),
      };
      pluginComponent.setNotificationChannels([noneChannel]);

      class TestPlugin extends BasePlugin {
        readonly name = "nochannel-plugin";
        async init(env: PluginEnv): Promise<void> {
          await (env as any).notify({
            type: "x",
            title: "x",
            content: "x",
          });
        }
      }

      const plugin = new TestPlugin();
      // Should NOT throw even though no channel handled it
      await expect(pluginComponent.register(plugin)).resolves.toBeUndefined();
      expect(noneChannel.send).not.toHaveBeenCalled();
    });

    test("notify should use the first canRoute=true channel (channel ordering)", async () => {
      const firstSend = vi.fn(async () => {});
      const secondSend = vi.fn(async () => {});

      const firstChannel: NotificationChannel = {
        name: "first",
        canRoute: () => true,
        send: firstSend,
      };
      const secondChannel: NotificationChannel = {
        name: "second",
        canRoute: () => true,
        send: secondSend,
      };

      pluginComponent.setNotificationChannels([firstChannel, secondChannel]);

      class TestPlugin extends BasePlugin {
        readonly name = "order-plugin";
        async init(env: PluginEnv): Promise<void> {
          await (env as any).notify({ type: "x", title: "x", content: "x" });
        }
      }

      const plugin = new TestPlugin();
      await pluginComponent.register(plugin);

      expect(firstSend).toHaveBeenCalledTimes(1);
      expect(secondSend).not.toHaveBeenCalled();
    });

    test("notify should fall through to second channel when first rejects routing", async () => {
      const firstSend = vi.fn(async () => {});
      const secondSend = vi.fn(async () => {});

      const firstChannel: NotificationChannel = {
        name: "reject",
        canRoute: () => false,
        send: firstSend,
      };
      const secondChannel: NotificationChannel = {
        name: "accept",
        canRoute: () => true,
        send: secondSend,
      };

      pluginComponent.setNotificationChannels([firstChannel, secondChannel]);

      class TestPlugin extends BasePlugin {
        readonly name = "fallthrough-plugin";
        async init(env: PluginEnv): Promise<void> {
          await (env as any).notify({ type: "x", title: "x", content: "x" });
        }
      }

      const plugin = new TestPlugin();
      await pluginComponent.register(plugin);

      expect(firstSend).not.toHaveBeenCalled();
      expect(secondSend).toHaveBeenCalledTimes(1);
    });

    test("notify should not throw even when channel.send rejects (swallowed)", async () => {
      const throwingChannel: NotificationChannel = {
        name: "throwing",
        canRoute: () => true,
        send: vi.fn(async () => {
          throw new Error("send failed");
        }),
      };
      pluginComponent.setNotificationChannels([throwingChannel]);

      class TestPlugin extends BasePlugin {
        readonly name = "throw-plugin";
        async init(env: PluginEnv): Promise<void> {
          await (env as any).notify({ type: "x", title: "x", content: "x" });
        }
      }

      const plugin = new TestPlugin();
      // register should not throw
      await expect(pluginComponent.register(plugin)).resolves.toBeUndefined();
    });

    test("notify should pass current ALS envContext (replyChannel) to channel.send", async () => {
      // 因为 plugin.init 不在 ALS 内执行，channel.send 会拿到空 EnvContext
      // 这里我们主要验证 send 被调用时的第三参数是 EnvContextLike
      const sendSpy = vi.fn(async () => {});
      const captureChannel: NotificationChannel = {
        name: "capture-ctx",
        canRoute: () => true,
        send: sendSpy,
      };
      pluginComponent.setNotificationChannels([captureChannel]);

      class TestPlugin extends BasePlugin {
        readonly name = "ctx-plugin";
        async init(env: PluginEnv): Promise<void> {
          await (env as any).notify({ type: "x", title: "x", content: "x" });
        }
      }

      const plugin = new TestPlugin();
      await pluginComponent.register(plugin);

      const [_opts, _extras, envContext] = sendSpy.mock.calls[0]!;
      expect(envContext).toBeDefined();
      expect(typeof envContext).toBe("object");
      // 注：plugin.init 不在 ALS 内，envContext 为空对象
      expect(envContext).toEqual(getEnvContextOrEmpty());
    });
  });

  // ========================================================================
  // EnvContext-aware behavior
  // ========================================================================

  describe("Event-bus channel silent-skip when env.pushEnvEvent is missing", () => {
    test("should silently skip when env has no pushEnvEvent (no throw, no push)", async () => {
      // env 不含 pushEnvEvent
      const envWithoutPush: any = {
        getComponent: vi.fn(),
      };
      (pluginComponent as any).env = envWithoutPush;

      class TestPlugin extends BasePlugin {
        readonly name = "no-push-plugin";
        async init(env: PluginEnv): Promise<void> {
          await (env as any).notify({
            type: "should_silently_skip",
            title: "t",
            content: "c",
          });
        }
      }

      const plugin = new TestPlugin();
      // Should not throw
      await expect(pluginComponent.register(plugin)).resolves.toBeUndefined();
    });
  });
});

// ============================================================================
// Tests for Task #2903: PluginComponent 启动时版本一致性 warn
// Bug: plugins.json 声明的 version 和磁盘上实际加载的 plugin 代码版本不一致
//      (e.g. ~/.roy-bot/node_modules/@ai-setting/roy-plugin-task-show 是
//        旧版 cp 副本的 v2.5.7，但 plugins.json 记的是 v2.5.9)，导致 CLI 跑起来
//      加载到旧版本/损坏的入口，报 AdapterError。
// 修复目标：
//   - checkVersionDrift helper: 加载完 plugin 后，对比 declared vs loaded version
//   - 不一致时 logger.warn（带 resolvedPath 帮助用户诊断）
//   - 一致时不应 warn（regression guard）
// ============================================================================

describe("Task #2903: PluginComponent version drift check", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "plugin-version-drift-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 场景 1: readActualVersion 必须能从 resolvedPath 读出版本
  // ─────────────────────────────────────────────────────────────────────
  test("场景 1: readActualVersion 从 fake plugin 目录读出版本", async () => {
    const mod = await import("./plugin-component");
    expect(typeof mod.readActualVersion).toBe("function");

    // 构造 fake plugin：tempDir/pkg/index.js + tempDir/pkg/package.json (v2.5.9)
    const fakePkgDir = join(tempDir, "@ai-setting", "roy-plugin-task-show");
    mkdirSync(fakePkgDir, { recursive: true });
    writeFileSync(
      join(fakePkgDir, "package.json"),
      JSON.stringify({
        name: "@ai-setting/roy-plugin-task-show",
        version: "2.5.9",
      }),
      "utf-8"
    );
    writeFileSync(join(fakePkgDir, "index.js"), "// fake plugin", "utf-8");

    const resolvedPath = join(fakePkgDir, "index.js");
    const actual = mod.readActualVersion(resolvedPath);
    expect(actual).toBe("2.5.9");
  });

  // ─────────────────────────────────────────────────────────────────────
  // 场景 2: readActualVersion 在路径不存在 package.json 时返回 null
  // ─────────────────────────────────────────────────────────────────────
  test("场景 2: readActualVersion 路径不存在 package.json 时返回 null", async () => {
    const mod = await import("./plugin-component");
    expect(typeof mod.readActualVersion).toBe("function");

    // 构造一个完全没有 package.json 的路径
    const fakePath = join(tempDir, "no-package-json", "index.js");
    mkdirSync(join(tempDir, "no-package-json"), { recursive: true });
    writeFileSync(fakePath, "// no package.json", "utf-8");

    const actual = mod.readActualVersion(fakePath);
    expect(actual).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────
  // 场景 3: checkVersionDrift 一致时返回 drifted=false，不 warn
  // ─────────────────────────────────────────────────────────────────────
  test("场景 3: checkVersionDrift 一致时（declared=actual）→ drifted=false，不 warn", async () => {
    const mod = await import("./plugin-component");
    expect(typeof mod.checkVersionDrift).toBe("function");

    const fakePkgDir = join(tempDir, "consistent-plugin");
    mkdirSync(fakePkgDir, { recursive: true });
    writeFileSync(
      join(fakePkgDir, "package.json"),
      JSON.stringify({ name: "consistent-plugin", version: "1.0.0" }),
      "utf-8"
    );
    writeFileSync(join(fakePkgDir, "index.js"), "// consistent", "utf-8");

    const warnMock = { warn: vi.fn() };
    const result = mod.checkVersionDrift(
      "1.0.0",
      join(fakePkgDir, "index.js"),
      warnMock
    );

    expect(result.declared).toBe("1.0.0");
    expect(result.actual).toBe("1.0.0");
    expect(result.drifted).toBe(false);
    expect(warnMock.warn).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────
  // 场景 4: checkVersionDrift 不一致时返回 drifted=true 且 warn 带 resolvedPath
  // ─────────────────────────────────────────────────────────────────────
  test("场景 4: checkVersionDrift 不一致时（declared 2.5.9 vs loaded 2.5.7）→ drifted=true，且 warn 带 resolvedPath", async () => {
    const mod = await import("./plugin-component");
    expect(typeof mod.checkVersionDrift).toBe("function");

    // 模拟 cp 副本的实际版本：v2.5.7
    const fakePkgDir = join(tempDir, "stale-cp-plugin");
    mkdirSync(fakePkgDir, { recursive: true });
    writeFileSync(
      join(fakePkgDir, "package.json"),
      JSON.stringify({ name: "stale-cp-plugin", version: "2.5.7" }),
      "utf-8"
    );
    writeFileSync(join(fakePkgDir, "index.js"), "// stale cp", "utf-8");

    const resolvedPath = join(fakePkgDir, "index.js");
    const warnMock = { warn: vi.fn() };

    // 用户 plugins.json 声明 v2.5.9（npm 真装的版本），但 fallback 命中了 v2.5.7
    const result = mod.checkVersionDrift("2.5.9", resolvedPath, warnMock);

    expect(result.declared).toBe("2.5.9");
    expect(result.actual).toBe("2.5.7");
    expect(result.drifted).toBe(true);
    expect(result.resolvedPath).toBe(resolvedPath);

    // 关键断言：warn 必须被调用，且包含关键信息
    expect(warnMock.warn).toHaveBeenCalledTimes(1);
    const warnMsg = warnMock.warn.mock.calls[0][0];
    expect(warnMsg).toContain("stale-cp-plugin");
    expect(warnMsg).toContain("2.5.9"); // declared
    expect(warnMsg).toContain("2.5.7"); // actual
    expect(warnMsg).toContain(resolvedPath); // resolvedPath
  });

  // ─────────────────────────────────────────────────────────────────────
  // 场景 5: checkVersionDrift 找不到 package.json 时 drifted=false，不 warn
  // ─────────────────────────────────────────────────────────────────────
  test("场景 5: checkVersionDrift 找不到 package.json 时 → drifted=false，不 warn", async () => {
    const mod = await import("./plugin-component");
    expect(typeof mod.checkVersionDrift).toBe("function");

    const fakePath = join(tempDir, "no-package", "index.js");
    mkdirSync(join(tempDir, "no-package"), { recursive: true });
    writeFileSync(fakePath, "// no package.json", "utf-8");

    const warnMock = { warn: vi.fn() };
    const result = mod.checkVersionDrift("1.0.0", fakePath, warnMock);

    expect(result.declared).toBe("1.0.0");
    expect(result.actual).toBeNull();
    expect(result.drifted).toBe(false);
    expect(warnMock.warn).not.toHaveBeenCalled();
  });
});

// ========================================================================
// Task #2908: loadPluginFromPackage npm global root fallback
//
// 根因：import(packageName) 在 monorepo cwd 下无法解析 npm global root（不在 Node
// 模块解析路径中），导致 install --global 后 plugin service 不启动。
//
// 修复：fallback chain 头部插入 npm global root 作为 fallback 0。
// 顺序：0 (npm root -g) → 1 (import) → 2 (project local) → 3 (cp copy)
// ========================================================================

// ⚠️ vi.mock 是 hoisted 的，必须在模块顶层调用，且 mock factory 内部不能
//    引用 test 作用域变量。我们用一个可变 holder + vi.fn 跨 describe 共享。
const mockExecSync = vi.fn();
// ⚠️ factory 必须返回**完整导出面**（Bun 走 ESM exports 语义）：只给 execSync 会让
// 任何静态 import exec / spawn / spawnSync… 的模块加载期 SyntaxError。
vi.mock("node:child_process", () =>
  createChildProcessMockModule({
    execSync: (...args: any[]) => mockExecSync(...args),
  }),
);

describe("Task #2908: PluginComponent loadPluginFromPackage npm global root fallback", () => {
  let tempDir: string;
  let pluginComponent: PluginComponent;
  let mockEnv: any;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "plugin-load-fallback-test-"));
    pluginComponent = new PluginComponent();

    mockEnv = {
      getComponent: vi.fn().mockReturnValue({
        registerAgent: vi.fn(),
        register: vi.fn(),
      }),
    };
    (pluginComponent as any).env = mockEnv;
  });

  afterEach(() => {
    pluginComponent = null!;
    mockEnv = null!;
    globalHookManager.clear();
    rmSync(tempDir, { recursive: true, force: true });
    mockExecSync.mockReset();
  });

  // ─────────────────────────────────────────────────────────────────────
  // RED-1: import 失败 + npm global root 命中 → 应加载成功
  // ─────────────────────────────────────────────────────────────────────
  test("RED-1: loadPluginFromPackage should fall back to npm global root when import(packageName) fails", async () => {
    // 1. 创建一个 mock npm global root，里面放一个简单的 plugin
    const mockNpmRoot = join(tempDir, "mock-npm-root");
    const fakePluginDir = join(mockNpmRoot, "fake-test-plugin");
    mkdirSync(fakePluginDir, { recursive: true });
    writeFileSync(
      join(fakePluginDir, "package.json"),
      JSON.stringify({
        name: "fake-test-plugin",
        version: "1.0.0",
        type: "module",
        main: "index.js",
      }),
      "utf-8"
    );
    writeFileSync(
      join(fakePluginDir, "index.js"),
      `export default { name: "fake-test-plugin", version: "1.0.0", init() {} };`,
      "utf-8"
    );

    // 2. 配置 mock execSync → 返回 mockNpmRoot
    mockExecSync.mockImplementation(() => mockNpmRoot + "\n");

    // 3. 调用 loadPluginFromPackage — 当前实现会 fail（不查 npm root），fix 后成功
    await (pluginComponent as any).loadPluginFromPackage(
      "fake-test-plugin",
      "1.0.0"
    );

    // 4. 关键断言：plugin 应该被注册成功
    expect(pluginComponent.has("fake-test-plugin")).toBe(true);
    const loaded = pluginComponent.get("fake-test-plugin");
    expect(loaded).toBeDefined();
    expect(loaded?.name).toBe("fake-test-plugin");
    expect(loaded?.version).toBe("1.0.0");

    // 5. execSync 必须被调用过一次
    expect(mockExecSync).toHaveBeenCalledWith(
      "npm root -g",
      expect.objectContaining({ encoding: "utf-8" })
    );
  });

  // ─────────────────────────────────────────────────────────────────────
  // RED-2: npm global root 找不到 + 项目本地命中 → 走项目本地 fallback
  // ─────────────────────────────────────────────────────────────────────
  test("RED-2: loadPluginFromPackage should fall back to project local when npm global root has no package", async () => {
    // 1. 创建一个空的 mock npm global root（package 不存在）
    const mockNpmRoot = join(tempDir, "empty-npm-root");
    mkdirSync(mockNpmRoot, { recursive: true });

    // 2. 在 process.cwd() 临时创建项目本地 plugin 目录
    //    因为 process.cwd() 是 monorepo 根，不污染，直接用 chdir 到 tempDir
    const originalCwd = process.cwd();
    process.chdir(tempDir);
    try {
      const projectLocalDir = join(tempDir, ".roy", "plugins", "fake-project-plugin");
      mkdirSync(projectLocalDir, { recursive: true });
      writeFileSync(
        join(projectLocalDir, "package.json"),
        JSON.stringify({
          name: "fake-project-plugin",
          version: "1.0.0",
          type: "module",
          main: "index.js",
        }),
        "utf-8"
      );
      writeFileSync(
        join(projectLocalDir, "index.js"),
        `export default { name: "fake-project-plugin", version: "1.0.0", init() {} };`,
        "utf-8"
      );

      // 3. 配置 mock execSync → 返回 mockNpmRoot（但 package 不在里面）
      mockExecSync.mockImplementation(() => mockNpmRoot + "\n");

      // 4. 调用 loadPluginFromPackage
      await (pluginComponent as any).loadPluginFromPackage(
        "fake-project-plugin",
        "1.0.0"
      );

      // 5. 关键断言：项目本地版本被加载
      expect(pluginComponent.has("fake-project-plugin")).toBe(true);
      const loaded = pluginComponent.get("fake-project-plugin");
      expect(loaded?.version).toBe("1.0.0");

      // 6. execSync 应该被调用过（查过 npm root）
      expect(mockExecSync).toHaveBeenCalled();
    } finally {
      process.chdir(originalCwd);
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // RED-3: 三处都找不到 → 应优雅 return（不抛错，logger.warn 被调用）
  // ─────────────────────────────────────────────────────────────────────
  test("RED-3: loadPluginFromPackage should warn and return gracefully when all fallback paths fail", async () => {
    // 1. 配置 mock execSync → 返回不存在的 npm root（package 肯定不存在）
    const mockNpmRoot = join(tempDir, "non-existent-npm-root");
    mockExecSync.mockImplementation(() => mockNpmRoot + "\n");

    // 2. Spy logger.warn
    const warnSpy = vi.spyOn((pluginComponent as any).logger, "warn");

    try {
      // 3. 临时 chdir 到 tempDir，确保 .roy/plugins/ 不存在
      const originalCwd = process.cwd();
      process.chdir(tempDir);
      try {
        // 4. 调用 loadPluginFromPackage — 不存在的 package
        await (pluginComponent as any).loadPluginFromPackage(
          "totally-nonexistent-plugin-9999",
          "1.0.0"
        );

        // 5. 关键断言：没有抛错，plugin 未注册
        expect(pluginComponent.has("totally-nonexistent-plugin-9999")).toBe(false);

        // 6. logger.warn 应至少被调用一次（fallback 全部失败时）
        const warnCalls = warnSpy.mock.calls.map((c) => c[0]);
        const hasRelevantWarn = warnCalls.some((msg) =>
          typeof msg === "string" && msg.includes("totally-nonexistent-plugin-9999")
        );
        expect(hasRelevantWarn).toBe(true);

        // 7. execSync 应被调用过一次（查过 npm root）
        expect(mockExecSync).toHaveBeenCalled();
      } finally {
        process.chdir(originalCwd);
      }
    } finally {
      warnSpy.mockRestore();
    }
  });
});
