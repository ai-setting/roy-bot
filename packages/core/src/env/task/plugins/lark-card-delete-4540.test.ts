/**
 * @fileoverview Task #4540 — 取消（删除）任务后卡片 / pin 收尾
 *
 * ## 用户真机反馈
 * > 「我测试创建了一个任务，然后又取消了他。但是这个卡片消息没有变化，然后这个
 * >   pin也没有取消。」
 *
 * ## 根因（两条）
 * A. 用户「取消」实际走 `TaskComponent.deleteTask()`（**硬删除**），不是
 *    `updateTask(status="cancelled")` —— 所以 `AFTER_UPDATE` 不触发。
 * B. `getPluginHookPoints()` 兜底白名单只有 4 个点，**缺 `task:after.delete`**
 *    → `LarkCliTaskNotifyHook` 即使 `execute()` 里写了 case 也收不到事件。
 *
 * ## 本文件覆盖（9 项）
 * 1. after.delete 且 deleted=true → patch 被调用（终态文案 + 原 messageId）
 * 2. after.delete → unpin 被调用且**带 `--yes`**
 * 3. deleted=false → 既不 patch 也不 unpin
 * 4. 卡片记录缺失 → 优雅 skip（不抛、不发新卡）
 * 5. patch 失败 → warn 降级不抛
 * 6. unpin 失败 → warn 降级不抛
 * 7. 持久化状态变 `closed` + `closed_at` 有值
 * 8. 集成：`getPluginHookPoints()` 对 task 通知插件返回含 `task:after.delete`
 * 9. 回归：其它插件 hook 点集合无意外变化（显式 hookPoints 优先、TaskTagPlugin）
 */

import { describe, it, expect } from "bun:test";
import { mock } from "bun:test";

import {
  LarkCliTaskNotifyHook,
  createLarkCliTaskNotifyHook,
} from "./lark-cli-task-notify-plugin";
import { LarkCardPatchNotifier } from "./lark-card-patch-notifier";
import { MemoryLarkCardStateStore } from "./lark-card-state-store";
import { TaskHookPoints } from "../hooks/task-hook-points";
import type { HookContext } from "../../hook/types";
import type {
  TaskCreateResultContext,
  TaskDeleteResultContext,
} from "../hooks/contexts";
import { runWithEnvContext, type EnvContext } from "../../context";

// ============================================================================
// Helpers
// ============================================================================

const TASK_ID = 4539;
const MESSAGE_ID = "om_x100b62e91284f0a4cf45d84bfdc355b";
const CHAT_ID = "oc_20ea15b1276eb336a60757bfabdd43f9";
const PROFILE = "default";

