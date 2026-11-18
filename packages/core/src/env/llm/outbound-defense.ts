/**
 * @fileoverview HTTP outbound defence middleware for the AI SDK (path B).
 *
 * ── Why this file exists (Task #4457 → #4465) ──────────────────────────
 *
 * roy-bot has TWO independent LLM request paths:
 *
 *   path A  `adapter-pi-ai.ts`  → pi-ai `stream()` / `complete()`
 *   path B  `invoke.ts`         → AI SDK `streamText()` / `generateText()`
 *
 * path A is the normal route. path B runs when path A fails — see
 * `llm.ts`: "adapter(pi-ai) failed, falling back to AI SDK invoke".
 *
 * Everything defensive was only ever wired into path A:
 *
 *   #4398/#4403  `reasoning_content: ""` on assistant messages (via pi-ai's
 *                `onPayload` hook) — path A only
 *   #4383        `prompt_cache_key` / `prompt_cache_retention` (via pi-ai's
 *                `buildPiCacheOptions`) — path A only
 *
 * Byte-level packet capture of a production fallback proved the gap:
 *
 *   | path                    | assistant msgs | with reasoning_content |
 *   |-------------------------|----------------|------------------------|
 *   | A `adapter.stream()`    |            149 |            149 (100%)  |
 *   | B `invoke()` (fallback) |            149 |              0 (0%)    |
 *
 * Same endpoint, same conversation — the only difference was path B. The
 * request came back `400 [invalid_request_error] The reasoning_content in the
 * thinking mode must be passed back to the API.`
 *
 * The capture also showed path B sending no cache keys at all, so every
 * fallback paid full input price.
 *
 * ── Why a fetch middleware, and not "patch the messages array" ─────────
 *
 * The obvious fix is to inject the field into the `ModelMessage[]` we hand the
 * SDK. That approach is **silently useless** here, for two independent reasons
 * discovered while localising this task:
 *
 *   1. `convertToSDKMessages()` writes cache options under the `openai`
 *      providerOptions key, but `@ai-sdk/openai-compatible` reads
 *      `openaiCompatible` / `<providerName>` and validates them against
 *      `openaiCompatibleLanguageModelChatOptions` — a schema with **no**
 *      `promptCacheKey` field at all. So the existing path B cache code has
 *      never emitted anything on the wire. (Confirmed by capture: 0 hits.)
 *
 *   2. The wire protocol is not always chat/completions. On
 *      `openai-responses` the top-level conversation list is `input`, not
 *      `messages`, so any messages-only patch is a no-op there.
 *
 * A `fetch` wrapper sits after all protocol conversion and after providerOptions
 * validation, so it sees exactly the bytes that go on the wire — and it is the
 * only option shared by all three provider factories (`createOpenAI`,
 * `createOpenAICompatible`, `createAnthropic`); `transformRequestBody` exists
 * on `openai-compatible` only.
 *
 * ── Cache-prefix safety (the constraint that shapes every decision here) ──
 *
 * Prompt caching is a PREFIX match: the bytes sent at turn N are the reusable
 * prefix at turn N+1. Therefore:
 *
 *   - the injected value is a constant `""`, appended at a deterministic
 *     position, on *every* assistant message of *every* turn;
 *   - the field is only added when absent (idempotent, no double-injection);
 *   - the guard is NARROW: non-DeepSeek providers never get the field, because
 *     they either reject unknown fields or hash assistant messages into their
 *     own prefix — injecting would be a pure cache regression.
 *
 * Both guarantees are covered by tests in `fallback-path-defense.test.ts`.
 */

import {
  shouldInjectReasoningContent,
  injectReasoningContent,
} from "./reasoning-defense";
import { clampOpenAIPromptCacheKey } from "./llm-cache";

/** Wire protocols we know how to patch. */
export type WireProtocol =
  | "openai-chat"
  | "openai-responses"
  | "anthropic"
  | "other";

