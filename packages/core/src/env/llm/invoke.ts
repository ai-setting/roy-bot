/**
 * @fileoverview LLM invocation with AI SDK integration.
 *
 * This module provides LLM invocation using AI SDK for better provider support.
 * Stream events are published via Environment.pushEnvEvent().
 */

import { randomUUID } from "crypto";
import { streamText, type ModelMessage, type ToolSet, jsonSchema } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { toolParametersToJsonSchema } from "./tool-schema";
import type { ToolInfo, ToolResult, LLMOutput, LLMMessage, UsageInfo, ContentPart, ProviderCapabilities } from "./types";
import type { Environment } from "../interface";
import { createLogger } from "../log-trace/logger";
import { safeParseToolArgs } from "./tool-args-parser";
import { repairOrphanSdkMessages } from "./orphan-toolcall";
import {
  buildOpencodeHeaders,
  __clearOpencodeSessionIdCache,
} from "./opencode-session";
import { createOutboundDefenseFetch, wireProtocolFromApiProtocol, type WireProtocol } from "./outbound-defense";
import { redactSecrets, redactErrorForTransport } from "./redact";
import { resolveApiProtocol } from "./adapter-pi-ai";

/**
 * Re-exported for backwards compatibility with existing tests
 * (`packages/core/test/llm/opencode-go-interactive.test.ts`). The implementation
 * now lives in `opencode-session.ts` so the default PiAiAdapter path can share it.
 */
export { __clearOpencodeSessionIdCache };

// 创建 llm:invoke 模块日志器
const logger = createLogger("llm:invoke");

// LanguageModel type alias for type checking
type AISDKLanguageModel = Parameters<ReturnType<typeof createOpenAI>["languageModel"]>[0];

/**
 * GenerateText Options
 * 
 * 定义 generateText 函数的参数类型，用于类型安全调用
 */
interface GenerateTextOptions {
  model: AISDKLanguageModel;
  messages: ModelMessage[];
  tools?: ToolSet;
  temperature?: number;
  maxTokens?: number;
  abortSignal?: AbortSignal;
  [key: string]: unknown;
}

/**
 * GenerateText Result
 * 
 * 定义 generateText 返回的结果类型
 */
interface GenerateTextResult {
  text: string;
  finishReason: string;
  usage: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  [key: string]: unknown;
}

/**
 * Invoke LLM 配置
 */
export interface InvokeConfig {
  /** 模型标识符（格式: providerId/modelId） */
  model: string;
  /** Base URL */
  baseURL?: string;
  /** API Key */
  apiKey: string;
  /**
   * Provider capabilities from config (`llm.providers.<id>.capabilities`).
   *
   * Task #4403: declared here so `LLMComponent.invoke()` can forward it to
   * `ChatRequest.capabilities` without an `as any` cast. Typed as the full
   * `ProviderCapabilities` shape (not just `{ reasoning?: boolean }`) because
   * the runtime value is the whole object from config.
   */
  capabilities?: ProviderCapabilities;
  /** 额外选项 */
  options?: {
    /**
     * 文本内嵌思考标签处理配置
     *
     * 对齐 `ProviderCapabilities.thinkingInText` (`packages/core/src/env/llm/types.ts`)：
     * - `enabled`: 是否启用标签剥离
     * - `tags`: 标签名列表（例如 `["think"]` → `""`）
     * - `removeFromOutput`: 剥离后是否从返回值中移除（`false` 则保留原始含标签内容，
     *   便于维持消息历史中的推理连续性，例如 MiniMax 需要看历史中的标签才会继续输出 reasoning）
     */
    thinkingInText?: {
      enabled?: boolean;
      tags?: string[];
      removeFromOutput?: boolean;
    };
  };
}

/**
 * LLM 选项
 */
export interface InvokeOptions {
  /** 消息列表 */
  messages: LLMMessage[];
  /** 工具列表 */
  tools?: ToolInfo[];
  /** 模型标识符（可选） */
  model?: string;
  /** 温度参数 */
  temperature?: number;
  /** 最大 Token 数 */
  maxTokens?: number;
  /** Environment 实例（用于发布流式事件，可选） */
  env?: Environment;
  /** 上下文信息（用于事件元数据） */
  context?: {
    /** Session ID */
    sessionId?: string;
    /** Message ID */
    messageId?: string;
  };
  /**
   * 工具选择策略（强制 LLM 调用特定工具）
   *
   * - "auto"   — LLM 自主决定（默认）
   * - "none"   — 禁止调用任何工具
   * - "required" — 必须调用至少一个工具（Issue #1694: 确保 json-extract 必须调用 workflow_submit_output）
   * - { type: "function", function: { name: "..." } } — 强制调用指定工具
   */
  toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  /**
   * Prompt-cache retention preference (Task #4465).
   *
   * path A already honours this through `buildPiCacheOptions()`; path B (this
   * AI SDK fallback) ignored it entirely, so every fallback request paid full
   * input price. Forwarded to the outbound defence middleware, which emits
   * `prompt_cache_key` / `prompt_cache_retention` on OpenAI-family protocols.
   *
   * Omitted → the middleware defaults to `"long"` for OpenAI-family protocols,
   * matching path A's default for `openai-completions`.
   */
  cacheRetention?: "none" | "short" | "long";
}

/**
 * LLM Tool Context - Context for tool calls during LLM invocation
 */
export interface LLMToolContext {
  /** Abort Signal */
  abort?: AbortSignal | undefined;
  /** 额外上下文 */
  context?: Record<string, unknown>;
}

/**
 * Usage 信息（AI SDK 格式）
 * 参考: LanguageModelV3Usage from @ai-sdk/provider
 */
interface AISDKUsage {
  // 标准格式: inputTokens/outputTokens 是对象，包含 total 等属性
  inputTokens?: {
    total?: number;
    noCache?: number;
    cacheRead?: number;
    cacheWrite?: number;
    [key: string]: unknown;
  };
  outputTokens?: {
    total?: number;
    [key: string]: unknown;
  };
  totalTokens?: number;
  // 兼容旧格式: 直接 number
  promptTokens?: number;
  completionTokens?: number;
  inputTokenDetails?: {
    tokens?: number;
    [key: string]: unknown;
  };
  outputTokenDetails?: {
    tokens?: number;
    [key: string]: unknown;
  };
  raw?: {
    total_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

/**
 * Usage 信息转换
 */
export interface ConvertedUsageInfo {
  /** Prompt Token 数 */
  promptTokens: number;
  /** Completion Token 数 */
  completionTokens: number;
  /** 总 Token 数 */
  totalTokens: number;
  /**
   * Anthropic prompt cache read tokens (cache_read_input_tokens).
   * `undefined` when the provider did not report a cache-read field.
   * `0` means the cache was checked but no tokens hit (distinct from
   * the field being absent).
   */
  cacheRead?: number;
  /**
   * Anthropic prompt cache write tokens (cache_creation_input_tokens).
   * See {@link cacheRead} for semantics.
   */
  cacheWrite?: number;
}

/**
 * AI SDK 最大重试次数
 * AI SDK 内部使用指数退避策略（默认 2s → 4s → 8s）
 */
const MAX_RETRIES = 3;

/**
 * LLM 默认超时时间（毫秒）
 */
const DEFAULT_TIMEOUT = 60000;

/**
 * 超时错误
 */
export class TimeoutError extends Error {
  constructor(message: string, public readonly timeout: number) {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * 带超时的 Promise 包装器
 * 
 * @param promise 要执行的 Promise
 * @param timeoutMs 超时时间（毫秒）
 * @param message 自定义错误消息
 * @returns Promise 结果
 * @throws TimeoutError 当超时时
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number = DEFAULT_TIMEOUT,
  message?: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(
        message || `LLM invocation timeout after ${timeoutMs}ms`,
        timeoutMs
      ));
    }, timeoutMs);
  });
  
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    // ★ 清除定时器，防止内存泄漏
    // 当主 Promise 先完成时，定时器仍在 pending 状态，需要清理
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * 解析模型字符串
 * 格式: "providerId/modelId"
 */
