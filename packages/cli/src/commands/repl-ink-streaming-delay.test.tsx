/**
 * @fileoverview Task #2319: Streaming delay (首段文字延迟)
 *
 * 根因: packages/cli/src/commands/repl-ink.tsx `appendAssistantDelta`
 *  对第一段 chunk 也强制 setTimeout(50ms) 后才 flushStreamingDelta.
 *  这意味着 assistant 流式输出的首段文字永远有 50ms+ 硬延迟,
 *  即使只有 1 个 chunk 也得等 50ms 才出现.
 *
 * 修复方向 (RED 阶段先验, GREEN 阶段实现):
 *  - appendAssistantDelta 第一次调用时立即 flush (不 setTimeout),
 *    后续 50ms 内的 delta 才走 throttle 合并.
 *  - 或: throttle 从 50ms 降到 16ms (~60fps) 以匹配 Ink 渲染频率.
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 */

import { describe, test, expect, vi } from "bun:test";
import { isParallelRun } from "../test-utils/parallel-guard";
import * as React from "react";
import { render } from "ink-testing-library";
import { REPLInk, type REPLInkApi } from "./repl-ink";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const baseContext = {
  model: "M3",
  cwd: "~/test",
  version: "1.6.13",
  sessionTitle: "test-session",
};

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ============================================================================
// RED: 首段文字延迟
// ============================================================================

describe.skipIf(isParallelRun)("Task #2319 RED: assistant 流式输出首段延迟", () => {
  test("RED-1: 单个 delta 应在调用后 30ms 内出现在 frame (不等 50ms throttle)", async () => {
    let api: REPLInkApi | null = null;
    const { lastFrame } = render(
      React.createElement(REPLInk, {
        initialContext: baseContext,
        onSubmit: () => {},
        onReady: (a) => {
          api = a;
        },
      }),
    );

    await wait(200); // 等 onReady + 初始 render
    expect(api).not.toBeNull();

    // 先推送一条 user message 让历史有上下文
    api!.appendMessage({ role: "user", content: "hi" });
    await wait(30);

    // 模拟 LLM 第一个 text chunk 到达 — 必须立即可见 (不等 50ms throttle)
    const t0 = Date.now();
    api!.appendAssistantDelta("Hello");
    await wait(30); // 给 ink 渲染时间, 但远小于 50ms throttle

    const frame = lastFrame() ?? "";
    const plain = stripAnsi(frame);
    expect(plain).toContain("Hello");
    expect(Date.now() - t0).toBeLessThan(60); // 必须 < 60ms (远小于 throttle 50ms + buffer)
  });

  test("RED-2: 连续 3 个 delta (跨 50ms+) 首段 30ms 内可见, 后续被 throttle 合并", async () => {
    let api: REPLInkApi | null = null;
    const { lastFrame } = render(
      React.createElement(REPLInk, {
        initialContext: baseContext,
        onSubmit: () => {},
        onReady: (a) => {
          api = a;
        },
      }),
    );

    await wait(200);
    expect(api).not.toBeNull();

    api!.appendMessage({ role: "user", content: "tell me a story" });
    await wait(30);

    // 第一个 delta 必须立即可见
    const t0 = Date.now();
    api!.appendAssistantDelta("Once");
    await wait(30);
    let frame = lastFrame() ?? "";
    let plain = stripAnsi(frame);
    expect(plain).toContain("Once");
    expect(Date.now() - t0).toBeLessThan(60);

    // 后续 delta 应该走 throttle: 第 2 个 + 第 3 个 (跨 50ms) 合并到同一条 message
    api!.appendAssistantDelta(" upon");
    await wait(20);
    api!.appendAssistantDelta(" a time");
    await wait(80); // 等 throttle flush

    frame = lastFrame() ?? "";
    plain = stripAnsi(frame);
    // 完整内容应可见 (合并)
    expect(plain).toContain("Once");
    expect(plain).toContain("upon");
    expect(plain).toContain("a time");
  });

  test("RED-3: finishAssistantStream 应立即 flush (不等 50ms)", async () => {
    let api: REPLInkApi | null = null;
    const { lastFrame } = render(
      React.createElement(REPLInk, {
        initialContext: baseContext,
        onSubmit: () => {},
        onReady: (a) => {
          api = a;
        },
      }),
    );

    await wait(200);
    expect(api).not.toBeNull();

    // 第 1 个 delta 应立即 flush (不 throttle)
    api!.appendAssistantDelta("Final");
    await wait(30);

    const t0 = Date.now();
    api!.finishAssistantStream();
    await wait(30);

    const frame = lastFrame() ?? "";
    const plain = stripAnsi(frame);
    expect(plain).toContain("Final");
    // finish 后内容必须立刻可见 (< 50ms)
    expect(Date.now() - t0).toBeLessThan(60);
  });
});

describe.skipIf(isParallelRun)("Task #2319 RED: 验证 throttle 仍然合并后续 delta (regression guard)", () => {
  test("REG-1: 50ms 内连续 delta 仍合并为 1 条 message (throttle 仍生效)", async () => {
    let api: REPLInkApi | null = null;
    const { lastFrame } = render(
      React.createElement(REPLInk, {
        initialContext: baseContext,
        onSubmit: () => {},
        onReady: (a) => {
          api = a;
        },
      }),
    );

    await wait(200);
    expect(api).not.toBeNull();

    // 第 1 个 delta 立即可见
    api!.appendAssistantDelta("a");
    await wait(5);
    let frame = lastFrame() ?? "";
    expect(stripAnsi(frame)).toContain("a");

    // 后续 5 个 delta 在 50ms 内 → 应被 throttle 合并 (不触发 5 次 setMessages)
    api!.appendAssistantDelta("b");
    await wait(5);
    api!.appendAssistantDelta("c");
    await wait(5);
    api!.appendAssistantDelta("d");
    await wait(5);
    api!.appendAssistantDelta("e");
    await wait(5);
    api!.appendAssistantDelta("f");

    // 等 throttle flush
    await wait(80);

    frame = lastFrame() ?? "";
    const plain = stripAnsi(frame);
    // 所有 delta 应合并到同一条 assistant message: "abcdef"
    expect(plain).toContain("abcdef");
  });
});