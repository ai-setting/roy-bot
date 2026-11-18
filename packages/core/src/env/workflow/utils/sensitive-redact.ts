/**
 * @fileoverview sensitive-redact.ts — Redact sensitive fields from input before persisting (Task #2900 P1)
 *
 * Background: engine.ts was persisting the raw workflow `input` object into
 * session metadata.input, leaking sensitive fields (password / LDAP_PASSWORD /
 * apiKey / token / secret) to the session DB. This util produces a deep-copy
 * with sensitive keys replaced by the `"[REDACTED]"` sentinel.
 *
 * Design choices:
 *   - Case-insensitive matching (PASSWORD / Password / password all redacted).
 *   - Recurses into nested objects AND arrays (so {config:{auth:{password}}}
 *     and [{user, password}] are both safe).
 *   - Does NOT mutate the input — callers can safely pass the original object
 *     elsewhere.
 *   - Returns undefined for undefined/null input so engine.ts:447 etc. behave
 *     identically when no input was supplied.
 *   - Returns non-object scalars (strings, numbers, booleans) unchanged —
 *     they can't contain field names.
 *
 * Sensitive key list (lowercase, prefix-matched):
 *   password, ldap_password, apikey, api_key, token, secret, auth,
 *   access_token, refresh_token, authorization, cookie, private_key,
 *   session_token, sid
 *
 * Note: 'sid' is included to redact the ONES ones-ids-sid cookie value if
 * accidentally passed as a top-level field (the workflow uses sidCookie,
 * not sid, so this is defensive).
 */

/** Sentinel value used to replace redacted fields. */
export const REDACTED_SENTINEL = "[REDACTED]";

/**
 * Lowercase set of sensitive key names. Matched case-insensitively against
 * any object key encountered during traversal.
 */
const SENSITIVE_KEYS = new Set<string>([
  "password",
  "ldap_password",
  "apikey",
  "api_key",
  "token",
  "secret",
  "auth",
  "access_token",
  "refresh_token",
  "authorization",
  "cookie",
  "private_key",
  "session_token",
  "sid",
]);

/**
 * Redact sensitive fields from `input`. Returns a new object/array with
 * sensitive values replaced by "[REDACTED]". Non-sensitive scalars and
 * non-object values pass through unchanged. Returns undefined for
 * undefined/null input.
 */
export function redactSensitiveFields<T = unknown>(input: T): T | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }
  if (typeof input !== "object") {
    return input;
  }
  return redactValue(input as unknown as Record<string, unknown>) as T;
}

/**
 * Internal recursive helper.
 */
function redactValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  if (typeof value !== "object") {
    return value;
  }
  const obj = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      result[k] = REDACTED_SENTINEL;
    } else {
      result[k] = redactValue(v);
    }
  }
  return result;
}