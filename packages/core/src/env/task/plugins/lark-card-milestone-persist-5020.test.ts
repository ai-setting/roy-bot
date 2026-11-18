/**
 * @fileoverview Task #5020 — operation 里程碑必须落进共享 ledger 的 timeline
 *
 * ## 缺陷（真飞书卡片 #5010 实测）
 *
 * agent 确实调用了 `task_operation_create` 记了 3 条里程碑（store 里查得到，
 * ids 38125 / 38128 / 38129），但卡片「里程碑序列」区一条都没有 —— 只有
 * 系统自动钩子的「Task 完成」。
 *
 * ## 根因（跨进程状态分裂）
 *
 * daemon 进程与 MCP server 进程**各持一份** `LarkCardPatchNotifier`，
 * 各自的内存 `states` Map 互不相通：
 *
 * 1. **MCP 进程**持有 `task:operation:after.create` hook
 *    （`claude/mcp/task-notify-hooks.mjs` → core 的
 *    `LarkCliTaskNotifyHook.onAfterOperationCreate`）。agent 每记一条
 *    operation，它就 `cardNotifier.updateTask({ milestones })` 累积一次。
 *    —— 这条链**完全正常**，agent 的里程碑确实进了 MCP 进程的内存态。
 *
 * 2. **但 `onAfterOperationCreate` 从不把累积结果落进持久层。**
 *    `refreshTimeline()` 只有两个调用点：`sendCardUpdate`（:1369）与
 *    `sendCardFinish`（:1438）。operation 这条路径**一个都没有**。
 *    ⇒ MCP 进程内存里的 agent 里程碑**从不进 `lark-cards.db`**。
 *
 * 3. **daemon 进程**收尾时用**自己那份残缺的 state** 重建整张卡
 *    （core `LarkCardPatchNotifier.finishTask` 用
 *    `mergeUnique(state?.milestones ?? [], [finalMilestone])`）。
 *    daemon 的 state 里只有它自己知道的里程碑（通常是 0 条），
 *    ⇒ agent 的 3 条里程碑被**整体替换**掉，只剩终态那一条。
 *
 * 实证：任务 #5010 的 ledger 快照 = `milestones:["Task 创建"]`、
 * `processSteps:[]`、`updateCount:1` —— 只有建卡那一次落过库。
 *
 * ## 本文件的断言
 *
 * `onAfterOperationCreate` 之后，ledger 的 `timeline` 快照必须包含
 * agent 那条 operation 的里程碑 —— 这样任何**别的进程**（daemon）
 * 都能从 ledger 回填出完整时间线。
 *
 * @see lark-cli-task-notify-plugin.ts onAfterOperationCreate
 */

import { describe, it, expect } from "bun:test";
import { LarkCliTaskNotifyHook } from "./lark-cli-task-notify-plugin";
import { LarkCardPatchNotifier } from "./lark-card-patch-notifier";
import { MemoryLarkCardStateStore } from "./lark-card-state-store";
import { TaskHookPoints } from "../hooks/task-hook-points";
import type { HookContext } from "../../hook/types";
import type { TaskCreateResultContext } from "../hooks/contexts";
import { runWithEnvContext, type EnvContext } from "../../context";

// ============================================================================
// Helpers
// ============================================================================

function makeTask(overrides: Partial<any> = {}): any {
  return {
    id: 5010,
    title: "实现 reverseString 工具函数（含单元测试）",
    description: "desc",
    status: "active",
    priority: "high",
    type: "normal",
    progress: 50,
    current_status: "进行中",
    createdAt: "2026-11-05T08:30:15.089Z",
    updatedAt: "2026-11-05T08:31:00.000Z",
    project_path: "/tmp/e2e",
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
  } as unknown as HookContext<T>;
}

/**
 * A notifier whose `updateTask` really accumulates into the in-memory state
 * (so `exportState` returns the timeline), but whose transport is stubbed.
 *
 * The stub also records every rendered card, so a test can assert on what
 * the **user would see** (the milestone lines in the card body).
 */
