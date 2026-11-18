/**
 * @fileoverview Hook 系统统一导出
 * 
 * 注意：HookContext 泛型版本从 ./types 导出
 * Agent 特有的 HookContext 包含 iteration, maxIterations 等字段，在 ./agent/types.ts 中
 */

export {
  type HookPhase,
  type HookMeta,
  type HookContext,
  type Hook,
  type HookFn,
  type HookActionType,
  type HookAction,
  type HookResult,
  // 导出别名供内部使用
  type HookContext as BaseHookContext,
  type Hook as BaseHook,
  type HookFn as BaseHookFn,
  createHook,
  createPriorityHook,
} from "./types";

// HookManager
export { HookManager, type HookManagerOptions } from "./hook-manager";

// GlobalHookManager
export {
  globalHookManager,
  AgentHookPoints,
  LLMHookPoints,
  ToolHookPoints,
  executeAgentHook,
  executeAgentHookWithIntervention,
  executeLLMHook,
  executeToolHook,
} from "./global-hook-manager";
