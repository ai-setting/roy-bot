/**
 * @roy-bot/core - Core SDK
 */

// Utils
export { generateId, generateDescendingId } from "./utils/id";
export {
  ATTACH_FILE_MAX_BYTES,
  sniffMimeType,
  isMediaType,
  parseImageInput,
} from "./utils/media";

// Environment
export {
  type Environment,
  BaseEnvironment,
} from "./env";

export type {
  EnvironmentConfig,
  BaseEnvironmentConfig,
  EnvEvent,
  EnvEventMetadata,
  EnvEventHandler,
  Action,
  Context,
} from "./env";

// Component
export {
  type Component,
  type ComponentConfig,
  type ComponentSchema,
  type ComponentPaths,
  type ComponentStatus,
  type ComponentConfigChangeEvent,
  type ComponentWatchCallback,
  BaseComponent,
} from "./env/component";

// Hook System
export {
  globalHookManager,
  type HookPhase,
  type HookMeta,
  type BaseHookContext,  // 通用 HookContext
  type BaseHook,  // 通用 Hook
  type BaseHookFn,  // 通用 HookFn
  type HookManagerOptions,
  type HookAction,
  type HookResult,
  type HookActionType,
  createHook,
  createPriorityHook,
  HookManager,
} from "./env/hook";

// Paths
export {
  type XDGPaths,
  type XDGDirType,
  XDG_PATHS,
  getXDGPaths,
  getXDGPath,
} from "./env/paths";

// ConfigComponent
export {
  type ConfigSource,
  type ConfigSourceType,
  type ConfigChangeEvent,
  type ComponentRegistration,
  ConfigComponent,
} from "./config/config-component";

// LLM Component
export {
  LLMComponent,
  type LLMComponentOptions,
  type ContentPart,
  type LLMMessage,
  type LLMOutput,
  type UsageInfo,
  type ToolCall,
  type LLMConfig,
  type LLMProvider,
  type ProviderConfig,
  type ProviderType,
  type LLMInvokeRequest,
  type LLMInvokeResult,
  type StreamEvent,
  invoke,
  invokeNonStream,
  parseModelString,
  createInvokeConfig,
  type InvokeConfig,
  type InvokeOptions,
  type LLMToolContext,
  type ConvertedUsageInfo,
  LLMConfigSchema,
  ProviderConfigSchema,
  ProviderCapabilitiesSchema,
  ModelLimitsSchema,
  LLMDefaultConfigSchema,
  isOpencodeProvider,
  isOpencodeEndpoint,
  buildOpencodeHeaders,
} from "./env/llm";

// Tool Component
export {
  ToolComponent,
  type ToolComponentConfig,
  type Tool,
  type ToolInfo,
  type ToolResult,
  type ToolResultMetadata,
  type ToolMetadata,
  type SandboxConfig,
  type ValidationResult,
  ToolRegistry,
  ToolValidator,
  getAllBuiltInTools,
  getBuiltInTool,
  bashTool,
  globTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  grepTool,
  understandImageTool,
  setUnderstandImageLLMProvider,
  getUnderstandImageLLMProvider,
  resetUnderstandImageLLMProvider,
  type UnderstandImageLLMProvider,
} from "./env/tool";

// Re-export ToolContext from tool (it's defined in tool/types.ts)
export type { ToolContext } from "./env/tool/types";
export type { ToolHookContext } from "./env/tool/tool-component";

// Agent Component
export {
  AgentComponent,
  type AgentComponentConfig,
  type AgentContext,
  AgentComponentConfigSchema,
  type Plugin,
  type HookPoint,
  type HookContext,  // Agent 特有的 HookContext
} from "./env/agent";

// Agent Registry
export {
  AgentRegistry,
  type AgentDefinition,
  type AgentType,
  type AgentConfig,
  type ExportOptions,
} from "./env/agent/agent-registry";

