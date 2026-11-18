/**
 * @fileoverview Task #5602 —— 点任务卡「💬 会话查看」后 task 卡不得被改写成 session 卡
 *
 * ## 用户实测（Task #5591 系列续）
 *
 * 任务卡 → 点「💬 会话查看」→ 任务卡被改写成 session 卡
 * （「📋 任务卡实时更新」变成「💬 会话卡实时更新」）。
 *
 * ## 根因（file:line）
 *
 * `lark-card-action-handler.ts` `handleCardAction`：
 * 「💬 会话查看」按钮 action=refresh_activity（#5420 文案改名，
 * action 名不动）→ 直接走 `handleRefreshSessionCard`（session 主键
 * 路径）→ 内置实现 `handleRefreshSessionActivity`：
 *
 * - `preserved = notifier.buildSessionCardWithActivity(event.messageId, ...)`
 *   —— 它只查 `sessionStates`（session 卡索引）。**task 卡的
 *   messageId 在 `states` 里，不在 `sessionStates`** ⇒ 返回 undefined。
 * - `preserved` 为 undefined → 走 fallback：`buildSessionCard({...})`
 *   整卡重建 —— **session 卡渲染器覆盖 task 卡** ⇒ 用户实测的改写。
 *
 * task 卡上的「💬 会话查看」按钮 value 同时带 taskId + sessionId
 * （#5581 透传 + CV BLOCKER-1），语义应是「查看该 session 的最近
 * 消息」，但**渲染必须保持 task 卡身份**（task 卡的里程碑/进度/
 * 建群按钮一个不少），把最近消息作为 task 卡上的活性/消息面板
 * 呈现 —— 而不是把整卡换成 session 卡。
 *
 * ## 本文件断言的不变式
 *
 * 1. task 卡（`startTask` 发出）上点「💬 会话查看」→ 返回的
 *    cardUpdate header 仍是「📋 任务卡实时更新」（卡身份不变）。
 * 2. task 卡上的建群按钮 / 会话查看按钮不消失。
 * 3. session 卡上点「💬 会话查看」→ 仍是 session 卡（既有行为不回归）。
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  LarkCardPatchNotifier,
  buildSessionCard,
} from "./lark-card-patch-notifier";
import {
  handleCardAction,
  __resetCardActionInflightForTest,
  type CardActionPorts,
} from "./lark-card-action-handler";

const CHAT = "oc_5602_chat";
const SESSION = "session_5602";
const TASK_ID = 5602;

beforeEach(() => {
  __resetCardActionInflightForTest();
});

/** 拦截 lark-cli 的 notifier（send 返回可控 messageId） */
function makeNotifier(): LarkCardPatchNotifier {
  const notifier = new LarkCardPatchNotifier({ sessionCardStore: null });
  notifier.testRunner = async (_argv, op) => {
    if (op === "send") {
      return JSON.stringify({ data: { message_id: "om_new_5602" } });
    }
    return JSON.stringify({ data: {} });
  };
  (notifier as any).pinMessage = async () => {};
  return notifier;
}

function headerTitle(card: any): string {
  return card?.header?.title?.content ?? "";
}

function buttonTexts(card: any): string[] {
  const out: string[] = [];
  const walk = (els: any[]): void => {
    for (const e of els ?? []) {
      if (e?.tag === "button") out.push(e?.text?.content ?? "");
      else if (Array.isArray(e?.elements)) walk(e.elements);
      else if (Array.isArray(e?.columns)) {
        for (const c of e.columns) walk(c.elements ?? []);
      }
    }
  };
  walk(card?.body?.elements ?? []);
  return out;
}

/** 造一张 task 卡（生产形状：hook 的 onAfterCreate 走 startTask） */
async function startTaskCard(
  notifier: LarkCardPatchNotifier,
): Promise<string> {
  const res = await notifier.startTask({
    chatId: CHAT,
    meta: {
      id: TASK_ID,
      title: "点会话查看不改写任务卡",
      priority: "high",
      sessionId: SESSION,
    },
  });
  return res.messageId;
}

