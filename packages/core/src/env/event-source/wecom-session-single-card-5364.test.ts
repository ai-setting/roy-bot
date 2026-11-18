/**
 * @fileoverview Task #5364 —— 企微「单卡 + 按钮驱动更新」核心行为测试
 *
 * ## 用户需求（2026-11-12 08:34 拍板 B）
 *
 * > 「企微改成**只维护一张卡 + 靠按钮触发更新**」
 *
 * ## 本文件锁定三件事
 *
 * A. **只发一次**：同一 session 的后续 lifecycle 事件**不准再发卡**
 *    （旧实现每条都发 ⇒ 用户否掉的「每个生命周期一张卡」）
 * B. **状态不丢**：后续 lifecycle 只写持久层，刷新时要能重建完整卡
 * C. **刷新帧完整**：生命周期 / 会话详情 / 任务行 / 操作记录 / 活性 ——
 *    用户明令「原有信息一个不少」
 *
 * ## 为什么必须断言 sendCard 的**调用次数**
 *
 * 前几轮（#5360 R2/R3/R4）反复栽在「代码写了但行为不是你想要的」。
 * 「只发一张卡」的唯一硬证据就是 `sendCard` 被调了几次 —— 断言卡片内容
 * 再漂亮，发两张也是错的。
 */

import { describe, test, expect } from "bun:test";
import type { EnvEvent } from "../types";
import {
  createWecomSessionCardSender,
} from "./wecom-session-card-sender";
import {
  buildWecomSessionUpdateFrame,
  ROY_SESSION_PREFIX,
  WecomCardActionKey,
  wecomCardTaskIdForSession,
} from "./wecom-card-builder";
import {
  createMemoryWecomSessionCardStore,
  type WecomSessionCardStore,
} from "../task/plugins/wecom-session-card-store";
import type { SubSessionActivity } from "../task/plugins/sub-session-activity";

const SESSION_ID = "session_b_04357c17";
const SOURCE_ID = "wecom-bot-1";
const USER_ID = "dzk_wecom_userid";
const NOW = new Date(2026, 10, 12, 8, 34, 0).getTime();
const MIN = 60 * 1000;

function ev(
  lifecycle: string,
  over: Record<string, unknown> = {},
): EnvEvent {
  return {
    id: `evt-${lifecycle}`,
    type: "task.background.session_started",
    timestamp: Date.now(),
    payload: {
      backgroundTaskId: "process_b",
      subSessionId: SESSION_ID,
      parentSessionId: "parent-1",
      description: "调研 airport 本体生成",
      subagentType: "roy",
      lifecycle,
      startedAt: NOW - 20 * MIN,
      ...over,
    },
    metadata: {
      source: "task.background",
      sourceId: SOURCE_ID,
      replyChannel: {
        type: "wecom-cli",
        chatId: USER_ID,
        params: { chatType: "single", sourceId: SOURCE_ID },
      },
    },
  } as unknown as EnvEvent;
}

function makeSender(store: WecomSessionCardStore) {
  const calls: any[] = [];
  const send = createWecomSessionCardSender({
    store,
    sendCard: async (input) => {
      calls.push(input);
      return { ok: true };
    },
  });
  return { send, calls };
}

// ============================================================================
// A. 只发一次（B 方案的核心）
// ============================================================================

