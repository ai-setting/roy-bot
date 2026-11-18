/**
 * @fileoverview AgentComponent Types
 * 
 * 基于 roy-bot docs/agent-component-design.md
 * 
 * 注意：Tool 相关类型从 ToolComponent 复用，保持统一
 */

import type { ModelMessage } from "ai";
import type { Tool, ToolResult } from "../tool/types";
import type { LLMOutput } from "../llm/types";

// AbortSignal type from global scope (instance type, not constructor)
type AbortSignalType = AbortSignal;

// ============================================================================
// Re-export types from other components
// ============================================================================

// Tool 和 ToolResult 从 ToolComponent 复用
export { Tool, ToolResult };

// Forward declaration for ProjectSummary (avoid circular dependency)
export interface ProjectSummary {
  projectPath: string;
  projectName: string;
  lastUpdated: number;
  summary: string;
  shortSummary: string;
  draftCount: number;
  memoryMdPath: string;
  draftsDir: string;
  detailsDir: string;
}

// ============================================================================
// Agent Context
// ============================================================================

/**
 * Agent 执行上下文
 */
export interface AgentContext {
  /** 会话 ID */
  sessionId?: string;
  /** 消息 ID */
  messageId?: string;
  /** Trace ID（每次 query 唯一，用于 per-query 去重和追踪） */
  traceId?: string;
  /** 中断信号 */
  abort?: AbortSignalType;
  /** 额外的上下文信息（会添加到 system prompt） */
  additionInfo?: string;
  /** 元数据 */
  metadata?: Record<string, unknown>;
  /** Agent 类型（用于选择 Behavior Spec） */
  agentType?: string;
  /** 使用的模型 */
  model?: string;
  /**
   * Task #4623 — 兜底模型（`providerId/modelId`）。
   *
   * 主模型调用失败（404 / 429 / 配额耗尽 / 5xx / 超时 / 重试耗尽）时，
   * 本次 run 自动切换到该模型继续执行。优先级：
   *   CLI `--fallback-model` > AgentContext.fallbackModel > 配置 `llm.fallbackModel`
   *
   * 认证失败（401/403）、请求错误（400）、主动取消、上下文超限 **不** 触发降级。
   */
  fallbackModel?: string;
  /**
   * Task #4724 — 兜底模型**有序列表**（`providerId/modelId`）。
   *
   * 主模型调用失败（404 / 429 / 配额耗尽 / 5xx / 超时 / 重试耗尽）时，按数组
   * 顺序逐个尝试兜底模型，全部失败才抛原始错误。优先级：
   *   CLI `--fallback-model`（数组）> `AgentContext.fallbackModels`
   *   > CLI `--fallback-model`（单值）/ `AgentContext.fallbackModel`
   *   > 配置 `llm.fallbackModels`（数组）> 配置 `llm.fallbackModel`（旧单值）
   *
   * 认证失败（401/403）、请求错误（400）、主动取消、上下文超限 **不** 触发降级。
   */
  fallbackModels?: string[];
  /** 允许的工具列表（上下文级别，会覆盖 agent 配置） */
  allowedTools?: string[];
  /** 拒绝的工具列表（上下文级别，会覆盖 agent 配置） */
  deniedTools?: string[];
  /** 是否过滤 history 中的 tool 消息（上下文级别，会覆盖 agent 配置） */
  filterHistory?: boolean;

  /**
   * Task #2590 follow-up — caller-provided run id.
   *
   * If provided, the agent run uses this id instead of an internally generated
   * one (AgentComponent.runCounter). The caller is responsible for ensuring
   * the id is unique within the AgentComponent instance and stable for the
   * lifetime of the run. Run id is used to key `aborted` / `abortControllers`
   * maps inside AgentComponent, so callers wanting run-scoped abort
   * (e.g. BackgroundTaskManager.executeWithAbort) should pre-allocate an id
   * and pass it in. This eliminates the need for an onRunStarted callback
   * and lets the caller record (runId, taskRecord) BEFORE the run actually
   * starts.
   *
   * Validation:
   *   - Must not be empty / whitespace-only (AgentComponent._run rejects explicitly)
   *   - Must not already be in `aborted` / `abortControllers` Maps
   *
   * If not provided, AgentComponent allocates a new id from its internal
   * `runCounter` (preserves backward compatibility with existing callers).
   */
  runId?: string;

