/**
 * @fileoverview Task #4552 (A1) — telemetry 事件不得进 lane / 不得触发 agent run
 *
 * ## 用户明令的方案（A1，飞书群 2026-10-26 16:59）
 *
 * > 「任务 process 通知时间就不送到 agent 进行处理了，只是通过找到 triggerEvent
 * >   发一个进展的提示消息给到飞书就行了，否则太费 token 也引发任务说的问题」
 *
 * 即：`task.background.started` / `task.background.progress` 从「agent 参与的
 * 通知」降级为「纯 IM 直发的轻量提示」。
 *
 * ## 本文件锁定的不变量
 *
 * 1. `progress` → 不 claimSession / 不建 session / 不调 onEventWithEnv
 *    （= 不触发 agent run），而是**直发一条飞书消息**
 * 2. `started` 同上
 * 3. **终态（completed/failed/timeout/stopped）+ ask_user 仍然进 lane 走 agent**
 *    —— 回归护栏：防「把终态也短路掉」这个最危险的失误。
 *    ★ 2026-10-27 契约更新（用户明确要求）：completed / timeout 在进 lane **之前**
 *      额外直发一条终态回执（同一套 sender）；failed / stopped / ask_user 不直发。
 * 4. 反查不到 chatId 时：**不抛、不发、也不回落 agent**（明确选择「丢弃」）
 * 5. 直发失败（lark-cli 报错）**不得**污染事件消费循环（best-effort）
 * 6. 心跳不再占用 lane —— 用户消息不再被饿死（A1 的核心收益）
 *
 * ## 为什么「反查不到 chatId」选择丢弃而不是回落老路径
 *
 * 老路径 = 进 lane + 完整 agent run。若在这里回落，`__default__` lane
 * （本地 REPL / 非飞书事件共用）会重新变成饥饿源 —— 正是要根治的东西。
 * telemetry 是**非必需**信息，丢弃远优于让一条心跳挡住用户消息。
 */

import { describe, test, expect, vi } from "bun:test";
import { EventHandler } from "./event-handler";
import type { EventHandlerOptions } from "./event-handler";
import { EventMessageFormatter } from "./event-message-formatter";

// ============================================================================
// Helpers
// ============================================================================

const CHAT = "oc_8904d6f184e31b6cc51ba53a0a19aa2f";
const PROFILE = "tongzhuli";
const START = new Date(2026, 9, 26, 12, 23, 42).getTime();
const FIVE_HOURS = 5 * 3600 * 1000;

async function waitFor(fn: () => boolean, timeout = 3000, interval = 5): Promise<void> {
  const start = Date.now();
  while (!fn() && Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, interval));
  }
  if (!fn()) throw new Error(`waitFor timed out after ${timeout}ms`);
}

function makeSessionComponent() {
  return {
    create: vi.fn().mockResolvedValue({ id: "should-not-be-used", title: "t" }),
    get: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    getActiveSessionId: vi.fn().mockReturnValue(undefined),
    setActiveSession: vi.fn().mockResolvedValue(true),
  };
}

interface SentNotice {
  chatId?: string;
  profile?: string;
  text: string;
  /** ★ A1 幂等键（飞书侧据此对重复投递去重） */
  idempotencyKey?: string;
}

