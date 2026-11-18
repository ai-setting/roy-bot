/**
 * @fileoverview lane ↔ session 1:1 不变量测试 (Task #4515 / H2)
 *
 * ## 问题（#4514 复审 H2）
 *
 * lane key 用 **transport id**（`chatId` / `trigger:<sid>` / `__default__`），
 * 而 session 用 **storage id**（chat session 的 `id === chatId`，但 trigger 路径
 * 解析出来的 session id 是**另一套空间的 id**）。两个 key 空间不 1:1：
 *
 *   lane A = `oc_A`（chat lane,          chatId=oc_A）
 *   lane B = `trigger:oc_A`（trigger lane，事件无 replyChannel → chatId=undefined）
 *   两条 lane 经 `ensureActiveSession()` 的「优 2 / 优 3」都解析到 **session `oc_A`**
 *   → 两个 lane 各自跑 `waitForIdle(sessionId)`，但**同一时刻都能看到 idle**，
 *     于是同一 session 被两轮并发写（上下文错乱）。
 *
 * 另外门禁是 check-then-act（`waitForIdle` 返回后到真正开始跑之间有窗口），
 * 即使 sessionId 相同也可能都通过 —— TOCTOU。
 *
 * ## 修复（双管齐下）
 *
 * ① 根治：**先解析 session，再用解析出的 sessionId 当 lane key**（1:1）
 * ② 兜底：门禁改成**原子声明** —— `claimSession(sid)` 占位，避免 TOCTOU
 *
 * ## 本测试锁定的不变量
 *
 * - 两个不同的 transport key 解析到**同一 sessionId** 时，处理必须**串行**
 * - 解析到不同 sessionId 时仍**并行**（不能为修 H2 把并发干掉）
 * - 同一个 transport key 的多次事件仍 FIFO 串行
 */

import { describe, test, expect, vi, beforeEach } from "bun:test";
import { EventHandler } from "./event-handler";
import type { EventHandlerOptions } from "./event-handler";
import {
  EventMessageFormatter,
  type FormattedEvent,
} from "./event-message-formatter";

// ============================================================================
// Helpers
// ============================================================================

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

const formatter = new EventMessageFormatter({ prefix: "[测试]" });

/** 飞书事件：带 chatId（→ chat lane） */
function eventWithChat(chatId: string, tag = "e") {
  return {
    type: "event-source.event.lark-cli",
    payload: { tag },
    metadata: {
      sourceId: "test-source",
      replyChannel: { type: "lark-cli", chatId, messageId: `om_${tag}` },
    },
  };
}

/**
 * 后台通知：带 trigger_session_id、**无 replyChannel**（→ trigger lane）。
 * 这是 H2 的生产可达路径（`task.background.*` 无 replyChannel）。
 */
function eventWithTrigger(triggerSessionId: string, tag = "e") {
  return {
    type: "task.background.completed",
    payload: { tag },
    metadata: { sourceId: "test-source", trigger_session_id: triggerSessionId },
  };
}

function format(evt: unknown): FormattedEvent {
  return formatter.formatWithEvent(evt as any);
}

function tagOf(fe: FormattedEvent): string {
  return ((fe.envEvent?.payload as { tag?: string })?.tag ?? "?");
}

interface Trace {
  tag: string;
  sessionId?: string;
  start: number;
  end: number;
}

/**
 * SessionComponent mock：
 * - `create({id})` 返回 `id`（chat 路径）
 * - `get(id)` 对已存在的 session 返回该 session（trigger 优2 路径）
 * - `list()` 对 chatId 返回一行（chat 路径命中已有）
 * - `getActiveSessionId()` 返回 undefined（避免优3 干扰本组的显式场景）
 *
 * `sameSession` 场景：让 trigger lane 解析出的 session id 与 chat lane 相同。
 */
