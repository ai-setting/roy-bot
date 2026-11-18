/**
 * @fileoverview PiAiAdapter — 包装 @earendil-works/pi-ai。
 *
 * 这是 roy-bot 默认的 LLM 适配层（ROY_LLM_PROVIDER=pi-ai 时启用）。
 * 把 ChatRequest / ChatResponse / StreamHandle 翻译成 pi-ai 的
 * complete() / stream() / getModel() 三件套。
 *
 * 关键映射：
 * - provider/modelId → getModel(provider, modelId)
 * - LLMMessage[] → pi-ai Context.messages
 * - AssistantMessage.stopReason → ChatResponse.finishReason
 * - usage {input, output, totalTokens} → UsageInfo
 */
import {
  complete,
  stream as piStream,
  getModel,
  type Model,
  type Context,
  type AssistantMessage,
  type CacheRetention,
} from "@earendil-works/pi-ai";
import type {
  LLMAdapter,
  ChatRequest,
  ChatResponse,
  StreamHandle,
  ResolvedProvider,
  EmbedRequest,
  EmbedResponse,
} from "./adapter";
import type { LLMMessage, ToolInfo } from "./types";
import { TracedAs } from "../log-trace/decorator";
import { embedParamFilter, embedResultFilter } from "../log-trace/trace-filters";
import { createLogger } from "../log-trace/logger";
import { zodToJsonSchema } from "zod-to-json-schema";
import { toolParametersToJsonSchema, isZodSchema } from "./tool-schema";
import { sniffImageMime } from "../../utils/media";
import { buildOpencodeHeaders } from "./opencode-session";
import { createReasoningDefenseHook } from "./reasoning-defense";
import { redactSecrets } from "./redact";

const logger = createLogger("llm:adapter-pi-ai");

/**
 * Known provider list — 驱动 resolveProvider 的硬编码能力映射
 *
 * `apiProtocol`（Task #4383 P1）是**显式**协议声明，优先于任何 baseURL 猜测。
 * 历史背景：`api` 字段曾被 `resolvePiModel()` 里的字面量特判
 * （`baseURL?.includes("anthropic")`）绕过 —— minimax 因为真实 baseURL 恰好是
 * `https://api.minimaxi.com/anthropic` 才「误打误撞」走对 anthropic-messages，
 * 从而成为三家 provider 里唯一挂上显式 `cache_control` 的那个（#4381 实测 99.86%）。
 * 现在把它变成声明式的，避免「换个 baseURL 就悄悄改了协议」。
 *
 * `api` 保留为**向后兼容**的遗留字段（只在既无 `apiProtocol` 也无 baseURL 线索时兜底）。
 */
export const KNOWN_PROVIDER_APIS: Record<
  string,
  { api: string; apiProtocol?: string; contextLimit: number; maxTokensLimit: number }
> = {
  anthropic: {
    api: "anthropic-messages",
    apiProtocol: "anthropic-messages",
    contextLimit: 200000,
    maxTokensLimit: 8192,
  },
  openai: {
    api: "openai-responses",
    apiProtocol: "openai-responses",
    contextLimit: 128000,
    maxTokensLimit: 16384,
  },
  google: {
    api: "google-generative-ai",
    apiProtocol: "google-generative-ai",
    contextLimit: 1000000,
    maxTokensLimit: 8192,
  },
  "google-vertex": {
    api: "google-vertex",
    apiProtocol: "google-vertex",
    contextLimit: 1000000,
    maxTokensLimit: 8192,
  },
  deepseek: {
    api: "openai-completions",
    apiProtocol: "openai-completions",
    contextLimit: 64000,
    maxTokensLimit: 8192,
  },
  // Task #4383 P1: glm 过去**完全不在**这张表里，靠 `|| "openai-completions"`
  // 兜底才「巧合正确」。显式声明后语义清晰，也补齐 context/maxTokens 能力映射。
  glm: {
    api: "openai-completions",
    apiProtocol: "openai-completions",
    contextLimit: 128000,
    maxTokensLimit: 8192,
  },
  xai: {
    api: "openai-completions",
    apiProtocol: "openai-completions",
    contextLimit: 131072,
    maxTokensLimit: 8192,
  },
  groq: {
    api: "openai-completions",
    apiProtocol: "openai-completions",
    contextLimit: 32768,
    maxTokensLimit: 8192,
  },
  // Task #4383 P1: minimax 官方端点（api.minimaxi.com/anthropic）是
  // Anthropic Messages 兼容协议 —— 显式声明，不再依赖 baseURL 里有没有 "anthropic"。
  minimax: {
    api: "anthropic-messages",
    apiProtocol: "anthropic-messages",
    contextLimit: 128000,
    maxTokensLimit: 8192,
  },
  "minimax-cn": {
    api: "anthropic-messages",
    apiProtocol: "anthropic-messages",
    contextLimit: 128000,
    maxTokensLimit: 8192,
  },
  moonshotai: {
    api: "openai-completions",
    apiProtocol: "openai-completions",
    contextLimit: 128000,
    maxTokensLimit: 8192,
  },
  "kimi-coding": {
    api: "openai-completions",
    apiProtocol: "openai-completions",
    contextLimit: 128000,
    maxTokensLimit: 8192,
  },
};

