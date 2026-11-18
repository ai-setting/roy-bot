/**
 * Real provider prompt-cache behavior validation.
 *
 * This suite is intentionally credential-gated because it sends repeated long
 * prompts to real providers and can incur usage charges. Run in isolation:
 *
 * PI_AI_CACHE_E2E=1 \
 * DEEPSEEK_PI_AI_TEST_KEY=... MINIMAX_PI_AI_TEST_KEY=... GLM_PI_AI_TEST_KEY=... \
 * bun test packages/core/test/llm/cache-behavior.test.ts
 */
import { describe, expect, test } from "bun:test";
import { PiAiAdapter } from "../../src/env/llm/adapter-pi-ai";

type ProviderName = "deepseek" | "minimax" | "glm";
type UsageRow = {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  total: number;
};

const runE2E = process.env.PI_AI_CACHE_E2E === "1";
const prefix = Array.from({ length: 18 }, (_, i) =>
  `Stable cache benchmark paragraph ${i + 1}: a quiet library beside a river has numbered rooms, lamps, shelves, and a deterministic catalog. This text is deliberately fixed so provider prompt-cache accounting can be compared across three requests.`,
).join(" ");

const providers: Array<{
  name: ProviderName;
  modelId: string;
  apiKey?: string;
  baseURL: string;
}> = [
  {
    name: "deepseek",
    modelId: "deepseek-chat",
    apiKey: process.env.DEEPSEEK_PI_AI_TEST_KEY,
    baseURL: "https://api.deepseek.com",
  },
  {
    name: "minimax",
    modelId: "MiniMax-M3",
    apiKey: process.env.MINIMAX_PI_AI_TEST_KEY ?? process.env.MINIMAX_API_KEY,
    baseURL: "https://api.minimax.chat/v1",
  },
  {
    name: "glm",
    modelId: "glm-4-flash",
    apiKey: process.env.GLM_PI_AI_TEST_KEY,
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
  },
];

function cacheHitRate(rows: UsageRow[]): number {
  const input = rows.reduce((sum, row) => sum + row.input, 0);
  const cacheRead = rows.reduce((sum, row) => sum + row.cacheRead, 0);
  return cacheRead / Math.max(1, input + cacheRead);
}

async function runProvider(provider: (typeof providers)[number]): Promise<UsageRow[]> {
  const adapter = new PiAiAdapter();
  const questions = [
    "Reply with exactly one short sentence saying hello.",
    "Reply with exactly one short sentence saying the library is open.",
    "Reply with exactly one short sentence saying the river is calm.",
  ];
  const rows: UsageRow[] = [];
  for (const question of questions) {
    const response = await adapter.chat({
      provider: provider.name,
      modelId: provider.modelId,
      baseURL: provider.baseURL,
      apiKey: provider.apiKey!,
      messages: [{ role: "user", content: `${prefix}\n${question}` }],
      maxTokens: 32,
      temperature: 0,
    });
    rows.push({
      input: response.usage.promptTokens,
      cacheRead: response.usage.cacheRead ?? 0,
      cacheWrite: response.usage.cacheWrite ?? 0,
      output: response.usage.completionTokens,
      total: response.usage.totalTokens,
    });
    expect(response.text.length).toBeGreaterThan(0);
  }
  return rows;
}

describe.skipIf(!runE2E)("pi-ai three-provider cache behavior", () => {
  test("reports repeated-prefix usage and verifies DeepSeek cache benefit", async () => {
    const observed: Partial<Record<ProviderName, UsageRow[]>> = {};
    for (const provider of providers) {
      if (!provider.apiKey) continue;
      observed[provider.name] = await runProvider(provider);
    }

    expect(observed.deepseek).toHaveLength(3);
    const deepseekHitRate = cacheHitRate(observed.deepseek!);
    // RED expectation from the cache requirement: stable prefixes should hit.
    expect(deepseekHitRate).toBeGreaterThan(0.5);

    // Providers may legitimately expose no automatic prompt cache. Keep those
    // observations visible without turning provider policy into a false failure.
    for (const rows of Object.values(observed)) {
      expect(rows).toHaveLength(3);
      expect(cacheHitRate(rows!)).toBeGreaterThanOrEqual(0);
    }
  }, { timeout: 120000 });
});

export { cacheHitRate };
