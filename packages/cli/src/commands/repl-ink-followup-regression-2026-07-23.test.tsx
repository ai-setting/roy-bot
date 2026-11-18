/**
 * @fileoverview Task #2309 follow-up regressions for Task #2303's ESC fix
 *
 * Task #2303 (bug/fix-esc-cascade-multiline-regression-2026-07-22) 修复了
 * multiline input 模式下 ESC 不触发 cascade stop 的 race, 但引入了 2 个新回归:
 *
 * Bug 1 (Input 吞掉): ESC 中断 agent 后, 用户重新输入时字符被吞。
 *   例如输入 "你好呀" 只看到 "呀"。
 *   根因 (待 RED 阶段验证): MultilineInput.clearBuffer() 不完全重置内部状态,
 *   或者父 useInput 的 listener remove/re-add 间隙导致字符丢失。
 *
 * Bug 2 (Stream 输出追加到中断消息): ESC 中断 agent 后, 新 agent 输出 "接着"
 * 上次中断位置继续追加 (而不是开新消息)。
 *   根因 (待 RED 阶段验证): pendingDeltaRef / streamingIndexRef 在 abort 后
 * 未被重置, flushStreamingDelta 仍然找到旧的 streaming message, 把新 delta
 * 追加到旧 message 后面。
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 */

import { describe, test, expect, vi } from "bun:test";
import { isParallelRun } from "../test-utils/parallel-guard";
import * as React from "react";
import { render } from "ink-testing-library";
import { REPLInk, MultilineInput, type MultilineInputRef, type REPLInkApi } from "./repl-ink";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const baseContext = {
  model: "M3",
  cwd: "~/test",
  version: "1.6.13",
  sessionTitle: "test-session",
};

// ============================================================================
// Bug 1: Input 吞掉 (RED → GREEN)
// ============================================================================

describe.skipIf(isParallelRun)("Bug 1 RED — ESC 中断后输入字符不应被吞 (Task #2309)", () => {
  test("RED 场景 1: ESC 后输入完整 ASCII 字符串必须全部保留", async () => {
    const onSubmit = vi.fn();
    const onEscape = vi.fn();
    const { stdin, lastFrame } = render(
      React.createElement(MultilineInput, {
        onSubmit,
        onEscape,
      }),
    );
    await wait(50);

    // 先输入一些文字
    stdin.write("draft");
    await wait(50);

    // ESC 中断
    stdin.write("\x1b");
    await wait(50);

    // 重新输入完整字符串
    stdin.write("hello world");
    await wait(50);

    const frame = lastFrame() ?? "";
    // 关键: 完整字符串必须保留
    expect(frame).toContain("hello world");
  });

  test("RED 场景 2: ESC 后输入多字节字符 (UTF-8 中文) 全部保留", async () => {
    const onSubmit = vi.fn();
    const onEscape = vi.fn();
    const { stdin, lastFrame } = render(
      React.createElement(MultilineInput, {
        onSubmit,
        onEscape,
      }),
    );
    await wait(50);

    // ESC 中断 (无前置 draft)
    stdin.write("\x1b");
    await wait(50);

    // 输入 3 个中文字符 (每个 3 字节 UTF-8)
    stdin.write("你好呀");
    await wait(50);

    const frame = lastFrame() ?? "";
    // 所有 3 个字符都必须保留
    expect(frame).toContain("你");
    expect(frame).toContain("好");
    expect(frame).toContain("呀");
    // 更严格的断言: 完整字符串
    expect(frame).toContain("你好呀");
  });

  test("RED 场景 3: clearBuffer() 后输入必须完整保留, 不残留旧内容", async () => {
    const onSubmit = vi.fn();
    const onEscape = vi.fn();
    const ref = React.createRef<MultilineInputRef>();
    const { stdin, lastFrame } = render(
      React.createElement(MultilineInput, {
        onSubmit,
        onEscape,
        ref,
      }),
    );
    await wait(50);

    // 输入 draft
    stdin.write("draft text to clear");
    await wait(50);

    // 显式 clearBuffer
    ref.current?.clearBuffer();
    await wait(50);

    // 重新输入
    stdin.write("fresh input after clear");
    await wait(50);

    const frame = lastFrame() ?? "";
    // 不应包含 "draft text to clear"
    expect(frame).not.toContain("draft text to clear");
    // 应包含完整 "fresh input after clear"
    expect(frame).toContain("fresh input after clear");
  });

  test("RED 场景 4: 在 REPLInk 完整路径上模拟 ESC 中断 + 重新输入", async () => {
    // 接近真实用户场景:
    // 1. 启动 REPLInk
    // 2. 输入消息 + Enter (触发 onSubmit)
    // 3. ESC 中断
    // 4. 重新输入 (验证字符不丢)
    const onSubmit = vi.fn();
    const onEscape = vi.fn();
    const { stdin, lastFrame } = render(
      React.createElement(REPLInk, {
        initialContext: baseContext,
        onSubmit,
        onEscape,
      }),
    );
    await wait(50);

    // 输入消息
    stdin.write("first message");
    await wait(50);
    // 提交
    stdin.write("\r");
    await wait(50);

    // 模拟 ESC 中断
    stdin.write("\x1b");
    await wait(100);

    // 重新输入
    stdin.write("second message after esc");
    await wait(50);

    const frame = lastFrame() ?? "";
    // 关键: 第二次输入的字符必须全部保留
    expect(frame).toContain("second message after esc");
  });
});

