/**
 * @fileoverview BountyIMHandler Tests (TDD RED)
 *
 * TDD 测试套件，覆盖 bounty-im 提升为 roy-bot core 内置 handler 后的全部功能：
 *
 * 1. 导出 / Handler 结构 (3 tests)
 * 2. validateConfig 错误路径 (5 tests - 严格化，不再 fallback 到 bountyConfig)
 * 3. validateConfig 兼容路径 (2 tests - 顶级字段 + options 兼容)
 * 4. createInstance / 生命周期 (4 tests)
 * 5. WebSocket 生命周期 (3 tests)
 * 6. 消息解析 (4 tests - pending/delivered/ACK/metadata)
 * 7. EventSourceComponent 集成 (1 test)
 * 8. BUILT_IN_EVENT_SOURCE_TYPES (1 test)
 *
 * 总计: 23 个测试
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "bun:test";
import type {
  EventSourceConfig,
  EventSourceInstance,
  EventSourceEvent,
  EventSourceEventHandler,
  EventSourceHandler,
} from "./types";
import {
  BountyIMInstance,
  buildDefaultBountyIMSystemPrompt,
  resolveBountyIMSystemPrompt,
} from "./bounty-im-handler";

// =============================================================================
// Mock ws module
// =============================================================================

type Listener = (...args: unknown[]) => void;

interface MockWebSocket {
  on: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  _listeners: Map<string, Listener[]>;
  /** Constructor URL (captured) */
  url: string;
  /** Constructor options (captured) — used to assert rejectUnauthorized etc. */
  options: Record<string, unknown> | undefined;
  trigger(event: string, ...args: unknown[]): void;
}

const mockWsInstances: MockWebSocket[] = [];

function createMockWebSocket(url: string, options: Record<string, unknown> | undefined): MockWebSocket {
  const listeners = new Map<string, Listener[]>();
  const ws: MockWebSocket = {
    on: vi.fn((event: string, handler: Listener) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(handler);
    }),
    send: vi.fn(),
    close: vi.fn(),
    _listeners: listeners,
    url,
    options,
    trigger(event: string, ...args: unknown[]) {
      const handlers = listeners.get(event) || [];
      for (const h of handlers) h(...args);
    },
  };
  mockWsInstances.push(ws);
  return ws;
}

vi.mock("ws", () => {
  return {
    WebSocket: class MockWebSocketImpl {
      on = vi.fn();
      send = vi.fn();
      close = vi.fn();
      constructor(url: string, options?: unknown) {
        const instance = createMockWebSocket(url, options as Record<string, unknown> | undefined);
        Object.assign(this, instance);
      }
    },
  };
});

// =============================================================================
// Helper: 创建有效 bounty-im 配置
// =============================================================================

function createValidConfig(overrides: Partial<EventSourceConfig> = {}): EventSourceConfig {
  return {
    id: "bounty-im-test",
    name: "Bounty IM Test",
    type: "bounty-im",
    enabled: true,
    // v0.14 strict: bounty-im identity = email only
    email: "alice@bounty.example.com",
    imServerUrl: "ws://localhost:4005/ws",
    ...overrides,
  };
}

// =============================================================================
// 1. 导出 / Handler 结构
// =============================================================================

describe("BountyIMHandler exports & structure", () => {
  test("should export bountyIMHandler", async () => {
    const mod = await import("./bounty-im-handler");
    expect(mod.bountyIMHandler).toBeDefined();
    expect(typeof mod.bountyIMHandler).toBe("object");
  });

  test("should export BountyIMInstance class", async () => {
    const mod = await import("./bounty-im-handler");
    expect(mod.BountyIMInstance).toBeDefined();
    expect(typeof mod.BountyIMInstance).toBe("function");
  });

  test("bountyIMHandler.type should be 'bounty-im'", async () => {
    const { bountyIMHandler } = await import("./bounty-im-handler");
    expect(bountyIMHandler.type).toBe("bounty-im");
  });

  test("bountyIMHandler should have validateConfig function", async () => {
    const { bountyIMHandler } = await import("./bounty-im-handler");
    expect(typeof bountyIMHandler.validateConfig).toBe("function");
  });

  test("bountyIMHandler should have createInstance function", async () => {
    const { bountyIMHandler } = await import("./bounty-im-handler");
    expect(typeof bountyIMHandler.createInstance).toBe("function");
  });
});

// =============================================================================
// 2. validateConfig 错误路径（严格化 - 不再 fallback 到 bountyConfig）
// =============================================================================

describe("bountyIMHandler.validateConfig - error paths", () => {
  test("should reject when id is missing", async () => {
    const { bountyIMHandler } = await import("./bounty-im-handler");
    const errors = bountyIMHandler.validateConfig({
      id: "",
      name: "Test",
      type: "bounty-im",
      enabled: true,
      email: "agent@test.com",
      imServerUrl: "ws://localhost:4005/ws",
    } as EventSourceConfig);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /id/i.test(e))).toBe(true);
  });

  test("should reject when email is missing (v0.14 strict - no address fallback)", async () => {
    const { bountyIMHandler } = await import("./bounty-im-handler");
    const errors = bountyIMHandler.validateConfig({
      id: "test",
      name: "Test",
      type: "bounty-im",
      enabled: true,
      imServerUrl: "ws://localhost:4005/ws",
    } as EventSourceConfig);
    expect(errors.some((e) => /email.*required/i.test(e))).toBe(true);
  });

  test("should reject when email format is invalid", async () => {
    const { bountyIMHandler } = await import("./bounty-im-handler");
    const errors = bountyIMHandler.validateConfig({
      id: "test",
      name: "Test",
      type: "bounty-im",
      enabled: true,
      email: "invalid-email-no-at",
      imServerUrl: "ws://localhost:4005/ws",
    } as EventSourceConfig);
    expect(errors.some((e) => /email.*format/i.test(e))).toBe(true);
  });

  test("should reject when imServerUrl is missing (no bountyConfig fallback)", async () => {
    const { bountyIMHandler } = await import("./bounty-im-handler");
    const errors = bountyIMHandler.validateConfig({
      id: "test",
      name: "Test",
      type: "bounty-im",
      enabled: true,
      email: "agent@test.com",
    } as EventSourceConfig);
    expect(errors.some((e) => /imServerUrl.*required/i.test(e))).toBe(true);
  });

  test("should reject when imServerUrl protocol is not ws/wss", async () => {
    const { bountyIMHandler } = await import("./bounty-im-handler");
    const errors = bountyIMHandler.validateConfig({
      id: "test",
      name: "Test",
      type: "bounty-im",
      enabled: true,
      email: "agent@test.com",
      imServerUrl: "http://localhost:4005/ws",
    } as EventSourceConfig);
    expect(errors.some((e) => /ws.*wss|protocol/i.test(e))).toBe(true);
  });
});

// =============================================================================
// 3. validateConfig 兼容路径（顶级字段 + options 兼容）
// =============================================================================

describe("bountyIMHandler.validateConfig - v0.14 strict email-only paths", () => {
  test("should accept top-level email/imServerUrl config (v0.14)", async () => {
    const { bountyIMHandler } = await import("./bounty-im-handler");
    const errors = bountyIMHandler.validateConfig(createValidConfig());
    expect(errors).toEqual([]);
  });

  test("v0.14: should reject config with legacy address field (NO backward compat)", async () => {
    const { bountyIMHandler } = await import("./bounty-im-handler");
    const errors = bountyIMHandler.validateConfig({
      id: "test",
      name: "Test",
      type: "bounty-im",
      enabled: true,
      address: "uuid@bounty.example.com", // v0.12/v0.13 legacy field
      imServerUrl: "ws://localhost:4005/ws",
    } as EventSourceConfig);
    // v0.14 strict: address field 不再被识别作为 valid identity
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /email.*required/i.test(e))).toBe(true);
  });

  test("v0.14: should reject options.address fallback (NO backward compat)", async () => {
    const { bountyIMHandler } = await import("./bounty-im-handler");
    const errors = bountyIMHandler.validateConfig({
      id: "test",
      name: "Test",
      type: "bounty-im",
      enabled: true,
      options: {
        address: "agent@test.com",
        imServerUrl: "ws://localhost:4005/ws",
      },
    } as EventSourceConfig);
    // v0.14 strict: options.address 也不被识别
    expect(errors.some((e) => /email.*required/i.test(e))).toBe(true);
  });
});

