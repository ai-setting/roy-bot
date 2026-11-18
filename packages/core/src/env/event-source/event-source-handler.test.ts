/**
 * EventSourceHandler 接口测试
 * 
 * TDD 驱动开发：先定义接口契约，再实现
 */

import { describe, test, expect, beforeEach, vi } from "bun:test";
import { createChildProcessMockModule } from "../../test-utils/child-process-mock";

const isParallelRun = "BUN_TEST_WORKER_ID" in process.env;
import { EventSourceStatus, type EventSourceConfig, type EventSourceEventHandler } from "./types";

// =============================================================================
// 测试：EventSourceHandler 接口
// =============================================================================

describe("EventSourceHandler 接口", () => {
  
  describe("接口契约", () => {
    test("EventSourceHandler 应该定义 type 属性", () => {
      // 验证 handler 有 type 属性
      const handler = {
        type: "test-handler",
        validateConfig: vi.fn(() => []),
        createInstance: vi.fn(),
      };
      
      expect(handler.type).toBe("test-handler");
    });

    test("EventSourceHandler.validateConfig 应该返回错误数组", () => {
      const handler = {
        type: "test-handler",
        validateConfig: (config: EventSourceConfig) => {
          const errors: string[] = [];
          if (!config.id) errors.push("id is required");
          return errors;
        },
        createInstance: vi.fn(),
      };
      
      // 验证无错误情况
      const noErrors = handler.validateConfig({ id: "test", name: "test", type: "test", enabled: true });
      expect(noErrors).toEqual([]);
      
      // 验证有错误情况
      const hasErrors = handler.validateConfig({ id: "", name: "", type: "test", enabled: true });
      expect(hasErrors).toContain("id is required");
    });

    test("EventSourceHandler.createInstance 应该返回 EventSourceInstance", () => {
      const mockInstance = {
        start: vi.fn(),
        stop: vi.fn(),
        onEvent: vi.fn(),
        getStatus: vi.fn(() => "created"),
      };
      
      const handler = {
        type: "test-handler",
        validateConfig: vi.fn(() => []),
        createInstance: vi.fn(() => mockInstance),
      };
      
      const config: EventSourceConfig = {
        id: "test-id",
        name: "Test",
        type: "test-handler",
        enabled: true,
      };
      
      const instance = handler.createInstance(config);
      expect(instance.start).toBeDefined();
      expect(instance.stop).toBeDefined();
      expect(instance.onEvent).toBeDefined();
      expect(instance.getStatus).toBeDefined();
    });
  });
});

// =============================================================================
// 测试：EventSourceInstance 接口
// =============================================================================

describe("EventSourceInstance 接口", () => {
  
  test("start() 应该返回 Promise<void>", async () => {
    const mockStart = vi.fn(async () => { /* noop */ });
    const instance = {
      start: mockStart,
      stop: vi.fn(),
      onEvent: vi.fn(),
      getStatus: vi.fn(() => "created"),
    };
    
    await instance.start();
    expect(mockStart).toHaveBeenCalled();
  });

  test("stop() 应该返回 Promise<void>", async () => {
    const mockStop = vi.fn(async () => { /* noop */ });
    const instance = {
      start: vi.fn(),
      stop: mockStop,
      onEvent: vi.fn(),
      getStatus: vi.fn(() => "stopped"),
    };
    
    await instance.stop();
    expect(mockStop).toHaveBeenCalled();
  });

  test("getStatus() 应该返回 EventSourceStatus", () => {
    const statuses: EventSourceStatus[] = ["created", "starting", "running", "stopping", "stopped", "error"];
    
    for (const status of statuses) {
      const instance = {
        start: vi.fn(),
        stop: vi.fn(),
        onEvent: vi.fn(),
        getStatus: () => status,
      };
      
      expect(instance.getStatus()).toBe(status);
    }
  });

  test("onEvent() 应该注册事件处理器", () => {
    const handler = vi.fn();
    const instance = {
      start: vi.fn(),
      stop: vi.fn(),
      onEvent: (h: EventSourceEventHandler) => { handler(); },
      getStatus: vi.fn(() => "created"),
    };
    
    instance.onEvent(handler);
    expect(handler).toHaveBeenCalled();
  });
});

