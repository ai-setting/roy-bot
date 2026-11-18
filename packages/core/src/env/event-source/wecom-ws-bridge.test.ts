/**
 * @fileoverview Task #5165 — 企微长连接 WebSocket 桥测试
 *
 * 全部 mock 掉真实网络（不连 wss://openws.work.weixin.qq.com）。
 * 协议帧形状取自官方 @wecom/aibot-node-sdk 源码（Task #5142 取证）：
 * - 认证帧 {cmd:"aibot_subscribe",headers:{req_id},body:{bot_id,secret}}
 * - 认证响应 {headers:{req_id:"aibot_subscribe_..."},errcode:0}
 * - 心跳 {cmd:"ping"}，响应 req_id 前缀 "ping_"
 * - 消息帧 {cmd:"aibot_msg_callback",headers:{req_id},body:{...}}
 */

import { describe, expect, test } from "bun:test";
import {
  buildWecomAuthFrame,
  buildWecomHeartbeatFrame,
  isWecomAuthResponse,
  isWecomHeartbeatResponse,
  isWecomDisconnectedEvent,
} from "./wecom-ws-bridge";

describe("wecom-ws-bridge — 协议帧构造", () => {
  test("认证帧：cmd=aibot_subscribe，body 带 bot_id+secret，req_id 前缀正确", () => {
    const f = buildWecomAuthFrame("BOT-1", "sec-1");
    expect(f.cmd).toBe("aibot_subscribe");
    expect(f.body.bot_id).toBe("BOT-1");
    expect(f.body.secret).toBe("sec-1");
    expect(f.headers.req_id.startsWith("aibot_subscribe_")).toBe(true);
  });

  test("心跳帧：cmd=ping，req_id 前缀 ping_", () => {
    const f = buildWecomHeartbeatFrame();
    expect(f.cmd).toBe("ping");
    expect(f.headers.req_id.startsWith("ping_")).toBe(true);
  });

  test("认证响应判定：req_id 前缀 aibot_subscribe_ + errcode", () => {
    expect(
      isWecomAuthResponse({
        headers: { req_id: "aibot_subscribe_123_abc" },
        errcode: 0,
      }),
    ).toBe(true);
    expect(
      isWecomAuthResponse({
        headers: { req_id: "aibot_subscribe_123_abc" },
        errcode: 95001,
      }),
    ).toBe(true); // 失败响应也是认证响应（errcode!=0）
    expect(isWecomAuthResponse({ headers: { req_id: "ping_x" }, errcode: 0 })).toBe(
      false,
    );
    expect(isWecomAuthResponse({ cmd: "aibot_msg_callback" })).toBe(false);
  });

  test("心跳响应判定：req_id 前缀 ping_", () => {
    expect(
      isWecomHeartbeatResponse({ headers: { req_id: "ping_123_abc" }, errcode: 0 }),
    ).toBe(true);
    expect(
      isWecomHeartbeatResponse({
        headers: { req_id: "aibot_subscribe_1_a" },
        errcode: 0,
      }),
    ).toBe(false);
  });

  // =======================================================================
  // Task #5203：disconnected_event 判定（服务端踢线信号）
  // =======================================================================

  test("disconnected_event 判定：aibot_event_callback + event.eventtype=disconnected_event", () => {
    expect(
      isWecomDisconnectedEvent({
        cmd: "aibot_event_callback",
        headers: { req_id: "req-1" },
        body: {
          msgid: "M1",
          msgtype: "event",
          event: { eventtype: "disconnected_event" },
        },
      }),
    ).toBe(true);
  });

  test("disconnected_event 判定：其他事件类型 / 消息帧 / 心跳响应 → false", () => {
    expect(
      isWecomDisconnectedEvent({
        cmd: "aibot_event_callback",
        body: { event: { eventtype: "template_card_event" } },
      }),
    ).toBe(false);
    expect(
      isWecomDisconnectedEvent({
        cmd: "aibot_msg_callback",
        body: { msgid: "M1", msgtype: "text" },
      }),
    ).toBe(false);
    expect(isWecomDisconnectedEvent({ headers: { req_id: "ping_x" } })).toBe(
      false,
    );
    expect(isWecomDisconnectedEvent(undefined)).toBe(false);
  });
});

// =============================================================================
// WsBridge 状态机（mock ws，不连真实网络）
// =============================================================================

import { WecomWsBridge } from "./wecom-ws-bridge";