export interface OutboundDefenseTarget {
  /** Configured provider id (may be a gateway, e.g. `opencodego`). */
  provider?: string;
  /** Model id actually requested — decides DeepSeek-family membership. */
  modelId?: string;
  /** Conversation id; becomes `prompt_cache_key` for OpenAI-family protocols. */
  sessionId?: string;
  /**
   * Cache retention preference, mirroring pi-ai's `cacheRetention`:
   *   - `"long"`  → `prompt_cache_key` + `prompt_cache_retention: "24h"`
   *   - `"short"` → `prompt_cache_key` only
   *   - `"none"`  → neither
   *
   * When omitted, OpenAI-family protocols default to `"long"` so path B
   * matches what path A does through `buildPiCacheOptions()` (which defaults
   * to `"long"` for `openai-completions`).
   */
  cacheRetention?: "none" | "short" | "long";
  /**
   * Restricts which patches may be applied. Omitted → auto-detect from the
   * body shape (permissive; used by unit tests and by callers that already
   * know the endpoint speaks OpenAI).
   *
   * Production passes this explicitly so an Anthropic request can never
   * receive OpenAI-only fields (`prompt_cache_key`) or a stray
   * `reasoning_content` that the Messages API would reject.
   */
  wireProtocol?: WireProtocol;
}

/** The keys that can hold a conversation list, per protocol. */
const CONVERSATION_LIST_KEYS = ["messages", "input"] as const;

/**
 * Locate the conversation list in a request body.
 *
 * `openai-chat` / `anthropic` use `messages`; `openai-responses` uses `input`.
 * Returns `null` when the body carries no recognisable list.
 */
function findConversationList(
  body: Record<string, unknown>,
  wireProtocol: WireProtocol | undefined,
): { key: string; list: unknown[] } | null {
  if (wireProtocol === "openai-responses") {
    return Array.isArray(body.input) ? { key: "input", list: body.input } : null;
  }
  if (wireProtocol === "openai-chat" || wireProtocol === "anthropic") {
    return Array.isArray(body.messages)
      ? { key: "messages", list: body.messages }
      : null;
  }
  // Auto-detect (protocol unspecified).
  for (const key of CONVERSATION_LIST_KEYS) {
    if (Array.isArray(body[key])) {
      return { key, list: body[key] as unknown[] };
    }
  }
  return null;
}

/**
 * Does this protocol accept the OpenAI-style prompt-cache fields?
 *
 * Anthropic uses in-body `cache_control` breakpoints instead (already handled
 * by `ANTHROPIC_CACHE_CONTROL` in `invoke.ts`), and unknown top-level fields
 * are not safe to send there.
 */
function protocolSupportsCacheKeys(wireProtocol: WireProtocol | undefined): boolean {
  return wireProtocol === undefined
    || wireProtocol === "openai-chat"
    || wireProtocol === "openai-responses";
}

/**
 * Does this protocol accept `reasoning_content` on assistant messages?
 *
 * Only the OpenAI-family ones. The Anthropic Messages API validates message
 * fields strictly and would reject it.
 *
 * KNOWN LIMITATION (Task #4465 cross-validation C4): on the `openai-responses`
 * protocol this field is *not* valid either — a responses `input` item has no
 * `reasoning_content` member. Today that combination is unreachable in
 * production, because it needs `providerId === "openai"` **and** a model id
 * containing `deepseek`, and no such provider is configured. But should someone
 * point an `openai`-id provider at a DeepSeek model via the responses API, this
 * gate would emit an invalid shape. Excluded deliberately rather than guessed
 * at: the only user-visible DeepSeek path is `openai-completions`.
 */
function protocolSupportsReasoningField(wireProtocol: WireProtocol | undefined): boolean {
  return wireProtocol === undefined
    || wireProtocol === "openai-chat"
    || wireProtocol === "openai-responses";
}

/**
 * Apply both defences to a parsed request body, returning a NEW object.
 *
 * Pure and synchronous, so it can be unit-tested without any HTTP machinery.
 * Returns the original reference when nothing changes, which keeps the
 * "untouched for non-DeepSeek providers" guarantee cheap to assert.
 */
