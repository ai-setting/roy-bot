/**
 * @fileoverview LLM Cache Options Helpers (Task #2748 §5.3-5.5)
 *
 * 4 项 cache 优化相关的 helper 集中在此模块：
 * - §5.3: OpenAI-Compatible prompt_cache_key
 * - §5.4: Tool schema cache_control (Anthropic)
 * - §5.5: parts JSON canonicalize
 *
 * 集中导出便于复用、单元测试、独立演进。
 */

import { sortObjectKeysDeep } from "./invoke";

/**
 * §5.3: OpenAI-Compatible provider 的 prompt_cache_key
 *
 * Anthropic 端用 cache_control; OpenAI 端用 prompt_cache_key。
 * roy-bot 当前完全没给 OpenAI-Compatible (minimax/DeepSeek/GLM) 挂这个，
 * 导致这些 provider 的 cache 完全靠隐式行为，命中率低。
 *
 * 参考 pi-agent: openai-completions.ts:680-695 (prompt_cache_key=sessionId)
 */

export function isOpenAICompatibleProvider(providerName: string): boolean {
  // 覆盖 minimax/DeepSeek/GLM/通用 openai-compatible
  return (
    providerName === "openai-compatible" ||
    providerName === "openai" ||
    providerName.startsWith("minimax") ||
    providerName === "deepseek" ||
    providerName.startsWith("deepseek") ||
    providerName === "glm" ||
    providerName.startsWith("glm")
  );
}

export function clampOpenAIPromptCacheKey(sessionId: string, maxLen = 64): string {
  if (sessionId.length <= maxLen) return sessionId;
  // 截断并保留 hash 唯一性
  return sessionId.slice(0, maxLen - 8) + "-" + sessionId.slice(-7);
}

export function buildOpenAICompatProviderOptions(
  sessionId: string | undefined,
  cacheRetention: "short" | "long" | "none" = "long"
): Record<string, unknown> {
  if (!sessionId) return {};
  return {
    openai: {
      promptCacheKey: clampOpenAIPromptCacheKey(sessionId),
      promptCacheRetention: cacheRetention === "long" ? "24h" : undefined,
    },
  };
}

/**
 * §5.4: 给工具 schema 的末 tool 挂 cache_control (Anthropic 3 层)
 *
 * pi-agent: anthropic-messages.ts:1005 (compat.supportsCacheControlOnTools ? cacheControl : undefined)
 * 收益：工具 schema 大的 agent 多省 10-30% input cost。
 */
export function applyToolCacheControl<T extends Record<string, unknown>>(
  tools: T[] | undefined,
  providerName: string
): T[] | undefined {
  if (!tools || tools.length === 0) return tools;
  if (providerName !== "anthropic" && !providerName.startsWith("anthropic")) {
    return tools;
  }
  // 复制数组（避免 mutate 原数据），给末 tool 挂 cache_control
  const result = tools.map((t) => ({ ...t }));
  const lastTool = result[result.length - 1] as Record<string, unknown>;
  lastTool.providerOptions = {
    anthropic: { cacheControl: { type: "ephemeral" } },
  };
  return result;
}

/**
 * §5.5: parts JSON canonicalize
 *
 * SQLite 存 parts 为 JSON 字符串，读出来时 JSON.parse 的 key 顺序不保证稳定。
 * 在写入时对 parts 做 sortObjectKeysDeep → byte-stable 序列化。
 *
 * 同时也处理 tool-call arguments 字符串（如果是 string，需要 parse → sort → stringify）。
 */
export function canonicalizeParts(parts: unknown): string {
  if (!parts) return JSON.stringify(parts);
  const sorted = sortObjectKeysDeep(parts);
  canonicalizeToolCallArgsInPlace(sorted);
  return JSON.stringify(sorted);
}

/**
 * 递归遍历 parts，将 tool-call 的 arguments string 解析 → sortObjectKeysDeep → stringify
 */
function canonicalizeToolCallArgsInPlace(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) canonicalizeToolCallArgsInPlace(item);
    return;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.type === "tool-call" && typeof obj.arguments === "string") {
      try {
        const parsed = JSON.parse(obj.arguments);
        const sorted = sortObjectKeysDeep(parsed);
        obj.arguments = JSON.stringify(sorted);
      } catch {
        // parse 失败保持原样
      }
    }
    for (const key of Object.keys(obj)) {
      canonicalizeToolCallArgsInPlace(obj[key]);
    }
  }
}
