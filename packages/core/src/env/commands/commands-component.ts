/**
 * @fileoverview CommandsComponent
 * 
 * 命令管理核心组件（收藏式）
 * 
 * 功能：
 * - 管理 user/project 多路径命令目录
 * - 提供命令发现、添加、移除、执行能力
 * - 支持 File/Env/Object 三种配置来源
 */

import path from "path";
import os from "os";
import { BaseComponent, type ComponentConfig } from "../component";
import { createLogger } from "../log-trace/logger";
import * as fs from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";

import type {
  CommandsComponentOptions,
  CommandsComponentConfig,
  CommandIndex,
  CommandMeta,
  CommandSource,
  ScanResult,
  DiscoverOptions,
  AddCommandOptions,
  RemoveCommandOptions,
  ExecutionResult,
} from "./types";
import { parseMetaFile, scanMetaFiles } from "./parser";
import type { ConfigComponent } from "../../config/config-component";
import { toEnvKey, envKeyToConfigKey } from "../../config/env-key";
import { COMMANDS_CONFIG_REGISTRATION, COMMANDS_DEFAULTS } from "./commands-config-registration";

const execAsync = promisify(exec);
const logger = createLogger("commands");

// 默认配置
const DEFAULT_USER_DIR = ".roy-bot/commands";
const DEFAULT_PROJECT_DIR = ".roy/commands";
const DEFAULT_CACHE_DIR = ".cache/roy-bot/commands";
const DESCRIPTIONS_FILE = "descriptions.json";

// 配置键名列表
const CONFIG_KEYS = [
  "command.userCommandsDir",
  "command.projectCommandsDir",
  "command.cacheDir",
];

export class CommandsComponent extends BaseComponent {
  readonly name = "commands";
  readonly version = "2.0.0";

  private config?: CommandsComponentConfig;
  private configComponent?: ConfigComponent;
  private userCommandsDir: string = "";
  private projectCommandsDir: string = "";
  private descriptionCache: Map<string, string> = new Map();
  private descriptionCacheFile: string = "";

  constructor() {
    super();
    this.initDefaultDirs();
  }

  private initDefaultDirs(): void {
    const homeDir = os.homedir();
    this.userCommandsDir = path.join(homeDir, DEFAULT_USER_DIR);
    this.projectCommandsDir = DEFAULT_PROJECT_DIR;
    this.descriptionCacheFile = path.join(homeDir, DEFAULT_CACHE_DIR, DESCRIPTIONS_FILE);
  }

  // ========================================================================
  // Component Lifecycle
  // ========================================================================

  /**
   * 初始化组件
   * 
   * 配置加载顺序（优先级从低到高）：
   * 1. File - 配置文件
   * 2. Env - 环境变量
   * 3. Object - 直接传入的 config 对象
   */
  async init(config?: ComponentConfig): Promise<void> {
    await super.init(config);

    const options = config?.options as unknown as CommandsComponentOptions | undefined;
    if (!options?.configComponent) {
      throw new Error("ConfigComponent is required for CommandsComponent initialization");
    }

    this.configComponent = options.configComponent;
    await this.registerConfig(options);

    // 确保 user 目录存在
    await fs.mkdir(this.userCommandsDir, { recursive: true });

    // 加载描述缓存
    await this.loadDescriptionCache();

    logger.info(`CommandsComponent initialized: user=${this.userCommandsDir}, project=${this.projectCommandsDir}`);
  }