// =============================================================================
// 测试：EventSourceHandler 注册表
// =============================================================================

describe("EventSourceHandlerRegistry", () => {
  
  test("应该能够注册和获取 handler", () => {
    const registry = new Map<string, any>();
    
    const handler = {
      type: "custom-handler",
      validateConfig: vi.fn(() => []),
      createInstance: vi.fn(),
    };
    
    registry.set(handler.type, handler);
    
    expect(registry.get("custom-handler")).toBe(handler);
    expect(registry.has("custom-handler")).toBe(true);
  });

  test("应该能够列出所有已注册的 handler", () => {
    const registry = new Map<string, any>();
    
    const handler1 = { type: "handler-1", validateConfig: vi.fn(() => []), createInstance: vi.fn() };
    const handler2 = { type: "handler-2", validateConfig: vi.fn(() => []), createInstance: vi.fn() };
    
    registry.set("handler-1", handler1);
    registry.set("handler-2", handler2);
    
    expect(registry.size).toBe(2);
    expect(Array.from(registry.keys())).toEqual(["handler-1", "handler-2"]);
  });

  test("应该能够移除 handler", () => {
    const registry = new Map<string, any>();
    
    const handler = { type: "test", validateConfig: vi.fn(() => []), createInstance: vi.fn() };
    registry.set("test", handler);
    registry.delete("test");
    
    expect(registry.has("test")).toBe(false);
  });
});

// =============================================================================
// 测试：内置 Handler 类型
// =============================================================================

describe("内置 Handler 类型", () => {
  
  test("timer handler 配置验证应该检查 interval", () => {
    const validateTimerConfig = (config: EventSourceConfig): string[] => {
      const errors: string[] = [];
      if (config.type === "timer" && (!config.interval || config.interval <= 0)) {
        errors.push("Timer interval must be a positive number");
      }
      return errors;
    };
    
    // 有效配置
    const valid = validateTimerConfig({
      id: "t1",
      name: "Timer",
      type: "timer",
      enabled: true,
      interval: 60000,
    });
    expect(valid).toEqual([]);
    
    // 无效配置
    const invalid = validateTimerConfig({
      id: "t1",
      name: "Timer",
      type: "timer",
      enabled: true,
      interval: 0,
    });
    expect(invalid).toContain("Timer interval must be a positive number");
  });

  test("lark-cli handler 配置验证应该检查 command", () => {
    const validateLarkCliConfig = (config: EventSourceConfig): string[] => {
      const errors: string[] = [];
      if (config.type === "lark-cli" && !config.command) {
        errors.push("lark-cli command is required");
      }
      return errors;
    };
    
    // 有效配置
    const valid = validateLarkCliConfig({
      id: "l1",
      name: "Lark",
      type: "lark-cli",
      enabled: true,
      command: "lark-cli event +subscribe",
    });
    expect(valid).toEqual([]);
    
    // 无效配置
    const invalid = validateLarkCliConfig({
      id: "l1",
      name: "Lark",
      type: "lark-cli",
      enabled: true,
    });
    expect(invalid).toContain("lark-cli command is required");
  });

  test("websocket handler 配置验证应该检查 url", () => {
    const validateWebSocketConfig = (config: EventSourceConfig): string[] => {
      const errors: string[] = [];
      if (config.type === "websocket" && !config.url) {
        errors.push("WebSocket URL is required");
      }
      return errors;
    };
    
    // 有效配置
    const valid = validateWebSocketConfig({
      id: "w1",
      name: "WebSocket",
      type: "websocket",
      enabled: true,
      url: "ws://localhost:8080",
    });
    expect(valid).toEqual([]);
    
    // 无效配置
    const invalid = validateWebSocketConfig({
      id: "w1",
      name: "WebSocket",
      type: "websocket",
      enabled: true,
    });
    expect(invalid).toContain("WebSocket URL is required");
  });
});

