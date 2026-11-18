/**
 * @fileoverview Logger - 统一日志系统
 * 
 * 遵循 XDG Base Directory Specification:
 * - 日志存储在 XDG_DATA_HOME/roy-bot/logs/ (默认 ~/.local/share/roy-bot/logs/)
 * 无需配置，自动创建目录
 * 
 * 支持 traceId 追踪：通过 trace-context 模块自动注入
 * 
 * 配置优先级（从高到低）：
 * 1. ConfigComponent (log-trace.logging.level, log-trace.logging.dir)
 * 2. 环境变量 (LOG_LEVEL, LOG_DIR)
 * 3. setLogDirOverride() 手动设置
 * 4. XDG 默认路径
 */

import { appendFileSync, existsSync, mkdirSync } from "fs";
import { basename, dirname, join } from "path";
import { getTracerProvider } from "./opentelemetry/tracer-provider";

/**
 * 简化 Bun file: 协议的编码路径
 * 例如: packages+core/node_modules/.bun/@roy-bot+core@file+packages+core/node_modules/@roy-bot/core/src/env/agent/agent-component.ts
 * 转换为: packages/core/src/env/agent/agent-component.ts
 */
export function simplifyFilePath(fullPath: string): string {
  let path = fullPath.replace(/\\/g, "/");
  
  // 处理 Bun 虚拟文件系统路径
  // 例如: /$bunfs/root/cli/src/bin/roy-bot.js -> cli/src/bin/roy-bot.js
  const bunfsMatch = path.match(/\/\$bunfs\/root\/(.+)$/);
  if (bunfsMatch) {
    // 从虚拟路径中提取相对路径
    const virtualPath = bunfsMatch[1];
    // 查找 packages/ 开头的路径
    const packagesMatch = virtualPath.match(/(packages\/[^/]+\/src\/[^/]+\/.+)$/);
    if (packagesMatch) {
      return packagesMatch[1];
    }
    // 返回去掉 bunfs 前缀的路径
    return virtualPath;
  }
  
  // 尝试匹配并简化 @roy-bot/core 的路径
  const fileProtocolMatch = path.match(/@roy-bot\+core@file\+([^/]+)\/node_modules\/@roy-bot\/core\/(.+)$/);
  if (fileProtocolMatch) {
    const rootPkg = fileProtocolMatch[1].replace(/\+/g, "/");
    const remaining = fileProtocolMatch[2];
    const prefix = rootPkg;
    const suffix = remaining.startsWith("src/") ? remaining : `src/${remaining}`;
    return `${prefix}/${suffix}`;
  }
  
  // 回退：查找 packages/ 开头的路径
  const packagesRootMatch = path.match(/(packages\/[^/]+\/src\/[^/]+\/.+)$/);
  if (packagesRootMatch) {
    return packagesRootMatch[1];
  }
  
  // 回退到简单查找
  const rootMarkers = ["packages/core/src", "packages/core", "packages"];
  for (const marker of rootMarkers) {
    const idx = path.indexOf(marker);
    if (idx !== -1) {
      return path.substring(idx);
    }
  }
  
  return path;
}
import type { LogLevel, ILogger } from "./types";

// ============================================================================
// Default Paths (based on XDG_DATA_HOME)
// ============================================================================

/**
 * 获取默认日志目录（基于 XDG 标准）
 * 存储在 XDG_DATA_HOME/roy-bot/logs/
 */
function getDefaultLogDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  // 尝试使用 xdg-basedir
  try {
    const xdg = require("xdg-basedir");
    if (xdg.xdgData) {
      return join(xdg.xdgData, "roy-bot", "logs");
    }
  } catch {}
  // 回退到 ~/.local/share/roy-bot/logs
  return join(home, ".local", "share", "roy-bot", "logs");
}

// 导入 ConfigComponent 类型（延迟导入避免循环依赖）
let ConfigComponent: any = null;

function getConfigComponentClass() {
  if (!ConfigComponent) {
    try {
      ConfigComponent = require("../config/config-component").ConfigComponent;
    } catch {
      return null;
    }
  }
  return ConfigComponent;
}

let configComponentInstance: any = null;

// ============================================================================
// 安静模式
// ============================================================================

/**
 * 安静模式：启用后日志只写入文件，不输出到 stdout/stderr
 */
let quietMode = false;

export function isQuietMode(): boolean {
  return quietMode;
}

export function setQuietMode(enabled: boolean): void {
  quietMode = enabled;
}

