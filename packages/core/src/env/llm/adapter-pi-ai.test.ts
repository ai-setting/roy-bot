/**
 * PiAiAdapter 单元测试（RED-first）
 *
 * 使用 mock.module 拦截 @earendil-works/pi-ai，验证：
 * 1. chat() 把 ChatRequest 翻译成 pi-ai complete() 并返回 ChatResponse
 * 2. toolUse → toolCalls 映射
 * 3. resolveProvider() 返回正确的 ResolvedProvider
 * 4. chat() 流式返回 stopReason/usage 字段正确
 */
import { describe, test, expect, beforeEach } from "bun:test";

describe("PiAiAdapter", () => {
  let capturedCompleteArgs: any[] = [];
  let capturedStreamArgs: any[] = [];

  beforeEach(async () => {
    capturedCompleteArgs = [];
    capturedStreamArgs = [];
    // 用 mock.module 替换 pi-ai（每次测试前重置）
    const piAiMock = {
      complete: async (...args: any[]) => {
        capturedCompleteArgs.push(args);
        return {
          role: "assistant",
          content: [{ type: "text", text: "Hello from pi-ai" }],
          stopReason: "stop",
          usage: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          model: "claude-sonnet-4-20250514",
          provider: "anthropic",
          api: "anthropic-messages",
        };
      },
      stream: (..._args: any[]) => {
        // 不调用；adapter.stream 暂未实现（task 8 之后）
        throw new Error("stream not implemented yet");
      },
      getModel: ((provider: string, modelId: string) => ({
        id: modelId,
        provider,
        api: provider === "anthropic" ? "anthropic-messages" : "openai-completions",
        contextLimit: 200000,
        maxTokensLimit: 8192,
      })) as any,
    };
    // @ts-expect-error - bun test mock
    (globalThis as any).__PI_AI_MOCK__ = piAiMock;
  });

  test("adapter 名称为 'pi-ai'", async () => {
    const { PiAiAdapter } = await import("./adapter-pi-ai");
    const adapter = new PiAiAdapter();
    expect(adapter.name).toBe("pi-ai");
  });

  test("resolveProvider() 解析 anthropic provider", async () => {
    const { PiAiAdapter } = await import("./adapter-pi-ai");
    const adapter = new PiAiAdapter();
    const rp = await adapter.resolveProvider("anthropic", "claude-sonnet-4-20250514");
    expect(rp.api).toBe("anthropic-messages");
    expect(rp.provider).toBe("anthropic");
    expect(rp.modelId).toBe("claude-sonnet-4-20250514");
    expect(rp.contextLimit).toBeGreaterThan(0);
  });

  test("infers minimax API from configured endpoint", async () => {
    const { resolvePiModel } = await import("./adapter-pi-ai");
    expect(resolvePiModel("minimax", "MiniMax-M3", "https://api.minimax.chat/v1")).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://api.minimax.chat/v1",
    });
  });

  test("normalizes null tool schemas for OpenAI-compatible APIs", async () => {
    const { toPiTools } = await import("./adapter-pi-ai");
    const tools = toPiTools([{ name: "bash", parameters: { type: null } as any }]);
    // Task #5422: reason 注入后空 schema 变为 { type, properties:{reason}, required:[reason] }
    const params = tools?.[0]?.parameters as any;
    expect(params?.type).toBe("object");
    expect(params?.properties?.reason).toBeDefined();
    expect(params?.required).toContain("reason");
  });

  test("converts Zod schemas to JSON schema (Task #2722 regression: empty schema caused malformed tool calls)", async () => {
    // Background: agent-component passes Zod schemas (e.g., task_search's
    // SearchTasksToolSchema) as ToolInfo.parameters. Before this fix, the
    // uncommitted toPiTools change stripped any non-{type:'object'} schema
    // to {type:'object', properties:{}}, which made the LLM generate malformed
    // tool calls (the model had no schema to follow).
    const { z } = await import("zod");
    const { toPiTools } = await import("./adapter-pi-ai");
    const SearchTasksToolSchema = z.object({
      keywords: z.array(z.string()).describe("关键词列表"),
      limit: z.number().optional().default(20),
    });
    const tools = toPiTools([
      { name: "task_search", description: "Search tasks", parameters: SearchTasksToolSchema as any },
    ]);
    // After fix: should produce a JSON schema with type:object and the actual properties
    expect(tools?.[0]?.parameters).not.toEqual({ type: "object", properties: {} });
    expect((tools?.[0]?.parameters as any)?.type).toBe("object");
    expect((tools?.[0]?.parameters as any)?.properties).toBeDefined();
    expect((tools?.[0]?.parameters as any)?.properties?.keywords).toBeDefined();
    expect((tools?.[0]?.parameters as any)?.properties?.limit).toBeDefined();
  });

  test("builds custom provider models with their pi-ai API paths", async () => {
    const { resolvePiModel } = await import("./adapter-pi-ai");
    const cases = [
      ["minimax", "anthropic-messages", "https://api.minimaxi.com/anthropic"],
      ["minimax-openai", "openai-completions", "https://api.minimaxi.com/v1"],
      ["minimax-responses", "openai-responses", "https://api.minimaxi.com/v1"],
    ] as const;
    for (const [provider, api, baseURL] of cases) {
      expect(resolvePiModel(provider, "MiniMax-M3", baseURL)).toMatchObject({
        id: "MiniMax-M3",
        provider,
        api,
        baseUrl: baseURL,
      });
    }
  });
});
