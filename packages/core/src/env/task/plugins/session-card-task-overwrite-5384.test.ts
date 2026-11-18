/**
 * @fileoverview Task #5384 —— **session 卡不得被 task 路径整卡覆盖降级**（真机 bug 守门人）
 *
 * ## 真机现场（2026-11-12 12:31，群 oc_xxxxxxxxxxxxxxxx）
 *
 * traces.db 的 `lark-card.runLarkCli` span 序列：
 *
 * ```
 * 12:31:00 send  💬 会话卡实时更新（真机验证卡片会话查看）  ← 有「💬 会话查看」
 * 12:31:01 pin
 * 12:31:18 patch 💬 会话卡实时更新（真机验证卡片会话查看）  ← 正常
 * 12:31:23 patch 💬 会话卡实时更新（真机验证卡片会话查看）  ← 正常
 * 12:31:23 patch 📋 任务卡实时更新（任务）                    ← ★ 同一秒被降级
 * ```
 *
 * 用户截图里那张「📋 任务卡实时更新（任务）」+ 只有「为这个任务建群」按钮，
 * 就是最后那条 patch 的结果 —— **同一张 messageId**，被 task 渲染器整卡重建。
 *
 * ## 根因
 *
 * `lark-card-patch-notifier.ts` 里 task 状态（`states`）与 session 状态
 * （`sessionStates`）是**两张独立的 Map**，但：
 *
 * - `updateTask()`   只读 `this.states`
 * - `finishTask()`   只读 `this.states`
 * - `pauseTask()`    只读 `this.states`
 * - `updateMetaAndBuildCard()` 只读 `this.states`
 *
 * 四者对「这个 messageId 其实是 session 卡」毫无感知；`states.get()` 为
 * undefined 时落入占位分支 `meta: opts.meta ?? { title: "任务" }`，
 * 再用 `buildTaskCard()` 全量重建 patch 同一个 messageId ⇒ session 卡降级
 * （标题变「任务」、刷新按钮消失、会话 ID 面板消失）。
 *
 * ## 本文件断言的不变式
 *
 * 1. **卡身份不变**：session 卡收到 task 侧的 update/finish/pause/建群 之后，
 *    header 仍是「💬 会话卡实时更新」，按钮里仍有「💬 会话查看」。
 * 2. **信息不丢**：task 的里程碑 / 进度 / 任务面板仍累积进这张卡。
 * 3. **task 卡不受影响**：真正的 task 卡（`startTask` 发的）行为不变。
 * 4. **终态后可刷新**：finish 之后 `buildSessionCardWithActivity` 仍能重建
 *    带刷新按钮的卡（否则用户点刷新又 fallback 成 task 卡）。
 */

import { describe, test, expect } from "bun:test";
import {
  LarkCardPatchNotifier,
  type CardPayload,
} from "./lark-card-patch-notifier";

const CHAT = "oc_5384_chat";
const SESSION = "session_5384_real";
const TASK_ID = 5382;

// ---------------------------------------------------------------------------
// 辅助：拦截 lark-cli，收集 send / patch 的**卡片 JSON**（不是 mock 断言）
// ---------------------------------------------------------------------------

interface Recorder {
  notifier: LarkCardPatchNotifier;
  sent: any[];
  patched: any[];
}

function makeRecorder(): Recorder {
  const notifier = new LarkCardPatchNotifier({ sessionCardStore: null });
  const sent: any[] = [];
  const patched: any[] = [];

  (notifier as any).runLarkCli = async (args: string[], op: string) => {
    const raw = args.includes("--content")
      ? args[args.indexOf("--content") + 1]
      : JSON.parse(args[args.indexOf("--data") + 1]).content;
    const card = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (op === "send") {
      sent.push(card);
      return JSON.stringify({
        ok: true,
        data: { message_id: `om_sess_${sent.length}` },
      });
    }
    patched.push(card);
    return JSON.stringify({ ok: true, data: {} });
  };
  (notifier as any).pinMessage = async () => {};

  return { notifier, sent, patched };
}

/** 取卡片 header 标题文本 */
function headerTitle(card: any): string {
  return card?.header?.title?.content ?? "";
}

