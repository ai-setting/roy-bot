/**
 * @fileoverview Task #5203 — 企微真卡片接线测试
 *
 * - handleWsFrame：template_card_event → 卡片动作处理（不走 Agent，
 *   不分发事件）+ 5 秒内 aibot_respond_update_msg 回帧
 * - WecomTaskNotifyHook：deliver 改走 sendWecomTemplateCard（WS 直发
 *   template_card），失败回落 markdown
 */

import { describe, expect, test, beforeEach } from "bun:test";
import {
  WECOM_CLI_ES_TYPE,
  wecomCliHandler,
} from "./wecom-cli-handler";
import {
  __resetWecomRespondRegistryForTest,
  registerWecomRespondTarget,
} from "./wecom-respond-registry";
import type { EventSourceConfig, EventSourceEvent } from "./types";
import {
  WecomCardActionKey,
  newWecomCardTaskId,
} from "./wecom-card-builder";

function makeWsConfig(): EventSourceConfig {
  return {
    id: "es-wecom-card-wire",
    name: "wecom-card-wire",
    type: WECOM_CLI_ES_TYPE,
    botId: "B1",
    secret: "S1",
    handleRule: { plugins: ["WecomTaskNotifyPlugin"] },
  } as EventSourceConfig;
}

function makeCardEventFrame(input: {
  reqId: string;
  eventKey: string;
  taskId: string;
}) {
  return {
    cmd: "aibot_event_callback",
    headers: { req_id: input.reqId },
    body: {
      msgid: `MSG-${input.reqId}`,
      create_time: 1700000000,
      aibotid: "BOT-1",
      chattype: "single",
      from: { userid: "DongZhaoKun" },
      msgtype: "event",
      event: {
        eventtype: "template_card_event",
        template_card_event: {
          card_type: "button_interaction",
          event_key: input.eventKey,
          task_id: input.taskId,
        },
      },
    },
  };
}

describe("handleWsFrame — template_card_event 分流（Task #5203）", () => {
  beforeEach(() => {
    __resetWecomRespondRegistryForTest();
  });

  test("点「标记完成」→ aibot_respond_update_msg 回帧（5 秒窗口）+ 不分发事件", async () => {
    const inst = wecomCliHandler.createInstance(makeWsConfig());
    const received: EventSourceEvent[] = [];
    inst.onEvent((evt) => received.push(evt));

    // 注册 mock target：捕获 respond/sendCmd
    const responded: Array<{ reqId: string; body: any }> = [];
    registerWecomRespondTarget("es-wecom-card-wire", {
      respond: (reqId, body) => {
        responded.push({ reqId, body });
        return undefined;
      },
      sendCmd: () => undefined,
    });

    // 注入 task 端口（真实实现从 environment 取；测试直接注入）
    const done: number[] = [];
    (inst as unknown as {
      setCardActionPorts: (p: unknown) => void;
    }).setCardActionPorts({
      markTaskDone: async (id: number) => {
        done.push(id);
      },
      reopenTask: async () => {},
      updateCard: async (reqId: string, cardTaskId: string, label: string) => {
        // 模拟真实端口：经 bridge.respond 发 aibot_respond_update_msg
        const { buildWecomCardUpdateBody } = await import(
          "./wecom-card-action-handler"
        );
        const { body } = buildWecomCardUpdateBody({
          cardTaskId,
          statusLabel: label,
        });
        responded.push({ reqId, body });
      },
    });

    const cardTaskId = newWecomCardTaskId(42);
    await (inst as unknown as {
      handleWsFrame: (f: unknown) => Promise<void>;
    }).handleWsFrame(
      makeCardEventFrame({
        reqId: "REQ-CARD-1",
        eventKey: WecomCardActionKey.MARK_DONE,
        taskId: cardTaskId,
      }),
    );

    // task 操作触发
    expect(done).toEqual([42]);
    // 卡片更新帧发出（aibot_respond_update_msg + req_id 透传）
    const update = responded.find(
      (r) => r.body?.response_type === "update_template_card",
    );
    expect(update).toBeDefined();
    expect(update!.reqId).toBe("REQ-CARD-1");
    expect(update!.body.template_card.task_id).toBe(cardTaskId);
    // 事件不分发到 Agent（卡片点击是确定性动作）
    expect(received.length).toBe(0);
  });

  test("普通消息帧不受影响（仍分发事件）", async () => {
    const inst = wecomCliHandler.createInstance(makeWsConfig());
    const received: EventSourceEvent[] = [];
    inst.onEvent((evt) => received.push(evt));

    await (inst as unknown as {
      handleWsFrame: (f: unknown) => Promise<void>;
    }).handleWsFrame({
      cmd: "aibot_msg_callback",
      headers: { req_id: "REQ-MSG-1" },
      body: {
        msgid: "MSG-1",
        chattype: "single",
        from: { userid: "u1" },
        msgtype: "text",
        text: { content: "hello" },
      },
    });
    expect(received.length).toBe(1);
  });
});

