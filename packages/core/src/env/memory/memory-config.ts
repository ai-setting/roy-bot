/**
 * @fileoverview Memory Component Configuration
 * 
 * 定义 Memory 组件的默认配置
 */

import path from "path";
import os from "os";
import { type MemoryConfig } from "./types";

/**
 * 默认配置
 */
export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  memoryPaths: [
    // 全局路径 (~/.config/roy-bot/memory/)
    {
      type: "global",
      path: path.join(os.homedir(), ".config", "roy-bot", "memory"),
    },
    // 项目路径 (.roy/memory/)
    {
      type: "project",
      path: ".roy/memory",
    },
  ],
  recursive: true,
  cacheEnabled: true,
  cacheTTL: 5 * 60 * 1000, // 5 分钟
};

/**
 * 优先级映射（后面的优先级更高）
 */
export const SOURCE_PRIORITY: Record<string, number> = {
  "global": 0,
  "project": 1,
};

/**
 * 获取来源优先级
 */
export function getSourcePriority(source: string): number {
  return SOURCE_PRIORITY[source] ?? 0;
}
