/**
 * Task #4625 — `Retry-After` runaway sleep → silent hang (unit layer).
 *
 * ## Bug (reproduced, 2026-10-29)
 *
 * ```
 * timeout 90 roy-bot act hi --model opencode/deepseek-v4.1-flash-free
 * # → EXIT=124, 0 bytes of output
 * ```
 *
 * Upstream answers `429 FreeUsageLimitError` with `Retry-After: 79229`.
 * `openai@6.26.0` `client.js:437-463` turns that header into the sleep duration
 * **with no cap**, and pi-ai never passes `maxRetries`, so the SDK's default of
 * 2 retries applies → the process sleeps 21.87 h, retries, sleeps 21.87 h, and
 * only then throws. Measured by intercepting `openai/internal/utils/sleep`:
 *
 *     SLEEP_CALLS = [78743000, 78742000]   // 43.75 h total
 *
 * ## Why the cap lives in roy-bot and not in pi-ai
 *
 * pi-ai forwards `maxRetries` / `timeoutMs` (`simple-options.js:13-15`) but has
 * **no** notion of a maximum retry delay: `maxRetryDelayMs` is plumbed into
 * `buildBaseOptions` and then never read anywhere (grep: one hit, the
 * assignment). It is a no-op and cannot bound the sleep. The only lever that
 * reaches the SDK is `maxRetries`.
 *
 * Bounding the *count* is sufficient because roy-bot already owns a bounded
 * retry layer: when the pi-ai path fails, `llm.ts` falls back to the AI SDK
 * `invoke()` path, whose `getRetryDelayInMs` clamps every delay to
 * `< 60s` (`ai/dist/index.js:2666-2678`). So `maxRetries: 0` does not mean
 * "no retries ever" — it means "the unbounded-sleep layer does not retry; the
 * bounded layer does". The companion integration test
 * (`retry-after-bound.integration.test.ts`) proves the whole chain then fails
 * within seconds instead of hanging.
 */
import { describe, test, expect, mock } from "bun:test";

/**
 * Mount a pi-ai mock that records the options object handed to it, then import
 * the adapter so each test can drive `chat()` / `stream()`.
 */
async function loadAdapterWithCapture(captured: any[]) {
  mock.module("@earendil-works/pi-ai", () => {
    const okMessage = (model: any) => ({
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    return {
      complete: async (model: any, _ctx: any, options: any) => {
        captured.push(options);
        return okMessage(model);
      },
      stream: (model: any, _ctx: any, options: any) => {
        captured.push(options);
        return {
          async *[Symbol.asyncIterator]() {
            /* no events */
          },
          result: async () => okMessage(model),
        };
      },
      getModel: () => undefined,
    };
  });
  const mod = await import("./adapter-pi-ai");
  return mod.PiAiAdapter;
}

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    provider: "opencode",
    modelId: "deepseek-v4.1-flash-free",
    messages: [{ role: "user", content: "hi" } as any],
    apiKey: "test-key",
    baseURL: "https://opencode.ai/inference/openai/v1",
    sessionId: "session_retry_after_test",
    ...overrides,
  } as any;
}

describe("Task #4625 A — bound the SDK-level retry sleep", () => {
  test("stream() passes maxRetries so a 429 Retry-After cannot sleep for hours", async () => {
    const captured: any[] = [];
    const PiAiAdapter = await loadAdapterWithCapture(captured);
    const adapter = new PiAiAdapter();

    await adapter.stream(baseRequest());

    expect(captured.length).toBeGreaterThan(0);
    const opts = captured[0];
    // `undefined` would let openai's default (2) apply, and each of those
    // retries may sleep for the full upstream `Retry-After` (21.87 h each).
    expect(typeof opts.maxRetries).toBe("number");
    expect(opts.maxRetries).toBe(0);
  });

  test("chat() passes the same bounded maxRetries as stream()", async () => {
    const captured: any[] = [];
    const PiAiAdapter = await loadAdapterWithCapture(captured);
    const adapter = new PiAiAdapter();

    await adapter.chat(baseRequest());

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0].maxRetries).toBe(0);
  });

  test("the retry cap is unconditional — every provider gets it, not just opencode", async () => {
    const captured: any[] = [];
    const PiAiAdapter = await loadAdapterWithCapture(captured);
    const adapter = new PiAiAdapter();

    // An ordinary provider must not stay exposed to the same runaway sleep:
    // the defect is in the transport, not in opencode.
    await adapter.stream(
      baseRequest({
        provider: "opencodego",
        modelId: "deepseek-v4.1-flash",
        baseURL: "https://opencode.ai/inference/go/v1",
      }),
    );

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0].maxRetries).toBe(0);
  });
});

