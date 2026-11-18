/**
 * @fileoverview LarkCliTaskNotifyHook — 卡片持久化 + stop/cancel/completion 终态更新（Task #4536）
 *
 * 覆盖 9 个必测场景（用户诉求 A/B/C）：
 *
 * A. 持久化
 *   1. 发卡后 messageId 被持久化（读回验证）
 *   2. 模拟进程重启（新建 hook 实例 + 同一持久化 store）→ update 仍能 patch 原卡片，不重复发卡
 *
 * B. stop / cancel / completion 三终态
 *   3. completed  → 卡片标完成 + unpin
 *   4. cancelled  → 卡片标取消（不再误标"失败"）+ unpin
 *   5. paused     → 卡片标暂停 + unpin（新增能力）
 *   6. pause → resume → pause 二次进入，仍能找到同一卡片
 *
 * C. 健壮性
 *   7. 持久化写入抛错 → 卡片流程不中断（降级）
 *   8. 持久化记录缺失 → skip 且不重复发卡
 *   9. 并发两次 update → 幂等（不重复发卡/patch 不炸）
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { mock } from "bun:test";
import { LarkCliTaskNotifyHook } from "./lark-cli-task-notify-plugin";
import { LarkCardPatchNotifier } from "./lark-card-patch-notifier";
import {
  MemoryLarkCardStateStore,
  SqliteLarkCardStateStore,
  type LarkCardStateStore,
} from "./lark-card-state-store";
import { TaskHookPoints } from "../hooks/task-hook-points";
import type { HookContext } from "../../hook/types";
import type {
  TaskCreateResultContext,
  TaskUpdateResultContext,
  TaskCompleteResultContext,
} from "../hooks/contexts";
import { runWithEnvContext, type EnvContext } from "../../context";

// ============================================================================
// Helpers
// ============================================================================

function makeTask(overrides: Partial<any> = {}): any {
  return {
    id: 42,
    title: "持久化测试任务",
    description: "desc",
    status: "active",
    priority: "high",
    type: "normal",
    progress: 50,
    current_status: "进行中",
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-01T01:00:00Z",
    project_path: "/tmp/test",
    context: "{}",
    ...overrides,
  };
}

function makeEnvContext(overrides: Partial<EnvContext> = {}): EnvContext {
  return {
    envEvent: { metadata: {} },
    sourceId: "es-test-1",
    userId: "ou_test",
    replyChannel: { chatId: "oc_chat123", messageId: "om_msg456" },
    pluginEnabled: { "es-test-1:LarkCliTaskNotifyHook": true },
    ...overrides,
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

/** 带 mock 的 notifier（实例级覆盖，不污染 prototype） */
function makeMockNotifier() {
  const notifier = new LarkCardPatchNotifier();
  (notifier as any).startTask = mock(async () => ({
    messageId: "om_card_test",
    pinned: true,
  }));
  (notifier as any).updateTask = mock(async () => {});
  (notifier as any).finishTask = mock(async () => {});
  // ★ xval MAJOR 2：paused/archived 走 pauseTask（保留时间线，不清内存态）
  (notifier as any).pauseTask = mock(async () => {});
  return notifier;
}

/** 一次性把「task created + 卡片已发」铺好 */
async function bootstrapCard(
  hook: LarkCliTaskNotifyHook,
  task = makeTask()
): Promise<void> {
  const ctx = makeHookContext(TaskHookPoints.AFTER_CREATE, {
    task,
  } as unknown as TaskCreateResultContext);
  await runWithEnvContext(makeEnvContext(), async () => {
    await hook.execute(ctx);
  });
}

async function fireUpdate(
  hook: LarkCliTaskNotifyHook,
  task: any,
  changes: any
): Promise<void> {
  const ctx = makeHookContext(TaskHookPoints.AFTER_UPDATE, {
    task,
    changes,
  } as unknown as TaskUpdateResultContext);
  await runWithEnvContext(makeEnvContext(), async () => {
    await hook.execute(ctx);
  });
}

async function fireComplete(
  hook: LarkCliTaskNotifyHook,
  task: any
): Promise<void> {
  const ctx = makeHookContext(TaskHookPoints.AFTER_COMPLETE, {
    task,
    changes: { status: task.status },
    terminalStatus: task.status,
    sessionId: "s1",
  } as unknown as TaskCompleteResultContext);
  await runWithEnvContext(makeEnvContext(), async () => {
    await hook.execute(ctx);
  });
}

// ============================================================================
// A. 持久化
// ============================================================================