function makeHandler(opts: {
  sent: SentNotice[];
  onEventWithEnv?: any;
  sessionComponent?: any;
  eventStore?: any;
  senderThrows?: boolean;
  /** ★ 交叉验证补充：显式控制自我回声过滤开关（不传 = 走 env 默认，即开启） */
  selfEchoEnabled?: boolean;
}): EventHandler {
  return new EventHandler({
    env: { subscribeAll: () => () => {}, getComponent: () => undefined } as any,
    eventTypes: ["task.background.*", "event-source.event.*"],
    formatter: new EventMessageFormatter({ prefix: "[通知]" }),
    onEvent: async () => {},
    onEventWithEnv: opts.onEventWithEnv ?? (async () => {}),
    sessionComponent: (opts.sessionComponent ?? makeSessionComponent()) as any,
    ...(opts.eventStore ? { eventStore: opts.eventStore } : {}),
    ...(opts.selfEchoEnabled !== undefined
      ? { selfEchoFilter: { enabled: opts.selfEchoEnabled } }
      : {}),
    telemetrySender: async (notice: SentNotice) => {
      if (opts.senderThrows) throw new Error("lark-cli exited with code 1");
      opts.sent.push(notice);
    },
    // ★ Task #5360：本文件锁定的是**文本直发机制**（文案 / 幂等键 / 目标解析 /
    //   best-effort），不是"要不要发"。卡片化改造把默认模式改成了 `"auto"`
    //   （按 ES 配置 statusNotifications，缺省 false ⇒ 静默走卡片），
    //   所以这里显式钉住 `"text"`：让这些机制类断言继续测它们该测的东西。
    //   "默认 auto + 配置 false 时静默" 由 telemetry-notice-card-mode-5360.test.ts 覆盖。
    noticeTextDelivery: "text",
  } as EventHandlerOptions);
}

/** 真实形态：心跳带 metadata.replyChannel（这正是 lane 串道的来源） */
function progressEvent(
  over: Record<string, unknown> = {},
  meta: Record<string, unknown> = {},
) {
  return {
    id: "evt-progress",
    type: "task.background.progress",
    timestamp: Date.now(),
    payload: {
      backgroundTaskId: "process_1792988622098_r6rml36s6",
      subSessionId: "sub-1",
      parentSessionId: "parent-1",
      status: "running",
      description: "调研 airport 本体生成",
      associatedTaskId: 4547,
      startedAt: START,
      timeoutMs: FIVE_HOURS,
      ...over,
    },
    metadata: {
      source: "task.background",
      sourceId: "src",
      trigger_session_id: "parent-1",
      replyChannel: { type: "lark-cli", chatId: CHAT, messageId: "om_x", profile: PROFILE },
      ...meta,
    },
  } as any;
}

function startedEvent(over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) {
  return {
    id: "evt-started",
    type: "task.background.started",
    timestamp: Date.now(),
    payload: {
      backgroundTaskId: "process_1792988622098_r6rml36s6",
      subSessionId: "sub-1",
      parentSessionId: "parent-1",
      description: "调研 airport 本体生成",
      subagentType: "general",
      associatedTaskId: 4547,
      startedAt: START,
      timeoutMs: FIVE_HOURS,
      ...over,
    },
    metadata: {
      source: "task.background",
      sourceId: "src",
      trigger_session_id: "parent-1",
      replyChannel: { type: "lark-cli", chatId: CHAT, messageId: "om_x", profile: PROFILE },
      ...meta,
    },
  } as any;
}

function terminalEvent(type: string) {
  return {
    id: `evt-${type}`,
    type,
    timestamp: Date.now(),
    payload: {
      backgroundTaskId: "bg-1",
      subSessionId: "sub-1",
      parentSessionId: "parent-1",
      status: type.replace("task.background.", ""),
      result: "done",
      executionTimeMs: 1000,
      description: "调研 airport 本体生成",
      associatedTaskId: 4547,
    },
    metadata: {
      source: "task.background",
      sourceId: "src",
      trigger_session_id: "parent-1",
      replyChannel: { type: "lark-cli", chatId: CHAT, messageId: "om_x" },
    },
  } as any;
}

/** 直接走订阅通道（start() 会订阅 env.subscribeAll） */
function makeSubscribableEnv() {
  let dispatch: ((e: any) => void) | null = null;
  return {
    env: {
      subscribeAll: (h: (e: any) => void) => {
        dispatch = h;
        return () => {
          dispatch = null;
        };
      },
      getComponent: () => undefined,
    } as any,
    emit: (e: any) => {
      if (!dispatch) throw new Error("not subscribed yet");
      dispatch(e);
    },
  };
}

/** 建一个已订阅的 handler + emit */
function startHandler(opts: Parameters<typeof makeHandler>[0]) {
  const handler = makeHandler(opts);
  const { env, emit } = makeSubscribableEnv();
  (handler as any).env = env;
  handler.start();
  return { handler, emit };
}