const capturedCards: any[] = [];

function makeRealStateNotifier(messageId = "om_card_test") {
  const notifier = new LarkCardPatchNotifier();
  // Stub only the transport — the state machine stays real.
  (notifier as any).runLarkCli = async (argv: string[], op: string) => {
    const dataIdx = argv.indexOf("--data");
    const contentIdx = argv.indexOf("--content");
    const raw =
      dataIdx !== -1
        ? argv[dataIdx + 1]
        : contentIdx !== -1
          ? argv[contentIdx + 1]
          : undefined;
    if (raw) {
      const body = JSON.parse(raw);
      capturedCards.push(
        typeof body.content === "string" ? JSON.parse(body.content) : body
      );
    }
    if (op === "send") {
      return JSON.stringify({ ok: true, data: { message_id: messageId } });
    }
    return JSON.stringify({ ok: true });
  };
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

/** Fire `task:operation:after.create` with an agent-written milestone. */
async function fireOperationCreate(
  hook: LarkCliTaskNotifyHook,
  operation: Record<string, unknown>
): Promise<void> {
  const ctx = makeHookContext(TaskHookPoints.OPERATION_AFTER_CREATE, {
    operation,
  } as any);
  await runWithEnvContext(makeEnvContext(), async () => {
    await hook.execute(ctx);
  });
}

/** Read the persisted timeline snapshot for a task. */
function readTimeline(store: MemoryLarkCardStateStore, taskId: number): any {
  const rec = store.get(taskId);
  if (!rec?.timeline) return undefined;
  return JSON.parse(rec.timeline);
}

// ============================================================================
// The regression
// ============================================================================

describe("Task #5020 — operation 里程碑必须落进共享 ledger 的 timeline", () => {
  it("RED: operation hook 之后 ledger.timeline 含 agent 手写的里程碑", async () => {
    const store = new MemoryLarkCardStateStore();
    const notifier = makeRealStateNotifier("om_card_test");
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });

    // 建卡 → ledger 有了第一份 timeline（只有「Task 创建」）
    await bootstrapCard(hook);

    const before = readTimeline(store, 5010);
    expect(before).toBeDefined();
    expect(before.milestones.map((m: any) => m.title)).toEqual(["Task 创建"]);

    // agent 记一条里程碑（MCP 进程里发生的那次 operation 创建）
    await fireOperationCreate(hook, {
      id: 38125,
      taskId: 5010,
      sessionId: "claude-mcp",
      milestoneType: "milestone",
      milestoneTitle: "设计与立项落定",
      milestoneDescription:
        "reverseString 设计定案并立项 #5010：签名 `reverseString(s: string): string`",
      processDescription: "先定 Unicode 码点语义，再落盘实现与单测。",
      timestamp: "2026-11-05T08:30:28.508Z",
    });

    // ★ 核心断言：ledger 必须带上这条 agent 里程碑，
    //   否则别的进程（daemon）无从回填 → 卡片上永远看不到它。
    const after = readTimeline(store, 5010);
    expect(after).toBeDefined();
    const titles = after.milestones.map((m: any) => m.title);
    expect(titles).toContain("设计与立项落定");
    expect(titles).toContain("Task 创建");
  });

  it("RED: 连续 3 条 operation 里程碑全部落进 ledger.timeline", async () => {
    const store = new MemoryLarkCardStateStore();
    const notifier = makeRealStateNotifier("om_card_test");
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });

    await bootstrapCard(hook);

    const agentMilestones = [
      {
        title: "设计与立项落定",
        ts: "2026-11-05T08:30:28.508Z",
        desc: "reverseString 设计定案并立项 #5010",
      },
      {
        title: "实现与单测落盘",
        ts: "2026-11-05T08:30:50.539Z",
        desc: "reverse.ts 531 B / reverse.test.ts 1046 B",
      },
      {
        title: "测试全绿收口",
        ts: "2026-11-05T08:31:05.618Z",
        desc: "bun test → 7 pass / 0 fail, EXIT_CODE=0",
      },
    ];

    for (const m of agentMilestones) {
      await fireOperationCreate(hook, {
        id: 0,
        taskId: 5010,
        sessionId: "claude-mcp",
        milestoneType: "milestone",
        milestoneTitle: m.title,
        milestoneDescription: m.desc,
        processDescription: "过程叙述 100-500 字符。",
        timestamp: m.ts,
      });
    }

    const after = readTimeline(store, 5010);
    const titles = after.milestones.map((m: any) => m.title);
    expect(titles).toEqual([
      "Task 创建",
      "设计与立项落定",
      "实现与单测落盘",
      "测试全绿收口",
    ]);
  });

  it("RED: ledger 里的里程碑描述必须保留 agent 的技术叙述（不能只剩标题）", async () => {
    const store = new MemoryLarkCardStateStore();
    const notifier = makeRealStateNotifier("om_card_test");
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });

    await bootstrapCard(hook);
    await fireOperationCreate(hook, {
      id: 0,
      taskId: 5010,
      sessionId: "claude-mcp",
      milestoneType: "milestone",
      milestoneTitle: "测试全绿收口",
      milestoneDescription:
        "bun test reverse.test.ts → 7 pass / 0 fail / EXIT_CODE=0",
      processDescription: "过程叙述。",
      timestamp: "2026-11-05T08:31:05.618Z",
    });

    const after = readTimeline(store, 5010);
    const m = after.milestones.find((x: any) => x.title === "测试全绿收口");
    expect(m).toBeDefined();
    expect(m.description).toContain("7 pass");
  });

  it("非回归：operation hook 失败不得影响卡片其它流程（ledger 写失败也降级）", async () => {
    const store = new MemoryLarkCardStateStore();
    const notifier = makeRealStateNotifier("om_card_test");
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
    });

    await bootstrapCard(hook);

    // store 的 upsert 抛错 → operation 路径必须降级，不抛
    (store as any).upsert = () => {
      throw new Error("boom");
    };

    await expect(
      fireOperationCreate(hook, {
        id: 0,
        taskId: 5010,
        sessionId: "claude-mcp",
        milestoneType: "milestone",
        milestoneTitle: "设计与立项落定",
        milestoneDescription: "d",
        processDescription: "p",
        timestamp: "2026-11-05T08:30:28.508Z",
      })
    ).resolves.toBeUndefined();
  });

  // ==========================================================================
  // 跨进程回填 —— 这才是用户看到的那个 bug
  // ==========================================================================

  it("RED: 另一个进程（daemon）能从 ledger 回填出 agent 的里程碑并渲染到终态卡", async () => {
    const store = new MemoryLarkCardStateStore();

    // ---- 进程 1：MCP server（持有 operation hook） ------------------------
    const mcpNotifier = makeRealStateNotifier("om_card_test");
    const mcpHook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: mcpNotifier,
      cardStateStore: store,
    });
    await bootstrapCard(mcpHook);
    await fireOperationCreate(mcpHook, {
      id: 38125,
      taskId: 5010,
      sessionId: "claude-mcp",
      milestoneType: "milestone",
      milestoneTitle: "设计与立项落定",
      milestoneDescription: "reverseString 设计定案并立项 #5010",
      processDescription: "过程叙述。",
      timestamp: "2026-11-05T08:30:28.508Z",
    });

    // ---- 进程 2：daemon（收尾时重建整张卡）------------------------------
    const daemonNotifier = makeRealStateNotifier("om_card_test");
    // daemon 的 notifier 对这张卡**没有内存态** —— 只能从 ledger 回填
    (daemonNotifier as any).hydrateState(
      "om_card_test",
      JSON.parse(store.get(5010)!.timeline!)
    );
    await daemonNotifier.finishTask({
      messageId: "om_card_test",
      profile: undefined,
      status: "completed",
      finalStep: "已回复到原消息",
      progress: 100,
    });

    // 终态卡的里程碑序列必须包含 agent 那条 + 终态那条
    const state = (daemonNotifier as any).exportState("om_card_test");
    // finishTask 末尾会 delete state → 用 patch 捕获的卡片内容断言
    const titles = capturedCardTitles();
    expect(titles).toContain("设计与立项落定");
    expect(titles).toContain("Task 完成");
  });
});

