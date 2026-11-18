/**
 * @fileoverview Task #5062 — 飞书消息积压秒级 ack（rule-based 直发，不走 agent 主循环）
 *
 * ## 用户拍板的语义（父任务 #5037）
 *
 * > 「enqueue() 时若该 lane（同一个飞书 session）已有**未处理**的消息
 *   （lane 非空 **或** 该 lane 正在跑 in-flight），则为**新到的这条**消息
 *   **立即**发一条 rule-based ack「消息已收到，正在处理中，请耐心等候」」
 *
 * ## 本文件锁定的不变量
 *
 * 1. lane 空 + 无 in-flight → **第一条**消息**不发** ack
 * 2. lane 已有 pending → 第 2 条消息**立即**发 ack
 * 3. lane 正在跑（in-flight）→ 新消息发 ack
 * 4. ack **不走 agent 主循环**（不调 onEventWithEnv）
 * 5. ack **不占用执行槽**（不调 acquireSlot）
 * 6. ack 是 **fire-and-forget**（enqueue 同步返回，不 await）
 * 7. 不同 lane **互不** ack
 * 8. ack **不发给** telemetry / 终态回执 / 卡片点击事件
 * 9. ack 发送失败**不影响** lane 调度
 * 10. 幂等键存在且 **≤ 50 字符**
 * 11. **self-echo**：bot 自己发的 ack（senderType=`app`）被 `isSelfEchoEvent`
 *     判为 skip → 不会回灌触发第二次 agent run
 *
 * ## 为什么不需要改 self-echo-filter.ts
 *
 * `self-echo-filter.ts` L77 的 `BOT_SENDER_TYPES = {bot, app}`，
 * `isSelfEchoEvent` L210 第 1 条即 `senderType ∈ {bot,app} → skip`。
 * 飞书侧 bot 自己发的消息 `sender_type = app` → 命中 → 被丢弃。
 * 本文件用测试把这条不变量钉死（用例 11）。
 */

import { describe, test, expect, vi } from "bun:test";
import { EventHandler, buildPendingAckText } from "./event-handler";
import type { EventHandlerOptions } from "./event-handler";
import { EventMessageFormatter } from "./event-message-formatter";
import { isSelfEchoEvent } from "./self-echo-filter";

// ============================================================================
// Helpers
// ============================================================================

const CHAT = "oc_8904d6f184e31b6cc51ba53a0a19aa2f";
const CHAT_B = "oc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PROFILE = "tongzhuli";

async function waitFor(fn: () => boolean, timeout = 3000, interval = 5): Promise<void> {
  const start = Date.now();
  while (!fn() && Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, interval));
  }
  if (!fn()) throw new Error(`waitFor timed out after ${timeout}ms`);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeSessionComponent() {
  return {
    create: vi.fn().mockImplementation(async (opts: any) => ({
      id: opts?.id ?? `gen-${Math.random().toString(36).slice(2, 8)}`,
      title: opts?.title ?? "Lark Chat",
    })),
    get: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockImplementation(async (options: any) => {
      const filterChatId = options?.filter?.metadata?.chatId;
      return filterChatId ? [{ id: filterChatId, title: `Lark Chat ${filterChatId}` }] : [];
    }),
    getActiveSessionId: vi.fn().mockReturnValue(undefined),
    setActiveSession: vi.fn().mockResolvedValue(true),
  };
}

interface SentNotice {
  chatId?: string;
  profile?: string;
  text: string;
  idempotencyKey?: string;
  sink?: "lark" | "stdout";
}

function makeHandler(opts: {
  sent: SentNotice[];
  onEventWithEnv?: any;
  sessionComponent?: any;
  senderThrows?: boolean;
  selfEchoEnabled?: boolean;
}): EventHandler {
  return new EventHandler({
    env: { subscribeAll: () => () => {}, getComponent: () => undefined } as any,
    eventTypes: ["task.background.*", "event-source.event.*"],
    formatter: new EventMessageFormatter({ prefix: "[通知]" }),
    onEvent: async () => {},
    onEventWithEnv: opts.onEventWithEnv ?? (async () => {}),
    sessionComponent: (opts.sessionComponent ?? makeSessionComponent()) as any,
    ...(opts.selfEchoEnabled !== undefined
      ? { selfEchoFilter: { enabled: opts.selfEchoEnabled } }
      : {}),
    telemetrySender: async (notice: SentNotice) => {
      if (opts.senderThrows) throw new Error("lark-cli exited with code 1");
      opts.sent.push(notice);
    },
  } as EventHandlerOptions);
}

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

