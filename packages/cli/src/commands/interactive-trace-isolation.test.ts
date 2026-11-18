/**
 * @fileoverview executeInternal 的 per-run trace 隔离测试 (Task #4515 / H1-b)
 *
 * ## 背景
 *
 * #4514 复审 H1 指出：`run.ts` 的 `startSpan("interactive.execute")`
 * 发生在 `provider.withGlobalContext(...)` 建立 ALS 作用域**之前**。
 *
 * H1 的主体修复（`tracer-provider.ts`：currentContext 入 ALS）之后仍然存在
 * 一个残余问题：
 *
 *   - 作用域**外**的 `startSpan()` 读写的是 provider 的**进程级** tracerContexts 表
 *   - 两个并发 run 都先在作用域外 startSpan → 第二个 run 会把第一个 run 的
 *     currentContext 变成自己（父子关系串味），而且拿到的 traceId 也可能继承
 *
 * ## 本测试锁定的不变量
 *
 * `executeInternal` 并发跑两个不同 session 时：
 *   1. 两轮传给 `onExecute` 的 `traceId` 必须**不同**（各自独立根 trace）
 *   2. 两轮结束后 provider 的进程级 tracer currentContext 必须被清干净
 *      （不在进程级单槽里留下"上一轮"的痕迹，否则下一轮会误继承）
 *   3. 单轮执行时 traceId 与根 span 一致（不误伤单会话路径）
 */

import { describe, test, expect, vi, beforeEach } from "bun:test";
import { REPL } from "./run";
import { getTracerProvider } from "@ai-setting/roy-bot-core";

// ============================================================================
// Helpers
// ============================================================================

