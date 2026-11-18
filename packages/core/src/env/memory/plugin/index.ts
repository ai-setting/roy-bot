/**
 * @fileoverview Memory Plugin Index - Simplified
 * 
 * 简化后的导出 - 只保留核心组件
 * 
 * 移除的组件（已被简化设计替代）：
 * - DraftManager -> 使用 write_memory tool
 * - MemoryOrganizer -> 使用 recall --extract 命令
 * - AccessLog -> 不再需要
 */

// Types - 只导出必要类型
export type {
  MemoryPluginConfig,
  MemoryTask,
  MemoryTaskType,
  ExtractMemoryPayload,
  SessionMessage,
  MemoryHookContext,
} from "./types";

// Core Components - 只保留核心组件
export { MemoryManager } from "./memory-manager";
export { MemoryPlugin, createMemoryPlugin } from "./memory-plugin";

// Re-export for compatibility
export { recallMemory } from "./recall-memory";

// Memory Agent exports
export type {
  MemoryScope,
  ProjectSummary,
  MemoryAgentInput,
  MemoryAgentResult,
  MemoryAgentConfig,
} from "./memory-agent";
export {
  createMemoryAgent,
  formatMemoryInput,
  parseMemoryAgentOutput,
  createEmptyResult,
  buildProjectInput,
  buildGlobalInput,
  applyMemoryResult,
  generateProjectSummary,
  PROJECT_MEMORY_AGENT_PROMPT,
  GLOBAL_MEMORY_AGENT_PROMPT,
} from "./memory-agent";