// ============================================================================
// 1. progress → 不进 lane、不跑 agent、直发一条飞书消息
// ============================================================================

describe("Task #4552 A1 — progress 心跳降级为 IM 直发", () => {
  test("progress：不触发 agent run，直发 1 条飞书消息（chatId + profile + 文案）", async () => {
    const sent: SentNotice[] = [];
    const onEventWithEnv = vi.fn(async () => {});
    const sessionComponent = makeSessionComponent();
    const { handler, emit } = startHandler({ sent, onEventWithEnv, sessionComponent });

    emit(progressEvent());
    await waitFor(() => sent.length === 1);

    // ① 不跑 agent（token 的主因）
    expect(onEventWithEnv).toHaveBeenCalledTimes(0);
    // ② 不建 session（claimSession 的前置）
    expect(sessionComponent.create).toHaveBeenCalledTimes(0);
    expect(sessionComponent.get).toHaveBeenCalledTimes(0);
    // ③ 完全绕开队列（没有 lane 积压）
    expect(handler.getQueueLength()).toBe(0);
    // ④ 直发内容正确
    expect(sent[0].chatId).toBe(CHAT);
    expect(sent[0].profile).toBe(PROFILE);
    expect(sent[0].text).toContain("Task #4547");
    expect(sent[0].text).toContain("已跑");
    expect(sent[0].text).toContain("预计 17:23 超时");

    handler.stop();
  });

  test("连续 12 条心跳 = 12 条直发、0 次 agent run（正是 #4547 现场）", async () => {
    const sent: SentNotice[] = [];
    const onEventWithEnv = vi.fn(async () => {});
    const { handler, emit } = startHandler({ sent, onEventWithEnv });

    for (let i = 0; i < 12; i++) {
      emit(progressEvent({ progressMessage: `第 ${i + 1} 次心跳` }));
    }

    await waitFor(() => sent.length === 12);
    expect(onEventWithEnv).toHaveBeenCalledTimes(0);
    expect(handler.getQueueLength()).toBe(0);

    handler.stop();
  });
});

// ============================================================================
// 2. started 同上
// ============================================================================

describe("Task #4552 A1 — started 也降级为 IM 直发", () => {
  test("started：不触发 agent run，直发 1 条", async () => {
    const sent: SentNotice[] = [];
    const onEventWithEnv = vi.fn(async () => {});
    const { handler, emit } = startHandler({ sent, onEventWithEnv });

    emit(startedEvent());
    await waitFor(() => sent.length === 1);

    expect(onEventWithEnv).toHaveBeenCalledTimes(0);
    expect(sent[0].chatId).toBe(CHAT);
    expect(sent[0].text).toContain("Task #4547");
    expect(sent[0].text).toContain("17:23");

    handler.stop();
  });
});

// ============================================================================
// 3. 终态回归护栏 —— 必须仍然走 agent
//
// ★ 2026-10-27 契约更新（用户明确要求）：
//   - completed / timeout：**直发一条规则回执 + 仍走 agent**（双通道）
//   - failed / stopped / ask_user：只走 agent（不进回执白名单，避免双发）
// ============================================================================

