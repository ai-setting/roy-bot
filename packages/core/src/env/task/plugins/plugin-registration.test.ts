/**
 * @fileoverview Plugin Registration Tests - 验证直接使用 Hook 接口的插件注册机制
 */

import { describe, it, expect, beforeEach, vi } from "bun:test";
import { HookManager } from "../../hook/hook-manager";
import { runWithEnvContext } from "../../context";

describe("Plugin Hook Registration", () => {
  let hookManager: HookManager<{ message: string }>;

  beforeEach(() => {
    hookManager = new HookManager({
      componentName: "test",
      componentVersion: "1.0.0",
    });
  });

  describe("Direct Hook Registration", () => {
    it("should register and execute a hook directly", async () => {
      const executed: string[] = [];

      // 直接注册 Hook
      hookManager.register("test:hook", {
        name: "test-hook",
        priority: 10,
        execute: async (ctx) => {
          executed.push(ctx.data.message);
        },
      });

      // 执行 hook
      await hookManager.execute("test:hook", { message: "hello" });

      expect(executed).toEqual(["hello"]);
    });

    it("should support plugin metadata for pluginEnabled check", async () => {
      const executed: string[] = [];

      hookManager.register("test:hook", {
        name: "test-hook-with-plugin",
        priority: 10,
        pluginName: "test-hook",
        sourceId: "test-source",
        execute: async (ctx) => {
          executed.push("executed");
        },
      });

      // 执行时传递 pluginEnabled
      await hookManager.execute("test:hook", { message: "test" }, {
        pluginEnabled: {
          "test-source:test-hook": true,
        },
      });

      expect(executed).toEqual(["executed"]);
    });

    it("should skip hook when plugin is not enabled", async () => {
      const executed: string[] = [];

      hookManager.register("test:hook", {
        name: "disabled-hook",
        priority: 10,
        pluginName: "test-hook",
        sourceId: "test-source",
        execute: async (ctx) => {
          executed.push("executed");
        },
      });

      // 执行时传递 pluginEnabled = false
      await hookManager.execute("test:hook", { message: "test" }, {
        pluginEnabled: {
          "test-source:test-hook": false, // 禁用
        },
      });

      // hook 不应该被执行
      expect(executed).toEqual([]);
    });

    it("should execute hooks in priority order", async () => {
      const executed: number[] = [];

      // 注册多个不同优先级的 hooks
      hookManager.register("test:hook", {
        name: "low-priority",
        priority: 1,
        execute: async () => { executed.push(1); return; },
      });

      hookManager.register("test:hook", {
        name: "high-priority",
        priority: 100,
        execute: async () => { executed.push(100); return; },
      });

      hookManager.register("test:hook", {
        name: "medium-priority",
        priority: 50,
        execute: async () => { executed.push(50); return; },
      });

      await hookManager.execute("test:hook", { message: "test" });

      // 当前实现：低优先级先执行（数字小的先执行）
      expect(executed).toEqual([1, 50, 100]);
    });

    it("should register multiple hooks at once", async () => {
      const executed: string[] = [];

      hookManager.registerMany("test:hook", [
        {
          name: "hook-1",
          priority: 10,
          execute: async () => { executed.push("1"); },
        },
        {
          name: "hook-2",
          priority: 20,
          execute: async () => { executed.push("2"); },
        },
      ]);

      await hookManager.execute("test:hook", { message: "test" });

      // 当前实现：低优先级先执行（数字小的先执行）
      expect(executed).toEqual(["1", "2"]);
    });
  });

  describe("Plugin Pattern - No TaskPlugin Base Class", () => {
    it("should allow plugin pattern without base class", async () => {
      // 模拟一个插件，不继承任何基类，直接使用 Hook 接口
      const myPlugin = {
        name: "my-plugin",
        hooks: [
          { point: "task:after.create", priority: 5 },
          { point: "task:after.update", priority: 5 },
        ],
        execute: async (ctx: any) => {
          if (ctx.hookPoint === "task:after.create") {
            // 执行创建逻辑
          }
          if (ctx.hookPoint === "task:after.update") {
            // 执行更新逻辑
          }
        },
      };

      // 注册插件的 hooks
      for (const hook of myPlugin.hooks) {
        hookManager.register(hook.point, {
          name: `${myPlugin.name}:${hook.point}`,
          priority: hook.priority,
          execute: myPlugin.execute,
        });
      }

      // 执行 hooks
      await hookManager.execute("task:after.create", { message: "test" });
      await hookManager.execute("task:after.update", { message: "test" });

      // 验证 hooks 已注册
      expect(hookManager.count("task:after.create")).toBe(1);
      expect(hookManager.count("task:after.update")).toBe(1);
    });

    it("should unregister hooks by name", async () => {
      hookManager.register("test:hook", {
        name: "to-be-removed",
        priority: 10,
        execute: async () => {},
      });

      expect(hookManager.count("test:hook")).toBe(1);

      const removed = hookManager.unregister("test:hook", "to-be-removed");

      expect(removed).toBe(true);
      expect(hookManager.count("test:hook")).toBe(0);
    });
  });

  describe("Hook Context Enrichment", () => {
    it("should enrich metadata with EnvContext when executing", async () => {
      let receivedMetadata: any;

      hookManager.register("test:hook", {
        name: "metadata-check",
        priority: 10,
        execute: async (ctx) => {
          receivedMetadata = ctx.metadata;
        },
      });

      await runWithEnvContext({
        traceId: "test-trace-123",
        sourceId: "test-source",
        userId: "user_456",
        pluginEnabled: {
          "test-source:test-hook": true,
        },
        envEvent: { metadata: {} },
      } as any, async () => {
        await hookManager.execute("test:hook", { message: "test" });
      });

      // metadata 应该包含 envContext
      expect(receivedMetadata.envContext).toBeDefined();
      expect(receivedMetadata.envContext.traceId).toBe("test-trace-123");
    });
  });
});

describe("Replace TaskPlugin with Hook - Migration Guide", () => {
  it("documents the new plugin pattern", () => {
    // === 旧的 TaskPlugin 模式 ===
    // class MyPlugin extends TaskPlugin {
    //   readonly name = "MyPlugin";
    //   readonly hooks = [{ point: "task:after.create", priority: 5 }];
    //   async execute(ctx: HookContext) { /* ... */ }
    // }
    // taskComponent.registerPlugin(new MyPlugin());

    // === 新的直接 Hook 模式 ===
    const newPlugin = {
      name: "my-plugin",
      hooks: [
        { point: "task:after.create", priority: 5 },
        { point: "task:after.update", priority: 5 },
      ],
      // 直接实现 execute
      execute: async (ctx: any) => {
        console.log("Plugin logic here, ctx.data contains task info");
      },
    };

    // 注册方式：
    // for (const hook of newPlugin.hooks) {
    //   hookManager.register(hook.point, {
    //     name: `${newPlugin.name}:${hook.point}`,
    //     priority: hook.priority,
    //     execute: newPlugin.execute,
    //     pluginName: newPlugin.name,
    //     sourceId: /* from config */,
    //   });
    // }

    // 验证结构正确
    expect(newPlugin.name).toBe("my-plugin");
    expect(newPlugin.hooks).toHaveLength(2);
    expect(typeof newPlugin.execute).toBe("function");
  });
});