function startHandler(opts: Parameters<typeof makeHandler>[0]) {
  const handler = makeHandler(opts);
  const { env, emit } = makeSubscribableEnv();
  (handler as any).env = env;
  handler.start();
  return { handler, emit };
}

/**
 * 真实形态的飞书用户消息。
 *
 * 生产链：`event-source-handlers.ts` 构造
 *   `type: "event-source.event.lark-cli"`
 *   `metadata.sourceMessageType: "im.message.receive_v1"`（真实事件类型在这里）
 */
function userMessageEvent(over: Record<string, unknown> = {}) {
  return {
    id: "es-lark-cli-123",
    type: "event-source.event.lark-cli",
    timestamp: Date.now(),
    payload: { message: "{}" },
    metadata: {
      source: "event-source",
      sourceId: "lark-cli",
      sourceMessageType: "im.message.receive_v1",
      chatId: CHAT,
      messageId: "om_xxx",
      replyChannel: { type: "lark-cli", chatId: CHAT, messageId: "om_xxx", profile: PROFILE },
      ...over,
    },
  } as any;
}

/** 不同 chat 的用户消息（用于「不同 lane 互不 ack」） */
function userMessageEventB(over: Record<string, unknown> = {}) {
  return {
    id: "es-lark-cli-456",
    type: "event-source.event.lark-cli",
    timestamp: Date.now(),
    payload: { message: "{}" },
    metadata: {
      source: "event-source",
      sourceId: "lark-cli",
      sourceMessageType: "im.message.receive_v1",
      chatId: CHAT_B,
      messageId: "om_yyy",
      replyChannel: { type: "lark-cli", chatId: CHAT_B, messageId: "om_yyy", profile: PROFILE },
      ...over,
    },
  } as any;
}

// ============================================================================
// 1. lane 空 + 无 in-flight → 第一条消息**不发** ack
// ============================================================================

describe("Task #5062 — 积压秒级 ack：触发条件", () => {
  test("lane 空 + 无 in-flight：第一条用户消息不发 ack", async () => {
    const sent: SentNotice[] = [];
    const { handler, emit } = startHandler({ sent });

    emit(userMessageEvent());
    // 等待 agent 侧处理完（证明「不是没触发，只是没发 ack」）
    await waitFor(() => handler.getQueueLength() === 0);
    await delay(50);

    expect(sent).toHaveLength(0);
    handler.stop();
  });

  // ==========================================================================
  // 2. lane 已有 pending → 第 2 条消息**立即**发 ack
  // ==========================================================================

  test("lane 已有 pending：第 2 条消息立即发 ack（chatId + profile + 文案）", async () => {
    const sent: SentNotice[] = [];
    // 让第 1 条消息卡住 → lane 保持 pending
    const gate = { release: false };
    const onEventWithEnv = vi.fn(async () => {
      while (!gate.release) await delay(5);
    });
    const { handler, emit } = startHandler({ sent, onEventWithEnv });

    // 第 1 条：进 lane，agent 开始处理（卡住）
    emit(userMessageEvent({ messageId: "om_1" }));
    await waitFor(() => onEventWithEnv.mock.calls.length >= 1);

    // 第 2 条：lane 有 pending → 应立即发 ack
    emit(userMessageEvent({ messageId: "om_2", id: "es-lark-cli-124" }));
    await waitFor(() => sent.length === 1);

    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe(CHAT);
    expect(sent[0].profile).toBe(PROFILE);
    expect(sent[0].text).toContain("消息已收到");
    expect(sent[0].text).toContain("正在处理中");

    gate.release = true;
    handler.stop();
  });

  // ==========================================================================
  // 3. lane 正在跑（in-flight）→ 新消息发 ack
  // ==========================================================================

  test("lane 正在跑（in-flight）：新消息发 ack", async () => {
    const sent: SentNotice[] = [];
    const gate = { release: false };
    const onEventWithEnv = vi.fn(async () => {
      while (!gate.release) await delay(5);
    });
    const { handler, emit } = startHandler({ sent, onEventWithEnv });

    // 第 1 条：agent 正在跑（in-flight，lane 数组已空）
    emit(userMessageEvent({ messageId: "om_1" }));
    await waitFor(() => onEventWithEnv.mock.calls.length >= 1);
    expect(handler.getQueueLength()).toBeGreaterThan(0); // 含 in-flight

    // 第 2 条：lane 数组空但 in-flight → 仍应发 ack
    emit(userMessageEvent({ messageId: "om_2", id: "es-lark-cli-124" }));
    await waitFor(() => sent.length === 1);

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("消息已收到");

    gate.release = true;
    handler.stop();
  });

  // ==========================================================================
  // 4. ack **不走 agent 主循环**
  // ==========================================================================

  test("ack 不触发 agent 主循环：onEventWithEnv 调用次数不因 ack 增加", async () => {
    const sent: SentNotice[] = [];
    const gate = { release: false };
    const onEventWithEnv = vi.fn(async () => {
      while (!gate.release) await delay(5);
    });
    const { handler, emit } = startHandler({ sent, onEventWithEnv });

    emit(userMessageEvent({ messageId: "om_1" }));
    await waitFor(() => onEventWithEnv.mock.calls.length >= 1);
    const callsBeforeAck = onEventWithEnv.mock.calls.length;

    // 第 2 条 → 发 ack，但**不**触发 agent
    emit(userMessageEvent({ messageId: "om_2", id: "es-lark-cli-124" }));
    await waitFor(() => sent.length === 1);
    await delay(80);

    expect(sent).toHaveLength(1);
    expect(onEventWithEnv.mock.calls.length).toBe(callsBeforeAck);

    gate.release = true;
    handler.stop();
  });
});

