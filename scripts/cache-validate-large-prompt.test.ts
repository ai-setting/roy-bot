#!/usr/bin/env bun
/**
 * @fileoverview Cache 命中率验证 V5 (Task #2758) — 完整 system prompt 5/10 turn 实测
 *
 * V4 (Task #2756) 实测 cache hit ratio = 58.85% (GLM-4.6)，与 pi-agent baseline 96.6% 差 37.75pp。
 *
 * 根因分析 (V4 报告)：
 * - V4 用的 system prompt 仅 ~600 chars (~150 tokens)
 * - pi-agent 用的 system prompt 含完整 agent + tools (~2000+ tokens)
 * - 小 system prompt → 用户查询占比大 → cache 命中比例小
 *
 * V5 目标：用**真实的 roy-bot default system prompt**（`builtInPrompts["default"]`，
 * ~363 行 / ~3000+ tokens）替换 V4 的小 prompt，重测 5 turn + 10 turn，验证假设：
 * - 如果 V5-A 命中 80%+ → 确认是 system prompt 体量问题（pi-agent 96.6% 来自大 system）
 * - 如果 V5-A 命中 < 70% → 深入排查 provider 端 cache 机制差异
 *
 * 真实 system prompt 来源：`packages/core/src/env/prompt/prompts-index.ts` 的
 * `builtInPrompts["default"]`，通过 `renderDefaultPrompt("Roy")` 渲染。
 *
 * **安全约束**:
 * - API key 从 `~/.roy-bot/auth.json` 运行时读取 (不写入代码/commit)
 * - 预算：< $0.05 (5 turn × 1 provider + 10 turn × 1 provider = 15 calls)
 * - 测试失败也不写入 API key
 *
 * Provider：
 * - GLM-4.6: 主测试 (V4 已验证有 cache, 58.85% baseline)
 * - DeepSeek (`deepseek-chat`): 对比 (V3 测过 74.4% overall / 94.7% T5)
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { builtInPrompts, renderDefaultPrompt } from "../packages/core/src/env/prompt/prompts-index";

// ============================================================================
// 真实 system prompt — 替换 V4 的小 prompt
// ============================================================================

/** 完整的 roy-bot default system prompt (接待员 agent, ~363 行) */
const FULL_SYSTEM_PROMPT = renderDefaultPrompt("Roy");

/** 用于报告的 prompt 体量信息 */
const PROMPT_STATS = {
  chars: FULL_SYSTEM_PROMPT.length,
  lines: FULL_SYSTEM_PROMPT.split("\n").length,
  approxTokens: Math.ceil(FULL_SYSTEM_PROMPT.length / 4), // 经验估算 4 chars/token
};

console.log(
  `[V5] Default system prompt: ${PROMPT_STATS.chars} chars / ${PROMPT_STATS.lines} lines / ~${PROMPT_STATS.approxTokens} tokens`
);

// ============================================================================
// API Key 读取
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
  const cleaned = content.replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(cleaned) as AuthConfig;
}

// ============================================================================
// Provider 配置
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
      name: "GLM",
      model: "glm-4.6",
      baseURL: auth.providers.glm?.baseURL || "https://open.bigmodel.cn/api/paas/v4",
      apiKey: auth.providers.glm?.apiKey || "",
    },
  ];
}

// ============================================================================
// 5 Turn Multi-turn 对话流 (复用 V4 设计, 保持 byte-stable 上一致)
// ============================================================================

interface Turn {
  label: string;
  query: string;
  expectedAssistant: string;
}