describe("Task #4625 B — surface the failure as an accurate message", () => {
  test("classifyReactFailure recognizes the free-usage 429 as its own kind", async () => {
    const { classifyReactFailure } = await import("../error-reply");

    const err = new Error(
      "429 Free usage limit reached. Free models work in OpenCode " +
        "(https://opencode.ai); subscribe to OpenCode Go to keep going: " +
        "https://opencode.ai/go",
    );
    (err as any).status = 429;

    const info = classifyReactFailure(err);
    // The generic `upstream_retry` wording ("稍后重发一次即可") is actively wrong
    // here: the quota is exhausted for hours, so retrying now cannot succeed.
    expect(info.kind).toBe("quota_exhausted");
    expect(info.retryable).toBe(false);
  });

  test("the quota message tells the user roughly how long to wait", async () => {
    const { classifyReactFailure, buildFailureReplyMarkdown } = await import(
      "../error-reply"
    );

    const err = new Error("429 Free usage limit reached: subscribe to OpenCode Go");
    (err as any).status = 429;
    (err as any).headers = { "retry-after": "79229" };

    const info = classifyReactFailure(err);
    const md = buildFailureReplyMarkdown(info, {
      sessionId: "session_x",
      query: "hi",
    } as any);

    expect(md).toMatch(/小时|hour/i);
    expect(md).not.toMatch(/稍后重发一次即可/);
  });

  test("a plain 429 without a quota signal still classifies as upstream_retry", async () => {
    const { classifyReactFailure } = await import("../error-reply");

    const err = new Error("429 Too Many Requests");
    (err as any).status = 429;

    // Guard against over-matching: a transient rate limit must keep the
    // "retry now" advice, otherwise we would tell users to wait 22 hours for
    // something that clears in seconds.
    expect(classifyReactFailure(err).kind).toBe("upstream_retry");
  });
});

describe("Task #4625 C — one-line CLI failure summary", () => {
  test("quota exhaustion becomes a short Chinese line carrying the window", async () => {
    const { formatCliFailureLine } = await import("../error-reply");

    // Shape mirrors the real AI_RetryError: the Retry-After lives on the nested
    // APICallError, not on the wrapper — this is what the production chain
    // actually produces (verified against a real 429).
    const inner: any = new Error("Free usage limit reached: subscribe to OpenCode Go");
    inner.statusCode = 429;
    inner.responseHeaders = { "retry-after": "79229" };
    const outer: any = new Error(
      "Failed after 4 attempts. Last error: Free usage limit reached",
    );
    outer.name = "AI_RetryError";
    outer.errors = [inner];

    const line = formatCliFailureLine(outer);
    expect(line).toContain("额度");
    expect(line).toMatch(/小时/);
    // Must stay a single short line — a 7 KB stack dump is not a user message.
    expect(line.length).toBeLessThan(300);
    expect(line).not.toContain("\n");
  });

  test("an ordinary rate limit keeps the generic wording", async () => {
    const { formatCliFailureLine } = await import("../error-reply");
    const err: any = new Error("429 Too Many Requests");
    err.status = 429;
    const line = formatCliFailureLine(err);
    // Behaviour that matters: a transient rate limit must NOT be dressed up as
    // "wait ~22 hours", and the upstream status must still be visible so the
    // user can tell what happened.
    expect(line).not.toMatch(/小时|额度/);
    expect(line).toContain("429");
  });

  test("a non-429 error still produces a non-empty line (never silent)", async () => {
    const { formatCliFailureLine } = await import("../error-reply");
    const line = formatCliFailureLine(new Error("boom"));
    expect(line.length).toBeGreaterThan(0);
  });
});