// ============================================================================
// 5-8. ack 与主流程的隔离
// ============================================================================

describe("Task #5062 — 积压秒级 ack：与主流程隔离", () => {
  // ==========================================================================
  // 5. ack **不占用执行槽**
  // ==========================================================================

  test("ack 不占用执行槽：activeSlots 不因 ack 增加", async () => {
    const sent: SentNotice[] = [];
    const gate = { release: false };
    const onEventWithEnv = vi.fn(async () => {
      while (!gate.release) await delay(5);
    });
    const { handler, emit } = startHandler({ sent, onEventWithEnv });

    emit(userMessageEvent({ messageId: "om_1" }));
    await waitFor(() => onEventWithEnv.mock.calls.length >= 1);
    const slotsBefore = (handler as any).activeSlots as number;

    // 第 2 条 → 只发 ack，不该新增槽位占用
    emit(userMessageEvent({ messageId: "om_2", id: "es-lark-cli-124" }));
    await waitFor(() => sent.length === 1);
    await delay(50);

    expect((handler as any).activeSlots as number).toBe(slotsBefore);

    gate.release = true;
    handler.stop();
  });

  // ==========================================================================
  // 6. ack 是 **fire-and-forget**（enqueue 同步返回）
  // ==========================================================================

  test("ack 是 fire-and-forget：enqueue 同步返回，不等 ack 发完", async () => {
    const sent: SentNotice[] = [];
    let senderResolved = false;
    const handler = new EventHandler({
      env: { subscribeAll: () => () => {}, getComponent: () => undefined } as any,
      eventTypes: ["task.background.*", "event-source.event.*"],
      formatter: new EventMessageFormatter({ prefix: "[通知]" }),
      onEvent: async () => {},
      onEventWithEnv: async () => {},
      sessionComponent: makeSessionComponent() as any,
      telemetrySender: async (notice: SentNotice) => {
        // 模拟 lark-cli 直发的长耗时（5s 硬超时场景）
        await delay(200);
        senderResolved = true;
        sent.push(notice);
      },
    } as EventHandlerOptions);

    // 先塞一条占住 lane
    const gate = { release: false };
    (handler as any).onEventWithEnv = async () => {
      while (!gate.release) await delay(5);
    };
    const first = handler.formatter!.formatWithEvent(userMessageEvent({ messageId: "om_1" }) as any);
    handler.enqueue(first);
    await delay(30);

    // 第 2 条 → 应触发 ack，但 enqueue 必须**同步返回**
    const second = handler.formatter!.formatWithEvent(userMessageEvent({ messageId: "om_2", id: "es-lark-cli-124" }) as any);
    const t0 = Date.now();
    handler.enqueue(second);
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(100); // 没等 200ms 的 sender
    expect(senderResolved).toBe(false); // sender 还没跑完

    gate.release = true;
    handler.stop();
  });

  // ==========================================================================
  // 7. 不同 lane **互不** ack
  // ==========================================================================

  test("不同 lane 互不 ack：A lane 的消息不给 B lane 发 ack", async () => {
    const sent: SentNotice[] = [];
    const gate = { release: false };
    const onEventWithEnv = vi.fn(async () => {
      while (!gate.release) await delay(5);
    });
    const { handler, emit } = startHandler({ sent, onEventWithEnv });

    // A lane 第 1 条 → 占用 A lane
    emit(userMessageEvent({ messageId: "om_a1" }));
    await waitFor(() => onEventWithEnv.mock.calls.length >= 1);

    // B lane 第 1 条 → B lane 是空的，**不应**发 ack
    emit(userMessageEventB({ messageId: "om_b1" }));
    await delay(150);

    expect(sent).toHaveLength(0);

    // B lane 第 2 条 → B lane 已有 pending → 发 ack，且 chatId 是 B
    emit(userMessageEventB({ messageId: "om_b2", id: "es-lark-cli-789" }));
    await waitFor(() => sent.length === 1);

    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe(CHAT_B);

    gate.release = true;
    handler.stop();
  });

  // ==========================================================================
  // 8. ack **不发给** telemetry / 终态 / 卡片点击事件
  // ==========================================================================

  test("ack 不发给 telemetry / 终态 / 卡片点击事件", async () => {
    const sent: SentNotice[] = [];
    const { handler, emit } = startHandler({ sent });

    // telemetry（started）—— handleEvent 里已 return，防御性地再挡一层
    emit({
      id: "evt-started",
      type: "task.background.started",
      timestamp: Date.now(),
      payload: { backgroundTaskId: "p1", description: "d" },
      metadata: {
        source: "task.background",
        sourceId: "src",
        replyChannel: { type: "lark-cli", chatId: CHAT, messageId: "om_x", profile: PROFILE },
      },
    } as any);
    await delay(80);

    // 终态回执（completed）
    emit({
      id: "evt-completed",
      type: "task.background.completed",
      timestamp: Date.now(),
      payload: { backgroundTaskId: "p1", description: "d", result: "ok" },
      metadata: {
        source: "task.background",
        sourceId: "src",
        replyChannel: { type: "lark-cli", chatId: CHAT, messageId: "om_x", profile: PROFILE },
      },
    } as any);
    await delay(120);

    // 卡片点击（card.action.trigger）—— 不是用户消息
    emit({
      id: "es-lark-cli-card",
      type: "event-source.event.lark-cli",
      timestamp: Date.now(),
      payload: { message: "{}" },
      metadata: {
        source: "event-source",
        sourceId: "lark-cli",
        sourceMessageType: "card.action.trigger",
        chatId: CHAT,
        replyChannel: { type: "lark-cli", chatId: CHAT, messageId: "om_card", profile: PROFILE },
      },
    } as any);
    await delay(120);

    // 上面这些都不该产生 ack（sent 里只可能有 completed 的终态回执，不是 ack）
    const acks = sent.filter((n) => n.text.includes("消息已收到"));
    expect(acks).toHaveLength(0);

    handler.stop();
  });
});