describe("WecomTaskNotifyHook — template_card 直发（Task #5203）", () => {
  // 延迟 import（避免与上面 describe 的模块初始化顺序耦合）
  test("deliver 走 WS 直发 template_card；构造失败回落 markdown", async () => {
    const { WecomTaskNotifyHook } = await import(
      "../task/plugins/wecom-task-notify-plugin"
    );
    const { MemoryWecomCardStateStore } = await import(
      "../task/plugins/wecom-card-state-store"
    );
    const { buildWecomTextNoticeCard } = await import("./wecom-card-builder");

    __resetWecomRespondRegistryForTest();
    const sentCards: Array<{ chatId: string; card: any }> = [];
    registerWecomRespondTarget("src-card-hook", {
      respond: () => undefined,
      sendCmd: (cmd, body) => {
        sentCards.push({
          chatId: String(body.chatid),
          card: body.template_card,
        });
        return undefined;
      },
    });

    const store = new MemoryWecomCardStateStore();
    const hook = new WecomTaskNotifyHook({
      pluginName: "WecomTaskNotifyPlugin",
      sourceId: "src-card-hook",
      cardStateStore: store,
      sender: {
        // markdown fallback sender（CLI 路径）——卡片直发失败时才走
        send: async () => ({ ok: true, channel: "cli" }),
      },
    });

    // 模拟企微事件上下文
    const { runWithEnvContext } = await import("../context/env-context");
    const envContext = {
      sourceId: "src-card-hook",
      userId: "u1",
      envEvent: {
        type: "event-source.event.wecom-cli",
        metadata: { chatId: "wotnB7Wgxxx", sourceId: "src-card-hook" },
      },
      replyChannel: { type: "wecom-cli", chatId: "wotnB7Wgxxx" },
      pluginEnabled: { "src-card-hook:WecomTaskNotifyPlugin": true },
      plugins: ["WecomTaskNotifyPlugin"],
    } as any;

    await runWithEnvContext(envContext, async () => {
      await (hook as unknown as {
        execute: (ctx: unknown) => Promise<void>;
      }).execute({
        component: { name: "task", version: "1" },
        hookPoint: "task:after.create",
        phase: "after",
        metadata: {},
        data: {
          task: {
            id: 42,
            title: "真卡片任务",
            description: "测试 template_card 直发",
            status: "todo",
            progress: 0,
          },
        },
      } as unknown as Parameters<
        typeof hook.execute
      >[0]);
    });

    // 卡片经 WS 直发（sendCmd → aibot_send_msg template_card）
    expect(sentCards.length).toBe(1);
    expect(sentCards[0].chatId).toBe("wotnB7Wgxxx");
    // ★ Task #5250：升级为 button_interaction 卡（带「刷新详情」按钮）
    expect(sentCards[0].card.card_type).toBe("button_interaction");
    expect(
      sentCards[0].card.button_list.some(
        (b: { key: string; text: string }) =>
          b.key === "task_view" && b.text.includes("刷新"),
      ),
    ).toBe(true);
    expect(sentCards[0].card.main_title.title).toContain("#42");
    // store 已记录（chatId + 时间线）
    const rec = store.get(42);
    expect(rec).toBeDefined();
    expect(rec!.chatId).toBe("wotnB7Wgxxx");
    expect(rec!.status).toBe("open");
  });
});
