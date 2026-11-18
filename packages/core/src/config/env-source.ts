import {
  ConfigSource,
  ConfigSourceType,
  ConfigChangeEvent,
} from "./config-component";
import { toEnvKey, fromEnvKey, envKeyToConfigKey } from "./env-key";

/**
 * EnvSource 配置
 */
export interface EnvSourceOptions {
  /** 环境变量前缀 */
  prefix?: string;
  /** 值转换函数 */
  transform?: (value: string, key: string) => unknown;
  /** 轮询间隔（ms），用于检测环境变量变化 */
  pollInterval?: number;
  /** 优先级 */
  priority?: number;
  /** 是否启用监听（轮询），默认 true */
  watch?: boolean;
}

/**
 * 环境变量配置源
 * 
 * 从 process.env 读取配置，支持：
 * - 前缀过滤
 * - 值转换
 * - 环境变量监听（轮询）
 */
export class EnvSource implements ConfigSource {
  readonly name: ConfigSourceType = "env";
  readonly priority = 20;

  private prefix: string;
  private transform?: (value: string, key: string) => unknown;
  private pollInterval?: number;
  private watchers = new Set<(event: ConfigChangeEvent) => void>();
  private pollTimer?: NodeJS.Timeout;
  private lastValues = new Map<string, string>();
  private watchEnabled: boolean = true;

  constructor(options: EnvSourceOptions = {}) {
    this.prefix = options.prefix ?? "";
    this.transform = options.transform;
    this.pollInterval = options.pollInterval;
    this.watchEnabled = options.watch ?? true;
  }

  /**
   * 获取环境变量名（带前缀）
   * 将点号路径转换为下划线分隔的大写形式
   * 例如: "llm.provider" + prefix "LLM" -> "LLM_LLM_PROVIDER"
   * 例如: "DEBUG" + prefix "MY_APP_" -> "MY_APP_DEBUG"
   * 例如: "llm.defaultModel" + prefix "LLM" -> "LLM_LLM_DEFAULT_MODEL"
   */
  private getEnvKey(key: string): string {
    return toEnvKey(key, this.prefix);
  }

  /**
   * 移除前缀获取内部 key
   * 注意：保持原始格式（大小写），仅移除前缀
   */
  private getInternalKey(envKey: string): string {
    return fromEnvKey(envKey, this.prefix);
  }

  /**
   * 读取环境变量
   */
  read(key: string): unknown {
    const envKey = this.getEnvKey(key);
    const value = process.env[envKey];
    
    if (value === undefined) {
      return undefined;
    }

    if (this.transform) {
      return this.transform(value, key);
    }

    return value;
  }

  /**
   * 写入环境变量
   */
  write(key: string, value: unknown): boolean {
    const envKey = this.getEnvKey(key);
    const oldValue = process.env[envKey];
    const stringValue = String(value);

    // 设置环境变量
    process.env[envKey] = stringValue;

    // 通知监听器
    const event: ConfigChangeEvent = {
      type: oldValue === undefined ? "add" : "change",
      key,
      oldValue: oldValue !== undefined ? this.transformValue(oldValue, key) : undefined,
      newValue: this.transformValue(stringValue, key),
      source: this.name,
      timestamp: Date.now(),
    };
    this.notifyWatchers(event);

    return true;
  }

  /**
   * 删除环境变量
   */
  delete(key: string): boolean {
    const envKey = this.getEnvKey(key);
    const oldValue = process.env[envKey];

    if (oldValue === undefined) {
      return false;
    }

    delete process.env[envKey];

    // 通知监听器
    const event: ConfigChangeEvent = {
      type: "delete",
      key,
      oldValue: this.transformValue(oldValue, key),
      newValue: undefined,
      source: this.name,
      timestamp: Date.now(),
    };
    this.notifyWatchers(event);

    return true;
  }

  /**
   * 列出所有环境变量
   */
  list(): Array<{ key: string; value: unknown }> {
    const result: Array<{ key: string; value: unknown }> = [];
    const prefix = this.prefix.toUpperCase();

    for (const envKey of Object.keys(process.env)) {
      // 检查前缀匹配
      if (prefix && !envKey.startsWith(prefix)) {
        continue;
      }

      const key = this.getInternalKey(envKey);
      const value = process.env[envKey];

      if (value !== undefined) {
        result.push({
          key,
          value: this.transformValue(value, key),
        });
      }
    }

    return result;
  }

  /**
   * 监听环境变量变化
   */
  watch(callback: (event: ConfigChangeEvent) => void): () => void {
    this.watchers.add(callback);

    // 如果 watch 被禁用，直接返回
    if (!this.watchEnabled) {
      return () => {
        this.watchers.delete(callback);
      };
    }

    // 启动轮询
    this.ensurePolling();

    // 记录初始值
    this.recordCurrentValues();

    return () => {
      this.watchers.delete(callback);

      // 停止轮询如果没有监听器
      if (this.watchers.size === 0) {
        this.stopPolling();
      }
    };
  }

