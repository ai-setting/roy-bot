/**
 * Defensive `reasoning_content` injection for DeepSeek-family providers.
 *
 * Task #4398. Business trigger (production, 12 occurrences, all
 * `opencodego / deepseek-v4.1-flash`):
 *
 *   [invalid_request_error] The `reasoning_content` in the thinking mode must
 *   be passed back to the API.
 *
 * ── Why roy-bot has to do this itself ────────────────────────────────
 *
 * pi-ai *does* know how to patch this, at `openai-completions.js:712-716`:
 *
 *   if (compat.requiresReasoningContentOnAssistantMessages &&
 *       model.reasoning &&                        // ← (B)
 *       assistantMsg.reasoning_content === undefined) {
 *     assistantMsg.reasoning_content = "";
 *   }
 *
 * Two independent switches have to be on, and for our failing combo BOTH are
 * off:
 *
 *   (A) `requiresReasoningContentOnAssistantMessages` comes from
 *       `detectCompat()` (`openai-completions.js:884`):
 *         const isDeepSeek = provider === "deepseek" || baseUrl.includes("deepseek.com")
 *       opencodego is `provider: "opencodego"` with
 *       `baseUrl: "https://opencode.ai/inference/go/v1"` → false.
 *
 *   (B) `model.reasoning` comes from the model descriptor. pi-ai's bundled
 *       registry has no opencodego entries, so roy-bot builds the descriptor
 *       itself in `resolvePiModel()`, which hardcodes `reasoning: false`.
 *       The `capabilities.reasoning: true` in config never reaches it.
 *
 * So patching compat alone would still be a no-op: (B) short-circuits the AND.
 * Hence the defence lands on roy-bot's side, via pi-ai's public `onPayload`
 * hook (supported by all three protocol paths: openai-completions.js:78,
 * anthropic.js:325, openai-responses.js:64).
 *
 * ── The cache constraint (the user's actual worry) ─────────────────────
 *
 * Prompt caching is a PREFIX match: the bytes we send for turn N become the
 * reusable prefix at turn N+1. So the injected value must be perfectly stable
 * — a constant `""`, appended at a deterministic position, present on *every*
 * assistant message of every turn. Anything volatile (timestamp, counter,
 * random id, or "only inject when we happen to think we need it") would change
 * the prefix between turns and silently destroy the cache.
 *
 * That is also why the guard is deliberately NARROW: providers outside the
 * DeepSeek family never get the field. They either reject unknown fields or
 * hash assistant messages into their own prefix, so injecting for them would be
 * a cache regression with zero benefit.
 */

/**
 * Providers known to require `reasoning_content` on assistant messages once the
 * request is routed to a thinking-capable backend.
 *
 * `provider` is the *configured* provider id (may be a gateway), `modelId` is
 * the model the gateway is asked for. They are checked independently because
 * gateways are heterogeneous: `opencodego` serves deepseek AND glm AND kimi, so
 * the model id is what decides.
 */
const DEEPSEEK_PROVIDER_PREFIX = "deepseek";
const DEEPSEEK_MODEL_MARKER = "deepseek";

/**
 * Should assistant messages get a `reasoning_content` field for this target?
 *
 * True when either:
 * - the configured provider is the DeepSeek API itself (`deepseek`, `deepseek-cn`, …), or
 * - the model id names a DeepSeek model, regardless of which gateway fronts it
 *   (this is the `opencodego + deepseek-v4.1-flash` production case).
 */
export function shouldInjectReasoningContent(
  provider: string | undefined,
  modelId: string | undefined,
): boolean {
  const p = (provider ?? "").toLowerCase();
  const m = (modelId ?? "").toLowerCase();

  if (p === DEEPSEEK_PROVIDER_PREFIX || p.startsWith(`${DEEPSEEK_PROVIDER_PREFIX}-`)) {
    return true;
  }
  return m.includes(DEEPSEEK_MODEL_MARKER);
}

/** Minimal structural view of a chat message — avoids importing pi-ai types. */
interface AnyMessage {
  role?: string;
  reasoning_content?: string;
  [key: string]: unknown;
}

/**
 * Add `reasoning_content: ""` to every assistant message that lacks the field.
 *
 * Contract:
 * - only `role === "assistant"` messages are touched;
 * - existing `reasoning_content` (including a real thinking trace) is preserved;
 * - the input array and its objects are NOT mutated — a new array is returned;
 * - idempotent, and the produced bytes are identical across calls.
 */
export function injectReasoningContent<T extends AnyMessage>(messages: T[]): T[] {
  return messages.map((msg) => {
    if (msg?.role !== "assistant") return msg;
    // `in` (not a truthiness check) so that a legitimate empty string written by
    // a previous turn is recognised as "already present" and left alone.
    if ("reasoning_content" in msg) return msg;
    // Spread keeps the original key order and appends the new key last, so the
    // serialised bytes are deterministic across turns — cache prefix stays stable.
    return { ...msg, reasoning_content: "" };
  });
}

/**
 * Apply the defence to a raw pi-ai request payload (shape varies by protocol,
 * so this stays structural and conservative).
 *
 * Returns the SAME object reference when nothing needs to change, which makes
 * "we did zero work for non-DeepSeek providers" observable in tests and keeps
 * the untouched path allocation-free.
 */
export function applyReasoningDefense<P extends { messages?: unknown }>(
  payload: P,
  target: { provider?: string; modelId?: string },
): P {
  if (!payload || typeof payload !== "object") return payload;
  if (!shouldInjectReasoningContent(target.provider, target.modelId)) return payload;

  const messages = (payload as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return payload;

  return { ...payload, messages: injectReasoningContent(messages as AnyMessage[]) } as P;
}

/**
 * Build the `onPayload` hook for pi-ai `complete()` / `stream()`.
 *
 * Kept as a factory (rather than passing `applyReasoningDefense` directly) so
 * the hook closes over the exact provider/model of this call — pi-ai invokes it
 * with `(payload, model)`, and we deliberately do not trust `model.provider`
 * alone because the configured provider id is what the gateway routing uses.
 */
export function createReasoningDefenseHook(target: {
  provider?: string;
  modelId?: string;
}): (payload: any) => any {
  return (payload: any) => applyReasoningDefense(payload, target);
}
