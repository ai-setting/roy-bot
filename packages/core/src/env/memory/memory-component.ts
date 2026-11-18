/**
 * @fileoverview MemoryComponent - Simplified
 * 
 * 记忆管理核心组件
 * 
 * 简化设计：
 * - 移除 DraftManager、MemoryOrganizer、AccessLog 依赖
 * - 只保留核心的 memory 文件操作
 * - 提供 recallMemory(scope) 方法支持 project/global scope
 */

import { BaseComponent, type ComponentConfig } from "../component";
import { createLogger } from "../log-trace/logger";
import type { ToolComponent } from "../tool";
import type { Tool } from "../tool/types";
import type {
  MemoryConfig,
  MemoryPath,
  RecordMemoryMode,
  RecordMemoryResult,
} from "./types";
import { DEFAULT_MEMORY_CONFIG } from "./memory-config";
import { createMemoryTools } from "./built-in";
import { MEMORY_CONFIG_REGISTRATION, MEMORY_DEFAULTS } from "./memory-config-registration";
import type { ConfigComponent } from "../../config/config-component";
import { envKeyToConfigKey } from "../../config/env-key";

import path from "path";
import fs from "fs/promises";

const logger = createLogger("memory");

/**
 * MemoryComponent 配置选项（通过 options 传递）
 */
export interface MemoryComponentOptions {
  /** ConfigComponent 实例（必填） */
  configComponent: ConfigComponent;
  
  /** 配置文件相对路径（可选，基于 XDG_DATA_HOME） */
  configPath?: string;
  
  /** 环境变量前缀（可选，默认 "MEMORY"） */
  envPrefix?: string;
  
  /** 直接传入的配置对象（可选，优先级最高） */
  config?: Partial<MemoryConfig>;
}

/**
 * MemoryComponent - Simplified
 * 
 * 简化的记忆管理组件，只负责：
 * - 管理本地文件系统记忆存储
 * - 注册记忆操作工具
 * - 提供目录扫描和缓存
 * 
 * 复杂功能已移除：
 * - DraftManager（草稿管理）
 * - MemoryOrganizer（记忆整理）
 * - AccessLog（访问日志）
 */
export class MemoryComponent extends BaseComponent {
  name = "memory";
  version = "2.0.0";

  private config!: MemoryConfig;
  private toolComponent?: ToolComponent;
  private configComponent?: ConfigComponent;

  // 缓存
  private cache: Map<string, { data: unknown; timestamp: number }> = new Map();

  /** 配置变更 watcher 清理函数 */
  private configWatcher?: () => void;

  // ====================
  // Lifecycle
  // ====================

  async init(config?: ComponentConfig): Promise<void> {
    await super.init(config);

    // 从 options 获取 ConfigComponent
    const options = config?.options as unknown as MemoryComponentOptions | undefined;
    if (!options?.configComponent) {
      throw new Error("ConfigComponent is required for MemoryComponent initialization");
    }

    this.configComponent = options.configComponent;
    await this.registerConfig(options);

    logger.info("[MemoryComponent] Initialized (simplified)");
  }

  /**
   * 注册配置到 ConfigComponent
   */
  private async registerConfig(options: MemoryComponentOptions): Promise<void> {
    const configComponent = this.configComponent;
    if (!configComponent) return;

    const { configPath, envPrefix, config } = options;
    const prefix = envPrefix ?? "MEMORY";

    // 1. 使用 registerComponent 注册配置结构
    configComponent.registerComponent(MEMORY_CONFIG_REGISTRATION);

    // 2. 注册 FileSource
    if (configPath) {
      configComponent.registerSource({
        type: "file",
        relativePath: configPath,
        optional: true,
        watch: false
      });
    }

    // 3. 注册 EnvSource
    configComponent.registerSource({
      type: "env",
      envPrefix: prefix,
      priority: 20,
      watch: false
    });
    
    // 4. 从 sources 加载配置
    await configComponent.load("memory");
    
    // 5. 后备方案：直接读取环境变量
    for (const envKey of Object.keys(process.env)) {
      const configKey = envKeyToConfigKey(envKey, prefix, "memory");
      if (!configKey) continue;
      const value = process.env[envKey];
      if (value !== undefined) {
        await configComponent.set(configKey, value);
      }
    }

    // 6. 设置默认值
    for (const [key, value] of Object.entries(MEMORY_DEFAULTS)) {
      if (configComponent.get(key) === undefined) {
        await configComponent.set(key, value);
      }
    }

    // 7. 直接配置对象（最高优先级）
    if (config) {
      const flatConfig = this.flattenConfig(config);
      for (const [key, value] of Object.entries(flatConfig)) {
        await configComponent.set(key, value);
      }
    }

    // 8. 注册配置热更新监听
    this.registerConfigWatcher(configComponent);

    // 9. 解析最终配置
    this.buildConfig(configComponent);
  }

