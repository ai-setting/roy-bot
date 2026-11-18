/**
 * @fileoverview @Traced `errorIf` — 返回值驱动的 span ERROR 状态 (TDD RED)
 *
 * 背景（2026-10-16 生产事故 traceId=83eadac2316d5be7529ca42ce7057d63）：
 *   工具执行用**返回值**表达失败（`{success:false, error:"Tool not found: bash"}`），
 *   而不是抛异常 —— 因为 ReAct 循环必须把失败作为 tool result 回灌给模型
 *   （AI SDK v6 要求 tool-call / tool-result 1:1 配对），抛异常会破坏配对。
 *
 *   副作用：`@TracedAs` 只在「函数抛出」时才把 span 标 ERROR，所以这类失败
 *   的 span.status 一直是 `ok`（错误只藏在 result 属性里）。
 *   实测：事故 trace 里 3 个 / 1 个 Tool-not-found 的 executeTool span 全是 status=ok，
 *   于是 `roy-bot debug trace --list` 聚合出来的 status 全绿，
 *   问题静默存在数周，直到人工翻 25GB trace DB 才被发现。
 *
 * 修复：给 @Traced 增加 `errorIf(result)` 选项 —— 函数正常返回，但按返回值判定
 * 为失败时，span 以 ERROR 收尾（保持函数返回值不变，不破坏 tool-result 配对）。
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "bun:test";
import { wrapFunction } from "./decorator";
import { getTracerProvider, resetTracerProvider } from "./opentelemetry/tracer-provider";

/** 捕获 decorator 实际操作的 span，便于断言 end() 的入参 */
function captureSpans() {
  const spans: Array<{ name: string; setAttribute: any; end: any }> = [];
  const provider: any = getTracerProvider();
  const fakeTracer = {
    startSpan: (name: string) => {
      const span = {
        name,
        setAttribute: vi.fn(),
        end: vi.fn(),
      };
      spans.push(span);
      return span;
    },
  };
  vi.spyOn(provider, "getTracer").mockReturnValue(fakeTracer as any);
  return spans;
}

describe("@Traced errorIf — 返回值驱动的 ERROR 状态", () => {
  let spans: ReturnType<typeof captureSpans>;

  beforeEach(() => {
    resetTracerProvider();
    getTracerProvider();
    spans = captureSpans();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetTracerProvider();
  });

  const isToolNotFound = (r: any) =>
    r?.success === false && typeof r?.error === "string" && /^Tool (not found|disabled):/.test(r.error)
      ? new Error(r.error)
      : undefined;

  test("返回值为失败时 → span 以 ERROR 收尾（end 收到 Error）", async () => {
    const fn = async () => ({ success: false, output: "", error: "Tool not found: bash" });
    const wrapped = wrapFunction(fn, "executeTool", { recordResult: true, errorIf: isToolNotFound });

    const result = await wrapped();

    // 关键：函数返回值不变（tool-result 配对不受影响）
    expect(result).toEqual({ success: false, output: "", error: "Tool not found: bash" });

    expect(spans).toHaveLength(1);
    expect(spans[0].end).toHaveBeenCalledTimes(1);
    const [, err] = spans[0].end.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toBe("Tool not found: bash");
  });

  test("返回值为成功时 → span 仍为 OK（不误报）", async () => {
    const fn = async () => ({ success: true, output: "ok", error: undefined });
    const wrapped = wrapFunction(fn, "executeTool", { recordResult: true, errorIf: isToolNotFound });

    await wrapped();

    const [resultArg, errArg] = spans[0].end.mock.calls[0];
    expect(errArg).toBeUndefined();
    expect(resultArg).toEqual({ success: true, output: "ok", error: undefined });
  });

  test("工具自身的运行时失败（非 not found）不应标 ERROR，避免噪音淹没真问题", async () => {
    const fn = async () => ({ success: false, output: "", error: "command exited with code 1" });
    const wrapped = wrapFunction(fn, "executeTool", { recordResult: true, errorIf: isToolNotFound });

    await wrapped();

    const [, errArg] = spans[0].end.mock.calls[0];
    expect(errArg).toBeUndefined();
  });

  test("不传 errorIf 时行为完全不变（默认向后兼容）", async () => {
    const fn = async () => ({ success: false, error: "Tool not found: bash" });
    const wrapped = wrapFunction(fn, "executeTool", { recordResult: true });

    await wrapped();

    expect(spans[0].end).toHaveBeenCalledWith({ success: false, error: "Tool not found: bash" });
  });

  test("同步函数同样支持 errorIf", () => {
    const fn = () => ({ success: false, error: "Tool disabled: bash" });
    const wrapped = wrapFunction(fn, "executeTool", { recordResult: true, errorIf: isToolNotFound });

    wrapped();

    const [, errArg] = spans[0].end.mock.calls[0];
    expect(errArg).toBeInstanceOf(Error);
    expect(String(errArg.message)).toBe("Tool disabled: bash");
  });
});
