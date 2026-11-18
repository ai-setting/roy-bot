/**
 * @fileoverview Task #5182 — reopen 复用原卡（不建新卡）
 *
 * 用户飞书明令（2026-11-08 15:56）：
 * 「reopen 复用原卡。但是需要往操作记录里面增加一个 reopen 的记录。然后重新 pin」
 *
 * ## 旧行为（Task #4536 F1 锁定的，本次推翻）
 *
 * closed 记录 + task 重新激活（status→active）时：
 *   清内存 messageId + dropStaleMessageId → 走 startTask 发一张**新卡**。
 *   用户看到同一任务两张卡（旧卡 closed + 新卡 open），且旧卡历史丢失。
 *
 * ## 新行为（本文件锁定）
 *
 *   R1 reopen → **复用原卡**：updateTask patch 原 messageId（不调 startTask），
 *      卡片内容标注「🔄 重新打开」里程碑；持久层 markReopened（closed→open，
 *      messageId 不变）；重新 pin（pinMessage）。
 *   R2 reopen 后连续两次 update：第二次仍 patch 同一张原卡（不重复发卡）。
 *   R3 reopen 时原卡 patch 失败 → 降级回退到旧路径（发新卡），保证可见性。
 *   R4 无记录（从未发过卡）的活跃 task → 仍走 startTask 建首卡（不变）。
 */

import { describe, it, expect } from "bun:test";
import { mock } from "bun:test";
import { LarkCliTaskNotifyHook } from "./lark-cli-task-notify-plugin";
import { LarkCardPatchNotifier } from "./lark-card-patch-notifier";
import { MemoryLarkCardStateStore } from "./lark-card-state-store";
import { TaskHookPoints } from "../hooks/task-hook-points";
import type { HookContext } from "../../hook/types";
import type {
  TaskCreateResultContext,
  TaskUpdateResultContext,
  TaskCompleteResultContext,
} from "../hooks/contexts";
import { runWithEnvContext, type EnvContext } from "../../context";

// ============================================================================
// Helpers（与 lark-card-persist-4536.test.ts 同款）
// ============================================================================

