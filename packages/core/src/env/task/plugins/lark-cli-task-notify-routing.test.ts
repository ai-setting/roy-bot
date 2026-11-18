/**
 * @fileoverview LarkCliTaskNotifyHook 卡片路由集成测试（Task #4394 简化版）
 *
 * ## 现行行为（用户 2026-10-20 明令）
 *
 * > 去掉专属群卡片逻辑，只保留触发群的进度卡片（可用户点击建群）
 *
 * 判据：
 * 1. 有触发群 → 卡片进触发群（**不**判定"是不是别的 task 的专属群"）
 * 2. 没有触发群 → 卡片进本 task / 祖先已有的专属群（兜底，不丢卡）
 * 3. 都不发"改投 / 指路"卡片（`sendRedirectNotice` 已从 notifier 删除）
 *
 * ## 已删除的旧行为（Task #4394）
 *
 * 旧实现会在"触发群是别 task 专属群"时：
 * - 调 `ensureTaskGroupChat` 新建专属群 → 卡片进新群
 * - 在触发群补一张「📂 任务卡片已改投专属群」指路卡
 *
 * 该行为已被用户明确要求删除，所有相关测试一并移除。
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { LarkCliTaskNotifyHook } from "./lark-cli-task-notify-plugin";
import { TaskHookPoints } from "../hooks/task-hook-points";
import type { HookContext } from "../../hook/types";
import type { TaskCreateResultContext } from "../hooks/contexts";
import { runWithEnvContext, type EnvContext } from "../../context";

/** 触发群（曾是 task #4377 的专属群，用户截图里的那个） */
const TRIGGER = "oc_8947d9e26125514e1ae34cf69c499380";
const OWN_GROUP = "oc_own4394group0000000000000000";
const ANCESTOR_GROUP = "oc_ancestor43890000000000000000";

function makeTask(overrides: Partial<any> = {}): any {
  return {
    id: 4393,
    title: "家长端纯 CSS 版",
    description: "描述",
    status: "active",
    priority: "high",
    type: "normal",
    progress: 0,
    current_status: "进行中",
    goals_and_expected_deliverables: "报告",
    parent_task_id: 4389,
    createdAt: "2026-10-20T07:20:00Z",
    updatedAt: "2026-10-20T07:20:00Z",
    project_path: "/tmp/proj",
    context: JSON.stringify({ child_of: 4389 }),
    ...overrides,
  };
}

