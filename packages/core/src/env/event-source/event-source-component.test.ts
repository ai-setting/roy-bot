/**
 * EventSourceComponent 测试
 * 
 * TDD 驱动开发：测试基于 Handler 注册机制的新版 EventSourceComponent
 */

import { describe, test, expect, beforeEach, vi } from "bun:test";

const isParallelRun = "BUN_TEST_WORKER_ID" in process.env;
import { 
  EventSourceStatus, 
  type EventSourceConfig, 
  type EventSourceHandler,
  type EventSourceInstance,
  type EventSourceEventHandler,
  type EventSourceEvent,
  EventSourceInitHooks,
  BUILT_IN_EVENT_SOURCE_TYPES,
} from "./types";

// =============================================================================
// Mock 实现
// =============================================================================

/**
 * 创建测试用的 Handler
 */
function createMockHandler(type: string): EventSourceHandler {
  return {
    type,
    validateConfig: (config: EventSourceConfig) => {
      const errors: string[] = [];
      if (type === "websocket" && !config.url) {
        errors.push("URL is required for websocket");
      }
      if (type === "timer" && (!config.interval || config.interval <= 0)) {
        errors.push("Interval must be positive for timer");
      }
      if (type === "lark-cli" && !config.command) {
        errors.push("Command is required for lark-cli");
      }
      if (type === "bounty-im" && !config.address) {
        errors.push("Address is required for bounty-im");
      }
      return errors;
    },
    createInstance: (config: EventSourceConfig): EventSourceInstance => {
      let status: EventSourceStatus = "created";
      let eventHandler: EventSourceEventHandler | null = null;
      
      return {
        start: vi.fn(async () => { 
          status = "running"; 
        }),
        stop: vi.fn(async () => { 
          status = "stopped"; 
        }),
        getStatus: () => status,
        onEvent: vi.fn((handler: EventSourceEventHandler) => { 
          eventHandler = handler; 
        }),
        offEvent: vi.fn(() => { 
          eventHandler = null; 
        }),
      };
    },
  };
}

// =============================================================================
// 模拟 EventSourceComponent（简化版，用于测试）
// =============================================================================

class MockEventSourceComponent {
  readonly name = "event-source";
  readonly version = "1.0.0";
  
  private sources: Map<string, EventSourceConfig> = new Map();
  private statuses: Map<string, EventSourceStatus> = new Map();
  private handlers: Map<string, EventSourceHandler> = new Map();
  private instances: Map<string, EventSourceInstance> = new Map();
  private eventHandlers: Map<string, EventSourceEventHandler> = new Map();
  
  async onInit(): Promise<void> {
    await EventSourceInitHooks.execute(this);
  }
  
  registerHandler(handler: EventSourceHandler): void {
    this.handlers.set(handler.type, handler);
  }
  
  unregisterHandler(type: string): boolean {
    return this.handlers.delete(type);
  }
  
  getHandler(type: string): EventSourceHandler | undefined {
    return this.handlers.get(type);
  }
  
  listHandlers(): EventSourceHandler[] {
    return Array.from(this.handlers.values());
  }
  
  register(config: EventSourceConfig): void {
    if (this.sources.has(config.id)) {
      throw new Error(`EventSource already exists: ${config.id}`);
    }
    
    const handler = this.handlers.get(config.type);
    if (!handler) {
      throw new Error(`No handler registered for event source type: ${config.type}`);
    }
    
    const errors = handler.validateConfig(config);
    if (errors.length > 0) {
      throw new Error(`Invalid config: ${errors.join(", ")}`);
    }
    
    this.sources.set(config.id, config);
    this.statuses.set(config.id, "created");
  }
  
  unregister(id: string): boolean {
    const existed = this.sources.has(id);
    if (this.statuses.get(id) === "running") {
      this.stopSource(id);
    }
    this.sources.delete(id);
    this.statuses.delete(id);
    this.instances.delete(id);
    this.eventHandlers.delete(id);
    return existed;
  }
  
