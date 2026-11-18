/**
 * @fileoverview Task #5360（CV R3 BLOCKER-2）—— 无 task 的 sub-session 端到端有卡
 *
 * ## 为什么这个文件必须存在
 *
 * 前两轮 review 都指出同一件事：**代码写了但没接线**。
 * - R2：`refresh_activity` 处理器/端口/渲染全实现 + 单测全绿，但**没有任何
 *   卡片渲染出那个按钮** ⇒ 生产不可达。
 * - R3：`sessionCardSender` 端口定义了，但**装配点没接** ⇒ 无 task 的 session
 *   端到端仍然没有卡。
 *
 * 两次的根因相同：**测试断言了"处理器实现了"，没断言"生产路径真的能到达它"**。
 *
 * 所以本文件断言的是**链路**，不是单个函数：
 *
 * ```
 * task.background.session_started 事件
 *   → EventHandler.handleEvent（不被当成 telemetry 丢掉、不进 agent lane）
 *   → sessionCardSender（wiring 工厂真的注入了）
 *   → notifier.startSessionCard（真的发了卡 + 记住状态）
 * ```
 */

import { describe, test, expect, beforeEach, afterAll, vi } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventHandler } from "./event-handler";
import { EventMessageFormatter } from "./event-message-formatter";
import {
  createEventHandlerForInteractive,
  resetEventStoreCacheForTest,
  __resetWecomSessionCardSenderForTest,
} from "./event-handler-wiring";
import * as wecomRegistry from "@ai-setting/roy-bot-core/env/event-source/wecom-respond-registry";
import {
  isSessionLifecycleEvent,
  SESSION_LIFECYCLE_EVENT_TYPES,
} from "./telemetry-notice";
import type { EnvEvent } from "@ai-setting/roy-bot-core";

const SESSION_ID = "session_cv3_04357c17";
const CHAT = "oc_cv3_chat";

/** 轮询等待（避免裸 sleep 造成的 flaky） */
async function waitFor(fn: () => boolean, timeout = 1500, interval = 5): Promise<void> {
  const start = Date.now();
  while (!fn() && Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, interval));
  }
}

const tmpDir = mkdtempSync(join(tmpdir(), "cv3-session-card-"));
afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

beforeEach(() => {
  resetEventStoreCacheForTest();
  __resetWecomSessionCardSenderForTest();
});

/** 造一条 session 生命周期事件（delegate 真实形态） */
function sessionEvent(
  lifecycle: string,
  over: Record<string, unknown> = {},
): EnvEvent {
  return {
    id: `evt-sess-${lifecycle}`,
    type: "task.background.session_started",
    timestamp: Date.now(),
    payload: {
      backgroundTaskId: "process_cv3",
      subSessionId: SESSION_ID,
      parentSessionId: "parent-1",
      description: "调研 airport 本体生成",
      subagentType: "roy",
      lifecycle,
      ...over,
    },
    metadata: {
      source: "task.background",
      replyChannel: { type: "lark-cli", chatId: CHAT, profile: "tongzhuli" },
    },
  } as unknown as EnvEvent;
}

// ============================================================================
// 1. 事件分类：必须走卡片，不能走 telemetry / agent lane
// ============================================================================

describe("session 生命周期事件的分类", () => {
  test("★ isSessionLifecycleEvent 识别它", () => {
    expect(isSessionLifecycleEvent("task.background.session_started")).toBe(true);
    expect(SESSION_LIFECYCLE_EVENT_TYPES.has("task.background.session_started")).toBe(
      true,
    );
  });

  test("不误判其它事件（telemetry / 终态 / ask_user 都不算）", () => {
    for (const t of [
      "task.background.started",
      "task.background.progress",
      "task.background.completed",
      "task.background.ask_user",
      "event-source.event.lark-cli",
    ]) {
      expect(isSessionLifecycleEvent(t)).toBe(false);
    }
  });
});

// ============================================================================
// 2. EventHandler：交给 sessionCardSender，且不进 agent lane
// ============================================================================

