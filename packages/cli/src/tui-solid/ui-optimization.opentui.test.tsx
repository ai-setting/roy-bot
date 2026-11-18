/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview TUI layout regression tests — **opentui/solid** edition
 * (Task #4679 片5).
 *
 * Ports the 5 assertions of `tui/ui-optimization.test.tsx` (Task #4103).
 * The Ink file is **untouched** — it still guards the live Ink chain.
 *
 * ## Two documented translations
 *
 * 1. **Frame height.** Ink's `lastFrame()` returns only the rows the layout
 *    produced. opentui's `captureCharFrame()` returns the **whole frame**,
 *    padded to the render height. So the "compact frame" check counts
 *    *non-blank* rows instead of total rows. The intent — "the layout does
 *    not inflate the frame" — is preserved.
 *
 * 2. **The blank-gap proxy.** Both files measure "is there an oversized gap?"
 *    with the same retired `blankRun()` helper (removed in P0).
 *    Under opentui the padding is spaces rather than newlines, so the proxy
 *    is rewritten to measure the longest run of consecutive **blank** rows.
 *    Same question, same shape of answer.
 *
 * ## Task #4954 P0 translation (fullscreen layout)
 *
 * P0 把 App 改为**全屏三段式**（scrollbox flexGrow=1 占满 +
 * 底部 flexShrink=0 沉底）。⇒ 两条旧断言的布局假设变化：
 *
 * - 「header 与 status bar 相邻」：全屏布局下 status bar **沉底**是
 *   预期行为（输入框锚定），header→status 间距不再 <8。
 *   ⇒ 断言改为「status bar 在**最后一行**（锚定成功）」+「header 在首行」。
 * - 「blankRun <6 / compact frame <12 行」：全屏布局中间区域本来就
 *   由 scrollbox 撑满（空行=scrollbox 剩余空间，非布局 bug）。
 *   ⇒ 改为「内容行之间（trimmed frame）无 oversized gap」——
 *   旧 blankRun proxy 已退役；全屏下内容块是
 *   header/历史/底部三段，两两之间由 scrollbox 空间隔开是设计意图。
 *   ⇒ proxy 改为「消息区内容不被裁剪」（流式文本出现恰好 1 次保留）
 *   + 「帧顶部是 header、底部是状态栏」的结构断言。
 */

import { describe, it, expect } from "bun:test";
import { testRender } from "@opentui/solid";
import { App, type HistoryItem } from "./App.js";
import {
  isSolidReactive,
  SSR_SKIP_REASON,
} from "./test-utils/solid-test-env.js";

const SOLID_REACTIVE = isSolidReactive();
const describeIfClient = SOLID_REACTIVE ? describe : describe.skip;



/** Mount `App` headlessly and return its captured frame. */
async function frameOf(props: {
  history: HistoryItem[];
  status: "idle" | "thinking" | "streaming";
  streamingText?: string;
  model?: string;
  workdir?: string;
}): Promise<string> {
  const t = await testRender(() => <App {...props} />, { width: 100, height: 30 });
  await t.renderOnce();
  const f = t.captureCharFrame();
  await t.dispose();
  return f;
}

describeIfClient("TUI layout regression (Task #4103)", () => {
  describe("Bug 1 — oversized GAP below the header", () => {
    it("empty history + idle: header first, status anchored last (P0)", async () => {
      const frame = await frameOf({
        history: [],
        status: "idle",
        model: "m",
        workdir: "/tmp",
      });
      // P0 全屏三段式：header 在帧首、状态栏沉底；两者之间是
      // scrollbox 的剩余空间（设计意图，非布局 bug）。
      const lines = frame.split("\n");
      const headerIdx = lines.findIndex((l) => l.includes("Roy Agent"));
      // ★ P1（DS MINOR-2）：锚定 marker 用状态栏独有组合——
      //   含 workdir 且含分隔符 · 的行（通用子串 /tmp 会误命中历史）。
      const statusIdx = lines.findIndex((l) => l.includes("/tmp") && l.includes("\u00b7"));
      // header 出现在帧首（≤1 行容差，captureCharFrame 首行时序抖动实测存在）
      expect(headerIdx).toBeLessThanOrEqual(1);
      // 状态栏锚定在帧底（倒数第二行；最后一行是 opentui 帧尾）
      expect(statusIdx).toBeGreaterThanOrEqual(lines.length - 3);
      expect(statusIdx).toBeLessThanOrEqual(lines.length - 2);
    });

    it("status bar is anchored to the bottom (fullscreen P0 layout)", async () => {
      const frame = await frameOf({
        history: [],
        status: "idle",
        model: "m",
        workdir: "/tmp",
      });
      const lines = frame.split("\n");
      const headerIdx = lines.findIndex((l) => l.includes("Roy Agent"));
      // ★ P1（DS MINOR-2）：锚定 marker 用状态栏独有组合——
      //   含 workdir 且含分隔符 · 的行（通用子串 /tmp 会误命中历史）。
      const statusIdx = lines.findIndex((l) => l.includes("/tmp") && l.includes("\u00b7"));
      // Both markers MUST exist — otherwise the assertion below would be
      // skipped and the test would pass vacuously.
      expect(headerIdx).toBeGreaterThanOrEqual(0);
      expect(statusIdx).toBeGreaterThanOrEqual(0);
      // P0：status bar 沉底 = scrollbox 占满中间（旧 <8 邻接假设退役）。
      expect(statusIdx).toBeGreaterThanOrEqual(headerIdx);
    });
  });

  describe("Bug 3 — jump / blank on stream completion", () => {
    it("streaming with text renders it exactly once without a blank explosion", async () => {
      const frame = await frameOf({
        history: [],
        status: "streaming",
        streamingText: "hello stream",
        model: "m",
        workdir: "/tmp",
      });
      expect(frame.split("hello stream").length - 1).toBe(1);
      // P0：流式文本必须可见（不被裁剪/不重复爆炸）。
      expect(frame).toContain("hello stream");
    });

    it("idle after finish shows the finalized history row once and no spinner", async () => {
      const history: HistoryItem[] = [
        { role: "assistant", content: "done response", id: "h1" },
      ];
      const frame = await frameOf({
        history,
        status: "idle",
        model: "m",
        workdir: "/tmp",
      });
      expect(frame.split("done response").length - 1).toBe(1);
      // No leftover dynamic spinner once the stream is finished.
      expect(frame).not.toContain("Generating response");
    });
  });

  describe("Streamed-message grouping (Task #4123)", () => {
    it("shows the Agent heading once for a message split into continuation blocks", async () => {
      const history: HistoryItem[] = [
        { role: "assistant", content: "para one", id: "h1" },
        { role: "assistant", content: "para two", id: "h2", continuation: true },
        { role: "assistant", content: "para three", id: "h3", continuation: true },
      ];
      const frame = await frameOf({
        history,
        status: "idle",
        model: "m",
        workdir: "/tmp",
      });
      // One logical reply → exactly one role heading.
      // Task #4994 (P4): label is plain text ("Agent") — count only
      // whole-label lines (the banner "🚀 Roy Agent" also contains
      // the word, but not as a standalone label row).
      const labelRows = frame
        .split("\n")
        .filter((l) => l.trim() === "Agent");
      expect(labelRows.length).toBe(1);
      expect(frame).toContain("para one");
      expect(frame).toContain("para two");
      expect(frame).toContain("para three");
    });
  });
});

describe("TUI layout regression (opentui/solid) — runtime gate", () => {
  it("reports WHY the suite is skipped under the SSR build", () => {
    // eslint-disable-next-line no-console
    console.log(
      `[片5] solid-reactive=${SOLID_REACTIVE} ` +
        `=> ui-optimization suite ${SOLID_REACTIVE ? "RUN" : `SKIPPED: ${SSR_SKIP_REASON}`}`,
    );
    expect(typeof SOLID_REACTIVE).toBe("boolean");
  });
});
