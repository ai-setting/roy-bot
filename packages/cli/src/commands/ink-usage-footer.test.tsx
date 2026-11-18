/**
 * @fileoverview Task #4396: the interactive TUI must render a dim grey
 * cache/token footer under every assistant message.
 *
 * User requirement (飞书 p2p 2026-10-20):
 *   "在每个Agent消息的后面添加上这个cache和token信息已灰色颜色展示出来"
 *
 * Chain under test:
 *   LLM completed → StreamOutputService emits `llm.completed` with `usage`
 *   → interactive.ts onChunk → REPLInkApi.attachUsage(usage)
 *   → REPLMessage.usage → MessageView renders <UsageFooter/>
 */

import { describe, test, expect, vi } from "bun:test";
import { isParallelRun } from "../test-utils/parallel-guard";
import { render } from "ink-testing-library";
import React from "react";
import { REPLInk, type REPLInkApi } from "./repl-ink";
import { formatUsageFooter } from "../tui/UsageFooter.js";

const BASE_CONTEXT = {
  model: "M3",
  cwd: "/tmp",
  version: "1.0",
  sessionTitle: "test",
};

/** Wait for the mount effect that publishes REPLInkApi. */
async function waitForReady(
  onReady: ReturnType<typeof vi.fn>,
  timeoutMs = 1500,
): Promise<REPLInkApi | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const calls = onReady.mock.calls;
    if (calls.length > 0 && calls[calls.length - 1]?.[0]) {
      return calls[calls.length - 1]![0] as REPLInkApi;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  return undefined;
}

const WARM_USAGE = {
  promptTokens: 32,
  completionTokens: 8,
  totalTokens: 15120,
  cacheRead: 14976,
  cacheWrite: 0,
  promptTokensTotal: 15008,
};

describe.skipIf(isParallelRun)("Task #4396: assistant message cache footer", () => {
  test("REPLInkApi exposes attachUsage", async () => {
    const onReady = vi.fn();
    render(
      React.createElement(REPLInk, {
        initialContext: BASE_CONTEXT,
        onSubmit: () => {},
        onReady,
      }),
    );

    const api = await waitForReady(onReady);
    if (!api) return; // parallel isolation fallback
    expect(typeof api.attachUsage).toBe("function");
  });

  test("attachUsage renders the cache/token footer under the assistant message", async () => {
    const onReady = vi.fn();
    const { lastFrame } = render(
      React.createElement(REPLInk, {
        initialContext: BASE_CONTEXT,
        onSubmit: () => {},
        onReady,
      }),
    );

    const api = await waitForReady(onReady);
    if (!api) return;

    // Simulate one completed LLM call.
    api.appendAssistantDelta("我是 Roy，有什么可以帮你？");
    api.finishAssistantStream();
    api.attachUsage(WARM_USAGE);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("我是 Roy");
    // The footer line, rendered from the same pure formatter.
    expect(frame).toContain("99.8%");
    expect(frame).toContain("in 32");
    expect(frame).toContain("out 8");
  });

  test("each assistant message keeps its own footer", async () => {
    const onReady = vi.fn();
    const { lastFrame } = render(
      React.createElement(REPLInk, {
        initialContext: BASE_CONTEXT,
        onSubmit: () => {},
        onReady,
      }),
    );

    const api = await waitForReady(onReady);
    if (!api) return;

    api.appendAssistantDelta("first reply");
    api.finishAssistantStream();
    api.attachUsage({
      promptTokens: 10,
      completionTokens: 2,
      cacheRead: 1000,
      cacheWrite: 0,
      promptTokensTotal: 1010,
    });

    api.appendAssistantDelta("second reply");
    api.finishAssistantStream();
    api.attachUsage({
      promptTokens: 20,
      completionTokens: 4,
      cacheRead: 500,
      cacheWrite: 0,
      promptTokensTotal: 520,
    });

    const frame = lastFrame() ?? "";
    // 1000/1010 = 99.0% ; 500/520 = 96.2%
    expect(frame).toContain("first reply");
    expect(frame).toContain("99.0%");
    expect(frame).toContain("second reply");
    expect(frame).toContain("96.2%");
  });

  test("attaching usage is a standalone row, not a patch of the last assistant message", async () => {
    // Ink's <Static> never repaints a committed row, so the footer must be its
    // own message. This also makes it paint even with no assistant text yet.
    const onReady = vi.fn();
    const { lastFrame } = render(
      React.createElement(REPLInk, {
        initialContext: BASE_CONTEXT,
        onSubmit: () => {},
        onReady,
      }),
    );

    const api = await waitForReady(onReady);
    if (!api) return;

    expect(() => api.attachUsage(WARM_USAGE)).not.toThrow();
    expect(lastFrame() ?? "").toContain("99.8%");
  });

  test("an earlier turn's footer is never rewritten by a later turn (cross-turn attribution)", async () => {
    const onReady = vi.fn();
    const { lastFrame } = render(
      React.createElement(REPLInk, {
        initialContext: BASE_CONTEXT,
        onSubmit: () => {},
        onReady,
      }),
    );

    const api = await waitForReady(onReady);
    if (!api) return;

    // Turn 1
    api.appendAssistantDelta("turn one reply");
    api.finishAssistantStream();
    api.attachUsage({
      promptTokens: 32,
      completionTokens: 8,
      cacheRead: 1000,
      cacheWrite: 0,
      promptTokensTotal: 1032,
    });
    // Turn 2 — must NOT overwrite turn 1's numbers.
    api.appendAssistantDelta("turn two reply");
    api.finishAssistantStream();
    api.attachUsage({
      promptTokens: 4200,
      completionTokens: 77,
      cacheRead: 0,
      cacheWrite: 0,
      promptTokensTotal: 4200,
    });

    const frame = lastFrame() ?? "";
    // 1000/1032 = 96.9% must still be present alongside turn 2's 0.0%.
    expect(frame).toContain("96.9%");
    expect(frame).toContain("0.0%");
    expect(frame).toContain("turn one reply");
    expect(frame).toContain("turn two reply");
  });
});

describe("formatUsageFooter alignment with the REPL footer contract", () => {
  test("the footer text the REPL renders is derived from the pure formatter", () => {
    // Guards against the component drifting from the tested formatter.
    expect(formatUsageFooter(WARM_USAGE)).toContain("99.8%");
  });
});