/** Poll `predicate` until it holds or `ms` elapses (for trailing-edge throttling). */
async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

/** Titles of the milestone lines in the last captured card. */
function capturedCardTitles(): string[] {
  const card = capturedCards[capturedCards.length - 1];
  if (!card) return [];
  const out: string[] = [];
  const walk = (els: any[]): void => {
    for (const e of els ?? []) {
      if (e?.tag === "markdown" && typeof e.content === "string") {
        for (const line of e.content.split("\n")) {
          const m = /^-\s+\*\*\d{2}:\d{2}:\d{2}\*\*\s+(.+)$/.exec(line.trim());
          if (m) out.push(m[1].trim());
        }
      } else if (e?.tag === "collapsible_panel" && Array.isArray(e.elements)) {
        walk(e.elements);
      }
    }
  };
  walk(card?.body?.elements ?? card?.elements ?? []);
  return out;
}

// ============================================================================
// MAJOR（review 指出）— 被节流的 operation 也必须当场出现在**卡片**上
// ============================================================================

describe("Task #5020 — 节流不得让里程碑在卡片上缺项", () => {
  it("RED: 5s 内连记两条 operation，两条里程碑都必须出现在卡片上", async () => {
    const store = new MemoryLarkCardStateStore();
    const notifier = makeRealStateNotifier("om_card_test");
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
      // ★ 缩短节流窗口：让「尾沿补发」在测试里既快又确定
      //    （默认 5000ms 会与 bun 的 5s 用例超时正面撞车）
      operationThrottleMs: 300,
    });

    await bootstrapCard(hook);
    capturedCards.length = 0;

    // 两条紧接着的 operation（间隔远小于节流窗口）
    await fireOperationCreate(hook, {
      id: 0,
      taskId: 5010,
      sessionId: "claude-mcp",
      milestoneType: "milestone",
      milestoneTitle: "设计与立项落定",
      milestoneDescription: "reverseString 设计定案并立项 #5010",
      processDescription: "过程叙述。",
      timestamp: "2026-11-05T08:30:28.508Z",
    });
    await fireOperationCreate(hook, {
      id: 0,
      taskId: 5010,
      sessionId: "claude-mcp",
      milestoneType: "milestone",
      milestoneTitle: "实现与单测落盘",
      milestoneDescription: "reverse.ts 531 B / reverse.test.ts 1046 B",
      processDescription: "过程叙述。",
      timestamp: "2026-11-05T08:30:30.539Z",
    });

    // 第二条落在节流窗口内 → 立刻只 patch 了第一条。
    const immediate = capturedCardTitles();
    expect(immediate).toContain("设计与立项落定");

    // ★ 关键：节流只是**延后**，不是丢弃。等尾沿补发落地后，
    //   第二条必须出现在卡片上（否则用户看到的仍然是有洞的时间线）。
    const landed = await waitFor(
      () => capturedCardTitles().includes("实现与单测落盘"),
      3000
    );
    expect(landed).toBe(true);
    const titles = capturedCardTitles();
    expect(titles).toContain("设计与立项落定");
    expect(titles).toContain("实现与单测落盘");
  });
});

