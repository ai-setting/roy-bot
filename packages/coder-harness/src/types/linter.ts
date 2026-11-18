/**
 * @fileoverview Linter 相关类型定义
 */

/**
 * 位置
 */
export interface Position {
  /** 行号（0-indexed） */
  line: number;
  /** 列号（0-indexed） */
  character: number;
}

/**
 * 范围
 */
export interface Range {
  /** 起始位置 */
  start: Position;
  /** 结束位置 */
  end: Position;
}

/**
 * 诊断信息严重程度
 */
export enum DiagnosticSeverity {
  /** 错误 */
  Error = 1,
  /** 警告 */
  Warning = 2,
  /** 信息 */
  Information = 3,
  /** 提示 */
  Hint = 4,
}

/**
 * 诊断信息
 */
export interface Diagnostic {
  /** 问题范围 */
  range: Range;
  /** 严重程度 */
  severity: DiagnosticSeverity;
  /** 错误代码 */
  code?: number | string;
  /** 来源 */
  source?: string;
  /** 问题描述 */
  message: string;
}

/**
 * Lint 结果
 */
export interface LintResult {
  /** 文件路径 */
  filePath: string;
  /** 诊断信息列表 */
  diagnostics: Diagnostic[];
  /** 问题数量 */
  count: number;
  /** 时间戳 */
  timestamp: number;
}

/**
 * LinterPlugin 配置
 */
export interface LinterPluginConfig {
  /** 是否启用 */
  enabled?: boolean;
  /** 空闲超时（毫秒），超时后关闭 LSP 连接 */
  idleTimeout?: number;
  /** 最大并发连接数 */
  maxConnections?: number;
  /** 要忽略的文件模式（glob） */
  ignorePatterns?: string[];
  /** 是否自动下载 LSP 服务器 */
  autoDownload?: boolean;
}

/**
 * LSP 服务器信息
 */
export interface LSPServerInfo {
  /** 服务器 ID */
  id: string;
  /** 支持的文件扩展名 */
  extensions: string[];
  /** 根目录标识文件 */
  rootPattern: string[];
  /** 排除的根目录文件 */
  excludePattern?: string[];
  /** 启动命令 */
  command: string[];
  /** 启动参数 */
  args?: string[];
  /** 初始化选项 */
  initializationOptions?: Record<string, unknown>;
  /**
   * 可选的 client 工厂函数。
   *
   * 当 server 需要定制 LSPClient 行为时（例如 markdown LSP 需要实现
   * `markdown/parse` 请求 + 发送 `markdown.validate.*` 配置），可以
   * 通过此 factory 创建 LSPClient 子类的实例。未提供则使用默认 LSPClient。
   *
   * 注意：类型这里写成 `unknown` 以避免 types 模块反向依赖 lsp 模块，
   * 实际签名 `(proc: ChildProcess, info: LSPServerInfo, rootUri: string, initTimeout?: number) => LSPClient`
   * 在 `lsp/server.ts` 里使用时通过断言收敛。
   */
  clientFactory?: (proc: unknown, info: LSPServerInfo, rootUri: string, initTimeout?: number) => unknown;
}

/**
 * LSP 管理器配置
 */
export interface LSPManagerConfig {
  /** 空闲超时（毫秒） */
  idleTimeout: number;
  /** 最大并发连接数 */
  maxConnections: number;
  /** 是否自动下载 */
  autoDownload: boolean;
  /** LSP 服务器安装目录 */
  installPath?: string;
  /** 预加载的语言服务器 ID 列表，默认预加载所有 */
  preloadLanguages?: string[];
  /** 显式工作区根目录，用于对齐预热连接与文件连接 */
  workspaceRoot?: string;
  /** 预加载清理间隔（毫秒），默认 30000 */
  cleanupInterval?: number;
  /** 健康检查间隔（毫秒），默认 60000 */
  healthCheckInterval?: number;
  /** LSP 客户端初始化超时（毫秒），默认 2000 */
  initTimeout?: number;
  /** F5: 空闲连接 ping 阈值（毫秒），默认 30000。超过此时间未使用的连接在复用前会先 ping 健康检查 */
  idlePingThresholdMs?: number;
}