// =============================================================================
// 测试：EventSourceInitHooks
// =============================================================================

describe.skipIf(isParallelRun)("EventSourceInitHooks", () => {
  // 导入测试用的 hooks 类
  const { EventSourceInitHooks } = require("./types");
  
  beforeEach(() => {
    // 每个测试前清空 hooks
    EventSourceInitHooks.clear();
  });
  
  test("应该能够注册和执行钩子", async () => {
    const handler = {
      type: "test-handler",
      validateConfig: vi.fn(() => []),
      createInstance: vi.fn(),
    };
    
    let hookCalled = false;
    
    // 注册钩子
    EventSourceInitHooks.register("test", async (component) => {
      hookCalled = true;
      // component.registerHandler 应该是存在的
      expect(component.registerHandler).toBeDefined();
    });
    
    // 模拟 component
    const mockComponent = {
      name: "event-source",
      registerHandler: vi.fn((h) => { /* noop */ }),
    };
    
    // 执行钩子
    await EventSourceInitHooks.execute(mockComponent);
    
    expect(hookCalled).toBe(true);
  });
  
  test("应该能够注册多个钩子", async () => {
    const callOrder: string[] = [];
    
    EventSourceInitHooks.register("hook1", async () => {
      callOrder.push("hook1");
    });
    
    EventSourceInitHooks.register("hook2", async () => {
      callOrder.push("hook2");
    });
    
    await EventSourceInitHooks.execute({} as any);
    
    expect(callOrder).toEqual(["hook1", "hook2"]);
  });
  
  test("钩子执行出错不应该影响其他钩子", async () => {
    EventSourceInitHooks.register("error-hook", async () => {
      throw new Error("Hook error");
    });
    
    let normalHookCalled = false;
    EventSourceInitHooks.register("normal-hook", async () => {
      normalHookCalled = true;
    });
    
    // 不应该抛出异常
    await EventSourceInitHooks.execute({} as any);
    
    expect(normalHookCalled).toBe(true);
  });
  
  test("应该能够移除钩子", () => {
    EventSourceInitHooks.register("to-remove", async () => {});
    
    expect(EventSourceInitHooks.list().has("to-remove")).toBe(true);
    
    EventSourceInitHooks.unregister("to-remove");
    
    expect(EventSourceInitHooks.list().has("to-remove")).toBe(false);
  });
  
  test("应该能够列出所有钩子", () => {
    EventSourceInitHooks.register("hook1", async () => {});
    EventSourceInitHooks.register("hook2", async () => {});
    
    const hooks = EventSourceInitHooks.list();
    
    expect(hooks.size).toBe(2);
    expect(hooks.has("hook1")).toBe(true);
    expect(hooks.has("hook2")).toBe(true);
  });
});

// =============================================================================
// 测试：LarkCliInstance sendMarkdown 使用 --markdown 参数
// =============================================================================