export function parseModelString(model?: string): { providerId: string; modelId: string } {
  if (!model) {
    return { providerId: "openai", modelId: "gpt-4o" };
  }

  const parts = model.split("/");
  if (parts.length >= 2) {
    return { providerId: parts[0], modelId: parts.slice(1).join("/") };
  }

  return { providerId: "openai", modelId: model };
}

/**
 * 从 Usage 信息提取标准格式
 *
 * I4 (review-cache-stability.md): now exposes `cacheRead` / `cacheWrite` so
 * callers can observe Anthropic prompt cache effectiveness.
 *
 * AI SDK v3 usage shape places cache tokens at two possible locations:
 * 1. `usage.inputTokens.cacheRead` / `usage.inputTokens.cacheWrite`
 *    (modern LanguageModelV3Usage object form)
 * 2. `usage.inputTokenDetails.cacheReadTokens` / `cacheWriteTokens`
 *    (legacy / MiniMax / DeepSeek form)
 *
 * We check the modern form first and fall back to the legacy form.
 * A reported `0` is preserved (the cache was checked, no hit);
 * `undefined` means the provider did not report the field at all.
 */
export function extractUsageInfo(usage: AISDKUsage | undefined): ConvertedUsageInfo | undefined {
  if (!usage) return undefined;

  // 标准格式: inputTokens/outputTokens 是对象，包含 total 属性（AI SDK LanguageModelV3Usage）
  if (usage.inputTokens && typeof usage.inputTokens === "object") {
    const inputTokens = usage.inputTokens;
    // AI SDK v3 may surface cacheRead/cacheWrite directly on inputTokens.
    // Fallback to legacy inputTokenDetails if not present.
    const cacheRead =
      typeof inputTokens.cacheRead === "number"
        ? inputTokens.cacheRead
        : typeof usage.inputTokenDetails?.cacheReadTokens === "number"
          ? usage.inputTokenDetails.cacheReadTokens
          : undefined;
    const cacheWrite =
      typeof inputTokens.cacheWrite === "number"
        ? inputTokens.cacheWrite
        : typeof usage.inputTokenDetails?.cacheWriteTokens === "number"
          ? usage.inputTokenDetails.cacheWriteTokens
          : undefined;
    return {
      promptTokens: inputTokens.total ?? 0,
      completionTokens: usage.outputTokens?.total ?? 0,
      totalTokens: usage.totalTokens ?? 0,
      cacheRead,
      cacheWrite,
    };
  }

  // 旧格式: 直接 number 属性
  if (typeof usage.promptTokens === "number") {
    return {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens ?? 0,
      totalTokens: usage.totalTokens ?? 0,
    };
  }

  // MiniMax 格式: 使用 tokenDetails
  if (usage.inputTokenDetails || usage.outputTokenDetails) {
    const details = usage.inputTokenDetails as
      | { tokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
      | undefined;
    return {
      promptTokens: details?.tokens ?? 0,
      completionTokens: usage.outputTokenDetails?.tokens ?? 0,
      totalTokens: usage.totalTokens ?? 0,
      cacheRead: details?.cacheReadTokens,
      cacheWrite: details?.cacheWriteTokens,
    };
  }

  // MiniMax 流式格式: 只有 total_tokens
  if (usage.raw && typeof usage.raw.total_tokens === "number") {
    return {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: usage.raw.total_tokens,
    };
  }

  return undefined;
}

/**
 * 计算 prompt cache 命中率（0..1）。
 *
 * Task #4373：这是把「roy-bot 自己的缓存命中」变成可观测量的关键 helper。
 *
 * ⚠️ 语义陷阱（上一轮 #4369 已经踩过一次）：
 *
 *   pi-ai 上报的 `promptTokens` 是 **已扣除缓存后的新增量**：
 *     `input = max(0, prompt_tokens - cacheRead - cacheWrite)`
 *     `totalTokens = input + output + cacheRead + cacheWrite`
 *   （见 `pi-ai/dist/providers/openai-completions.js::parseChunkUsage`、
 *     以及 `anthropic.js` 的 message_start 分支——同样把 cacheRead /
 *     cacheWrite 单独累加进 totalTokens）
 *
 *   所以 `cacheRead / promptTokens` 在真实暖流数据下会算出 20,960%
 *   这种荒谬值。正确的分母是「模型实际处理过的全部 input token」：
 *
 *     promptTokensTotal = promptTokens + cacheRead + cacheWrite
 *     hitRate = cacheRead / promptTokensTotal
 *
 * @param usage - 至少包含 promptTokens；cache 字段可选
 * @returns 0..1 之间的命中率。无缓存信息 / 无 input token 时返回 0（不是 NaN）
 */
export function computeCacheHitRate(usage: {
  promptTokens: number;
  /** Cache-aware denominator; when present it wins over the derivation below. */
  promptTokensTotal?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheMiss?: number;
}): number {
  const reads = usage.cacheRead ?? 0;
  if (reads <= 0) return 0;

  // Prefer the denominator that `normalizeUsage()` already reconciled against
  // the provider's own totalTokens invariant. Only fall back to derivation when
  // the caller passed raw adapter values.
  const writes = usage.cacheWrite ?? 0;
  const totalInput =
    usage.promptTokensTotal !== undefined && usage.promptTokensTotal > 0
      ? usage.promptTokensTotal
      : (usage.promptTokens ?? 0) + reads + writes;
  if (totalInput <= 0) return 0;

  const rate = reads / totalInput;
  // Defensive clamp: a misbehaving provider should never produce >100%.
  return Math.min(1, Math.max(0, rate));
}

/**
 * 将 LLMMessage.content (string | ContentPart[]) 扁平化为单一文本字符串。
 *
 * 用途：assistant 消息同时携带 toolCalls 时，AI SDK v6 不原生支持
 * ContentPart[] 形式的多模态输出，因此把 text parts 拼接为字符串，
 * 非 text parts (image/file) 故意丢弃——因为 assistant -> AI SDK 的
 * 回传链路只需要 text + tool-calls。
 */
function flattenAssistantContentToText(content: string | ContentPart[]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/**
 * Recursively sort object keys for deterministic byte serialization.
 *
 * I2 (review-cache-stability.md): the LLM may emit the same tool call
 * with keys in different orders across turns (e.g. `{a:1,b:2}` vs
 * `{b:2,a:1}`). AI SDK internally JSON.stringifies tool-call `input`
 * before forwarding to Anthropic — if the key order shifts, the cache
 * prefix changes and Anthropic reports a cache miss.
 *
 * Sorting keys before JSON.stringify (or before handing to AI SDK)
 * guarantees the bytes are deterministic regardless of LLM key order.
 *
 * Behavioral notes:
 * - Arrays preserve their order (element order is semantically meaningful).
 * - Uint8Array / Buffer are returned by identity (we don't try to sort
 *   their bytes — that would be lossy and impossible for binary data).
 * - Primitives (string, number, boolean, null, undefined) pass through.
 *
 * @see https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
 */
export function sortObjectKeysDeep<T>(obj: T, seen: WeakSet<object> = new WeakSet()): T {
  // Primitives, null, undefined → identity
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;

  // Cycle detection — keep the cycle node as-is (preserves type identity and avoids RangeError)
  if (seen.has(obj as object)) return obj;
  seen.add(obj as object);

  // Arrays preserve order, but we recurse into their elements
  if (Array.isArray(obj)) {
    return obj.map((item) => sortObjectKeysDeep(item, seen)) as unknown as T;
  }

  // Binary data (Uint8Array / Buffer) → identity (preserve bytes)
  if (obj instanceof Uint8Array) return obj;

  // URL → identity (URL.toString() would be a coercion)
  if (obj instanceof URL) return obj;

  // Date / RegExp → identity (preserve source/flags/time)
  if (obj instanceof Date) return obj;
  if (obj instanceof RegExp) return obj;

  // WeakSet / WeakMap → identity (entries are intentionally opaque / not enumerable)
  if (obj instanceof WeakSet) return obj;
  if (obj instanceof WeakMap) return obj;

  // Map → plain object with sorted keys (Map ordering is insertion order, which is unstable across machines)
  if (obj instanceof Map) {
    const sortedEntries = [...obj.entries()].sort(([a], [b]) =>
      String(a).localeCompare(String(b)),
    );
    const sorted: Record<string, unknown> = {};
    for (const [k, v] of sortedEntries) {
      sorted[String(k)] = sortObjectKeysDeep(v, seen);
    }
    return sorted as unknown as T;
  }

  // Set → sorted array (Set ordering is insertion order, which is unstable across machines)
  if (obj instanceof Set) {
    return [...obj].sort().map((v) => sortObjectKeysDeep(v, seen)) as unknown as T;
  }

  // Class instances / non-plain objects → identity passthrough
  // (Recursing would lose prototype methods / `this` binding / class identity)
  if (!isPlainObject(obj)) return obj;

  // Plain object → recurse with sorted keys
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = sortObjectKeysDeep((obj as Record<string, unknown>)[key], seen);
  }
  return sorted as unknown as T;
}

/**
 * Returns true iff `obj` is a plain object (Object.prototype or null prototype).
 * Class instances and other exotic objects return false.
 */
function isPlainObject(obj: unknown): obj is Record<string, unknown> {
  if (obj === null || typeof obj !== "object") return false;
  const proto = Object.getPrototypeOf(obj);
  return proto === Object.prototype || proto === null;
}

/**
 * Anthropic cache_control: { type: "ephemeral" } option.
 *
 * @see https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
 *
 * When this option appears on a content part (or system message), Anthropic
 * treats that point as a cache breakpoint: all preceding tokens become
 * cacheable for ~5 minutes. The AI SDK Anthropic provider translates this
 * to `cache_control: { type: "ephemeral" }` in the outgoing request.
 *
 * Anthropic limits:
 * - max 4 cache breakpoints per request
 * - each breakpoint must cover ≥ 1024 tokens
 *
 * We currently set 2 breakpoints (system + last user) which keeps us
 * comfortably under the 4-breakpoint limit and lets the entire prefix
 * (system + history + current query) hit the cache on multi-turn calls.
 */
const ANTHROPIC_CACHE_CONTROL = {
  anthropic: { cacheControl: { type: "ephemeral" } },
} as const;

// 【Task #2748 §5.3-5.5】cache 优化 helper 已抽到 ./llm-cache.ts
import {
  isOpenAICompatibleProvider,
  buildOpenAICompatProviderOptions,
  applyToolCacheControl,
  canonicalizeParts,
} from "./llm-cache";

// Re-export the public cache helpers so existing call sites (e.g. tests) keep working.
export { applyToolCacheControl, canonicalizeParts } from "./llm-cache";

/**
 * 将 LLMMessage 转换为 AI SDK 格式
 *
 * I1 (review-cache-stability.md): inserts Anthropic prompt-cache breakpoints
 * on the system message and the last user message. Without these, Anthropic
 * never caches anything and we pay full input price every turn.
 *
 * Task #2748 §5.3: 支持 sessionId 参数，给 OpenAI-Compatible provider
 * 注入 prompt_cache_key=sessionId。
 */
export function convertToSDKMessages(
  messages: LLMMessage[],
  options?: { sessionId?: string; provider?: string }
): ModelMessage[] {
  // Compute the index of the last user message once, up-front.
  // We attach cacheControl to the LAST user message so the entire prefix
  // (system + all prior turns + current query) becomes cacheable.
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIndex = i;
      break;
    }
  }

  // 【Task #2748 §5.3】计算 OpenAI-Compatible providerOptions
  // 只对 OpenAI-Compatible 注入 prompt_cache_key；Anthropic 用 cache_control
  const openaiOptions = isOpenAICompatibleProvider(options?.provider ?? "")
    ? buildOpenAICompatProviderOptions(options?.sessionId, "long")
    : {};

  return messages.map((msg, index) => {
    // I1: system message — cache breakpoint on the whole system prompt
    if (msg.role === "system") {
      return {
        role: "system" as const,
        content: typeof msg.content === "string" ? msg.content : "",
        // 【Task #2748 §5.3】OpenAI-Compatible 注入 promptCacheKey
        // Anthropic 仍用 ANTHROPIC_CACHE_CONTROL
        providerOptions:
          Object.keys(openaiOptions).length > 0
            ? { ...ANTHROPIC_CACHE_CONTROL, ...openaiOptions }
            : ANTHROPIC_CACHE_CONTROL,
      };
    }

    // v2.1: 处理 user 消息的 array content (多模态: text + image)
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const contentParts = msg.content.map((part) => {
        if (part.type === "image") {
          // AI SDK ImagePart: { type: 'image', image: DataContent | URL }
          return { type: "image" as const, image: part.image };
        }
        if (part.type === "file") {
          // AI SDK FilePart: { type: 'file', data: DataContent | URL, mediaType: string }
          return { type: "file" as const, data: part.file, mediaType: part.mediaType };
        }
        return { type: "text" as const, text: part.text };
      });

      // I1: attach cacheControl to the last part of the LAST user message
      // so all preceding tokens (system + history + earlier user parts) become
      // cacheable. Other user messages get no cacheControl.
      if (index === lastUserIndex && contentParts.length > 0) {
        const lastPart = contentParts[contentParts.length - 1] as Record<string, unknown>;
        lastPart.providerOptions = ANTHROPIC_CACHE_CONTROL;
      }

      return {
        role: "user" as const,
        content: contentParts,
      };
    }

    // I1: text-only user messages — same treatment, but cacheControl goes on
    // the message-level providerOptions rather than an inline part.
    if (msg.role === "user" && typeof msg.content === "string") {
      if (index === lastUserIndex) {
        return {
          role: "user" as const,
          content: msg.content,
          providerOptions: ANTHROPIC_CACHE_CONTROL,
        };
      }
      return {
        role: "user" as const,
        content: msg.content,
      };
    }

    // 处理 assistant 消息中的 toolCalls
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      // AI SDK v6 期望 toolCalls 在 content 数组中作为 tool-call part
      // 注意：使用 input: unknown 而不是 arguments: string
      const toolCallParts = msg.toolCalls.map((tc) => {
        // 解析 arguments 为对象
        let input: unknown = {};
        if (tc.function?.arguments) {
          if (typeof tc.function.arguments === "string") {
            input = safeParseToolArgs(tc.function.arguments);
          } else {
            input = tc.function.arguments;
          }
        } else if ((tc as any).arguments) {
          if (typeof (tc as any).arguments === "string") {
            input = safeParseToolArgs((tc as any).arguments);
          } else {
            input = (tc as any).arguments;
          }
        }

        // I2 (review-cache-stability.md): sort keys recursively so the
        // eventual JSON.stringify of `input` is byte-stable regardless of
        // the LLM's key ordering across turns. Without this, the same
        // tool call emitted as {a,b} vs {b,a} produces different prefix
        // bytes → Anthropic cache miss.
        input = sortObjectKeysDeep(input);

        return {
          type: "tool-call" as const,
          toolCallId: tc.id,
          toolName: tc.function?.name || tc.name || "unknown",
          input,
        };
      });
      
      // Preserve text content alongside tool-call parts
      // Without this, text/reasoning from previous iterations is lost in the round-trip
      // v2.1 fix (B1): assistant messages may carry ContentPart[] (multimodal). AI SDK
      // does not natively support multimodal assistant output, so we flatten text parts
      // into a single string. Non-text parts (image, file) are dropped — this is a safe
      // fallback since assistant -> AI SDK round-trip only needs text/tool-calls.
      const contentParts: Array<
        { type: "text"; text: string } | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
      > = [];
      if (msg.content) {
        contentParts.push({ type: "text", text: flattenAssistantContentToText(msg.content) });
      }
      contentParts.push(...toolCallParts);

      return {
        role: "assistant" as const,
        content: contentParts,
      };
    }
    
    // 验证 tool 消息格式
    if (msg.role === "tool") {
      // ✅ Task #4992 R3: a tool message may carry its result INSIDE
      // an array `content` of tool-result parts (AI SDK part shape —
      // how SessionComponent persists tool messages and how the
      // repair functions emit them). Without this branch the id was
      // lost ("unknown") and the converter's pending-set never saw a
      // result → AI_MissingToolResultsError even for perfectly
      // paired histories.
      if (!msg.toolCallId && Array.isArray(msg.content)) {
        const part = (msg.content as any[]).find((p: any) => p?.type === "tool-result" && typeof p.toolCallId === "string");
        if (part) {
          const convertedPart: ModelMessage = {
            role: "tool" as const,
            content: [{
              type: "tool-result" as const,
              toolCallId: part.toolCallId,
              toolName: part.toolName || "unknown",
              output: {
                type: "text" as const,
                value: typeof part.output === "string" ? part.output : JSON.stringify(part.output ?? ""),
              },
            }],
          };
          return convertedPart;
        }
      }
      if (!msg.toolCallId) {
        logger.warn("Tool message missing toolCallId", { msg });
      }
      
      // AI SDK v6 要求 tool 消息的 output 格式为 { type: 'text', value: string }
      // 处理 content 可能是数组的情况（AI SDK v6 格式）
      let outputValue = "";
      const content = msg.content as string | unknown[];
      if (typeof content === "string") {
        outputValue = content;
      } else if (Array.isArray(content)) {
        // 如果是数组，可能是 [{ type: 'tool-result', output: '...' }]
        const toolResultPart = (content as any[]).find((p: any) => p?.type === "tool-result");
        if (toolResultPart) {
          outputValue = typeof toolResultPart.output === "string" 
            ? toolResultPart.output 
            : JSON.stringify(toolResultPart.output);
        } else {
          // 尝试提取任何文本内容
          outputValue = JSON.stringify(content);
        }
      } else {
        outputValue = JSON.stringify(content);
      }
      
      const converted: ModelMessage = {
        role: "tool" as const,
        content: [{
          type: "tool-result" as const,
          toolCallId: msg.toolCallId || "unknown",
          toolName: msg.name || "unknown",
          output: {
            type: "text" as const,
            value: outputValue,
          },
        }],
      };
      
      return converted;
    }
    return msg as unknown as ModelMessage;
  });
}