  /**
   * Issue #1694 Layer 1: override message history for this run.
   *
   * RESERVED FOR FUTURE USE: When provided (non-empty), AgentComponent._run()
   * will use this array INSTEAD of loading history from the session DB.
   *
   * Current callers (as of Task #1694 commit c6c10707):
   *   - workflow-json-output-plugin does NOT yet pass `messages`
   *   - json-extract sub-agent still reads session DB history
   *
   * Future use cases:
   *   - Caller wants to inject SANITIZED history (strip main agent pollution)
   *   - Caller wants to inject SYNTHETIC history (e.g., for testing)
   *   - Caller wants to share history across multiple sub-agent runs
   *
   * Behavior when set:
   *   - effectiveContext.messages.length > 0 → use as hookCtx.messages
   *   - effectiveContext.messages is undefined or empty → fallback to session DB
   *
   * Only ModelMessage[] is accepted (matches the format the LLM expects).
   * The first message, if any, MAY be a system message.
   */
  messages?: ModelMessage[];

  /**
   * Issue #1694 root-cause fix: Force LLM to call a specific tool (or any
   * tool) when this context is used.
   *
   * - `"required"` — force LLM to call at least one tool
   * - `{ type: "function", function: { name: "..." } }` — force a specific tool
   * - undefined / "auto" — let LLM choose (default)
   *
   * Primary use case: workflow-json-output-plugin forces json-extract
   * sub-agent to call `workflow_submit_output`, eliminating the
   * non-deterministic failure where sub-agent sees the parent's markdown
   * JSON output and decides "already done" (finishReason=stop, no tool call).
   *
   * Propagated by AgentComponent.invokeLLM to llmComponent.invoke, then to
   * AI SDK streamText's `toolChoice`.
   */
  toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };

  // ===== EventSource 扩展字段 =====
  
  /** 处理事件的 agent 名称（EventSource 指定） */
  agentName?: string;
  
  /** 启用的插件列表（EventSource 指定） */
  plugins?: string[];
  
  /** 关联的 EnvEvent（EventSource 事件） */
  envEvent?: import("../types").EnvEvent;
  
  /** Plugin 启用标记 { "sourceId:pluginName": true } */
  pluginEnabled?: Record<string, boolean>;
  
  /** 额外工具列表（上下文级别，会追加到可用工具列表末尾） */
  extraTools?: import("../tool/types").Tool[];

  /**
   * ★ Task #5333 — 放行的 channel-only 工具名单（会话渠道上下文）。
   *
   * 由事件源驱动的一轮对话注入（EventSourceConfig.extendTools →
   * evt.metadata.extendTools → agentContext.extendTools）。
   *
   * `tool.metadata.channelOnly === true` 的工具只有名字出现在这里时才可见；
   * 未标记 channelOnly 的工具完全不受影响。
   *
   * 典型：企微 ES 注入 `["wecom_respond"]`，于是处理企微事件的 agent
   * （可能是 default）能看到 wecom_respond；而同名 default agent
   * 在交互式 CLI / 飞书会话里看不到它。
   */
  extendTools?: string[];

  /** 是否将 ReAct 消息持久化到 session DB（默认 true）。
   *  设为 false 时，agent run 仍会读取 session history，但不会写入新消息。
   *  用于子 agent 复用父 session 的 history 但不污染 session DB。 */
  persistSession?: boolean;
}

/**
 * 工具调用（内部使用）
 */
export interface ToolCall {
  /** 调用 ID */
  id: string;

  /** 工具名称 */
  name: string;

  /** 调用参数 */
  arguments: Record<string, unknown>;
}

/**
 * 工具调用结果
 */
export interface ToolCallResult {
  /** 调用 ID */
  id: string;

  /** 工具名称 */
  name: string;

  /** 调用结果 */
  result: ToolResult;

  /** 是否成功 */
  success: boolean;
}

// ============================================================================
// Hook Types
// ============================================================================

/**
 * Hook 点枚举（带 component 前缀）
 */
export type HookPoint =
  | "agent:before.start"      // Agent 开始执行前
  | "agent:before.llm"        // 调用 LLM 前
  | "agent:after.llm"         // 调用 LLM 后
  | "agent:before.tool"        // 执行工具前
  | "agent:after.tool"         // 执行工具后
  | "agent:on.iteration"       // 每次迭代后
  | "agent:on.threshold"       // 达到阈值时
  | "agent:after.complete"     // 执行完成后
  | "agent:on.error"           // 发生错误时
  | "agent:after.react"        // React 循环结束后
  | "on.error";               // 简化写法（兼容）