// ============================================================================
// stdout 严格模式（stdio 宿主用）
// ============================================================================

/**
 * stdout 严格模式：启用后 **stdout 只留给协议**，日志一律走 stderr。
 *
 * ## 为什么需要
 *
 * MCP 的 stdio 传输是「按行分隔的 JSON-RPC」，跑在 stdout 上。只要有
 * **一行** 非 JSON 的输出，客户端就会丢弃这个 server —— Claude Code 会报
 * `mcp_servers: [{"name":"plugin:roy-task:roy-task","status":"failed"}]`，
 * 而 server 本身其实是活的。
 *
 * core 的 logger 原本把 `info` 打到 `console.log`（= stdout），task store
 * 的 migration 也用 `console.log` 打印横幅。实测（Task #4619）：插件的 MCP
 * server 26 行 stdout 里有 **24 行不是 JSON**。
 *
 * `setQuietMode(true)` 也能解决（全部进日志文件），但那会把 **stderr**
 * 也一起关掉 —— 而 stderr 恰恰是 server 诊断信息该去的地方。所以这里提供
 * 一个更细的开关：**stdout 归协议，stderr 归诊断**。
 */
let stdoutStrictMode = false;

export function isStdoutStrictMode(): boolean {
  return stdoutStrictMode;
}

export function setStdoutStrictMode(enabled: boolean): void {
  stdoutStrictMode = enabled;
}

// ============================================================================
// ConfigComponent 配置
// ============================================================================

/**
 * 设置 ConfigComponent 实例（用于实时配置读取）
 */
export function setConfigComponent(component: any): void {
  configComponentInstance = component;
}

/**
 * 获取日志级别（支持热更新）
 */
export function getLogLevel(): LogLevel {
  // 1. 优先从 ConfigComponent 获取
  if (configComponentInstance) {
    const level = configComponentInstance.get("log_trace.logging.level");
    if (level && ["debug", "info", "warn", "error"].includes(level)) {
      return level as LogLevel;
    }
  }
  
  // 2. 环境变量
  const envLevel = process.env.LOG_LEVEL as LogLevel;
  if (envLevel && ["debug", "info", "warn", "error"].includes(envLevel)) {
    return envLevel;
  }
  
  // 3. 默认值
  return "info";
}

/**
 * 获取指定类别的日志级别
 * 
 * 支持按类别配置日志级别，配置路径：log-trace.logging.levels.<category>
 * 
 * @param category 日志类别（如 "llm", "agent", "tool"）
 * @returns 该类别的日志级别，如果未配置则返回全局级别
 */
export function getCategoryLogLevel(category: string): LogLevel {
  // 1. 从 ConfigComponent 获取按类别日志级别
  if (configComponentInstance) {
    // 支持嵌套配置：log-trace.logging.levels.llm
    const levels = configComponentInstance.get("log_trace.logging.levels");
    if (levels && typeof levels === "object") {
      const categoryLevel = (levels as Record<string, string>)[category];
      if (categoryLevel && ["debug", "info", "warn", "error"].includes(categoryLevel)) {
        return categoryLevel as LogLevel;
      }
    }
    // 也支持直接配置：log-trace.logging.levels.llm = "debug"
    const directLevel = configComponentInstance.get(`log_trace.logging.levels.${category}`);
    if (directLevel && ["debug", "info", "warn", "error"].includes(directLevel as string)) {
      return directLevel as LogLevel;
    }
  }
  
  // 2. 环境变量（使用前缀，如 LOG_LEVEL_LLM）
  const envKey = `LOG_LEVEL_${category.toUpperCase().replace(/:/g, "_")}`;
  const envLevel = process.env[envKey] as LogLevel;
  if (envLevel && ["debug", "info", "warn", "error"].includes(envLevel)) {
    return envLevel;
  }
  
  // 3. 返回全局级别作为默认值
  return getLogLevel();
}

// ============================================================================
// 日志目录
// ============================================================================

/**
 * 判断路径是否为绝对路径
 * 支持：Unix (/开头)、Windows (盘符开头)、~ (home目录)
 */
function isAbsolutePath(path: string): boolean {
  // Unix 绝对路径
  if (path.startsWith("/")) {
    return true;
  }
  // Windows 盘符路径 (如 C:\, D:\)
  if (/^[a-zA-Z]:[/\\]/.test(path)) {
    return true;
  }
  return false;
}