function makeSessionComponent(opts: {
  /** trigger id → 解析出的 session id */
  triggerToSession?: Record<string, string>;
  /** chatId → 已有 session id（默认 === chatId） */
  chatToSession?: Record<string, string>;
  /** 全局 active session（优3） */
  activeSessionId?: string;
}) {
  const sessionExists = new Set<string>();
  for (const v of Object.values(opts.triggerToSession ?? {})) sessionExists.add(v);
  for (const v of Object.values(opts.chatToSession ?? {})) sessionExists.add(v);

  return {
    create: vi.fn().mockImplementation(async (o: any) => {
      const id = o?.id ?? `gen-${Math.random().toString(36).slice(2, 8)}`;
      sessionExists.add(id);
      return { id, title: o?.title ?? "Lark Chat" };
    }),
    get: vi.fn().mockImplementation(async (id: string) => {
      // 优2 路径：trigger id 映射到目标 session（可能与 chat lane 的 session 相同）
      const mapped = opts.triggerToSession?.[id] ?? (sessionExists.has(id) ? id : undefined);
      return mapped ? { id: mapped, title: `Session ${mapped}` } : undefined;
    }),
    list: vi.fn().mockImplementation(async (o: any) => {
      const chatId = o?.filter?.metadata?.chatId;
      if (!chatId) return [];
      const sid = opts.chatToSession?.[chatId] ?? chatId;
      return [{ id: sid, title: `Lark Chat ${chatId}` }];
    }),
    getActiveSessionId: vi.fn().mockReturnValue(opts.activeSessionId),
    setActiveSession: vi.fn().mockResolvedValue(true),
  };
}

function createOptions(overrides: Partial<EventHandlerOptions> = {}): EventHandlerOptions {
  return {
    env: { subscribeAll: vi.fn().mockReturnValue(() => {}) } as any,
    eventTypes: ["event-source.event.*", "task.background.*"],
    formatter,
    isIdle: () => true,
    onEvent: vi.fn().mockResolvedValue(undefined),
    maxConcurrentSessions: 32, // 不让并发上限掩盖问题
    ...overrides,
  };
}

function makeTracer(delays: Record<string, number>, traces: Trace[]) {
  return vi.fn().mockImplementation(async (fe: FormattedEvent) => {
    const tag = tagOf(fe);
    const start = Date.now();
    await delay(delays[tag] ?? 0);
    traces.push({ tag, sessionId: fe.eventSessionId, start, end: Date.now() });
  });
}

/** 判定 traces 里是否有执行区间重叠 */
function hasOverlap(traces: Trace[]): boolean {
  for (let i = 0; i < traces.length; i++) {
    for (let j = i + 1; j < traces.length; j++) {
      const a = traces[i];
      const b = traces[j];
      if (a.start < b.end && b.start < a.end) return true;
    }
  }
  return false;
}

let sessionComponent: ReturnType<typeof makeSessionComponent>;

beforeEach(() => {
  sessionComponent = makeSessionComponent({});
});

// ============================================================================
// H2-1: 两个 lane 解析到同一 sessionId → 必须串行
// ============================================================================

