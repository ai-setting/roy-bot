/**
 * @fileoverview TDD tests for model fallback eligibility (Task #4623).
 *
 * RED phase — these tests describe the contract BEFORE the implementation
 * exists. The module under test (`./model-fallback`) is intentionally
 * referenced through a dynamic import so the failure mode is an assertion
 * failure rather than a module-resolution error (which would mask the real
 * signal).
 *
 * Contract:
 *   - 404 / 429 / quota / 5xx / timeout / retry-exhausted → ELIGIBLE
 *   - 401 / 403 / 400 / abort / context-threshold     → NOT eligible
 *   - no fallback configured                            → NOT eligible
 */

import { describe, test, expect } from "bun:test";
import {
  isFallbackEligibleError,
  parseFallbackModel,
} from "./model-fallback";

describe("isFallbackEligibleError — eligible cases", () => {
  test("404 statusCode is eligible (user screenshot: 404 Page not found)", () => {
    const err = Object.assign(new Error("Page not found"), { statusCode: 404 });
    expect(isFallbackEligibleError(err)).toBe(true);
  });

  test("bare text '404 Page not found' is eligible (statusCode lost by stringification)", () => {
    expect(isFallbackEligibleError(new Error("404 Page not found"))).toBe(true);
    expect(isFallbackEligibleError("Error | 404 Page not found")).toBe(true);
  });

  test("429 rate limit is eligible", () => {
    expect(isFallbackEligibleError(new Error("429 Too Many Requests"))).toBe(true);
  });

  test("quota exhaustion text is eligible", () => {
    expect(
      isFallbackEligibleError(new Error("You exceeded your current quota, please check your plan and billing details.")),
    ).toBe(true);
    expect(isFallbackEligibleError(new Error("insufficient_quota"))).toBe(true);
    expect(isFallbackEligibleError(new Error("余额不足，额度已用尽"))).toBe(true);
  });

  test("5xx server errors are eligible", () => {
    expect(isFallbackEligibleError(new Error("503 Service Unavailable"))).toBe(true);
    expect(isFallbackEligibleError(new Error("500 Internal Server Error"))).toBe(true);
  });

  test("timeouts / transport errors are eligible", () => {
    expect(isFallbackEligibleError(new Error("Request timed out after 300s"))).toBe(true);
    expect(isFallbackEligibleError(new Error("socket hang up"))).toBe(true);
    expect(isFallbackEligibleError(new Error("fetch failed"))).toBe(true);
  });

  test("retry-exhausted errors are eligible (the user's 'llm 多次调用重试的错误')", () => {
    expect(isFallbackEligibleError(new Error("RetryError: retries exhausted"))).toBe(true);
    expect(isFallbackEligibleError(new Error("max retries exceeded"))).toBe(true);
    expect(isFallbackEligibleError(new Error("All retries failed"))).toBe(true);
  });

  test("statusCode on a plain object is honoured", () => {
    expect(isFallbackEligibleError({ statusCode: 502, message: "bad gateway" })).toBe(true);
  });

  test("status-only errors are eligible without any digits in the text (review P1-1)", () => {
    // AI SDK 常把 response.statusText 当 message（"Not Found"），文本里没有 404。
    expect(isFallbackEligibleError(Object.assign(new Error("Not Found"), { statusCode: 404 }))).toBe(true);
    expect(isFallbackEligibleError(Object.assign(new Error("Too Many Requests"), { statusCode: 429 }))).toBe(true);
    expect(
      isFallbackEligibleError(Object.assign(new Error("Request failed"), { statusCode: 503 })),
    ).toBe(true);
    expect(
      isFallbackEligibleError(Object.assign(new Error("Request Timeout"), { statusCode: 408 })),
    ).toBe(true);
  });

  test("statusCode carried on `cause` is honoured (Task #4625 transport shape)", () => {
    const err = new Error("Request failed", {
      cause: { name: "AI_APICallError", message: "upstream boom", statusCode: 429 },
    });
    expect(isFallbackEligibleError(err)).toBe(true);

    const unavailable = new Error("Upstream request failed", {
      cause: {
        name: "AI_APICallError",
        statusCode: 400,
        responseBody: '{"error":{"message":"Model is unavailable."}}',
      },
    });
    expect(isFallbackEligibleError(unavailable)).toBe(true);
  });

  test("credit-balance exhaustion behind HTTP 400 is eligible (review P1-2)", () => {
    const err = Object.assign(
      new Error("Your credit balance is too low to access the Anthropic API."),
      { statusCode: 400 },
    );
    expect(isFallbackEligibleError(err)).toBe(true);
    expect(isFallbackEligibleError(new Error("402 Payment Required"))).toBe(true);
    expect(isFallbackEligibleError(new Error("insufficient credits"))).toBe(true);
  });

  test("a real TimeoutError is eligible even though its text mentions abort (review P1-3)", () => {
    const timeout = Object.assign(
      new Error("The operation was aborted due to timeout"),
      { name: "TimeoutError" },
    );
    expect(isFallbackEligibleError(timeout)).toBe(true);
    // 但**真正的取消**仍然不降级：AbortError 文本不含 timeout，走 abort blocker。
    expect(
      isFallbackEligibleError(Object.assign(new Error("The operation was aborted"), {
        name: "AbortError",
      })),
    ).toBe(false);
  });

  test("model-unavailable behind HTTP 400 is eligible (2026-10-29 real-gateway shape)", () => {
    // 真机交叉验证：opencodego 对不可用模型返回 400 + "Model is unavailable."
    // 只看状态码会被 400 hard blocker 拦掉，fallback 永不触发。
    const err = new Error("Upstream request failed: Model is unavailable.");
    expect(isFallbackEligibleError(err)).toBe(true);
    expect(
      isFallbackEligibleError(Object.assign(new Error("Upstream request failed: Model is unavailable."), {
        statusCode: 400,
      })),
    ).toBe(true);
    expect(isFallbackEligibleError(new Error("400 Model not found"))).toBe(true);
    expect(isFallbackEligibleError(new Error("model_not_found"))).toBe(true);
    expect(isFallbackEligibleError(new Error("模型不可用"))).toBe(true);
  });
});