/** 可编程的 mock WebSocket（只实现 bridge 用到的面） */
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readyState = 0; // CONNECTING
  sent: string[] = [];
  handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }
  on(ev: string, cb: (...a: unknown[]) => void) {
    (this.handlers[ev] ??= []).push(cb);
  }
  send(data: string) {
    this.sent.push(data);
  }
  terminate() {
    this.emit("close");
  }
  close() {
    this.emit("close");
  }
  // 测试驱动：模拟服务端行为
  emit(ev: string, ...args: unknown[]) {
    for (const cb of this.handlers[ev] ?? []) cb(...args);
  }
  /** 模拟连接建立 */
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  /** 模拟收到服务端帧 */
  feed(frame: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(frame)));
  }
}

function makeBridgeOpts() {
  const MockWS = MockWebSocket as unknown as {
    new (url: string): WebSocket;
  };
  return {
    botId: "BOT-1",
    secret: "sec-1",
    wsFactory: (url: string) => new MockWS(url) as unknown as WebSocket,
    heartbeatIntervalMs: 10,
    reconnectBaseDelayMs: 5,
  };
}

describe("WecomWsBridge — 连接与认证", () => {
  test("connect 后 open 即发认证帧（bot_id+secret）", async () => {
    MockWebSocket.instances = [];
    const bridge = new WecomWsBridge(makeBridgeOpts());
    bridge.connect();
    const ws = MockWebSocket.instances[0];
    ws.open();
    // open → 同步发认证帧
    const auth = ws.sent.map((s) => JSON.parse(s)).find(
      (f: { cmd?: string }) => f.cmd === "aibot_subscribe",
    );
    expect(auth).toBeDefined();
    expect(auth.body.bot_id).toBe("BOT-1");
    expect(auth.body.secret).toBe("sec-1");
  });

  test("认证成功（errcode=0）→ authenticated 回调 + 心跳启动", async () => {
    MockWebSocket.instances = [];
    let authed = 0;
    const bridge = new WecomWsBridge(makeBridgeOpts());
    bridge.onAuthenticated(() => authed++);
    bridge.connect();
    const ws = MockWebSocket.instances[0];
    ws.open();
    // 找到认证帧的 req_id，回一个成功响应
    const auth = JSON.parse(ws.sent[0]);
    ws.feed({
      headers: { req_id: auth.headers.req_id },
      errcode: 0,
      errmsg: "ok",
    });
    expect(authed).toBe(1);
    // 心跳已启动：等 2 个间隔应看到 ping 帧
    await new Promise((r) => setTimeout(r, 30));
    const pings = ws.sent
      .map((s) => JSON.parse(s))
      .filter((f: { cmd?: string }) => f.cmd === "ping");
    expect(pings.length).toBeGreaterThanOrEqual(1);
    bridge.stop();
  });

  test("认证失败（errcode!=0）→ 不回调 authenticated，按 auth 失败计数重连", async () => {
    MockWebSocket.instances = [];
    let authed = 0;
    let reconnecting = 0;
    const bridge = new WecomWsBridge(makeBridgeOpts());
    bridge.onAuthenticated(() => authed++);
    bridge.onReconnecting(() => reconnecting++);
    bridge.connect();
    const ws = MockWebSocket.instances[0];
    ws.open();
    const auth = JSON.parse(ws.sent[0]);
    ws.feed({
      headers: { req_id: auth.headers.req_id },
      errcode: 95001,
      errmsg: "bad secret",
    });
    expect(authed).toBe(0);
    // 等重连定时器触发 → 新建第二条连接
    await new Promise((r) => setTimeout(r, 30));
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    expect(reconnecting).toBeGreaterThanOrEqual(1);
    bridge.stop();
  });

  test("消息帧 → onMessage 回调透传原始帧", async () => {
    MockWebSocket.instances = [];
    const got: unknown[] = [];
    const bridge = new WecomWsBridge(makeBridgeOpts());
    bridge.onMessage((frame) => got.push(frame));
    bridge.connect();
    const ws = MockWebSocket.instances[0];
    ws.open();
    const auth = JSON.parse(ws.sent[0]);
    ws.feed({ headers: { req_id: auth.headers.req_id }, errcode: 0 });
    ws.feed({
      cmd: "aibot_msg_callback",
      headers: { req_id: "req-1" },
      body: { msgid: "M1", msgtype: "text", text: { content: "hi" } },
    });
    expect(got.length).toBe(1);
    expect((got[0] as { body?: { msgid?: string } }).body?.msgid).toBe("M1");
    bridge.stop();
  });

  test("stop 后不再重连（isManualClose）", async () => {
    MockWebSocket.instances = [];
    const bridge = new WecomWsBridge(makeBridgeOpts());
    bridge.connect();
    const ws = MockWebSocket.instances[0];
    ws.open();
    bridge.stop();
    const count = MockWebSocket.instances.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(MockWebSocket.instances.length).toBe(count);
  });

  // =======================================================================
  // Task #5203：服务端踢线（disconnected_event）必须触发重连
  // =======================================================================

  test("收到 disconnected_event 事件帧 → 主动重连（新建第二条 WS）", async () => {
    MockWebSocket.instances = [];
    let reconnecting = 0;
    const bridge = new WecomWsBridge(makeBridgeOpts());
    bridge.onReconnecting(() => reconnecting++);
    bridge.connect();
    const ws = MockWebSocket.instances[0];
    ws.open();
    const auth = JSON.parse(ws.sent[0]);
    ws.feed({ headers: { req_id: auth.headers.req_id }, errcode: 0 });
    expect(MockWebSocket.instances.length).toBe(1);

    // 服务端踢线：只发事件帧，TCP 仍然 ESTAB（不触发 close）
    ws.feed({
      cmd: "aibot_event_callback",
      headers: { req_id: "req-disc-1" },
      body: {
        msgid: "M-DISC",
        msgtype: "event",
        event: { eventtype: "disconnected_event" },
      },
    });

    // 等退避定时器触发 → 应新建第二条连接
    await new Promise((r) => setTimeout(r, 40));
    expect(reconnecting).toBeGreaterThanOrEqual(1);
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    bridge.stop();
  });

  test("disconnected_event 不透传给 onMessage（避免上层误当业务事件）", async () => {
    MockWebSocket.instances = [];
    const got: unknown[] = [];
    const bridge = new WecomWsBridge(makeBridgeOpts());
    bridge.onMessage((frame) => got.push(frame));
    bridge.connect();
    const ws = MockWebSocket.instances[0];
    ws.open();
    const auth = JSON.parse(ws.sent[0]);
    ws.feed({ headers: { req_id: auth.headers.req_id }, errcode: 0 });
    ws.feed({
      cmd: "aibot_event_callback",
      headers: { req_id: "req-disc-2" },
      body: {
        msgid: "M-DISC2",
        msgtype: "event",
        event: { eventtype: "disconnected_event" },
      },
    });
    expect(got.length).toBe(0);
    bridge.stop();
  });

  test("stop 后收到 disconnected_event → 不再重连", async () => {
    MockWebSocket.instances = [];
    const bridge = new WecomWsBridge(makeBridgeOpts());
    bridge.connect();
    const ws = MockWebSocket.instances[0];
    ws.open();
    bridge.stop();
    const count = MockWebSocket.instances.length;
    ws.feed({
      cmd: "aibot_event_callback",
      headers: { req_id: "req-disc-3" },
      body: {
        msgid: "M-DISC3",
        msgtype: "event",
        event: { eventtype: "disconnected_event" },
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(MockWebSocket.instances.length).toBe(count);
  });
});

// =============================================================================
// DS review B1/M1 修复（Task #5165）— 帧透传 secret 清洗
// =============================================================================

describe("WecomWsBridge — 帧透传 secret 清洗（DS review B1）", () => {
  test("服务端 echo 帧（含 body.secret）→ onMessage 收到的帧已删除 secret 字段", async () => {
    MockWebSocket.instances = [];
    const got: unknown[] = [];
    const bridge = new WecomWsBridge(makeBridgeOpts());
    bridge.onMessage((frame) => got.push(frame));
    bridge.connect();
    const ws = MockWebSocket.instances[0];
    ws.open();
    const auth = JSON.parse(ws.sent[0]);
    ws.feed({ headers: { req_id: auth.headers.req_id }, errcode: 0 });
    // 服务端异常 echo：消息帧 body 里带 secret（不应泄漏给上层）
    ws.feed({
      cmd: "aibot_msg_callback",
      headers: { req_id: "req-echo" },
      body: { msgid: "M2", msgtype: "text", secret: "sec-1", text: { content: "hi" } },
    });
    expect(got.length).toBe(1);
    const frame = got[0] as { body?: Record<string, unknown> };
    expect(frame.body).toBeDefined();
    expect(frame.body!.secret).toBeUndefined();
    expect(frame.body!.msgid).toBe("M2");
    bridge.stop();
  });

  test("顶层 secret 字段同样被清洗（防御 echo 形态 2）", async () => {
    MockWebSocket.instances = [];
    const got: unknown[] = [];
    const bridge = new WecomWsBridge(makeBridgeOpts());
    bridge.onMessage((frame) => got.push(frame));
    bridge.connect();
    const ws = MockWebSocket.instances[0];
    ws.open();
    const auth = JSON.parse(ws.sent[0]);
    ws.feed({ headers: { req_id: auth.headers.req_id }, errcode: 0 });
    ws.feed({
      cmd: "aibot_msg_callback",
      headers: { req_id: "req-echo2" },
      secret: "sec-1",
      body: { msgid: "M3" },
    });
    const frame = got[0] as { secret?: string };
    expect(frame.secret).toBeUndefined();
    bridge.stop();
  });
});

// =============================================================================
// 回复帧（Task #5174 — aibot_respond_msg 回帧）
// =============================================================================

import {
  buildWecomRespondFrame,
  buildWecomRespondTextFrame,
} from "./wecom-ws-bridge";

describe("wecom-ws-bridge — 回复帧构造（Task #5174）", () => {
  test("buildWecomRespondFrame：cmd=aibot_respond_msg，req_id 原样透传", () => {
    const frame = buildWecomRespondFrame("h2HfG2TdRDatXcGVqxW51gAA", {
      msgtype: "text",
      text: { content: "hi back" },
    });
    expect(frame.cmd).toBe("aibot_respond_msg");
    expect(frame.headers?.req_id).toBe("h2HfG2TdRDatXcGVqxW51gAA");
    expect(frame.body).toEqual({
      msgtype: "text",
      text: { content: "hi back" },
    });
  });

  test("buildWecomRespondTextFrame：便捷构造 text 回复", () => {
    const frame = buildWecomRespondTextFrame("req-1", "hello");
    expect(frame.cmd).toBe("aibot_respond_msg");
    expect(frame.headers?.req_id).toBe("req-1");
    expect(frame.body?.msgtype).toBe("text");
    expect((frame.body?.text as { content: string }).content).toBe("hello");
  });

  test("空 req_id 抛错（回复必须关联原消息）", () => {
    expect(() => buildWecomRespondFrame("", { msgtype: "text" })).toThrow(
      /req_id/,
    );
  });
});

describe("WecomWsBridge — respond 发送（Task #5174）", () => {
  test("认证后 respond → ws.send 发出 aibot_respond_msg 帧", async () => {
    MockWebSocket.instances = [];
    const bridge = new WecomWsBridge(makeBridgeOpts());
    bridge.connect();
    const ws = MockWebSocket.instances[0];
    ws.open();
    const auth = JSON.parse(ws.sent[0]);
    ws.feed({ headers: { req_id: auth.headers.req_id }, errcode: 0 });

    const before = ws.sent.length;
    const err = bridge.respond("orig-req-1", {
      msgtype: "text",
      text: { content: "reply!" },
    });
    expect(err).toBeUndefined();
    const sent = ws.sent.slice(before).map((s) => JSON.parse(s));
    const respond = sent.find(
      (f: { cmd?: string }) => f.cmd === "aibot_respond_msg",
    );
    expect(respond).toBeDefined();
    expect(respond.headers.req_id).toBe("orig-req-1");
    expect(respond.body.text.content).toBe("reply!");
    bridge.stop();
  });

  test("未连接时 respond 返回错误不抛（best-effort）", () => {
    MockWebSocket.instances = [];
    const bridge = new WecomWsBridge(makeBridgeOpts());
    // 不 connect → ws undefined
    const err = bridge.respond("req-x", { msgtype: "text" });
    expect(err).toBeInstanceOf(Error);
  });

  test("stop 后 respond 返回错误", async () => {
    MockWebSocket.instances = [];
    const bridge = new WecomWsBridge(makeBridgeOpts());
    bridge.connect();
    const ws = MockWebSocket.instances[0];
    ws.open();
    const auth = JSON.parse(ws.sent[0]);
    ws.feed({ headers: { req_id: auth.headers.req_id }, errcode: 0 });
    bridge.stop();
    const err = bridge.respond("req-y", { msgtype: "text" });
    expect(err).toBeInstanceOf(Error);
  });
});
