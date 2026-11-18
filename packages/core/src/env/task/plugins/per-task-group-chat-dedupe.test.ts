/**
 * @fileoverview 专属群「单一 owner + 幂等」回归测试
 *
 * 对应真实故障（2026-10-15，Task #4231 / #4235）：
 * 同一个 task 出现 **两个同名专属群**、**3 张卡片**、触发群收到 **2 张改投卡片**。
 *
 * 根因（双 trace 实证）：
 * 1. 两条建群路径都调 `createGroupChat` 且互不知道对方建过群：
 *    - `LarkCliTaskNotifyHook.resolveCardTarget(source=new-group)` → `PerTaskGroupChatPlugin.ensureGroupChat`
 *    - `PerTaskGroupChatPlugin.onAfterCreate`
 * 2. `onAfterCreate` 自己还发一张初始卡片（→ 同 task 多卡 + 双 notifier 各自 patch）。
 * 3. `ensureGroupChat → attachChatIdToTask → taskComponent.updateTask` 同步触发
 *    `task:after.update` → notify hook 重入 → fallback 再补卡 + 再发改投卡片。
 *
 * 本文件锁定修复后的三条不变量：
 * - **一个 task 只建一个群**（第二次调用/并发调用/已有 context 都复用，不重建）
 * - **首张卡片只有一个 owner**（本插件不再发初始卡片，交给 LarkCliTaskNotifyHook）
 * - 建群幂等不依赖调用方顺序（谁先跑都只建一个）
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { PerTaskGroupChatPlugin } from "./per-task-group-chat-plugin";
import { TaskHookPoints } from "../hooks/task-hook-points";
import type { HookContext } from "../../hook/types";
import type { TaskCreateResultContext } from "../hooks/contexts";
import { runWithEnvContext, type EnvContext } from "../../context";

function makeEnvContext(): EnvContext {
  return {
    envEvent: { metadata: {} },
    sourceId: "es-dedupe",
    userId: "ou_user",
    replyChannel: { chatId: "oc_trigger", messageId: "om_msg", profile: "tongzhuli" },
    pluginEnabled: { "es-dedupe:PerTaskGroupChatPlugin": true },
  } as unknown as EnvContext;
}

function makeTask(overrides: Record<string, unknown> = {}): any {
  return {
    id: 4235,
    title: "GitHub 热门 opencode 插件项目调研",
    description: "检索并产出报告",
    status: "active",
    priority: "high",
    type: "normal",
    progress: 0,
    current_status: "进行中",
    goals_and_expected_deliverables: "报告",
    parent_task_id: undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    project_path: "/tmp/proj",
    context: "{}",
    ...overrides,
  };
}

interface Harness {
  plugin: PerTaskGroupChatPlugin;
  createCalls: Array<{ name: string }>;
  cardCalls: Array<Record<string, unknown>>;
  attachCalls: Array<{ taskId: number; chatId: string }>;
  bindings: Array<{ status: string }>;
}

/** 造一个真插件 + 打桩 createGroupChat / notifier / taskUpdater / sessionComponent */
function makeHarness(opts: { chatIdFactory?: () => string } = {}): Harness {
  const plugin = new PerTaskGroupChatPlugin({ pluginName: "PerTaskGroupChatPlugin", sourceId: "es-dedupe", autoCreateGroup: true });
  const createCalls: Array<{ name: string }> = [];
  const cardCalls: Array<Record<string, unknown>> = [];
  const attachCalls: Array<{ taskId: number; chatId: string }> = [];
  const bindings: Array<{ status: string }> = [];

  let seq = 0;
  (plugin as any).createGroupChat = async (o: any) => {
    createCalls.push({ name: o.name });
    return opts.chatIdFactory ? opts.chatIdFactory() : `oc_group_${++seq}`;
  };
  (plugin as any).cardNotifier = {
    startTask: async (o: any) => {
      cardCalls.push(o);
      return { messageId: "om_card_x", pinned: true };
    },
    updateTask: async () => {},
    finishTask: async () => {},
  };
  plugin.setTaskUpdater(async (taskId: number, context: string) => {
    const chatId = JSON.parse(context).larkPerTaskChatId;
    attachCalls.push({ taskId, chatId });
    // 模拟真实链路：写 DB 后 in-memory task.context 也要更新（否则同链路后续看不到）
    return undefined;
  });
  plugin.setSessionComponent({
    upsertChatTaskBinding: async (o: any) => {
      bindings.push({ status: o.status });
      return { ...o, boundAt: "x", errorMessage: null, rebindCount: 0 };
    },
  } as any);

  return { plugin, createCalls, cardCalls, attachCalls, bindings };
}

