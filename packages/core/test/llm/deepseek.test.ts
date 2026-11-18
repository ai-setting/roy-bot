/**
 * DeepSeek Provider 真实 LLM 集成测试（cred-gated）
 * DeepSeek 走 OpenAI 兼容协议。
 */
import { describe, test, expect } from "bun:test";
import { PiAiAdapter } from "../../src/env/llm/adapter-pi-ai";

const isParallelRun = "BUN_TEST_WORKER_ID" in process.env;
const apiKey = process.env.DEEPSEEK_PI_AI_TEST_KEY;
const modelId = process.env.DEEPSEEK_TEST_MODEL || "deepseek-chat";

describe.skipIf(isParallelRun || !apiKey)("PiAiAdapter integration: deepseek", () => {
  test("chat returns text response", async () => {
    const adapter = new PiAiAdapter();
    const resp = await adapter.chat({
      provider: "deepseek",
      modelId,
      messages: [{ role: "user", content: "Reply with one short sentence." }],
      apiKey: apiKey!,
      maxTokens: 200,
      temperature: 0,
    });
    expect(resp.text.length).toBeGreaterThan(0);
    expect(["stop", "length"]).toContain(resp.finishReason);
  }, { timeout: 30000 });

  test("resolveProvider 返回 openai-completions api", async () => {
    const adapter = new PiAiAdapter();
    const rp = await adapter.resolveProvider("deepseek", modelId);
    expect(rp.api).toBe("openai-completions");
    expect(rp.contextLimit).toBeGreaterThan(0);
  });
});
