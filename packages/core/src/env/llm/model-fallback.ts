/**
 * @fileoverview Model fallback eligibility detection (Task #4623).
 *
 * Background
 * ----------
 * The user reported that `roy-bot act ... --model <provider/model>` works for
 * the default agent, but sub-agents spawned via `delegate_task` silently fall
 * back to the configured default model. On top of that, when the primary model
 * runs out of quota the whole run dies with `Error | 404 Page not found` and
 * there is no way to keep going.
 *
 * This module owns two pure concerns:
 *
 *   1. `isFallbackEligibleError()` — decide whether a given failure should
 *      trigger a model downgrade.
 *   2. `parseFallbackModel()` — normalise a `providerId/modelId` string.
 *
 * ⚠️ WHY TEXT MATCHING (and not `instanceof`)
 *
 * The production error chain destroys the error *type* before it ever reaches
 * us:
 *
 *   - `llm.ts:873`  → `throw new Error(result.result)` (AI SDK stringifies
 *                     the error, `statusCode` is lost)
 *   - `environment.ts:handle_query` → `throw new Error(result.error)`
 *   - `error-reply.ts` → `classifyReactFailure()` matches on **text**
 *     (its own comment says "不能依赖 instanceof RetryError")
 *
 * So the only signal that survives to the fallback layer is the message text
 * (plus, when the provider happens to expose it, a `statusCode` property).
 * Both are inspected here.
 */

/**
 * HTTP status codes that explicitly disqualify a fallback.
 *
 * ⚠️ 404 is deliberately NOT in this set — the user's screenshot
 * (`Error | 404 Page not found`) is the primary trigger for a fallback.
 */
const NON_FALLBACKABLE_STATUS = new Set([400, 401, 403]);

/**
 * "This model does not exist / is not available" markers (Task #4623 交叉验证).
 *
 * ⚠️ 为什么必须在 hard blocker **之前**判断：
 *
 * 2026-10-29 真机交叉验证发现，opencodego 网关对**不可用的模型**返回的是
 * **HTTP 400**（不是 404）：
 *
 *   statusCode: 400
 *   responseBody: {"error":{"type":"server_error",
 *     "message":"Upstream request failed: Model is unavailable."}}
 *
 * 如果只按状态码判定，这条最常见的"额度/模型不可用"路径会被 400 hard blocker
 * 拦掉，fallback 永远不触发 —— 正是用户要解决的场景。所以这里先看**语义**：
 * 只要错误文本明确指向"模型不可用/不存在"，就视为可降级，与状态码无关。
 *
 * 与之相对，"400 Bad Request"（参数/工具 schema 错误）不含这些语义，仍然不降级。
 */
const MODEL_UNAVAILABLE_PATTERNS: RegExp[] = [
  /model(?:\s+id|\s+name)?\s+(?:is\s+)?(?:unavailable|not\s+available)/i,
  /model(?:\s+id|\s+name)?\s+(?:is\s+)?(?:not\s+found|does\s+not\s+exist|not\s+supported|deprecated|disabled|invalid|unknown)/i,
  // 只认「unknown/unsupported/nonexistent + model」这种整体语义；
  // 不再收录 `invalid model` —— "Invalid model response: failed to parse tool call JSON"
  // 是工具调用/序列化错误，换模型并不能修好（review P2-2 实测误命中）。
  /\b(?:unknown|unsupported|nonexistent)\s+model\b/i,
  /model[_\s-]?not[_\s-]?found/i,
  /no\s+such\s+model/i,
  /模型(?:不存在|不可用|未找到|不支持|已下线)/,
];

/**
 * 余额/付费语义（review P1-2）。
 *
 * Anthropic 余额耗尽返回 **400**：`Your credit balance is too low to access the
 * Anthropic API.` —— 既不含 quota 关键词，又会被 400 hard blocker 拦掉。
 * 这类"钱包空了"的语义必须和"模型不可用"同级，在 hard blocker 之前判定。
 */
const CREDIT_PATTERNS: RegExp[] = [
  /credit balance/i,
  /balance (?:is )?too? ?low/i,
  /insufficient (?:balance|credits?|funds?)/i,
  /payment required/i,
  /\b402\b/,
  /充值|欠费/,
];

