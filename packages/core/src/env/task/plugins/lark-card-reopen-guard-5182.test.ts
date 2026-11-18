/**
 * @fileoverview Task #5182 follow-up — reopen patch 被 finalisedCards 守卫吞掉
 *
 * 真网取证（2026-11-08 18:00，隔离 HOME e2e）：
 *   create → complete → reopen 一个 turn 内完成，
 *   reopenReuseCard 打了「已复用原卡」INFO + pin 成功，
 *   但卡片内容仍是「已完成 🎉」——updateTask 的
 *   finalisedCards 守卫（Task #5020）在 finishTask 之后命中，
 *   **静默 early-return**，patch 从未发出。
 *
 * ## 锁定行为（本文件）
 *
 *   P1 finishTask 之后 updateTask 守卫命中 → patch 不发出
 *      （锁定真网 bug 的根因行为）。
 *   P2 unfinaliseCard：finishTask 后调用 → 守卫解除，再次
 *      updateTask 的 patch **真实发出**（argv 带 messageId，
 *      卡片含「重新打开」里程碑）。
 *   P3 unfinaliseCard 对未终结的卡是 no-op（不破坏运行中卡片状态）。
 *
 * 与 lark-card-reopen-5182.test.ts 的区别：那套用 mock notifier
 * （updateTask 是 mock，测的是 hook 层路由）；本文件用**真 notifier**
 * + testRunner 注入（mock 掉的正是被吞的 patch 这一步）。
 */

import { describe, it, expect } from "bun:test";
import { LarkCardPatchNotifier } from "./lark-card-patch-notifier";

const CHAT = "oc_reopen_guard";
const PROFILE = "gonglin";

interface RunCall {
  argv: string[];
  op: string;
}

function makeNotifier(): {
  notifier: LarkCardPatchNotifier;
  calls: RunCall[];
} {
  const notifier = new LarkCardPatchNotifier();
  const calls: RunCall[] = [];
  notifier.testRunner = async (argv, op) => {
    calls.push({ argv, op });
    // send 返回结构需带 data.message_id（extractMessageId 解析）
    return JSON.stringify({ data: { message_id: "om_guard_test" } });
  };
  return { notifier, calls };
}

function patchCalls(calls: RunCall[]): RunCall[] {
  return calls.filter((c) => c.op === "patch");
}

describe("Task #5182 follow-up — reopen patch 不被终态守卫吞掉", () => {
  it("P1 finishTask 后 updateTask 守卫命中 → patch 静默被吞（锁定根因）", async () => {
    const { notifier, calls } = makeNotifier();

    await notifier.startTask({
      chatId: CHAT,
      profile: PROFILE,
      meta: { id: 1, title: "guard test" },
    });
    await notifier.finishTask({
      messageId: "om_guard",
      profile: PROFILE,
      status: "completed",
    });
    // finishTask 自身会打一次终态 patch —— 记为基线
    const patchesAfterFinish = patchCalls(calls).length;

    // 迟到的 update（reopen 场景）
    await notifier.updateTask({
      messageId: "om_guard",
      profile: PROFILE,
      status: "running",
      milestones: [
        { title: "🔄 任务重新打开", timestamp: new Date().toISOString() },
      ],
    });

    // 守卫命中：finishTask 之后没有新 patch 发出（这就是真网 bug 的根因）
    expect(patchCalls(calls).length).toBe(patchesAfterFinish);
  });

  it("P2 unfinaliseCard 解除终态守卫 → reopen patch 真实发出", async () => {
    const { notifier, calls } = makeNotifier();

    await notifier.startTask({
      chatId: CHAT,
      profile: PROFILE,
      meta: { id: 2, title: "unfinalise test" },
    });
    await notifier.finishTask({
      messageId: "om_unfinalise",
      profile: PROFILE,
      status: "completed",
    });
    const patchesAfterFinish = patchCalls(calls).length;

    // ★ 修复：reopen 前解封
    (notifier as any).unfinaliseCard("om_unfinalise");

    await notifier.updateTask({
      messageId: "om_unfinalise",
      profile: PROFILE,
      status: "running",
      milestones: [
        { title: "🔄 任务重新打开", timestamp: new Date().toISOString() },
      ],
    });

    const patches = patchCalls(calls).slice(patchesAfterFinish);
    expect(patches.length).toBe(1);
    const argv = patches[0].argv.join(" ");
    expect(argv).toContain("om_unfinalise");
    // patch 的 --data 里带 reopen 里程碑（card JSON 双重编码）
    expect(argv).toContain("重新打开");
  });

  it("P3 unfinaliseCard 对未终结的卡是 no-op（不破坏运行中状态）", async () => {
    const { notifier, calls } = makeNotifier();

    const { messageId } = await notifier.startTask({
      chatId: CHAT,
      profile: PROFILE,
      meta: { id: 3, title: "no-op test" },
    });

    const stateBefore = (notifier as any).exportState(messageId);
    expect(stateBefore).toBeDefined();

    (notifier as any).unfinaliseCard(messageId);

    // state 仍在且未被重建
    const stateAfter = (notifier as any).exportState(messageId);
    expect(stateAfter).toBeDefined();
    expect(stateAfter!.updateCount).toBe(stateBefore!.updateCount);

    // updateTask 仍正常 patch
    await notifier.updateTask({
      messageId,
      profile: PROFILE,
      status: "running",
      milestones: [
        { title: "常规更新", timestamp: new Date().toISOString() },
      ],
    });
    expect(patchCalls(calls).length).toBe(1);
  });
});