/**
 * 将 ToolInfo 转换为 AI SDK ToolSet 格式
 *
 * 【Task #2748 §5.4】对 Anthropic 末 tool 挂 cache_control
 * 复用 applyToolCacheControl helper：Anthropic 3 层 cache → 多省 10-30% input cost
 */
function convertToolsToSDK(tools: ToolInfo[], providerName?: string): ToolSet {
  const result: ToolSet = {};

  for (const tool of tools) {
    const jsonSchemaObj = extractToolSchema(tool.parameters);
    (result as Record<string, unknown>)[tool.name] = {
      description: tool.description || "",
      inputSchema: jsonSchema(jsonSchemaObj),
    };
  }

  // 【Task #2748 §5.4】对 Anthropic 末 tool 挂 cache_control
  if (providerName) {
    const cached = applyToolCacheControl(
      Object.entries(result).map(([name, def]) => ({ name, ...((def as object) || {}) })),
      providerName
    );
    if (cached && cached.length > 0) {
      // 把 cache_control 写回原 ToolSet（仅末 tool）
      const lastCached = cached[cached.length - 1] as Record<string, unknown>;
      const lastName = (lastCached.name as string) || Object.keys(result)[Object.keys(result).length - 1];
      if (result[lastName]) {
        (result[lastName] as Record<string, unknown>).providerOptions = lastCached.providerOptions;
      }
    }
  }

  return result;
}