describe("isFallbackEligibleError — non-eligible cases", () => {
  test("401 unauthorized is NOT eligible (same credential on fallback model)", () => {
    expect(isFallbackEligibleError(new Error("401 Unauthorized"))).toBe(false);
    expect(isFallbackEligibleError(Object.assign(new Error("nope"), { statusCode: 401 }))).toBe(false);
  });

  test("403 forbidden is NOT eligible even when it mentions quota", () => {
    expect(isFallbackEligibleError(new Error("403 Forbidden"))).toBe(false);
    expect(
      isFallbackEligibleError(new Error("403 quota exceeded for your account")),
    ).toBe(false);
  });

  test("400 bad request is NOT eligible", () => {
    expect(isFallbackEligibleError(new Error("400 Bad Request"))).toBe(false);
  });

  test("abort is NOT eligible (cancellation contract)", () => {
    expect(isFallbackEligibleError(new Error("AbortError: The operation was aborted"))).toBe(false);
  });

  test("context threshold is NOT eligible (prompt too long, not a model problem)", () => {
    expect(isFallbackEligibleError(new Error("Context threshold exceeded: 1230/10000"))).toBe(false);
  });

  test("no fallback configured → always false", () => {
    expect(isFallbackEligibleError(new Error("404 Page not found"), false)).toBe(false);
  });

  test("regressions from review P2-2: no false positives on URLs / params / tool-parse errors", () => {
    // URL 里的 404 不应触发降级
    expect(
      isFallbackEligibleError(new Error("GET https://api.example.com/v1/404/models failed")),
    ).toBe(false);
    // 参数错误里的 500 不应触发降级
    expect(
      isFallbackEligibleError(new Error("Invalid parameter: max_tokens 500 must be <= 4096")),
    ).toBe(false);
    // 工具调用解析错误不是「模型不可用」
    expect(
      isFallbackEligibleError(new Error("Invalid model response: failed to parse tool call JSON")),
    ).toBe(false);
  });

  test("unrelated error is NOT eligible", () => {
    expect(isFallbackEligibleError(new Error("Tool 'bash' not found"))).toBe(false);
  });

  test("null / undefined are NOT eligible", () => {
    expect(isFallbackEligibleError(null)).toBe(false);
    expect(isFallbackEligibleError(undefined)).toBe(false);
  });
});

describe("parseFallbackModel", () => {
  test("providerId/modelId is split", () => {
    expect(parseFallbackModel("tong/GLM-5.3-Flash")).toEqual({
      providerId: "tong",
      modelId: "GLM-5.3-Flash",
    });
  });

  test("bare modelId keeps provider undefined", () => {
    expect(parseFallbackModel("gpt-4o")).toEqual({ modelId: "gpt-4o" });
  });

  test("model ids containing slashes keep the remainder", () => {
    expect(parseFallbackModel("openai/org/meta-llama/Llama-3")).toEqual({
      providerId: "openai",
      modelId: "org/meta-llama/Llama-3",
    });
  });

  test("empty / whitespace input yields undefined", () => {
    expect(parseFallbackModel(undefined)).toBeUndefined();
    expect(parseFallbackModel("")).toBeUndefined();
    expect(parseFallbackModel("   ")).toBeUndefined();
  });
});
