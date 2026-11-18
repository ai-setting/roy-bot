/**
 * Protocol Resolver
 * 
 * Resolves configuration references using protocols:
 * - file:// - Read from files, relative paths based on XDG_DATA_HOME
 * - env:// - Read from environment variables
 * 
 * Syntax: ${protocol://path#key}
 */

// Supported protocols
export type ProtocolType = "file" | "env";

// Protocol reference pattern: ${protocol://path} or ${protocol://path#key}
// 支持默认值语法: ${protocol://path#key:-default}
const PROTOCOL_PATTERN = /^\$\{([^:]+):\/\/([^:#]+)(?:#([^:-]+))?(?::-(.*))?\}$/;

/**
 * Protocol reference structure
 */
export interface ProtocolRef {
  protocol: ProtocolType;
  path: string;
  key: string;
  defaultValue?: string;
  raw: string;
}

/**
 * Resolve result
 */
export interface ResolveResult {
  value: unknown;
  source: ProtocolType;
}

/**
 * ProtocolResolver 配置
 */
export interface ProtocolResolverOptions {
  /** XDG 数据目录，默认 ~/.local/share */
  xdgDataHome?: string;
  /** 文件读取函数（用于测试注入） */
  readFileFn?: (path: string) => string;
}

/**
 * 协议解析器
 * 
 * 解析配置中的协议引用，支持：
 * - ${file://path#key} - 从文件读取（相对路径基于 XDG_DATA_HOME）
 * - ${env://varName} - 从环境变量读取
 */
export class ProtocolResolver {
  private _xdgDataHome: string;
  private readFileFn: (path: string) => string;

  constructor(options: ProtocolResolverOptions = {}) {
    this._xdgDataHome = options.xdgDataHome ?? ProtocolResolver.getDefaultXDGDataHome();
    
    if (options.readFileFn) {
      this.readFileFn = options.readFileFn;
    } else {
      const fsSync = require("fs");
      this.readFileFn = (path: string) => fsSync.readFileSync(path, "utf-8");
    }
  }

  /**
   * 获取当前的 XDG_DATA_HOME
   */
  get xdgDataHome(): string {
    return this._xdgDataHome;
  }

  /**
   * 设置 XDG_DATA_HOME（用于运行时更新）
   */
  set xdgDataHome(value: string) {
    this._xdgDataHome = value;
  }

  /**
   * 获取默认 XDG_DATA_HOME
   */
  static getDefaultXDGDataHome(): string {
    return process.env.XDG_DATA_HOME ?? `${process.env.HOME ?? "~"}/.local/share`;
  }

  /**
   * 解析协议引用
   * 支持默认值语法: ${protocol://path#key:-default}
   */
  parse(ref: string): ProtocolRef | null {
    const match = ref.match(PROTOCOL_PATTERN);
    if (!match) return null;

    const [, protocol, path, key, defaultValue] = match;
    if (!["file", "env"].includes(protocol)) return null;

    return {
      protocol: protocol as ProtocolType,
      path,
      key: key ?? "",
      defaultValue,
      raw: ref,
    };
  }

  /**
   * 检查是否是协议引用
   */
  isProtocolRef(value: string): boolean {
    return PROTOCOL_PATTERN.test(value);
  }

  /**
   * 解析并获取协议引用的值
   * 
   * @returns 解析结果，包含值和来源；解析失败时返回 null
   */
  resolve(ref: string): ResolveResult | null {
    const parsed = this.parse(ref);
    if (!parsed) return null;

    const value = this.resolveInternal(parsed);
    
    // 对于 file 协议，如果值是 undefined/null，表示解析失败
    if (parsed.protocol === "file" && value === undefined) {
      return null;
    }
    
    // 对于 env 协议，如果值是 undefined 且没有默认值，返回 null
    if (value === undefined && parsed.protocol === "env" && parsed.defaultValue === undefined) {
      return null;
    }
    
    // 如果值是 undefined 但有默认值，返回默认值
    if (value === undefined && parsed.defaultValue !== undefined) {
      return {
        value: parsed.defaultValue,
        source: parsed.protocol,
      };
    }
    
    return {
      value,
      source: parsed.protocol,
    };
  }

  /**
   * 解析文件引用
   */
  private resolveFileRef(filePath: string, key: string): unknown {
    // 解析相对路径
    const resolvedPath = this.resolvePath(filePath);
    
    try {
      const content = this.readFileFn(resolvedPath);
      // 尝试解析 JSON
      let data: unknown;
      try {
        data = JSON.parse(content);
      } catch {
        // 如果不是 JSON，作为纯文本处理
        return content;
      }
      
      // 获取嵌套值
      return this.getNestedValue(data, key);
    } catch {
      return undefined;
    }
  }

  /**
   * 解析并获取协议引用的值
   * 返回 null 表示解析失败（如协议不支持、文件不存在等）
   */
  private resolveInternal(ref: ProtocolRef): unknown {
    switch (ref.protocol) {
      case "env":
        return process.env[ref.path];
      case "file":
        return this.resolveFileRef(ref.path, ref.key);
    }
  }

  /**
   * 解析路径（处理相对路径）
   */
  private resolvePath(filePath: string): string {
    if (filePath.startsWith("/")) {
      // 绝对路径
      return filePath;
    }
    
    if (filePath.startsWith("~")) {
      // ~ 开头，替换为 HOME
      return filePath.replace("~", process.env.HOME ?? "");
    }

    // 相对路径，基于 XDG_DATA_HOME
    return `${this._xdgDataHome}/${filePath}`;
  }

  /**
   * 获取嵌套值
   */
  private getNestedValue(obj: unknown, key: string): unknown {
    if (key === "$" || key === "") return obj;

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
}

export { PROTOCOL_PATTERN };
