/**
 * 内置 Handler 实现测试
 * 
 * 测试 lark-cli、timer、websocket 内置 Handler 的功能
 */

import { describe, test, expect, vi, beforeEach, mock } from "bun:test";
import { createChildProcessMockModule } from "../../test-utils/child-process-mock";
import type { 
  EventSourceConfig, 
  EventSourceInstance,
  EventSourceHandler,
} from "./types";

// =============================================================================
// 模拟 Handler（用于测试）
// =============================================================================

/**
 * 模拟 LarkCliHandler（不实际启动进程）
 */
function createMockLarkCliHandler(): EventSourceHandler {
  return {
    type: "lark-cli",
    validateConfig: (config) => {
      const errors: string[] = [];
      if (!config.command) {
        errors.push("lark-cli command is required");
      }
      return errors;
    },
    createInstance: (config): EventSourceInstance => {
      let status = "created";
      let eventHandler: any = null;
      
      return {
        start: vi.fn(async () => { status = "running"; }),
        stop: vi.fn(async () => { status = "stopped"; }),
        getStatus: () => status,
        onEvent: vi.fn((h) => { eventHandler = h; }),
        offEvent: vi.fn(() => { eventHandler = null; }),
      };
    },
  };
}

/**
 * 模拟 TimerHandler
 */
function createMockTimerHandler(): EventSourceHandler {
  return {
    type: "timer",
    validateConfig: (config) => {
      const errors: string[] = [];
      if (!config.interval || config.interval <= 0) {
        errors.push("Timer interval must be a positive number");
      }
      return errors;
    },
    createInstance: (config): EventSourceInstance => {
      let status = "created";
      let eventHandler: any = null;
      
      return {
        start: vi.fn(async () => { status = "running"; }),
        stop: vi.fn(async () => { status = "stopped"; }),
        getStatus: () => status,
        onEvent: vi.fn((h) => { eventHandler = h; }),
        offEvent: vi.fn(() => { eventHandler = null; }),
      };
    },
  };
}

/**
 * 模拟 WebSocketHandler
 */
function createMockWebSocketHandler(): EventSourceHandler {
  return {
    type: "websocket",
    validateConfig: (config) => {
      const errors: string[] = [];
      if (!config.url) {
        errors.push("WebSocket URL is required");
      }
      return errors;
    },
    createInstance: (config): EventSourceInstance => {
      let status = "created";
      let eventHandler: any = null;
      
      return {
        start: vi.fn(async () => { status = "running"; }),
        stop: vi.fn(async () => { status = "stopped"; }),
        getStatus: () => status,
        onEvent: vi.fn((h) => { eventHandler = h; }),
        offEvent: vi.fn(() => { eventHandler = null; }),
      };
    },
  };
}

// =============================================================================
// 测试：LarkCli Handler
// =============================================================================

describe("LarkCli Handler", () => {
  let handler: EventSourceHandler;
  
  beforeEach(() => {
    handler = createMockLarkCliHandler();
  });
  
  test("type 应该是 'lark-cli'", () => {
    expect(handler.type).toBe("lark-cli");
  });
  
  test("validateConfig 应该验证 command", () => {
    const errors = handler.validateConfig({
      id: "test",
      name: "Test",
      type: "lark-cli",
      enabled: true,
      channelPromptMode: "legacy", // ★ ES-M1: 本组守护 legacy 长模板形态
      command: "lark-cli event +subscribe",
    });
    expect(errors).toEqual([]);
    
    const errors2 = handler.validateConfig({
      id: "test",
      name: "Test",
      type: "lark-cli",
      enabled: true,
      channelPromptMode: "legacy", // ★ ES-M1: 本组守护 legacy 长模板形态
    });
    expect(errors2).toContain("lark-cli command is required");
  });
  
  test("createInstance 应该返回 EventSourceInstance", () => {
    const config: EventSourceConfig = {
      id: "lark-1",
      name: "My Lark",
      type: "lark-cli",
      enabled: true,
      channelPromptMode: "legacy", // ★ ES-M1: 本组守护 legacy 长模板形态
      command: "lark-cli event +subscribe",
    };
    
    const instance = handler.createInstance(config);
    
    expect(instance.start).toBeDefined();
    expect(instance.stop).toBeDefined();
    expect(instance.getStatus).toBeDefined();
    expect(instance.onEvent).toBeDefined();
    expect(instance.offEvent).toBeDefined();
  });
  
  test("实例应该能启动和停止", async () => {
    const instance = handler.createInstance({
      id: "lark-1",
      name: "My Lark",
      type: "lark-cli",
      enabled: true,
      channelPromptMode: "legacy", // ★ ES-M1: 本组守护 legacy 长模板形态
      command: "lark-cli event +subscribe",
    });
    
    expect(instance.getStatus()).toBe("created");
    
    await instance.start();
    expect(instance.start).toHaveBeenCalled();
    
    await instance.stop();
    expect(instance.stop).toHaveBeenCalled();
  });
});

// =============================================================================
// 测试：Timer Handler
// =============================================================================

describe("Timer Handler", () => {
  let handler: EventSourceHandler;
  
  beforeEach(() => {
    handler = createMockTimerHandler();
  });
  
  test("type 应该是 'timer'", () => {
    expect(handler.type).toBe("timer");
  });
  
  test("validateConfig 应该验证 interval", () => {
    const errors = handler.validateConfig({
      id: "test",
      name: "Test",
      type: "timer",
      enabled: true,
      interval: 60000,
    });
    expect(errors).toEqual([]);
    
    const errors2 = handler.validateConfig({
      id: "test",
      name: "Test",
      type: "timer",
      enabled: true,
      interval: 0,
    });
    expect(errors2).toContain("Timer interval must be a positive number");
    
    const errors3 = handler.validateConfig({
      id: "test",
      name: "Test",
      type: "timer",
      enabled: true,
    });
    expect(errors3).toContain("Timer interval must be a positive number");
  });
  
  test("createInstance 应该返回 EventSourceInstance", () => {
    const config: EventSourceConfig = {
      id: "timer-1",
      name: "My Timer",
      type: "timer",
      enabled: true,
      interval: 1000,
    };
    
    const instance = handler.createInstance(config);
    
    expect(instance.start).toBeDefined();
    expect(instance.stop).toBeDefined();
    expect(instance.getStatus).toBeDefined();
  });
  
  test("实例应该能启动和停止", async () => {
    const instance = handler.createInstance({
      id: "timer-1",
      name: "My Timer",
      type: "timer",
      enabled: true,
      interval: 1000,
    });
    
    expect(instance.getStatus()).toBe("created");
    
    await instance.start();
    expect(instance.start).toHaveBeenCalled();
    expect(instance.getStatus()).toBe("running");
    
    await instance.stop();
    expect(instance.stop).toHaveBeenCalled();
    expect(instance.getStatus()).toBe("stopped");
  });
});

// =============================================================================
// 测试：WebSocket Handler
// =============================================================================

describe("WebSocket Handler", () => {
  let handler: EventSourceHandler;
  
  beforeEach(() => {
    handler = createMockWebSocketHandler();
  });
  
  test("type 应该是 'websocket'", () => {
    expect(handler.type).toBe("websocket");
  });
  
  test("validateConfig 应该验证 url", () => {
    const errors = handler.validateConfig({
      id: "test",
      name: "Test",
      type: "websocket",
      enabled: true,
      url: "ws://localhost:8080",
    });
    expect(errors).toEqual([]);
    
    const errors2 = handler.validateConfig({
      id: "test",
      name: "Test",
      type: "websocket",
      enabled: true,
    });
    expect(errors2).toContain("WebSocket URL is required");
  });
  
  test("createInstance 应该返回 EventSourceInstance", () => {
    const config: EventSourceConfig = {
      id: "ws-1",
      name: "My WebSocket",
      type: "websocket",
      enabled: true,
      url: "ws://localhost:8080",
    };
    
    const instance = handler.createInstance(config);
    
    expect(instance.start).toBeDefined();
    expect(instance.stop).toBeDefined();
    expect(instance.getStatus).toBeDefined();
  });
  
  test("实例应该能启动和停止", async () => {
    const instance = handler.createInstance({
      id: "ws-1",
      name: "My WebSocket",
      type: "websocket",
      enabled: true,
      url: "ws://localhost:8080",
    });
    
    expect(instance.getStatus()).toBe("created");
    
    await instance.start();
    expect(instance.start).toHaveBeenCalled();
    
    await instance.stop();
    expect(instance.stop).toHaveBeenCalled();
  });
});

// =============================================================================
// 测试：内置 Handler 列表
// =============================================================================

