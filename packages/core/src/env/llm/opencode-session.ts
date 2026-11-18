/**
 * @fileoverview OpenCode Go provider helpers.
 *
 * The OpenCode Go inference endpoint (`https://opencode.ai/inference/go/v1`)
 * requires a stable `x-opencode-session` header per conversation; without it the
 * server responds `400 MissingSessionID` and the request cannot be routed:
 *   https://opencode.ai/docs/go/#how-it-works
 *
 * This module is the single source of truth for:
 *   1. detecting the OpenCode Go provider id, and
 *   2. generating / memoizing a stable session id per conversation.
 *
 * Why it lives here instead of inside `invoke.ts`:
 *   roy-bot has TWO LLM transports that both hit the same endpoint —
 *     - `PiAiAdapter`  (default path, `ROY_LLM_PROVIDER=pi-ai`)
 *     - `invoke()` in `invoke.ts` (AI SDK fallback, `ROY_LLM_PROVIDER=ai-sdk`)
 *   The header injection must be shared so neither path silently regresses.
 *   Historically only the AI SDK path injected it, so the default pi-ai path
 *   always failed with `MissingSessionID` and relied on the fallback.
 *
 * Provider id normalization:
 *   Users have registered the provider under several spellings across time
 *   (`opencode`, `opencode-go`, `opencodego`; see Task #4168 / #4170 / #4173).
 *   We normalize case and strip `-`/`_` so all of them match. The Feishu
 *   channel's chat-keyed session ids (`oc_...`) are irrelevant here: the header
 *   value is always a freshly generated `ses_...` id, so any conversation id
 *   (including `oc_...`) works as the cache key.
 */

/** Max number of cached conversation → session id entries (bounded FIFO). */
const OPENCODE_SESSION_ID_CACHE_MAX = 1000;

/** Conversation id → stable OpenCode session id. */
const opencodeSessionIdCache = new Map<string, string>();

/**
 * Generate an OpenCode-compatible `x-opencode-session` id.
 *
 * Official client format (sst/opencode source analysis, Task #4165):
 *   `ses_<12 hex timestamp><14 base62 random>` = 30 chars
 *
 * We do not enforce the exact 30-char length (the server only validates the
 * `ses_` prefix and a minimum length), but we keep the same shape so the output
 * is easy to recognize alongside the official client.
 *
 * @param nowMs - injectable clock (for tests)
 */
export function generateOpencodeSessionId(nowMs: number = Date.now()): string {
  const timestampHex = Math.floor(nowMs / 1000)
    .toString(16)
    .padStart(12, "0");
  const randomChars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let suffix = "";
  for (let i = 0; i < 14; i++) {
    suffix += randomChars[Math.floor(Math.random() * randomChars.length)];
  }
  return `ses_${timestampHex}${suffix}`;
}

/**
 * True when `providerId` refers to the OpenCode Go provider.
 *
 * Recognizes `opencode`, `opencode-go`, `opencode_go` and `opencodego`
 * (case-insensitive). Unrelated providers (e.g. `deepseek`, `openai`) return
 * false so we never send the header to endpoints that don't understand it.
 */
export function isOpencodeProvider(providerId: string | undefined | null): boolean {
  if (!providerId) return false;
  const normalized = providerId.toLowerCase().replace(/[-_]/g, "");
  return normalized === "opencode" || normalized === "opencodego";
}

/**
 * True when `baseURL` points at the OpenCode Go inference endpoint.
 *
 * Id-based detection misses the case where a user points some other provider
 * name at the OpenCode endpoint; endpoint detection closes that gap. Only the
 * official host is matched so unrelated gateways are unaffected.
 */
export function isOpencodeEndpoint(baseURL: string | undefined | null): boolean {
  if (!baseURL) return false;
  try {
    const url = new URL(baseURL);
    return url.hostname === "opencode.ai" && url.pathname.startsWith("/inference/go");
  } catch {
    // Not an absolute URL — fall back to a conservative substring check.
    return /^https?:\/\/opencode\.ai\/inference\/go(\/|$)/i.test(baseURL);
  }
}

/**
 * Get (or create) the stable OpenCode session id for a conversation.
 *
 * `x-opencode-session` must be STABLE for the lifetime of a conversation
 * (the server uses it for routing/caching, see #4168). The header is injected
 * once per LLM turn, so we memoize the generated id per conversation key.
 *
 * - `conversationId` undefined → return an ephemeral id (no stable key to
 *   cache under, better than poisoning a shared entry).
 * - The cache is a bounded FIFO so long-lived processes cannot grow it forever.
 */
export function getOrCreateOpencodeSessionId(
  conversationId: string | undefined,
  nowMs: number = Date.now(),
): string {
  if (!conversationId) {
    return generateOpencodeSessionId(nowMs);
  }

  const cached = opencodeSessionIdCache.get(conversationId);
  if (cached) {
    return cached;
  }

  const sessionId = generateOpencodeSessionId(nowMs);
  if (opencodeSessionIdCache.size >= OPENCODE_SESSION_ID_CACHE_MAX) {
    const oldest = opencodeSessionIdCache.keys().next().value;
    if (oldest !== undefined) {
      opencodeSessionIdCache.delete(oldest);
    }
  }
  opencodeSessionIdCache.set(conversationId, sessionId);
  return sessionId;
}

/**
 * Build the request headers for a provider.
 *
 * Returns `{ "x-opencode-session": "ses_..." }` for OpenCode Go providers and
 * an empty object for everyone else. Match is by provider id OR endpoint, so it
 * keeps working if the provider is registered under a different name.
 */
export function buildOpencodeHeaders(
  providerId: string | undefined | null,
  conversationId?: string,
  baseURL?: string,
): Record<string, string> {
  if (!isOpencodeProvider(providerId) && !isOpencodeEndpoint(baseURL)) {
    return {};
  }
  return { "x-opencode-session": getOrCreateOpencodeSessionId(conversationId) };
}

/** Test-only: reset the conversation → session id cache between cases. */
export function __clearOpencodeSessionIdCache(): void {
  opencodeSessionIdCache.clear();
}