/**
 * Providers that expose **multiple official endpoints with different wire
 * protocols under the same provider id** (Task #4383 P1).
 *
 * MiniMax publishes both:
 *   - `https://api.minimaxi.com/anthropic` → Anthropic Messages compatible
 *   - `https://api.minimaxi.com/v1`        → OpenAI compatible
 * so no single constant is correct for them — the configured endpoint decides.
 *
 * Previously this decision lived as a buried ternary
 * (`baseURL?.includes("anthropic") ? "anthropic-messages" : "openai-completions"`)
 * inlined for `provider === "minimax" || "minimax-cn"`, which is exactly why
 * #4381 concluded minimax's cache behaviour was working "by accident".
 * Declaring the mapping as data keeps the behaviour but makes it explicit,
 * testable and auditable.
 *
 * Order matters: **longest `pathIncludes` first**. This keeps the match
 * unambiguous even for adversarial URLs: with `/v1` listed before
 * `/anthropic`, a hypothetical `https://api.minimaxi.com/v1/anthropic` would
 * also resolve to anthropic-messages — but ordering by length means the most
 * specific declared segment always wins, so the table stays predictable.
 */
const PROVIDER_ENDPOINT_APIS: Record<string, Array<{ pathIncludes: string; apiProtocol: string }>> = {
  minimax: [
    { pathIncludes: "/anthropic", apiProtocol: "anthropic-messages" },
    { pathIncludes: "/v1", apiProtocol: "openai-completions" },
  ],
  "minimax-cn": [
    { pathIncludes: "/anthropic", apiProtocol: "anthropic-messages" },
    { pathIncludes: "/v1", apiProtocol: "openai-completions" },
  ],
};

/**
 * Match an endpoint rule, preferring the most specific (longest) `pathIncludes`.
 *
 * Pre-computed sort keys keep this allocation-free at call time; the table is
 * tiny so the sort runs once at module load.
 */
const ENDPOINT_RULES_SORTED: Record<string, Array<{ pathIncludes: string; apiProtocol: string }>> =
  Object.fromEntries(
    Object.entries(PROVIDER_ENDPOINT_APIS).map(([provider, rules]) => [
      provider,
      [...rules].sort((a, b) => b.pathIncludes.length - a.pathIncludes.length),
    ]),
  );

/**
 * Provider id → protocol override for ids that are spelled differently on
 * purpose (they pin a *non-default* protocol for the same vendor).
 *
 * Kept separate from `KNOWN_PROVIDER_APIS` because these are *id variants*,
 * not separate providers.
 */
const PROVIDER_API_OVERRIDES: Record<string, string> = {
  "minimax-responses": "openai-responses",
  "minimax-openai": "openai-completions",
};

/**
 * Resolve the pi-ai API protocol for a provider (Task #4383 P1).
 *
 * Resolution order (first match wins):
 *   1. `explicitProtocol` — caller/config pins it, highest priority
 *   2. `PROVIDER_API_OVERRIDES` — deliberate id-variant pins
 *   3. `PROVIDER_ENDPOINT_APIS[provider]` — declared per-endpoint mapping
 *      (only for vendors that genuinely ship two protocols)
 *   4. `KNOWN_PROVIDER_APIS[provider].apiProtocol` — declarative vendor default
 *   5. generic `baseURL` heuristics — backward compat for user-defined proxies
 *      (`/responses` → openai-responses, `anthropic` → anthropic-messages).
 *      This path logs a warning so we notice configs that should be declared.
 *   6. `KNOWN_PROVIDER_APIS[provider].api` — legacy field
 *   7. `openai-completions` — final fallback
 *
 * @param provider         roy-bot provider id from config (e.g. "minimax")
 * @param baseURL          resolved provider base URL (may be undefined)
 * @param explicitProtocol optional explicit protocol from caller/config
 */
