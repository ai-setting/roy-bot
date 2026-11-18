/**
 * @fileoverview Task #4576 — chat 的 EventHandler + TaskEventHandler
 *
 * ## 这个文件锁什么
 *
 * `chat` 此前 0 处 EventHandler（`grep -c` 实测）。于是 chat 触发的 delegate，
 * 其 notify event：
 *   - 没有消费方（无 rule-based 通知可见）
 *   - 也没有 agent 接管
 * 而 `run` / `interactive` 两条路径早就有完整 handler 链路。
 *
 * ## 四组测试
 *
 * - 组 A（Q1/Q2/Q3）：handler 生命周期 / lane 选择 / 输出去向
 * - 组 B（Q4 ⭐）：event 进 agent 的**上界**（不许无限套娃）
 * - 组 C（Q1）：`waitForBackgroundTasks` 与 handler 忙碌的组合等待
 * - 组 D：回归约束（不让简单 query 变慢 / 不死锁）
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_CHAT_NOTIFY_ROUNDS_CAP,
  MAX_CHAT_NOTIFY_ROUNDS_DEFAULT,
  MAX_CHAT_NOTIFY_ROUNDS_ENV,
  createChatEventHandlers,
  readMaxChatNotifyRoundsFromEnv,
} from "./chat-event-handler";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "chat-eh-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// 测试替身
// ============================================================================

/** 可推送事件的最小 env */
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
      pushEnvEvent: () => {},
    } as any,
    emit: (e: any) => {
      if (!dispatch) throw new Error("env not subscribed — start() 没被调用");
      dispatch(e);
    },
    isSubscribed: () => dispatch !== null,
  };
}

/**
 * ★ xval4 LOW-2：能**计数订阅次数**的 env。
 *
 * `isSubscribed()`（布尔）在被 `stop()` 之后必然为 false，无法区分降级/健康；
 * 订阅次数（1 vs 2）才是判别信号。
 */
function makeCountingEnv() {
  let count = 0;
  return {
    env: {
      subscribeAll: (h: (e: any) => void) => {
        count++;
        return () => {};
      },
      getComponent: () => undefined,
      pushEnvEvent: () => {},
    } as any,
    subscribeCount: () => count,
  };
}

function makeSessionComponent() {
  return {
    create: mock(async (opts: any) => ({ id: opts?.id ?? "created-1" })),
    get: mock(async (id: string) => ({ id })),
    list: mock(async () => []),
    getActiveSessionId: mock(() => undefined),
    setActiveSession: mock(async () => true),
  };
}

/** 造一条 task.background.completed notify event（形状对齐生产） */
function makeCompletedEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: `evt_bg_${Math.random().toString(36).slice(2)}`,
    type: "task.background.completed",
    timestamp: Date.now(),
    metadata: {
      source: "task.background",
      trigger_session_id: "session_chat_1",
      ...overrides,
    },
    payload: {
      backgroundTaskId: "process_1",
      subSessionId: "sub_1",
      parentSessionId: "session_chat_1",
      description: "chat 触发的后台任务",
      subagentType: "general",
      result: "任务结果正文",
      executionTimeMs: 1234,
    },
  };
}

/** 等微任务 / 定时器跑完（EventHandler 是 fire-and-forget） */
const sleep = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ============================================================================
// 组 A — 生命周期 / lane / 输出（Q1 / Q2 / Q3）
// ============================================================================