// =============================================================================
// 4. createInstance / 生命周期
// =============================================================================

describe("BountyIMInstance lifecycle", () => {
  let instance: EventSourceInstance;
  let bountyInstance: InstanceType<typeof import("./bounty-im-handler").BountyIMInstance>;

  beforeEach(() => {
    mockWsInstances.length = 0;
    return import("./bounty-im-handler").then((mod) => {
      bountyInstance = new mod.BountyIMInstance(createValidConfig());
      instance = bountyInstance as unknown as EventSourceInstance;
    });
  });

  afterEach(async () => {
    if (instance.getStatus && instance.getStatus() === "running") {
      await instance.stop();
    }
  });

  test("should create instance with 'created' initial status", () => {
    expect(instance.getStatus()).toBe("created");
  });

  test("createInstance should return BountyIMInstance", async () => {
    const { bountyIMHandler, BountyIMInstance } = await import("./bounty-im-handler");
    const inst = bountyIMHandler.createInstance(createValidConfig());
    expect(inst).toBeInstanceOf(BountyIMInstance);
  });

  test("should have start/stop/onEvent/offEvent methods", () => {
    expect(typeof instance.start).toBe("function");
    expect(typeof instance.stop).toBe("function");
    expect(typeof instance.getStatus).toBe("function");
    expect(typeof instance.onEvent).toBe("function");
    expect(typeof instance.offEvent).toBe("function");
  });

  test("onEvent should register handler without error", () => {
    const handler = vi.fn();
    instance.onEvent(handler);
  });
});

// =============================================================================
// 5. WebSocket 生命周期
// =============================================================================

describe("BountyIMInstance WebSocket lifecycle", () => {
  test("start should create WebSocket connection", async () => {
    mockWsInstances.length = 0;
    const { BountyIMInstance } = await import("./bounty-im-handler");
    const inst = new BountyIMInstance(createValidConfig());
    const events: EventSourceEvent[] = [];
    inst.onEvent((evt) => { events.push(evt); });

    await inst.start();
    expect(mockWsInstances.length).toBeGreaterThanOrEqual(1);
    expect(inst.getStatus()).toMatch(/running|starting/);

    // Trigger 'open' to confirm status transitions to running
    mockWsInstances[0].trigger("open");
    expect(inst.getStatus()).toBe("running");

    await inst.stop();
  });

  test("start without imServerUrl should throw", async () => {
    const { BountyIMInstance } = await import("./bounty-im-handler");
    const inst = new BountyIMInstance(createValidConfig({ imServerUrl: undefined }));
    inst.onEvent(() => {});
    await expect(inst.start()).rejects.toThrow(/imServerUrl.*required/i);
  });

  test("stop should close WebSocket and transition to stopped", async () => {
    mockWsInstances.length = 0;
    const { BountyIMInstance } = await import("./bounty-im-handler");
    const inst = new BountyIMInstance(createValidConfig());
    inst.onEvent(() => {});

    await inst.start();
    mockWsInstances[0].trigger("open");
    expect(inst.getStatus()).toBe("running");

    await inst.stop();
    expect(inst.getStatus()).toBe("stopped");
  });
});

// =============================================================================
// 6. 消息解析
// =============================================================================

