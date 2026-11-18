/**
 * Task #4373: cache usage 必须从 adapter 成功路径完整传递到 LLMInvokeResult
 *
 * 用户诉求（飞书 p2p 2026-10-20）：
 *   "我要看的是 roy-bot 这个 harness 的缓存命中，
 *    你用探针自己写代码怎么能了解 roy-bot 的缓存命中情况呢"
 *
 * 事实（修复前，来自生产 traces.db）：
 *   roy-bot 自己的 `llm.component.invoke` span，output.usage 只有 3 个字段
 *     { promptTokens, completionTokens, totalTokens }
 *   86,922 个 span 中 **0 个** 带 cacheRead。
 *
 * 根因：
 *   - `UsageInfo`（types.ts）已有 cacheRead/cacheWrite
 *   - `adapter-pi-ai.ts::fromAssistantMessage` 已正确解析 msg.usage.cacheRead
 *   - 但 `llm.ts::invoke` 的 adapter 成功路径 **主动重打包** usage 成
 *     3 字段字面量（line 751-755），并把 `finishUsage` 变量显式标注为
 *     3 字段类型（line 642）→ cache 字段被结构性丢弃。
 *   - fallback 路径（line 724-728）同样问题。
 *
 * 语义关键（决定命中率公式不能是 reads/promptTokens）：
 *   pi-ai `openai-completions.js::parseChunkUsage`:
 *     input = max(0, prompt_tokens - cacheReadTokens - cacheWriteTokens)
 *     totalTokens = input + output + cacheRead + cacheWrite
 *   ⇒ pi-ai 的 `promptTokens`(=input) 是 **已扣缓存后的新增量**。
 *   ⇒ 正确命中率 = cacheRead / (promptTokens + cacheRead + cacheWrite)
 *   ⇒ 错误公式 cacheRead/promptTokens 在真机数据下会算出 20,960%（>100% 荒谬值）
 */