describe("Task #5020 — patch 失败也必须把时间线落进 ledger", () => {
  it("RED: updateTask 抛错时 ledger.timeline 仍含 agent 里程碑", async () => {
    const store = new MemoryLarkCardStateStore();
    const notifier = makeRealStateNotifier("om_card_test");
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
      operationThrottleMs: 0, // 关掉节流，直击 patch 失败路径
    });

    await bootstrapCard(hook);

    // 让飞书 patch 失败（模拟 lark-cli 网络挂掉）
    const origRun = (notifier as any).runLarkCli;
    (notifier as any).runLarkCli = async (argv: string[], op: string) => {
      if (op === "patch") throw new Error("lark-cli exploded");
      return origRun(argv, op);
    };

    await fireOperationCreate(hook, {
      id: 0,
      taskId: 5010,
      sessionId: "claude-mcp",
      milestoneType: "milestone",
      milestoneTitle: "测试全绿收口",
      milestoneDescription: "bun test → 7 pass / 0 fail",
      processDescription: "过程叙述。",
      timestamp: "2026-11-05T08:31:05.618Z",
    });

    // ★ patch 挂了，但 ledger 必须已经有这条里程碑 —— 否则别的进程
    //   （daemon 收尾重建整张卡）永远看不到它。
    const after = readTimeline(store, 5010);
    expect(after).toBeDefined();
    expect(after.milestones.map((m: any) => m.title)).toContain("测试全绿收口");
  });
});

