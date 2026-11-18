/**
 * @fileoverview act.ts stdout no-duplicate tests
 *
 * Task #2833: [Bug] roy-bot act 命令重复输出 AI 回复（stdout emit 2 次）
 *
 * TDD RED — 锁定根因：act.ts 在 handleQueryWithContext 返回 result 后无条件
 * 调用 output.log(result)，与 StreamOutputService 通过 process.stdout.write
 * 流式输出的内容重复。
 *
 * 修复策略（GREEN）— 仅在 LLM 流没有发出任何文本（workflow agent 或
 * 零文本响应）时才补打印，否则直接跳过避免重复 emit。
 *
 * RED 覆盖：
 * 1. LLM 流已发出文本 → 不调用 output.log(result)
 * 2. LLM 流没有发出文本（workflow agent） → 调用 output.log(result)
 * 3. result 为空字符串 → 不调用 output.log
 * 4. think 块和正文不在 stdout 重复（mock StreamOutputService 验证 fullText 与 result 关系）
 */

import { describe, test, expect, vi } from "bun:test";
import { finalizeActStdout } from "./act-stdout-finalize";
import { StreamOutputService } from "../services/stream-output.service";

function makeStreamServiceWithFullText(text: string): StreamOutputService {
  // 直接 new StreamOutputService，然后 push 模拟的 llm.text delta 到 fullText
  const svc = new StreamOutputService();
  if (text.length > 0) {
    svc.handleEvent({
      id: "mock-1",
      type: "llm.text",
      timestamp: Date.now(),
      metadata: {},
      payload: { delta: text },
    });
  }
  return svc;
}

describe("act #2833: finalizeActStdout (no duplicate stdout)", () => {
  test("RED-1: LLM 流已发出文本 → 不调用 output.log(result)", () => {
    const output = { log: vi.fn() } as any;
    const streamService = makeStreamServiceWithFullText(
      "你好！我是 Roy 👋 有什么可以帮你的吗？"
    );

    finalizeActStdout({
      result: "你好！我是 Roy 👋 有什么可以帮你的吗？",
      streamService,
      output,
    });

    expect(output.log).not.toHaveBeenCalled();
  });

  test("RED-2: LLM 流没有发出文本（workflow agent）→ 调用 output.log(result)", () => {
    const output = { log: vi.fn() } as any;
    const streamService = makeStreamServiceWithFullText("");

    finalizeActStdout({
      result: "workflow agent final result",
      streamService,
      output,
    });

    expect(output.log).toHaveBeenCalledWith("workflow agent final result");
  });

  test("RED-3: result 为空 → 不调用 output.log", () => {
    const output = { log: vi.fn() } as any;
    const streamService = makeStreamServiceWithFullText("");

    finalizeActStdout({
      result: "",
      streamService,
      output,
    });

    expect(output.log).not.toHaveBeenCalled();
  });

  test("RED-4: think 块和正文不在 stdout 重复（混合验证）", () => {
    // 模拟 LLM 流：emit 一个混合 think + 正文 的流
    const output = { log: vi.fn() } as any;
    const streamService = new StreamOutputService();
    const fullStreamedText =
      "<think>The user said hi, respond directly</think>\n\n你好！我是 Roy 👋";
    streamService.handleEvent({
      id: "mock-1",
      type: "llm.text",
      timestamp: Date.now(),
      metadata: {},
      payload: { delta: fullStreamedText },
    });

    // act 返回的 result 与 streamService 累积的 fullText 完全一致
    finalizeActStdout({
      result: fullStreamedText,
      streamService,
      output,
    });

    // 关键断言：output.log 没有被调用 → 不会有第二次 emit
    expect(output.log).not.toHaveBeenCalled();
    // 同时验证 streamService 累积了完整的 think + 正文（用于 sanity check）
    expect(streamService.getFullText()).toBe(fullStreamedText);
  });
});