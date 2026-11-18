/**
 * @fileoverview Task #4396: `LLMComponent.invoke()` must publish an
 * `llm.completed` env event carrying the call's usage.
 *
 * Root cause (first-hand, measured from a real TUI run):
 *   The interactive TUI (`roy-bot interactive` → commands/interactive.ts → RunTui)
 *   subscribes to env events through QueryExecutor → StreamOutputService.
 *   `StreamOutputService.handleCompleted()` is what parses
 *   `payload.metadata.usage` into the usage footer's data source.
 *
 *   But `LLMComponent.consumeStreamAndGetResult()` only ever emitted
 *   `llm.text` / `llm.reasoning`, and `finalizeOutput()` — which is where the
 *   usage is actually finalized — emitted **nothing**.  The only
 *   `llm.completed` producer in the whole codebase lived in
 *   `invoke.ts::invokeNonStream()`, a path the interactive TUI never uses.
 *
 *   Consequence: `StreamOutputService.handleCompleted()` was dead code on the
 *   TUI path, so `usageInfo` was always undefined and no cache metrics could
 *   ever reach the Ink layer.
 *
 * User requirement (飞书 p2p 2026-10-20):
 *   "在每个Agent消息的后面添加上这个cache和token信息已灰色颜色展示出来"
 */

import { vi, describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Environment } from "../interface";
import { ConfigComponent } from "../../config/config-component";

let lastFakeAdapter: any = null;

describe("LLMComponent publishes llm.completed with usage (Task #4396)", () => {
  const originalEnv = process.env.ROY_LLM_PROVIDER;

  const OWNED_ENV_KEYS = [
    "LLM_LLM_DEFAULT_PROVIDER",
    "LLM_LLM_DEFAULT_MODEL",
    "LLM_DEFAULT_PROVIDER",
    "LLM_DEFAULT_MODEL",
    "LLM_LLM_PROVIDERS",
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of OWNED_ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    process.env.ROY_LLM_PROVIDER = "pi-ai";
    lastFakeAdapter = null;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ROY_LLM_PROVIDER;
    else process.env.ROY_LLM_PROVIDER = originalEnv;
    for (const k of OWNED_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  function makeFakeAdapter(finalResult: any) {
    return {
      name: "pi-ai" as const,
      chat: vi.fn(async () => finalResult),
      stream: vi.fn(async () => ({
        events: (async function* () {})(),
        result: async () => finalResult,
      })),
      resolveProvider: vi.fn(async () => ({
        api: "openai-completions",
        provider: "minimax",
        modelId: "MiniMax-M3",
        contextLimit: 1000000,
        maxTokensLimit: 8192,
      })),
      embed: vi.fn(async () => {
        throw new Error("not implemented");
      }),
    };
  }

  async function buildLLMComponent(events: any[]) {
    const { LLMComponent } = await import("./llm");
    const configComponent = new ConfigComponent({});
    configComponent.set("llm.providers", {
      minimax: { apiKey: "sk-test", baseURL: "https://api.test/v1" },
    });
    configComponent.set("llm.defaultProvider", "minimax");
    configComponent.set("llm.defaultModel", "MiniMax-M3");
    const comp = new LLMComponent();
    comp.__setAdapterForTest(lastFakeAdapter);
    const fakeEnv = {
      pushEnvEvent: (e: any) => events.push(e),
      subscribeTo: () => () => {},
      getComponent: () => undefined,
    } as any;
    await comp.init({
      name: "llm",
      version: "1.0.0",
      enabled: true,
      env: fakeEnv as unknown as Environment,
      options: { configComponent },
    });
    return { comp };
  }

  test("emits llm.completed carrying cacheRead/cacheWrite and the model", async () => {
    lastFakeAdapter = makeFakeAdapter({
      text: "hello",
      finishReason: "stop" as const,
      toolCalls: undefined,
      usage: {
        promptTokens: 32,
        completionTokens: 8,
        // Consistent with pi-ai semantics:
        //   promptTokensTotal = promptTokens + cacheRead + cacheWrite = 15008
        //   totalTokens       = promptTokensTotal + completionTokens     = 15016
        totalTokens: 15016,
        cacheRead: 14976,
        cacheWrite: 0,
      },
    });

    const events: any[] = [];
    const { comp } = await buildLLMComponent(events);
    await comp.invoke({
      messages: [{ role: "user", content: "hi" }],
      skipThresholdCheck: true,
    });

    const completed = events.find((e) => e.type === "llm.completed");
    expect(completed).toBeDefined();
    // Shape must match what StreamOutputService.handleCompleted() reads.
    const usage = completed!.payload?.metadata?.usage;
    expect(usage).toBeDefined();
    expect(usage.cacheRead).toBe(14976);
    expect(usage.promptTokens).toBe(32);
    expect(usage.completionTokens).toBe(8);
    expect(usage.promptTokensTotal).toBe(15008);
    // And the model string in `provider/model` form (the TUI splits on "/").
    expect(typeof completed!.payload?.metadata?.model).toBe("string");
    expect(completed!.payload.metadata.model).toContain("/");
    // Content must ride along so the service can settle the stream.
    expect(completed!.payload.content).toBe("hello");
  });

  test("still emits llm.completed when the adapter reports no usage", async () => {
    lastFakeAdapter = makeFakeAdapter({
      text: "hi",
      finishReason: "stop" as const,
      toolCalls: undefined,
      usage: undefined,
    });

    const events: any[] = [];
    const { comp } = await buildLLMComponent(events);
    await comp.invoke({
      messages: [{ role: "user", content: "hi" }],
      skipThresholdCheck: true,
    });

    const completed = events.find((e) => e.type === "llm.completed");
    // The event must exist even without usage — otherwise the TUI never
    // learns the turn finished (no footer, but also no settle).
    expect(completed).toBeDefined();
    expect(completed!.payload?.metadata?.usage).toBeUndefined();
  });

  test("does not emit llm.completed when the adapter fails", async () => {
    lastFakeAdapter = {
      ...makeFakeAdapter(null),
      chat: vi.fn(async () => {
        throw new Error("boom");
      }),
      stream: vi.fn(async () => {
        throw new Error("boom");
      }),
    };

    // LLMComponent falls back to the AI SDK `invoke()` path when the adapter
    // fails. Stub it so this test stays hermetic — without the stub it makes a
    // REAL network call to api.minimaxi.com (the 404 noise that leaked into
    // other test output and made this file non-deterministic).
    //
    // NOTE: the fallback calls `invoke()`, NOT `invokeNonStream()` — stubbing
    // the latter has no effect. llm.ts holds a live ESM binding, so the spy
    // must target the module object `llm.ts` actually imported.
    const invokeMod = await import("./invoke");
    const events: any[] = [];
    const { comp } = await buildLLMComponent(events);

    const spy = vi
      .spyOn(invokeMod, "invoke")
      .mockRejectedValue(new Error("ai-sdk unavailable"));

    try {
      await expect(
        comp.invoke({
          messages: [{ role: "user", content: "hi" }],
          skipThresholdCheck: true,
        }),
      ).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }

    // The whole point: a failed call must not publish a completion event.
    expect(events.find((e) => e.type === "llm.completed")).toBeUndefined();
  });
});
