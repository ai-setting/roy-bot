/**
 * @fileoverview LSP 配置管理
 *
 * 管理 LSP 的安装路径、预加载等配置
 */

import path from "path";
import os from "os";
import fs from "fs";
import { resolveGlobalBinPath } from "./npm-paths";

/**
 * LSP 配置选项
 */
export interface LSPConfigOptions {
  /** 是否启用 LSP 功能 */
  enabled?: boolean;
  /** 是否预加载 LSP 服务器 */
  preload?: boolean;
  /** 预加载的语言服务器 ID 列表 */
  preloadLanguages?: string[];
  /** LSP 包安装路径 */
  installPath?: string;
  /** 空闲超时时间 (ms) */
  idleTimeout?: number;
  /** 最大并发连接数 */
  maxConnections?: number;
  /** 是否自动安装缺失的依赖 */
  autoInstall?: boolean;
  /** 跳过 LSP 依赖安装 */
  skipDeps?: boolean;
}

/**
 * LSP 配置
 */
export class LSPConfig {
  enabled: boolean;
  preload: boolean;
  preloadLanguages: string[] | undefined;
  installPath: string;
  idleTimeout: number;
  maxConnections: number;
  autoInstall: boolean;
  skipDeps: boolean;

  constructor(options: LSPConfigOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.preload = options.preload ?? false;
    this.preloadLanguages = options.preloadLanguages;
    this.installPath = options.installPath ?? this.getDefaultInstallPath();
    this.idleTimeout = options.idleTimeout ?? 60000;
    this.maxConnections = options.maxConnections ?? 5;
    this.autoInstall = options.autoInstall ?? false;
    this.skipDeps = options.skipDeps ?? false;
  }

  /**
   * 获取默认安装路径
   */
  private getDefaultInstallPath(): string {
    return path.join(os.homedir(), ".local", "share", "roy-bot", "lsp-servers");
  }

  /**
   * 获取全局 bin 路径
   */
  getGlobalBinPath(): string {
    return resolveGlobalBinPath();
  }

  /**
   * 转换为 JSON 对象
   */
  toJSON(): LSPConfigOptions {
    return {
      enabled: this.enabled,
      preload: this.preload,
      preloadLanguages: this.preloadLanguages,
      installPath: this.installPath,
      idleTimeout: this.idleTimeout,
      maxConnections: this.maxConnections,
      autoInstall: this.autoInstall,
      skipDeps: this.skipDeps,
    };
  }

  /**
   * 从 JSON 对象加载
   */
  static fromJSON(json: Partial<LSPConfigOptions>): LSPConfig {
    return new LSPConfig(json);
  }
}

/**
 * LSP 配置加载器
 */
export class LSPConfigLoader {
  private configPath: string;

  constructor(configDir?: string) {
    const baseDir = configDir ?? path.join(os.homedir(), ".config", "roy-bot");
    this.configPath = path.join(baseDir, "lsp.json");
  }

  /**
   * 加载配置
   */
  load(): LSPConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const content = fs.readFileSync(this.configPath, "utf8");
        const json = JSON.parse(content);
        return LSPConfig.fromJSON(json);
      }
    } catch (error) {
      console.warn(`Failed to load LSP config from ${this.configPath}:`, error);
    }
    return new LSPConfig();
  }

  /**
   * 保存配置
   */
  save(config: LSPConfig): void {
    const dir = path.dirname(this.configPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(config.toJSON(), null, 2));
  }

  /**
   * 获取配置路径
   */
  getConfigPath(): string {
    return this.configPath;
  }
}

/**
 * 获取默认 LSP 配置
 */
export function getDefaultLSPConfig(): LSPConfig {
  return new LSPConfig();
}

/**
 * 创建 LSP 配置加载器
 */
export function createLSPConfigLoader(configDir?: string): LSPConfigLoader {
  return new LSPConfigLoader(configDir);
}
