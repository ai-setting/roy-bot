import { z, ZodType, ZodTypeDef } from "zod";

// 前向声明 Environment（避免循环依赖）
import type { Environment } from "./interface";

// 导入 Hook 系统
import { HookManager, createHook, createPriorityHook } from "./hook";
import type { Hook, HookContext, HookPhase, HookMeta, HookFn, HookManagerOptions } from "./hook";

// 导出 Hook 系统
export type { Hook, HookContext, HookPhase, HookMeta, HookFn, HookManagerOptions };
export { HookManager, createHook, createPriorityHook };

/**
 * Component 状态
 */
export type ComponentStatus =
  | "created"
  | "initializing"
  | "running"
  | "stopping"
  | "stopped"
  | "error";

/**
 * Component 配置
 */
export interface ComponentConfig {
  name: string;
  version: string;
  enabled: boolean;
  options?: Record<string, unknown>;
  /**
   * Environment 实例（可选）
   * 
   * 推荐在 init 时接收 env 实例，以便：
   * - 通过 env.getComponent() 获取其他组件
   * - 通过 env.pushEnvEvent() 发布事件
   * - 通过 env.handle_query() 处理查询
   * 
   * 如果未提供，部分 Component 仍可正常工作（如测试场景）
   * 
   * @example
   * ```typescript
   * async onInit(): Promise<void> {
   *   if (this.env) {
   *     const configComp = this.env.getComponent("config");
   *   }
   * }
   * ```
   */
  env?: Environment;
}

/**
 * Component 路径声明
 */
export interface ComponentPaths {
  base: "config" | "state" | "data" | "cache";
  subPath: string;
  isDirectory: boolean;
}

/**
 * Component Schema（注册配置）
 */
export interface ComponentSchema {
  /** Component 名称 */
  name: string;

  /** 配置 Schema（Zod） */
  schema: ZodType<unknown, ZodTypeDef, unknown>;

  /** 默认值（从 Schema 提取） */
  defaults: Record<string, unknown>;

  /** 路径声明 */
  paths?: Record<string, ComponentPaths>;

  /** 元信息 */
  metadata?: {
    description?: string;
    version?: string;
    author?: string;
  };
}

/**
 * Component 配置变更事件
 */
export interface ComponentConfigChangeEvent {
  /** Component 名称 */
  component: string;

  /** 变更的配置键 */
  key: string;

  /** 旧值 */
  oldValue: unknown;

  /** 新值 */
  newValue: unknown;

  /** 是否持久化 */
  persisted: boolean;

  /** 时间戳 */
  timestamp: number;
}

/**
 * Component 配置监听回调
 */
export type ComponentWatchCallback = (
  event: ComponentConfigChangeEvent
) => void | Promise<void>;

/**
 * Component 基类接口
 */
export interface Component {
  /** Component 名称 */
  readonly name: string;

  /** Component 版本 */
  readonly version: string;

  /** 获取状态 */
  getStatus(): ComponentStatus;

  /** 获取配置 */
  getConfig(): ComponentConfig;

  /** 初始化 */
  init(config: ComponentConfig): Promise<void>;

  /** 启动 */
  start(): Promise<void>;

  /** 停止 */
  stop(): Promise<void>;
}

/**
 * Component 基类实现
 */
export abstract class BaseComponent implements Component {
  abstract readonly name: string;
  abstract readonly version: string;

  protected _status: ComponentStatus = "created";
  protected _enabled: boolean = true;
  protected env!: Environment;  // 非可选，使用 definite assignment assertion

  /** Hook 管理器 - 子类初始化时由构造函数设置 */
  public readonly hookManager: HookManager;

  constructor() {
    // 创建 HookManager，稍后在 init 中更新组件信息
    this.hookManager = new HookManager();
  }

  getStatus(): ComponentStatus {
    return this._status;
  }

  getConfig(): ComponentConfig {
    return {
      name: this.name,
      version: this.version,
      enabled: this._enabled,
      env: this.env,
    };
  }
  
  /**
   * 检查 Environment 是否已初始化
   */
  protected isEnvInitialized(): boolean {
    return this._status !== "created";
  }

