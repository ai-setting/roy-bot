import { ZodType, ZodTypeDef } from "zod";
import {
  BaseComponent,
  type ComponentSchema,
  type ComponentPaths,
  type ComponentWatchCallback,
  type ComponentConfigChangeEvent,
} from "../env/component";
import {
  XDG_PATHS,
  type XDGDirType,
} from "../env/paths";
import { parseJSONCWithProtocols, parseJSONCWithEnv } from "./config-parser";
import { ProtocolResolver } from "./protocol-resolver";
import { FileSource } from "./file-source";
import { EnvSource } from "./env-source";
import * as fsSync from "fs";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";

/**
 * ConfigSource 类型
 */
export type ConfigSourceType = "memory" | "file" | "env" | "remote" | "project";

/**
 * SourceRegistration - Source 注册配置
 */
export interface SourceRegistration {
  /** Source 类型 */
  type: ConfigSourceType;
  /** 相对路径（file 类型使用，基于 XDG_DATA_HOME） */
  relativePath?: string;
  /** 环境变量前缀（env 类型使用） */
  envPrefix?: string;
  /** 项目根目录（project 类型使用，默认 process.cwd()） */
  cwd?: string;
  /** 优先级，默认值：memory=0, file=10, env=20, project=25 */
  priority?: number;
  /** 是否可选（file 类型使用，文件不存在时不报错） */
  optional?: boolean;
  /** 是否启用文件监听（file 类型使用，默认 true） */
  watch?: boolean;
}

/**
 * KeyRegistration - 配置 Key 注册
 */
export interface KeyRegistration {
  /** 配置 Key（支持点号嵌套，如 "llm.provider"） */
  key: string;
  /** 优先使用的 Source 列表（按优先级从低到高） */
  sources: ConfigSourceType[];
  /** 自定义优先级（覆盖默认优先级） */
  priority?: number;
  /** 默认值 */
  default?: unknown;
}

/**
 * ComponentRegistration - Component 注册配置
 */
export interface ComponentRegistration {
  /** Component 名称 */
  name: string;
  /** 声明需要的 Source */
  sources: SourceRegistration[];
  /** 声明需要的配置 Key */
  keys: KeyRegistration[];
  /** 配置 Schema（用于验证，可选） */
  schema?: ZodType<unknown, ZodTypeDef, unknown>;
  /** 默认值 */
  defaults?: Record<string, unknown>;
}

/**
 * 配置源不存在错误
 */
export class ConfigSourceNotFoundError extends Error {
  constructor(sourceType: string, path?: string) {
    const message = path
      ? `Config source not found: ${sourceType} at ${path}`
      : `Config source not found: ${sourceType}`;
    super(message);
    this.name = "ConfigSourceNotFoundError";
  }
}

/**
 * 配置文件不存在错误
 */
export class ConfigFileNotFoundError extends Error {
  constructor(filePath: string) {
    super(`Config file not found: ${filePath}`);
    this.name = "ConfigFileNotFoundError";
  }
}

/**
 * ConfigSource 接口
 */
export interface ConfigSource {
  readonly name: ConfigSourceType;
  readonly priority: number;
  read(key: string): unknown | undefined;
  write?(key: string, value: unknown): boolean;
  delete?(key: string): boolean;
  list(): Array<{ key: string; value: unknown }>;
  watch?(callback: (event: ConfigChangeEvent) => void): () => void;
}

/**
 * Config 变更事件
 */
export interface ConfigChangeEvent {
  type: "change" | "add" | "delete";
  key: string;
  oldValue: unknown;
  newValue: unknown;
  source: ConfigSourceType;
  timestamp: number;
}

/**
 * 异步持久化条目
 */
interface PersistEntry {
  key: string;
  value: unknown;
  timestamp: number;
}

/**
 * MemorySource 实现
 */
export class MemorySource implements ConfigSource {
  readonly name: ConfigSourceType = "memory";
  readonly priority = 0;

  private store = new Map<string, { value: unknown; timestamp: number; version: number }>();
  private watchers = new Set<(event: ConfigChangeEvent) => void>();

  read(key: string): unknown | undefined {
    return this.store.get(key)?.value;
  }

