/**
 * @fileoverview Task #5597 —— 两卡并存模式下 task 卡不得被 session patch 覆盖
 *
 * ## 用户实测（gonglin ES，worktree ed84e43e）
 *
 * 一开始正确发出「📋 任务卡」，不一会儿变成「💬 会话卡」——
 * task 卡片消息被 session patch 覆盖了。
 *
 * ## 根因（file:line）
 *
 * `lark-cli-task-notify-plugin.ts` `restoreCardState()`：
 * 两卡并存（emitTaskCard=true，#5580 定稿）时 `lark_card` 表 task 记录的
 * `messageId` 是 **task 卡**的 id（`buildCardState` 落库带 sessionId），
 * 但 `adoptSessionCard(rec.sessionId, rec.messageId)` 把它灌进了
 * **session 卡索引** `sessionCardIds` ⇒ 后续 session patch
 * （refresh_activity / lifecycle）命中 task 卡 ⇒ task 卡被改写成 session 卡。
 *
 * 该逻辑是 #5364 单卡语义遗留：单卡时 task 卡 == session 卡所以无害；
 * #5580 两卡并存后 = patch 目标错位。
 *
 * ## 修复语义（本文件锁定）
 *
 * - 两卡模式（emitTaskCard=true）：`restoreCardState` **不得** adopt
 *   （session 卡索引由 notifier 构造回灌 `lark_session_card` 表负责，#5591）。
 * - 单卡模式（emitTaskCard=false，#5364 软回滚）：task 卡 == session 卡，
 *   adopt 行为**保留**（重启后 patch 命中同一张卡）。
 */

import { describe, it, expect, mock } from "bun:test";
import { LarkCliTaskNotifyHook } from "./lark-cli-task-notify-plugin";
import { LarkCardPatchNotifier } from "./lark-card-patch-notifier";
import {
  MemoryLarkCardStateStore,
  MemoryLarkSessionCardStore,
} from "./lark-card-state-store";
import { TaskHookPoints } from "../hooks/task-hook-points";
import type { HookContext } from "../../hook/types";
import type {
  TaskUpdateResultContext,
} from "../hooks/contexts";
import { runWithEnvContext, type EnvContext } from "../../context";

const TASK_ID = 5597;
const SESSION = "session_5597_two_cards";
const TASK_CARD_ID = "om_task_card_5597";

function makeTask(overrides: Partial<any> = {}): any {
  return {
    id: TASK_ID,
    title: "两卡恢复测试任务",
    description: "desc",
    status: "active",
    priority: "high",
    type: "normal",
    progress: 50,
    current_status: "进行中",
    createdAt: "2026-11-15T00:00:00Z",
    updatedAt: "2026-11-15T01:00:00Z",
    project_path: "/tmp/test",
    context: "{}",
    ...overrides,
  };
}

function makeEnvContext(): EnvContext {
  return {
    envEvent: { metadata: {} },
    sourceId: "es-test-5597",
    userId: "ou_test",
    replyChannel: { chatId: "oc_chat5597", messageId: "om_msg5597" },
    pluginEnabled: { "es-test-5597:LarkCliTaskNotifyHook": true },
  } as EnvContext;
}

function makeHookContext<T>(hookPoint: string, data: T): HookContext<T> {
  return {
    component: { name: "task", version: "1.0.0" },
    data,
    metadata: {},
    phase: "after",
    hookPoint,
  };
}

/** mock 掉发送路径，保留真实的索引方法（getSessionCardMessageId 等） */
function makeMockNotifier(sessionStore?: MemoryLarkSessionCardStore) {
  const notifier = new LarkCardPatchNotifier({
    sessionCardStore: sessionStore ?? null,
  });
  // ★ 测试注入点：替换 runLarkCli 执行器（避免真 spawn lark-cli）。
  //   send 返回需含 data.message_id（extractMessageId 解析）。
  notifier.testRunner = async (_argv, op) => {
    if (op === "send") {
      return JSON.stringify({ data: { message_id: "om_new_task_card" } });
    }
    return "{}";
  };
  (notifier as any).startTask = async () => ({
    messageId: "om_new_task_card",
    pinned: true,
  });
  (notifier as any).updateTask = async () => {};
  (notifier as any).finishTask = async () => {};
  (notifier as any).pauseTask = async () => {};
  return notifier;
}

/** 预置持久层：两卡并存下 task 记录 = task 卡 messageId + sessionId */
function seedStore(): MemoryLarkCardStateStore {
  const store = new MemoryLarkCardStateStore();
  store.upsert({
    taskId: TASK_ID,
    messageId: TASK_CARD_ID,
    chatId: "oc_chat5597",
    pinned: true,
    status: "open",
    sessionId: SESSION,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return store;
}

/**
 * 预置 session 卡持久层：单卡模式下 task 卡 == session 卡
 * （#5364 语义），session 卡索引应恢复到同一 messageId。
 */
function seedSessionStore(): MemoryLarkSessionCardStore {
  const store = new MemoryLarkSessionCardStore();
  store.upsert({
    sessionId: SESSION,
    messageId: TASK_CARD_ID,
    chatId: "oc_chat5597",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return store;
}

async function fireUpdate(hook: LarkCliTaskNotifyHook): Promise<void> {
  const ctx = makeHookContext(TaskHookPoints.AFTER_UPDATE, {
    task: makeTask({ progress: 80 }),
    changes: { progress: 80 },
  } as unknown as TaskUpdateResultContext);
  await runWithEnvContext(makeEnvContext(), async () => {
    await hook.execute(ctx);
  });
}

describe("Task #5597：restoreCardState 两卡/单卡语义分离", () => {
  it("两卡模式（emitTaskCard=true）：task 卡 messageId 不得灌进 session 卡索引", async () => {
    const store = seedStore();
    const notifier = makeMockNotifier();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
      emitTaskCard: true,
    });

    await fireUpdate(hook);

    // 核心断言：session 卡索引里**不是** task 卡的 messageId
    // （否则 session patch 会打到 task 卡上 = 用户实测的覆盖）。
    // 测试里 session 卡 store 为空 ⇒ upsertSessionCard 走 startSessionCard
    // 发新 session 卡（生产中由构造回灌命中已有 session 卡）——
    // 无论哪种路径，索引值都绝不能是 task 卡 id。
    expect(notifier.getSessionCardMessageId(SESSION)).not.toBe(TASK_CARD_ID);
  });

  it("两卡模式：task 卡 patch 仍命中 task 卡（cardMessageIds 不受影响）", async () => {
    const store = seedStore();
    const notifier = makeMockNotifier();
    const updateTask = mock(async () => {});
    (notifier as any).updateTask = updateTask;
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
      emitTaskCard: true,
    });

    await fireUpdate(hook);

    // task 卡更新仍 patch 原 task 卡（不重复发卡）
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect((updateTask as any).mock.calls[0][0].messageId).toBe(TASK_CARD_ID);
  });

  it("单卡模式（emitTaskCard=false）：保留 adopt 行为（重启后 patch 命中同一张卡）", async () => {
    const store = seedStore();
    const sessionStore = seedSessionStore();
    const notifier = makeMockNotifier(sessionStore);
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
      emitTaskCard: false,
    });

    await fireUpdate(hook);

    // #5364 单卡语义：task 卡 == session 卡，认领恢复索引
    expect(notifier.getSessionCardMessageId(SESSION)).toBe(TASK_CARD_ID);
  });
});