  private ensurePolling(): void {
    if (this.pollTimer !== undefined) {
      return;
    }

    const interval = this.pollInterval ?? 1000;
    this.pollTimer = setInterval(() => {
      this.checkForChanges();
    }, interval);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private recordCurrentValues(): void {
    this.lastValues.clear();
    const entries = this.list();
    for (const entry of entries) {
      const envKey = this.getEnvKey(entry.key);
      const value = process.env[envKey];
      if (value !== undefined) {
        this.lastValues.set(envKey, value);
      }
    }
  }

  private checkForChanges(): void {
    const currentEntries = this.list();
    const currentValues = new Map<string, string>();

    for (const entry of currentEntries) {
      const envKey = this.getEnvKey(entry.key);
      const value = process.env[envKey];
      if (value !== undefined) {
        currentValues.set(envKey, value);
      }
    }

    // 检测删除
    for (const [envKey, oldValue] of this.lastValues.entries()) {
      if (!currentValues.has(envKey)) {
        const key = this.getInternalKey(envKey);
        this.notifyWatchers({
          type: "delete",
          key,
          oldValue: this.transformValue(oldValue, key),
          newValue: undefined,
          source: this.name,
          timestamp: Date.now(),
        });
      }
    }

    // 检测添加和变更
    for (const [envKey, newValue] of currentValues.entries()) {
      const key = this.getInternalKey(envKey);
      const oldValue = this.lastValues.get(envKey);

      if (oldValue === undefined) {
        this.notifyWatchers({
          type: "add",
          key,
          oldValue: undefined,
          newValue: this.transformValue(newValue, key),
          source: this.name,
          timestamp: Date.now(),
        });
      } else if (oldValue !== newValue) {
        this.notifyWatchers({
          type: "change",
          key,
          oldValue: this.transformValue(oldValue, key),
          newValue: this.transformValue(newValue, key),
          source: this.name,
          timestamp: Date.now(),
        });
      }
    }

    // 更新记录
    this.lastValues = currentValues;
  }

  private transformValue(value: string, key: string): unknown {
    if (this.transform) {
      return this.transform(value, key);
    }
    return value;
  }

  private notifyWatchers(event: ConfigChangeEvent): void {
    this.watchers.forEach((cb) => cb(event));
  }

  /**
   * 关闭并清理资源
   */
  close(): void {
    this.stopPolling();
    this.watchers.clear();
  }

  /**
   * 验证 process.env 中的环境变量，识别未在已知 config keys 中的项
   * （Bug #2186 Bug 2 修复：env var 拼写错误时不再静默忽略）
   *
   * 遍历 process.env，对于以 prefix 开头的每个环境变量名：
   * 1. 用 `envKeyToConfigKey` 反向解析为 config key（如 `LLM_DEFAULT_PROVIDER` → `llm.default.provider`）
   * 2. 检查 configKey 是否在 `knownKeys` 中（精确匹配，或作为前缀匹配）
   * 3. 如果不匹配且 logger 存在，输出警告
   *
   * @param options.componentName - 用于 envKeyToConfigKey 反向解析（如 "llm"）
   * @param options.knownKeys - 已知 config keys 集合（dotted 路径形式）
   *                          - 精确匹配：knownKeys.has(configKey)
   *                          - 前缀匹配：knownKeys 中任一项 + "." + 后缀 === configKey
   * @param options.logger - 可选 logger（{ warn(msg: string) }）
   * @returns 未识别的环境变量名列表
   *
   * @example
   * const warnings: string[] = [];
   * envSource.validateUnrecognizedEnvVars({
   *   componentName: "llm",
   *   knownKeys: new Set(["llm.defaultProvider", "llm.providers"]),
   *   logger: { warn: (msg) => warnings.push(msg) },
   * });
   */
  validateUnrecognizedEnvVars(options: {
    componentName?: string;
    knownKeys?: Set<string>;
    logger?: { warn: (msg: string) => void };
  } = {}): string[] {
    const { componentName, knownKeys, logger } = options;
    const prefixUpper = this.prefix.toUpperCase();
    const unrecognized: string[] = [];

    // If knownKeys is undefined/empty, skip validation to avoid false positives
    // (caller didn't supply config-key rules, so we don't know what's "known")
    if (!knownKeys || knownKeys.size === 0) {
      return unrecognized;
    }

    for (const envKey of Object.keys(process.env)) {
      // 仅检查以 prefix 开头（case-insensitive）的环境变量
      if (prefixUpper && !envKey.toUpperCase().startsWith(prefixUpper)) {
        continue;
      }

      // 反向解析为 config key
      const configKey = componentName
        ? envKeyToConfigKey(envKey, this.prefix, componentName)
        : undefined;

      // 没有 componentName 时，退化为内部 key（仅做存在性检查，不做匹配）
      const candidateKey = configKey ?? fromEnvKey(envKey, this.prefix).toLowerCase().replace(/_/g, ".");

      // 检查是否匹配已知 keys（精确或前缀形式）
      const isKnown = Array.from(knownKeys).some((known) => {
        if (known === candidateKey) return true;
        // "llm.providers" 应当匹配 "llm.providers.openai.apiKey"
        if (candidateKey.startsWith(known + ".")) return true;
        return false;
      });

      if (!isKnown) {
        const valuePreview = JSON.stringify(process.env[envKey]);
        const truncated = valuePreview.length > 50 ? valuePreview.slice(0, 47) + "..." : valuePreview;
        const msg =
          `[EnvSource] Unrecognized env var: ${envKey}=${truncated} ` +
          `(resolved config key "${candidateKey}" not in known keys: ${Array.from(knownKeys).join(", ") || "<empty>"}). ` +
          `Check spelling, or add the key to the component's known config keys.`;
        unrecognized.push(envKey);
        if (logger?.warn) logger.warn(msg);
      }
    }

    return unrecognized;
  }
}