// Log & Trace Component
export {
  LogTraceComponent,
  type LogTraceConfig,
  type LogTraceComponentOptions,
  LogTraceConfigSchema,
  Traced,
  TracedAs,
  TracedLightweight,
  wrapFunction,
  type TracedOptions,
  createLogger,
  getLogDir,
  setLogDirOverride,
  setQuietMode,
  isQuietMode,
  getLogLevels,
  getLogLevel,
  setLoggerConfigComponent,
  SQLiteSpanStorage,
  type SpanContext,
  type SpanAttributes,
  type Span,
  type TraceInfo,
  type SpanStorage,
  type LogLevel,
  type LoggerConfig,
  type ILogger,
  SpanKind,
  SpanStatus,
  // OpenTelemetry Tracer Provider
  OTelTracerProvider,
  getTracerProvider,
  resetTracerProvider,
  type OTelTracer,
  type OTelSpan,
  type SpanOptions,
  // OpenTelemetry Propagation
  propagation,
  // Trace 参数瘦身过滤器（Task #4479）
  // 从包根导出，方便其他包直接复用同一套「摘要 filter」+ ROY_TRACE_FULL 全量开关。
  isTraceFullMode,
  resetTraceFullModeCache,
  llmInvokeParamFilter,
  llmInvokeResultFilter,
  messagesParamFilter,
  toolExecParamFilter,
  toolInvokeParamFilter,
  toolExecResultFilter,
  embedParamFilter,
  embedResultFilter,
  envQueryParamFilter,
  agentRunParamFilter,
  recordSessionMessagesParamFilter,
  // Task #5117 (M1): stdout 归协议、stderr 归诊断（run headless 用）
  setStdoutStrictMode,
} from "./env/log-trace";

// Debug Component
export {
  DebugComponent,
  TraceFormatter,
  TreeFormatter,
  ReplFormatter,
  type TraceDataSource,
  type TraceParserOptions,
} from "./env/debug";
export type {
  TraceEntry,
  TraceTreeNode,
  ParserOptions,
  LogDiscoveryOptions,
  TraceIdInfo,
  TraceSummary,
  TraceAction,
  LogLevel as DebugLogLevel,
  FormatOptions,
} from "./env/debug";

// Prompt Component
export {
  PromptComponent,
  type PromptComponentOptions,
} from "./env/prompt/prompt-component";
export { PromptStore } from "./env/prompt/prompt-store";
export { closeDatabase } from "./env/workflow/storage/sqlite";

// Prompt types
export type {
  PromptConfig,
  PromptPath,
  PromptEntry,
  PromptSource,
  PromptHook,
  RenderHookContext,
  PromptHookMap,
} from "./env/prompt/types";

// Session Component
export {
  SessionComponent,
  MemorySessionStore,
} from "./env/session";

// Session types
export type {
  Session,
  SessionMessage,
  SessionConfig,
  CreateSessionOptions,
  UpdateSessionOptions,
  ListSessionsOptions,
  AddMessageOptions,
  SessionCheckpoint,
  CompactOptions,
  CompactResult,
  CompactPreview,
  CheckpointAdaptReport,
  GetContextOptions,
  GetContextResult,
  CheckpointType,
  SearchMessagesOptions,
  MessageMatch,
  SearchResult,
} from "./env/session/types";

// Task #2245 — ESC cascade stop orchestrator (single entry: cascadeStopSessionTree)
export {
  cascadeStopSessionTree,
  type CascadeStopOptions,
  type CascadeStopResult,
} from "./env/session-tree-stopper";

// Memory Component - re-export from plugin for backwards compatibility
// Note: MemoryComponent is exported from ./env/memory/plugin
// Additional exports for memory-agent-tools and prompts
export {
  createMemoryAgentTools,
} from "./env/memory/tools/memory-agent-tools";

// Memory Agent Tools types
export type {
  SearchSessionsParams,
  GetSessionParams,
  WriteMemoryParams,
} from "./env/memory/tools/memory-agent-tools";

// Prompt utilities
export {
  getBuiltInPrompt,
  getBuiltInPromptNames,
} from "./env/prompt/prompts-index";

// Task Component
export {
  TaskComponent,
  SQLiteTaskStore,
  // Task #5440 — remote 存储（roy-bot 接入常驻 task-service）
  RemoteTaskStore,
  createRemoteTaskStore,
  getDefaultTaskDbPath,
  // ★ Task #5063 — 终态 current_status 措辞同源锚点（CLI 侧引用用）
  TASK_COMPLETED_STATUS_WORD,
  TASK_CANCELLED_STATUS_WORD,
  TASK_ARCHIVED_STATUS_WORD,
  TASK_DELIVERABLE_RECORDED,
} from "./env/task";
export type {
  Task,
  TaskOperation,
  TaskStatus,
  TaskPriority,
  ActionType,
  CreateTaskOptions,
  UpdateTaskOptions,
  ListTasksOptions,
  CreateOperationOptions,
  ListOperationsOptions,
  TaskConfig,
} from "./env/task/types";