describe("A1 回归护栏 — 终态必须仍然进 lane 走 agent", () => {
  const directNoticeTypes = [
    "task.background.completed",
    "task.background.timeout",
  ];
  const agentOnlyTypes = [
    "task.background.failed",
    "task.background.stopped",
    "task.background.ask_user",
  ];

  for (const type of directNoticeTypes) {
    test(`${type} → 走 agent + 额外直发 1 条终态回执`, async () => {
      const sent: SentNotice[] = [];
      const onEventWithEnv = vi.fn(async () => {});
      const sessionComponent = makeSessionComponent();
      const { handler, emit } = startHandler({ sent, onEventWithEnv, sessionComponent });

      emit(terminalEvent(type));
      await waitFor(() => onEventWithEnv.mock.calls.length === 1, 4000);

      // ① 仍触发 agent（终态必须让 agent 读结果并组织回复）
      expect(onEventWithEnv).toHaveBeenCalledTimes(1);
      // ② 规则回执必须发出去（agent 忘调 lark-cli 时用户也能看到终态）
      expect(sent.length).toBe(1);
      expect(sent[0].chatId).toBe(CHAT);
      expect(sent[0].text).toContain("Task #4547");
      // ③ 回执不含 result 正文（agent 的总结才是正文）
      expect(sent[0].text).not.toContain("done");

      handler.stop();
    });
  }

  for (const type of agentOnlyTypes) {
    test(`${type} → 仍然进 lane 走 agent，不直发回执`, async () => {
      const sent: SentNotice[] = [];
      const onEventWithEnv = vi.fn(async () => {});
      const sessionComponent = makeSessionComponent();
      const { handler, emit } = startHandler({ sent, onEventWithEnv, sessionComponent });

      emit(terminalEvent(type));
      await waitFor(() => onEventWithEnv.mock.calls.length === 1, 4000);

      // ① 仍触发 agent
      expect(onEventWithEnv).toHaveBeenCalledTimes(1);
      // ② 不在回执白名单 → 不直发（否则用户只收到一句话，看不到结果）
      expect(sent.length).toBe(0);

      handler.stop();
    });
  }
});

// ============================================================================
// 4. 反查不到 chatId → 静默丢弃（不抛 / 不发 / 不回落 agent）
// ============================================================================

describe("Task #4552 A1 — 目标解析失败的行为（明确选择丢弃）", () => {
  test("既无 replyChannel 也无 triggerEventId → 不发、不跑 agent、不抛", async () => {
    const sent: SentNotice[] = [];
    const onEventWithEnv = vi.fn(async () => {});
    const { handler, emit } = startHandler({ sent, onEventWithEnv });

    const evt = progressEvent();
    delete (evt.metadata as any).replyChannel;

    expect(() => emit(evt)).not.toThrow();
    // 给它一点时间，确认真的什么都没发生
    await new Promise((r) => setTimeout(r, 120));

    expect(sent.length).toBe(0);
    expect(onEventWithEnv).toHaveBeenCalledTimes(0);
    expect(handler.getQueueLength()).toBe(0);

    handler.stop();
  });

  test("triggerEventId 反查失败（store 返回 null）→ 静默丢弃，不回落 agent", async () => {
    const sent: SentNotice[] = [];
    const onEventWithEnv = vi.fn(async () => {});
    const eventStore = { getEventById: vi.fn().mockResolvedValue(null) };
    const { handler, emit } = startHandler({ sent, onEventWithEnv, eventStore });

    const evt = progressEvent();
    delete (evt.metadata as any).replyChannel;
    (evt.metadata as any).triggerEventId = "evt_missing";

    emit(evt);
    await new Promise((r) => setTimeout(r, 150));

    expect(eventStore.getEventById).toHaveBeenCalledWith("evt_missing");
    expect(sent.length).toBe(0);
    expect(onEventWithEnv).toHaveBeenCalledTimes(0);

    handler.stop();
  });

  test("只有 triggerEventId（无 replyChannel）→ 用 store 反查出的 chatId 直发", async () => {
    const sent: SentNotice[] = [];
    const onEventWithEnv = vi.fn(async () => {});
    const eventStore = {
      getEventById: vi.fn().mockResolvedValue({
        eventId: "evt_1",
        esType: "lark-cli",
        senderId: "ou_x",
        text: "请调研",
        metadata: { chatId: "oc_from_store", messageId: "om_1", profile: "tongzhuli" },
        rawEvent: null,
        createdAt: Date.now(),
      }),
    };
    const { handler, emit } = startHandler({ sent, onEventWithEnv, eventStore });

    const evt = progressEvent();
    delete (evt.metadata as any).replyChannel;
    (evt.metadata as any).triggerEventId = "evt_1";

    emit(evt);
    await waitFor(() => sent.length === 1);

    expect(sent[0].chatId).toBe("oc_from_store");
    expect(sent[0].profile).toBe("tongzhuli");
    expect(onEventWithEnv).toHaveBeenCalledTimes(0);

    handler.stop();
  });

  test("EventStore 抛错 → 不冒泡（绝不能炸掉事件消费循环）", async () => {
    const sent: SentNotice[] = [];
    const onEventWithEnv = vi.fn(async () => {});
    const eventStore = {
      getEventById: vi.fn(async () => {
        throw new Error("db down");
      }),
    };
    const { handler, emit } = startHandler({ sent, onEventWithEnv, eventStore });

    const evt = progressEvent();
    delete (evt.metadata as any).replyChannel;
    (evt.metadata as any).triggerEventId = "evt_1";

    expect(() => emit(evt)).not.toThrow();
    await new Promise((r) => setTimeout(r, 150));

    expect(sent.length).toBe(0);
    expect(onEventWithEnv).toHaveBeenCalledTimes(0);

    handler.stop();
  });
});

