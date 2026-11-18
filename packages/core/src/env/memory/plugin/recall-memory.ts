/**
 * @fileoverview Recall Memory - Simplified
 * 
 * 简化设计：
 * - 移除 AccessLog（访问日志已废弃）
 * - 只读取 memory.md 文件
 */

import fs from "fs/promises";
import path from "path";
import type { MemoryPath } from "../types";

/**
 * 读取记忆文件
 * 
 * @param memoryPaths - 记忆路径列表
 * @returns 记忆内容
 */
export async function recallMemory(
  memoryPaths: MemoryPath[]
): Promise<string> {
  const results: string[] = [];

  for (const memoryPath of memoryPaths) {
    const scope = memoryPath.type; // "global" | "project"
    const baseDir = memoryPath.path;

    try {
      // 读取 memory.md
      const memoryFile = path.join(baseDir, "memory.md");
      try {
        const content = await fs.readFile(memoryFile, "utf-8");
        if (content.trim()) {
          results.push(`## [${scope}] memory.md\n${content}`);
        }
      } catch {
        // 文件不存在，跳过
      }
    } catch (error) {
      // 整个 scope 处理失败，跳过
      console.error(`Error processing memory path ${baseDir}:`, error);
    }
  }

  if (results.length === 0) {
    return "(No memory files found)";
  }

  return results.join("\n\n");
}

// Re-export types for convenience
export type { MemoryPath } from "../types";