describe("Task #4625 D — the recovery window survives the error-flattening boundary", () => {
  test("a flattened upstream error keeps its Retry-After reachable via cause", async () => {
    const { classifyReactFailure, formatCliFailureLine } = await import("../error-reply");

    // `environment.ts` rethrows `new Error(result.error)` — the message string
    // only. Everything structured (statusCode / responseHeaders / nested
    // APICallError) would be lost, including the Retry-After that tells the
    // user how long the quota needs. `cause` must carry the original object.
    const inner: any = new Error(
      "Free usage limit reached. Free models work in OpenCode; subscribe to OpenCode Go",
    );
    inner.name = "APICallError";
    inner.statusCode = 429;
    inner.responseHeaders = { "retry-after": "79229" };

    const flattened = new Error("Free usage limit reached.", { cause: inner });

    const info = classifyReactFailure(flattened);
    expect(info.kind).toBe("quota_exhausted");
    expect(info.retryAfterSeconds).toBe(79229);

    const line = formatCliFailureLine(flattened);
    expect(line).toMatch(/约 22 小时/);
  });
});

describe("Task #4625 E — adapter preserves the failing response's Retry-After", () => {
  test("stream() surfaces an error that still carries retry-after", async () => {
    const captured: any[] = [];
    mock.module("@earendil-works/pi-ai", () => ({
      complete: async () => ({ role: "assistant", content: [], stopReason: "stop" }),
      stream: (_model: any, _ctx: any, options: any) => {
        captured.push(options);
        return {
          async *[Symbol.asyncIterator]() {
            /* no deltas: this is what a 429 looks like */
          },
          result: async () => ({
            role: "assistant",
            content: [],
            api: "openai-completions",
            provider: "opencode",
            model: "deepseek-v4.1-flash-free",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
            stopReason: "error",
            errorMessage: "429 Free usage limit reached: subscribe to OpenCode Go",
            timestamp: Date.now(),
          }),
        };
      },
      getModel: () => undefined,
    }));

    const { PiAiAdapter } = await import("./adapter-pi-ai");
    const adapter = new PiAiAdapter();
    const handle = await adapter.stream(baseRequest());

    const opts = captured[0];
    // pi-ai exposes the raw response via onResponse. The adapter must use it,
    // because pi-ai itself flattens the upstream error into `errorMessage`
    // (a plain string) and drops responseHeaders — so this hook is the only
    // surviving carrier of `Retry-After`.
    expect(typeof opts.onResponse).toBe("function");
    opts.onResponse(
      { status: 429, headers: { "retry-after": "79229" } },
      { id: "deepseek-v4.1-flash-free" },
    );

    // result() must reject with something the classifier can mine.
    const err = await handle.result().then(
      () => { throw new Error("expected result() to reject"); },
      (e: unknown) => e,
    );

    const { extractRetryAfterSeconds } = await import("../error-reply");
    expect(extractRetryAfterSeconds(err)).toBe(79229);
  });
});

describe("Task #4625 F — provider error enrichment", () => {
  test("buildProviderError carries status + retry-after so the window is recoverable", async () => {
    const { buildProviderError } = await import("./adapter-pi-ai");
    const { extractRetryAfterSeconds } = await import("../error-reply");

    const err = buildProviderError("429 Free usage limit reached", {
      status: 429,
      headers: { "retry-after": "79229" },
    });

    expect(err.message).toContain("Free usage limit");
    expect(extractRetryAfterSeconds(err)).toBe(79229);
  });

  test("buildProviderError without a capture still yields a usable Error", async () => {
    const { buildProviderError } = await import("./adapter-pi-ai");
    const err = buildProviderError("boom", undefined);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("boom");
  });

  test("a captured response survives the invoke() → llm.ts stringify boundary via cause", async () => {
    const { classifyReactFailure, formatCliFailureLine } = await import("../error-reply");

    // Reproduces the production chain after the fix:
    //   invoke() returns { result: <redacted string>, originalError: <APICallError> }
    //   llm.ts  throws new Error(result.result, { cause: result.originalError })
    const apiErr: any = new Error("Free usage limit reached");
    apiErr.name = "AI_APICallError";
    apiErr.statusCode = 429;
    apiErr.responseHeaders = { "retry-after": "79229" };

    const flattened = new Error(apiErr.message, { cause: apiErr });

    expect(classifyReactFailure(flattened).kind).toBe("quota_exhausted");
    expect(formatCliFailureLine(flattened)).toMatch(/约 22 小时/);
  });
});

