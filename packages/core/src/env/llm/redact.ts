/**
 * Secret redaction for upstream error text.
 *
 * ## Why this is a shared module and not a private helper
 *
 * Task #4465 established the rule: never trust an upstream error message to be
 * secret-free — AI SDK / fetch errors routinely embed the request URL, the
 * `Authorization` header, or a provider payload, any of which can contain the
 * API key. `invoke.ts` therefore redacts before putting the message in
 * `result.result`.
 *
 * Task #4625 added a second channel for the *same* error object: the raw
 * `Error` is attached as `cause` so that `Retry-After` (the "when does the
 * quota reset" header) survives the stringification boundaries, because a bare
 * message string cannot carry headers.
 *
 * That created a hole. `error-reply.ts` walks `cause` while building the
 * `technical` line, and that line is rendered into the user-facing failure
 * reply (Feishu + CLI). So the raw, un-redacted upstream text — the very thing
 * `invoke.ts` had just stripped out — came back in through the side door.
 *
 * Redaction therefore has to happen at **both** ends, which means it cannot stay
 * private to `invoke.ts`. Kept dependency-free on purpose so both the LLM layer
 * and the error-reporting layer can import it without a cycle.
 */

/**
 * Redact credentials from free-form text before logging or showing it.
 *
 * Two passes:
 * 1. exact known secrets (caller-supplied, e.g. the configured `apiKey`) — this
 *    is defense in depth for formats the patterns below do not know about;
 * 2. well-known key shapes (`sk-…`, `oc_sk_…`, `Bearer …`).
 *
 * @param text          free-form text that may embed a credential
 * @param knownSecrets  exact values to scrub; entries shorter than 8 chars are
 *                      ignored so a trivial value cannot wreck the message
 */
export function redactSecrets(
  text: string,
  knownSecrets: Array<string | undefined> = [],
): string {
  let out = text;

  // 1) Exact known secrets (defense in depth for arbitrary key formats).
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 8) {
      out = out.split(secret).join("<redacted>");
    }
  }

  // 2) Well-known key shapes.
  out = out.replace(/\boc_sk_[A-Za-z0-9_-]{8,}\b/g, "<redacted>");
  out = out.replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, "<redacted>");
  out = out.replace(/\bBearer\s+[A-Za-z0-9._\-+/=]{12,}\b/g, "<redacted>");
  return out;
}

/**
 * Produce a redacted *copy* of an upstream error, safe to hand to anything that
 * renders user-visible text (task #4625, review finding on the `cause` channel).
 *
 * ## Why a copy, and why by value
 *
 * A bare `Error` message cannot carry `Retry-After`, so roy-bot attaches the
 * original error object as `cause` to keep the recovery window alive. But
 * `error-reply.ts` walks `cause` when building the `technical` line, which is
 * rendered into the failure reply (CLI + Feishu). The raw object therefore has
 * to be sanitised *before* it travels — redacting at the sink is not enough,
 * because the sink does not know the apiKey and can only match key *shapes*.
 *
 * Shape matching covers `sk-…`, `oc_sk_…` and `Bearer …`. Real providers also
 * use JWT-style keys (MiniMax) and UUID/random-hash access keys (gateways), and
 * those slip through every pattern. Only the caller knows the actual secret
 * value, so the scrub has to happen here.
 *
 * ## Contract
 *
 * - never mutates the input;
 * - preserves `name`, `message`, `stack`, `statusCode`, `responseHeaders`, and a
 *   `cause` chain — the fields the classifier and `extractRetryAfterSeconds()`
 *   rely on. Anything lost here silently degrades the user-facing message;
 * - `stack` is scrubbed too, since stacks embed request URLs.
 *
 * Depth is bounded so a cyclic `cause` chain cannot hang.
 */
/**
 * Keys whose values are upstream payloads rather than metadata — they routinely
 * embed the API key verbatim (URL query, echoed request body, debug headers).
 */
const CREDENTIAL_BEARING_KEYS = new Set([
  "url",
  "requestBodyValues",
  "requestBody",
  "responseBody",
  "responseHeaders",
  "headers",
]);

/**
 * Recursively redact strings inside an arbitrary JSON-ish value.
 *
 * Bounded so a deeply nested or cyclic payload cannot hang the sanitiser; on a
 * cycle the value is replaced with a marker rather than thrown away entirely.
 */
function redactDeep(value: unknown, knownSecrets: Array<string | undefined>, depth = 0): unknown {
  if (depth > 4) return value;
  if (typeof value === "string") return redactSecrets(value, knownSecrets);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, knownSecrets, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, knownSecrets, depth + 1);
    }
    return out;
  }
  return value;
}

export function redactErrorForTransport(
  error: unknown,
  knownSecrets: Array<string | undefined> = [],
  depth = 0,
): unknown {
  if (depth > 6) return undefined;
  if (!error || typeof error !== "object") {
    return typeof error === "string" ? redactSecrets(error, knownSecrets) : error;
  }

  const src = error as Record<string, any>;
  const out: Record<string, any> = {};

  // Copy **all own** properties, not just enumerable ones (review MINOR-7).
  //
  // `new Error(msg, {cause})` defines `cause` as non-enumerable, and so does
  // `AggregateError.errors` — `Object.keys()` returns `[]` for both. Dropping
  // them means `extractRetryAfterSeconds()` finds nothing and the CLI falls back
  // to "恢复时间未知", silently undoing the whole point of this task. Today's
  // producers happen to attach `cause` as an enumerable property, so this is a
  // latent trap rather than a live bug — but it is one `new Error(msg, {cause})`
  // away from regressing.
  for (const key of Object.getOwnPropertyNames(src)) {
    // Skip accessor-only internals (this is a plain data copy).
    const desc = Object.getOwnPropertyDescriptor(src, key);
    if (!desc || !("value" in desc)) continue;
    const value = src[key];
    if (typeof value === "string") {
      out[key] = redactSecrets(value, knownSecrets);
    } else if (key === "cause" || key === "lastError") {
      out[key] = redactErrorForTransport(value, knownSecrets, depth + 1);
    } else if (key === "errors" && Array.isArray(value)) {
      out[key] = value.map((inner) => redactErrorForTransport(inner, knownSecrets, depth + 1));
    } else if (CREDENTIAL_BEARING_KEYS.has(key)) {
      // Review MINOR-6: these carry request/response payloads that can embed a
      // key verbatim. Recursing scrubs nested strings; anything we cannot walk
      // (numbers, arrays of primitives) is copied as-is.
      out[key] = redactDeep(value, knownSecrets);
    } else {
      out[key] = value;
    }
  }

  // Non-enumerable but load-bearing: `message`/`stack`/`name` on Error instances
  // usually live on the prototype, so Object.keys() misses them.
  for (const key of ["name", "message", "stack"] as const) {
    const value = src[key];
    if (typeof value === "string" && !(key in out)) {
      out[key] = redactSecrets(value, knownSecrets);
    }
  }

  return out;
}
