/**
 * @fileoverview Task #5333 — ES config `extendTools` 事件层接线测试
 *
 * ## 需求
 * 「ES config 支持 extend tools —— 不同 ES 驱动的 agent 注入 tools 可不同。」
 *
 * ## 契约（本文件断言）
 * 1. `EventSourceConfig.extendTools?: string[]` 生效
 * 2. `wecom-cli` handler：即使用户没配，也**默认注入** `["wecom_respond"]`
 *    （企微渠道的唯一出站工具），并 config.extendTools 追加在后（去重）
 * 3. `lark-cli` handler：config.extendTools 原样透传（未配 → 不注入任何键）
 * 4. 两个 handler 都把 extendTools 写进 `evt.metadata.extendTools`，
 *    供 run.ts / run-headless-dispatch.ts 透传到 AgentContext
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createChildProcessMockModule } from "../../test-utils/child-process-mock";
import type { EventSourceEvent } from "./types";

const spawnMock = mock((_cmd: string, _args: string[]) => ({
  stdout: { on: () => {} },
  stderr: { on: () => {} },
  on: (event: string, cb: Function) => {
    if (event === "close") cb(0);
  },
  kill: () => {},
  pid: 99996,
} as any));

const execStub = mock((_cmd: string, cb?: Function) => {
  if (typeof cb === "function") cb(null, { stdout: "", stderr: "" });
  return { on: () => {}, kill: () => {}, pid: 99995 } as any;
});

beforeEach(() => {
  spawnMock.mockClear();
  execStub.mockClear();
  mock.module("child_process", () =>
    createChildProcessMockModule({
      spawn: spawnMock,
      exec: execStub as any,
    }),
  );
});

// =============================================================================
// 企微 handler：默认注入 wecom_respond
// =============================================================================

const TEXT_MSG_FRAME = {
  cmd: "aibot_msg_callback",
  headers: { req_id: "req-ext-1" },
  body: {
    msgid: "MSGID-EXT-1",
    aibotid: "AIBOT123",
    chatid: "CHATID-EXT-1",
    chattype: "group",
    from: { userid: "zhangsan" },
    msgtype: "text",
    text: { content: "hello" },
  },
};

async function captureWecomEvents(config: any): Promise<EventSourceEvent[]> {
  const { wecomCliHandler } = await import("./wecom-cli-handler");
  const inst = wecomCliHandler.createInstance(config) as unknown as {
    startWithBridge: (f: (url: string) => unknown) => Promise<void>;
    handleWsFrame: (f: unknown) => void;
    onEvent: (h: (e: EventSourceEvent) => void) => void;
    stop: () => Promise<void>;
  };
  await inst.startWithBridge(() => ({
    on: () => {},
    send: () => {},
    close: () => {},
    terminate: () => {},
  }));
  const events: EventSourceEvent[] = [];
  inst.onEvent((e) => events.push(e));
  inst.handleWsFrame(TEXT_MSG_FRAME);
  await inst.stop();
  return events;
}

describe("Task #5333 — wecom-cli handler extendTools 默认注入", () => {
  test("未配置 extendTools 时，metadata.extendTools 默认含 wecom_respond", async () => {
    const events = await captureWecomEvents({
      id: "es-ext-wecom-1",
      name: "wecom-ext",
      type: "wecom-cli",
      enabled: true,
      options: { botId: "b1", secret: "s1" },
    });
    expect(events.length).toBe(1);
    expect(events[0].metadata.extendTools).toEqual(["wecom_respond"]);
  });

  test("config.extendTools 与默认 wecom_respond 合并（默认在前、去重）", async () => {
    const events = await captureWecomEvents({
      id: "es-ext-wecom-2",
      name: "wecom-ext2",
      type: "wecom-cli",
      enabled: true,
      extendTools: ["custom_tool", "wecom_respond"],
      options: { botId: "b1", secret: "s1" },
    });
    expect(events[0].metadata.extendTools).toEqual(["wecom_respond", "custom_tool"]);
  });
});

// =============================================================================
// lark-cli handler：config.extendTools 透传
// =============================================================================

function makeLarkMessageEvent(): any {
  return {
    type: "im.message.receive_v1",
    event_id: "evt-ext-1",
    event: {
      header: { event_type: "im.message.receive_v1", app_id: "cli_app123", tenant_key: "tenant_xyz" },
      message: {
        message_id: "om_ext_001",
        chat_id: "oc_ext_001",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
      sender: { sender_id: { open_id: "ou_ext_001" } },
    },
  };
}

async function captureLarkEvents(config: any): Promise<any[]> {
  const { larkCliHandler } = await import("./event-source-handlers");
  const { LarkCliInstance } = await import("./event-source-handlers");
  (LarkCliInstance as any).__resetDedupForTest?.();
  const instance = larkCliHandler.createInstance(config);
  const captured: any[] = [];
  instance.onEvent((evt: any) => captured.push(evt));
  await (instance as any).handleEvent(JSON.stringify(makeLarkMessageEvent()));
  return captured;
}

describe("Task #5333 — lark-cli handler extendTools 透传", () => {
  test("配置了 extendTools 时透传到 metadata.extendTools", async () => {
    const events = await captureLarkEvents({
      id: "es-ext-lark-1",
      name: "lark-ext",
      type: "lark-cli",
      enabled: true,
      profile: "tongzhuli",
      extendTools: ["lark_custom_tool"],
    });
    expect(events.length).toBe(1);
    expect(events[0].metadata.extendTools).toEqual(["lark_custom_tool"]);
  });

  test("未配置 extendTools 时不注入该键（default agent 不受影响）", async () => {
    const events = await captureLarkEvents({
      id: "es-ext-lark-2",
      name: "lark-ext2",
      type: "lark-cli",
      enabled: true,
      profile: "tongzhuli",
    });
    expect(events.length).toBe(1);
    expect(events[0].metadata.extendTools).toBeUndefined();
  });
});
