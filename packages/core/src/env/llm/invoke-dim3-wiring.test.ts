/**
 * @fileoverview Dim 3 production wire test (Task #2760)
 *
 * Background (claude review #2759):
 * - Helper `convertToSDKMessages` accepts `{ sessionId, provider }` options
 *   and forwards them to the OpenAI-Compatible prompt_cache_key builder.
 * - Unit tests in `llm-cache-options.test.ts` (T1.1/1.2/1.3) only test the
 *   helper in isolation, not the production call site.
 * - The two production call sites in `invoke.ts:1002` and `invoke.ts:1343`
 *   (for `invoke` and `invokeNonStream` respectively) do NOT pass
 *   `{ sessionId, provider }`. So the helper is effectively dead code in
 *   production, and the 99% hit ratio we observed in V5 (#2758) came from
 *   DeepSeek's implicit prefix caching, not from our explicit
 *   `prompt_cache_key`.
 *
 * This file provides 2 RED tests that exercise the FULL production path:
 *  1. Stream path (`invoke`) — confirm `streamText` is called with messages
 *     whose system part carries `providerOptions.openai.promptCacheKey`.
 *  2. Non-stream path (`invokeNonStream`) — same, but via `generateText`.
 *
 * These tests will fail on the current code base (no wiring) and pass
 * after the 4-line fix in `invoke.ts:1002` + `invoke.ts:1343`.
 */

import { vi, describe, test, expect, beforeEach, afterEach } from "bun:test";

const isParallelRun = "BUN_TEST_WORKER_ID" in process.env;

import { invoke, invokeNonStream } from "./invoke";
import type { InvokeConfig, InvokeOptions } from "./invoke";
import * as aiModule from "ai";

// Spy on streamText + generateText — same pattern as invoke.test.ts
const streamTextSpy = vi.spyOn(aiModule, "streamText");
const generateTextSpy = vi.spyOn(aiModule, "generateText");

// Helper: extract the messages arg that invoke / invokeNonStream pass to
// streamText / generateText respectively. streamText is called with a
// single options object; the field is `messages`.
function getMessagesArgFromStreamText(callIdx = 0): unknown[] {
  const spy = streamTextSpy.mock as unknown as { calls: Array<[Record<string, unknown>]> };
  const call = spy.calls[callIdx];
  if (!call) throw new Error(`streamText call ${callIdx} not found`);
  return (call[0].messages as unknown[]) ?? [];
}

function getMessagesArgFromGenerateText(callIdx = 0): unknown[] {
  const spy = generateTextSpy.mock as unknown as { calls: Array<[Record<string, unknown>]> };
  const call = spy.calls[callIdx];
  if (!call) throw new Error(`generateText call ${callIdx} not found`);
  return (call[0].messages as unknown[]) ?? [];
}

describe.skipIf(isParallelRun)("Dim 3 production wire — invoke() passes sessionId + provider to convertToSDKMessages", () => {
  beforeEach(() => {
    streamTextSpy.mockReset();
    generateTextSpy.mockReset();
  });

  afterEach(() => {
    streamTextSpy.mockReset();
    generateTextSpy.mockReset();
  });

  test("D3.stream: invoke() with openai-compatible/minimax-m3 + sessionId ⇒ streamText sees promptCacheKey on system message", async () => {
    async function* emptyStream() {
      // No text-delta needed — we just want to inspect the call args
    }
    (streamTextSpy as ReturnType<typeof vi.fn>).mockResolvedValue({
      fullStream: emptyStream(),
    });

    const config: InvokeConfig = {
      model: "openai-compatible/minimax-m3",
      apiKey: "sk-test",
      baseURL: "https://api.minimax.chat/v1",
    };

    const options: InvokeOptions = {
      messages: [
        { role: "system", content: "you are helpful" },
        { role: "user", content: "hello" },
      ],
      context: {
        sessionId: "sess_dim3_stream_001",
        messageId: "msg_001",
      },
    };

    await invoke(config, options, { abort: undefined });

    const messages = getMessagesArgFromStreamText(0);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    const sysMsg = messages.find((m) => (m as { role?: string }).role === "system") as
      | { providerOptions?: Record<string, unknown> }
      | undefined;
    expect(sysMsg).toBeDefined();
    // This is the RED assertion: prompt_cache_key must reach the SDKMessages
    // (i.e. be present on the system message's providerOptions.openai).
    expect(
      (sysMsg!.providerOptions?.openai as { promptCacheKey?: string } | undefined)?.promptCacheKey
    ).toBe("sess_dim3_stream_001");
  });

  test("D3.stream: invoke() with anthropic provider + sessionId ⇒ streamText does NOT set promptCacheKey", async () => {
    async function* emptyStream() {
      // pass
    }
    (streamTextSpy as ReturnType<typeof vi.fn>).mockResolvedValue({
      fullStream: emptyStream(),
    });

    const config: InvokeConfig = {
      model: "anthropic/claude-3-5-sonnet",
      apiKey: "sk-test",
    };

    const options: InvokeOptions = {
      messages: [
        { role: "system", content: "you are helpful" },
        { role: "user", content: "hello" },
      ],
      context: { sessionId: "sess_anthropic_001" },
    };

    await invoke(config, options, { abort: undefined });

    const messages = getMessagesArgFromStreamText(0);
    const sysMsg = messages.find((m) => (m as { role?: string }).role === "system") as
      | { providerOptions?: Record<string, unknown> }
      | undefined;
    expect(sysMsg).toBeDefined();
    // Anthropic must NOT receive openai.promptCacheKey — it has its own cache_control
    expect((sysMsg!.providerOptions?.openai as { promptCacheKey?: string } | undefined)?.promptCacheKey).toBeUndefined();
    // But Anthropic cacheControl should still be present
    expect(sysMsg!.providerOptions?.anthropic).toBeDefined();
  });

  test("D3.stream: invoke() with openai-compatible + missing sessionId ⇒ no promptCacheKey emitted (graceful)", async () => {
    async function* emptyStream() {
      // pass
    }
    (streamTextSpy as ReturnType<typeof vi.fn>).mockResolvedValue({
      fullStream: emptyStream(),
    });

    const config: InvokeConfig = {
      model: "openai-compatible/minimax-m3",
      apiKey: "sk-test",
    };

    const options: InvokeOptions = {
      messages: [
        { role: "system", content: "you are helpful" },
        { role: "user", content: "hello" },
      ],
      // No sessionId in context
    };

    await invoke(config, options, { abort: undefined });

    const messages = getMessagesArgFromStreamText(0);
    const sysMsg = messages.find((m) => (m as { role?: string }).role === "system") as
      | { providerOptions?: Record<string, unknown> }
      | undefined;
    expect(sysMsg).toBeDefined();
    // No sessionId ⇒ no promptCacheKey (helper uses ANTHROPIC_CACHE_CONTROL only when openaiOptions is empty)
    expect((sysMsg!.providerOptions?.openai as { promptCacheKey?: string } | undefined)?.promptCacheKey).toBeUndefined();
  });
});