describe("★ B 方案：一个 session 只发一张卡", () => {
  test("首次 lifecycle 事件 → 发卡 1 次 + 落库 running", async () => {
    const store = createMemoryWecomSessionCardStore();
    const { send, calls } = makeSender(store);

    await send(ev("running"));

    expect(calls).toHaveLength(1);
    const rec = store.get(SESSION_ID);
    expect(rec).toBeDefined();
    expect(rec!.lifecycle).toBe("running");
    expect(rec!.chatId).toBe(USER_ID);
    expect(rec!.chatType).toBe("single");
    expect(rec!.title).toBe("调研 airport 本体生成");
    expect(rec!.agentType).toBe("roy");
    expect(rec!.cardTaskId.startsWith(ROY_SESSION_PREFIX)).toBe(true);
  });

  test("★ 后续 completed → **不再发卡**，只更新持久层", async () => {
    const store = createMemoryWecomSessionCardStore();
    const { send, calls } = makeSender(store);

    await send(ev("running"));
    await send(ev("completed"));

    expect(calls).toHaveLength(1); // ★ 关键断言：仍然只有一张卡
    const rec = store.get(SESSION_ID);
    expect(rec!.lifecycle).toBe("completed");
    expect(rec!.closedAt).toBeDefined();
  });

  test("★ 五个生命周期全走完 → 发送次数恒为 1", async () => {
    const store = createMemoryWecomSessionCardStore();
    const { send, calls } = makeSender(store);

    for (const l of ["running", "completed", "timeout", "failed", "stopped"]) {
      await send(ev(l));
    }
    expect(calls).toHaveLength(1);
  });

  test("★ 里程碑累积（刷新时才能看到完整生命周期轨迹）", async () => {
    const store = createMemoryWecomSessionCardStore();
    const { send } = makeSender(store);

    await send(ev("running"));
    await send(ev("completed"));

    const rec = store.get(SESSION_ID);
    const ms = JSON.parse(rec!.milestones ?? "[]");
    expect(ms.length).toBe(2);
    expect(ms[0].title).toContain("运行中");
    expect(ms[1].title).toContain("已完成");
  });

  test("★ 重启场景：store 已有记录 → 一次都不重发", async () => {
    const store = createMemoryWecomSessionCardStore();
    store.upsert({
      sessionId: SESSION_ID,
      chatId: USER_ID,
      chatType: "single",
      cardTaskId: wecomCardTaskIdForSession(SESSION_ID),
      lifecycle: "running",
      createdAt: NOW - 30 * MIN,
      updatedAt: NOW - 30 * MIN,
    });

    const { send, calls } = makeSender(store);
    await send(ev("running"));
    await send(ev("completed"));

    expect(calls).toHaveLength(0); // 之前发过卡了 ⇒ 一条都不发
    expect(store.get(SESSION_ID)!.lifecycle).toBe("completed");
  });

  test("无 store 端口 → 内部内存兜底，同实例也只发一次（不会退化成发 N 张）", async () => {
    const calls: any[] = [];
    const send = createWecomSessionCardSender({
      sendCard: async (i) => {
        calls.push(i);
        return { ok: true };
      },
    });
    await send(ev("running"));
    await send(ev("completed"));
    await send(ev("stopped"));
    expect(calls).toHaveLength(1);
  });

  test("★ 渠道 guard 仍然生效：飞书事件一张都不发", async () => {
    const store = createMemoryWecomSessionCardStore();
    const { send, calls } = makeSender(store);
    await send(
      ev("running", {
        // replyChannel 换成飞书
      }),
    );
    // 上面是企微；下面这条才是飞书
    const larkEvent = {
      ...ev("completed"),
      metadata: {
        replyChannel: { type: "lark-cli", chatId: "oc_feishu" },
      },
    } as unknown as EnvEvent;
    await send(larkEvent);
    expect(calls).toHaveLength(1); // 只有企微那条
    expect(store.list()).toHaveLength(1);
  });
});

// ============================================================================
// B. 刷新帧：完整快照（原有信息一个不少）
// ============================================================================

const act = (): SubSessionActivity => ({
  subSessionId: SESSION_ID,
  messageCount: 88,
  updatedAt: NOW - 3 * MIN,
  lastMessage: { role: "assistant", content: "已定位到 delegate 的关联反查逻辑" },
});

