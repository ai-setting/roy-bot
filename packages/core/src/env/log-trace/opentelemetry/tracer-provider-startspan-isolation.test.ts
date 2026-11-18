/**
 * @fileoverview 并发 run 的 startSpan() 真实 trace 隔离测试 (Task #4515 / H1)
 *
 * ## 为什么需要这个测试（#4514 复审 H1）
 *
 * 已有的 `tracer-provider-run-isolation.test.ts` **只断言 `provider.getGlobalContext()`
 * 的读值**，从不调用 `startSpan()` —— 而 `startSpan()` 才是生产唯一用法。
 *
 * 结果：`withGlobalContext` 的 ALS 修好了「provider 那一层」，但
 * `OTelTracerImpl.startSpan()` 里父上下文优先级是：
 *
 *     hasExplicitParent ? parentFromOptions
 *   : this.currentContext            ← ⚠️ tracer 实例单槽，优先级更高
 *   : globalContext                  ← ALS 作用域只影响这一层
 *
 * 生产所有调用点都用 `getTracer("roy-tracer")`（同一个 key → 同一个实例，
 * 见 `decorator.ts:425` / `logger.ts:398` / `bash.ts:19,131` /
 * `event-source-handlers.ts:1675`），所以并发 run 共享同一个 `currentContext`：
 *
 *   run A: startSpan() → currentContext = A        （traceId=trace-A）
 *   run B: startSpan() → 继承 currentContext = A   ❌ B 的 traceId 变成 trace-A
 *   run B: span.end()  → currentContext 被恢复成 A 或清空 → 把 A 的上下文踩坏
 *
 * ## 本测试锁定的不变量
 *
 * 并发两个 run（各自 `withGlobalContext` 作用域）调用 **同一 tracer 实例** 的
 * `startSpan()` 时，**实际产出的** traceId / parentSpanId 必须互相独立：
 *   - 每个 run 的根 span 是独立的新 trace（除非显式传 parent）
 *   - run A 的子 span 父是 run A 的根，run B 的子 span 父是 run B 的根
 *   - run A 的 span.end() 不得影响 run B 后续 startSpan 的父上下文
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { OTelTracerProvider } from "./tracer-provider";
import type { SpanContext } from "../types";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 不初始化 storage 的 provider：`startSpan` 不写 DB，`span.end()` 时 storage
 * 未初始化会打 warn 但不会抛（见 otel-tracer "storage not initialized" 分支）。
 * 为了让测试输出干净，所有 span 都不调 end()，除非该用例明确要测 end 语义。
 */
function makeProvider(): OTelTracerProvider {
  return new OTelTracerProvider();
}