  /**
   * 注册配置到 ConfigComponent
   * 
   * 使用 SessionComponent 的正确模式：
   * 1. 使用 registerComponent() 注册配置（包含 sources、keys、defaults）
   * 2. 使用 load("command") 加载配置值
   * 3. 处理环境变量后备方案
   * 4. 处理 config 对象（最高优先级）
   */
  private async registerConfig(options: CommandsComponentOptions): Promise<void> {
    const configComponent = this.configComponent;
    if (!configComponent) return;

    const { configPath, envPrefix, config } = options;

    // 1. 注册 COMMANDS_CONFIG_REGISTRATION（包含 defaults、sources、keys）
    configComponent.registerComponent(COMMANDS_CONFIG_REGISTRATION);

    // 2. 如果提供了 configPath，添加额外的 file source
    if (configPath) {
      configComponent.registerSource({
        type: "file",
        relativePath: configPath,
        optional: true,
        watch: false,
      });
    }

    // 3. 使用 load 加载配置（会使用 defaults 填充，然后被环境变量覆盖）
    await configComponent.load("command");

    // 4. 环境变量后备方案（确保环境变量能够覆盖配置）
    const prefix = envPrefix !== undefined ? envPrefix : "COMMAND";
    for (const key of CONFIG_KEYS) {
      const envKey = toEnvKey(key, prefix);
      const value = process.env[envKey];
      if (value !== undefined) {
        await configComponent.set(key, value);
      }
    }

    // 5. 自动发现其他相关环境变量
    const loadedKeys = new Set(CONFIG_KEYS);
    for (const envKey of Object.keys(process.env)) {
      const configKey = envKeyToConfigKey(envKey, prefix, "command");
      if (!configKey) continue;
      if (loadedKeys.has(configKey)) continue;
      loadedKeys.add(configKey);
      const value = process.env[envKey];
      if (value !== undefined) {
        await configComponent.set(configKey, value);
      }
    }

    // 6. 直接配置对象（最高优先级）
    if (config) {
      const flatConfig = this.flattenConfig(config);
      for (const [key, value] of Object.entries(flatConfig)) {
        if (value !== undefined) {
          await configComponent.set(key, value);
        }
      }
    }

    // 7. 设置默认值（只有当配置不存在时）
    // 注意：commands 使用基于 HOME 的绝对路径作为默认值
    const homeDir = os.homedir();
    const defaultDirs = {
      "command.userCommandsDir": path.join(homeDir, DEFAULT_USER_DIR),
      "command.projectCommandsDir": DEFAULT_PROJECT_DIR,
      "command.cacheDir": path.join(homeDir, DEFAULT_CACHE_DIR),
    };
    
    for (const [key, value] of Object.entries(defaultDirs)) {
      if (configComponent.get(key) === undefined) {
        await configComponent.set(key, value);
      }
    }

    // 应用最终配置
    this.applyConfig(configComponent);
  }

  /**
   * 将嵌套配置扁平化
   */
  private flattenConfig(config: CommandsComponentConfig): Record<string, string> {
    const result: Record<string, string> = {};
    
    if (config.userCommandsDir !== undefined) {
      result["command.userCommandsDir"] = config.userCommandsDir;
    }
    if (config.projectCommandsDir !== undefined) {
      result["command.projectCommandsDir"] = config.projectCommandsDir;
    }
    if (config.cacheDir !== undefined) {
      result["command.cacheDir"] = config.cacheDir;
    }
    
    return result;
  }

  /**
   * 从 ConfigComponent 应用配置
   */
  private applyConfig(configComponent: ConfigComponent): void {
    const userDir = configComponent.get("command.userCommandsDir") as string | undefined;
    const projectDir = configComponent.get("command.projectCommandsDir") as string | undefined;
    const cacheDir = configComponent.get("command.cacheDir") as string | undefined;

    this.userCommandsDir = userDir || path.join(os.homedir(), DEFAULT_USER_DIR);
    this.projectCommandsDir = projectDir || DEFAULT_PROJECT_DIR;
    this.descriptionCacheFile = path.join(
      cacheDir || path.join(os.homedir(), DEFAULT_CACHE_DIR),
      DESCRIPTIONS_FILE
    );

    this.config = {
      userCommandsDir: this.userCommandsDir,
      projectCommandsDir: this.projectCommandsDir,
      cacheDir: cacheDir,
    };
  }

  async start(): Promise<void> {
    await super.start();
    logger.debug("CommandsComponent started");
  }

  async stop(): Promise<void> {
    await this.saveDescriptionCache();
    await super.stop();
    logger.debug("CommandsComponent stopped");
  }

  /**
   * 获取命令目录列表
   */
  async getCommandDirs(): Promise<{ user: string; project: string }> {
    return {
      user: this.userCommandsDir,
      project: this.projectCommandsDir,
    };
  }