describe("Task #4536 A — 卡片 messageId 持久化", () => {
  it("A1 发卡后 messageId 被持久化（读回验证）", async () => {
    const notifier = makeMockNotifier();
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });

    await bootstrapCard(hook);

    const rec = store.get(42);
    expect(rec).toBeDefined();
    expect(rec!.messageId).toBe("om_card_test");
    expect(rec!.chatId).toBe("oc_chat123");
    expect(rec!.pinned).toBe(true);
    expect(rec!.status).toBe("open");
  });

  it("A2 模拟进程重启：新 hook 实例 + 同一 store → patch 原卡片，不重复发卡", async () => {
    const store = new MemoryLarkCardStateStore();

    // ---- 进程 1：发卡 ----
    const notifier1 = makeMockNotifier();
    const hook1 = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier1,
      cardStateStore: store,
    });
    await bootstrapCard(hook1);
    expect((notifier1 as any).startTask).toHaveBeenCalledTimes(1);

    // ---- 进程 2（重启）：全新 notifier + hook，但共用 store ----
    const notifier2 = makeMockNotifier();
    const hook2 = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier2,
      cardStateStore: store,
    });

    await fireUpdate(hook2, makeTask({ progress: 80 }), { progress: 80 });

    // 关键：patch 的是「原卡片的 messageId」，而不是重新发一张卡
    expect((notifier2 as any).startTask).not.toHaveBeenCalled();
    expect((notifier2 as any).updateTask).toHaveBeenCalledTimes(1);
    const call = ((notifier2 as any).updateTask as any).mock.calls[0][0];
    expect(call.messageId).toBe("om_card_test");
  });

  it("A2b 重启后收到 completion → 仍能找到卡片并 finishTask", async () => {
    const store = new MemoryLarkCardStateStore();
    const notifier1 = makeMockNotifier();
    const hook1 = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier1,
      cardStateStore: store,
    });
    await bootstrapCard(hook1);

    const notifier2 = makeMockNotifier();
    const hook2 = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier2,
      cardStateStore: store,
    });
    await fireComplete(hook2, makeTask({ status: "completed", progress: 100 }));

    expect((notifier2 as any).finishTask).toHaveBeenCalledTimes(1);
    const call = ((notifier2 as any).finishTask as any).mock.calls[0][0];
    expect(call.messageId).toBe("om_card_test");
    expect(call.status).toBe("completed");

    // 终态后记录保留但标记 closed
    const rec = store.get(42);
    expect(rec!.status).toBe("closed");
    expect(rec!.messageId).toBe("om_card_test");
    expect(rec!.pinned).toBe(false);
  });

  it("A3 真实 SQLite store：跨实例（真重启语义）恢复 messageId", async () => {
    const dir = mkdtempSync(join(tmpdir(), "card4326-"));
    const dbPath = join(dir, "lark-cards.db");
    try {
      // 进程 1
      const s1 = new SqliteLarkCardStateStore(dbPath);
      const n1 = makeMockNotifier();
      const h1 = new LarkCliTaskNotifyHook({
        cardMode: true,
        cardNotifier: n1,
        cardStateStore: s1,
      });
      await bootstrapCard(h1);
      s1.close();

      // 进程 2
      const s2 = new SqliteLarkCardStateStore(dbPath);
      const n2 = makeMockNotifier();
      const h2 = new LarkCliTaskNotifyHook({
        cardMode: true,
        cardNotifier: n2,
        cardStateStore: s2,
      });
      await fireUpdate(h2, makeTask({ progress: 90 }), { progress: 90 });

      expect((n2 as any).startTask).not.toHaveBeenCalled();
      const call = ((n2 as any).updateTask as any).mock.calls[0][0];
      expect(call.messageId).toBe("om_card_test");
      s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// B. stop / cancel / completion
// ============================================================================

describe("Task #4536 B — stop/cancel/completion 三终态更新卡片 + pin", () => {
  it("B1 completed → 卡片标完成 + unpin", async () => {
    const notifier = makeMockNotifier();
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });
    await bootstrapCard(hook);

    await fireComplete(hook, makeTask({ status: "completed", progress: 100 }));

    const call = ((notifier as any).finishTask as any).mock.calls[0][0];
    expect(call.status).toBe("completed");
    expect(store.get(42)!.pinned).toBe(false);
    expect(store.get(42)!.status).toBe("closed");
  });

  it("B2 cancelled → 卡片标「已取消」（不是 failed）+ unpin", async () => {
    const notifier = makeMockNotifier();
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });
    await bootstrapCard(hook);

    await fireComplete(hook, makeTask({ status: "cancelled" }));

    const call = ((notifier as any).finishTask as any).mock.calls[0][0];
    expect(call.status).toBe("cancelled");
    expect(store.get(42)!.pinned).toBe(false);
    expect(store.get(42)!.status).toBe("closed");
  });

  it("B3 paused（stop）→ 卡片标「已暂停」+ unpin（新增能力）", async () => {
    const notifier = makeMockNotifier();
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });
    await bootstrapCard(hook);

    await fireUpdate(hook, makeTask({ status: "paused" }), {
      status: "paused",
    });

    // stop 走 pauseTask（patch 灰底「已暂停」+ unpin + 保留时间线），不是普通 update
    expect((notifier as any).updateTask).not.toHaveBeenCalled();
    const call = ((notifier as any).pauseTask as any).mock.calls[0][0];
    expect(call).toBeDefined();
    expect(call.messageId).toBe("om_card_test");
    // task.status="paused" → 卡片状态 "stopped"（灰底「⏹️ 已暂停」）
    expect(call.status).toBe("stopped");

    const rec = store.get(42)!;
    expect(rec.pinned).toBe(false);
    // ★ paused 不是终结：记录 status=paused，messageId 保留供 resume 复用
    expect(rec.status).toBe("paused");
    expect(rec.messageId).toBe("om_card_test");
    // ★ paused 不是终结：不能有 closedAt（否则状态被污染成"已关闭"）
    expect(rec.closedAt).toBeUndefined();
  });

  it("B4 pause → resume → pause 二次进入，仍找到同一卡片", async () => {
    const notifier = makeMockNotifier();
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });
    await bootstrapCard(hook);

    // 第一次 pause
    await fireUpdate(hook, makeTask({ status: "paused" }), {
      status: "paused",
    });
    expect(store.get(42)!.status).toBe("paused");

    // resume：status 回 active
    await fireUpdate(hook, makeTask({ status: "active" }), {
      status: "active",
    });
    expect(store.get(42)!.status).toBe("open");

    // 第二次 pause：必须还用同一张卡
    await fireUpdate(hook, makeTask({ status: "paused" }), {
      status: "paused",
    });
    expect(store.get(42)!.status).toBe("paused");
    expect(store.get(42)!.closedAt).toBeUndefined();

    const pauseCalls = (notifier as any).pauseTask.mock.calls;
    expect(pauseCalls.length).toBe(2);
    expect(pauseCalls[0][0].messageId).toBe("om_card_test");
    expect(pauseCalls[1][0].messageId).toBe("om_card_test");
    // 全程只发过一张卡
    expect((notifier as any).startTask).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// C. 健壮性