describe("Task #4515 (H1): 并发 run 的 startSpan() trace 隔离", () => {
  let provider: OTelTracerProvider;

  beforeEach(() => {
    provider = makeProvider();
  });

  test("并发两个 run 共用同一 tracer 实例时，根 span 的 traceId 必须不同", async () => {
    const tracer = provider.getTracer("roy-tracer"); // 生产用法：同一个实例
    const result: Record<string, string> = {};

    const run = (name: string, ms: number) =>
      provider.withGlobalContext(undefined, async () => {
        await delay(ms);
        const span = tracer.startSpan(`root-${name}`);
        result[`${name}_traceId`] = span.spanContext.traceId;
        result[`${name}_parent`] = String(span.spanContext.parentSpanId);
        await delay(ms);
      });

    await Promise.all([run("A", 2), run("B", 8)]);

    // 两个 run 都是独立根 span（无显式 parent）→ traceId 必须不同
    expect(result.A_traceId).toBeDefined();
    expect(result.B_traceId).toBeDefined();
    expect(result.A_traceId).not.toBe(result.B_traceId);
    // 根 span 没有父
    expect(result.A_parent).toBe("undefined");
    expect(result.B_parent).toBe("undefined");
  });

  test("并发两个 run 的子 span 各挂各的根（parentSpanId 不串）", async () => {
    const tracer = provider.getTracer("roy-tracer");
    const result: Record<string, { rootTrace: string; rootSpan: string; childTrace: string; childParent: string }> = {};

    const run = (name: string, ms: number) =>
      provider.withGlobalContext(undefined, async () => {
        const root = tracer.startSpan(`root-${name}`);
        await delay(ms); // 让两个 run 交错
        const child = tracer.startSpan(`child-${name}`);
        result[name] = {
          rootTrace: root.spanContext.traceId,
          rootSpan: root.spanContext.spanId,
          childTrace: child.spanContext.traceId,
          childParent: String(child.spanContext.parentSpanId),
        };
      });

    await Promise.all([run("A", 3), run("B", 9)]);

    // 子 span 必须继承**自己 run** 的 trace
    expect(result.A.childTrace).toBe(result.A.rootTrace);
    expect(result.A.childParent).toBe(result.A.rootSpan);
    expect(result.B.childTrace).toBe(result.B.rootTrace);
    expect(result.B.childParent).toBe(result.B.rootSpan);
    // 两个 run 的 trace 必须不同
    expect(result.A.rootTrace).not.toBe(result.B.rootTrace);
  });

  test("run A 结束 span 后，run B 的新 span 不被 A 的上下文污染", async () => {
    const tracer = provider.getTracer("roy-tracer");
    const result: Record<string, string> = {};

    const runA = provider.withGlobalContext(undefined, async () => {
      const a1 = tracer.startSpan("A1");
      await delay(5);
      a1.end(); // 触发 handleSpanEnd → 可能把 currentContext 恢复/清空
      result.A1_trace = a1.spanContext.traceId;
    });

    const runB = provider.withGlobalContext(undefined, async () => {
      await delay(2);
      const b1 = tracer.startSpan("B1");
      result.B1_trace = b1.spanContext.traceId;
      await delay(12); // 等 A 的 end() 已经跑过
      const b2 = tracer.startSpan("B2");
      result.B2_trace = b2.spanContext.traceId;
      result.B2_parent = String(b2.spanContext.parentSpanId);
    });

    await Promise.all([runA, runB]);

    // B1/B2 都是 B 自己的新 trace（B 没有显式 parent）
    expect(result.B1_trace).not.toBe(result.A1_trace);
    // A 的 end() 不该让 B2 认 A1 当爹
    expect(result.B2_parent).not.toBe(result.A1_trace);
  });

  test("显式 options.parent 仍然最高优先级（跨进程场景不被改坏）", async () => {
    const tracer = provider.getTracer("roy-tracer");
    const injected: SpanContext = {
      traceId: "trace-explicit-000000000000000000",
      spanId: "span-explicit-000",
      parentSpanId: undefined,
    } as SpanContext;

    const span = await provider.withGlobalContext(undefined, async () => {
      return tracer.startSpan("cross-process", { parent: injected });
    });

    expect(span.spanContext.traceId).toBe(injected.traceId);
    expect(span.spanContext.parentSpanId).toBe(injected.spanId);
  });

  test("显式 options.context 仍然最高优先级（注入完整 context）", async () => {
    const tracer = provider.getTracer("roy-tracer");
    const injected: SpanContext = {
      traceId: "trace-injected-00000000000000000",
      spanId: "span-injected-000",
      parentSpanId: undefined,
    } as SpanContext;

    const span = await provider.withGlobalContext(undefined, async () => {
      return tracer.startSpan("injected", { context: injected });
    });

    expect(span.spanContext.traceId).toBe(injected.traceId);
    expect(span.spanContext.parentSpanId).toBe(injected.spanId);
  });

  test("无 ALS 作用域时，同步嵌套的父子关系仍然正确（向后兼容）", () => {
    const tracer = provider.getTracer("roy-tracer");

    const root = tracer.startSpan("root");
    const child = tracer.startSpan("child");

    // 同步链：child 继承 root（currentContext 或 ALS 未介入）
    expect(child.spanContext.traceId).toBe(root.spanContext.traceId);
    expect(child.spanContext.parentSpanId).toBe(root.spanContext.spanId);
  });

  test("对照实验：每个 run 用独立 tracer 实例时本来就隔离（证明根因是实例单槽）", async () => {
    const result: Record<string, string> = {};

    const run = (name: string, ms: number) =>
      provider.withGlobalContext(undefined, async () => {
        // 独立实例（getTracer 用不同 name → 不同实例）
        const ownTracer = provider.getTracer(`tracer-${name}`);
        await delay(ms);
        const span = ownTracer.startSpan(`root-${name}`);
        result[`${name}_traceId`] = span.spanContext.traceId;
        result[`${name}_parent`] = String(span.spanContext.parentSpanId);
        await delay(ms);
      });

    await Promise.all([run("A", 2), run("B", 8)]);

    expect(result.A_traceId).not.toBe(result.B_traceId);
    expect(result.A_parent).toBe("undefined");
    expect(result.B_parent).toBe("undefined");
  });
});