export function resolveApiProtocol(
  provider: string,
  baseURL?: string,
  explicitProtocol?: string,
): string {
  if (explicitProtocol) return explicitProtocol;
  if (PROVIDER_API_OVERRIDES[provider]) return PROVIDER_API_OVERRIDES[provider];

  // Declared per-endpoint protocols (multi-protocol vendors), longest match first.
  const endpointRules = ENDPOINT_RULES_SORTED[provider];
  if (endpointRules) {
    for (const rule of endpointRules) {
      if (baseURL?.includes(rule.pathIncludes)) return rule.apiProtocol;
    }
  }

  const declared = KNOWN_PROVIDER_APIS[provider]?.apiProtocol;
  if (declared) return declared;

  // --- backward compat: user-defined providers not in the table ---
  if (baseURL?.includes("/responses")) return "openai-responses";
  if (baseURL?.includes("anthropic")) {
    logger.warn(
      `[adapter-pi-ai] provider "${provider}" 的协议靠 baseURL 含 "anthropic" 推断为 anthropic-messages；` +
        `建议在 KNOWN_PROVIDER_APIS 或调用处显式声明 apiProtocol（Task #4383 P1）`,
      { provider, inferred_api_protocol: "anthropic-messages", base_url: baseURL },
    );
    return "anthropic-messages";
  }

  return KNOWN_PROVIDER_APIS[provider]?.api || "openai-completions";
}

/**
 * pi-ai `Model.compat` overrides that make `reasoning: true` a **byte-level
 * no-op** for the openai-completions request body (Task #4403).
 *
 * Both entries are load-bearing and were derived empirically by capturing the
 * real payload through pi-ai's public `onPayload` hook and diffing it against
 * the `reasoning: false` baseline:
 *
 * - `supportsDeveloperRole: false` — without it, `openai-completions.js:591`
 *   computes `useDeveloperRole = model.reasoning && compat.supportsDeveloperRole`
 *   and rewrites the first message's role from `system` to `developer`.
 *   That difference lands at **JSON offset ~40** (the very start of the body),
 *   so prompt caching — which is a prefix match — would miss on every turn.
 * - `thinkingFormat: "openai"` — without it, `openai-completions.js:433-475`
 *   picks the vendor's native thinking branch and, because roy-bot never
 *   passes `options.reasoningEffort`, emits an explicit
 *   `thinking: {type: "disabled"}` (deepseek) / `enable_thinking: false`
 *   (zai/qwen). That is a new top-level field the provider never saw before.
 *
 * With all three pins the payload is byte-identical to the `reasoning: false`
 * baseline for every CUSTOM provider in the real config (verified for
 * opencodego / glm / minimax / ali / volcengine / tong / opencode, plus
 * deepseek once the Task #4398 `reasoning_content` hook is attached), so
 * turning reasoning on can never regress the cache.
 *
 * Scope caveat: this guarantee covers the **fallback** (custom-provider)
 * branch of `resolvePiModel()`. pi-ai built-ins keep their own hand-tuned
 * `compat`/`reasoning` in the descriptor and are deliberately left alone.
 */
export const REASONING_COMPAT_PIN = {
  supportsDeveloperRole: false,
  thinkingFormat: "openai",
  // `thinkingFormat: "openai"` skips all vendor thinking branches, but control
  // then falls through to the generic gates at openai-completions.js:471/475,
  // and `detectCompat()` marks glm/ali/volcengine/tong as
  // `supportsReasoningEffort: true`. Without this third pin, a future caller
  // that passes `options.reasoningEffort` would emit a brand-new
  // `reasoning_effort` field. Dead today (roy-bot never passes it), pinned
  // anyway so the invariant does not depend on that staying true.
  supportsReasoningEffort: false,
} as const;

/**
 * Protocols where {@link REASONING_COMPAT_PIN} can actually hold the payload
 * byte-stable.
 *
 * `openai-responses` is deliberately excluded: pi-ai flips the system prompt
 * role there **unconditionally** —
 *   `openai-responses-shared.js:66: const role = model.reasoning ? "developer" : "system"`
 * — with no `compat` escape hatch (its `getCompat()` only exposes
 * `sendSessionIdHeader` / `supportsLongCacheRetention`). So on that path
 * `reasoning: true` is a guaranteed prefix break, and we keep it off.
 */
export const REASONING_SAFE_PROTOCOLS: ReadonlySet<string> = new Set([
  "openai-completions",
  "anthropic-messages",
]);

/** De-dupes the refusal warning to one line per provider:protocol pair. */
const warnedReasoningRefusals = new Set<string>();

/**
 * Decide the `reasoning` flag for a pi-ai model descriptor (Task #4403).
 *
 * This replaces the hardcoded `reasoning: false` that `resolvePiModel()` used
 * to emit for every non-built-in (i.e. every custom) provider — the root
 * problem flagged by Task #4398, because that literal silently disabled every
 * `model.reasoning`-gated pi-ai capability.
 *
 * Resolution order:
 *   1. protocol safety guard — see {@link REASONING_SAFE_PROTOCOLS}. Even an
 *      explicit `capabilities.reasoning: true` cannot win here, because on
 *      `openai-responses` the request prefix is guaranteed to change.
 *   2. explicit config `capabilities.reasoning` (either `true` or `false`).
 *   3. conservative default `false`.
 *
 * Deliberately NO model-name pattern matching. Guessing from names (e.g.
 * "looks like a reasoner") risks emitting provider-specific thinking fields
 * that the backend rejects (400), makes calls slower, and bills thinking
 * tokens as output. Config is the only source of truth; absence means off.
 *
 * @param provider    roy-bot provider id (may be a gateway)
 * @param modelId     model id requested from the provider
 * @param capabilities `llm.providers.<id>.capabilities` from config
 * @param apiProtocol resolved pi-ai API protocol for this target
 */