describe("BountyIMInstance message processing", () => {
  let events: EventSourceEvent[];
  let bountyInstance: InstanceType<typeof import("./bounty-im-handler").BountyIMInstance>;

  beforeEach(async () => {
    mockWsInstances.length = 0;
    events = [];
    const mod = await import("./bounty-im-handler");
    bountyInstance = new mod.BountyIMInstance(createValidConfig());
    bountyInstance.onEvent((evt) => { events.push(evt); });
    await bountyInstance.start();
    mockWsInstances[0].trigger("open");
  });

  afterEach(async () => {
    if (bountyInstance.getStatus() === "running") {
      await bountyInstance.stop();
    }
  });

  test("should emit event on pending text message", () => {
    const messagePayload = JSON.stringify({
      event: "message",
      data: {
        id: "msg-1",
        from: "alice@example.com",
        to: "30193cb7-651d-4bf2-8439-052d9a466cf7@bounty.example.com",
        status: "pending",
        content: { type: "text", body: "hello" },
      },
    });
    mockWsInstances[0].trigger("message", messagePayload);

    expect(events.length).toBe(1);
    // Phase B.11: 对齐 LarkCli 模式，event.type 必须是 "event-source.event.<sourceType>"
    // 这样 interactive.ts 的 eventTypes: ["event-source.event.*"] 才能匹配 BountyIM 的事件。
    expect(events[0].type).toBe("event-source.event.bounty-im");
    expect(events[0].payload.sourceType).toBe("bounty-im");
    // sourceMessageType 携带原始 bounty event type (bounty-im.message / bounty-im.<...>)
    expect(events[0].metadata.sourceMessageType).toBe("bounty-im.message");
    expect(events[0].payload.sourceId).toBe("bounty-im-test");
    // senderId 在 metadata 中
    const payload = events[0].payload as { metadata: { senderId: string } };
    expect(payload.metadata.senderId).toBe("alice@example.com");
  });

  test("should process delivered status messages (k8s server always sends delivered)", () => {
    // Bounty server in k8s always pushes with status='delivered' after marking
    // it delivered (server code: handleMessage path). So handler MUST accept
    // delivered messages too, not just 'pending' ones. (Bug fixed in Phase B.10.)
    // Task #2136: msg.to must match config.email (v0.14 strict email routing)
    const messagePayload = JSON.stringify({
      event: "message",
      data: {
        id: "msg-delivered-1",
        from: "alice@example.com",
        to: "alice@bounty.example.com", // matches config.email
        status: "delivered",
        content: { type: "text", body: "realtime push" },
      },
    });
    mockWsInstances[0].trigger("message", messagePayload);

    // K8s server idempotency: when reconnecting, server only re-pushes 'pending'
    // (never-delivered) messages via handleOpen — so all messages received via
    // 'message' event are intended to be dispatched.
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("event-source.event.bounty-im");
    expect(events[0].metadata.sourceMessageType).toBe("bounty-im.message");

    // ACK should still be sent for delivered messages with id.
    const ws = mockWsInstances[0];
    const ackCall = ws.send.mock.calls.find((call: unknown[]) => {
      const payload = call[0] as string;
      return payload.includes('"ack"');
    });
    expect(ackCall).toBeDefined();
  });

  test("should skip non-message events (connected/pong)", () => {
    const connectedPayload = JSON.stringify({ event: "connected" });
    mockWsInstances[0].trigger("message", connectedPayload);
    expect(events.length).toBe(0);
  });

  test("should send ACK when msg.id is present", () => {
    const messagePayload = JSON.stringify({
      event: "message",
      data: {
        id: "msg-ack-test",
        from: "alice@example.com",
        to: "alice@bounty.example.com", // matches config.email (v0.14 strict)
        status: "pending",
        content: { type: "text", body: "ack me" },
      },
    });
    mockWsInstances[0].trigger("message", messagePayload);

    const ws = mockWsInstances[0];
    expect(ws.send).toHaveBeenCalled();
    const ackCall = ws.send.mock.calls.find((call: unknown[]) => {
      const payload = call[0] as string;
      return payload.includes('"ack"');
    });
    expect(ackCall).toBeDefined();
  });

  test("should populate metadata with handleRule.agent", async () => {
    const { BountyIMInstance } = await import("./bounty-im-handler");
    const inst = new BountyIMInstance(
      createValidConfig({
        handleRule: { agent: "roy" },
      }),
    );
    const localEvents: EventSourceEvent[] = [];
    inst.onEvent((evt) => { localEvents.push(evt); });

    mockWsInstances.length = 0;
    await inst.start();
    mockWsInstances[0].trigger("open");

    const messagePayload = JSON.stringify({
      event: "message",
      data: {
        id: "msg-1",
        from: "alice@example.com",
        to: "alice@bounty.example.com", // matches config.email (v0.14 strict)
        status: "pending",
        content: { type: "text", body: "hello" },
      },
    });
    mockWsInstances[0].trigger("message", messagePayload);

    expect(localEvents.length).toBe(1);
    const payload = localEvents[0].payload as unknown as Record<string, unknown>;
    const metadata = payload.metadata as unknown as Record<string, unknown>;
    expect(metadata.agent).toBe("roy");

    await inst.stop();
  });

  test("should build replyChannel with type 'bounty-im'", () => {
    const messagePayload = JSON.stringify({
      event: "message",
      data: {
        id: "msg-1",
        from: "alice@example.com",
        to: "alice@bounty.example.com", // matches config.email (v0.14 strict)
        status: "pending",
        content: { type: "text", body: "reply test" },
      },
    });
    mockWsInstances[0].trigger("message", messagePayload);

    expect(events.length).toBe(1);
    const payload = events[0].payload as unknown as Record<string, unknown>;
    const replyChannel = payload.replyChannel as unknown as Record<string, unknown>;
    expect(replyChannel.type).toBe("bounty-im");
  });

  test("should build recommendedAction with reply command", () => {
    const messagePayload = JSON.stringify({
      event: "message",
      data: {
        id: "msg-1",
        from: "alice@example.com",
        to: "alice@bounty.example.com", // matches config.email (v0.14 strict)
        status: "pending",
        content: { type: "text", body: "action test" },
      },
    });
    mockWsInstances[0].trigger("message", messagePayload);

    expect(events.length).toBe(1);
    const payload = events[0].payload as unknown as Record<string, unknown>;
    const recommendedAction = payload.recommendedAction as unknown as Record<string, unknown>;
    expect(recommendedAction.action).toBeDefined();
    expect(typeof recommendedAction.action).toBe("string");
    expect(recommendedAction.replyTo).toBeDefined();
  });

  // ===========================================================================
  // v0.14.1+ email-display fix — RED tests
  //
  // Bug: recipient sees `[From <uuid>@authenticated]` and recommended reply
  // template uses `wss://...` (WS inbound) instead of `https://...` (HTTP API).
  //
  // Goal:
  //   - metadata.senderEmail reflects the registered email (server-enriched
  //     via msg.fromEmail, or profile email for self-only paths).
  //   - recommendedAction.action uses `--server-url https://...` (translated
  //     from `wss://`) AND uses registered emails for `--from-email` /
  //     `--to-email` instead of canonical / placeholders.
  // ===========================================================================

  test("v0.14.1+ RED: metadata.senderEmail mirrors msg.fromEmail when server enriches it", () => {
    const messagePayload = JSON.stringify({
      event: "message",
      data: {
        id: "msg-enriched-1",
        from: "767a3275-uuid-uuid-uuid-uuid-uuid@authenticated",
        fromEmail: "user@example.com",
        to: "30193cb7-651d-4bf2-8439-052d9a466cf7@bounty.example.com",
        status: "pending",
        content: { type: "text", body: "hi" },
      },
    });
    mockWsInstances[0].trigger("message", messagePayload);

    const payload = events[0].payload as unknown as {
      metadata: { senderId: string; senderEmail?: string };
    };
    expect(payload.metadata.senderId).toBe("767a3275-uuid-uuid-uuid-uuid-uuid@authenticated");
    expect(payload.metadata.senderEmail).toBe("user@example.com");
  });

  test("v0.14.1+ RED: metadata.senderEmail falls back to profile email when msg.fromEmail missing", () => {
    // canonical sender — client-side resolver must fall back to profile email
    // (best effort: sender UUID @authenticated suffix → current profile email)
    const messagePayload = JSON.stringify({
      event: "message",
      data: {
        id: "msg-fb-1",
        from: "767a3275-1234-5678-9abc-def012345678@authenticated",
        to: "alice@bounty.example.com", // profile email (matches createValidConfig)
        status: "pending",
        content: { type: "text", body: "no enrichment" },
      },
    });
    mockWsInstances[0].trigger("message", messagePayload);

    const payload = events[0].payload as unknown as {
      metadata: { senderId: string; senderEmail?: string };
    };
    // Sender is `<uuid>@authenticated` and no server-side fromEmail is
    // available → resolver falls back to the current profile email. Better
    // than the canonical `<uuid>@authenticated` placeholder for downstream LLM
    // context.
    expect(payload.metadata.senderId).toBe(
      "767a3275-1234-5678-9abc-def012345678@authenticated",
    );
    expect(payload.metadata.senderEmail).toBe("alice@bounty.example.com");
  });

  test("v0.14.1+ RED: recommendedAction.action uses https://, not wss://, when imServerUrl is wss", () => {
    // Build a brand-new instance with wss:// to test the URL translation
    bountyInstance.stop();
    mockWsInstances.length = 0;
    events.length = 0;
    bountyInstance = new (bountyInstance.constructor as typeof BountyIMInstance)(
      createValidConfig({ imServerUrl: "wss://bounty.example.example.com/ws" }),
    );
    bountyInstance.onEvent((evt) => { events.push(evt); });
    return bountyInstance.start().then(() => {
      mockWsInstances[0].trigger("open");
      const messagePayload = JSON.stringify({
        event: "message",
        data: {
          id: "msg-https-1",
          from: "alice@example.com",
          fromEmail: "alice@example.com",
          to: "alice@bounty.example.com", // matches config.email (v0.14 strict)
          status: "pending",
          content: { type: "text", body: "https test" },
        },
      });
      mockWsInstances[0].trigger("message", messagePayload);

      const payload = events[0].payload as unknown as {
        recommendedAction: { action: string };
      };
      expect(payload.recommendedAction.action).toContain("https://bounty.example.example.com");
      expect(payload.recommendedAction.action).not.toContain("wss://");
    });
  });

  test("v0.14.1+ RED: recommendedAction.action uses http://, not ws://, when imServerUrl is ws", () => {
    bountyInstance.stop();
    mockWsInstances.length = 0;
    events.length = 0;
    bountyInstance = new (bountyInstance.constructor as typeof BountyIMInstance)(
      createValidConfig({ imServerUrl: "ws://localhost:4005/ws" }),
    );
    bountyInstance.onEvent((evt) => { events.push(evt); });
    return bountyInstance.start().then(() => {
      mockWsInstances[0].trigger("open");
      const messagePayload = JSON.stringify({
        event: "message",
        data: {
          id: "msg-http-1",
          from: "alice@example.com",
          fromEmail: "alice@example.com",
          to: "alice@bounty.example.com", // matches config.email (v0.14 strict)
          status: "pending",
          content: { type: "text", body: "http test" },
        },
      });
      mockWsInstances[0].trigger("message", messagePayload);

      const payload = events[0].payload as unknown as {
        recommendedAction: { action: string };
      };
      expect(payload.recommendedAction.action).toContain("http://localhost:4005");
      expect(payload.recommendedAction.action).not.toContain("ws://");
    });
  });

  test("v0.14.1+ RED: recommendedAction.action --to-email uses msg.fromEmail (not canonical)", () => {
    const messagePayload = JSON.stringify({
      event: "message",
      data: {
        id: "msg-to-email-1",
        from: "767a3275-uuid-uuid-uuid-uuid-uuid@authenticated",
        fromEmail: "user@example.com",
        to: "alice@bounty.example.com",
        status: "pending",
        content: { type: "text", body: "to email test" },
      },
    });
    mockWsInstances[0].trigger("message", messagePayload);

    const payload = events[0].payload as unknown as {
      recommendedAction: { action: string };
    };
    expect(payload.recommendedAction.action).toContain("--to-email user@example.com");
    expect(payload.recommendedAction.action).not.toContain("767a3275-uuid");
    expect(payload.recommendedAction.action).not.toContain("@authenticated");
  });

  test("v0.14.1+ RED: recommendedAction.action --from-email uses profile email (not <your-email>)", () => {
    bountyInstance.stop();
    mockWsInstances.length = 0;
    events.length = 0;
    bountyInstance = new (bountyInstance.constructor as typeof BountyIMInstance)(
      createValidConfig({ email: "dev-author@bigai.ai" }),
    );
    bountyInstance.onEvent((evt) => { events.push(evt); });
    return bountyInstance.start().then(() => {
      mockWsInstances[0].trigger("open");
      const messagePayload = JSON.stringify({
        event: "message",
        data: {
          id: "msg-from-1",
          from: "alice@example.com",
          fromEmail: "alice@example.com",
          to: "dev-author@bigai.ai",
          status: "pending",
          content: { type: "text", body: "from email test" },
        },
      });
      mockWsInstances[0].trigger("message", messagePayload);

      const payload = events[0].payload as unknown as {
        recommendedAction: { action: string };
      };
      expect(payload.recommendedAction.action).toContain("--from-email dev-author@bigai.ai");
      expect(payload.recommendedAction.action).not.toContain("<your-email>");
    });
  });
});

