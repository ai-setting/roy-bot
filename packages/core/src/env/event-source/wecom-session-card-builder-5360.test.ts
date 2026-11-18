/**
 * @fileoverview Task #5360 —— 企微 **session 卡** 构建器（用户明令「企微也是这个逻辑」）
 *
 * ## 需求（用户 22:32 / 22:37）
 *
 * 「以 sub-session 为基底」在两渠道都要成立：
 * - 卡片身份 = **sessionId 主键**（不是 task）
 * - 该 session 建了 task → 把 task 信息同步进卡片
 * - 无论有无 task：刷新活性（消息数 + 最近 msg）+ **生命周期（完成/超时/停止）体现在同卡**
 *
 * ## 本文件锁定
 *
 * A. 企微 session 卡的 `task_id` 用 `roy-session-<id>` 前缀 ⇒ 回调能反解回 session
 * B. **不渲染**建群/解散群（企微侧本来就没有）；只渲染「刷新活性」
 * C. 有 task → 多一行任务信息（不丢）
 * D. 生命周期 → 状态文案 + 终态标记
 * E. 活性三态（有数据 / 暂无 / 终态）
 * F. 协议合规：`task_id` 字符合法、按钮 ≤6、`card_action.type=0`
 */

import { describe, test, expect } from "bun:test";
import {
  ROY_SESSION_PREFIX,
  WecomCardActionKey,
  buildWecomSessionCard,
  wecomCardTaskIdForSession,
} from "./wecom-card-builder";
import type { SubSessionActivity } from "../task/plugins/sub-session-activity";

const NOW = new Date(2026, 10, 11, 22, 47, 12).getTime();
const MIN = 60 * 1000;
const SESSION_ID = "session_04357c17-9ff8-4e3d-a498-bc254da5caf9";

function act(over: Partial<SubSessionActivity> = {}): SubSessionActivity {
  return {
    subSessionId: SESSION_ID,
    messageCount: 88,
    updatedAt: NOW - 3 * MIN,
    lastMessage: { role: "assistant", content: "已定位到 delegate 的关联反查逻辑" },
    ...over,
  };
}

// ============================================================================
// A. 主键
// ============================================================================

describe("企微 session 卡的 task_id", () => {
  test("★ 用 roy-session- 前缀（回调可反解回 session 主键）", () => {
    const card = buildWecomSessionCard({
      sessionId: SESSION_ID,
      lifecycle: "running",
    });
    expect(card.task_id.startsWith(ROY_SESSION_PREFIX)).toBe(true);
    expect(card.task_id).toContain(SESSION_ID);
  });

  test("★ 有 task 时带 @task-<n> 附加值，但主键仍是 session", () => {
    const card = buildWecomSessionCard({
      sessionId: SESSION_ID,
      task: { id: 5360, title: "任务通知卡片化改造" },
      lifecycle: "running",
    });
    expect(card.task_id).toBe(wecomCardTaskIdForSession(SESSION_ID, 5360));
    expect(card.task_id.startsWith(ROY_SESSION_PREFIX)).toBe(true);
  });

  test("协议合规：字符集（数字字母 _-@）且 ≤128 字节", () => {
    const card = buildWecomSessionCard({ sessionId: SESSION_ID });
    expect(card.task_id).toMatch(/^[A-Za-z0-9_\-@]+$/);
    expect(new TextEncoder().encode(card.task_id).length).toBeLessThanOrEqual(128);
  });
});

// ============================================================================
// B. 按钮
// ============================================================================

describe("企微 session 卡的按钮", () => {
  test("★ 只有「刷新活性」，没有建群/解散群（企微无此概念）", () => {
    const card = buildWecomSessionCard({ sessionId: SESSION_ID, activity: act() });
    const keys = card.button_list.map((b) => b.key);
    expect(keys).toContain(WecomCardActionKey.REFRESH_ACTIVITY);
    expect(keys).not.toContain("create_group");
    expect(keys).not.toContain("disband_group");
  });

  test("★ 有 task 时也只加刷新活性（不塞建群按钮进企微卡）", () => {
    const card = buildWecomSessionCard({
      sessionId: SESSION_ID,
      task: { id: 5360, title: "t" },
      activity: act(),
    });
    const keys = card.button_list.map((b) => b.key);
    expect(keys).not.toContain("create_group");
    expect(keys.length).toBeLessThanOrEqual(6);
  });

  test("按钮文案可读（不是只有 key）", () => {
    const card = buildWecomSessionCard({ sessionId: SESSION_ID });
    expect(card.button_list[0].text).toContain("刷新活性");
  });
});

