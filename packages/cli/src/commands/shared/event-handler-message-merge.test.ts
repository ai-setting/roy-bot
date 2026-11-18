/**
 * @fileoverview Task #5037-B — 飞书消息积压合并：同一 session 的 N 条未处理消息拼成一次 query
 *
 * ## 用户拍板的语义（父任务 #5037）
 *
 * > 「所谓合并是将**未被处理的同一个飞书 session 的消息都合并处理**」
 *
 * > 「将积累的多个飞书消息汇聚成一个 query 触发 agent 处理，
 *   **trigger event 可以记录最近的一个**」
 *
 * ## 本文件锁定的不变量
 *
 * 1. 同一 lane 连续 N 条 → **只触发 1 次** agent
 * 2. 合并后的 query **含全部 N 条**内容
 * 3. 合并顺序 = **时间正序**（后一条可能是对前一条的补充）
 * 4. trigger event 取**最后一条**（envEvent / envContext 都沿用最后一条）
 * 5. 只有 1 条时行为**与现状等价**（仍触发 1 次，内容是原文）
 * 6. **不同 lane 不合并**
 * 7. 合并**不影响** #5037-A 的秒级 ack 行为
 *
 * ## 合并时机（已拍板）
 *
 * 合并发生在 **`runLane` 出队那一刻**（agent 空闲时），lane 里剩下的全部合并。
 * **不设固定时间窗** —— 用户说的是「未被处理的都合并」；设定时器反而会引入
 * 「窗口外的消息怎么办」的边界 bug。
 */

import { describe, test, expect, vi } from "bun:test";
import { EventHandler } from "./event-handler";
import type { EventHandlerOptions } from "./event-handler";
import { EventMessageFormatter } from "./event-message-formatter";
import { buildMergedMessage } from "./event-handler";

// ============================================================================
// Helpers（沿用 #5037-A 的模板）
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

/** 真实形态的飞书用户消息 */
function userMessageEvent(
  over: Record<string, unknown> = {},
  meta: Record<string, unknown> = {},
) {
  return {
    id: "es-lark-cli-merge",
    type: "event-source.event.lark-cli",
    timestamp: Date.now(),
    payload: { message: "{}" },
    metadata: {
      source: "event-source",
      sourceId: "lark-cli",
      sourceMessageType: "im.message.receive_v1",
      chatId: CHAT,
      messageId: "om_merge_1",
      replyChannel: { type: "lark-cli", chatId: CHAT, messageId: "om_merge_1", profile: PROFILE },
      ...meta,
    },
    ...over,
  } as any;
}

/** 不同 chat 的用户消息 */
function userMessageEventB(over: Record<string, unknown> = {}) {
  return {
    id: "es-lark-cli-merge-b",
    type: "event-source.event.lark-cli",
    timestamp: Date.now(),
    payload: { message: "{}" },
    metadata: {
      source: "event-source",
      sourceId: "lark-cli",
      sourceMessageType: "im.message.receive_v1",
      chatId: CHAT_B,
      messageId: "om_merge_b1",
      replyChannel: { type: "lark-cli", chatId: CHAT_B, messageId: "om_merge_b1", profile: PROFILE },
    },
    ...over,
  } as any;
}

/**
 * 带**可区分内容**的用户消息 —— 合并后要能断言 query 含全部内容。
 *
 * `content` 会被 formatter 渲染进 item.message，所以这里给不同的 payload。
 */
function messageWithContent(content: string, over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) {
  return userMessageEvent(
    {
      ...over,
      payload: { message: JSON.stringify({ rawData: { text: content } }) },
    },
    meta,
  );
}

// ============================================================================
// 1~4. 核心：合并 + 顺序 + trigger event
// ============================================================================