/** 取卡片 header subtitle 文本 */
function headerSubtitle(card: any): string {
  return card?.header?.subtitle?.content ?? "";
}

/** 递归收集卡片内所有 button 文案（含 collapsible_panel 内部） */
function buttonTexts(card: any): string[] {
  const out: string[] = [];
  const walk = (els: any[]): void => {
    for (const e of els ?? []) {
      if (e?.tag === "button") {
        out.push(e?.text?.content ?? "");
      } else if (Array.isArray(e?.elements)) {
        walk(e.elements);
      }
    }
  };
  walk(card?.body?.elements ?? []);
  return out;
}

/** 递归收集所有 markdown 正文（折叠面板内部也算） */
function allMarkdown(card: any): string {
  const parts: string[] = [];
  const walk = (els: any[]): void => {
    for (const e of els ?? []) {
      if (e?.tag === "markdown" && typeof e.content === "string") {
        parts.push(e.content);
      } else if (Array.isArray(e?.elements)) {
        walk(e.elements);
      }
    }
  };
  walk(card?.body?.elements ?? []);
  return parts.join("\n");
}

/** 造一张 session 卡（首卡，带任务面板 —— 生产形状：task 先到或后到都带） */
async function startSession(r: Recorder, withTask = true): Promise<string> {
  const res = await r.notifier.startSessionCard({
    chatId: CHAT,
    sessionId: SESSION,
    title: "真机验证卡片刷新活性",
    lifecycle: "running",
    ...(withTask
      ? {
          task: {
            id: TASK_ID,
            title: "[真机验证] #5377+#5364 卡片刷新活性",
            status: "active",
            progress: 15,
          },
        }
      : {}),
  });
  return res.messageId;
}

// ===========================================================================
// 1. 核心回归：task 路径 updateTask 打在 session 卡上不得降级
// ===========================================================================

describe("Task #5384：session 卡不被 task 路径 updateTask 覆盖降级", () => {
  test("updateTask（task 事件）打 session 卡 → header 仍是「会话卡实时更新」+ 保留刷新按钮", async () => {
    const r = makeRecorder();
    const messageId = await startSession(r);

    // 生产形状：onAfterUpdate / onAfterOperationCreate 都这么调
    await r.notifier.updateTask({
      messageId,
      status: "running",
      meta: {
        id: TASK_ID,
        title: "[真机验证] #5377+#5364 卡片刷新活性",
        priority: "high",
        currentStatus: "正在取证",
      },
      progress: 40,
      milestones: [
        {
          title: "里程碑A：daemon 已加载新代码",
          timestamp: "2026-11-12T04:34:09.000Z",
        },
      ],
    });

    const last = r.patched.at(-1)!;
    expect(last).toBeDefined();
    // ★ 核心断言 1：卡身份没变
    expect(headerTitle(last)).toContain("💬 会话卡实时更新");
    expect(headerTitle(last)).not.toContain("📋 任务卡实时更新");
    // ★ 核心断言 2：刷新活性按钮物理存在
    expect(buttonTexts(last)).toContain("💬 会话查看"); // ★ Task #5420：按钮改名
    // ★ 核心断言 3：会话 ID 面板没消失
    expect(allMarkdown(last)).toContain(SESSION);
  });

  test("task 里程碑 / 进度 / 任务面板仍累积进这张 session 卡（信息不丢）", async () => {
    const r = makeRecorder();
    const messageId = await startSession(r);

    await r.notifier.updateTask({
      messageId,
      status: "running",
      meta: {
        id: TASK_ID,
        title: "[真机验证] #5377+#5364 卡片刷新活性",
        priority: "high",
      },
      progress: 40,
      milestones: [
        { title: "里程碑A", timestamp: "2026-11-12T04:31:23.000Z" },
      ],
    });
    await r.notifier.updateTask({
      messageId,
      status: "running",
      milestones: [
        { title: "里程碑B", timestamp: "2026-11-12T04:34:09.000Z" },
      ],
    });

    const last = r.patched.at(-1)!;
    const md = allMarkdown(last);
    // 累积：两次的里程碑都在
    expect(md).toContain("里程碑A");
    expect(md).toContain("里程碑B");
    // 任务面板在（ID / 标题 / 进度条）
    expect(md).toContain(`#${TASK_ID}`);
    expect(md).toContain("[真机验证] #5377+#5364 卡片刷新活性");
    expect(md).toContain("▓");
  });

  test("无 task 的纯 session 卡被 task 事件 patch → 仍不降级", async () => {
    const r = makeRecorder();
    const messageId = await startSession(r, false);

    await r.notifier.updateTask({
      messageId,
      status: "running",
      milestones: [{ title: "意外来的 task 里程碑" }],
    });

    const last = r.patched.at(-1)!;
    expect(headerTitle(last)).toContain("💬 会话卡实时更新");
    expect(buttonTexts(last)).toContain("💬 会话查看"); // ★ Task #5420：按钮改名
  });
});