  get(id: string): EventSourceConfig | undefined {
    return this.sources.get(id);
  }
  
  list(): EventSourceConfig[] {
    return Array.from(this.sources.values());
  }
  
  getEventSourceStatus(id: string): EventSourceStatus | undefined {
    return this.statuses.get(id);
  }
  
  onEvent(id: string, handler: EventSourceEventHandler): void {
    this.eventHandlers.set(id, handler);
    const instance = this.instances.get(id);
    if (instance) {
      instance.onEvent(handler);
    }
  }
  
  offEvent(id: string): void {
    this.eventHandlers.delete(id);
    const instance = this.instances.get(id);
    if (instance) {
      instance.offEvent();
    }
  }
  
  async startSource(id: string): Promise<void> {
    const config = this.sources.get(id);
    if (!config) {
      throw new Error(`EventSource not found: ${id}`);
    }
    
    const currentStatus = this.statuses.get(id);
    if (currentStatus === "running") {
      return;
    }
    
    this.statuses.set(id, "starting");
    
    const handler = this.handlers.get(config.type);
    if (!handler) {
      throw new Error(`No handler registered for event source type: ${config.type}`);
    }
    
    const instance = handler.createInstance(config);
    this.instances.set(id, instance);
    
    const eventHandler = this.eventHandlers.get(id);
    if (eventHandler) {
      instance.onEvent(eventHandler);
    }
    
    await instance.start();
    this.statuses.set(id, "running");
  }
  
  async stopSource(id: string): Promise<void> {
    const status = this.statuses.get(id);
    if (status === "stopped" || status === "created") {
      return;
    }
    
    this.statuses.set(id, "stopping");
    
    const instance = this.instances.get(id);
    if (instance) {
      await instance.stop();
      this.instances.delete(id);
    }
    
    this.statuses.set(id, "stopped");
  }
}

// =============================================================================
// 测试：Handler 注册机制
// =============================================================================

describe("Handler 注册机制", () => {
  let component: MockEventSourceComponent;
  
  beforeEach(() => {
    component = new MockEventSourceComponent();
    EventSourceInitHooks.clear();
  });
  
  test("应该能注册 Handler", async () => {
    await component.onInit();
    
    component.registerHandler(createMockHandler("custom-source"));
    
    expect(component.getHandler("custom-source")).toBeDefined();
  });
  
  test("应该能注册多个 Handler", async () => {
    await component.onInit();
    
    component.registerHandler(createMockHandler("source-1"));
    component.registerHandler(createMockHandler("source-2"));
    component.registerHandler(createMockHandler("source-3"));
    
    expect(component.listHandlers()).toHaveLength(3);
  });
  
  test("应该能注销 Handler", async () => {
    await component.onInit();
    
    component.registerHandler(createMockHandler("my-source"));
    expect(component.getHandler("my-source")).toBeDefined();
    
    component.unregisterHandler("my-source");
    expect(component.getHandler("my-source")).toBeUndefined();
  });
  
  test("应该能获取 Handler", async () => {
    await component.onInit();
    
    const handler = createMockHandler("my-source");
    component.registerHandler(handler);
    
    const retrieved = component.getHandler("my-source");
    expect(retrieved).toBe(handler);
  });
});

// =============================================================================
// 测试：事件源注册
// =============================================================================

