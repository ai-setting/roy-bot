# Component 去中心化配置注册设计

## 1. 概述

本文档描述 roy-bot 中 Component 的去中心化配置注册机制。

**核心理念**：每个 Component 自己声明需要的 Source 和配置 Key，ConfigComponent 统一管理和加载。

**设计背景**：
- 传统方案：集中式配置，所有配置集中管理，导致 ConfigComponent 臃肿
- 去中心化方案：各 Component 自主声明，ConfigComponent 按需创建和管理 Source

---

## 2. 设计原则

```
┌─────────────────────────────────────────────────────────────────────┐
│                    去中心化配置注册原则                                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   ✓ 各 Component 自主注册                                            │
│     Component init 时声明自己需要的 Source 和配置 Key                    │
│                                                                     │
│   ✓ ConfigComponent 统一管理                                         │
│     按 Component 声明创建 Source，加载配置                             │
│                                                                     │
│   ✓ Source 按需加载                                                 │
│     只注册 Component 需要的 Source，不强制内置所有层级                  │
│                                                                     │
│   ✓ 相对路径统一解析                                                 │
│     FileSource 使用相对路径，通过 getPath + XDG_DATA_HOME 获取完整路径  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. 核心架构

### 3.1 Component 注册流程

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Component 注册流程                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   LLMComponent.init()                                              │
│       │                                                             │
│       ├──→ ConfigComponent.registerSource({                       │
│       │       type: "file",                                       │
│       │       relativePath: "llm-config.jsonc"                    │
│       │   })                                                        │
│       │                                                             │
│       ├──→ ConfigComponent.registerKeys([                         │
│       │       { key: "llm.provider", sources: ["file", "env", "memory"] },
│       │       { key: "llm.model", sources: ["file", "memory"] },   │
│       │   ])                                                        │
│       │                                                             │
│       └──→ ConfigComponent.load()  // 按需加载该 Component 的配置     │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 配置加载流程

```
┌─────────────────────────────────────────────────────────────────────┐
│                    配置加载流程                                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   ConfigComponent                                                   │
│       │                                                             │
│       ├── 管理所有注册的 Source                                      │
│       │   ├── MemorySource (内置)                                   │
│       │   ├── FileSource (按需注册)                                  │
│       │   └── EnvSource (按需注册)                                   │
│       │                                                             │
│       ├── 管理所有注册的 Keys                                        │
│       │   └── { "llm.provider": [file, memory, env], ... }         │
│       │                                                             │
│       └── load()                                                    │
│           │                                                         │
│           └──→ 按 Key 优先级查询各 Source                            │
│               ├── MemorySource (优先级 0)                            │
│               ├── FileSource (优先级 10)                            │
│               └── EnvSource (优先级 20)                             │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.3 Source 优先级

| Source | 优先级 | 说明 |
|--------|--------|------|
| MemorySource | 0 | 运行时内存，最先查询 |
| FileSource | 10 | 本地配置文件 |
| EnvSource | 20 | 环境变量，最后查询（最高优先级） |

**优先级规则**：数字越小优先级越低，查询时从低到高，**首次找到的值即采用**。

---

## 4. 核心接口定义

### 4.1 ComponentRegistration

```typescript
/**
 * Component 注册配置
 * 每个 Component 在 init 时声明自己的配置需求
 */
export interface ComponentRegistration {
  /** Component 名称 */
  name: string;
  
  /** 声明需要的 Source */
  sources: SourceRegistration[];
  
  /** 声明需要的配置 Key */
  keys: KeyRegistration[];
  
  /** 配置 Schema (用于验证，可选) */
  schema?: ZodSchema;
  
  /** 默认值 */
  defaults?: Record<string, unknown>;
}
```

### 4.2 SourceRegistration

