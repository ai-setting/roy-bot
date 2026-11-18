/**
 * @fileoverview path B (AI SDK `invoke.ts`) must carry the same outbound
 * defences that path A (pi-ai adapter) already has.
 *
 * ── Business trigger (Task #4457 → #4465) ─────────────────────────────
 *
 * Production failure, byte-level packet capture:
 *
 *   21:53:15.127 [WARN]  adapter(pi-ai) failed, falling back to AI SDK invoke:
 *                        429 Endpoint is unavailable.
 *   21:53:17.492 [ERROR] AI_APICallError: reasoning_content ... ee31113b
 *
 * path A streamed half the answer, hit a transient gateway 429, and the LLM
 * component fell back to path B. Both paths POST to the same endpoint with the
 * same 149 assistant messages, yet:
 *
 *   | path                    | assistant | with reasoning_content |
 *   |-------------------------|-----------|------------------------|
 *   | A `adapter.stream()`    |       149 |            149 (100%)  |
 *   | B `invoke()` (fallback) |       149 |              0 (0%)    |
 *
 * So the defence added by #4398/#4403 never runs on the fallback path, and the
 * request is rejected with 400.
 *
 * The same capture also showed path B drops `prompt_cache_key` /
 * `prompt_cache_retention` — i.e. the #4383 cache optimisation is *also*
 * path-A-only. Every fallback therefore paid full input price.
 *
 * ── Why these tests look at the wire body ─────────────────────────────
 *
 * The obvious fix ("add the field to the messages array we hand the SDK") is
 * silently useless: `@ai-sdk/openai-compatible` validates `providerOptions`
 * through `openaiCompatibleLanguageModelChatOptions`, which has **no**
 * `promptCacheKey` field at all, and the existing `convertToSDKMessages()`
 * writes to the `openai` key while the provider reads `openaiCompatible` /
 * `<providerName>`. Code-level assertions would therefore pass while the wire
 * stays empty — exactly the trap #4457 fell into.
 *
 * Hence every meaningful assertion here reads the **actual serialised HTTP
 * body**, either directly (middleware unit tests) or through the real AI SDK
 * provider (`doGenerate` integration test with a stubbed `fetch`).
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";

import { createOutboundDefenseFetch } from "./outbound-defense";

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

interface CapturedCall {
  url: string;
  init: RequestInit;
  body: Record<string, unknown> | null;
}

/** Build a fake `fetch` that records what the provider actually serialised. */
function makeCapturingFetch(): { fetch: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fakeFetch = (async (url: any, init: any) => {
    const raw = init?.body;
    let body: Record<string, unknown> | null = null;
    if (typeof raw === "string") {
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
    }
    calls.push({ url: String(url), init, body });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch, calls };
}

/** A conversation shaped like the production one: many assistant turns. */
function buildConversation(assistantCount: number) {
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "start" },
  ];
  for (let i = 0; i < assistantCount; i++) {
    messages.push({ role: "assistant", content: `answer ${i}` });
    messages.push({ role: "user", content: `follow-up ${i}` });
  }
  return messages;
}

function assistantMessages(list: unknown[]): Array<Record<string, unknown>> {
  return list.filter(
    (m): m is Record<string, unknown> =>
      !!m && typeof m === "object" && (m as Record<string, unknown>).role === "assistant",
  );
}