/**
 * Context data for agent:after.react hook
 */
export interface AgentReactContext {
  /** Current messages for memory extraction */
  messages: ModelMessage[];
  /** Current session ID */
  sessionId?: string;
  /** Execution summary */
  summary?: string;
}

/**
 * Hook 上下文（Agent 特有版本）
 * 
 * 注意：这是 AgentComponent 使用的 HookContext 扩展版本
 * 包含 iteration, maxIterations, messages 等 Agent 特有字段
 */
export interface HookContext {
  
  // ===== Hook 点特定字段 =====

  /** 当前 LLM 输出（after.llm hook 可用） */
  llmOutput?: AgentLLMOutput;

  /** 当前工具调用（before.tool/after.tool hook 可用） */
  currentToolCall?: ToolCall;

  /** 工具执行结果（after.tool hook 可用） */
  toolResult?: ToolCallResult;

  /** 阈值信息（on.threshold hook 可用） */
  threshold?: {
    type: "tokens" | "turns" | "iterations" | "custom";
    value: number;
    limit?: number;
  };

  /** 当前错误（on.error hook 可用） */
  error?: Error;

  /** 当前 Agent 实例 */
  agent: AgentInstance;

  /** 当前迭代次数（可修改） */
  iteration: number;

  /** 最大迭代次数限制（before.llm hook 可用） */
  maxIterations: number;

  /** 消息列表（可直接修改） */
  messages: ModelMessage[];

  /** 可用工具列表（可直接修改） */
  tools: Tool[];

  /** 当前 system prompt（可直接修改） */
  systemPrompt: string;

  /** 额外的上下文信息（可直接修改） */
  additionInfo?: string;

  /**
   * Task #2744: session-scope cache snapshot (internal use)
   *
   * ★ Task #5224 — 快照改为**内存级**（`AgentComponent._cacheSnapshots`，
   *   key=sessionId），**不再持久化**到 session.metadata.cacheSnapshot。
   *   由 AgentComponent._run 在 first-run 创建并透传给 buildMessages。
   *   buildMessages 使用 snapshot 的 additionInfo（而非每轮重读
   *   ctx.context.additionInfo）以保证 system prompt 字节级一致 → LLM
   *   prompt cache 命中。
   *
   * - systemPrompt: 含 {{memory}} 替换后的最终字符串（**含构建时注入的渠道 prompt**）
   * - additionInfo: first-run 时的 additionInfo（冻结）
   * - snapshotAt: 构建时间戳
   *
   * ⚠️ 本字段**仅是运行时透传载体**：它的值只来自
   *   `_loadOrCreateCacheSnapshot` 的内存 Map，**既不从 session.metadata 读取，
   *   也不写入 session.metadata** —— 不要把它当成「可持久化到 session 行」的句柄。
   *
   * 第三方代码不应直接修改此字段。快照重建条件：进程重启（内存态全失）
   * 或换用新的 sessionId。
   */
  _cacheSnapshot?: {
    systemPrompt: string;
    additionInfo: string;
    snapshotAt: number;
  };

  /** 执行上下文（可直接修改属性） */
  context: AgentContext;

  // ===== 内部状态（Plugin 通常不需要修改） =====

  /**
   * Task #4623 — 本次 run 的唯一 ID（internal use）。
   *
   * 仅用于把「本次 run 已降级到 fallback model」的粘性状态 key 到 run 维度，
   * 避免跨 run 串味（上一轮额度耗尽不代表下一轮还失效）。
   */
  _runId?: string;

  /** 是否已停止 */
  _stopped?: boolean;

  /** 停止原因 */
  _stopReason?: string;

  /** 待执行的干预动作 */
  _pendingAction?: {
    type: HookActionType;
    payload?: unknown;
  };

  /** 错误列表 */
  _errors?: Array<{
    plugin: string;
    error: string;
  }>;

  /** Structured JSON extracted by workflow plugin after ReAct (agent:after.react) */
  structuredOutputExtracted?: Record<string, unknown>;

  // ===== Memory Agent 特定字段 =====