```typescript
/**
 * Source 注册配置
 */
export interface SourceRegistration {
  /** Source 类型 */
  type: "memory" | "file" | "env";
  
  /** 相对路径 (file source 专用，基于 XDG_DATA_HOME) */
  relativePath?: string;
  
  /** 环境变量前缀 (env source 专用) */
  envPrefix?: string;
  
  /** 优先级 (数字越小优先级越低，默认值见 Source 优先级表) */
  priority?: number;
  
  /** 加载选项 */
  options?: {
    /** 是否可选 (file 不存在时不报错) */
    optional?: boolean;
    /** 解析格式 */
    format?: "json" | "jsonc" | "yaml";
  };
}
```

### 4.3 KeyRegistration

```typescript
/**
 * Key 注册配置
 */
export interface KeyRegistration {
  /** 配置 Key (支持点号分隔的嵌套路径) */
  key: string;
  
  /** 可用的 Source 类型列表 (按优先级排序) */
  sources: ("memory" | "file" | "env")[];
  
  /** 是否必需 (默认 false) */
  required?: boolean;
  
  /** 默认值 */
  default?: unknown;
  
  /** 验证器 (可选) */
  validate?: (value: unknown) => boolean;
}
```

### 4.4 ConfigSource 接口

```typescript
/**
 * 配置源接口
 */
export interface ConfigSource {
  /** Source 类型 */
  readonly type: "memory" | "file" | "env";
  
  /** 优先级 (数字越小优先级越低) */
  readonly priority: number;
  
  /** 获取配置值 */
  get(key: string): Promise<unknown>;
  
  /** 设置配置值 (仅 memory source 支持) */
  set?(key: string, value: unknown): Promise<void>;
  
  /** 检查是否包含某个 key */
  has(key: string): Promise<boolean>;
  
  /** 获取所有配置 */
  getAll(): Promise<Record<string, unknown>>;
}

/**
 * MemorySource - 内存配置源
 */
export class MemorySource implements ConfigSource {
  readonly type = "memory" as const;
  readonly priority = 0;
  
  private store: Map<string, unknown> = new Map();
  
  async get(key: string): Promise<unknown> {
    return this.store.get(key);
  }
  
  async set(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }
  
  async has(key: string): Promise<boolean> {
    return this.store.has(key);
  }
  
  async getAll(): Promise<Record<string, unknown>> {
    return Object.fromEntries(this.store.entries());
  }
}

/**
 * FileSource - 文件配置源
 */
export class FileSource implements ConfigSource {
  readonly type = "file" as const;
  readonly priority: number;
  
  constructor(
    private relativePath: string,
    options?: {
      priority?: number;
      format?: "json" | "jsonc" | "yaml";
      optional?: boolean;
    }
  ) {
    this.priority = options?.priority ?? 10;
    this.format = options?.format ?? "jsonc";
    this.optional = options?.optional ?? false;
  }
  
  private data: Record<string, unknown> | null = null;
  private loaded = false;
  
  /** 获取完整文件路径 */
  private getFilePath(): string {
    const xdgDataHome = process.env.XDG_DATA_HOME ?? 
      path.join(os.homedir(), ".local", "share");
    return path.join(xdgDataHome, this.relativePath);
  }
  
  /** 加载配置文件 */
  async load(): Promise<void> {
    if (this.loaded) return;
    
    const filePath = this.getFilePath();
    
    if (!fs.existsSync(filePath)) {
      if (this.optional) {
        this.data = {};
        this.loaded = true;
        return;
      }
      throw new ConfigFileNotFoundError(filePath);
    }
    
    const content = fs.readFileSync(filePath, "utf-8");
    this.data = this.parseContent(content);
    this.loaded = true;
  }
  
  private parseContent(content: string): Record<string, unknown> {
    switch (this.format) {
      case "json":
        return JSON.parse(content);
      case "jsonc":
        return parseJSONC(content);
      case "yaml":
        return yaml.parse(content);
      default:
        return JSON.parse(content);
    }
  }
  
  async get(key: string): Promise<unknown> {
    await this.load();
    if (!this.data) return undefined;
    return getNestedValue(this.data, key);
  }
  
  async has(key: string): Promise<boolean> {
    await this.load();
    if (!this.data) return false;
    return getNestedValue(this.data, key) !== undefined;
  }
  
  async getAll(): Promise<Record<string, unknown>> {
    await this.load();
    return this.data ?? {};
  }
}

/**
 * EnvSource - 环境变量配置源
 */
export class EnvSource implements ConfigSource {
  readonly type = "env" as const;
  readonly priority = 20;
  
  constructor(
    private envPrefix: string = "",
    options?: { priority?: number }
  ) {
    this.priority = options?.priority ?? 20;
  }
  
  /** 将 key 转换为环境变量名 */
  private keyToEnvVar(key: string): string {
    const prefix = this.envPrefix ? `${this.envPrefix}_` : "";
    const upperKey = key.toUpperCase().replace(/\./g, "_");
    return `${prefix}${upperKey}`;
  }
  
  async get(key: string): Promise<unknown> {
    const envVar = this.keyToEnvVar(key);
    return process.env[envVar] ?? undefined;
  }
  
  async has(key: string): Promise<boolean> {
    const envVar = this.keyToEnvVar(key);
    return envVar in process.env;
  }
  
  async getAll(): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    const prefix = this.envPrefix ? `${this.envPrefix}_` : "";
    
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith(prefix)) {
        const configKey = key
          .slice(prefix.length)
          .toLowerCase()
          .replace(/_/g, ".");
        result[configKey] = value;
      }
    }
    
    return result;
  }
}
```