describe("Task #5020 — 终态不得被尾沿补发打回进行中", () => {
  it("RED: 窗口内记里程碑后立即完成任务，卡片应保持「已完成」且里程碑不丢", async () => {
    const store = new MemoryLarkCardStateStore();
    const notifier = makeRealStateNotifier("om_card_test");
    const hook = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
      operationThrottleMs: 300,
    });

    await bootstrapCard(hook);
    capturedCards.length = 0;

    // 一条落在窗口内的 operation（立即 patch）
    await fireOperationCreate(hook, {
      id: 0,
      taskId: 5010,
      sessionId: "claude-mcp",
      milestoneType: "milestone",
      milestoneTitle: "设计与立项落定",
      milestoneDescription: "reverseString 设计定案",
      processDescription: "过程叙述。",
      timestamp: "2026-11-05T08:30:28.508Z",
    });
    // 第二条必然被节流 → 登记尾沿 timer
    await fireOperationCreate(hook, {
      id: 0,
      taskId: 5010,
      sessionId: "claude-mcp",
      milestoneType: "milestone",
      milestoneTitle: "测试全绿收口",
      milestoneDescription: "bun test → 7 pass / 0 fail",
      processDescription: "过程叙述。",
      timestamp: "2026-11-05T08:30:29.000Z",
    });

    // 紧接着任务完成（timer 还没到点）
    const completed = makeTask({ status: "completed", progress: 100 });
    await runWithEnvContext(makeEnvContext(), async () => {
      await hook.execute(
        makeHookContext(TaskHookPoints.AFTER_COMPLETE, {
          task: completed,
          changes: { status: "completed" },
          terminalStatus: "completed",
          sessionId: "s1",
        } as any)
      );
    });

    // ★ 等过窗口，让尾沿 timer 有机会（错误地）触发
    await new Promise((r) => setTimeout(r, 600));

    const last = capturedCards[capturedCards.length - 1];
    const subtitle = JSON.stringify(last?.header ?? {});
    // 卡片必须仍然是「全部完成」，不能被刷回「进行中」
    expect(subtitle).toContain("全部完成");
    // 且里程碑不能因为空 state 重建而清空
    expect(capturedCardTitles()).toContain("测试全绿收口");
  });
});