describe.skipIf(isParallelRun)("Dim 3 production wire — invokeNonStream() passes sessionId + provider to convertToSDKMessages", () => {
  beforeEach(() => {
    generateTextSpy.mockReset();
    streamTextSpy.mockReset();
  });

  afterEach(() => {
    generateTextSpy.mockReset();
    streamTextSpy.mockReset();
  });

  test("D3.nonstream: invokeNonStream() with openai-compatible + sessionId ⇒ generateText sees promptCacheKey", async () => {
    generateTextSpy.mockResolvedValue({
      text: "ok",
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    } as unknown as Awaited<ReturnType<typeof aiModule.generateText>>);

    const config: InvokeConfig = {
      model: "openai-compatible/deepseek-chat",
      apiKey: "sk-test",
      baseURL: "https://api.deepseek.com",
    };

    const options: InvokeOptions = {
      messages: [
        { role: "system", content: "you are helpful" },
        { role: "user", content: "hello" },
      ],
      context: { sessionId: "sess_dim3_nonstream_002" },
    };

    await invokeNonStream(config, options, { abort: undefined });

    const messages = getMessagesArgFromGenerateText(0);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    const sysMsg = messages.find((m) => (m as { role?: string }).role === "system") as
      | { providerOptions?: Record<string, unknown> }
      | undefined;
    expect(sysMsg).toBeDefined();
    // RED assertion: promptCacheKey must be on the SDKMessages
    expect(
      (sysMsg!.providerOptions?.openai as { promptCacheKey?: string } | undefined)?.promptCacheKey
    ).toBe("sess_dim3_nonstream_002");
  });

  test("D3.nonstream: invokeNonStream() with deepseek + sessionId ⇒ generateText sees promptCacheKey", async () => {
    generateTextSpy.mockResolvedValue({
      text: "ok",
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    } as unknown as Awaited<ReturnType<typeof aiModule.generateText>>);

    const config: InvokeConfig = {
      model: "openai-compatible/glm-4.6",
      apiKey: "sk-test",
      baseURL: "https://open.bigmodel.cn/api/paas/v4",
    };

    const options: InvokeOptions = {
      messages: [
        { role: "system", content: "you are helpful" },
        { role: "user", content: "hello" },
      ],
      context: { sessionId: "sess_glm_003" },
    };

    await invokeNonStream(config, options, { abort: undefined });

    const messages = getMessagesArgFromGenerateText(0);
    const sysMsg = messages.find((m) => (m as { role?: string }).role === "system") as
      | { providerOptions?: Record<string, unknown> }
      | undefined;
    expect(sysMsg).toBeDefined();
    expect(
      (sysMsg!.providerOptions?.openai as { promptCacheKey?: string } | undefined)?.promptCacheKey
    ).toBe("sess_glm_003");
  });
});
