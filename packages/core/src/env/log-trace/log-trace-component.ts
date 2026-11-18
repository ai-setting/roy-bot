/**
 * @fileoverview Log & Trace Component
 * 
 * 提供日志和追踪的统一组件封装
 * 
 * 配置通过 ConfigComponent 实时获取，支持配置热更新
 */

import { 
  BaseComponent, 
  type ComponentConfig, 
  type ComponentSchema,
} from "../component";
import { z } from "zod";
import { join } from "path";
import { createLogger, setQuietMode, setConfigComponent, type LogLevel } from "./logger";
import { getTracerProvider, type OTelTracer } from "./opentelemetry/tracer-provider";
import { SQLiteSpanStorage, type SpanStorage } from "./span-storage";
import { initTraceContext, type ITraceContext } from "./trace-context";
import type { ConfigComponent } from "../../config/config-component";
import { envKeyToConfigKey } from "../../config/env-key";
import { LOG_TRACE_CONFIG_REGISTRATION, LOG_TRACE_DEFAULTS } from "./log-trace-config-registration";

// ============================================================================
// Default Paths (based on XDG_DATA_HOME)
// ============================================================================

/**
 * 获取默认数据目录（基于 XDG 标准）
 */
function getDefaultDataDir(): string {
  // 尝试使用 xdg-basedir
  try {
    const xdg = require("xdg-basedir");
    if (xdg.xdgData) {
      return xdg.xdgData;
    }
  } catch {}
  
  // 回退到 ~/.local/share
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  return join(home, ".local", "share");
}

/**
 * 获取默认日志目录（基于 XDG 标准）
 * 存储在 XDG_DATA_HOME/roy-bot/logs/
 */
export function getDefaultLogDir(): string {
  return join(getDefaultDataDir(), "roy-bot", "logs");
}

/**
 * 获取默认的 span 数据库路径（基于 XDG 标准）
 * 存储在 XDG_DATA_HOME/roy-bot/traces.db
 */
export function getDefaultSpanDbPath(): string {
  return join(getDefaultDataDir(), "roy-bot", "traces.db");
}

// ============================================================================
// Config Schema
// ============================================================================

/**
 * Log & Trace Component 配置 Schema
 */
export const LogTraceConfigSchema = z.object({
  /** 是否启用日志 */
  logging: z.object({
    enabled: z.boolean().default(true),
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    quiet: z.boolean().default(false),
    file: z.string().default("app.log"),
    dir: z.string().default(getDefaultLogDir()),
    /** 日志输出最大长度（0 表示不限制） */
    maxOutput: z.number().default(0),
  }).default({}),
  
  /** 是否启用追踪 */
  tracing: z.object({
    enabled: z.boolean().default(true),
    dbPath: z.string().optional(),
  }).default({}),
  
  /** 初始化请求上下文 */
  initContext: z.object({
    requestId: z.string().optional(),
    sessionId: z.string().optional(),
  }).optional(),
});

export type LogTraceConfig = z.infer<typeof LogTraceConfigSchema>;

/**
 * LogTraceComponent 配置选项（通过 options 传递）
 * 
 * 配置加载顺序（优先级从低到高）：
 * 1. File - 配置文件（通过 configPath 指定）
 * 2. Env - 环境变量（通过 envPrefix 配置前缀）
 * 3. Object - 直接传入的 config 对象（最高优先级）
 */
export interface LogTraceComponentOptions {
  /** ConfigComponent 实例（必填） */
  configComponent: ConfigComponent;
  
  /** 配置文件相对路径（可选，基于 XDG_DATA_HOME） */
  configPath?: string;
  
  /** 环境变量前缀（可选，默认 "LOG"） */
  envPrefix?: string;
  
  /**
   * 项目根目录（可选，默认 process.cwd()）
   * 用于加载 ${cwd}/.roy/config.jsonc 项目级配置
   */
  cwd?: string;
  
  /** 回调函数 */
  callbacks?: {
    onLogLevelChange?: (level: LogLevel) => void;
  };
  
  /** 直接传入的配置对象（可选，优先级最高） */
  config?: Partial<LogTraceConfig>;
}

// ============================================================================
// Component
// ============================================================================

/**
 * Log & Trace Component
 * 
 * 提供统一的日志和追踪能力
 * 配置通过 ConfigComponent 实时获取，支持配置热更新
 * 
 * @example
 * // 通过 ConfigComponent 初始化
 * const configComponent = new ConfigComponent();
 * const component = new LogTraceComponent();
 * await component.init({
 *   env,  // Environment 实例（必填）
 *   options: { configComponent }
 * });
 * 
 * // 配置更新后，日志级别会自动热更新
 * configComponent.set("log-trace.logging.level", "debug");
 * 
 * // 初始化追踪上下文
 * component.initContext("request-123", "session-456");
 * 
 * // 使用日志
 * component.getLogger().info("Hello, world!");
 * 
 * // 使用追踪
 * const span = component.getTracer().startSpan("my-span");
 * component.getTracer().endSpan(span);
 */
export class LogTraceComponent extends BaseComponent {
  readonly name = "log-trace";
  readonly version = "1.0.0";