describe("事件源注册", () => {
  let component: MockEventSourceComponent;
  
  beforeEach(() => {
    component = new MockEventSourceComponent();
    EventSourceInitHooks.clear();
  });
  
  test("应该能注册事件源", async () => {
    await component.onInit();
    component.registerHandler(createMockHandler("timer"));
    
    const config: EventSourceConfig = {
      id: "timer-1",
      name: "My Timer",
      type: "timer",
      enabled: true,
      interval: 1000,
    };
    
    component.register(config);
    
    expect(component.get("timer-1")).toBeDefined();
    expect(component.getEventSourceStatus("timer-1")).toBe("created");
  });
  
  test("注册重复 ID 应该抛出错误", async () => {
    await component.onInit();
    component.registerHandler(createMockHandler("timer"));
    
    const config: EventSourceConfig = {
      id: "timer-1",
      name: "My Timer",
      type: "timer",
      enabled: true,
      interval: 1000,
    };
    
    component.register(config);
    
    expect(() => component.register(config)).toThrow("EventSource already exists");
  });
  
  test("注册时应该验证配置", async () => {
    await component.onInit();
    component.registerHandler(createMockHandler("timer"));
    
    const config: EventSourceConfig = {
      id: "timer-1",
      name: "My Timer",
      type: "timer",
      enabled: true,
      interval: 0, // 无效
    };
    
    expect(() => component.register(config)).toThrow("Invalid config");
  });
  
  test("注册时应该检查 Handler 是否存在", async () => {
    await component.onInit();
    // 不注册任何 handler
    
    const config: EventSourceConfig = {
      id: "unknown-1",
      name: "Unknown",
      type: "unknown-type",
      enabled: true,
    };
    
    expect(() => component.register(config)).toThrow("No handler registered");
  });
  
  test("应该能列出所有事件源", async () => {
    await component.onInit();
    component.registerHandler(createMockHandler("timer"));
    
    component.register({ id: "t1", name: "T1", type: "timer", enabled: true, interval: 1000 });
    component.register({ id: "t2", name: "T2", type: "timer", enabled: true, interval: 2000 });
    
    expect(component.list()).toHaveLength(2);
  });
  
  test("应该能注销事件源", async () => {
    await component.onInit();
    component.registerHandler(createMockHandler("timer"));
    
    component.register({ id: "t1", name: "T1", type: "timer", enabled: true, interval: 1000 });
    expect(component.get("t1")).toBeDefined();
    
    component.unregister("t1");
    expect(component.get("t1")).toBeUndefined();
  });
});

// =============================================================================
// 测试：生命周期控制
// =============================================================================

describe("生命周期控制", () => {
  let component: MockEventSourceComponent;
  
  beforeEach(() => {
    component = new MockEventSourceComponent();
    EventSourceInitHooks.clear();
  });
  
  test("startSource 应该使用 Handler 创建并启动实例", async () => {
    await component.onInit();
    component.registerHandler(createMockHandler("timer"));
    
    component.register({
      id: "timer-1",
      name: "My Timer",
      type: "timer",
      enabled: true,
      interval: 1000,
    });
    
    await component.startSource("timer-1");
    
    expect(component.getEventSourceStatus("timer-1")).toBe("running");
  });
  
  test("startSource 应该跳过已运行的源", async () => {
    await component.onInit();
    component.registerHandler(createMockHandler("timer"));
    
    component.register({
      id: "timer-1",
      name: "My Timer",
      type: "timer",
      enabled: true,
      interval: 1000,
    });
    
    await component.startSource("timer-1");
    await component.startSource("timer-1"); // 重复启动
    
    expect(component.getEventSourceStatus("timer-1")).toBe("running");
  });
  
  test("startSource 找不到源应该抛出错误", async () => {
    await component.onInit();
    component.registerHandler(createMockHandler("timer"));
    
    await expect(component.startSource("non-existent")).rejects.toThrow("EventSource not found");
  });
  
  test("stopSource 应该停止实例", async () => {
    await component.onInit();
    component.registerHandler(createMockHandler("timer"));
    
    component.register({
      id: "timer-1",
      name: "My Timer",
      type: "timer",
      enabled: true,
      interval: 1000,
    });
    
    await component.startSource("timer-1");
    expect(component.getEventSourceStatus("timer-1")).toBe("running");
    
    await component.stopSource("timer-1");
    expect(component.getEventSourceStatus("timer-1")).toBe("stopped");
  });
  
  test("stopSource 应该跳过已停止的源", async () => {
    await component.onInit();
    component.registerHandler(createMockHandler("timer"));
    
    component.register({
      id: "timer-1",
      name: "My Timer",
      type: "timer",
      enabled: true,
      interval: 1000,
    });
    
    await component.stopSource("timer-1"); // 从未启动
    
    expect(component.getEventSourceStatus("timer-1")).toBe("created");
  });
  
  test("注销已运行的源应该先停止", async () => {
    await component.onInit();
    component.registerHandler(createMockHandler("timer"));
    
    component.register({
      id: "timer-1",
      name: "My Timer",
      type: "timer",
      enabled: true,
      interval: 1000,
    });
    
    await component.startSource("timer-1");
    expect(component.getEventSourceStatus("timer-1")).toBe("running");
    
    component.unregister("timer-1");
    expect(component.getEventSourceStatus("timer-1")).toBeUndefined();
  });
});

