/**
 * PiAiAdapter × OpenCode Go header injection (regression for the default path).
 *
 * 背景（用户飞书反馈 2026-10-14）：
 * - 默认 LLM 路径是 `PiAiAdapter`（ROY_LLM_PROVIDER 未设置 → pi-ai）。
 * - 历史修复 (#4168 / #4173) 只在 AI SDK 的 `createProviderInstance()` 里注入
 *   `x-opencode-session`，pi-ai 路径完全没注入。
 * - 结果：默认路径每次都以 400 MissingSessionID 失败，只能靠 AI SDK fallback 兜底；
 *   一旦 fallback 不可用（旧 standalone / config 解析失败）就直接报错。
 *   飞书渠道的 chat-keyed session id 是 `oc_...` 开头，同样复现（与前缀无关）。
 *
 * 本测试直接捕获 PiAiAdapter 传给 pi-ai 的 options.headers，断言：
 * - opencodego / opencode-go / opencode → 注入非空且 sha`ses_` 前缀的 header
 * - 同一个 sessionId → header 稳定（便于服务端缓存路由）
 * - 无关 provider（deepseek）→ 不注入
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";

interface CapturedCall {
  options?: { headers?: Record<string, string> };
}

const completeCalls: CapturedCall[] = [];
const streamCalls: CapturedCall[] = [];

mock.module("@earendil-works/pi-ai", () => {
  const assistantMessage = () => ({
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    stopReason: "stop",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    model: "deepseek-v4.1-flash",
    provider: "opencodego",
    api: "openai-completions",
  });
  return {
    complete: async (_model: unknown, _ctx: unknown, options?: CapturedCall["options"]) => {
      completeCalls.push({ options });
      return assistantMessage();
    },
    stream: (_model: unknown, _ctx: unknown, options?: CapturedCall["options"]) => {
      streamCalls.push({ options });
      return {
        // Minimal async-iterable + result() shape used by the adapter.
        [Symbol.asyncIterator]: async function* () {},
        result: async () => assistantMessage(),
      };
    },
    // Force the custom-descriptor fallback path (no bundled provider/model).
    getModel: () => undefined,
  };
});

const { PiAiAdapter } = await import("./adapter-pi-ai");
const { __clearOpencodeSessionIdCache } = await import("./opencode-session");

const BASE_REQ = {
  modelId: "deepseek-v4.1-flash",
  baseURL: "https://opencode.ai/inference/go/v1",
  apiKey: "oc_sk_test_placeholder",
  temperature: 0.7,
  maxTokens: 32,
  messages: [{ role: "user", content: "hi" }],
} as const;

describe("PiAiAdapter: x-opencode-session header injection", () => {
  beforeEach(() => {
    completeCalls.length = 0;
    streamCalls.length = 0;
    __clearOpencodeSessionIdCache();
  });

  test("chat(): provider=opencodego injects ses_-prefixed header", async () => {
    const adapter = new PiAiAdapter();
    await adapter.chat({ provider: "opencodego", sessionId: "oc_ce59231c7152ae7e2e948608e8294b18", ...BASE_REQ } as any);
    const headers = completeCalls[0]?.options?.headers;
    expect(headers?.["x-opencode-session"]).toMatch(/^ses_/);
  });

  test("chat(): session id is stable across calls for the same conversation", async () => {
    const adapter = new PiAiAdapter();
    const sessionId = "oc_ce59231c7152ae7e2e948608e8294b18";
    await adapter.chat({ provider: "opencodego", sessionId, ...BASE_REQ } as any);
    await adapter.chat({ provider: "opencodego", sessionId, ...BASE_REQ } as any);
    const first = completeCalls[0]?.options?.headers?.["x-opencode-session"];
    const second = completeCalls[1]?.options?.headers?.["x-opencode-session"];
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  test("stream(): provider=opencode-go (legacy) injects header", async () => {
    const adapter = new PiAiAdapter();
    await adapter.stream({ provider: "opencode-go", sessionId: "conv-legacy", ...BASE_REQ } as any);
    expect(streamCalls[0]?.options?.headers?.["x-opencode-session"]).toMatch(/^ses_/);
  });

  test("stream(): provider=opencode (legacy original) injects header", async () => {
    const adapter = new PiAiAdapter();
    await adapter.stream({ provider: "opencode", sessionId: "conv-original", ...BASE_REQ } as any);
    expect(streamCalls[0]?.options?.headers?.["x-opencode-session"]).toMatch(/^ses_/);
  });

  test("chat(): unrelated provider (deepseek) does NOT inject header", async () => {
    const adapter = new PiAiAdapter();
    await adapter.chat({ provider: "deepseek", sessionId: "conv-x", ...BASE_REQ, baseURL: "https://api.deepseek.com" } as any);
    expect(completeCalls[0]?.options?.headers?.["x-opencode-session"]).toBeUndefined();
  });
});