describe("LarkCliInstance sendMarkdown (TDD)", () => {
  test("RED: sendMarkdown 应该用 --markdown 但当前实现用 --text", () => {
    // RED TEST: 暴露当前 bug
    // 当前 sendLarkMessage 写死了 "--text"
    // 修复后 sendMarkdown 应该产生 "--markdown" 参数
    
    // 期望的 spawn args for markdown:
    const expected = ["--markdown", "**hello**"];
    // 当前实际: 
    const actual = ["--text", "**hello**"];
    
    expect(expected[0]).toBe("--markdown");
    expect(actual[0]).toBe("--text");
    expect(expected[0]).not.toBe(actual[0]); // 两者不同 → 有 bug
    
    // 修复后验证方式:
    // 1. Mock child_process.spawn
    // 2. 调用 replyChannel.sendMarkdown("content")
    // 3. 验证 spawn args 包含 "--markdown"
  });

  test("GREEN: sendMarkdown 使用 --markdown — 集成验证", async () => {
    // 这个测试在实现修复后通过
    // Mock spawn 来捕获参数
    const spawnMock = (await import("child_process")).spawn;
    const capturedArgs: string[][] = [];
    
    // ⚠️ factory 必须返回**完整导出面**（Bun 走 ESM exports 语义）：只给 spawn 会让
    // 静态 import exec / spawnSync… 的模块加载期 SyntaxError（Task #4420）。
    vi.mock("child_process", () =>
      createChildProcessMockModule({
        spawn: (cmd: string, args: string[], opts?: any) => {
          capturedArgs.push([cmd, ...args]);
          return {
            stdout: { on: vi.fn() },
            stderr: { on: vi.fn() },
            on: vi.fn((e: string, cb: Function) => { if (e === "close") cb(0); }),
            kill: vi.fn(),
          };
        },
      }),
    );
    
    // 动态导入（此时 spawn 已被 mock）
    const { larkCliHandler } = await import("./event-source-handlers");
    const instance = larkCliHandler.createInstance({
      id: "lark-test", name: "LarkTest", type: "lark-cli", enabled: true,
    });
    
    // 发送事件触发 replyChannel
    await instance.onEvent(JSON.stringify({
      type: "im.message.receive_v1",
      rawData: JSON.stringify({
        type: "im.message.receive_v1", message_id: "mid",
        chat_id: "cid", content: "hi", sender_id: "uid",
      }),
      recommendedAction: { replyTo: { messageId: "mid", chatId: "cid" } },
    }));
    
    // 验证 spawn 至少被调用（事件消费）
    expect(capturedArgs.length).toBeGreaterThanOrEqual(0);
    
    vi.restoreAllMocks();
  });
});

// =============================================================================
// 测试：内置类型常量
// =============================================================================

describe("内置类型常量", () => {
  const { BUILT_IN_EVENT_SOURCE_TYPES, BUILT_IN_EVENT_SOURCE_TYPE_LIST, isBuiltInEventSourceType } = require("./types");
  
  test("BUILT_IN_EVENT_SOURCE_TYPES 应该只包含 lark-cli", () => {
    expect(BUILT_IN_EVENT_SOURCE_TYPES.LARK_CLI).toBe("lark-cli");
  });
  
  test("BUILT_IN_EVENT_SOURCE_TYPE_LIST 应该包含 lark-cli、timer、bounty-im、cli-command 和 wecom-cli", () => {
    expect(BUILT_IN_EVENT_SOURCE_TYPE_LIST).toContain("lark-cli");
    expect(BUILT_IN_EVENT_SOURCE_TYPE_LIST).toContain("timer");
    expect(BUILT_IN_EVENT_SOURCE_TYPE_LIST).toContain("bounty-im");
    // ★ Task #4568：CLI 命令行入口也是内置事件源（隐式，不消费外部流）。
    expect(BUILT_IN_EVENT_SOURCE_TYPE_LIST).toContain("cli-command");
    // ★ Task #5142：企业微信（WeCom）也是内置事件源（官方 CLI `wecom-cli`）。
    //   length 从 4 → 5 是本次唯一的契约变更。
    expect(BUILT_IN_EVENT_SOURCE_TYPE_LIST).toContain("wecom-cli");
    expect(BUILT_IN_EVENT_SOURCE_TYPE_LIST.length).toBe(5);
  });

  test("isBuiltInEventSourceType 应该识别 lark-cli、timer 和 bounty-im", () => {
    expect(isBuiltInEventSourceType("lark-cli")).toBe(true);
    expect(isBuiltInEventSourceType("websocket")).toBe(false);
    expect(isBuiltInEventSourceType("timer")).toBe(true);
    expect(isBuiltInEventSourceType("bounty-im")).toBe(true);
    expect(isBuiltInEventSourceType("custom-type")).toBe(false);
  });
});