// =============================================================================
// 测试：事件处理
// =============================================================================

describe("事件处理", () => {
  let component: MockEventSourceComponent;
  
  beforeEach(() => {
    component = new MockEventSourceComponent();
    EventSourceInitHooks.clear();
  });
  
  test("应该能注册事件处理器", async () => {
    await component.onInit();
    component.registerHandler(createMockHandler("timer"));
    
    component.register({
      id: "timer-1",
      name: "My Timer",
      type: "timer",
      enabled: true,
      interval: 1000,
    });
    
    const handler = vi.fn();
    component.onEvent("timer-1", handler);
    
    expect(component["eventHandlers"].has("timer-1")).toBe(true);
  });
  
  test("应该能注销事件处理器", async () => {
    await component.onInit();
    component.registerHandler(createMockHandler("timer"));
    
    component.register({
      id: "timer-1",
      name: "My Timer",
      type: "timer",
      enabled: true,
      interval: 1000,
    });
    
    component.onEvent("timer-1", vi.fn());
    component.offEvent("timer-1");
    
    expect(component["eventHandlers"].has("timer-1")).toBe(false);
  });
  
  test("启动后注册处理器应该同步到实例", async () => {
    await component.onInit();
    component.registerHandler(createMockHandler("timer"));
    
    component.register({
      id: "timer-1",
      name: "My Timer",
      type: "timer",
      enabled: true,
      interval: 1000,
    });
    
    await component.startSource("timer-1");
    
    const handler = vi.fn();
    component.onEvent("timer-1", handler);
    
    // 处理器应该被设置到实例
    const instance = component["instances"].get("timer-1");
    expect(instance?.onEvent).toHaveBeenCalled();
  });
});

// =============================================================================
// 测试：EventSourceInitHooks 集成
// =============================================================================

describe.skipIf(isParallelRun)("EventSourceInitHooks 集成", () => {
  let component: MockEventSourceComponent;
  
  beforeEach(() => {
    component = new MockEventSourceComponent();
    EventSourceInitHooks.clear();
  });
  
  test("onInit 应该执行所有注册的 hooks", async () => {
    EventSourceInitHooks.register("handler-1", async (comp: any) => {
      comp.registerHandler(createMockHandler("hook-source-1"));
    });
    
    EventSourceInitHooks.register("handler-2", async (comp: any) => {
      comp.registerHandler(createMockHandler("hook-source-2"));
    });
    
    await component.onInit();
    
    expect(component.getHandler("hook-source-1")).toBeDefined();
    expect(component.getHandler("hook-source-2")).toBeDefined();
  });
  
  test("hook 出错不应该影响其他 hooks", async () => {
    let otherHookCalled = false;
    
    EventSourceInitHooks.register("error-hook", async () => {
      throw new Error("Hook error");
    });
    
    EventSourceInitHooks.register("normal-hook", async (comp: any) => {
      otherHookCalled = true;
      comp.registerHandler(createMockHandler("normal-source"));
    });
    
    await component.onInit();
    
    expect(otherHookCalled).toBe(true);
    expect(component.getHandler("normal-source")).toBeDefined();
  });
  
  test("bounty-im 可以通过 hook 注册", async () => {
    EventSourceInitHooks.register("bounty-im", async (comp: any) => {
      comp.registerHandler(createMockHandler("bounty-im"));
    });
    
    await component.onInit();
    
    expect(component.getHandler("bounty-im")).toBeDefined();
    
    // 验证 bounty-im handler 的配置验证
    const handler = component.getHandler("bounty-im")!;
    const errors = handler.validateConfig({
      id: "b1",
      name: "B1",
      type: "bounty-im",
      enabled: true,
    });
    expect(errors).toContain("Address is required for bounty-im");
  });
});

