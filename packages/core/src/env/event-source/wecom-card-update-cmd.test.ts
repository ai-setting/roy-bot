/**
 * @fileoverview Task #5203 — view 无时间线根因回归测试
 *
 * ## 根因（真网实证：用户点「查看详情」卡片不更新）
 *
 * 默认 updateCard 端口调 `bridge.respond(reqId, body)`，而
 * `respond()` 内部把帧硬包成 `cmd: "aibot_respond_msg"` ——
 * 卡片更新必须用 `cmd: "aibot_respond_update_msg"`。
 * `buildWecomCardUpdateBody` 返回的正确 cmd 被解构丢弃，
 * 服务端收到 aibot_respond_msg + update_template_card body
 * 静默拒绝 → 卡片永远不更新。
 *
 * ## 为什么既有测试没抓住（假防御）
 *
 * wecom-card-wiring.test.ts 的用例 **mock 掉了 updateCard 端口
 * 本身**，从未走默认端口实现 → cmd 被吞的 bug 恒绿。
 *
 * 本文件用 mock WS 驱动**真实默认端口**（startWithBridge +
 * environment mock），断言线上真正发出的帧 cmd。
 */

import { describe, expect, test } from "bun:test";
import {
  WECOM_CLI_ES_TYPE,
  wecomCliHandler,
} from "./wecom-cli-handler";
import type { EventSourceConfig } from "./types";
import {
  WecomCardActionKey,
  buildWecomCardUpdateFrame,
  newWecomCardTaskId,
} from "./wecom-card-builder";

/** 可编程 mock WebSocket（只实现 bridge 用到的面） */
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readyState = 0;
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

function makeWsConfig(): EventSourceConfig {
  return {
    id: "es-wecom-card-cmd",
    name: "wecom-card-cmd",
    type: WECOM_CLI_ES_TYPE,
    botId: "B1",
    secret: "S1",
  } as EventSourceConfig;
}

/** 带默认端口接线的运行中实例（environment mock 提供 task 端口） */
async function makeWiredInstance(): Promise<{
  inst: ReturnType<typeof wecomCliHandler.createInstance>;
  ws: MockWebSocket;
  updatedTasks: Array<{ id: number; options: Record<string, unknown> }>;
}> {
  const inst = wecomCliHandler.createInstance(makeWsConfig());
  const updatedTasks: Array<{
    id: number;
    options: Record<string, unknown>;
  }> = [];
  // environment mock：taskComponent.updateTask（默认端口 cross-wire 依赖）
  (inst as unknown as { setEnvironment: (e: unknown) => void }).setEnvironment({
    getComponent: (name: string) =>
      name === "task"
        ? {
            updateTask: async (id: number, options: Record<string, unknown>) => {
              updatedTasks.push({ id, options });
            },
          }
        : undefined,
  });
  await (inst as unknown as {
    startWithBridge: (
      f: (url: string) => unknown,
    ) => Promise<void>;
  }).startWithBridge((url) => new MockWebSocket(url));
  const ws = MockWebSocket.instances.at(-1)!;
  ws.open(); // 认证帧发出
  return { inst, ws, updatedTasks };
}

describe("默认 updateCard 端口 — cmd 必须是 aibot_respond_update_msg（Task #5203 回归）", () => {
  test("默认端口 updateCard → 线上帧 cmd=aibot_respond_update_msg + req_id 透传 + 时间线 horizontal（截断修复）", async () => {
    MockWebSocket.instances = [];
    const { inst, ws } = await makeWiredInstance();
    try {
      const ports = (
        inst as unknown as { cardActionPorts?: { updateCard: (...a: unknown[]) => Promise<void> } }
      ).cardActionPorts;
      expect(ports).toBeDefined();

      const cardTaskId = newWecomCardTaskId(2);
      await ports!.updateCard(
        "REQ-VIEW-1",
        cardTaskId,
        "已查看",
        "已为您刷新详情",
        [
          {
            timestamp: "2026-11-09 10:30",
            title: "GREEN：时间线详情 6 测试全过",
            description: "view 动作从 store 读 timeline",
          },
        ],
      );

      const frames = ws.sent.map((s) => JSON.parse(s));
      const update = frames.find(
        (f: { cmd?: string }) => f.cmd === "aibot_respond_update_msg",
      );
      // ★ 核心断言：更新帧必须用 aibot_respond_update_msg（不是 aibot_respond_msg）
      expect(update).toBeDefined();
      expect(update.headers.req_id).toBe("REQ-VIEW-1");
      expect(update.body.response_type).toBe("update_template_card");
      expect(update.body.template_card.task_id).toBe(cardTaskId);
      // ★ 截断修复：时间线走 horizontal_content_list
      // ★ Task #5275：value 短化（语义首段）——长标题
      //   「GREEN：时间线详情 6 测试全过」首段化为「GREEN」，
      //   完整内容在进展卡 sub_title_text/quote_area 仍可见。
      expect(
        update.body.template_card.horizontal_content_list.some(
          (h: { value: string }) => h.value.includes("GREEN"),
        ),
      ).toBe(true);
      // 不允许误发成普通回复帧
      const wrong = frames.find(
        (f: { cmd?: string; body?: any }) =>
          f.cmd === "aibot_respond_msg" &&
          f.body?.response_type === "update_template_card",
      );
      expect(wrong).toBeUndefined();
    } finally {
      await inst.stop();
    }
  });

  test("端到端：点「查看详情」按钮 → 默认链路发出 aibot_respond_update_msg 帧", async () => {
    MockWebSocket.instances = [];
    const { inst, ws, updatedTasks } = await makeWiredInstance();
    try {
      const cardTaskId = newWecomCardTaskId(2);
      ws.feed({
        cmd: "aibot_event_callback",
        headers: { req_id: "REQ-E2E-VIEW" },
        body: {
          msgid: "MSG-E2E-VIEW",
          create_time: 1700000000,
          aibotid: "B1",
          chattype: "single",
          from: { userid: "DongZhaoKun" },
          msgtype: "event",
          event: {
            eventtype: "template_card_event",
            template_card_event: {
              card_type: "button_interaction",
              event_key: WecomCardActionKey.VIEW,
              task_id: cardTaskId,
            },
          },
        },
      });
      // handleWsFrame 是 async，feed 同步 emit → 等微任务排空
      await new Promise((r) => setTimeout(r, 20));

      const frames = ws.sent.map((s) => JSON.parse(s));
      const update = frames.find(
        (f: { cmd?: string; headers?: any }) =>
          f.cmd === "aibot_respond_update_msg" &&
          f.headers?.req_id === "REQ-E2E-VIEW",
      );
      expect(update).toBeDefined();
      expect(update.body.response_type).toBe("update_template_card");
      // view 动作不触发 task 操作
      expect(updatedTasks).toEqual([]);
    } finally {
      await inst.stop();
    }
  });
});

describe("buildWecomCardUpdateFrame — cmd 契约（防回归锚点）", () => {
  test("帧 cmd 恒为 aibot_respond_update_msg", () => {
    const frame = buildWecomCardUpdateFrame({
      reqId: "R1",
      taskId: "t1",
      statusLabel: "已查看",
    });
    expect(frame.cmd).toBe("aibot_respond_update_msg");
    expect(frame.headers.req_id).toBe("R1");
  });
});
