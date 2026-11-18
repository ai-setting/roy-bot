/**
 * @fileoverview 「卡片已改投专属群」reroute 逻辑已移除的回归测试（Task #4394）
 *
 * ## 用户要求（飞书 p2p 2026-10-20）
 *
 * > roy-bot之前的任务已经要求去掉这个专属群卡片逻辑，只保留触发群的进度卡片
 * > （可用户点击建群）的逻辑呀
 *
 * 真实 bug（用户截图）：task #4393 的进度卡片被自动改投到 lineage 群
 * `oc_d27157ac5e2f1c130dd93a5604e3a67c`，触发群
 * `oc_8947d9e26125514e1ae34cf69c499380` 收到一张标题为
 * 「📂 任务卡片已改投专属群 / 这里不是本任务的群，进展请看专属群」的灰卡。
 *
 * ## 判据（本文件逐条盯死）
 *
 * 1. **有触发群 → 卡片永远进触发群**，不管该群是不是「别的 task 的专属群」
 * 2. **不再补发任何「改投 / 指路 / 去哪看」卡片**
 * 3. **notifier 上不存在 sendRedirectNotice**（整条链路删除，不可复活）
 * 4. **buildTaskCard 的「为这个任务建群 / 解散该群」按钮必须保留**
 *    —— 用户主动点才建群，这是要保留的功能
 * 5. **没有触发群时**仍可用本 task（或祖先）的群兜底，卡片不能被丢掉
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { LarkCliTaskNotifyHook } from "./lark-cli-task-notify-plugin";
import { TaskHookPoints } from "../hooks/task-hook-points";
import type { HookContext } from "../../hook/types";
import type { TaskCreateResultContext } from "../hooks/contexts";
import { runWithEnvContext, type EnvContext } from "../../context";
import {
  decideCardChatTarget,
  type CardChatDecision,
} from "./card-chat-routing";
import { buildTaskCard, LarkCardPatchNotifier } from "./lark-card-patch-notifier";

/** 触发群 = task #4377 的专属群（用户截图里的那个） */
const TRIGGER_OWNED_BY_4377 = "oc_8947d9e26125514e1ae34cf69c499380";
/** 曾被错误改投到的 lineage 群（用户截图里的那个） */
const LINEAGE_GROUP = "oc_d27157ac5e2f1c130dd93a5604e3a67c";
/** 本 task 自己的专属群 */
const OWN_GROUP = "oc_own4394group0000000000000000";

/** 用户截图里出现的、必须彻底消失的文案 */
const FORBIDDEN_TEXTS = [
  "任务卡片已改投专属群",
  "这里不是本任务的群",
  "进展请看专属群",
  "改投 lineage",
];

// ========================================================================
// helpers（复用 lark-cli-task-notify-routing.test.ts 的脚手架）
// ========================================================================

function makeTask(overrides: Partial<any> = {}): any {
  return {
    id: 4393,
    title: "[Web] 家长端纯 CSS 版（0 JS，预览环境可用）",
    description: "描述",
    status: "active",
    priority: "high",
    type: "normal",
    progress: 10,
    current_status: "进行中",
    goals_and_expected_deliverables: "报告",
    parent_task_id: 4389,
    createdAt: "2026-10-20T07:00:00Z",
    updatedAt: "2026-10-20T07:00:00Z",
    project_path: "/tmp/proj",
    // 本 task 已经有自己的专属群 → 旧实现会「改投」到这里
    context: JSON.stringify({ larkPerTaskChatId: OWN_GROUP }),
    ...overrides,
  };
}

function makeEnvContext(chatId: string): EnvContext {
  return {
    envEvent: { metadata: {} },
    sourceId: "es-test",
    userId: "ou_test",
    replyChannel: { chatId, messageId: "om_msg", profile: "tongzhuli" },
    pluginEnabled: { "es-test:LarkCliTaskNotifyPlugin": true },
  } as unknown as EnvContext;
}

function makeCreateCtx(task: any): HookContext<TaskCreateResultContext> {
  return {
    component: { name: "task", version: "1.0.0" },
    data: { task } as unknown as TaskCreateResultContext,
    metadata: {},
    phase: "after",
    hookPoint: TaskHookPoints.AFTER_CREATE,
  } as unknown as HookContext<TaskCreateResultContext>;
}

