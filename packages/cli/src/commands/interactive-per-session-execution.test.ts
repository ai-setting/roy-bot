/**
 * @fileoverview REPL 执行态按 session 隔离测试 (Task #4486 Phase 2)
 *
 * 核心语义（TDD）：
 * 1. `executingSessions: Map<string, number>`（引用计数）替代 isExecuting 单布尔：
 *    - 两个 session 可同时 executing
 *    - `isIdle()` = 所有 session 都空闲（派生值）
 *    - `isExecuting` getter 保留为派生值（状态栏 / 输入提示 / ESC 用）
 * 2. `isSessionIdle(sessionId)` 供 EventHandler 做 per-session 门禁
 * 3. `currentAgentContext` 单槽改为 executeInternal 显式传参：
 *    - 并发两轮时各自的 agentContext 不互相覆盖
 */

import { describe, test, expect, vi, beforeEach } from "bun:test";
import { REPL } from "./run";

// ============================================================================
// Helpers
// ============================================================================

/**
 * 构造一个最小可用的 REPL 实例（绕过 readline / Ink）。
 * 用 Object.create(prototype) 保留真实方法，只 stub 副作用。
 */
function makeRepl(onExecute?: (msg: any, traceId?: string, agentContext?: any) => Promise<any>) {
  const repl = Object.create(REPL.prototype) as any;
  repl.isShuttingDown = false;
  // ★ Task #4486: isExecuting 现在是只读派生 getter，不能再赋值。
  //   执行态由 executingSessions 跟踪。
  repl.executingSessions = new Map<string, number>();
  repl.replMode = "ready";
  repl.statusBarCtx = {};
  repl.options = {
    sessionId: "sess_default",
    sessionTitle: "Test",
    onExecute: onExecute ?? vi.fn().mockResolvedValue("ok"),
    onStatus: vi.fn(),
    onSwitchSession: vi.fn(),
    onCompact: vi.fn(),
    onShutdown: vi.fn().mockResolvedValue(undefined),
  };
  // 屏蔽输出副作用
  repl.setMode = vi.fn();
  repl.redrawInputArea = vi.fn();
  repl.updatePrompt = vi.fn();
  repl.rl = null;
  return repl;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn: () => boolean, timeout = 3000, interval = 5): Promise<void> {
  const start = Date.now();
  while (!fn() && Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, interval));
  }
  if (!fn()) throw new Error(`waitFor timed out after ${timeout}ms`);
}

// ============================================================================
// 测试 1：executingSessions 多 session 并发
// ============================================================================

describe("REPL 执行态隔离: executingSessions", () => {
  test("executingSessions 是引用计数 Map，初始为空且 isIdle()=true", () => {
    const repl = makeRepl();
    expect(repl.executingSessions).toBeInstanceOf(Map);
    expect(repl.executingSessions.size).toBe(0);
    expect(repl.isIdle()).toBe(true);
  });

  test("两个 session 可同时 executing，各自独立跟踪", async () => {
    const gates: Array<() => void> = [];
    const repl = makeRepl(async () => {
      await new Promise<void>((r) => gates.push(r));
      return "done";
    });

    // 手动标记两个 session 在执行（模拟 executeInternal 的两个并发调用）
    repl.markSessionExecuting("oc_A", true);
    repl.markSessionExecuting("oc_B", true);

    expect(repl.executingSessions.get("oc_A")).toBe(1);
    expect(repl.executingSessions.get("oc_B")).toBe(1);
    expect(repl.isSessionIdle("oc_A")).toBe(false);
    expect(repl.isSessionIdle("oc_B")).toBe(false);
    // ★ 派生值：有任一 session 在执行 → isExecuting=true / isIdle()=false
    expect(repl.isExecuting).toBe(true);
    expect(repl.isIdle()).toBe(false);

    // 只释放 A → A 空闲，B 仍占用，全局仍非 idle
    repl.markSessionExecuting("oc_A", false);
    expect(repl.isSessionIdle("oc_A")).toBe(true);
    expect(repl.isSessionIdle("oc_B")).toBe(false);
    expect(repl.isExecuting).toBe(true);
    expect(repl.isIdle()).toBe(false);

    // 全部释放 → 全局 idle
    repl.markSessionExecuting("oc_B", false);
    expect(repl.isExecuting).toBe(false);
    expect(repl.isIdle()).toBe(true);

    for (const g of gates) g();
  });

  test("isSessionIdle(sessionId) 对未登记的 session 返回 true", () => {
    const repl = makeRepl();
    repl.markSessionExecuting("oc_A", true);
    expect(repl.isSessionIdle("oc_unknown")).toBe(true);
    expect(repl.isSessionIdle("oc_A")).toBe(false);
  });

  test("isExecuting 是派生 getter（不能直接赋值覆盖语义）", () => {
    const repl = makeRepl();
    expect(repl.isExecuting).toBe(false);
    repl.markSessionExecuting("oc_X", true);
    expect(repl.isExecuting).toBe(true);
    repl.executingSessions.clear();
    expect(repl.isExecuting).toBe(false);
  });
});

