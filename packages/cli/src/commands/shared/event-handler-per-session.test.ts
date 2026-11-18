/**
 * @fileoverview EventHandler per-session 并发调度测试 (Task #4486 Phase 1)
 *
 * 核心语义（TDD）：
 * 1. 同一 session（chatId / trigger:<id> / __default__）事件严格 FIFO 串行，不重叠
 * 2. 不同 session 事件并行执行，无 head-of-line blocking
 * 3. 慢会话不阻塞快会话
 * 4. per-session 空闲门禁 isSessionIdle 生效；不提供时回落全局 isIdle
 * 5. maxConcurrentSessions 限制同时运行的 lane 数
 * 6. stop() 语义：停止后不再处理、队列清空
 * 7. getQueueLength / isQueueEmpty 跨 lane 聚合
 * 8. EnvContext 按 item 快照 + 处理时重入（修复单 worker ALS 串味）
 */

import { describe, test, expect, vi, beforeEach } from "bun:test";
import { EventHandler } from "./event-handler";
import type { EventHandlerOptions } from "./event-handler";
import {
  EventMessageFormatter,
  type FormattedEvent,
} from "./event-message-formatter";
import {
  createEnvContext,
  getEnvContext,
  runWithEnvContext,
} from "@ai-setting/roy-bot-core/env";

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

/** 构造带 chatId 的 mock event（→ chat-keyed session 路径） */
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

/** 构造带 trigger_session_id 的 mock event（→ trigger lane） */
function eventWithTrigger(triggerSessionId: string, tag = "e") {
  return {
    type: "task.background.completed",
    payload: { tag },
    metadata: { sourceId: "test-source", trigger_session_id: triggerSessionId },
  };
}

/** 构造既无 chatId 也无 trigger 的 event（→ __default__ lane） */
function eventPlain(tag = "e") {
  return {
    type: "task.background.completed",
    payload: { tag },
    metadata: { sourceId: "test-source" },
  };
}

function format(evt: unknown): FormattedEvent {
  return formatter.formatWithEvent(evt as any);
}

/** 记录每次处理的开始/结束时间戳，用于判定串行 / 并行 */
interface Trace {
  tag: string;
  sessionId?: string;
  start: number;
  end: number;
}

