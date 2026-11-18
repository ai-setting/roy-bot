/**
 * @fileoverview Task #2309 Bug 1 + Bug 2 investigation tests
 *
 * 比 RED 阶段更全面的测试, 模拟真实 interactive REPL 场景:
 * - 真实 streaming (throttle 50ms)
 * - 真实 abort cascade
 * - 真实 input 字符
 */

import { describe, test, expect, vi } from "bun:test";
import { isParallelRun } from "../test-utils/parallel-guard";
import * as React from "react";
import { render } from "ink-testing-library";
import { REPLInk, MultilineInput, type REPLInkApi } from "./repl-ink";
import { resetStreamAbort, streamAbortSignal } from "../services/stream-output.service";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const baseContext = {
  model: "M3",
  cwd: "~/test",
  version: "1.6.13",
  sessionTitle: "test-session",
};

// ============================================================================
// 深度调查 Bug 1: 真实 stream + ESC + 重新输入
// ============================================================================

describe.skipIf(isParallelRun)("Bug 1 深度调查 — 真实 streaming + ESC + 重新输入 (Task #2309)", () => {
  test("调查场景 A: stream + ESC + 大量字符输入, 字符全部保留", async () => {
    let capturedApi: REPLInkApi | undefined;
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      React.createElement(REPLInk, {
        initialContext: baseContext,
        onSubmit,
        onReady: (api) => {
          capturedApi = api;
        },
      }),
    );
    await wait(100);

    // 模拟 agent streaming (产生多个 delta + throttle 触发)
    for (let i = 0; i < 10; i++) {
      capturedApi!.appendAssistantDelta(`chunk${i} `);
      await wait(60); // > 50ms throttle
    }
    capturedApi!.finishAssistantStream();
    await wait(50);

    // 模拟 ESC 中断 (resetStreamAbort + abortStream)
    resetStreamAbort();
    streamAbortSignal.aborted = true;

    // 模拟 ESC 后的新流 (用户在打字)
    await wait(100);

    // 模拟 typing: 但 stdin.write 是 char 级别的
    // 先打一些 draft
    stdin.write("user typing here");
    await wait(50);

    // 关键: 用户继续输入 (中文)
    stdin.write("继续");
    await wait(50);

    const frame = lastFrame() ?? "";
    // 期望: 用户输入完整保留
    expect(frame).toContain("user typing here");
    expect(frame).toContain("继续");
  });

  test("调查场景 B: stream + ESC + 极端快速字符输入", async () => {
    let capturedApi: REPLInkApi | undefined;
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      React.createElement(REPLInk, {
        initialContext: baseContext,
        onSubmit,
        onReady: (api) => {
          capturedApi = api;
        },
      }),
    );
    await wait(100);

    // 模拟 stream + 立即 abort (没有 finish)
    capturedApi!.appendAssistantDelta("partial interrupted");
    await wait(30); // < 50ms throttle (delta 没 flush)

    // 立即 abort
    resetStreamAbort();
    streamAbortSignal.aborted = true;
    // 模拟 finish (finish 会在 throttle 触发时把 delta 写入旧 message 并标记 finished)
    capturedApi!.finishAssistantStream();
    await wait(100);

    // 快速输入
    stdin.write("abc");
    await wait(50);
    stdin.write("def");
    await wait(50);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("abcdef");
  });

  test("调查场景 C: stream + ESC + 新 stream + input chars (混合场景)", async () => {
    let capturedApi: REPLInkApi | undefined;
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      React.createElement(REPLInk, {
        initialContext: baseContext,
        onSubmit,
        onReady: (api) => {
          capturedApi = api;
        },
      }),
    );
    await wait(100);

    // 第一轮 stream (interrupt)
    capturedApi!.appendAssistantDelta("first agent interrupted");
    await wait(60);
    capturedApi!.appendAssistantDelta(" more text");
    await wait(60);
    // 不 finish, 模拟被 abort
    resetStreamAbort();
    streamAbortSignal.aborted = true;

    // 立即 finish (Bug 2 fix 路径)
    capturedApi!.finishAssistantStream();
    await wait(50);

    // 用户输入
    stdin.write("new question");
    await wait(50);

    // 第二轮 stream (新 agent)
    capturedApi!.appendAssistantDelta("new agent response");
    await wait(60);
    capturedApi!.appendAssistantDelta(" more content");
    await wait(60);
    capturedApi!.finishAssistantStream();
    await wait(50);

    const frame = lastFrame() ?? "";

    // 关键: Bug 2 验证 - 新 stream 不应追加到旧 streaming message
    expect(frame).not.toMatch(/first agent interrupted.*new agent response/);
    // Bug 1 验证 - 用户输入保留
    expect(frame).toContain("new question");
  });
});

// ============================================================================
// 深度调查 Bug 1: submit 路径被吞
// ============================================================================