  /**
   * 发现命令
   */
  async discover(options?: DiscoverOptions): Promise<ScanResult> {
    const commands: CommandIndex[] = [];
    let userCount = 0;
    let projectCount = 0;

    // 先扫描 project 目录（优先）
    try {
      const projectCommands = await this.scanDir(this.projectCommandsDir, "project", options?.pattern);
      commands.push(...projectCommands);
      projectCount = projectCommands.length;
    } catch (error) {
      logger.debug(`Failed to scan project dir: ${error}`);
    }

    // 再扫描 user 目录（去重）
    try {
      const userCommands = await this.scanDir(this.userCommandsDir, "user", options?.pattern);
      for (const cmd of userCommands) {
        const exists = commands.find((c) => c.name === cmd.name);
        if (!exists) {
          commands.push(cmd);
          userCount++;
        }
      }
    } catch (error) {
      logger.debug(`Failed to scan user dir: ${error}`);
    }

    commands.sort((a, b) => a.name.localeCompare(b.name));

    return {
      commands,
      stats: { userCount, projectCount },
    };
  }

  /**
   * 添加命令
   */
  async add(options: AddCommandOptions): Promise<void> {
    const { name, target, source = "user", description, tips } = options;
    const dir = source === "user" ? this.userCommandsDir : this.projectCommandsDir;
    const targetPath = path.resolve(target);

    await fs.mkdir(dir, { recursive: true });

    const commandPath = path.join(dir, name);

    try {
      await fs.access(commandPath);
      throw new Error(`Command '${name}' already exists`);
    } catch (error: any) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    // 创建符号链接
    await fs.symlink(targetPath, commandPath);
    logger.info(`Added command '${name}' -> ${targetPath} (${source})`);

    // 创建 meta.md（用于 Prompt 注入）
    const commandDir = path.join(dir, name);
    await this.createCommandMeta(commandDir, {
      name,
      target: targetPath,
      description: description || `Command: ${name}`,
      tips,
      source,
    });
  }

  /**
   * 创建命令的 meta.md 文件
   */
  private async createCommandMeta(
    commandDir: string,
    options: {
      name: string;
      target: string;
      description: string;
      tips?: string;
      source: CommandSource;
    }
  ): Promise<void> {
    // 确保命令目录存在（符号链接本身不能作为目录）
    // meta.md 存在命令的父目录中
    const parentDir = path.dirname(commandDir);
    const metaPath = path.join(parentDir, `${options.name}.meta.md`);
    
    const tipsContent = options.tips 
      ? `\ntips: "${options.tips}"` 
      : "";

    const content = `---
name: ${options.name}
description: ${options.description}${tipsContent}
source: ${options.source}
---

# ${options.name} Command

## Target
\`${options.target}\`

## 功能
${options.description}

## 探索提示
Run \`${options.name} --help\` to explore full capabilities.
`;

    await fs.writeFile(metaPath, content, "utf-8");
    logger.info(`[CommandsComponent] Created meta.md for '${options.name}'`);
  }