export function resolveModelReasoning(
  provider: string,
  modelId: string,
  capabilities?: { reasoning?: boolean },
  apiProtocol?: string,
): boolean {
  const requested = capabilities?.reasoning === true;
  if (!requested) return false;

  // Safety guard: on protocols where we cannot pin the payload back to the
  // `reasoning: false` bytes, refusing is strictly better than a cache wipe.
  // Fails CLOSED on a missing/empty protocol: an unknown protocol is by
  // definition one we have not proven pinnable, so the safe answer is "off".
  if (!apiProtocol || !REASONING_SAFE_PROTOCOLS.has(apiProtocol)) {
    // Warn once per provider:protocol pair — `resolvePiModel()` runs on every
    // single LLM call, so an unconditional warn would spam the hot path (D6).
    const key = `${provider}:${apiProtocol ?? "<unresolved>"}`;
    if (!warnedReasoningRefusals.has(key)) {
      warnedReasoningRefusals.add(key);
      logger.warn(
        `[adapter-pi-ai] provider "${provider}" (${apiProtocol ?? "unresolved"}) 的 capabilities.reasoning=true 被忽略：` +
          `该协议无法通过 compat pin 保持请求体字节一致，打开会破坏 prompt cache 前缀（Task #4403）`,
        { provider, model_id: modelId, api_protocol: apiProtocol },
      );
    }
    return false;
  }

  return true;
}

/**
 * Build the pi-ai cache-related request options (Task #4383 P0).
 *
 * Why this exists (#4381 root cause): pi-ai only emits an explicit cache
 * marker when it is handed the right options. Two independent code paths:
 *
 * - **openai-completions** (`openai-completions.js:394-398`): `prompt_cache_key`
 *   is only set when `baseUrl` contains `api.openai.com` **or**
 *   `cacheRetention === "long" && compat.supportsLongCacheRetention`.
 *   deepseek / glm are neither `api.openai.com` nor passed any retention, so
 *   `prompt_cache_key` was permanently `undefined` → they fell back to implicit
 *   caching. Passing `cacheRetention: "long"` also sets
 *   `prompt_cache_retention: "24h"`.
 * - **anthropic-messages** (`anthropic.js:25-36, 667-707`): `cache_control`
 *   markers are attached whenever `cacheRetention !== "none"`, and pi-ai
 *   already defaults to `"short"` (ephemeral, no ttl). That default is exactly
 *   what makes minimax hit 99.86%, so we must NOT override it — passing
 *   `"long"` would add `ttl: "1h"` and silently change current behaviour.
 *
 * Hence: openai-completions defaults to `"long"`, everything else keeps pi-ai's
 * own default unless the caller explicitly asks for a retention.
 *
 * @returns options fragment to spread into `complete()` / `stream()` options.
 *          Only keys that should actually be sent are present (no `undefined`
 *          values), so `"sessionId" in opts` stays a meaningful assertion.
 */