describe("Task #5037-B — 消息合并：核心语义", () => {
  test("连续 3 条消息 → 只触发 1 次 agent，且 query 含全部 3 条", async () => {
    const sent: SentNotice[] = [];
    const onEventWithEnv = vi.fn(async () => {});
    const { handler, emit } = startHandler({ sent, onEventWithEnv });

    emit(messageWithContent("第一条内容", { id: "es-1" }, { messageId: "om_1" }));
    emit(messageWithContent("第二条内容", { id: "es-2" }, { messageId: "om_2" }));
    emit(messageWithContent("第三条内容", { id: "es-3" }, { messageId: "om_3" }));

    await waitFor(() => onEventWithEnv.mock.calls.length >= 1);
    await delay(150);

    // ★ 只触发 1 次
    expect(onEventWithEnv.mock.calls.length).toBe(1);

    const merged = onEventWithEnv.mock.calls[0][0] as any;
    const text: string = merged.message;

    // ★ 含全部 3 条
    expect(text).toContain("第一条内容");
    expect(text).toContain("第二条内容");
    expect(text).toContain("第三条内容");

    handler.stop();
  });

  test("合并顺序为时间正序（第 1 条在第 3 条之前）", async () => {
    const sent: SentNotice[] = [];
    const onEventWithEnv = vi.fn(async () => {});
    const { handler, emit } = startHandler({ sent, onEventWithEnv });

    emit(messageWithContent("AAA", { id: "es-1" }, { messageId: "om_1" }));
    emit(messageWithContent("BBB", { id: "es-2" }, { messageId: "om_2" }));
    emit(messageWithContent("CCC", { id: "es-3" }, { messageId: "om_3" }));

    await waitFor(() => onEventWithEnv.mock.calls.length >= 1);
    await delay(150);

    const text: string = (onEventWithEnv.mock.calls[0][0] as any).message;
    expect(text.indexOf("AAA")).toBeLessThan(text.indexOf("BBB"));
    expect(text.indexOf("BBB")).toBeLessThan(text.indexOf("CCC"));

    handler.stop();
  });

  test("trigger event 取最后一条（envEvent.id / messageId）", async () => {
    const sent: SentNotice[] = [];
    const onEventWithEnv = vi.fn(async () => {});
    const { handler, emit } = startHandler({ sent, onEventWithEnv });

    emit(messageWithContent("第一条", { id: "es-1" }, { messageId: "om_1" }));
    emit(messageWithContent("第二条", { id: "es-2" }, { messageId: "om_2" }));
    emit(messageWithContent("第三条", { id: "es-3" }, { messageId: "om_3" }));

    await waitFor(() => onEventWithEnv.mock.calls.length >= 1);
    await delay(150);

    const merged = onEventWithEnv.mock.calls[0][0] as any;
    // ★ 最后一条的 event id
    expect(merged.envEvent?.id).toBe("es-3");
    // ★ 最后一条的 messageId
    expect(
      (merged.envEvent?.metadata as any)?.messageId,
    ).toBe("om_3");

    handler.stop();
  });

  test("只有 1 条消息时行为与现状等价（触发 1 次，内容含原文）", async () => {
    const sent: SentNotice[] = [];
    const onEventWithEnv = vi.fn(async () => {});
    const { handler, emit } = startHandler({ sent, onEventWithEnv });

    emit(messageWithContent("单独一条", { id: "es-only" }, { messageId: "om_only" }));

    await waitFor(() => onEventWithEnv.mock.calls.length >= 1);
    await delay(150);

    expect(onEventWithEnv.mock.calls.length).toBe(1);
    const text: string = (onEventWithEnv.mock.calls[0][0] as any).message;
    expect(text).toContain("单独一条");

    handler.stop();
  });
});

// ============================================================================
// 5~6. lane 隔离
// ============================================================================

describe("Task #5037-B — 消息合并：lane 隔离", () => {
  test("不同 lane 不合并（各触发 1 次，共 2 次）", async () => {
    const sent: SentNotice[] = [];
    const onEventWithEnv = vi.fn(async () => {});
    const { handler, emit } = startHandler({ sent, onEventWithEnv });

    emit(messageWithContent("A1", { id: "es-a1" }, { messageId: "om_a1" }));
    emit(messageWithContent("A2", { id: "es-a2" }, { messageId: "om_a2" }));
    emit(userMessageEventB({ id: "es-b1" }));
    emit(userMessageEventB({ id: "es-b2" }));

    await waitFor(() => onEventWithEnv.mock.calls.length >= 2);
    await delay(200);

    // ★ A lane 合并成 1 次 + B lane 合并成 1 次 = 共 2 次
    expect(onEventWithEnv.mock.calls.length).toBe(2);

    const texts = onEventWithEnv.mock.calls.map((c: any[]) => String(c[0].message));
    // A lane 的合并产物含 A1/A2；B lane 的产物不含 A 的内容
    const aText = texts.find((t) => t.includes("A1"));
    const bText = texts.find((t) => !t.includes("A1"));
    expect(aText).toBeDefined();
    expect(aText).toContain("A2");
    expect(bText).toBeDefined();
    expect(bText).not.toContain("A1");

    handler.stop();
  });

  test("合并不影响 #5037-A 的秒级 ack（第 2 条仍立刻收到 ack）", async () => {
    const sent: SentNotice[] = [];
    // 让第 1 条卡住 → lane 保持 pending
    const gate = { release: false };
    const onEventWithEnv = vi.fn(async () => {
      while (!gate.release) await delay(5);
    });
    const { handler, emit } = startHandler({ sent, onEventWithEnv });

    emit(messageWithContent("第一条", { id: "es-1" }, { messageId: "om_1" }));
    await waitFor(() => onEventWithEnv.mock.calls.length >= 1);

    emit(messageWithContent("第二条", { id: "es-2" }, { messageId: "om_2" }));
    await waitFor(() => sent.length >= 1);

    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent[0].text).toContain("消息已收到");

    gate.release = true;
    handler.stop();
  });
});

// ============================================================================
// 7. 内部事件不合并（Task #4515 H2 不变量护栏）
// ============================================================================