const TURNS_5: Turn[] = [
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

/** 10 turn — 增长趋势测试 (T1-T5 + T6-T10 看 hit ratio 增长) */
const TURNS_10: Turn[] = [
  ...TURNS_5,
  {
    label: "T6",
    query: "What about the weather in Paris during October?",
    expectedAssistant: "October in Paris: avg high 16°C, low 10°C, 8 rainy days, fewer crowds.",
  },
  {
    label: "T7",
    query: "How does that compare to Tokyo weather in October?",
    expectedAssistant: "Tokyo in October: avg high 22°C, low 15°C, 6 rainy days, beautiful autumn.",
  },
  {
    label: "T8",
    query: "Which city has better food options?",
    expectedAssistant: "Both cities have excellent food. Paris for classic French cuisine, Tokyo for variety and innovation.",
  },
  {
    label: "T9",
    query: "How much should I budget for the trip excluding hotel?",
    expectedAssistant: "Budget $80-120/day per person: meals, transport, attractions. Total ~$800-1500 for 5 days.",
  },
  {
    label: "T10",
    query: "Can you summarize the recommendation in 3 bullet points?",
    expectedAssistant: "• Paris for art/culture lovers • Tokyo for food/tech enthusiasts • October is ideal for both",
  },
];

// ============================================================================
// LLM 调用 (OpenAI 兼容协议)
// ============================================================================

interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** cached_tokens (GLM/DeepSeek prompt_tokens_details) */
  cachedTokens?: number;
  /** prompt_cache_hit_tokens (DeepSeek 特定) */
  cacheHitTokens?: number;
  /** prompt_cache_miss_tokens (DeepSeek 特定) */
  cacheMissTokens?: number;
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

  // 计算当前 turn 的 user 数量, 确定 label
  const userCount = messages.filter((m) => m.role === "user").length;
  const turnLabel = `T${userCount}`;

  return {
    turnLabel,
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
 * 跑 multi-turn 对话 - 每个 turn 累积 history (system + 之前所有 user/assistant + 当前 user)
 * 复用同一 session (目的是让 provider 端能识别 prefix 相同)
 */
async function runMultiTurn(
  config: ProviderConfig,
  turns: Turn[]
): Promise<LLMCallResult[]> {
  const results: LLMCallResult[] = [];
  const history: Array<{ role: string; content: string }> = [
    { role: "system", content: FULL_SYSTEM_PROMPT },
  ];

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
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
// 汇总工具
// ============================================================================

/**
 * 智能选择 hit/miss 计算方式：
 * - DeepSeek: 返回 `cacheHitTokens` + `cacheMissTokens` → 用 hit/(hit+miss)
 * - GLM: 只返回 `cached_tokens`（已命中部分） → 用 cached/prompt
 */
function computeHitRatio(u: LLMUsage): {
  hit: number;
  miss: number;
  cached: number;
  ratio: string;
} {
  const hit = u.cacheHitTokens ?? 0;
  const miss = u.cacheMissTokens ?? 0;
  const cached = u.cachedTokens ?? 0;

  // 优先用 hit + miss 模式 (DeepSeek)
  if (hit > 0 || miss > 0) {
    const denom = hit + miss;
    const ratio = denom > 0 ? ((hit / denom) * 100).toFixed(1) + "%" : "—";
    return { hit, miss, cached, ratio };
  }

  // 降级用 cached / prompt (GLM)
  if (cached > 0 && u.promptTokens > 0) {
    const ratio = ((cached / u.promptTokens) * 100).toFixed(1) + "%";
    // miss 估算: prompt - cached (假设剩余 token 都是 miss/未命中)
    return { hit: cached, miss: u.promptTokens - cached, cached, ratio };
  }

  return { hit: 0, miss: 0, cached: 0, ratio: "—" };
}

function summarizeResults(provider: string, results: LLMCallResult[]): {
  table: string[];
  totalHit: number;
  totalMiss: number;
  totalPrompt: number;
  totalCached: number;
  overallRatio: string;
  perTurn: Array<{ turn: string; prompt: number; cached: number; hit: number; miss: number; ratio: string }>;
} {
  const table: string[] = [];
  table.push(`| Provider | Turn | prompt | completion | cached | hit | miss | hit_ratio |`);
  table.push(`|---|---|---|---|---|---|---|---|`);

  let totalHit = 0;
  let totalMiss = 0;
  let totalPrompt = 0;
  let totalCached = 0;
  const perTurn: Array<{ turn: string; prompt: number; cached: number; hit: number; miss: number; ratio: string }> = [];

  for (const r of results) {
    const { hit, miss, cached, ratio } = computeHitRatio(r.usage);
    totalHit += hit;
    totalMiss += miss;
    totalPrompt += r.usage.promptTokens;
    totalCached += cached;
    perTurn.push({
      turn: r.turnLabel,
      prompt: r.usage.promptTokens,
      cached,
      hit,
      miss,
      ratio,
    });
    table.push(
      `| ${provider} | ${r.turnLabel} | ${r.usage.promptTokens} | ${r.usage.completionTokens} | ${cached} | ${hit} | ${miss} | ${ratio} |`
    );
  }
  const totalDenom = totalHit + totalMiss;
  const overallRatio =
    totalDenom > 0 ? ((totalHit / totalDenom) * 100).toFixed(1) + "%" : "n/a";
  table.push(
    `| **${provider} TOTAL** | — | ${totalPrompt} | — | ${totalCached} | **${totalHit}** | **${totalMiss}** | **${overallRatio}** |`
  );

  return { table, totalHit, totalMiss, totalPrompt, totalCached, overallRatio, perTurn };
}

// ============================================================================
// 主测试
// ============================================================================

describe("Task #2758 (V5) Cache: 完整 system prompt 重测", () => {
  // --------------------------------------------------------------------------
  // Test A: 完整 system prompt 5 turn (GLM-4.6)
  // --------------------------------------------------------------------------
  it("Test A: 5 turn GLM-4.6 完整 system prompt", async () => {
    console.log("\n========================================");
    console.log("Test A: 5 turn GLM-4.6 完整 system prompt");
    console.log(`System prompt: ${PROMPT_STATS.chars} chars / ~${PROMPT_STATS.approxTokens} tokens`);
    console.log("========================================\n");

    const configs = getProviderConfigs();
    const glm = configs.find((c) => c.name === "GLM");
    if (!glm?.apiKey) {
      console.log("[SKIP] GLM apiKey missing");
      return;
    }

    const results = await runMultiTurn(glm, TURNS_5);

    for (const r of results) {
      const u = r.usage;
      console.log(
        `  ${r.turnLabel}: prompt=${u.promptTokens} completion=${u.completionTokens} ` +
          `cached=${u.cachedTokens ?? "n/a"} hit=${u.cacheHitTokens ?? "n/a"} ` +
          `miss=${u.cacheMissTokens ?? "n/a"} chars=${r.promptChars}`
      );
    }

    const summary = summarizeResults("GLM-4.6", results);
    console.log("\n" + summary.table.join("\n"));

    expect(results.length).toBe(5);
  }, 300000);

  // --------------------------------------------------------------------------
  // Test B: 10 turn 增长趋势 (GLM-4.6)
  // --------------------------------------------------------------------------
  it("Test B: 10 turn GLM-4.6 完整 system prompt 增长趋势", async () => {
    console.log("\n========================================");
    console.log("Test B: 10 turn GLM-4.6 完整 system prompt");
    console.log(`System prompt: ${PROMPT_STATS.chars} chars / ~${PROMPT_STATS.approxTokens} tokens`);
    console.log("========================================\n");

    const configs = getProviderConfigs();
    const glm = configs.find((c) => c.name === "GLM");
    if (!glm?.apiKey) {
      console.log("[SKIP] GLM apiKey missing");
      return;
    }

    const results = await runMultiTurn(glm, TURNS_10);

    for (const r of results) {
      const u = r.usage;
      console.log(
        `  ${r.turnLabel}: prompt=${u.promptTokens} completion=${u.completionTokens} ` +
          `cached=${u.cachedTokens ?? "n/a"} hit=${u.cacheHitTokens ?? "n/a"} ` +
          `miss=${u.cacheMissTokens ?? "n/a"} chars=${r.promptChars}`
      );
    }

    const summary = summarizeResults("GLM-4.6 (10 turn)", results);
    console.log("\n" + summary.table.join("\n"));

    expect(results.length).toBe(10);
  }, 600000);

  // --------------------------------------------------------------------------
  // Test C: DeepSeek 对比 (5 turn)
  // --------------------------------------------------------------------------
  it("Test C: 5 turn DeepSeek 完整 system prompt 对比", async () => {
    console.log("\n========================================");
    console.log("Test C: 5 turn DeepSeek 完整 system prompt");
    console.log(`System prompt: ${PROMPT_STATS.chars} chars / ~${PROMPT_STATS.approxTokens} tokens`);
    console.log("========================================\n");

    const configs = getProviderConfigs();
    const ds = configs.find((c) => c.name === "DeepSeek");
    if (!ds?.apiKey) {
      console.log("[SKIP] DeepSeek apiKey missing");
      return;
    }

    const results = await runMultiTurn(ds, TURNS_5);

    for (const r of results) {
      const u = r.usage;
      console.log(
        `  ${r.turnLabel}: prompt=${u.promptTokens} completion=${u.completionTokens} ` +
          `cached=${u.cachedTokens ?? "n/a"} hit=${u.cacheHitTokens ?? "n/a"} ` +
          `miss=${u.cacheMissTokens ?? "n/a"} chars=${r.promptChars}`
      );
    }

    const summary = summarizeResults("DeepSeek", results);
    console.log("\n" + summary.table.join("\n"));

    expect(results.length).toBe(5);
  }, 300000);

  // --------------------------------------------------------------------------
  // 静态检查: builtInPrompts 真的很大 (Sanity check)
  // --------------------------------------------------------------------------
  it("Sanity: builtInPrompts['default'] 体量检查 (V4 小 prompt vs V5 大 prompt)", () => {
    console.log("\n========================================");
    console.log("Sanity check: builtInPrompts 体量对比");
    console.log("========================================\n");

    const defaultPrompt = builtInPrompts["default"];
    const royPrompt = builtInPrompts["roy"];
    const defaultChars = defaultPrompt.length;
    const defaultTokens = Math.ceil(defaultChars / 4);
    const royChars = royPrompt.length;
    const royTokens = Math.ceil(royChars / 4);

    console.log(`builtInPrompts['default'] (接待员): ${defaultChars} chars / ${defaultPrompt.split("\n").length} lines / ~${defaultTokens} tokens`);
    console.log(`builtInPrompts['roy'] (sub-agent): ${royChars} chars / ${royPrompt.split("\n").length} lines / ~${royTokens} tokens`);
    console.log(`\nV4 小 prompt: ~600 chars / ~150 tokens`);
    console.log(`V5 大 prompt: ${defaultChars} chars / ~${defaultTokens} tokens`);
    console.log(`放大倍数: ${(defaultChars / 600).toFixed(1)}x`);

    // 验证 default prompt 真的很大 (至少 2000+ tokens = 8000+ chars)
    expect(defaultChars).toBeGreaterThan(8000);
    expect(defaultTokens).toBeGreaterThan(2000);
  });
});