/**
 * 从 Zod 类型提取 JSON Schema
 */
function extractToolSchema(parameters: Record<string, unknown>): Record<string, unknown> {
  // ★ Task #4231：统一走 toolParametersToJsonSchema —— 会**彻底展开 $ref**。
  //   旧实现只把 `definitions.zod` 提出来当顶层 schema（丢掉 definitions），
  //   导致 `action_type: {"$ref": "#/definitions/zod/properties/milestone_type"}`
  //   变成悬空指针 → strict 的 openai-compatible 网关（opencodego）直接 400：
  //   `Invalid schema for function 'task_operation_create': Pointer
  //    '/definitions/zod/properties/milestone_type' does not exist`。
  return toolParametersToJsonSchema(parameters);
}

/**
 * 生成 Provider 选项
 */
function generateProviderOptions(
  providerType: string,
  options: {
    temperature?: number;
    maxTokens?: number;
  }
): {
  temperature?: number;
  maxTokens?: number;
  providerOptions: Record<string, unknown>;
} {
  const result: {
    temperature?: number;
    maxTokens?: number;
    providerOptions: Record<string, unknown>;
  } = {
    providerOptions: {},
  };

  if (options.temperature !== undefined) {
    result.temperature = options.temperature;
  }

  if (options.maxTokens !== undefined) {
    result.maxTokens = options.maxTokens;
  }

  // Provider 特定配置
  switch (providerType) {
    case "anthropic":
      // Anthropic 不支持 temperature，使用 top_p
      break;
    case "openai-compatible":
      // OpenAI 兼容格式支持 includeUsage
      result.providerOptions.includeUsage = true;
      break;
  }

  return result;
}

