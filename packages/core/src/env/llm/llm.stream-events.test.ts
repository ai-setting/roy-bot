/**
 * LLMComponent.invoke → adapter.stream() 流式事件测试（RED-first）
 *
 * Task #2719: interactive 路径必须走 pi-ai 真 stream()，字符逐字流式输出。
 *
 * 验证目标：
 * 1. LLMComponent.invoke() 优先调用 adapter.stream() 而非 adapter.chat()
 * 2. 消费 stream.events 时，遇到 text_delta 必须推送 llm.text env 事件
 * 3. 消费 stream.events 时，遇到 thinking_delta 必须推送 llm.reasoning env 事件
 * 4. 调用 stream.result() 拿到最终 ChatResponse 后正常返回 LLMInvokeResult
 * 5. 适配器 stream() 抛错时回退到 AI SDK invoke()
 */
import { vi, describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import type { Environment } from "../interface";
import { ConfigComponent } from "../../config/config-component";

// Track if stream/chat were called
let streamCalled = 0;
let chatCalled = 0;
let lastFakeAdapter: any = null;

// We use mock.module to replace the factory module before LLMComponent loads it.
mock.module("./factory", () => ({
  setLLMProvider: (_name: any) => {},
  getLLMProviderOverride: () => undefined,
  createLLMAdapter: () => {
    return lastFakeAdapter;
  },
}));

describe("LLMComponent.invoke → adapter.stream() (Task #2719)", () => {
  const originalEnv = process.env.ROY_LLM_PROVIDER;

  beforeEach(() => {
    process.env.ROY_LLM_PROVIDER = "pi-ai";
    streamCalled = 0;
    chatCalled = 0;
    lastFakeAdapter = null;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ROY_LLM_PROVIDER;
    else process.env.ROY_LLM_PROVIDER = originalEnv;
  });

  function makeFakeAdapter(events: any[], finalResult: any) {
    return {
      name: "pi-ai" as const,
      // chat() is a SUCCESS stub. The current (RED) implementation calls chat().
      // We verify that stream() is called INSTEAD. chat() should NOT be invoked.
      chat: vi.fn(async () => {
        chatCalled++;
        return {
          text: "STALE_CHAT_RESULT",
          finishReason: "stop" as const,
          usage: { promptTokens: 999, completionTokens: 999, totalTokens: 1998 },
        };
      }),
      stream: vi.fn(async () => {
        streamCalled++;
        return {
          events: (async function* () {
            for (const e of events) yield e;
          })(),
          result: async () => finalResult,
        };
      }),
      resolveProvider: vi.fn(async () => ({
        api: "openai-completions", provider: "minimax", modelId: "MiniMax-M3",
        contextLimit: 128000, maxTokensLimit: 8192,
      })),
      embed: vi.fn(async () => { throw new Error("not implemented"); }),
    };
  }

  async function buildLLMComponent(captured: any[]) {
    const { LLMComponent } = await import("./llm");
    const configComponent = new ConfigComponent({});
    configComponent.set("llm.providers", {
      minimax: { apiKey: "sk-test", baseURL: "https://api.test/v1" },
    });
    configComponent.set("llm.defaultProvider", "minimax");
    configComponent.set("llm.defaultModel", "MiniMax-M3");
    const comp = new LLMComponent();
    const fakeEnv = {
      pushEnvEvent: (evt: any) => { captured.push(evt); },
      subscribeTo: () => () => {},
      getComponent: () => undefined,
    } as any;
    await comp.init({
      name: "llm", version: "1.0.0", enabled: true,
      env: fakeEnv as unknown as Environment,
      options: { configComponent },
    });
    return { comp };
  }

  test("LLMComponent.invoke calls adapter.stream() and consumes text_delta → llm.text events", async () => {
    const fakeEvents = [
      { type: "start", partial: { role: "assistant", content: [] } },
      { type: "text_start", contentIndex: 0, partial: { role: "assistant", content: [{ type: "text", text: "" }] } },
      { type: "text_delta", contentIndex: 0, delta: "Hello", partial: { role: "assistant", content: [{ type: "text", text: "Hello" }] } },
      { type: "text_delta", contentIndex: 0, delta: " world", partial: { role: "assistant", content: [{ type: "text", text: "Hello world" }] } },
      { type: "text_end", contentIndex: 0, content: "Hello world", partial: { role: "assistant", content: [{ type: "text", text: "Hello world" }] } },
      { type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "Hello world" }] } },
    ];
    lastFakeAdapter = makeFakeAdapter(fakeEvents, {
      text: "Hello world",
      finishReason: "stop" as const,
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
    });

    const captured: any[] = [];
    const { comp } = await buildLLMComponent(captured);

    const result = await comp.invoke({ messages: [{ role: "user", content: "hi" }] });

    // stream() should be called, chat() should NOT
    expect(streamCalled).toBe(1);
    expect(chatCalled).toBe(0);
    expect(result.output.content).toBe("Hello world");
    // verify usage comes from stream result, not from chat stub
    expect(result.output.usage?.promptTokens).toBe(5);

    const textEvents = captured.filter((e: any) => e.type === "llm.text");
    expect(textEvents.length).toBeGreaterThanOrEqual(2);
    expect(textEvents[0].payload.delta).toBe("Hello");
    expect(textEvents[0].payload.content).toBe("Hello");
    expect(textEvents[1].payload.delta).toBe(" world");
    expect(textEvents[1].payload.content).toBe("Hello world");
  });

  test("LLMComponent.invoke consumes thinking_delta → llm.reasoning events", async () => {
    const fakeEvents = [
      { type: "thinking_start", contentIndex: 0, partial: { role: "assistant", content: [{ type: "thinking", thinking: "" }] } },
      { type: "thinking_delta", contentIndex: 0, delta: "Let me think", partial: { role: "assistant", content: [{ type: "thinking", thinking: "Let me think" }] } },
      { type: "thinking_end", contentIndex: 0, content: "Let me think", partial: { role: "assistant", content: [{ type: "thinking", thinking: "Let me think" }] } },
      { type: "done", reason: "stop", message: { role: "assistant", content: [] } },
    ];
    lastFakeAdapter = makeFakeAdapter(fakeEvents, {
      text: "", finishReason: "stop" as const,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    const captured: any[] = [];
    const { comp } = await buildLLMComponent(captured);

    await comp.invoke({ messages: [{ role: "user", content: "hi" }] });

    expect(streamCalled).toBe(1);
    expect(chatCalled).toBe(0);

    const reasoningEvents = captured.filter((e: any) => e.type === "llm.reasoning");
    expect(reasoningEvents.length).toBeGreaterThanOrEqual(1);
    expect(reasoningEvents[0].payload.delta).toBe("Let me think");
  });

  test("LLMComponent.invoke falls back to AI SDK invoke() when adapter.stream() throws", async () => {
    // Make adapter.stream() throw
    lastFakeAdapter = {
      name: "pi-ai" as const,
      chat: vi.fn(async () => {
        chatCalled++;
        return { text: "", finishReason: "stop" as const, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
      }),
      stream: vi.fn(async () => {
        streamCalled++;
        throw new Error("pi-ai stream failed");
      }),
      resolveProvider: vi.fn(async () => ({
        api: "openai-completions", provider: "minimax", modelId: "MiniMax-M3",
        contextLimit: 128000, maxTokensLimit: 8192,
      })),
      embed: vi.fn(async () => { throw new Error("not implemented"); }),
    };

    const captured: any[] = [];
    const { comp } = await buildLLMComponent(captured);

    // Mock ai SDK streamText for the fallback path
    const aiModule = await import("ai");
    const streamTextSpy = vi.spyOn(aiModule as any, "streamText");
    streamTextSpy.mockResolvedValue({
      fullStream: (async function* () {
        yield { type: "text-delta", textDelta: "From AI SDK" };
        yield { type: "finish", totalUsage: { inputTokens: { total: 5, cacheRead: 0, noCache: 5 }, outputTokens: { total: 2 }, totalTokens: 7 } };
      })(),
    } as any);

    try {
      const result = await comp.invoke({ messages: [{ role: "user", content: "hi" }] });

      // stream() should be called and throw
      expect(streamCalled).toBe(1);

      // The fallback path uses invoke() function which emits llm.text via the underlying streamText
      const textEvents = captured.filter((e: any) => e.type === "llm.text");
      expect(textEvents.length).toBeGreaterThanOrEqual(1);
      expect(result).toBeDefined();
    } finally {
      streamTextSpy.mockRestore();
    }
  });

  test("LLMComponent.invoke emits llm.text on second consecutive invocation (multiple-inputs bug, Task #2723)", async () => {
    // Regression test for the "multiple inputs no output" bug:
    // The first invoke() works, but the second invoke() produces no llm.text events
    // because consumeStreamAndGetResult state leaks or the adapter stream is not
    // properly consumed on subsequent calls.
    const fakeEvents = [
      { type: "text_delta", contentIndex: 0, delta: "Hello" },
      { type: "text_delta", contentIndex: 0, delta: " world" },
      { type: "done", reason: "stop" },
    ];
    const finalResult = {
      text: "Hello world",
      finishReason: "stop" as const,
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
    };

    // Each call to stream() returns a fresh async generator
    let callCount = 0;
    lastFakeAdapter = {
      name: "pi-ai" as const,
      chat: vi.fn(async () => {
        chatCalled++;
        return { text: "STALE", finishReason: "stop" as const, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
      }),
      stream: vi.fn(async () => {
        callCount++;
        streamCalled++;
        return {
          events: (async function* () {
            for (const e of fakeEvents) yield e;
          })(),
          result: async () => finalResult,
        };
      }),
      resolveProvider: vi.fn(async () => ({
        api: "openai-completions", provider: "minimax", modelId: "MiniMax-M3",
        contextLimit: 128000, maxTokensLimit: 8192,
      })),
      embed: vi.fn(async () => { throw new Error("not implemented"); }),
    };

    const captured: any[] = [];
    const { comp } = await buildLLMComponent(captured);

    // First invocation
    const result1 = await comp.invoke({ messages: [{ role: "user", content: "hi" }] });
    const textEvents1 = captured.filter((e: any) => e.type === "llm.text");
    expect(textEvents1.length).toBeGreaterThanOrEqual(2);
    expect(result1.output.content).toBe("Hello world");

    // Clear captured events for second invocation
    captured.length = 0;

    // Second invocation — must still emit llm.text events
    const result2 = await comp.invoke({ messages: [{ role: "user", content: "hi" }] });
    const textEvents2 = captured.filter((e: any) => e.type === "llm.text");
    expect(textEvents2.length).toBeGreaterThanOrEqual(2);
    expect(textEvents2[0].payload.delta).toBe("Hello");
    expect(result2.output.content).toBe("Hello world");

    // Both invocations should have called stream(), not chat()
    expect(streamCalled).toBe(2);
    expect(chatCalled).toBe(0);
  });

  // ========================================================================
  // P0-2: consumeStreamAndGetResult mid-abort test (claude-minimax review)
  //
  // When the stream is aborted mid-way (e.g. AbortSignal fires while
  // consuming events), consumeStreamAndGetResult must still call
  // streamHandle.result() in the finally block to ensure resource cleanup,
  // and the returned ChatResponse must have finishReason "aborted".
  // ========================================================================
  test("consumeStreamAndGetResult calls .result() and cleans up on mid-stream abort", async () => {
    let resultCalled = 0;
    const abortController = new AbortController();

    // Events: first two deltas are yielded, then we abort before the rest
    const fakeEvents = [
      { type: "text_delta", contentIndex: 0, delta: "Hello" },
      { type: "text_delta", contentIndex: 0, delta: " world" },
    ];

    lastFakeAdapter = {
      name: "pi-ai" as const,
      chat: vi.fn(async () => {
        chatCalled++;
        return { text: "STALE", finishReason: "stop" as const, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
      }),
      stream: vi.fn(async () => {
        streamCalled++;
        return {
          events: (async function* () {
            for (const e of fakeEvents) {
              yield e;
            }
            // Simulate abort: the stream ends here (pi-ai would stop
            // yielding after abort signal fires)
            abortController.abort();
          })(),
          result: async () => {
            resultCalled++;
            return {
              text: "Hello world",
              finishReason: "aborted" as const,
              usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
            };
          },
        };
      }),
      resolveProvider: vi.fn(async () => ({
        api: "openai-completions", provider: "minimax", modelId: "MiniMax-M3",
        contextLimit: 128000, maxTokensLimit: 8192,
      })),
      embed: vi.fn(async () => { throw new Error("not implemented"); }),
    };

    const captured: any[] = [];
    const { comp } = await buildLLMComponent(captured);

    const result = await comp.invoke({
      messages: [{ role: "user", content: "hi" }],
      abortSignal: abortController.signal,
    });

    // stream() was called
    expect(streamCalled).toBe(1);
    // result() must have been called (resource cleanup in finally block)
    expect(resultCalled).toBe(1);
    // The result should reflect the aborted state
    expect(result.output.content).toBe("Hello world");
    // llm.text events were emitted for the deltas we got
    const textEvents = captured.filter((e: any) => e.type === "llm.text");
    expect(textEvents.length).toBeGreaterThanOrEqual(2);
  });
});
