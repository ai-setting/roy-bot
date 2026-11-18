/**
 * EventSourceComponent - 基于 Handler 注册机制的重构版本
 * 
 * 这个文件包含重构后的 EventSourceComponent 实现
 * 使用 Handler 注册模式替代原来的 switch-case 硬编码
 */

import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { BaseComponent, type ComponentConfig, type ComponentStatus } from "../component";
import type { ConfigComponent } from "../../config/config-component";
import { toEnvKey, envKeyToConfigKey } from "../../config/env-key";
import { createLogger } from "../log-trace/logger";
import { TracedAs } from "../log-trace/decorator";
import { EVENT_SOURCE_CONFIG_REGISTRATION, EVENT_SOURCE_DEFAULTS } from "./event-source-config-registration";
import type { 
  EventSourceConfig, 
  EventSourceStatus, 
  EventSourceEvent,
  EventSourceEventHandler,
  EventSourceType,
  EventSourcePersistenceConfig,
  EventSourceHandler,
  EventSourceInstance,
  EventSourceComponentInterface,
  EventSourceInitHook,
} from "./types";
import { 
  larkCliHandler, 
  builtInHandlers,
} from "./event-source-handlers";
import {
  snapshotConfigDir,
  appendAuditLog,
  checkSourceCountDrop,
  readSourceCountFromDisk,
} from "../../config/config-protection";

const logger = createLogger("event-source");

// ============================================================================
// 类型定义
// ============================================================================

/**
 * EventSourceComponent 配置选项
 */
export interface EventSourceComponentOptions {
  /** ConfigComponent 实例（必填） */
  configComponent: ConfigComponent;

  /** 配置文件相对路径（可选） */
  configPath?: string;

  /** 直接传入的配置对象（可选，优先级最高） */
  config?: Partial<EventSourceConfigOptions>;

  /** 是否自动注册内置 Handler（默认 true） */
  registerBuiltInHandlers?: boolean;
}

/**
 * EventSourceComponent.update() 的返回结果
 */
export interface EventSourceUpdateResult {
  /** 事件源 ID */
  id: string;
  /** 更新后的完整配置 */
  updated: EventSourceConfig;
  /** 更新前是否处于 running 状态 */
  wasRunning: boolean;
  /** 是否实际调用了 stopSource */
  stopped: boolean;
  /** 是否自动重启（当前实现恒为 false，由用户手动 start 生效） */
  restarted: boolean;
  /** 本次更新的字段名列表 */
  fields: string[];
}


/**
 * EventSourceComponent 内部配置
 */
interface EventSourceConfigOptions {
  enabled: boolean;
  persistenceEnabled: boolean;
  configPath: string;
}

// ============================================================================
// EventSourceComponent
// ============================================================================

/**
 * EventSourceComponent
 * 
 * 事件源组件，管理所有事件源的注册、配置和生命周期
 * 
 * 使用 Handler 注册机制，支持动态扩展事件源类型
 */