/**
 * 转换 toolChoice 格式
 *
 * AI SDK 的 streamText/generateText 期望的 toolChoice 格式为：
 *   - "auto" | "none" | "required" (string)
 *   - { type: "tool", toolName: "xxx" } (object)
 *
 * 而我们内部使用的格式为 OpenAI 风格：
 *   - "auto" | "none" (string)
 *   - { type: "function", function: { name: "xxx" } } (object)
 *
 * 此函数将内部格式转换为 AI SDK 兼容格式。
 */
function convertToolChoice(
  toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } }
): Parameters<typeof streamText>[0]["toolChoice"] {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === "string") return toolChoice;
  // { type: "function", function: { name: "xxx" } } → { type: "tool", toolName: "xxx" }
  // 验证 toolName 不为空，避免 AI SDK 收到空 toolName 导致行为异常
  const toolName = toolChoice.function?.name?.trim();
  if (!toolName) return undefined;
  return { type: "tool" as const, toolName };
}

/**
 * 创建 Env 事件发布函数
 * @param env Environment 实例
 * @param context 上下文信息
 * @returns 发布函数
 */
function createEnvEventEmitter(env?: Environment, context?: InvokeOptions["context"]) {
  if (!env || typeof env.pushEnvEvent !== "function") {
    logger.warn("[invoke] createEnvEventEmitter: env is null/undefined or pushEnvEvent is unavailable, streaming events will be disabled");
    return null;
  }

  return (event: { type: string; [key: string]: unknown }) => {
    try {
      const fullType = `llm.${event.type}`;
      env.pushEnvEvent({
        id: randomUUID(),
        type: fullType,
        timestamp: Date.now(),
        metadata: {
          source: "llm.invoke",
          sessionId: context?.sessionId,
          messageId: context?.messageId,
        },
        payload: event,
      });
    } catch (err) {
      logger.warn("Failed to push env event", { error: String(err), eventType: event.type });
    }
  };
}

/**
 * 从 AI SDK stream part 提取文本增量（兼容 text / delta 字段）
 */
export function getStreamPartText(part: Record<string, unknown>): string {
  const value = part.text ?? part.delta ?? part.textDelta;
  return typeof value === "string" ? value : "";
}

/**
 * 处理流式 thinking 标签
 * 在检测到 opening/closing 标签时立即触发推理事件
 *
 * Note: `removeFromOutput` lives on `InvokeConfig.options.thinkingInText`
 * but is NOT consulted here — caller (invoke) decides whether to expose
 * `fullContent` (cleaned) or `rawFullContent` (with raw tags preserved
 * for message-history continuity).
 */
function processThinkingStream(
  textDelta: string,
  config: {
    enabled?: boolean;
    tags?: string[];
  },
  state: {
    isOpen: boolean;
    content: string;
  }
): {
  cleanedText: string;
  isThinkingTagOpen: boolean;
  currentThinkingContent: string;
  reasoningEvents: string[];
} {
  if (!config.enabled || !textDelta) {
    return {
      cleanedText: textDelta,
      isThinkingTagOpen: state.isOpen,
      currentThinkingContent: state.content,
      reasoningEvents: [],
    };
  }

  const tags = config.tags || ["thinking"];
  let remainingText = textDelta;
  const reasoningEvents: string[] = [];
  let isOpen = state.isOpen;
  let currentContent = state.content;

  for (const tag of tags) {
    const openTag = `<${tag}>`;
    const closeTag = `</${tag}>`;

    let text = remainingText;
    let result = "";

    const openIndex = text.toLowerCase().indexOf(openTag.toLowerCase());
    const closeIndex = text.toLowerCase().indexOf(closeTag.toLowerCase());

    if (openIndex !== -1 && (closeIndex === -1 || openIndex < closeIndex)) {
      // 先找到 opening 标签
      const beforeOpen = text.substring(0, openIndex);
      const afterOpen = text.substring(openIndex + openTag.length);

      if (!isOpen) {
        isOpen = true;
        currentContent = "";
        reasoningEvents.push("");
      }

      result += beforeOpen;

      const innerCloseIndex = afterOpen.toLowerCase().indexOf(closeTag.toLowerCase());

      if (innerCloseIndex !== -1) {
        // 同一 delta 中有 opening 和 closing
        const thinkingContent = afterOpen.substring(0, innerCloseIndex);
        const afterClose = afterOpen.substring(innerCloseIndex + closeTag.length);

        currentContent += thinkingContent;
        reasoningEvents.push(currentContent);

        isOpen = false;
        currentContent = "";

        result += afterClose;
      } else {
        // 只有 opening 标签
        currentContent += afterOpen;
        reasoningEvents.push(currentContent);
        result += "";
      }

      remainingText = result;
    } else if (closeIndex !== -1) {
      // 先找到 closing 标签
      const beforeClose = text.substring(0, closeIndex);
      const afterClose = text.substring(closeIndex + closeTag.length);

      if (isOpen) {
        currentContent += beforeClose;
        reasoningEvents.push(currentContent);
        isOpen = false;
        currentContent = "";
        result = afterClose;
      } else {
        result = text;
      }

      remainingText = result;
    }
  }

  // 🐛 如果已打开 think 标签但当前 chunk 无标签，内容应累积为 reasoning
  if (isOpen && remainingText === textDelta) {
    currentContent += remainingText;
    reasoningEvents.push(currentContent);
    remainingText = "";
  }

  return {
    cleanedText: remainingText,
    isThinkingTagOpen: isOpen,
    currentThinkingContent: currentContent,
    reasoningEvents,
  };
}

/**
 * 核心 LLM 调用函数
 * 使用 AI SDK 的 streamText
 * 
 * 流式事件通过 env.pushEnvEvent() 发布
 *
 * @param config - Invoke 配置
 * @param options - LLM 选项
 * @param ctx - Tool Context
 * @returns ToolResult
 */