// ============================================================================

describe("Task #4536 C — 健壮性", () => {
  it("C1 持久化写入抛错 → 卡片流程不中断（仍发卡 + 仍 patch）", async () => {
    const notifier = makeMockNotifier();
    const brokenStore: LarkCardStateStore = {
      upsert: () => {
        throw new Error("disk full");
      },
      get: () => {
        throw new Error("disk full");
      },
      list: () => {
        throw new Error("disk full");
      },
      markPinned: () => {
        throw new Error("disk full");
      },
      markPaused: () => {
        throw new Error("disk full");
      },
      markReopened: () => {
        throw new Error("disk full");
      },
      markClosed: () => {
        throw new Error("disk full");
      },
      delete: () => {
        throw new Error("disk full");
      },
      close: () => {},
    };

    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: brokenStore,
    });

    // 发卡：不能因为持久化抛错而失败
    await bootstrapCard(hook);
    expect((notifier as any).startTask).toHaveBeenCalledTimes(1);

    // patch：同样不能中断（内存 Map 仍有 messageId）
    await fireUpdate(hook, makeTask({ progress: 70 }), { progress: 70 });
    expect((notifier as any).updateTask).toHaveBeenCalledTimes(1);
  });

  it("C2 无持久化记录 + 无内存记录 → 落库前先不重复发卡（update 触发首次发卡仅一次）", async () => {
    const notifier = makeMockNotifier();
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });

    // 没有 create 事件（记录缺失）→ 首次 update 允许补发一次卡（落库）
    await fireUpdate(hook, makeTask({ progress: 10 }), { progress: 10 });
    expect((notifier as any).startTask).toHaveBeenCalledTimes(1);
    expect(store.get(42)!.messageId).toBe("om_card_test");

    // 第二次 update → 有了持久化记录，不应再发卡
    await fireUpdate(hook, makeTask({ progress: 20 }), { progress: 20 });
    expect((notifier as any).startTask).toHaveBeenCalledTimes(1);
    expect((notifier as any).updateTask).toHaveBeenCalledTimes(2);
  });

  it("C3 并发两次 update → 只发一张卡（幂等）", async () => {
    const notifier = makeMockNotifier();
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });

    await Promise.all([
      fireUpdate(hook, makeTask({ progress: 30 }), { progress: 30 }),
      fireUpdate(hook, makeTask({ progress: 31 }), { progress: 31 }),
    ]);

    expect((notifier as any).startTask).toHaveBeenCalledTimes(1);
  });

  it("C4 卡片记录缺失 + 终态事件 → 优雅 skip（不发新卡、不抛错）", async () => {
    const notifier = makeMockNotifier();
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });

    // 直接从 complete 开始（老任务 / 记录丢失）
    await fireComplete(hook, makeTask({ status: "completed", progress: 100 }));

    // 应该不发卡、不 finish（无卡片可 patch），也不抛异常
    expect((notifier as any).startTask).not.toHaveBeenCalled();
    expect((notifier as any).finishTask).not.toHaveBeenCalled();
  });

  it("C5 pinned 状态在 patch 后仍被持久化保持", async () => {
    const notifier = makeMockNotifier();
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });
    await bootstrapCard(hook);
    await fireUpdate(hook, makeTask({ progress: 60 }), { progress: 60 });

    const rec = store.get(42)!;
    expect(rec.pinned).toBe(true);
    expect(rec.status).toBe("open");
    expect(rec.updatedAt).toBeGreaterThanOrEqual(rec.createdAt);
  });
});

// ============================================================================
// D. 卡片渲染：cancelled / stopped 的真实文案与色板
// ============================================================================