  /** Project Memory Agent 生成的摘要列表（由 Project Agent 写入，Global Agent 读取） */
  projectSummaries?: ProjectSummary[];
}

/**
 * Hook 干预动作
 */
export type HookActionType =
  | "stop"             // 停止执行
  | "retry"            // 重试当前迭代
  | "compress"         // 执行压缩
  | "extract_memory"   // 提取记忆
  | "inject_message"   // 注入消息
  | "skip_tool";      // 跳过当前工具调用

/**
 * Hook 返回结果
 */
export interface HookResult {
  /** 是否继续执行（false = 停止 Agent） */
  continue: boolean;

  /** 干预动作（可选） */
  action?: {
    type: HookActionType;
    payload?: unknown;
  };
}

/**
 * Plugin 定义
 */
export interface Plugin {
  /** Plugin 唯一名称 */
  name: string;

  /** Plugin 版本 */
  version: string;

  /** Plugin 描述 */
  description?: string;

  /** 订阅的 Hook 点及优先级 */
  hooks: Array<{
    point: HookPoint;
    /** 优先级，默认 0，数字越大越先执行 */
    priority?: number;
  }>;

  /** 执行函数 */
  execute: (ctx: HookContext) => HookResult | Promise<HookResult>;
}

// ============================================================================
// Agent Types
// ============================================================================

/**
 * Agent 类型
 */
export type AgentType = "primary" | "sub" | "summary";

/**
 * 【Task #4813】cacheSnapshot 记忆失效检测（B1 mtime 方案）：
 * 首拍时各 memory 文件的 mtime 快照。
 *
 * - globalMtime: global memory.md 的 mtime（ms）；文件不存在记 0
 * - projectMtime: project memory.md 的 mtime（ms）；文件不存在记 0
 *
 * ⚠️ 【Task #5224】**已停用**（保留类型仅为向后兼容，不破坏公开导出面）：
 * 快照改内存级后，失效检测（`_isMemorySnapshotStale`）被移除 —— session
 * 生命周期内快照冻结，新 session / 进程重启自然重建并拿到最新 memory。
 */
export interface MemorySnapshotStat {
  globalMtime: number;
  projectMtime: number;
}

/**
 * ★ Task #5224 — session-scope cache snapshot（内存级）。
 *
 * 构建一次、session 生命周期内冻结使用；不持久化到 sessions.db。
 *
 * - systemPrompt: 含 {{memory}} 替换后的最终字符串，
 *   **且含构建时注入的渠道 prompt**（唯一注入点）
 * - additionInfo: 构建时的 additionInfo（冻结 → 字节级一致 → prompt cache 命中）
 * - snapshotAt: 构建时间戳
 */
export interface CacheSnapshot {
  systemPrompt: string;
  additionInfo: string;
  snapshotAt: number;
}

/**
 * Agent 状态
 */
export type AgentStatus = "idle" | "running" | "paused" | "stopped" | "error";

/**
 * Agent 实例配置
 */
export interface AgentInstanceConfig {
  /** Agent 类型 */
  type: AgentType;

  /** Agent 名称 */
  name?: string;

  /** System Prompt */
  systemPrompt?: string;

  /** System Prompt 引用（指向 PromptComponent 中的 prompt） */
  systemPromptRef?: string;

  /** Behavior Spec ID */
  behaviorSpecId?: string;

  /** 使用的模型 */
  model?: string;

  /** 最大迭代次数 */
  maxIterations?: number;

  /** 最大错误重试次数 */
  maxErrorRetries?: number;

  /** 死循环检测阈值 */
  doomLoopThreshold?: number;

  /** 允许的工具列表 */
  allowedTools?: string[];

  /** 拒绝的工具列表 */
  deniedTools?: string[];

  /** 工具超时（毫秒） */
  toolTimeout?: number;

  /** 工具重试次数 */
  toolRetries?: number;

  /** 是否过滤 history 中的 tool 消息（默认过滤，避免上下文过长） */
  filterHistory?: boolean;
}

/**
 * Agent 实例
 */
export interface AgentInstance {
  /** Agent 名称 */
  name: string;

  /** Agent 配置 */
  config: Required<AgentInstanceConfig>;

  /** 当前状态 */
  status: AgentStatus;

  /** 注册的 Plugins */
  plugins: Map<string, Plugin>;
}

