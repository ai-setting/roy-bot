/**
 * @fileoverview Task #5203 — WS 直发通道测试
 *
 * - WecomWsBridge.sendCmd：主动推送帧（aibot_send_msg 等，无需原消息关联）
 * - sendWecomTemplateCard：卡片出站（WS 直发 template_card →
 *   失败/不可用时回落 markdown CLI 路径）
 */

import { describe, expect, test } from "bun:test";
import { WecomWsBridge } from "./wecom-ws-bridge";
import {
  __resetWecomRespondRegistryForTest,
  registerWecomRespondTarget,
  sendWecomTemplateCard,
} from "./wecom-respond-registry";
import {
  buildWecomTextNoticeCard,
  buildWecomSendCardFrame,
} from "./wecom-card-builder";

// ============================================================================
// bridge.sendCmd
// ============================================================================

/** 可编程的 mock WebSocket（对齐 wecom-ws-bridge.test.ts 的既有 mock） */
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
  emit(ev: string, ...args: unknown[]) {
    for (const cb of this.handlers[ev] ?? []) cb(...args);
  }
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  feed(frame: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(frame)));
  }
}

function makeBridgeOpts() {
  const MockWS = MockWebSocket as unknown as {
    new (url: string): any;
  };
  return {
    botId: "BOT-1",
    secret: "sec-1",
    wsFactory: (url: string) => new MockWS(url),
    heartbeatIntervalMs: 10,
    reconnectBaseDelayMs: 5,
  };
}

async function authedBridge(): Promise<{
  bridge: WecomWsBridge;
  ws: MockWebSocket;
}> {
  const bridge = new WecomWsBridge(makeBridgeOpts() as any);
  bridge.connect();
  const ws = MockWebSocket.instances[0];
  ws.open();
  const auth = JSON.parse(ws.sent[0]);
  ws.feed({ headers: { req_id: auth.headers.req_id }, errcode: 0 });
  return { bridge, ws };
}

describe("WecomWsBridge — sendCmd 主动推送（Task #5203）", () => {
  test("认证后 sendCmd → ws.send 发出指定 cmd 帧", async () => {
    MockWebSocket.instances = [];
    const { bridge, ws } = await authedBridge();
    const before = ws.sent.length;
    const err = bridge.sendCmd("aibot_send_msg", {
      chatid: "u1",
      msgtype: "template_card",
      template_card: { card_type: "text_notice" },
    });
    expect(err).toBeUndefined();
    const sent = ws.sent.slice(before).map((s) => JSON.parse(s));
    const f = sent.find((x: { cmd?: string }) => x.cmd === "aibot_send_msg");
    expect(f).toBeDefined();
    expect(f.body.chatid).toBe("u1");
    expect(f.body.msgtype).toBe("template_card");
    bridge.stop();
  });

  test("未连接时 sendCmd 返回错误不抛（best-effort）", () => {
    MockWebSocket.instances = [];
    const bridge = new WecomWsBridge(makeBridgeOpts() as any);
    const err = bridge.sendCmd("aibot_send_msg", {});
    expect(err).toBeInstanceOf(Error);
  });

  test("stop 后 sendCmd 返回错误", async () => {
    MockWebSocket.instances = [];
    const { bridge } = await authedBridge();
    bridge.stop();
    const err = bridge.sendCmd("aibot_send_msg", {});
    expect(err).toBeInstanceOf(Error);
  });
});

// ============================================================================
// sendWecomTemplateCard
// ============================================================================

describe("sendWecomTemplateCard — 卡片出站（Task #5203）", () => {
  test("WS 实例已注册 → 直发 template_card，channel=ws", async () => {
    __resetWecomRespondRegistryForTest();
    MockWebSocket.instances = [];
    const { bridge, ws } = await authedBridge();
    registerWecomRespondTarget("src-1", {
      respond: (reqId, body) => bridge.respond(reqId, body),
      sendCmd: (cmd, body) => bridge.sendCmd(cmd, body),
    });

    const card = buildWecomTextNoticeCard({
      taskId: 42,
      title: "T",
      statusLabel: "🔄",
      progress: 50,
      milestones: [],
    });
    const before = ws.sent.length;
    const r = await sendWecomTemplateCard({
      sourceId: "src-1",
      chatId: "wotnB7Wgxxx",
      chatType: "single",
      card,
    });
    expect(r.ok).toBe(true);
    expect(r.channel).toBe("ws");
    const sent = ws.sent.slice(before).map((s) => JSON.parse(s));
    const f = sent.find((x: { cmd?: string }) => x.cmd === "aibot_send_msg");
    expect(f).toBeDefined();
    expect(f.body.msgtype).toBe("template_card");
    expect(f.body.chat_type).toBe(1);
    bridge.stop();
  });

  test("无注册实例 → ok=false 带错误说明（不抛）", async () => {
    __resetWecomRespondRegistryForTest();
    const card = buildWecomTextNoticeCard({
      taskId: 1,
      title: "T",
      statusLabel: "🔄",
      progress: 0,
      milestones: [],
    });
    const r = await sendWecomTemplateCard({
      sourceId: "no-such-src",
      chatId: "u1",
      chatType: "single",
      card,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no instance");
  });

  test("sendCmd 失败 → ok=false 带原因", async () => {
    __resetWecomRespondRegistryForTest();
    registerWecomRespondTarget("src-2", {
      respond: () => new Error("respond not used"),
      sendCmd: () => new Error("bridge not connected"),
    });
    const card = buildWecomTextNoticeCard({
      taskId: 1,
      title: "T",
      statusLabel: "🔄",
      progress: 0,
      milestones: [],
    });
    const r = await sendWecomTemplateCard({
      sourceId: "src-2",
      chatId: "u1",
      chatType: "single",
      card,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("bridge not connected");
  });

  test("sendCmd 抛异常 → 捕获为 ok=false（永不抛）", async () => {
    __resetWecomRespondRegistryForTest();
    registerWecomRespondTarget("src-3", {
      respond: () => undefined,
      sendCmd: () => {
        throw new Error("boom");
      },
    });
    const card = buildWecomTextNoticeCard({
      taskId: 1,
      title: "T",
      statusLabel: "🔄",
      progress: 0,
      milestones: [],
    });
    const r = await sendWecomTemplateCard({
      sourceId: "src-3",
      chatId: "u1",
      chatType: "single",
      card,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("boom");
  });
});
