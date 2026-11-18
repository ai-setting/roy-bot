/**
 * LLM fallback config tests (TDD RED for Task #2888 follow-up)
 *
 * Background:
 *   Task #2888's root-cause report identified that when PiAiAdapter.stream()
 *   fails (e.g. finishReason=error, MIME 400, etc.), LLMComponent.invoke()
 *   falls back to AI SDK invoke() at line 572-580. The fallback currently
 *   uses ctx.invokeConfig as-is, which means it inherits the SAME baseURL
 *   the adapter just failed on. For some custom providers (minimax) this
 *   causes the fallback to hit the WRONG URL and return HTTP 404.
 *
 *   The fix: extract a `resolveFallbackProviderConfig(providerId)` helper
 *   that explicitly reads ~/.roy-bot/config.jsonc + auth.json and returns
 *   the per-provider baseURL/apiKey/providerType. Then plumb the fallback
 *   path to use this helper instead of ctx.invokeConfig.
 *
 *   These tests verify:
 *     1. Fallback reads apiKey/baseURL from auth.json (config-driven)
 *     2. Fallback respects per-provider config from config.jsonc
 *     3. Fallback for unknown provider → throws clear error
 *
 *   The tests use vi.spyOn(fs, "readFile") to mock both files (same pattern
 *   as mcp/loader.test.ts).
 */