// ============================================================================
// 5. 直发失败不得污染事件消费循环
// ============================================================================

describe("Task #4552 A1 — 直发失败 best-effort", () => {
  test("sender 抛错 → 不冒泡到事件循环，后续终态事件照常处理", async () => {
    const sent: SentNotice[] = [];
    const onEventWithEnv = vi.fn(async () => {});
    const { handler, emit } = startHandler({ sent, onEventWithEnv, senderThrows: true });

    expect(() => emit(progressEvent())).not.toThrow();
    await new Promise((r) => setTimeout(r, 120));

    // 终态事件仍然正常工作（证明循环没被污染）
    emit(terminalEvent("task.background.completed"));
    await waitFor(() => onEventWithEnv.mock.calls.length === 1, 4000);
    expect(onEventWithEnv).toHaveBeenCalledTimes(1);

    handler.stop();
  });
});

// ============================================================================
// 6. lane 不再被心跳占用（A1 的核心收益，端到端体现）
// ============================================================================

describe("Task #4552 A1 — 心跳不再占用 lane", () => {
  test("心跳涌入后，用户消息仍能立即被处理（不再被饿死）", async () => {
    const sent: SentNotice[] = [];
    const order: string[] = [];
    let releaseUser = () => {};

    const onEventWithEnv = vi.fn(async (fe: any) => {
      const tag = (fe.envEvent?.payload as any)?.tag ?? "?";
      order.push(tag);
      if (tag === "user-1") {
        await new Promise<void>((r) => {
          releaseUser = r;
        });
      }
    });

    const { handler, emit } = startHandler({ sent, onEventWithEnv });

    // 用户消息先占住 lane（模拟一次长 agent run）
    emit({
      id: "u1",
      type: "event-source.event.lark-cli",
      timestamp: Date.now(),
      payload: { tag: "user-1", text: "后台任务在干嘛呢" },
      metadata: {
        sourceId: "src",
        replyChannel: { type: "lark-cli", chatId: CHAT, messageId: "om_u1" },
      },
    } as any);
    await waitFor(() => order.includes("user-1"), 4000);

    // 期间涌入 5 条心跳 —— A1 之后它们完全不进 lane
    for (let i = 0; i < 5; i++) {
      emit(progressEvent({ progressMessage: `心跳 ${i}` }));
    }
    await waitFor(() => sent.length === 5);

    // 再发一条用户消息
    emit({
      id: "u2",
      type: "event-source.event.lark-cli",
      timestamp: Date.now(),
      payload: { tag: "user-2", text: "回答我呀" },
      metadata: {
        sourceId: "src",
        replyChannel: { type: "lark-cli", chatId: CHAT, messageId: "om_u2" },
      },
    } as any);

    // 释放第一条（模拟长 run 结束）
    releaseUser();
    await waitFor(() => order.includes("user-2"), 4000);

    // ★ 核心断言：第二条用户消息确实被处理了（A1 前它会被 5 条心跳推后）
    expect(order).toContain("user-1");
    expect(order).toContain("user-2");
    // 心跳一条都没进 agent
    expect(order.filter((t) => t.startsWith("心跳"))).toHaveLength(0);

    handler.stop();
  });

  test("心跳不会把 lane 标记为 running（不占并发槽位）", async () => {
    const sent: SentNotice[] = [];
    const onEventWithEnv = vi.fn(async () => {});
    const { handler, emit } = startHandler({ sent, onEventWithEnv });

    emit(progressEvent());
    emit(progressEvent({ progressMessage: "b" }));
    await waitFor(() => sent.length === 2);

    expect(handler.getRunningLaneKeys()).toHaveLength(0);

    handler.stop();
  });
});