export async function invoke(
  config: InvokeConfig,
  options: InvokeOptions,
  ctx: LLMToolContext
): Promise<ToolResult> {
  try {
    // 0. 创建 Env 事件发布器
    const emitToEnv = createEnvEventEmitter(options.env, options.context);
    logger.info('[invoke] Created event emitter', {
      envAvailable: !!options.env,
      hasContext: options.context !== undefined,
    });

    // 1. 解析模型字符串
    const { providerId, modelId } = parseModelString(options.model || config.model);

    // 2. 获取 Provider 实例
    // 注意：实际使用需要 ProviderManager 已初始化
    // 这里简化处理，直接创建 SDK Provider
    const provider = createProviderInstance(
      providerId,
      config.apiKey,
      config.baseURL,
      options.context?.sessionId,
      options.cacheRetention,
      modelId,
    );

    if (!provider) {
      throw new Error(`Failed to create provider for ${providerId}`);
    }

    // 3. 转换消息为 AI SDK 格式
    // 【Task #2760 Dim 3】把 sessionId + provider 透传给 convertToSDKMessages，
    // 让 OpenAI-Compatible provider 注入 prompt_cache_key=sessionId。
    // 修复前单元测试通过但生产路径漏传 → 99% 命中率实际来自 DeepSeek 隐式 prefix caching，
    // 修复后命中代码层的 prompt_cache_key 显式 cache。
    const messages = convertToSDKMessages(options.messages, {
      sessionId: options.context?.sessionId,
      provider: providerId,
    });

    // ✅ Task #4992 (Defence 2, orphan tool-call fix):
    // The AI SDK prompt converter is zero-tolerant about
    // assistant tool-calls without matching tool-results —
    // a single orphan in the history makes streamText() throw
    // AI_MissingToolResultsError and kill the run (production
    // kill chain: Task #4983, session_1bba0d11). Repair every
    // orphan with a placeholder tool-result BEFORE streamText,
    // so ANY source of orphans (legacy sessions, crashes,
    // ContextError windows) can no longer break the fallback.
    const orphanRepair = repairOrphanSdkMessages(messages, {
      reason: "repaired before AI SDK fallback (Task #4992 defence 2)",
    });
    if (orphanRepair.repairedCount > 0) {
      logger.warn(
        `[invoke] Repaired ${orphanRepair.repairedCount} orphan tool-call(s) before AI SDK fallback: ` +
        orphanRepair.orphans.map((o) => o.toolCallId).join(", "),
      );
    }

    // DEBUG: 记录转换后消息中的 toolCallId 匹配情况
    const toolCallIds = new Set<string>();
    const assistantToolCalls: { id: string; name?: string }[] = [];
    const toolResultIds: string[] = [];
    
    for (const msg of messages) {
      if (msg.role === "assistant") {
        // 检查 assistant 消息中的 toolCalls
        const assistantContent = Array.isArray(msg.content) ? msg.content : [];
        for (const part of assistantContent) {
          if (part && typeof part === "object" && (part as any).type === "tool-call") {
            const tc = (part as any).toolCall || (part as any);
            assistantToolCalls.push({ id: tc.id, name: tc.name || (tc.function && tc.function.name) });
            toolCallIds.add(tc.id);
          }
        }
      }
      if (msg.role === "tool") {
        const toolContent = Array.isArray(msg.content) ? msg.content : [];
        for (const part of toolContent) {
          if (part && typeof part === "object" && (part as any).type === "tool-result") {
            toolResultIds.push((part as any).toolCallId);
          }
        }
      }
    }
    
    // 检查 toolCallId 匹配
    const missingToolResults = assistantToolCalls.filter(tc => !toolResultIds.includes(tc.id));
    const orphanedToolResults = toolResultIds.filter(id => !toolCallIds.has(id));
    
    if (assistantToolCalls.length > 0 || toolResultIds.length > 0) {
      logger.debug("[invoke] ToolCallId matching analysis:", {
        assistantToolCalls,
        toolResultIds,
        missingToolResults: missingToolResults.length > 0 ? missingToolResults : "none",
        orphanedToolResults: orphanedToolResults.length > 0 ? orphanedToolResults : "none",
      });
    }

    // 4. 转换工具
    const tools = options.tools && options.tools.length > 0 ? convertToolsToSDK(options.tools, providerId) : undefined;

    // 5. 生成 Provider 选项
    const providerOptions = generateProviderOptions(providerId, {
      temperature: options.temperature,
      maxTokens: options.maxTokens,
    });

    // 6. 发布开始事件
    const model = `${providerId}/${modelId}`;
    if (emitToEnv) {
      logger.info('[invoke] Emitting llm.start event');
      emitToEnv({ type: "start", metadata: { model } });
    } else {
      logger.warn('[invoke] emitToEnv is null, skipping llm.start event');
    }

    // 7. 调用 AI SDK streamText
    const streamTextOptions = {
      model: provider.languageModel(modelId) as Parameters<typeof streamText>[0]["model"],
      // Task #4992: use the REPAIRED message array (orphans patched
      // above) so streamText's converter can never throw
      // AI_MissingToolResultsError.
      messages: orphanRepair.messages,
      tools,
      temperature: providerOptions.temperature,
      maxTokens: providerOptions.maxTokens,
      abortSignal: ctx.abort,
      maxRetries: MAX_RETRIES,
      streamOptions: {
        includeUsage: true,
      },
      allowSystemInMessages: true,
      toolChoice: convertToolChoice(options.toolChoice),
    };

    const result = await streamText(streamTextOptions as Parameters<typeof streamText>[0]);

    // 8. 处理流
    let fullContent = "";        // 清理后的文本（不含 think 标签，用于显示）
    let rawFullContent = "";     // 原始文本（含 think 标签，用于消息历史，保证后续对话继续输出 reasoning）
    let reasoningContent = "";
    const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
    let usageInfo: ConvertedUsageInfo | undefined;
    const textDeltaLog: string[] = []; // DEBUG: 记录所有 text-delta 用于排查重复

    // 流式推理状态
    let isThinkingTagOpen = false;
    let currentThinkingContent = "";

    for await (const part of result.fullStream) {
      const streamPart = part as Record<string, unknown>;

      // Hoist thinkingInText config out of the text-delta branch so that
      // reasoning-delta suppression can consult the same flag.
      const thinkingConfig = (config.options as { thinkingInText?: { enabled?: boolean; tags?: string[]; removeFromOutput?: boolean } } | undefined)?.thinkingInText;

      switch (streamPart.type) {
        case "text-delta": {
          const textDelta = getStreamPartText(streamPart);
          if (!textDelta) break;

          if (thinkingConfig?.enabled) {
            const thinkingResult = processThinkingStream(textDelta, thinkingConfig, {
              isOpen: isThinkingTagOpen,
              content: currentThinkingContent,
            });

            isThinkingTagOpen = thinkingResult.isThinkingTagOpen;
            currentThinkingContent = thinkingResult.currentThinkingContent;
            fullContent += thinkingResult.cleanedText;
            rawFullContent += textDelta;  // 保存原始文本（含 think 标签），用于消息历史

            for (const reasoningSnapshot of thinkingResult.reasoningEvents) {
              const delta = reasoningSnapshot.slice(reasoningContent.length);
              reasoningContent = reasoningSnapshot;
              if (emitToEnv && delta) {
                emitToEnv({ type: "reasoning", content: reasoningContent, delta });
              }
            }

            if (emitToEnv && thinkingResult.cleanedText) {
              emitToEnv({ type: "text", content: fullContent, delta: thinkingResult.cleanedText });
            }
          } else {
            fullContent += textDelta;
            rawFullContent += textDelta;
            if (process.env.DEBUG_DUPLICATE) {
              textDeltaLog.push(textDelta);
            }
            if (emitToEnv) {
              emitToEnv({ type: "text", content: fullContent, delta: textDelta });
            }
          }
          break;
        }

        case "reasoning-delta": {
          const reasoningDelta = getStreamPartText(streamPart);
          if (!reasoningDelta) break;
          // When thinkingInText is enabled, reasoning is sourced from inline
          // <think> tags in text-delta (via processThinkingStream). Native
          // reasoning-delta events would duplicate that reasoning, so we
          // suppress them here. This matches the documented intent:
          // "With thinkingInText enabled, the reasoning-delta events must
          //  be suppressed to prevent duplication."
          if (thinkingConfig?.enabled) break;
          reasoningContent += reasoningDelta;
          if (emitToEnv) {
            emitToEnv({ type: "reasoning", content: reasoningContent, delta: reasoningDelta });
          }
          break;
        }

        case "reasoning-end":
          // 不关闭 reasoning 块：native reasoning-end 事件之后还有 text-delta，
          // 块会在 text / completed 到达时自动关闭。
          break;

        case "tool-call": {
          const toolInput = streamPart.input as Record<string, unknown>;
          const toolCallId = (streamPart.toolCallId ?? streamPart.id) as string;
          const toolName = streamPart.toolName as string;
          toolCalls.push({
            id: toolCallId,
            name: toolName,
            args: toolInput,
          });
          break;
        }

        case "finish-step":
          const stepUsage = extractUsageInfo(streamPart.usage as AISDKUsage);
          if (stepUsage) {
            usageInfo = stepUsage;
          }
          break;

        case "error":
          throw streamPart.error;

        case "finish":
          usageInfo = extractUsageInfo(streamPart.totalUsage as AISDKUsage);
          if (!usageInfo && streamPart.usage) {
            usageInfo = extractUsageInfo(streamPart.usage as AISDKUsage);
          }
          break;
      }
    }

    // 9. 发布完成事件
    if (emitToEnv) {
      emitToEnv({
        type: "completed",
        content: fullContent,
        metadata: {
          model,
          usage: usageInfo,
        },
      });
    }

    // 10. 选择输出内容
    // 当 thinkingInText.removeFromOutput 为 true 时使用 cleaned fullContent，
    // 否则使用 rawFullContent（含 think 标签）存入消息历史，避免 MiniMax 因
    // 历史中无 think 标签而停止输出 reasoning
    const thinkingOpts = (config.options as { thinkingInText?: { removeFromOutput?: boolean } } | undefined)?.thinkingInText;
    const outputContent = thinkingOpts?.removeFromOutput ? fullContent : rawFullContent;

    // DEBUG: 记录 fullContent / rawFullContent 的值，排查 DeepSeek 文本重复问题
    if (process.env.DEBUG_DUPLICATE) {
      const outputLines = outputContent.split('\n').filter(Boolean);
      const uniqueLines = new Set(outputLines);
      if (outputLines.length !== uniqueLines.size) {
        logger.warn('[DEBUG_DUPLICATE] outputContent has duplicate lines', {
          fullContent,
          rawFullContent,
          outputContent,
          reasoningContent: reasoningContent || '',
          textDeltas: textDeltaLog,
        });
      } else {
        logger.info('[DEBUG_DUPLICATE] outputContent OK', {
          charCount: outputContent.length,
          lineCount: outputLines.length,
          uniqueLineCount: uniqueLines.size,
          hasReasoning: !!reasoningContent,
        });
      }
    }

    if (toolCalls.length > 0) {
      const firstToolCall = toolCalls[0];
      return {
        toolCallId: firstToolCall.id,
        result: JSON.stringify({
          content: outputContent,
          reasoning: reasoningContent || undefined,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.args),
            },
          })),
        }),
      };
    }

    return {
      toolCallId: "invoke-" + Date.now(),
      result: JSON.stringify({
        content: outputContent,
        reasoning: reasoningContent || undefined,
        usage: usageInfo,
        model,
      }),
    };
  } catch (error) {
    // Never trust an upstream error message to be secret-free: AI SDK / fetch
    // errors can embed the request URL, Authorization header, or provider error
    // payload, any of which may contain the API key.
    const rawMessage = error instanceof Error ? error.message : String(error);
    const rawStack = error instanceof Error ? error.stack : undefined;
    const safeMessage = redactSecrets(rawMessage, [config.apiKey]);
    logger.error("Error during invocation", {
      error: safeMessage,
      stack: rawStack ? redactSecrets(rawStack, [config.apiKey]) : undefined,
    });

    return {
      toolCallId: "error-" + Date.now(),
      result: safeMessage,
      isError: true,
      // Task #4625: keep the structured error. `safeMessage` is a redacted
      // string, so the Retry-After header (the only source of "when does the
      // quota reset") would otherwise be lost here — exactly the boundary that
      // made `act` print "恢复时间未知".
      //
      // It must be a REDACTED COPY, not the raw object. This error travels via
      // `cause` up to `error-reply.ts`, which renders it into the user-facing
      // reply; and the sink cannot scrub properly because only this frame knows
      // the actual apiKey (pattern matching misses JWT / UUID style keys).
      ...(error instanceof Error
        ? { originalError: redactErrorForTransport(error, [config.apiKey]) as Error }
        : {}),
    };
  }
}


