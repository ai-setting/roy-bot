/**
 * @fileoverview 主 executor 与 per-session executor 的重复渲染测试 (Task #4515 / H3)
 *
 * ## 问题（#4514 复审 H3，codex 判 HIGH）
 *
 * `run.ts` 里有两个订阅同一批 `llm.*` / `tool.*` 事件的 QueryExecutor：
 *
 *   - **主 executor**（`queryExecutor`，用户输入用）——**没有** setSessionScope
 *   - **per-session executor 池**（事件驱动 turn 用）——有 setSessionScope(sid)
 *
 * StreamOutputService 的 sessionFilter 默认 undefined（不过滤），所以主
 * executor 会**照收所有 session 的事件**。当事件驱动 turn 走 per-session
 * executor 渲染一次、主 executor 又渲染一次 → 同一段文本出现两次。
 *
 * ## 为什么 headless 也受影响（推翻 #4486 的 caveat）
 *
 * 原 caveat 说「重复渲染需人工打字才触发，纯 headless 不受影响」，理由是
 * 主 executor 的 streamService 只在用户 `execute()` 之后才创建。
 *
 * 但 `__default__` lane（无 chatId 无 triggerSessionId 的后台通知）经
 * 「优 3」会落到 **REPL 自己的 active session**，此时
 * `runSessionId === sessionId` → `isEventDrivenTurn === false` → **走主
 * executor**。所以纯 headless 的事件流同样会创建/使用主 executor，也就会
 * 与 per-session executor 撞车。
 *
 * ## 修复
 *
 * 给主 executor 也 `setSessionScope(replSessionId)`：它只渲染 REPL 自己
 * session 的事件。配合 M2 修正后的 filter 语义（无 sessionId 的事件仍放行），
 * 不会吞掉合法事件。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  StreamOutputService,
  __resetAllStreamAbortForTest,
  type StreamChunkEvent,
} from "../../services/stream-output.service";
import { QueryExecutor } from "./query-executor";

// ============================================================================
// Helpers
// ============================================================================

function makeTextEvent(delta: string, sessionId?: string) {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    type: "llm.text",
    timestamp: Date.now(),
    metadata: sessionId ? { sessionId } : {},
    payload: { delta },
  } as any;
}

function makeStartEvent(sessionId?: string) {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    type: "llm.start",
    timestamp: Date.now(),
    metadata: sessionId ? { sessionId } : {},
    payload: { metadata: { model: "test" } },
  } as any;
}

/**
 * 最小 env：`subscribeTo` 返回 unsubscribe，`pushEnvEvent` 用来把事件扇出给
 * 所有订阅者（真实 Environment 就是这样做的 —— 这正是重复渲染的机制）。
 */
