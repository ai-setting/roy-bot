/**
 * @fileoverview Shared ask_user timeout helpers
 *
 * Task #1967: Centralize the constants, sentinel helpers, and race-safe
 * readline listener used by both `shared/ask-user-handler.ts` (getUserChoice)
 * and `commands/run.ts` (promptUser).
 *
 * Before this refactor, both call sites duplicated:
 *   - `ASK_USER_TIMEOUT_MS`
 *   - `ASK_USER_TIMEOUT_SENTINEL_PREFIX`
 *   - `isAskUserTimeoutSentinel(value)`
 *   - `createAskUserTimeoutSentinel(...)` payload shape
 *   - the `resolved` flag + `setTimeout` + `removeListener('line')` race dance
 *
 * Behavior is intentionally unchanged: callers that previously imported
 * these names from `./ask-user-handler` or `./interactive` continue to work
 * via re-exports.
 */

/**
 * Default timeout for ask_user waits (2 minutes).
 *
 * Production default; tests may inject a shorter value via `opts.timeoutMs`.
 */
export const ASK_USER_TIMEOUT_MS = 120_000;

/**
 * Sentinel prefix that identifies an "ask_user timed out" response.
 *
 * The full sentinel is `__ASK_USER_TIMEOUT__:<json-payload>`; the prefix
 * alone is not considered a sentinel (must carry at least one payload char).
 */
export const ASK_USER_TIMEOUT_SENTINEL_PREFIX = "__ASK_USER_TIMEOUT__:";

/**
 * Returns true when `value` is a complete ask_user timeout sentinel.
 *
 * The check is strict: `value` must be a string strictly longer than the
 * prefix AND start with the prefix. This prevents false positives when the
 * user manually types something like `__ASK_USER_TIMEOUT__:abc` (truncated
 * / invalid JSON).
 */
export function isAskUserTimeoutSentinel(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length > ASK_USER_TIMEOUT_SENTINEL_PREFIX.length &&
    value.startsWith(ASK_USER_TIMEOUT_SENTINEL_PREFIX)
  );
}

/**
 * Optional metadata carried alongside the ask_user error.
 *
 * Subset of fields that the sentinel payload preserves for downstream
 * debugging. All fields are optional to keep the helper resilient.
 */
export interface AskUserTimeoutSentinelSource {
  query?: string;
  sessionId?: string;
  agentSessionId?: string;
  nodeId?: string;
  nodeType?: string;
}

/**
 * Extra options for `createAskUserTimeoutSentinel`.
 */
export interface AskUserTimeoutSentinelExtra {
  /** Caller tag baked into the payload (e.g. `"repl"` or `"handler"`). */
  source?: string;
  /** Fallback question used when `errorInfo?.query` is unavailable. */
  question?: string;
}

/**
 * Build an ask_user timeout sentinel string.
 *
 * The returned string is guaranteed to satisfy `isAskUserTimeoutSentinel`.
 *
 * Payload fields are intentionally fixed to:
 *   `query, sessionId, agentSessionId, nodeId, nodeType, timestamp,
 *    timeoutMs, source`
 * — adding new fields would be a behavior change (downstream tests and
 * tooling rely on this exact shape).
 *
 * @param errorInfo  Optional AskUserError info; `query` is preferred over
 *                   `extra.question` for the payload `query` field.
 * @param timeoutMs  Timeout value (in ms) used to trigger the sentinel.
 * @param extra      Caller overrides (source label, fallback question).
 */
export function createAskUserTimeoutSentinel(
  errorInfo: AskUserTimeoutSentinelSource | undefined,
  timeoutMs: number,
  extra?: AskUserTimeoutSentinelExtra,
): string {
  const payload = {
    query: errorInfo?.query ?? extra?.question ?? "",
    sessionId: errorInfo?.sessionId,
    agentSessionId: errorInfo?.agentSessionId,
    nodeId: errorInfo?.nodeId,
    nodeType: errorInfo?.nodeType,
    timestamp: Date.now(),
    timeoutMs,
    source: extra?.source ?? "repl",
  };
  return ASK_USER_TIMEOUT_SENTINEL_PREFIX + JSON.stringify(payload);
}

/**
 * Minimal readline-like interface needed by `withAskUserTimeoutRace`.
 *
 * We accept a structural type (not `readline.Interface` directly) so the
 * helper is easy to unit-test without instantiating a real `readline`.
 *
 * `readline.Interface` already implements these methods structurally
 * (it extends `readline.ReadStream` / `EventEmitter`), so callers can
 * usually pass it without any cast.
 */
export interface WithAskUserTimeoutRaceRl {
  on(
    event: "line",
    listener: (input: string) => void,
  ): unknown;
  removeListener(
    event: "line",
    listener: (input: string) => void,
  ): unknown;
}

export interface WithAskUserTimeoutRaceOpts {
  rl: WithAskUserTimeoutRaceRl;
  timeoutMs: number;
  /** Invoked when the user provides input before the timeout. The helper
   *  has already removed the `line` listener and cleared the timer. */
  onLine: (input: string) => void;
  /** Invoked when the timer fires before any user input. The helper has
   *  already removed the `line` listener. */
  onTimeout: () => void;
}

/**
 * Race between a readline `line` event and a `setTimeout`.
 *
 * Behavior:
 * - Exactly one of `onLine` or `onTimeout` is invoked.
 * - The losing path is silently dropped via a `resolved` flag — no
 *   double-resolve and no unhandled rejection from the loser's callback.
 * - `rl.removeListener('line', handleLine)` is called on whichever path
 *   wins, keeping `listenerCount('line')` at zero after the race.
 * - The timer is cleared via `clearTimeout` when the user wins; the
 *   losing timer path is naturally inert.
 * - The timer is `.unref()`-ed so it never blocks Node shutdown.
 *
 * Returns `{ cancel() }` so callers can short-circuit (e.g. on shutdown).
 */
export function withAskUserTimeoutRace(
  opts: WithAskUserTimeoutRaceOpts,
): { cancel: () => void } {
  const { rl, timeoutMs, onLine, onTimeout } = opts;

  // Task #2377: 防御性 null check — caller 责任检查，但这里也拦截防止 null 崩溃
  // 场景: ink 模式 (this.rl === null) 误调本函数，caller 已加 `if (this.rl)` 守卫
  // 但万一 caller 漏了，深度防御避免 TypeError: null is not an object (evaluating 'rl.on')
  if (!rl) {
    return { cancel: () => {} };
  }

  let resolved = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const handleLine = (input: string) => {
    if (resolved) return;
    resolved = true;
    rl.removeListener("line", handleLine);
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    onLine(input);
  };

  rl.on("line", handleLine);

  timer = setTimeout(() => {
    if (resolved) return;
    resolved = true;
    rl.removeListener("line", handleLine);
    onTimeout();
    timer = null;
  }, timeoutMs);

  // Allow Node to exit even while the timer is pending.
  if (timer && typeof timer.unref === "function") {
    timer.unref();
  }

  return {
    cancel() {
      if (resolved) return;
      resolved = true;
      rl.removeListener("line", handleLine);
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