/**
 * Resolve the wire protocol for the outbound defence middleware (Task #4465,
 * cross-validation C1).
 *
 * Derived from the **endpoint** via `resolveApiProtocol()`, i.e. exactly the
 * same source of truth path A uses, instead of hardcoding it per provider id.
 * The distinction is load-bearing: the production `minimax` provider points at
 * `https://api.minimaxi.com/anthropic`, which is an Anthropic-protocol endpoint
 * even though its id says "minimax". A per-id table would have sent OpenAI-only
 * cache fields there.
 *
 * `providerId === "openai"` keeps its explicit `openai-responses` answer because
 * that branch calls `createOpenAI().languageModel()`, which is hardwired to the
 * responses protocol regardless of what the baseURL looks like.
 */
function resolveDefenseProtocol(providerId: string, baseURL?: string): WireProtocol {
  if (providerId === "openai") return "openai-responses";
  return wireProtocolFromApiProtocol(resolveApiProtocol(providerId, baseURL));
}

/**
 * 创建 Provider 实例
 * 根据 providerId 创建对应的 AI SDK Provider
 *
 * Task #4465: every branch that can actually reach the wire installs an
 * outbound defence `fetch` middleware (see outbound-defense.ts). The `google`
 * branch is deliberately excluded: `createGoogleGenerativeAI` exposes no
 * `fetch` option, and Google needs neither the DeepSeek-family
 * `reasoning_content` field nor OpenAI-style prompt-cache keys. Rationale:
 *
 *   - path A (`adapter-pi-ai.ts`) has carried the `reasoning_content` defence
 *     (#4398/#4403) and the explicit prompt-cache markers (#4383) for a while;
 *     path B — this AI SDK fallback — had neither, so a single transient 429 on
 *     path A turned into a hard 400 here.
 *   - The middleware patches the serialised HTTP body, which is the only place
 *     that is protocol-agnostic: `createOpenAI().languageModel()` speaks the
 *     **responses** protocol (body key `input`), while the compatible branch
 *     speaks **chat/completions** (body key `messages`).
 *   - `fetch` is the only option all three provider factories share
 *     (`transformRequestBody` exists on `openai-compatible` alone).
 *
 * The middleware is fail-open: anything it cannot parse is forwarded untouched,
 * because path B only runs once we are already in a degraded state.
 */
