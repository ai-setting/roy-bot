/**
 * Extra adversarial safety tests for the outbound defence middleware.
 * Written while cross-validation runs, targeting the "could this break
 * something" question specifically.
 */
import { describe, test, expect } from "bun:test";
import { applyOutboundDefense, createOutboundDefenseFetch } from "./outbound-defense";

describe("adversarial safety", () => {
  test("anthropic protocol: NO prompt_cache_key, NO reasoning_content", () => {
    const body = {
      model: "claude-3",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "yo" },
      ],
      system: "sys",
    };
    const out = applyOutboundDefense(body, {
      provider: "deepseek",     // even a deepseek provider id
      modelId: "deepseek-chat",
      sessionId: "ses_1",
      cacheRetention: "long",
      wireProtocol: "anthropic",
    });
    expect(JSON.stringify(out)).not.toContain("reasoning_content");
    expect("prompt_cache_key" in out).toBe(false);
    expect("prompt_cache_retention" in out).toBe(false);
    expect(out).toBe(body); // untouched reference
  });

  test("does NOT overwrite prompt_cache_key already set by the SDK", () => {
    const body = {
      messages: [{ role: "assistant", content: "a" }],
      prompt_cache_key: "sdk-provided-key",
      prompt_cache_retention: "1h",
    };
    const out = applyOutboundDefense(body, {
      provider: "deepseek", modelId: "deepseek-chat",
      sessionId: "our-session", cacheRetention: "long",
    });
    expect(out.prompt_cache_key).toBe("sdk-provided-key");
    expect(out.prompt_cache_retention).toBe("1h");
  });

  test("cacheRetention 'none' → no cache fields at all", () => {
    const out = applyOutboundDefense(
      { messages: [] },
      { provider: "glm", modelId: "glm-5.2", sessionId: "s", cacheRetention: "none" },
    );
    expect("prompt_cache_key" in out).toBe(false);
    expect("prompt_cache_retention" in out).toBe(false);
  });

  test("cacheRetention 'short' → key yes, retention no", () => {
    const out = applyOutboundDefense(
      { messages: [] },
      { provider: "glm", modelId: "glm-5.2", sessionId: "s", cacheRetention: "short" },
    );
    expect(out.prompt_cache_key).toBe("s");
    expect("prompt_cache_retention" in out).toBe(false);
  });

  test("response body is NEVER consumed — streaming still works", async () => {
    // Simulate a streaming SSE response and verify the middleware hands the
    // exact same Response object back, body untouched and readable.
    const sse = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("data: {\"a\":1}\n\n"));
        c.close();
      },
    });
    const upstreamResponse = new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const fakeFetch = (async () => upstreamResponse) as unknown as typeof fetch;

    const wrapped = createOutboundDefenseFetch(
      { provider: "deepseek", modelId: "deepseek-chat", sessionId: "s" },
      fakeFetch,
    );
    const res = await wrapped("https://x/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "assistant", content: "a" }] }),
    });
    expect(res).toBe(upstreamResponse);
    expect(res.bodyUsed).toBe(false);
    const text = await res.text();
    expect(text).toContain("data:");
  });

  test("inner fetch throwing is propagated, not swallowed", async () => {
    const boom = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    const wrapped = createOutboundDefenseFetch(
      { provider: "deepseek", modelId: "deepseek-chat" },
      boom,
    );
    await expect(
      wrapped("https://x/v1/chat/completions", { method: "POST", body: JSON.stringify({ messages: [] }) }),
    ).rejects.toThrow("network down");
  });

  test("assistant message with non-string reasoning_content is preserved as-is", () => {
    const out = applyOutboundDefense(
      { messages: [{ role: "assistant", content: "a", reasoning_content: { weird: true } }] },
      { provider: "deepseek", modelId: "deepseek-chat" },
    );
    expect(out.messages[0].reasoning_content).toEqual({ weird: true });
  });

  test("array body (not an object) passes through untouched", async () => {
    const fakeFetch = (async (_u: any, i: any) => new Response(i.body)) as unknown as typeof fetch;
    const wrapped = createOutboundDefenseFetch(
      { provider: "deepseek", modelId: "deepseek-chat" },
      fakeFetch,
    );
    const arrBody = "[1,2,3]";
    const res = await wrapped("https://x", { method: "POST", body: arrBody });
    expect(await res.text()).toBe(arrBody);
  });

  test("deepseek provider id variants all inject (deepseek, deepseek-cn)", () => {
    for (const p of ["deepseek", "deepseek-cn"]) {
      const out = applyOutboundDefense(
        { messages: [{ role: "assistant", content: "a" }] },
        { provider: p, modelId: "whatever" },
      );
      expect(out.messages[0].reasoning_content).toBe("");
    }
  });

  test("gateway + non-deepseek model does NOT inject (opencodego/kimi)", () => {
    const body = { messages: [{ role: "assistant", content: "a" }] };
    const out = applyOutboundDefense(body, { provider: "opencodego", modelId: "kimi-k2" });
    expect(JSON.stringify(out)).not.toContain("reasoning_content");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Task #4465 cross-validation C1: the wire protocol must follow the ENDPOINT,
// not the provider id.
// ───────────────────────────────────────────────────────────────────────────

describe("C1: protocol derived from endpoint (path A parity)", () => {
  test("wireProtocolFromApiProtocol maps every pi-ai protocol", async () => {
    const { wireProtocolFromApiProtocol } = await import("./outbound-defense");
    expect(wireProtocolFromApiProtocol("openai-completions")).toBe("openai-chat");
    expect(wireProtocolFromApiProtocol("openai-responses")).toBe("openai-responses");
    expect(wireProtocolFromApiProtocol("anthropic-messages")).toBe("anthropic");
    // Unknown → the safe default that both patches are valid on.
    expect(wireProtocolFromApiProtocol("something-else")).toBe("openai-chat");
    expect(wireProtocolFromApiProtocol(undefined)).toBe("openai-chat");
  });

  test("minimax pointing at an /anthropic endpoint must NOT receive OpenAI cache keys", async () => {
    // This is the real production config: providers.minimax.baseURL =
    // https://api.minimaxi.com/anthropic. Path A classifies it as
    // anthropic-messages, so path B must not send prompt_cache_key there.
    const { resolveApiProtocol } = await import("./adapter-pi-ai");
    const { wireProtocolFromApiProtocol, applyOutboundDefense } = await import("./outbound-defense");

    const apiProtocol = resolveApiProtocol("minimax", "https://api.minimaxi.com/anthropic");
    expect(apiProtocol).toBe("anthropic-messages");

    const out = applyOutboundDefense(
      { messages: [{ role: "assistant", content: "a" }] },
      {
        provider: "minimax",
        modelId: "MiniMax-M3",
        sessionId: "ses-mm",
        cacheRetention: "long",
        wireProtocol: wireProtocolFromApiProtocol(apiProtocol),
      },
    );
    expect("prompt_cache_key" in out).toBe(false);
    expect("prompt_cache_retention" in out).toBe(false);
    expect(JSON.stringify(out)).not.toContain("reasoning_content");
  });

  test("minimax pointing at a /v1 endpoint DOES receive OpenAI cache keys", async () => {
    const { resolveApiProtocol } = await import("./adapter-pi-ai");
    const { wireProtocolFromApiProtocol, applyOutboundDefense } = await import("./outbound-defense");

    const apiProtocol = resolveApiProtocol("minimax", "https://api.minimaxi.com/v1");
    expect(apiProtocol).toBe("openai-completions");

    const out = applyOutboundDefense(
      { messages: [{ role: "assistant", content: "a" }] },
      {
        provider: "minimax",
        modelId: "MiniMax-M3",
        sessionId: "ses-mm",
        cacheRetention: "long",
        wireProtocol: wireProtocolFromApiProtocol(apiProtocol),
      },
    );
    expect(out.prompt_cache_key).toBe("ses-mm");
    expect(out.prompt_cache_retention).toBe("24h");
  });

  test("production providers resolve to the expected protocol via resolveApiProtocol", async () => {
    const { resolveApiProtocol } = await import("./adapter-pi-ai");
    const { wireProtocolFromApiProtocol } = await import("./outbound-defense");
    const cases: Array<[string, string, string]> = [
      ["opencodego", "https://opencode.ai/inference/go/v1", "openai-chat"],
      ["deepseek", "https://api.deepseek.com", "openai-chat"],
      ["glm", "https://open.bigmodel.cn/api/paas/v4", "openai-chat"],
      ["ali", "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", "openai-chat"],
      ["anthropic", "https://api.anthropic.com", "anthropic"],
    ];
    for (const [provider, baseURL, expected] of cases) {
      expect(wireProtocolFromApiProtocol(resolveApiProtocol(provider, baseURL))).toBe(expected);
    }
  });
});