---

## 5. ConfigComponent 实现

### 5.1 核心实现

```typescript
/**
 * ConfigComponent - 配置中心
 * 统一管理所有 Component 的配置注册和加载
 */
export class ConfigComponent extends BaseComponent {
  readonly name = "config";
  readonly version = "1.0.0";
  
  // 已注册的 Source
  private sources: Map<string, ConfigSource> = new Map();
  
  // 已注册的 Keys
  private keyRegistry: Map<string, KeyRegistration> = new Map();
  
  // Component 注册信息
  private componentRegistrations: Map<string, ComponentRegistration> = new Map();
  
  // 默认内置 Source
  private memorySource = new MemorySource();
  
  /**
   * 注册 Source
   */
  registerSource(registration: SourceRegistration): void {
    const sourceId = this.generateSourceId(registration);
    
    let source: ConfigSource;
    
    switch (registration.type) {
      case "memory":
        source = this.memorySource;
        break;
        
      case "file":
        if (!registration.relativePath) {
          throw new Error("FileSource requires relativePath");
        }
        source = new FileSource(registration.relativePath, {
          priority: registration.priority,
          format: registration.options?.format ?? "jsonc",
          optional: registration.options?.optional ?? false,
        });
        break;
        
      case "env":
        source = new EnvSource(registration.envPrefix, {
          priority: registration.priority,
        });
        break;
        
      default:
        throw new Error(`Unknown source type: ${(registration as any).type}`);
    }
    
    this.sources.set(sourceId, source);
  }
  
  /**
   * 注册 Keys
   */
  registerKeys(keys: KeyRegistration[]): void {
    for (const key of keys) {
      this.keyRegistry.set(key.key, key);
    }
  }
  
  /**
   * 注册 Component
   */
  registerComponent(registration: ComponentRegistration): void {
    // 注册所有 Source
    for (const source of registration.sources) {
      this.registerSource(source);
    }
    
    // 注册所有 Keys
    this.registerKeys(registration.keys);
    
    // 保存 Component 注册信息
    this.componentRegistrations.set(registration.name, registration);
  }
  
  /**
   * 获取配置值 (按优先级查询)
   */
  async get(key: string): Promise<unknown> {
    const keyReg = this.keyRegistry.get(key);
    const sourceTypes = keyReg?.sources ?? ["memory", "file", "env"];
    
    // 按优先级排序 Source 类型
    const sortedTypes = this.sortByPriority(sourceTypes);
    
    for (const type of sortedTypes) {
      const source = this.findSource(type);
      if (!source) continue;
      
      if (await source.has(key)) {
        return await source.get(key);
      }
    }
    
    // 返回默认值
    return keyReg?.default;
  }
  
  /**
   * 设置配置值 (仅写入 MemorySource)
   */
  async set(key: string, value: unknown): Promise<void> {
    await this.memorySource.set(key, value);
  }
  
  /**
   * 加载配置 (批量)
   */
  async load(keys?: string[]): Promise<Record<string, unknown>> {
    const keysToLoad = keys ?? Array.from(this.keyRegistry.keys());
    const result: Record<string, unknown> = {};
    
    for (const key of keysToLoad) {
      result[key] = await this.get(key);
    }
    
    return result;
  }
  
  /**
   * 获取 Component 的所有配置
   */
  async getComponentConfig(componentName: string): Promise<Record<string, unknown>> {
    const registration = this.componentRegistrations.get(componentName);
    if (!registration) {
      throw new Error(`Component not registered: ${componentName}`);
    }
    
    const keys = registration.keys.map(k => k.key);
    return await this.load(keys);
  }
  
  /**
   * 按优先级排序 Source 类型
   */
  private sortByPriority(types: ("memory" | "file" | "env")[]): ("memory" | "file" | "env")[] {
    const priorityMap: Record<string, number> = {
      memory: 0,
      file: 10,
      env: 20,
    };
    
    return [...types].sort((a, b) => 
      (priorityMap[a] ?? 999) - (priorityMap[b] ?? 999)
    );
  }
  
  /**
   * 查找 Source
   */
  private findSource(type: "memory" | "file" | "env"): ConfigSource | undefined {
    for (const source of this.sources.values()) {
      if (source.type === type) {
        return source;
      }
    }
    return undefined;
  }
  
  /**
   * 生成 Source ID
   */
  private generateSourceId(registration: SourceRegistration): string {
    if (registration.type === "file") {
      return `file:${registration.relativePath}`;
    }
    if (registration.type === "env") {
      return `env:${registration.envPrefix ?? ""}`;
    }
    return registration.type;
  }
}
```