describe("Task #5037-B — 消息合并：内部事件不合并", () => {
  test("task.background.* 通知事件**不**被合并（每条各触发 1 次）", async () => {
    const sent: SentNotice[] = [];
    const onEventWithEnv = vi.fn(async () => {});
    const { handler, emit } = startHandler({ sent, onEventWithEnv });

    // 两条后台通知（内部事件）—— 绝不合并
    emit({
      id: "evt-bg-1",
      type: "task.background.completed",
      timestamp: Date.now(),
      payload: { backgroundTaskId: "bg-1", status: "completed", result: "r1" },
      metadata: {
        source: "task.background",
        sourceId: "src",
        trigger_session_id: "t1",
        replyChannel: { type: "lark-cli", chatId: CHAT, messageId: "om_bg1" },
      },
    } as any);
    emit({
      id: "evt-bg-2",
      type: "task.background.completed",
      timestamp: Date.now(),
      payload: { backgroundTaskId: "bg-2", status: "completed", result: "r2" },
      metadata: {
        source: "task.background",
        sourceId: "src",
        trigger_session_id: "t2",
        replyChannel: { type: "lark-cli", chatId: CHAT, messageId: "om_bg2" },
      },
    } as any);

    await waitFor(() => onEventWithEnv.mock.calls.length >= 2, 5000);
    await delay(200);

    // ★ 内部事件各触发 1 次，不被合并成 1 次
    expect(onEventWithEnv.mock.calls.length).toBe(2);

    handler.stop();
  });

  test("用户消息与内部事件混合时，只合并用户消息，不跨越内部事件", async () => {
    const sent: SentNotice[] = [];
    const onEventWithEnv = vi.fn(async () => {});
    const { handler, emit } = startHandler({ sent, onEventWithEnv });

    // ⚠️ 必须逐条 emit + 等一拍：`handleEvent` 对 rule-notice 事件（task.background.*）
    //   会先 await `sendRuleNotice` 再入队 → 不同类型事件的**入队顺序**不保证等于
    //   emit 顺序。测试要验证「不跨内部事件合并」，必须先把 lane 顺序钉死。
    emit(messageWithContent("用户第一条", { id: "es-u1" }, { messageId: "om_u1" }));
    await delay(80);
    emit({
      id: "evt-bg-mid",
      type: "task.background.completed",
      timestamp: Date.now(),
      payload: { backgroundTaskId: "bg-mid", status: "completed" },
      metadata: {
        source: "task.background",
        sourceId: "src",
        trigger_session_id: "tmid",
        replyChannel: { type: "lark-cli", chatId: CHAT, messageId: "om_bgmid" },
      },
    } as any);
    await delay(80);
    emit(messageWithContent("用户第二条", { id: "es-u2" }, { messageId: "om_u2" }));

    await waitFor(() => onEventWithEnv.mock.calls.length >= 3, 5000);
    await delay(200);

    // ★ 3 条各触发 1 次（用户消息没被跨过内部事件合并到一起）
    expect(onEventWithEnv.mock.calls.length).toBe(3);

    const texts = onEventWithEnv.mock.calls.map((c: any[]) => String(c[0].message));
    const userTexts = texts.filter((t) => t.includes("用户"));
    // 用户消息各自独立（没被合并成一条含两条的 query）
    expect(userTexts.some((t) => t.includes("用户第一条") && t.includes("用户第二条"))).toBe(false);

    handler.stop();
  });
});

// ============================================================================
// 8. 截断标注（DS review MINOR-2）
// ============================================================================

describe("Task #5037-B — 消息合并：截断标注", () => {
  test("总长超限时标注出被省略的条号区间", () => {
    // 每条 600 字（超过单条 500 上限 → 也会触发单条截断），10 条足以撑爆 4000 总长
    const long = "x".repeat(600);
    const batch = Array.from({ length: 10 }, (_, i) => ({ message: `${i + 1}:${long}` }));

    const out = buildMergedMessage(batch);

    // ★ 必须明确告知省略了哪几条 —— 可能是「算了别做了」这类改变意图的短句
    expect(out).toContain("已省略第");
    expect(out).toMatch(/已省略第 \d+~\d+ 条，共 \d+ 条/);
  });

  test("单条超长时标注单条截断（不谎报省略条数）", () => {
    const batch = [{ message: "y".repeat(900) }];
    const out = buildMergedMessage(batch);

    expect(out).toContain("已截断");
    expect(out).not.toContain("已省略第");
  });

  test("内容不超限时无任何截断标注", () => {
    const out = buildMergedMessage([
      { message: "短消息一" },
      { message: "短消息二" },
    ]);

    expect(out).toContain("短消息一");
    expect(out).toContain("短消息二");
    expect(out).not.toContain("已截断");
    expect(out).not.toContain("已省略第");
  });

  test("空 batch 返回空串；单条 batch 原样返回", () => {
    expect(buildMergedMessage([])).toBe("");
    expect(buildMergedMessage([{ message: "只有一条" }])).toBe("只有一条");
  });
});
