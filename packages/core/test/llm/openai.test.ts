/**
 * OpenAI Provider 真实 LLM 集成测试（cred-gated）
 *
 * 启用条件：OPENAI_PI_AI_TEST_KEY 环境变量
 */
import { describe, test, expect } from "bun:test";
import { PiAiAdapter } from "../../src/env/llm/adapter-pi-ai";

const isParallelRun = "BUN_TEST_WORKER_ID" in process.env;
const apiKey = process.env.OPENAI_PI_AI_TEST_KEY;
const modelId = process.env.OPENAI_TEST_MODEL || "gpt-4o-mini";

describe.skipIf(isParallelRun || !apiKey)("PiAiAdapter integration: openai", () => {
  test("chat returns text response", async () => {
    const adapter = new PiAiAdapter();
    const resp = await adapter.chat({
      provider: "openai",
      modelId,
      messages: [{ role: "user", content: "Reply with one short sentence." }],
      apiKey: apiKey!,
      maxTokens: 200,
      temperature: 0,
    });
    expect(resp.text.length).toBeGreaterThan(0);
    expect(["stop", "length"]).toContain(resp.finishReason);
  }, { timeout: 30000 });

  test("resolveProvider 返回 openai-responses api", async () => {
    const adapter = new PiAiAdapter();
    const rp = await adapter.resolveProvider("openai", modelId);
    expect(rp.api).toMatch(/openai/);
    expect(rp.contextLimit).toBeGreaterThan(0);
  });
});