---

## 6. Component 集成示例

### 6.1 LLMComponent 注册示例

```typescript
export class LLMComponent extends BaseComponent {
  readonly name = "llm";
  readonly version = "1.0.0";
  
  async init(config?: ComponentConfig): Promise<void> {
    // 注册 Component 及其配置需求
    ConfigComponent.registerComponent({
      name: "llm",
      sources: [
        {
          type: "file",
          relativePath: "llm-config.jsonc",
          options: { format: "jsonc", optional: true }
        },
        {
          type: "env",
          envPrefix: "LLM"
        }
      ],
      keys: [
        { key: "llm.provider", sources: ["file", "env", "memory"], required: true },
        { key: "llm.model", sources: ["file", "memory"] },
        { key: "llm.temperature", sources: ["file", "env", "memory"], default: 0.7 },
        { key: "llm.maxTokens", sources: ["file", "memory"] },
        { key: "llm.baseURL", sources: ["file", "env", "memory"] },
        { key: "llm.apiKey", sources: ["env", "file", "memory"] },
      ]
    });
    
    // 加载配置
    const config = await ConfigComponent.getComponentConfig("llm");
    
    // 使用配置
    this.provider = config["llm.provider"] as string;
    this.model = config["llm.model"] as string;
    this.temperature = config["llm.temperature"] as number;
  }
}
```

### 6.2 SessionComponent 注册示例

```typescript
export class SessionComponent extends BaseComponent {
  readonly name = "session";
  readonly version = "1.0.0";
  
  async init(config?: ComponentConfig): Promise<void> {
    ConfigComponent.registerComponent({
      name: "session",
      sources: [
        {
          type: "file",
          relativePath: "session-config.jsonc"
        }
      ],
      keys: [
        { key: "session.maxHistory", sources: ["file", "memory"], default: 100 },
        { key: "session.autoCompact", sources: ["file", "memory"], default: true },
        { key: "session.compactThreshold", sources: ["file", "memory"], default: 0.8 },
      ]
    });
    
    const config = await ConfigComponent.getComponentConfig("session");
    this.maxHistory = config["session.maxHistory"] as number;
  }
}
```

---

## 7. 配置文件格式

### 7.1 JSONC 格式 (推荐)