  private config?: LogTraceConfig;
  private configComponent?: ConfigComponent;
  private tracer?: OTelTracer;
  private traceContext?: ITraceContext;
  
  /** 配置变更 watcher 清理函数 */
  private configWatcher?: () => void;

  constructor() {
    super();
  }

  /**
   * 初始化组件
   * 
   * 配置加载优先级（从高到低）：
   * 1. Object - 直接传入的 config 对象
   * 2. Env - 环境变量（通过 envPrefix 配置前缀）
   * 3. File - 配置文件（通过 configPath 指定）
   */
  async init(config: ComponentConfig): Promise<void> {
    // 调用基类 init，注入 env
    await super.init(config);

    // 从 options 获取 ConfigComponent
    const options = config.options as unknown as LogTraceComponentOptions | undefined;
    if (!options?.configComponent) {
      throw new Error("ConfigComponent is required for LogTraceComponent initialization");
    }

    this.configComponent = options.configComponent;
    await this.registerConfig(options);

    // 初始化 Trace Context
    this.traceContext = initTraceContext();

    // 初始化 Tracer (OTel)
    const provider = getTracerProvider();
    // TODO: 这里后续要统一使用 "roy-tracer"，但需要先重构为单例模式
    // 目前保留原有 tracer 名称以避免破坏现有功能
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _unused = provider;
    await provider.initialize();
    this.tracer = provider.getTracer("roy-tracer");

    // 配置日志
    this.configureLogging();

    // 初始化请求上下文（如果配置了）
    if (this.config?.initContext?.requestId) {
      this.traceContext.initContext(
        this.config.initContext.requestId,
        this.config.initContext.sessionId
      );
    }

    this.setStatus("running");
  }

  /**
   * 注册配置到 ConfigComponent
   * 
   * 遵循 SessionComponent 模式：
   * 1. 使用 registerComponent 注册配置结构
   * 2. 使用 load 加载配置
   * 3. 设置默认值
   * 4. 处理环境变量后备方案
   * 5. 处理 config 对象
   * 
   * 配置加载顺序（优先级从低到高）：
   * 1. FileSource - 从配置文件加载（最低）
   * 2. EnvSource - 从环境变量加载（中等）
   * 3. MemorySource - 直接配置对象（最高）
   */
  private async registerConfig(options: LogTraceComponentOptions): Promise<void> {
    const configComponent = options.configComponent;
    if (!configComponent) return;

    const { configPath, envPrefix, cwd, config } = options;
    const prefix = envPrefix !== undefined ? envPrefix : "LOG_TRACE";
    const projectCwd = cwd ?? process.cwd();

    // 1. 使用 registerComponent 注册配置结构（keys 和 sources）
    configComponent.registerComponent(LOG_TRACE_CONFIG_REGISTRATION);

    // 2. 注册项目级配置 source（${cwd}/.roy/config.jsonc）
    //    - 高优先级 25（高于 env=20，高于 file=10）
    //    - 文件不存在时静默跳过（registerSource 内部用 optional: true 处理）
    //    - 默认不监听（项目级配置变更需重启生效）
    configComponent.registerProjectSource({ cwd: projectCwd });

    // 3. 注册 FileSource（如果提供了 configPath）
    if (configPath) {
      configComponent.registerSource({
        type: "file",
        relativePath: configPath,
        optional: true,
        watch: false
      });
    }

    // 4. 注册 EnvSource
    configComponent.registerSource({
      type: "env",
      envPrefix: prefix,
      priority: 20,
      watch: false
    });
    
    // 5. 从 sources 加载配置（FileSource 和 EnvSource）
    await configComponent.load("log-trace");
    
    // 5. 后备方案：直接读取环境变量（确保所有环境变量都被处理）
    for (const envKey of Object.keys(process.env)) {
      const configKey = envKeyToConfigKey(envKey, prefix, "log-trace");
      if (!configKey) continue;
      const value = process.env[envKey];
      if (value !== undefined) {
        await configComponent.set(configKey, value);
      }
    }

    // 6. 设置静态默认值（只有当配置不存在时）
    for (const [key, value] of Object.entries(LOG_TRACE_DEFAULTS)) {
      if (configComponent.get(key) === undefined) {
        await configComponent.set(key, value);
      }
    }
    
    // 7. 特殊处理动态默认值（这些无法在 defaults 中定义）
    if (configComponent.get("log-trace.logging.dir") === undefined) {
      await configComponent.set("log-trace.logging.dir", getDefaultLogDir());
    }
    if (configComponent.get("log-trace.logging.file") === undefined) {
      await configComponent.set("log-trace.logging.file", "app.log");
    }
    if (configComponent.get("log-trace.logging.maxOutput") === undefined) {
      await configComponent.set("log-trace.logging.maxOutput", 0);
    }
    if (configComponent.get("log-trace.tracing.dbPath") === undefined) {
      await configComponent.set("log-trace.tracing.dbPath", getDefaultSpanDbPath());
    }

    // 8. 直接配置对象（最高优先级）
    if (config) {
      const flatConfig = this.flattenConfig(config);
      for (const [key, value] of Object.entries(flatConfig)) {
        await configComponent.set(key, value);
      }
    }

    // 9. 注册配置热更新监听
    this.registerConfigWatcher(configComponent);
    
    // 10. 设置全局 ConfigComponent（让 logger 可以读取配置）
    setConfigComponent(configComponent);
    
    // 11. 解析最终配置
    // 如果 tracing.dbPath 未配置，使用默认值
    const tracingDbPath = configComponent.get("log-trace.tracing.dbPath") as string | undefined;
    this.config = {
      logging: {
        enabled: (configComponent.get("log-trace.logging.enabled") as boolean) ?? true,
        level: (configComponent.get("log-trace.logging.level") as LogLevel) ?? "info",
        quiet: (configComponent.get("log-trace.logging.quiet") as boolean) ?? false,
        file: (configComponent.get("log-trace.logging.file") as string) ?? "app.log",
        dir: (configComponent.get("log-trace.logging.dir") as string) ?? getDefaultLogDir(),
        maxOutput: (configComponent.get("log-trace.logging.maxOutput") as number) ?? 0,
      },
      tracing: {
        enabled: (configComponent.get("log-trace.tracing.enabled") as boolean) ?? true,
        dbPath: tracingDbPath ?? getDefaultSpanDbPath(),
      },
    };
  }