describe("Task #4536 D — 终态卡片渲染文案", () => {
  it("D1 cancelled → 灰底 + 「已取消」，不出现「失败」", () => {
    const { buildTaskCard } = require("./lark-card-patch-notifier");
    const card = buildTaskCard({
      status: "cancelled",
      meta: { id: 42, title: "T" },
      milestones: [],
      processSteps: [],
      updateCount: 2,
      spinner: "⏳",
    });
    const raw = JSON.stringify(card);
    expect(card.header.template).toBe("grey");
    expect(card.header.subtitle.content).toContain("已取消");
    expect(raw).not.toContain("任务失败");
  });

  it("D2 stopped（paused）→ 灰底 + 「已停止」，不出现「失败」/「完成」", () => {
    const { buildTaskCard } = require("./lark-card-patch-notifier");
    const card = buildTaskCard({
      status: "stopped",
      meta: { id: 42, title: "T" },
      milestones: [],
      processSteps: [],
      updateCount: 2,
      spinner: "⏳",
    });
    const raw = JSON.stringify(card);
    expect(card.header.template).toBe("grey");
    expect(card.header.subtitle.content).toContain("已停止");
    expect(raw).not.toContain("任务失败");
    expect(raw).not.toContain("全部完成");
  });

  it("D3 finishTask(cancelled) 终态里程碑写「Task 已取消」", async () => {
    const { LarkCardPatchNotifier } = require("./lark-card-patch-notifier");
    const notifier = new LarkCardPatchNotifier({ pinOnStart: false, unpinOnFinish: false });
    const calls: string[][] = [];
    (notifier as any).runLarkCli = async (args: string[]) => {
      calls.push(args);
      return JSON.stringify({ ok: true });
    };
    await notifier.finishTask({ messageId: "om_x", status: "cancelled" });
    // 只应有一次 patch 调用（unpinOnFinish=false）
    expect(calls.length).toBe(1);
    // patch 的 --data 里必须带「Task 已取消」里程碑
    const dataArg = calls[0][calls[0].indexOf("--data") + 1];
    expect(dataArg).toContain("Task 已取消");
    expect(dataArg).not.toContain("Task 失败");
  });

  it("D4 finishTask(stopped) 终态里程碑写「Task 已暂停」", async () => {
    const { LarkCardPatchNotifier } = require("./lark-card-patch-notifier");
    const notifier = new LarkCardPatchNotifier({ pinOnStart: false, unpinOnFinish: false });
    const calls: string[][] = [];
    (notifier as any).runLarkCli = async (args: string[]) => {
      calls.push(args);
      return JSON.stringify({ ok: true });
    };
    await notifier.finishTask({ messageId: "om_x", status: "stopped" });
    const dataArg = calls[0][calls[0].indexOf("--data") + 1];
    expect(dataArg).toContain("Task 已暂停");
  });

  it("D5 三种终态都触发 unpin，且 pins delete 契约带 --yes（显式开启时）", async () => {
    const { LarkCardPatchNotifier } = require("./lark-card-patch-notifier");
    // ★ Task #5164 R2a：默认不 unpin；本契约测显式 unpinOnFinish=true 的 argv 形态
    for (const status of ["completed", "cancelled", "stopped"] as const) {
      const notifier = new LarkCardPatchNotifier({ unpinOnFinish: true });
      const calls: string[][] = [];
      (notifier as any).runLarkCli = async (args: string[]) => {
        calls.push(args);
        return JSON.stringify({ ok: true });
      };
      await notifier.finishTask({ messageId: "om_x", status });
      const unpin = calls.find((c) => c.includes("pins") && c.includes("delete"));
      expect(unpin).toBeDefined();
      expect(unpin!).toContain("--yes");
      expect(unpin!).toContain("--message-id");
      expect(unpin![unpin!.indexOf("--message-id") + 1]).toBe("om_x");
    }
  });
});

// ============================================================================
// E. resume 后 re-pin（pin 状态与任务状态保持一致）
// ============================================================================

describe("Task #4536 E — resume 后 re-pin 闭环", () => {
  it("E1 pause → resume：resume 后卡片重新 pin（pin 状态跟随任务状态）", async () => {
    const notifier = makeMockNotifier();
    (notifier as any).pinMessage = mock(async () => {});
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });
    await bootstrapCard(hook);

    // pause → unpin
    await fireUpdate(hook, makeTask({ status: "paused" }), { status: "paused" });
    expect(store.get(42)!.pinned).toBe(false);

    // resume → re-pin
    await fireUpdate(hook, makeTask({ status: "active" }), { status: "active" });
    expect((notifier as any).pinMessage).toHaveBeenCalledTimes(1);
    const call = ((notifier as any).pinMessage as any).mock.calls[0];
    expect(call[0]).toBe("om_card_test");
    expect(store.get(42)!.pinned).toBe(true);
  });

  it("E1b 已置顶的卡片 resume 不重复 pin（幂等，避免每次 update 都调 pins create）", async () => {
    const notifier = makeMockNotifier();
    (notifier as any).pinMessage = mock(async () => {});
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });
    await bootstrapCard(hook);
    // bootstrap 后记录 pinned=true；手工标 paused 但保持 pinned=true 的边界
    store.markPaused(42);
    store.markPinned(42, true);

    await fireUpdate(hook, makeTask({ status: "active" }), { status: "active" });
    // 已经置顶 → 不该再 pin 一次
    expect((notifier as any).pinMessage).not.toHaveBeenCalled();
    expect(store.get(42)!.pinned).toBe(true);
    expect(store.get(42)!.status).toBe("open");
  });

  it("E2 普通 update（未 pause 过）不触发 re-pin", async () => {
    const notifier = makeMockNotifier();
    (notifier as any).pinMessage = mock(async () => {});
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });
    await bootstrapCard(hook);
    await fireUpdate(hook, makeTask({ progress: 55 }), { progress: 55 });
    expect((notifier as any).pinMessage).not.toHaveBeenCalled();
  });

  it("E3 re-pin 失败不阻断 patch（降级）", async () => {
    const notifier = makeMockNotifier();
    (notifier as any).pinMessage = mock(async () => {
      throw new Error("pin failed");
    });
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });
    await bootstrapCard(hook);
    await fireUpdate(hook, makeTask({ status: "paused" }), { status: "paused" });

    // resume：pin 抛错，但 patch 仍应发生
    await fireUpdate(hook, makeTask({ status: "active" }), { status: "active" });
    expect((notifier as any).updateTask).toHaveBeenCalled();
    // pin 失败 → 持久层记录仍是 unpinned（如实反映）
    expect(store.get(42)!.pinned).toBe(false);
    expect(store.get(42)!.status).toBe("open");
  });

  it("E4 pinMessage 的 lark-cli 契约：pins create 只传 --data message_id", async () => {
    const { LarkCardPatchNotifier } = require("./lark-card-patch-notifier");
    const notifier = new LarkCardPatchNotifier();
    const calls: string[][] = [];
    (notifier as any).runLarkCli = async (args: string[]) => {
      calls.push(args);
      return JSON.stringify({ ok: true });
    };
    await notifier.pinMessage("om_repin", "prof-x");
    expect(calls.length).toBe(1);
    const c = calls[0];
    expect(c.slice(0, 3)).toEqual(["--profile", "prof-x", "im"]);
    expect(c).toContain("pins");
    expect(c).toContain("create");
    expect(c).toContain("--data");
    expect(c[c.indexOf("--data") + 1]).toBe('{"message_id":"om_repin"}');
    // 绝不能用非法 flag（旧 bug：--chat-id/--message-id 会 unknown flag）
    expect(c).not.toContain("--chat-id");
    expect(c).not.toContain("--message-id");
  });
});