// ============================================================================
// C. task 增强（有则显示、无则不影响）
// ============================================================================

describe("企微 session 卡的 task 增强", () => {
  test("★ 有 task → 任务号/标题出现在卡上（信息不丢）", () => {
    const card = buildWecomSessionCard({
      sessionId: SESSION_ID,
      task: {
        id: 5360,
        title: "任务通知卡片化改造",
        status: "active",
        progress: 75,
      },
      lifecycle: "running",
    });
    const t = JSON.stringify(card);
    expect(t).toContain("5360");
    expect(t).toContain("任务通知卡片化改造");
  });

  test("★ 无 task → 不出现任务号占位（不渲染 undefined）", () => {
    const card = buildWecomSessionCard({ sessionId: SESSION_ID, lifecycle: "running" });
    const t = JSON.stringify(card);
    expect(t).not.toContain("undefined");
    expect(t).not.toContain("Task #undefined");
  });
});

// ============================================================================
// D. 生命周期（用户第 4 点：完成/超时/停止都要体现在卡上）
// ============================================================================

describe("企微 session 卡的生命周期", () => {
  test.each([
    ["running", "运行中"],
    ["completed", "已完成"],
    ["timeout", "已超时"],
    ["failed", "已失败"],
    ["stopped", "已停止"],
  ] as const)("★ %s → 文案含「%s」", (lifecycle, phrase) => {
    const card = buildWecomSessionCard({ sessionId: SESSION_ID, lifecycle });
    expect(JSON.stringify(card)).toContain(phrase);
  });

  test("★ 终态 → 活性显示「已结束」而非「疑似停滞」", () => {
    const card = buildWecomSessionCard({
      sessionId: SESSION_ID,
      lifecycle: "completed",
      activity: act({ updatedAt: NOW - 40 * MIN }),
      activityNow: NOW,
    });
    const t = JSON.stringify(card);
    expect(t).toContain("已结束");
    expect(t).not.toContain("疑似停滞");
  });

  test("★ 有 task 但 session 终态 → 仍按 session 生命周期显示（不显示运行中）", () => {
    const card = buildWecomSessionCard({
      sessionId: SESSION_ID,
      task: { id: 1, title: "t", status: "active" },
      lifecycle: "timeout",
    });
    expect(JSON.stringify(card)).toContain("已超时");
  });
});

// ============================================================================
// E. 活性三态
// ============================================================================

describe("企微 session 卡的活性", () => {
  test("★ 有活性 → 消息数 + 最近 msg 可见", () => {
    const card = buildWecomSessionCard({
      sessionId: SESSION_ID,
      activity: act(),
      activityNow: NOW,
    });
    const t = JSON.stringify(card);
    expect(t).toContain("消息数 88 条");
    expect(t).toContain("delegate 的关联反查");
  });

  test("★ activity=null → 暂无数据（点了要有反馈）", () => {
    const card = buildWecomSessionCard({ sessionId: SESSION_ID, activity: null });
    expect(JSON.stringify(card)).toContain("暂无数据");
  });

  test("不传 activity → 不渲染活性行（首卡零噪音）", () => {
    const card = buildWecomSessionCard({ sessionId: SESSION_ID, lifecycle: "running" });
    const t = JSON.stringify(card);
    expect(t).not.toContain("消息数");
  });

  test("★ 活跃 → 🟢（与飞书同一套阈值）", () => {
    const card = buildWecomSessionCard({
      sessionId: SESSION_ID,
      activity: act(),
      activityNow: NOW,
    });
    expect(JSON.stringify(card)).toContain("🟢");
  });
});

// ============================================================================
// F. 协议合规
// ============================================================================

describe("企微 session 卡协议合规", () => {
  test("card_action.type=0（不做整卡跳转，避免 42028 缺 url）", () => {
    const card = buildWecomSessionCard({ sessionId: SESSION_ID });
    expect(card.card_action?.type).toBe(0);
  });

  test("card_type=button_interaction（可点刷新）", () => {
    expect(buildWecomSessionCard({ sessionId: SESSION_ID }).card_type).toBe(
      "button_interaction",
    );
  });

  test("main_title 有标题（协议必填）", () => {
    const card = buildWecomSessionCard({ sessionId: SESSION_ID });
    expect(card.main_title.title.length).toBeGreaterThan(0);
  });

  test("超长 sessionId 不撑坏 main_title（截断）", () => {
    const card = buildWecomSessionCard({
      sessionId: `session_${"a".repeat(200)}`,
    });
    expect(card.main_title.title.length).toBeLessThanOrEqual(140);
  });
});