// ============================================================================
// 测试 2：executeInternal 显式 sessionId / agentContext 传参
// ============================================================================

describe("REPL 执行态隔离: executeInternal 显式传参", () => {
  test("executeInternal(message, { sessionId }) 把 sessionId 传给 onExecute", async () => {
    const calls: Array<{ agentContext?: any; traceId?: string }> = [];
    const repl = makeRepl(async (_msg, traceId, agentContext) => {
      calls.push({ traceId, agentContext });
      return "ok";
    });

    await repl.executeInternal("hello", { showPrompt: false, sessionId: "oc_A" });

    expect(calls.length).toBe(1);
    // sessionId 必须注入到 agentContext.eventSessionId（下游 QueryExecutor 用它）
    expect(calls[0].agentContext?.eventSessionId).toBe("oc_A");
  });

  test("并发两轮各自带自己的 agentContext，互不覆盖（修单槽竞争）", async () => {
    const seen: Array<{ tag: string; eventSessionId?: string; marker?: string }> = [];
    const repl = makeRepl(async (_msg, _traceId, agentContext) => {
      // 模拟真实 LLM 调用耗时，制造重叠
      await delay(30);
      seen.push({
        tag: agentContext?.marker,
        eventSessionId: agentContext?.eventSessionId,
        marker: agentContext?.marker,
      });
      return "ok";
    });

    const p1 = repl.executeInternal("m1", {
      showPrompt: false,
      sessionId: "oc_A",
      agentContext: { marker: "ctx-A", eventSessionId: "oc_A" },
    });
    const p2 = repl.executeInternal("m2", {
      showPrompt: false,
      sessionId: "oc_B",
      agentContext: { marker: "ctx-B", eventSessionId: "oc_B" },
    });

    await Promise.all([p1, p2]);

    expect(seen.length).toBe(2);
    const a = seen.find((s) => s.marker === "ctx-A")!;
    const b = seen.find((s) => s.marker === "ctx-B")!;
    // ★ 核心：各自的 agentContext 没有互相覆盖
    expect(a.eventSessionId).toBe("oc_A");
    expect(b.eventSessionId).toBe("oc_B");
  });

  test("executeInternal 结束后释放自己的 session 占用，不误清别人", async () => {
    let releaseB: () => void = () => {};
    const gateB = new Promise<void>((r) => {
      releaseB = r;
    });
    const repl = makeRepl(async (msg) => {
      if (msg === "slow") await gateB;
      return "ok";
    });

    const pB = repl.executeInternal("slow", { showPrompt: false, sessionId: "oc_B" });
    await waitFor(() => repl.isSessionIdle("oc_B") === false, 2000);

    // A 快速跑完
    await repl.executeInternal("fast", { showPrompt: false, sessionId: "oc_A" });

    // A 空闲，B 仍占用
    expect(repl.isSessionIdle("oc_A")).toBe(true);
    expect(repl.isSessionIdle("oc_B")).toBe(false);
    expect(repl.isIdle()).toBe(false);

    releaseB();
    await pB;
    expect(repl.isSessionIdle("oc_B")).toBe(true);
    expect(repl.isIdle()).toBe(true);
  });

  test("未传 sessionId 时回落 options.sessionId（向后兼容单会话调用）", async () => {
    const seen: any[] = [];
    const repl = makeRepl(async (_m, _t, agentContext) => {
      seen.push(agentContext);
      return "ok";
    });

    await repl.executeInternal("hello", { showPrompt: false });

    expect(seen.length).toBe(1);
    expect(seen[0]?.eventSessionId).toBe("sess_default");
  });

  test("executeInternal 抛错时也释放 session 占用（finally 保证）", async () => {
    const repl = makeRepl(async () => {
      throw new Error("boom");
    });
    // 屏蔽 console.error 噪声
    const origError = console.error;
    console.error = vi.fn();
    try {
      await repl.executeInternal("x", { showPrompt: false, sessionId: "oc_A" });
    } finally {
      console.error = origError;
    }
    expect(repl.isSessionIdle("oc_A")).toBe(true);
    expect(repl.isIdle()).toBe(true);
  });
});

