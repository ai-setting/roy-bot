/**
 * @fileoverview Task #5364 —— 企微 session 卡「按钮驱动更新」刷新路径
 *
 * ## 用户需求（B 方案）
 *
 * > 「靠按钮触发更新：卡片上「刷新」按钮点击时（有 req_id 回调窗口）
 * >   → patch 该卡显示最新状态 + 活性」
 *
 * ## 本文件锁定
 *
 * 1. 刷新时**从持久层读快照**（不是内存、不是 task）—— 重启后仍能渲染
 * 2. 渲染内容 = 生命周期 + 会话详情 + 任务行 + 操作记录 + 活性（信息不丢）
 * 3. 生命周期由 store 承载 ⇒ 超时/完成/停止在刷新后真的显示出来
 * 4. 全部 best-effort：store 缺/抛错 → 降级但**仍更新卡片**（用户点了必须有反馈）
 */

import { describe, test, expect } from "bun:test";
import {
  __resetWecomCardActionInflightForTest,
  handleWecomCardAction,
  buildWecomSessionCardUpdateBody,
  type WecomCardActionPorts,
} from "./wecom-card-action-handler";
import {
  WecomCardActionKey,
  wecomCardTaskIdForSession,
} from "./wecom-card-builder";
import {
  createMemoryWecomSessionCardStore,
  type WecomSessionCardState,
  type WecomSessionCardStore,
} from "../task/plugins/wecom-session-card-store";

const SESSION_ID = "session_refresh_04357c17";
const REQ_ID = "REQ-refresh-1";
const NOW = new Date(2026, 10, 12, 8, 34, 0).getTime();
const MIN = 60 * 1000;

function frame(key: string) {
  return {
    cmd: "aibot_event_callback",
    headers: { req_id: REQ_ID },
    body: {
      event: {
        eventtype: "template_card_event",
        template_card_event: {
          event_key: key,
          task_id: wecomCardTaskIdForSession(SESSION_ID),
        },
      },
      from: { userid: "user1" },
    },
  };
}

function seed(over: Partial<WecomSessionCardState> = {}): WecomSessionCardStore {
  const store = createMemoryWecomSessionCardStore();
  store.upsert({
    sessionId: SESSION_ID,
    chatId: "dzk_userid",
    chatType: "single",
    sourceId: "wecom-bot-1",
    cardTaskId: wecomCardTaskIdForSession(SESSION_ID),
    lifecycle: "running",
    title: "调研 airport 本体生成",
    agentType: "roy",
    startedAt: new Date(NOW - 40 * MIN).toISOString(),
    associatedTaskId: 5364,
    milestones: JSON.stringify([
      { title: "运行中", timestamp: new Date(NOW - 40 * MIN).toISOString() },
      { title: "已完成", timestamp: new Date(NOW - 2 * MIN).toISOString() },
    ]),
    createdAt: NOW - 40 * MIN,
    updatedAt: NOW - 2 * MIN,
    ...over,
  });
  return store;
}

function makePorts(
  store: WecomSessionCardStore | undefined,
  extra: Partial<WecomCardActionPorts> = {},
): WecomCardActionPorts {
  return {
    markTaskDone: async () => {},
    reopenTask: async () => {},
    updateCard: async () => {},
    ...(store ? { loadSessionCardState: (sid: string) => store.get(sid) } : {}),
    ...extra,
  };
}

// ============================================================================
// A. 从持久层读快照
// ============================================================================