describe("Task #4515 (H2): lane 与 session 必须 1:1", () => {
  test("chat lane 与 trigger lane 解析到同一 session 时必须串行", async () => {
    // chatId=oc_A → session "shared-session"
    // trigger=t1   → 也解析到 session "shared-session"（H2 的撞车场景）
    sessionComponent = makeSessionComponent({
      chatToSession: { oc_A: "shared-session" },
      triggerToSession: { t1: "shared-session" },
    });

    const traces: Trace[] = [];
    const onEventWithEnv = makeTracer({ c1: 60, n1: 60 }, traces);

    const handler = new EventHandler(
      createOptions({ sessionComponent: sessionComponent as any, onEventWithEnv }),
    );

    handler.enqueue(format(eventWithChat("oc_A", "c1")));
    handler.enqueue(format(eventWithTrigger("t1", "n1")));

    await waitFor(() => traces.length >= 2, 5000);

    // ★ 核心断言：两条事件都落在同一 session，执行区间绝不能重叠
    expect(traces.map((t) => t.sessionId)).toEqual(["shared-session", "shared-session"]);
    expect(hasOverlap(traces)).toBe(false);

    handler.stop();
  });

  test("三条不同 transport key 都解析到同一 session → 严格串行（不重叠）", async () => {
    sessionComponent = makeSessionComponent({
      chatToSession: { oc_A: "shared" },
      triggerToSession: { t1: "shared", t2: "shared" },
    });

    const traces: Trace[] = [];
    const onEventWithEnv = makeTracer({ c1: 40, n1: 40, n2: 40 }, traces);

    const handler = new EventHandler(
      createOptions({ sessionComponent: sessionComponent as any, onEventWithEnv }),
    );

    handler.enqueue(format(eventWithChat("oc_A", "c1")));
    handler.enqueue(format(eventWithTrigger("t1", "n1")));
    handler.enqueue(format(eventWithTrigger("t2", "n2")));

    await waitFor(() => traces.length >= 3, 8000);

    expect(hasOverlap(traces)).toBe(false);
    expect(traces.length).toBe(3);

    handler.stop();
  });

  test("解析到不同 session 时仍然并行（修 H2 不能把并发干掉）", async () => {
    sessionComponent = makeSessionComponent({
      chatToSession: { oc_A: "sess_A" },
      triggerToSession: { t1: "sess_B" },
    });

    const traces: Trace[] = [];
    const onEventWithEnv = makeTracer({ c1: 60, n1: 60 }, traces);

    const handler = new EventHandler(
      createOptions({ sessionComponent: sessionComponent as any, onEventWithEnv }),
    );

    handler.enqueue(format(eventWithChat("oc_A", "c1")));
    handler.enqueue(format(eventWithTrigger("t1", "n1")));

    await waitFor(() => traces.length >= 2, 5000);

    // 不同 session → 两条 trace 的 sessionId 不同，且区间重叠（真并行）
    const sids = traces.map((t) => t.sessionId);
    expect(new Set(sids).size).toBe(2);
    expect(hasOverlap(traces)).toBe(true);

    handler.stop();
  });

  test("同一 transport key 的多次事件仍严格 FIFO 串行（回归护栏）", async () => {
    sessionComponent = makeSessionComponent({ chatToSession: { oc_A: "sess_A" } });

    const traces: Trace[] = [];
    const onEventWithEnv = makeTracer({ c1: 30, c2: 30 }, traces);

    const handler = new EventHandler(
      createOptions({ sessionComponent: sessionComponent as any, onEventWithEnv }),
    );

    handler.enqueue(format(eventWithChat("oc_A", "c1")));
    handler.enqueue(format(eventWithChat("oc_A", "c2")));

    await waitFor(() => traces.length >= 2, 5000);

    expect(traces.map((t) => t.tag)).toEqual(["c1", "c2"]);
    expect(hasOverlap(traces)).toBe(false);

    handler.stop();
  });
});

// ============================================================================
// H2-1b: 根治机制的结构性证据（lane ↔ session 1:1）
// ============================================================================