function makeEnv() {
  const handlers: Array<(e: any) => void> = [];
  return {
    subscribeTo: (_types: string[], cb: (e: any) => void) => {
      handlers.push(cb);
      return () => {
        const i = handlers.indexOf(cb);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
    subscribeAll: (cb: (e: any) => void) => {
      handlers.push(cb);
      return () => {
        const i = handlers.indexOf(cb);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
    pushEnvEvent: (e: any) => {
      for (const h of handlers.slice()) h(e);
      return e.id;
    },
    /** 测试用：模拟 env 把事件扇出给所有订阅者 */
    __emit: (e: any) => {
      for (const h of handlers.slice()) h(e);
    },
    getComponent: () => undefined,
  } as any;
}

function makeOutput() {
  return {
    log: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    success: () => {},
  } as any;
}

function textDeltas(chunks: StreamChunkEvent[]): string[] {
  return chunks.filter((c) => c.type === "llm.text").map((c) => (c as any).delta);
}

beforeEach(() => {
  __resetAllStreamAbortForTest();
});

// ============================================================================
// H3: 主 executor 必须只渲染 REPL 自己 session 的事件
// ============================================================================

describe("Task #4515 (H3): 主 executor 与 per-session executor 不重复渲染", () => {
  test("主 executor 绑了 REPL session 后，别的 session 的事件不被它渲染", () => {
    const env = makeEnv();

    // 主 executor（用户输入用），绑定 REPL 自己的 session
    const mainChunks: StreamChunkEvent[] = [];
    const main = new QueryExecutor({
      env,
      sessionComponent: undefined,
      output: makeOutput(),
      quiet: true,
      silent: true,
    });
    main.initStreamOutput(undefined);
    main.setSessionScope("repl-session");
    main.setChunkCallback((e) => mainChunks.push(e));
    main.subscribeToEvents();

    // per-session executor（事件驱动 turn 用）
    const sessChunks: StreamChunkEvent[] = [];
    const sess = new QueryExecutor({
      env,
      sessionComponent: undefined,
      output: makeOutput(),
      quiet: true,
      silent: true,
    });
    sess.initStreamOutput(undefined);
    sess.setSessionScope("sess_B");
    sess.setChunkCallback((e) => sessChunks.push(e));
    sess.subscribeToEvents();

    // 事件：sess_B 的流式文本
    env.__emit(makeStartEvent("sess_B"));
    env.__emit(makeTextEvent("HELLO-B", "sess_B"));

    // ★ 核心断言：per-session 渲染一次，主 executor **不**渲染
    expect(textDeltas(sessChunks)).toEqual(["HELLO-B"]);
    expect(textDeltas(mainChunks)).toEqual([]);

    main.dispose();
    sess.dispose();
  });

  test("headless 场景：__default__ 落到 REPL session → 只渲染一次", () => {
    // __default__ lane 经优 3 解析到 REPL 自己的 session → isEventDrivenTurn=false
    //   → 走主 executor。此时主 executor 就是"唯一渲染者"，必须正好渲染一次。
    const env = makeEnv();
    const chunks: StreamChunkEvent[] = [];

    const main = new QueryExecutor({
      env,
      sessionComponent: undefined,
      output: makeOutput(),
      quiet: true,
      silent: true,
    });
    main.initStreamOutput(undefined);
    main.setSessionScope("repl-session");
    main.setChunkCallback((e) => chunks.push(e));
    main.subscribeToEvents();

    env.__emit(makeStartEvent("repl-session"));
    env.__emit(makeTextEvent("ONLY-ONCE", "repl-session"));

    expect(textDeltas(chunks)).toEqual(["ONLY-ONCE"]);

    main.dispose();
  });

  test("主 executor 仍渲染 REPL session 自己的事件（不能为了去重把主路径弄哑）", () => {
    const env = makeEnv();
    const chunks: StreamChunkEvent[] = [];

    const main = new QueryExecutor({
      env,
      sessionComponent: undefined,
      output: makeOutput(),
      quiet: true,
      silent: true,
    });
    main.initStreamOutput(undefined);
    main.setSessionScope("repl-session");
    main.setChunkCallback((e) => chunks.push(e));
    main.subscribeToEvents();

    env.__emit(makeStartEvent("repl-session"));
    env.__emit(makeTextEvent("user-turn", "repl-session"));

    expect(textDeltas(chunks)).toEqual(["user-turn"]);

    main.dispose();
  });

  test("多个 per-session executor + 主 executor 并发时，各 session 只渲染自己的", () => {
    const env = makeEnv();

    const main = new QueryExecutor({
      env, sessionComponent: undefined, output: makeOutput(), quiet: true, silent: true,
    });
    main.initStreamOutput(undefined);
    main.setSessionScope("repl");
    const mainChunks: StreamChunkEvent[] = [];
    main.setChunkCallback((e) => mainChunks.push(e));
    main.subscribeToEvents();

    const mk = (sid: string) => {
      const chunks: StreamChunkEvent[] = [];
      const ex = new QueryExecutor({
        env, sessionComponent: undefined, output: makeOutput(), quiet: true, silent: true,
      });
      ex.initStreamOutput(undefined);
      ex.setSessionScope(sid);
      ex.setChunkCallback((e) => chunks.push(e));
      ex.subscribeToEvents();
      return { ex, chunks };
    };

    const a = mk("sess_A");
    const b = mk("sess_B");

    // 交错发出三个 session 的事件
    env.__emit(makeStartEvent("sess_A"));
    env.__emit(makeTextEvent("from-A", "sess_A"));
    env.__emit(makeStartEvent("sess_B"));
    env.__emit(makeTextEvent("from-B", "sess_B"));
    env.__emit(makeStartEvent("repl"));
    env.__emit(makeTextEvent("from-repl", "repl"));

    // 每个窗口恰好一份，没有重复
    expect(textDeltas(a.chunks)).toEqual(["from-A"]);
    expect(textDeltas(b.chunks)).toEqual(["from-B"]);
    expect(textDeltas(mainChunks)).toEqual(["from-repl"]);

    main.dispose();
    a.ex.dispose();
    b.ex.dispose();
  });

  test("无 sessionId 的事件在绑定 scope 后仍被主 executor 渲染（M2 语义）", () => {
    // 回归护栏：H3 给主 executor 绑 scope 后，不能把"没有 sessionId 的
    // llm.*"整批吞掉（M2 修复的语义）。
    const env = makeEnv();
    const chunks: StreamChunkEvent[] = [];

    const main = new QueryExecutor({
      env, sessionComponent: undefined, output: makeOutput(), quiet: true, silent: true,
    });
    main.initStreamOutput(undefined);
    main.setSessionScope("repl");
    main.setChunkCallback((e) => chunks.push(e));
    main.subscribeToEvents();

    env.__emit(makeStartEvent(undefined));
    env.__emit(makeTextEvent("orphan"));

    expect(textDeltas(chunks)).toEqual(["orphan"]);

    main.dispose();
  });
});

// ============================================================================
// H3-structural: 不依赖调用方手工 setSessionScope
// ============================================================================

describe("Task #4515 (H3 结构性保证): execute() 自动绑定本次 session", () => {
  test("主 executor 从未调用 setSessionScope，也不会渲染别 session 的事件", async () => {
    const env = makeEnv();
    const mainChunks: StreamChunkEvent[] = [];

    // ⚠️ 关键：这里**故意不调用** main.setSessionScope(...)
    const main = new QueryExecutor({
      env,
      sessionComponent: undefined,
      output: makeOutput(),
      quiet: true,
      silent: true,
    });
    main.initStreamOutput(undefined);
    main.setChunkCallback((e) => mainChunks.push(e));

    // 模拟一次用户输入（真实路径：execute(message, replSessionId, ...)）
    // stub 掉 agent 调用，只关心流式订阅 + scope 绑定
    (main as any).agentComponent = undefined;
    const executePromise = main
      .execute("hi", "repl-session", {}, "trace-x", {})
      .catch(() => "stubbed");

    // 等 subscribeToEvents 生效
    await new Promise((r) => setTimeout(r, 10));

    // 别 session 的事件
    env.__emit(makeStartEvent("sess_B"));
    env.__emit(makeTextEvent("LEAKED-B", "sess_B"));
    // 本 session 的事件
    env.__emit(makeTextEvent("mine", "repl-session"));

    await executePromise;

    // ★ 核心断言：别 session 的文本不能出现在主 executor 的渲染里
    expect(textDeltas(mainChunks)).not.toContain("LEAKED-B");
    expect(textDeltas(mainChunks)).toContain("mine");

    main.dispose();
  });

  test("同一 executor 连续服务两个 session 时，scope 每轮刷新（不残留旧 scope）", async () => {
    const env = makeEnv();
    const chunks: StreamChunkEvent[] = [];

    const ex = new QueryExecutor({
      env,
      sessionComponent: undefined,
      output: makeOutput(),
      quiet: true,
      silent: true,
    });
    ex.initStreamOutput(undefined);
    ex.setChunkCallback((e) => chunks.push(e));

    // 第一轮：session A
    const p1 = ex.execute("a", "sess_A", {}, "t1", {}).catch(() => "stub");
    await new Promise((r) => setTimeout(r, 10));
    env.__emit(makeTextEvent("from-A", "sess_A"));
    env.__emit(makeTextEvent("from-B", "sess_B"));
    await p1;

    expect(textDeltas(chunks)).toContain("from-A");
    expect(textDeltas(chunks)).not.toContain("from-B");

    // 第二轮：同一 executor 改服务 session B
    chunks.length = 0;
    const p2 = ex.execute("b", "sess_B", {}, "t2", {}).catch(() => "stub");
    await new Promise((r) => setTimeout(r, 10));
    env.__emit(makeTextEvent("from-B2", "sess_B"));
    env.__emit(makeTextEvent("from-A2", "sess_A"));
    await p2;

    expect(textDeltas(chunks)).toContain("from-B2");
    expect(textDeltas(chunks)).not.toContain("from-A2");

    ex.dispose();
  });
});

// ============================================================================
// M2 × H3: 无 sessionId 的事件只能渲染一次（交叉验证发现的回归）
// ============================================================================

describe("Task #4515 (M2 × H3): 无 sessionId 事件不扇出", () => {
  test("主 executor + 两个 per-session executor 同时订阅，无 sid 事件只渲染 1 份", async () => {
    const env = makeEnv();

    // 主 executor（无归属事件的"主人"）
    const mainChunks: StreamChunkEvent[] = [];
    const main = new QueryExecutor({
      env, sessionComponent: undefined, output: makeOutput(), quiet: true, silent: true,
    });
    main.initStreamOutput(undefined);
    main.setChunkCallback((e) => mainChunks.push(e));
    main.subscribeToEvents();

    const mkNonOwner = (sid: string) => {
      const chunks: StreamChunkEvent[] = [];
      const ex = new QueryExecutor({
        env, sessionComponent: undefined, output: makeOutput(), quiet: true, silent: true,
      });
      ex.initStreamOutput(undefined);
      ex.setSessionScope(sid);
      ex.setAcceptsSidelessEvents(false); // per-session executor 不是主人
      ex.setChunkCallback((e) => chunks.push(e));
      ex.subscribeToEvents();
      return { ex, chunks };
    };

    const a = mkNonOwner("sess_A");
    const b = mkNonOwner("sess_B");

    // 一个无 sessionId 的 llm.text —— 交叉验证实测修复前会被渲染 3 份
    env.__emit(makeStartEvent(undefined));
    env.__emit(makeTextEvent("ORPHAN-NO-SESSION"));

    const total =
      textDeltas(mainChunks).length +
      textDeltas(a.chunks).length +
      textDeltas(b.chunks).length;

    expect(textDeltas(mainChunks)).toEqual(["ORPHAN-NO-SESSION"]);
    expect(total).toBe(1);

    main.dispose();
    a.ex.dispose();
    b.ex.dispose();
  });

  test("各 session 的事件仍只被自己的 executor 渲染（隔离不受影响）", async () => {
    const env = makeEnv();
    const mainChunks: StreamChunkEvent[] = [];

    const main = new QueryExecutor({
      env, sessionComponent: undefined, output: makeOutput(), quiet: true, silent: true,
    });
    main.initStreamOutput(undefined);
    // 生产里主 executor 的 scope 由 execute(replSessionId) 结构性绑定；
    // 本用例不跑 execute()，所以显式绑一次等价条件。
    main.setSessionScope("repl-session");
    main.setChunkCallback((e) => mainChunks.push(e));
    main.subscribeToEvents();

    const mkNonOwner = (sid: string) => {
      const chunks: StreamChunkEvent[] = [];
      const ex = new QueryExecutor({
        env, sessionComponent: undefined, output: makeOutput(), quiet: true, silent: true,
      });
      ex.initStreamOutput(undefined);
      ex.setSessionScope(sid);
      ex.setAcceptsSidelessEvents(false);
      ex.setChunkCallback((e) => chunks.push(e));
      ex.subscribeToEvents();
      return { ex, chunks };
    };

    const a = mkNonOwner("sess_A");
    const b = mkNonOwner("sess_B");

    env.__emit(makeStartEvent("sess_A"));
    env.__emit(makeTextEvent("from-A", "sess_A"));
    env.__emit(makeStartEvent("sess_B"));
    env.__emit(makeTextEvent("from-B", "sess_B"));

    expect(textDeltas(a.chunks)).toEqual(["from-A"]);
    expect(textDeltas(b.chunks)).toEqual(["from-B"]);
    expect(textDeltas(mainChunks)).toEqual([]);

    main.dispose();
    a.ex.dispose();
    b.ex.dispose();
  });
});

// ============================================================================
// M2 × H3 生产顺序：setAcceptsSidelessEvents(false) 必须在 execute() 之后仍生效
// ============================================================================

describe("Task #4515 (M2 × H3 生产顺序): per-session executor 的 opt-out 不能被 execute() 覆盖", () => {
  test("按生产顺序（setScope/opt-out → execute）后，无 sid 事件不被 per-session 渲染", async () => {
    // ⚠️ 这条用例复刻生产的真实调用顺序（run.ts）：
    //      created.initStreamOutput(); created.setSessionScope(sid);
    //      created.setAcceptsSidelessEvents(false);   ← 在 execute() 之前
    //      created.setChunkCallback(cb);
    //      await exec.execute(message, sid, ...)       ← 之后才 execute
    //
    //   之前那条用例没调 execute()，恰好绕开了覆盖问题 → 假绿。
    const env = makeEnv();
    const chunks: StreamChunkEvent[] = [];

    const ex = new QueryExecutor({
      env, sessionComponent: undefined, output: makeOutput(), quiet: true, silent: true,
    });
    ex.initStreamOutput(undefined);
    ex.setSessionScope("sess_A");
    ex.setAcceptsSidelessEvents(false); // 非主人（execute 之前设定，生产顺序）
    ex.setChunkCallback((e) => chunks.push(e));

    const p = ex.execute("hi", "sess_A", {}, "t1", {}).catch(() => "stub");
    await new Promise((r) => setTimeout(r, 15));

    // execute() 之后：opt-out 必须仍在位
    expect((ex as any).streamService.acceptsSidelessEvents).toBe(false);

    env.__emit(makeStartEvent(undefined));
    env.__emit(makeTextEvent("ORPHAN"));

    await p;

    expect(textDeltas(chunks)).toEqual([]);

    ex.dispose();
  });

  test("主 executor（从不 opt-out）在 execute() 之后仍是主人", async () => {
    const env = makeEnv();
    const chunks: StreamChunkEvent[] = [];

    const main = new QueryExecutor({
      env, sessionComponent: undefined, output: makeOutput(), quiet: true, silent: true,
    });
    main.initStreamOutput(undefined);
    main.setChunkCallback((e) => chunks.push(e));

    const p = main.execute("hi", "repl-session", {}, "t1", {}).catch(() => "stub");
    await new Promise((r) => setTimeout(r, 15));

    expect((main as any).streamService.acceptsSidelessEvents).toBe(true);

    env.__emit(makeStartEvent(undefined));
    env.__emit(makeTextEvent("ORPHAN-OK"));

    await p;

    expect(textDeltas(chunks)).toEqual(["ORPHAN-OK"]);

    main.dispose();
  });
});
