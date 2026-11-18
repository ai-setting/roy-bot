/**
 * Unit tests for the shared OpenCode Go provider helpers.
 *
 * These lock in the provider-id normalization so every spelling users have
 * registered over time (`opencode`, `opencode-go`, `opencode_go`, `opencodego`)
 * is recognized by BOTH the default PiAiAdapter path and the AI SDK path.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  isOpencodeProvider,
  isOpencodeEndpoint,
  buildOpencodeHeaders,
  getOrCreateOpencodeSessionId,
  generateOpencodeSessionId,
  __clearOpencodeSessionIdCache,
} from "./opencode-session";

describe("isOpencodeProvider", () => {
  test("recognizes every historical spelling (case / -_ insensitive)", () => {
    for (const id of ["opencode", "opencode-go", "opencode_go", "opencodego", "OpenCodeGo", "OPENCODE"]) {
      expect(isOpencodeProvider(id)).toBe(true);
    }
  });

  test("rejects unrelated or empty providers", () => {
    for (const id of ["deepseek", "openai", "openai-compatible", "", undefined, null]) {
      expect(isOpencodeProvider(id as any)).toBe(false);
    }
  });
});

describe("isOpencodeEndpoint", () => {
  test("matches the official OpenCode Go endpoint", () => {
    expect(isOpencodeEndpoint("https://opencode.ai/inference/go/v1")).toBe(true);
    expect(isOpencodeEndpoint("https://opencode.ai/inference/go")).toBe(true);
  });

  test("rejects unrelated endpoints", () => {
    expect(isOpencodeEndpoint("https://api.deepseek.com")).toBe(false);
    expect(isOpencodeEndpoint("https://not-opencode.ai.evil.com/inference/go/v1")).toBe(false);
    expect(isOpencodeEndpoint(undefined)).toBe(false);
  });
});

describe("generateOpencodeSessionId", () => {
  test("has the ses_ prefix and hex timestamp shape", () => {
    const id = generateOpencodeSessionId(1_791_959_398_930);
    expect(id).toMatch(/^ses_[0-9a-f]{12}[A-Za-z0-9]{14}$/);
  });
});

describe("getOrCreateOpencodeSessionId / buildOpencodeHeaders", () => {
  beforeEach(() => __clearOpencodeSessionIdCache());

  test("stable per conversation id (Feishu oc_ chat id works as key)", () => {
    const conv = "oc_ce59231c7152ae7e2e948608e8294b18";
    const a = getOrCreateOpencodeSessionId(conv);
    const b = getOrCreateOpencodeSessionId(conv);
    expect(a).toBe(b);
    expect(a).toMatch(/^ses_/);
  });

  test("distinct conversations get distinct session ids", () => {
    const a = getOrCreateOpencodeSessionId("oc_a");
    const b = getOrCreateOpencodeSessionId("oc_b");
    expect(a).not.toBe(b);
  });

  test("no conversation id → ephemeral ses_ id (not cached)", () => {
    const a = getOrCreateOpencodeSessionId(undefined);
    const b = getOrCreateOpencodeSessionId(undefined);
    expect(a).toMatch(/^ses_/);
    expect(b).toMatch(/^ses_/);
  });

  test("buildOpencodeHeaders returns header only for OpenCode providers", () => {
    expect(buildOpencodeHeaders("opencodego", "oc_x")).toEqual({
      "x-opencode-session": getOrCreateOpencodeSessionId("oc_x"),
    });
    expect(buildOpencodeHeaders("deepseek", "oc_x")).toEqual({});
    expect(buildOpencodeHeaders(undefined)).toEqual({});
  });

  test("buildOpencodeHeaders also matches by endpoint (rename-proof)", () => {
    const headers = buildOpencodeHeaders("some-renamed-provider", "oc_y", "https://opencode.ai/inference/go/v1");
    expect(headers["x-opencode-session"]).toMatch(/^ses_/);
    // Same conversation key → same header value as id-based lookup.
    expect(headers["x-opencode-session"]).toBe(getOrCreateOpencodeSessionId("oc_y"));
  });
});
