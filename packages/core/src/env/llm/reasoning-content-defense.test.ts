/**
 * Task #4398 — defensive `reasoning_content` injection.
 *
 * Business context (user, 2026-10-20):
 *   "[invalid_request_error] The `reasoning_content` in the thinking mode must
 *    be passed back to the API."
 *   → 12 occurrences in production, ALL of them `opencodego / deepseek-v4.1-flash`.
 *
 * Root cause is a DOUBLE miss in the detection chain:
 *
 *   1. pi-ai `openai-completions.js:884`
 *        const isDeepSeek = provider === "deepseek" || baseUrl.includes("deepseek.com")
 *      → opencodego is neither (provider="opencodego",
 *        baseUrl="https://opencode.ai/inference/go/v1") → compat flag stays false.
 *
 *   2. roy-bot `adapter-pi-ai.ts` `resolvePiModel()` hardcodes `reasoning: false`
 *      for every model that is not in pi-ai's built-in registry (opencodego is
 *      not). pi-ai's injection site (`openai-completions.js:712-716`) is a
 *      THREE-way AND:
 *          if (compat.requiresReasoningContentOnAssistantMessages &&
 *              model.reasoning &&                        // ← permanently false
 *              assistantMsg.reasoning_content === undefined)
 *      → the injection can never happen from inside pi-ai, no matter what the
 *        compat flag says. `capabilities.reasoning: true` in config never
 *        reaches `resolvePiModel()` either.
 *
 * Therefore the defence has to live on the roy-bot side (`onPayload`), which
 * is exactly where these tests aim.
 *
 * ⚠️ The user's one hard constraint: this must NOT disturb prompt caching.
 * That is why injection is guarded by `shouldInjectReasoningContent()` (only
 * DeepSeek-family providers) and why a byte-for-byte stability test exists —
 * a value that varied per call would break the cache prefix.
 */
import { describe, test, expect, mock } from "bun:test";

describe("reasoning_content defence — decision function", () => {
  test("injects for opencodego + deepseek family (the production failure combo)", async () => {
    const { shouldInjectReasoningContent } = await import("./reasoning-defense");
    expect(shouldInjectReasoningContent("opencodego", "deepseek-v4.1-flash")).toBe(true);
    expect(shouldInjectReasoningContent("opencodego", "deepseek-v4-pro")).toBe(true);
    // Direct deepseek provider, other spellings of the family.
    expect(shouldInjectReasoningContent("deepseek", "deepseek-chat")).toBe(true);
    expect(shouldInjectReasoningContent("deepseek", "deepseek-reasoner")).toBe(true);
  });

  test("does NOT inject for non-DeepSeek providers (cache safety)", async () => {
    const { shouldInjectReasoningContent } = await import("./reasoning-defense");
    // These providers either reject unknown fields or hash the assistant
    // message into their cache prefix — adding a field would be a silent
    // cache regression for zero benefit.
    expect(shouldInjectReasoningContent("glm", "glm-5.2")).toBe(false);
    expect(shouldInjectReasoningContent("minimax", "MiniMax-M3")).toBe(false);
    expect(shouldInjectReasoningContent("anthropic", "claude-sonnet-4")).toBe(false);
    expect(shouldInjectReasoningContent("openai", "gpt-5")).toBe(false);
    // opencodego routing to a NON-deepseek model must stay untouched.
    expect(shouldInjectReasoningContent("opencodego", "glm-5.2")).toBe(false);
    expect(shouldInjectReasoningContent("opencodego", "kimi-k2.7-code")).toBe(false);
  });
});

describe("reasoning_content defence — message injection", () => {
  test("adds empty-string reasoning_content to every assistant message", async () => {
    const { injectReasoningContent } = await import("./reasoning-defense");
    const messages: any[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello", toolCalls: [] },
      { role: "toolResult", content: "result" },
      { role: "assistant", content: "", toolCalls: [{ id: "1" }] },
    ];
    const out = injectReasoningContent(messages);

    expect(out[1].reasoning_content).toBe("");
    expect(out[3].reasoning_content).toBe("");
    // Only assistant messages are touched.
    expect(out[0].reasoning_content).toBeUndefined();
    expect(out[2].reasoning_content).toBeUndefined();
  });

  test("preserves a real reasoning_content when the model did produce one", async () => {
    const { injectReasoningContent } = await import("./reasoning-defense");
    const messages: any[] = [
      { role: "assistant", content: "x", reasoning_content: "real thinking" },
      { role: "assistant", content: "y", reasoning_content: "" },
    ];
    const out = injectReasoningContent(messages);
    expect(out[0].reasoning_content).toBe("real thinking");
    expect(out[1].reasoning_content).toBe("");
  });

  test("is idempotent and does not mutate the input array", async () => {
    const { injectReasoningContent } = await import("./reasoning-defense");
    const messages: any[] = [{ role: "assistant", content: "a" }];
    const once = injectReasoningContent(messages);
    const twice = injectReasoningContent(once as any);

    expect(messages[0].reasoning_content).toBeUndefined(); // input untouched
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice)); // idempotent
  });

  /**
   * The cache-safety guard rail.
   *
   * Prompt caching is a PREFIX match: whatever we serialise for turn N becomes
   * the prefix the provider is asked to reuse at turn N+1. If the injected
   * value were derived from anything volatile (timestamp, random id, attempt
   * counter), every turn would produce a different prefix and the cache would
   * never hit. This test pins the value to the literal empty string.
   */
  test("injected value is a constant empty string — byte-stable for cache prefix", async () => {
    const { injectReasoningContent } = await import("./reasoning-defense");
    const a = injectReasoningContent([{ role: "assistant", content: "same" }] as any);
    const b = injectReasoningContent([{ role: "assistant", content: "same" }] as any);
    expect(a[0].reasoning_content).toBe("");
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // Field ORDER matters for byte-identical serialisation: the key must be
    // appended last, deterministically, on every call.
    expect(JSON.stringify(a)).toBe('[{"role":"assistant","content":"same","reasoning_content":""}]');
  });
});

