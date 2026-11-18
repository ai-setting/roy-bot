/**
 * AiSdkAdapter 单元测试（smoke）
 *
 * 不调用真实 LLM；只验证 class 实例化和 name 字段。
 * 详细行为由现有 invoke/invokeNonStream 的单元测试覆盖。
 */
import { describe, test, expect } from "bun:test";

describe("AiSdkAdapter", () => {
  test("adapter 名称为 'ai-sdk'", async () => {
    const { AiSdkAdapter } = await import("./adapter-ai-sdk");
    const adapter = new AiSdkAdapter();
    expect(adapter.name).toBe("ai-sdk");
    expect(typeof adapter.chat).toBe("function");
    expect(typeof adapter.stream).toBe("function");
    expect(typeof adapter.resolveProvider).toBe("function");
  });

  test("resolveProvider() 返回 anthropic-messages 当 provider=anthropic", async () => {
    const { AiSdkAdapter } = await import("./adapter-ai-sdk");
    const adapter = new AiSdkAdapter();
    const rp = await adapter.resolveProvider("anthropic", "claude-sonnet-4-20250514");
    expect(rp.api).toBe("anthropic-messages");
    expect(rp.provider).toBe("anthropic");
  });

  test("resolveProvider() 返回 openai-completions 当 provider=openai", async () => {
    const { AiSdkAdapter } = await import("./adapter-ai-sdk");
    const adapter = new AiSdkAdapter();
    const rp = await adapter.resolveProvider("openai", "gpt-4o");
    expect(rp.api).toBe("openai-completions");
    expect(rp.provider).toBe("openai");
  });
});