// ============================================================================
// 9-11. 容错 / 幂等 / self-echo
// ============================================================================

describe("Task #5062 — 积压秒级 ack：容错 / 幂等 / 自我回声", () => {
  // ==========================================================================
  // 9. ack 发送失败**不影响** lane 调度
  // ==========================================================================

  test("ack 发送失败不影响 lane 调度：消息仍被正常处理", async () => {
    const sent: SentNotice[] = [];
    const onEventWithEnv = vi.fn(async () => {});
    // sender 抛异常
    const { handler, emit } = startHandler({ sent, onEventWithEnv, senderThrows: true });

    emit(userMessageEvent({ messageId: "om_1" }));
    await waitFor(() => onEventWithEnv.mock.calls.length >= 1);

    // 第 2 条 → ack 发送失败（抛），但不能影响 lane
    emit(userMessageEvent({ messageId: "om_2", id: "es-lark-cli-124" }));
    await delay(150);

    // 第 2 条仍然被正常处理（agent 主循环走到了第 2 次）
    await waitFor(() => onEventWithEnv.mock.calls.length >= 2);
    expect(onEventWithEnv.mock.calls.length).toBeGreaterThanOrEqual(2);

    handler.stop();
  });

  // ==========================================================================
  // 10. 幂等键存在且 **≤ 50 字符**
  // ==========================================================================

  test("ack 幂等键存在且 ≤ 50 字符", async () => {
    const sent: SentNotice[] = [];
    const gate = { release: false };
    const onEventWithEnv = vi.fn(async () => {
      while (!gate.release) await delay(5);
    });
    const { handler, emit } = startHandler({ sent, onEventWithEnv });

    emit(userMessageEvent({ messageId: "om_1" }));
    await waitFor(() => onEventWithEnv.mock.calls.length >= 1);

    emit(userMessageEvent({ messageId: "om_2", id: "es-lark-cli-124" }));
    await waitFor(() => sent.length === 1);

    expect(sent[0].idempotencyKey).toBeDefined();
    expect(sent[0].idempotencyKey!.length).toBeGreaterThan(0);
    expect(sent[0].idempotencyKey!.length).toBeLessThanOrEqual(50);

    gate.release = true;
    handler.stop();
  });

  // ==========================================================================
  // 11. **self-echo**：bot 自己发的 ack 不会被当成用户消息回灌
  // ==========================================================================

  test("self-echo：bot 自己发的 ack（senderType=app）被判为 skip，不会触发第二次 agent run", async () => {
    // ① 纯函数层：bot senderType=app → skip
    const botEcho = {
      id: "es-lark-cli-echo",
      type: "event-source.event.lark-cli",
      timestamp: Date.now(),
      payload: { message: "{}" },
      metadata: {
        source: "event-source",
        sourceId: "lark-cli",
        sourceMessageType: "im.message.receive_v1",
        senderType: "app",
        senderId: "ou_bot_self_open_id",
        chatId: CHAT,
        replyChannel: { type: "lark-cli", chatId: CHAT, messageId: "om_echo", profile: PROFILE },
      },
    } as any;

    const verdict = isSelfEchoEvent(botEcho, { selfBotIds: [] });
    expect(verdict.skip).toBe(true);
    expect(verdict.reason).toBe("bot-sender");

    // ② 集成层：把这条 bot 回声喂进 handler → 不进 lane、不跑 agent
    const sent: SentNotice[] = [];
    const onEventWithEnv = vi.fn(async () => {});
    const { handler, emit } = startHandler({ sent, onEventWithEnv });

    emit(botEcho);
    await delay(150);

    expect(onEventWithEnv.mock.calls.length).toBe(0);
    expect(handler.getQueueLength()).toBe(0);
    expect(sent).toHaveLength(0);
    expect(handler.getSelfEchoDroppedCount()).toBe(1);

    handler.stop();
  });

  test("self-echo 兜底：senderType 口径漂移为 user 时，senderId 命中 selfBotIds 仍被过滤", async () => {
    const botEcho = {
      id: "es-lark-cli-echo2",
      type: "event-source.event.lark-cli",
      timestamp: Date.now(),
      payload: { message: "{}" },
      metadata: {
        source: "event-source",
        sourceId: "lark-cli",
        sourceMessageType: "im.message.receive_v1",
        senderType: "user",
        senderId: "ou_bot_self_open_id",
        chatId: CHAT,
        replyChannel: { type: "lark-cli", chatId: CHAT, messageId: "om_echo2", profile: PROFILE },
      },
    } as any;

    const verdict = isSelfEchoEvent(botEcho, { selfBotIds: ["ou_bot_self_open_id"] });
    expect(verdict.skip).toBe(true);
    expect(verdict.reason).toBe("self-bot-id");
  });
});