function tagOf(fe: FormattedEvent): string {
  return ((fe.envEvent?.payload as { tag?: string })?.tag ?? "?");
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

function createOptions(overrides: Partial<EventHandlerOptions> = {}): EventHandlerOptions {
  return {
    env: { subscribeAll: vi.fn().mockReturnValue(() => {}) } as any,
    eventTypes: ["event-source.event.*", "task.background.*"],
    formatter,
    isIdle: () => true,
    onEvent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** 构造 onEventWithEnv：按 tag 决定处理耗时，记录 start/end */
function makeTracer(delays: Record<string, number>, traces: Trace[]) {
  return vi.fn().mockImplementation(async (fe: FormattedEvent) => {
    const tag = tagOf(fe);
    const start = Date.now();
    await delay(delays[tag] ?? 0);
    traces.push({ tag, sessionId: fe.eventSessionId, start, end: Date.now() });
  });
}

let sessionComponent: ReturnType<typeof makeSessionComponent>;

beforeEach(() => {
  sessionComponent = makeSessionComponent();
});

// ============================================================================
// 测试 1：同 session 严格串行（不重叠）
// ============================================================================

describe("EventHandler per-session: same session serial", () => {
  test("同一 chatId 的多个事件严格 FIFO 串行，执行区间不重叠", async () => {
    const traces: Trace[] = [];
    const onEventWithEnv = makeTracer({ a1: 40, a2: 40, a3: 40 }, traces);

    const handler = new EventHandler(
      createOptions({ sessionComponent: sessionComponent as any, onEventWithEnv }),
    );

    handler.enqueue(format(eventWithChat("oc_A", "a1")));
    handler.enqueue(format(eventWithChat("oc_A", "a2")));
    handler.enqueue(format(eventWithChat("oc_A", "a3")));

    await waitFor(() => traces.length >= 3);
    await waitFor(() => handler.isQueueEmpty());

    // 顺序必须严格按入队顺序
    expect(traces.map((t) => t.tag)).toEqual(["a1", "a2", "a3"]);

    // 区间不重叠：后一个的 start >= 前一个的 end
    for (let i = 1; i < traces.length; i++) {
      expect(traces[i].start).toBeGreaterThanOrEqual(traces[i - 1].end);
    }

    // 三个事件共享同一个 chat-keyed session
    expect(new Set(traces.map((t) => t.sessionId)).size).toBe(1);
    expect(traces[0].sessionId).toBe("oc_A");

    handler.stop();
  });

  test("__default__ lane（无 chatId 无 trigger）同样严格串行", async () => {
    const traces: Trace[] = [];
    const onEventWithEnv = makeTracer({ d1: 30, d2: 30 }, traces);

    const handler = new EventHandler(
      createOptions({ sessionComponent: sessionComponent as any, onEventWithEnv }),
    );

    handler.enqueue(format(eventPlain("d1")));
    handler.enqueue(format(eventPlain("d2")));

    await waitFor(() => traces.length >= 2);
    expect(traces.map((t) => t.tag)).toEqual(["d1", "d2"]);
    for (let i = 1; i < traces.length; i++) {
      expect(traces[i].start).toBeGreaterThanOrEqual(traces[i - 1].end);
    }

    handler.stop();
  });

  test("同一 triggerSessionId 的事件共享一条 lane（串行 + 同 session）", async () => {
    const traces: Trace[] = [];
    const onEventWithEnv = makeTracer({ t1: 30, t2: 30 }, traces);

    const handler = new EventHandler(
      createOptions({ sessionComponent: sessionComponent as any, onEventWithEnv }),
    );

    handler.enqueue(format(eventWithTrigger("sess_parent", "t1")));
    handler.enqueue(format(eventWithTrigger("sess_parent", "t2")));

    await waitFor(() => traces.length >= 2);
    expect(traces.map((t) => t.tag)).toEqual(["t1", "t2"]);
    expect(traces[1].start).toBeGreaterThanOrEqual(traces[0].end);
    expect(traces[0].sessionId).toBe(traces[1].sessionId);

    handler.stop();
  });
});

// ============================================================================
// 测试 2：不同 session 并行（无 head-of-line blocking）
// ============================================================================

describe("EventHandler per-session: cross-session parallel", () => {
  test("不同 chatId 的事件重叠执行（不再互相阻塞）", async () => {
    const traces: Trace[] = [];
    // A 慢（120ms），B 快（20ms）
    const onEventWithEnv = makeTracer({ slow: 120, fast: 20 }, traces);

    const handler = new EventHandler(
      createOptions({ sessionComponent: sessionComponent as any, onEventWithEnv }),
    );

    const t0 = Date.now();
    handler.enqueue(format(eventWithChat("oc_A", "slow")));
    // 保证 slow 已开始占用 A lane
    await delay(15);
    handler.enqueue(format(eventWithChat("oc_B", "fast")));

    await waitFor(() => traces.length >= 2, 3000);

    const slow = traces.find((t) => t.tag === "slow")!;
    const fast = traces.find((t) => t.tag === "fast")!;

    // ★ 核心断言：fast 在 slow 结束之前就已经完成（重叠执行）
    expect(fast.end).toBeLessThanOrEqual(slow.end);

    // 两个事件各自路由到自己的 chat session
    expect(slow.sessionId).toBe("oc_A");
    expect(fast.sessionId).toBe("oc_B");

    // 总耗时不应接近两者之和（并行节省时间）
    expect(Date.now() - t0).toBeLessThan(220);

    handler.stop();
  });

  test("慢会话不阻塞快会话：3 个 chat 同时到达，快的不等慢的", async () => {
    const traces: Trace[] = [];
    const onEventWithEnv = makeTracer({ s1: 150, s2: 10, s3: 10 }, traces);

    const handler = new EventHandler(
      createOptions({ sessionComponent: sessionComponent as any, onEventWithEnv }),
    );

    handler.enqueue(format(eventWithChat("oc_slow", "s1")));
    handler.enqueue(format(eventWithChat("oc_f1", "s2")));
    handler.enqueue(format(eventWithChat("oc_f2", "s3")));

    await waitFor(() => traces.length >= 3, 3000);

    const s1 = traces.find((t) => t.tag === "s1")!;
    const others = traces.filter((t) => t.tag !== "s1");
    for (const o of others) {
      expect(o.end).toBeLessThanOrEqual(s1.end);
    }

    handler.stop();
  });
});

// ============================================================================
// 测试 3：per-session 空闲门禁
// ============================================================================

describe("EventHandler per-session: idle gating", () => {
  test("isSessionIdle(sessionId)=false 时该 session 等待，其他 session 照常执行", async () => {
    const traces: Trace[] = [];
    const onEventWithEnv = makeTracer({ busy: 5, free: 5 }, traces);

    // oc_busy 一开始就 busy，80ms 后释放
    let busyReleased = false;
    setTimeout(() => {
      busyReleased = true;
    }, 80);

    const handler = new EventHandler(
      createOptions({
        sessionComponent: sessionComponent as any,
        onEventWithEnv,
        isIdle: () => true, // 全局永远空闲 —— 证明不是全局门禁把它挡住了
        isSessionIdle: (sid: string) => (sid === "oc_busy" ? busyReleased : true),
        idleCheckInterval: 10,
      }),
    );

    handler.enqueue(format(eventWithChat("oc_busy", "busy")));
    handler.enqueue(format(eventWithChat("oc_free", "free")));

    await waitFor(() => traces.length >= 1, 3000);
    // free 先完成（busy 还在等门禁）
    expect(traces[0].tag).toBe("free");

    await waitFor(() => traces.length >= 2, 3000);
    expect(traces[1].tag).toBe("busy");

    handler.stop();
  });

  test("不提供 isSessionIdle 时回落全局 isIdle（向后兼容）", async () => {
    const traces: Trace[] = [];
    const onEventWithEnv = makeTracer({ g1: 5 }, traces);

    let idle = false;
    setTimeout(() => {
      idle = true;
    }, 60);

    const handler = new EventHandler(
      createOptions({
        sessionComponent: sessionComponent as any,
        onEventWithEnv,
        isIdle: () => idle,
        idleCheckInterval: 10,
      }),
    );

    handler.enqueue(format(eventWithChat("oc_A", "g1")));

    // 立刻检查：还没处理（全局 isIdle=false 挡住）
    await delay(20);
    expect(traces.length).toBe(0);

    await waitFor(() => traces.length >= 1, 3000);
    expect(traces[0].tag).toBe("g1");

    handler.stop();
  });
});

// ============================================================================
// 测试 4：maxConcurrentSessions
// ============================================================================

describe("EventHandler per-session: maxConcurrentSessions", () => {
  test("maxConcurrentSessions=1 时不同 session 也被串行化", async () => {
    const traces: Trace[] = [];
    const onEventWithEnv = makeTracer({ x1: 30, x2: 30, x3: 30 }, traces);

    const handler = new EventHandler(
      createOptions({
        sessionComponent: sessionComponent as any,
        onEventWithEnv,
        maxConcurrentSessions: 1,
      }),
    );

    handler.enqueue(format(eventWithChat("oc_1", "x1")));
    handler.enqueue(format(eventWithChat("oc_2", "x2")));
    handler.enqueue(format(eventWithChat("oc_3", "x3")));

    await waitFor(() => traces.length >= 3, 4000);

    // 任意两个的执行区间都不能重叠
    for (let i = 0; i < traces.length; i++) {
      for (let j = i + 1; j < traces.length; j++) {
        const a = traces[i];
        const b = traces[j];
        const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
        expect(overlap).toBeLessThanOrEqual(0);
      }
    }

    handler.stop();
  });

  test("默认配置下 2 个不同 session 可并行", async () => {
    const traces: Trace[] = [];
    const onEventWithEnv = makeTracer({ p1: 60, p2: 60 }, traces);

    const handler = new EventHandler(
      createOptions({ sessionComponent: sessionComponent as any, onEventWithEnv }),
    );

    const t0 = Date.now();
    handler.enqueue(format(eventWithChat("oc_p1", "p1")));
    handler.enqueue(format(eventWithChat("oc_p2", "p2")));

    await waitFor(() => traces.length >= 2, 3000);

    // 并行 → 总耗时远小于 2×60ms
    expect(Date.now() - t0).toBeLessThan(115);

    handler.stop();
  });
});

// ============================================================================
// 测试 5：队列查询 API 跨 lane 聚合 + stop() 语义
// ============================================================================

describe("EventHandler per-session: queue introspection & stop", () => {
  test("getQueueLength / isQueueEmpty 跨所有 lane 聚合", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const processed: string[] = [];
    const onEventWithEnv = vi.fn().mockImplementation(async (fe: FormattedEvent) => {
      await gate;
      processed.push(tagOf(fe));
    });

    const handler = new EventHandler(
      createOptions({
        sessionComponent: sessionComponent as any,
        onEventWithEnv,
        maxConcurrentSessions: 32,
      }),
    );

    handler.enqueue(format(eventWithChat("oc_q1", "q1")));
    handler.enqueue(format(eventWithChat("oc_q2", "q2")));
    handler.enqueue(format(eventWithChat("oc_q3", "q3")));

    // 三条同时进入处理（不同 lane）→ 队列计数含正在处理中的项
    await waitFor(() => handler.getQueueLength() === 3, 2000);
    expect(handler.isQueueEmpty()).toBe(false);

    release!();
    await waitFor(() => handler.isQueueEmpty(), 3000);

    expect(processed.sort()).toEqual(["q1", "q2", "q3"]);

    handler.stop();
  });

  test("stop() 后入队的事件不再处理，队列清空", async () => {
    const traces: Trace[] = [];
    const onEventWithEnv = makeTracer({ z1: 5, z2: 5 }, traces);

    const handler = new EventHandler(
      createOptions({ sessionComponent: sessionComponent as any, onEventWithEnv }),
    );

    handler.enqueue(format(eventWithChat("oc_z", "z1")));
    await waitFor(() => traces.length >= 1, 3000);

    handler.stop();
    expect(handler.getQueueLength()).toBe(0);
    expect(handler.isQueueEmpty()).toBe(true);

    // stop 后再入队 → 忽略
    handler.enqueue(format(eventWithChat("oc_z", "z2")));
    await delay(50);
    expect(traces.map((t) => t.tag)).toEqual(["z1"]);
  });

  test("isSessionIdle(key) 反射当前 lane 是否有在跑的任务", async () => {
    const traces: Trace[] = [];
    const onEventWithEnv = makeTracer({ i1: 60 }, traces);

    const handler = new EventHandler(
      createOptions({ sessionComponent: sessionComponent as any, onEventWithEnv }),
    );

    // 初始都空闲
    expect(handler.isSessionIdle("oc_i")).toBe(true);

    handler.enqueue(format(eventWithChat("oc_i", "i1")));
    await waitFor(() => handler.isSessionIdle("oc_i") === false, 2000);

    await waitFor(() => traces.length >= 1, 3000);
    await waitFor(() => handler.isSessionIdle("oc_i") === true, 2000);

    handler.stop();
  });
});

// ============================================================================
// 测试 6：EnvContext 按 item 快照 + 处理时重入（修 ALS 串味）
// ============================================================================

describe("EventHandler per-session: EnvContext isolation", () => {
  test("不同事件各自的 EnvContext 不串味（agentContext/messageId 隔离）", async () => {
    const observed: Array<{ tag: string; messageId?: string; taskId?: number }> = [];
    const onEventWithEnv = vi.fn().mockImplementation(async (fe: FormattedEvent) => {
      // 模拟消费端在处理事件时从 ALS 读 EnvContext
      const ctx = getEnvContext();
      const tag = tagOf(fe);
      // 让异步链多跨几个 tick，暴露串味
      await delay(10);
      const ctxAfter = getEnvContext();
      observed.push({
        tag,
        messageId: (ctxAfter?.messageId ?? ctx?.messageId) as string | undefined,
        taskId: (ctxAfter?.agentContext as { currentTaskId?: number } | undefined)
          ?.currentTaskId,
      });
    });

    const handler = new EventHandler(
      createOptions({ sessionComponent: sessionComponent as any, onEventWithEnv }),
    );

    // 模拟 EventSource 用 runWithEnvContext 投递事件（生产路径）
    const enqueueInCtx = (
      chatId: string,
      tag: string,
      messageId: string,
      taskId: number,
    ) => {
      const ctx = createEnvContext({
        envEvent: { type: "event-source.event.lark-cli", payload: { tag } } as any,
        sourceId: "test-source",
        userId: "ou_test",
        messageId,
      });
      // agentContext 不在 createEnvContext 参数里（共享可变槽位），手动挂上
      ctx.agentContext = { currentTaskId: taskId };
      runWithEnvContext(ctx, () => {
        handler.enqueue(format(eventWithChat(chatId, tag)));
      });
    };

    enqueueInCtx("oc_ctx1", "c1", "om_111", 1001);
    enqueueInCtx("oc_ctx2", "c2", "om_222", 1002);

    await waitFor(() => observed.length >= 2, 4000);

    const c1 = observed.find((o) => o.tag === "c1")!;
    const c2 = observed.find((o) => o.tag === "c2")!;

    // ★ 核心：各自看到自己的 messageId / currentTaskId（不串）
    expect(c1.messageId).toBe("om_111");
    expect(c1.taskId).toBe(1001);
    expect(c2.messageId).toBe("om_222");
    expect(c2.taskId).toBe(1002);

    handler.stop();
  });

  test("无 EnvContext 时处理仍正常（不崩）", async () => {
    const traces: Trace[] = [];
    const onEventWithEnv = makeTracer({ n1: 5 }, traces);

    const handler = new EventHandler(
      createOptions({ sessionComponent: sessionComponent as any, onEventWithEnv }),
    );

    handler.enqueue(format(eventWithChat("oc_none", "n1")));
    await waitFor(() => traces.length >= 1, 3000);
    expect(traces[0].tag).toBe("n1");

    handler.stop();
  });
});

// ============================================================================
// 测试 7：槽位饥饿回归（门禁先于槽位）
// ============================================================================

describe("EventHandler per-session: 槽位饥饿回归", () => {
  test("多个 busy session 占满门禁时不吞掉并发槽位，空闲 session 仍能跑", async () => {
    const traces: Trace[] = [];
    const onEventWithEnv = makeTracer(
      { b1: 5, b2: 5, b3: 5, b4: 5, free: 5 },
      traces,
    );

    // 三个 session 一开始都 busy，120ms 后才释放
    let released = false;
    setTimeout(() => {
      released = true;
    }, 120);

    const handler = new EventHandler(
      createOptions({
        sessionComponent: sessionComponent as any,
        onEventWithEnv,
        isIdle: () => true,
        isSessionIdle: (sid: string) =>
          sid.startsWith("oc_busy") ? released : true,
        idleCheckInterval: 10,
        maxConcurrentSessions: 4, // 4 个槽位
      }),
    );

    // ★ 4 个 busy lane（= 槽位数）+ 1 个 free lane。
    //   若"抢槽位"先于"等门禁"，4 个 busy lane 会把 4 个槽位全占住等门禁，
    //   free 永远排不上 —— 这正是修复前的饥饿 bug。
    handler.enqueue(format(eventWithChat("oc_busy1", "b1")));
    handler.enqueue(format(eventWithChat("oc_busy2", "b2")));
    handler.enqueue(format(eventWithChat("oc_busy3", "b3")));
    handler.enqueue(format(eventWithChat("oc_busy4", "b4")));
    handler.enqueue(format(eventWithChat("oc_free", "free")));

    // ★ 核心：free 必须在 busy 释放之前就跑完（没被 busy 的 lane 饿死）
    await waitFor(() => traces.some((t) => t.tag === "free"), 3000);
    expect(released).toBe(false);

    // 之后 busy 们也陆续跑完
    await waitFor(() => traces.length >= 5, 4000);
    expect(traces.length).toBe(5);

    handler.stop();
  });
});

// ============================================================================
// 测试 8：runLane 异常不产生 unhandled rejection
// ============================================================================

describe("EventHandler per-session: lane 异常兜底", () => {
  test("session 解析抛错时 lane 不炸进程（有 catch），后续 lane 仍能处理", async () => {
    const traces: Trace[] = [];
    const onEventWithEnv = makeTracer({ ok: 5 }, traces);

    // chatId = oc_boom 时 list/create/get 全部抛错
    const boomSession = {
      ...makeSessionComponent(),
      list: vi.fn().mockImplementation(async (options: any) => {
        const cid = options?.filter?.metadata?.chatId;
        if (cid === "oc_boom") throw new Error("DB exploded");
        return cid ? [{ id: cid, title: `Lark Chat ${cid}` }] : [];
      }),
      create: vi.fn().mockImplementation(async () => {
        throw new Error("DB exploded on create");
      }),
      get: vi.fn().mockImplementation(async () => {
        throw new Error("DB exploded on get");
      }),
      getActiveSessionId: vi.fn().mockReturnValue(undefined),
    };

    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);

    const origError = console.error;
    console.error = vi.fn();

    const handler = new EventHandler(
      createOptions({
        sessionComponent: boomSession as any,
        onEventWithEnv,
      }),
    );

    try {
      handler.enqueue(format(eventWithChat("oc_boom", "boom")));
      handler.enqueue(format(eventWithChat("oc_ok", "ok")));

      // 好的那个照常处理
      await waitFor(() => traces.some((t) => t.tag === "ok"), 3000);
      expect(traces.map((t) => t.tag)).toContain("ok");

      // 给 unhandledRejection 一点时间冒出来
      await delay(60);
      expect(unhandled.length).toBe(0);
    } finally {
      console.error = origError;
      process.off("unhandledRejection", onUnhandled);
      handler.stop();
    }
  });
});
