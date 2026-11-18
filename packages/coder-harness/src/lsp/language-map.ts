/**
 * @fileoverview 语言到 LSP 服务器的映射
 * 
 * 定义文件扩展名到语言 ID 和 LSP 服务器的映射关系
 */

import path from "path";

/**
 * 文件扩展名到语言 ID 的映射
 */
export const LANGUAGE_EXTENSIONS: Record<string, string> = {
  // TypeScript/JavaScript
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".mts": "typescript",
  ".cts": "typescript",
  // Python
  ".py": "python",
  // Vue
  ".vue": "vue",
  // CSS
  ".css": "css",
  ".scss": "scss",
  ".sass": "sass",
  ".less": "less",
  // HTML
  ".html": "html",
  ".htm": "html",
  // JSON
  ".json": "json",
  ".jsonc": "jsonc",
  // Markdown
  ".md": "markdown",
  ".markdown": "markdown",
};

/**
 * 文件扩展名到 LSP 服务器 ID 的映射
 */
export const SERVER_BY_EXTENSION: Record<string, string> = {
  // TypeScript/JavaScript
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "typescript",
  ".jsx": "typescript",
  ".mjs": "typescript",
  ".cjs": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  // Python
  ".py": "python",
  // Vue
  ".vue": "vue",
  // CSS
  ".css": "css",
  ".scss": "css",
  ".sass": "css",
  ".less": "css",
  // HTML
  ".html": "html",
  ".htm": "html",
  // JSON
  ".json": "json",
  ".jsonc": "json",
  // Markdown
  ".md": "markdown",
  ".markdown": "markdown",
};

/**
 * 根据文件路径获取对应的 LSP 服务器 ID
 * 
 * @param filePath 文件路径
 * @returns 服务器 ID，如果不支持则返回 null
 */
export function getServerId(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return SERVER_BY_EXTENSION[ext] ?? null;
}

/**
 * 根据文件路径获取语言 ID
 * 
 * @param filePath 文件路径
 * @returns 语言 ID
 */
export function getLanguageId(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return LANGUAGE_EXTENSIONS[ext] ?? "plaintext";
}

/**
 * 检查文件是否被支持
 * 
 * @param filePath 文件路径
 * @returns 是否支持
 */
export function isSupported(filePath: string): boolean {
  return getServerId(filePath) !== null;
}

/**
 * 根据语言 ID 获取所有支持的文件扩展名
 * 
 * @param serverId LSP 服务器 ID
 * @returns 文件扩展名数组
 */
export function getExtensionsByServer(serverId: string): string[] {
  return Object.entries(SERVER_BY_EXTENSION)
    .filter(([, id]) => id === serverId)
    .map(([ext]) => ext);
}