// ============================================================================
// ★ DS review MAJOR-1 回归护栏：ack 正文不得泄漏原始 JSON
//
// ## 生产的 payload 形态（event-source-handlers.ts L1904）
//
//   const message = JSON.stringify({
//     rawData,               // ← 飞书原始事件（用户正文在这里面）
//     recommendedAction,
//     ...(triggerEventId ? { triggerEventId } : {}),
//   });
//
// 也就是说 `payload.message` 是**整个信封 JSON**，不是用户正文。
// 旧的 `stripJsonNoise()` 只查顶层 text/content/body/message → 一个都不命中
// → 原样返回整个 JSON → 被截断 50 字符 → 用户收到半截 `{"rawData":...`。
//
// ## 本组用例锁定的契约
//
// 1. ack 正文**只含固定规则文案**，不含任何 JSON 片段
// 2. ack 正文**不含**用户原文（摘要不进正文；完整属性进日志）
// ============================================================================

/** 生产形态的飞书用户消息（payload.message = 整个信封 JSON） */
function productionUserMessageEvent(over: Record<string, unknown> = {}) {
  return {
    id: "es-lark-cli-prod",
    type: "event-source.event.lark-cli",
    timestamp: Date.now(),
    payload: {
      message: JSON.stringify({
        rawData: {
          type: "im.message.receive_v1",
          event: {
            sender: { sender_type: "user", sender_id: "ou_1759934f98e0677e17f09591389c24f1" },
            message: {
              message_type: "text",
              content: JSON.stringify({ text: "用户真实输入内容" }),
            },
          },
        },
        recommendedAction: { action: "处理飞书 群聊消息并以机器人身份回复" },
        triggerEventId: "evt_1793884146028",
      }),
    },
    metadata: {
      source: "event-source",
      sourceId: "lark-cli",
      sourceMessageType: "im.message.receive_v1",
      chatId: CHAT,
      messageId: "om_prod_1",
      replyChannel: { type: "lark-cli", chatId: CHAT, messageId: "om_prod_1", profile: PROFILE },
      ...over,
    },
  } as any;
}

