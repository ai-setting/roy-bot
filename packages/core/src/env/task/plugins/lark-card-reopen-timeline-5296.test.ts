/**
 * @fileoverview Task #5296 — reopen 后历史时间线不丢（飞书卡片）
 *
 * 用户飞书反馈（2026-11-11 09:02）：
 * 「重新打开又把之前的卡片内容干掉了」——#5182 reopen 复用原卡，
 * 但真机取证（traceId=01a1c77fa3b14b7619c0782d99c00f89）：
 * task #5286 complete → reopen 后卡片时间线只剩 2 条
 * （「🔄 任务重新打开」+ 当前进展），历史里程碑全丢。
 *
 * ## 根因（取证见 task #5296 操作记录）
 *
 *   1. `sendCardFinish` 真终态走 `finishTask`：patch 成功后
 *      notifier **states.delete(messageId)**（内存态清空），
 *      而持久层只 `persistClosed`（翻 status，**不快照 timeline**）
 *      → 历史内容既不在内存也不在持久层。
 *   2. reopen（closed 记录 + task 重新激活）→ `reopenReuseCard`：
 *      - `restoreCardState` 的 `restoredTaskIds` 短路（同进程首次
 *        bootstrap 已 add）→ 不会再次 hydrate；
 *      - 即使 hydrate，closed 记录也被 `rec.status !== "closed"`
 *        守卫挡住；
 *      - `mergeTimelineState` 因内存态不存在返回 false
 *        → patch 增量只带 1 条 reopen 里程碑；
 *      - `updateTask` 用空默认 state（milestones: []）重建卡片
 *        → 历史时间线全丢。
 *
 * ## 修复（F2，单点）
 *
 *   F1 终态快照：**无需改码**——取证 + 测试（R2 在修复前已
 *      pass）证实 operation hook 的 `refreshTimeline` 每次
 *      operation 后已把完整快照落库，终态时持久层 timeline
 *      完好（`persistClosed` 只翻 status 不动 timeline 列）。
 *   F2 reopen hydrate：`reopenReuseCard` 在 mergeTimelineState
 *      **之前**，若持久层 rec.timeline 有快照则强制
 *      `hydrateNotifierState`（清掉 restoredTaskIds 短路的影响），
 *      使 merge 成功、patch 走内存态全量时间线。
 *
 * ## 锁定行为
 *
 *   R1 complete（历史里程碑累积）→ reopen → exportState /
 *      updateTask patch 均含历史里程碑（含具体历史标题）。
 *   R2 持久层 timeline 在终态时被快照（重启后 reopen 也能恢复）。
 *   R3 reopen 后持久层 timeline 保留历史；#5182 行为不回归：
 *      复用原卡、不发新卡。
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
  TaskOperationCreateResultContext,
} from "../hooks/contexts";
import { runWithEnvContext, type EnvContext } from "../../context";

// ============================================================================
// Helpers（与 lark-card-reopen-5182.test.ts 同款）
// ============================================================================

function makeOperation(seq: number, title: string): any {
  return {
    id: 1000 + seq,
    taskId: 42,
    milestoneType: "milestone",
    milestoneTitle: title,
    timestamp: new Date().toISOString(),
  };
}

async function fireOperation(
  hook: LarkCliTaskNotifyHook,
  operation: any
): Promise<void> {
  const ctx = makeHookContext(TaskHookPoints.OPERATION_AFTER_CREATE, {
    operation,
  } as unknown as TaskOperationCreateResultContext);
  await runWithEnvContext(makeEnvContext(), async () => {
    await hook.execute(ctx);
  });
}

// ============================================================================
// Helpers（与 lark-card-reopen-5182.test.ts 同款）
// ============================================================================

function makeTask(overrides: Partial<any> = {}): any {
  return {
    id: 42,
    title: "reopen 历史时间线保留测试任务",
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
    sourceId: "es-test-5296",
    userId: "ou_test",
    replyChannel: { type: "lark", chatId: "oc_chat5296", messageId: "om_msg5296", profile: "test-profile" },
    pluginEnabled: { "es-test-5296:LarkCliTaskNotifyHook": true },
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

/**
 * 真 notifier（非 mock updateTask/finishTask）——
 * 内存态累积/删除逻辑必须真实执行，才能复现
 * 「finishTask 清内存态 → reopen 空重建」的根因路径。
 * 只 mock 最底层的 runLarkCli（不真调 lark-cli）。
 */
