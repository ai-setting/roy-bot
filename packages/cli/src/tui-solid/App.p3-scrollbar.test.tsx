/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview Task #5077 P3 Phase 2 — **App 滚动条** 集成测试（TDD RED）。
 *
 * ## 测什么
 *
 * App.tsx 的 `<scrollbox>` 接上滚动条后（`verticalScrollbarOptions`）：
 *   1. **可滚动内容 ⇒ 滚动条出现在最右列**（半块字形 `▀`/`▄`，
 *      位置随 scrollTop 移动 —— 实测事实，见 scrollbar.ts 文件头）
 *   2. **不可滚动内容 ⇒ 无滚动条字形**（opentui 原生隐藏）
 *   3. **键位跳底/跳顶后滚动条位置移动**（滚动条跟随真实滚动状态）
 *
 * ## 断言方式
 *
 * `testRender` + `captureCharFrame()` —— 帧级断言：
 *   - 可滚动时最右列（width-1）**存在** `▀` 或 `▄` 字形
 *   - 不可滚动时最右列**全是空格**
 */

import { describe, expect, it } from "bun:test";
import { testRender } from "@opentui/solid";
import { ScrollBoxRenderable } from "@opentui/core";
import { App, type HistoryItem } from "./App.js";
import { isSolidReactive } from "./test-utils/solid-test-env.js";

const SOLID_REACTIVE = isSolidReactive();
const describeIfClient = SOLID_REACTIVE ? describe : describe.skip;

/** 造 N 行历史。 */
function rows(count: number): HistoryItem[] {
  return Array.from({ length: count }, (_, i) => ({
    role: "assistant" as const,
    content: `row-${String(i).padStart(3, "0")}`,
  }));
}

interface Mounted {
  t: Awaited<ReturnType<typeof testRender>>;
  scrollbox: ScrollBoxRenderable;
  dispose: () => Promise<void>;
}

async function mountApp(
  history: HistoryItem[],
  size: { width: number; height: number } = { width: 60, height: 14 },
): Promise<Mounted> {
  let scrollbox: ScrollBoxRenderable | undefined;
  const t = await testRender(
    () => (
      <App history={history} status="idle" onScrollboxRef={(n: ScrollBoxRenderable) => (scrollbox = n)} />
    ),
    size,
  );
  await t.renderOnce();
  return { t, scrollbox: scrollbox!, dispose: () => t.dispose() };
}

/** 最右列的滚动条字形（半块 ▀/▄ —— banner 圆角框 ╮│╯ 不是滑块）。 */
function scrollbarGlyphs(t: Awaited<ReturnType<typeof testRender>>): Array<{ row: number; ch: string }> {
  const frame = t.captureCharFrame();
  const lines = frame.split("\n");
  const col = (lines[0]?.length ?? 1) - 1;
  const out: Array<{ row: number; ch: string }> = [];
  lines.forEach((line: string, row: number) => {
    const ch = line[col] ?? " ";
    if (ch === "▀" || ch === "▄") out.push({ row, ch });
  });
  return out;
}

/** 滑块颜色（走 App 的 onScrollboxRef 拿实例读 renderable 状态）。 */
function sliderColors(scrollbox: ScrollBoxRenderable): { bg: string; fg: string } {
  const slider = (scrollbox.verticalScrollBar as unknown as { slider: { backgroundColor: { r: number; g: number; b: number }; foregroundColor: { r: number; g: number; b: number } } }).slider;
  const hex = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return {
    bg: `#${hex(slider.backgroundColor.r)}${hex(slider.backgroundColor.g)}${hex(slider.backgroundColor.b)}`,
    fg: `#${hex(slider.foregroundColor.r)}${hex(slider.foregroundColor.g)}${hex(slider.foregroundColor.b)}`,
  };
}

describeIfClient("App.p3-scrollbar — 滚动条出现/隐藏（帧级）", () => {
  it("内容超过一屏 ⇒ 最右列出现滚动条字形（▀/▄）", async () => {
    const m = await mountApp(rows(40));
    try {
      const glyphs = scrollbarGlyphs(m.t);
      expect(glyphs.length).toBeGreaterThan(0);
      // 滑块只画半块字形（上半块/下半块），不是全块 █
      expect(glyphs.every((g) => g.ch === "▀" || g.ch === "▄")).toBe(true);
    } finally {
      await m.dispose();
    }
  });

  it("内容不足一屏 ⇒ 最右列无滚动条字形（原生隐藏）", async () => {
    const m = await mountApp(rows(3));
    try {
      // banner 圆角框（╮│╯）会占最右列，但**不是**滚动条字形
      expect(scrollbarGlyphs(m.t)).toEqual([]);
    } finally {
      await m.dispose();
    }
  });

  it("滚动条跟随滚动状态：跳顶后滑块移到首行附近", async () => {
    const m = await mountApp(rows(40));
    try {
      // 跳顶（scrollBy 到 0）
      m.scrollbox.scrollBy(-Number.MAX_SAFE_INTEGER, "content");
      await m.t.renderOnce();
      expect(m.scrollbox.scrollTop).toBe(0);
      const glyphs = scrollbarGlyphs(m.t);
      expect(glyphs.length).toBeGreaterThan(0);
      // 滑块头应在首行（或次行，视 native 绘制留边）
      expect(glyphs[0].row).toBeLessThanOrEqual(1);
    } finally {
      await m.dispose();
    }
  });

  it("★接线承重：滑块配色 = token（backgroundElement 底 / borderActive 前景，Task #5086 P5）", async () => {
    const m = await mountApp(rows(40));
    try {
      // P5 token 化前：#1a1a1a / #666666 硬编码；P5 后：App 注入 token
      // （dark: backgroundElement=#1e1e1e / borderActive=#606060）。
      // 断言实际帧里的 RGBA，确认走的是 token 而非 opentui 裸默认
      // （裸默认 bg=(37,37,39)/fg=(154,158,163)）。
      const colors = sliderColors(m.scrollbox);
      expect(colors.bg).toBe("#1e1e1e");
      expect(colors.fg).toBe("#606060");
    } finally {
      await m.dispose();
    }
  });

  it("★接线承重：滚动条容器左移 1 列（paddingLeft:1 → x=width-2）", async () => {
    const m = await mountApp(rows(40), { width: 60, height: 14 });
    try {
      // 裸 scrollbox 的容器 x = width-1（59）；
      // 接了 paddingLeft:1 才是 58（滑块仍在最右列 59）。
      const bar = m.scrollbox.verticalScrollBar as unknown as { x: number; slider: { x: number } };
      expect(bar.x).toBe(58);
      expect(bar.slider.x).toBe(59);
    } finally {
      await m.dispose();
    }
  });
});