// ============================================================================
// 测试 3：currentAgentContext 单槽移除后的行为
// ============================================================================

describe("REPL 执行态隔离: currentAgentContext 单槽已废弃", () => {
  test("handleEventMessageWithEnv 走显式传参，不依赖 currentAgentContext 单槽", async () => {
    const seen: any[] = [];
    const repl = makeRepl(async (_m, _t, agentContext) => {
      await delay(20);
      seen.push(agentContext);
      return "ok";
    });
    repl.sessionComponent = { getActiveSessionId: () => "sess_default" };
    repl.ensureActiveSession = vi.fn().mockResolvedValue(undefined);
    // 屏蔽 console.log 噪声
    const origLog = console.log;
    console.log = vi.fn();

    try {
      const eA = {
        message: "msg A",
        envEvent: { type: "event-source.event.lark-cli", metadata: { sourceId: "s" } },
        eventSessionId: "oc_A",
        chatId: "oc_A",
      };
      const eB = {
        message: "msg B",
        envEvent: { type: "event-source.event.lark-cli", metadata: { sourceId: "s" } },
        eventSessionId: "oc_B",
        chatId: "oc_B",
      };

      const p1 = repl.handleEventMessageWithEnv(eA);
      const p2 = repl.handleEventMessageWithEnv(eB);
      await Promise.all([p1, p2]);
    } finally {
      console.log = origLog;
    }

    expect(seen.length).toBe(2);
    const ids = seen.map((c) => c?.eventSessionId).sort();
    // ★ 两个事件各自的 eventSessionId 都正确（不因单槽覆盖而串味）
    expect(ids).toEqual(["oc_A", "oc_B"]);
  });
});

// ============================================================================
// 测试 4：per-session ticker / 状态栏派生
// ============================================================================

describe("REPL 执行态隔离: 派生状态", () => {
  test("getExecutingSessionIds() 返回当前占用列表（诊断用）", () => {
    const repl = makeRepl();
    repl.markSessionExecuting("oc_A", true);
    repl.markSessionExecuting("oc_B", true);
    expect(repl.getExecutingSessionIds().sort()).toEqual(["oc_A", "oc_B"]);
    repl.markSessionExecuting("oc_A", false);
    expect(repl.getExecutingSessionIds()).toEqual(["oc_B"]);
  });

  // ★ Task #4515 (H2b): 语义修正 —— 原测试断言的是「重复 mark 幂等」，
  //   而这正是 H2b 的缺陷本身（同 session 双跑时第一轮结束就提前释放）。
  //   引用计数下重复 mark 必须让计数递增，需要同样次数的 unmark 才释放。
  test("重复 mark 递增引用计数，需要同样次数 unmark 才释放", () => {
    const repl = makeRepl();
    repl.markSessionExecuting("oc_A", true);
    repl.markSessionExecuting("oc_A", true);
    expect(repl.executingSessions.get("oc_A")).toBe(2);
    repl.markSessionExecuting("oc_A", false);
    // 还有一轮在跑 → 仍占用
    expect(repl.executingSessions.get("oc_A")).toBe(1);
    expect(repl.isSessionIdle("oc_A")).toBe(false);
    repl.markSessionExecuting("oc_A", false);
    expect(repl.executingSessions.size).toBe(0);
    // 多余的 unmark 不报错、不产生负数条目
    repl.markSessionExecuting("oc_A", false);
    expect(repl.executingSessions.size).toBe(0);
  });
});