function makeEnvContext(chatId?: string): EnvContext {
  return {
    envEvent: { metadata: {} },
    sourceId: "es-test",
    userId: "ou_test",
    replyChannel: chatId
      ? { chatId, messageId: "om_msg", profile: "tongzhuli" }
      : undefined,
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

describe("LarkCliTaskNotifyHook 卡片路由（Task #4394）", () => {
  let bundle: ReturnType<typeof makeNotifier>;

  beforeEach(() => {
    bundle = makeNotifier();
  });

  async function runCreate(opts: {
    chatId?: string;
    task: any;
    ports?: any;
    config?: any;
  }): Promise<ReturnType<typeof makeNotifier>> {
    const hook = new LarkCliTaskNotifyHook(opts.config);
    (hook as any).cardNotifier = bundle.notifier;
    if (opts.ports && typeof (hook as any).setCardRoutingPorts === "function") {
      (hook as any).setCardRoutingPorts(opts.ports);
    }

    await runWithEnvContext(makeEnvContext(opts.chatId), async () => {
      await hook.execute(makeCreateCtx(opts.task));
    });
    return bundle;
  }

  // ======================================================================
  // 核心：有触发群 → 永远触发群
  // ======================================================================

  it("★ 有触发群 → 卡片进触发群（即使本 task 有自己的群也不改投）", async () => {
    const b = await runCreate({
      chatId: TRIGGER,
      task: makeTask({
        context: JSON.stringify({ larkPerTaskChatId: OWN_GROUP }),
      }),
      ports: { getTask: async () => undefined },
    });

    const start = b.calls.find((c) => c.op === "start")!;
    expect(start).toBeDefined();
    expect(start.opts.chatId).toBe(TRIGGER);
    expect(start.opts.chatId).not.toBe(OWN_GROUP);
  });

  it("★ 有触发群 + 祖先有群 → 仍进触发群", async () => {
    const b = await runCreate({
      chatId: TRIGGER,
      task: makeTask(),
      ports: {
        getTask: async (id: number) =>
          id === 4389
            ? { context: JSON.stringify({ larkPerTaskChatId: ANCESTOR_GROUP }), parent_task_id: null }
            : undefined,
      },
    });

    const start = b.calls.find((c) => c.op === "start")!;
    expect(start.opts.chatId).toBe(TRIGGER);
  });

  it("★ 触发群只收到 1 张进度卡，不补发任何指路卡", async () => {
    const b = await runCreate({
      chatId: TRIGGER,
      task: makeTask(),
      ports: { getTask: async () => undefined },
    });

    expect(b.calls.filter((c) => c.op === "start")).toHaveLength(1);
    expect(b.calls.find((c) => c.op === "redirect")).toBeUndefined();
    // notifier 上已经没有 sendRedirectNotice 这个方法
    expect(
      (bundle.notifier as unknown as Record<string, unknown>)["sendRedirectNotice"]
    ).toBeUndefined();
  });

  it("★ 旧的 CardRoutingPorts.lookupChatOwnership / ensureTaskGroupChat 已不再是接口一部分", async () => {
    // 传旧端口也不应报错（duck-typing 忽略），且不影响投递目标
    const b = await runCreate({
      chatId: TRIGGER,
      task: makeTask(),
      ports: {
        lookupChatOwnership: async () => ({
          chatId: TRIGGER,
          ownerTaskIds: [4377],
          sources: ["chat-name"],
          dedicated: true,
        }),
        ensureTaskGroupChat: async () => {
          throw new Error("不该被调用（自动建群已删除）");
        },
      },
    });

    const start = b.calls.find((c) => c.op === "start")!;
    expect(start.opts.chatId).toBe(TRIGGER);
  });

  // ======================================================================
  // 兜底：没有触发群
  // ======================================================================

  it("★ 没有触发群 → 用本 task 自己的群兜底", async () => {
    const b = await runCreate({
      chatId: undefined,
      task: makeTask({
        context: JSON.stringify({ larkPerTaskChatId: OWN_GROUP }),
      }),
      ports: { getTask: async () => undefined },
    });

    const start = b.calls.find((c) => c.op === "start")!;
    expect(start).toBeDefined();
    expect(start.opts.chatId).toBe(OWN_GROUP);
  });

  it("★ 没有触发群 → 用最近祖先的群兜底", async () => {
    const b = await runCreate({
      chatId: undefined,
      task: makeTask(),
      ports: {
        getTask: async (id: number) =>
          id === 4389
            ? { context: JSON.stringify({ larkPerTaskChatId: ANCESTOR_GROUP }), parent_task_id: null }
            : undefined,
      },
    });

    const start = b.calls.find((c) => c.op === "start")!;
    expect(start).toBeDefined();
    expect(start.opts.chatId).toBe(ANCESTOR_GROUP);
  });

  it("★ 没有触发群 + 全 lineage 无群 → skip（不建群、不报错）", async () => {
    const b = await runCreate({
      chatId: undefined,
      task: makeTask(),
      ports: { getTask: async () => undefined },
    });

    expect(b.calls.find((c) => c.op === "start")).toBeUndefined();
  });

  // ======================================================================
  // 幂等：同一 task 只发一张首卡（Task #4237 能力保留）
  // ======================================================================

  it("★ 同一 task 重复触发 create → 只发一张首卡", async () => {
    const hook = new LarkCliTaskNotifyHook();
    (hook as any).cardNotifier = bundle.notifier;

    await runWithEnvContext(makeEnvContext(TRIGGER), async () => {
      await hook.execute(makeCreateCtx(makeTask()));
      await hook.execute(makeCreateCtx(makeTask()));
    });

    expect(bundle.calls.filter((c) => c.op === "start")).toHaveLength(1);
  });

  it("★ 首卡发送失败 → 后续 update 不再重试（sentinel，Task #4237 能力保留）", async () => {
    const hook = new LarkCliTaskNotifyHook();
    const calls: any[] = [];
    (hook as any).cardNotifier = {
      startTask: mock(async () => {
        calls.push("start");
        throw new Error("send failed");
      }),
      updateTask: mock(async () => {
        calls.push("update");
      }),
      finishTask: mock(async () => {}),
    };

    const updateCtx = {
      component: { name: "task", version: "1.0.0" },
      data: { task: makeTask({ id: 4393 }), changes: { progress: 20 } },
      metadata: {},
      phase: "after",
      hookPoint: TaskHookPoints.AFTER_UPDATE,
    } as unknown as HookContext<any>;

    await runWithEnvContext(makeEnvContext(TRIGGER), async () => {
      await hook.execute(makeCreateCtx(makeTask()));
      await hook.execute(updateCtx);
      await hook.execute(updateCtx);
    });

    // 只尝试发一次首卡，之后都 skip
    expect(calls.filter((c) => c === "start")).toHaveLength(1);
  });

  it("★ 进度更新 patch 同一张卡片（沿用触发群的 chatId）", async () => {
    const hook = new LarkCliTaskNotifyHook();
    (hook as any).cardNotifier = bundle.notifier;

    const updateCtx = {
      component: { name: "task", version: "1.0.0" },
      data: { task: makeTask({ progress: 50 }), changes: { progress: 50 } },
      metadata: {},
      phase: "after",
      hookPoint: TaskHookPoints.AFTER_UPDATE,
    } as unknown as HookContext<any>;

    await runWithEnvContext(makeEnvContext(TRIGGER), async () => {
      await hook.execute(makeCreateCtx(makeTask()));
      await hook.execute(updateCtx);
    });

    const start = bundle.calls.find((c) => c.op === "start")!;
    const update = bundle.calls.find((c) => c.op === "update")!;
    expect(start.opts.chatId).toBe(TRIGGER);
    expect(update).toBeDefined();
    expect(update.opts.messageId).toBe("om_card_new");
  });
});