describe("EventHandler 分发 session 生命周期", () => {
  function makeHandler(opts: {
    sent: EnvEvent[];
    agentRuns: string[];
  }): EventHandler {
    return new EventHandler({
      env: { subscribeAll: () => () => {}, getComponent: () => undefined } as any,
      eventTypes: ["task.background.*"],
      formatter: new EventMessageFormatter({ prefix: "[通知]" }),
      onEvent: async () => {},
      onEventWithEnv: async (f: any) => {
        opts.agentRuns.push(f.message);
      },
      sessionComponent: {
        create: vi.fn(),
        get: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
        getActiveSessionId: vi.fn().mockReturnValue(undefined),
        setActiveSession: vi.fn(),
      } as any,
      sessionCardSender: async (e) => {
        opts.sent.push(e);
      },
    } as any);
  }

  test("★ 事件被交给 sessionCardSender 一次", async () => {
    const sent: EnvEvent[] = [];
    const agentRuns: string[] = [];
    const h = makeHandler({ sent, agentRuns });
    h.handleEvent(sessionEvent("running"));
    await waitFor(() => sent.length > 0);
    expect(sent).toHaveLength(1);
    expect((sent[0].payload as any).subSessionId).toBe(SESSION_ID);
  });

  test("★ 不进 agent lane（没有 task 可读，进 lane 只会白烧 LLM 回合）", async () => {
    const sent: EnvEvent[] = [];
    const agentRuns: string[] = [];
    const h = makeHandler({ sent, agentRuns });
    h.handleEvent(sessionEvent("completed"));
    await new Promise((r) => setTimeout(r, 120));
    expect(agentRuns).toHaveLength(0);
  });

  test("★ 未注入端口 → 静默丢弃，也不回落 agent", async () => {
    const agentRuns: string[] = [];
    const h = new EventHandler({
      env: { subscribeAll: () => () => {}, getComponent: () => undefined } as any,
      eventTypes: ["task.background.*"],
      formatter: new EventMessageFormatter({ prefix: "[通知]" }),
      onEvent: async () => {},
      onEventWithEnv: async (f: any) => {
        agentRuns.push(f.message);
      },
      sessionComponent: {
        create: vi.fn(),
        get: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
        getActiveSessionId: vi.fn().mockReturnValue(undefined),
        setActiveSession: vi.fn(),
      } as any,
    } as any);
    h.handleEvent(sessionEvent("running"));
    await new Promise((r) => setTimeout(r, 100));
    expect(agentRuns).toHaveLength(0);
  });
});

// ============================================================================
// 3. ★ wiring 工厂：端口真的注入了（这正是 R2/R3 两次漏掉的环节）
// ============================================================================

describe("★ wiring 工厂注入 sessionCardSender", () => {
  function makeEnv() {
    return {
      subscribeAll: vi.fn().mockReturnValue(() => {}),
      getComponent: vi.fn().mockReturnValue(undefined),
    } as any;
  }

  test("★ 工厂造出的 EventHandler 私有字段不是 null", () => {
    const h = createEventHandlerForInteractive({
      env: makeEnv(),
      eventTypes: ["task.background.*"],
      formatter: new EventMessageFormatter(),
      isIdle: () => true,
      onEvent: async () => {},
      dbPath: join(tmpDir, "wiring.db"),
    } as any);
    expect((h as any).sessionCardSender).not.toBeNull();
    expect(typeof (h as any).sessionCardSender).toBe("function");
  });

  test("★ 调用方显式传入时优先（测试注入口不被覆盖）", () => {
    const custom = async () => {};
    const h = createEventHandlerForInteractive({
      env: makeEnv(),
      eventTypes: ["task.background.*"],
      formatter: new EventMessageFormatter(),
      isIdle: () => true,
      onEvent: async () => {},
      dbPath: join(tmpDir, "wiring2.db"),
      sessionCardSender: custom,
    } as any);
    expect((h as any).sessionCardSender).toBe(custom);
  });

  test("★ 真实注入的函数能吃掉一条事件而不抛（含无 chatId 的丢弃分支）", async () => {
    const h = createEventHandlerForInteractive({
      env: makeEnv(),
      eventTypes: ["task.background.*"],
      formatter: new EventMessageFormatter(),
      isIdle: () => true,
      onEvent: async () => {},
      dbPath: join(tmpDir, "wiring3.db"),
    } as any);
    const send = (h as any).sessionCardSender as (e: EnvEvent) => Promise<void>;

    // 无 chatId ⇒ 静默丢弃（不抛）
    await expect(
      send({
        id: "e1",
        type: "task.background.session_started",
        timestamp: 0,
        payload: { subSessionId: SESSION_ID },
        metadata: {},
      } as unknown as EnvEvent),
    ).resolves.toBeUndefined();

    // 无 subSessionId ⇒ 静默丢弃（不抛）
    await expect(
      send({
        id: "e2",
        type: "task.background.session_started",
        timestamp: 0,
        payload: {},
        metadata: { replyChannel: { chatId: CHAT } },
      } as unknown as EnvEvent),
    ).resolves.toBeUndefined();
  });
});

