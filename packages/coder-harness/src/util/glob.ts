/**
 * @fileoverview Glob 模式匹配工具
 *
 * 提供统一的 glob 匹配功能，用于文件过滤和忽略模式检查
 */

import { minimatch } from "minimatch";

/**
 * 检查文件路径是否匹配 glob 模式
 *
 * @param filePath 文件路径
 * @param pattern glob 模式
 * @returns 是否匹配
 */
export function matchGlob(filePath: string, pattern: string): boolean {
  // 使用 matchBase 选项让 *.ext 匹配任意路径下的文件
  return minimatch(filePath, pattern, { dot: true, matchBase: true });
}

/**
 * 检查文件路径是否应该被忽略
 *
 * @param filePath 文件路径
 * @param ignorePatterns 忽略模式列表
 * @returns 是否应该忽略
 */
export function shouldIgnore(filePath: string, ignorePatterns: string[]): boolean {
  if (ignorePatterns.length === 0) {
    return false;
  }
  return ignorePatterns.some((pattern) => matchGlob(filePath, pattern));
}