  protected setStatus(status: ComponentStatus): void {
    this._status = status;
  }

  /**
   * 获取 Environment 实例
   */
  protected getEnv(): Environment {
    return this.env;
  }

  async init(config?: ComponentConfig): Promise<void> {
    // 如果提供了 env，则注入
    if (config?.env) {
      this.env = config.env;
    }
    
    this.setStatus("initializing");
    
    // 只有当 name/version 未在子类中定义时才从 config 注入
    // 注意：如果子类已定义这些属性，Object.defineProperty 会失败
    try {
      if (config?.name) Object.defineProperty(this, "name", { value: config.name, writable: false });
      if (config?.version) Object.defineProperty(this, "version", { value: config.version, writable: false });
    } catch {
      // 忽略错误（属性可能已在子类中定义）
    }
    if (config?.enabled !== undefined) this._enabled = config.enabled;
    
    // 更新 HookManager 的组件信息
    this.hookManager.setComponentInfo(this.name, this.version);
    
    await this.onInit();
    this.setStatus("running");
  }

  async start(): Promise<void> {
    // 使用内部标志跟踪 start() 是否已调用
    // 这是必要的，因为 init() 会将状态设为 "running"，但组件的 start() 仍需被调用
    if ((this as any)._started) return;
    (this as any)._started = true;
    
    await this.onStart();
    this.setStatus("running");
  }

  async stop(): Promise<void> {
    this.setStatus("stopping");
    
    // 清理 Hooks
    this.hookManager.clear();
    
    await this.onStop();
    this.setStatus("stopped");
  }

  /**
   * 子类可覆盖的钩子方法
   */
  protected async onInit(): Promise<void> {}
  protected async onStart(): Promise<void> {}
  protected async onStop(): Promise<void> {}

  // ========================================================================
  // Hook 便捷方法
  // ========================================================================

  /**
   * 注册 Hook
   * 
   * @param hookPoint Hook 点名称
   * @param hook Hook 实例
   */
  protected registerHook<T = unknown>(hookPoint: string, hook: Hook<T>): void {
    this.hookManager.register(hookPoint, hook);
  }

  /**
   * 便捷方法：快速注册 Hook
   */
  protected addHook<T = unknown>(
    hookPoint: string,
    name: string,
    fn: HookFn<T>,
    priority?: number
  ): void {
    this.hookManager.register(
      hookPoint,
      createHook({ name, priority }, fn)
    );
  }

  /**
   * 便捷方法：按名称取消注册 Hook
   */
  protected removeHook(hookPoint: string, name: string): boolean {
    return this.hookManager.unregister(hookPoint, name);
  }

  /**
   * 执行 Hook
   */
  protected async executeHooks<T = unknown>(
    hookPoint: string,
    data: T,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    await this.hookManager.execute(hookPoint, data, metadata);
  }

  // ========================================================================
  // 配置统一管理方法
  // ========================================================================

  /**
   * 获取 ConfigComponent 实例
   * 
   * 子类可使用此方法获取配置组件，支持热更新
   */
  protected getConfigComponent(): { get(key: string): unknown } | undefined {
    return this.env?.getComponent("config") as unknown as { get(key: string): unknown } | undefined;
  }

  /**
   * 动态获取运行时配置值
   * 
   * 优先从 ConfigComponent 获取（支持热更新），否则返回默认值
   * 适用于运行时可能变化的配置（如 API Keys、模型参数）
   * 
   * @param key 配置键（支持点号分隔的路径，如 "llm.temperature"）
   * @param defaultValue 默认值
   * @returns 配置值或默认值
   * 
   * @example
   * ```typescript
   * // 获取 LLM 温度配置（可能支持热更新）
   * const temperature = this.getRuntimeConfig("llm.temperature", 0.7);
   * 
   * // 获取 API Key
   * const apiKey = this.getRuntimeConfig<string>("llm.providers.openai.apiKey");
   * ```
   */
  protected getRuntimeConfig<T>(key: string, defaultValue: T): T {
    const configComponent = this.getConfigComponent();
    if (configComponent) {
      const value = configComponent.get(key);
      if (value !== undefined) {
        return value as T;
      }
    }
    return defaultValue;
  }
}