export function buildPiCacheOptions(args: {
  apiProtocol: string;
  sessionId?: string;
  cacheRetention?: CacheRetention;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (args.sessionId) out.sessionId = args.sessionId;

  if (args.apiProtocol === "openai-completions") {
    out.cacheRetention = args.cacheRetention ?? "long";
  } else if (args.cacheRetention) {
    // Non-openai protocols: only send when explicitly requested, so pi-ai's
    // own default (notably anthropic's "short") stays untouched.
    out.cacheRetention = args.cacheRetention;
  }
  return out;
}

/**
 * Resolve built-in models and models declared by roy-bot configuration.
 * pi-ai's generated registry only contains its bundled provider/model pairs;
 * custom provider ids (for example minimax-openai) need a complete Model
 * descriptor before complete()/stream() can dispatch by API.
 */
export function resolvePiModel(
  provider: string,
  modelId: string,
  baseURL?: string,
  capabilities?: { reasoning?: boolean },
): Model<any> {
  const builtIn = getModel(provider as any, modelId as any) as Model<any> | undefined;
  // pi-ai built-ins deliberately keep their own hand-tuned `reasoning`/`compat`
  // and are NOT touched by the config-driven logic below. That is a considered
  // choice, not an oversight (Task #4403 review, D1):
  //
  //   - pi-ai already marks reasoning-capable built-ins as `reasoning: true`, so
  //     there is nothing for `resolveModelReasoning()` to "turn on".
  //   - Forcing them to honour `capabilities.reasoning: false` would be an
  //     ACTIVE regression on the wire, not a no-op: with `reasoning: false`
  //     pi-ai stops emitting `thinking: {type: "disabled"}`
  //     (openai-completions.js:475 needs `model.reasoning` to emit it), so the
  //     provider falls back to its own default and thinking may get billed
  //     again as output. Verified by payload capture.
  //   - Their built-in `compat` is provider-tuned; overwriting it with
  //     REASONING_COMPAT_PIN could drop `thinkingFormat: "deepseek"` /
  //     `requiresReasoningContentOnAssistantMessages` and change behaviour.
  //
  // The scope of the byte-identity guarantee in REASONING_COMPAT_PIN is
  // therefore exactly this fallback branch (custom providers).
  if (builtIn) return baseURL ? { ...builtIn, baseUrl: baseURL } : builtIn;

  // P2-7: Replaced nested ternary with a clear lookup table for readability.
  // Task #4383 P1: protocol resolution is now declarative (see
  // `resolveApiProtocol`) instead of the old hardcoded
  // `baseURL?.includes("anthropic")` special-case for minimax.
  const configuredApi = resolveApiProtocol(provider, baseURL);

  // Task #4403: `reasoning` is now config-driven instead of a hardcoded
  // `false`. The old literal was the root problem flagged by #4398: it made
  // every `model.reasoning`-gated pi-ai capability silently dead for all
  // custom providers. When it does turn on, we pin `compat` at the same time
  // so the outgoing payload stays byte-identical (see REASONING_COMPAT_PIN).
  const reasoning = resolveModelReasoning(provider, modelId, capabilities, configuredApi);

  return {
    id: modelId,
    name: modelId,
    api: configuredApi,
    provider,
    baseUrl: baseURL || "",
    reasoning,
    // Pin the compat overrides only when reasoning is actually on. With
    // reasoning off every gated branch is already dead, and leaving `compat`
    // undefined keeps pi-ai's own auto-detection in charge (unchanged
    // behaviour for the vast majority of requests).
    ...(reasoning ? { compat: { ...REASONING_COMPAT_PIN } } : {}),
    // Default to ["text", "image"] for fallback path:
    // - pi-ai's `downgradeUnsupportedImages` uses `model.input.includes("image")`
    //   as the single switch for image content pass-through vs placeholder.
    // - Custom providers (e.g. minimax-cn) aren't in pi-ai's built-in registry,
    //   so they hit this fallback. Default to pass-through to let the model
    //   API surface a clear 400 error if it truly doesn't support images,
    //   rather than silently substituting "(image omitted: model does not support images)".
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: KNOWN_PROVIDER_APIS[provider]?.contextLimit || 128000,
    maxTokens: KNOWN_PROVIDER_APIS[provider]?.maxTokensLimit || 8192,
  };
}

/**
 * Task #4625 — hard cap on SDK-level retries.
 *
 * ## The bug this prevents
 *
 * ```
 * timeout 90 roy-bot act hi --model opencode/deepseek-v4.1-flash-free
 * # → EXIT=124, 0 bytes of output
 * ```
 *
 * Upstream replied `429 FreeUsageLimitError` with `Retry-After: 79229`
 * (≈ 21.87 h). `openai@6.26.0` `client.js:437-463` turns that header into the
 * sleep duration **with no upper bound**, and because pi-ai never passed
 * `maxRetries`, the SDK's own default of 2 applied — so the process slept
 * 21.87 h, retried, slept 21.87 h, and only then threw. Measured by
 * intercepting `openai/internal/utils/sleep`: `[78743000, 78742000]` ms,
 * 43.75 h total. Nothing is emitted while sleeping, so `act` printed 0 bytes.
 *
 * ## Why `maxRetries: 0` and not `maxRetryDelayMs`
 *
 * pi-ai does plumb a `maxRetryDelayMs` option (`simple-options.js:15`), but
 * nothing ever reads it — grep finds exactly one hit, the assignment itself.
 * It is a no-op, so it cannot bound the sleep. `maxRetries` is the only lever
 * that actually reaches the SDK, and 0 is the correct value rather than 1 or 2
 * because roy-bot already owns a *bounded* retry layer: on failure `llm.ts`
 * falls back to the AI SDK path, whose `getRetryDelayInMs` clamps every delay
 * to `< 60 s` (`ai/dist/index.js:2666-2678`). Retrying inside the
 * unbounded-sleep layer buys nothing and risks hours of silence; the bounded
 * layer is the right place to retry.
 *
 * Applied unconditionally (not just for opencode): the defect is in the
 * transport, so every provider is exposed to the same runaway sleep — a
 * gateway answering `503` with a long `Retry-After` would hang identically.
 */
const PI_MAX_RETRIES = 0;

/**
 * Task #4625 — capture the upstream HTTP response so `Retry-After` survives.
 *
 * ## Why a hook is the only way
 *
 * pi-ai flattens every provider failure into `AssistantMessage.errorMessage`,
 * a plain string (`openai-completions.js:314-327` does exactly
 * `output.errorMessage = error.message`). `responseHeaders` are dropped on the
 * floor. So by the time roy-bot sees `stopReason === "error"`, the only
 * remaining trace of "how long until the quota resets" is what we saved
 * ourselves.
 *
 * `onResponse` is pi-ai's public hook for that moment — it fires right after
 * `.withResponse()` resolves, *before* the body is consumed
 * (`openai-completions.js:90`), with `{status, headers}`.
 *
 * ## Why it captures unconditionally
 *
 * The hook cannot know in advance whether this response will become an error
 * (a 200 can still fail later while streaming). Capturing every response costs
 * one object allocation per request and lets `enrichProviderError()` decide
 * afterwards. Skipping non-error statuses would risk losing the very headers we
 * need when a `2xx` starts streaming and then dies.
 */
export interface CapturedProviderResponse {
  status: number;
  headers: Record<string, string>;
}

export function createResponseCapture(): {
  onResponse: (response: CapturedProviderResponse) => void;
  captured: () => CapturedProviderResponse | undefined;
} {
  let last: CapturedProviderResponse | undefined;
  return {
    onResponse: (response) => {
      // Defensive copy: pi-ai owns the header object it passes in, and the
      // caller may mutate it while normalising header names.
      last = {
        status: response?.status ?? 0,
        headers: { ...(response?.headers ?? {}) },
      };
    },
    captured: () => last,
  };
}

/**
 * Task #4625 — attach the captured HTTP response to a failed pi-ai result.
 *
 * pi-ai reports failures as `{stopReason:"error", errorMessage}` rather than by
 * throwing, so roy-bot has to turn that into a real `Error` for the caller to
 * fall back on. Throwing a *bare* `new Error(errorMessage)` was how the
 * `Retry-After` got lost: the message string cannot carry headers.
 *
 * The captured response is attached twice on purpose:
 * - as `responseHeaders`, the shape `@ai-sdk/provider`'s `APICallError` uses, so
 *   `extractRetryAfterSeconds()` finds it on the first branch it tries;
 * - as `cause`, so anything that only walks `cause` (including
 *   `collectErrorText()`, which builds the user-facing text) also sees it.
 */
export function buildProviderError(
  message: string,
  captured: CapturedProviderResponse | undefined,
  knownSecrets: Array<string | undefined> = [],
): Error {
  const err = new Error(redactSecrets(message, knownSecrets));
  if (!captured) return err;

  const enriched = err as Error & {
    statusCode?: number;
    responseHeaders?: Record<string, string>;
  };
  if (captured.status) enriched.statusCode = captured.status;
  if (Object.keys(captured.headers).length > 0) {
    enriched.responseHeaders = captured.headers;
  }
  // `cause` must be a distinct object: an Error cannot be its own cause.
  (enriched as { cause?: unknown }).cause = {
    statusCode: captured.status,
    responseHeaders: captured.headers,
  };
  return enriched;
}

/**
 * 将 LLMMessage 转换为 pi-ai 的消息结构
 */
export function toPiMessages(messages: LLMMessage[]): Context["messages"] {
  const out: Context["messages"] = [];
  const ts = Date.now();
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      if (typeof m.content === "string") {
        out.push({ role: "user", content: m.content, timestamp: ts });
      } else {
        out.push({ role: "user", content: m.content.flatMap((c) => {
          if (c.type === "text") return [{ type: "text", text: c.text }];
          if (c.type === "image") return [{ type: "image", data: c.image instanceof Uint8Array ? Buffer.from(c.image).toString("base64") : c.image, mimeType: sniffImageMime(c.image, (c as any).mediaType) }];
          return [{ type: "text", text: `[file:${c.mediaType}] ${typeof c.file === "string" ? c.file : Buffer.from(c.file).toString("base64")}` }];
        }), timestamp: ts });
      }
      continue;
    }
    if (m.role === "tool") {
      out.push({ role: "toolResult", toolCallId: m.toolCallId || "", toolName: m.name || "", content: [{ type: "text", text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }], isError: false, timestamp: ts });
      continue;
    }
    const content: any[] = [];
    if (typeof m.content === "string" && m.content) content.push({ type: "text", text: m.content });
    else if (Array.isArray(m.content)) for (const c of m.content) {
      if (c.type === "text") content.push({ type: "text", text: c.text });
      else if (c.type === "image") content.push({ type: "image", data: c.image instanceof Uint8Array ? Buffer.from(c.image).toString("base64") : c.image, mimeType: sniffImageMime(c.image, (c as any).mediaType) });
      else content.push({ type: "text", text: `[file:${c.mediaType}] ${typeof c.file === "string" ? c.file : Buffer.from(c.file).toString("base64")}` });
    }
    for (const tc of m.toolCalls || []) content.push({ type: "toolCall", id: tc.id, name: tc.name, arguments: safeJson(tc.arguments) });
    out.push({ role: "assistant", content, api: "openai-completions" as any, model: "", provider: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: ts });
  }
  return out;
}

