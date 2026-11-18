/**
 * Task #4383 P0 — end-to-end wiring proof.
 *
 * `buildPiCacheOptions()` being correct is not enough: the real question from
 * #4381 is whether pi-ai *actually receives* `sessionId` / `cacheRetention`
 * when roy-bot drives it through `PiAiAdapter.stream()`.
 *
 * These tests intercept the pi-ai provider stream function and assert on the
 * options object that reaches it. If the adapter ever drops the wiring again
 * (e.g. someone reverts to `{apiKey, baseURL, temperature, maxTokens, signal}`),
 * this fails.
 */
import { describe, test, expect, mock } from "bun:test";

describe("P0 e2e: PiAiAdapter forwards cache options into pi-ai", () => {
  test("stream() forwards sessionId + cacheRetention=long for openai-completions", async () => {
    const captured: any[] = [];

    mock.module("@earendil-works/pi-ai", () => {
      const fakeStream = (model: any, _ctx: any, options: any) => {
        captured.push({ model, options });
        return {
          // minimal AssistantMessageEventStream shape
          async *[Symbol.asyncIterator]() {
            /* no events */
          },
          result: async () => ({
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
            stopReason: "stop",
            timestamp: Date.now(),
          }),
        };
      };
      const fakeComplete = async (model: any, _ctx: any, options: any) => {
        captured.push({ model, options });
        return {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
          stopReason: "stop",
          timestamp: Date.now(),
        };
      };
      return {
        stream: fakeStream,
        complete: fakeComplete,
        // Force the fallback model-descriptor path so our apiProtocol table is used.
        getModel: () => undefined,
      };
    });

    const { PiAiAdapter } = await import("./adapter-pi-ai");
    const adapter = new PiAiAdapter();

    await adapter.chat({
      provider: "deepseek",
      modelId: "deepseek-flash",
      messages: [{ role: "user", content: "hi" } as any],
      apiKey: "k",
      baseURL: "https://api.deepseek.com",
      sessionId: "session_e2e_1",
    });

    expect(captured.length).toBe(1);
    expect(captured[0].model.api).toBe("openai-completions");
    expect(captured[0].options.sessionId).toBe("session_e2e_1");
    expect(captured[0].options.cacheRetention).toBe("long");
  });

  test("stream() keeps anthropic default (no cacheRetention override) for minimax", async () => {
    const captured: any[] = [];

    mock.module("@earendil-works/pi-ai", () => ({
      stream: (model: any, _ctx: any, options: any) => {
        captured.push({ model, options });
        return {
          async *[Symbol.asyncIterator]() {},
          result: async () => ({
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
            stopReason: "stop",
            timestamp: Date.now(),
          }),
        };
      },
      complete: async () => {
        throw new Error("not used");
      },
      getModel: () => undefined,
    }));

    const { PiAiAdapter } = await import("./adapter-pi-ai");
    const adapter = new PiAiAdapter();
    const handle = await adapter.stream({
      provider: "minimax",
      modelId: "MiniMax-M3",
      messages: [{ role: "user", content: "hi" } as any],
      apiKey: "k",
      baseURL: "https://api.minimaxi.com/anthropic",
      sessionId: "session_e2e_2",
    });
    await handle.result();

    expect(captured.length).toBe(1);
    // Task #4383 P1: explicit table resolves minimax → anthropic-messages
    expect(captured[0].model.api).toBe("anthropic-messages");
    expect(captured[0].options.sessionId).toBe("session_e2e_2");
    // Regression guard: passing "long" here would add cache_control.ttl="1h"
    // and change minimax's proven 99.86% behaviour.
    expect(captured[0].options.cacheRetention).toBeUndefined();
  });
});