  write(key: string, value: unknown): boolean {
    const oldEntry = this.store.get(key);
    const entry = {
      value,
      timestamp: Date.now(),
      version: (oldEntry?.version ?? 0) + 1,
    };
    this.store.set(key, entry);

    this.notifyWatchers({
      type: oldEntry ? "change" : "add",
      key,
      oldValue: oldEntry?.value,
      newValue: value,
      source: "memory",
      timestamp: entry.timestamp,
    });

    return true;
  }

  delete(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;

    this.store.delete(key);

    this.notifyWatchers({
      type: "delete",
      key,
      oldValue: entry.value,
      newValue: undefined,
      source: "memory",
      timestamp: Date.now(),
    });

    return true;
  }

  list(): Array<{ key: string; value: unknown }> {
    return Array.from(this.store.entries()).map(([key, entry]) => ({
      key,
      value: entry.value,
    }));
  }

  watch(callback: (event: ConfigChangeEvent) => void): () => void {
    this.watchers.add(callback);
    return () => this.watchers.delete(callback);
  }

  private notifyWatchers(event: ConfigChangeEvent): void {
    this.watchers.forEach((cb) => cb(event));
  }
}

/**
 * 异步持久化队列
 */
export class AsyncPersistQueue {
  private queue: Map<string, PersistEntry> = new Map();
  private timer?: NodeJS.Timeout;
  private paused = false;

  constructor(
    private options: {
      debounceMs: number;
      persistFn: (entries: PersistEntry[]) => Promise<void>;
    }
  ) {}

  add(key: string, value: unknown): void {
    this.queue.set(key, { key, value, timestamp: Date.now() });
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.paused || this.timer) return;

    this.timer = setTimeout(async () => {
      this.timer = undefined;
      await this.flush();
    }, this.options.debounceMs);
  }

  async flush(): Promise<void> {
    if (this.queue.size === 0) return;

    const entries = Array.from(this.queue.values());
    this.queue.clear();

    try {
      await this.options.persistFn(entries);
    } catch (error) {
      console.error("Failed to persist config:", error);
    }
  }

  clear(): void {
    this.queue.clear();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  size(): number {
    return this.queue.size;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    if (this.queue.size > 0) {
      this.scheduleFlush();
    }
  }
}

/**
 * ConfigComponent 配置
 */
export interface ConfigComponentOptions {
  /** 持久化文件路径 */
  persistFile?: string;
  /** 防抖延迟（ms） */
  debounceMs?: number;
  /** 最大批量大小 */
  maxBatchSize?: number;
}

/**
 * ConfigComponent
 */
export class ConfigComponent extends BaseComponent {
  readonly name = "config";
  readonly version = "1.0.0";

  private memorySource = new MemorySource();
  private sources: ConfigSource[] = [this.memorySource];
  private componentSchemas = new Map<string, ComponentSchema>();
  private componentPaths = new Map<string, Record<string, ComponentPaths>>();
  private watchers = new Map<string, Set<ComponentWatchCallback>>();
  /** Source watch unsubscribe 函数 */
  private sourceUnwatchFns = new Map<string, () => void>();

  private persistQueue: AsyncPersistQueue;
  private persistFile?: string;

  // === 去中心化配置注册 ===
  
  /** Key 注册表：key -> KeyRegistration */
  private keyRegistry = new Map<string, KeyRegistration>();
  
  /** Component 注册表：name -> ComponentRegistration */
  private componentRegistrations = new Map<string, ComponentRegistration>();
  
  /** 协议解析器 */
  private protocolResolver?: ProtocolResolver;
  
  /** XDG_DATA_HOME 缓存（用于测试注入） */
  private __xdgDataHome?: string;

  /** Source 注册配置（延迟创建） */
  private pendingSources: SourceRegistration[] = [];
  
  /** Source 唯一标识缓存：type:relativePath -> true */
  private sourceKeys = new Map<string, boolean>();
  
  /**
   * 获取 XDG_DATA_HOME（动态获取，支持运行时覆盖）
   */
  getXdgDataHome(): string {
    return this.__xdgDataHome ?? process.env.XDG_DATA_HOME ?? 
      path.join(os.homedir(), ".local", "share");
  }
  
  /**
   * 设置 XDG_DATA_HOME（用于测试）
   */
  setXdgDataHome(path: string): void {
    this.__xdgDataHome = path;
    // 同时更新 ProtocolResolver 的 xdgDataHome
    if (this.protocolResolver) {
      this.protocolResolver.xdgDataHome = path;
    }
  }