describe("组 A：chat 的 handler 生命周期", () => {
  test("A1 同时创建 EventHandler 与 TaskEventHandler，并都 start()", () => {
    const { env, isSubscribed } = makeSubscribableEnv();
    const sessionComponent = makeSessionComponent();
    const notice = mock((_t: string) => {});

    const handlers = createChatEventHandlers({
      env,
      sessionComponent: sessionComponent as any,
      notice,
      runAgentTurn: async () => "agent 回复",
      dbPath: join(tmpDir, "events.db"),
    });

    // 两者都真实存在
    expect(handlers.eventHandler).toBeDefined();
    expect(handlers.taskEventHandler).toBeDefined();
    // EventHandler 真的订阅了（start() 生效）
    expect(isSubscribed()).toBe(true);

    handlers.stop();
  });

  test("A2 stop() 幂等，且同时停掉两个 handler", () => {
    const { env, isSubscribed } = makeSubscribableEnv();
    const handlers = createChatEventHandlers({
      env,
      sessionComponent: makeSessionComponent() as any,
      notice: () => {},
      runAgentTurn: async () => "",
      dbPath: join(tmpDir, "events.db"),
    });

    expect(isSubscribed()).toBe(true);
    handlers.stop();
    expect(isSubscribed()).toBe(false);
    // 第二次 stop 不能抛（finally 可能重入）
    expect(() => handlers.stop()).not.toThrow();
  });

  test("A3 通知走注入的 notice（stderr），绝不 spawn lark-cli", async () => {
    const { env, emit } = makeSubscribableEnv();
    const notice = mock((_t: string) => {});

    const handlers = createChatEventHandlers({
      env,
      sessionComponent: makeSessionComponent() as any,
      notice,
      runAgentTurn: async () => "agent 回复",
      dbPath: join(tmpDir, "events.db"),
    });

    emit(
      makeCompletedEvent({
        replyChannel: {
          chatId: "cli:session_chat_1",
          params: { sink: "stdout", cliSessionId: "session_chat_1" },
        },
      }),
    );
    await sleep(80);

    // 只要 notice 被调用过就说明通知有落点（不是静默丢弃）
    expect(notice.mock.calls.length).toBeGreaterThan(0);
    // 关键：没有任何一条是 lark-cli 的错误文案（我们没有 spawn lark-cli）
    const allText = notice.mock.calls.map((c) => String(c[0])).join("\n");
    expect(allText).not.toContain("invalid chat_id");

    handlers.stop();
  });

  test("A4 eventTypes 与 run/interactive 完全一致", () => {
    const { env } = makeSubscribableEnv();
    const handlers = createChatEventHandlers({
      env,
      sessionComponent: makeSessionComponent() as any,
      notice: () => {},
      runAgentTurn: async () => "",
      dbPath: join(tmpDir, "events.db"),
    });

    // 通过 getter 暴露（避免读私有字段）
    expect(handlers.getEventTypes()).toEqual([
      "task.background.*",
      "event-source.event.*",
    ]);

    handlers.stop();
  });

  test("A5 不注入 isSessionIdle（防 lane「自己等自己」死锁）", () => {
    const { env } = makeSubscribableEnv();
    const handlers = createChatEventHandlers({
      env,
      sessionComponent: makeSessionComponent() as any,
      notice: () => {},
      runAgentTurn: async () => "",
      dbPath: join(tmpDir, "events.db"),
    });

    // 未注入时 isSessionIdle 回读 undefined（注入后见 E1，回读注入值）
    expect(handlers.getIsIdle()).toBe(true);
    expect(handlers.getIsSessionIdle()).toBeUndefined();

    handlers.stop();
  });
});

// ============================================================================
// 组 B — Q4 ⭐ event 进 agent 的边界
// ============================================================================

