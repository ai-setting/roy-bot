// packages/core/src/env/memory/types.ts

import { z } from "zod";

// ==================== 基础类型 ====================

/**
 * Memory 来源类型
 * - project: 项目级记忆
 * - global: 全局记忆
 */
export type MemorySource = "project" | "global";

/**
 * Memory 路径配置
 */
export interface MemoryPath {
  /** 来源类型 */
  type: MemorySource;
  /** 绝对路径 */
  path: string;
}

/**
 * MemoryComponent 配置
 */
export interface MemoryConfig {
  /** 多路径配置 */
  memoryPaths: MemoryPath[];
  /** 是否递归扫描子目录 */
  recursive: boolean;
  /** 是否启用缓存 */
  cacheEnabled: boolean;
  /** 缓存有效期（毫秒） */
  cacheTTL?: number;
  /** 记忆文件名 */
  memoryFile?: string;
}

/**
 * record_memory 操作模式
 */
export type RecordMemoryMode = "append" | "prepend" | "overwrite" | "delete";

/**
 * record_memory 操作结果
 */
export interface RecordMemoryResult {
  /** 文件路径 */
  path: string;
  /** 操作类型 */
  action: "created" | "append" | "prepend" | "overwrite" | "delete";
}

// ==================== Tool 参数 Schema ====================

/**
 * record_memory 工具参数
 */
export const RecordMemorySchema = z.object({
  /** 作用域 (必填) */
  scope: z.enum(["project", "global"]).describe("作用域: project/global"),
  
  /** 操作模式 */
  mode: z.enum(["append", "prepend", "overwrite", "delete"])
    .describe("模式: append(追加)/prepend(插入)/overwrite(覆盖)/delete(删除)"),
  
  /** 记忆内容 (delete 模式不需要) */
  content: z.string().optional().describe("记忆内容"),
  
  /** 章节标题 (可选，用于生成 ## title 章节) */
  title: z.string().optional().describe("章节标题"),
});

export type RecordMemoryParams = z.infer<typeof RecordMemorySchema>;

/**
 * recall_memory 工具参数
 */
export const RecallMemorySchema = z.object({
  /** 作用域 (可选，不传则读取所有 scope) */
  scope: z.enum(["project", "global"]).optional().describe("作用域（可选，不传则读取所有）"),
});

export type RecallMemoryParams = z.infer<typeof RecallMemorySchema>;
