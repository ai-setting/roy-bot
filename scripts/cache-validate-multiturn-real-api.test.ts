#!/usr/bin/env bun
/**
 * @fileoverview Cache 命中率验证 v3 (Task #2755) — 真实 API 5 turn multi-turn 对话
 *
 * V2 (Task #2750) 完成了 byte-stability 验证 (mock LLM)：
 * - 5 turn multi-turn 对话流 (query → ReAct → query → ReAct → query)
 * - 验证 system prompt / tools / parts / prompt_cache_key 跨 turn byte-stable
 * - 预测真实环境 cache 命中率 ≥ 96% (对齐 pi-agent 96.6-96.8%)
 *
 * 但 V2 **没实测** cache token — 预测是基于 byte-stability 的间接证据。
 *
 * 本脚本用 **真实 API** 跑 5 turn multi-turn 对话，收集 `cache_read_input_tokens` /
 * `cache_creation_input_tokens` 实际数据：
 * - 3 provider × 5 turn = 15 次真实 LLM 调用
 * - 收集每个 turn 的 usage 字段 (含 cache 字段)
 * - 计算实际 cache hit ratio
 * - 与 V2 预测对比，与 pi-agent baseline 对比
 *
 * **安全约束**:
 * - API key 从 `~/.roy-bot/auth.json` 运行时读取 (不写入代码/commit)
 * - 预算：~0.05 美元以内 (5 turn × 3 provider, max_tokens=150)
 * - 测试失败也不写入 API key
 *
 * 3 provider：
 * - DeepSeek: `deepseek-chat` (v4-flash 别名) @ https://api.deepseek.com
 * - MiniMax:  `MiniMax-Text-01` @ https://api.minimax.chat/v1
 * - GLM:      `glm-4.6` @ https://open.bigmodel.cn/api/paas/v4 (V4 retry — was `glm-4-plus` no cache)
 *
 * **诚实预期**: 实测可能发现这些 provider 当前的 v3.x/v4.x 模型 **未启用** prompt cache
 * 公开 API (usage 字段 cached_tokens/cache_hit_tokens 全为 0)，这是真实数据。
 * 字节级稳定性工作仍然有效 — 一旦 provider 启用 cache，可立即受益。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ============================================================================
// API Key 读取 (从 auth.json 运行时读取，不硬编码)
// ============================================================================

interface AuthConfig {
  providers: Record<string, { apiKey: string; baseURL: string }>;
}

function loadAuthConfig(): AuthConfig {
  const authPath = path.join(os.homedir(), ".roy-bot", "auth.json");
  if (!fs.existsSync(authPath)) {
    throw new Error(`auth.json not found at ${authPath}`);
  }
  const content = fs.readFileSync(authPath, "utf-8");
  // 注释行清理 (auth.json 含 _note 字段)
  const cleaned = content.replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(cleaned) as AuthConfig;
}

// ============================================================================
// Provider 配置 (运行时从 auth.json 读取 baseURL + apiKey)
// ============================================================================

interface ProviderConfig {
  name: string;
  model: string;
  baseURL: string;
  apiKey: string;
}

function getProviderConfigs(): ProviderConfig[] {
  const auth = loadAuthConfig();
  return [
    {
      name: "DeepSeek",
      model: "deepseek-chat",
      baseURL: auth.providers.deepseek?.baseURL || "https://api.deepseek.com",
      apiKey: auth.providers.deepseek?.apiKey || "",
    },
    {
      name: "MiniMax",
      model: "MiniMax-Text-01",
      baseURL: auth.providers.minimax?.baseURL || "https://api.minimax.chat/v1",
      apiKey: auth.providers.minimax?.apiKey || "",
    },
    {
      name: "GLM",
      model: "glm-4.6",
      baseURL: auth.providers.glm?.baseURL || "https://open.bigmodel.cn/api/paas/v4",
      apiKey: auth.providers.glm?.apiKey || "",
    },
  ];
}

// ============================================================================
// 5 Turn Multi-turn 对话流 (沿用 V2 设计)
// ============================================================================

interface Turn {
  label: string;
  query: string;
  expectedAssistant: string;
}

const TURNS: Turn[] = [
  {
    label: "T1",
    query: "What is the capital of France?",
    expectedAssistant: "The capital of France is Paris.",
  },
  {
    label: "T2",
    query: "Plan a 3-day trip to Paris. Find the best hotel in city center, budget $200/night.",
    expectedAssistant:
      "For your 3-day Paris trip, I recommend Hotel Lutetia ($195/night, 4.6 stars, in 6th arr.).",
  },
  {
    label: "T3",
    query: "Based on the hotel you found, how far is it from the Louvre?",
    expectedAssistant:
      "Hotel Lutetia is about 2.8 km from the Louvre - 30-minute walk or 10 minutes by metro.",
  },
  {
    label: "T4",
    query: "Compare it with a similar hotel in Tokyo. Use the same criteria.",
    expectedAssistant:
      "Comparable hotel in Tokyo: Hotel Mitsui Kyoto ($210/night, 4.7 stars, 1.2 km from center).",
  },
  {
    label: "T5",
    query: "Which one would you recommend for a 5-day trip in October?",
    expectedAssistant:
      "For a 5-day October trip, I recommend Hotel Lutetia Paris. October is shoulder season.",
  },
];

/** 稳定的 system prompt — 用于验证 cache 跨 turn 命中 */
const SYSTEM_PROMPT = `You are an expert travel planner with deep knowledge of European and Asian destinations. You help users plan multi-day trips including hotel selection, daily itineraries, and seasonal recommendations. Always provide specific hotel names with addresses when possible. Consider weather, crowds, and cultural events in your recommendations. When comparing cities, evaluate hotel pricing relative to local cost of living. Use a structured thinking approach: first understand the user goals, then research destination context, then suggest specific hotels with names, then provide a day-by-day itinerary considering weather and seasonal factors. You have extensive knowledge of hotels in Paris (Hotel Lutetia, Le Bristol, Hotel de Crillon) and Tokyo (Hotel Mitsui Kyoto, Park Hyatt Tokyo, Aman Tokyo). For comparison queries, evaluate on: price, rating, location, and amenities.`;

