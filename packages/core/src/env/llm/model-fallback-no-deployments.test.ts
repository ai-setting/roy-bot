/**
 * @fileoverview TDD tests for Task #4682 — the tong gateway
 * "No deployments available" error must trigger a fallback.
 *
 * Regression guard (implementation landed in 6927f4f3, review
 * fixes in d7b0dab6). The gaps these tests pin down:
 *
 *   1. `AI SDK RetryError (Failed after N attempts) is eligible` →
 *      the message has no "retry" word, the old RETRY_EXHAUSTED_PATTERNS
 *      missed it.
 *   2. `AI_RetryError name is matched` → /\bretryerror\b/i cannot
 *      match AI_RetryError (underscore is not a word boundary).
 *   3. `plain gateway message is eligible` → "No deployments
 *      available" was not in any pattern list.
 *
 * Regression guard: existing hard blockers must stay blocked.
 */

import { describe, test, expect } from "bun:test";
import {
  isFallbackEligibleError,
} from "./model-fallback";

/** The exact error text from the user's production screenshot (Task #4682). */
const TONG_GATEWAY_TEXT =
  "Failed after 4 attempts. Last error: No deployments available for " +
  "selected model, Try again in 5 seconds. Passed model=GLM-5.3-Flash. " +
  "pre-call-checks=False, cooldown_list=['4364fec50f3bb0a41bdcdecd5ebf5a923e87483134373caae0794df726286b89']";

/** Mirrors the AI SDK (ai@6) RetryError construction. */
function makeAiSdkRetryError(message: string, lastErrorMessage: string): Error {
  const err = new Error(message) as Error & {
    name: string;
    reason: string;
    errors: unknown[];
    lastError: unknown;
  };
  err.name = "AI_RetryError";
  err.reason = "maxRetriesExceeded";
  err.errors = [new Error(lastErrorMessage)];
  err.lastError = err.errors[0];
  return err;
}

describe("Task #4682 — gateway no-deployments errors trigger fallback", () => {
  test("AI SDK RetryError 'Failed after N attempts' is eligible", () => {
    // The AI SDK RetryError message contains NO "retry" word —
    // the old RETRY_EXHAUSTED_PATTERNS (retry/retries/retryerror)
    // cannot match it.
    const err = makeAiSdkRetryError(
      "Failed after 4 attempts. Last error: No deployments available for selected model, Try again in 5 seconds.",
      "No deployments available for selected model",
    );
    expect(isFallbackEligibleError(err)).toBe(true);
  });

  test("AI_RetryError error name is honoured (underscore breaks \\b)", () => {
    const err = new Error("Request failed");
    err.name = "AI_RetryError";
    expect(isFallbackEligibleError(err)).toBe(true);
  });

  test("the exact production error text is eligible (all 3 shapes)", () => {
    // Shape 1: plain string (what error-reply.ts renders)
    expect(isFallbackEligibleError(TONG_GATEWAY_TEXT)).toBe(true);
    // Shape 2: plain Error
    expect(isFallbackEligibleError(new Error(TONG_GATEWAY_TEXT))).toBe(true);
    // Shape 3: redacted transport object (invoke.ts → cause chain)
    expect(
      isFallbackEligibleError({
        name: "AI_RetryError",
        message: TONG_GATEWAY_TEXT,
        reason: "maxRetriesExceeded",
      }),
    ).toBe(true);
  });

  test("bare gateway message without the AI SDK retry wrapper", () => {
    // The adapter path can throw the gateway message directly,
    // without any "Failed after N attempts" prefix.
    expect(
      isFallbackEligibleError(
        new Error(
          "No deployments available for selected model, Try again in 5 seconds. Passed model=GLM-5.3-Flash.",
        ),
      ),
    ).toBe(true);
  });

  test("'Try again in N seconds' alone (gateway cooldown phrasing)", () => {
    expect(
      isFallbackEligibleError(
        new Error("All instances are cooling down. Try again in 30 seconds."),
      ),
    ).toBe(true);
  });

  test("the gateway error with statusCode 400 still triggers (DS review M-1)", () => {
    // The gateway can attach HTTP 400 to the same "No deployments"
    // text — the strong-specificity load-balancer vocabulary is
    // checked BEFORE the hard blockers, like MODEL_UNAVAILABLE_PATTERNS.
    const withStatus = Object.assign(new Error(TONG_GATEWAY_TEXT), {
      statusCode: 400,
    });
    expect(isFallbackEligibleError(withStatus)).toBe(true);
    expect(
      isFallbackEligibleError(
        new Error(TONG_GATEWAY_TEXT, { cause: { statusCode: 400 } }),
      ),
    ).toBe(true);
    // cooldown_list / pre-call-checks alone (strong subset) also pass.
    expect(
      isFallbackEligibleError(
        Object.assign(new Error("pre-call-checks=False, cooldown_list=[a]"), {
          statusCode: 400,
        }),
      ),
    ).toBe(true);
  });

  test("tool-level 'failed after N attempts' does NOT match (DS review m-1)", () => {
    // The tightened regex requires the AI-SDK-specific continuation.
    expect(
      isFallbackEligibleError(new Error("Tool 'bash' failed after 3 attempts")),
    ).toBe(false);
    expect(
      isFallbackEligibleError(new Error("Command failed after 2 attempts")),
    ).toBe(false);
    // But both real AI SDK shapes still match.
    expect(
      isFallbackEligibleError(
        new Error("Failed after 4 attempts. Last error: boom"),
      ),
    ).toBe(true);
    expect(
      isFallbackEligibleError(
        new Error("Failed after 2 attempts with non-retryable error: 'boom'"),
      ),
    ).toBe(true);
  });

  test("regression: hard blockers still blocked (no false positives)", () => {
    expect(isFallbackEligibleError(new Error("401 Unauthorized"))).toBe(false);
    expect(isFallbackEligibleError(new Error("403 Forbidden"))).toBe(false);
    expect(isFallbackEligibleError(new Error("400 Bad Request: bad tool schema"))).toBe(false);
    expect(isFallbackEligibleError(new Error("Request aborted"))).toBe(false);
    expect(
      isFallbackEligibleError(new Error("context window exceeded")),
    ).toBe(false);
  });

  test("regression: 'Failed after N attempts with non-retryable error' stays eligible", () => {
    // The AI SDK also wraps non-retryable errors in a RetryError with
    // the same "Failed after N attempts" prefix — the gateway
    // no-deployment error is exactly that shape in production.
    expect(
      isFallbackEligibleError(
        new Error(
          "Failed after 2 attempts with non-retryable error: 'No deployments available'",
        ),
      ),
    ).toBe(true);
  });

  test("regression: a normal business error is NOT eligible", () => {
    // Tool errors / validation errors must not downgrade the model.
    expect(
      isFallbackEligibleError(new Error("Tool 'edit_file' failed: file not found")),
    ).toBe(false);
    expect(
      isFallbackEligibleError(new Error("Invalid arguments: expected string")),
    ).toBe(false);
  });
});
