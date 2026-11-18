import { describe, test, expect, beforeEach } from "bun:test";

const isParallelRun = "BUN_TEST_WORKER_ID" in process.env;
import { HookManager } from "./hook-manager";
import type { Hook, HookContext } from "./types";
import { createHook } from "./types";

// 测试用的上下文类型
interface TestData {
  value: number;
}

// 创建测试 Hook 的辅助函数
function makeHook(
  name: string,
  execute: (ctx: HookContext<TestData>) => void | Promise<void>,
  priority?: number
): Hook<TestData> {
  return createHook({ name, priority }, execute);
}

describe("HookManager", () => {
  let manager: HookManager<TestData>;

  beforeEach(() => {
    manager = new HookManager<TestData>();
  });

  // ========================================================================
  // 基础功能测试
  // ========================================================================

  describe("register", () => {
    test("should register a hook to a hook point", () => {
      const hook = makeHook("test-hook", async () => {});
      
      manager.register("test.point", hook);
      
      expect(manager.count("test.point")).toBe(1);
    });

    test("should register multiple hooks to the same hook point", () => {
      const hook1 = makeHook("hook-1", async () => {});
      const hook2 = makeHook("hook-2", async () => {});
      
      manager.register("test.point", hook1);
      manager.register("test.point", hook2);
      
      expect(manager.count("test.point")).toBe(2);
    });

    test("should register hooks to different hook points", () => {
      const hook1 = makeHook("hook-1", async () => {});
      const hook2 = makeHook("hook-2", async () => {});
      
      manager.register("point.1", hook1);
      manager.register("point.2", hook2);
      
      expect(manager.count("point.1")).toBe(1);
      expect(manager.count("point.2")).toBe(1);
    });
  });

  describe("registerMany", () => {
    test("should register multiple hooks at once", () => {
      const hooks = [
        makeHook("hook-1", async () => {}),
        makeHook("hook-2", async () => {}),
      ];
      
      manager.registerMany("test.point", hooks);
      
      expect(manager.count("test.point")).toBe(2);
    });

    test("should register empty array", () => {
      manager.registerMany("test.point", []);
      expect(manager.count("test.point")).toBe(0);
    });
  });

  describe("unregister", () => {
    test("should unregister a hook by name", () => {
      const hook1 = makeHook("hook-1", async () => {});
      const hook2 = makeHook("hook-2", async () => {});
      
      manager.register("test.point", hook1);
      manager.register("test.point", hook2);
      
      const result = manager.unregister("test.point", "hook-1");
      
      expect(result).toBe(true);
      expect(manager.count("test.point")).toBe(1);
    });

    test("should return false if hook not found", () => {
      const result = manager.unregister("nonexistent", "hook");
      expect(result).toBe(false);
    });
  });

  describe("unregisterAll", () => {
    test("should unregister all hooks at a hook point", () => {
      manager.register("test.point", makeHook("hook-1", async () => {}));
      manager.register("test.point", makeHook("hook-2", async () => {}));
      
      manager.unregisterAll("test.point");
      
      expect(manager.count("test.point")).toBe(0);
    });
  });

  describe("count", () => {
    test("should return 0 for non-existent hook point", () => {
      expect(manager.count("nonexistent")).toBe(0);
    });
  });

  describe("clear", () => {
    test("should clear all hooks", () => {
      manager.register("point.1", makeHook("hook-1", async () => {}));
      manager.register("point.2", makeHook("hook-2", async () => {}));
      
      manager.clear();
      
      expect(manager.count("point.1")).toBe(0);
      expect(manager.count("point.2")).toBe(0);
    });
  });

  describe("getHookPoints", () => {
    test("should return all registered hook points", () => {
      manager.register("point.1", makeHook("hook-1", async () => {}));
      manager.register("point.2", makeHook("hook-2", async () => {}));
      manager.register("point.3", makeHook("hook-3", async () => {}));
      
      const points = manager.getHookPoints();
      
      expect(points).toContain("point.1");
      expect(points).toContain("point.2");
      expect(points).toContain("point.3");
    });

    test("should return empty array when no hooks registered", () => {
      expect(manager.getHookPoints()).toEqual([]);
    });
  });

  // ========================================================================
  // 执行测试
  // ========================================================================

  describe("execute", () => {
    test("should execute all hooks at a hook point", async () => {
      const executionOrder: string[] = [];
      
      manager.register("test.point", makeHook("hook-1", async () => {
        executionOrder.push("hook-1");
      }));
      manager.register("test.point", makeHook("hook-2", async () => {
        executionOrder.push("hook-2");
      }));
      
      await manager.execute("test.point", { value: 42 }, { meta: "test" });
      
      expect(executionOrder).toEqual(["hook-1", "hook-2"]);
    });

    test("should pass correct context to hooks", async () => {
      let receivedCtx: HookContext<TestData> | null = null;
      
      manager.register("test.point", makeHook("test-hook", async (ctx) => {
        receivedCtx = ctx;
      }));
      
      const testData = { value: 123 };
      const testMeta = { source: "unit-test" };
      
      await manager.execute("test.point", testData, testMeta);
      
      expect(receivedCtx).not.toBeNull();
      expect(receivedCtx!.data).toEqual(testData);
      expect(receivedCtx!.metadata).toEqual(testMeta);
      expect(receivedCtx!.phase).toBe("before");
      expect(receivedCtx!.hookPoint).toBe("test.point");
    });

    test("should do nothing for non-existent hook point", async () => {
      const hook = makeHook("should-not-run", async () => {
        throw new Error("This hook should not run");
      });
      
      // 不注册，直接执行
      await manager.execute("nonexistent", { value: 0 });
      
      // 没有错误即为通过
      expect(true).toBe(true);
    });
  });

  describe("executeAndCollect", () => {
    test("should collect return values from hooks", async () => {
      manager.register("test.point", makeHook("hook-1", async () => "result-1"));
      manager.register("test.point", makeHook("hook-2", async () => "result-2"));
      
      const results = await manager.executeAndCollect<string>("test.point", { value: 0 });
      
      expect(results).toEqual(["result-1", "result-2"]);
    });

    test("should return empty array for non-existent hook point", async () => {
      const results = await manager.executeAndCollect<string>("nonexistent", { value: 0 });
      expect(results).toEqual([]);
    });
  });

  // ========================================================================
  // 优先级测试
  // ========================================================================

  describe("hook priority", () => {
    test("should execute hooks in priority order (lower priority first)", async () => {
      const executionOrder: string[] = [];
      
      manager.register("test.point", makeHook("low-priority", async () => {
        executionOrder.push("low-priority");
      }, 100));
      
      manager.register("test.point", makeHook("high-priority", async () => {
        executionOrder.push("high-priority");
      }, 1));
      
      manager.register("test.point", makeHook("medium-priority", async () => {
        executionOrder.push("medium-priority");
      }, 50));
      
      await manager.execute("test.point", { value: 0 });
      
      expect(executionOrder).toEqual([
        "high-priority",
        "medium-priority",
        "low-priority"
      ]);
    });

    test("should maintain registration order for same priority", async () => {
      const executionOrder: string[] = [];
      
      manager.register("test.point", makeHook("first", async () => {
        executionOrder.push("first");
      }, 0));
      
      manager.register("test.point", makeHook("second", async () => {
        executionOrder.push("second");
      }, 0));
      
      await manager.execute("test.point", { value: 0 });
      
      expect(executionOrder).toEqual(["first", "second"]);
    });

    test("should use default priority 0 when not specified", async () => {
      const executionOrder: string[] = [];
      
      manager.register("test.point", makeHook("with-priority", async () => {
        executionOrder.push("with-priority");
      }, 10));
      
      manager.register("test.point", makeHook("no-priority", async () => {
        executionOrder.push("no-priority");
      }));
      
      await manager.execute("test.point", { value: 0 });
      
      expect(executionOrder).toEqual(["no-priority", "with-priority"]);
    });
  });

  // ========================================================================
  // 错误隔离测试
  // ========================================================================

  describe.skipIf(isParallelRun)("error isolation", () => {
    test("should not throw if a hook throws", async () => {
      manager.register("test.point", makeHook("failing-hook", async () => {
        throw new Error("Hook failed");
      }));
      
      manager.register("test.point", makeHook("good-hook", async () => {}));
      
      // 应该不抛出错误 - 直接调用而不是用 expect
      let threw = false;
      try {
        await manager.execute("test.point", { value: 0 });
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
    });

    test("should continue executing other hooks if one fails", async () => {
      const executionOrder: string[] = [];
      
      manager.register("test.point", makeHook("hook-1", async () => {
        executionOrder.push("hook-1");
      }));
      
      manager.register("test.point", makeHook("failing-hook", async () => {
        throw new Error("Hook failed");
      }));
      
      manager.register("test.point", makeHook("hook-2", async () => {
        executionOrder.push("hook-2");
      }));
      
      await manager.execute("test.point", { value: 0 });
      
      expect(executionOrder).toEqual(["hook-1", "hook-2"]);
    });

    test("should handle async hooks throwing", async () => {
      const executionOrder: string[] = [];
      
      manager.register("test.point", makeHook("hook-1", async () => {
        executionOrder.push("hook-1");
      }));
      
      manager.register("test.point", makeHook("async-failing", async () => {
        await Promise.resolve();
        throw new Error("Async hook failed");
      }));
      
      manager.register("test.point", makeHook("hook-2", async () => {
        executionOrder.push("hook-2");
      }));
      
      await manager.execute("test.point", { value: 0 });
      
      expect(executionOrder).toEqual(["hook-1", "hook-2"]);
    });
  });

  // ========================================================================
  // pluginEnabled 检查测试
  // ========================================================================

  describe("pluginEnabled check", () => {
    test("should skip hook if pluginName and sourceId are set but not enabled in metadata", async () => {
      const executedHooks: string[] = [];
      
      // 注册带 pluginName 和 sourceId 的 hook
      manager.register("test.point", {
        name: "es-hook-1",
        priority: 0,
        pluginName: "task-tag",
        sourceId: "es-lark-1",
        execute: async () => { executedHooks.push("es-hook-1"); },
      });
      
      // 注册不带 pluginName 的 hook（应该总是执行）
      manager.register("test.point", {
        name: "normal-hook",
        priority: 0,
        execute: async () => { executedHooks.push("normal-hook"); },
      });
      
      // 执行时不传递 pluginEnabled
      await manager.execute("test.point", { value: 0 });
      
      // 只有 normal-hook 执行
      expect(executedHooks).toEqual(["normal-hook"]);
    });

    test("should execute hook if enabled in pluginEnabled metadata", async () => {
      const executedHooks: string[] = [];
      
      manager.register("test.point", {
        name: "es-hook-1",
        priority: 0,
        pluginName: "task-tag",
        sourceId: "es-lark-1",
        execute: async () => { executedHooks.push("es-hook-1"); },
      });
      
      manager.register("test.point", {
        name: "es-hook-2",
        priority: 0,
        pluginName: "task-tag",
        sourceId: "es-bounty-1",
        execute: async () => { executedHooks.push("es-hook-2"); },
      });
      
      // 只启用 es-lark-1:task-tag
      await manager.execute("test.point", { value: 0 }, {
        pluginEnabled: {
          "es-lark-1:task-tag": true,
        },
      });
      
      expect(executedHooks).toEqual(["es-hook-1"]);
    });

    test("should execute multiple hooks if all enabled", async () => {
      const executedHooks: string[] = [];
      
      manager.register("test.point", {
        name: "es-hook-1",
        priority: 0,
        pluginName: "task-tag",
        sourceId: "es-lark-1",
        execute: async () => { executedHooks.push("es-hook-1"); },
      });
      
      manager.register("test.point", {
        name: "es-hook-2",
        priority: 0,
        pluginName: "bounty-plugin",
        sourceId: "es-bounty-1",
        execute: async () => { executedHooks.push("es-hook-2"); },
      });
      
      manager.register("test.point", {
        name: "normal-hook",
        priority: 0,
        execute: async () => { executedHooks.push("normal-hook"); },
      });
      
      await manager.execute("test.point", { value: 0 }, {
        pluginEnabled: {
          "es-lark-1:task-tag": true,
          "es-bounty-1:bounty-plugin": true,
        },
      });
      
      expect(executedHooks).toEqual(["es-hook-1", "es-hook-2", "normal-hook"]);
    });

    test("should respect priority order with pluginEnabled check", async () => {
      const executedHooks: string[] = [];
      
      manager.register("test.point", {
        name: "high-priority",
        priority: 1,
        pluginName: "task-tag",
        sourceId: "es-lark-1",
        execute: async () => { executedHooks.push("high-priority"); },
      });
      
      manager.register("test.point", {
        name: "low-priority",
        priority: 100,
        pluginName: "task-tag",
        sourceId: "es-lark-1",
        execute: async () => { executedHooks.push("low-priority"); },
      });
      
      await manager.execute("test.point", { value: 0 }, {
        pluginEnabled: {
          "es-lark-1:task-tag": true,
        },
      });
      
      expect(executedHooks).toEqual(["high-priority", "low-priority"]);
    });
  });

  // ========================================================================
  // 生命周期测试
  // ========================================================================

  describe("hook lifecycle", () => {
    test("should pass component info to hooks", async () => {
      let receivedCtx: HookContext<TestData> | null = null;
      const customManager = new HookManager<TestData>({
        componentName: "TestComponent",
        componentVersion: "2.0.0"
      });
      
      customManager.register("test.point", makeHook("test-hook", async (ctx) => {
        receivedCtx = ctx;
      }));
      
      await customManager.execute("test.point", { value: 0 });
      
      expect(receivedCtx!.component.name).toBe("TestComponent");
      expect(receivedCtx!.component.version).toBe("2.0.0");
    });

    test("should pass correct hookPoint to hooks", async () => {
      let receivedHookPoint: string | null = null;
      
      manager.register("my.hook.point", makeHook("test-hook", async (ctx) => {
        receivedHookPoint = ctx.hookPoint;
      }));
      
      await manager.execute("my.hook.point", { value: 0 });
      
      expect(receivedHookPoint).toBe("my.hook.point");
    });
  });
});