```jsonc
// ~/.local/share/llm-config.jsonc
{
  // LLM 配置
  "llm": {
    "provider": "openai",
    "model": "gpt-4",
    "temperature": 0.7,
    "maxTokens": 4096,
    "baseURL": "https://api.openai.com/v1",
    
    // API 密钥 (敏感信息建议使用环境变量)
    "apiKey": "${OPENAI_API_KEY}"
  },
  
  // 提供商配置
  "providers": {
    "minimax": {
      "provider": "openai-compatible",
      "baseURL": "https://api.minimax.chat/v1",
      "apiKey": "${MINIMAX_API_KEY}"
    }
  }
}
```

### 7.2 相对路径解析

```
FileSource relativePath: "llm-config.jsonc"
    ↓
XDG_DATA_HOME: ~/.local/share (默认)
    ↓
完整路径: ~/.local/share/llm-config.jsonc
```

**自定义 XDG_DATA_HOME**:
```bash
export XDG_DATA_HOME=/custom/path
# → /custom/path/llm-config.jsonc
```

---

## 8. 错误处理

### 8.1 错误类型

```typescript
/**
 * 配置相关错误
 */
export class ConfigError extends Error {
  constructor(
    message: string,
    public code: string,
    public context?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * 配置文件未找到
 */
export class ConfigFileNotFoundError extends ConfigError {
  constructor(filePath: string) {
    super(
      `Configuration file not found: ${filePath}`,
      "CONFIG_FILE_NOT_FOUND",
      { filePath }
    );
  }
}

/**
 * 配置解析错误
 */
export class ConfigParseError extends ConfigError {
  constructor(filePath: string, cause: Error) {
    super(
      `Failed to parse configuration file: ${filePath}`,
      "CONFIG_PARSE_ERROR",
      { filePath, cause: cause.message }
    );
  }
}

/**
 * 必需配置缺失
 */
export class ConfigRequiredError extends ConfigError {
  constructor(key: string) {
    super(
      `Required configuration key is missing: ${key}`,
      "CONFIG_REQUIRED",
      { key }
    );
  }
}

/**
 * 配置验证错误
 */
export class ConfigValidationError extends ConfigError {
  constructor(key: string, value: unknown, schema: string) {
    super(
      `Configuration validation failed for key: ${key}`,
      "CONFIG_VALIDATION",
      { key, value, schema }
    );
  }
}
```

### 8.2 错误处理策略

```typescript
// 在 ConfigComponent 中

/**
 * 获取配置值，带错误处理
 */
async getSafely(key: string, fallback?: unknown): Promise<unknown> {
  try {
    const value = await this.get(key);
    
    // 检查必需配置
    const keyReg = this.keyRegistry.get(key);
    if (keyReg?.required && value === undefined) {
      throw new ConfigRequiredError(key);
    }
    
    return value ?? fallback;
  } catch (error) {
    if (error instanceof ConfigError) {
      // 已知错误类型，重新抛出
      throw error;
    }
    
    // 未知错误，包装
    throw new ConfigError(
      `Failed to get config: ${key}`,
      "CONFIG_GET_ERROR",
      { key, cause: error }
    );
  }
}

/**
 * 加载配置，带部分成功支持
 */
async loadWithPartialSuccess(keys: string[]): Promise<{
  success: Record<string, unknown>;
  failed: Array<{ key: string; error: ConfigError }>;
}> {
  const success: Record<string, unknown> = {};
  const failed: Array<{ key: string; error: ConfigError }> = [];
  
  for (const key of keys) {
    try {
      success[key] = await this.getSafely(key);
    } catch (error) {
      if (error instanceof ConfigError) {
        failed.push({ key, error });
      } else {
        failed.push({
          key,
          error: new ConfigError("Unknown error", "UNKNOWN", { key, cause: error })
        });
      }
    }
  }
  
  return { success, failed };
}
```

---

## 9. 使用示例

### 9.1 完整使用流程

