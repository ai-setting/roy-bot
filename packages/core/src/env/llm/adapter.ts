/**
 * @fileoverview LLM Adapter 抽象接口。
 *
 * roy-bot 的 LLM 接入点统一通过 LLMAdapter；
 * 当前实现：
 *   - PiAiAdapter    — 包装 @earendil-works/pi-ai（默认路径）
 *   - AiSdkAdapter   — 包装 Vercel AI SDK（fallback 路径）
 *
 * 通过 {@link createLLMAdapter} 选择，由环境变量 `ROY_LLM_PROVIDER` 控制。
 */

import type { LLMMessage, ToolInfo, UsageInfo, ProviderCapabilities } from "./types";

/** Adapter 名称（联合类型 + 运行时数组） */
export type AdapterName = "pi-ai" | "ai-sdk";

/** 运行时可用的 adapter 列表 */
export const ADAPTER_NAMES: readonly AdapterName[] = ["pi-ai", "ai-sdk"] as const;

/** Provider 解析结果 */
export interface ResolvedProvider {
  api: string;
  provider: string;
  modelId: string;
  contextLimit: number;
  maxTokensLimit: number;
}

/** Chat 请求 */
export interface ChatRequest {
  provider: string;
  modelId: string;
  messages: LLMMessage[];
  tools?: ToolInfo[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  apiKey: string;
  baseURL?: string;
  signal?: AbortSignal;
  /**
   * Conversation / session id (e.g. roy-bot session id, or the Feishu
   * chat-keyed session id `oc_...`). Used by providers that need a stable
   * per-conversation identifier — notably OpenCode Go, which requires a stable
   * `x-opencode-session` header (see opencode-session.ts).
   */
  sessionId?: string;
  /**
   * Prompt-cache retention preference (Task #4383 P0).
   *
   * Forwarded to pi-ai's `ProviderStreamOptions.cacheRetention`. When omitted,
   * `buildPiCacheOptions()` applies a protocol-aware default:
   * - `openai-completions` → `"long"` (needed for `prompt_cache_key`)
   * - anything else → pi-ai's own default (`anthropic` uses `"short"` =
   *   ephemeral `cache_control`, which is the behaviour minimax already relies on)
   */
  cacheRetention?: "none" | "short" | "long";
  /**
   * Provider capabilities from config (`llm.providers.<id>.capabilities`).
   *
   * Task #4403: this is the data path that was missing. `resolvePiModel()` used
   * to hardcode `reasoning: false` for every custom provider, so
   * `capabilities.reasoning` in config never influenced the pi-ai model
   * descriptor at all. Threading it through here lets the descriptor reflect
   * what the user actually configured.
   */
  capabilities?: ProviderCapabilities;
}

/** Chat 响应（统一形状） */
export interface ChatResponse {
  text: string;
  finishReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  usage: UsageInfo;
  raw?: unknown;
}

/** Stream handle：暴露异步事件流 + 最终结果 */
export interface StreamHandle {
  events: AsyncIterable<unknown>;
  result: () => Promise<ChatResponse>;
}

/** LLM Adapter 接口（3 个核心方法） */
export interface EmbedRequest {
  provider: string;
  modelId: string;
  input: string | string[];
  apiKey: string;
  baseURL?: string;
  signal?: AbortSignal;
}

export interface EmbedResponse {
  embeddings: number[][];
  usage: UsageInfo;
}

export interface LLMAdapter {
  readonly name: AdapterName;
  chat(req: ChatRequest): Promise<ChatResponse>;
  stream(req: ChatRequest): Promise<StreamHandle>;
  resolveProvider(provider: string, modelId: string): Promise<ResolvedProvider>;
  embed(req: EmbedRequest): Promise<EmbedResponse>;
}