export function applyOutboundDefense(
  body: Record<string, unknown>,
  target: OutboundDefenseTarget,
): Record<string, unknown> {
  let next: Record<string, unknown> | null = null;
  const writable = (): Record<string, unknown> => {
    if (!next) next = { ...body };
    return next;
  };

  // ── Goal 1: reasoning_content on every assistant message ──────────────
  if (
    protocolSupportsReasoningField(target.wireProtocol)
    && shouldInjectReasoningContent(target.provider, target.modelId)
  ) {
    const found = findConversationList(body, target.wireProtocol);
    if (found) {
      const injected = injectReasoningContent(found.list as any[]) as unknown[];
      // `injectReasoningContent` returns the same element references when a
      // message already carries the field, so a length/identity check tells us
      // whether anything actually changed.
      const changed = injected.some((m, i) => m !== found.list[i]);
      if (changed) writable()[found.key] = injected;
    }
  }

  // ── Goal 2: explicit prompt-cache markers ─────────────────────────────
  if (protocolSupportsCacheKeys(target.wireProtocol) && target.sessionId) {
    const retention = target.cacheRetention ?? "long";
    if (retention !== "none") {
      // `??=` semantics: never overwrite a key the SDK already set, so the
      // prefix bytes stay stable if AI SDK starts emitting these itself.
      if (body.prompt_cache_key === undefined) {
        writable().prompt_cache_key = clampOpenAIPromptCacheKey(target.sessionId);
      }
      if (retention === "long" && body.prompt_cache_retention === undefined) {
        writable().prompt_cache_retention = "24h";
      }
    }
  }

  return next ?? body;
}

/**
 * Wrap a `fetch` implementation with the outbound defences.
 *
 * The wrapper is deliberately fail-open: anything it cannot understand
 * (non-string body, unparsable JSON, unexpected shape) is forwarded to the
 * inner fetch **completely unchanged**. A broken defence must never turn a
 * recoverable LLM call into a hard failure — path B only runs *because* we are
 * already in a degraded state.
 *
 * @param target  provider/model/session of this call
 * @param inner   the fetch to delegate to (defaults to globalThis.fetch)
 */
export function createOutboundDefenseFetch(
  target: OutboundDefenseTarget,
  inner: typeof fetch = ((...args: Parameters<typeof fetch>) =>
    globalThis.fetch(...args)) as typeof fetch,
): typeof fetch {
  return (async (input: any, init?: any) => {
    if (!init || typeof init.body !== "string" || init.body.length === 0) {
      return inner(input, init);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(init.body);
    } catch {
      // Not JSON — someone else's payload. Hands off.
      return inner(input, init);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return inner(input, init);
    }

    let patched: Record<string, unknown>;
    try {
      patched = applyOutboundDefense(parsed as Record<string, unknown>, target);
    } catch {
      // Defence itself failed — never block the request over it.
      return inner(input, init);
    }

    if (patched === parsed) {
      // Nothing to change: forward the original bytes untouched so we cannot
      // accidentally alter serialisation (key order, number formatting, …).
      return inner(input, init);
    }

    return inner(input, { ...init, body: JSON.stringify(patched) });
  }) as typeof fetch;
}

/**
 * Map a pi-ai `apiProtocol` (the vocabulary `resolveApiProtocol()` speaks) onto
 * this module's wire-protocol vocabulary.
 *
 * Task #4465 cross-validation (C1): the initial implementation hardcoded the
 * wire protocol per *provider id*, but path A derives it from the **endpoint**
 * (`resolveApiProtocol(provider, baseURL)`). The two disagree for real configs —
 * e.g. the production `minimax` provider points at
 * `https://api.minimaxi.com/anthropic`, which path A classifies as
 * `anthropic-messages` while a per-id table says "OpenAI chat". Injecting
 * OpenAI-only `prompt_cache_key` onto an Anthropic-protocol endpoint would be
 * wrong (and pointless) there.
 *
 * So callers should derive the protocol the same way path A does and hand the
 * result through this mapper.
 */
export function wireProtocolFromApiProtocol(apiProtocol: string | undefined): WireProtocol {
  switch (apiProtocol) {
    case "openai-responses":
      return "openai-responses";
    case "anthropic-messages":
      return "anthropic";
    case "openai-completions":
      return "openai-chat";
    default:
      // Unknown protocol: assume OpenAI chat, which is the only shape both
      // patches are safe on. Callers that *know* the protocol should pass it
      // explicitly instead of relying on this fallback.
      return "openai-chat";
  }
}
