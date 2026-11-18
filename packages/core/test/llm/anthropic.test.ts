/**
 * Anthropic Provider 真实 LLM 集成测试（cred-gated）
 *
 * 启用条件：
 * - ANTHROPIC_PI_AI_TEST_KEY 环境变量（避免误用其它 key）
 * - 非并行模式（避免 LLM 调用受并发影响）
 */
import { describe, test, expect } from "bun:test";
import { PiAiAdapter } from "../../src/env/llm/adapter-pi-ai";

const isParallelRun = "BUN_TEST_WORKER_ID" in process.env;
const apiKey = process.env.ANTHROPIC_PI_AI_TEST_KEY;
const modelId = process.env.ANTHROPIC_TEST_MODEL || "claude-sonnet-4-20250514";

describe.skipIf(isParallelRun || !apiKey)("PiAiAdapter integration: anthropic", () => {
  test("chat returns text response from claude-sonnet-4", async () => {
    const adapter = new PiAiAdapter();
    const resp = await adapter.chat({
      provider: "anthropic",
      modelId,
      messages: [{ role: "user", content: "Reply with one short sentence about Claude." }],
      apiKey: apiKey!,
      maxTokens: 200,
      temperature: 0,
    });
    expect(resp.text.length).toBeGreaterThan(0);
    expect(["stop", "length"]).toContain(resp.finishReason);
    expect(resp.usage.totalTokens).toBeGreaterThan(0);
  }, { timeout: 30000 });

  test("resolveProvider 返回 anthropic-messages api", async () => {
    const adapter = new PiAiAdapter();
    const rp = await adapter.resolveProvider("anthropic", modelId);
    expect(rp.api).toBe("anthropic-messages");
    expect(rp.contextLimit).toBeGreaterThan(0);
  });
});