/**
 * LSPPlugin 配置
 */
export interface LSPPluginConfig {
  /** 是否启用 */
  enabled?: boolean;
  /** 空闲超时（毫秒） */
  idleTimeout?: number;
  /** 最大并发连接数 */
  maxConnections?: number;
  /** 是否自动下载 LSP 服务器 */
  autoDownload?: boolean;
}

// ============================================
// TypeCheckPlugin 类型定义
// ============================================

/**
 * TypeCheckPlugin 配置
 */
export interface TypeCheckPluginConfig {
  /** 是否启用 */
  enabled?: boolean;
  /** 保存时检查 */
  checkOnSave?: boolean;
  /** 编辑时检查 */
  checkOnEdit?: boolean;
  /** 要忽略的文件模式（glob） */
  ignorePatterns?: string[];
  /** 要检查的文件扩展名 */
  supportedExtensions?: string[];
  /** 检查超时（毫秒） */
  timeout?: number;
}

/**
 * TypeCheckManager 配置
 */
export interface TypeCheckManagerConfig {
  /** 检查超时（毫秒） */
  timeout: number;
  /** 忽略的文件模式 */
  ignorePatterns: string[];
}

/**
 * 类型检查问题
 */
export interface TypeCheckIssue {
  /** 行号 */
  line: number;
  /** 列号 */
  column: number;
  /** 结束行号 */
  endLine?: number;
  /** 结束列号 */
  endColumn?: number;
  /** 问题消息 */
  message: string;
  /** 错误代码 */
  code?: string | number;
  /** 严重程度 */
  severity: "error" | "warning" | "info";
}

/**
 * 类型检查结果
 */
export interface TypeCheckResult {
  /** 文件路径 */
  filePath: string;
  /** 错误列表 */
  errors: TypeCheckIssue[];
  /** 警告列表 */
  warnings: TypeCheckIssue[];
  /** 信息列表 */
  info: TypeCheckIssue[];
  /** 统计信息 */
  stats: {
    errors: number;
    warnings: number;
    info: number;
  };
  /** 时间戳 */
  timestamp: number;
}

/**
 * TypeCheckEngine 类型
 */
export type TypeCheckEngine = "typescript" | "python" | "deno" | "rust";

// ============================================
// CodeCheckPlugin 类型定义
// ============================================

/**
 * CodeCheckPlugin 配置
 */
export interface CodeCheckPluginConfig {
  /** 是否启用，默认 true */
  enabled?: boolean;
  /** 保存时检查，默认 true */
  checkOnSave?: boolean;
  /** 编辑时检查，默认 true */
  checkOnEdit?: boolean;
  /** 忽略的文件模式（glob），默认 [] */
  ignorePatterns?: string[];
  /** 支持的文件扩展名，默认全部 */
  supportedExtensions?: string[];
  /** 检查超时（毫秒），默认 30000 */
  timeout?: number;
  /** 自定义命令映射，会覆盖默认命令 */
  commands?: Record<string, string>;
}

/**
 * CodeCheckManager 配置
 */
export interface CodeCheckManagerConfig {
  /** 检查超时（毫秒） */
  timeout: number;
  /** 忽略的文件模式 */
  ignorePatterns: string[];
  /** 自定义命令映射 */
  commands?: Record<string, string>;
}

/**
 * 命令检查结果
 */
export interface CodeCheckResult {
  /** 文件路径 */
  filePath: string;
  /** 命令输出 */
  output: string;
  /** 退出码 */
  exitCode: number;
  /** 是否成功 */
  success: boolean;
  /** 解析出的问题列表 */
  issues: CodeCheckIssue[];
  /** 时间戳 */
  timestamp: number;
}

/**
 * 检查问题
 */
export interface CodeCheckIssue {
  /** 行号 */
  line: number;
  /** 列号 */
  column: number;
  /** 问题消息 */
  message: string;
  /** 错误代码 */
  code?: string;
  /** 严重程度 */
  severity: "error" | "warning" | "info";
  /** 执行命令 */
  command: string;
}