  /**
   * 将配置对象展平为点号路径
   */
  private flattenConfig(
    obj: Record<string, unknown>,
    prefix = "log-trace"
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
    
    this.configWatcher = configComponent.watch("log-trace.*", (event) => {
      this.onConfigChange(event);
    });
  }

  /**
   * 处理配置变更
   */
  protected onConfigChange(event: { key: string; oldValue?: unknown; newValue?: unknown }): void {
    if (event.key === "log-trace.logging.quiet") {
      setQuietMode(event.newValue as boolean);
    }
  }

  /**
   * 创建存储实例
   * 
   * @throws Error 如果未配置 dbPath
   */
  private createStorage(): SpanStorage {
    // 优先从 ConfigComponent 获取 dbPath
    if (this.configComponent) {
      const dbPath = this.configComponent.get("log-trace.tracing.dbPath") as string | undefined;
      if (dbPath) {
        return new SQLiteSpanStorage(dbPath);
      }
    }

    // 降级到本地配置
    if (this.config?.tracing?.dbPath) {
      return new SQLiteSpanStorage(this.config.tracing.dbPath);
    }

    // 最后使用默认值
    return new SQLiteSpanStorage(getDefaultSpanDbPath());
  }

  /**
   * 配置日志系统
   * 
   * 默认 quiet 模式开启，除非显式设置为 false
   */
  private configureLogging(): void {
    if (!this.config?.logging) {
      // 如果没有 logging 配置，默认开启 quiet
      setQuietMode(true);
      return;
    }

    if (this.config.logging.quiet !== false) {
      // 默认 quiet 开启（quiet 为 true 或 undefined）
      setQuietMode(true);
    }
  }

  /**
   * 初始化追踪上下文
   * 
   * @param requestId 请求 ID
   * @param sessionId 会话 ID（可选）
   */
  initContext(requestId: string, sessionId?: string): void {
    if (!this.traceContext) {
      throw new Error("Component not initialized");
    }
    this.traceContext.initContext(requestId, sessionId);
  }

  /**
   * 创建新的追踪上下文（返回清理函数）
   * 
   * @param requestId 请求 ID
   * @param sessionId 会话 ID（可选）
   */
  startContext(requestId: string, sessionId?: string): () => void {
    if (!this.traceContext) {
      throw new Error("Component not initialized");
    }
    return this.traceContext.startNewContext(requestId, sessionId);
  }

  /**
   * 获取 Logger
   * 
   * @param prefix 日志前缀
   */
  getLogger(prefix?: string): ReturnType<typeof createLogger> {
    return createLogger(prefix || "app");
  }

  /**
   * 获取 Tracer
   */
  getTracer(): OTelTracer {
    if (!this.tracer) {
      throw new Error("Component not initialized");
    }
    return this.tracer;
  }

  /**
   * 获取 Trace Context
   */
  getTraceContext(): ITraceContext | undefined {
    return this.traceContext;
  }

  /**
   * 获取当前 requestId
   */
  getRequestId(): string | undefined {
    return this.traceContext?.getRequestId();
  }

  /**
   * 停止组件
   */
  async onStop(): Promise<void> {
    // 清理配置 watcher
    this.configWatcher?.();
    this.configWatcher = undefined;
    
    // 清理 tracer
    this.tracer = undefined;
    this.setStatus("stopped");
  }
}

// ============================================================================
// Component Schema
// ============================================================================

/**
 * Log & Trace Component Schema
 */
export const logTraceComponentSchema: ComponentSchema = {
  name: "log-trace",
  schema: LogTraceConfigSchema,
  defaults: {
    logging: { enabled: true, level: "info", quiet: false, file: "app.log" },
    tracing: { enabled: true },
  },
  metadata: {
    description: "Log & Trace Component - Unified logging and tracing",
    version: "1.0.0",
    author: "roy-bot",
  },
};
