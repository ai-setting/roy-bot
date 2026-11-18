import { z } from "zod";

// ============================================================================
// Message Types
// ============================================================================

/**
 * Content Part (v2.1 - multimodal support)
 *
 * 支持文本 + 图片（多模态）的混合消息内容。
 * 字段命名严格对齐 AI SDK v6 的 UserContent (TextPart | ImagePart | FilePart)，
 * 以保证 convertToSDKMessages 返回值能直接通过类型检查并送往 AI SDK。
 *
 * 注意：
 * - AI SDK 的 ImagePart 使用 `image` 字段（不再是 OpenAI Chat Completions 的 `image_url`）
 * - AI SDK 的 FilePart 使用 `data` 字段 + 必填 `mediaType`（不再是可选 `mimeType`）
 * - 下游用户调用 OpenAI 时，AI SDK 会在 provider 适配层自动把 ImagePart 翻译成 OpenAI 格式
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: string | Uint8Array }  // base64 data URL 或 URL
  | { type: "file"; file: string | Uint8Array; mediaType: string };

/**
 * LLM Message
 */
export interface LLMMessage {
  /** 消息角色 */
  role: "system" | "user" | "assistant" | "tool";
  /** 消息内容（支持多模态：文本 + 图片） */
  content: string | ContentPart[];
  /** 工具调用（仅 assistant 角色） */
  toolCalls?: ToolCall[];
  /** 工具调用 ID（仅 tool 角色） */
  toolCallId?: string;
  /** 名称（用于 function 调用） */
  name?: string;
}

/**
 * Tool Call (OpenAI format)
 */
export interface ToolCall {
  /** 工具调用 ID */
  id: string;
  /** 工具名称 */
  name: string;
  /** 工具参数（JSON 字符串） */
  arguments: string;
  /** OpenAI 格式的 function 对象 */
  function?: {
    /** 函数名称 */
    name: string;
    /** 函数参数（JSON 字符串） */
    arguments: string;
  };
}

/**
 * Tool Result
 */
export interface ToolResult {
  /** 对应的工具调用 ID */
  toolCallId: string;
  /** 工具执行结果 */
  result: string;
  /** 是否为错误 */
  isError?: boolean;
  /**
   * Task #4625：保留原始错误对象（**已脱敏的结构副本**）。
   *
   * `result` 是字符串，装不下 `APICallError.responseHeaders` 之类结构化信息，
   * 而 `Retry-After`（额度多久恢复）只存在那里。上层构造 `Error` 时把它挂到
   * `cause` 上，`extractRetryAfterSeconds()` 才能一路挖到。
   *
   * ⚠️ **不要用 `instanceof Error` 判断它。** 为了脱敏，`invoke.ts` 交给这里的
   * 是 `redactErrorForTransport()` 产出的**普通对象副本**（不是 Error 实例），
   * 这样才能按值擦掉 apiKey。下游一律按结构化字段访问
   * （`name` / `message` / `statusCode` / `responseHeaders` / `cause`）。
   */
  originalError?: Error | Record<string, unknown>;
}

// ============================================================================
// Output Types
// ============================================================================

/**
 * Usage Information
 */