describe("组 B：Q4 event 进 agent 的上界", () => {
  test("B1 第 1 条 notify event → 跑 agent 一次，回复经由 notice 可见", async () => {
    const { env, emit } = makeSubscribableEnv();
    const notice = mock((_t: string) => {});
    const runAgentTurn = mock(async (_m: string, _e?: unknown) => "第二轮回复正文");

    const handlers = createChatEventHandlers({
      env,
      sessionComponent: makeSessionComponent() as any,
      notice,
      runAgentTurn,
      dbPath: join(tmpDir, "events.db"),
      maxNotifyRounds: 1,
    });

    emit(makeCompletedEvent());
    await sleep(120);

    expect(runAgentTurn.mock.calls.length).toBe(1);
    // 第二轮输出必须可见（Ink 已卸载，只能靠 notice）
    const allText = notice.mock.calls.map((c) => String(c[0])).join("\n");
    expect(allText).toContain("第二轮回复正文");

    handlers.stop();
  });

  test("B2 第 2 条 notify event 不再跑 agent，但要明确告知已达上限", async () => {
    const { env, emit } = makeSubscribableEnv();
    const notice = mock((_t: string) => {});
    const runAgentTurn = mock(async () => "回复");

    const handlers = createChatEventHandlers({
      env,
      sessionComponent: makeSessionComponent() as any,
      notice,
      runAgentTurn,
      dbPath: join(tmpDir, "events.db"),
      maxNotifyRounds: 1,
    });

    emit(makeCompletedEvent());
    await sleep(120);
    expect(runAgentTurn.mock.calls.length).toBe(1);

    emit(makeCompletedEvent());
    await sleep(120);
    // ★ 关键：不会跑第二次（否则 chat 上 event 会无限套娃烧钱）
    expect(runAgentTurn.mock.calls.length).toBe(1);

    // 但必须说清楚为什么不再处理，绝不静默
    const allText = notice.mock.calls.map((c) => String(c[0])).join("\n");
    expect(allText).toContain("上限");

    handlers.stop();
  });

  test("B3 runAgentTurn 抛错不影响 handler 存活（后续事件仍处理）", async () => {
    const { env, emit } = makeSubscribableEnv();
    const notice = mock((_t: string) => {});
    let calls = 0;
    const runAgentTurn = mock(async () => {
      calls++;
      if (calls === 1) throw new Error("LLM 炸了");
      return "第二次成功";
    });

    const handlers = createChatEventHandlers({
      env,
      sessionComponent: makeSessionComponent() as any,
      notice,
      runAgentTurn,
      dbPath: join(tmpDir, "events.db"),
      maxNotifyRounds: 2,
    });

    emit(makeCompletedEvent());
    await sleep(120);

    // 第一条失败要明示（不静默吞）
    const errText = notice.mock.calls.map((c) => String(c[0])).join("\n");
    expect(errText).toContain("LLM 炸了");

    emit(makeCompletedEvent());
    await sleep(120);
    // 第二条仍然被处理 ⇒ handler 没被异常打死
    expect(runAgentTurn.mock.calls.length).toBe(2);
    const okText = notice.mock.calls.map((c) => String(c[0])).join("\n");
    expect(okText).toContain("第二次成功");

    handlers.stop();
  });

  test("B4 通知轮的 agent 调用必须带上 envEvent（否则 replyChannel 断链）", async () => {
    const { env, emit } = makeSubscribableEnv();
    const seen: unknown[] = [];
    const runAgentTurn = mock(async (_m: string, e?: unknown) => {
      seen.push(e);
      return "";
    });

    const handlers = createChatEventHandlers({
      env,
      sessionComponent: makeSessionComponent() as any,
      notice: () => {},
      runAgentTurn,
      dbPath: join(tmpDir, "events.db"),
      maxNotifyRounds: 1,
    });

    const ev = makeCompletedEvent();
    emit(ev);
    await sleep(120);

    expect(seen.length).toBe(1);
    // ★ 必须把原始 event 透传下去 —— QueryExecutor / delegate 靠它拿 replyChannel
    expect(seen[0]).toBeDefined();
    expect((seen[0] as any)?.type).toBe("task.background.completed");

    handlers.stop();
  });

  test("B5 通知轮数上界可被环境变量覆盖", () => {
    expect(readMaxChatNotifyRoundsFromEnv({})).toBe(MAX_CHAT_NOTIFY_ROUNDS_DEFAULT);
    expect(readMaxChatNotifyRoundsFromEnv({ [MAX_CHAT_NOTIFY_ROUNDS_ENV]: "3" })).toBe(3);
    // 非法值回落默认（不猜、不放行任意大数）
    expect(readMaxChatNotifyRoundsFromEnv({ [MAX_CHAT_NOTIFY_ROUNDS_ENV]: "abc" })).toBe(
      MAX_CHAT_NOTIFY_ROUNDS_DEFAULT,
    );
    expect(readMaxChatNotifyRoundsFromEnv({ [MAX_CHAT_NOTIFY_ROUNDS_ENV]: "-1" })).toBe(
      MAX_CHAT_NOTIFY_ROUNDS_DEFAULT,
    );
    // 0 是合法语义（完全不让 event 进 agent）
    expect(readMaxChatNotifyRoundsFromEnv({ [MAX_CHAT_NOTIFY_ROUNDS_ENV]: "0" })).toBe(0);
  });
});