/** Errors that are never worth a model switch: cancellation and prompt-too-long. */
const INTRINSIC_BLOCKERS: RegExp[] = [
  /abort(?:ed|error)?/i,
  /operation was (?:aborted|cancelled)/i,
  /context threshold exceeded/i,
  /context window (?:exceeded|overflow)/i,
];

/**
 * Quota / rate-limit / billing markers.
 *
 * These are matched case-insensitively against the error text. They cover the
 * "model 额度到了" scenario the user described, which some providers surface
 * as 403 rather than 429.
 */
const QUOTA_PATTERNS: RegExp[] = [
  /insufficient[_ ]quota/i,
  /exceeded your current quota/i,
  /quota (?:exceeded|exhausted)/i,
  /rate[ _-]?limit/i,
  /\b429\b/,
  /too many requests/i,
  /billing/i,
  /insufficient balance/i,
  /余额不足/i,
  /额度(?:不足|耗尽|用尽|超限)/,
  /配额(?:不足|耗尽|用尽)/,
];

/** Server-side / transient markers → worth one retry on a different model. */
const SERVER_ERROR_PATTERNS: RegExp[] = [
  // 不再用裸 `\b5\d{2}\b`：`max_tokens 500 must be <= 4096` 这类参数错误会被误判
  // （review P2-2）。真实 5xx 由 statusCode 分支负责；文本分支只认带语义的形态。
  /(?:http|status|code|error)\D{0,12}5\d{2}\b/i,
  /\b5\d{2}\s+(?:internal|bad\s+gateway|service\s+unavailable|gateway\s+timeout|server\s+error)/i,
  /internal server error/i,
  /bad gateway/i,
  /service unavailable/i,
  /gateway timeout/i,
  /overloaded/i,
];

/**
 * Timeout / transport markers.
 *
 * A timed-out primary model is worth retrying on the fallback: the fallback
 * provider may simply be faster.
 */
const TIMEOUT_PATTERNS: RegExp[] = [
  /timed?[\s_-]?out/i,
  /timeout/i,
  /etimedout/i,
  /econnreset/i,
  /econnrefused/i,
  /socket hang up/i,
  /network (?:error|failure)/i,
  /fetch failed/i,
];

/**
 * "The provider already retried and still failed" markers.
 *
 * The AI SDK layer (`invoke.ts:1155`, `maxRetries: MAX_RETRIES` = 3) retries
 * transient failures internally. When those retries are exhausted the error
 * bubbles up, and the user asked for exactly that case ("llm 多次调用重试的
 * 错误") to be eligible for a fallback.
 */
const RETRY_EXHAUSTED_PATTERNS: RegExp[] = [
  /retry(?:ing)? (?:failed|exhausted)/i,
  /retries exhausted/i,
  /max(?:imum)? ?retries/i,
  /too many retries/i,
  /\bretryerror\b/i,
  /all retries? failed/i,
  // Task #4682: the AI SDK RetryError message is
  // `Failed after N attempts. Last error: ...` (maxRetriesExceeded) or
  // `Failed after N attempts with non-retryable error: ...`
  // (errorNotRetryable) — neither contains a "retry" word, so every
  // pattern above misses it. This is the same shape `error-reply.ts`
  // UPSTREAM_RETRY_PATTERNS matches.
  // DS review m-1: require the AI-SDK-specific continuation
  // (". Last error" / " with non-retryable error") so tool-level
  // "failed after 3 attempts" messages do NOT match.
  /failed after \d+ attempts(?:\. last error| with non-retryable error)/i,
  // Task #4682: `AI_RetryError` — the underscore is not a word
  // boundary, so /\bretryerror\b/i cannot match the name.
  /ai_?retryerror/i,
];

/**
 * Gateway load-balancer exhaustion markers (Task #4682).
 *
 * The tong gateway answers with
 * `No deployments available for selected model, Try again in 5 seconds.
 * Passed model=... cooldown_list=[...]` when every upstream instance
 * for the model is cooling down / unavailable. "deployments" and
 * "cooldown_list" are gateway-side load-balancing vocabulary — the
 * correct remedy is a different model (different provider), which is
 * exactly what a fallback is for.
 */
const GATEWAY_NO_DEPLOYMENT_PATTERNS: RegExp[] = [
  /no deployments? available/i,
  /try again in \d+ seconds?/i,
  /cooldown_list/i,
  /pre-call-checks/i,
];