describe("内置 Handler 列表", () => {
  test("应该包含 lark-cli、timer、websocket", () => {
    const builtInHandlers: EventSourceHandler[] = [
      createMockLarkCliHandler(),
      createMockTimerHandler(),
      createMockWebSocketHandler(),
    ];
    
    const types = builtInHandlers.map(h => h.type);
    
    expect(types).toContain("lark-cli");
    expect(types).toContain("timer");
    expect(types).toContain("websocket");
    expect(types).toHaveLength(3);
  });
});

// =============================================================================
// 测试：完整流程（使用模拟）
// =============================================================================

describe("完整流程（使用模拟 Handler）", () => {
  let handlers: Map<string, EventSourceHandler>;
  let instances: Map<string, EventSourceInstance>;
  let sources: Map<string, EventSourceConfig>;
  let statuses: Map<string, string>;
  
  beforeEach(() => {
    handlers = new Map();
    instances = new Map();
    sources = new Map();
    statuses = new Map();
    
    // 注册所有内置 Handler
    handlers.set("lark-cli", createMockLarkCliHandler());
    handlers.set("timer", createMockTimerHandler());
    handlers.set("websocket", createMockWebSocketHandler());
  });
  
  test("使用 timer Handler 完整流程", async () => {
    // 1. 注册事件源
    const config: EventSourceConfig = {
      id: "timer-1",
      name: "My Timer",
      type: "timer",
      enabled: true,
      interval: 1000,
    };
    sources.set("timer-1", config);
    statuses.set("timer-1", "created");
    
    // 2. 获取 Handler 并创建实例
    const handler = handlers.get("timer")!;
    const instance = handler.createInstance(config);
    instances.set("timer-1", instance);
    
    // 3. 启动
    await instance.start();
    statuses.set("timer-1", instance.getStatus());
    expect(statuses.get("timer-1")).toBe("running");
    
    // 4. 停止
    await instance.stop();
    statuses.set("timer-1", instance.getStatus());
    expect(statuses.get("timer-1")).toBe("stopped");
  });
  
  test("使用 websocket Handler 完整流程", async () => {
    const config: EventSourceConfig = {
      id: "ws-1",
      name: "My WS",
      type: "websocket",
      enabled: true,
      url: "ws://localhost:8080",
    };
    
    const handler = handlers.get("websocket")!;
    const instance = handler.createInstance(config);
    instances.set("ws-1", instance);
    
    await instance.start();
    expect(instance.start).toHaveBeenCalled();
    
    await instance.stop();
    expect(instance.stop).toHaveBeenCalled();
  });
  
  test("Handler 找不到时应该抛出错误", () => {
    const config: EventSourceConfig = {
      id: "unknown-1",
      name: "Unknown",
      type: "unknown-type",
      enabled: true,
    };
    
    const handler = handlers.get("unknown-type");
    expect(handler).toBeUndefined();
  });
});