// ============================================================================
// F. 任务被重新打开（closed → active）后的行为
// ============================================================================

describe("Task #4536 F — 重新打开旧任务（reopen）", () => {
  // ★ Task #5182（用户明令 2026-11-08 15:56）：reopen 行为改为**复用原卡**
  //   （patch + 「🔄 任务重新打开」里程碑 + 重新 pin），不再发新卡。
  //   新行为由 lark-card-reopen-5182.test.ts 的 R1/R2 锁定；
  //   本文件 F1/F1b 相应改写为「复用原卡」断言。
  it("F1 已 closed 的 task 被 reopen（status→active）→ 复用原卡 patch，不发新卡", async () => {
    const notifier = makeMockNotifier();
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });
    await bootstrapCard(hook);
    await fireComplete(hook, makeTask({ status: "completed", progress: 100 }));
    expect(store.get(42)!.status).toBe("closed");

    // ★ reopen：用户把任务重新激活（Task #4534/#4535 这类续做场景很常见）
    await fireUpdate(hook, makeTask({ status: "active", progress: 10 }), {
      status: "active",
    });

    // Task #5182：复用原卡（不 startTask），patch 同一 messageId
    expect((notifier as any).startTask).toHaveBeenCalledTimes(1);
    expect((notifier as any).updateTask).toHaveBeenCalled();
    const lastUpdate = ((notifier as any).updateTask as any).mock.calls.at(-1)[0];
    expect(lastUpdate.messageId).toBe("om_card_test");
    expect(store.get(42)!.status).toBe("open");
  });

  it("F1b reopen 后连续两次 update：第二次仍 patch 同一张原卡", async () => {
    const notifier = makeMockNotifier();
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });
    await bootstrapCard(hook); // om_card_test
    await fireComplete(hook, makeTask({ status: "completed", progress: 100 }));

    // reopen（复用原卡 om_card_test）
    await fireUpdate(hook, makeTask({ status: "active", progress: 5 }), {
      status: "active",
    });
    expect((notifier as any).startTask).toHaveBeenCalledTimes(1);

    // 后续普通 update 仍 patch 原卡，且**不再**发新卡
    await fireUpdate(hook, makeTask({ status: "active", progress: 40 }), {
      progress: 40,
    });
    expect((notifier as any).startTask).toHaveBeenCalledTimes(1);
    const lastUpdate = ((notifier as any).updateTask as any).mock.calls.at(-1)[0];
    expect(lastUpdate.messageId).toBe("om_card_test");
  });

  it("F1c archived 任务不发卡（归档 ≠ 活跃，避免给已归档任务刷卡片）", async () => {
    const notifier = makeMockNotifier();
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });

    // 无任何记录 + 任务是 archived → 不应建卡
    await fireUpdate(hook, makeTask({ status: "archived" }), { progress: 50 });

    expect((notifier as any).startTask).not.toHaveBeenCalled();
  });

  it("F2 closed 的 task 收到普通进展 update（未 reopen）→ 仍然 skip，不复活旧卡", async () => {
    const notifier = makeMockNotifier();
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });
    await bootstrapCard(hook);
    await fireComplete(hook, makeTask({ status: "completed", progress: 100 }));

    // 终态后迟到的 operation/update（progress 变化但 status 仍 completed）
    await fireUpdate(hook, makeTask({ status: "completed", progress: 100 }), {
      progress: 100,
    });

    // 不应再发新卡，也不应 resurrect 旧卡
    expect((notifier as any).startTask).toHaveBeenCalledTimes(1);
    expect(store.get(42)!.status).toBe("closed");
  });
});

