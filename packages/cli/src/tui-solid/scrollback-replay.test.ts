/**
 * @fileoverview Task #4721 G1 — **历史回放**（scrollback-replay）的单元测试。
 *
 * 本模块是**纯函数**（无 JSX / 无 Solid）⇒ 可以在任何 runner 下直接测，
 * 不受「bun test 下 Solid JSX 急求值」的限制（见
 * `test-utils/repaint-capability.ts` 的说明）。
 */

import { describe, expect, it } from "bun:test";
import {
  estimateHistoryRows,
  maxHistoryOffset,
  selectHistoryWindow,
} from "./scrollback-replay.js";
import type { HistoryItem } from "./App.js";

const msg = (id: string, content: string): HistoryItem => ({
  role: "assistant",
  content,
  id,
});

describe("Task #4721 G1 — scrollback-replay", () => {
  it("estimates a short message as a few rows", () => {
    expect(estimateHistoryRows(msg("a", "hello"), 80)).toBeGreaterThan(1);
  });

  it("estimates a long message as more rows than a short one", () => {
    const short = estimateHistoryRows(msg("a", "hi"), 40);
    const long = estimateHistoryRows(msg("b", "x".repeat(400)), 40);
    expect(long).toBeGreaterThan(short);
  });

  it("counts CJK as double width", () => {
    const cjk = estimateHistoryRows(msg("a", "中".repeat(100)), 40);
    const ascii = estimateHistoryRows(msg("b", "a".repeat(100)), 40);
    expect(cjk).toBeGreaterThan(ascii);
  });

  it("returns an empty window when the offset is zero", () => {
    const buffer = [msg("a", "one"), msg("b", "two")];
    expect(selectHistoryWindow(buffer, 0)).toEqual([]);
  });

  it("returns an empty window for an empty buffer", () => {
    expect(selectHistoryWindow([], 10)).toEqual([]);
  });

  it("selects the newest items when scrolling back", () => {
    const buffer = [msg("a", "one"), msg("b", "two"), msg("c", "three")];
    const window = selectHistoryWindow(buffer, 3);
    expect(window.length).toBeGreaterThan(0);
    // 窗口里的最后一项必须是**最新**那条。
    expect(window[window.length - 1]?.id).toBe("c");
  });

  it("selects more items for a larger offset", () => {
    const buffer = Array.from({ length: 10 }, (_, i) => msg(`m${i}`, `line ${i}`));
    const small = selectHistoryWindow(buffer, 3);
    const large = selectHistoryWindow(buffer, 30);
    expect(large.length).toBeGreaterThan(small.length);
  });

  it("never exceeds the buffer length", () => {
    const buffer = [msg("a", "one"), msg("b", "two")];
    expect(selectHistoryWindow(buffer, 1000).length).toBeLessThanOrEqual(buffer.length);
  });

  it("maxHistoryOffset grows with the buffer", () => {
    const one = maxHistoryOffset([msg("a", "hello")]);
    const two = maxHistoryOffset([msg("a", "hello"), msg("b", "world")]);
    expect(two).toBeGreaterThan(one);
  });

  it("maxHistoryOffset is 0 for an empty buffer", () => {
    expect(maxHistoryOffset([])).toBe(0);
  });
});
