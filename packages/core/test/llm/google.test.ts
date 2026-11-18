/**
 * Google Provider 真实 LLM 集成测试（cred-gated）
 */
import { describe, test, expect } from "bun:test";
import { PiAiAdapter } from "../../src/env/llm/adapter-pi-ai";

const isParallelRun = "BUN_TEST_WORKER_ID" in process.env;
const apiKey = process.env.GOOGLE_PI_AI_TEST_KEY;
const modelId = process.env.GOOGLE_TEST_MODEL || "gemini-2.0-flash-exp";

describe.skipIf(isParallelRun || !apiKey)("PiAiAdapter integration: google", () => {
  test("chat returns text response", async () => {
    const adapter = new PiAiAdapter();
    const resp = await adapter.chat({
      provider: "google",
      modelId,
      messages: [{ role: "user", content: "Reply with one short sentence." }],
      apiKey: apiKey!,
      maxTokens: 200,
      temperature: 0,
    });
    expect(resp.text.length).toBeGreaterThan(0);
    expect(["stop", "length"]).toContain(resp.finishReason);
  }, { timeout: 30000 });

  test("resolveProvider 返回 google-generative-ai api", async () => {
    const adapter = new PiAiAdapter();
    const rp = await adapter.resolveProvider("google", modelId);
    expect(rp.api).toBe("google-generative-ai");
    expect(rp.contextLimit).toBeGreaterThan(0);
  });
});