  /**
   * 构建最终配置对象
   */
  private buildConfig(configComponent: ConfigComponent): void {
    const recursive = (configComponent.get("memory.recursive") as boolean) ?? true;
    const cacheEnabled = (configComponent.get("memory.cacheEnabled") as boolean) ?? true;
    const cacheTTL = (configComponent.get("memory.cacheTTL") as number) ?? 300000;
    const memoryFile = (configComponent.get("memory.memoryFile") as string) ?? "memory.md";

    // 从配置获取 memoryPaths
    const memoryPathsConfig = configComponent.get("memory.memoryPaths");
    let memoryPaths: MemoryPath[] = [];

    if (Array.isArray(memoryPathsConfig)) {
      memoryPaths = memoryPathsConfig as MemoryPath[];
    } else if (typeof memoryPathsConfig === "string") {
      try {
        memoryPaths = JSON.parse(memoryPathsConfig);
      } catch {
        memoryPaths = DEFAULT_MEMORY_CONFIG.memoryPaths;
      }
    }

    if (memoryPaths.length === 0) {
      memoryPaths = DEFAULT_MEMORY_CONFIG.memoryPaths;
    }

    this.config = {
      memoryPaths,
      recursive,
      cacheEnabled,
      cacheTTL,
      memoryFile,
    };
  }