// ============================================================================
// 7. stop() 语义不变
// ============================================================================

describe("Task #4552 A1 — stop() 后不再直发", () => {
  test("stop 之后到达的 telemetry 不发不抛", async () => {
    const sent: SentNotice[] = [];
    const onEventWithEnv = vi.fn(async () => {});
    const handler = makeHandler({ sent, onEventWithEnv });
    const { env, emit } = makeSubscribableEnv();
    (handler as any).env = env;
    handler.start();

    handler.stop();

    // stop() 取消订阅 → emit 时 dispatch 已为 null
    expect(() => emit(progressEvent())).toThrow(/not subscribed/);
    await new Promise((r) => setTimeout(r, 60));
    expect(sent.length).toBe(0);
  });
});

// ============================================================================
// 8. 幂等键：同一事件重复投递（lark-cli 重投 / 进程重启重放）不应重复发
// ============================================================================

describe("Task #4552 A1 — 幂等键", () => {
  test("telemetry 通知带幂等键（≤50 字符，飞书硬限制）", async () => {
    const sent: SentNotice[] = [];
    const { handler, emit } = startHandler({ sent, onEventWithEnv: vi.fn(async () => {}) });

    emit(progressEvent());
    await waitFor(() => sent.length === 1);

    // 没有幂等键 → 进程重启后重放同一条心跳会给用户发重复提示
    expect(sent[0].idempotencyKey).toBeDefined();
    expect(sent[0].idempotencyKey!.length).toBeLessThanOrEqual(50);

    handler.stop();
  });

  test("同一事件重复投递 → 幂等键相同（飞书侧据此去重）", async () => {
    const sent: SentNotice[] = [];
    const { handler, emit } = startHandler({ sent, onEventWithEnv: vi.fn(async () => {}) });

    const evt = progressEvent();
    emit({ ...evt });
    emit({ ...evt });
    await waitFor(() => sent.length === 2);

    expect(sent[0].idempotencyKey).toBe(sent[1].idempotencyKey);

    handler.stop();
  });

  test("不同事件 id → 幂等键不同（不能把所有心跳压成一条）", async () => {
    const sent: SentNotice[] = [];
    const { handler, emit } = startHandler({ sent, onEventWithEnv: vi.fn(async () => {}) });

    emit(progressEvent());
    emit({ ...progressEvent(), id: "evt-progress-2" });
    await waitFor(() => sent.length === 2);

    expect(sent[0].idempotencyKey).not.toBe(sent[1].idempotencyKey);

    handler.stop();
  });
});

// ============================================================================
// 6. ★ A1 BLOCKING 修复：EventHandler 侧自我回声过滤（防御纵深）
// ============================================================================
//
// ## 为什么主修（--as bot）之外还要这一层
//
// 主修修的是「我们自己发出的提示别被回灌」。但下面这些情况主修都防不住：
//   1. 将来有人新增出站路径，又忘掉 `--as bot`（回归）
//   2. 另一个 app 的 bot 与本 app 同处一群，它的消息对我们也是 `sender_type=app`
//   3. 承载 bot 消息的事件里 `sender_type` 被飞书报成 `user`（历史发生过类似的
//      字段口径漂移），但 senderId 仍是我们 bot 的 open_id / app_id
//
// 所以 EventHandler 入口再加一层「识别自我发送者 → 丢弃」。
//
// ## 铁律：只拦 bot/app 发送者，绝不按文案过滤
//
// 「🔔 / 🔄 前缀」过滤是错误做法 —— 用户完全可能手打一条「🔔 这是什么意思」。
// 详见本文件 RED-3b 回归护栏。