```typescript
// main.ts
import { ConfigComponent } from "./config";
import { LLMComponent } from "./llm";
import { SessionComponent } from "./session";

async function main() {
  // 1. 创建 ConfigComponent (全局单例)
  const config = ConfigComponent.getInstance();
  
  // 2. 创建其他 Component (会自动注册配置需求)
  const llm = new LLMComponent();
  const session = new SessionComponent();
  
  // 3. 初始化所有 Component
  await llm.init();
  await session.init();
  
  // 4. 运行时修改配置 (写入 MemorySource)
  await config.set("llm.temperature", 0.9);
  
  // 5. 获取配置
  const temperature = await config.get("llm.temperature");
  console.log(`Temperature: ${temperature}`);
}

main();
```

### 9.2 配置文件示例

```jsonc
// ~/.local/share/llm-config.jsonc
{
  "llm": {
    "provider": "openai",
    "model": "gpt-4",
    "temperature": 0.7,
    "maxTokens": 4096
  }
}
```

```jsonc
// ~/.local/share/session-config.jsonc
{
  "session": {
    "maxHistory": 100,
    "autoCompact": true,
    "compactThreshold": 0.8
  }
}
```

### 9.3 环境变量覆盖

```bash
# 设置环境变量 (最高优先级)
export LLM_PROVIDER=anthropic
export LLM_MODEL=claude-3

# 运行时
# llm.provider = "anthropic" (来自环境变量)
# llm.model = "claude-3" (来自环境变量)
```

### 9.4 运行时修改

```typescript
// 运行时设置 (写入 MemorySource)
await config.set("llm.temperature", 0.9);

// 获取当前配置
const current = await config.get("llm.temperature"); // 0.9
```

---

## 10. 与旧设计的对比

### 10.1 旧设计 (集中式)

```
┌─────────────────────────────────────────────────────────────┐
│                     旧: 集中式配置                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   ConfigComponent                                          │
│   ├── 内置 MemorySource                                     │
│   ├── 内置 FileSource (config.json)                         │
│   ├── 内置 EnvSource                                        │
│   └── 知道所有 Component 的配置                              │
│                                                             │
│   问题:                                                    │
│   - ConfigComponent 臃肿                                   │
│   - 添加新配置需要修改 ConfigComponent                       │
│   - 难以扩展新的 Source 类型                                │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 10.2 新设计 (去中心化)

```
┌─────────────────────────────────────────────────────────────┐
│                     新: 去中心化配置                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   LLMComponent         SessionComponent      ToolComponent  │
│   ├── registerSource  ├── registerSource    ├── ...        │
│   ├── registerKeys    ├── registerKeys      │              │
│   └── ...             └── ...               │              │
│           │                 │                │              │
│           └────────┬────────┴────────────────┘              │
│                ConfigComponent                              │
│                ├── 管理 Source (按需创建)                    │
│                ├── 管理 Key Registry                        │
│                └── 按优先级加载配置                          │
│                                                             │
│   优点:                                                    │
│   - ConfigComponent 保持简洁                                │
│   - 各 Component 自主声明配置需求                           │
│   - 易扩展、易维护                                          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 11. 配置引用协议

### 11.1 协议引用概述

在配置文件中，可以使用协议引用来引用其他配置源的值，实现配置的关联和复用。

```
┌─────────────────────────────────────────────────────────────────────┐
│                    配置引用协议架构                                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   配置文件 (llm-config.jsonc)                                       │
│   ├── "apiKey": "${file://auth#minimax.key}"                       │
│   ├── "baseURL": "${env://MINIMAX_BASE_URL}"                       │
│   └── "model": "${MINIMAX_MODEL}"                                  │
│                                                                     │
│   FileSource 加载时                                                  │
│       │                                                             │
│       ├── parseJSONC() → 解析 JSONC                                 │
│       └── substituteProtocolRefs() → 替换协议引用                   │
│           │                                                         │
│           ├── ${file://auth#key} → 读取 auth 文件                   │
│           ├── ${env://VAR_NAME} → 读取环境变量                       │
│           └── ${VAR_NAME} → 读取环境变量 (简写)                      │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 11.2 支持的协议

| 协议 | 语法 | 说明 |
|------|------|------|
| `file://` | `${file://<alias>#<jsonpath>}` | 读取注册路径对应的文件 |
| `env://` | `${env://<VAR_NAME>}` | 读取环境变量 |
| 默认 | `${<VAR_NAME>}` | 读取环境变量（简写） |