function createProviderInstance(
  providerId: string,
  apiKey: string,
  baseURL?: string,
  conversationId?: string,
  cacheRetention?: "none" | "short" | "long",
  modelId?: string,
): any {
  try {
    // OpenAI
    if (providerId === "openai") {
      const openai = createOpenAI({
        apiKey,
        baseURL,
        // `languageModel()` on this provider uses the **responses** API, whose
        // conversation list is `input` rather than `messages`.
        fetch: createOutboundDefenseFetch({
          provider: providerId,
          modelId,
          sessionId: conversationId,
          cacheRetention,
          wireProtocol: resolveDefenseProtocol(providerId, baseURL),
        }),
      });
      return openai;
    }

    // Anthropic
    if (providerId === "anthropic") {
      const anthropic = createAnthropic({
        apiKey,
        // The Messages API validates message fields strictly: no
        // `reasoning_content`, and prompt caching uses in-body `cache_control`
        // breakpoints (already wired via ANTHROPIC_CACHE_CONTROL). Passing the
        // protocol explicitly keeps both patches off.
        fetch: createOutboundDefenseFetch({
          provider: providerId,
          modelId,
          sessionId: conversationId,
          cacheRetention,
          wireProtocol: resolveDefenseProtocol(providerId, baseURL),
        }),
      });
      return anthropic;
    }

    // Google
    if (providerId === "google") {
      const google = createGoogleGenerativeAI({
        apiKey,
      });
      return google;
    }

    // 默认: 使用 OpenAI 兼容格式（支持 minimax、deepseek 等）
    // 【Task #4168 + #4173】OpenCode Go provider 自动注入 x-opencode-session header
    // 官方文档要求 (https://opencode.ai/docs/go/#how-it-works)：
    //   "Send a stable session ID in x-opencode-session for each conversation
    //    so we can optimize routing"
    // 不注入会返回 400 MissingSessionID。
    //
    // provider id 识别 + session id 生成统一收敛到 `opencode-session.ts`，
    // 与默认的 PiAiAdapter 路径共用（见 isOpencodeProvider / buildOpencodeHeaders）：
    //   - `"opencode"` / `"opencode-go"` / `"opencodego"` 都能命中（大小写 / -_ 无关）
    const providerHeaders = buildOpencodeHeaders(providerId, conversationId, baseURL);

    const defaultProvider = createOpenAICompatible({
      name: providerId,
      apiKey,
      baseURL: baseURL || "",
      includeUsage: true, // Enable usage in stream responses for MiniMax etc.
      headers: providerHeaders,
      // Task #4465: same outbound defence as the branches above. This is the
      // branch the production fallback actually takes (opencodego / deepseek /
      // glm / minimax all land here).
      fetch: createOutboundDefenseFetch({
        provider: providerId,
        modelId,
        sessionId: conversationId,
        cacheRetention,
        wireProtocol: resolveDefenseProtocol(providerId, baseURL),
      }),
    });
    return defaultProvider;
  } catch (error) {
    logger.error(`Failed to create provider ${providerId}`, { error: String(error) });
    return null;
  }
}

/**
 * Test-only re-export of createProviderInstance so that unit tests can verify
 * header injection behavior without booting the full invoke() stack.
 *
 * This is gated by an explicit `__` prefix to make it obvious in code review
 * that this surface is for tests only. Production code MUST NOT import this.
 */
export const __createProviderInstanceForTest = createProviderInstance;

/**
 * 非流式 LLM 调用
 * 
 * 使用 AI SDK 的 generateText API，返回完整响应
 */
export async function invokeNonStream(
  config: InvokeConfig,
  options: InvokeOptions,
  ctx: LLMToolContext
): Promise<LLMOutput> {
  // 解析模型字符串
  const { providerId, modelId } = parseModelString(options.model || config.model);

  // 获取 Provider 实例
  const provider = createProviderInstance(
    providerId,
    config.apiKey,
    config.baseURL,
    options.context?.sessionId,
    options.cacheRetention,
    modelId,
  );
  if (!provider) {
    throw new Error(`Failed to create provider for ${providerId}`);
  }

  // 转换消息和工具
  // 【Task #2760 Dim 3】非流式同样修复 (claude review #2759 指出 invokeNonStream 也漏传)
  const messages = convertToSDKMessages(options.messages, {
    sessionId: options.context?.sessionId,
    provider: providerId,
  });

  // ✅ Task #4992 (Defence 2, R3): invokeNonStream gets the same
  // orphan repair as invoke() — generateText's converter is the
  // same zero-tolerant pending-set validator.
  const orphanRepair = repairOrphanSdkMessages(messages, {
    reason: "repaired before AI SDK generateText (Task #4992 defence 2)",
  });
  if (orphanRepair.repairedCount > 0) {
    logger.warn(
      `[invokeNonStream] Repaired ${orphanRepair.repairedCount} orphan tool-call(s): ` +
      orphanRepair.orphans.map((o) => o.toolCallId).join(", "),
    );
  }

  const tools = options.tools && options.tools.length > 0 ? convertToolsToSDK(options.tools, providerId) : undefined;

  // 生成 Provider 选项
  const providerOptions = generateProviderOptions(providerId, {
    temperature: options.temperature,
    maxTokens: options.maxTokens,
  });

  // 使用 generateText API（非流式）
  const { generateText } = await import("ai");
  const genTextFn = generateText as unknown as (options: GenerateTextOptions) => Promise<GenerateTextResult>;
  const result = await genTextFn({
    model: provider.languageModel(modelId),
    messages: orphanRepair.messages,
    tools,
    temperature: providerOptions.temperature,
    maxTokens: providerOptions.maxTokens,
    abortSignal: ctx.abort,
    allowSystemInMessages: true,
    toolChoice: convertToolChoice(options.toolChoice),
  });

  // 计算 usage
  const usage = result.usage;
  const usageInfo: UsageInfo | undefined = usage ? {
    promptTokens: (usage as Record<string, unknown>).promptTokens as number ?? 0,
    completionTokens: (usage as Record<string, unknown>).completionTokens as number ?? 0,
    totalTokens: (usage as Record<string, unknown>).totalTokens as number ?? 0,
  } : undefined;

  // 发布完成事件（如果有 env 且 pushEnvEvent 可用）
  if (options.env && typeof options.env.pushEnvEvent === "function") {
    options.env.pushEnvEvent({
      id: randomUUID(),
      type: "llm.completed",
      timestamp: Date.now(),
      metadata: {
        source: "llm.invokeNonStream",
        sessionId: options.context?.sessionId,
        messageId: options.context?.messageId,
      },
      payload: {
        type: "completed",
        content: result.text,
        metadata: {
          model: `${providerId}/${modelId}`,
          usage: usageInfo,
        },
      },
    });
  }

  return {
    content: result.text,
    finishReason: result.finishReason === "stop" ? "stop" : "tool-calls",
    model: `${providerId}/${modelId}`,
    usage: usageInfo,
  };
}

/**
 * 创建 LLM 配置
 */
export function createInvokeConfig(
  model: string,
  apiKey: string,
  baseURL?: string
): InvokeConfig {
  return {
    model,
    apiKey,
    baseURL,
  };
}