export interface UsageInfo {
  /** Prompt Token 数 */
  promptTokens: number;
  /** Completion Token 数 */
  completionTokens: number;
  /** 总 Token 数 */
  totalTokens: number;
  /**
   * Anthropic prompt cache hit tokens (cache_read_input_tokens).
   *
   * Surfaces the `cacheRead` field that AI SDK exposes on its v3 usage
   * shape (`usage.inputTokens.cacheRead`) so the application layer (CLI,
   * cost monitor, interactive REPL) can observe cache effectiveness.
   *
   * Optional because:
   * - not every provider populates this field (only Anthropic, OpenAI
   *   prompt-cache aware endpoints)
   * - `0` is a meaningful value (cache was checked, no hit) and must be
   *   preserved — `undefined` means the field was not reported.
   */
  cacheRead?: number;
  /**
   * Anthropic prompt cache write tokens (cache_creation_input_tokens).
   * See {@link cacheRead} for semantics.
   */
  cacheWrite?: number;
  /**
   * Tokens that were NOT served from cache.
   *
   * Only DeepSeek-shaped providers report this explicitly
   * (`prompt_cache_miss_tokens`). For every other provider it stays
   * `undefined` and callers should derive it from
   * `promptTokens - cacheRead - cacheWrite` if needed.
   *
   * Task #4373: added so the field survives the `llm.ts` usage re-pack.
   */
  cacheMiss?: number;
  /**
   * Total input tokens the model actually processed, i.e.
   * `promptTokens + cacheRead + cacheWrite`.
   *
   * Why this exists (Task #4373): pi-ai reports `promptTokens` as the
   * **non-cached remainder** (`input = prompt_tokens - cacheRead - cacheWrite`,
   * see `pi-ai/dist/providers/openai-completions.js::parseChunkUsage`).
   * Computing a cache hit rate as `cacheRead / promptTokens` therefore
   * explodes past 100% on real traffic. This field gives every consumer
   * (span, REPL, cost monitor) the correct denominator without having to
   * re-derive the provider semantics.
   *
   * `undefined` when the provider reported no cache fields at all.
   */
  promptTokensTotal?: number;
}

/**
 * LLM Output
 */
export interface LLMOutput {
  /** 生成的内容 */
  content: string;
  /** 推理/思考内容（支持 reasoning 模型的输出） */
  reasoning?: string;
  /** 完成原因 */
  finishReason: "stop" | "length" | "content-filter" | "tool-calls" | "function-call";
  /** 工具调用 */
  toolCalls?: ToolCall[];
  /** Usage 信息 */
  usage?: UsageInfo;
  /** 生成模型 */
  model?: string;
}

// ============================================================================
// Provider Types
// ============================================================================

/**
 * Provider 类型
 *
 * 已支持的 provider：
 * - openai / anthropic / google — 主流 LLM 厂商
 * - openai-compatible — 通用 OpenAI 兼容协议（含 deepseek / xai / minimax / kimi 等）
 */
export type ProviderType =
  | "openai"
  | "anthropic"
  | "google"
  | "openai-compatible"
  // pi-ai 新增 provider（OpenAI 兼容协议）
  | "deepseek"
  | "xai"
  | "groq"
  | "minimax"
  | "minimax-cn"
  | "moonshotai"
  | "kimi-coding"
  | "google-vertex";

/**
 * Provider 能力配置
 */
export interface ProviderCapabilities {
  /** 支持推理（CoT） */
  reasoning?: boolean;
  /** 支持工具调用 */
  toolcall?: boolean;
  /** 混合内容字段（用于解析推理内容） */
  interleaved?: {
    /** 字段名 */
    field: string;
  };
  /** 文本内思考标签配置 */
  thinkingInText?: {
    /** 是否启用 */
    enabled?: boolean;
    /** 标签列表 */
    tags?: string[];
    /** 是否从输出中移除标签内容 */
    removeFromOutput?: boolean;
  };
}

/**
 * 模型限制配置
 */
export interface ModelLimits {
  /** 上下文窗口大小（Token 数） */
  contextWindow: number;
  /** 压缩阈值（0-1），超过此比例触发上下文压缩 */
  compactionThreshold?: number;
  /** 最大输出 Token 数 */
  maxOutputTokens?: number;
}

/**
 * Provider 配置
 */