  constructor(options: ConfigComponentOptions = {}) {
    super();
    this.persistFile = options.persistFile;
    this.persistQueue = new AsyncPersistQueue({
      debounceMs: options.debounceMs ?? 300,
      persistFn: this.persistToFile.bind(this),
    });
    
    // 初始化协议解析器（延迟初始化，依赖 getXdgDataHome）
    this.protocolResolver = new ProtocolResolver();
  }

  // === Component 注册 ===

  /**
   * 注册 Component Schema
   */
  register(schema: ComponentSchema): void {
    this.componentSchemas.set(schema.name, schema);

    // 注册路径
    if (schema.paths) {
      this.componentPaths.set(schema.name, schema.paths);
    }

    // 初始化默认值到内存
    for (const [key, value] of Object.entries(schema.defaults)) {
      const fullKey = `${schema.name}.${key}`;
      if (this.memorySource.read(fullKey) === undefined) {
        this.memorySource.write(fullKey, value);
      }
    }
  }

  /**
   * 注销 Component
   */
  unregister(name: string): boolean {
    this.componentSchemas.delete(name);
    this.componentPaths.delete(name);
    return true;
  }

  /**
   * 检查是否已注册
   */
  isRegistered(name: string): boolean {
    return this.componentSchemas.has(name);
  }

  /**
   * 列出所有注册的 Component
   */
  listComponents(): string[] {
    return Array.from(this.componentSchemas.keys());
  }

  // === 层级 Key 访问 ===

  /**
   * 获取配置值（支持 xxx.yyy.zzz 嵌套访问）
   * 支持两种模式：
   * 1. 完整 key：直接查找，如 "component.key" -> 读取 "component.key"
   * 2. 嵌套对象：查找 component 对象后从中获取属性，如 "component.nested.deep" 
   *    -> 先找 "component.nested"，再获取其 "deep" 属性
   */
  get(key: string): unknown {
    // 先检查内存层
    const memoryValue = this.memorySource.read(key);
    if (memoryValue !== undefined) {
      return memoryValue;
    }

    // 尝试解析嵌套 key（从短到长尝试）
    if (key.includes(".")) {
      const parts = key.split(".");
      
      // 从第二部分开始尝试，逐级向上查找父对象
      for (let i = parts.length - 1; i >= 1; i--) {
        const componentParts = parts.slice(0, i);
        const component = componentParts.join(".");
        const restParts = parts.slice(i);
        const restKey = restParts.join(".");
        
        const componentValue = this.memorySource.read(component);
        if (typeof componentValue === "object" && componentValue !== null) {
          const nestedValue = this.getNestedValue(componentValue, restKey);
          if (nestedValue !== undefined) {
            return nestedValue;
          }
        }
      }
    }

    return undefined;
  }

