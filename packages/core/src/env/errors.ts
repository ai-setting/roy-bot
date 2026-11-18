/**
 * @fileoverview 统一错误类型体系
 * 
 * 提供 AgentError, ToolError, LLMError, ComponentError, ContextError 等错误类型
 * 每个错误包含 code（错误码）和 details（额外信息）
 */

/**
 * 错误码枚举
 */
export const ErrorCodes = {
  // Agent 错误 (AGENT_xxx)
  AGENT_NOT_FOUND: "AGENT_001",
  AGENT_RUN_FAILED: "AGENT_002",
  AGENT_TIMEOUT: "AGENT_003",
  AGENT_CONFIG_INVALID: "AGENT_004",
  
  // Tool 错误 (TOOL_xxx)
  TOOL_NOT_FOUND: "TOOL_001",
  TOOL_DISABLED: "TOOL_002",
  TOOL_EXECUTION_FAILED: "TOOL_003",
  TOOL_VALIDATION_FAILED: "TOOL_004",
  
  // LLM 错误 (LLM_xxx)
  LLM_PROVIDER_NOT_FOUND: "LLM_001",
  LLM_INVOCATION_FAILED: "LLM_002",
  LLM_TIMEOUT: "LLM_003",
  LLM_CONFIG_INVALID: "LLM_004",
  
  // Component 错误 (COMP_xxx)
  COMPONENT_NOT_FOUND: "COMP_001",
  COMPONENT_INIT_FAILED: "COMP_002",
  COMPONENT_NOT_RUNNING: "COMP_003",
  
  // Config 错误 (CONFIG_xxx)
  CONFIG_NOT_FOUND: "CONFIG_001",
  CONFIG_INVALID: "CONFIG_002",
  CONFIG_SOURCE_ERROR: "CONFIG_003",
  
  // Context 错误 (CTX_xxx)
  CONTEXT_THRESHOLD_EXCEEDED: "CTX_001",
  CONTEXT_COMPACTION_FAILED: "CTX_002",
  
  // MCP 错误 (MCP_xxx)
  MCP_INIT_FAILED: "MCP_001",
  MCP_SERVER_ERROR: "MCP_002",
  MCP_TOOL_ERROR: "MCP_003",
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

/**
 * RoyError 基类
 */
export class RoyError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Agent 相关错误
 */
export class AgentError extends RoyError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCodes.AGENT_NOT_FOUND,
    details?: unknown
  ) {
    super(message, code, details);
  }
}

/**
 * Tool 相关错误
 */
export class ToolError extends RoyError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCodes.TOOL_NOT_FOUND,
    public readonly toolName?: string,
    details?: unknown
  ) {
    super(message, code, details);
  }
}

/**
 * LLM 相关错误
 */
export class LLMError extends RoyError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCodes.LLM_INVOCATION_FAILED,
    public readonly provider?: string,
    details?: unknown
  ) {
    super(message, code, details);
  }
}

/**
 * Component 相关错误
 */
export class ComponentError extends RoyError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCodes.COMPONENT_NOT_FOUND,
    public readonly componentName?: string,
    details?: unknown
  ) {
    super(message, code, details);
  }
}

/**
 * LLM Output 结构（用于 ContextError 携带 assistant message）
 * 
 * 这是简化版本，仅包含保存到 session 所需的最少字段。
 * 与 llm/types.ts 中的 LLMOutput 不同，那个版本包含完整的 LLM 调用结果。
 */
export interface LLMOutput {
  content?: string;
  reasoning?: string;
  toolCalls?: Array<{
    id: string;
    function?: {
      name: string;
      arguments: string;
    };
    name?: string;
    arguments?: unknown;
  }>;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Context 相关错误
 */
export class ContextError extends RoyError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCodes.CONTEXT_THRESHOLD_EXCEEDED,
    public readonly sessionId?: string,
    public readonly usage?: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    },
    public readonly contextWindow?: number,
    public readonly llmOutput?: LLMOutput,
    details?: unknown
  ) {
    super(message, code, details);
  }
}

/**
 * 检查是否是 RoyError
 */
export function isRoyError(error: unknown): error is RoyError {
  return error instanceof RoyError;
}

/**
 * 获取错误码
 */
export function getErrorCode(error: unknown): ErrorCode | undefined {
  if (error instanceof RoyError) {
    return error.code;
  }
  return undefined;
}