describe("Task #4515 (H2 根治): lane 必须以 sessionId 为 canonical key", () => {
  test("两个 transport key 解析到同一 session → 最终只剩一条 lane（不是两条）", async () => {
    sessionComponent = makeSessionComponent({
      chatToSession: { oc_A: "shared" },
      triggerToSession: { t1: "shared" },
    });

    const traces: Trace[] = [];
    /** 每次处理 item 时，"正在跑"的 lane key 快照（判别根治是否生效） */
    const processingLaneKeys: string[][] = [];
    const baseTracer = makeTracer({ c1: 80, n1: 5 }, traces);
    // 第一条慢一点，让第二条在它跑的时候入队，制造"两条 lane 并存"的时机
    const onEventWithEnv = vi.fn().mockImplementation(async (fe: FormattedEvent) => {
      processingLaneKeys.push(handler.getRunningLaneKeys().slice());
      await baseTracer(fe);
    });

    const handler = new EventHandler(
      createOptions({ sessionComponent: sessionComponent as any, onEventWithEnv }),
    );

    handler.enqueue(format(eventWithChat("oc_A", "c1")));
    await waitFor(() => handler.getRunningLaneKeys().length >= 1, 2000);
    handler.enqueue(format(eventWithTrigger("t1", "n1")));

    await waitFor(() => traces.length >= 2, 5000);

    // ★ 结构性断言：**真正处理 item 的那条 lane** 必须是 sessionId 命名的
    //   canonical lane（`shared`），而不是 transport key（`oc_A` / `trigger:t1`）。
    //
    //   判别力：只有根治（lane 归并）能做到这一点；仅靠兜底 claimSession 时，
    //   n1 仍由 `trigger:t1` 这条 lane 的 runner 处理 → 观测到 `trigger:t1`。
    //   （必须关注"处理时"，lane 创建/归并瞬间的 key 会污染观测。）
    expect(processingLaneKeys.length).toBe(2);
    expect(processingLaneKeys.every((keys) => keys.length === 1 && keys[0] === "shared")).toBe(
      true,
    );

    // 更强的断言：两条事件都归属同一 session，且串行
    expect(traces.map((t) => t.sessionId)).toEqual(["shared", "shared"]);
    expect(hasOverlap(traces)).toBe(false);

    handler.stop();
  });

  test("归并后 __default__ / trigger / chat 三种 transport key 汇入同一 lane", async () => {
    sessionComponent = makeSessionComponent({
      chatToSession: { oc_M: "sess_M" },
      triggerToSession: { tM: "sess_M" },
      activeSessionId: "sess_M", // 优3：无 trigger 的事件也落到 sess_M
    });

    const traces: Trace[] = [];
    const onEventWithEnv = makeTracer({ c1: 40, n1: 40, p1: 40 }, traces);

    const handler = new EventHandler(
      createOptions({ sessionComponent: sessionComponent as any, onEventWithEnv }),
    );

    handler.enqueue(format(eventWithChat("oc_M", "c1")));
    handler.enqueue(format(eventWithTrigger("tM", "n1")));
    handler.enqueue(
      format({ type: "task.background.completed", payload: { tag: "p1" }, metadata: { sourceId: "s" } }),
    );

    await waitFor(() => traces.length >= 3, 8000);

    // 三条全部落到同一 session，且两两不重叠
    expect(traces.every((t) => t.sessionId === "sess_M")).toBe(true);
    expect(hasOverlap(traces)).toBe(false);

    handler.stop();
  });
});

// ============================================================================
// H2-1c: 兜底机制 —— claimSession 的原子性（TOCTOU 隔离带）
// ============================================================================

