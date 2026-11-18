/**
 * LLM Component
 * 提供 LLM 调用能力
 */

// Adapter layer
export {
  type LLMAdapter,
  type AdapterName,
  type ChatRequest,
  type ChatResponse,
  type StreamHandle,
  type ResolvedProvider,
  ADAPTER_NAMES,
} from "./adapter";
export { PiAiAdapter } from "./adapter-pi-ai";
export { AiSdkAdapter } from "./adapter-ai-sdk";
export { createLLMAdapter, setLLMProvider, getLLMProviderOverride } from "./factory";

// Types
export {
  type ContentPart,
  type LLMMessage,
  type LLMOutput,
  type UsageInfo,
  type ToolCall,
  type ToolResult,
  type ToolInfo,
  type LLMConfig,
  type LLMProvider,
  type ProviderConfig,
  type ProviderType,
  type LLMInvokeRequest,
  type LLMInvokeResult,
  type StreamEvent,
} from "./types";

export {
  LLMConfigSchema,
  ProviderConfigSchema,
  ProviderCapabilitiesSchema,
  ModelLimitsSchema,
  LLMDefaultConfigSchema,
} from "./types";

// Provider
export { ProviderManager } from "./provider";

// Transform
export { LLMTransform } from "./transform";

// Invoke (AI SDK integration)
export {
  invoke,
  invokeNonStream,
  parseModelString,
  createInvokeConfig,
  convertToSDKMessages,
  type InvokeConfig,
  type InvokeOptions,
  type LLMToolContext,
  type ConvertedUsageInfo,
} from "./invoke";

// OpenCode Go provider helpers (shared by PiAiAdapter + AI SDK invoke path)
export {
  isOpencodeProvider,
  isOpencodeEndpoint,
  buildOpencodeHeaders,
  getOrCreateOpencodeSessionId,
  generateOpencodeSessionId,
} from "./opencode-session";

// Hooks
export {
  type LLMHookType,
  type LLMHookContext,
  type LLMBeforeInvokeHook,
  type LLMAfterInvokeHook,
  type LLMStreamHook,
  type LLMHookRegistration,
  LLMHooks,
} from "./hooks";

// Component
export { LLMComponent, type LLMComponentOptions } from "./llm";