  /**
   * 批量获取
   */
  getMany(keys: string[]): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      result[key] = this.get(key);
    }
    return result;
  }

  /**
   * 设置配置值（内存级别 + 异步持久化）
   */
  async set(key: string, value: unknown): Promise<void> {
    const oldValue = this.get(key);

    // 写入内存（立即生效）
    this.memorySource.write(key, value);

    // 触发监听器
    const event: ComponentConfigChangeEvent = {
      component: key.split(".")[0],
      key,
      oldValue,
      newValue: value,
      persisted: false,
      timestamp: Date.now(),
    };
    this.notifyWatchers(key, event);

    // 队列化持久化（异步）
    this.persistQueue.add(key, value);
  }

  /**
   * 批量设置
   */
  async setMany(config: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(config)) {
      await this.set(key, value);
    }
  }

  // === 路径 ===

  /**
   * 获取 Component 的路径
   */
  getPath(component: string, subPath?: string): string {
    const paths = this.componentPaths.get(component);

    if (!paths) {
      throw new Error(`Component not registered: ${component}`);
    }

    if (subPath && paths[subPath]) {
      const { base, subPath: relativePath } = paths[subPath];
      return XDG_PATHS.getComponentPath(base, relativePath);
    }

    // 返回第一个注册的路径
    const firstKey = Object.keys(paths)[0];
    if (!firstKey) {
      throw new Error(`No paths registered for component: ${component}`);
    }
    const { base, subPath: relativePath } = paths[firstKey];
    return XDG_PATHS.getComponentPath(base, relativePath);
  }

  // === 持久化 ===

  /**
   * 手动持久化
   */
  async save(key?: string): Promise<void> {
    await this.persistQueue.flush();
  }

  /**
   * 重置到默认值
   */
  async reset(key: string): Promise<void> {
    const [component, ...rest] = key.split(".");
    const schema = this.componentSchemas.get(component);
    if (!schema) return;

    const partialKey = rest.join(".");
    const defaultValue = schema.defaults[partialKey] ?? schema.defaults[key];
    if (defaultValue !== undefined) {
      await this.set(key, defaultValue);
    }
  }

  // === 监听 ===

  /**
   * 监听配置变更
   */
  watch(pattern: string, callback: ComponentWatchCallback): () => void {
    if (!this.watchers.has(pattern)) {
      this.watchers.set(pattern, new Set());
    }
    this.watchers.get(pattern)!.add(callback);

    return () => {
      this.watchers.get(pattern)?.delete(callback);
    };
  }

  // === 配置源 ===

  /**
   * 添加配置源
   */
  addSource(source: ConfigSource): void {
    this.sources.push(source);
    this.sources.sort((a, b) => a.priority - b.priority);

    // 启用监听
    if (source.watch) {
      const callback = (event: any) => {
        this.notifyWatchers(event.key, {
          component: event.key.split(".")[0],
          key: event.key,
          oldValue: event.oldValue,
          newValue: event.newValue,
          persisted: true,
          timestamp: event.timestamp,
        });
      };
      
      // 调用 watch 并忽略错误（确保初始化错误不会中断流程）
      try {
        const unwatch = source.watch(callback);
        const sourceKey = this.getSourceKey(source);
        this.sourceUnwatchFns.set(sourceKey, unwatch);
      } catch {
        // 忽略错误
      }
    }
  }

  /**
   * 获取 Source 唯一标识
   */
  private getSourceKey(source: ConfigSource): string {
    if ("filePath" in source) {
      return `file:${source.filePath}`;
    }
    if ("prefix" in source) {
      return `env:${source.prefix}`;
    }
    return source.name;
  }

  /**
   * 移除配置源
   */
  removeSource(name: ConfigSourceType): boolean {
    const index = this.sources.findIndex((s) => s.name === name);
    if (index > 0) {
      // 清理 watcher
      const source = this.sources[index];
      const sourceKey = this.getSourceKey(source);
      const unwatch = this.sourceUnwatchFns.get(sourceKey);
      if (unwatch) {
        unwatch();
        this.sourceUnwatchFns.delete(sourceKey);
      }
      // 不移除 memorySource
      this.sources.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * 关闭所有配置源的 watcher（用于优雅退出）
   */
  unwatchAll(): void {
    for (const unwatch of this.sourceUnwatchFns.values()) {
      unwatch();
    }
    this.sourceUnwatchFns.clear();
  }

  /**
   * 释放持久化队列与文件 watcher（CLI 退出时调用）
   */
  shutdown(): void {
    this.unwatchAll();
    this.persistQueue.clear();
  }

  protected async onStop(): Promise<void> {
    this.shutdown();
    await super.onStop();
  }

  /**
   * 获取配置源列表
   */
  getSources(): ConfigSource[] {
    return [...this.sources];
  }

  // === 私有方法 ===

  private getNestedValue(obj: unknown, key: string): unknown {
    const keys = key.split(".");
    let current: unknown = obj;

    for (const k of keys) {
      if (typeof current !== "object" || current === null) return undefined;
      current = (current as Record<string, unknown>)[k];
    }

    return current;
  }

  private notifyWatchers(key: string, event: ComponentConfigChangeEvent): void {
    // 精确匹配
    const exactWatchers = this.watchers.get(key);
    exactWatchers?.forEach((cb) => cb(event));

    // 通配符匹配
    const [component] = key.split(".");
    const wildcardWatchers = this.watchers.get(`${component}.*`);
    wildcardWatchers?.forEach((cb) => cb(event));

    // 全局匹配
    const globalWatchers = this.watchers.get("*");
    globalWatchers?.forEach((cb) => cb(event));
  }

  private async persistToFile(entries: PersistEntry[]): Promise<void> {
    if (!this.persistFile) return;

    // 简化实现：追加到文件
    // 实际应该读取文件、合并、更新
    console.log(`[ConfigComponent] Persisting ${entries.length} entries to ${this.persistFile}`);
    // TODO: 实现完整文件持久化
  }

  // === 去中心化配置注册 ===

  /**
   * 注册配置 Source
   * 
   * Source 会在首次 load() 时被创建
   * 
   * @example
   * config.registerSource({ type: "file", relativePath: "llm-config.jsonc" });
   * config.registerSource({ type: "env", envPrefix: "LLM" });
   */
  registerSource(registration: SourceRegistration): void {
    const { type, relativePath, envPrefix, cwd } = registration;
    
    // 生成唯一标识
    let sourceKey: string;
    if (type === "file" && relativePath) {
      sourceKey = `file:${relativePath}`;
    } else if (type === "project") {
      const projectCwd = cwd ?? process.cwd();
      const projectPath = path.join(projectCwd, ".roy", "config.jsonc");
      sourceKey = `project:${projectPath}`;
    } else {
      sourceKey = `${type}:${envPrefix ?? ""}`;
    }
    
    // 检查是否已注册
    if (this.sourceKeys.has(sourceKey)) {
      return; // 忽略重复注册
    }
    
    // 延迟创建：只保存注册配置
    this.pendingSources.push(registration);
    this.sourceKeys.set(sourceKey, true);
  }
  
  /**
   * 注册项目级配置 Source（从 `${cwd}/.roy/config.jsonc` 加载）
   * 
   * 项目级配置优先级高于 env 和全局 file，可在不同项目下设置不同的配置。
   * 如果文件不存在，静默忽略（不报错）。重复注册同一 cwd 是幂等的。
   * 
   * @param options.cwd - 项目根目录，默认为 `process.cwd()`
   * @param options.priority - 优先级，默认 25（高于 env=20、file=10）
   * 
   * @example
   * config.registerProjectSource();
   * config.registerProjectSource({ cwd: "/path/to/project" });
   */
  registerProjectSource(options?: { cwd?: string; priority?: number }): void {
    const cwd = options?.cwd ?? process.cwd();
    this.registerSource({
      type: "project",
      cwd,
      priority: options?.priority ?? 25,
      optional: true,
      watch: false,
    });
  }
  
  /**
   * 创建 Source 实例
   */
  private createSource(registration: SourceRegistration): ConfigSource {
    const { type, relativePath, envPrefix, cwd, priority, optional, watch } = registration;
    
    switch (type) {
      case "memory": {
        // MemorySource 是内置的，直接返回
        return this.memorySource;
      }

      case "file": {
        if (!relativePath) {
          throw new Error("File source requires relativePath");
        }
        
        // 判断是绝对路径还是相对路径
        // 注意：在 Bun 环境中，import.meta.url 返回的是 file:/// URL
        const isAbsolutePath = path.isAbsolute(relativePath) || relativePath.startsWith("file://");
        
        let filePath: string;
        if (isAbsolutePath) {
          // 绝对路径：直接使用
          filePath = relativePath.startsWith("file://") 
            ? relativePath.replace(/^file:\/\//, "") 
            : relativePath;
        } else {
          // 相对路径：基于 XDG_DATA_HOME
          // 更新 ProtocolResolver 的 XDG_DATA_HOME 为当前值
          if (this.protocolResolver) {
            this.protocolResolver.xdgDataHome = this.getXdgDataHome();
          }
          filePath = path.join(this.getXdgDataHome(), relativePath);
        }
        
        return new FileSource({
          filePath,
          optional: optional ?? false,
          resolver: this.protocolResolver,
          watch: watch,
          priority: priority ?? 10,
        });
      }

      case "project": {
        // 项目级配置：${cwd}/.roy/config.jsonc
        // - 永远 optional（文件不存在时静默初始化为空对象）
        // - 默认 priority 25（高于 env=20，高于 file=10）
        // - name="project" 让 load() 能按 "project" 类型查找到此 source
        // - watch=false（避免 hot reload 噪音，项目级配置变更需重启生效）
        const projectCwd = cwd ?? process.cwd();
        const filePath = path.join(projectCwd, ".roy", "config.jsonc");
        
        return new FileSource({
          filePath,
          optional: true,
          resolver: this.protocolResolver,
          watch: watch ?? false,
          priority: priority ?? 25,
          name: "project",
        });
      }

      case "env": {
        return new EnvSource({
          prefix: envPrefix ?? "",
          priority: priority ?? 20,
          watch: watch,
        });
      }

      default:
        throw new Error(`Unknown source type: ${type}`);
    }
  }
  
  /**
   * 确保所有待创建的 Source 已被创建
   */
  private ensureSourcesCreated(): void {
    for (const pending of this.pendingSources) {
      const source = this.createSource(pending);
      this.addSource(source);
    }
    this.pendingSources = [];
  }

  /**
   * 注册配置 Key
   * 
   * @example
   * config.registerKeys([
   *   { key: "llm.provider", sources: ["file", "memory"], default: "openai" },
   *   { key: "llm.model", sources: ["file"] },
   * ]);
   */
  registerKeys(keys: KeyRegistration[]): void {
    for (const keyReg of keys) {
      // 如果已存在，跳过（保留原有注册）
      if (this.keyRegistry.has(keyReg.key)) {
        continue;
      }
      this.keyRegistry.set(keyReg.key, keyReg);
      
      // 自动将默认值写入 memory source
      if (keyReg.default !== undefined) {
        if (this.memorySource.read(keyReg.key) === undefined) {
          this.memorySource.write(keyReg.key, keyReg.default);
        }
      }
    }
  }

  /**
   * 注册 Component（一次性注册 Source 和 Keys）
   * 
   * @example
   * config.registerComponent({
   *   name: "llm",
   *   sources: [
   *     { type: "file", relativePath: "llm-config.jsonc" },
   *     { type: "env", envPrefix: "LLM" },
   *   ],
   *   keys: [
   *     { key: "llm.provider", sources: ["file", "env", "memory"] },
   *   ],
   * });
   */
  registerComponent(registration: ComponentRegistration): void {
    const { name, sources, keys, defaults } = registration;
    
    // 存储 Component 注册信息
    this.componentRegistrations.set(name, registration);
    
    // 注册所有 Source
    for (const sourceReg of sources) {
      this.registerSource(sourceReg);
    }
    
    // 注册所有 Keys
    this.registerKeys(keys);
    
    // 注册默认值（如果提供）
    if (defaults) {
      for (const [key, value] of Object.entries(defaults)) {
        const fullKey = `${name}.${key}`;
        if (this.memorySource.read(fullKey) === undefined) {
          this.memorySource.write(fullKey, value);
        }
      }
    }
  }

  /**
   * 按需加载配置
   * 
   * 从注册的 Source 加载已注册 Keys 的配置值到内存中
   * 
   * @param componentName - 可选，指定要加载的 Component 名称
   * 
   * @example
   * // 加载所有已注册的 Keys
   * await config.load();
   * 
   * // 只加载指定 Component 的 Keys
   * await config.load("llm");
   */
  async load(componentName?: string): Promise<void> {
    // 确保所有待创建的 Source 已被创建
    this.ensureSourcesCreated();
    
    // 确定要加载哪些 Keys
    let keysToLoad: Array<{ key: string; sources: ConfigSourceType[] }>;
    
    if (componentName) {
      // 只加载指定 Component 的 Keys
      const registration = this.componentRegistrations.get(componentName);
      if (!registration) {
        return; // Component 未注册，直接返回
      }
      keysToLoad = registration.keys.map(k => ({
        key: k.key,
        sources: k.sources,
      }));
    } else {
      // 加载所有已注册的 Keys
      keysToLoad = Array.from(this.keyRegistry.values()).map(k => ({
        key: k.key,
        sources: k.sources,
      }));
    }
    
    // 按 Source 分组加载
    const sourcesByType = new Map<ConfigSourceType, ConfigSource>();
    for (const source of this.sources) {
      sourcesByType.set(source.name, source);
    }
    
    // 加载每个 Key
    for (const { key, sources: sourceTypes } of keysToLoad) {
      // 检查内存中是否已有值
      if (this.memorySource.read(key) !== undefined) {
        continue; // 已有值，跳过
      }
      
      // 按优先级加载
      // sources 参数指定了要查询的 Source 类型列表
      // 我们需要从这些 Source 中找到第一个有值的
      for (const sourceType of sourceTypes) {
        const source = sourcesByType.get(sourceType);
        if (!source) continue;
        
        const value = source.read(key);
        if (value !== undefined) {
          // 加载到内存
          this.memorySource.write(key, value);
          break;
        }
      }
    }
  }

  /**
   * 获取已注册的 Source 列表
   */
  getRegisteredSources(): ConfigSource[] {
    // 确保所有延迟创建的 Source 已被创建
    this.ensureSourcesCreated();
    return [...this.sources];
  }
}