describe("Task #4515 (H2 兜底): claimSession 原子声明", () => {
  test("同一 key 的并发 claim 严格按序（第二个必须等第一个 release）", async () => {
    const handler = new EventHandler(createOptions({}));
    const order: string[] = [];

    // 直接驱动私有互斥链：模拟两个 lane 同时进入"检查通过"的窗口
    const claim = (handler as any).claimSession.bind(handler) as (
      key: string,
    ) => Promise<() => void>;

    const run = async (name: string, holdMs: number) => {
      const release = await claim("sess_shared");
      order.push(`${name}-enter`);
      await delay(holdMs);
      order.push(`${name}-exit`);
      release();
    };

    await Promise.all([run("A", 40), run("B", 5)]);

    // A 先 claim → A 完整进出后 B 才能进
    expect(order).toEqual(["A-enter", "A-exit", "B-enter", "B-exit"]);

    handler.stop();
  });

  test("不同 key 的 claim 互不阻塞（不能把跨 session 并发干掉）", async () => {
    const handler = new EventHandler(createOptions({}));
    const order: string[] = [];

    const claim = (handler as any).claimSession.bind(handler) as (
      key: string,
    ) => Promise<() => void>;

    const run = async (key: string, name: string, holdMs: number) => {
      const release = await claim(key);
      order.push(`${name}-enter`);
      await delay(holdMs);
      order.push(`${name}-exit`);
      release();
    };

    await Promise.all([run("sess_A", "A", 40), run("sess_B", "B", 40)]);

    // 两个 session 重叠：两个 enter 都在任何 exit 之前
    const firstExit = order.findIndex((o) => o.endsWith("-exit"));
    const entersBeforeFirstExit = order.slice(0, firstExit).filter((o) => o.endsWith("-enter"));
    expect(entersBeforeFirstExit.length).toBe(2);

    handler.stop();
  });

  test("release 之后 Map 条目被清理（不无限增长）", async () => {
    const handler = new EventHandler(createOptions({}));
    const claim = (handler as any).claimSession.bind(handler) as (
      key: string,
    ) => Promise<() => void>;

    const release = await claim("sess_X");
    release();

    // 让 then 链跑完
    await delay(10);
    expect((handler as any).sessionChains.size).toBe(0);

    handler.stop();
  });

  test("重复 release 是幂等的（不会重复放行）", async () => {
    const handler = new EventHandler(createOptions({}));
    const claim = (handler as any).claimSession.bind(handler) as (
      key: string,
    ) => Promise<() => void>;

    const release = await claim("sess_Y");
    release();
    release(); // 不应抛错 / 不应破坏链

    // 后续 claim 仍然正常
    const r2 = await claim("sess_Y");
    r2();
    await delay(10);
    expect((handler as any).sessionChains.size).toBe(0);

    handler.stop();
  });
});

// ============================================================================
// M1: lane 收尾窗口内的入队不能永久滞留
// ============================================================================

describe("Task #4515 (M1): lane 收尾窗口不丢事件", () => {
  test("runner 收尾瞬间入队的事件仍被处理（不无时限滞留）", async () => {
    // ⚠️ 关键：让 chatId === resolved sessionId，**不触发 lane 归并**。
    //   否则归并会让新事件落到另一条 lane 上、绕开 M1 的窗口，测不到真问题。
    sessionComponent = makeSessionComponent({ chatToSession: { oc_m1: "oc_m1" } });

    const traces: Trace[] = [];
    const onEventWithEnv = makeTracer({ first: 5, late: 5 }, traces);

    const handler = new EventHandler(
      createOptions({ sessionComponent: sessionComponent as any, onEventWithEnv }),
    );

    // ★ 精确注入 M1 的竞态窗口：
    //   `runLane()` 末尾先 `lanes.delete(key)`，`runningLanes.delete(key)` 要到
    //   `scheduleLane()` 的 `.finally` 才发生（中间隔着一段微任务边界）。
    //   落在这个窗口里 enqueue 的事件会因 `scheduleLane()` 的
    //   `runningLanes.has(key)` 早退而**无人调度** —— 修复前一直滞留。
    let injected = false;
    const lanes = (handler as any).lanes as Map<string, any>;
    const origDelete = lanes.delete.bind(lanes);
    lanes.delete = (k: string) => {
      // ⚠️ 顺序很重要：先真的删掉条目，再 enqueue。
      //   反过来会把新 item 一起删掉（那是测试自身的 bug，不是 M1）。
      const result = origDelete(k);
      if (!injected && k === "oc_m1") {
        injected = true;
        // 此刻 runningLanes 仍含 oc_m1 → scheduleLane() 会早退（M1 的窗口）
        handler.enqueue(format(eventWithChat("oc_m1", "late")));
      }
      return result;
    };

    handler.enqueue(format(eventWithChat("oc_m1", "first")));

    await waitFor(() => traces.length >= 2, 4000);

    expect(injected).toBe(true);
    expect(traces.map((t) => t.tag).sort()).toEqual(["first", "late"]);
    expect(handler.getQueueLength()).toBe(0);

    handler.stop();
  });
});
