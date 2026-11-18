/**
 * @fileoverview Task #4396 end-to-end contract test: an assistant message
 * built by RunTui's history logic must render the cache/token footer through
 * <App>, using the exact `llm.completed` payload shape the core emits.
 *
 * This is the guard that ties the three layers together:
 *   1. core `LLMComponent.finalizeOutput()` → `llm.completed` with usage
 *      (covered by llm-completed-event.test.ts in packages/core)
 *   2. StreamOutputService → StreamChunkEvent.usage
 *      (covered by stream-output-usage-chunk.test.ts)
 *   3. interactive.ts createStreamHandleQuery → onUsage → HistoryItem.usage → <App>
 *      (this file)
 *
 * User requirement (飞书 p2p 2026-10-20):
 *   "在每个Agent消息的后面添加上这个cache和token信息已灰色颜色展示出来"
 */

import { describe, test, expect } from "bun:test";
import { isParallelRun } from "../test-utils/parallel-guard";
import { render } from "ink-testing-library";
import React from "react";
import { App, type HistoryItem } from "./App.js";

/** The exact shape core publishes on `llm.completed`. */
const CORE_USAGE = {
  promptTokens: 113,
  completionTokens: 2,
  totalTokens: 14835,
  cacheRead: 14720,
  cacheWrite: 0,
  promptTokensTotal: 14833,
};

describe.skipIf(isParallelRun)("App renders the assistant usage footer (Task #4396)", () => {
  test("renders cache hit rate and in/out tokens under the message", () => {
    const history: HistoryItem[] = [
      { role: "user", content: "hello", id: "u1" },
      { role: "assistant", content: "world", id: "a1" },
      { role: "usage", content: "", id: "u1f", usage: CORE_USAGE },
    ];
    const { lastFrame } = render(
      <App history={history} status="idle" model="deepseek-v4.1-flash" />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("world");
    // 14720 / 14833 = 99.24% → 99.2%
    expect(frame).toContain("99.2%");
    expect(frame).toContain("in 113");
    expect(frame).toContain("out 2");
  });

  test("text-separates the footer from the assistant body (own line)", () => {
    const history: HistoryItem[] = [
      { role: "assistant", content: "reply", id: "a1" },
      { role: "usage", content: "", id: "a1f", usage: CORE_USAGE },
    ];
    const { lastFrame } = render(<App history={history} status="idle" />);
    const lines = (lastFrame() ?? "").split("\n");
    const bodyIdx = lines.findIndex((l) => l.includes("reply"));
    const footerIdx = lines.findIndex((l) => l.includes("99.2%"));
    expect(bodyIdx).toBeGreaterThanOrEqual(0);
    expect(footerIdx).toBeGreaterThan(bodyIdx);
  });

  test("a footer appended after the assistant row is painted (Static append semantics)", () => {
    // Ink's <Static> never repaints a committed row, so the footer must be a
    // NEW item. This guards against regressing to patch-in-place.
    const base: HistoryItem[] = [
      { role: "assistant", content: "para one", id: "a1" },
    ];
    const { lastFrame, rerender } = render(<App history={base} status="idle" />);
    expect(lastFrame() ?? "").not.toContain("99.2%");

    rerender(
      <App
        history={[...base, { role: "usage", content: "", id: "a1f", usage: CORE_USAGE }]}
        status="idle"
      />,
    );
    expect(lastFrame() ?? "").toContain("99.2%");
  });

  test("renders no footer when the provider reported no usage", () => {
    const history: HistoryItem[] = [
      { role: "assistant", content: "plain reply", id: "a1" },
    ];
    const { lastFrame } = render(<App history={history} status="idle" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("plain reply");
    expect(frame).not.toContain("cache");
    expect(frame).not.toContain("NaN");
  });

  test("each assistant message carries its own footer", () => {
    const history: HistoryItem[] = [
      { role: "assistant", content: "first", id: "a1" },
      {
        role: "usage",
        content: "",
        id: "a1f",
        usage: { promptTokens: 10, completionTokens: 1, cacheRead: 1000, cacheWrite: 0, promptTokensTotal: 1010 },
      },
      { role: "assistant", content: "second", id: "a2" },
      {
        role: "usage",
        content: "",
        id: "a2f",
        usage: { promptTokens: 20, completionTokens: 2, cacheRead: 500, cacheWrite: 0, promptTokensTotal: 520 },
      },
    ];
    const { lastFrame } = render(<App history={history} status="idle" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("99.0%"); // 1000/1010
    expect(frame).toContain("96.2%"); // 500/520
  });
});