// ============================================================================
// H1-c: 作用域外 end() 不得把上下文泄漏到下一轮
// ============================================================================

describe("Task #4515 (H1-c): 作用域外 end 不污染下一轮", () => {
  test("作用域外 end() 会写进程级表 —— 这是调用方必须用同步作用域包裹的原因", async () => {
    // ⚠️ 这是**已知契约边界**，不是 provider 能单方面兜住的：
    //   `span.end()` → `handleSpanEnd()` 恢复父上下文时，写到哪里取决于
    //   **调用方当时所处的 ALS 作用域**。作用域外调用就必然写进程级表。
    //   所以生产代码（interactive.ts 的 finally）必须用
    //   `runInGlobalContextSync` 把 end() 包回本 run 的作用域 —— 本测试锁定
    //   这个边界，防止有人以为 provider 会"自动保护"而省掉那层包裹。
    const provider = makeProvider();
    const tracer = provider.getTracer("roy-tracer");

    let rootSpan!: ReturnType<typeof tracer.startSpan>;
    await provider.withGlobalContext(undefined, async () => {
      rootSpan = tracer.startSpan("root-A");
      tracer.startSpan("child-still-open"); // 让 end 后有"父"可恢复
    });

    tracer.setCurrentContext(undefined); // 清干净，便于观察泄漏
    rootSpan.end(); // 作用域外 end

    // 结论：泄漏到进程级表了（下一条断言反过来验证"包了作用域就不泄漏"）
    const leaked = tracer.getCurrentContext();
    expect(leaked).toBeDefined();

    // 对照：同样的 end 用 runInGlobalContextSync 包裹 → 不写进程级表
    tracer.setCurrentContext(undefined);
    await provider.withGlobalContext(undefined, async () => {
      const s2 = tracer.startSpan("root-quiet");
      tracer.startSpan("child-quiet");
      provider.runInGlobalContextSync(s2.spanContext, () => s2.end());
    });
    expect(tracer.getCurrentContext()).toBeUndefined();
  });

  test("用 runInGlobalContextSync 包住的 end() 不写进程级表", async () => {
    const provider = makeProvider();
    const tracer = provider.getTracer("roy-tracer");

    let rootSpan!: ReturnType<typeof tracer.startSpan>;
    let ctx: SpanContext | undefined;

    await provider.withGlobalContext(undefined, async () => {
      rootSpan = tracer.startSpan("root-A");
      ctx = rootSpan.spanContext;
      tracer.startSpan("child-open");
    });

    // 在同一个 run 的同步作用域里 end → 应该只写本 run 的 map（已丢弃）
    provider.runInGlobalContextSync(ctx, () => rootSpan.end());

    // 进程级表必须干净
    expect(tracer.getCurrentContext()).toBeUndefined();
  });
});