// ============================================================================
// Bug 2: Stream 输出追加到中断消息 (RED → GREEN)
// ============================================================================

describe.skipIf(isParallelRun)("Bug 2 RED — ESC 中断后新 agent 输出应开新消息 (Task #2309)", () => {
  test("RED 场景 1: 旧 streaming message 显式 finish 后, 新 delta 必须开新 message", async () => {
    // 模拟真实 abort 路径:
    // 1. 旧 stream 活跃 (appendAssistantDelta)
    // 2. abort → finishAssistantStream 标记旧为 finished (handleEscKey 调)
    // 3. 用户重新提交, 新 agent 开始
    // 4. appendAssistantDelta 新 delta
    // 期望: 新 delta 创建新 message, 不追加到旧 message
    let capturedApi: REPLInkApi | undefined;
    const { lastFrame } = render(
      React.createElement(REPLInk, {
        initialContext: baseContext,
        onSubmit: vi.fn(),
        onReady: (api) => {
          capturedApi = api;
        },
      }),
    );
    await wait(100);

    expect(capturedApi).toBeDefined();

    // 旧 stream
    capturedApi!.appendAssistantDelta("interrupted partial text");
    await wait(100); // 等 throttle flush (50ms)

    // 模拟 abort: 显式 finish 旧 stream (handleEscKey 路径)
    capturedApi!.finishAssistantStream();
    await wait(50);

    // 新 agent 开始 (模拟用户提交新 query 后 LLM 重新开始)
    capturedApi!.appendAssistantDelta("new stream chunk 1");
    await wait(100);
    capturedApi!.appendAssistantDelta(" new stream chunk 2");
    await wait(100);

    capturedApi!.finishAssistantStream();
    await wait(50);

    const frame = lastFrame() ?? "";
    // 关键: 不应出现 "interrupted partial textnew stream chunk" (无空格分隔, 说明追加到旧消息)
    expect(frame).not.toMatch(/interrupted partial textnew stream chunk/);
  });

  test("RED 场景 2: 多次 append + finish 循环, 每次都开新 message", async () => {
    let capturedApi: REPLInkApi | undefined;
    const { lastFrame } = render(
      React.createElement(REPLInk, {
        initialContext: baseContext,
        onSubmit: vi.fn(),
        onReady: (api) => {
          capturedApi = api;
        },
      }),
    );
    await wait(100);

    // 模拟 3 轮 stream (每轮 append + finish)
    for (let i = 1; i <= 3; i++) {
      capturedApi!.appendAssistantDelta(`stream ${i} content`);
      await wait(100);
      capturedApi!.finishAssistantStream();
      await wait(50);
    }

    const frame = lastFrame() ?? "";
    // 关键: 不应出现 "stream 1 contentstream 2 content" 这种粘连
    expect(frame).not.toMatch(/stream 1 contentstream 2 content/);
  });

  test("RED 场景 3: stale stream 防御 — 长间隔 (>1s) 没新 chunk, 后续 delta 开新 message", async () => {
    // Task #2309 防御性 fix: 即便 handleEscKey 路径忘了调 finishAssistantStream,
    // REPLInk 也应该能检测 stale streaming message (距离上次 chunk > 1s) 并开新 message.
    //
    // 这个测试验证 stale stream 防御机制.
    let capturedApi: REPLInkApi | undefined;
    const { lastFrame } = render(
      React.createElement(REPLInk, {
        initialContext: baseContext,
        onSubmit: vi.fn(),
        onReady: (api) => {
          capturedApi = api;
        },
      }),
    );
    await wait(100);

    expect(capturedApi).toBeDefined();

    // 旧 stream
    capturedApi!.appendAssistantDelta("old interrupted text");
    await wait(100); // throttle flush

    // 模拟长间隔 (用户重新输入 + 提交 + LLM 启动)
    // 真实场景: 用户按 ESC 后, abortStream + finish + cascadeStop (~1-5s) + 用户打字 + 提交 + LLM 启动
    // 这里用 1100ms 模拟足够长 (跨过 STALE_STREAM_THRESHOLD_MS = 1000ms)
    await wait(1100);

    // 新 agent 开始 (没有显式 finishAssistantStream, 模拟 abort 漏掉的场景)
    capturedApi!.appendAssistantDelta("fresh new text");
    await wait(100);
    capturedApi!.finishAssistantStream();
    await wait(50);

    const frame = lastFrame() ?? "";
    // 关键: 长间隔后, 新 delta 应开新 message, 不应追加到旧 message
    expect(frame).not.toMatch(/old interrupted textfresh new text/);
  });
});