export interface ProviderConfig {
  /** Provider 类型 */
  provider: ProviderType | string;
  /** Provider 名称 */
  name?: string;
  /** Provider 描述 */
  description?: string;
  /** API Key */
  apiKey: string;
  /** Base URL（可选，用于代理或兼容 API） */
  baseURL?: string;
  /** 支持的模型列表 */
  models?: string[];
  /** Provider 默认模型 */
  defaultModel?: string;
  /** Provider 默认温度参数 */
  temperature?: number;
  /** Provider 默认最大 Token 数 */
  maxTokens?: number;
  /** Provider 能力配置 */
  capabilities?: ProviderCapabilities;
  /** 模型限制配置（按模型 ID 索引） */
  limits?: Record<string, ModelLimits>;
  /** Provider 特定选项（如 __dangerous__） */
  providerOptions?: Record<string, unknown>;
  /** 其他配置 */
  options?: Record<string, unknown>;
}

/**
 * LLM Provider 实例（由 AI SDK 创建）
 */
export interface LLMProvider {
  /** Provider ID */
  id: string;
  /** Provider 实例 */
  provider: unknown;
  /** 支持的模型 */
  models: string[];
  /** Provider 配置 */
  config?: ProviderConfig;
}

// ============================================================================
// Config Types
// ============================================================================

/**
 * 全局默认配置
 */
export interface LLMDefaultConfig {
  /** 默认温度参数 */
  temperature?: number;
  /** 默认最大 Token 数 */
  maxTokens?: number;
}

/**
 * LLM Config
 */
export interface LLMConfig {
  /** 全局默认配置 */
  default?: LLMDefaultConfig;
  /** 默认模型 */
  defaultModel?: string;
  /** Provider 配置映射 */
  providers: Record<string, ProviderConfig>;
  /** 默认 Provider */
  defaultProvider: string;
  /** 温度参数（全局覆盖） */
  temperature?: number;
  /** 最大 Token 数（全局覆盖） */
  maxTokens?: number;
  /** Top P（全局覆盖） */
  topP?: number;
  /** 是否流式输出 */
  stream?: boolean;
  /** 其他配置 */
  options?: Record<string, unknown>;
}

// ============================================================================
// Config Schema
// ============================================================================

/**
 * ProviderCapabilities Zod Schema
 */
export const ProviderCapabilitiesSchema = z.object({
  reasoning: z.boolean().optional(),
  toolcall: z.boolean().optional(),
  interleaved: z.object({
    field: z.string(),
  }).optional(),
  thinkingInText: z.object({
    enabled: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    removeFromOutput: z.boolean().optional(),
  }).optional(),
});

/**
 * ModelLimits Zod Schema
 */
export const ModelLimitsSchema = z.object({
  contextWindow: z.number().int().positive(),
  compactionThreshold: z.number().min(0).max(1).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
});

/**
 * ProviderConfig Zod Schema
 */
export const ProviderConfigSchema = z.object({
  provider: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  apiKey: z.string(),
  baseURL: z.string().optional(),
  models: z.array(z.string()).optional(),
  defaultModel: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  capabilities: ProviderCapabilitiesSchema.optional(),
  limits: z.record(z.string(), ModelLimitsSchema).optional(),
  providerOptions: z.record(z.unknown()).optional(),
  options: z.record(z.unknown()).optional(),
});

/**
 * LLMDefaultConfig Zod Schema
 */
export const LLMDefaultConfigSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
});

// ★ Task #4946 review MINOR-4：LLMConfigSchema.temperature 刻意**不带**
//   `.default(0.7)`。运行时配置加载不走这个 schema（getLLMConfig 直接
//   读 ConfigComponent），这里的 default 若将来被接进运行时解析，
//   会把「未配置」变成「配置了 0.7」，静默复活 Task #4946 修掉的
//   死锁（全局默认值掩盖 provider 级 temperature）。兜底值统一由
//   temperature-policy.ts 的 resolveTemperature() 负责。

/**
 * LLMConfig Zod Schema
 */