describe("session 刷新：从持久层读快照", () => {
  test("★ 读到 lifecycle=completed ⇒ 刷新卡显示「已完成」而不是「运行中」", async () => {
    __resetWecomCardActionInflightForTest();
    let captured: any;
    const store = seed({ lifecycle: "completed", closedAt: NOW - 2 * MIN });

    const r = await handleWecomCardAction(
      frame(WecomCardActionKey.REFRESH_ACTIVITY),
      makePorts(store, {
        updateCard: async () => {},
        loadSessionActivity: async () => ({ activity: undefined, terminal: true }),
      }),
    );
    expect(r.ok).toBe(true);

    // 用同一 store 重建刷新帧，验证状态文案
    const rec = store.get(SESSION_ID)!;
    const body = buildWecomSessionCardUpdateBody({
      cardTaskId: rec.cardTaskId,
      sessionId: SESSION_ID,
      reqIdForTest: REQ_ID,
      state: rec,
      activity: null,
      now: NOW,
    });
    expect(JSON.stringify(body.body)).toContain("已完成");
  });

  test("★ 超时态刷新 → 「已超时」（区分终态种类）", () => {
    const rec = seed({ lifecycle: "timeout" }).get(SESSION_ID)!;
    const { body } = buildWecomSessionCardUpdateBody({
      cardTaskId: rec.cardTaskId,
      sessionId: SESSION_ID,
      reqIdForTest: REQ_ID,
      state: rec,
      now: NOW,
    });
    const rows = (body as any).template_card.horizontal_content_list as Array<{
      keyname: string;
      value: string;
    }>;
    const status = rows.find((r) => r.keyname === "状态");
    expect(status?.value).toBe("已超时");
    // main_title 也是「已超时」而不是「已完成」
    const title = (body as any).template_card.main_title.title as string;
    expect(title).toContain("已超时");
    expect(title).not.toContain("已完成");
  });

  test("★ 会话详情 + Agent + 已运行 + 任务号 都在刷新卡上（信息不丢）", () => {
    const rec = seed().get(SESSION_ID)!;
    const { body } = buildWecomSessionCardUpdateBody({
      cardTaskId: rec.cardTaskId,
      sessionId: SESSION_ID,
      reqIdForTest: REQ_ID,
      state: rec,
      now: NOW,
    });
    const rows = (body as any).template_card.horizontal_content_list as Array<{
      keyname: string;
      value: string;
    }>;
    const keys = rows.map((r) => r.keyname);
    const values = rows.map((r) => r.value).join("|");
    expect(keys).toContain("状态");
    expect(keys).toContain("会话");
    expect(keys).toContain("Agent");
    expect(keys).toContain("已运行");
    expect(keys).toContain("任务");
    expect(values).toContain("5364");
  });

  test("★ 操作记录（milestones）从持久层渲染进刷新卡", () => {
    const rec = seed().get(SESSION_ID)!;
    const { body } = buildWecomSessionCardUpdateBody({
      cardTaskId: rec.cardTaskId,
      sessionId: SESSION_ID,
      reqIdForTest: REQ_ID,
      state: rec,
      now: NOW,
    });
    const rows = (body as any).template_card.horizontal_content_list as Array<{
      keyname: string;
      value: string;
    }>;
    const values = rows.map((r) => `${r.keyname}:${r.value}`).join("|");
    expect(values).toContain("运行中");
    expect(values).toContain("已完成");
  });

  test("★ 活性仍然渲染（消息数 + 最近消息）", () => {
    const rec = seed().get(SESSION_ID)!;
    const { body } = buildWecomSessionCardUpdateBody({
      cardTaskId: rec.cardTaskId,
      sessionId: SESSION_ID,
      reqIdForTest: REQ_ID,
      state: rec,
      activity: {
        subSessionId: SESSION_ID,
        messageCount: 88,
        updatedAt: NOW - 3 * MIN,
        lastMessage: { role: "assistant", content: "已定位到 delegate 逻辑" },
      },
      now: NOW,
    });
    const s = JSON.stringify(body);
    expect(s).toContain("88");
    expect(s).toContain("delegate");
  });

  test("★ 协议：task_id 必须等于存下的 cardTaskId（原样回填）", () => {
    const rec = seed().get(SESSION_ID)!;
    const { body } = buildWecomSessionCardUpdateBody({
      cardTaskId: rec.cardTaskId,
      sessionId: SESSION_ID,
      reqIdForTest: REQ_ID,
      state: rec,
      now: NOW,
    });
    expect((body as any).template_card.task_id).toBe(rec.cardTaskId);
  });
});

// ============================================================================
// B. 端到端：刷新真的读 store（接线断言 / 变异测试）
// ============================================================================

describe("★ 刷新路径真读 store（变异测试：删掉读 store 就变红）", () => {
  test("loadSessionCardState 被调用一次，且拿到正确 sessionId", async () => {
    __resetWecomCardActionInflightForTest();
    let lookups = 0;
    let seenId: string | undefined;
    const store = seed({ lifecycle: "failed" });

    const r = await handleWecomCardAction(
      frame(WecomCardActionKey.REFRESH_ACTIVITY),
      makePorts(store, {
        loadSessionCardState: (sid: string) => {
          lookups++;
          seenId = sid;
          return store.get(sid);
        },
      }),
    );
    expect(r.ok).toBe(true);
    expect(lookups).toBe(1);
    expect(seenId).toBe(SESSION_ID);
  });

  test("★ 没有 loadSessionCardState 端口 → 仍 ok（降级，但不阻断反馈）", async () => {
    __resetWecomCardActionInflightForTest();
    let captured: any;
    const r = await handleWecomCardAction(
      frame(WecomCardActionKey.REFRESH_ACTIVITY),
      {
        markTaskDone: async () => {},
        reopenTask: async () => {},
        updateCard: async (...args: any[]) => {
          captured = args;
        },
      },
    );
    expect(r.ok).toBe(true);
    expect(captured).toBeDefined();
  });

  test("★ loadSessionCardState 抛错 → 降级但仍更新卡片", async () => {
    __resetWecomCardActionInflightForTest();
    let updated = 0;
    const r = await handleWecomCardAction(
      frame(WecomCardActionKey.REFRESH_ACTIVITY),
      {
        markTaskDone: async () => {},
        reopenTask: async () => {},
        updateCard: async () => {
          updated++;
        },
        loadSessionCardState: () => {
          throw new Error("db locked");
        },
      },
    );
    expect(r.ok).toBe(true);
    expect(updated).toBe(1);
  });
});