/**
 * The HIGH-SPECIFICITY subset of the gateway vocabulary
 * (Task #4682, DS review M-1).
 *
 * "deployments" / "cooldown_list" / "pre-call-checks" are
 * load-balancer proper nouns — no normal business error carries
 * them, so this subset is checked BEFORE the hard blockers
 * (same architecture decision as MODEL_UNAVAILABLE_PATTERNS:
 * the gateway answers HTTP 400 for "model unavailable", and a
 * "No deployments" error carrying statusCode 400 would otherwise
 * be blocked forever).
 */
const GATEWAY_LB_STRONG_PATTERNS: RegExp[] = [
  /no deployments? available/i,
  /cooldown_list/i,
  /pre-call-checks/i,
];

/**
 * Errors that must NEVER trigger a fallback, regardless of their text.
 *
 * - 401/403 — authentication/authorisation. The fallback model normally lives
 *   under the *same* provider and therefore uses the *same* credential, so
 *   switching models cannot possibly help; it only burns an extra request and
 *   delays the real error message.
 * - 400 — the request itself is malformed (bad tool schema, bad payload).
 *   A different model would reject it the same way.
 * - Abort — the user (or the task timeout) explicitly cancelled. Silently
 *   restarting on another model would violate the cancellation contract.
 */
const HARD_BLOCKERS: RegExp[] = [
  /\b401\b/,
  /unauthorized/i,
  /\b403\b/,
  /forbidden/i,
  /invalid[ _-]?api[ _-]?key/i,
  /authentication (?:failed|error)/i,
  /\b400\b/,
  /bad request/i,
  /abort(?:ed|error)?/i,
  /operation was (?:aborted|cancelled)/i,
  /context threshold exceeded/i,
  /context window (?:exceeded|overflow)/i,
];

/** Extract a best-effort HTTP status code from an error object. */
function extractStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as Record<string, unknown>;
  const cause = (candidate.cause ?? undefined) as Record<string, unknown> | undefined;
  const raw =
    candidate.statusCode ??
    candidate.status ??
    (candidate.response as Record<string, unknown> | undefined)?.status ??
    cause?.statusCode ??
    cause?.status;
  const num = typeof raw === "number" ? raw : Number(raw);  return Number.isFinite(num) && num > 0 ? num : undefined;
}

/** Keys that may carry the provider's human-readable failure reason. */
const TEXT_KEYS = [
  "message",
  "errorMessage",
  "reason",
  "detail",
  "body",
  "responseBody",
  "error",
  "data",
  "lastError",
];

/**
 * Collect all text fragments that might carry the failure signal.
 *
 * review P2-1：`cause` 不一定是 Error —— Task #4625 之后 `llm.ts` 抛出的
 * `Error(msg, { cause })` 里，`cause` 是**脱敏后的普通对象副本**，真正的
 * `statusCode` / `responseBody` / `data` 都在它上面。之前只处理
 * `cause instanceof Error`，导致这类结构化错误只看到一个笼统的 message。
 */
function collectErrorText(error: unknown): string {
  const parts: string[] = [];
  const pushFromObject = (obj: Record<string, unknown>): void => {
    for (const key of TEXT_KEYS) {
      const value = obj[key];
      if (typeof value === "string") parts.push(value);
    }
  };

  if (typeof error === "string") {
    parts.push(error);
  } else if (error instanceof Error) {
    parts.push(error.message);
    parts.push(error.name);
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error) {
      parts.push(cause.message);
      parts.push(cause.name);
    } else if (typeof cause === "string") {
      parts.push(cause);
    } else if (cause && typeof cause === "object") {
      pushFromObject(cause as Record<string, unknown>);
    }
  } else if (error && typeof error === "object") {
    pushFromObject(error as Record<string, unknown>);
  }
  return parts.filter(Boolean).join(" | ");
}

/**
 * Decide whether a failure should trigger a model fallback.
 *
 * @param error       The thrown value (may be an Error, a plain object, or a string).
 * @param hasFallback Whether a fallback model is actually configured. When
 *                    `false` this always returns `false` so callers can use it
 *                    as a single guard.
 */