// ============================================================================
// LLM 调用 (OpenAI 兼容协议)
// ============================================================================

interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** cached_tokens (DeepSeek/GLM prompt_tokens_details) */
  cachedTokens?: number;
  /** prompt_cache_hit_tokens (DeepSeek 特定) */
  cacheHitTokens?: number;
  /** prompt_cache_miss_tokens (DeepSeek 特定) */
  cacheMissTokens?: number;
  /** 完整 usage 字段 (供报告输出) */
  rawUsage: Record<string, unknown>;
}

interface LLMCallResult {
  turnLabel: string;
  usage: LLMUsage;
  responseContent: string;
  promptChars: number;
}

async function callLLM(
  config: ProviderConfig,
  messages: Array<{ role: string; content: string }>,
  maxTokens = 150
): Promise<LLMCallResult> {
  const url = `${config.baseURL.replace(/\/$/, "")}/chat/completions`;
  const body = {
    model: config.model,
    messages,
    max_tokens: maxTokens,
    temperature: 0.7,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `${config.name} HTTP ${res.status}: ${errText.slice(0, 200)}`
    );
  }

  const data = (await res.json()) as any;
  const usage = data.usage ?? {};
  const promptDetails = usage.prompt_tokens_details ?? {};

  return {
    turnLabel: TURNS[messages.filter((m) => m.role === "user").length - 1]
      ?.label ?? `T${messages.filter((m) => m.role === "user").length}`,
    usage: {
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      totalTokens: usage.total_tokens ?? 0,
      cachedTokens: promptDetails.cached_tokens,
      cacheHitTokens: usage.prompt_cache_hit_tokens,
      cacheMissTokens: usage.prompt_cache_miss_tokens,
      rawUsage: usage,
    },
    responseContent: data.choices?.[0]?.message?.content ?? "",
    promptChars: JSON.stringify(messages).length,
  };
}

/**
 * 构造 5 turn 多轮历史 + 调用 LLM
 * - 每个 turn 累积 system + 之前所有 user/assistant 消息 + 当前 user
 * - 复用同一 session (目的是让 provider 端能识别 prefix 相同)
 */
async function runMultiTurn(config: ProviderConfig): Promise<LLMCallResult[]> {
  const results: LLMCallResult[] = [];
  const history: Array<{ role: string; content: string }> = [
    { role: "system", content: SYSTEM_PROMPT },
  ];

  for (let i = 0; i < TURNS.length; i++) {
    const turn = TURNS[i];
    history.push({ role: "user", content: turn.query });

    const result = await callLLM(config, history);
    result.turnLabel = turn.label;
    results.push(result);

    // 把 LLM 真实响应加入 history (后续 turn 会引用)
    history.push({
      role: "assistant",
      content: result.responseContent || turn.expectedAssistant,
    });
  }

  return results;
}

// ============================================================================
// 主测试 — 3 provider × 5 turn 实测
// ============================================================================