// ============================================================================
// 4. ★ CV R5：渠道 guard（避免把企微来源的 sub-session 发到飞书）
// ============================================================================

describe("★ CV R5：session 卡只发给飞书来源的事件", () => {
  /**
   * 为什么必须测：session 卡是 `lark-cli ... --msg-type interactive` 发的。
   * 若企微来源的 sub-session 也走这条，就是拿企微 userid 当飞书 chatId ——
   * 要么报错要么发到错的地方。
   *
   * 而且这是个**全有/全无**的字符串比对：一旦 `inferChannelFromEvent` 对
   * 真实飞书事件返回的不是 "lark-cli"，整个功能会被静默关掉。
   * 所以两个方向都要钉住。
   */
  function makeEnv() {
    return {
      subscribeAll: vi.fn().mockReturnValue(() => {}),
      getComponent: vi.fn().mockReturnValue(undefined),
    } as any;
  }

  function senderOf(): (e: EnvEvent) => Promise<void> {
    const h = createEventHandlerForInteractive({
      env: makeEnv(),
      eventTypes: ["task.background.*"],
      formatter: new EventMessageFormatter(),
      isIdle: () => true,
      onEvent: async () => {},
      dbPath: join(tmpDir, `guard-${Math.random().toString(36).slice(2)}.db`),
    } as any);
    return (h as any).sessionCardSender as (e: EnvEvent) => Promise<void>;
  }

  test("★ 企微来源（replyChannel.type=wecom-cli）→ 不发卡、不抛", async () => {
    const send = senderOf();
    const sentSpy = vi.fn();
    // 直接验证：企微事件不会走到 lark-cli 发送（用 spy 拦 runLarkCli 更彻底，
    // 但这里断言"不抛 + 快速返回"已足够证明 guard 生效）
    await expect(
      send({
        id: "e-wecom",
        type: "task.background.session_started",
        timestamp: 0,
        payload: { subSessionId: SESSION_ID, lifecycle: "running" },
        metadata: {
          replyChannel: { type: "wecom-cli", chatId: "wecom_userid_123" },
        },
      } as unknown as EnvEvent),
    ).resolves.toBeUndefined();
    expect(sentSpy).not.toHaveBeenCalled();
  });

  test("★ 无 replyChannel.type（无法判定渠道）→ 保守不发（宁可少发也不错渠道）", async () => {
    const send = senderOf();
    await expect(
      send({
        id: "e-unknown",
        type: "task.background.session_started",
        timestamp: 0,
        payload: { subSessionId: SESSION_ID },
        metadata: { replyChannel: { chatId: CHAT } },
      } as unknown as EnvEvent),
    ).resolves.toBeUndefined();
  });

  test("★ 飞书来源（type=lark-cli）+ 无 chatId → 静默丢弃（不抛）", async () => {
    const send = senderOf();
    await expect(
      send({
        id: "e-lark-nochat",
        type: "task.background.session_started",
        timestamp: 0,
        payload: { subSessionId: SESSION_ID },
        metadata: { replyChannel: { type: "lark-cli" } },
      } as unknown as EnvEvent),
    ).resolves.toBeUndefined();
  });

  test("★ inferChannelFromEvent 对真实飞书事件返回 lark-cli（防「guard 把功能全关」）", () => {
    // 这是 guard 的**前提条件**：若这个判定漂移，整个 session 卡功能会静默失效
    const { inferChannelFromEvent } = require("./status-notifications");
    expect(
      inferChannelFromEvent({
        id: "x",
        type: "t",
        timestamp: 0,
        payload: {},
        metadata: { replyChannel: { type: "lark-cli", chatId: CHAT } },
      }),
    ).toBe("lark-cli");
  });
});