export function extractSystemPrompt(messages: LLMMessage[]): string | undefined {
  const prompts = messages.filter((m) => m.role === "system").map((m) => typeof m.content === "string" ? m.content : m.content.filter((c) => c.type === "text").map((c) => c.text).join(""));
  return prompts.length ? prompts.join("\n\n") : undefined;
}

function safeJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch (e) {
    // P1-5: Log parse failure with input length for traceability
    logger.warn(`[safeJson] JSON.parse failed`, {
      parse_failed: true,
      input_length: s.length,
      error: (e as Error).message,
    });
    return {};
  }
}

function convertToolParameters(parameters: unknown): any {
  // ★ Task #4231：统一走 toolParametersToJsonSchema（彻底展开 $ref，防悬空指针）
  return toolParametersToJsonSchema(parameters);
}

export function toPiTools(tools: ToolInfo[] | undefined): Context["tools"] {
  if (!tools) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description || "",
    parameters: convertToolParameters(t.parameters),
  }));
}

/**
 * Build the per-request `ProviderStreamOptions` extras that are not plain
 * scalar fields — currently just custom HTTP headers.
 *
 * OpenCode Go requires a stable `x-opencode-session` header per conversation
 * (400 MissingSessionID otherwise, see opencode-session.ts). pi-ai merges
 * `options.headers` last, so this works for every OpenAI-compatible provider
 * while only ever being populated for OpenCode Go.
 */