  /**
   * 将配置对象展平为点号路径
   */
  private flattenConfig(
    obj: Record<string, unknown>,
    prefix = "memory"
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const fullKey = `${prefix}.${key}`;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        Object.assign(
          result,
          this.flattenConfig(value as Record<string, unknown>, fullKey)
        );
      } else {
        result[fullKey] = value;
      }
    }
    return result;
  }

  /**
   * 注册配置热更新监听
   */
  private registerConfigWatcher(configComponent: ConfigComponent): void {
    if (typeof configComponent.watch !== "function") {
      return;
    }
    
    this.configWatcher = configComponent.watch("memory.*", (event) => {
      this.onConfigChange(event);
    });
  }

  /**
   * 处理配置变更
   */
  protected onConfigChange(event: { key: string; oldValue?: unknown; newValue?: unknown }): void {
    logger.info(`[MemoryComponent] Config changed: ${event.key}`, {
      oldValue: event.oldValue,
      newValue: event.newValue
    });
    if (this.configComponent) {
      this.buildConfig(this.configComponent);
    }
    this.cache.clear();
  }

  async start(): Promise<void> {
    await super.start();

    // 获取 ToolComponent
    this.toolComponent = this.env?.getComponent("tool");
    if (!this.toolComponent) {
      logger.warn("[MemoryComponent] ToolComponent not found, skipping tool registration");
      return;
    }

    // 注册工具
    await this.registerTools();

    this.setStatus("running");
    logger.info(`[MemoryComponent] Started with ${this.toolComponent.getToolCount()} tools`);
  }

  async stop(): Promise<void> {
    // 清理配置 watcher
    if (this.configWatcher) {
      this.configWatcher();
      this.configWatcher = undefined;
    }

    // 取消注册工具
    if (this.toolComponent) {
      this.toolComponent.unregister("record_memory");
      this.toolComponent.unregister("recall_memory");
    }

    // 清理缓存
    this.cache.clear();

    await super.stop();
    logger.info("[MemoryComponent] Stopped");
  }

  // ====================
  // Tool Registration
  // ====================

  private async registerTools(): Promise<void> {
    if (!this.toolComponent) return;

    // 创建工具
    const tools = createMemoryTools(
      (args) => this.recordMemory(args),
      (scope) => this.recallMemory(scope),
      {
        getMemoryPaths: () => this.getMemoryPaths(),
        getMemoryFile: () => this.getMemoryFile(),
      }
    );

    // 注册到 ToolComponent
    for (const tool of tools) {
      this.toolComponent.register(tool);
    }

    logger.info("[MemoryComponent] Registered memory tools");
  }

  // ====================
  // Memory Operations
  // ====================

  /**
   * 获取所有配置的 memory 路径
   */
  getMemoryPaths(): MemoryPath[] {
    return this.config.memoryPaths;
  }

  /**
   * 更新 memory paths
   */
  updateMemoryPaths(paths: MemoryPath[]): void {
    this.config.memoryPaths = paths;
    this.clearCache();
  }

  /**
   * 获取记忆文件名
   */
  getMemoryFile(): string {
    return this.config.memoryFile ?? "memory.md";
  }

  /**
   * 记录记忆
   * 
   * @param args.mode 操作模式
   * @param args.content 记忆内容
   * @param args.title 标题
   * @param args.filename 文件名
   * @param args.scope 作用域 (project/global)，用于选择正确的 memory path
   */
  async recordMemory(args: {
    mode: RecordMemoryMode;
    content?: string;
    title?: string;
    filename?: string;
    scope?: "project" | "global";
  }): Promise<RecordMemoryResult | null> {
    const { mode, content, title, filename, scope } = args;
    const memoryFile = filename ?? this.getMemoryFile();
    const paths = this.config.memoryPaths;

    if (paths.length === 0) {
      return null;
    }

    // 根据 scope 选择正确的路径
    let basePath: string;
    if (scope) {
      const targetPath = paths.find(p => p.type === scope);
      if (!targetPath) {
        logger.warn(`[recordMemory] No ${scope} path configured, using first available path`);
        basePath = paths[0].path;
      } else {
        basePath = targetPath.path;
      }
    } else {
      // 默认使用第一个路径
      basePath = paths[0].path;
    }
    const filePath = path.join(basePath, memoryFile);

    try {
      let existingContent = "";
      let fileExists = false;
      try {
        existingContent = await fs.readFile(filePath, "utf-8");
        fileExists = true;
      } catch {
        // 文件不存在
      }

      let newContent: string;
      let action: RecordMemoryResult["action"];

      switch (mode) {
        case "delete":
          if (fileExists) {
            await fs.unlink(filePath);
            this.clearCache();
            return { path: filePath, action: "delete" };
          }
          return null;

        case "overwrite":
          if (title && content) {
            newContent = `## ${title}\n\n${content}\n`;
          } else {
            newContent = content ?? "";
          }
          action = fileExists ? "overwrite" : "created";
          break;

        case "append":
          if (!content) {
            throw new Error("content is required for append mode");
          }
          if (title) {
            newContent = existingContent + `\n## ${title}\n\n${content}\n`;
          } else {
            newContent = existingContent + `\n${content}\n`;
          }
          action = fileExists ? "append" : "created";
          break;

        case "prepend":
          if (!content) {
            throw new Error("content is required for prepend mode");
          }
          if (title) {
            newContent = `## ${title}\n\n${content}\n\n---\n\n${existingContent}`;
          } else {
            newContent = `${content}\n\n---\n\n${existingContent}`;
          }
          action = fileExists ? "prepend" : "created";
          break;

        default:
          throw new Error(`Unknown mode: ${mode}`);
      }

      await fs.mkdir(basePath, { recursive: true });
      await fs.writeFile(filePath, newContent, "utf-8");
      this.clearCache();

      return { path: filePath, action };
    } catch (error) {
      logger.error(`[recordMemory] Failed: ${error}`);
      throw error;
    }
  }

  /**
   * 回忆记忆 - 读取所有记忆文件内容
   * 
   * @param scope 可选：project 或 global，默认读取所有
   */
  async recallMemory(scope?: "project" | "global"): Promise<string> {
    const memoryFile = this.getMemoryFile();
    const paths = this.config.memoryPaths;
    const results: string[] = [];

    for (const memoryPath of paths) {
      // 如果指定了 scope，只读取匹配的记忆
      if (scope && memoryPath.type !== scope) {
        continue;
      }
      
      const filePath = path.join(memoryPath.path, memoryFile);
      
      try {
        const content = await fs.readFile(filePath, "utf-8");
        if (content.trim()) {
          results.push(`## [${memoryPath.type}] ${memoryFile}\n${content}`);
        }
      } catch {
        // 文件不存在，跳过
      }
    }

    return results.join("\n\n");
  }

  // ====================
  // Cache
  // ====================

  private clearCache(): void {
    this.cache.clear();
  }

  private getCache<T>(key: string): T | undefined {
    if (!this.config.cacheEnabled) return undefined;

    const entry = this.cache.get(key);
    if (!entry) return undefined;

    const age = Date.now() - entry.timestamp;
    if (age > (this.config.cacheTTL ?? 300000)) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.data as T;
  }

  private setCache<T>(key: string, data: T): void {
    if (!this.config.cacheEnabled) return;
    this.cache.set(key, { data, timestamp: Date.now() });
  }
}