describe("Task #2755: Real API 5 turn multi-turn cache validation", () => {
  it("3 provider × 5 turn 真实 API cache token 收集", async () => {
    console.log("\n========================================");
    console.log("Real API Multi-turn Cache Validation");
    console.log("========================================\n");

    const configs = getProviderConfigs();
    const allResults: Record<string, LLMCallResult[]> = {};

    // 顺序跑 (避免 rate limit)，每个 provider 独立 session
    // 可通过 CACHE_TEST_PROVIDERS=GLM 或 CACHE_TEST_PROVIDERS=GLM,DeepSeek 过滤
    const providerFilter = process.env.CACHE_TEST_PROVIDERS
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const config of configs) {
      if (
        providerFilter &&
        !providerFilter.some((f) =>
          config.name.toLowerCase().includes(f.toLowerCase())
        )
      ) {
        console.log(`[SKIP] ${config.name}: filtered by CACHE_TEST_PROVIDERS`);
        continue;
      }
      if (!config.apiKey) {
        console.log(`[SKIP] ${config.name}: no API key`);
        continue;
      }
      const sessionId = `cache-test-${config.name.toLowerCase()}-${Date.now()}`;
      console.log(
        `\n[RUN] ${config.name} (${config.model}) @ ${config.baseURL}`
      );
      console.log(`      session: ${sessionId}`);

      try {
        const results = await runMultiTurn(config);
        allResults[config.name] = results;

        // 打印每个 turn 的 usage
        for (const r of results) {
          const u = r.usage;
          console.log(
            `  ${r.turnLabel}: prompt=${u.promptTokens} completion=${u.completionTokens} ` +
              `cached=${u.cachedTokens ?? "n/a"} hit=${u.cacheHitTokens ?? "n/a"} ` +
              `miss=${u.cacheMissTokens ?? "n/a"} chars=${r.promptChars}`
          );
        }
      } catch (err) {
        console.log(`  [ERROR] ${config.name}: ${(err as Error).message}`);
        allResults[config.name] = [];
      }
    }

    // 汇总输出
    console.log("\n========================================");
    console.log("Summary — Cache Hit Ratio per Provider");
    console.log("========================================\n");

    const summaryLines: string[] = [];
    summaryLines.push(
      "| Provider | Turn | prompt | completion | cached | hit | miss | hit_ratio |"
    );
    summaryLines.push("|---|---|---|---|---|---|---|---|");

    for (const provider of Object.keys(allResults)) {
      const results = allResults[provider];
      if (results.length === 0) continue;
      let totalHit = 0;
      let totalMiss = 0;
      for (const r of results) {
        const u = r.usage;
        const hit = u.cacheHitTokens ?? 0;
        const miss = u.cacheMissTokens ?? 0;
        const cached = u.cachedTokens ?? 0;
        totalHit += hit;
        totalMiss += miss;
        const denominator = hit + miss;
        const ratio =
          denominator > 0 ? ((hit / denominator) * 100).toFixed(1) + "%" : "—";
        summaryLines.push(
          `| ${provider} | ${r.turnLabel} | ${u.promptTokens} | ${u.completionTokens} | ${cached} | ${hit} | ${miss} | ${ratio} |`
        );
      }
      const totalDenom = totalHit + totalMiss;
      const totalRatio =
        totalDenom > 0 ? ((totalHit / totalDenom) * 100).toFixed(1) + "%" : "n/a";
      summaryLines.push(
        `| **${provider} TOTAL** | — | — | — | — | **${totalHit}** | **${totalMiss}** | **${totalRatio}** |`
      );
      summaryLines.push("|---|---|---|---|---|---|---|---|");
    }

    console.log(summaryLines.join("\n"));

    // 保存结果到 JSON 供报告使用
    const outputPath = path.join(
      os.tmpdir(),
      `cache-real-api-results-${Date.now()}.json`
    );
    // 脱敏：删除 API key 字段
    const safeResults = JSON.parse(JSON.stringify(allResults));
    for (const provider of Object.keys(safeResults)) {
      for (const r of safeResults[provider]) {
        // 移除任何可能包含 key 的字段
        delete r.apiKey;
      }
    }
    fs.writeFileSync(
      outputPath,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          results: safeResults,
          summary: summaryLines,
        },
        null,
        2
      )
    );
    console.log(`\n[SAVED] Results → ${outputPath}`);

    // 断言：3 个 provider 都成功跑完 5 turn
    expect(Object.keys(allResults).length).toBeGreaterThanOrEqual(3);
    for (const provider of Object.keys(allResults)) {
      expect(allResults[provider].length).toBe(5);
    }
  }, 300000); // 5 minute timeout for real API calls
});
