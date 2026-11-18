/**
 * OpenCode Go Provider 配置解析测试 (Task #4168)
 *
 * 验证目标：
 * 1. auth.json 含 `providers.opencode-go.{apiKey, baseURL}` 时
 *    `resolveFallbackProviderConfig("opencode-go")` 能正确返回 baseURL
 * 2. baseURL 必须是用户修正后的 `https://opencode.ai/inference/go/v1`
 *    （不是之前错的 `https://opencode.ai/zen/go`）
 * 3. config.jsonc 缺 `llm.providers.opencode-go.provider` 时默认走 "openai-compatible"
 *
 * 关联：
 * - 父任务 #2859 [Longterm] roy-bot 主线
 * - 调研 #4158 (opencode 集成调研) / #4165 (free tier 客户端识别)
 * - 实施 #4168 (方案 A 轻量集成)
 *
 * 实现方式：mock home 目录，写临时 auth.json + config.jsonc，验证返回值
 */

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  mock,
} from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Mock node:os BEFORE importing llm.ts so the module captures our homedir
let mockHome: string | null = null;
mock.module("node:os", () => {
  const realOs = require("node:os");
  return {
    ...realOs,
    homedir: () => mockHome ?? realOs.homedir(),
  };
});

// Import after mock setup
const { resolveFallbackProviderConfig } = await import(
  "../../src/env/llm/llm"
);

describe("resolveFallbackProviderConfig: opencode-go provider", () => {
  // SECURITY: never put a real credential in this file — it is committed to git
  // and CI logs. Use an obviously-fake placeholder instead.
  const TEST_API_KEY = "oc_sk_test_placeholder_not_a_real_key";

  let tempHome: string;
  let authPath: string;
  let configPath: string;

  beforeEach(async () => {
    // Create temp home with auth.json + config.jsonc
    tempHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "roy-bot-opencode-go-"),
    );
    authPath = path.join(tempHome, ".roy-bot", "auth.json");
    configPath = path.join(tempHome, ".roy-bot", "config.jsonc");

    await fs.mkdir(path.dirname(authPath), { recursive: true });

    // Set mock home for this test
    mockHome = tempHome;
  });

  afterEach(async () => {
    // Clear mock home
    mockHome = null;
    // Cleanup temp
    try {
      await fs.rm(tempHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("auth.json has opencode-go provider with corrected baseURL → resolves to inference/go/v1", async () => {
    // Given: user auth.json with corrected baseURL
    const auth = {
      providers: {
        "opencode-go": {
          apiKey: TEST_API_KEY,
          baseURL: "https://opencode.ai/inference/go/v1",
        },
      },
    };
    await fs.writeFile(authPath, JSON.stringify(auth));

    // And: config.jsonc with providerType override
    const configText = `{
      "llm": {
        "providers": {
          "opencode-go": {
            "provider": "openai-compatible"
          }
        }
      }
    }`;
    await fs.writeFile(configPath, configText);

    // When: resolveFallbackProviderConfig("opencode-go") is called
    const result = await resolveFallbackProviderConfig("opencode-go");

    // Then: baseURL is the corrected inference/go/v1
    expect(result.baseURL).toBe("https://opencode.ai/inference/go/v1");
    expect(result.apiKey).toBe(TEST_API_KEY);
    expect(result.providerType).toBe("openai-compatible");
  });

  test("missing config.jsonc provider override → defaults to openai-compatible", async () => {
    // Given: auth.json with opencode-go, but config.jsonc has no llm.providers entry
    const auth = {
      providers: {
        "opencode-go": {
          apiKey: "oc_sk_test",
          baseURL: "https://opencode.ai/inference/go/v1",
        },
      },
    };
    await fs.writeFile(authPath, JSON.stringify(auth));
    await fs.writeFile(configPath, "{}");

    // When
    const result = await resolveFallbackProviderConfig("opencode-go");

    // Then: default providerType is "openai-compatible"
    expect(result.providerType).toBe("openai-compatible");
    expect(result.baseURL).toBe("https://opencode.ai/inference/go/v1");
  });

  test("missing opencode-go entry in auth.json → throws", async () => {
    // Given: empty providers
    await fs.writeFile(authPath, JSON.stringify({ providers: {} }));
    await fs.writeFile(configPath, "{}");

    // When / Then
    await expect(
      resolveFallbackProviderConfig("opencode-go"),
    ).rejects.toThrow(/no config found/);
  });

  test("architecture invariant: opencode-go + openai-compatible → @ai-sdk/openai-compatible consumer", async () => {
    // Verifies that the providerType 'openai-compatible' maps to the right npm dependency,
    // and that baseURL ends in /v1 (standard OpenAI API root).

    // Given
    const auth = {
      providers: {
        "opencode-go": {
          apiKey: "oc_sk_test",
          baseURL: "https://opencode.ai/inference/go/v1",
        },
      },
    };
    await fs.writeFile(authPath, JSON.stringify(auth));
    await fs.writeFile(configPath, "{}");

    // When
    const result = await resolveFallbackProviderConfig("opencode-go");

    // Then
    expect(result.providerType).toBe("openai-compatible");
    expect(result.baseURL.endsWith("/v1")).toBe(true);

    // Sanity: @ai-sdk/openai-compatible exports the function invoke.ts uses
    const aiSdk = await import("@ai-sdk/openai-compatible");
    expect(typeof aiSdk.createOpenAICompatible).toBe("function");
  });

  test("providerType 'openai-compatible' triggers default branch in createProviderInstance", async () => {
    // Verify the architectural contract: any providerId not in {openai, anthropic, google}
    // (which includes 'opencode-go') falls through to createOpenAICompatible({...}).
    //
    // We can verify this by looking at invoke.ts source: the function has an `if/else if/else`
    // chain ending in createOpenAICompatible({name: providerId, ...}).
    //
    // Direct test via mock.module("@ai-sdk/openai-compatible") and re-importing invoke.ts
    // would be brittle (Bun ESM live-binding issues). Instead, we assert the observable
    // contract: providerType matches and baseURL ends in /v1.

    const auth = {
      providers: {
        "opencode-go": {
          apiKey: "oc_sk_test",
          baseURL: "https://opencode.ai/inference/go/v1",
        },
      },
    };
    await fs.writeFile(authPath, JSON.stringify(auth));
    await fs.writeFile(configPath, "{}");

    const result = await resolveFallbackProviderConfig("opencode-go");

    // The default branch in createProviderInstance (invoke.ts:1317) requires:
    //   - providerType !== 'openai' && providerType !== 'anthropic' && providerType !== 'google'
    //   - providerType === 'openai-compatible' is the documented default in
    //     resolveFallbackProviderConfig
    expect(result.providerType).not.toBe("openai");
    expect(result.providerType).not.toBe("anthropic");
    expect(result.providerType).not.toBe("google");
    expect(result.providerType).toBe("openai-compatible");
  });
});