describe("Task #4625 G — the cause channel must not leak secrets (review MAJOR-1)", () => {
  /**
   * The `cause` channel exists so `Retry-After` survives. Its side effect is
   * that the *raw* upstream Error — the one `invoke.ts` deliberately redacts
   * before putting it in `result.result` — becomes reachable again, and
   * `classifyReactFailure()` walks `cause` when building `technical`, which is
   * rendered straight into the user-facing failure reply.
   *
   * So the redaction that `invoke.ts` applies to the string must also be
   * applied at the sink.
   */
  test("an API key inside cause never reaches the user-facing reply", async () => {
    const { classifyReactFailure, buildFailureReplyMarkdown } = await import("../error-reply");

    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";
    const raw: any = new Error(
      `401 Incorrect API key provided: ${secret} for url https://api.example/v1/chat`,
    );
    raw.name = "AI_APICallError";
    raw.statusCode = 401;

    // Exactly what invoke.ts produces: redacted string + raw originalError.
    const flattened = new Error("401 Incorrect API key provided: <redacted>", {
      cause: raw,
    });

    const info = classifyReactFailure(flattened);
    const md = buildFailureReplyMarkdown(info, { query: "hi" });

    expect(info.technical ?? "").not.toContain(secret);
    expect(md).not.toContain(secret);
  });

  test("a Bearer token inside cause is redacted too", async () => {
    const { classifyReactFailure } = await import("../error-reply");

    const raw: any = new Error(
      "401 Unauthorized: Bearer abcdefghijklmnop1234567890 rejected",
    );
    raw.statusCode = 401;

    const flattened = new Error("401 Unauthorized", { cause: raw });
    const info = classifyReactFailure(flattened);

    expect(info.technical ?? "").not.toContain("abcdefghijklmnop1234567890");
  });

  test("redaction does not destroy the Retry-After signal", async () => {
    const { classifyReactFailure, formatCliFailureLine } = await import("../error-reply");

    const raw: any = new Error(
      "429 Free usage limit reached (key sk-proj-abcdefghijklmnopqrstuvwxyz123456)",
    );
    raw.statusCode = 429;
    raw.responseHeaders = { "retry-after": "79229" };

    const info = classifyReactFailure(new Error("429 Free usage limit reached", { cause: raw }));

    expect(info.kind).toBe("quota_exhausted");
    expect(formatCliFailureLine(new Error("x", { cause: raw }))).toMatch(/约 22 小时/);
  });
});

describe("Task #4625 H — any key format, not just sk-/Bearer (review MAJOR-1 residual)", () => {
  /**
   * Pattern-based redaction only recognises `sk-…`, `oc_sk_…` and `Bearer …`.
   * Real providers use other shapes: MiniMax ships JWT-style `eyJ…` keys, and
   * many gateways use UUID / random-hash access keys. Those sail straight
   * through the regexes.
   *
   * The only reliable way is to scrub with the *known* secret value — but
   * `classifyReactFailure()` never sees the apiKey. So the sanitiser has to run
   * where the key IS known (`invoke.ts`) and the redacted copy is what travels.
   */
  test("a non-standard key format is redacted by value, not by pattern", async () => {
    const { redactErrorForTransport } = await import("./redact");
    const { classifyReactFailure, buildFailureReplyMarkdown } = await import("../error-reply");

    const apiKey = "ary8Fj2kLmNoPqRsTuVwXyZ"; // no sk- prefix, no Bearer
    // A genuine quota 429 so the same fixture proves both "no leak" and
    // "the diagnosis still works" (review MINOR-9).
    const raw: any = new Error(`429 Free usage limit reached (key ${apiKey})`);
    raw.statusCode = 429;
    raw.responseHeaders = { "retry-after": "79229" };

    // What invoke.ts must hand over instead of the raw error.
    const safe = redactErrorForTransport(raw, [apiKey]);

    const flattened = new Error("403 Forbidden", { cause: safe });
    const info = classifyReactFailure(flattened);
    const md = buildFailureReplyMarkdown(info, { query: "hi" });

    expect(info.technical ?? "").not.toContain(apiKey);
    expect(md).not.toContain(apiKey);
    // Review MINOR-9: redaction must not cost the diagnosis, so assert the
    // classification too — not just "no leak".
    expect(info.kind).toBe("quota_exhausted");
    expect(info.retryAfterSeconds).toBe(79229);
  });

  test("redactErrorForTransport keeps the fields the classifier needs", async () => {
    const { redactErrorForTransport } = await import("./redact");
    const { extractRetryAfterSeconds } = await import("../error-reply");

    const apiKey = "ary8Fj2kLmNoPqRsTuVwXyZ";
    const raw: any = new Error(`429 Free usage limit reached (key ${apiKey})`);
    raw.name = "AI_APICallError";
    raw.statusCode = 429;
    raw.responseHeaders = { "retry-after": "79229" };

    const safe: any = redactErrorForTransport(raw, [apiKey]);

    // Redaction must not cost us the recovery window.
    expect(extractRetryAfterSeconds(safe)).toBe(79229);
    expect(safe.statusCode).toBe(429);
    expect(String(safe.message)).not.toContain(apiKey);
  });

  test("the stack is scrubbed too (stacks embed URLs and can embed keys)", async () => {
    const { redactErrorForTransport } = await import("./redact");

    const apiKey = "ary8Fj2kLmNoPqRsTuVwXyZ";
    const raw: any = new Error("boom");
    raw.stack = `Error: boom\n    at fetch (https://api.x/v1?key=${apiKey})`;

    const safe: any = redactErrorForTransport(raw, [apiKey]);
    expect(String(safe.stack)).not.toContain(apiKey);
  });
});

