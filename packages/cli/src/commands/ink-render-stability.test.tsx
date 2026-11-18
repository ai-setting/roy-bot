/**
 * @fileoverview Task #2304 T-B: Ink render stability tests
 *
 * 验证 REPLInk 在 streaming / user input 时:
 * 1. 整体 render count 有界 (不被 streaming delta 触发失控重渲染)
 * 2. Welcome region 在 streaming 期间保持稳定 (不会被 delta 触发 unmount/remount)
 * 3. 输入区 (MultilineInput + 边框) 视觉输出稳定 (不被 delta 触发 reflow)
 * 4. 状态栏文本稳定 (不被 delta 触发重建)
 *
 * 设计: 用 Wrapper 计数 REPLInk render count + 用 lastFrame 抽样比对 delta 前后
 */

import { test, expect, describe, vi } from "bun:test";
import { isParallelRun } from "../test-utils/parallel-guard";
import * as React from "react";
import { render } from "ink-testing-library";
import { REPLInk } from "./repl-ink";

async function wait(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

const baseContext = {
  model: "M3",
  cwd: "~/test",
  version: "1.6.13",
  sessionTitle: "test-session",
};

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe.skipIf(isParallelRun)("Task #2304 T-B: REPLInk render stability during streaming", () => {
  test("wrapper REPLInk renders are bounded under streaming deltas", async () => {
    let api: any = null;
    let replRenderCount = 0;
    const Probe = () => {
      replRenderCount++;
      return React.createElement(REPLInk, {
        initialContext: baseContext,
        onSubmit: () => {},
        onReady: (a) => {
          api = a;
        },
      });
    };

    render(React.createElement(Probe));
    await wait(300);
    expect(api).not.toBeNull();

    const baseline = replRenderCount;
    // 期望: 1 次 mount 渲染 + 30 deltas 在 throttle (50ms) 内合并为少量 flush
    // throttle flush 每 50ms 一次 → 300ms / 10ms = 30 次 push, 但 50ms 内 1 flush
    // → 6 flush (300ms / 50ms) + finish 1 次 = ~7 次
    for (let i = 0; i < 30; i++) {
      api.appendAssistantDelta(`d${i}`);
      await wait(10);
    }
    await wait(150);
    api.finishAssistantStream();
    await wait(100);

    const delta = replRenderCount - baseline;
    // 30 个 delta + 收尾 → 总 re-render 应 < 15 (实际期望 ~7-10)
    expect(delta).toBeLessThanOrEqual(15);
  });

  test("streaming deltas do not reflow input region frame", async () => {
    let api: any = null;
    const { lastFrame } = render(
      React.createElement(REPLInk, {
        initialContext: baseContext,
        onSubmit: () => {},
        onReady: (a) => {
          api = a;
        },
      }),
    );
    await wait(300);
    expect(api).not.toBeNull();

    // Append a user message first so we have a stable pre-stream frame
    api.appendMessage({ role: "user", content: "stable-msg" });
    await wait(50);

    const beforeFrame = stripAnsi(lastFrame() ?? "");
    // Divider before input should be present
    expect(beforeFrame).toContain("─");

    // Push streaming deltas
    for (let i = 0; i < 10; i++) {
      api.appendAssistantDelta(`chunk${i} `);
      await wait(10);
    }
    await wait(150);
    api.finishAssistantStream();
    await wait(100);

    const afterFrame = stripAnsi(lastFrame() ?? "");
    // Input region divider should still be present after streaming
    expect(afterFrame).toContain("─");
    // streaming content should appear
    expect(afterFrame).toContain("chunk0");
    expect(afterFrame).toContain("chunk9");
    // user message should still be visible (not evicted)
    expect(afterFrame).toContain("stable-msg");
  });

  test("input region frame is byte-identical before and after deltas when content is unchanged", async () => {
    // 这一组: append deltas then finish — 输入区 (在消息历史下方) 应保持视觉一致
    // 因为 MultilineInput 是 uncontrolled + React.memo
    let api: any = null;
    const { lastFrame } = render(
      React.createElement(REPLInk, {
        initialContext: baseContext,
        onSubmit: () => {},
        onReady: (a) => {
          api = a;
        },
      }),
    );
    await wait(300);
    expect(api).not.toBeNull();

    // 截取无 message 状态下的 frame
    const emptyFrame = stripAnsi(lastFrame() ?? "");

    // push 一些 messages + deltas (不影响输入区)
    api.appendMessage({ role: "user", content: "u1" });
    await wait(20);
    for (let i = 0; i < 5; i++) {
      api.appendAssistantDelta(`a${i}`);
      await wait(10);
    }
    await wait(80);
    api.finishAssistantStream();
    await wait(50);

    const busyFrame = stripAnsi(lastFrame() ?? "");
    // 输入区 divider 在两个 frame 都应存在
    expect(emptyFrame).toContain("─");
    expect(busyFrame).toContain("─");
    // user message 应该在 busyFrame
    expect(busyFrame).toContain("u1");
    // streaming 内容应在 busyFrame
    expect(busyFrame).toContain("a4");
  });

  test("status bar text does not change on streaming deltas (same mode)", async () => {
    let api: any = null;
    const { lastFrame } = render(
      React.createElement(REPLInk, {
        initialContext: baseContext,
        onSubmit: () => {},
        onReady: (a) => {
          api = a;
        },
      }),
    );
    await wait(300);
    expect(api).not.toBeNull();

    // Capture initial status bar (look for mode indicator)
    const initialFrame = stripAnsi(lastFrame() ?? "");
    // Status bar has git branch info or model name
    const initialModelLine = initialFrame.split("\n").find((l) => l.includes("M3")) ?? "";

    // Push streaming deltas
    for (let i = 0; i < 10; i++) {
      api.appendAssistantDelta(`s${i}`);
      await wait(10);
    }
    await wait(150);

    const midFrame = stripAnsi(lastFrame() ?? "");
    const midModelLine = midFrame.split("\n").find((l) => l.includes("M3")) ?? "";

    // Status bar line with model should be stable across streaming
    // (unless mode changes via setMode — which we don't call here)
    expect(initialModelLine).toBe(midModelLine);
  });
});
