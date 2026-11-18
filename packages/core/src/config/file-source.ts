import * as fsSync from "fs";
import * as fsPromises from "fs/promises";
import path from "path";
import {
  ConfigSource,
  ConfigSourceType,
  ConfigChangeEvent,
} from "./config-component";
import { parseJSONCWithEnv, parseJSONCWithProtocols } from "./config-parser";
import { ProtocolResolver } from "./protocol-resolver";

/**
 * FileSource 配置
 */
export interface FileSourceOptions {
  /** 文件路径 */
  filePath: string;
  /** 写入防抖延迟（ms），默认 100ms */
  debounceMs?: number;
  /** 协议解析器（可选），用于解析 file://, env:// 协议 */
  resolver?: ProtocolResolver;
  /** 是否可选，文件不存在时不报错（默认 false） */
  optional?: boolean;
  /** 是否启用文件监听（默认 true） */
  watch?: boolean;
  /** 优先级（默认 10，越大越高） */
  priority?: number;
  /** Source 名称（默认 "file"，project source 可设为 "project"） */
  name?: ConfigSourceType;
}

/**
 * 文件配置源
 * 
 * 从 JSON 文件读取/写入配置，支持：
 * - 点号访问嵌套值（user.profile.name）
 * - 文件监听
 * - 异步批量写入
 * - 协议引用解析 (file://, env://)
 */
export class FileSource implements ConfigSource {
  readonly name: ConfigSourceType;
  readonly priority: number;

  private filePath: string;
  private data: Record<string, unknown> = {};
  private watchers = new Set<(event: ConfigChangeEvent) => void>();
  private watcherHandle?: ReturnType<typeof fsSync.watch>;
  private debounceMs: number;
  private pendingWrite?: ReturnType<typeof setTimeout>;
  private lastFileContent = "";
  private resolver?: ProtocolResolver;
  private optional: boolean = false;
  private watchEnabled: boolean = true;

  constructor(options: FileSourceOptions | string, resolver?: ProtocolResolver) {
    if (typeof options === "string") {
      this.filePath = options;
      this.debounceMs = 100;
      this.resolver = resolver;
      this.optional = true; // 字符串构造默认为可选，保持向后兼容
      this.priority = 10;
      this.name = "file";
    } else {
      this.filePath = options.filePath;
      this.debounceMs = options.debounceMs ?? 100;
      this.resolver = options.resolver ?? resolver;
      this.optional = options.optional ?? true; // 对象构造默认为可选
      this.watchEnabled = options.watch ?? true;
      this.priority = options.priority ?? 10;
      this.name = options.name ?? "file";
    }

    // 同步初始化
    this.initSync();
  }

  /**
   * 同步初始化：加载文件内容
   */
  private initSync(): void {
    try {
      if (fsSync.existsSync(this.filePath)) {
        const content = fsSync.readFileSync(this.filePath, "utf-8");
        
        // 如果配置了 resolver，使用 parseJSONCWithProtocols 解析协议引用
        if (this.resolver) {
          this.data = parseJSONCWithProtocols(content, this.resolver);
        } else {
          this.data = parseJSONCWithEnv(content);
        }
        
        this.lastFileContent = content;
      } else {
        if (this.optional) {
          // 可选文件不存在时，静默初始化为空对象
          this.data = {};
          this.lastFileContent = "{}";
        } else {
          // 必需文件不存在时，抛出错误
          throw new Error(`Config file not found: ${this.filePath}`);
        }
      }
    } catch (error) {
      if (this.optional) {
        // 可选文件出错时，静默初始化为空对象
        this.data = {};
        this.lastFileContent = "{}";
      } else {
        // 必需文件出错时，重新抛出错误
        throw error;
      }
    }
  }

  /**
   * 异步初始化
   */
  private async ensureInit(): Promise<void> {
    if (this.lastFileContent === "" && !fsSync.existsSync(this.filePath)) {
      // 尚未初始化，执行同步初始化
      this.initSync();
    }
  }

  /**
   * 获取嵌套值
   */
  private getNestedValue(obj: Record<string, unknown>, key: string): unknown {
    const keys = key.split(".");
    let current: unknown = obj;
    
    for (const k of keys) {
      if (current === null || current === undefined || typeof current !== "object") {
        return undefined;
      }
      current = (current as Record<string, unknown>)[k];
    }
    
    return current;
  }

  /**
   * 设置嵌套值
   */
  private setNestedValue(obj: Record<string, unknown>, key: string, value: unknown): void {
    const keys = key.split(".");
    let current = obj;
    
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (!(k in current) || typeof current[k] !== "object" || current[k] === null) {
        current[k] = {};
      }
      current = current[k] as Record<string, unknown>;
    }
    