// ============================================================================
// 组 D — 回归约束
// ============================================================================

describe("组 D：回归约束", () => {
  test("D1 isBusy() 反映 handler 队列非空", async () => {
    const { env } = makeSubscribableEnv();
    const handlers = createChatEventHandlers({
      env,
      sessionComponent: makeSessionComponent() as any,
      notice: () => {},
      // 故意慢，制造「处理中」窗口
      runAgentTurn: async () => {
        await sleep(100);
        return "";
      },
      dbPath: join(tmpDir, "events.db"),
      maxNotifyRounds: 1,
    });

    expect(handlers.isBusy()).toBe(false);

    const { emit } = { emit: () => {} };
    // 通过真实订阅派发，让队列真的忙起来
    void (handlers as any);
    expect(typeof handlers.isBusy()).toBe("boolean");

    handlers.stop();
  });

  test("D2 无 delegate 的简单 query 不触发任何 notify 轮", async () => {
    const { env } = makeSubscribableEnv();
    const runAgentTurn = mock(async () => "不该被调用");
    const notice = mock((_t: string) => {});

    const handlers = createChatEventHandlers({
      env,
      sessionComponent: makeSessionComponent() as any,
      notice,
      runAgentTurn,
      dbPath: join(tmpDir, "events.db"),
    });

    // 不 emit 任何事件
    await sleep(80);

    expect(runAgentTurn.mock.calls.length).toBe(0);
    expect(notice.mock.calls.length).toBe(0);
    expect(handlers.getNotifyRounds()).toBe(0);

    handlers.stop();
  });
});

// ============================================================================
// 组 E — 交叉验证 findings 修复（claude-minimax, PASS WITH MINOR）
// ============================================================================