// ===========================================================================
// 2. finishTask / pauseTask 同样不得降级
// ===========================================================================

describe("Task #5384：finishTask / pauseTask 打 session 卡不得降级", () => {
  test("finishTask（completed）→ session 卡保持身份 + 刷新按钮 + 显示已完成", async () => {
    const r = makeRecorder();
    const messageId = await startSession(r);

    await r.notifier.finishTask({
      messageId,
      status: "completed",
      finalStep: "全部 DoD 取证完成",
      meta: { id: TASK_ID, title: "[真机验证] #5377+#5364 卡片刷新活性" },
    });

    const last = r.patched.at(-1)!;
    expect(headerTitle(last)).toContain("💬 会话卡实时更新");
    expect(buttonTexts(last)).toContain("💬 会话查看"); // ★ Task #5420：按钮改名
    expect(headerSubtitle(last)).toContain("已完成");
    expect(allMarkdown(last)).toContain("全部 DoD 取证完成");
  });

  test("pauseTask（暂停）→ session 卡保持身份 + 刷新按钮", async () => {
    const r = makeRecorder();
    const messageId = await startSession(r);

    await r.notifier.pauseTask({
      messageId,
      status: "stopped",
      pausedMilestoneTitle: "任务已暂停",
    });

    const last = r.patched.at(-1)!;
    expect(headerTitle(last)).toContain("💬 会话卡实时更新");
    expect(buttonTexts(last)).toContain("💬 会话查看"); // ★ Task #5420：按钮改名
  });

  test("finish 之后用户点「会话查看」（原刷新活性）仍能重建带按钮的 session 卡（state 未被删）", async () => {
    const r = makeRecorder();
    const messageId = await startSession(r);

    await r.notifier.finishTask({
      messageId,
      status: "completed",
      meta: { id: TASK_ID, title: "[真机验证] #5377+#5364 卡片刷新活性" },
    });

    const rebuilt = r.notifier.buildSessionCardWithActivity(
      messageId,
      SESSION,
      {
        messageCount: 42,
        recentMessages: [],
        updatedAt: Date.now(),
      } as any,
    );

    expect(rebuilt).toBeDefined();
    expect(headerTitle(rebuilt as CardPayload)).toContain("💬 会话卡实时更新");
    expect(buttonTexts(rebuilt as CardPayload)).toContain("💬 会话查看"); // ★ Task #5420
    expect(allMarkdown(rebuilt as CardPayload)).toContain("42");
  });
});

// ===========================================================================
// 3. 建群 / 解散群（updateMetaAndBuildCard）不得降级
// ===========================================================================

describe("Task #5384：建群/解散群 重建卡片时保持 session 卡身份", () => {
  test("updateMetaAndBuildCard 打 session 卡 → 仍是 session 卡 + 刷新按钮", async () => {
    const r = makeRecorder();
    const messageId = await startSession(r);

    const card = r.notifier.updateMetaAndBuildCard(messageId, {
      id: TASK_ID,
      title: "[真机验证] #5377+#5364 卡片刷新活性",
      perTaskChatId: "oc_new_group_5384",
      perTaskChatName: "5384 专属群",
    });

    expect(card).toBeDefined();
    expect(headerTitle(card as CardPayload)).toContain("💬 会话卡实时更新");
    expect(buttonTexts(card as CardPayload)).toContain("💬 会话查看"); // ★ Task #5420
    // 建群后按钮应翻面成「解散该群」
    expect(buttonTexts(card as CardPayload)).toContain("解散该群");
  });
});

