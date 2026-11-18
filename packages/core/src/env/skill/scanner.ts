import fs from "fs/promises";
import path from "path";
import { glob } from "glob";
import { createLogger } from "../log-trace/logger";
import { parseSkillFile } from "./parser";
import { getSourcePriority } from "./config";
import type { SkillConfig, SkillEntry, SkillPath, SkillSource } from "./types";

const logger = createLogger("skill-scanner");

/**
 * 展开路径（支持 ~ 展开）
 */
function expandPath(inputPath: string): string {
  if (inputPath.startsWith("~/")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    return path.join(home, inputPath.slice(2));
  }
  return path.resolve(inputPath);
}

/**
 * 检查路径是否存在
 */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Skill 扫描器
 */
export class SkillScanner {
  private config: SkillConfig;
  private skillsMap: Map<string, SkillEntry>;

  constructor(config: SkillConfig) {
    this.config = config;
    this.skillsMap = new Map();
  }

  /**
   * 扫描所有 skillPaths 并加载 skills
   */
  async scan(): Promise<Map<string, SkillEntry>> {
    this.skillsMap.clear();

    for (const skillPath of this.config.skillPaths) {
      await this.scanPath(skillPath);
    }

    return this.skillsMap;
  }

  /**
   * 扫描单个路径
   */
  private async scanPath(skillPath: SkillPath): Promise<void> {
    const expandedPath = expandPath(skillPath.path);

    if (!(await pathExists(expandedPath))) {
      logger.info(`[SkillScanner] Path not found, skipping: ${expandedPath}`);
      return;
    }

    logger.info(`[SkillScanner] Scanning: ${expandedPath}`);

    // 使用正斜杠构建 glob pattern，确保 Windows 兼容性
    // glob 库需要正斜杠路径，不能使用 path.join（Windows 会用反斜杠）
    const sep = "/";
    const basePattern = expandedPath.replace(/\\/g, "/");
    const pattern = this.config.recursive
      ? `${basePattern}${sep}**${sep}SKILL.md`
      : `${basePattern}${sep}SKILL.md`;

    const files = await glob(pattern, {
      absolute: true,
      ignore: ["**/node_modules/**"],
    });

    logger.info(`[SkillScanner] Found ${files.length} SKILL.md files`);

    for (const filePath of files) {
      await this.processFile(filePath, skillPath.type);
    }
  }

  /**
   * 处理单个 SKILL.md 文件
   */
  private async processFile(
    filePath: string,
    source: SkillSource
  ): Promise<void> {
    const entry = await parseSkillFile(filePath, source);

    if (!entry) {
      return;
    }

    // 按优先级合并去重
    const existing = this.skillsMap.get(entry.name);
    if (!existing || getSourcePriority(source) > getSourcePriority(existing.source)) {
      this.skillsMap.set(entry.name, entry);
      logger.debug(`[SkillScanner] Loaded skill: ${entry.name} (${source})`);
    }
  }

  /**
   * 获取扫描结果
   */
  getSkills(): Map<string, SkillEntry> {
    return this.skillsMap;
  }
}