  /**
   * 获取所有收藏命令的元信息（用于 Prompt 注入）
   */
  async getCommandsMeta(): Promise<CommandMeta[]> {
    const metaList: CommandMeta[] = [];

    // 扫描 user 目录
    try {
      const entries = await fs.readdir(this.userCommandsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".meta.md")) {
          const metaPath = path.join(this.userCommandsDir, entry.name);
          const meta = await parseMetaFile(metaPath, "user");
          if (meta) {
            metaList.push(meta);
          }
        }
      }
    } catch (error) {
      // 目录不存在时忽略
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.debug(`Failed to scan user commands dir: ${error}`);
      }
    }

    // 扫描 project 目录
    try {
      const entries = await fs.readdir(this.projectCommandsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".meta.md")) {
          const metaPath = path.join(this.projectCommandsDir, entry.name);
          const meta = await parseMetaFile(metaPath, "project");
          if (meta) {
            metaList.push(meta);
          }
        }
      }
    } catch (error) {
      // 目录不存在时忽略
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.debug(`Failed to scan project commands dir: ${error}`);
      }
    }

    return metaList;
  }

  /**
   * 移除命令
   */
  async remove(options: RemoveCommandOptions): Promise<void> {
    const { name, source } = options;

    const dirsToCheck = source
      ? [source === "user" ? this.userCommandsDir : this.projectCommandsDir]
      : [this.userCommandsDir, this.projectCommandsDir];

    for (const dir of dirsToCheck) {
      const commandPath = path.join(dir, name);
      try {
        await fs.unlink(commandPath);
        logger.info(`Removed command '${name}' from ${dir}`);
        return;
      } catch (error: any) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }

    throw new Error(`Command '${name}' not found`);
  }

  /**
   * 获取命令信息
   */
  async getInfo(name: string): Promise<CommandIndex | null> {
    const dirsToCheck = [this.projectCommandsDir, this.userCommandsDir];

    for (const dir of dirsToCheck) {
      const commandPath = path.join(dir, name);
      try {
        const stat = await fs.lstat(commandPath);
        const realPath = stat.isSymbolicLink() ? await fs.readlink(commandPath) : commandPath;
        const cmdSource: CommandSource = dir === this.projectCommandsDir ? "project" : "user";

        const shortDescription = await this.getDescription(realPath, name, dir);

        return {
          name,
          path: realPath,
          source: cmdSource,
          shortDescription,
        };
      } catch (error: any) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }

    return null;
  }

  /**
   * 执行命令
   */
  async exec(options: { name: string; args?: string[]; cwd?: string }): Promise<ExecutionResult> {
    const { name, args = [], cwd } = options;

    const info = await this.getInfo(name);
    if (!info) {
      return {
        stdout: "",
        stderr: `Command '${name}' not found`,
        exitCode: 127,
        success: false,
      };
    }

    const cmd = `${info.path} ${args.join(" ")}`;
    try {
      const { stdout, stderr } = await execAsync(cmd, {
        cwd: cwd || process.cwd(),
        timeout: 30000,
      });
      return {
        stdout,
        stderr,
        exitCode: 0,
        success: true,
      };
    } catch (error: any) {
      return {
        stdout: error.stdout || "",
        stderr: error.stderr || error.message,
        exitCode: error.code || 1,
        success: false,
      };
    }
  }

  // ========================================================================
  // Private Methods
  // ========================================================================

  private async scanDir(dir: string, source: CommandSource, pattern?: string): Promise<CommandIndex[]> {
    const commands: CommandIndex[] = [];

    try {
      const entries = await fs.readdir(dir);

      for (const entry of entries) {
        if (entry.startsWith(".")) continue;
        if (pattern && !this.matchPattern(entry, pattern)) continue;

        const fullPath = path.join(dir, entry);

        try {
          const stat = await fs.lstat(fullPath);

          if (!stat.isSymbolicLink() && !stat.isFile()) continue;

          if (stat.isFile()) {
            try {
              await fs.access(fullPath, fs.constants.X_OK);
            } catch {
              continue;
            }
          }

          const realPath = stat.isSymbolicLink() ? await fs.readlink(fullPath) : fullPath;
          const shortDescription = await this.getDescription(realPath, entry, dir);

          commands.push({
            name: entry,
            path: realPath,
            source,
            shortDescription,
          });
        } catch (error) {
          logger.debug(`Failed to stat ${fullPath}: ${error}`);
        }
      }
    } catch (error) {
      logger.debug(`Failed to scan dir ${dir}: ${error}`);
    }

    return commands;
  }

  private matchPattern(name: string, pattern: string): boolean {
    const regex = new RegExp("^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
    return regex.test(name);
  }

  private async getDescription(commandPath: string, name?: string, commandsDir?: string): Promise<string> {
    // 1. 优先从 meta.md 读取 description
    if (name && commandsDir) {
      const metaPath = path.join(commandsDir, `${name}.meta.md`);
      try {
        const meta = await parseMetaFile(metaPath, "user");
        if (meta?.description) {
          this.descriptionCache.set(commandPath, meta.description);
          return meta.description;
        }
      } catch {
        // meta.md 不存在或解析失败，忽略
      }
    }

    // 2. Fallback 到 --help | head -1
    const cached = this.descriptionCache.get(commandPath);
    if (cached !== undefined) return cached;

    try {
      const { stdout } = await execAsync(`${commandPath} --help 2>/dev/null | head -1`, {
        timeout: 2000,
      });
      const description = stdout.trim().split("\n")[0] || "";

      this.descriptionCache.set(commandPath, description);
      return description;
    } catch {
      return "";
    }
  }

  private async loadDescriptionCache(): Promise<void> {
    try {
      const content = await fs.readFile(this.descriptionCacheFile, "utf-8");
      const data = JSON.parse(content);
      this.descriptionCache = new Map(Object.entries(data));
    } catch {
      // 缓存文件不存在，忽略
    }
  }

  private async saveDescriptionCache(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.descriptionCacheFile), { recursive: true });
      const data = Object.fromEntries(this.descriptionCache);
      await fs.writeFile(this.descriptionCacheFile, JSON.stringify(data, null, 2));
    } catch (error) {
      logger.debug(`Failed to save description cache: ${error}`);
    }
  }
}