// ============================================================================
// F 补：终结/归档 + 无卡片 → 不凭空建卡（四个终态全覆盖）
// ============================================================================

describe("Task #4536 F-补 — 终结态无卡片时不建卡", () => {
  for (const terminalStatus of [
    "paused",
    "cancelled",
    "completed",
    "archived",
    "failed",
  ] as const) {
    it(`F1d 无卡片 + status=${terminalStatus} → 不建卡（不刷脏卡片）`, async () => {
      const notifier = makeMockNotifier();
      const store = new MemoryLarkCardStateStore();
      const hook = new LarkCliTaskNotifyHook({
        cardMode: true,
        cardNotifier: notifier,
        cardStateStore: store,
      });

      await fireUpdate(hook, makeTask({ status: terminalStatus }), {
        progress: 50,
      });

      expect((notifier as any).startTask).not.toHaveBeenCalled();
      expect(store.get(42)).toBeUndefined();
    });
  }
});

// ============================================================================
// G. 交叉验证（xval @ /tmp/xval-4536.log）抓到的 4 个 MAJOR 回归
// ============================================================================

describe("Task #4536 G — xval MAJOR 1: 提前 progress=100 不得引发重复卡片", () => {
  it("G1 progress=100 但 task 仍 active → 不关卡片；后续 update 仍 patch 同一张卡（不发新卡）", async () => {
    const notifier = makeMockNotifier();
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });
    await bootstrapCard(hook);

    // A: 只有 progress=100，task.status 还是 active（历史上有 agent 这么报）
    await fireUpdate(hook, makeTask({ status: "active", progress: 100 }), {
      progress: 100,
    });

    // B: 后续普通 update
    await fireUpdate(hook, makeTask({ status: "active", progress: 60 }), {
      progress: 60,
    });

    // 关键：全程只发过 1 张卡（bootstrap 那张），绝无第二张
    expect((notifier as any).startTask).toHaveBeenCalledTimes(1);
    expect(store.get(42)!.status).toBe("open");
    const lastUpdate = ((notifier as any).updateTask as any).mock.calls.at(-1)[0];
    expect(lastUpdate.messageId).toBe("om_card_test");
  });
});

describe("Task #4536 G — xval MAJOR 2: pause → resume 不得抹掉卡片时间线", () => {
  it("G2 pause 后 resume，卡片仍是同一张且历史时间线保留（不退回第 1 次更新）", async () => {
    const notifier = new LarkCardPatchNotifier();
    const cliCalls: string[][] = [];
    (notifier as any).runLarkCli = async (args: string[]) => {
      cliCalls.push(args);
      if (args.includes("+messages-send")) {
        return JSON.stringify({ ok: true, data: { message_id: "om_card_test" } });
      }
      return JSON.stringify({ ok: true });
    };

    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });
    await bootstrapCard(hook);
    // 累积一些进展
    await fireUpdate(hook, makeTask({ progress: 40 }), { progress: 40 });
    await fireUpdate(hook, makeTask({ progress: 60 }), { progress: 60 });

    // pause
    await fireUpdate(hook, makeTask({ status: "paused" }), { status: "paused" });
    const pausePatch = cliCalls.filter((c) => c.includes("patch")).at(-1)!;
    const pauseData = pausePatch[pausePatch.indexOf("--data") + 1];
    // pause 卡片里必须还能看到之前的进展（时间线没被清空）
    expect(pauseData).toContain("进度");

    // resume
    await fireUpdate(hook, makeTask({ status: "active", progress: 70 }), {
      status: "active",
      progress: 70,
    });
    const resumePatch = cliCalls.filter((c) => c.includes("patch")).at(-1)!;
    const resumeData = resumePatch[resumePatch.indexOf("--data") + 1];
    // 关键：resume 后不能退回"第 1 次更新"
    expect(resumeData).not.toContain("第 1 次更新");
    // 且 milestone 历史仍存在（不是"暂无里程碑"）
    expect(resumeData).not.toContain("暂无里程碑");
  });
});

describe("Task #4536 G — xval MAJOR 4: closed 卡片不得在重启后复活", () => {
  // ★ Task #5182：reopen 已改为复用原卡；本测试语义收窄为
  //   「reopen 复用原卡失败（patch 抛错）→ 降级发新卡，且降级路径
  //   也不得把持久层翻成 open+旧 messageId」（xval MAJOR 4 不变量保留）。
  it("G4 reopen 复用原卡 patch 失败 → 降级发新卡；降级失败时记录不得是 open+旧 messageId", async () => {
    const notifier = makeMockNotifier();
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });
    await bootstrapCard(hook);
    await fireComplete(hook, makeTask({ status: "completed", progress: 100 }));
    expect(store.get(42)!.status).toBe("closed");

    // reopen 复用原卡：patch 失败 + 降级 startTask 也失败
    (notifier as any).updateTask = mock(async () => {
      throw new Error("patch failed");
    });
    (notifier as any).startTask = mock(async () => {
      throw new Error("send failed");
    });
    await fireUpdate(hook, makeTask({ status: "active", progress: 1 }), {
      status: "active",
    });

    // 记录不能是 "open + 旧 closed messageId" 的组合
    const rec = store.get(42);
    if (rec) {
      expect(rec.status).not.toBe("open");
    } else {
      expect(rec).toBeUndefined();
    }

    // 并且重启后（新 hook 实例）不得 patch 已 closed 的旧卡；
    // 降级新卡必须是一个**新的** messageId（不是原来的 om_card_test）
    const n2 = makeMockNotifier();
    (n2 as any).startTask = mock(async () => ({
      messageId: "om_card_NEW",
      pinned: true,
    }));
    const h2 = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: n2,
      cardStateStore: store,
    });
    await fireUpdate(h2, makeTask({ status: "active", progress: 20 }), {
      progress: 20,
    });
    const patches = ((n2 as any).updateTask as any).mock.calls;
    for (const c of patches) {
      expect(c[0].messageId).not.toBe("om_card_test");
    }
    // 新记录指向新卡
    expect(store.get(42)!.messageId).toBe("om_card_NEW");
  });
});