function makeRealNotifier(): LarkCardPatchNotifier {
  const notifier = new LarkCardPatchNotifier();
  // ★ startTask 的 stdout 必须含 message_id（extractMessageId 解析），
  //   否则首卡发送失败 → 无卡片 → 测试无意义。
  (notifier as any).runLarkCli = mock(async (args: any, kind: string) => {
    if (kind === "send") {
      return JSON.stringify({
        data: { message_id: "om_card_5182" },
      });
    }
    return "{}";
  });
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
// R. reopen 后历史时间线保留（Task #5296）
// ============================================================================

describe("Task #5296 — reopen 后历史时间线不丢", () => {
  it("R1 complete（累积历史）→ reopen → 卡片时间线含历史里程碑", async () => {
    const notifier = makeRealNotifier();
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });

    await bootstrapCard(hook); // 首卡 om_card_5182
    // 累积历史：两条 operation（各贡献一条里程碑，走真实 merge 路径）
    await fireOperation(hook, makeOperation(1, "阶段A完成"));
    await fireOperation(hook, makeOperation(2, "阶段B完成"));

    const histBefore = (notifier as any).exportState("om_card_5182");
    expect(histBefore.milestones.length).toBeGreaterThanOrEqual(2);

    // 终态：finishTask → 内存态被删
    await fireComplete(hook, makeTask({ status: "completed", progress: 100 }));
    expect(store.get(42)!.status).toBe("closed");
    expect((notifier as any).exportState("om_card_5182")).toBeUndefined();

    // reopen：任务重新激活
    await fireUpdate(hook, makeTask({ status: "active", progress: 10 }), {
      status: "active",
    });

    // ★ 核心断言：reopen 后内存态（exportState）包含历史里程碑，
    //   不只剩 reopen 一条
    const snapAfter = (notifier as any).exportState("om_card_5182");
    expect(snapAfter).toBeDefined();
    const titles = snapAfter.milestones.map((m: any) => String(m.title));
    expect(titles.some((t: string) => t.includes("重新打开"))).toBe(true);
    // ★ CV MINOR 补强：断言具体历史标题仍在（不只数数量）
    expect(titles).toContain("阶段A完成");
    expect(titles).toContain("阶段B完成");
  });

  it("R2 终态时持久层 timeline 被快照（重启后 reopen 可恢复）", async () => {
    const notifier = makeRealNotifier();
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });

    await bootstrapCard(hook);
    await fireOperation(hook, makeOperation(1, "阶段A推进"));
    await fireComplete(hook, makeTask({ status: "completed", progress: 100 }));
    const rec = store.get(42)!;
    expect(rec.status).toBe("closed");
    expect(rec.timeline).toBeTruthy();
    const snap = JSON.parse(rec.timeline!);
    expect(snap.milestones.length).toBeGreaterThanOrEqual(2);
  });

  it("R3 reopen 后持久层 timeline 也保留历史（快照回写）", async () => {
    const notifier = makeRealNotifier();
    const store = new MemoryLarkCardStateStore();
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });

    await bootstrapCard(hook);
    await fireOperation(hook, makeOperation(1, "阶段A推进"));
    await fireComplete(hook, makeTask({ status: "completed", progress: 100 }));
    await fireUpdate(hook, makeTask({ status: "active", progress: 10 }), {
      status: "active",
    });

    // reopen 成功：复用原卡（不回归 #5182）
    expect(store.get(42)!.status).toBe("open");
    expect(store.get(42)!.messageId).toBe("om_card_5182");

    // ★ reopen 后持久层 timeline 含历史 + reopen 里程碑
    const rec = store.get(42)!;
    const snap = JSON.parse(rec.timeline!);
    const titles = snap.milestones.map((m: any) => String(m.title));
    expect(titles.some((t: string) => t.includes("重新打开"))).toBe(true);
    // ★ CV MINOR 补强：断言具体历史标题仍在（不只数数量）
    expect(titles).toContain("阶段A推进");
  });
});