// =============================================================================
// 7. EventSourceComponent 集成（通过 builtInHandlers 自动注册）
// =============================================================================

describe("bountyIMHandler integration with builtInHandlers", () => {
  test("bountyIMHandler should be included in builtInHandlers", async () => {
    const { builtInHandlers } = await import("./event-source-handlers");
    const bountyHandler = builtInHandlers.find((h: EventSourceHandler) => h.type === "bounty-im");
    expect(bountyHandler).toBeDefined();
    expect(bountyHandler).toBe(
      (await import("./bounty-im-handler")).bountyIMHandler,
    );
  });

  test("getBuiltInHandler('bounty-im') should return bountyIMHandler", async () => {
    const { getBuiltInHandler } = await import("./event-source-handlers");
    const handler = getBuiltInHandler("bounty-im");
    expect(handler).toBeDefined();
    expect(handler?.type).toBe("bounty-im");
  });
});

// =============================================================================
// 8. BUILT_IN_EVENT_SOURCE_TYPES
// =============================================================================

describe("BUILT_IN_EVENT_SOURCE_TYPES", () => {
  test("BUILT_IN_EVENT_SOURCE_TYPES.BOUNTY_IM should be 'bounty-im'", async () => {
    const { BUILT_IN_EVENT_SOURCE_TYPES } = await import("./types");
    expect(BUILT_IN_EVENT_SOURCE_TYPES.BOUNTY_IM).toBe("bounty-im");
  });
});

// =============================================================================
// 9. TLS 跳过校验（tlsSkipVerify 配置）- Phase B.8
// =============================================================================

describe("tlsSkipVerify", () => {
  test("T22: 默认配置时 rejectUnauthorized 应该是 true（严格 TLS 验证）", async () => {
    mockWsInstances.length = 0;
    const { BountyIMInstance } = await import("./bounty-im-handler");
    const inst = new BountyIMInstance(createValidConfig());
    inst.onEvent(() => {});

    await inst.start();
    expect(mockWsInstances.length).toBeGreaterThanOrEqual(1);

    // 默认未配置 tlsSkipVerify → rejectUnauthorized 应为 true（严格验证）
    const ws = mockWsInstances[mockWsInstances.length - 1];
    expect(ws.options).toBeDefined();
    expect(ws.options?.rejectUnauthorized).toBe(true);

    await inst.stop();
  });

  test("T23: tlsSkipVerify=true 时 rejectUnauthorized 是 false", async () => {
    mockWsInstances.length = 0;
    const { BountyIMInstance } = await import("./bounty-im-handler");
    const inst = new BountyIMInstance(
      createValidConfig({ tlsSkipVerify: true }),
    );
    inst.onEvent(() => {});

    await inst.start();
    const ws = mockWsInstances[mockWsInstances.length - 1];
    expect(ws.options).toBeDefined();
    expect(ws.options?.rejectUnauthorized).toBe(false);

    await inst.stop();
  });

  test("T24: tlsSkipVerify=false 时 rejectUnauthorized 是 true", async () => {
    mockWsInstances.length = 0;
    const { BountyIMInstance } = await import("./bounty-im-handler");
    const inst = new BountyIMInstance(
      createValidConfig({ tlsSkipVerify: false }),
    );
    inst.onEvent(() => {});

    await inst.start();
    const ws = mockWsInstances[mockWsInstances.length - 1];
    expect(ws.options).toBeDefined();
    expect(ws.options?.rejectUnauthorized).toBe(true);

    await inst.stop();
  });

  test("T25: tlsSkipVerify 写在 options 里也生效（兼容路径）", async () => {
    mockWsInstances.length = 0;
    const { BountyIMInstance } = await import("./bounty-im-handler");
    // 用户写在 options.tlsSkipVerify（旧式路径），应该和顶级字段等价
    const inst = new BountyIMInstance(
      createValidConfig({
        tlsSkipVerify: undefined,
        options: { tlsSkipVerify: true },
      } as Partial<EventSourceConfig>),
    );
    inst.onEvent(() => {});

    await inst.start();
    const ws = mockWsInstances[mockWsInstances.length - 1];
    expect(ws.options?.rejectUnauthorized).toBe(false);

    await inst.stop();
  });
});

// =============================================================================
// 10. bun runtime env fallback（Phase B.9）
//
// 设计要点（用户强约束）：
// 1. bun 全局存在（typeof Bun !== "undefined"）= dev/runtime 模式
// 2. 仅在 tlsSkipVerify=true 且 bun runtime 下写 NODE_TLS_REJECT_UNAUTHORIZED='0'
// 3. Node.js runtime 完全不动 env var（生产目标）
// 4. tlsSkipVerify=false / 未设置 时不动 env var
// =============================================================================

describe("bun runtime env fallback (Phase B.9)", () => {
  /**
   * 测试 bun runtime 下 `tlsSkipVerify=true` 时回退到 NODE_TLS_REJECT_UNAUTHORIZED=0
   * env var 的逻辑。
   *
   * bun 的全局 `Bun` 在 bun test 环境下是 non-configurable 的，无法
   * 直接清空/覆盖 globalThis.Bun 来模拟 Node.js 路径——所以 handler 实现
   * 暴露一个 `shouldWriteBunTlsSkipEnv` 帮助函数，测试 Node.js 路径时通过
   * 显式 `isBunRuntimeOverride=false` 参数注入。这避免了测试改真实全局状态，
   * 同时保持 production 调用点的自然写法：`shouldWriteBunTlsSkipEnv(tlsSkipVerify)`。
   */
  const originalEnv = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

  beforeEach(() => {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    mockWsInstances.length = 0;
  });

  afterEach(async () => {
    // 恢复 env
    if (originalEnv === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalEnv;
    }
  });

  test("T26: bun runtime + tlsSkipVerify=true + wss:// 集成测试 → start() 写 NODE_TLS_REJECT_UNAUTHORIZED='0'", async () => {
    // bun test 环境本身就有 Bun 全局，验证 type guard 真的命中
    expect(typeof (globalThis as { Bun?: unknown }).Bun).not.toBe("undefined");

    const { BountyIMInstance } = await import("./bounty-im-handler");
    const inst = new BountyIMInstance(
      createValidConfig({
        tlsSkipVerify: true,
        imServerUrl: "wss://bounty.example.com/ws", // T26 显式用 wss://，避免被 URL guard 跳过
      } as Partial<EventSourceConfig>),
    );
    inst.onEvent(() => {});

    await inst.start();

    // env 应被设为 "0"（bun 下 ws 库的 TLS 层接受这个 env var）
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe("0");

    await inst.stop();
  });

  test("T27: bun runtime + tlsSkipVerify=false → start() 不修改环境变量", async () => {
    expect(typeof (globalThis as { Bun?: unknown }).Bun).not.toBe("undefined");
    const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

    const { BountyIMInstance } = await import("./bounty-im-handler");
    const inst = new BountyIMInstance(
      createValidConfig({ tlsSkipVerify: false }),
    );
    inst.onEvent(() => {});

    await inst.start();

    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(before);

    await inst.stop();
  });

  test("T28: bun runtime + tlsSkipVerify 未设置 → start() 不修改环境变量", async () => {
    expect(typeof (globalThis as { Bun?: unknown }).Bun).not.toBe("undefined");
    const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

    const { BountyIMInstance } = await import("./bounty-im-handler");
    const inst = new BountyIMInstance(
      createValidConfig({ tlsSkipVerify: undefined }),
    );
    inst.onEvent(() => {});

    await inst.start();

    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(before);

    await inst.stop();
  });

  test("T29: 模拟 Node.js runtime (isBunRuntimeOverride=false) + tlsSkipVerify=true → 不修改环境变量", async () => {
    // 用 helper 注入测试 — 不真的去改 globalThis.Bun（它是 non-configurable）。
    // 等价断言："如果 isBun=false，handler 的回退逻辑不会写 env var"。
    // 通过单元测试 helper 的两条矩阵路径完成（T26 已覆盖 bun=true 集成路径）。

    const { shouldWriteBunTlsSkipEnv } = await import("./bounty-im-handler");
    expect(typeof shouldWriteBunTlsSkipEnv).toBe("function");

    // Node.js path: 即便 tlsSkipVerify=true，helper 必须返回 false
    expect(shouldWriteBunTlsSkipEnv(true, false)).toBe(false);
    // bun path 的对称证明：tlsSkipVerify=true + bun → helper 返回 true
    expect(shouldWriteBunTlsSkipEnv(true, true)).toBe(true);
  });

  test("T29-bonus: helper 矩阵覆盖全 (tlsSkipVerify × bun) 边界", async () => {
    const { shouldWriteBunTlsSkipEnv } = await import("./bounty-im-handler");

    // tlsSkipVerify=false / undefined: 任何 runtime 都不应该写 env var
    expect(shouldWriteBunTlsSkipEnv(false, true)).toBe(false);
    expect(shouldWriteBunTlsSkipEnv(false, false)).toBe(false);
    // undefined 时不强制转 true — 默认严格验证
    expect(shouldWriteBunTlsSkipEnv(undefined as unknown as boolean, true)).toBe(false);
    expect(shouldWriteBunTlsSkipEnv(undefined as unknown as boolean, false)).toBe(false);

    // tlsSkipVerify=true + bun → 写；+node → 不写
    expect(shouldWriteBunTlsSkipEnv(true, true)).toBe(true);
    expect(shouldWriteBunTlsSkipEnv(true, false)).toBe(false);
  });

  test("T30: 即使 tlsSkipVerify=true，但 imServerUrl 是 ws://（非 TLS）→ 不写 env var", async () => {
    // ws:// 不走 TLS 通道，根本不需要 NODE_TLS_REJECT_UNAUTHORIZED。
    // 写这个 env var 会无谓地禁用同进程其他 TLS 连接的证书校验（副作用）。
    // start() 应该在调用 new WebSocket 前先判断 protocol 是 wss:// 才写 env var。
    //
    // 注意：mock 的 ws 不会真正走网络，但仍会触发 setStatus / WS 构造 options 等。
    const { BountyIMInstance } = await import("./bounty-im-handler");
    const inst = new BountyIMInstance(
      createValidConfig({
        tlsSkipVerify: true,
        imServerUrl: "ws://localhost:8080/ws", // non-TLS
      } as Partial<EventSourceConfig>),
    );
    inst.onEvent(() => {});

    await inst.start();

    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();

    await inst.stop();
  });

  test("T30-bonus: tlsSkipVerify=true + wss:// + bun → 写 env var（保证 wss 路径不被砍）", async () => {
    // T26 已经覆盖默认 wss URL；这里显式再断言一次以防 URL 守卫误伤 wss 路径
    const { BountyIMInstance } = await import("./bounty-im-handler");
    const inst = new BountyIMInstance(
      createValidConfig({
        tlsSkipVerify: true,
        imServerUrl: "wss://example.com:8443/ws",
      } as Partial<EventSourceConfig>),
    );
    inst.onEvent(() => {});

    await inst.start();

    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe("0");

    await inst.stop();
  });
});