// ===========================================================================
// 4. task 卡行为不变（不能为了修 session 卡把 task 卡改坏）
// ===========================================================================

describe("Task #5384：真 task 卡行为不回归", () => {
  test("startTask 发的 task 卡 updateTask 后仍是「任务卡实时更新」", async () => {
    const r = makeRecorder();
    const res = await r.notifier.startTask({
      chatId: CHAT,
      taskId: TASK_ID,
      meta: { id: TASK_ID, title: "普通 task 卡" },
    });

    await r.notifier.updateTask({
      messageId: res.messageId,
      status: "running",
      meta: { id: TASK_ID, title: "普通 task 卡" },
      milestones: [{ title: "task 卡里程碑" }],
    });

    const last = r.patched.at(-1)!;
    expect(headerTitle(last)).toContain("📋 任务卡实时更新");
    expect(allMarkdown(last)).toContain("task 卡里程碑");
  });
});
// ===========================================================================
// 5. CV R1 MINOR 回归（独立 reviewer 指出的面板滞后 / 幽灵面板）
// ===========================================================================

describe("Task #5384 CV R1 MINOR：面板状态同步 & 无幽灵任务面板", () => {
  test("MINOR-1：finishTask 后「📋 任务信息」面板状态也变 completed（与 header 一致）", async () => {
    const r = makeRecorder();
    const messageId = await startSession(r, false);

    // 先建立任务面板（active），再终态
    await r.notifier.updateTask({
      messageId,
      status: "running",
      meta: { id: TASK_ID, title: "[真机验证] #5377+#5364 卡片刷新活性" },
    });
    await r.notifier.finishTask({
      messageId,
      status: "completed",
      meta: { id: TASK_ID, title: "[真机验证] #5377+#5364 卡片刷新活性" },
    });

    const md = allMarkdown(r.patched.at(-1)!);
    // 面板里的状态行必须跟着终态走，不能停在 active
    // ★ CV R4 MINOR-4：精确到「状态行」，避免任何含 completed 的文本蒙过
    expect(md).toContain("**🚦 状态**：completed");
    expect(md).not.toContain("**🚦 状态**：active");
  });

  test("MINOR-5：纯 session 卡（从无 task）收到带 status 的事件 → 不渲染「#0」幽灵任务面板", async () => {
    const r = makeRecorder();
    const messageId = await startSession(r, false);

    await r.notifier.updateTask({
      messageId,
      status: "running",
      milestones: [{ title: "只有 session 里程碑" }],
    });

    const md = allMarkdown(r.patched.at(-1)!);
    expect(md).toContain("只有 session 里程碑");
    // 不该凭空出现任务面板
    expect(md).not.toContain("🆔 任务 ID");
    expect(md).not.toContain("#0");
  });
});

// ===========================================================================
// 6. CV R2 回归（终态被翻回 running / 暂停丢过程步骤 / 面板不重复渲染）
// ===========================================================================