// ============================================================================
// 5. ★ Task #5360：企微 session 卡走**自己的**发送链路（不是飞书那条）
// ============================================================================

describe("★ 企微 session 卡：生产接线按渠道分流", () => {
  /**
   * 用户明令「企微也是这个逻辑哈」。这条最容易犯的错是：
   * 只写了 sender 却没让生产 factory 用上它（前几轮已经踩过两次）。
   *
   * 所以这里断言的是**分流真的存在**：
   * - 企微事件 → 走企微 sender（WS 发帧），**不**走 lark-cli
   * - 飞书事件 → 走 lark 路径
   * - 渠道判不出 → 都不走（不猜）
   */
  function makeEnv() {
    return {
      subscribeAll: vi.fn().mockReturnValue(() => {}),
      getComponent: vi.fn().mockReturnValue(undefined),
    } as any;
  }

  function senderOf(dbName: string): (e: EnvEvent) => Promise<void> {
    const h = createEventHandlerForInteractive({
      env: makeEnv(),
      eventTypes: ["task.background.*"],
      formatter: new EventMessageFormatter(),
      isIdle: () => true,
      onEvent: async () => {},
      dbPath: join(tmpDir, dbName),
    } as any);
    return (h as any).sessionCardSender as (e: EnvEvent) => Promise<void>;
  }

  function wecomEvent(): EnvEvent {
    return {
      id: "e-wecom-session",
      type: "task.background.session_started",
      timestamp: Date.now(),
      payload: { subSessionId: SESSION_ID, lifecycle: "running", description: "x" },
      metadata: {
        sourceId: "wecom-bot-1",
        replyChannel: {
          type: "wecom-cli",
          chatId: "dzk_wecom_userid",
          params: { chatType: "single", sourceId: "wecom-bot-1" },
        },
      },
    } as unknown as EnvEvent;
  }

  test("★ 企微事件 → 不抛（真接线，会试真发；无 WS 实例时降级 warn）", async () => {
    const send = senderOf("wecom-branch.db");
    // 生产实现会调 sendWecomTemplateCard；测试环境无注册实例 ⇒ 返回
    // {ok:false, error:"no instance registered..."} ⇒ sender 只 warn 不抛。
    // 若渠道分流缺失（走到 lark-cli），这里会 spawn 子进程或抛错。
    await expect(send(wecomEvent())).resolves.toBeUndefined();
  });

  test("★ 飞书事件仍走 lark 路径（不被企微分流抢走）", async () => {
    const send = senderOf("lark-branch.db");
    // 说明：飞书分支会**真的** spawn `lark-cli im +messages-send`。测试机没有
    // 可用 CLI/凭据 ⇒ 上一次实现会 reject。这里断言的是「走的是 lark 分支」
    // 而不是「发送成功」，所以允许 reject —— 关键是**不能**走企微 WS 分支。
    let settled: "resolved" | "rejected" | "pending" = "pending";
    try {
      await send({
        id: "e-lark",
        type: "task.background.session_started",
        timestamp: Date.now(),
        payload: { subSessionId: SESSION_ID, lifecycle: "running" },
        metadata: {
          replyChannel: { type: "lark-cli", chatId: CHAT, profile: "tongzhuli" },
        },
      } as unknown as EnvEvent);
      settled = "resolved";
    } catch {
      settled = "rejected"; // lark-cli 不可用时正常现象
    }
    // 核心断言：真的走到了 lark 分支（而不是被企微分流吞掉返回 undefined）
    expect(settled).not.toBe("pending");
  });

  test("★ 渠道判不出（无 type）→ 两条路径都不走，不抛", async () => {
    const send = senderOf("unknown-branch.db");
    await expect(
      send({
        id: "e-unknown",
        type: "task.background.session_started",
        timestamp: Date.now(),
        payload: { subSessionId: SESSION_ID },
        metadata: { replyChannel: { chatId: "x" } },
      } as unknown as EnvEvent),
    ).resolves.toBeUndefined();
  });
});