function makeTask(overrides: Partial<any> = {}): any {
  return {
    id: TASK_ID,
    title: "取消后卡片要更新",
    description: "desc",
    status: "todo",
    priority: "high",
    type: "normal",
    progress: 0,
    current_status: "待开始",
    createdAt: "2026-10-25T10:10:00Z",
    updatedAt: "2026-10-25T10:10:00Z",
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
    replyChannel: { chatId: CHAT_ID, messageId: "om_inbound" },
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

/**
 * 带 spy 的 notifier。
 *
 * ★ 关键：`runLarkCli` 是**唯一**的 lark-cli 出口，patch / unpin 都从这里走
 *   （`finishTask` 内部用 `this.runLarkCli`）。为了能断言「到底跑了哪几条命令」，
 *   我们在实例级把 `runLarkCli` 换成 spy —— 这样拿到的是**真实 argv**，
 *   而不是被 mock 掉的高层方法返回值（更能证伪）。
 */
function makeSpyNotifier(opts: { patchFails?: boolean; unpinFails?: boolean } = {}) {
  const notifier = new LarkCardPatchNotifier();
  const calls: Array<{ args: string[]; kind: string }> = [];

  (notifier as any).runLarkCli = mock(async (args: string[], kind: string) => {
    calls.push({ args, kind });
    if (opts.patchFails && (kind === "patch" || args.includes("patch"))) {
      throw new Error("simulated patch failure");
    }
    if (opts.unpinFails && kind === "unpin") {
      throw new Error("simulated unpin failure");
    }
    return "";
  });

  return { notifier, calls };
}

/** 发过一张卡之后的 store（模拟「卡片已存在且之前置顶」） */
function seedStore(overrides: Partial<any> = {}) {
  const store = new MemoryLarkCardStateStore();
  store.upsert({
    taskId: TASK_ID,
    messageId: MESSAGE_ID,
    chatId: CHAT_ID,
    profile: PROFILE,
    pinned: true,
    status: "open",
    createdAt: 1_792_923_078_021,
    updatedAt: 1_792_923_078_021,
    ...overrides,
  } as any);
  return store;
}

function makeHook(
  notifier: LarkCardPatchNotifier,
  store: MemoryLarkCardStateStore
) {
  return new LarkCliTaskNotifyHook({
    cardMode: true,
    cardNotifier: notifier,
    cardStateStore: store,
  });
}

/** 触发一次 `task:after.delete` */
async function fireDelete(
  hook: LarkCliTaskNotifyHook,
  data: TaskDeleteResultContext = { id: TASK_ID, deleted: true }
): Promise<void> {
  const ctx = makeHookContext(TaskHookPoints.AFTER_DELETE, data);
  await runWithEnvContext(makeEnvContext(), async () => {
    await hook.execute(ctx);
  });
}

// ============================================================================
// 1–2. 核心：delete → patch + unpin
// ============================================================================

describe("Task #4540 after.delete → 卡片收尾", () => {
  it("1. deleted=true → patch 原卡片（不重新发卡）", async () => {
    const { notifier, calls } = makeSpyNotifier();
    const store = seedStore();
    const hook = makeHook(notifier, store);

    await fireDelete(hook);

    const patchCalls = calls.filter((c) => c.args.includes("messages") && c.args.includes("patch"));
    expect(patchCalls).toHaveLength(1);

    const patchArgs = patchCalls[0].args;
    // 必须 patch 的是**原来的**那条卡片消息
    expect(patchArgs).toContain(MESSAGE_ID);
    // 绝不能重新发一张卡
    expect(calls.some((c) => c.args.includes("+messages-send"))).toBe(false);
    // profile 必须带上（default profile 的 p2p 群）
    expect(patchArgs[patchArgs.indexOf("--profile") + 1]).toBe(PROFILE);
  });

  it("2. deleted=true → unpin 且 argv 带 --yes（high-risk-write 必须）", async () => {
    const { notifier, calls } = makeSpyNotifier();
    const store = seedStore();
    const hook = makeHook(notifier, store);

    await fireDelete(hook);

    const unpinCalls = calls.filter(
      (c) => c.args.includes("pins") && c.args.includes("delete")
    );
    // ★ xval MINOR-1：两条 —— finishTask 内部一条 + onAfterDelete 显式补一条。
    //   后者是必须的：内部那条的异常会被 finishTask 自己 try/catch 吞掉，
    //   如果不在外面再试一次，"unpin 失败"就永远不会被重试（正是用户报的现象）。
    expect(unpinCalls.length).toBeGreaterThanOrEqual(1);
    // 每一条都必须带 --yes，且指向同一条消息
    for (const c of unpinCalls) {
      const args = c.args;
      expect(args).toContain("--message-id");
      expect(args[args.indexOf("--message-id") + 1]).toBe(MESSAGE_ID);
      expect(args).toContain("--yes");
    }
  });
});

// ============================================================================
// 3. deleted=false 不动作
// ============================================================================

describe("Task #4540 deleted=false 不动作", () => {
  it("3. deleted=false → 既不 patch 也不 unpin", async () => {
    const { notifier, calls } = makeSpyNotifier();
    const store = seedStore();
    const hook = makeHook(notifier, store);

    await fireDelete(hook, { id: TASK_ID, deleted: false });

    expect(calls).toHaveLength(0);
    // 记录也不能被翻成 closed（删除失败 = 任务还在）
    expect(store.get(TASK_ID)!.status).toBe("open");
  });
});

// ============================================================================
// 4. 记录缺失 → 优雅 skip
// ============================================================================

describe("Task #4540 记录缺失优雅降级", () => {
  it("4. 卡片记录缺失 → skip：不抛错、不发新卡、不 unpin", async () => {
    const { notifier, calls } = makeSpyNotifier();
    const store = new MemoryLarkCardStateStore(); // 空 store
    const hook = makeHook(notifier, store);

    // 不抛
    await fireDelete(hook);

    expect(calls).toHaveLength(0);
  });

  it("4b. 记录存在但 messageId 为空 → 同样 skip", async () => {
    const { notifier, calls } = makeSpyNotifier();
    const store = seedStore({ messageId: "" });
    const hook = makeHook(notifier, store);

    await fireDelete(hook);

    expect(calls).toHaveLength(0);
  });
});

// ============================================================================
// 5–6. 失败降级
// ============================================================================

describe("Task #4540 patch / unpin 失败降级", () => {
  it("5. patch 失败 → warn 降级不抛，仍尝试 unpin", async () => {
    const { notifier, calls } = makeSpyNotifier({ patchFails: true });
    const store = seedStore();
    const hook = makeHook(notifier, store);

    // 不抛
    await fireDelete(hook);

    // unpin 仍要尝试（卡片虽然没改成终态，但 pin 一定要取消）
    expect(
      calls.some((c) => c.args.includes("pins") && c.args.includes("delete"))
    ).toBe(true);
  });

  it("6. unpin 失败 → warn 降级不抛", async () => {
    const { notifier } = makeSpyNotifier({ unpinFails: true });
    const store = seedStore();
    const hook = makeHook(notifier, store);

    await fireDelete(hook); // 不抛即通过
    expect(store.get(TASK_ID)!.status).toBe("closed");
  });
});

// ============================================================================
// 7. 持久化状态
// ============================================================================

describe("Task #4540 持久化状态 closed", () => {
  it("7. delete 成功后记录翻 closed + closed_at 有值 + pinned=false", async () => {
    const { notifier } = makeSpyNotifier();
    const store = seedStore();
    const hook = makeHook(notifier, store);

    await fireDelete(hook);

    const rec = store.get(TASK_ID)!;
    expect(rec.status).toBe("closed");
    expect(rec.closedAt).toBeDefined();
    expect(typeof rec.closedAt).toBe("number");
    expect(rec.pinned).toBe(false);
    // messageId 保留（便于事后追溯）
    expect(rec.messageId).toBe(MESSAGE_ID);
  });
});

// ============================================================================
// 8–9. 集成：hook 点注册
// ============================================================================

describe("Task #4540 getPluginHookPoints 注册 task:after.delete", () => {
  /**
   * 造一个最小的 LarkCliInstance 实例（只测 getPluginHookPoints 这个纯函数）。
   * 用真实的 factory 产物，避免 fake 对象与真实插件脱节。
   */
  function makeInstance() {
    // 延迟 require，避免顶层 import 拉起整个 event-source 依赖图
    const mod = require("../../event-source/event-source-handlers");
    const InstanceCls =
      mod.LarkCliInstance ?? mod.LarkCliEventSourceHandler ?? mod.default;
    const inst = Object.create(InstanceCls.prototype);
    inst.config = { id: "es-test-1", handleRule: {} };
    return inst as any;
  }

  it("8. 真实 task 通知插件 → hook 点含 task:after.delete", () => {
    const inst = makeInstance();
    const plugin = createLarkCliTaskNotifyHook({ pluginName: "LarkCliTaskNotifyPlugin" });

    const points: string[] = inst.getPluginHookPoints(plugin);
    expect(points).toContain("task:after.delete");
    // 既有 4 个点一个都不能少（回归）
    expect(points).toContain("task:after.create");
    expect(points).toContain("task:after.update");
    expect(points).toContain("task:operation:after.create");
    expect(points).toContain("task:after.complete");
  });

  it("9. 显式声明 hookPoints 的插件 → 白名单不生效（不被污染）", () => {
    const inst = makeInstance();
    const fake = {
      name: "LarkCliWorkflowNotifyPlugin",
      execute: () => {},
      hookPoints: ["workflow:before.run", "workflow:after.run"],
    };

    const points: string[] = inst.getPluginHookPoints(fake);
    expect(points).toEqual(["workflow:before.run", "workflow:after.run"]);
    expect(points).not.toContain("task:after.delete");
  });
});

// ============================================================================
// 10. 文案契约（破坏性自检 S12 补洞：原来只断言 patch 被调用，没断言文案）
// ============================================================================

describe("Task #4540 卡片终态文案", () => {
  /** 从 patch argv 里取出卡片 JSON（--data 的 content 是二次 stringify） */
  function extractCard(calls: Array<{ args: string[]; kind: string }>): any {
    const patch = calls.find((c) => c.args.includes("patch"));
    expect(patch).toBeDefined();
    const args = patch!.args;
    const dataIdx = args.indexOf("--data");
    expect(dataIdx).toBeGreaterThan(-1);
    const outer = JSON.parse(args[dataIdx + 1]);
    return JSON.parse(outer.content);
  }

  it("10. 删除后卡片文案是「已删除」，不是「已取消」/「已完成」", async () => {
    const { notifier, calls } = makeSpyNotifier();
    const store = seedStore();
    const hook = makeHook(notifier, store);

    await fireDelete(hook);

    const card = extractCard(calls);
    const raw = JSON.stringify(card);

    // 与 cancelled（🚫 已取消）明确区分：任务实体已从库消失
    expect(raw).toContain("已删除");
    expect(raw).not.toContain("🚫 已取消");
    expect(raw).not.toContain("全部完成");
    // header 灰底（终态不抢眼）
    expect(card.header.template).toBe("grey");
  });

  it("10b. 终态里程碑是「Task 已删除」而非「Task 已取消」", async () => {
    const { notifier, calls } = makeSpyNotifier();
    const store = seedStore();
    const hook = makeHook(notifier, store);

    await fireDelete(hook);

    const raw = JSON.stringify(extractCard(calls));
    expect(raw).toContain("Task 已删除");
    expect(raw).not.toContain("Task 已取消");
  });
});

// ============================================================================
// 11. 终态卡片不得同时出现「已删除」与「进行中」（真机 E2E 发现的矛盾）
// ============================================================================

describe("Task #4540 终态卡片进度文案一致性", () => {
  function extractCardRaw(calls: Array<{ args: string[]; kind: string }>): string {
    const patch = calls.find((c) => c.args.includes("patch"))!;
    const args = patch.args;
    const outer = JSON.parse(args[args.indexOf("--data") + 1]);
    return outer.content as string;
  }

  it("11. deleted 终态卡片不能出现「尚未上报百分比」/「进行中」", async () => {
    const { notifier, calls } = makeSpyNotifier();
    const store = seedStore();
    const hook = makeHook(notifier, store);

    await fireDelete(hook);

    const raw = extractCardRaw(calls);
    expect(raw).not.toContain("尚未上报百分比");
    expect(raw).toContain("任务已取消（删除）");
  });
});

// ============================================================================
// 12. xval MINOR-1：finishTask 内部吞掉 unpin 失败时，外层必须重试一次
// ============================================================================

describe("Task #4540 unpin 失败必须重试（xval MINOR-1）", () => {
  it("12. finishTask 内部 unpin 静默失败 → 外层仍再试一次 unpin", async () => {
    // 构造：patch 成功，但**只有第 1 次** unpin 失败（模拟 finishTask 内部那条）
    // ★ Task #5164 R2a：默认不 unpin，但 delete 收尾仍走 unpin ——
    //   显式 unpinOnFinish=true 保留本契约（删除语义下 pin 必须取消）
    const notifier = new LarkCardPatchNotifier({ unpinOnFinish: true });
    const calls: Array<{ args: string[]; kind: string }> = [];
    let unpinAttempts = 0;

    (notifier as any).runLarkCli = mock(async (args: string[], kind: string) => {
      calls.push({ args, kind });
      if (kind === "unpin") {
        unpinAttempts++;
        if (unpinAttempts === 1) {
          // ← finishTask 内部的 unpin 抛错，但会被它自己 catch 掉 → 静默失败
          throw new Error("simulated transient unpin failure");
        }
      }
      return "";
    });

    const store = seedStore();
    const hook = makeHook(notifier, store);

    await fireDelete(hook);

    // 关键断言：unpin 被尝试了 **至少 2 次**（内部 1 次失败 + 外层重试 1 次成功）
    expect(unpinAttempts).toBeGreaterThanOrEqual(2);
  });
});