describe("Task #4552 A1-BLOCKING — 自我回声事件不得进 lane / 不得跑 agent", () => {
  /** 真实形态：lark-cli consume 简化格式，sender_type 在顶层 */
  function echoEvent(over: Record<string, unknown> = {}) {
    return {
      id: "es-echo-bot",
      type: "event-source.event.lark-cli",
      timestamp: Date.now(),
      metadata: {
        source: "event-source",
        sourceId: "id_e2e4552_a1test",
        sourceMessageType: "im.message.receive_v1",
        replyChannel: { type: "lark-cli", chatId: CHAT, messageId: "om_echo", profile: PROFILE },
      },
      payload: {
        sourceId: "id_e2e4552_a1test",
        sourceType: "lark-cli",
        rawEvent: {
          type: "im.message.receive_v1",
          message_id: "om_x100b62c7ff2f6ca4b070d56e9200176",
          chat_id: CHAT,
          message_type: "post",
          sender_id: "ou_70b460648c0fec2fb260757ee9a6a38f",
          sender_type: "app",
          content: "🔔 process_x「probe」已启动",
          ...over,
        },
      },
    } as any;
  }

  test("RED-2: sender_type=app 的事件 → 不 enqueue、不跑 agent", async () => {
    const sent: SentNotice[] = [];
    const onEventWithEnv = vi.fn(async () => {});
    const sessionComponent = makeSessionComponent();
    const { handler, emit } = startHandler({ sent, onEventWithEnv, sessionComponent });

    emit(echoEvent());
    await new Promise((r) => setTimeout(r, 200));

    expect(onEventWithEnv).toHaveBeenCalledTimes(0);
    expect(handler.getQueueLength()).toBe(0);
    // 也不该走 telemetry 直发（它不是 telemetry 类型，是被回灌的 user 消息）
    expect(sent.length).toBe(0);
    // 更不该建 session / claim
    expect(sessionComponent.create).toHaveBeenCalledTimes(0);

    handler.stop();
  });

  test("RED-2b: sender_type=bot 同样被拦", async () => {
    const sent: SentNotice[] = [];
    const onEventWithEnv = vi.fn(async () => {});
    const { handler, emit } = startHandler({ sent, onEventWithEnv });

    emit(echoEvent({ sender_type: "bot" }));
    await new Promise((r) => setTimeout(r, 200));

    expect(onEventWithEnv).toHaveBeenCalledTimes(0);
    expect(handler.getQueueLength()).toBe(0);

    handler.stop();
  });

  test("RED-2c: 嵌套格式的 app sender 同样被拦", async () => {
    const sent: SentNotice[] = [];
    const onEventWithEnv = vi.fn(async () => {});
    const { handler, emit } = startHandler({ sent, onEventWithEnv });

    emit({
      id: "es-nested-echo",
      type: "event-source.event.lark-cli",
      timestamp: Date.now(),
      metadata: {
        source: "event-source",
        replyChannel: { type: "lark-cli", chatId: CHAT, profile: PROFILE },
      },
      payload: {
        rawEvent: {
          event: {
            message: { message_id: "om_n", chat_id: CHAT },
            sender: {
              sender_id: { open_id: "ou_70b460648c0fec2fb260757ee9a6a38f" },
              sender_type: "app",
            },
          },
        },
      },
    } as any);
    await new Promise((r) => setTimeout(r, 200));

    expect(onEventWithEnv).toHaveBeenCalledTimes(0);

    handler.stop();
  });

  test("RED-3（回归护栏）: sender_type=user 的真实用户消息 → 仍然正常进 lane 跑 agent", async () => {
    const sent: SentNotice[] = [];
    const onEventWithEnv = vi.fn(async () => {});
    const { handler, emit } = startHandler({ sent, onEventWithEnv });

    emit(echoEvent({ sender_type: "user", sender_id: "ou_b9924f48dc122c3dad0ff4f37851c09b" }));
    await waitFor(() => onEventWithEnv.mock.calls.length === 1, 4000);

    expect(onEventWithEnv).toHaveBeenCalledTimes(1);

    handler.stop();
  });

  test("RED-3b（回归护栏）: 用户手打「🔔」开头的消息 → 不被按文案误伤", async () => {
    const sent: SentNotice[] = [];
    const onEventWithEnv = vi.fn(async () => {});
    const { handler, emit } = startHandler({ sent, onEventWithEnv });

    emit(
      echoEvent({
        sender_type: "user",
        sender_id: "ou_b9924f48dc122c3dad0ff4f37851c09b",
        content: "🔔 这是我自己打的，回我一下",
      }),
    );
    await waitFor(() => onEventWithEnv.mock.calls.length === 1, 4000);

    expect(onEventWithEnv).toHaveBeenCalledTimes(1);

    handler.stop();
  });

  test("RED-4（回归护栏）: 终态 5 类仍走 agent，未被过滤破坏", async () => {
    for (const type of [
      "task.background.completed",
      "task.background.failed",
      "task.background.timeout",
      "task.background.stopped",
      "task.background.ask_user",
    ]) {
      const sent: SentNotice[] = [];
      const onEventWithEnv = vi.fn(async () => {});
      const { handler, emit } = startHandler({ sent, onEventWithEnv });

      emit(terminalEvent(type));
      await waitFor(() => onEventWithEnv.mock.calls.length === 1, 4000);

      expect(onEventWithEnv).toHaveBeenCalledTimes(1);
      handler.stop();
    }
  });
});