// Task Plugins
export {
  TaskTagPlugin,

  createAutoTaskPlugin,
  type AutoTaskPluginConfig,
} from "./env/task/plugins";
export {
  TaskHookPoints,
  type TaskHookPoint,
} from "./env/task/hooks";

// Task Discipline (Task #4889 — 单一真相源，runtime 无关)
export {
  TASK_DISCIPLINE_PROMPT,
  TASK_DISCIPLINE_LIFECYCLE,
  TASK_DISCIPLINE_OPERATION,
  TASK_DISCIPLINE_GOALS,
  TASK_DISCIPLINE_COMPLETE,
} from "./env/task/prompt";

// Skill Component
export {
  SkillComponent,
} from "./env/skill";
export type {
  SkillEntry,
  SkillListItem,
  SkillConfig,
  SkillPath,
  SkillSource,
  SkillToolParams,
} from "./env/skill/types";

// Mcp Component
export {
  McpComponent,
} from "./env/mcp";
export type {
  McpComponentConfig,
  McpComponentOptions,
  McpPath,
  McpServerConfig,
  McpServerLocalConfig,
  McpServerRemoteConfig,
  McpServerStatus,
  DiscoveredMcpServer,
} from "./env/mcp";

// Memory Component
export {
  MemoryComponent,
} from "./env/memory";
export type {
  MemoryConfig,
  MemoryPath,
  MemorySource,
  RecordMemoryParams,
  RecallMemoryParams,
  RecordMemoryMode,
  RecordMemoryResult,
} from "./env/memory/types";
export type { MemoryComponentOptions } from "./env/memory";

// Memory Plugin (for --plugin memory) - Simplified
export {
  MemoryPlugin,
  createMemoryPlugin,
} from "./env/memory/plugin";
export type {
  MemoryPluginConfig,
} from "./env/memory/plugin/types";

// Commands Component
export {
  CommandsComponent,
} from "./env/commands";
export type {
  CommandsComponentConfig,
  CommandIndex,
  ScanResult,
  ExecutionResult,
  DiscoverOptions,
  AddCommandOptions,
  RemoveCommandOptions,
  CommandSource,
  CommandsComponentOptions,
} from "./env/commands";

// EventSource Component
export * from "./env/event-source";

// Error types
export {
  ErrorCodes,
  RoyError,
  AgentError,
  ToolError,
  LLMError,
  ComponentError,
  ContextError,
  isRoyError,
  getErrorCode,
} from "./env/errors";

export type { ErrorCode } from "./env/errors";

// Workflow Component
export {
  WorkflowComponent,
  type WorkflowComponentConfig,
} from "./env/workflow/workflow-component";

// Workflow HIL types
export {
  AskUserError,
  type NodeInterruptEvent,
  type WorkflowAskUserEvent,
} from "./env/workflow/types/workflow-hil";

// Workflow Decorators
export {
  Workflow,
  WorkflowEdges,
  NodeAs,
  Edge,
} from "./env/workflow/decorators";
export type {
  WorkflowOptions,
  NodeAsOptions,
  EdgeMetadata,
} from "./env/workflow/types/decorators-types";
export {
  createWorkflowFromClass,
} from "./env/workflow/utils/create-workflow";
export {
  registerDecoratorNodeType,
} from "./env/workflow/utils/node-registry-helper";

// ========================================================================
// Plugin Component (Unified Plugin System)
// ========================================================================

export {
  PluginComponent,
  type PluginComponentOptions,
} from "./env/plugin/plugin-component";
export {
  BasePlugin,
  type PluginEnv,
  type HookDefinition,
  type HookHandler,
  type AgentInstanceConfig,
  type ToolDefinition,
  type HookResult as PluginHookResult,
  type HookContext as PluginHookContext,
} from "./env/plugin/types";