function piRequestExtras(req: ChatRequest): { headers?: Record<string, string> } {
  const headers = buildOpencodeHeaders(req.provider, req.sessionId, req.baseURL);
  return Object.keys(headers).length > 0 ? { headers } : {};
}

/**
 * 把 pi-ai AssistantMessage 转为统一的 ChatResponse
 */
function fromAssistantMessage(msg: AssistantMessage): ChatResponse {
  let text = "";
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
  for (const block of msg.content) {
    const b = block as any;
    if (b.type === "text") {
      text += b.text || "";
    } else if (b.type === "toolCall") {
      toolCalls.push({
        id: b.id || "",
        name: b.name || "",
        arguments: typeof b.arguments === "string" ? b.arguments : JSON.stringify(b.arguments ?? {}),
      });
    }
  }
  return {
    text,
    finishReason: (msg.stopReason || "stop") as ChatResponse["finishReason"],
    toolCalls: toolCalls.length ? toolCalls : undefined,
    usage: {
      promptTokens: msg.usage?.input ?? 0,
      completionTokens: msg.usage?.output ?? 0,
      totalTokens: msg.usage?.totalTokens ?? 0,
      cacheRead: msg.usage?.cacheRead,
      cacheWrite: msg.usage?.cacheWrite,
    },
    raw: msg,
  };
}

export class EmbeddingNotSupportedError extends Error {
  constructor(adapter: string) {
    super(`Embedding is not supported by ${adapter}; use AiSdkAdapter.embed() or apply at higher layer.`);
    this.name = "EmbeddingNotSupportedError";
  }
}

export class PiAiAdapter implements LLMAdapter {
  readonly name = "pi-ai" as const;