// ============================================================================
// 7. 诊断计数可读（交叉验证指出：只写不读 = 死状态 + 注释不实）
// ============================================================================
//
// claude-minimax 指出 `selfEchoDroppedCount` 被 ++ 但无人读、无 getter、
// 无测试断言，而注释写着"诊断 / 测试断言用"。两种修法：接一个读口，或删掉。
// 这里选**接读口** —— 这层过滤在生产上要能观测（真触发时运维要能一眼看到
// 到底丢了多少条），而不是只能翻 console 日志。

describe("Task #4552 A1-BLOCKING — 自我回声丢弃计数可观测", () => {
  function echoEvent(over: Record<string, unknown> = {}) {
    return {
      id: "es-echo-count",
      type: "event-source.event.lark-cli",
      timestamp: Date.now(),
      metadata: {
        source: "event-source",
        replyChannel: { type: "lark-cli", chatId: CHAT, messageId: "om_echo", profile: PROFILE },
      },
      payload: {
        rawEvent: {
          type: "im.message.receive_v1",
          message_id: "om_echo",
          chat_id: CHAT,
          sender_id: "ou_70b460648c0fec2fb260757ee9a6a38f",
          sender_type: "app",
          content: "🔔 x",
          ...over,
        },
      },
    } as any;
  }

  test("初始为 0", () => {
    const { handler } = startHandler({ sent: [], onEventWithEnv: vi.fn(async () => {}) });
    expect(handler.getSelfEchoDroppedCount()).toBe(0);
    handler.stop();
  });

  test("每丢一条 +1（3 条 bot 事件 → 3）", async () => {
    const { handler, emit } = startHandler({
      sent: [],
      onEventWithEnv: vi.fn(async () => {}),
    });

    emit(echoEvent());
    emit(echoEvent({ message_id: "om_echo2" }));
    emit(echoEvent({ message_id: "om_echo3", sender_type: "bot" }));
    await new Promise((r) => setTimeout(r, 200));

    expect(handler.getSelfEchoDroppedCount()).toBe(3);
    handler.stop();
  });

  test("真实用户消息不增计数（证明计数只统计真丢的）", async () => {
    const onEventWithEnv = vi.fn(async () => {});
    const { handler, emit } = startHandler({ sent: [], onEventWithEnv });

    emit(echoEvent({ sender_type: "user", sender_id: "ou_b9924f48dc122c3dad0ff4f37851c09b" }));
    await waitFor(() => onEventWithEnv.mock.calls.length === 1, 4000);

    expect(handler.getSelfEchoDroppedCount()).toBe(0);
    handler.stop();
  });

  test("软回滚关闭时也不增计数（过滤根本没出手）", async () => {
    const { handler, emit } = startHandler({
      sent: [],
      onEventWithEnv: vi.fn(async () => {}),
      selfEchoEnabled: false,
    } as any);

    emit(echoEvent());
    await new Promise((r) => setTimeout(r, 200));

    expect(handler.getSelfEchoDroppedCount()).toBe(0);
    handler.stop();
  });
});
