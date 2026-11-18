import fs from "fs/promises";
import { createLogger } from "../log-trace/logger";
import type { SkillEntry, SkillSource } from "./types";

const logger = createLogger("skill-parser");

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
 * 解析 SKILL.md 文件
 */
export async function parseSkillFile(
  filePath: string,
  source: SkillSource
): Promise<SkillEntry | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");

    // 匹配 frontmatter: --- ... ---
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
    if (!frontmatterMatch) {
      logger.warn(`[SkillParser] Missing frontmatter in: ${filePath}`);
      return null;
    }

    const frontmatter = parseFrontmatter(frontmatterMatch[1]);
    const name = frontmatter.name;
    const description = frontmatter.description;

    if (!name) {
      logger.warn(`[SkillParser] Missing name in frontmatter: ${filePath}`);
      return null;
    }

    if (!description) {
      logger.warn(`[SkillParser] Missing description in frontmatter: ${filePath}`);
      return null;
    }

    // 移除 frontmatter 获取实际内容
    const actualContent = content.replace(/^---\n[\s\S]*?\n---\n?/, "");

    return {
      name,
      description,
      filePath,
      content: actualContent,
      source,
      loadedAt: Date.now(),
    };
  } catch (error) {
    logger.error(`[SkillParser] Failed to parse file: ${filePath}`, error);
    return null;
  }
}