import { vi, describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import type { Environment } from "../interface";
import { ConfigComponent } from "../../config/config-component";

// Fake adapter injected via LLMComponent.__setAdapterForTest().
//
// ⚠️ Deliberately NOT using `mock.module("./factory")`: that replaces the
// module globally for the whole Bun process, which leaked into
// llm.adapter-integration.test.ts (4 unrelated failures). The instance-scoped
// setter keeps this file hermetic.
let lastFakeAdapter: any = null;

describe("cache usage visibility (Task #4373)", () => {
  const originalEnv = process.env.ROY_LLM_PROVIDER;

  // LLMComponent.init() reads provider/model from EnvSource, and several other
  // test files in this package mutate these globals without restoring them.
  // When this file runs later in the same Bun process, a stale
  // `LLM_LLM_DEFAULT_PROVIDER` (e.g. "openai") makes init() throw before any
  // assertion runs. Fence the whole surface here.
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

  function makeFakeAdapter(finalResult: any, opts: { throwStream?: boolean } = {}) {
    return {
      name: "pi-ai" as const,
      chat: vi.fn(async () => {
        if (opts.throwStream) throw new Error("chat also unavailable");
        return finalResult;
      }),
      stream: vi.fn(async () => {
        if (opts.throwStream) throw new Error("pi-ai stream failed");
        return {
          events: (async function* () {
            // no incremental events needed for usage assertions
          })(),
          result: async () => finalResult,
        };
      }),
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

  async function buildLLMComponent() {
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
      pushEnvEvent: () => {},
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

  // -------------------------------------------------------------------------
  // RED 1 — adapter success path must preserve cacheRead / cacheWrite
  // -------------------------------------------------------------------------
  test("adapter success path preserves cacheRead/cacheWrite in output.usage", async () => {
    lastFakeAdapter = makeFakeAdapter({
      text: "ok",
      finishReason: "stop" as const,
      toolCalls: undefined,
      usage: {
        promptTokens: 24,
        completionTokens: 32,
        totalTokens: 102072,
        cacheRead: 102016,
        cacheWrite: 0,
      },
    });

    const { comp } = await buildLLMComponent();
    const result = await comp.invoke({
      messages: [{ role: "user", content: "hi" }],
      skipThresholdCheck: true,
    });

    expect(result.output.usage).toBeDefined();
    // These two assertions are the RED ones — currently undefined.
    expect(result.output.usage!.cacheRead).toBe(102016);
    expect(result.output.usage!.cacheWrite).toBe(0);
    // Existing 3 fields must remain untouched.
    expect(result.output.usage!.promptTokens).toBe(24);
    expect(result.output.usage!.completionTokens).toBe(32);
    expect(result.output.usage!.totalTokens).toBe(102072);
  });

  // -------------------------------------------------------------------------
  // RED 2 — adapter fallback path (AI SDK) must preserve cache
  //
  // The AI SDK fallback serializes usage into `result.result` JSON, which
  // llm.ts then re-parses. That path also used to rebuild a 3-field literal.
  // We drive it through the real `invoke()` (mocking only `ai.streamText`),
  // matching the established convention in llm.stream-events.test.ts — a
  // vi.spyOn on our own `./invoke` export does NOT work because llm.ts holds
  // a live ESM binding to the original function.
  // -------------------------------------------------------------------------
  test("adapter fallback path preserves cacheRead/cacheWrite in output.usage", async () => {
    lastFakeAdapter = makeFakeAdapter(null, { throwStream: true });

    const { comp } = await buildLLMComponent();

    const aiModule = await import("ai");
    const streamTextSpy = vi.spyOn(aiModule as any, "streamText");
    streamTextSpy.mockResolvedValue({
      fullStream: (async function* () {
        yield { type: "text-delta", textDelta: "from-ai-sdk" };
        yield {
          type: "finish",
          // AI SDK v3 shape: cacheRead lives on inputTokens, and
          // inputTokens.total is FULLY INCLUSIVE (contrast with pi-ai).
          totalUsage: {
            inputTokens: { total: 102040, cacheRead: 102016, cacheWrite: 0, noCache: 24 },
            outputTokens: { total: 32 },
            totalTokens: 102072,
          },
        };
      })(),
    } as any);

    try {
      const result = await comp.invoke({
        messages: [{ role: "user", content: "hi" }],
        skipThresholdCheck: true,
      });

      expect(result.output.usage).toBeDefined();
      expect(result.output.usage!.cacheRead).toBe(102016);
      expect(result.output.usage!.cacheWrite).toBe(0);
      // AI SDK's promptTokens is the inclusive total — must not be altered.
      expect(result.output.usage!.promptTokens).toBe(102040);
      // …so the cache-aware denominator must equal it (no double counting).
      expect(result.output.usage!.promptTokensTotal).toBe(102040);
    } finally {
      streamTextSpy.mockRestore();
    }
  });

  // -------------------------------------------------------------------------
  // RED 3 — cacheMiss must survive too (DeepSeek-shaped providers)
  // -------------------------------------------------------------------------
  test("adapter success path preserves cacheMiss when reported", async () => {
    lastFakeAdapter = makeFakeAdapter({
      text: "ok",
      finishReason: "stop" as const,
      usage: {
        promptTokens: 1000,
        completionTokens: 50,
        totalTokens: 2100,
        cacheRead: 1000,
        cacheWrite: 0,
        cacheMiss: 50,
      },
    });

    const { comp } = await buildLLMComponent();
    const result = await comp.invoke({
      messages: [{ role: "user", content: "hi" }],
      skipThresholdCheck: true,
    });

    expect(result.output.usage!.cacheMiss).toBe(50);
  });

  // -------------------------------------------------------------------------
  // RED 4 — undefined cache fields must stay undefined (not coerced to 0)
  //
  // `0` means "cache was checked, no hit"; `undefined` means "provider did
  // not report the field". Collapsing them loses information.
  // -------------------------------------------------------------------------
  test("absent cache fields stay undefined, reported zeros stay 0", async () => {
    lastFakeAdapter = makeFakeAdapter({
      text: "ok",
      finishReason: "stop" as const,
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        // cacheRead/cacheWrite intentionally absent
      },
    });

    const { comp } = await buildLLMComponent();
    const result = await comp.invoke({
      messages: [{ role: "user", content: "hi" }],
      skipThresholdCheck: true,
    });

    expect(result.output.usage!.cacheRead).toBeUndefined();
    expect(result.output.usage!.cacheWrite).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // RED 7 — promptTokensTotal must reflect pi-ai's non-cached promptTokens
  //
  // pi-ai: promptTokens=24 (non-cached), cacheRead=102016,
  //        totalTokens=102072 = 24 + 32 + 102016
  // ⇒ promptTokensTotal = 24 + 102016 = 102040
  // -------------------------------------------------------------------------
  test("promptTokensTotal adds cached tokens back for the pi-ai usage shape", async () => {
    lastFakeAdapter = makeFakeAdapter({
      text: "ok",
      finishReason: "stop" as const,
      usage: {
        promptTokens: 24,
        completionTokens: 32,
        totalTokens: 102072,
        cacheRead: 102016,
        cacheWrite: 0,
      },
    });

    const { comp } = await buildLLMComponent();
    const result = await comp.invoke({
      messages: [{ role: "user", content: "hi" }],
      skipThresholdCheck: true,
    });

    expect(result.output.usage!.promptTokens).toBe(24);
    expect(result.output.usage!.promptTokensTotal).toBe(102040);
  });

  // -------------------------------------------------------------------------
  // RED 8 — computeCacheHitRate should prefer promptTokensTotal when present
  // -------------------------------------------------------------------------
  test("computeCacheHitRate accepts promptTokensTotal as the authoritative denominator", async () => {
    const { computeCacheHitRate } = await import("./invoke");

    // pi-ai row: non-cached 24, cacheRead 102016 → 99.98%
    const rate = computeCacheHitRate({
      promptTokens: 24,
      promptTokensTotal: 102040,
      cacheRead: 102016,
      cacheWrite: 0,
    });
    expect(rate).toBeCloseTo(102016 / 102040, 6);
    expect(rate).toBeLessThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // RED 5 — computeCacheHitRate must stay ≤ 100% under pi-ai semantics
  //
  // pi-ai: promptTokens = input (already cache-subtracted)
  //        totalTokens  = input + output + cacheRead + cacheWrite
  // ⇒ rate = cacheRead / (promptTokens + cacheRead + cacheWrite)
  //
  // The naive `cacheRead / promptTokens` yields 102016/24 = 4250.67 (425,067%).
  // -------------------------------------------------------------------------
  test("computeCacheHitRate normalizes promptTokens and never exceeds 100%", async () => {
    const { computeCacheHitRate } = await import("./invoke");

    // Real-world pi-ai shape: promptTokens is the *non-cached* remainder.
    const rate = computeCacheHitRate({
      promptTokens: 24,
      cacheRead: 102016,
      cacheWrite: 0,
    });
    expect(rate).toBeGreaterThan(0.99);
    expect(rate).toBeLessThanOrEqual(1);

    // All-cached, zero new input → 100%
    expect(
      computeCacheHitRate({ promptTokens: 0, cacheRead: 5000, cacheWrite: 0 })
    ).toBe(1);

    // Pure cold write, no read → 0%
    expect(
      computeCacheHitRate({ promptTokens: 100, cacheRead: 0, cacheWrite: 900 })
    ).toBe(0);

    // No cache info at all → 0 (not NaN)
    expect(computeCacheHitRate({ promptTokens: 100 })).toBe(0);

    // Degenerate zero usage → 0 (not NaN)
    expect(
      computeCacheHitRate({ promptTokens: 0, cacheRead: 0, cacheWrite: 0 })
    ).toBe(0);
  });

  // -------------------------------------------------------------------------
  // RED 6 — the 4 real production rows from traces.db must all report ≤100%
  //
  // These are actual values mined from
  // ~/.local/share/roy-bot/traces.db before the fix
  // (3-field usage only → cacheRead had to be *reverse-engineered*).
  // After the fix we should be able to compute these directly and sanely.
  // -------------------------------------------------------------------------
  test("real production rows yield sane hit rates (no >100% outliers)", async () => {
    const { computeCacheHitRate } = await import("./invoke");

    // (promptTokens, completionTokens, totalTokens) observed in prod spans
    const rows: Array<[number, number, number]> = [
      [618, 108, 130262],
      [1072, 229, 129813],
      [797, 241, 389518],
      [267, 237, 388728],
    ];

    for (const [p, c, t] of rows) {
      // Reverse-engineer cacheRead from totalTokens (pi-ai invariant).
      const cacheRead = t - p - c;
      expect(cacheRead).toBeGreaterThan(0);

      const rate = computeCacheHitRate({
        promptTokens: p,
        cacheRead,
        cacheWrite: 0,
      });
      expect(rate).toBeGreaterThan(0.98);
      expect(rate).toBeLessThanOrEqual(1);
    }
  });
});
