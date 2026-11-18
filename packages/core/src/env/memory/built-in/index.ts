/**
 * @fileoverview Memory Built-in Tools Index
 * 
 * 简化的记忆工具导出
 * 
 * 只暴露两个工具：
 * - record_memory: 统一的记忆写入工具
 * - recall_memory: 统一的记忆读取工具
 */

import type { Tool } from "../../tool/types";
import type { MemoryPath, RecordMemoryResult } from "../types";
import { createRecordMemoryTool, RecordMemorySchema } from "./record-memory";
import { createRecallMemoryTool, RecallMemorySchema } from "./recall-memory";

/**
 * record_memory 工具操作接口
 */
export interface RecordMemoryOperations {
  (args: {
    scope: "project" | "global";
    mode: "append" | "prepend" | "overwrite" | "delete";
    content?: string;
    title?: string;
  }): Promise<RecordMemoryResult | null>;
}

/**
 * recall_memory 工具操作接口
 */
export interface RecallMemoryOperations {
  (scope?: "project" | "global"): Promise<string>;
}

/**
 * MemoryToolConfig
 */
export interface MemoryToolConfig {
  getMemoryPaths: () => MemoryPath[];
  getMemoryFile: () => string;
}

/**
 * 创建所有记忆工具
 */
export function createMemoryTools(
  recordMemory: RecordMemoryOperations,
  recallMemory: RecallMemoryOperations,
  config: MemoryToolConfig
): Tool[] {
  return [
    createRecordMemoryTool(recordMemory, config.getMemoryPaths, config.getMemoryFile),
    createRecallMemoryTool(recallMemory, config.getMemoryPaths, config.getMemoryFile),
  ];
}

// Re-export schemas for external use
export { RecordMemorySchema, type RecordMemoryParams } from "./record-memory";
export { RecallMemorySchema, type RecallMemoryParams } from "./recall-memory";