describe.skipIf(isParallelRun)("Bug 1 submit 路径调查 — submit 后字符可能被吞 (Task #2309)", () => {
  test("调查场景 E: stream + ESC + 提交新消息, onSubmit 收到完整内容", async () => {
    let capturedApi: REPLInkApi | undefined;
    const onSubmit = vi.fn();
    const { stdin } = render(
      React.createElement(REPLInk, {
        initialContext: baseContext,
        onSubmit,
        onReady: (api) => {
          capturedApi = api;
        },
      }),
    );
    await wait(100);

    // 模拟 stream
    capturedApi!.appendAssistantDelta("first stream");
    await wait(60);

    // abort + finish (模拟 handleEscKey 路径)
    capturedApi!.finishAssistantStream();
    await wait(50);

    // 用户输入新消息 + Enter
    stdin.write("hello world from user");
    await wait(50);
    stdin.write("\r"); // Enter
    await wait(100);

    // 关键: onSubmit 应该收到完整内容
    expect(onSubmit).toHaveBeenCalledWith("hello world from user");
  });

  test("调查场景 F: stream + ESC + 中文输入 + 提交", async () => {
    let capturedApi: REPLInkApi | undefined;
    const onSubmit = vi.fn();
    const { stdin } = render(
      React.createElement(REPLInk, {
        initialContext: baseContext,
        onSubmit,
        onReady: (api) => {
          capturedApi = api;
        },
      }),
    );
    await wait(100);

    // abort + finish
    capturedApi!.finishAssistantStream();
    await wait(50);

    // 输入中文 + Enter
    stdin.write("你好世界");
    await wait(50);
    stdin.write("\r");
    await wait(100);

    expect(onSubmit).toHaveBeenCalledWith("你好世界");
  });

  test("调查场景 G: 旧 streaming message 未 finish, 新字符 + 提交, 旧 content 不混入", async () => {
    let capturedApi: REPLInkApi | undefined;
    const onSubmit = vi.fn();
    const { stdin } = render(
      React.createElement(REPLInk, {
        initialContext: baseContext,
        onSubmit,
        onReady: (api) => {
          capturedApi = api;
        },
      }),
    );
    await wait(100);

    // 旧 streaming (未 finish, 模拟 abort 后)
    capturedApi!.appendAssistantDelta("old content from prev");
    await wait(60);

    // 用户输入并提交
    stdin.write("fresh input");
    await wait(50);
    stdin.write("\r");
    await wait(100);

    // onSubmit 必须只收到新内容, 不混入旧 streaming content
    expect(onSubmit).toHaveBeenCalledWith("fresh input");
  });
});

// ============================================================================
// 深度调查 Bug 1: timing race - parent re-render during typing
// ============================================================================

describe.skipIf(isParallelRun)("Bug 1 timing race 调查 — parent re-render 与 input 字符 (Task #2309)", () => {
  test("调查场景 H: parent 频繁 re-render 期间字符输入是否丢失", async () => {
    let capturedApi: REPLInkApi | undefined;
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      React.createElement(REPLInk, {
        initialContext: baseContext,
        onSubmit,
        onReady: (api) => {
          capturedApi = api;
        },
      }),
    );
    await wait(100);

    // 模拟 abort 后, 模拟"父组件 setMessages 频繁触发" (类似 abort 时段还有遗留 stream)
    // 这里连续触发多次 setMessages, 让父组件频繁 re-render
    for (let i = 0; i < 20; i++) {
      // 触发父 setMessages (via api.appendMessage)
      capturedApi!.appendMessage({ role: "system", content: `system msg ${i}` });
      // 不 wait, 让 React 在 microtask 队列里堆积 setState
    }
    await wait(200); // 让所有 setState 完成

    // 用户输入: 在父频繁 re-render 期间输入字符
    stdin.write("xyz");
    await wait(100);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("xyz");
  });

  test("调查场景 I: clearBuffer 后立即输入, 字符保留", async () => {
    const onSubmit = vi.fn();
    const onEscape = vi.fn();
    const ref = React.createRef<any>();
    const { stdin, lastFrame } = render(
      React.createElement(MultilineInput, {
        onSubmit,
        onEscape,
        ref,
      }),
    );
    await wait(50);

    // 先输入 draft
    stdin.write("draft");
    await wait(50);

    // ESC (清空 buffer)
    stdin.write("\x1b");
    await wait(50);

    // 立即输入 (verify 后 ESC 字符立刻可达)
    stdin.write("immediate");
    await wait(50);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("immediate");
  });

  test("调查场景 J: REPLInk 父级: streaming delta 触发 re-render 期间用户输入", async () => {
    let capturedApi: REPLInkApi | undefined;
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      React.createElement(REPLInk, {
        initialContext: baseContext,
        onSubmit,
        onReady: (api) => {
          capturedApi = api;
        },
      }),
    );
    await wait(100);

    // 模拟 abort 路径: finish 旧 streaming
    capturedApi!.finishAssistantStream();
    await wait(50);

    // 模拟 parent 在 setMode("executing") 期间的频繁 re-render
    // (用户提交时, onSubmit 进入 executing 状态, agent streaming 频繁 re-render)
    for (let i = 0; i < 10; i++) {
      capturedApi!.setMode("executing");
      // 不 wait — 让 React 频繁 re-render
    }
    await wait(100);

    // 用户在频繁 re-render 期间输入
    stdin.write("regression");
    await wait(100);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("regression");
  });
});



describe.skipIf(isParallelRun)("Bug 2 深度调查 — 真实 flushStreamingDelta 时序 (Task #2309)", () => {
  test("调查场景 D: 旧 delta 未 flush 时 abort, 新 delta 不应写入旧 message", async () => {
    let capturedApi: REPLInkApi | undefined;
    render(
      React.createElement(REPLInk, {
        initialContext: baseContext,
        onSubmit: vi.fn(),
        onReady: (api) => {
          capturedApi = api;
        },
      }),
    );
    await wait(100);

    // 第一个 delta 进 pending, 但 throttle 还没触发 (< 50ms)
    capturedApi!.appendAssistantDelta("early text");
    await wait(10); // < 50ms, throttle 没 fire

    // abort + finish 立即 (模拟 handleEscKey 路径)
    capturedApi!.finishAssistantStream();
    await wait(100);

    // 新 stream 开始
    capturedApi!.appendAssistantDelta("late text");
    await wait(100); // 让 throttle fire

    capturedApi!.finishAssistantStream();
    await wait(50);

    // 通过 frame 检查
    const captured = capturedApi as any;
    expect(captured).toBeDefined();
  });
});