### 11.3 file:// 协议

用于引用其他配置文件中的值。

**语法**:
```
${file://<alias>#<jsonpath>}
```

**参数**:
- `alias`: XDG_PATHS 中注册的路径别名
- `jsonpath`: JSON 文件中的点号路径

**示例**:

```jsonc
// ~/.local/share/llm-config.jsonc
{
  "llm": {
    "provider": "minimax",
    "model": "MiniMax-M2.7",
    
    // 引用 auth 文件中的密钥
    "apiKey": "${file://auth#minimax.apiKey}",
    "baseURL": "${file://auth#minimax.baseURL}",
    
    // 引用环境变量
    "embeddingKey": "${env://MINIMAX_EMBEDDING_KEY}"
  }
}

// ~/.local/share/auth.json
{
  "minimax": {
    "apiKey": "sk-xxx",
    "baseURL": "https://api.minimax.chat/v1"
  }
}
```

### 11.4 env:// 协议

用于读取环境变量。

**语法**:
```
${env://<VAR_NAME>}
```

**示例**:

```jsonc
{
  "apiKey": "${env://OPENAI_API_KEY}",
  "baseURL": "${env://OPENAI_BASE_URL}"
}
```

### 11.5 默认协议（简写）

环境变量的简写语法。

**语法**:
```
${<VAR_NAME>}
```

**示例**:

```jsonc
{
  "apiKey": "${OPENAI_API_KEY}",
  "temperature": "${DEFAULT_TEMPERATURE:-0.7}"
}
```

### 11.6 默认值语法

所有协议都支持默认值语法：

```
${protocol://...:-defaultValue}
```

**示例**:

```jsonc
{
  "temperature": "${TEMPERATURE:-0.7}",
  "apiKey": "${file://auth#provider.key:-${env://DEFAULT_KEY}}"
}
```

### 11.7 引用替换流程

当 `substituteProtocolRefs()` 遇到 `${file://auth#minimax.key}` 时：

```
1. 解析协议
   "file://auth#minimax.key"
         ↓
   protocol: "file"
   alias: "auth"
   jsonpath: "minimax.key"

2. 获取文件路径
   XDG_PATHS.getPath("auth")
         ↓
   path.join(XDG_DATA_HOME, "auth")
         ↓
   "~/.local/share/auth"

3. 读取并解析文件
   JSON.parse(fs.readFileSync("~/.local/share/auth"))
         ↓
   { "minimax": { "apiKey": "sk-xxx", ... } }

4. 提取目标值
   getNestedValue(data, "minimax.apiKey")
         ↓
   "sk-xxx"
```

### 11.8 实现：ProtocolResolver

```typescript
// protocol-resolver.ts

export class ProtocolResolver {
  private xdgDataHome: string;
  
  constructor(options: ProtocolResolverOptions = {}) {
    this.xdgDataHome = options.xdgDataHome 
      ?? `${process.env.HOME}/.local/share`;
  }
  
  /**
   * 解析协议引用
   * 支持: ${file://path#key}, ${env://VAR}, ${VAR}, ${...:-default}
   */
  resolve(ref: string): ResolveResult | null {
    // 解析协议
    const parsed = this.parse(ref);
    if (!parsed) return null;
    
    // 解析值
    const value = this.resolveProtocol(parsed);
    return { value, source: parsed.protocol };
  }
  
  private resolveProtocol(parsed: ProtocolRef): unknown {
    switch (parsed.protocol) {
      case "env":
        return process.env[parsed.path] ?? parsed.defaultValue;
      
      case "file":
        return this.resolveFileRef(parsed.path, parsed.key);
      
      default:
        return parsed.defaultValue;
    }
  }
  
  private resolveFileRef(filePath: string, jsonpath: string): unknown {
    const resolvedPath = this.resolvePath(filePath);
    if (!resolvedPath) return undefined;
    
    try {
      const content = fs.readFileSync(resolvedPath, "utf-8");
      const data = JSON.parse(content);
      return this.getNestedValue(data, jsonpath);
    } catch {
      return undefined;
    }
  }
  
  private resolvePath(filePath: string): string | undefined {
    // 检查绝对路径
    if (filePath.startsWith("/")) {
      return filePath;
    }
    
    // 检查 ~ 开头
    if (filePath.startsWith("~")) {
      return filePath.replace("~", process.env.HOME ?? "");
    }
    
    // 相对路径，基于 XDG_DATA_HOME
    return path.join(this.xdgDataHome, filePath);
  }
}
```