// =============================================================================
// 测试：内置 Handler
// =============================================================================

describe("内置 Handler", () => {
  let component: MockEventSourceComponent;
  
  beforeEach(() => {
    component = new MockEventSourceComponent();
    EventSourceInitHooks.clear();
  });
  
  test("timer handler 配置验证", async () => {
    await component.onInit();
    component.registerHandler(createMockHandler("timer"));
    
    const config: EventSourceConfig = {
      id: "t1",
      name: "T1",
      type: "timer",
      enabled: true,
      interval: 1000,
    };
    
    component.register(config);
    expect(component.get("t1")).toBeDefined();
    
    // 无效配置
    const handler = component.getHandler("timer")!;
    const errors = handler.validateConfig({ ...config, interval: 0 });
    expect(errors).toContain("Interval must be positive for timer");
  });
  
  test("websocket handler 配置验证", async () => {
    await component.onInit();
    component.registerHandler(createMockHandler("websocket"));
    
    const config: EventSourceConfig = {
      id: "w1",
      name: "W1",
      type: "websocket",
      enabled: true,
      url: "ws://localhost:8080",
    };
    
    component.register(config);
    expect(component.get("w1")).toBeDefined();
  });
  
  test("lark-cli handler 配置验证", async () => {
    await component.onInit();
    component.registerHandler(createMockHandler("lark-cli"));
    
    const config: EventSourceConfig = {
      id: "l1",
      name: "L1",
      type: "lark-cli",
      enabled: true,
      command: "lark-cli event +subscribe",
    };
    
    component.register(config);
    expect(component.get("l1")).toBeDefined();
  });
});

// =============================================================================
// 测试：完整流程
// =============================================================================

describe("完整流程", () => {
  let component: MockEventSourceComponent;
  
  beforeEach(() => {
    component = new MockEventSourceComponent();
    EventSourceInitHooks.clear();
  });
  
  test("注册 → 启动 → 停止 → 注销", async () => {
    await component.onInit();
    component.registerHandler(createMockHandler("timer"));
    
    // 1. 注册
    const config: EventSourceConfig = {
      id: "timer-1",
      name: "My Timer",
      type: "timer",
      enabled: true,
      interval: 1000,
    };
    component.register(config);
    expect(component.getEventSourceStatus("timer-1")).toBe("created");
    
    // 2. 启动
    await component.startSource("timer-1");
    expect(component.getEventSourceStatus("timer-1")).toBe("running");
    
    // 3. 停止
    await component.stopSource("timer-1");
    expect(component.getEventSourceStatus("timer-1")).toBe("stopped");
    
    // 4. 注销
    component.unregister("timer-1");
    expect(component.get("timer-1")).toBeUndefined();
  });
  
  test("bounty-im 通过 hook 注册并完整流程", async () => {
    EventSourceInitHooks.register("bounty-im", async (comp: any) => {
      comp.registerHandler(createMockHandler("bounty-im"));
    });
    
    await component.onInit();
    
    // 注册事件源
    const config: EventSourceConfig = {
      id: "bounty-1",
      name: "My Bounty",
      type: "bounty-im",
      enabled: true,
      address: "agent-1@localhost",
    };
    component.register(config);
    
    // 启动
    await component.startSource("bounty-1");
    expect(component.getEventSourceStatus("bounty-1")).toBe("running");
    
    // 停止
    await component.stopSource("bounty-1");
    expect(component.getEventSourceStatus("bounty-1")).toBe("stopped");
  });
});
