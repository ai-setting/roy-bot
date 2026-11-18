/**
 * @fileoverview Task #4721 G1 — **滚轮序列拦截器**的单元测试。
 *
 * 本模块是**纯函数**（无 JSX / 无 Solid）⇒ 任何 runner 下都能测。
 */

import { describe, expect, it } from "bun:test";
import {
  createWheelInterceptor,
  parseWheelSequence,
  type WheelEvent,
} from "./wheel-interceptor.js";

describe("Task #4721 G1 — wheel-interceptor", () => {
  it("parses a wheel-up SGR sequence", () => {
    const ev = parseWheelSequence("\x1b[<64;10;25M");
    expect(ev).toEqual({ direction: "up", column: 10, row: 25 });
  });

  it("parses a wheel-down SGR sequence", () => {
    const ev = parseWheelSequence("\x1b[<65;10;25M");
    expect(ev?.direction).toBe("down");
  });

  it("parses the release form (lowercase m) too", () => {
    expect(parseWheelSequence("\x1b[<64;1;1m")?.direction).toBe("up");
  });

  it("returns null for a plain left click", () => {
    expect(parseWheelSequence("\x1b[<0;10;25M")).toBeNull();
  });

  it("returns null for a mouse-move sequence", () => {
    // motion 位 = 32 ⇒ 不是滚轮
    expect(parseWheelSequence("\x1b[<35;10;25M")).toBeNull();
  });

  it("returns null for non-mouse input", () => {
    expect(parseWheelSequence("hello")).toBeNull();
    expect(parseWheelSequence("\x1b[A")).toBeNull();
    expect(parseWheelSequence("")).toBeNull();
  });

  it("returns null for a malformed mouse sequence", () => {
    expect(parseWheelSequence("\x1b[<64;10M")).toBeNull();
    expect(parseWheelSequence("\x1b[<64;;25M")).toBeNull();
  });

  // -------------------------------------------------------------------
  // 拦截器
  // -------------------------------------------------------------------
  it("intercepts a wheel event inside the history area", () => {
    const seen: WheelEvent[] = [];
    const handler = createWheelInterceptor({
      isInHistoryArea: (row) => row <= 18,
      onHistoryWheel: (e) => seen.push(e),
    });
    expect(handler("\x1b[<64;10;5M")).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.direction).toBe("up");
  });

  it("does NOT intercept a wheel event outside the history area", () => {
    const seen: WheelEvent[] = [];
    const handler = createWheelInterceptor({
      isInHistoryArea: (row) => row <= 18,
      onHistoryWheel: (e) => seen.push(e),
    });
    // 动态区 ⇒ 交给 opentui 原生路径 ⇒ 必须返回 false（不抢）
    expect(handler("\x1b[<64;10;25M")).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it("does NOT intercept non-wheel input", () => {
    const seen: WheelEvent[] = [];
    const handler = createWheelInterceptor({
      isInHistoryArea: () => true,
      onHistoryWheel: (e) => seen.push(e),
    });
    expect(handler("\x1b[<0;10;5M")).toBe(false);   // 左键
    expect(handler("x")).toBe(false);               // 普通按键
    expect(seen).toHaveLength(0);
  });

  it("handles the boundary row exactly (row == boundary is history)", () => {
    const seen: WheelEvent[] = [];
    const handler = createWheelInterceptor({
      isInHistoryArea: (row) => row <= 18,
      onHistoryWheel: (e) => seen.push(e),
    });
    expect(handler("\x1b[<64;10;18M")).toBe(true);
    expect(handler("\x1b[<64;10;19M")).toBe(false);
    expect(seen).toHaveLength(1);
  });
});