  @TracedAs("llm.adapter.chat", {
    recordParams: true,
    recordResult: true,
    log: true,
    paramFilter: (args: any[]) => {
      const req = args[0];
      return {
        provider: req?.provider,
        model_id: req?.modelId,
        messages_count: req?.messages?.length,
        tools_count: req?.tools?.length,
        temperature: req?.temperature,
        max_tokens: req?.maxTokens,
      };
    },
    resultFilter: (r: any) => ({
      finish_reason: r?.finishReason,
      usage_input: r?.usage?.promptTokens,
      usage_output: r?.usage?.completionTokens,
      usage_total: r?.usage?.totalTokens,
      content_length: r?.text?.length,
    }),
  })
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const model = resolvePiModel(req.provider, req.modelId, req.baseURL, req.capabilities);
    const ctx: Context = {
      systemPrompt: [req.systemPrompt, extractSystemPrompt(req.messages)].filter(Boolean).join("\n\n") || undefined,
      messages: toPiMessages(req.messages),
      tools: toPiTools(req.tools),
    };
    // Task #4625: same response capture as stream() — see createResponseCapture.
    const responseCapture = createResponseCapture();
    const msg = await complete(model, ctx, {
      apiKey: req.apiKey,
      baseURL: req.baseURL,
      temperature: req.temperature,
      maxTokens: req.maxTokens,
      signal: req.signal,
      onResponse: responseCapture.onResponse,
      // Task #4383 P0: hand pi-ai the session id + cache retention so it can
      // emit an explicit cache marker (prompt_cache_key / cache_control)
      // instead of relying on provider-side implicit caching.
      ...buildPiCacheOptions({
        apiProtocol: model.api,
        sessionId: req.sessionId,
        cacheRetention: req.cacheRetention,
      }),
      // Task #4398: defensive `reasoning_content` injection for the DeepSeek
      // family. See reasoning-defense.ts for the double-miss root cause and
      // the cache-prefix stability rationale. Non-DeepSeek payloads are
      // returned untouched (same reference), so other providers' caches can
      // not be affected by this hook.
      onPayload: createReasoningDefenseHook({
        provider: req.provider,
        modelId: req.modelId,
      }),
      // Task #4625: bound the SDK's unbounded `Retry-After` sleep.
      maxRetries: PI_MAX_RETRIES,
      ...piRequestExtras(req),
    } as any);
    // Task #4625: same failure-enrichment as stream().
    if (msg.stopReason === "error") {
      throw buildProviderError(
        msg.errorMessage || "Provider returned an error stop reason",
        responseCapture.captured(),
        [req.apiKey],
      );
    }
    return fromAssistantMessage(msg);
  }

  @TracedAs("llm.adapter.stream", {
    recordParams: true,
    recordResult: false,
    log: true,
    paramFilter: (args: any[]) => {
      const req = args[0];
      return {
        provider: req?.provider,
        model_id: req?.modelId,
        messages_count: req?.messages?.length,
      };
    },
  })
  async stream(req: ChatRequest): Promise<StreamHandle> {
    const model = resolvePiModel(req.provider, req.modelId, req.baseURL, req.capabilities);
    const ctx: Context = {
      systemPrompt: [req.systemPrompt, extractSystemPrompt(req.messages)].filter(Boolean).join("\n\n") || undefined,
      messages: toPiMessages(req.messages), tools: toPiTools(req.tools),
    };
    // Task #4625: capture the HTTP response so `Retry-After` is not lost when
    // pi-ai flattens the failure into `errorMessage` (see createResponseCapture).
    const responseCapture = createResponseCapture();
    const eventStream = piStream(model, ctx, {
      apiKey: req.apiKey,
      baseURL: req.baseURL,
      temperature: req.temperature,
      maxTokens: req.maxTokens,
      signal: req.signal,
      onResponse: responseCapture.onResponse,
      // Task #4383 P0: same wiring as chat() — see buildPiCacheOptions().
      ...buildPiCacheOptions({
        apiProtocol: model.api,
        sessionId: req.sessionId,
        cacheRetention: req.cacheRetention,
      }),
      // Task #4398: same defence as chat() — see reasoning-defense.ts.
      onPayload: createReasoningDefenseHook({
        provider: req.provider,
        modelId: req.modelId,
      }),
      // Task #4625: same retry cap as chat() — see PI_MAX_RETRIES.
      maxRetries: PI_MAX_RETRIES,
      ...piRequestExtras(req),
    } as any);
    return {
      events: eventStream,
      result: async () => {
        const msg = await eventStream.result();
        // Task #4625: pi-ai reports provider failures as stopReason:"error"
        // instead of throwing. Surface it as a real Error carrying the captured
        // response, otherwise callers only ever see the message string and the
        // recovery window (Retry-After) is unrecoverable.
        if (msg.stopReason === "error") {
          throw buildProviderError(
            msg.errorMessage || "Provider returned an error stop reason",
            responseCapture.captured(),
            [req.apiKey],
          );
        }
        return fromAssistantMessage(msg);
      },
    };
  }

  /**
   * ★ 2026-10-22：**只存摘要**（Task #4479）。embed 的 `texts` 是大字符串数组，
   * 绝不能入库；返回值向量同理。正常路径由 filter 存摘要，
   * `recordResult: false` 只是 filter 失效时的兜底（见 ai_sdk.embed 的说明）。
   */
  @TracedAs("llm.adapter.embed", {
    paramFilter: embedParamFilter,
    resultFilter: embedResultFilter,
    recordResult: false,
    log: true,
  })
  async embed(_req: EmbedRequest): Promise<EmbedResponse> {
    throw new EmbeddingNotSupportedError(this.name);
  }

  @TracedAs("llm.adapter.resolve_provider", {
    recordParams: true,
    recordResult: true,
    log: true,
    paramFilter: (args: any[]) => ({
      provider: args[0],
      model_id: args[1],
    }),
    resultFilter: (r: any) => ({
      api: r?.api,
      context_limit: r?.contextLimit,
      max_tokens_limit: r?.maxTokensLimit,
    }),
  })
  async resolveProvider(provider: string, modelId: string): Promise<ResolvedProvider> {
    const model = resolvePiModel(provider, modelId);
    const caps = KNOWN_PROVIDER_APIS[provider] || {
      api: model.api,
      contextLimit: model.contextWindow,
      maxTokensLimit: model.maxTokens,
    };
    return {
      api: model.api,
      provider,
      modelId,
      contextLimit: caps.contextLimit,
      maxTokensLimit: caps.maxTokensLimit,
    };
  }
}