function makeTask(overrides: Partial<any> = {}): any {
  return {
    id: 42,
    title: "reopen 复用原卡测试任务",
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
    sourceId: "es-test-5182",
    userId: "ou_test",
    replyChannel: { chatId: "oc_chat5182", messageId: "om_msg5182" },
    pluginEnabled: { "es-test-5182:LarkCliTaskNotifyHook": true },
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

function makeMockNotifier() {
  const notifier = new LarkCardPatchNotifier();
  (notifier as any).startTask = mock(async () => ({
    messageId: "om_card_5182",
    pinned: true,
  }));
  (notifier as any).updateTask = mock(async () => {});
  (notifier as any).finishTask = mock(async () => {});
  (notifier as any).pauseTask = mock(async () => {});
  (notifier as any).pinMessage = mock(async () => {});
  (notifier as any).unpinMessage = mock(async () => {});
  return notifier;
}

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
// R. reopen 复用原卡（Task #5182）
// ============================================================================

describe("Task #5182 — reopen 复用原卡（不建新卡）", () => {
  it("R1 closed 的 task 被 reopen（status→active）→ patch 原卡 + 重新 pin，不发新卡", async () => {
    const notifier = makeMockNotifier();
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });
    await bootstrapCard(hook); // om_card_5182, pinned=true
    await fireComplete(hook, makeTask({ status: "completed", progress: 100 }));
    expect(store.get(42)!.status).toBe("closed");
    expect(store.get(42)!.messageId).toBe("om_card_5182");

    // ★ reopen：任务重新激活
    await fireUpdate(hook, makeTask({ status: "active", progress: 10 }), {
      status: "active",
    });

    // 核心断言：不调 startTask（不发新卡），只 patch 原卡
    expect((notifier as any).startTask).toHaveBeenCalledTimes(1);
    expect((notifier as any).updateTask).toHaveBeenCalled();
    const lastUpdate = ((notifier as any).updateTask as any).mock.calls.at(-1)[0];
    expect(lastUpdate.messageId).toBe("om_card_5182");

    // 卡片内容带「重新打开」里程碑
    // ★ 实现双通道：内存态存在走 mergeTimelineState（快照可验）；
    //   内存态缺失（mock notifier / 重启未 hydrate）→ 增量随 patch 传。
    //   两路都验证：exportState 快照 + updateTask 的 opts.milestones。
    const snap = (notifier as any).exportState?.("om_card_5182");
    const patchMs = lastUpdate.milestones ?? [];
    const allMs = [...(snap?.milestones ?? []), ...patchMs];
    const hasReopen = allMs.some((m: any) =>
      String(m.title ?? "").includes("重新打开")
    );
    expect(hasReopen).toBe(true);

    // 持久层：closed → open，messageId 不变
    const rec = store.get(42)!;
    expect(rec.status).toBe("open");
    expect(rec.messageId).toBe("om_card_5182");

    // 重新 pin（终态时被 unpin 过）
    expect((notifier as any).pinMessage).toHaveBeenCalled();
    const pinCall = ((notifier as any).pinMessage as any).mock.calls.at(-1);
    expect(pinCall[0]).toBe("om_card_5182");
    expect(store.get(42)!.pinned).toBe(true);
  });

  it("R2 reopen 后连续两次 update：第二次仍 patch 同一张原卡", async () => {
    const notifier = makeMockNotifier();
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });
    await bootstrapCard(hook);
    await fireComplete(hook, makeTask({ status: "completed", progress: 100 }));

    // reopen
    await fireUpdate(hook, makeTask({ status: "active", progress: 5 }), {
      status: "active",
    });
    expect((notifier as any).startTask).toHaveBeenCalledTimes(1);

    // 后续普通 update：仍 patch 原卡，绝不再发卡
    await fireUpdate(hook, makeTask({ status: "active", progress: 40 }), {
      progress: 40,
    });
    expect((notifier as any).startTask).toHaveBeenCalledTimes(1);
    const lastUpdate = ((notifier as any).updateTask as any).mock.calls.at(-1)[0];
    expect(lastUpdate.messageId).toBe("om_card_5182");
  });

  it("R3 reopen 时原卡 patch 失败 → 降级发新卡（可见性兜底）", async () => {
    const notifier = makeMockNotifier();
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });
    await bootstrapCard(hook); // 首卡 om_card_5182
    await fireComplete(hook, makeTask({ status: "completed", progress: 100 }));
    expect(store.get(42)!.status).toBe("closed");

    // 原卡 patch 失败；降级 startTask 返回**不同的新 messageId**
    // （DS review MAJOR 1：降级后持久层必须指向新卡，不得残留旧 id）
    (notifier as any).updateTask = mock(async () => {
      throw new Error("patch failed: card deleted by user");
    });
    (notifier as any).startTask = mock(async () => ({
      messageId: "om_card_NEW",
      pinned: true,
    }));

    await fireUpdate(hook, makeTask({ status: "active", progress: 1 }), {
      status: "active",
    });

    // 降级：发了一张新卡，持久层指向新卡（不是旧 id）
    expect((notifier as any).startTask).toHaveBeenCalledTimes(1);
    const rec = store.get(42)!;
    expect(rec.status).toBe("open");
    expect(rec.messageId).toBe("om_card_NEW");
    // 内存 Map 也回填新卡 id（DS review MINOR 2）
    expect((hook as any).cardMessageIds.get(42)).toBe("om_card_NEW");
  });

  it("R4 无记录的活跃 task update → 仍走 startTask 建首卡（行为不变）", async () => {
    const notifier = makeMockNotifier();
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });

    await fireUpdate(hook, makeTask({ status: "active", progress: 1 }), {
      status: "active",
    });

    expect((notifier as any).startTask).toHaveBeenCalledTimes(1);
  });
});