describe("★ 刷新帧 buildWecomSessionUpdateFrame", () => {
  test("协议合规：cmd / req_id 透传 / template_card.task_id 原样回填", () => {
    const cardTaskId = wecomCardTaskIdForSession(SESSION_ID);
    const frame = buildWecomSessionUpdateFrame({
      reqId: "REQ-1",
      cardTaskId,
      sessionId: SESSION_ID,
      lifecycle: "timeout",
      now: NOW,
    });
    expect(frame.cmd).toBe("aibot_respond_update_msg");
    expect(frame.headers.req_id).toBe("REQ-1");
    const tc = (frame.body as any).template_card;
    expect(tc.task_id).toBe(cardTaskId); // 回调带回值原样回填（协议硬约束）
  });

  test("★ 生命周期文案：超时 ≠ 已完成（区分终态种类）", () => {
    const frame = buildWecomSessionUpdateFrame({
      reqId: "R",
      cardTaskId: "roy-session-x",
      sessionId: SESSION_ID,
      lifecycle: "timeout",
      now: NOW,
    });
    const body = JSON.stringify(frame.body);
    expect(body).toContain("已超时");
    expect(body).not.toContain("已完成");
  });

  test("★ 会话信息行不丢：sessionId / Agent / 已运行", () => {
    const frame = buildWecomSessionUpdateFrame({
      reqId: "R",
      cardTaskId: "roy-session-x",
      sessionId: SESSION_ID,
      lifecycle: "running",
      agentType: "roy",
      startedAt: new Date(NOW - 20 * MIN).toISOString(),
      now: NOW,
    });
    const rows = (frame.body as any).template_card.horizontal_content_list;
    const keys = rows.map((r: any) => r.keyname);
    expect(keys).toContain("会话");
    expect(keys).toContain("Agent");
    expect(keys).toContain("已运行");
    expect(keys).toContain("状态");
  });

  test("★ 操作记录（milestones）渲染进卡片（最新在顶部）", () => {
    const frame = buildWecomSessionUpdateFrame({
      reqId: "R",
      cardTaskId: "roy-session-x",
      sessionId: SESSION_ID,
      lifecycle: "completed",
      milestones: [
        { title: "子会话启动", timestamp: new Date(NOW - 20 * MIN).toISOString() },
        { title: "子会话完成", timestamp: new Date(NOW).toISOString() },
      ],
      now: NOW,
    });
    const rows = (frame.body as any).template_card.horizontal_content_list;
    const values = rows.map((r: any) => `${r.keyname}:${r.value}`).join("|");
    expect(values).toContain("启动");
    expect(values).toContain("完成");
    // 最新在顶部
    expect(values.indexOf("完成")).toBeLessThan(values.indexOf("启动"));
  });

  test("★ 活性（消息数 + 最近消息）渲染", () => {
    const frame = buildWecomSessionUpdateFrame({
      reqId: "R",
      cardTaskId: "roy-session-x",
      sessionId: SESSION_ID,
      lifecycle: "running",
      activity: act(),
      now: NOW,
    });
    const body = JSON.stringify(frame.body);
    expect(body).toContain("88");
    expect(body).toContain("delegate");
  });

  test("★ 刷新后按钮仍可再刷（可重复点）", () => {
    const frame = buildWecomSessionUpdateFrame({
      reqId: "R",
      cardTaskId: "roy-session-x",
      sessionId: SESSION_ID,
      lifecycle: "running",
      now: NOW,
    });
    const keys = (frame.body as any).template_card.button_list.map(
      (b: any) => b.key,
    );
    expect(keys).toContain(WecomCardActionKey.REFRESH_ACTIVITY);
  });

  test("★ 有 task 增强 → 任务行出现（信息不丢）", () => {
    const frame = buildWecomSessionUpdateFrame({
      reqId: "R",
      cardTaskId: "roy-session-x",
      sessionId: SESSION_ID,
      lifecycle: "running",
      task: { id: 5364, title: "企微单卡改造", status: "active", progress: 60 },
      now: NOW,
    });
    const rows = (frame.body as any).template_card.horizontal_content_list;
    const values = rows.map((r: any) => `${r.keyname}:${r.value}`).join("|");
    expect(values).toContain("5364");
  });

  test("协议预算：horizontal_content_list ≤ 6 行（企微硬限制）", () => {
    const frame = buildWecomSessionUpdateFrame({
      reqId: "R",
      cardTaskId: "roy-session-x",
      sessionId: SESSION_ID,
      lifecycle: "running",
      agentType: "roy",
      startedAt: new Date(NOW - 20 * MIN).toISOString(),
      task: { id: 5364, title: "企微单卡改造", status: "active" },
      milestones: Array.from({ length: 10 }, (_, i) => ({
        title: `里程碑 ${i}`,
        timestamp: new Date(NOW - i * MIN).toISOString(),
      })),
      now: NOW,
    });
    expect(
      (frame.body as any).template_card.horizontal_content_list.length,
    ).toBeLessThanOrEqual(6);
  });

  test("req_id 缺失 → 抛错（协议要求，不能静默）", () => {
    expect(() =>
      buildWecomSessionUpdateFrame({
        reqId: "",
        cardTaskId: "roy-session-x",
        sessionId: SESSION_ID,
        lifecycle: "running",
        now: NOW,
      }),
    ).toThrow(/req_id/);
  });
});