export function isFallbackEligibleError(error: unknown, hasFallback = true): boolean {
  if (!hasFallback) return false;
  if (error === undefined || error === null) return false;

  const text = collectErrorText(error);
  const status = extractStatusCode(error);

  // 1) 超时优先于 abort（review P1-3）。
  //    真实 `AbortSignal.timeout()` / undici 抛的是
  //    `TimeoutError: The operation was aborted due to timeout` ——
  //    文本同时命中 abort 语义，若先判 abort 就会把超时永久拦掉。
  //    （与 `error-reply.ts` 里「timeout 必须在 aborted 之前」的结论一致。）
  const timedOut = TIMEOUT_PATTERNS.some((re) => re.test(text));
  if (timedOut) return true;

  // 2) 内在阻断：真正的取消 / 上下文超限 —— 换模型也没意义，且必须尊重中断语义。
  if (INTRINSIC_BLOCKERS.some((re) => re.test(text))) return false;

  // 3) "模型不可用/不存在" / 余额耗尽 —— 语义优先于状态码
  //    （见 MODEL_UNAVAILABLE_PATTERNS / CREDIT_PATTERNS 的注释：
  //     真实网关会用 400 表达模型不可用 / 余额不足）。
  if (MODEL_UNAVAILABLE_PATTERNS.some((re) => re.test(text))) return true;
  if (CREDIT_PATTERNS.some((re) => re.test(text))) return true;

  // 3.5) 网关负载均衡耗尽（Task #4682，DS review M-1）——
  //     与 MODEL_UNAVAILABLE_PATTERNS 同级：语义优先于状态码。
  //     真机事实（本文件头注释）：opencodego 网关用 HTTP 400 表达
  //     "模型不可用"；tong 网关的 "No deployments available" 若带上
  //     statusCode: 400，放在 hard blocker 之后会被 400 拦掉，
  //     同一故障换个形态复发。强特异性子集（负载均衡专有名词）
  //     提前判定是安全的。
  //     弱特异性的 /try again in \d+ seconds?/i 留在 hard blocker
  //     之后（step 6）——礼貌性文案不应越过认证/参数错误判定。
  if (GATEWAY_LB_STRONG_PATTERNS.some((re) => re.test(text))) return true;

  // 4) 其余 hard blocker（认证 / 参数错误）—— 换同一个 key 的模型无益。
  if (HARD_BLOCKERS.some((re) => re.test(text))) return false;
  if (status !== undefined && NON_FALLBACKABLE_STATUS.has(status)) return false;

  // 5) 状态码直判（review P1-1）：429 / 408 / 5xx / 404 —— 即使文本里没有数字
  //    （AI SDK 常把 `response.statusText` 当 message，例如 "Not Found"）。
  if (status !== undefined) {
    if (status === 404 || status === 408 || status === 429 || status >= 500) return true;
  }

  // 6) 文本兜底：404 只认独立出现的 "404"，避免 URL / request-id 里的 404
  //    （如 `GET https://api/v1/404/models failed`）造成误判（review P2-2）。
  if (/(?:^|[^/\w])404(?!\d)/.test(text)) return true;

  if (QUOTA_PATTERNS.some((re) => re.test(text))) return true;
  if (SERVER_ERROR_PATTERNS.some((re) => re.test(text))) return true;
  if (RETRY_EXHAUSTED_PATTERNS.some((re) => re.test(text))) return true;
  // Task #4682: 弱特异性网关文案（"Try again in N seconds"）——
  // 留在 hard blocker 之后：401/403 body 里的礼貌性文案不应降级。
  if (GATEWAY_NO_DEPLOYMENT_PATTERNS.some((re) => re.test(text))) return true;

  return false;
}

/**
 * Normalise a fallback model string.
 *
 * Accepted formats:
 *   - `"providerId/modelId"`  → `{ providerId, modelId }`
 *   - `"modelId"`             → `{ providerId: undefined, modelId }`
 *
 * @returns `undefined` when the input is empty / whitespace-only.
 */
export function parseFallbackModel(
  fallbackModel: string | undefined,
): { providerId?: string; modelId: string } | undefined {
  if (!fallbackModel) return undefined;
  const trimmed = fallbackModel.trim();
  if (!trimmed) return undefined;
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex > 0) {
    return {
      providerId: trimmed.slice(0, slashIndex),
      modelId: trimmed.slice(slashIndex + 1),
    };
  }
  return { modelId: trimmed };
}