/**
 * 解析路径中的 ~ 为 home 目录
 */
function expandHomeDir(path: string): string {
  if (path.startsWith("~")) {
    const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
    return join(home, path.slice(1));
  }
  return path;
}

/**
 * 获取日志文件名
 * 实时从 ConfigComponent 读取（支持 env/file/memory 多 source）
 */
export function getLogFile(): string {
  if (configComponentInstance) {
    // 使用 log-trace.logging.file（与 LogTraceComponent 一致）
    const file = configComponentInstance.get("log-trace.logging.file");
    if (file) {
      return file as string;
    }
  }
  return "app.log";
}

export function getLogDir(): string {
  if (configComponentInstance) {
    // 使用 log-trace.logging.dir（与 LogTraceComponent 一致）
    // 历史遗留版本用 log_trace.logging.dir（下划线）但 ConfigComponent 注册的键是连字符
    const dir = configComponentInstance.get("log-trace.logging.dir");
    if (dir) {
      return dir as string;
    }
  }
  return getDefaultLogDir();
}

/**
 * 获取日志输出最大长度配置
 * 实时从 ConfigComponent 读取
 * 
 * @returns 配置的值（0 表示不限制），如果未配置则返回 undefined
 */
export function getMaxOutput(): number | undefined {
  if (configComponentInstance) {
    const maxOutput = configComponentInstance.get("log-trace.logging.maxOutput");
    if (typeof maxOutput === "number") {
      return maxOutput;
    }
  }
  return undefined; // 未配置
}

// 日志目录覆盖（手动设置，优先级最高）
let logDirOverride: string | undefined;

export function setLogDirOverride(dir: string): void {
  logDirOverride = dir;
}

export function getLogDirOverride(): string | undefined {
  return logDirOverride;
}

// 修改 getLogDir 使用 override
const originalGetLogDir = getLogDir;
// getLogDir 保持不变，override 由外部使用

// ============================================================================
// Logger 实现
// ============================================================================

const levelPriority: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const levelEnvMap: Record<string, LogLevel> = {
  "debug": "debug",
  "info": "info",
  "warn": "warn",
  "error": "error",
};

function getEffectiveLevel(configured?: LogLevel): LogLevel {
  // 优先级：构造函数配置 > 环境变量 > 默认 info
  if (configured) return configured;
  const envLevel = process.env.LOG_LEVEL as LogLevel;
  return levelEnvMap[envLevel || ""] || "info";
}

/**
 * Log Data
 * 
 * 用于日志记录的数据结构
 */
interface LogData {
  level?: string;
  category?: string;
  message?: string;
  timestamp?: number;
  callerLocation?: string;
  requestId?: string;
  [key: string]: unknown;
}

class Logger implements ILogger {
  private prefix: string;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  private shouldLog(level: LogLevel): boolean {
    // 获取该类别的日志级别（支持按类别配置）
    const categoryLevel = getCategoryLogLevel(this.prefix);
    return levelPriority[level] >= levelPriority[categoryLevel];
  }