/** 构造最小可用 REPL（跳过 readline / Ink），同 interactive-per-session-execution */
function makeRepl(onExecute?: (msg: any, traceId?: string, agentContext?: any) => Promise<any>) {
  const repl = Object.create(REPL.prototype) as any;
  repl.isShuttingDown = false;
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
  repl.setMode = vi.fn();
  repl.redrawInputArea = vi.fn();
  repl.updatePrompt = vi.fn();
  repl.rl = null;
  return repl;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

beforeEach(() => {
  const provider = getTracerProvider();
  // 干净起点：清掉进程级全局 context 与 tracer currentContext
  provider.setGlobalContext(undefined);
  const t = provider.getTracer("roy-tracer");
  t.setCurrentContext(undefined);
});

// ============================================================================
// H1-b: executeInternal 的 trace 隔离
// ============================================================================

describe("Task #4515 (H1-b): executeInternal per-run trace 隔离", () => {
  test("并发两个 session 的 traceId 必须不同（各自独立根 trace）", async () => {
    const traceIds: string[] = [];
    const repl = makeRepl(async (_msg, traceId) => {
      traceIds.push(String(traceId));
      await delay(5);
      return "ok";
    });

    await Promise.all([
      repl.executeInternal("a", { showPrompt: false, sessionId: "oc_A" }),
      repl.executeInternal("b", { showPrompt: false, sessionId: "oc_B" }),
    ]);

    expect(traceIds.length).toBe(2);
    expect(traceIds[0]).not.toBe(traceIds[1]);
  });

  test("并发两轮结束后，进程级 tracer currentContext 不留残留", async () => {
    const repl = makeRepl(async () => {
      await delay(5);
      return "ok";
    });

    await Promise.all([
      repl.executeInternal("a", { showPrompt: false, sessionId: "oc_A" }),
      repl.executeInternal("b", { showPrompt: false, sessionId: "oc_B" }),
    ]);

    const tracer = getTracerProvider().getTracer("roy-tracer");
    expect(tracer.getCurrentContext()).toBeUndefined();
  });

  test("单轮执行：traceId 与根 span 一致（不误伤单会话路径）", async () => {
    let seenTraceId: string | undefined;
    const repl = makeRepl(async (_msg, traceId) => {
      seenTraceId = traceId;
      return "ok";
    });

    await repl.executeInternal("solo", { showPrompt: false, sessionId: "oc_A" });

    expect(seenTraceId).toBeDefined();
    expect(typeof seenTraceId).toBe("string");
    // 单轮结束后不留残留
    expect(getTracerProvider().getTracer("roy-tracer").getCurrentContext()).toBeUndefined();
  });

  test("并发两轮各自在 ALS 作用域内 startSpan，traceId 与 onExecute 收到的一致", async () => {
    const provider = getTracerProvider();
    const tracer = provider.getTracer("roy-tracer");
    const observed: Array<{ traceId: string; spanTraceId: string; spanParent: string }> = [];

    const repl = makeRepl(async (_msg, traceId) => {
      // onExecute 内部（= 生产 agent 调用装饰器的位置）创建的 span
      const inner = tracer.startSpan("inside-execute");
      observed.push({
        traceId: String(traceId),
        spanTraceId: inner.spanContext.traceId,
        spanParent: String(inner.spanContext.parentSpanId),
      });
      await delay(5);
      return "ok";
    });

    await Promise.all([
      repl.executeInternal("a", { showPrompt: false, sessionId: "oc_A" }),
      repl.executeInternal("b", { showPrompt: false, sessionId: "oc_B" }),
    ]);

    expect(observed.length).toBe(2);
    // 每个 run 内部 span 都继承**自己**那一轮的 trace
    for (const o of observed) {
      expect(o.spanTraceId).toBe(o.traceId);
    }
    // 两轮 trace 不同
    expect(observed[0].spanTraceId).not.toBe(observed[1].spanTraceId);
  });
});

// ============================================================================
// H1-c: end() 必须在作用域内，否则泄漏到下一轮
// ============================================================================

describe("Task #4515 (H1-c): 一轮结束后不把 trace 上下文留给下一轮", () => {
  test("连续两轮（非并发）不得复用同一个 traceId", async () => {
    const provider = getTracerProvider();
    const tracer = provider.getTracer("roy-tracer");
    const traceIds: string[] = [];

    const repl = makeRepl(async (_msg, traceId) => {
      // 模拟真实 run 内部还有未结束的子 span（让 end() 之后有"父"可恢复）
      tracer.startSpan("inner-still-open");
      traceIds.push(String(traceId));
      return "ok";
    });

    // 第一轮
    await repl.executeInternal("first", { showPrompt: false, sessionId: "oc_A" });
    // 第二轮（不复用 session 并发，纯串行 —— 泄漏就必然暴露）
    await repl.executeInternal("second", { showPrompt: false, sessionId: "oc_A" });

    expect(traceIds.length).toBe(2);
    // ★ 核心断言：串行两轮必须是两个独立 trace
    expect(traceIds[0]).not.toBe(traceIds[1]);
    // 结束后进程级表干净
    expect(tracer.getCurrentContext()).toBeUndefined();
  });
});

// ============================================================================
// Task #4519 (V3): 消费侧契约 —— context 必须从「事件载荷」读，而不是进程级单槽
//
// 这一组测试锁的是 `executeInternal` 的**读侧**：ES 层已把 trace context 放进
// `envEvent.metadata.traceContext`，消费侧必须优先用它。
//
// 为什么必须有这一组：ES 层的写侧测试（event-source-trace-isolation.test.ts）
// 只证明「每条事件产出不同的 traceContext」，但如果消费侧仍然只读进程级单槽，
// 串味会照旧发生。破坏实验证实：把读取改回 `provider.getGlobalContext()` 时，
// ES 侧 8 个测试**全绿**（它们不看消费侧），所以必须在这里锁死。
// ============================================================================

describe("Task #4519 (V3): 载荷优先于进程级单槽", () => {
  test("envEvent.metadata.traceContext 存在时，必须复用它的 traceId（而非进程级单槽）", async () => {
    const provider = getTracerProvider();
    provider.setGlobalContext({
      traceId: "0000000000000000000000000000dead", // 进程级残留（应被忽略）
      spanId: "deadbeefdeadbeef",
      parentSpanId: undefined,
    });

    const seen: string[] = [];
    const repl = makeRepl(async (_msg, traceId) => {
      seen.push(String(traceId));
      return "ok";
    });

    await repl.executeInternal("event-driven", {
      showPrompt: false,
      sessionId: "oc_A",
      agentContext: {
        eventSessionId: "oc_A",
        envEvent: {
          metadata: {
            traceContext: {
              traceId: "1111111111111111111111111111beef",
              spanId: "cafebabecafebabe",
              parentSpanId: undefined,
            },
          },
        },
      },
    });

    expect(seen.length).toBe(1);
    // ★ 必须用载荷里的 traceId，不能被进程级残留覆盖
    expect(seen[0]).toBe("1111111111111111111111111111beef");

    provider.setGlobalContext(undefined);
  });

  test("两条并发 run 各带自己的载荷 context → 互不串味（即使进程级槽有污染）", async () => {
    const provider = getTracerProvider();
    // 故意把进程级槽污染成一个「第三个」trace
    provider.setGlobalContext({
      traceId: "9999999999999999999999999999ffff",
      spanId: "ffffffffffffffff",
      parentSpanId: undefined,
    });

    const seen: string[] = [];
    const repl = makeRepl(async (_msg, traceId) => {
      seen.push(String(traceId));
      await delay(5);
      return "ok";
    });

    const mkCtx = (traceId: string, spanId: string) => ({
      eventSessionId: traceId === "aaa" ? "oc_A" : "oc_B",
      envEvent: { metadata: { traceContext: { traceId, spanId, parentSpanId: undefined } } },
    });

    await Promise.all([
      repl.executeInternal("a", { showPrompt: false, sessionId: "oc_A", agentContext: mkCtx("aaaaaaaaaaaaaaaaaaaaaaaaaaaa1111", "aaaa1111aaaa1111") }),
      repl.executeInternal("b", { showPrompt: false, sessionId: "oc_B", agentContext: mkCtx("bbbbbbbbbbbbbbbbbbbbbbbbbbbb2222", "bbbb2222bbbb2222") }),
    ]);

    expect(seen.length).toBe(2);
    expect(new Set(seen).size).toBe(2);
    expect(seen).toContain("aaaaaaaaaaaaaaaaaaaaaaaaaaaa1111");
    expect(seen).toContain("bbbbbbbbbbbbbbbbbbbbbbbbbbbb2222");
    // 不得出现进程级残留的 trace
    expect(seen).not.toContain("9999999999999999999999999999ffff");

    provider.setGlobalContext(undefined);
  });

  test("无载荷时回落进程级单槽（向后兼容 RunTui / act / workflow 路径）", async () => {
    const provider = getTracerProvider();
    provider.setGlobalContext({
      traceId: "5555555555555555555555555555aaaa",
      spanId: "5555aaaa5555aaaa",
      parentSpanId: undefined,
    });

    const seen: string[] = [];
    const repl = makeRepl(async (_msg, traceId) => {
      seen.push(String(traceId));
      return "ok";
    });

    // 没有 envEvent / traceContext 的普通调用
    await repl.executeInternal("plain", { showPrompt: false, sessionId: "oc_A" });

    expect(seen.length).toBe(1);
    // ★ 回落语义必须保留（否则 RunTui/act 的既有行为会被破坏）
    expect(seen[0]).toBe("5555555555555555555555555555aaaa");

    provider.setGlobalContext(undefined);
  });
});
