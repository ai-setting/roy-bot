/**
 * @fileoverview Task #5608 —— 插件 daemon 场景：notifier 无 task 卡状态时
 * 「💬 会话查看」不得把 task 卡改写成 session 卡
 *
 * ## 用户实测复发（2026-11-15，roy-task 0.7.19 + core 1.7.94）
 *
 * gonglin daemon 日志（21:14，task #5490）：
 * ```
 * handleCardAction: 旧 task 卡 #5490 无 sessionId，反查得到 session_285f…（按 session 主键刷新）
 * handleRefreshSessionActivity: notifier 无 messageId=om_x100b60aeb… 的状态，fallback 重建 session 卡
 * ```
 *
 * ## 根因（file:line）
 *
 * #5602 的 task 卡归属守卫（handleRefreshSessionActivity 第 0 步）：
 *
 * ```
 * ports.notifier?.isTaskCardMessage?.(event.messageId) &&
 * !ports.notifier?.isSessionCardMessage?.(event.messageId)
 * ```
 *
 * `isTaskCardMessage` 只查 notifier **内存**（`states` + `finalisedCards`）。
 * 插件 daemon（roy-task）的 card-action 链路里 notifier 是**全新实例**
 * （`createCardPort` 的 `loadNotifier` 每次 serve 进程只 new 一次，
 * 且从不 hydrate task 卡状态 —— 只有 finish 时才 hydrate timeline），
 * task 卡从未进 `states` ⇒ 守卫恒 false ⇒ fallback `buildSessionCard`
 * 整卡重建 ⇒ task 卡被 session 卡覆盖（用户实测复发）。
 *
 * ## 修法（本文件断言）
 *
 * 守卫加**持久层兜底**：内存判定为 false 时，再查
 * `getSharedLarkCardStateStore().get(taskId)` —— 有记录（无论 open/closed）
 * 且 messageId 与被点的卡一致 ⇒ 这张卡就是 task 卡 ⇒ 委托 task 路径。
 *
 * 持久层 `lark_card` 表由 core hook 与插件 ledger 双方写入
 * （gonglin 实证：task 5490 行带 session_id，messageId 与被点卡一致），
 * 是跨进程、跨重启的权威「这张卡曾是 task 卡」记录。
 *
 * ## 不变式
 *
 * 1. notifier 无状态 + 持久层有记录 → 委托 task 路径（本次修复）。
 * 2. notifier 无状态 + 持久层无记录 → 既有 fallback（session 重建，#5602 语义）。
 * 3. session 卡（sessionStates 命中）→ 仍走 session 渲染（不回归）。
 * 4. 内存状态命中（#5602 原场景）→ 行为不变。
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { LarkCardPatchNotifier } from "./lark-card-patch-notifier";
import {
  handleCardAction,
  __resetCardActionInflightForTest,
  type CardActionPorts,
} from "./lark-card-action-handler";
import {
  SqliteLarkCardStateStore,
  __resetSharedLarkCardStateStoreForTest,
} from "./lark-card-state-store";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHAT = "oc_5608_chat";
const SESSION = "session_5608";
const TASK_ID = 5608;

beforeEach(() => {
  __resetCardActionInflightForTest();
  __resetSharedLarkCardStateStoreForTest();
});

function makeNotifier(): LarkCardPatchNotifier {
  const notifier = new LarkCardPatchNotifier({ sessionCardStore: null });
  notifier.testRunner = async (_argv, op) => {
    if (op === "send") {
      return JSON.stringify({ data: { message_id: "om_new_5608" } });
    }
    return JSON.stringify({ data: {} });
  };
  (notifier as any).pinMessage = async () => {};
  return notifier;
}

function headerTitle(card: any): string {
  return card?.header?.title?.content ?? "";
}

/** 造一张 task 卡（fresh notifier，不进 states —— 模拟插件 daemon） */
async function startTaskCardFresh(
  notifier: LarkCardPatchNotifier,
): Promise<string> {
  const res = await notifier.startTask({
    chatId: CHAT,
    meta: {
      id: TASK_ID,
      title: "5608 守卫持久层兜底",
      priority: "high",
      sessionId: SESSION,
    },
  });
  // 模拟插件 daemon：发完卡立刻丢掉内存态（重启 / 新实例）
  (notifier as any).states.delete(res.messageId);
  (notifier as any).finalisedCards.delete(res.messageId);
  return res.messageId;
}

function makePorts(
  notifier: LarkCardPatchNotifier,
  overrides: Partial<CardActionPorts> = {},
): CardActionPorts {
  return {
    getTask: async () => ({
      id: TASK_ID,
      title: "5608 守卫持久层兜底",
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
      activity: { subSessionId: SESSION, messageCount: 3, updatedAt: Date.now() },
      terminal: false,
    }),
    loadSessionMessages: async () => [],
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
    token: "tok_5608",
  };
}

describe("Task #5608：notifier 无状态时守卫走持久层兜底", () => {
  it("★ 持久层有 task 卡记录 → 委托 task 路径（header 仍是任务卡）", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "roy-5608-"));
    try {
      const store = new SqliteLarkCardStateStore(join(dbDir, "cards.db"));
      // 把共享单例替换为测试库（守卫内部读 getSharedLarkCardStateStore）
      const mod = await import("./lark-card-state-store");
      (mod as any).__setSharedLarkCardStateStoreForTest?.(store);

      const notifier = makeNotifier();
      const taskCardId = await startTaskCardFresh(notifier);
      // 持久层登记：插件 ledger / core hook 都会写这一行
      store.upsert({
        taskId: TASK_ID,
        messageId: taskCardId,
        chatId: CHAT,
        profile: "gonglin",
        pinned: true,
        status: "open",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const r = await handleCardAction(refreshEvent(taskCardId), makePorts(notifier));
      expect(r.ok).toBe(true);
      expect(r.cardUpdate).toBeDefined();
      expect(headerTitle(r.cardUpdate)).toContain("📋 任务卡实时更新");
      expect(headerTitle(r.cardUpdate)).not.toContain("💬 会话卡实时更新");
    } finally {
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it("★ 持久层无记录 → 既有 fallback（session 重建，不回归 #5602）", async () => {
    const notifier = makeNotifier();
    const taskCardId = await startTaskCardFresh(notifier);

    const r = await handleCardAction(refreshEvent(taskCardId), makePorts(notifier));
    expect(r.ok).toBe(true);
    expect(headerTitle(r.cardUpdate)).toContain("💬 会话卡实时更新");
  });

  it("★ 持久层记录的 messageId 不匹配 → 不算 task 卡（走 session fallback）", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "roy-5608-"));
    try {
      const store = new SqliteLarkCardStateStore(join(dbDir, "cards.db"));
      const mod = await import("./lark-card-state-store");
      (mod as any).__setSharedLarkCardStateStoreForTest?.(store);
      store.upsert({
        taskId: TASK_ID,
        messageId: "om_other_card",
        chatId: CHAT,
        pinned: false,
        status: "open",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const notifier = makeNotifier();
      const taskCardId = await startTaskCardFresh(notifier);

      const r = await handleCardAction(refreshEvent(taskCardId), makePorts(notifier));
      expect(r.ok).toBe(true);
      expect(headerTitle(r.cardUpdate)).toContain("💬 会话卡实时更新");
    } finally {
      rmSync(dbDir, { recursive: true, force: true });
    }
  });
});