  private ensureLogDirectory(dir: string): void {
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch (err) {
        console.error("[Logger] Failed to create log directory:", dir, err);
      }
    }
  }

  private getCallerLocation(): { file: string; line: number } | null {
    const originalLimit = Error.stackTraceLimit;
    Error.stackTraceLimit = 10;
    
    const err = new Error();
    Error.captureStackTrace(err, this.formatMessage);
    
    const stack = err.stack?.split("\n") || [];
    Error.stackTraceLimit = originalLimit;

    for (let i = 1; i < stack.length; i++) {
      const line = stack[i];
      if (line.includes("at ") && !line.includes("logger.ts") && !line.includes("formatMessage")) {
        const match = line.match(/at\s+.+\s+\((.+):(\d+):\d+\)/) || line.match(/at\s+(.+):(\d+):\d+/);
        if (match) {
          const filePath = match[1];
          const relativePath = this.getRelativePath(filePath);
          return {
            file: relativePath,
            line: parseInt(match[2], 10),
          };
        }
      }
    }
    return null;
  }

  private getRelativePath(fullPath: string): string {
    return simplifyFilePath(fullPath);
  }

  private formatMessage(level: LogLevel, message: string, data?: unknown): string {
    const now = new Date();
    const timestamp = now.toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).replace(/\//g, "-") + "." + String(now.getMilliseconds()).padStart(3, "0");
    const prefix = this.prefix ? `[${this.prefix}]` : "";
    
    // 获取 OTel tracer 中的 traceId
    let traceIdStr = "";
    try {
      const provider = getTracerProvider();
      const tracer = provider.getTracer("roy-tracer");
      const context = tracer.getCurrentContext();
      if (context?.traceId) {
        traceIdStr = `[traceId=${context.traceId}]`;
      }
    } catch {
      // 忽略 tracer 获取失败的情况
    }

    // 检查 data 中是否包含 callerLocation（用于 traced 装饰器传递原函数位置）
    let locationStr = "";
    if (data && typeof data === "object" && "callerLocation" in data) {
      const logData = data as LogData;
      locationStr = logData.callerLocation ? ` [${logData.callerLocation}]` : "";
      // 从 data 中移除 callerLocation，避免它在日志中显示
      const { callerLocation: _callerLocation, ...rest } = logData;
      data = Object.keys(rest).length > 0 ? rest : undefined;
    } else {
      const location = this.getCallerLocation();
      if (location) {
        locationStr = ` [${location.file}:${location.line}]`;
      }
    }

    let formatted = `${timestamp} [${level.toUpperCase()}]${traceIdStr}${locationStr}${prefix} ${message}`;
    
    if (data !== undefined) {
      if (typeof data === "object") {
        // 使用单行 JSON 格式，避免换行
        formatted += " " + JSON.stringify(data).replace(/\n/g, "");
      } else {
        formatted += " " + String(data);
      }
    }
    
    // 应用 maxOutput 截断
    const maxOutput = getMaxOutput();
    if (maxOutput && maxOutput > 0 && formatted.length > maxOutput) {
      formatted = formatted.substring(0, maxOutput) + " [TRUNCATED]";
    }
    
    return formatted;
  }

  private writeToFile(message: string): void {
    try {
      // 实时获取配置，支持热更新
      const dir = getLogDir();
      const filename = getLogFile();
      
      // 解析路径：展开 ~，判断绝对/相对路径
      const expandedDir = expandHomeDir(dir);
      const resolvedDir = isAbsolutePath(expandedDir) ? expandedDir : join(process.cwd(), expandedDir);
      this.ensureLogDirectory(resolvedDir);
      const logFile = join(resolvedDir, filename);
      appendFileSync(logFile, message + "\n", "utf-8");
    } catch (err) {
      console.error("[Logger] Failed to write to log file:", err);
    }
  }

  private log(level: LogLevel, message: string, data?: unknown): void {
    if (!this.shouldLog(level)) return;

    // formatMessage 会处理 callerLocation 并将其从 data 中移除
    // 返回的 formatted 只包含 message 和剩余的 data
    const formatted = this.formatMessage(level, message, data);
    
    // 总是写入文件
    this.writeToFile(formatted);
    
    // 根据安静模式和级别决定是否输出到控制台
    // 注意：不需要额外传递 data，因为 formatted 已包含所有需要的信息
    if (!isQuietMode()) {
      if (stdoutStrictMode) {
        // Task #4619: stdout 归协议（MCP stdio 传输），日志一律走 stderr。
        console.error(formatted);
      } else {
        const consoleMethod = level === "error" ? console.error :
                             level === "warn" ? console.warn :
                             level === "info" ? console.log :
                             console.debug;
        consoleMethod(formatted);
      }
    }
  }

  debug(message: string, data?: unknown): void {
    this.log("debug", message, data);
  }

  info(message: string, data?: unknown): void {
    this.log("info", message, data);
  }

  warn(message: string, data?: unknown): void {
    this.log("warn", message, data);
  }

  error(message: string, data?: unknown): void {
    this.log("error", message, data);
  }
}

// ============================================================================
// 导出
// ============================================================================

const loggerCache = new Map<string, Logger>();

/**
 * 创建或获取 Logger 实例
 * @param prefix Logger 前缀
 * 
 * 日志文件名通过 ConfigComponent 实时读取（log-trace.logging.file）
 */
export function createLogger(prefix: string): Logger {
  // 缓存 key 只用 prefix，因为 filename 通过配置实时读取
  if (!loggerCache.has(prefix)) {
    loggerCache.set(prefix, new Logger(prefix));
  }
  
  return loggerCache.get(prefix)!;
}

/**
 * 获取所有日志级别
 */
export function getLogLevels(): LogLevel[] {
  return ["debug", "info", "warn", "error"];
}

export type { LogLevel, ILogger } from "./types";