describe("reasoning_content defence — payload wiring", () => {
  test("applyReasoningDefense only rewrites messages for DeepSeek-family", async () => {
    const { applyReasoningDefense } = await import("./reasoning-defense");
    const payload = {
      model: "deepseek-v4.1-flash",
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
      ],
    };

    const on = applyReasoningDefense(payload, { provider: "opencodego", modelId: "deepseek-v4.1-flash" });
    expect((on as any).messages[1].reasoning_content).toBe("");
    expect((on as any).messages[0].reasoning_content).toBeUndefined();

    const off = applyReasoningDefense(payload, { provider: "glm", modelId: "glm-5.2" });
    // Untouched: identity, not a copy — proves we do zero work for safe providers.
    expect(off).toBe(payload);
    expect((off as any).messages[1].reasoning_content).toBeUndefined();
  });

  test("applyReasoningDefense tolerates payloads without messages", async () => {
    const { applyReasoningDefense } = await import("./reasoning-defense");
    const payload = { model: "x" };
    const out = applyReasoningDefense(payload, { provider: "deepseek", modelId: "deepseek-chat" });
    expect(out).toBe(payload);
  });
});

describe("reasoning_content defence — reaches pi-ai through the adapter", () => {
  test("PiAiAdapter passes an onPayload hook that injects reasoning_content", async () => {
    const captured: any[] = [];

    mock.module("@earendil-works/pi-ai", () => {
      const fakeComplete = async (model: any, _ctx: any, options: any) => {
        // Simulate pi-ai's internal flow: build the params, then hand them to
        // onPayload (openai-completions.js:77-81).
        const params = {
          model: model.id,
          messages: [
            { role: "user", content: "q" },
            { role: "assistant", content: "a" },
          ],
        };
        const next = await options?.onPayload?.(params, model);
        captured.push({ model, options, payload: next ?? params });
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
        stream: () => {
          throw new Error("not used in this test");
        },
        complete: fakeComplete,
        getModel: () => undefined, // force fallback descriptor path
      };
    });

    const { PiAiAdapter } = await import("./adapter-pi-ai");
    const adapter = new PiAiAdapter();

    await adapter.chat({
      provider: "opencodego",
      modelId: "deepseek-v4.1-flash",
      apiKey: "k",
      baseURL: "https://opencode.ai/inference/go/v1",
      messages: [{ role: "user", content: "q" }],
      sessionId: "s1",
    } as any);

    const c = captured[0];
    expect(typeof c.options.onPayload).toBe("function");
    expect(c.payload.messages[1].reasoning_content).toBe("");
    expect(c.payload.messages[0].reasoning_content).toBeUndefined();
  });

  test("PiAiAdapter leaves non-DeepSeek payloads byte-identical", async () => {
    const captured: any[] = [];

    mock.module("@earendil-works/pi-ai", () => {
      const fakeComplete = async (model: any, _ctx: any, options: any) => {
        const params = {
          model: model.id,
          messages: [{ role: "assistant", content: "a" }],
        };
        const next = await options?.onPayload?.(params, model);
        captured.push({ next: next ?? params });
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
      return { stream: () => { throw new Error("unused"); }, complete: fakeComplete, getModel: () => undefined };
    });

    const { PiAiAdapter } = await import("./adapter-pi-ai");
    const adapter = new PiAiAdapter();

    await adapter.chat({
      provider: "glm",
      modelId: "glm-5.2",
      apiKey: "k",
      baseURL: "https://open.bigmodel.cn/api/paas/v4",
      messages: [{ role: "user", content: "q" }],
    } as any);

    expect(captured[0].next).toEqual({ model: "glm-5.2", messages: [{ role: "assistant", content: "a" }] });
    expect(captured[0].next.messages[0].reasoning_content).toBeUndefined();
  });
});
