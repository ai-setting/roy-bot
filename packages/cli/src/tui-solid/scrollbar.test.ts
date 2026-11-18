/**
 * @fileoverview Task #5077 P3 Phase 2 — **滚动条模块** 单测（TDD RED）。
 *
 * ## 测什么
 *
 * `scrollbar.ts` 的纯函数：
 *   1. `resolveScrollbarColors` —— opencode 同款 track 配色（暗 track + 亮前景）
 *   2. `resolveScrollbarPadding` —— 滑块与内容列之间的 1 列呼吸距
 *   3. `resolveViewportPaddingRight` —— 内容右缘给滚动条让位（1 列）
 *   4. `computeScrollbarVisible` —— 可滚动⇒显示、不可滚动⇒隐藏（对齐
 *      opentui `recalculateVisibility` 的语义，显式判定用于接线守卫）
 */

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_SCROLLBAR_FOREGROUND_COLOR,
  DEFAULT_SCROLLBAR_TRACK_BACKGROUND_COLOR,
  computeScrollbarVisible,
  resolveScrollbarPadding,
  resolveScrollbarColors,
  resolveViewportPaddingRight,
} from "./scrollbar.js";

describe("scrollbar.ts — 配色（对齐 opencode track 配色）", () => {
  it("默认前景色是中灰（opencode theme.border.base 量级）", () => {
    expect(DEFAULT_SCROLLBAR_FOREGROUND_COLOR).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it("默认 track 底色比前景色更暗（层次感）", () => {
    const fg = parseInt(DEFAULT_SCROLLBAR_FOREGROUND_COLOR.slice(1), 16);
    const bg = parseInt(DEFAULT_SCROLLBAR_TRACK_BACKGROUND_COLOR.slice(1), 16);
    expect(bg).toBeLessThan(fg);
  });

  it("resolveScrollbarColors 返回 trackOptions 结构", () => {
    const colors = resolveScrollbarColors();
    expect(colors).toHaveProperty("backgroundColor");
    expect(colors).toHaveProperty("foregroundColor");
    expect(colors.backgroundColor).toMatch(/^#/);
    expect(colors.foregroundColor).toMatch(/^#/);
  });

  it("显式传参时以调用方为准", () => {
    const colors = resolveScrollbarColors({ foregroundColor: "#ff0000", backgroundColor: "#0000ff" });
    expect(colors.foregroundColor).toBe("#ff0000");
    expect(colors.backgroundColor).toBe("#0000ff");
  });

  // Task #5086 P5 (DS r3 MAJOR-1): in NO_COLOR mode the theme token is
  // the EMPTY STRING. `??` would return it → opentui parseColor("")
  // paints the scrollbar magenta + logs "Invalid hex color" every frame.
  it("NO_COLOR 下不返回空串（否则 opentui 画品红）", () => {
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const colors = resolveScrollbarColors();
      expect(colors.backgroundColor).not.toBe("");
      expect(colors.foregroundColor).not.toBe("");
      // 必须仍是合法 hex（opentui 只吃 hex / 命名色）
      expect(colors.backgroundColor).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(colors.foregroundColor).toMatch(/^#[0-9a-fA-F]{6}$/);
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
    }
  });

  it("NO_COLOR 下显式传入空串也回落默认（不吃空串）", () => {
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const colors = resolveScrollbarColors({ backgroundColor: "", foregroundColor: "" });
      expect(colors.backgroundColor).not.toBe("");
      expect(colors.foregroundColor).not.toBe("");
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
    }
  });
});

describe("scrollbar.ts — 几何参数", () => {
  it("滑块左呼吸距默认 1 列（opencode 同款）", () => {
    expect(resolveScrollbarPadding()).toBe(1);
    expect(resolveScrollbarPadding(undefined)).toBe(1);
    expect(resolveScrollbarPadding(2)).toBe(2);
  });

  it("非法 padding 回落 1（负数/小数/NaN）", () => {
    expect(resolveScrollbarPadding(0)).toBe(1);
    expect(resolveScrollbarPadding(-1)).toBe(1);
    expect(resolveScrollbarPadding(1.5)).toBe(1);
    expect(resolveScrollbarPadding(Number.NaN)).toBe(1);
  });

  it("视口 paddingRight 默认与滑块呼吸距相等（1 列让位）", () => {
    expect(resolveViewportPaddingRight()).toBe(resolveScrollbarPadding());
    expect(resolveViewportPaddingRight(2)).toBe(2);
  });
});

describe("scrollbar.ts — 出现/隐藏判定", () => {
  it("可滚动（内容 > 视口）⇒ 显示", () => {
    expect(computeScrollbarVisible({ contentHeight: 100, viewportHeight: 10 })).toBe(true);
    expect(computeScrollbarVisible({ contentHeight: 11, viewportHeight: 10 })).toBe(true);
  });

  it("不可滚动（内容 <= 视口）⇒ 隐藏", () => {
    expect(computeScrollbarVisible({ contentHeight: 10, viewportHeight: 10 })).toBe(false);
    expect(computeScrollbarVisible({ contentHeight: 5, viewportHeight: 10 })).toBe(false);
  });

  it("退化输入（0/负数/NaN）⇒ 隐藏", () => {
    expect(computeScrollbarVisible({ contentHeight: 0, viewportHeight: 10 })).toBe(false);
    expect(computeScrollbarVisible({ contentHeight: 100, viewportHeight: 0 })).toBe(false);
    expect(computeScrollbarVisible({ contentHeight: Number.NaN, viewportHeight: 10 })).toBe(false);
    expect(computeScrollbarVisible({ contentHeight: 100, viewportHeight: Number.NaN })).toBe(false);
  });
});