// ============================================================================
// Phase B.11: systemPrompt 默认值 + 用户覆盖 + metadata 透传
// ============================================================================

describe("Phase B.11: bountyIM default systemPrompt + override", () => {
  test("v0.14: buildDefaultBountyIMSystemPrompt uses email + --server-url + reply command hint", () => {
    const prompt = buildDefaultBountyIMSystemPrompt({
      currentEmail: "agent-x@bounty.example.com",
      imServerUrl: "wss://bounty.example.com/ws",
    });
    expect(prompt).toContain("agent-x@bounty.example.com");
    // v0.14: 命令用 --server-url（不是 --endpoint）
    expect(prompt).toContain("https://bounty.example.com");
    expect(prompt).toContain("bounty com send");
    expect(prompt).toContain("--server-url");
    // 强约束提示（"必须" + "省略会失败"）
    expect(prompt).toMatch(/必须|不可省略|省略会/);
    // v0.14 strict: 不应该再含 --endpoint alias（v0.12 风格）
    expect(prompt).not.toContain("--endpoint");
  });

  test("v0.14: imServerUrl 未设置时使用 localhost 占位", () => {
    const prompt = buildDefaultBountyIMSystemPrompt({
      currentEmail: "agent-x@bounty.example.com",
    });
    expect(prompt).toContain("agent-x@bounty.example.com");
    // 没有 imServerUrl 时应给占位字符串（http://localhost:4000 因为 ws:// 默认映射 http）
    expect(prompt).toMatch(/http(?:s)?:\/\//);
  });

  test("v0.14: wss URL 映射到 https:// server-url", () => {
    const prompt = buildDefaultBountyIMSystemPrompt({
      currentEmail: "a@b.com",
      imServerUrl: "wss://bounty.example.com:443/ws",
    });
    // v0.14: --server-url 应该是 https（不是 ws/wss），且 /ws 后缀应去掉
    expect(prompt).toContain("--server-url https://bounty.example.com:443");
  });

  test("v0.14: ws URL 映射到 http:// server-url (P1-2 bug fix)", () => {
    // BUG: 之前 wss? 强制替换成 https://，但 ws://localhost:4005 也变成 https，
    // 应该是 http（因为 ws 是明文协议）。
    const prompt = buildDefaultBountyIMSystemPrompt({
      currentEmail: "a@b.com",
      imServerUrl: "ws://localhost:4005/ws",
    });
    // 必须用 http://，不能用 https://（会触发 TLS handshake 失败）
    expect(prompt).toContain("--server-url http://localhost:4005");
    expect(prompt).not.toContain("--server-url https://localhost");
  });

  test("v0.14: resolveBountyIMSystemPrompt config.systemPrompt 优先级最高", () => {
    const resolved = resolveBountyIMSystemPrompt({
      configSystemPrompt: "CUSTOM-PROMPT",
      currentEmail: "a@b.com",
      imServerUrl: "wss://x.com/ws",
    });
    expect(resolved).toBe("CUSTOM-PROMPT");
  });

  test("v0.14: resolveBountyIMSystemPrompt 未配置时回退到默认 prompt (email-based)", () => {
    const resolved = resolveBountyIMSystemPrompt({
      currentEmail: "a@b.com",
      imServerUrl: "wss://x.com/ws",
    });
    expect(resolved).toContain("a@b.com");
    // v0.14: 改用 https://x.com 而非 wss://x.com/ws（bounty com send 用 HTTP API）
    expect(resolved).toContain("https://x.com");
  });
});

describe("Phase B.11: systemPrompt 透传到 event.metadata", () => {
  // 共享的 mockWs setup，复用文件中已有的 helper
  // 简化版 mock：直接构造 BountyIMInstance + 触发 message

  function setupInstance(systemPrompt?: string): { instance: BountyIMInstance; events: any[] } {
    const events: any[] = [];
    const config: EventSourceConfig = {
      id: "test-prompt",
      name: "test",
      type: "bounty-im",
      enabled: true,
      // v0.14 strict: bounty-im identity = email only
      email: "test-agent@bounty.example.com",
      imServerUrl: "wss://bounty.example.com/ws",
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    };
    const instance = new BountyIMInstance(config);
    instance.onEvent((evt) => events.push(evt));
    // Mock WebSocket — 直接调 processLine
    (instance as any).ws = {
      send: (msg: string) => { /* noop */ },
    };
    return { instance, events };
  }

  test("v0.14: 未显式配置 systemPrompt 时，metadata.systemPrompt 是默认 prompt (含 email)", () => {
    const { instance, events } = setupInstance();
    instance["processLine"](JSON.stringify({
      event: "message",
      data: {
        id: "msg-prompt-1",
        from: "alice@bounty.example.com",
        to: "test-agent@bounty.example.com",
        status: "pending",
        content: { type: "text", body: "hello" },
      },
    }));
    expect(events.length).toBe(1);
    const sysPrompt = events[0].metadata?.systemPrompt;
    expect(sysPrompt).toBeDefined();
    expect(sysPrompt).toContain("test-agent@bounty.example.com");
    // v0.14: prompt 含 https://bounty.example.com（HTTP endpoint）而不是 wss://...
    expect(sysPrompt).toContain("https://bounty.example.com");
    expect(sysPrompt).toContain("bounty com send");
  });

  test("显式配置 systemPrompt 时，metadata.systemPrompt 透传用户自定义值", () => {
    const custom = "CUSTOM-INSTRUCTION-FOR-AGENT";
    const { instance, events } = setupInstance(custom);
    instance["processLine"](JSON.stringify({
      event: "message",
      data: {
        id: "msg-prompt-2",
        from: "alice@bounty.example.com",
        to: "test-agent@bounty.example.com",
        status: "pending",
        content: { type: "text", body: "hello" },
      },
    }));
    expect(events.length).toBe(1);
    expect(events[0].metadata?.systemPrompt).toBe(custom);
  });
});



// ============================================================================
// Phase v0.14: systemPrompt 强约束 --server-url + --from-email
// ============================================================================
//
// v0.14: 命令格式从 v0.12 的 --endpoint 升级为 --server-url。
// 同时 identity 从 <uuid>@<host> 改为注册邮箱。
// 验证: prompt 含具体 inline 命令模板 + "必须" 提醒词 + email-only。

describe("Phase v0.14: systemPrompt forces --server-url + email-only usage", () => {
  test("v0.14: default systemPrompt 含 inline 命令模板，--server-url + --from-email", () => {
    const prompt = buildDefaultBountyIMSystemPrompt({
      currentEmail: "test@x.com",
      imServerUrl: "wss://bounty.example.com/ws",
    });
    // 验证 prompt 中命令模板 "bounty com send --server-url ..." 存在
    expect(prompt).toMatch(/bounty com send --server-url https:\/\/bounty\.example\.com/);
    // v0.14 strict: email-only 命令模板
    expect(prompt).toContain("--from-email test@x.com");
    expect(prompt).toContain("--to-email");
    // v0.14 strict: 不应再含 --endpoint alias（v0.12 风格）
    expect(prompt).not.toContain("--endpoint");
  });

  test("v0.14: default systemPrompt 含强约束语言 (省略会失败)", () => {
    const prompt = buildDefaultBountyIMSystemPrompt({
      currentEmail: "test@x.com",
      imServerUrl: "wss://bounty.example.com/ws",
    });
    // 必须有强约束词让 LLM 不跳过 --server-url
    const hasStrongConstraint = /必须/.test(prompt) || /不可省略/.test(prompt) || /省略会/.test(prompt);
    expect(hasStrongConstraint).toBe(true);
  });
});

// ============================================================================
// Phase v0.14: STRICT email-only（对齐 bounty server v0.14.0）
//
// 设计：
// - bounty IM identity = email ONLY（注册邮箱）
// - address 字段完全移除（v0.12 <uuid>@<host> 不再支持）
// - WS 连接 query 只有 ?email=<email>
// - validate 严格要求 email 字段存在（address 字段被忽略/报错）
// ============================================================================

describe("v0.14 strict email-only support", () => {
  test("T1: getCurrentIdentity() 只返回 email（no address field）", async () => {
    const { BountyIMInstance } = await import("./bounty-im-handler");

    // v0.14: identity 单一为 email，无 address 字段
    const inst = new BountyIMInstance(createValidConfig({
      email: "alice@bounty.example.com",
    } as Partial<EventSourceConfig>));
    const id = (inst as any).getCurrentIdentity();
    expect(id.email).toBe("alice@bounty.example.com");
    // v0.14 不再返回 address 字段
    expect(id.address).toBeUndefined();
  });

  test("T2: WS 连接用 ?email=<config.email> query（v0.14 唯一路径，无 ?address= fallback）", async () => {
    mockWsInstances.length = 0;
    const { BountyIMInstance } = await import("./bounty-im-handler");

    const inst = new BountyIMInstance(createValidConfig({
      email: "alice@bounty.example.com",
    } as Partial<EventSourceConfig>));
    inst.onEvent(() => {});
    await inst.start();
    const ws = mockWsInstances[mockWsInstances.length - 1];
    expect(ws.url).toContain("email=alice%40bounty.example.com");
    // v0.14 strict: 绝不允许 ?address= query
    expect(ws.url).not.toContain("address=");
    await inst.stop();
  });

  test("T3: validate() 只接受 email 格式（address 字段被忽略/报错）", async () => {
    const { bountyIMHandler } = await import("./bounty-im-handler");

    // Case A: 纯 email 格式 (v0.14)
    const errorsA = bountyIMHandler.validateConfig({
      id: "test-email",
      name: "Test",
      type: "bounty-im",
      enabled: true,
      email: "alice@bounty.example.com",
      imServerUrl: "ws://localhost:4005/ws",
    } as EventSourceConfig);
    expect(errorsA).toEqual([]);

    // Case B: 只有 address，没有 email → v0.14 strict 报错
    const errorsB = bountyIMHandler.validateConfig({
      id: "test-address-only",
      name: "Test",
      type: "bounty-im",
      enabled: true,
      address: "uuid@bounty.example.com",
      imServerUrl: "ws://localhost:4005/ws",
    } as EventSourceConfig);
    expect(errorsB.some((e) => /email.*required/i.test(e))).toBe(true);

    // Case C: email 格式无效
    const errorsC = bountyIMHandler.validateConfig({
      id: "test-bad-email",
      name: "Test",
      type: "bounty-im",
      enabled: true,
      email: "not-an-email",
      imServerUrl: "ws://localhost:4005/ws",
    } as EventSourceConfig);
    expect(errorsC.some((e) => /email.*format/i.test(e))).toBe(true);

    // Case D: email 和 address 都没有 → 报错
    const errorsD = bountyIMHandler.validateConfig({
      id: "test-none",
      name: "Test",
      type: "bounty-im",
      enabled: true,
      imServerUrl: "ws://localhost:4005/ws",
    } as EventSourceConfig);
    expect(errorsD.some((e) => /email.*required/i.test(e))).toBe(true);
  });

  test("T4: getCurrentAddress() 返回 email（v0.14 single canonical identity）", async () => {
    const { BountyIMInstance } = await import("./bounty-im-handler");
    const inst = new BountyIMInstance(createValidConfig({
      email: "alice@bounty.example.com",
    } as Partial<EventSourceConfig>));
    const addr = (inst as any).getCurrentAddress();
    expect(addr).toBe("alice@bounty.example.com");
  });

  test("T-bonus: buildDefaultBountyIMSystemPrompt 使用 v0.14 strict email-only 命令格式", () => {
    // v0.14: 只支持 --server-url + --from-email + --to-email 命令格式
    // 不再有 v0.12 -f/-t alias fallback
    const prompt = buildDefaultBountyIMSystemPrompt({
      currentEmail: "alice@bounty.example.com",
      imServerUrl: "wss://bounty.example.com/ws",
    });
    expect(prompt).toContain("--from-email alice@bounty.example.com");
    expect(prompt).toContain("--to-email");
    expect(prompt).toMatch(/bounty com send --server-url https:\/\/bounty\.example\.com/);
    // v0.14 strict: 绝不允许 -f/-t alias 形式
    expect(prompt).not.toMatch(/-f alice@bounty\.example\.com/);
    expect(prompt).not.toMatch(/-t <to-address>/);
  });
});

// =============================================================================
// 11. v0.14.1+ email-display helpers — 单元测试 (RED → GREEN 隔离)
// =============================================================================

describe("translateImServerUrlToHttpApi helper (v0.14.1+)", () => {
  test("translates wss://host:port/ws → https://host:port", async () => {
    const { translateImServerUrlToHttpApi } = await import("./bounty-im-handler");
    expect(translateImServerUrlToHttpApi("wss://bounty.example.com:443/ws")).toBe(
      "https://bounty.example.com:443",
    );
  });

  test("translates ws://host:port/ws → http://host:port", async () => {
    const { translateImServerUrlToHttpApi } = await import("./bounty-im-handler");
    expect(translateImServerUrlToHttpApi("ws://localhost:4005/ws")).toBe(
      "http://localhost:4005",
    );
  });

  test("translates wss:// without port → https://host", async () => {
    const { translateImServerUrlToHttpApi } = await import("./bounty-im-handler");
    expect(translateImServerUrlToHttpApi("wss://bounty.example.com/ws")).toBe(
      "https://bounty.example.com",
    );
  });

  test("preserves trailing path (only strips exact /ws suffix)", async () => {
    const { translateImServerUrlToHttpApi } = await import("./bounty-im-handler");
    // `/ws/api` is unusual — we keep the path so caller can debug.
    expect(translateImServerUrlToHttpApi("wss://bounty.example.com/ws/api")).toBe(
      "https://bounty.example.com/ws/api",
    );
  });
});

describe("resolveCanonicalToEmail helper (v0.14.1+)", () => {
  test("returns email as-is when already an email", async () => {
    const { resolveCanonicalToEmail } = await import("./bounty-im-handler");
    expect(resolveCanonicalToEmail("alice@example.com", "profile@x.com")).toBe(
      "alice@example.com",
    );
  });

  test("returns profile email when canonical is <uuid>@authenticated", async () => {
    const { resolveCanonicalToEmail } = await import("./bounty-im-handler");
    expect(
      resolveCanonicalToEmail(
        "767a3275-1234-5678-9abc-def012345678@authenticated",
        "dev-author@bigai.ai",
      ),
    ).toBe("dev-author@bigai.ai");
  });

  test("returns null when canonical is <uuid>@<other-host> (no client-side resolver)", async () => {
    const { resolveCanonicalToEmail } = await import("./bounty-im-handler");
    expect(
      resolveCanonicalToEmail(
        "767a3275-1234-5678-9abc-def012345678@bounty.example.example.com",
        "dev-author@bigai.ai",
      ),
    ).toBeNull();
  });

  test("returns null when canonical is <uuid>@authenticated but no profileEmail", async () => {
    const { resolveCanonicalToEmail } = await import("./bounty-im-handler");
    expect(
      resolveCanonicalToEmail(
        "767a3275-1234-5678-9abc-def012345678@authenticated",
        undefined,
      ),
    ).toBeNull();
  });

  test("returns null when canonical is empty / null / undefined", async () => {
    const { resolveCanonicalToEmail } = await import("./bounty-im-handler");
    expect(resolveCanonicalToEmail(undefined, "x@y.com")).toBeNull();
    expect(resolveCanonicalToEmail(null, "x@y.com")).toBeNull();
    expect(resolveCanonicalToEmail("", "x@y.com")).toBeNull();
    expect(resolveCanonicalToEmail("  ", "x@y.com")).toBeNull();
  });
});

// =============================================================================
// Self-echo + Wrong-address filter (Task #2136)
// =============================================================================

describe("isSelfEcho helper (Task #2136)", () => {
  test("returns true when msg.fromEmail matches currentEmail (server enrichment path)", async () => {
    const { isSelfEcho } = await import("./bounty-im-handler");
    const msg = {
      from: "30193cb7-651d-4bf2-8439-052d9a466cf7@authenticated",
      fromEmail: "user@example.com",
      to: "user@example.com",
    };
    expect(isSelfEcho(msg, "user@example.com")).toBe(true);
  });

  test("returns true when fromEmail matches case-insensitively (whitespace tolerant)", async () => {
    const { isSelfEcho } = await import("./bounty-im-handler");
    const msg = {
      fromEmail: "  USER@EXAMPLE.COM ",
      from: "30193cb7-651d-4bf2-8439-052d9a466cf7@authenticated",
      to: "user@example.com",
    };
    expect(isSelfEcho(msg, "user@example.com")).toBe(true);
  });

  test("returns true when canonical UUID before @ in from === to (no fromEmail)", async () => {
    const { isSelfEcho } = await import("./bounty-im-handler");
    const msg = {
      from: "abc12345-1234-1234-1234-123456789012@authenticated",
      to: "abc12345-1234-1234-1234-123456789012@bounty.example.com",
    };
    expect(isSelfEcho(msg, "anyone@example.com")).toBe(true);
  });

  test("returns false when sender is a different agent", async () => {
    const { isSelfEcho } = await import("./bounty-im-handler");
    const msg = {
      from: "99999@authenticated",
      fromEmail: "alice@other.com",
      to: "user@example.com",
    };
    expect(isSelfEcho(msg, "user@example.com")).toBe(false);
  });

  test("returns false when msg.from and msg.to are missing entirely", async () => {
    const { isSelfEcho } = await import("./bounty-im-handler");
    expect(isSelfEcho({}, "anyone@example.com")).toBe(false);
    expect(isSelfEcho({ from: "x@y.com" }, "anyone@example.com")).toBe(false);
    expect(isSelfEcho({ to: "x@y.com" }, "anyone@example.com")).toBe(false);
  });
});

describe("isWrongAddress helper (Task #2136)", () => {
  test("returns false when msg.to matches currentEmail exactly", async () => {
    const { isWrongAddress } = await import("./bounty-im-handler");
    expect(isWrongAddress({ to: "user@example.com" }, "user@example.com")).toBe(false);
  });

  test("returns true when msg.to is a different email entirely", async () => {
    const { isWrongAddress } = await import("./bounty-im-handler");
    expect(
      isWrongAddress({ to: "other-agent@example.com" }, "user@example.com"),
    ).toBe(true);
  });

  test("returns true when canonical UUID before @ differs", async () => {
    const { isWrongAddress } = await import("./bounty-im-handler");
    // Both sides are canonical UUID form (real UUID format 8-4-4-4-12)
    expect(
      isWrongAddress(
        { to: "99999999-9999-9999-9999-999999999999@authenticated" },
        "11111111-1111-1111-1111-111111111111@authenticated",
      ),
    ).toBe(true);
  });

  test("returns false when msg.to is missing (broadcast / unset — let it through)", async () => {
    const { isWrongAddress } = await import("./bounty-im-handler");
    expect(isWrongAddress({}, "anyone@example.com")).toBe(false);
    expect(isWrongAddress({ to: undefined }, "anyone@example.com")).toBe(false);
  });

  test("returns false when canonical UUID before @ matches even if suffix differs", async () => {
    const { isWrongAddress } = await import("./bounty-im-handler");
    expect(
      isWrongAddress(
        { to: "abc12345-1234-1234-1234-123456789012@some.other.host" },
        "abc12345-1234-1234-1234-123456789012@authenticated",
      ),
    ).toBe(false);
  });
});

// =============================================================================
// Self-echo + Wrong-address filter — Integration with processLine (Task #2136)
// =============================================================================

describe("BountyIMInstance processLine — self-echo + wrong-address filter (Task #2136)", () => {
  let localEvents: EventSourceEvent[];
  let localInstance: InstanceType<typeof import("./bounty-im-handler").BountyIMInstance>;

  beforeEach(async () => {
    mockWsInstances.length = 0;
    localEvents = [];
    const mod = await import("./bounty-im-handler");
    // Use canonical form for currentEmail so UUID-match path is also exercised
    localInstance = new mod.BountyIMInstance(
      createValidConfig({ email: "user@example.com" }),
    );
    localInstance.onEvent((evt) => { localEvents.push(evt); });
    await localInstance.start();
    mockWsInstances[0].trigger("open");
  });

  afterEach(async () => {
    if (localInstance.getStatus() === "running") {
      await localInstance.stop();
    }
  });

  test("skips self-echo: msg.fromEmail === currentEmail (no event, ACK still sent)", () => {
    const messagePayload = JSON.stringify({
      event: "message",
      data: {
        id: "msg-self-echo-1",
        from: "30193cb7-651d-4bf2-8439-052d9a466cf7@authenticated",
        fromEmail: "user@example.com",
        to: "user@example.com",
        status: "delivered",
        content: { type: "text", body: "中午开会，几点在哪儿开？" },
      },
    });
    mockWsInstances[0].trigger("message", messagePayload);

    // 1) No event emitted to agent
    expect(localEvents.length).toBe(0);

    // 2) ACK still sent so server doesn't re-push on reconnect
    const ws = mockWsInstances[0];
    const ackCall = ws.send.mock.calls.find((call: unknown[]) => {
      const payload = call[0] as string;
      return payload.includes('"ack"');
    });
    expect(ackCall).toBeDefined();
  });

  test("skips self-echo via canonical UUID match (no fromEmail enrichment)", () => {
    // Pre-v0.14.1 server doesn't enrich msg.fromEmail. Fall back to canonical UUID match.
    const canonicalUuid = "abc12345-1234-1234-1234-123456789012";
    const messagePayload = JSON.stringify({
      event: "message",
      data: {
        id: "msg-self-echo-2",
        from: `${canonicalUuid}@authenticated`,
        to: `${canonicalUuid}@bounty.example.com`, // same UUID before @ on both sides
        status: "delivered",
        content: { type: "text", body: "fallback path" },
      },
    });
    mockWsInstances[0].trigger("message", messagePayload);

    expect(localEvents.length).toBe(0);

    const ws = mockWsInstances[0];
    const ackCall = ws.send.mock.calls.find((call: unknown[]) => {
      const payload = call[0] as string;
      return payload.includes('"ack"');
    });
    expect(ackCall).toBeDefined();
  });

  test("skips wrong-address: msg.to references a different agent (v0.14 strict email routing)", () => {
    // v0.14 strict: identity = email. Both currentEmail and msg.to are email forms.
    // msg.to != currentEmail → wrong address → skip.
    const messagePayload = JSON.stringify({
      event: "message",
      data: {
        id: "msg-wrong-1",
        from: "alice@example.com",
        fromEmail: "alice@example.com",
        to: "other-agent@example.com", // NOT our email (user@example.com)
        status: "delivered",
        content: { type: "text", body: "should be ignored" },
      },
    });
    mockWsInstances[0].trigger("message", messagePayload);

    expect(localEvents.length).toBe(0);
  });

  test("does not generate recommendedAction (💡 回复:) when self-echo is skipped", () => {
    const messagePayload = JSON.stringify({
      event: "message",
      data: {
        id: "msg-self-echo-3",
        from: "abc12345-1234-1234-1234-123456789012@authenticated",
        fromEmail: "user@example.com",
        to: "user@example.com",
        status: "delivered",
        content: { type: "text", body: "测试 phantom prompt" },
      },
    });
    mockWsInstances[0].trigger("message", messagePayload);

    // No event at all → no recommendedAction → no phantom 💡 回复: line
    expect(localEvents.length).toBe(0);
    // Belt-and-suspenders: assert no event payload contains "💡 回复"
    for (const evt of localEvents) {
      const msg = (evt.payload as { message?: string }).message ?? "";
      expect(msg).not.toContain("💡 回复");
    }
  });

  test("passes through legitimate inbound: different sender → event emitted normally", () => {
    const messagePayload = JSON.stringify({
      event: "message",
      data: {
        id: "msg-legit-1",
        from: "alice@example.com",
        fromEmail: "alice@example.com",
        to: "user@example.com",
        status: "delivered",
        content: { type: "text", body: "legit inbound" },
      },
    });
    mockWsInstances[0].trigger("message", messagePayload);

    expect(localEvents.length).toBe(1);
    const payload = localEvents[0].payload as {
      metadata: { senderId: string; senderEmail: string };
      message: string;
    };
    expect(payload.metadata.senderId).toBe("alice@example.com");
    expect(payload.metadata.senderEmail).toBe("alice@example.com");
    // The 💡 回复: line SHOULD be present for legit inbound
    expect(payload.message).toContain("💡 回复");
  });

  test("end-to-end self-loop: simulate agent send → server echo → no event reaches agent", async () => {
    // 1) Simulate the agent sending a message via ws.send
    const outboundPayload = JSON.stringify({
      event: "message",
      data: {
        id: "msg-outbound-1",
        from: "user@example.com", // current agent
        fromEmail: "user@example.com",
        to: "dev-author@bigai.ai",
        status: "delivered",
        content: { type: "text", body: "我自己刚发的消息" },
      },
    });
    mockWsInstances[0].trigger("message", outboundPayload);

    // 2) Server echoes back the same message as a "delivered" event to the sender
    const echoPayload = JSON.stringify({
      event: "message",
      data: {
        id: "msg-outbound-1", // same ID!
        from: "user@example.com",
        fromEmail: "user@example.com",
        to: "user@example.com", // back to me
        status: "delivered",
        content: { type: "text", body: "我自己刚发的消息" },
      },
    });
    mockWsInstances[0].trigger("message", echoPayload);

    // 3) Agent should have ZERO events (no outbound, no echo)
    expect(localEvents.length).toBe(0);

    // 4) Both outbound AND echo should have been ACKed (idempotency)
    const ws = mockWsInstances[0];
    const ackCalls = ws.send.mock.calls.filter((call: unknown[]) => {
      const payload = call[0] as string;
      return payload.includes('"ack"');
    });
    expect(ackCalls.length).toBeGreaterThanOrEqual(2);
  });

  test("integration: mixed traffic — self-echo + legit inbound interleaved, only legit reaches agent", () => {
    // Simulates a realistic agent session:
    //   1. Agent sends outbound msg
    //   2. Server echoes it back (self-echo)
    //   3. Other agent sends legit inbound to us
    //   4. Agent sends another outbound
    //   5. Server echoes that too
    //   6. Other agent sends another legit inbound
    //
    // Expected: agent sees EXACTLY 2 events (the two legit inbounds).
    const currentAgent = "user@example.com";

    // 1) outbound → 2) server echo
    mockWsInstances[0].trigger("message", JSON.stringify({
      event: "message",
      data: {
        id: "out-1", from: currentAgent, fromEmail: currentAgent,
        to: "alice@example.com", status: "delivered",
        content: { type: "text", body: "outbound 1" },
      },
    }));
    mockWsInstances[0].trigger("message", JSON.stringify({
      event: "message",
      data: {
        id: "out-1", from: currentAgent, fromEmail: currentAgent,
        to: currentAgent, status: "delivered",
        content: { type: "text", body: "outbound 1 (echo)" },
      },
    }));
    // 3) legit inbound from alice
    mockWsInstances[0].trigger("message", JSON.stringify({
      event: "message",
      data: {
        id: "in-1", from: "alice@example.com", fromEmail: "alice@example.com",
        to: currentAgent, status: "delivered",
        content: { type: "text", body: "hi gdd" },
      },
    }));
    // 4) outbound → 5) server echo
    mockWsInstances[0].trigger("message", JSON.stringify({
      event: "message",
      data: {
        id: "out-2", from: currentAgent, fromEmail: currentAgent,
        to: "bob@example.com", status: "delivered",
        content: { type: "text", body: "outbound 2" },
      },
    }));
    mockWsInstances[0].trigger("message", JSON.stringify({
      event: "message",
      data: {
        id: "out-2", from: currentAgent, fromEmail: currentAgent,
        to: currentAgent, status: "delivered",
        content: { type: "text", body: "outbound 2 (echo)" },
      },
    }));
    // 6) legit inbound from bob
    mockWsInstances[0].trigger("message", JSON.stringify({
      event: "message",
      data: {
        id: "in-2", from: "bob@example.com", fromEmail: "bob@example.com",
        to: currentAgent, status: "delivered",
        content: { type: "text", body: "hey gdd" },
      },
    }));

    // 6 messages in, but agent only sees the 2 legit inbounds
    expect(localEvents.length).toBe(2);

    // Verify the 2 surviving events are exactly the legit inbounds
    const ids = localEvents.map((evt) => {
      const payload = evt.payload as unknown as { rawEvent: { data: { id: string } } };
      return payload.rawEvent.data.id;
    });
    expect(ids).toEqual(["in-1", "in-2"]);

    // All 6 messages should have been ACKed (4 skipped + 2 processed = 6 total)
    const ws = mockWsInstances[0];
    const ackCalls = ws.send.mock.calls.filter((call: unknown[]) => {
      const payload = call[0] as string;
      return payload.includes('"ack"');
    });
    expect(ackCalls.length).toBe(6);
  });

  test("integration via builtInHandlers.createInstance — self-echo still filtered at the top level", async () => {
    // Verify the filter is also active when the instance is created via the
    // built-in handler registry (not directly via 'new BountyIMInstance(...)').
    // This guards against regressions in EventSourceComponent wiring.
    mockWsInstances.length = 0;
    const { builtInHandlers, getBuiltInHandler } = await import(
      "./event-source-handlers"
    );
    const handler = getBuiltInHandler("bounty-im") ?? builtInHandlers.find(
      (h: { type: string }) => h.type === "bounty-im",
    );
    expect(handler).toBeDefined();
    if (!handler) return; // type narrowing for ts

    const cfg: EventSourceConfig = {
      id: "bounty-im-builtin-test",
      name: "Bounty IM Built-in Test",
      type: "bounty-im",
      enabled: true,
      email: "user@example.com",
      imServerUrl: "ws://localhost:4005/ws",
    };
    const inst = handler.createInstance(cfg);
    const builtinEvents: EventSourceEvent[] = [];
    inst.onEvent((evt) => { builtinEvents.push(evt); });
    await inst.start();
    mockWsInstances[0].trigger("open");

    // Trigger a self-echo via the registry-created instance
    mockWsInstances[0].trigger("message", JSON.stringify({
      event: "message",
      data: {
        id: "registry-self-echo",
        from: "user@example.com",
        fromEmail: "user@example.com",
        to: "user@example.com",
        status: "delivered",
        content: { type: "text", body: "echo via registry" },
      },
    }));

    expect(builtinEvents.length).toBe(0);
    await inst.stop();
  });
});
