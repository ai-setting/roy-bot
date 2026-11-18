/**
 * @fileoverview Trace context per-run 隔离测试 (Task #4486 Phase 3)
 *
 * 问题：`OTelTracerProvider.setGlobalContext` 是进程级单槽。
 * 并发多 session 时：
 *   - run A 设置 globalContext = A 的 span
 *   - run B 同时 startSpan() → 继承 A 的 traceId（串 trace）
 *   - run A 结束 setGlobalContext(undefined) → 把 B 的父上下文也清了
 *
 * 方案：把 globalContext 换成 AsyncLocalStorage 作用域内的 override，
 * `withGlobalContext(ctx, fn)` 在异步链内生效，链外仍回落到进程级单槽
 * （向后兼容所有既有调用方）。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { OTelTracerProvider } from "./tracer-provider";
import type { SpanContext } from "../types";

function ctx(traceId: string): SpanContext {
  return { traceId, spanId: `span_${traceId}`, parentSpanId: undefined } as SpanContext;
}

function makeProvider(): OTelTracerProvider {
  const provider = new OTelTracerProvider();
  // 不初始化 storage：startSpan 不需要 DB（span.end 才写）
  return provider;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("Task #4486 Phase 3: trace global context isolation", () => {
  let provider: OTelTracerProvider;

  beforeEach(() => {
    provider = makeProvider();
  });

  test("进程级 setGlobalContext / getGlobalContext 保持旧语义（向后兼容）", () => {
    expect(provider.getGlobalContext()).toBeUndefined();
    const c = ctx("legacy");
    provider.setGlobalContext(c);
    expect(provider.getGlobalContext()).toBe(c);
    provider.setGlobalContext(undefined);
    expect(provider.getGlobalContext()).toBeUndefined();
  });

  test("withGlobalContext 在异步链内覆盖全局 context，链外不受影响", async () => {
    const outer = ctx("outer");
    provider.setGlobalContext(outer);

    const inner = ctx("inner");
    let seenInside: SpanContext | undefined;
    await provider.withGlobalContext(inner, async () => {
      await delay(5);
      seenInside = provider.getGlobalContext();
    });

    expect(seenInside?.traceId).toBe("inner");
    // 链外仍是 outer（没被污染）
    expect(provider.getGlobalContext()?.traceId).toBe("outer");
  });

  test("两个并行 run 各自看到自己的 context（不串 trace）", async () => {
    const seen: Record<string, string | undefined> = {};

    const run = (name: string, ms: number) =>
      provider.withGlobalContext(ctx(name), async () => {
        await delay(ms);
        seen[name] = provider.getGlobalContext()?.traceId;
        await delay(ms);
        seen[`${name}_after`] = provider.getGlobalContext()?.traceId;
      });

    await Promise.all([run("A", 5), run("B", 12)]);

    expect(seen.A).toBe("A");
    expect(seen.A_after).toBe("A");
    expect(seen.B).toBe("B");
    expect(seen.B_after).toBe("B");
  });

  test("withGlobalContext(nested) 内层覆盖外层，退出后恢复外层", async () => {
    const seen: Record<string, string | undefined> = {};
    await provider.withGlobalContext(ctx("L1"), async () => {
      seen.before = provider.getGlobalContext()?.traceId;
      await provider.withGlobalContext(ctx("L2"), async () => {
        seen.inner = provider.getGlobalContext()?.traceId;
      });
      seen.after = provider.getGlobalContext()?.traceId;
    });

    expect(seen.before).toBe("L1");
    expect(seen.inner).toBe("L2");
    expect(seen.after).toBe("L1");
  });

  test("withGlobalContext(undefined) 在链内屏蔽进程级 context（不继承）", async () => {
    provider.setGlobalContext(ctx("process"));
    let inside: SpanContext | undefined = ctx("sentinel");
    await provider.withGlobalContext(undefined, async () => {
      inside = provider.getGlobalContext();
    });
    expect(inside).toBeUndefined();
    // 链外进程级还在
    expect(provider.getGlobalContext()?.traceId).toBe("process");
  });

  test("run A 结束清全局 context 不会破坏 run B 的链内 context", async () => {
    // 模拟 A/B 并发，A 先结束并 setGlobalContext(undefined)
    await Promise.all([
      provider.withGlobalContext(ctx("A"), async () => {
        await delay(3);
        // A 收尾：清进程级（旧代码做法）
        provider.setGlobalContext(undefined);
      }),
      provider.withGlobalContext(ctx("B"), async () => {
        await delay(10);
        // B 仍然看到自己的 context
        expect(provider.getGlobalContext()?.traceId).toBe("B");
      }),
    ]);
  });
});