    current[keys[keys.length - 1]] = value;
  }

  /**
   * 删除嵌套值
   */
  private deleteNestedValue(obj: Record<string, unknown>, key: string): boolean {
    const keys = key.split(".");
    let current = obj;
    
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (!(k in current) || typeof current[k] !== "object" || current[k] === null) {
        return false;
      }
      current = current[k] as Record<string, unknown>;
    }
    
    const lastKey = keys[keys.length - 1];
    if (lastKey in current) {
      delete current[lastKey];
      return true;
    }
    
    return false;
  }

  /**
   * 扁平化嵌套对象为点号路径
   */
  private flattenObject(obj: unknown, prefix = ""): Array<{ key: string; value: unknown }> {
    if (obj === null || obj === undefined) {
      return [];
    }

    if (typeof obj !== "object") {
      return prefix ? [{ key: prefix, value: obj }] : [];
    }

    if (Array.isArray(obj)) {
      return prefix ? [{ key: prefix, value: obj }] : [];
    }

    const result: Array<{ key: string; value: unknown }> = [];
    const entries = Object.entries(obj as Record<string, unknown>);

    for (const [k, v] of entries) {
      const newKey = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        result.push(...this.flattenObject(v, newKey));
      } else {
        result.push({ key: newKey, value: v });
      }
    }

    return result;
  }

  read(key: string): unknown | undefined {
    return this.getNestedValue(this.data, key);
  }

  async readAsync(key: string): Promise<unknown | undefined> {
    await this.ensureInit();
    return this.getNestedValue(this.data, key);
  }

  write(key: string, value: unknown): boolean {
    const oldValue = this.getNestedValue(this.data, key);
    this.setNestedValue(this.data, key, value);

    const event: ConfigChangeEvent = {
      type: oldValue === undefined ? "add" : "change",
      key,
      oldValue,
      newValue: value,
      source: this.name,
      timestamp: Date.now(),
    };
    this.notifyWatchers(event);

    this.scheduleWrite();

    return true;
  }

  private scheduleWrite(): void {
    if (this.pendingWrite) {
      clearTimeout(this.pendingWrite);
    }

    this.pendingWrite = setTimeout(() => {
      this.persistToFile();
    }, this.debounceMs);
  }

  private persistToFile(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fsSync.existsSync(dir)) {
        fsSync.mkdirSync(dir, { recursive: true });
      }

      const content = JSON.stringify(this.data, null, 2);
      fsSync.writeFileSync(this.filePath, content, "utf-8");
      this.lastFileContent = content;
    } catch (error) {
      console.error(`Failed to write config to ${this.filePath}:`, error);
    }
  }

  delete(key: string): boolean {
    const oldValue = this.getNestedValue(this.data, key);
    if (oldValue === undefined) {
      return false;
    }

    this.deleteNestedValue(this.data, key);

    const event: ConfigChangeEvent = {
      type: "delete",
      key,
      oldValue,
      newValue: undefined,
      source: this.name,
      timestamp: Date.now(),
    };
    this.notifyWatchers(event);

    this.scheduleWrite();

    return true;
  }

  list(): Array<{ key: string; value: unknown }> {
    return this.flattenObject(this.data);
  }

  async listAsync(): Promise<Array<{ key: string; value: unknown }>> {
    await this.ensureInit();
    return this.flattenObject(this.data);
  }

  watch(callback: (event: ConfigChangeEvent) => void): () => void {
    this.watchers.add(callback);
    
    // 如果 watch 被禁用，直接返回
    if (!this.watchEnabled) {
      return () => {
        this.watchers.delete(callback);
      };
    }
    
    this.ensureWatch();

    return () => {
      this.watchers.delete(callback);
      if (this.watchers.size === 0) {
        this.stopWatch();
      }
    };
  }

  private async ensureWatch(): Promise<void> {
    if (this.watcherHandle !== undefined) {
      return;
    }

    await this.ensureInit();

    // 可选文件不存在时不尝试监听
    if (!fsSync.existsSync(this.filePath)) {
      return;
    }

    try {
      this.watcherHandle = fsSync.watch(this.filePath, async (eventType) => {
        // 同时处理 change 和 rename 事件（in-place write 触发 change，
        // atomic rename 模式触发 rename；不同 OS/编辑器行为不一致）
        if (eventType === "change" || eventType === "rename") {
          await new Promise((r) => setTimeout(r, 50));
          await this.reloadFromFile();
        }
      });
    } catch (error) {
      console.error(`Failed to watch file ${this.filePath}:`, error);
    }
  }

  private stopWatch(): void {
    if (this.watcherHandle) {
      this.watcherHandle.close();
      this.watcherHandle = undefined;
    }
  }

  private async reloadFromFile(): Promise<void> {
    try {
      const content = await fsPromises.readFile(this.filePath, "utf-8");
      
      if (content === this.lastFileContent) {
        return;
      }

      const newData = parseJSONCWithEnv(content);
      const oldData = this.data;
      this.data = newData;
      this.lastFileContent = content;

      const oldFlat = this.flattenObject(oldData);
      const newFlat = this.flattenObject(newData);

      const oldKeys = new Set(oldFlat.map((e) => e.key));
      const newKeys = new Set(newFlat.map((e) => e.key));

      for (const key of oldKeys) {
        if (!newKeys.has(key)) {
          this.notifyWatchers({
            type: "delete",
            key,
            oldValue: oldFlat.find((e) => e.key === key)?.value,
            newValue: undefined,
            source: this.name,
            timestamp: Date.now(),
          });
        }
      }

      for (const newEntry of newFlat) {
        const oldEntry = oldFlat.find((e) => e.key === newEntry.key);
        if (!oldEntry) {
          this.notifyWatchers({
            type: "add",
            key: newEntry.key,
            oldValue: undefined,
            newValue: newEntry.value,
            source: this.name,
            timestamp: Date.now(),
          });
        } else if (oldEntry.value !== newEntry.value) {
          this.notifyWatchers({
            type: "change",
            key: newEntry.key,
            oldValue: oldEntry.value,
            newValue: newEntry.value,
            source: this.name,
            timestamp: Date.now(),
          });
        }
      }
    } catch (error) {
      console.error(`Failed to reload config from ${this.filePath}:`, error);
    }
  }

  private notifyWatchers(event: ConfigChangeEvent): void {
    this.watchers.forEach((cb) => cb(event));
  }

  async refresh(): Promise<void> {
    await this.reloadFromFile();
  }

  async close(): Promise<void> {
    this.stopWatch();
    
    if (this.pendingWrite) {
      clearTimeout(this.pendingWrite);
      this.pendingWrite = undefined;
    }
    
    this.persistToFile();
  }
}