describe("Task #4536 G — xval MINOR 8: archived 任务卡片不该永远 spinning + pinned", () => {
  it("G8 有卡片 + 任务变 archived → 卡片收尾（stopped）+ unpin", async () => {
    const notifier = makeMockNotifier();
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });
    await bootstrapCard(hook);

    await fireUpdate(hook, makeTask({ status: "archived" }), {
      status: "archived",
    });

    expect((notifier as any).pauseTask).toHaveBeenCalledTimes(1);
    const call = ((notifier as any).pauseTask as any).mock.calls[0][0];
    expect(call.status).toBe("stopped");
    expect(store.get(42)!.pinned).toBe(false);
  });
});

describe("Task #4536 G — xval MAJOR 3: 重启后卡片内容（时间线）不丢", () => {
  it("G3 重启后第一次 patch 仍带原里程碑与过程步骤，且更新次数不退回 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "card-content-"));
    const dbPath = join(dir, "cards.db");
    try {
      // ---- 进程 1：发卡 + 累积 2 次进展 ----
      const notifier1 = new LarkCardPatchNotifier();
      const cli1: string[][] = [];
      (notifier1 as any).runLarkCli = async (args: string[]) => {
        cli1.push(args);
        if (args.includes("+messages-send")) {
          return JSON.stringify({ ok: true, data: { message_id: "om_card_x" } });
        }
        return JSON.stringify({ ok: true });
      };
      const s1 = new SqliteLarkCardStateStore(dbPath);
      const h1 = new LarkCliTaskNotifyHook({
        cardMode: true,
        cardNotifier: notifier1,
        cardStateStore: s1,
      });
      await bootstrapCard(h1);
      await fireUpdate(h1, makeTask({ progress: 40, current_status: "扫描中" }), {
        progress: 40,
      });
      await fireUpdate(h1, makeTask({ progress: 55, current_status: "编码中" }), {
        progress: 55,
      });
      s1.close();

      // ---- 进程 2（真重启）：新 notifier（内存态为空）+ 同一 DB ----
      const notifier2 = new LarkCardPatchNotifier();
      const cli2: string[][] = [];
      (notifier2 as any).runLarkCli = async (args: string[]) => {
        cli2.push(args);
        return JSON.stringify({ ok: true });
      };
      const s2 = new SqliteLarkCardStateStore(dbPath);
      const h2 = new LarkCliTaskNotifyHook({
        cardMode: true,
        cardNotifier: notifier2,
        cardStateStore: s2,
      });
      await fireUpdate(h2, makeTask({ progress: 70, current_status: "测试中" }), {
        progress: 70,
      });

      const patch = cli2.find((c) => c.includes("patch"))!;
      expect(patch).toBeDefined();
      const data = patch[patch.indexOf("--data") + 1];
      // 关键：重启前的进展内容必须还在
      expect(data).not.toContain("暂无里程碑");
      expect(data).not.toContain("暂无过程信息");
      // 更新计数不是从 1 重新算
      expect(data).not.toContain("第 1 次更新");
      s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Task #4536 G — hydrateState 幂等（不覆盖更新鲜的内存态）", () => {
  it("G3b 内存已累积 N 次更新时，hydrateState 不得把计数退回旧值", async () => {
    const dir = mkdtempSync(join(tmpdir(), "card-hyd-"));
    const dbPath = join(dir, "cards.db");
    try {
      const notifier = new LarkCardPatchNotifier();
      const cli: string[][] = [];
      (notifier as any).runLarkCli = async (args: string[]) => {
        cli.push(args);
        if (args.includes("+messages-send")) {
          return JSON.stringify({ ok: true, data: { message_id: "om_h" } });
        }
        return JSON.stringify({ ok: true });
      };
      const store = new SqliteLarkCardStateStore(dbPath);
      const hook = new LarkCliTaskNotifyHook({
        cardMode: true,
        cardNotifier: notifier,
        cardStateStore: store,
      });
      await bootstrapCard(hook);
      await fireUpdate(hook, makeTask({ progress: 30 }), { progress: 30 });
      await fireUpdate(hook, makeTask({ progress: 50 }), { progress: 50 });

      const before = notifier.exportState("om_h")!;
      expect(before.updateCount).toBeGreaterThan(1);

      // 用一份**过期**快照尝试覆盖 —— 必须被忽略
      notifier.hydrateState("om_h", {
        updateCount: 1,
        milestones: [],
        processSteps: [],
        startedAt: "2020-01-01T00:00:00.000Z",
      });

      const after = notifier.exportState("om_h")!;
      expect(after.updateCount).toBe(before.updateCount);
      expect(after.milestones.length).toBe(before.milestones.length);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Task #4536 H — xval round2 MINOR 4: operation 路径也走持久层恢复", () => {
  it("H1 重启后收到 operation 事件 → 仍能 patch 原卡片（核心目标覆盖 operation 路径）", async () => {
    const store = new MemoryLarkCardStateStore();
    // 进程 1：发卡
    const n1 = makeMockNotifier();
    const h1 = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: n1,
      cardStateStore: store,
    });
    await bootstrapCard(h1);
    expect(store.get(42)!.messageId).toBe("om_card_test");

    // 进程 2（重启）：只收到 OPERATION_AFTER_CREATE
    const n2 = makeMockNotifier();
    const h2 = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: n2,
      cardStateStore: store,
    });
    const op = {
      id: 1,
      taskId: 42,
      milestoneType: "progress",
      milestoneTitle: "扫描完成",
      milestoneDescription: "12 个文件",
      processDescription: "用 grep 扫了一遍",
      timestamp: new Date().toISOString(),
    };
    const ctx = makeHookContext(TaskHookPoints.OPERATION_AFTER_CREATE, {
      operation: op,
    } as any);
    await runWithEnvContext(makeEnvContext(), async () => {
      await h2.execute(ctx);
    });

    // 关键：必须 patch 原卡片（旧实现这里 0 次调用）
    expect((n2 as any).updateTask).toHaveBeenCalledTimes(1);
    const call = ((n2 as any).updateTask as any).mock.calls[0][0];
    expect(call.messageId).toBe("om_card_test");
  });
});

describe("Task #4536 H — xval round2 MINOR 2: 空 messageId 绝不传给 lark-cli", () => {
  it("H2 messageId 为空串时 repinAfterResume 不得调用 pinMessage", async () => {
    const notifier = makeMockNotifier();
    (notifier as any).pinMessage = mock(async () => {});
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });
    await bootstrapCard(hook);
    // 模拟 dropStaleMessageId 之后记录：paused + 空 messageId
    store.upsert({
      taskId: 42,
      messageId: "",
      chatId: "oc_chat123",
      pinned: false,
      status: "paused",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    (hook as any).cardMessageIds.delete(42);
    (hook as any).restoredTaskIds.delete(42);

    await fireUpdate(hook, makeTask({ status: "active" }), { status: "active" });

    expect((notifier as any).pinMessage).not.toHaveBeenCalled();
  });
});

describe("Task #4536 H — xval round2 NIT 3: archived 的终态里程碑文案", () => {
  it("H3 archived 任务的收尾里程碑写「Task 已归档」而不是「已暂停」", async () => {
    const notifier = new LarkCardPatchNotifier({ unpinOnFinish: false });
    const calls: string[][] = [];
    (notifier as any).runLarkCli = async (args: string[]) => {
      calls.push(args);
      return JSON.stringify({ ok: true });
    };
    await notifier.pauseTask({ messageId: "om_a", status: "stopped", finalStep: undefined });
    expect(calls.length).toBe(1);
    // 默认（无 archived 标记）仍是"已暂停"
    expect(calls[0][calls[0].indexOf("--data") + 1]).toContain("Task 已暂停");
  });
});

describe("Task #4536 H — xval round2 NIT 3: archived 文案区分", () => {
  it("H3b 有卡片 + 任务变 archived → 里程碑写「Task 已归档」", async () => {
    const notifier = new LarkCardPatchNotifier({ unpinOnFinish: false });
    const calls: string[][] = [];
    (notifier as any).runLarkCli = async (args: string[]) => {
      calls.push(args);
      return JSON.stringify({ ok: true, data: { message_id: "om_arch" } });
    };
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });
    await bootstrapCard(hook);
    calls.length = 0;
    await fireUpdate(hook, makeTask({ status: "archived" }), {
      status: "archived",
    });
    const patch = calls.find((c) => c.includes("patch"))!;
    const data = patch[patch.indexOf("--data") + 1];
    expect(data).toContain("Task 已归档");
    expect(data).not.toContain("Task 已暂停");
  });
});

describe("Task #4536 H — operation 不刷已收尾/暂停的卡片", () => {
  it("H4 卡片已 pause 时收到 operation → 不再追加时间线（不把已收尾卡刷成进行中）", async () => {
    const notifier = makeMockNotifier();
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });
    await bootstrapCard(hook);
    await fireUpdate(hook, makeTask({ status: "paused" }), { status: "paused" });
    expect(store.get(42)!.status).toBe("paused");

    // 暂停之后迟到的 operation 事件
    const op = {
      id: 9,
      taskId: 42,
      milestoneType: "progress",
      milestoneTitle: "迟到的进展",
      timestamp: new Date().toISOString(),
    };
    const ctx = makeHookContext(TaskHookPoints.OPERATION_AFTER_CREATE, {
      operation: op,
    } as any);
    const before = ((notifier as any).updateTask as any).mock.calls.length;
    await runWithEnvContext(makeEnvContext(), async () => {
      await hook.execute(ctx);
    });
    expect(((notifier as any).updateTask as any).mock.calls.length).toBe(before);
  });
});