describe("专属群幂等：一个 task 只建一个群（Task #4237 修复）", () => {
  it("ensureGroupChat 连调两次 → createGroupChat 只调一次（第二次复用 context 里的群）", async () => {
    const h = makeHarness();
    const task = makeTask();

    const first = await runWithEnvContext(makeEnvContext(), async () =>
      h.plugin.ensureGroupChat(task)
    );
    // 模拟真实链路：建群后 chatId 落进 task.context（attachChatIdToTask 的副作用）
    task.context = JSON.stringify({
      larkPerTaskChatId: first!.chatId,
      larkPerTaskChatProfile: "tongzhuli",
    });
    const second = await runWithEnvContext(makeEnvContext(), async () =>
      h.plugin.ensureGroupChat(task)
    );

    expect(first?.chatId).toBeTruthy();
    expect(second?.chatId).toBe(first?.chatId);
    expect(h.createCalls.length).toBe(1); // ★ 只建一个群
  });

  it("ensureGroupChat 并发（同一 task 同时两次）→ createGroupChat 只调一次", async () => {
    const h = makeHarness();
    const task = makeTask();

    const [a, b] = await runWithEnvContext(makeEnvContext(), async () =>
      Promise.all([h.plugin.ensureGroupChat(task), h.plugin.ensureGroupChat(task)])
    );

    expect(a?.chatId).toBeTruthy();
    expect(b?.chatId).toBe(a?.chatId);
    expect(h.createCalls.length).toBe(1); // ★ in-flight 去重
  });

  it("task.context 已有 larkPerTaskChatId → 直接复用，不建群（不依赖调用顺序）", async () => {
    const h = makeHarness();
    const task = makeTask({
      context: JSON.stringify({
        larkPerTaskChatId: "oc_existing_group",
        larkPerTaskChatProfile: "tongzhuli",
      }),
    });

    const r = await runWithEnvContext(makeEnvContext(), async () =>
      h.plugin.ensureGroupChat(task)
    );

    expect(r?.chatId).toBe("oc_existing_group");
    expect(h.createCalls.length).toBe(0);
  });

  it("onAfterCreate：task 已有专属群 → 不再重复建群（Bug 2 回归）", async () => {
    const h = makeHarness();
    const task = makeTask({
      context: JSON.stringify({
        larkPerTaskChatId: "oc_already_created",
        larkPerTaskChatProfile: "tongzhuli",
      }),
    });
    const ctx = {
      hookPoint: TaskHookPoints.AFTER_CREATE,
      data: { task },
      metadata: {},
    } as unknown as HookContext<TaskCreateResultContext>;

    await runWithEnvContext(makeEnvContext(), async () =>
      h.plugin.execute(ctx)
    );

    expect(h.createCalls.length).toBe(0);
  });

  it("onAfterCreate 之后 ensureGroupChat 仍复用同一个群（跨路径去重）", async () => {
    const h = makeHarness();
    const task = makeTask();
    const ctx = {
      hookPoint: TaskHookPoints.AFTER_CREATE,
      data: { task },
      metadata: {},
    } as unknown as HookContext<TaskCreateResultContext>;

    await runWithEnvContext(makeEnvContext(), async () => h.plugin.execute(ctx));
    const createdByHook = h.createCalls.length;
    expect(createdByHook).toBe(1);

    // 插件建群后应把 chatId 写回 in-memory task.context（供同链路后续复用）
    const ctxChatId = JSON.parse(task.context).larkPerTaskChatId;
    expect(ctxChatId).toBeTruthy();

    const r = await runWithEnvContext(makeEnvContext(), async () =>
      h.plugin.ensureGroupChat(task)
    );
    expect(r?.chatId).toBe(ctxChatId);
    expect(h.createCalls.length).toBe(1); // ★ 没有第二个群
  });
});

describe("首张卡片只有一个 owner（Task #4237 修复）", () => {
  it("onAfterCreate 不再自己发初始卡片（卡片交给 LarkCliTaskNotifyHook）", async () => {
    const h = makeHarness();
    const task = makeTask();
    const ctx = {
      hookPoint: TaskHookPoints.AFTER_CREATE,
      data: { task },
      metadata: {},
    } as unknown as HookContext<TaskCreateResultContext>;

    await runWithEnvContext(makeEnvContext(), async () => h.plugin.execute(ctx));

    expect(h.createCalls.length).toBe(1); // 群照建
    expect(h.cardCalls.length).toBe(0); // ★ 但不再自己发卡（避免同 task 多卡）
  });

  it("ensureGroupChat 只建群不发卡（保持既有语义）", async () => {
    const h = makeHarness();
    await runWithEnvContext(makeEnvContext(), async () =>
      h.plugin.ensureGroupChat(makeTask())
    );
    expect(h.cardCalls.length).toBe(0);
  });
});