// =============================================================================
// 测试：recommendedAction profile 注入（TDD #1637）
// =============================================================================
// 这些测试验证 extractMetadata 构建的 recommendedAction 在 profile 字段注入后
// 能正确引导 LLM 使用对应的 lark-cli profile 调用。openId 是 per-app 隔离的，
// 不同 appId 的 event-source 必须用对应 profile 回复。
// --------------------------------------------------------------------
describe("recommendedAction profile injection (TDD #1637)", () => {
  // Mock child_process.spawn，避免真实启动 lark-cli
  const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
  const spawnMock = mock((cmd: string, args: string[]) => {
    spawnCalls.push({ cmd, args: [...args] });
    return {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: (event: string, cb: Function) => {
        if (event === "close") cb(0);
      },
      kill: () => {},
      pid: 99999,
    } as any;
  });

  // exec 替身：源码里两处使用 exec 的地方都是「调 lark-cli」——
  //   1. probeBusyEventKeys()（`event status --json`，best-effort 探测）
  //   2. patchCardByLarkCli()（卡片更新）
  // 单测绝不允许真的 spawn 外部二进制，所以把 exec 也替换成返回空 stdout 的桩。
  // 注意：仍必须提供**完整导出面**（Bun 走 ESM exports 语义），所以 exec 之外的
  // 导出交给共享 factory 自省派生；漏任何一个都会让整个文件加载期 SyntaxError
  // （这正是 Task #4420 修复的 48 条全红的根因）。
  const execStub = mock(
    (_cmd: string, cb?: Function) => {
      // execAsync = promisify(exec) → 走 callback(err, {stdout, stderr})
      if (typeof cb === "function") cb(null, { stdout: "", stderr: "" });
      return { on: () => {}, kill: () => {}, pid: 99998 } as any;
    },
  );

  beforeEach(() => {
    spawnCalls.length = 0;
    spawnMock.mockClear();
    execStub.mockClear();
    mock.module("child_process", () =>
      createChildProcessMockModule({
        spawn: spawnMock,
        exec: execStub as any,
      }),
    );
  });

  // 回归钉：验证 exec 确实被替换成桩（而不是透传真实实现）。
  // 若哪天有人把 helper 用法退回「只 mock spawn」，本测试会先红，
  // 比整个文件 48 条集体 SyntaxError 好定位得多。
  test("child_process mock 提供完整导出面，且 exec 是桩（不 spawn 外部二进制）", async () => {
    const cp = await import("child_process");
    for (const name of ["spawn", "exec", "execSync", "execFile", "spawnSync", "fork"]) {
      expect(typeof (cp as any)[name]).not.toBe("undefined");
    }
    expect((cp as any).exec).toBe(execStub as any);
  });

  /**
   * 构造一个 im.message.receive_v1 飞书事件
   */
  function makeLarkMessageEvent(overrides: any = {}): any {
    return {
      type: "im.message.receive_v1",
      event: {
        header: {
          event_type: "im.message.receive_v1",
          app_id: overrides.appId || "cli_app123",
          tenant_key: "tenant_xyz",
        },
        message: {
          message_id: "om_msg_001",
          chat_id: "oc_chat_001",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "hello" }),
        },
        sender: {
          sender_id: { open_id: "ou_user_001" },
        },
      },
    };
  }

  test("RED: 有 profile 时 recommendedAction.action 文本包含 profile=\"zhishitong\"（legacy 模式守护）", async () => {
    // 动态 import 让 mock.module 生效
    // ★ ES-M1（Task #5144）：lean 模式下 action 是动态卡片，规则文本
    //   前置渠道 systemPrompt；profile 注入的文本形态由 legacy 模式守护。
    const { larkCliHandler: ReloadedHandler } = await import("./event-source-handlers");
    const handler = ReloadedHandler;
    const instance = handler.createInstance({
      id: "es-zhishitong",
      name: "智事通",
      type: "lark-cli",
      enabled: true,
      channelPromptMode: "legacy", // ★ ES-M1: 本组守护 legacy 长模板形态
      profile: "zhishitong",  // 关键字段
      channelPromptMode: "legacy",
    });

    // 注册事件处理器
    let capturedEvent: any = null;
    instance.onEvent((evt) => {
      capturedEvent = evt;
    });

    // 直接调用 handleEvent 注入测试事件
    const rawEvent = makeLarkMessageEvent();
    await (instance as any).handleEvent(JSON.stringify(rawEvent));

    expect(capturedEvent).not.toBeNull();
    const action = capturedEvent.payload.recommendedAction;
    expect(action).toBeDefined();
    expect(action.action).toContain('profile="zhishitong"');
  });

  test("RED: 有 profile 时 action 文本示例命令包含 --profile zhishitong（legacy 模式守护）", async () => {
    // ★ ES-M1：legacy 模式守护长模板命令插值（lean 卡片不携带模板）。
    const { larkCliHandler: ReloadedHandler } = await import("./event-source-handlers");
    const handler = ReloadedHandler;
    const instance = handler.createInstance({
      id: "es-zhishitong",
      name: "智事通",
      type: "lark-cli",
      enabled: true,
      channelPromptMode: "legacy", // ★ ES-M1: 本组守护 legacy 长模板形态
      profile: "zhishitong",
      channelPromptMode: "legacy",
    });

    let capturedEvent: any = null;
    instance.onEvent((evt) => {
      capturedEvent = evt;
    });

    const rawEvent = makeLarkMessageEvent();
    await (instance as any).handleEvent(JSON.stringify(rawEvent));

    const action = capturedEvent.payload.recommendedAction;
    expect(action.action).toContain("--profile zhishitong");
  });

  test("RED: 有 profile 时 replyTo.profile === \"zhishitong\"", async () => {
    const { larkCliHandler: ReloadedHandler } = await import("./event-source-handlers");
    const handler = ReloadedHandler;
    const instance = handler.createInstance({
      id: "es-zhishitong",
      name: "智事通",
      type: "lark-cli",
      enabled: true,
      channelPromptMode: "legacy", // ★ ES-M1: 本组守护 legacy 长模板形态
      profile: "zhishitong",
    });

    let capturedEvent: any = null;
    instance.onEvent((evt) => {
      capturedEvent = evt;
    });

    const rawEvent = makeLarkMessageEvent();
    await (instance as any).handleEvent(JSON.stringify(rawEvent));

    const action = capturedEvent.payload.recommendedAction;
    expect(action.replyTo).toBeDefined();
    expect(action.replyTo.profile).toBe("zhishitong");
    expect(action.replyTo.appId).toBe("cli_app123");
    expect(action.replyTo.chatId).toBe("oc_chat_001");
    expect(action.replyTo.messageId).toBe("om_msg_001");
  });

  test("RED: 没 profile 时 action 文本不含 --profile（不污染 lark-test）", async () => {
    const { larkCliHandler: ReloadedHandler } = await import("./event-source-handlers");
    const handler = ReloadedHandler;
    const instance = handler.createInstance({
      id: "es-larktest",
      name: "lark-test",
      type: "lark-cli",
      enabled: true,
      channelPromptMode: "legacy", // ★ ES-M1: 本组守护 legacy 长模板形态
      // 没有 profile
    });

    let capturedEvent: any = null;
    instance.onEvent((evt) => {
      capturedEvent = evt;
    });

    const rawEvent = makeLarkMessageEvent();
    await (instance as any).handleEvent(JSON.stringify(rawEvent));

    const action = capturedEvent.payload.recommendedAction;
    expect(action).toBeDefined();
    expect(action.action).not.toContain("--profile");
    expect(action.action).not.toContain("profile=");
  });

  test("RED: 没 profile 时 replyTo.profile === undefined", async () => {
    const { larkCliHandler: ReloadedHandler } = await import("./event-source-handlers");
    const handler = ReloadedHandler;
    const instance = handler.createInstance({
      id: "es-larktest",
      name: "lark-test",
      type: "lark-cli",
      enabled: true,
      channelPromptMode: "legacy", // ★ ES-M1: 本组守护 legacy 长模板形态
    });

    let capturedEvent: any = null;
    instance.onEvent((evt) => {
      capturedEvent = evt;
    });

    const rawEvent = makeLarkMessageEvent();
    await (instance as any).handleEvent(JSON.stringify(rawEvent));

    const action = capturedEvent.payload.recommendedAction;
    expect(action.replyTo).toBeDefined();
    expect(action.replyTo.profile).toBeUndefined();
  });

  test("RED: LarkCliInstance.start() 用 --profile flag 启动 lark-cli event consume", async () => {
    const { larkCliHandler: ReloadedHandler } = await import("./event-source-handlers");
    const handler = ReloadedHandler;
    const instance = handler.createInstance({
      id: "es-zhishitong",
      name: "智事通",
      type: "lark-cli",
      enabled: true,
      channelPromptMode: "legacy", // ★ ES-M1: 本组守护 legacy 长模板形态
      profile: "zhishitong",
    });

    // start() 会调用 spawn("exec <command>", [], { shell: true })
    // 我们 mock spawn 之后检查 cmd 是否包含 --profile zhishitong
    await instance.start();

    expect(spawnCalls.length).toBeGreaterThanOrEqual(1);
    // 第一条 spawn 调用是 event consume，应该包含 --profile zhishitong
    const startCall = spawnCalls[0];
    expect(startCall.cmd).toContain("lark-cli");
    // cmd 是 "exec lark-cli event consume im.message.receive_v1 --as bot" 之类
    // 改造后应包含 --profile zhishitong
    expect(startCall.cmd).toContain("--profile");
    expect(startCall.cmd).toContain("zhishitong");

    // 不调用 stop()，因为 mock 进程不会自然退出，会 hang
  });

  test("RED: LarkCliInstance.start() 没 profile 时命令不包含 --profile", async () => {
    const { larkCliHandler: ReloadedHandler } = await import("./event-source-handlers");
    const handler = ReloadedHandler;
    const instance = handler.createInstance({
      id: "es-larktest",
      name: "lark-test",
      type: "lark-cli",
      enabled: true,
      channelPromptMode: "legacy", // ★ ES-M1: 本组守护 legacy 长模板形态
      // 没有 profile
    });

    await instance.start();

    expect(spawnCalls.length).toBeGreaterThanOrEqual(1);
    const startCall = spawnCalls[0];
    expect(startCall.cmd).not.toContain("--profile");
    // 不调用 stop()，因为 mock 进程不会自然退出，会 hang
  });

  test("validateConfig 应该不返回非空错误（command 是可选的）", () => {
    const { larkCliHandler: ReloadedHandler } = require("./event-source-handlers");
    const errors = ReloadedHandler.validateConfig({
      id: "test-validate",
      name: "validate-test",
      type: "lark-cli",
      enabled: true,
      channelPromptMode: "legacy", // ★ ES-M1: 本组守护 legacy 长模板形态
      // 没有 command
    });
    // 修复 (#1637): validateConfig 不应拒绝没有 command 的配置,
    // 因为 command 是可选的,默认会用 lark-cli event consume ... 启动。
    expect(errors).toEqual([]);
  });

  // =====================================================================
  // TDD #2115 (Round 4 更新): recommendedAction 必须强调 --markdown 必用
  //
  // 原始诉求：示例命令应使用 --markdown 而非 --text, 因为 --text 容易引导 LLM
  // 进入纯文本路径, 历史上跟纯文本转义渲染问题相关。
  //
  // Round 4 演进：prompt 现在不仅在示例里用 --markdown, 还在顶部加 ⭐ 关键
  // 说明强制 --markdown, 并在"禁止"章节明确禁用 --text / --msg-type text。
  // 因此测试断言从 "不出现 --text" 改为 "--text 必须在禁止列表里",
  // 且 --markdown flag 必须在示例里。
  // =====================================================================
  test("TDD #2115 (Round 4): 有 profile 时示例用 --markdown, 且 --text 被列入禁止（legacy 模式守护）", async () => {
    // ★ ES-M1：--markdown 强调是渠道 prompt 的静态规则文本（lean），
    //   本测试改为 legacy 模式守护同一规则在长模板里的形态。
    const { larkCliHandler: ReloadedHandler } = await import("./event-source-handlers");
    const instance = ReloadedHandler.createInstance({
      id: "es-md-with-profile",
      name: "markdown-test",
      type: "lark-cli",
      enabled: true,
      channelPromptMode: "legacy", // ★ ES-M1: 本组守护 legacy 长模板形态
      profile: "zhishitong",
      channelPromptMode: "legacy",
    });

    let capturedEvent: any = null;
    instance.onEvent((evt) => {
      capturedEvent = evt;
    });

    const rawEvent = makeLarkMessageEvent();
    await (instance as any).handleEvent(JSON.stringify(rawEvent));

    const action = capturedEvent.payload.recommendedAction;
    expect(action).toBeDefined();
    expect(action.action).toContain("--markdown");
    // Round 4: --text 必须出现在"禁止"章节, 不能简单断言不出现
    expect(action.action).toMatch(/禁止.*--text|--text.*禁止/s);
  });

  test("TDD #2115 (Round 4): 没 profile 时示例也用 --markdown, 且 --text 被列入禁止（legacy 模式守护）", async () => {
    const { larkCliHandler: ReloadedHandler } = await import("./event-source-handlers");
    const instance = ReloadedHandler.createInstance({
      id: "es-md-no-profile",
      name: "markdown-test-no-profile",
      type: "lark-cli",
      enabled: true,
      channelPromptMode: "legacy", // ★ ES-M1: 本组守护 legacy 长模板形态
      channelPromptMode: "legacy",
      // 没有 profile
    });

    let capturedEvent: any = null;
    instance.onEvent((evt) => {
      capturedEvent = evt;
    });

    const rawEvent = makeLarkMessageEvent();
    await (instance as any).handleEvent(JSON.stringify(rawEvent));

    const action = capturedEvent.payload.recommendedAction;
    expect(action).toBeDefined();
    expect(action.action).toContain("--markdown");
    expect(action.action).toMatch(/禁止.*--text|--text.*禁止/s);
  });
});
// =============================================================================
// TDD #2185: recommendedAction.action prompt 必须主动教 LLM 安全传多行 Markdown
//
// 背景：旧 prompt 示例 `--markdown "Markdown 格式回复内容"` 太简短，LLM 在多行
// Markdown 时通常直接内联拼成类似 `$'## 标题<NL><NL>body'` 的字面字符串，agent 工具
// 调用不做 shell 展开，飞书收到字面 $ 与字面反斜杠+n，显示坏掉。
//
// 修复目标：action prompt 文本必须
//   1) 推荐"先写临时 .md 文件 → --markdown \"$(cat /tmp/lark-reply.md)\""路径
//   2) 显式禁止：$'...' ANSI-C 引号、字面反斜杠+n、--markdown -、--markdown @file
//   3) 必须使用 replyTo 给定的 profile / chatId / messageId / --as bot
//   4) 既有 replyTo 结构（appId / profile / chatId / messageId）保持不变
//
// RED：本组测试先失败（在未引入 helper / 未改 prompt 之前）。
// =============================================================================
describe("recommendedAction safe markdown prompt (TDD #2185)", () => {
  // 把每种"不安全模式"展开成出现在 prompt 文本中就会被禁掉的具体字面
  const FORBIDDEN_PATTERNS = {
    ansiCQuote: "$'",         // 禁止 ANSI-C $'...'
    dashStdin: "--markdown -", // 禁止 stdin
    atFile: "--markdown @file", // 禁止 @file
  } as const;
  // 字面 "\n"（反斜杠 + n 两个字符）的检查必须在 prompt 文本里作为警示出现，
  // 但不能让 LLM 把它当控制字符（0x0A）拼进命令参数。

  function makeLarkEvent(overrides: any = {}): any {
    return {
      type: "im.message.receive_v1",
      event: {
        header: {
          event_type: "im.message.receive_v1",
          app_id: overrides.appId || "cli_app123",
          tenant_key: "tenant_xyz",
        },
        message: {
          message_id: overrides.messageId || "om_msg_001",
          chat_id: overrides.chatId || "oc_chat_001",
          chat_type: overrides.chatType || "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "hello" }),
        },
        sender: {
          sender_id: { open_id: overrides.senderId || "ou_user_001" },
        },
      },
    };
  }

  // 真实 nohup.out 中的事件 shape（简化格式 / 顶层 message_id、chat_id 等）
  function makeSimplifiedLarkEvent(overrides: any = {}): any {
    return {
      type: "im.message.receive_v1",
      event_id: overrides.event_id || "48ad92f2b0e9b6a25ed879800ae0ad5e",
      timestamp: overrides.timestamp || "1782992944589",
      id: overrides.messageId || "om_x100b6b514dcc24b4c3767e97c0fa45a",
      message_id: overrides.messageId || "om_x100b6b514dcc24b4c3767e97c0fa45a",
      create_time: overrides.create_time || "1782992944228",
      chat_id: overrides.chatId || "oc_20ea15b1276eb336a60757bfabdd43f9",
      chat_type: overrides.chatType || "p2p",
      message_type: "text",
      sender_id: overrides.senderId || "ou_b9924f48dc122c3dad0ff4f37851c09b",
      content: "hi",
    };
  }

  async function captureRecommendedAction(config: any, rawEvent: any): Promise<any> {
    const { larkCliHandler: ReloadedHandler } = await import("./event-source-handlers");
    const instance = ReloadedHandler.createInstance(config);
    let capturedEvent: any = null;
    instance.onEvent((evt: any) => {
      capturedEvent = evt;
    });
    await (instance as any).handleEvent(JSON.stringify(rawEvent));
    return capturedEvent?.payload?.recommendedAction;
  }

  // ---------------------------------------------------------------------------
  // 1. p2p + 有 profile：必须显式教 LLM 安全传 Markdown + 推荐用 cat $reply_file
  // ---------------------------------------------------------------------------
  test("TDD #2185 r2: p2p + 有 profile 时 action 推荐 jq --rawfile + --content 结构化路径", async () => {
    const action = await captureRecommendedAction(
      {
        id: "es-p2p-with-profile",
        name: "智事通",
        type: "lark-cli",
        enabled: true,
        channelPromptMode: "legacy", // ★ ES-M1: 本组守护 legacy 长模板形态
        profile: "zhishitong",
      },
      makeLarkEvent(),
    );
    expect(action).toBeDefined();
    expect(action.action).toContain('--rawfile md "$body_file"');
    expect(action.action).toContain('--content "$content"');
  });

  test("TDD #2185: p2p + 有 profile 时 action 文本不含 ANSI-C / --markdown - / --markdown @file", async () => {
    const action = await captureRecommendedAction(
      {
        id: "es-p2p-with-profile",
        name: "智事通",
        type: "lark-cli",
        enabled: true,
        channelPromptMode: "legacy", // ★ ES-M1: 本组守护 legacy 长模板形态
        profile: "zhishitong",
      },
      makeLarkEvent(),
    );
    expect(action).toBeDefined();
    expect(action.action).not.toContain(FORBIDDEN_PATTERNS.ansiCQuote);
    expect(action.action).not.toContain(FORBIDDEN_PATTERNS.dashStdin);
    expect(action.action).not.toContain(FORBIDDEN_PATTERNS.atFile);
  });

  test("TDD #2185: p2p + 有 profile 时 action 文本警示字面反斜杠+n（不是 0x0A 控制字符）", async () => {
    const action = await captureRecommendedAction(
      {
        id: "es-p2p-with-profile",
        name: "智事通",
        type: "lark-cli",
        enabled: true,
        channelPromptMode: "legacy", // ★ ES-M1: 本组守护 legacy 长模板形态
        profile: "zhishitong",
      },
      makeLarkEvent(),
    );
    expect(action).toBeDefined();
    // 必须以警示形式出现字面 "\n"（反斜杠 + n 两个字符），告诉 LLM 这个序列不能直接拼进 --markdown
    expect(action.action).toContain("\\n");
  });

  test("TDD #2185: p2p + 有 profile 时 action 文本告诉 LLM 必须使用 replyTo.profile", async () => {
    const action = await captureRecommendedAction(
      {
        id: "es-p2p-with-profile",
        name: "智事通",
        type: "lark-cli",
        enabled: true,
        channelPromptMode: "legacy", // ★ ES-M1: 本组守护 legacy 长模板形态
        profile: "zhishitong",
      },
      makeLarkEvent(),
    );
    expect(action).toBeDefined();
    expect(action.action).toContain("zhishitong");
    // 必须明确告诉 LLM 不要凭印象拼接
    expect(action.action).toMatch(/replyTo|reply_to|reply\.to/i);
  });

  test("TDD #2185: p2p + 有 profile 时 replyTo 既有结构保持不变", async () => {
    const action = await captureRecommendedAction(
      {
        id: "es-p2p-with-profile",
        name: "智事通",
        type: "lark-cli",
        enabled: true,
        channelPromptMode: "legacy", // ★ ES-M1: 本组守护 legacy 长模板形态
        profile: "zhishitong",
      },
      makeLarkEvent({
        appId: "cli_app123",
        chatId: "oc_chat_001",
        messageId: "om_msg_001",
      }),
    );
    expect(action).toBeDefined();
    expect(action.replyTo).toBeDefined();
    expect(action.replyTo.appId).toBe("cli_app123");
    expect(action.replyTo.profile).toBe("zhishitong");
    expect(action.replyTo.chatId).toBe("oc_chat_001");
    expect(action.replyTo.messageId).toBe("om_msg_001");
  });

  // ---------------------------------------------------------------------------
  // 2. p2p + 无 profile：同样的禁令；不污染 --profile 标志
  // ---------------------------------------------------------------------------
  test("TDD #2185: p2p + 无 profile 时 action 不含 --profile、不含不安全模式、推荐 cat 路径", async () => {
    const action = await captureRecommendedAction(
      {
        id: "es-p2p-no-profile",
        name: "lark-test",
        type: "lark-cli",
        enabled: true,
        channelPromptMode: "legacy", // ★ ES-M1: 本组守护 legacy 长模板形态
      },
      makeLarkEvent(),
    );
    expect(action).toBeDefined();
    expect(action.action).not.toContain("--profile");
    expect(action.action).not.toContain("profile=");
    expect(action.action).not.toContain(FORBIDDEN_PATTERNS.ansiCQuote);
    expect(action.action).not.toContain(FORBIDDEN_PATTERNS.dashStdin);
    expect(action.action).not.toContain(FORBIDDEN_PATTERNS.atFile);
    expect(action.action).toContain('--rawfile md "$body_file"');
  });

  test("TDD #2185: p2p + 无 profile 时 replyTo.profile === undefined", async () => {
    const action = await captureRecommendedAction(
      {
        id: "es-p2p-no-profile",
        name: "lark-test",
        type: "lark-cli",
        enabled: true,
        channelPromptMode: "legacy", // ★ ES-M1: 本组守护 legacy 长模板形态
      },
      makeLarkEvent(),
    );
    expect(action).toBeDefined();
    expect(action.replyTo.profile).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // 3. group + 有 profile：action 必须包含群聊提示 + 同样的禁令
  // ---------------------------------------------------------------------------
  test("TDD #2185 r2: group + 有 profile 时 action 含群聊提示、不含不安全模式、推荐 cat 路径", async () => {
    const action = await captureRecommendedAction(
      {
        id: "es-group-with-profile",
        name: "智事通",
        type: "lark-cli",
        enabled: true,
        channelPromptMode: "legacy", // ★ ES-M1: 本组守护 legacy 长模板形态
        profile: "zhishitong",
      },
      makeLarkEvent({ chatType: "group", chatId: "oc_group_001" }),
    );
    expect(action).toBeDefined();
    expect(action.action).toContain("群聊");
    expect(action.action).toContain('--rawfile md "$body_file"');
    expect(action.action).not.toContain(FORBIDDEN_PATTERNS.ansiCQuote);
    expect(action.action).not.toContain(FORBIDDEN_PATTERNS.dashStdin);
    expect(action.action).not.toContain(FORBIDDEN_PATTERNS.atFile);
    // 有 profile 时仍然要带上 --profile
    expect(action.action).toContain("--profile zhishitong");
  });

  test("TDD #2185: group + 有 profile 时 replyTo 既有结构保持不变", async () => {
    const action = await captureRecommendedAction(
      {
        id: "es-group-with-profile",
        name: "智事通",
        type: "lark-cli",
        enabled: true,
        channelPromptMode: "legacy", // ★ ES-M1: 本组守护 legacy 长模板形态
        profile: "zhishitong",
      },
      makeLarkEvent({ chatType: "group", chatId: "oc_group_001", messageId: "om_grp_001" }),
    );
    expect(action).toBeDefined();
    expect(action.replyTo.appId).toBe("cli_app123");
    expect(action.replyTo.profile).toBe("zhishitong");
    expect(action.replyTo.chatId).toBe("oc_group_001");
    expect(action.replyTo.messageId).toBe("om_grp_001");
  });

  // ---------------------------------------------------------------------------
  // 4. group + 无 profile
  // ---------------------------------------------------------------------------
  test("TDD #2185 r2: group + 无 profile 时 action 含群聊、不含 --profile、不含不安全模式", async () => {
    const action = await captureRecommendedAction(
      {
        id: "es-group-no-profile",
        name: "lark-test",
        type: "lark-cli",
        enabled: true,
        channelPromptMode: "legacy", // ★ ES-M1: 本组守护 legacy 长模板形态
      },
      makeLarkEvent({ chatType: "group", chatId: "oc_group_002" }),
    );
    expect(action).toBeDefined();
    expect(action.action).toContain("群聊");
    expect(action.action).not.toContain("--profile");
    expect(action.action).not.toContain(FORBIDDEN_PATTERNS.ansiCQuote);
    expect(action.action).not.toContain(FORBIDDEN_PATTERNS.dashStdin);
    expect(action.action).not.toContain(FORBIDDEN_PATTERNS.atFile);
    expect(action.action).toContain('--rawfile md "$body_file"');
  });

  // ---------------------------------------------------------------------------
  // 5. 真实 simplify-format event fixture（匹配 nohup.out 中的 shape）
  // ---------------------------------------------------------------------------
  test("TDD #2185: 真实 simplify-format im.message.receive_v1 事件也产生安全 action", async () => {
    const action = await captureRecommendedAction(
      {
        id: "es-real",
        name: "zhishitong",
        type: "lark-cli",
        enabled: true,
        channelPromptMode: "legacy", // ★ ES-M1: 本组守护 legacy 长模板形态
        profile: "zhishitong",
      },
      makeSimplifiedLarkEvent({
        chatType: "p2p",
        messageId: "om_x100b6b514dcc24b4c3767e97c0fa45a",
        chatId: "oc_20ea15b1276eb336a60757bfabdd43f9",
        senderId: "ou_b9924f48dc122c3dad0ff4f37851c09b",
      }),
    );
    expect(action).toBeDefined();
    expect(action.action).toContain('--rawfile md "$body_file"');
    expect(action.action).not.toContain(FORBIDDEN_PATTERNS.ansiCQuote);
    expect(action.action).not.toContain(FORBIDDEN_PATTERNS.dashStdin);
    expect(action.action).not.toContain(FORBIDDEN_PATTERNS.atFile);
    expect(action.replyTo.messageId).toBe("om_x100b6b514dcc24b4c3767e97c0fa45a");
    expect(action.replyTo.chatId).toBe("oc_20ea15b1276eb336a60757bfabdd43f9");
  });

  // ---------------------------------------------------------------------------
  // 6. prompt 字符串的 JSON 转义安全性：JSON.stringify(action) 不应破坏或丢字段
  // ---------------------------------------------------------------------------
  test("TDD #2185: action 字符串经 JSON.stringify 后保持禁令字符与 cat 路径", async () => {
    const action = await captureRecommendedAction(
      {
        id: "es-escape",
        name: "智事通",
        type: "lark-cli",
        enabled: true,
        channelPromptMode: "legacy", // ★ ES-M1: 本组守护 legacy 长模板形态
        profile: "zhishitong",
      },
      makeLarkEvent(),
    );
    const json = JSON.stringify(action);
    // jq 安全构造路径必须保留
    expect(json).toContain('--rawfile md \\\"$body_file\\\"');
    // 警示用 "\n"（反斜杠 + n）必须以 \\n 两个字符出现（JSON 转义）
    expect(json).toContain("\\\\n");
    // 完整往返
    const roundtrip = JSON.parse(json);
    expect(roundtrip.action).toContain('--content "$content"');
    expect(roundtrip.replyTo.profile).toBe("zhishitong");
  });
});
// =============================================================================
// TDD #XXXX (Round 4): 强化 --markdown 必用约束, 显式禁止 --text / 不带 flag
//
// 背景: 历史上 LLM 偶尔会走 plain text 路径, 让飞书把 Markdown 标签当字面
// 字符渲染, rich format (<at> mention、列表、**bold**、code block 等) 全部失效。
//
// 修复目标: action prompt 必须
//   1) 顶部加 ⭐ 关键: 飞书回复必须用 --markdown flag, 不要用 --text
//   2) 解释 lark-cli 默认是 plain text, Markdown 标签会显示为字面字符
//   3) 在 "禁止" 章节明确列出 --text flag 是禁用的
//
// 注意: prompt 字符串会被 console.log / JSON 序列化多次往返, 描述时要用 words
// 而不是字面 sequence, 避免安全示例本身变成新的字面陷阱。
// =============================================================================
describe("recommendedAction --markdown 强约束 (Round 4)", () => {
  async function captureAction(config: any, rawEvent: any): Promise<any> {
    const { larkCliHandler: ReloadedHandler } = await import("./event-source-handlers");
    const instance = ReloadedHandler.createInstance(config);
    let capturedEvent: any = null;
    instance.onEvent((evt: any) => {
      capturedEvent = evt;
    });
    await (instance as any).handleEvent(JSON.stringify(rawEvent));
    return capturedEvent?.payload?.recommendedAction;
  }

  function makeLarkEvent(overrides: any = {}): any {
    return {
      type: "im.message.receive_v1",
      event: {
        header: { event_type: "im.message.receive_v1", app_id: "cli_app123" },
        message: {
          message_id: overrides.messageId || "om_md_001",
          chat_id: overrides.chatId || "oc_chat_md_001",
          chat_type: overrides.chatType || "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "hello" }),
        },
        sender: { sender_id: { open_id: "ou_user_001" } },
      },
    };
  }

  test("Round 4 [RED]: 顶部 ⭐ 关键 说明必须强调所有回复用 --markdown, 不要 --text", async () => {
    const action = await captureAction(
      { id: "es-md-emphasis", name: "markdown-emphasis-test", type: "lark-cli", enabled: true, channelPromptMode: "legacy" },
      makeLarkEvent(),
    );
    expect(action).toBeDefined();
    // 必须出现"关键"或"必须"类强调词 + "--markdown" 关联
    expect(action.action).toMatch(/关键.*--markdown|--markdown.*关键/s);
    // 必须出现"不要用 --text"或同等含义的提示
    expect(action.action).toMatch(/不要.*--text|--text.*不要/s);
  });

  test("Round 4: 顶部说明解释 lark-cli 默认 plain text 会让 Markdown 标签显示为字面字符", async () => {
    const action = await captureAction(
      { id: "es-md-plain-warn", name: "md-plain-warn", type: "lark-cli", enabled: true, channelPromptMode: "legacy" },
      makeLarkEvent(),
    );
    expect(action).toBeDefined();
    // 必须提到 plain text 默认行为会让 rich format 失效
    expect(action.action).toMatch(/plain text|字面字符|raw 符号/);
  });

  test("Round 4: '禁止' 章节明确禁止 --text flag", async () => {
    const action = await captureAction(
      { id: "es-md-forbid-text", name: "md-forbid-text", type: "lark-cli", enabled: true, channelPromptMode: "legacy" },
      makeLarkEvent(),
    );
    expect(action).toBeDefined();
    // 在禁止列表里, --text 必须作为单独的禁用条目出现
    // 用 words 描述 ("禁止 --text flag"), 而不是把 --text 当字面 sequence
    expect(action.action).toMatch(/禁止.*--text|--text.*[禁禁]/s);
  });

  test("Round 4: '禁止' 章节也禁止 --msg-type text (避免 LLM 选错 msg-type)", async () => {
    const action = await captureAction(
      { id: "es-md-forbid-msgtype", name: "md-forbid-msgtype", type: "lark-cli", enabled: true, channelPromptMode: "legacy" },
      makeLarkEvent(),
    );
    expect(action).toBeDefined();
    expect(action.action).toMatch(/--msg-type text/);
  });

  test("Round 4: 调用模板给出结构化 content 构造方式 (jq --rawfile + --content)", async () => {
    const action = await captureAction(
      { id: "es-md-template-hint", name: "md-template-hint", type: "lark-cli", enabled: true, channelPromptMode: "legacy" },
      makeLarkEvent(),
    );
    expect(action).toBeDefined();
    // 模板必须用 jq --rawfile 安全构造 content，并以 --msg-type post --content 发送
    expect(action.action).toMatch(/jq -nc --rawfile md/);
    expect(action.action).toMatch(/--msg-type post --content/);
  });

  test("Round 4: group 场景下也保留同样的 markdown 强调", async () => {
    const action = await captureAction(
      { id: "es-md-group", name: "md-group", type: "lark-cli", enabled: true, channelPromptMode: "legacy" },
      makeLarkEvent({ chatType: "group", chatId: "oc_grp_md_001" }),
    );
    expect(action).toBeDefined();
    expect(action.action).toMatch(/关键.*--markdown/s);
    expect(action.action).toMatch(/--text/);
  });

  test("Round 4: 有 profile 时 markdown 强调仍然存在", async () => {
    const action = await captureAction(
      {
        id: "es-md-with-profile",
        name: "md-with-profile",
        type: "lark-cli",
        enabled: true,
        channelPromptMode: "legacy", // ★ ES-M1: 本组守护 legacy 长模板形态
        profile: "zhishitong",
      },
      makeLarkEvent(),
    );
    expect(action).toBeDefined();
    expect(action.action).toMatch(/关键.*--markdown/s);
    expect(action.action).toMatch(/--text/);
  });

  test("Round 4: action 中 --content 结构化路径出现次数 >= 3, 确保 LLM 多次看到", async () => {
    const action = await captureAction(
      { id: "es-md-count", name: "md-count", type: "lark-cli", enabled: true, channelPromptMode: "legacy" },
      makeLarkEvent(),
    );
    expect(action).toBeDefined();
    const occurrences = (action.action.match(/--content/g) || []).length;
    expect(occurrences).toBeGreaterThanOrEqual(3);
  });
});

// =============================================================================
// TDD #XXXX (Round 5): @-mention 必须用空闭合 <at user_id=".."></at>
//
// 背景: prompt 原本推荐自闭合 <at user_id=".."/>, 飞书不识别, 用户看到原始
// <at> 标签字面字符。LLM 通过 bash 直接调 lark-cli 时绕过 normalizeLarkAtMentions,
// 必须在 prompt 源头教会 LLM 正确语法。
//
// 修复目标:
//   1) scopeHint 推荐空闭合 <at user_id=".."></at>, 说明自闭合不工作
//   2) 顶部 ⭐ 关键 2 章节强调 at-mention 语法, 给正确示例, 列禁用模式
//   3) 严禁: 自闭合、反引号/HTML entity 转义、纯字符串 @userId
// =============================================================================
describe("recommendedAction at-mention 空闭合约束 (Round 5)", () => {
  async function captureAction(config: any, rawEvent: any): Promise<any> {
    const { larkCliHandler: ReloadedHandler } = await import("./event-source-handlers");
    const instance = ReloadedHandler.createInstance(config);
    let capturedEvent: any = null;
    instance.onEvent((evt: any) => {
      capturedEvent = evt;
    });
    await (instance as any).handleEvent(JSON.stringify(rawEvent));
    return capturedEvent?.payload?.recommendedAction;
  }

  function makeLarkEvent(overrides: any = {}): any {
    return {
      type: "im.message.receive_v1",
      event: {
        header: { event_type: "im.message.receive_v1", app_id: "cli_app123" },
        message: {
          message_id: overrides.messageId || "om_at_001",
          chat_id: overrides.chatId || "oc_grp_at_001",
          chat_type: overrides.chatType || "group",
          message_type: "text",
          content: JSON.stringify({ text: "hello" }),
        },
        sender: { sender_id: { open_id: "ou_1759934f98e0677e17f09591389c24f1" } },
      },
    };
  }

  test("Round 5 [RED]: scopeHint 推荐结构化 at 节点, 不是内联 <at> 文本标签", async () => {
    const action = await captureAction(
      { id: "es-at-scope", name: "at-scope", type: "lark-cli", enabled: true, channelPromptMode: "legacy" },
      makeLarkEvent({ chatType: "group" }),
    );
    expect(action).toBeDefined();
    // 群聊的 scopeHint 必须推荐结构化 at 节点
    expect(action.action).toMatch(/\{"tag":"at","user_id":"ou_1759934f98e0677e17f09591389c24f1"\}/);
    // scopeHint 里不能出现内联 <at ...> 文本标签示例
    const scopeLine = action.action.split("\n").find((l: string) => l.startsWith("scope:"));
    expect(scopeLine).toBeDefined();
    expect(scopeLine).not.toMatch(/<at\s+user_id="ou_/);
  });

  // ★ Task #5472 延续：prompt 动态注入真实 senderId（占位符 <senderId> 导致
  //   agent 行为不稳定：有时替换对、有时 @ 自己、有时照抄字面）。
  //   修法：extractMetadata 已提取 metadata.senderId，把它传进
  //   buildLarkRecommendedAction / buildLarkLeanAction，prompt 里出现真实值。
  describe("Task #5472: prompt 动态注入真实 senderId", () => {
    const REAL_OPEN_ID = "ou_1759934f98e0677e17f09591389c24f1";

    test("legacy：群聊 prompt 含真实 senderId，不含 <senderId> 占位符", async () => {
      const action = await captureAction(
        { id: "es-uid-legacy", name: "uid-legacy", type: "lark-cli", enabled: true, channelPromptMode: "legacy" },
        makeLarkEvent({ chatType: "group" }),
      );
      expect(action).toBeDefined();
      // at 节点示例里必须是真实 open_id，不是占位符
      expect(action.action).toContain(`--arg uid "${REAL_OPEN_ID}"`);
      expect(action.action).toContain(`{"tag":"at","user_id":"${REAL_OPEN_ID}"}`);
      expect(action.action).not.toContain("<senderId>");
    });

    test("lean：群聊动态卡片含真实 senderId，不含 <senderId> 占位符", async () => {
      const action = await captureAction(
        { id: "es-uid-lean", name: "uid-lean", type: "lark-cli", enabled: true },
        makeLarkEvent({ chatType: "group" }),
      );
      expect(action).toBeDefined();
      expect(action.action).toContain(`"user_id":"${REAL_OPEN_ID}"`);
      expect(action.action).not.toContain("<senderId>");
    });

    test("senderId 缺失时回退到占位符语义（不注入空值）", async () => {
      const evt = makeLarkEvent({ chatType: "group" });
      delete evt.event.sender;
      const action = await captureAction(
        { id: "es-uid-missing", name: "uid-missing", type: "lark-cli", enabled: true, channelPromptMode: "legacy" },
        evt,
      );
      expect(action).toBeDefined();
      expect(action.action).toContain("<senderId>");
    });
  });

  test("Round 5: scopeHint 显式说明自闭合不工作, 飞书不解析", async () => {
    const action = await captureAction(
      { id: "es-at-explain", name: "at-explain", type: "lark-cli", enabled: true, channelPromptMode: "legacy" },
      makeLarkEvent({ chatType: "group" }),
    );
    expect(action).toBeDefined();
    // 必须包含"自闭合 ... 不工作 / 不解析"或同等说明
    expect(action.action).toMatch(/自闭合.*不工作|自闭合.*不解析|不识别/);
  });

  test("Round 5: 顶部 '关键 2' 章节包含结构化 at 节点的强约束", async () => {
    const action = await captureAction(
      { id: "es-at-top", name: "at-top", type: "lark-cli", enabled: true, channelPromptMode: "legacy" },
      makeLarkEvent({ chatType: "group" }),
    );
    expect(action).toBeDefined();
    expect(action.action).toMatch(/关键.*at 节点|at 节点.*关键/s);
    expect(action.action).toMatch(/结构化 at 节点/);
  });

  test("Round 5: '关键 1' 章节给出结构化 at 节点示例", async () => {
    const action = await captureAction(
      { id: "es-at-example", name: "at-example", type: "lark-cli", enabled: true, channelPromptMode: "legacy" },
      makeLarkEvent({ chatType: "group" }),
    );
    expect(action).toBeDefined();
    // 必须给出结构化 at 节点的正确写法
    expect(action.action).toMatch(/\{"tag":"at","user_id":"ou_xxx"\}/);
  });

  test("Round 5: '严禁' 章节禁止内联 <at ... /> 文本标签", async () => {
    const action = await captureAction(
      { id: "es-at-forbid-self", name: "at-forbid-self", type: "lark-cli", enabled: true, channelPromptMode: "legacy" },
      makeLarkEvent({ chatType: "group" }),
    );
    expect(action).toBeDefined();
    // "严禁" 列表里必须禁止内联 <at> 文本标签
    expect(action.action).toMatch(/严禁.*<at user_id="ou_xxx"\/>|严禁.*<at user_id="ou_xxx"><\/at>/s);
  });

  test("Round 5: p2p 私聊场景不推荐 at-mention (私聊不需要 mention 对方)", async () => {
    const action = await captureAction(
      { id: "es-at-p2p", name: "at-p2p", type: "lark-cli", enabled: true, channelPromptMode: "legacy" },
      makeLarkEvent({ chatType: "p2p" }),
    );
    expect(action).toBeDefined();
    // p2p 场景的 scopeHint 不应该包含 <at> 标签示例 (私聊场景不强制要求 @mention)
    // 注意: action 整体 (含顶部章节) 仍会包含 at-mention 说明, 这里只检查 scopeHint 段落
    const scopeLine = action.action.split("\n").find((l: string) => l.startsWith("scope:"));
    expect(scopeLine).toBeDefined();
    expect(scopeLine).not.toMatch(/<at/);
  });
});

// =============================================================================
// TDD #2185 round 3: unique tempfile + guaranteed cleanup semantics
//
// 用户新增需求：除安全 Markdown 传输外，prompt 必须提示 LLM：
//   1. 用 mktemp 创建唯一临时文件（避免并发回复覆盖）
//   2. 用 trap 在退出时清理（无论成败都删，避免 /tmp 累积）
//   3. LLM 可照抄 4 步模板
//
// 鲁棒模板（推荐）：
//   body_file="$(mktemp /tmp/lark-reply.XXXXXX.md)"
//   trap 'rm -f "$body_file"' EXIT
//   cat > "$body_file" <<'LARK_REPLY_EOF'
//   ...（Markdown 内容）
//   LARK_REPLY_EOF
//   content="$(jq -nc --rawfile md "$body_file" ... '{zh_cn:{content:[[...at 节点...],[{tag:"md",text:$md}]]}}')"
//   lark-cli ... --msg-type post --content "$content"
//
// 设计要点：
//   - 唯一文件名：`mktemp /tmp/lark-reply.XXXXXX.md` 自动替换 X 为随机字符
//   - trap EXIT：脚本退出（包括错误退出）都触发清理
//   - heredoc 单引号包裹：防止 Markdown 内容被 shell 展开
//   - replyTo 结构 / profile / chat / message / bot 约束不变
//   - 原有禁令（ANSI-C / 字面 \n / --markdown - / --markdown @file）不变
//
// RED：本组测试在 prompt 仍是 cat /tmp/lark-reply.md 时全部失败。
// =============================================================================
describe("recommendedAction unique tempfile + cleanup (TDD #2185 round 3)", () => {
  // 必须出现的安全语义（用于 GREEN 后验证）
  const MKTEMP_HINT = "mktemp";                 // 唯一临时文件创建
  const TRAP_HINT = "trap";                      // 退出清理机制
  const RM_HINT = "rm -f";                       // 强制删除
  const EXIT_HINT = "EXIT";                      // trap on shell exit
  // 唯一文件名模板：mktemp 模板（XXXXXX 占位）
  const MKTEMP_TEMPLATE = ".XXXXXX";
  // 推荐的 $body_file 变量名
  const REPLY_FILE_VAR = "$body_file";

  function makeLarkEvent(overrides: any = {}): any {
    return {
      type: "im.message.receive_v1",
      event: {
        header: {
          event_type: "im.message.receive_v1",
          app_id: overrides.appId || "cli_app123",
          tenant_key: "tenant_xyz",
        },
        message: {
          message_id: overrides.messageId || "om_msg_001",
          chat_id: overrides.chatId || "oc_chat_001",
          chat_type: overrides.chatType || "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "hello" }),
        },
        sender: {
          sender_id: { open_id: overrides.senderId || "ou_user_001" },
        },
      },
    };
  }

  async function captureRecommendedAction(config: any, rawEvent: any): Promise<any> {
    const { larkCliHandler: ReloadedHandler } = await import("./event-source-handlers");
    const instance = ReloadedHandler.createInstance(config);
    let capturedEvent: any = null;
    instance.onEvent((evt: any) => {
      capturedEvent = evt;
    });
    await (instance as any).handleEvent(JSON.stringify(rawEvent));
    return capturedEvent?.payload?.recommendedAction;
  }

  // ---------------------------------------------------------------------------
  // 1. p2p + 有 profile：mktemp 唯一文件名 + trap 清理
  // ---------------------------------------------------------------------------
  test("TDD #2185 r3: p2p + 有 profile 时 action 包含 mktemp 唯一文件创建", async () => {
    const action = await captureRecommendedAction(
      { id: "es-p2p-p", name: "智事通", type: "lark-cli", enabled: true, channelPromptMode: "legacy", profile: "zhishitong" },
      makeLarkEvent(),
    );
    expect(action).toBeDefined();
    expect(action.action).toContain(MKTEMP_HINT);
    expect(action.action).toContain(MKTEMP_TEMPLATE);
  });

  test("TDD #2185 r3: p2p + 有 profile 时 action 包含 trap 清理 EXIT", async () => {
    const action = await captureRecommendedAction(
      { id: "es-p2p-p", name: "智事通", type: "lark-cli", enabled: true, channelPromptMode: "legacy", profile: "zhishitong" },
      makeLarkEvent(),
    );
    expect(action).toBeDefined();
    expect(action.action).toContain(TRAP_HINT);
    expect(action.action).toContain(EXIT_HINT);
    expect(action.action).toContain(RM_HINT);
  });

  test("TDD #2185 r3: p2p + 有 profile 时 action 仍推荐 --content \"$content\" 路径", async () => {
    const action = await captureRecommendedAction(
      { id: "es-p2p-p", name: "智事通", type: "lark-cli", enabled: true, channelPromptMode: "legacy", profile: "zhishitong" },
      makeLarkEvent(),
    );
    expect(action).toBeDefined();
    // 必须包含 --msg-type post --content "$content" 的安全调用形态
    expect(action.action).toMatch(/--msg-type post --content "\$content"/);
  });

  // ---------------------------------------------------------------------------
  // 2. p2p + 无 profile：同样 mktemp + trap
  // ---------------------------------------------------------------------------
  test("TDD #2185 r3: p2p + 无 profile 时 action 包含 mktemp + trap", async () => {
    const action = await captureRecommendedAction(
      { id: "es-p2p-np", name: "lark-test", type: "lark-cli", enabled: true, channelPromptMode: "legacy" },
      makeLarkEvent(),
    );
    expect(action).toBeDefined();
    expect(action.action).toContain(MKTEMP_HINT);
    expect(action.action).toContain(MKTEMP_TEMPLATE);
    expect(action.action).toContain(TRAP_HINT);
    expect(action.action).toContain(EXIT_HINT);
    expect(action.action).toContain(RM_HINT);
  });

  // ---------------------------------------------------------------------------
  // 3. group + 有 profile
  // ---------------------------------------------------------------------------
  test("TDD #2185 r3: group + 有 profile 时 action 包含 mktemp + trap", async () => {
    const action = await captureRecommendedAction(
      { id: "es-group-p", name: "智事通", type: "lark-cli", enabled: true, channelPromptMode: "legacy", profile: "zhishitong" },
      makeLarkEvent({ chatType: "group", chatId: "oc_group_001" }),
    );
    expect(action).toBeDefined();
    expect(action.action).toContain(MKTEMP_HINT);
    expect(action.action).toContain(MKTEMP_TEMPLATE);
    expect(action.action).toContain(TRAP_HINT);
    expect(action.action).toContain(EXIT_HINT);
    expect(action.action).toContain(RM_HINT);
    // 群聊特征仍保留
    expect(action.action).toContain("群聊");
  });

  // ---------------------------------------------------------------------------
  // 4. group + 无 profile
  // ---------------------------------------------------------------------------
  test("TDD #2185 r3: group + 无 profile 时 action 包含 mktemp + trap", async () => {
    const action = await captureRecommendedAction(
      { id: "es-group-np", name: "lark-test", type: "lark-cli", enabled: true, channelPromptMode: "legacy" },
      makeLarkEvent({ chatType: "group", chatId: "oc_group_002" }),
    );
    expect(action).toBeDefined();
    expect(action.action).toContain(MKTEMP_HINT);
    expect(action.action).toContain(MKTEMP_TEMPLATE);
    expect(action.action).toContain(TRAP_HINT);
    expect(action.action).toContain(EXIT_HINT);
    expect(action.action).toContain(RM_HINT);
  });

  // ---------------------------------------------------------------------------
  // 5. 4 类都使用唯一变量名 $reply_file 而不是字面 /tmp/lark-reply.md
  //    （避免并发覆盖 + 强化 trap 的可移植性）
  // ---------------------------------------------------------------------------
  test("TDD #2185 r3: 4 类都使用 $body_file 变量名而非字面 /tmp/lark-reply.md", async () => {
    const cases = [
      { config: { id: "a", name: "x", type: "lark-cli", enabled: true, channelPromptMode: "legacy", profile: "zhishitong" }, event: makeLarkEvent() },
      { config: { id: "b", name: "x", type: "lark-cli", enabled: true, channelPromptMode: "legacy" }, event: makeLarkEvent() },
      { config: { id: "c", name: "x", type: "lark-cli", enabled: true, channelPromptMode: "legacy", profile: "zhishitong" }, event: makeLarkEvent({ chatType: "group", chatId: "oc_g_001" }) },
      { config: { id: "d", name: "x", type: "lark-cli", enabled: true, channelPromptMode: "legacy" }, event: makeLarkEvent({ chatType: "group", chatId: "oc_g_002" }) },
    ];
    for (const c of cases) {
      const action = await captureRecommendedAction(c.config, c.event);
      expect(action).toBeDefined();
      // 推荐模板必须引用变量，避免并发覆盖字面路径
      expect(action.action).toContain(REPLY_FILE_VAR);
    }
  });

  // ---------------------------------------------------------------------------
  // 6. replyTo 既有结构在新增 trap/mktemp 后仍保持不变（向后兼容）
  // ---------------------------------------------------------------------------
  test("TDD #2185 r3: 新增 mktemp+trap 后 replyTo 既有结构（appId/profile/chatId/messageId）不变", async () => {
    const action = await captureRecommendedAction(
      { id: "es-bc", name: "智事通", type: "lark-cli", enabled: true, channelPromptMode: "legacy", profile: "zhishitong" },
      makeLarkEvent({ appId: "cli_app_X", chatId: "oc_chat_X", messageId: "om_msg_X" }),
    );
    expect(action).toBeDefined();
    expect(action.replyTo.appId).toBe("cli_app_X");
    expect(action.replyTo.profile).toBe("zhishitong");
    expect(action.replyTo.chatId).toBe("oc_chat_X");
    expect(action.replyTo.messageId).toBe("om_msg_X");
  });

  // ---------------------------------------------------------------------------
  // 7. 新增 trap/mktemp 后，原有禁令仍然全部有效（无回归）
  // ---------------------------------------------------------------------------
  test("TDD #2185 r3: 新增 trap/mktemp 后，原有禁令（ANSI-C / - / @file）继续生效", async () => {
    const action = await captureRecommendedAction(
      { id: "es-bans", name: "智事通", type: "lark-cli", enabled: true, channelPromptMode: "legacy", profile: "zhishitong" },
      makeLarkEvent(),
    );
    expect(action).toBeDefined();
    // 新模板不应引入被禁字面
    expect(action.action).not.toContain("$'");
    expect(action.action).not.toContain("--markdown -");
    expect(action.action).not.toContain("--markdown @file");
    // 字面 \n 警示仍在
    expect(action.action).toContain("\\n");
  });
});

// =============================================================================
// Task #3987 后续修复：lark-cli `event consume` 输出**简化格式**（顶层 sender_id）
// 之前 extractMetadata / extractUserId 只处理嵌套格式，导致：
// - replyChannel.params.userId = undefined
// - EnvContext.userId = "unknown"
// - PerTaskGroupChatPlugin 用 ["sender"] 推导时拿不到 userId → 群聊不邀请 user
// =============================================================================
describe("extractMetadata / extractUserId handle simplified lark event format", () => {
  // ★ Task #4137 P2 跨实例去重：dedup 改用模块级 SHARED_SEEN 静态 Map，
  // 测试间需要重置避免同 event_id 在多 describe 之间被吃光。
  beforeEach(async () => {
    const { LarkCliInstance } = await import("./event-source-handlers");
    LarkCliInstance.__resetDedupForTest();
  });

  async function captureEvent(config: any, rawEvent: any): Promise<any> {
    const { larkCliHandler: ReloadedHandler } = await import("./event-source-handlers");
    const instance = ReloadedHandler.createInstance(config);
    let capturedEvent: any = null;
    instance.onEvent((evt: any) => {
      capturedEvent = evt;
    });
    await (instance as any).handleEvent(JSON.stringify(rawEvent));
    return capturedEvent;
  }

  // 真实 nohup.out 中的事件 shape：顶层 sender_id 是字符串
  function makeSimplifiedLarkEvent(overrides: any = {}): any {
    return {
      type: "im.message.receive_v1",
      event_id: overrides.event_id || "b557f678055d679a18ebb79986dc0792",
      timestamp: overrides.timestamp || "1790651558434",
      id: overrides.messageId || "om_x100b6486849189",
      message_id: overrides.messageId || "om_x100b6486849189",
      create_time: overrides.create_time || "1790651557929",
      chat_id: overrides.chatId || "oc_ce59231c7152ae7e2e948608e8294b18",
      chat_type: overrides.chatType || "p2p",
      message_type: "text",
      sender_id: overrides.senderId || "ou_1759934f98e0677e17f09591389c24f1",
      sender_type: "user",
      content: overrides.content || "hi",
    };
  }

  test("extractMetadata: 简化格式应能解析 sender_id 到 replyChannel.params.userId", async () => {
    const evt = await captureEvent(
      { id: "es-tongzhuli", name: "tongzhuli", type: "lark-cli", enabled: true, channelPromptMode: "legacy", profile: "tongzhuli" },
      makeSimplifiedLarkEvent({ senderId: "ou_1759934f98e0677e17f09591389c24f1" }),
    );
    expect(evt).not.toBeNull();
    expect(evt.metadata.replyChannel.params.userId).toBe("ou_1759934f98e0677e17f09591389c24f1");
    expect(evt.payload.metadata.senderId).toBe("ou_1759934f98e0677e17f09591389c24f1");
  });

  test("extractUserId: 简化格式下 EnvContext.userId 应该是真实 open_id（不是 'unknown'）", async () => {
    const evt = await captureEvent(
      { id: "es-tongzhuli", name: "tongzhuli", type: "lark-cli", enabled: true, channelPromptMode: "legacy", profile: "tongzhuli" },
      makeSimplifiedLarkEvent({ senderId: "ou_1759934f98e0677e17f09591389c24f1" }),
    );
    expect(evt).not.toBeNull();
    // evt 里我们看不到 EnvContext，但可以通过 metadata.senderId 验证
    expect(evt.payload.metadata.senderId).toBe("ou_1759934f98e0677e17f09591389c24f1");
  });

  test("嵌套格式（兼容旧版）：sender_id 在 event.event.sender.sender_id.open_id 也应能解析", async () => {
    const nested = {
      type: "im.message.receive_v1",
      event: {
        header: { event_type: "im.message.receive_v1", app_id: "cli_app123", tenant_key: "tenant_xyz" },
        message: { message_id: "om_msg_001", chat_id: "oc_chat_001", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: "hi" }) },
        sender: { sender_id: { open_id: "ou_user_001" } },
      },
    };
    const evt = await captureEvent(
      { id: "es-default", name: "default", type: "lark-cli", enabled: true, channelPromptMode: "legacy", profile: "default" },
      nested,
    );
    expect(evt).not.toBeNull();
    expect(evt.metadata.replyChannel.params.userId).toBe("ou_user_001");
  });
});