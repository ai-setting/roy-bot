/**
 * @fileoverview Memory Component Index
 * 
 * 导出 Memory 组件及相关类型
 */

// Types - only export from one place to avoid duplicates
export * from "./types";

// Config
export { DEFAULT_MEMORY_CONFIG, SOURCE_PRIORITY, getSourcePriority } from "./memory-config";

// Component
export { MemoryComponent, type MemoryComponentOptions } from "./memory-component";

// Built-in Tools - export only schemas to avoid type conflicts
export { RecordMemorySchema, RecallMemorySchema } from "./built-in";

// Memory Plugin (for --plugin memory)
export * from "./plugin";