import { describe, test, expect, vi, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import { resolveFallbackProviderConfig } from "./llm";

const FAKE_AUTH_JSON = JSON.stringify({
  providers: {
    minimax: {
      apiKey: "sk-cp-fake-minimax-key-for-test-only",
      baseURL: "https://api.minimaxi.com/anthropic",
    },
    anthropic: {
      apiKey: "sk-ant-fake-anthropic-key-for-test-only",
      baseURL: "https://api.anthropic.com",
    },
    openai: {
      apiKey: "sk-fake-openai-key-for-test-only",
      baseURL: "https://api.openai.com/v1",
    },
  },
});

const FAKE_CONFIG_JSONC = `{
  // jsonc with comments — config-driven router
  "llm": {
    "providers": {
      "minimax": {
        "provider": "openai-compatible",
        "name": "MiniMax",
        "defaultModel": "MiniMax-M3"
      },
      "anthropic": {
        "provider": "anthropic",
        "name": "Anthropic",
        "defaultModel": "claude-3-5-sonnet-20240620"
      },
      "openai": {
        "provider": "openai",
        "name": "OpenAI",
        "defaultModel": "gpt-4o"
      }
    }
  }
}`;

describe("resolveFallbackProviderConfig - reads ~/.roy-bot/config.jsonc + auth.json (Task #2888)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Test 1: returns per-provider baseURL/apiKey from auth.json
  test("minimax: returns baseURL + apiKey from auth.json (config-driven, not hardcoded)", async () => {
    vi.spyOn(fs, "readFile").mockImplementation(async (p: any) => {
      const path = String(p);
      if (path.endsWith("auth.json")) return FAKE_AUTH_JSON;
      if (path.endsWith("config.jsonc")) return FAKE_CONFIG_JSONC;
      throw new Error(`unexpected readFile path: ${path}`);
    });

    const result = await resolveFallbackProviderConfig("minimax");
    expect(result.baseURL).toBe("https://api.minimaxi.com/anthropic");
    expect(result.apiKey).toBe("sk-cp-fake-minimax-key-for-test-only");
    // sanity: apiKey comes from auth.json (not a hardcoded "sk-test" placeholder)
    expect(result.apiKey).toContain("fake-minimax");
  });

  // Test 2: anthropic provider (different baseURL)
  test("anthropic: returns baseURL + apiKey from auth.json", async () => {
    vi.spyOn(fs, "readFile").mockImplementation(async (p: any) => {
      const path = String(p);
      if (path.endsWith("auth.json")) return FAKE_AUTH_JSON;
      if (path.endsWith("config.jsonc")) return FAKE_CONFIG_JSONC;
      throw new Error(`unexpected readFile path: ${path}`);
    });

    const result = await resolveFallbackProviderConfig("anthropic");
    expect(result.baseURL).toBe("https://api.anthropic.com");
    expect(result.apiKey).toBe("sk-ant-fake-anthropic-key-for-test-only");
  });

  // Test 3: openai provider (control case — confirms each provider is independent)
  test("openai: returns baseURL + apiKey from auth.json", async () => {
    vi.spyOn(fs, "readFile").mockImplementation(async (p: any) => {
      const path = String(p);
      if (path.endsWith("auth.json")) return FAKE_AUTH_JSON;
      if (path.endsWith("config.jsonc")) return FAKE_CONFIG_JSONC;
      throw new Error(`unexpected readFile path: ${path}`);
    });

    const result = await resolveFallbackProviderConfig("openai");
    expect(result.baseURL).toBe("https://api.openai.com/v1");
    expect(result.apiKey).toBe("sk-fake-openai-key-for-test-only");
  });

  // Test 4: returns providerType from config.jsonc when present
  test("returns providerType from config.jsonc (not hardcoded 'openai')", async () => {
    vi.spyOn(fs, "readFile").mockImplementation(async (p: any) => {
      const path = String(p);
      if (path.endsWith("auth.json")) return FAKE_AUTH_JSON;
      if (path.endsWith("config.jsonc")) return FAKE_CONFIG_JSONC;
      throw new Error(`unexpected readFile path: ${path}`);
    });

    const minimaxResult = await resolveFallbackProviderConfig("minimax");
    expect(minimaxResult.providerType).toBe("openai-compatible");

    const anthropicResult = await resolveFallbackProviderConfig("anthropic");
    expect(anthropicResult.providerType).toBe("anthropic");
  });

  // Test 5: unknown provider → throws clear error
  test("unknown provider → throws clear 'no config found' error", async () => {
    vi.spyOn(fs, "readFile").mockImplementation(async (p: any) => {
      const path = String(p);
      if (path.endsWith("auth.json")) return FAKE_AUTH_JSON;
      if (path.endsWith("config.jsonc")) return FAKE_CONFIG_JSONC;
      throw new Error(`unexpected readFile path: ${path}`);
    });

    expect(() =>
      resolveFallbackProviderConfig("nonexistent-provider-xyz")
    ).toThrow(/no config found/i);
  });

  // Test 6: config.jsonc has JSON-with-comments (jsonc) — comments must be stripped
  test("parses config.jsonc (JSON-with-comments) without crashing", async () => {
    const configWithManyComments = `{
      // line comment 1
      /* block comment */
      "llm": {
        "providers": {
          "minimax": {
            "provider": "openai-compatible"  // trailing comment
          }
        }
      }
    }`;
    vi.spyOn(fs, "readFile").mockImplementation(async (p: any) => {
      const path = String(p);
      if (path.endsWith("auth.json")) return FAKE_AUTH_JSON;
      if (path.endsWith("config.jsonc")) return configWithManyComments;
      throw new Error(`unexpected readFile path: ${path}`);
    });

    const result = await resolveFallbackProviderConfig("minimax");
    expect(result.providerType).toBe("openai-compatible");
  });

  // Test 7: apiKey prefix sanity check — must be config-driven, not hardcoded
  test("does NOT hardcode baseURL — different auth.json gives different baseURL", async () => {
    const customAuth = JSON.stringify({
      providers: {
        minimax: {
          apiKey: "custom-key",
          baseURL: "https://my-custom-proxy.example.com/v1",
        },
      },
    });
    vi.spyOn(fs, "readFile").mockImplementation(async (p: any) => {
      const path = String(p);
      if (path.endsWith("auth.json")) return customAuth;
      if (path.endsWith("config.jsonc")) return FAKE_CONFIG_JSONC;
      throw new Error(`unexpected readFile path: ${path}`);
    });

    const result = await resolveFallbackProviderConfig("minimax");
    expect(result.baseURL).toBe("https://my-custom-proxy.example.com/v1");
  });
});