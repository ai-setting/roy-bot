/**
 * @fileoverview Task #5420 — 卡片「🔄 刷新活性」→「💬 会话查看」：
 * 点击展开最近 5 条消息（名称=role + reason=内容截断）
 *
 * 用户拍板（2026-11-13 06:44）：「A 五条吧，但是只展示名称和 reason」
 *
 * 方案（/tmp/session-view-plan.md，并行 agent 定稿，本文件按其实现）：
 * A. 按钮文案改「💬 会话查看」，action 名 refresh_activity 不动（存量卡兼容）
 * B. 新纯函数 formatRecentMessageLines（sub-session-activity.ts）：
 *    5 条 / 不足 5 条（实际条数）/ 0 条（暂无消息）/ role 映射 / 100 字截断
 * C. buildSessionCard 新增 recentMessages 入参 → 「💬 最近消息」面板
 * D. handler 新端口 loadSessionMessages → 注入面板；未注入/抛错 → 不渲染（降级不抛）
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  buildSessionCard,
  buildTaskCard,
  LarkCardPatchNotifier,
} from "./lark-card-patch-notifier";
import {
  handleCardAction,
  __resetCardActionInflightForTest,
} from "./lark-card-action-handler";
import {
  formatRecentToolCallLines,
  type ToolCallView,
} from "./sub-session-activity";

const SESSION_ID = "session_5420_view";
const MESSAGE_ID = "om_5420_card";

function call(toolName: string, reason?: string): ToolCallView {
  return { toolName, ...(reason ? { reason } : {}) };
}

function flat(card: unknown): string {
  return JSON.stringify(card);
}

function panel(card: any, id: string): any {
  return (card?.body?.elements ?? []).find((e: any) => e?.element_id === id);
}

beforeEach(() => {
  __resetCardActionInflightForTest();
});

// ============================================================================
// A. 纯函数 formatRecentToolCallLines（★ 返工：工具名 + reason）
// ============================================================================

describe("formatRecentToolCallLines — 5 条工具调用列表（★ 返工：标题去重）", () => {
  test("★ 5 条 → 全部渲染（每行一条，无重复标题行）", () => {
    const lines = formatRecentToolCallLines([
      call("bash", "第一条"),
      call("read_file", "第二条"),
      call("grep", "第三条"),
      call("edit_file", "第四条"),
      call("bash", "第五条"),
    ]);
    expect(lines).toHaveLength(5); // ★ 返工：无标题行，5 条 = 5 行
    const all = lines.join("\n");
    expect(all).toContain("第一条");
    expect(all).toContain("第五条");
    // 标题不重复（面板 title 一处）
    expect(all).not.toContain("最近工具调用");
  });

  test("★ 不足 5 条 → 渲染实际条数（无标题行）", () => {
    const lines = formatRecentToolCallLines([call("bash", "a"), call("grep", "b")]);
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).toContain("a");
    expect(lines.join("\n")).toContain("b");
  });

  test("★ 0 条 → 诚实显示「暂无工具调用」", () => {
    const lines = formatRecentToolCallLines([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("暂无工具调用");
    expect(lines[0]).not.toContain("🔧");
  });

  test("★ 无 reason 的旧调用 → 显示「—」（不猜）", () => {
    const lines = formatRecentToolCallLines([call("bash")]);
    const all = lines.join("\n");
    expect(all).toContain("bash");
    expect(all).toContain("—");
  });

  test("★ 超长 reason 截断（>100 字 → 截断 + 省略号）", () => {
    const long = "很".repeat(300);
    const lines = formatRecentToolCallLines([call("bash", long)]);
    const body = lines[0];
    expect(body).toContain("…");
    expect(body.length).toBeLessThanOrEqual(120);
    expect(body).not.toBe(long);
  });

  test("★ 多行 reason 压成单行（卡片 bullet 不能有裸换行）", () => {
    const lines = formatRecentToolCallLines([call("bash", "第一行\n第二行")]);
    expect(lines[0]).not.toMatch(/\n/);
    expect(lines[0]).toContain("第一行");
    expect(lines[0]).toContain("第二行");
  });
});

// B. 按钮文案：💬 会话查看（action 名不动）
// ============================================================================

describe("按钮文案「💬 会话查看」（Task #5420）", () => {
  test("★ buildSessionCard 刷新按钮文案 = 💬 会话查看，action 仍 refresh_activity", () => {
    const card: any = buildSessionCard({ sessionId: SESSION_ID });
    const btn = card.body.elements.find(
      (e: any) => e.tag === "button" && e.value?.action === "refresh_activity",
    );
    expect(btn).toBeDefined();
    expect(btn.text.content).toBe("💬 会话查看");
    expect(btn.value.sessionId).toBe(SESSION_ID);
  });

  test("★ buildTaskCard 刷新按钮文案 = 💬 会话查看，action 仍 refresh_activity", () => {
    const card: any = buildTaskCard({
      status: "running",
      meta: { id: 5420, title: "t" },
    });
    const btn = card.body.elements.find(
      (e: any) => e.tag === "button" && e.value?.action === "refresh_activity",
    );
    expect(btn).toBeDefined();
    expect(btn.text.content).toBe("💬 会话查看");
    expect(btn.value.taskId).toBe("5420");
  });

  test("★ 旧文案「刷新活性」不再出现在任何新卡上", () => {
    const s = flat(buildSessionCard({ sessionId: SESSION_ID }));
    const t = flat(
      buildTaskCard({ status: "running", meta: { id: 1, title: "x" } }),
    );
    expect(s).not.toContain("刷新活性");
    expect(t).not.toContain("刷新活性");
  });
});

// ============================================================================
// C. buildSessionCard 渲染最近消息面板
// ============================================================================

describe("buildSessionCard — 🔧 最近工具调用面板", () => {
  test("★ 传 recentMessages → 面板渲染 5 条（工具名+reason）", () => {
    const card = buildSessionCard({
      sessionId: SESSION_ID,
      recentMessages: [
        call("bash", "帮我查一下状态"),
        call("read_file", "已查完，结果是好的"),
        call("grep", "继续第三步"),
        call("edit_file", "第三步完成"),
        call("bash", "收尾吧"),
      ],
    });
    const p = panel(card, "session_recent_messages");
    expect(p).toBeDefined();
    const t = flat(p);
    expect(t).toContain("帮我查一下状态");
    expect(t).toContain("收尾吧");
    expect(t).toContain("bash");
    expect(t).toContain("read_file");
    // 标题只出现一次（修双写）
    expect(t.split("最近工具调用").length - 1).toBe(1);
  });

  test("★ 不传 recentMessages → 不渲染面板（首卡零噪音）", () => {
    const card = buildSessionCard({ sessionId: SESSION_ID });
    expect(panel(card, "session_recent_messages")).toBeUndefined();
  });

  test("★ 空数组 → 面板照出 + 暂无工具调用（诚实显示）", () => {
    const card = buildSessionCard({
      sessionId: SESSION_ID,
      recentMessages: [],
    });
    const p = panel(card, "session_recent_messages");
    expect(p).toBeDefined();
    expect(flat(p)).toContain("暂无工具调用");
  });

  test("★ 不足 5 条 → 面板显示实际条数（标题去重后只显示行）", () => {
    const card = buildSessionCard({
      sessionId: SESSION_ID,
      recentMessages: [call("bash", "only one")],
    });
    const t = flat(panel(card, "session_recent_messages"));
    // ★ 返工：标题去重后列表不含「N 条」计数行，只渲染消息行
    expect(t).toContain("only one");
    expect(t).toContain("bash");
    expect(t.split("最近工具调用").length - 1).toBe(1);
  });
});

// ============================================================================
// D. handler：loadSessionMessages 端口 → 面板注入；降级不抛
// ============================================================================

describe("handleCardAction — 会话查看注入最近 5 条消息", () => {
  function baseEvent() {
    return {
      actionValue: { action: "refresh_activity", sessionId: SESSION_ID } as any,
      chatId: "oc_x",
      messageId: MESSAGE_ID,
      token: "tok",
    };
  }

  test("★ 端口注入 → 返回卡片含最近消息面板（5 条）", async () => {
    const r = await handleCardAction(
      baseEvent(),
      {
        getTask: async () => undefined,
        notifier: new LarkCardPatchNotifier(),
        loadSessionActivity: async () => ({
          activity: {
            subSessionId: SESSION_ID,
            messageCount: 42,
            updatedAt: Date.now() - 60_000,
          },
          terminal: false,
        }),
        loadSessionMessages: async () => [
          call("bash", "m1"),
          call("read_file", "m2"),
          call("grep", "m3"),
          call("edit_file", "m4"),
          call("bash", "m5"),
        ],
      },
    );
    expect(r.ok).toBe(true);
    const t = flat(r.cardUpdate);
    expect(t).toContain("m1");
    expect(t).toContain("m5");
    expect(t).toContain("消息数 42 条");
  });

  test("★ 端口未注入 → 无面板但卡片照出（降级，不报错）", async () => {
    const r = await handleCardAction(
      baseEvent(),
      {
        getTask: async () => undefined,
        notifier: new LarkCardPatchNotifier(),
        loadSessionActivity: async () => ({
          activity: {
            subSessionId: SESSION_ID,
            messageCount: 1,
            updatedAt: Date.now(),
          },
          terminal: false,
        }),
      },
    );
    expect(r.ok).toBe(true);
    expect(panel(r.cardUpdate, "session_recent_messages")).toBeUndefined();
  });

  test("★ 端口抛错 → 降级不抛（卡片仍渲染活性）", async () => {
    const r = await handleCardAction(
      baseEvent(),
      {
        getTask: async () => undefined,
        notifier: new LarkCardPatchNotifier(),
        loadSessionActivity: async () => ({
          activity: {
            subSessionId: SESSION_ID,
            messageCount: 1,
            updatedAt: Date.now(),
          },
          terminal: false,
        }),
        loadSessionMessages: () => {
          throw new Error("store down");
        },
      },
    );
    expect(r.ok).toBe(true);
    expect(panel(r.cardUpdate, "session_recent_messages")).toBeUndefined();
    expect(flat(r.cardUpdate)).toContain("消息数 1 条");
  });

  test("★ 端口返回空数组 → 面板显示暂无消息（诚实）", async () => {
    const r = await handleCardAction(
      baseEvent(),
      {
        getTask: async () => undefined,
        notifier: new LarkCardPatchNotifier(),
        loadSessionActivity: async () => ({
          activity: {
            subSessionId: SESSION_ID,
            messageCount: 0,
            updatedAt: Date.now(),
          },
          terminal: false,
        }),
        loadSessionMessages: async () => [],
      },
    );
    expect(r.ok).toBe(true);
    expect(flat(panel(r.cardUpdate, "session_recent_messages"))).toContain(
      "暂无工具调用",
    );
  });
});