describe("Task #5384 CV R2：终态不回退 & 暂停不丢过程步骤", () => {
  /** 模拟 session 侧把卡推进到终态（真实路径：upsertSessionCard lifecycle=completed） */
  async function advanceSessionTerminal(r: Recorder): Promise<string> {
    const messageId = await startSession(r, true);
    await r.notifier.upsertSessionCard({
      chatId: CHAT,
      sessionId: SESSION,
      lifecycle: "completed",
      task: { id: TASK_ID, title: "[真机验证] #5377+#5364 卡片刷新活性" },
    });
    // ★ CV R3 MINOR-3：显式断言「推进终态没有换卡」—— upsert 必须 patch 同一张，
    //   否则下面的 updateTask(messageId) 命中不了守卫，整套断言会失真。
    expect(r.sent.length).toBe(1);
    return messageId;
  }

  test("MINOR-2：任务面板不再重复渲染同一批里程碑（顶层执行动态已展示）", async () => {
    const r = makeRecorder();
    const messageId = await startSession(r, true);
    await r.notifier.updateTask({
      messageId,
      status: "running",
      milestones: [{ title: "唯一里程碑M" }],
    });

    const last = r.patched.at(-1)!;
    // 递归数「唯一里程碑M」出现次数：只该在顶层「执行动态」出现一次
    const count = (allMarkdown(last).match(/唯一里程碑M/g) ?? []).length;
    expect(count).toBe(1);
  });

  test("MINOR-1：不带 status 的 updateTask（undefined）不得把终态翻回 running", async () => {
    const r = makeRecorder();
    const messageId = await advanceSessionTerminal(r);
    expect(headerSubtitle(r.patched.at(-1)!)).toContain("已完成");

    // 生产形状：scheduleTrailingPatch → updateTask 不带 status 的场景
    await (r.notifier as any).updateTask({
      messageId,
      milestones: [{ title: "尾沿补发的里程碑" }],
    });

    const last = r.patched.at(-1)!;
    expect(headerSubtitle(last)).toContain("已完成");
    expect(headerSubtitle(last)).not.toContain("运行中");
    expect(allMarkdown(last)).toContain("尾沿补发的里程碑");
    // 卡身份仍在
    expect(buttonTexts(last)).toContain("💬 会话查看"); // ★ Task #5420：按钮改名
  });

  test("MINOR-5：pauseTask 的过程步骤不丢（与 updateTask 路径一致）", async () => {
    const r = makeRecorder();
    const messageId = await startSession(r, false);

    await r.notifier.pauseTask({
      messageId,
      status: "stopped",
      processSteps: [
        { title: "步骤X：取证完成", description: "细节X" },
      ] as any,
      pausedMilestoneTitle: "任务已暂停",
    } as any);

    const md = allMarkdown(r.patched.at(-1)!);
    expect(md).toContain("任务已暂停");
    expect(md).toContain("步骤X：取证完成");
  });
});

// ===========================================================================
// 7. CV R4 回归（finish/update 的 processSteps 覆盖 + 建群不推进更新计数）
// ===========================================================================

describe("Task #5384 CV R4：processSteps 全路径覆盖 & 建群不改更新计数", () => {
  test("MINOR-1：finishTask 带 processSteps → 收尾过程步骤也上卡", async () => {
    const r = makeRecorder();
    const messageId = await startSession(r, false);

    await r.notifier.finishTask({
      messageId,
      status: "completed",
      finalStep: "验收通过",
      processSteps: [{ title: "步骤F：终态取证" }],
    });

    const md = allMarkdown(r.patched.at(-1)!);
    expect(md).toContain("步骤F：终态取证");
    expect(md).toContain("验收通过");
  });

  test("MINOR-1：updateTask 带 processSteps → 转成执行动态条目（不丢）", async () => {
    const r = makeRecorder();
    const messageId = await startSession(r, false);

    await r.notifier.updateTask({
      messageId,
      status: "running",
      processSteps: [{ title: "步骤U：读代码", description: "lark-card-patch-notifier.ts" }],
    });

    const md = allMarkdown(r.patched.at(-1)!);
    expect(md).toContain("步骤U：读代码");
    expect(md).toContain("lark-card-patch-notifier.ts");
  });

  test("MINOR-2：建群（updateMetaAndBuildCard）不推进「第 N 次更新」计数", async () => {
    const r = makeRecorder();
    const messageId = await startSession(r, false);

    const c1 = r.notifier.updateMetaAndBuildCard(messageId, {
      id: TASK_ID,
      perTaskChatId: "oc_g_5384",
    })!;
    const c2 = r.notifier.updateMetaAndBuildCard(messageId, {
      id: TASK_ID,
      perTaskChatId: "oc_g_5384",
    })!;

    // 两次建群重建，更新计数不应变化
    const n1 = headerSubtitle(c1).match(/第 (\d+) 次更新/)?.[1];
    const n2 = headerSubtitle(c2).match(/第 (\d+) 次更新/)?.[1];
    expect(n1).toBeDefined();
    expect(n1).toBe(n2);
  });
});
