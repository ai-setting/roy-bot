/**
 * @fileoverview Environment Module
 * 
 * 导出 Environment 相关的类型和实现。
 */

// Environment 接口
export type { Environment } from "./interface";

// Environment 类型
export type {
  EnvironmentConfig,
  BaseEnvironmentConfig,
  EnvEvent,
  EnvEventMetadata,
  EnvEventHandler,
  Action,
  ToolResult,
  Context,
} from "./types";

// BaseEnvironment 实现
export { BaseEnvironment } from "./environment";

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
} from "./component";

// Hook 系统
export {
  type Hook,
  type HookContext,
  type HookPhase,
  type HookMeta,
  type HookFn,
  type HookManagerOptions,
  createHook,
  createPriorityHook,
  HookManager,
} from "./hook";

// EnvContext 系统
export {
  type EnvContext,
  getEnvContext,
  getEnvContextOrEmpty,
  hasEnvContext,
  runWithEnvContext,
  runWithEnvContextAsync,
  createEnvContext,
  mergeEnvContext,
} from "./context";

// Paths
export {
  type XDGPaths,
  type XDGDirType,
  XDG_PATHS,
  getXDGPaths,
  getXDGPath,
} from "./paths";

// Agent Component
export {
  AgentComponent,
  type AgentComponentConfig,
  AgentComponentConfigSchema,
  type AgentInstance,
  type AgentInstanceConfig,
  type AgentRunResult,
  type AgentContext,
  type Plugin,
  type HookContext as AgentHookContext,
  type HookPoint,
  type HookResult,
  type HookActionType,
  type Tool,
  type ToolCall,
  type ToolResult as AgentToolResult,
  type ToolCallResult,
  type LLMOutput,
} from "./agent";

// Task Component
export {
  TaskComponent,
  type TaskComponentOptions,
} from "./task";
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
} from "./task/types";

// MCP Component
export {
  McpComponent,
} from "./mcp";
export type {
  McpComponentConfig,
  McpComponentOptions,
  McpPath,
  McpServerConfig,
  McpServerStatus,
  DiscoveredMcpServer,
} from "./mcp";

// EventSource Component
export {
  EventSourceComponent,
  larkCliHandler,
  builtInHandlers,
} from "./event-source/event-source-component";
export type {
  EventSourceConfig,
  EventSourceStatus,
  EventSourceType,
  EventSourceEvent,
  EventSourceEventPayload,
  EventSourceEventHandler,
  EventSourceStatusChangeEvent,
  EventSourcePersistenceConfig,
  EventSourceComponentInterface,
  EventSourceHandler,
  EventSourceInstance,
  EventSourceAgentHandlerConfig,
  NotifyChannelInfo,
  RuleNoticeInfo,
  BUILT_IN_EVENT_SOURCE_TYPES,
} from "./event-source/types";
export {
  EventSourceInitHooks,
  isValidEventSourceType,
  isBuiltInEventSourceType,
  getDefaultConfigForType,
  validateEventSourceConfig,
} from "./event-source/types";

// Workflow Component
export {
  WorkflowComponent,
} from "./workflow/workflow-component";
export type {
  WorkflowComponentConfig,
} from "./workflow/workflow-component";

// Plugin Component
export {
  PluginComponent,
} from "./plugin/plugin-component";
export type {
  PluginComponentOptions,
} from "./plugin/plugin-component";