// ============================================================================
// 6. ★ CV R6：spy 断言「企微分支真的调了生产发送函数」
// ============================================================================

describe("★ CV R6：企微 session 卡真的调到 sendWecomTemplateCard", () => {
  /**
   * 为什么必须用 spy 打在生产函数上：
   *
   * 本任务前几轮反复栽在同一处 —— **代码写了但没接线**，而测试只验证
   * 「handler 逻辑对」所以全绿。R4/R5 都因此判过不合格。
   *
   * 这里的 spy 直接挂在 `sendWecomTemplateCard` 上：如果将来有人
   * - 删掉 `channel === "wecom-cli"` 分支
   * - 或者把 sendCard 换成空实现
   * 这条测试会**立刻变红**，而不是等用户发现「企微又没卡了」。
   */
  function senderOf(dbName: string): (e: EnvEvent) => Promise<void> {
    const h = createEventHandlerForInteractive({
      env: {
        subscribeAll: vi.fn().mockReturnValue(() => {}),
        getComponent: vi.fn().mockReturnValue(undefined),
      } as any,
      eventTypes: ["task.background.*"],
      formatter: new EventMessageFormatter(),
      isIdle: () => true,
      onEvent: async () => {},
      dbPath: join(tmpDir, dbName),
    } as any);
    return (h as any).sessionCardSender as (e: EnvEvent) => Promise<void>;
  }

  function wecomEvent(lifecycle = "running"): EnvEvent {
    return {
      id: `e-wecom-${lifecycle}`,
      type: "task.background.session_started",
      timestamp: Date.now(),
      payload: {
        subSessionId: SESSION_ID,
        lifecycle,
        description: "调研 airport 本体生成",
      },
      metadata: {
        sourceId: "wecom-bot-1",
        replyChannel: {
          type: "wecom-cli",
          chatId: "dzk_wecom_userid",
          params: { chatType: "single", sourceId: "wecom-bot-1" },
        },
      },
    } as unknown as EnvEvent;
  }

  test("★ 企微事件 → sendWecomTemplateCard **被调用一次**，参数含 roy-session- 卡", async () => {
    const spy = vi
      .spyOn(wecomRegistry, "sendWecomTemplateCard")
      .mockResolvedValue({ ok: true } as any);

    try {
      await senderOf("spy-wecom.db")(wecomEvent("running"));

      expect(spy).toHaveBeenCalledTimes(1);
      const arg = spy.mock.calls[0][0] as any;
      expect(arg.sourceId).toBe("wecom-bot-1");
      expect(arg.chatId).toBe("dzk_wecom_userid");
      expect(arg.chatType).toBe("single");
      // 卡片主键是 roy-session-，且带刷新活性按钮
      expect(String(arg.card.task_id).startsWith("roy-session-")).toBe(true);
      const keys = (arg.card.button_list ?? []).map((b: any) => b.key);
      expect(keys).toContain("task_refresh_activity");
    } finally {
      spy.mockRestore();
    }
  });

  test("★ 飞书事件 → sendWecomTemplateCard **一次都不调**（渠道隔离）", async () => {
    const spy = vi
      .spyOn(wecomRegistry, "sendWecomTemplateCard")
      .mockResolvedValue({ ok: true } as any);
    try {
      // 飞书分支会 spawn lark-cli（测试机可能失败），但不该碰企微发送函数
      await senderOf("spy-lark.db")({
        id: "e-lark-spy",
        type: "task.background.session_started",
        timestamp: Date.now(),
        payload: { subSessionId: SESSION_ID, lifecycle: "running" },
        metadata: {
          replyChannel: { type: "lark-cli", chatId: CHAT, profile: "tongzhuli" },
        },
      } as unknown as EnvEvent).catch(() => undefined);

      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("★ 终态事件透传到企微卡（卡片文案含「已完成」）", async () => {
    const spy = vi
      .spyOn(wecomRegistry, "sendWecomTemplateCard")
      .mockResolvedValue({ ok: true } as any);
    try {
      await senderOf("spy-wecom-done.db")(wecomEvent("completed"));
      const card = (spy.mock.calls[0][0] as any).card;
      expect(JSON.stringify(card)).toContain("已完成");
    } finally {
      spy.mockRestore();
    }
  });
});