function makePorts(
  notifier: LarkCardPatchNotifier,
  overrides: Partial<CardActionPorts> = {},
): CardActionPorts {
  return {
    getTask: async () => ({
      id: TASK_ID,
      title: "点会话查看不改写任务卡",
      description: "desc",
      goals: "g",
      priority: "high",
      type: "normal",
      project_path: "/tmp",
      parent_task_id: null,
      current_status: "进行中",
      context: "{}",
      session_id: SESSION,
    }),
    updateTaskContext: async () => {},
    notifier,
    loadSessionActivity: async () => ({
      activity: {
        subSessionId: SESSION,
        messageCount: 7,
        updatedAt: Date.now(),
      },
      terminal: false,
    }),
    loadSessionMessages: async () => [
      { toolName: "bash", reason: "查看状态" },
    ],
    ...overrides,
  } as CardActionPorts;
}

function refreshEvent(taskCardMessageId: string): any {
  return {
    actionValue: {
      action: "refresh_activity",
      taskId: String(TASK_ID),
      sessionId: SESSION,
    },
    chatId: CHAT,
    messageId: taskCardMessageId,
    token: "tok_5602",
  };
}

// ===========================================================================
// 核心回归：task 卡上点「💬 会话查看」→ 卡身份不变
// ===========================================================================

describe("Task #5602：task 卡上点「💬 会话查看」不得被改写成 session 卡", () => {
  it("★ task 卡点会话查看 → header 仍是「📋 任务卡实时更新」", async () => {
    const notifier = makeNotifier();
    const taskCardId = await startTaskCard(notifier);

    const r = await handleCardAction(
      refreshEvent(taskCardId),
      makePorts(notifier),
    );
    expect(r.ok).toBe(true);
    expect(r.cardUpdate).toBeDefined();
    // ★ 核心断言：卡身份没变 —— 不能被 buildSessionCard 整卡覆盖
    expect(headerTitle(r.cardUpdate)).toContain("📋 任务卡实时更新");
    expect(headerTitle(r.cardUpdate)).not.toContain("💬 会话卡实时更新");
  });

  it("★ task 卡点会话查看 → 建群按钮 + 会话查看按钮仍在", async () => {
    const notifier = makeNotifier();
    const taskCardId = await startTaskCard(notifier);

    const r = await handleCardAction(
      refreshEvent(taskCardId),
      makePorts(notifier),
    );
    expect(r.ok).toBe(true);
    const btns = buttonTexts(r.cardUpdate);
    expect(btns.some((t) => t === "为这个任务建群" || t === "解散该群")).toBe(
      true,
    );
    expect(btns).toContain("💬 会话查看");
  });

  it("★ task 卡点会话查看 → 里程碑历史保留（信息不丢）", async () => {
    const notifier = makeNotifier();
    const taskCardId = await startTaskCard(notifier);
    await notifier.updateTask({
      messageId: taskCardId,
      status: "running",
      progress: 40,
      milestones: [
        { title: "里程碑A：根因已锁定", timestamp: new Date().toISOString() },
      ],
    });

    const r = await handleCardAction(
      refreshEvent(taskCardId),
      makePorts(notifier),
    );
    expect(r.ok).toBe(true);
    const all = JSON.stringify(r.cardUpdate);
    expect(all).toContain("里程碑A：根因已锁定");
    // 进度也保留
    expect(all).toContain("40");
  });
});

// ===========================================================================
// 既有行为不回归：session 卡上点「💬 会话查看」仍是 session 卡
// ===========================================================================

describe("Task #5602：session 卡上点「💬 会话查看」行为不变", () => {
  it("★ session 卡点会话查看 → header 仍是「💬 会话卡实时更新」", async () => {
    const notifier = makeNotifier();
    const res = await notifier.startSessionCard({
      chatId: CHAT,
      sessionId: SESSION,
      title: "纯会话卡",
      lifecycle: "running",
    });

    const r = await handleCardAction(
      refreshEvent(res.messageId),
      makePorts(notifier),
    );
    expect(r.ok).toBe(true);
    expect(headerTitle(r.cardUpdate)).toContain("💬 会话卡实时更新");
    expect(headerTitle(r.cardUpdate)).not.toContain("📋 任务卡实时更新");
  });

  it("★ 无状态的 messageId（重启未回灌）→ fallback 重建 session 卡（既有降级）", async () => {
    const notifier = makeNotifier();
    // 不发卡，直接用一个未知 messageId 点刷新
    const r = await handleCardAction(
      refreshEvent("om_unknown_5602"),
      makePorts(notifier),
    );
    expect(r.ok).toBe(true);
    // fallback 语义：按 session 重建（session 卡）
    expect(headerTitle(r.cardUpdate)).toContain("💬 会话卡实时更新");
  });
});

// buildSessionCard 仍被 session 路径使用（import 保持有效）
void buildSessionCard;
