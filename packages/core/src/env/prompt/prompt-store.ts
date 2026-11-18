/**
 * @fileoverview PromptStore - 用户 prompt 文件持久化
 *
 * 默认目录：~/.local/share/roy-bot/prompts/
 * 文件命名：{name}.md，支持嵌套路径（如 subagent/explore.md）
 */

import { mkdir, readFile, writeFile, unlink, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { getXDGPath } from "../paths";
import { createLogger } from "../log-trace/logger";

const logger = createLogger("prompt:store");

export interface StoredPrompt {
  name: string;
  content: string;
  filePath: string;
}

export class PromptStore {
  private configDir: string;

  constructor(options: { baseDir?: string; configDir?: string } = {}) {
    if (options.configDir && options.configDir.length > 0) {
      this.configDir = options.configDir;
    } else if (options.baseDir) {
      this.configDir = join(options.baseDir, "prompts");
    } else {
      this.configDir = join(getXDGPath("data"), "prompts");
    }
  }

  getConfigDir(): string {
    return this.configDir;
  }

  configDirExists(): boolean {
    return existsSync(this.configDir);
  }

  getPromptFilePath(name: string): string {
    return join(this.configDir, `${name}.md`);
  }

  async savePrompt(name: string, content: string): Promise<string> {
    await this.ensureConfigDir();
    const filePath = this.getPromptFilePath(name);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf-8");
    logger.info(`[PromptStore] Saved prompt: ${name} -> ${filePath}`);
    return filePath;
  }

  async deletePrompt(name: string): Promise<boolean> {
    const filePath = this.getPromptFilePath(name);
    if (!existsSync(filePath)) {
      return false;
    }
    await unlink(filePath);
    logger.info(`[PromptStore] Deleted prompt file: ${filePath}`);
    return true;
  }

  async loadAll(): Promise<StoredPrompt[]> {
    if (!existsSync(this.configDir)) {
      return [];
    }

    const prompts: StoredPrompt[] = [];
    await this.collectPrompts(this.configDir, "", prompts);
    return prompts;
  }

  private async collectPrompts(
    directory: string,
    prefix: string,
    out: StoredPrompt[]
  ): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(directory, entry.name);

      if (entry.isDirectory()) {
        const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
        await this.collectPrompts(fullPath, nextPrefix, out);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }

      const baseName = entry.name.slice(0, -3);
      const name = prefix ? `${prefix}/${baseName}` : baseName;
      const content = (await readFile(fullPath, "utf-8")).trim();
      out.push({ name, content, filePath: fullPath });
    }
  }

  private async ensureConfigDir(): Promise<void> {
    if (!existsSync(this.configDir)) {
      await mkdir(this.configDir, { recursive: true });
      logger.debug(`[PromptStore] Created config directory: ${this.configDir}`);
    }
  }
}