/**
 * Agent 执行结果
 */
export interface AgentRunResult {
  /** 最终文本响应 */
  finalText?: string;

  /** 是否被 hook 停止 */
  stopped?: boolean;

  /** 停止原因 */
  stopReason?: string;

  /** 执行的迭代次数 */
  iterations: number;

  /** 工具调用列表 */
  toolCalls: ToolCall[];

  /** 错误信息（如有） */
  error?: string;

  /** 原始错误对象（用于保留 ContextError 等类型信息） */
  originalError?: Error;

  /** Structured JSON output (populated by workflow plugin after ReAct) */
  structuredOutput?: Record<string, unknown>;
}

// ============================================================================
// LLM Types (from ../llm/types)
// ============================================================================

/**
 * LLM 调用结果
 * 
 * 复用 LLMComponent 的 LLMOutput，并扩展 Agent 特有字段
 */
export interface LLMCallResult {
  /** 成功 */
  success: boolean;

  /** 输出 */
  output?: LLMOutput;

  /** 错误信息 */
  error?: string;

  /** Usage 信息 */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Agent 内部使用的 LLM 输出
 * 独立定义以避免与 LLMOutput 的类型冲突
 */
export interface AgentLLMOutput {
  /** 生成的内容 */
  content: string;
  /** 完成原因 */
  finishReason: "stop" | "length" | "content-filter" | "tool-calls" | "function-call";
  /** 工具调用（兼容格式） */
  toolCalls?: Array<{
    id: string;
    function?: {
      name: string;
      arguments: string;
    };
    name?: string;
    arguments?: string;
  }>;
  /** Usage 信息 */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** 生成模型 */
  model?: string;
  /** 推理内容（思考过程） */
  reasoning?: string;
}

// ============================================================================
// Summary Agent Types (new)
// ============================================================================

/**
 * Summary Agent 配置
 * 
 * 专门用于生成 session checkpoint 的 Agent
 */
export interface SummaryAgentConfig extends AgentInstanceConfig {
  /** Agent 类型 */
  type: "summary";
  
  /** 使用的 prompt */
  promptName: "session/compact";
  
  /** 默认模型 */
  model?: string;
  
  /** 最大迭代次数（summary 任务只需 1 次） */
  maxIterations: 1;
}

/**
 * Summary Agent 运行选项
 */
export interface SummaryAgentRunOptions {
  /** 消息列表 */
  messages: Array<{
    role: string;
    content: string;
  }>;
  
  /** 用户提供的上下文/提示 */
  userContext?: string;
  
  /** 期望的输出格式 */
  outputFormat: "json";
  
  /** 
   * 场景化提示 (Scenario Hint)
   * 
   * 用于指导 checkpoint 生成的重点方向。
   * 当提供此参数时，会在系统提示中添加场景上下文，
   * 帮助 LLM 生成更符合当前场景的 checkpoint。
   */
  scenarioHint?: string;
}

// ============================================================================
// Compact Hint Generation Types (new)
// ============================================================================

/**
 * Compact Hint 生成选项
 * 
 * 用于两阶段自动压缩流程中的第一阶段：
 * 根据会话历史生成场景化的压缩提示
 */
export interface CompactHintGenerationOptions {
  /** 消息列表 */
  messages: Array<{
    role: string;
    content: string;
  }>;
  
  /** 
   * 会话上下文信息（可选）
   * 
   * 包含会话相关的额外信息，如：
   * - 当前活跃任务信息
   * - 工作目录
   * - 最近的操作记录等
   */
  sessionContext?: {
    activeTaskId?: string;
    activeTaskTitle?: string;
    workingDirectory?: string;
    recentActions?: string[];
  };
}

/**
 * Compact Hint 生成结果
 */
export interface CompactHintGenerationResult {
  /** 
   * 场景化压缩指导提示（自然语言）
   * 
   * 这是一段"压缩指导 Prompt"，用于告诉 Compact 阶段：
   * "在当前这个场景/目标/任务下，生成 checkpoint 时应该重点关注什么"
   * 
   * 示例：
   * "Feature development. User is implementing JWT authentication for auth-service.
   *  Focus on: auth flow decisions, token refresh progress, middleware implementation."
   */
  hint: string;
  
  /** 原始 LLM 响应 */
  rawResponse?: string;
}