function makeNotifier() {
  const calls: any[] = [];
  return {
    notifier: {
      startTask: mock(async (opts: any) => {
        calls.push({ op: "start", opts });
        return { messageId: "om_card_new", pinned: true };
      }),
      updateTask: mock(async (opts: any) => {
        calls.push({ op: "update", opts });
      }),
      finishTask: mock(async (opts: any) => {
        calls.push({ op: "finish", opts });
      }),
    },
    calls,
  };
}

/**
 * 旧实现用的「触发群是别 task 的专属群」证据（Task #4230 的 ChatOwnership）
 *
 * 现在 `decideCardChatTarget` 已经不再接收 ownership（整条判定链路删除），
 * 这里用 `as any` 透传，确保**即使有人再传进来也不会改变投递目标**。
 */
function foreignOwnership(): any {
  return {
    chatId: TRIGGER_OWNED_BY_4377,
    ownerTaskIds: [4377],
    sources: ["#4377:larkPerTaskChatId", "chat-name"],
    chatName: "Task 4377 - xxx",
    dedicated: true,
  };
}

describe("Task #4394 / 卡片永不改投专属群", () => {
  let notifierBundle: ReturnType<typeof makeNotifier>;

  beforeEach(() => {
    notifierBundle = makeNotifier();
  });

  it("★ 触发群是别 task 的专属群 + 本 task 已有自己的群 → 卡片仍进触发群（不改投 lineage 群）", async () => {
    const hook = new LarkCliTaskNotifyHook();
    (hook as any).cardNotifier = notifierBundle.notifier;
    // 旧实现的端口（如果还被调用，就会把卡片改投到 OWN_GROUP）
    if (typeof (hook as any).setCardRoutingPorts === "function") {
      (hook as any).setCardRoutingPorts({
        lookupChatOwnership: async () => foreignOwnership(),
        getTask: async (id: number) =>
          id === 4389 ? { context: "{}", parent_task_id: null } : undefined,
        ensureTaskGroupChat: async () => ({ chatId: LINEAGE_GROUP }),
      });
    }

    await runWithEnvContext(makeEnvContext(TRIGGER_OWNED_BY_4377), async () => {
      await hook.execute(makeCreateCtx(makeTask()));
    });

    const start = notifierBundle.calls.find((c) => c.op === "start");
    expect(start).toBeDefined();
    // 判据 1：卡片目标 = 触发群，绝不是 OWN_GROUP / LINEAGE_GROUP
    expect(start!.opts.chatId).toBe(TRIGGER_OWNED_BY_4377);
    expect(start!.opts.chatId).not.toBe(OWN_GROUP);
    expect(start!.opts.chatId).not.toBe(LINEAGE_GROUP);
  });

  it("★ 不再补发任何「改投 / 指路」卡片（触发群只收到正常进度卡）", async () => {
    const hook = new LarkCliTaskNotifyHook();
    (hook as any).cardNotifier = notifierBundle.notifier;
    if (typeof (hook as any).setCardRoutingPorts === "function") {
      (hook as any).setCardRoutingPorts({
        lookupChatOwnership: async () => foreignOwnership(),
      });
    }

    await runWithEnvContext(makeEnvContext(TRIGGER_OWNED_BY_4377), async () => {
      await hook.execute(makeCreateCtx(makeTask()));
    });

    // 判据 2：只有一张首卡，没有 redirect / 第二张卡
    expect(notifierBundle.calls.filter((c) => c.op === "start")).toHaveLength(1);
    expect(notifierBundle.calls.find((c) => c.op === "redirect")).toBeUndefined();
  });

  it("★ notifier 不再暴露 sendRedirectNotice（整条链路删除，不可复活）", () => {
    const notifier = new LarkCardPatchNotifier();
    // 判据 3：方法不存在 = 谁也没法再发那张「已改投专属群」卡
    expect(
      (notifier as unknown as Record<string, unknown>)["sendRedirectNotice"]
    ).toBeUndefined();
  });

  it("★ 卡片 JSON 里永不出现「已改投专属群」类文案", async () => {
    const hook = new LarkCliTaskNotifyHook();
    (hook as any).cardNotifier = notifierBundle.notifier;
    if (typeof (hook as any).setCardRoutingPorts === "function") {
      (hook as any).setCardRoutingPorts({
        lookupChatOwnership: async () => foreignOwnership(),
      });
    }

    await runWithEnvContext(makeEnvContext(TRIGGER_OWNED_BY_4377), async () => {
      await hook.execute(makeCreateCtx(makeTask()));
    });

    const start = notifierBundle.calls.find((c) => c.op === "start");
    const serialized = JSON.stringify(start!.opts);
    for (const bad of FORBIDDEN_TEXTS) {
      expect(serialized).not.toContain(bad);
    }
  });

  // ======================================================================
  // 保留项：用户主动点的「建群」按钮不能因为删 reroute 而丢
  // ======================================================================

  it("★【保留】无专属群时卡片顶部有「为这个任务建群」按钮（action=create_group）", () => {
    const card = buildTaskCard({
      status: "running",
      meta: { id: 4393, title: "家长端纯 CSS 版" },
      milestones: [],
    });
    const raw = JSON.stringify(card);
    expect(raw).toContain("为这个任务建群");
    expect(raw).toContain('"action":"create_group"');
    expect(raw).toContain('"taskId":"4393"');
  });

  it("★【保留】已有专属群时按钮变「解散该群」+ 下方有进入群链接", () => {
    const card = buildTaskCard({
      status: "running",
      meta: {
        id: 4393,
        title: "家长端纯 CSS 版",
        perTaskChatId: OWN_GROUP,
        perTaskChatName: "Task 4393 - 家长端",
      },
      milestones: [],
    });
    const raw = JSON.stringify(card);
    expect(raw).toContain("解散该群");
    expect(raw).toContain('"action":"disband_group"');
    expect(raw).toContain("进入专属群");
    expect(raw).toContain(OWN_GROUP);
  });

  // ======================================================================
  // 决策函数：有触发群 → 永远触发群
  // ======================================================================

  it("★ decideCardChatTarget：即使传进来 ownership 说「是别 task 的群」，也返回触发群", () => {
    const d: CardChatDecision = decideCardChatTarget({
      taskId: 4393,
      lineageIds: [4393, 4389],
      lineageChat: { chatId: OWN_GROUP, profile: "tongzhuli", isSelf: true },
      triggerChatId: TRIGGER_OWNED_BY_4377,
      triggerProfile: "tongzhuli",
      // 旧字段（已删除），用 any 透传，验证它不再影响决策
      triggerOwnership: foreignOwnership(),
      allowNewGroup: true,
    } as any);

    expect(d.source).toBe("trigger-chat");
    expect(d.chatId).toBe(TRIGGER_OWNED_BY_4377);
    expect((d as any).reroutedFrom).toBeUndefined();
  });

  it("★ decideCardChatTarget：没有触发群 → 用本 task 自己的群兜底（卡片不能丢）", () => {
    const d = decideCardChatTarget({
      taskId: 4393,
      lineageIds: [4393, 4389],
      lineageChat: { chatId: OWN_GROUP, profile: "tongzhuli", isSelf: true },
      triggerChatId: undefined,
    });
    expect(d.chatId).toBe(OWN_GROUP);
    expect(d.source).toBe("own-group");
  });

  it("★ decideCardChatTarget：触发群和本 task 群都没有 → none（caller 静默 skip）", () => {
    const d = decideCardChatTarget({ taskId: 4393, lineageIds: [4393] });
    expect(d.source).toBe("none");
    expect(d.chatId).toBeUndefined();
  });

  it("★ decideCardChatTarget：普通触发群 → 触发群（happy path 不回归）", () => {
    const d = decideCardChatTarget({
      taskId: 4393,
      lineageIds: [4393],
      triggerChatId: TRIGGER_OWNED_BY_4377,
      triggerProfile: "tongzhuli",
    });
    expect(d.source).toBe("trigger-chat");
    expect(d.chatId).toBe(TRIGGER_OWNED_BY_4377);
    expect(d.profile).toBe("tongzhuli");
  });
});