export class EventSourceComponent 
  extends BaseComponent 
  implements EventSourceComponentInterface 
{
  readonly name = "event-source";
  readonly version = "1.0.0";

  // 内部状态
  private sources: Map<string, EventSourceConfig> = new Map();
  private statuses: Map<string, EventSourceStatus> = new Map();
  private handlers: Map<string, EventSourceHandler> = new Map();
  private instances: Map<string, EventSourceInstance> = new Map();
  private eventHandlers: Map<string, EventSourceEventHandler> = new Map();
  private buffers: Map<string, string> = new Map();

  // 持久化配置
  private configPath: string = "";
  private persistenceEnabled: boolean = true;

  constructor() {
    super();
    // ★ 测试环境守卫：构造期即应用（Task #5181）。
    //   防住「测试中 new EventSourceComponent() 后未走 init() 直接
    //   register()/saveConfig()」的场景 —— register 内部 fire-and-forget
    //   调 saveConfig()，若等 init() 才应用守卫就晚了。
    //   init() 成功路径会再次调用（幂等），覆盖配置驱动的 persistenceEnabled。
    this.applyTestEnvironmentGuard();
  }

  /**
   * 测试环境守卫（Task #5181，2026-11-07/11-08 事故防再发）
   *
   * 事故：测试中实例化 EventSourceComponent 并触发 saveConfig()，
   * 覆盖了生产 ~/.roy-bot/event-sources.json（10 个真实事件源配置差点丢失）。
   *
   * 规则：
   *   - 测试环境（NODE_ENV=test 或存在 BUN_TEST_WORKER_ID）⇒ persistence=false
   *     （只内存不落盘，绝不触碰真实 $HOME/.roy-bot/）
   *   - 显式 opt-out：ROY_AGENT_ES_PERSISTENCE=1 可在测试中强制开启持久化
   *     （用于守卫自身可测 / 隔离 HOME 的持久化测试）
   */
  static isTestEnvironment(): boolean {
    return process.env.NODE_ENV === "test" || "BUN_TEST_WORKER_ID" in process.env;
  }

  private applyTestEnvironmentGuard(): void {
    if (this.persistenceEnabled && EventSourceComponent.isTestEnvironment()) {
      if (process.env.ROY_AGENT_ES_PERSISTENCE === "1") {
        logger.debug("EventSource persistence opt-out active in test env (ROY_AGENT_ES_PERSISTENCE=1)");
        return;
      }
      this.persistenceEnabled = false;
      logger.debug(
        "EventSource persistence disabled by test-environment guard (Task #5181)",
      );
    }
  }
  
  /** ConfigComponent 用于配置管理 */
  private configComponent?: ConfigComponent;
  
  /** 配置热更新 watcher 清理函数 */
  private configWatcher?: () => void;

  // ========================================================================
  // 组件生命周期
  // ========================================================================

  /**
   * 初始化
   */
  protected async onInit(): Promise<void> {
    // 1. 执行所有注册的 hooks（允许第三方注册 Handler）
    await this.executeInitHooks();

    // 2. 加载已保存的事件源配置
    await this.loadConfig();
  }
  
  /**
   * 公开的初始化方法
   */
  async init(options?: ComponentConfig): Promise<void> {
    if (options?.env) {
      this.env = options.env;
    }
    
    this.setStatus("initializing");
    
    if (options?.name) Object.defineProperty(this, "name", { value: options.name, writable: false });
    if (options?.version) Object.defineProperty(this, "version", { value: options.version, writable: false });
    if (options?.enabled !== undefined) this._enabled = options.enabled;
    
    const opts = options?.options as unknown as EventSourceComponentOptions | undefined;
    if (opts?.configComponent) {
      this.configComponent = opts.configComponent;
      await this.registerConfig(opts);
      
      // 注册内置 Handler（如果没有禁用）
      if (opts.registerBuiltInHandlers !== false) {
        this.registerBuiltInHandlers();
      }
    } else {
      throw new Error("ConfigComponent is required for EventSourceComponent initialization");
    }
    
    await this.onInit();
    this.setStatus("running");

    // ★ 测试环境守卫：init 完成后、任何 saveConfig/loadConfig 生效前应用
    this.applyTestEnvironmentGuard();
  }

  protected async onStart(): Promise<void> {
    // noop
  }

  protected async onStop(): Promise<void> {
    this.configWatcher?.();
    this.configWatcher = undefined;
    
    // 停止所有运行中的事件源
    const runningSources = Array.from(this.statuses.entries())
      .filter(([_, status]) => status === "running")
      .map(([id]) => id);

    for (const id of runningSources) {
      await this.stopSource(id);
    }

    // 清空所有状态
    this.sources.clear();
    this.statuses.clear();
    this.instances.clear();
    this.eventHandlers.clear();
    this.handlers.clear();
    this.buffers.clear();
  }

  // ========================================================================
  // Handler 注册机制
  // ========================================================================

  /**
   * 创建默认的事件处理器
   * 
   * 当没有用户注册的 handler 时使用，将事件转发到 env.pushEnvEvent
   */
  private createDefaultEventHandler(sourceId: string, sourceType: string): EventSourceEventHandler {
    // EventSourceEvent 本身就是 EnvEvent，直接转发
    return (event) => {
      this.getEnv()?.pushEnvEvent(event);
    };
  }

  /**
   * 注册内置 Handler
   */
  private registerBuiltInHandlers(): void {
    for (const handler of builtInHandlers) {
      if (!this.handlers.has(handler.type)) {
        this.handlers.set(handler.type, handler);
        logger.debug(`Registered built-in handler: ${handler.type}`);
      }
    }
  }

  /**
   * 执行初始化钩子
   * 
   * 调用所有注册的 EventSourceInitHook，允许第三方扩展 Handler
   */
  private async executeInitHooks(): Promise<void> {
    const { EventSourceInitHooks } = await import("./types");
    await EventSourceInitHooks.execute(this);
  }

  /**
   * 注册 Handler
   */
  registerHandler(handler: EventSourceHandler): void {
    if (this.handlers.has(handler.type)) {
      logger.warn(`Handler already registered for type: ${handler.type}, overwriting`);
    }
    this.handlers.set(handler.type, handler);
    logger.debug(`Handler registered: ${handler.type}`);
  }

  /**
   * 注销 Handler
   */
  unregisterHandler(type: string): boolean {
    const deleted = this.handlers.delete(type);
    if (deleted) {
      logger.debug(`Handler unregistered: ${type}`);
    }
    return deleted;
  }

  /**
   * 获取 Handler
   */
  getHandler(type: string): EventSourceHandler | undefined {
    return this.handlers.get(type);
  }

  /**
   * 列出所有 Handler
   */
  listHandlers(): EventSourceHandler[] {
    return Array.from(this.handlers.values());
  }

  // ========================================================================
  // 配置注册
  // ========================================================================

  /**
   * 注册配置到 ConfigComponent
   */
  private async registerConfig(options: EventSourceComponentOptions): Promise<void> {
    const configComponent = options.configComponent;
    if (!configComponent) return;

    const { configPath, config } = options;
    const envPrefix = "EVENT_SOURCE";

    configComponent.registerComponent(EVENT_SOURCE_CONFIG_REGISTRATION);

    if (configPath) {
      configComponent.registerSource({
        type: "file",
        relativePath: configPath,
        optional: true,
        watch: false
      });
    }

    configComponent.registerSource({
      type: "env",
      envPrefix: envPrefix,
      priority: 20,
      watch: false
    });
    
    await configComponent.load("event-source");
    
    for (const envKey of Object.keys(process.env)) {
      const configKey = envKeyToConfigKey(envKey, envPrefix, "event-source");
      if (!configKey) continue;
      const value = process.env[envKey];
      if (value !== undefined) {
        await configComponent.set(configKey, value);
      }
    }

    for (const [key, value] of Object.entries(EVENT_SOURCE_DEFAULTS)) {
      if (configComponent.get(key) === undefined) {
        await configComponent.set(key, value);
      }
    }

    if (configComponent.get("event-source.configPath") === undefined) {
      const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
      const dataDir = join(home, ".roy-bot");
      await configComponent.set("event-source.configPath", join(dataDir, "event-sources.json"));
    }

    if (config) {
      const flatConfig = this.flattenConfig(config);
      for (const [key, value] of Object.entries(flatConfig)) {
        await configComponent.set(key, value);
      }
    }

    this.registerConfigWatcher(configComponent);
  }

  private buildConfig(): EventSourceConfigOptions {
    const configComponent = this.configComponent;
    if (!configComponent) {
      return { enabled: true, persistenceEnabled: true, configPath: "" };
    }
    return {
      enabled: configComponent.get("event-source.enabled") as boolean ?? true,
      persistenceEnabled: configComponent.get("event-source.persistenceEnabled") as boolean ?? true,
      configPath: configComponent.get("event-source.configPath") as string ?? "",
    };
  }

  private flattenConfig(obj: Record<string, unknown>, prefix = "event-source"): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const fullKey = `${prefix}.${key}`;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        Object.assign(result, this.flattenConfig(value as Record<string, unknown>, fullKey));
      } else {
        result[fullKey] = value;
      }
    }
    return result;
  }

  private registerConfigWatcher(configComponent: ConfigComponent): void {
    if (typeof configComponent.watch !== "function") return;
    this.configWatcher = configComponent.watch("event-source.*", (event) => {
      this.onConfigChange(event);
    });
  }

  protected onConfigChange(event: { key: string; oldValue?: unknown; newValue?: unknown }): void {
    logger.info(`EventSource config changed: ${event.key}`, {
      oldValue: event.oldValue,
      newValue: event.newValue
    });
  }

  // ========================================================================
  // 事件源注册与管理
  // ========================================================================

  /**
   * 注册事件源
   */
  register(config: EventSourceConfig): void {
    if (this.sources.has(config.id)) {
      throw new Error(`EventSource already exists: ${config.id}`);
    }
    
    // 验证 Handler 存在
    const handler = this.handlers.get(config.type);
    if (!handler) {
      throw new Error(`No handler registered for event source type: ${config.type}`);
    }
    
    // 验证配置
    const errors = handler.validateConfig(config);
    if (errors.length > 0) {
      throw new Error(`Invalid config: ${errors.join(", ")}`);
    }
    
    this.sources.set(config.id, config);
    this.statuses.set(config.id, "created");
    logger.debug(`EventSource registered: ${config.id} (${config.type})`);
    
    this.saveConfig().catch((err) => {
      logger.error(`Failed to save config after registering ${config.id}:`, err);
    });
  }

  /**
   * 注销事件源
   */
  unregister(id: string): boolean {
    const status = this.statuses.get(id);
    if (status === "running") {
      this.stopSource(id);
    }

    const existed = this.sources.has(id);
    this.sources.delete(id);
    this.statuses.delete(id);
    this.instances.delete(id);
    this.eventHandlers.delete(id);
    this.buffers.delete(id);

    if (existed) {
      logger.debug(`EventSource unregistered: ${id}`);
      this.saveConfig().catch((err) => {
        logger.error(`Failed to save config after unregistering ${id}:`, err);
      });
    }
    return existed;
  }

  /**
   * 更新事件源
   *
   * 行为：
   * - 只更新 partial 中明确出现的字段，其他字段保留
   * - 如果事件源正在 running，先 stop（不自动重启）
   * - 修改后调用 saveConfig() 持久化
   * - 找不到 id 抛出明确错误
   * - type 字段不允许修改
   *
   * @param id 事件源 ID
   * @param partial 要更新的字段子集
   * @returns 更新结果
   */
  @TracedAs("event-source.update", { recordParams: false, log: false })
  async update(
    id: string,
    partial: Partial<EventSourceConfig>,
  ): Promise<EventSourceUpdateResult> {
    if (!partial || Object.keys(partial).length === 0) {
      throw new Error("update() partial must not be empty");
    }

    const existing = this.sources.get(id);
    if (!existing) {
      throw new Error(`EventSource not found: ${id}`);
    }

    // type 字段禁止修改
    if (Object.prototype.hasOwnProperty.call(partial, "type")) {
      if (partial.type !== existing.type) {
        throw new Error(
          `Cannot update event source type: ${existing.type} -> ${partial.type} (use unregister + register instead)`,
        );
      }
    }

    const wasRunning = this.statuses.get(id) === "running";
    let stopped = false;

    // 如果正在 running，先 stop（不自动重启）
    if (wasRunning) {
      await this.stopSource(id);
      stopped = true;
    }

    // 应用 partial 更新（保留其他字段）
    const updated: EventSourceConfig = {
      ...existing,
      ...partial,
      // id 永远不可变
      id: existing.id,
      // type 已被上面的校验保护，这里强制使用原值
      type: existing.type,
    };

    // 通过 handler 重新校验配置
    const handler = this.handlers.get(existing.type);
    if (handler) {
      const errors = handler.validateConfig(updated);
      if (errors.length > 0) {
        throw new Error(`Invalid config after update: ${errors.join(", ")}`);
      }
    }

    this.sources.set(id, updated);
    logger.info(`EventSource updated: ${id}`, {
      fields: Object.keys(partial),
    });

    // 持久化
    try {
      await this.saveConfig();
    } catch (err) {
      logger.error(`Failed to save config after updating ${id}:`, err);
      throw err;
    }

    return {
      id,
      updated,
      wasRunning,
      stopped,
      restarted: false, // 当前实现不自动重启
      fields: Object.keys(partial),
    };
  }

  get(id: string): EventSourceConfig | undefined {
    return this.sources.get(id);
  }

  list(): EventSourceConfig[] {
    return Array.from(this.sources.values());
  }

  /**
   * 获取事件源状态
   *
   * Overload 1: 无参 → 返回组件级状态（继承自 BaseComponent.getStatus）
   * Overload 2: 带 id → 返回指定事件源状态
   */
  getStatus(): ComponentStatus;
  getStatus(id: string): EventSourceStatus | undefined;
  getStatus(id?: string): ComponentStatus | EventSourceStatus | undefined {
    if (id === undefined) {
      return this._status;
    }
    return this.statuses.get(id);
  }

  /**
   * 获取事件源状态（别名，兼容旧 API）
   * @deprecated 使用 getStatus(id) 代替
   */
  getEventSourceStatus(id: string): EventSourceStatus | undefined {
    return this.getStatus(id);
  }

  onEvent(id: string, handler: EventSourceEventHandler): void {
    this.eventHandlers.set(id, handler);
    
    // 同时设置到实例
    const instance = this.instances.get(id);
    if (instance) {
      instance.onEvent(handler);
    }
  }

  offEvent(id: string): void {
    this.eventHandlers.delete(id);
    
    const instance = this.instances.get(id);
    if (instance) {
      instance.offEvent();
    }
  }

  // ========================================================================
  // 生命周期控制（使用 Handler）
  // ========================================================================

  /**
   * 启动事件源
   */
  @TracedAs("event_source.start", { recordParams: true, recordResult: false })
  async startSource(id: string): Promise<void> {
    const config = this.sources.get(id);
    if (!config) {
      throw new Error(`EventSource not found: ${id}`);
    }

    const currentStatus = this.statuses.get(id);
    if (currentStatus === "running") {
      return;
    }

    this.statuses.set(id, "starting");

    try {
      // 获取 Handler
      const handler = this.handlers.get(config.type);
      if (!handler) {
        throw new Error(`No handler registered for event source type: ${config.type}`);
      }

      // 创建实例
      const instance = handler.createInstance(config);
      this.instances.set(id, instance);

      // ★ 注入 Environment 引用（必须在 start() / loadPlugins() 之前）
      // 第三方 handler 不实现 setEnvironment()，调用 null-safe，行为与之前一致。
      // LarkCliInstance 实现 setEnvironment() 后，registerPluginHooks 可以自动注入 setTaskUpdater。
      if (typeof (instance as { setEnvironment?: (env: unknown) => void }).setEnvironment === "function") {
        (instance as { setEnvironment: (env: unknown) => void }).setEnvironment(this.getEnv());
      }

      // 设置事件处理器
      // 优先使用用户注册的 handler，否则使用默认的 env.pushEnvEvent handler
      const eventHandler = this.eventHandlers.get(id) ?? this.createDefaultEventHandler(id, config.type);
      instance.onEvent(eventHandler);

      // 启动
      await instance.start();

      // ★ Task #5142：不要无条件写 "running" —— handler 可能在 start() 里
      //   **优雅降级**（例如 wecom-cli 二进制缺失 → instance.getStatus() === "error"）。
      //   无条件写 running 会让状态撒谎（CLI status 显示「运行中」但其实没跑）。
      const instanceStatus = instance.getStatus();
      if (instanceStatus === "error") {
        this.statuses.set(id, "error");
        const reason =
          (instance as { getLastError?: () => string | undefined }).getLastError?.() ??
          `event source '${config.type}' failed to start`;
        logger.error(`EventSource degraded to error state: ${id} (${config.type}) — ${reason}`);
        this.getEnv()?.pushEnvEvent({
          type: "event-source.error",
          payload: { sourceId: id, sourceType: config.type, reason },
        });
        throw new Error(reason);
      }
      this.statuses.set(id, "running");

      this.getEnv()?.pushEnvEvent({
        type: "event-source.started",
        payload: { sourceId: id, sourceType: config.type },
      });

      logger.info(`EventSource started: ${id} (${config.type})`);

    } catch (error) {
      this.statuses.set(id, "error");
      logger.error(`EventSource failed to start: ${id}`, error);
      throw error;
    }
  }

  /**
   * 停止事件源
   */
  @TracedAs("event_source.stop", { recordParams: true, recordResult: false })
  async stopSource(id: string): Promise<void> {
    const status = this.statuses.get(id);
    logger.info(`[EventSource ${id}] stopSource called, current status: ${status}`);

    if (status === "stopped" || status === "created") {
      logger.info(`[EventSource ${id}] already stopped/created, skipping`);
      return;
    }

    this.statuses.set(id, "stopping");

    try {
      const instance = this.instances.get(id);
      if (instance) {
        await instance.stop();
        this.instances.delete(id);
      }

      const config = this.sources.get(id);
      this.statuses.set(id, "stopped");

      this.getEnv()?.pushEnvEvent({
        type: "event-source.stopped",
        payload: { sourceId: id, sourceType: config?.type },
      });

      logger.info(`EventSource stopped: ${id}`);
    } catch (error) {
      this.statuses.set(id, "error");
      logger.error(`EventSource failed to stop: ${id}`, error);
      throw error;
    }
  }

  // ========================================================================
  // 配置持久化
  // ========================================================================

  private getConfigFilePath(): string {
    if (this.configPath) {
      return this.configPath;
    }
    const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
    const dataDir = join(home, ".roy-bot");
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    return join(dataDir, "event-sources.json");
  }

  async saveConfig(): Promise<void> {
    if (!this.persistenceEnabled) return;

    try {
      const configPath = this.getConfigFilePath();
      const configDir = join(configPath, "..");

      // ★ 护栏 3（Task #5194）：源数骤降检测 —— 写前对比磁盘源数，
      //   下降 >30% 时拒绝覆盖（fail-safe：宁可保存失败也不静默丢源）。
      //   事故 3（11-08 21:37）即 11 源被静默降级为 1 源。
      const diskCount = readSourceCountFromDisk(configPath);
      const newCount = this.sources.size;
      const dropCheck = checkSourceCountDrop(diskCount, newCount);
      if (!dropCheck.allowed && process.env.ROY_AGENT_ES_FORCE_SAVE !== "1") {
        appendAuditLog(configDir, {
          file: "event-sources.json",
          action: "drop-blocked",
          detail: dropCheck.reason,
        });
        logger.error(`Refusing to save event sources: ${dropCheck.reason}`);
        throw new Error(`EventSource saveConfig blocked: ${dropCheck.reason}`);
      }

      // ★ 护栏 1（Task #5194）：写前快照 —— 被覆盖的配置可从
      //   ~/.roy-bot/snapshots/<ts>/ 回滚。
      const snapDir = snapshotConfigDir(configDir);
      if (snapDir) {
        appendAuditLog(configDir, {
          file: "event-sources.json",
          action: "pre-save-snapshot",
          detail: `snapshot=${snapDir}`,
        });
      }

      const config: EventSourcePersistenceConfig = {
        version: "1.0.0",
        sources: Array.from(this.sources.values()),
      };
      writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

      // ★ 护栏 2（Task #5194）：写入审计 —— 谁/何时/什么。
      appendAuditLog(configDir, {
        file: "event-sources.json",
        action: "save",
        detail: `${newCount} sources (disk had ${diskCount})`,
      });

      logger.debug(`Saved ${this.sources.size} event source configurations`);
    } catch (error) {
      logger.error("Failed to save event source configurations:", error);
      throw error;
    }
  }

  async loadConfig(): Promise<void> {
    if (!this.persistenceEnabled) return;

    try {
      const configPath = this.getConfigFilePath();
      if (!existsSync(configPath)) {
        logger.debug(`No event source config file found at ${configPath}`);
        return;
      }

      const content = readFileSync(configPath, "utf-8");
      const config: EventSourcePersistenceConfig = JSON.parse(content);

      if (!config.sources || !Array.isArray(config.sources)) {
        logger.warn("Invalid event source config format, skipping load");
        return;
      }

      let loadedCount = 0;
      for (const source of config.sources) {
        if (!this.sources.has(source.id)) {
          this.sources.set(source.id, source);
          this.statuses.set(source.id, "created");
          loadedCount++;
        }
      }

      logger.info(`Loaded ${loadedCount} event source configurations`);
    } catch (error) {
      logger.error("Failed to load event source configurations:", error);
    }
  }
}

// 导出 Handler 以便第三方使用
export { 
  builtInHandlers, 
  larkCliHandler, 
};
