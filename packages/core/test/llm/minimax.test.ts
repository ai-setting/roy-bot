/**
 * MiniMax Provider 真实 LLM 集成测试（cred-gated）
 *
 * 支持 minimax（国际）和 minimax-cn（国内）两个 region。
 * 默认模型：MiniMax-M3。
 *
 * 启用条件：MINIMAX_PI_AI_TEST_KEY（避免与通用 MINIMAX_API_KEY 冲突）
 */
import { describe, test, expect } from "bun:test";
import { PiAiAdapter } from "../../src/env/llm/adapter-pi-ai";

const isParallelRun = "BUN_TEST_WORKER_ID" in process.env;
const apiKey = process.env.MINIMAX_PI_AI_TEST_KEY ?? process.env.MINIMAX_API_KEY;
const baseURL = process.env.MINIMAX_BASE_URL;
const provider = (process.env.MINIMAX_PROVIDER || "minimax") as "minimax" | "minimax-cn";
const modelId = process.env.MINIMAX_TEST_MODEL || "MiniMax-M2.7";

describe.skipIf(isParallelRun || !apiKey)("PiAiAdapter integration: MiniMax", () => {
  test("chat returns text response from MiniMax-M3", async () => {
    const adapter = new PiAiAdapter();
    const resp = await adapter.chat({
      provider,
      modelId,
      messages: [{ role: "user", content: "用一句话介绍你自己。" }],
      apiKey: apiKey!,
      baseURL,
      maxTokens: 200,
      temperature: 0,
    });
    expect(resp.text.length).toBeGreaterThan(0);
    expect(["stop", "length"]).toContain(resp.finishReason);
    expect(resp.usage.totalTokens).toBeGreaterThan(0);
  }, { timeout: 30000 });

  test("resolveProvider 返回 openai-completions api", async () => {
    const adapter = new PiAiAdapter();
    const rp = await adapter.resolveProvider(provider, modelId);
    expect(rp.api).toBe("openai-completions");
    expect(rp.contextLimit).toBeGreaterThan(0);
  });
});