export const LLMConfigSchema = z.object({
  default: LLMDefaultConfigSchema.optional(),
  defaultModel: z.string().optional(),
  providers: z.record(z.string(), ProviderConfigSchema),
  defaultProvider: z.string(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  topP: z.number().min(0).max(1).optional(),
  stream: z.boolean().default(true),
  options: z.record(z.unknown()).optional(),
});

// ============================================================================
// Invoke Types
// ============================================================================

/**
 * LLM Invoke 请求
 */
export interface LLMInvokeRequest {
  /** 消息列表 */
  messages: LLMMessage[];
  /** Provider ID（可选，默认使用配置的默认 Provider） */
  providerId?: string;
  /** 模型（可选，默认使用配置的默认模型） */
  model?: string;
  /** 工具列表 */
  tools?: ToolInfo[];
  /** 温度参数 */
  temperature?: number;
  /** 最大 Token 数 */
  maxTokens?: number;
  /** Top P */
  topP?: number;
  /** 工具选择策略 */
  toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  /** 停止序列 */
  stopSequences?: string[];
  /** Abort Signal */
  abortSignal?: AbortSignal;
  /** 调用上下文（用于事件元数据） */
  context?: LLMInvokeContext;
  /** 跳过上下文阈值检查（用于 SummaryAgent 等内部调用，避免循环触发压缩） */
  skipThresholdCheck?: boolean;
}

/**
 * LLM Invoke 结果
 */
export interface LLMInvokeResult {
  /** LLM 输出 */
  output: LLMOutput;
  /** 使用的 Provider ID */
  providerId: string;
  /** 使用的模型 */
  model: string;
  /** 调用延迟（毫秒） */
  latencyMs: number;
}

// ============================================================================
// Stream Types
// ============================================================================

/**
 * Stream 事件类型
 */
export type StreamEventType =
  | "start"
  | "text"
  | "reasoning"
  | "tool-call"
  | "tool-result"
  | "finish"
  | "error";

/**
 * Stream 事件
 */
export interface StreamEvent {
  /** 事件类型 */
  type: StreamEventType;
  /** 文本内容（type=text 时） */
  content?: string;
  /** Delta 内容（type=text 时） */
  delta?: string;
  /** 推理内容（type=reasoning 时） */
  reasoning?: string;
  /** 工具调用（type=tool-call 时） */
  toolCall?: {
    id: string;
    name: string;
    arguments: string;
  };
  /** 工具结果（type=tool-result 时） */
  toolResult?: {
    id: string;
    result: string;
  };
  /** 完成原因（type=finish 时） */
  finishReason?: "stop" | "length" | "content-filter" | "tool-calls";
  /** Usage 信息（type=finish 时） */
  usage?: UsageInfo;
  /** 错误信息（type=error 时） */
  error?: string;
}

// ============================================================================
// Tool Types
// ============================================================================

/**
 * Tool Info（用于 LLM 工具调用）
 */
export interface ToolInfo {
  /** 工具名称 */
  name: string;
  /** 工具描述 */
  description?: string;
  /** 工具参数 Schema */
  parameters: Record<string, unknown>;
}

// ============================================================================
// LLM Stream Event Types (for env.pushEnvEvent)
// ============================================================================

/**
 * LLM 调用上下文（用于事件元数据）
 */
export interface LLMInvokeContext {
  /** Session ID */
  sessionId?: string;
  /** Message ID */
  messageId?: string;
}

/**
 * LLM 流式事件类型（用于通过 env.pushEnvEvent 发布）
 * 
 * 这些事件会被包装成 EnvEvent 格式发布，事件类型为 `llm.${event.type}`
 */
export type LLMStreamEvent =
  | { type: "start"; metadata: { model: string } }
  | { type: "text"; content: string; delta: string }
  | { type: "reasoning"; content: string; delta?: string; phase?: "end" }
  | { type: "tool_call"; toolCall: { id: string; name: string; arguments: string } }
  | { type: "completed"; content: string; metadata: { model: string; usage?: UsageInfo } }
  | { type: "error"; error: string };
