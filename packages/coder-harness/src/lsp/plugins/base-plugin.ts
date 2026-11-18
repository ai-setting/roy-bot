/**
 * @fileoverview LanguageLSPPlugin 接口定义
 * 
 * 定义 LSP 插件的基础接口，所有 LSP 插件都需要实现此接口
 */

import type { Diagnostic, DocumentSymbol } from "vscode-languageserver-types";

/**
 * 插件预加载模式
 */
export type PreloadMode = "startup" | "lazy" | "disabled";

/**
 * LSP 插件配置
 */
export interface LanguageLSPPluginConfig {
  /** 是否启用 */
  enabled?: boolean;
  /** 预加载模式：startup（启动时）、lazy（首次使用时）、disabled（禁用） */
  preloadMode?: PreloadMode;
  /** 空闲超时（毫秒），超时后关闭 LSP 连接 */
  idleTimeout?: number;
}

/**
 * LSP 语言插件接口
 * 
 * 所有 LSP 语言插件都需要实现此接口
 */
export interface LanguageLSPPlugin {
  /** 插件名称 */
  readonly name: string;
  /** 插件描述 */
  readonly description: string;
  /** 支持的文件扩展名 */
  readonly extensions: readonly string[];
  /** 支持的语言 ID 列表 */
  readonly languageIds: readonly string[];

  /**
   * 初始化插件
   */
  initialize?(): Promise<void>;

  /**
   * 获取诊断信息
   * @param filePath 文件路径
   * @returns 诊断信息列表
   */
  getDiagnostics(filePath: string): Promise<Diagnostic[]>;

  /**
   * 获取文档符号
   * @param filePath 文件路径
   * @returns 文档符号列表
   */
  getSymbols?(filePath: string): Promise<DocumentSymbol[]>;

  /**
   * 获取插件状态
   * @returns 状态信息
   */
  getStatus?(): Record<string, unknown>;

  /**
   * 销毁插件
   */
  dispose(): Promise<void>;
}

/**
 * 抽象基类，提供通用的插件功能
 */
export abstract class BaseLanguageLSPPlugin implements LanguageLSPPlugin {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly extensions: readonly string[];
  abstract readonly languageIds: readonly string[];

  protected config: LanguageLSPPluginConfig;
  private initialized: boolean = false;

  constructor(config: LanguageLSPPluginConfig = {}) {
    this.config = {
      enabled: true,
      preloadMode: "startup",
      idleTimeout: 60000,
      ...config,
    };
  }

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  abstract getDiagnostics(filePath: string): Promise<Diagnostic[]>;

  getSymbols?(filePath: string): Promise<DocumentSymbol[]> {
    return Promise.resolve([]);
  }

  getStatus?(): Record<string, unknown> {
    return {
      name: this.name,
      enabled: this.config.enabled,
      initialized: this.initialized,
    };
  }

  async dispose(): Promise<void> {
    this.initialized = false;
  }

  /**
   * 检查插件是否已初始化
   */
  protected isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 检查插件是否启用
   */
  protected isEnabled(): boolean {
    return this.config.enabled !== false;
  }
}
