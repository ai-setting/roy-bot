/**
 * LLMAdapter 接口契约测试（RED-first）
 *
 * 锁定 adapter 接口的 3 个核心方法（chat / stream / resolveProvider）
 * 以及 AdapterName 联合类型、ChatRequest / ChatResponse / StreamHandle 形状。
 *
 * RED 验证：先 watch it fail — 整个 import 应该失败，因为 ./adapter.ts 不存在。
 * Bun 的 type-only import 会被擦除，需要从模块中读 runtime 值。
 */
import { describe, test, expect } from "bun:test";
import { ADAPTER_NAMES } from "./adapter";
import type {
  LLMAdapter,
  ChatRequest,
  ChatResponse,
  StreamHandle,
  AdapterName,
  ResolvedProvider,
  EmbedRequest,
  EmbedResponse,
} from "./adapter";

describe("LLMAdapter interface contract", () => {
  test("ADAPTER_NAMES runtime export 仅含 'pi-ai' | 'ai-sdk'", () => {
    expect(ADAPTER_NAMES).toBeDefined();
    expect(ADAPTER_NAMES).toHaveLength(2);
    expect(ADAPTER_NAMES).toContain("pi-ai");
    expect(ADAPTER_NAMES).toContain("ai-sdk");
  });

  test("AdapterName 联合类型仅含 'pi-ai' | 'ai-sdk'", () => {
    const names: AdapterName[] = ["pi-ai", "ai-sdk"];
    expect(names).toHaveLength(2);
    expect(names).toContain("pi-ai");
    expect(names).toContain("ai-sdk");
  });

  test("LLMAdapter 满足 4 方法契约（结构性子类型）", () => {
    const adapter: LLMAdapter = {
      name: "pi-ai",
      chat: async (_req: ChatRequest): Promise<ChatResponse> => ({
        text: "",
        finishReason: "stop",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }),
      stream: async (_req: ChatRequest): Promise<StreamHandle> => {
        const asyncIter = {
          async *[Symbol.asyncIterator]() {
            // empty
          },
        };
        return {
          events: asyncIter as unknown as AsyncIterable<unknown>,
          result: async () => ({
            text: "",
            finishReason: "stop" as const,
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          }),
        };
      },
      resolveProvider: async (
        provider: string,
        modelId: string,
      ): Promise<ResolvedProvider> => ({
        api: "anthropic-messages", provider, modelId,
        contextLimit: 200000, maxTokensLimit: 8192,
      }),
      embed: async (_req: EmbedRequest): Promise<EmbedResponse> => ({
        embeddings: [[0.1, 0.2]],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }),
    };
    expect(adapter.name).toBe("pi-ai");
    expect(typeof adapter.chat).toBe("function");
    expect(typeof adapter.stream).toBe("function");
    expect(typeof adapter.resolveProvider).toBe("function");
    expect(typeof adapter.embed).toBe("function");
  });

  test("ChatRequest 必填字段：provider / modelId / messages / apiKey", () => {
    const req: ChatRequest = {
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "sk-test",
    };
    expect(req.provider).toBe("anthropic");
    expect(req.messages).toHaveLength(1);
  });

  test("ChatResponse.usage 必填字段：promptTokens / completionTokens / totalTokens", () => {
    const resp: ChatResponse = {
      text: "hello",
      finishReason: "stop",
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      },
    };
    expect(resp.usage.totalTokens).toBe(15);
    expect(resp.finishReason).toBe("stop");
  });
});
