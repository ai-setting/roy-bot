/**
 * @fileoverview Session-id validation helper (Issue #8)
 *
 * `ROY_PARENT_SESSION_ID` is a cross-process propagation channel (set by an
 * outer parent process and consumed by the spawned child CLI). Because the
 * value crosses a trust boundary, callers must validate it before using it
 * to write into the session tree — otherwise a malicious or buggy parent
 * can inject arbitrary strings into the database or cause log noise.
 *
 * The policy:
 *  - Length: 8..128 characters (covers session_/run_/agent_ UUIDs + a bit of
 *    headroom; rejects empty, single-char, and absurdly long strings).
 *  - Character set: `[A-Za-z0-9_-]` (alphanumerics plus `_` and `-`).
 *    This covers all known session-id formats and rejects any control chars,
 *    spaces, slashes, dots, or shell metacharacters.
 */
export const MIN_SESSION_ID_LENGTH = 8;
export const MAX_SESSION_ID_LENGTH = 128;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Returns true if the given string is a well-formed session id we are willing
 * to propagate cross-process (e.g. via `ROY_PARENT_SESSION_ID`).
 *
 * Pass `null` / `undefined` / empty string → false (defensive: callers often
 * pull from env where missing values are common).
 */
export function isValidSessionId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < MIN_SESSION_ID_LENGTH) return false;
  if (value.length > MAX_SESSION_ID_LENGTH) return false;
  return SESSION_ID_PATTERN.test(value);
}
