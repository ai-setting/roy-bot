import path from "path";
import os from "os";
import { type SkillConfig } from "./types";

/**
 * 默认配置
 */
export const DEFAULT_SKILL_CONFIG: SkillConfig = {
  skillPaths: [
    // 用户路径 (~/.config/roy-bot/skills/)
    {
      type: "user",
      path: path.join(os.homedir(), ".config", "roy-bot", "skills"),
    },
    // 项目路径 (.roy/skills/)
    {
      type: "project",
      path: ".roy/skills",
    },
  ],
  recursive: true,
  cacheEnabled: true,
};

/**
 * 优先级映射（后面的优先级更高）
 */
export const SOURCE_PRIORITY: Record<string, number> = {
  "built-in": 0,
  "user": 1,
  "project": 2,
};

/**
 * 获取来源优先级
 */
export function getSourcePriority(source: string): number {
  return SOURCE_PRIORITY[source] ?? 0;
}