describe("Task #5020 — 已排队的迟到 update 不得改写终态卡片", () => {
  it("RED: finishTask 之后到达的 updateTask 必须被忽略，不得把卡片刷回进行中", async () => {
    const notifier = makeRealStateNotifier("om_card_race");
    const msgId = "om_card_race";

    // 建卡
    await notifier.startTask({
      chatId: "oc_chat123",
      meta: { id: 5010, title: "race" },
      milestones: [{ title: "Task 创建", timestamp: "2026-11-05T08:30:15.000Z" }],
    });
    await notifier.updateTask({
      messageId: msgId,
      status: "running",
      milestones: [
        { title: "设计与立项落定", timestamp: "2026-11-05T08:30:28.000Z", description: "d" },
      ],
    });
    capturedCards.length = 0;

    // 终态
    await notifier.finishTask({
      messageId: msgId,
      status: "completed",
      finalStep: "已回复到原消息",
      progress: 100,
    });
    const afterFinish = capturedCardTitles();
    expect(afterFinish).toContain("Task 完成");

    // ★ 模拟「已通过前置校验、正在排队」的迟到更新（尾沿补发的实际形态）
    await notifier.updateTask({
      messageId: msgId,
      status: "running",
      milestones: [],
      processSteps: [],
    });

    // 终态卡不得被改写：最后一张 patch 出来的卡片仍必须是「全部完成」
    const last = capturedCards[capturedCards.length - 1];
    expect(JSON.stringify(last?.header ?? {})).toContain("全部完成");
    // 且里程碑序列不得被空 state 清空
    expect(capturedCardTitles()).toContain("Task 完成");
  });
});

describe("Task #5020 — round-5：终态标记必须与 terminal patch 原子生效", () => {
  it("RED: 已排队的排队更新在 finishTask 期间也不得改写终态（unpin 前打标）", async () => {
    const notifier = makeRealStateNotifier("om_card_race2");
    const msgId = "om_card_race2";

    await notifier.startTask({
      chatId: "oc_chat123",
      meta: { id: 5010, title: "race2" },
      milestones: [{ title: "Task 创建", timestamp: "2026-11-05T08:30:15.000Z" }],
    });

    // ★ 让 unpin 变慢（模拟真实 lark-cli 往返），暴露「标记晚于 mutex 释放」的窗口
    const origRun = (notifier as any).runLarkCli;
    let unpinResolve: (() => void) | undefined;
    const unpinGate = new Promise<void>((r) => (unpinResolve = r));
    (notifier as any).runLarkCli = async (argv: string[], op: string) => {
      if (op === "unpin") {
        await unpinGate; // 卡住 unpin
        return JSON.stringify({ ok: true });
      }
      return origRun(argv, op);
    };

    // 终态（会卡在 unpin 上）
    const finishing = notifier.finishTask({
      messageId: msgId,
      status: "completed",
      finalStep: "已回复到原消息",
      progress: 100,
    });

    // 让 finishTask 跑过 mutex、进入 unpin 等待
    await new Promise((r) => setTimeout(r, 50));

    // 此时一个迟到的 update 到来（尾沿补发的形态）
    await notifier.updateTask({
      messageId: msgId,
      status: "running",
      milestones: [],
      processSteps: [],
    });

    const last = capturedCards[capturedCards.length - 1];
    // 迟到的 update 不能被渲染出来 —— 最后一张卡必须仍是终态
    expect(JSON.stringify(last?.header ?? {})).toContain("全部完成");

    unpinResolve!();
    await finishing;
  });

  it("RED: workflow 终态后迟到的 updateWorkflow 不得重建卡片", async () => {
    const notifier = makeRealStateNotifier("om_wf_race");
    const msgId = "om_wf_race";

    await notifier.startWorkflow({
      chatId: "oc_chat123",
      meta: { runId: "run-1" },
      totalNodes: 3,
      milestones: [{ title: "Workflow 启动", timestamp: "2026-11-05T08:30:15.000Z" }],
    });

    await notifier.finishWorkflow({
      messageId: msgId,
      status: "completed",
      finalStep: "done",
      progress: 100,
    });
    const beforeLate = capturedCards.length;

    // 迟到的 workflow 更新
    await notifier.updateWorkflow({
      messageId: msgId,
      status: "running",
      completedNodes: 0,
    });

    // 不得产生新的 patch（更不得把终态卡刷回 running）
    expect(capturedCards.length).toBe(beforeLate);
  });
});