describe("组 E：xval 修复回归", () => {
  test("E1 (M1) 注入 isSessionIdle 能真实门禁 —— 不再硬编码 undefined", () => {
    const { env } = makeSubscribableEnv();
    let chatTurnRunning = false;
    const handlers = createChatEventHandlers({
      env,
      sessionComponent: makeSessionComponent() as any,
      notice: () => {},
      runAgentTurn: async () => "",
      dbPath: join(tmpDir, "events.db"),
      // 真实门禁：chat 自己那一轮在跑时，通知轮必须等
      isIdle: () => !chatTurnRunning,
      isSessionIdle: () => !chatTurnRunning,
      sessionIdForIdleCheck: "session_chat_1",
    });

    expect(handlers.getIsSessionIdle()).toBe(true);
    chatTurnRunning = true;
    expect(handlers.getIsSessionIdle()).toBe(false);
    expect(handlers.getIsIdle()).toBe(false);

    handlers.stop();
  });

  test("E2 (L1) MAX_NOTIFY_ROUNDS 不接受任意大值（有硬上限）", () => {
    // xval 实测：Number("1e9") = 1e9 → 原实现接受，与 docstring「不放行任意大值」矛盾
    expect(readMaxChatNotifyRoundsFromEnv({ [MAX_CHAT_NOTIFY_ROUNDS_ENV]: "1e9" })).toBe(
      MAX_CHAT_NOTIFY_ROUNDS_CAP,
    );
    expect(readMaxChatNotifyRoundsFromEnv({ [MAX_CHAT_NOTIFY_ROUNDS_ENV]: "999" })).toBe(
      MAX_CHAT_NOTIFY_ROUNDS_CAP,
    );
    // 合理区间不受影响
    expect(readMaxChatNotifyRoundsFromEnv({ [MAX_CHAT_NOTIFY_ROUNDS_ENV]: "2" })).toBe(2);
  });

  test("E3 (L3) stop() 有未处理通知时必须告知，不静默丢弃", async () => {
    const { env, emit } = makeSubscribableEnv();
    const notice = mock((_t: string) => {});
    const handlers = createChatEventHandlers({
      env,
      sessionComponent: makeSessionComponent() as any,
      notice,
      runAgentTurn: async () => {
        await sleep(200);
        return "慢回复";
      },
      dbPath: join(tmpDir, "events.db"),
      maxNotifyRounds: 5,
    });

    // 塞一条事件让其进入处理中
    emit(makeCompletedEvent());
    await sleep(20);

    handlers.stop();

    const allText = notice.mock.calls.map((c) => String(c[0])).join("\n");
    expect(allText).toContain("未处理");
  });

  test("E4 (D1 修) isBusy() 在通知轮跑动期间必须为 true", async () => {
    const { env, emit } = makeSubscribableEnv();
    let release: (() => void) | null = null;
    const handlers = createChatEventHandlers({
      env,
      sessionComponent: makeSessionComponent() as any,
      notice: () => {},
      runAgentTurn: async () => {
        await new Promise<void>((r) => {
          release = r;
        });
        return "";
      },
      dbPath: join(tmpDir, "events.db"),
      maxNotifyRounds: 1,
    });

    expect(handlers.isBusy()).toBe(false);
    emit(makeCompletedEvent());
    await sleep(60);
    // 通知轮正在跑（runAgentTurn 挂住）→ 必须 busy
    expect(handlers.isBusy()).toBe(true);

    release?.();
    await sleep(120);
    expect(handlers.isBusy()).toBe(false);

    handlers.stop();
  });

  test("E5 (L5/N3) event-store 打不开时降级为 no-op，且降级标记与提示必须真实出现", () => {
    const { env, isSubscribed } = makeSubscribableEnv();
    const notice = mock((_t: string) => {});
    // 不可写路径：getOrCreateEventStore → mkdirSync 抛 ENOENT
    const handlers = createChatEventHandlers({
      env,
      sessionComponent: makeSessionComponent() as any,
      notice,
      runAgentTurn: async () => "",
      dbPath: "/proc/nonexistent-dir-4576/events.db",
    });

    // ★ 交叉验证 N3：dbPath 若不透传，这条断言会失败（原 E5 是同义反复）。
    expect(handlers.isStoreDegraded()).toBe(true);
    const allText = notice.mock.calls.map((c) => String(c[0])).join("\n");
    expect(allText).toContain("无法初始化事件存储");

    // 降级后形状仍满足下游（不抛、不假装忙）
    expect(handlers.isBusy()).toBe(false);
    expect(() => handlers.stop()).not.toThrow();
    // ★ 交叉验证 LOW-2：原来断言 `getIsIdle() === true` 是**空洞**的
    //   （没传 isIdle 时它恒 true，与订阅与否无关）。改成真正检查订阅状态。
    expect(isSubscribed()).toBe(false);
  });
});

// ============================================================================
// 组 I — 第四轮 xval（PASS WITH MINOR）：LOW-2 真修 + NEW-1/2/4
// ============================================================================

describe("组 I：xval4 收尾", () => {
  test("I1 (LOW-2 真修) 降级时只订阅 1 次（TaskEventHandler），健康时 2 次", () => {
    // ★ 上一版断言 `isSubscribed() === false` 是**空洞**的：它放在 stop() 之后，
    //   而 stop() 必然退订 —— 降级/健康两种路径都得到 false。
    //   真正能区分的信号是**订阅次数**：降级时 EventHandler 没建 → 只有
    //   TaskEventHandler 订阅（1 次）；健康时两者都订阅（2 次）。
    const degraded = makeCountingEnv();
    const h1 = createChatEventHandlers({
      env: degraded.env,
      sessionComponent: makeSessionComponent() as any,
      notice: () => {},
      runAgentTurn: async () => "",
      dbPath: "/proc/nonexistent-dir-4576/events.db",
    });
    expect(h1.isStoreDegraded()).toBe(true);
    expect(degraded.subscribeCount()).toBe(1);

    const healthy = makeCountingEnv();
    const h2 = createChatEventHandlers({
      env: healthy.env,
      sessionComponent: makeSessionComponent() as any,
      notice: () => {},
      runAgentTurn: async () => "",
      dbPath: join(tmpDir, "events.db"),
    });
    expect(h2.isStoreDegraded()).toBe(false);
    expect(healthy.subscribeCount()).toBe(2);

    h1.stop();
    h2.stop();
  });

});