### 11.9 在 FileSource 中集成

```typescript
// file-source.ts

export class FileSource implements ConfigSource {
  constructor(options: FileSourceOptions) {
    this.filePath = this.resolvePath(options.filePath);
    this.protocolResolver = new ProtocolResolver({
      xdgDataHome: options.xdgDataHome,
    });
    this.initSync();
  }
  
  private initSync(): void {
    if (!fs.existsSync(this.filePath)) {
      this.data = {};
      return;
    }
    
    const content = fs.readFileSync(this.filePath, "utf-8");
    const parsed = parseJSONC(content);
    this.data = this.substituteProtocolRefs(parsed);
  }
  
  private substituteProtocolRefs(value: unknown): unknown {
    if (typeof value === "string") {
      // 检查是否是协议引用
      if (isProtocolRefString(value)) {
        const result = this.protocolResolver.resolve(value);
        if (result !== null) {
          return result.value;
        }
      }
      
      // 替换字符串中的协议引用
      return value.replace(/\${([^}]+)}/g, (match, expr) => {
        const result = this.protocolResolver.resolve(match);
        return result?.value ?? match;
      });
    }
    
    if (Array.isArray(value)) {
      return value.map(item => this.substituteProtocolRefs(item));
    }
    
    if (value !== null && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = this.substituteProtocolRefs(v);
      }
      return result;
    }
    
    return value;
  }
}
```

### 11.10 配置示例

```jsonc
// ~/.local/share/llm-config.jsonc
{
  "llm": {
    "provider": "minimax",
    "model": "MiniMax-M2.7",
    "temperature": 0.7,
    
    // 使用 file:// 协议引用认证文件
    "apiKey": "${file://config/auth.json#minimax.apiKey}",
    "baseURL": "${file://config/auth.json#minimax.baseURL}",
    
    // 引用环境变量
    "embeddingKey": "${env://MINIMAX_EMBEDDING_KEY}",
    "organization": "${MINIMAX_ORG:-default-org}"
  },
  
  "session": {
    "autoCompact": true,
    "maxHistory": "${MAX_HISTORY:-1000}",
    "contextThreshold": "${CONTEXT_THRESHOLD:-8000}"
  }
}

// ~/.local/share/config/auth.json
{
  "minimax": {
    "apiKey": "sk-xxx",
    "baseURL": "https://api.minimax.chat/v1"
  },
  "openai": {
    "apiKey": "sk-proj-xxx"
  }
}
```

---

## 12. 迁移指南

### 12.1 从旧设计迁移

如果现有代码使用集中式配置，需要做以下迁移：

1. **Component 添加注册代码**:
```typescript
// Before
class LLMComponent {
  async init() {
    this.config = ConfigComponent.get("llm");
  }
}

// After
class LLMComponent {
  async init() {
    ConfigComponent.registerComponent({
      name: "llm",
      sources: [{ type: "file", relativePath: "llm-config.jsonc" }],
      keys: [{ key: "llm.provider", sources: ["file", "env", "memory"] }]
    });
    this.config = await ConfigComponent.getComponentConfig("llm");
  }
}
```

2. **配置文件迁移**: 将原有配置拆分到各 Component 的配置文件中。

3. **移除旧配置代码**: 删除 ConfigComponent 中硬编码的配置逻辑。

---

## 12. 相关文档

- ConfigComponent 设计文档 - ConfigComponent 详细设计
- 配置引用协议 - 文件引用和变量替换机制
- Architecture 设计文档 - 整体架构设计
- Environment 设计文档 - Environment 设计
