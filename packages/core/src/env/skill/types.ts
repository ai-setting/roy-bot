import { z } from "zod";

/**
 * Skill 来源类型
 */
export type SkillSource = "built-in" | "user" | "project";

/**
 * Skill 条目
 */
export interface SkillEntry {
  /** Skill 名称（唯一标识） */
  name: string;
  /** Skill 描述 */
  description: string;
  /** SKILL.md 文件路径 */
  filePath: string;
  /** 完整 markdown 内容 */
  content: string;
  /** 来源类型 */
  source: SkillSource;
  /** 加载时间戳 */
  loadedAt: number;
}

/**
 * Skill 列表项（用于 list 和 description）
 */
export interface SkillListItem {
  name: string;
  description: string;
  source: SkillSource;
}

/**
 * Skill 路径配置
 */
export interface SkillPath {
  /** 来源类型 */
  type: SkillSource;
  /** 绝对路径 */
  path: string;
}

/**
 * SkillComponent 配置
 */
export interface SkillConfig {
  /** 多路径配置 */
  skillPaths: SkillPath[];
  /** 是否递归扫描子目录 */
  recursive: boolean;
  /** 是否启用缓存 */
  cacheEnabled: boolean;
}

/**
 * SkillTool 参数 Schema
 */
export const SkillToolSchema = z.object({
  skill: z.string().describe("Skill name to load"),
});

export type SkillToolParams = z.infer<typeof SkillToolSchema>;