describe("Task #5062 — DS review MAJOR-1 回归：ack 正文不泄漏原始 JSON", () => {
  test("生产信封形态下，ack 正文不含 rawData / JSON 片段 / 用户原文", async () => {
    const sent: SentNotice[] = [];
    // 让第 1 条卡住 → lane 保持 pending，第 2 条才会触发 ack
    const gate = { release: false };
    const onEventWithEnv = vi.fn(async () => {
      while (!gate.release) await delay(5);
    });
    const { handler, emit } = startHandler({ sent, onEventWithEnv });

    emit(productionUserMessageEvent());
    await waitFor(() => onEventWithEnv.mock.calls.length >= 1);

    // 第 1 条不发 ack
    await delay(50);
    expect(sent).toHaveLength(0);

    // 第 2 条 → 发 ack
    emit(productionUserMessageEvent({ messageId: "om_prod_2" }));
    await waitFor(() => sent.length >= 1);
    await delay(50);

    expect(sent.length).toBeGreaterThanOrEqual(1);
    const text = sent[0].text;

    // 固定文案在
    expect(text).toContain("消息已收到");
    // ★ 不得出现任何 JSON 垃圾
    expect(text).not.toContain("rawData");
    expect(text).not.toContain("recommendedAction");
    expect(text).not.toContain("triggerEventId");
    expect(text).not.toContain("sender_type");
    expect(text).not.toContain("ou_1759934f98e0677e17f09591389c24f1");
    expect(text).not.toContain("{");
    expect(text).not.toContain("}");
    // ★ 不得回显用户原文
    expect(text).not.toContain("用户真实输入内容");

    gate.release = true;
    handler.stop();
  });

  test("buildPendingAckText() 无参时只输出固定文案", () => {
    // 签名已无参 —— 「任何动态内容都不可能进正文」由类型系统保证。
    // 真正的护栏是上面那条集成用例（生产信封 + 端到端 emit）。
    expect(buildPendingAckText()).toBe("✅ 消息已收到，正在处理中，请耐心等候");
  });
});