/** Invoke the middleware and return the body it handed to the inner fetch. */
async function runMiddleware(
  target: Parameters<typeof createOutboundDefenseFetch>[0],
  body: Record<string, unknown>,
  url = "https://opencode.ai/inference/go/v1/chat/completions",
): Promise<{ sent: Record<string, unknown> | null; call: CapturedCall }> {
  const capture = makeCapturingFetch();
  const wrapped = createOutboundDefenseFetch(target, capture.fetch);
  await wrapped(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(capture.calls.length).toBe(1);
  return { sent: capture.calls[0].body, call: capture.calls[0] };
}

// ───────────────────────────────────────────────────────────────────────────
// Goal 1 — reasoning_content defence on path B
// ───────────────────────────────────────────────────────────────────────────

describe("path B fallback: reasoning_content defense (Task #4465)", () => {
  test("outgoing wire body carries reasoning_content on EVERY assistant message (deepseek via gateway)", async () => {
    const conversation = buildConversation(149);
    const { sent } = await runMiddleware(
      { provider: "opencodego", modelId: "deepseek-v4.1-flash" },
      { model: "deepseek-v4.1-flash", messages: conversation },
    );

    expect(sent).not.toBeNull();
    const list = sent!.messages as unknown[];
    expect(Array.isArray(list)).toBe(true);

    const asst = assistantMessages(list);
    expect(asst.length).toBe(149);
    const withRc = asst.filter((m) => "reasoning_content" in m);
    // 100% coverage — this is the exact number the packet capture showed as 0.
    expect(withRc.length).toBe(149);
    for (const m of withRc) expect(m.reasoning_content).toBe("");

    // Non-assistant messages must be left alone.
    for (const m of list as Array<Record<string, unknown>>) {
      if (m.role !== "assistant") expect("reasoning_content" in m).toBe(false);
    }
  });

  test("existing reasoning_content (a real thinking trace) is preserved, not overwritten", async () => {
    const { sent } = await runMiddleware(
      { provider: "deepseek", modelId: "deepseek-chat" },
      {
        model: "deepseek-chat",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "a", reasoning_content: "real trace" },
          { role: "assistant", content: "b" },
        ],
      },
    );
    const asst = assistantMessages(sent!.messages as unknown[]);
    expect(asst[0].reasoning_content).toBe("real trace");
    expect(asst[1].reasoning_content).toBe("");
  });

  test("non-deepseek provider is untouched — byte-identical body (no cache regression for glm)", async () => {
    const conversation = buildConversation(20);
    const original = { model: "glm-5.2", messages: conversation };
    const { sent } = await runMiddleware(
      { provider: "glm", modelId: "glm-5.2" },
      original,
    );
    // Byte-for-byte identical serialisation: nothing was injected.
    expect(JSON.stringify(sent)).toBe(JSON.stringify(original));
    expect(JSON.stringify(sent)).not.toContain("reasoning_content");
  });

  test("openai-responses protocol is covered too — body uses `input`, not `messages`", async () => {
    // The reason 方案 B (patch the messages array) was rejected: on the
    // responses protocol the top-level list is `input`, so a messages-only fix
    // silently does nothing. The middleware must find whichever key is present.
    const input = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "a" },
      { role: "assistant", content: "b" },
    ];
    const { sent } = await runMiddleware(
      { provider: "openai", modelId: "deepseek-v3" },
      { model: "deepseek-v3", input },
      "https://api.openai.com/v1/responses",
    );

    expect(sent!.messages).toBeUndefined();
    const asst = assistantMessages(sent!.input as unknown[]);
    expect(asst.length).toBe(2);
    expect(asst.every((m) => "reasoning_content" in m)).toBe(true);
  });

  test("idempotent: running the middleware twice does not double-inject", async () => {
    const body = { model: "deepseek-chat", messages: buildConversation(5) };
    const first = await runMiddleware({ provider: "deepseek", modelId: "deepseek-chat" }, body);
    const second = await runMiddleware(
      { provider: "deepseek", modelId: "deepseek-chat" },
      first.sent as Record<string, unknown>,
    );
    expect(JSON.stringify(second.sent)).toBe(JSON.stringify(first.sent));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Goal 2 — cache fields on path B
// ───────────────────────────────────────────────────────────────────────────

describe("path B fallback: cache fields (Task #4465, parity with #4383)", () => {
  test("prompt_cache_key is present when a sessionId is available", async () => {
    const { sent } = await runMiddleware(
      { provider: "opencodego", modelId: "deepseek-v4.1-flash", sessionId: "session_abc123" },
      { model: "deepseek-v4.1-flash", messages: buildConversation(3) },
    );
    expect(sent!.prompt_cache_key).toBe("session_abc123");
  });

  test("prompt_cache_retention is present when retention is long", async () => {
    const { sent } = await runMiddleware(
      {
        provider: "opencodego",
        modelId: "deepseek-v4.1-flash",
        sessionId: "session_abc123",
        cacheRetention: "long",
      },
      { model: "deepseek-v4.1-flash", messages: buildConversation(3) },
    );
    expect(sent!.prompt_cache_retention).toBe("24h");
  });

  test("no cache fields are invented when there is no sessionId", async () => {
    const { sent } = await runMiddleware(
      { provider: "opencodego", modelId: "deepseek-v4.1-flash" },
      { model: "deepseek-v4.1-flash", messages: buildConversation(3) },
    );
    expect("prompt_cache_key" in sent!).toBe(false);
    expect("prompt_cache_retention" in sent!).toBe(false);
  });

  test("cache fields are applied for non-deepseek targets too (glm must not lose its cache)", async () => {
    const { sent } = await runMiddleware(
      { provider: "glm", modelId: "glm-5.2", sessionId: "ses_glm_1", cacheRetention: "long" },
      { model: "glm-5.2", messages: buildConversation(2) },
    );
    expect(sent!.prompt_cache_key).toBe("ses_glm_1");
    expect(sent!.prompt_cache_retention).toBe("24h");
    // …but reasoning_content still must NOT be injected for glm.
    expect(JSON.stringify(sent)).not.toContain("reasoning_content");
  });

  test("over-long sessionId is clamped so the key stays <= 64 chars (OpenAI limit)", async () => {
    const longId = "session_" + "x".repeat(120);
    const { sent } = await runMiddleware(
      { provider: "deepseek", modelId: "deepseek-chat", sessionId: longId },
      { model: "deepseek-chat", messages: buildConversation(1) },
    );
    expect(typeof sent!.prompt_cache_key).toBe("string");
    expect((sent!.prompt_cache_key as string).length).toBeLessThanOrEqual(64);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Safety — the middleware must never make things worse
// ───────────────────────────────────────────────────────────────────────────

describe("path B fallback: middleware safety", () => {
  test("stream flag and all unrelated fields survive untouched", async () => {
    const { sent, call } = await runMiddleware(
      { provider: "opencodego", modelId: "deepseek-v4.1-flash", sessionId: "s1" },
      {
        model: "deepseek-v4.1-flash",
        stream: true,
        stream_options: { include_usage: true },
        temperature: 0.3,
        messages: buildConversation(2),
      },
    );
    expect(sent!.stream).toBe(true);
    expect(sent!.stream_options).toEqual({ include_usage: true });
    expect(sent!.temperature).toBe(0.3);
    // Headers must not be dropped — x-opencode-session lives there.
    const headers = (call.init.headers ?? {}) as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
  });

  test("non-JSON body passes through unchanged (never throws)", async () => {
    const capture = makeCapturingFetch();
    const wrapped = createOutboundDefenseFetch(
      { provider: "deepseek", modelId: "deepseek-chat", sessionId: "s" },
      capture.fetch,
    );
    const weird = "this is not json at all";
    await wrapped("https://x/v1/chat/completions", { method: "POST", body: weird });
    expect(capture.calls[0].init.body).toBe(weird);
  });

  test("missing body (GET / no body) passes through unchanged", async () => {
    const capture = makeCapturingFetch();
    const wrapped = createOutboundDefenseFetch(
      { provider: "deepseek", modelId: "deepseek-chat", sessionId: "s" },
      capture.fetch,
    );
    await wrapped("https://x/v1/models", { method: "GET" });
    expect(capture.calls[0].init.body).toBeUndefined();
  });

  test("the upstream Response is returned as-is (stream body not consumed)", async () => {
    const capture = makeCapturingFetch();
    const wrapped = createOutboundDefenseFetch(
      { provider: "deepseek", modelId: "deepseek-chat" },
      capture.fetch,
    );
    const res = await wrapped("https://x/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(capture.calls.length).toBe(1);
  });

  test("an empty assistant list does not crash", async () => {
    const { sent } = await runMiddleware(
      { provider: "deepseek", modelId: "deepseek-chat" },
      { model: "deepseek-chat", messages: [{ role: "user", content: "only user" }] },
    );
    expect(Array.isArray(sent!.messages)).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Integration — real @ai-sdk/openai-compatible, real serialisation
// ───────────────────────────────────────────────────────────────────────────

describe("path B fallback: real AI SDK wire body (integration)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("createProviderInstance(...).doGenerate sends reasoning_content + prompt_cache_key on the wire", async () => {
    // Import the REAL provider factory (no module mock in this file) so the
    // serialisation under test is the one production actually uses.
    const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
    const capture = makeCapturingFetch();

    const provider = createOpenAICompatible({
      name: "opencodego",
      apiKey: "test-key",
      baseURL: "https://opencode.ai/inference/go/v1",
      includeUsage: true,
      fetch: createOutboundDefenseFetch(
        {
          provider: "opencodego",
          modelId: "deepseek-v4.1-flash",
          sessionId: "session_wire_1",
          cacheRetention: "long",
        },
        capture.fetch,
      ),
    });

    const model = provider.languageModel("deepseek-v4.1-flash");

    // The model only needs to reach the point where the request is sent; we
    // stub the response so doGenerate resolves, then inspect the captured body.
    try {
      await (model as any).doGenerate({
        prompt: [
          { role: "system", content: "sys" },
          { role: "user", content: [{ type: "text", text: "hello" }] },
          { role: "assistant", content: [{ type: "text", text: "answer 1" }] },
          { role: "user", content: [{ type: "text", text: "again" }] },
          { role: "assistant", content: [{ type: "text", text: "answer 2" }] },
        ],
        abortSignal: undefined,
      });
    } catch {
      // Response parsing may reject our stub payload — irrelevant here, we only
      // care that the request was actually serialised and sent.
    }

    expect(capture.calls.length).toBeGreaterThanOrEqual(1);
    const body = capture.calls[0].body!;
    expect(body).not.toBeNull();

    // Goal 1: assistant messages on the real wire carry reasoning_content.
    const asst = assistantMessages(body.messages as unknown[]);
    expect(asst.length).toBe(2);
    expect(asst.every((m) => m.reasoning_content === "")).toBe(true);

    // Goal 2: cache fields on the real wire.
    expect(body.prompt_cache_key).toBe("session_wire_1");
    expect(body.prompt_cache_retention).toBe("24h");

    // Sanity: the request went to the chat/completions endpoint.
    expect(capture.calls[0].url).toContain("/chat/completions");
  });

  test("glm on the real wire: cache fields present, reasoning_content absent", async () => {
    const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
    const capture = makeCapturingFetch();

    const provider = createOpenAICompatible({
      name: "glm",
      apiKey: "test-key",
      baseURL: "https://open.bigmodel.cn/api/paas/v4",
      fetch: createOutboundDefenseFetch(
        { provider: "glm", modelId: "glm-5.2", sessionId: "ses_glm", cacheRetention: "long" },
        capture.fetch,
      ),
    });

    try {
      await (provider.languageModel("glm-5.2") as any).doGenerate({
        prompt: [
          { role: "user", content: [{ type: "text", text: "hello" }] },
          { role: "assistant", content: [{ type: "text", text: "answer" }] },
        ],
      });
    } catch {
      /* stub response parse failure is fine */
    }

    const body = capture.calls[0].body!;
    expect(body.prompt_cache_key).toBe("ses_glm");
    expect(JSON.stringify(body)).not.toContain("reasoning_content");
  });
});
