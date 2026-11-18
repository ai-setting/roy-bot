/**
 * OpenCode Go interactive session header (Task #4173)
 *
 * 修复背景：
 * - 用户把 provider id 命名为 `opencodego`（无连字符）写入
 *   `~/.roy-bot/config.jsonc` line 92 + `~/.roy-bot/auth.json`。
 * - `createProviderInstance()` 旧 if 条件只接受 `"opencode"` / `"opencode-go"`，
 *   导致 `"opencodego"` 不命中 → x-opencode-session header 未注入
 *   → 服务端返回 400 MissingSessionID。
 *
 * 修复目标：
 * - 源码必须接受以下三种 provider id 都注入 `x-opencode-session`：
 *     * `"opencodego"`  - 用户当前命名（主目标）
 *     * `"opencode-go"` - 历史命名（向后兼容）
 *     * `"opencode"`    - 原本就支持
 *
 * 测试方法：通过 mock `@ai-sdk/openai-compatible.createOpenAICompatible`
 * 捕获 header，并在源码中新增测试导出 `__createProviderInstanceForTest`。
 *
 * 关联：
 * - 父任务 #2859 [Longterm] roy-bot 主线
 * - #4172 (config 修复) / #4170 (session 稳定 + 安全)
 * - #4168 (集成 commit c99df0fb)
 *
 * 安全：
 * - 本文件不包含任何真实 apiKey（用 `oc_sk_test_placeholder` 占位）。
 */

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  mock,
} from "bun:test";

interface CapturedConfig {
  name?: string;
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  includeUsage?: boolean;
}

const capturedByProvider: Record<string, CapturedConfig> = {};

// Mock @ai-sdk/openai-compatible BEFORE invoking invoke.ts
mock.module("@ai-sdk/openai-compatible", () => {
  return {
    createOpenAICompatible: (cfg: CapturedConfig) => {
      // Bucket by providerId so tests with different provider IDs don't
      // overwrite each other's captured config.
      capturedByProvider[cfg.name ?? "_default"] = cfg;
      return {
        languageModel: (modelId: string) => ({
          modelId,
          provider: "openai-compatible-mock",
        }),
      };
    },
  };
});

// Lazy import after mock setup
const invokeModule = await import("../../src/env/llm/invoke");

// Test-only helper exported by invoke.ts (see __createProviderInstanceForTest)
type CreateProviderInstanceFn = (
  providerId: string,
  apiKey: string,
  baseURL?: string,
  conversationId?: string,
) => any;
const createProviderInstance = (invokeModule as any)
  .__createProviderInstanceForTest as CreateProviderInstanceFn;
const { __clearOpencodeSessionIdCache } = invokeModule;

const TEST_API_KEY = "oc_sk_test_placeholder_not_a_real_key";

describe("createProviderInstance: x-opencode-session header injection (Task #4173)", () => {
  beforeEach(() => {
    for (const k of Object.keys(capturedByProvider)) delete capturedByProvider[k];
    __clearOpencodeSessionIdCache();
  });

  afterEach(() => {
    for (const k of Object.keys(capturedByProvider)) delete capturedByProvider[k];
  });

  test('providerId="opencodego" injects non-empty x-opencode-session header', () => {
    const provider = createProviderInstance("opencodego", TEST_API_KEY, "https://example.com/v1");
    expect(provider).not.toBeNull();
    const captured = capturedByProvider["opencodego"];
    expect(captured).toBeDefined();
    expect(captured.headers).toBeDefined();
    const sid = captured.headers?.["x-opencode-session"];
    expect(sid).toBeDefined();
    expect(sid).not.toBe("");
    // Session ID prefix convention per #4165
    expect(sid).toMatch(/^ses_/);
  });

  test('providerId="opencodego" → stable session id across consecutive calls (same conversationId)', () => {
    const convId = "test-conv-stable-001";
    createProviderInstance("opencodego", TEST_API_KEY, "https://example.com/v1", convId);
    const first = capturedByProvider["opencodego"]?.headers?.["x-opencode-session"];
    expect(first).toBeDefined();
    expect(first).toMatch(/^ses_/);

    // Second call with same conversationId must reuse the same id (stable per conversation)
    createProviderInstance("opencodego", TEST_API_KEY, "https://example.com/v1", convId);
    const second = capturedByProvider["opencodego"]?.headers?.["x-opencode-session"];
    expect(second).toBe(first);
  });

  test('providerId="opencodego" with no conversationId → header still injected (ephemeral ses_ id)', () => {
    createProviderInstance("opencodego", TEST_API_KEY, "https://example.com/v1");
    const sid = capturedByProvider["opencodego"]?.headers?.["x-opencode-session"];
    expect(sid).toBeDefined();
    expect(sid).not.toBe("");
    expect(sid).toMatch(/^ses_/);
  });

  test('providerId="opencode-go" (legacy) still works → backward compatibility', () => {
    createProviderInstance("opencode-go", TEST_API_KEY, "https://example.com/v1");
    const sid = capturedByProvider["opencode-go"]?.headers?.["x-opencode-session"];
    expect(sid).toBeDefined();
    expect(sid).not.toBe("");
    expect(sid).toMatch(/^ses_/);
  });

  test('providerId="opencode" (legacy original) still works → backward compatibility', () => {
    createProviderInstance("opencode", TEST_API_KEY, "https://example.com/v1");
    const sid = capturedByProvider["opencode"]?.headers?.["x-opencode-session"];
    expect(sid).toBeDefined();
    expect(sid).not.toBe("");
    expect(sid).toMatch(/^ses_/);
  });

  test('unrelated provider (e.g. "deepseek") does NOT inject x-opencode-session header', () => {
    createProviderInstance("deepseek", TEST_API_KEY, "https://example.com/v1");
    const sid = capturedByProvider["deepseek"]?.headers?.["x-opencode-session"];
    expect(sid).toBeUndefined();
  });
});