describe("Task #4625 I — non-enumerable cause must survive redaction (review MINOR-7)", () => {
  /**
   * `new Error(msg, {cause})` defines `cause` as **non-enumerable**, and same for
   * `AggregateError.errors`. A copy built from `Object.keys()` therefore drops
   * them, `extractRetryAfterSeconds()` comes back empty, and the CLI degrades to
   * "恢复时间未知" — i.e. the exact regression this task exists to fix.
   *
   * Not fatal on today's production path (both producers attach `cause` as a
   * plain enumerable property), but any future `new Error(msg, {cause})` wrapper
   * would silently reintroduce it.
   */
  test("a native {cause} option keeps its retry-after through redaction", async () => {
    const { redactErrorForTransport } = await import("./redact");
    const { extractRetryAfterSeconds, classifyReactFailure } = await import("../error-reply");

    const src = new Error("Free usage limit reached", {
      cause: {
        statusCode: 429,
        responseHeaders: { "retry-after": "79229" },
      } as any,
    });

    const safe: any = redactErrorForTransport(src, ["k"]);

    expect(extractRetryAfterSeconds(safe)).toBe(79229);
    expect(classifyReactFailure(new Error(src.message, { cause: safe })).retryAfterSeconds).toBe(79229);
  });

  test("AggregateError.errors is preserved too", async () => {
    const { redactErrorForTransport } = await import("./redact");
    const { extractRetryAfterSeconds } = await import("../error-reply");

    const inner: any = new Error("429 Free usage limit reached");
    inner.statusCode = 429;
    inner.responseHeaders = { "retry-after": "79229" };

    const agg = new AggregateError([inner], "all attempts failed");
    const safe: any = redactErrorForTransport(agg, ["k"]);

    expect(extractRetryAfterSeconds(safe)).toBe(79229);
  });
});

describe("Task #4625 J — credential-bearing payload fields are scrubbed (review MINOR-6)", () => {
  test("a key echoed inside requestBodyValues / responseHeaders / url is redacted", async () => {
    const { redactErrorForTransport } = await import("./redact");

    const key = "ary8Fj2kLmNoPqRsTuVwXyZ";
    const raw: any = new Error("boom");
    raw.url = `https://api.x/v1?key=${key}`;
    raw.requestBodyValues = { apiKey: key, model: "m" };
    raw.responseHeaders = { "x-debug": `token=${key}` };

    const safe = redactErrorForTransport(raw, [key]);
    const json = JSON.stringify(safe);

    expect(json).not.toContain(key);
    // and the harmless payload is still there
    expect(json).toContain('"model":"m"');
  });
});
