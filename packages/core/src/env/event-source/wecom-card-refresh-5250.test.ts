/**
 * @fileoverview Task #5250 — view「刷新详情」可重复点击
 *
 * ## 用户明令（08:10）
 *
 * 「查看详情」改「刷新详情」，可**重复点击**刷新查看
 * 最新里程碑/操作记录。
 *
 * ## 旧行为（#5203）
 *
 * view 更新后 buildWecomCardUpdateBody 把按钮替换成
 * 死的「已处理」（key=task_done_ack，无回调路由）→
 * 卡片变成一次性，无法再刷新。
 *
 * ## 新行为
 *
 * - view/reopen 刷新后按钮仍保留「刷新详情」
 *   （key=task_view，可再次点击触发 template_card_event）
 * - mark_done 仍替换成「已处理」（终态确认，向后兼容）
 */

import { describe, expect, test, beforeEach } from "bun:test";
import {
  handleWecomCardAction,
  __resetWecomCardActionInflightForTest,
  buildWecomCardUpdateBody,
  type WecomCardActionPorts,
} from "./wecom-card-action-handler";
import { WecomCardActionKey, newWecomCardTaskId } from "./wecom-card-builder";

/** 构造 template_card_event 回调帧 */
function makeCardEventFrame(input: {
  reqId: string;
  eventKey: string;
  taskId: string;
  userid?: string;
}) {
  return {
    cmd: "aibot_event_callback",
    headers: { req_id: input.reqId },
    body: {
      msgid: "MSG-5250",
      create_time: 1700000000,
      aibotid: "BOT-1",
      chattype: "single",
      from: { userid: input.userid ?? "DongZhaoKun" },
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

describe("Task #5250 — buildWecomCardUpdateBody 按钮按 action 决定", () => {
  test("view 更新后按钮仍为可点击的「刷新详情」（key=task_view）", () => {
    const { body } = buildWecomCardUpdateBody({
      cardTaskId: "roy-task-501-1-abc",
      statusLabel: "👀 已刷新",
      action: "view",
    });
    const card = body.template_card as any;
    expect(card.button_list).toHaveLength(1);
    expect(card.button_list[0].key).toBe("task_view");
    expect(card.button_list[0].text).toContain("刷新");
  });

  test("reopen 更新后按钮仍为可点击的「刷新详情」", () => {
    const { body } = buildWecomCardUpdateBody({
      cardTaskId: "roy-task-502-1-abc",
      statusLabel: "🔄 进行中",
      action: "reopen",
    });
    const card = body.template_card as any;
    expect(card.button_list[0].key).toBe("task_view");
  });

  test("mark_done 更新后按钮为「已处理」（终态，向后兼容）", () => {
    const { body } = buildWecomCardUpdateBody({
      cardTaskId: "roy-task-503-1-abc",
      statusLabel: "🎉 已完成",
      action: "mark_done",
    });
    const card = body.template_card as any;
    expect(card.button_list[0].key).toBe("task_done_ack");
    expect(card.button_list[0].text).toBe("已处理");
  });

  test("不传 action（旧调用方）→ 默认「已处理」（向后兼容）", () => {
    const { body } = buildWecomCardUpdateBody({
      cardTaskId: "roy-task-504-1-abc",
      statusLabel: "👀 已查看",
    });
    const card = body.template_card as any;
    expect(card.button_list[0].key).toBe("task_done_ack");
  });
});

describe("Task #5250 — view「刷新详情」可重复点击（端到端）", () => {
  beforeEach(() => __resetWecomCardActionInflightForTest());

  function makePorts() {
    const calls = {
      updates: [] as Array<{ reqId: string; cardTaskId: string }>,
    };
    const ports: WecomCardActionPorts = {
      markTaskDone: async () => {},
      reopenTask: async () => {},
      loadTimeline: () => [
        { title: "Task 创建", timestamp: "2026-11-10T00:00:00Z" },
      ],
      updateCard: async (reqId, cardTaskId) => {
        calls.updates.push({ reqId, cardTaskId });
      },
    };
    return { ports, calls };
  };

  test("连续两次 view 点击 → 两次 updateCard 均成功（可重复刷新）", async () => {
    const { ports, calls } = makePorts();
    const cardTaskId = newWecomCardTaskId(502);
    const r1 = await handleWecomCardAction(
      makeCardEventFrame({
        reqId: "REQ-5250-V2A",
        eventKey: WecomCardActionKey.VIEW,
        taskId: cardTaskId,
      }),
      ports,
    );
    const r2 = await handleWecomCardAction(
      makeCardEventFrame({
        reqId: "REQ-5250-V2B",
        eventKey: WecomCardActionKey.VIEW,
        taskId: cardTaskId,
      }),
      ports,
    );
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(calls.updates).toHaveLength(2);
    expect(calls.updates[0].reqId).toBe("REQ-5250-V2A");
    expect(calls.updates[1].reqId).toBe("REQ-5250-V2B");
  });
});

describe("Task #5250 — cli-handler 降级持久化 store（插件未加载）", () => {
  test("getWecomCardStateStore 插件未加载 → 懒创建持久化 store（非 undefined）", async () => {
    const { WECOM_CLI_ES_TYPE, wecomCliHandler } = await import(
      "./wecom-cli-handler"
    );
    const { mkdtempSync, rmSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const dir = mkdtempSync(join(tmpdir(), "wecom-fallback-5250-"));
    process.env.ROY_AGENT_WECOM_CARD_DB = join(dir, "wecom-cards.db");
    let inst: any;
    try {
      inst = wecomCliHandler.createInstance({
        id: "es-wecom-5250",
        name: "wecom-5250",
        type: WECOM_CLI_ES_TYPE,
        botId: "B1",
        secret: "S1",
      } as any);
      const getter = (
        inst as unknown as {
          getWecomCardStateStore(): { get(t: number): { timeline?: string } } | undefined;
        }
      ).getWecomCardStateStore.bind(inst);
      const store = getter();
      // ★ 核心断言：插件未加载也不返回 undefined（降级持久化 store）
      expect(store).toBeDefined();
      expect(typeof store!.get).toBe("function");
      // 写入 → 读回（同一实例内）
      const s2 = getter();
      expect(s2).toBe(store); // 懒创建：二次调用复用同一实例
    } finally {
      delete process.env.ROY_AGENT_WECOM_CARD_DB;
      // DS review M-3：先 stop（内部 close fallback store）再清理目录
      await inst?.stop?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
