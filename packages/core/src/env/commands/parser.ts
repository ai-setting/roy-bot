/**
 * @fileoverview Command Meta.md Parser
 * 
 * 解析命令目录下的 meta.md 文件，提取 Frontmatter 元信息
 */

import fs from "fs/promises";
import path from "path";
import { createLogger } from "../log-trace/logger";
import type { CommandMeta, CommandSource } from "./types";

const logger = createLogger("commands-parser");

/**
 * 解析 frontmatter 文本
 */
export function parseFrontmatter(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = text.split("\n");

  for (const line of lines) {
    // 匹配 key: value 格式
    const match = line.match(/^(\w+):\s*"?(.+?)"?\s*$/);
    if (match) {
      const key = match[1];
      let value = match[2];
      // 移除首尾引号
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
  }

  return result;
}

/**
 * 解析单个 meta.md 文件
 */
export async function parseMetaFile(
  filePath: string,
  source: CommandSource
): Promise<CommandMeta | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");

    // 匹配 frontmatter: --- ... ---
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
    if (!frontmatterMatch) {
      logger.warn(`[Parser] Missing frontmatter in: ${filePath}`);
      return null;
    }

    const frontmatter = parseFrontmatter(frontmatterMatch[1]);
    const name = frontmatter.name;
    const description = frontmatter.description;

    if (!name) {
      logger.warn(`[Parser] Missing name in frontmatter: ${filePath}`);
      return null;
    }

    if (!description) {
      logger.warn(`[Parser] Missing description in frontmatter: ${filePath}`);
      return null;
    }

    return {
      name,
      description,
      tips: frontmatter.tips,
      filePath,
      source,
    };
  } catch (error) {
    logger.error(`[Parser] Failed to parse file: ${filePath}`, error);
    return null;
  }
}

/**
 * 扫描目录下的所有 meta.md 文件
 */
export async function scanMetaFiles(
  dirPath: string,
  source: CommandSource
): Promise<CommandMeta[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const metaList: CommandMeta[] = [];

    for (const entry of entries) {
      // 跳过隐藏文件和目录
      if (entry.name.startsWith(".")) continue;
      
      if (entry.isFile() && entry.name === "meta.md") {
        const metaFilePath = path.join(dirPath, entry.name);
        const meta = await parseMetaFile(metaFilePath, source);
        if (meta) {
          metaList.push(meta);
        }
      }
    }

    return metaList;
  } catch (error) {
    // 目录不存在时返回空数组
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    logger.error(`[Parser] Failed to scan directory: ${dirPath}`, error);
    return [];
  }
}
