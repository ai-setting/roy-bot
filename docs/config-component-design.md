# ConfigComponent 设计文档

## 1. 概述

ConfigComponent 是 roy-bot 中的配置中心组件，参考分布式配置中心的设计理念，提供 **Component 级别** 的配置管理能力。

**核心职责：**
- 管理所有 Component 的配置集合
- 提供内存级别实时设置 + 异步持久化机制
- 支持配置变更监听
- 类型安全的配置 Schema 验证
- 支持去中心化配置注册

---

> **📌 新设计说明**：关于 Component 去中心化配置注册的详细设计，请参阅 [component-decentralized-config-design.md](./component-decentralized-config-design.md)

## 2. 设计目标

```
┌─────────────────────────────────────────────────────────────┐
│                    ConfigComponent 设计目标                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   ✓ Component 配置声明                                      │
│     每个 Component 声明自己的 Zod Schema                    │
│                                                             │
│   ✓ Component 配置查询                                      │
│     getComponent(name) → 配置集合 + 当前值                  │
│                                                             │
│   ✓ 内存级别实时设置                                        │
│     setComponent(name, key, value) → 立即生效              │
│                                                             │
│   ✓ 异步持久化机制                                          │
│     后台队列 + 防抖写入，不阻塞主流程                        │
│                                                             │
│   ✓ 配置变更监听                                            │
│     watchComponent(name, callback) → 实时通知              │
│                                                             │
│   ✓ 类型安全验证                                            │
│     Zod Schema 验证 + 合并默认值                            │
│                                                             │
│   ✓ Env 全局配置                                            │
│     XDG 路径 + 环境级别配置 + 全局配置                      │
│                                                             │
│   ✓ 去中心化配置注册 (新)                                   │
│     Component 自主声明 Source 和 Key                        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. 核心概念

### 3.1 去中心化配置注册

参见 [component-decentralized-config-design.md](./component-decentralized-config-design.md) 的详细设计。

核心流程：

```
Component.init()
    │
    ├──→ ConfigComponent.registerSource({ type: "file", relativePath: "xxx.jsonc" })
    ├──→ ConfigComponent.registerKeys([
    │       { key: "xxx.config", sources: ["file", "env", "memory"] }
    │   ])
    └──→ ConfigComponent.load()  // 按需加载配置
```

### 3.2 Component 配置声明机制

每个 Component 必须声明自己的配置 Schema，用于：
1. 定义配置项及默认值
2. 类型安全验证
3. 配置合并

```typescript
// 定义配置 Schema（每个 Component 自行定义）
class AgentComponent implements Component {
  // 静态配置 Schema
  static configSchema = z.object({
    provider: z.string().describe("LLM Provider"),
    model: z.string().default("gpt-4").describe("模型名称"),
    temperature: z.number().min(0).max(2).default(0.7).describe("温度参数"),
    maxTokens: z.number().int().positive().optional().describe("最大 Token 数"),
    systemPrompt: z.string().optional().describe("系统提示词"),
  });

  // Component 元信息
  readonly name = "agent";
  readonly version = "1.0.0";
  
  // 运行时配置（由 ConfigComponent 注入）
  config: z.infer<typeof AgentComponent.configSchema>;
}

// 使用示例
const agent = new AgentComponent();
agent.config = {
  provider: "openai",
  model: "gpt-4",           // 使用默认值
  temperature: 0.8,         // 自定义值
  // maxTokens: undefined   // 可选字段
};
```

### 3.3 配置存储结构

```
┌─────────────────────────────────────────────────────────────┐
│                 Component 配置存储结构                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   ConfigComponent                                          │
│   ├── registeredComponents: Map<string, ComponentSchema>   │
│   │   ├── "agent" → { schema, defaults, metadata }        │
│   │   ├── "session" → { schema, defaults, metadata }      │
│   │   └── "memory" → { schema, defaults, metadata }       │
│   │                                                            │
│   ├── runtimeConfigs: Map<string, Record<string, unknown>> │
│   │   ├── "agent" → { temperature: 0.8, model: "gpt-4" } │
│   │   └── "session" → { autoCompact: true, ... }          │
│   │                                                            │
│   ├── sources: Map<string, ConfigSource>                   │
│   │   ├── "memory" → MemorySource                          │
│   │   ├── "file:llm-config.jsonc" → FileSource            │
│   │   └── "env:LLM" → EnvSource                            │
│   │                                                            │
│   ├── keyRegistry: Map<string, KeyRegistration>             │
│   │   └── { "llm.provider": { sources: ["file", "memory"] } }│
│   │                                                            │
│   └── persistQueue: AsyncPersistQueue                       │
│       └── 后台异步写入持久层                                  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 3.4 配置查询流程

```
┌─────────────────────────────────────────────────────────────┐
│                 getComponent(name) 查询流程                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   getComponent("agent")                                    │
│       │                                                     │
│       ▼                                                     │
│   ┌─────────────────────────────────────────────────────┐ │
│   │ Step 1: 获取 Schema                                  │ │
│   │   schema = registeredComponents.get("agent")         │
│   │   → 获取 configSchema + defaults                   │
│   └─────────────────────────────────────────────────────┘ │
│       │                                                   │
│       ▼                                                     │
│   ┌─────────────────────────────────────────────────────┐ │
│   │ Step 2: 获取运行时配置                                │ │
│   │   runtime = runtimeConfigs.get("agent") || {}       │
│   └─────────────────────────────────────────────────────┘ │
│       │                                                   │
│       ▼                                                     │
│   ┌─────────────────────────────────────────────────────┐ │
│   │ Step 3: 合并配置 (defaults + runtime)                │ │
│   │   merged = { ...defaults, ...runtime }               │
│   └─────────────────────────────────────────────────────┘ │
│       │                                                   │
│       ▼                                                     │
│   ┌─────────────────────────────────────────────────────┐ │
│   │ Step 4: Schema 验证                                  │ │
│   │   validated = schema.parse(merged)                   │
│   └─────────────────────────────────────────────────────┘ │
│       │                                                   │
│       ▼                                                     │
│   返回合并后的配置对象                                      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. 配置源 (Source) 优先级

参见 [component-decentralized-config-design.md](./component-decentralized-config-design.md#33-source-优先级)

| Source | 优先级 | 说明 |
|--------|--------|------|
| MemorySource | 0 | 运行时内存，最先查询 |
| FileSource | 10 | 本地配置文件 |
| EnvSource | 20 | 环境变量，最后查询（最高优先级） |

---

## 5. XDG 路径与配置

### 5.1 XDG Base Directory Specification

```
~/.local/share/           # XDG_DATA_HOME (默认)
├── llm-config.jsonc     # LLMComponent 配置
├── session-config.jsonc # SessionComponent 配置
├── memory/              # MemoryComponent 数据
│   ├── sessions/        # 会话数据
│   └── knowledge/       # 知识库
└── cache/              # 缓存目录
```

### 5.2 环境变量

| 环境变量 | 说明 | 默认值 |
|----------|------|--------|
| `XDG_DATA_HOME` | 数据目录 | `~/.local/share` |
| `XDG_CONFIG_HOME` | 配置目录 | `~/.config` |
| `XDG_STATE_HOME` | 状态目录 | `~/.local/state` |
| `XDG_CACHE_HOME` | 缓存目录 | `~/.cache` |

---

## 6. 使用示例

### 6.1 基础使用

```typescript
import { ConfigComponent } from "./components/config";

// 获取 Component 配置
const agentConfig = ConfigComponent.getComponent("agent");
console.log(agentConfig);
// {
//   provider: "openai",
//   model: "gpt-4",
//   temperature: 0.8
// }

// 设置配置 (内存级别)
ConfigComponent.setComponent("agent", "temperature", 0.9);

// 监听配置变更
ConfigComponent.watchComponent("agent", (key, newValue, oldValue) => {
  console.log(`agent.${key} changed: ${oldValue} → ${newValue}`);
});
```

### 6.2 Component 注册配置

```typescript
// 在 Component.init() 中注册
class LLMComponent extends BaseComponent {
  async init(config?: ComponentConfig): Promise<void> {
    // 注册配置需求
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
      ]
    });
    
    // 加载配置
    const config = await ConfigComponent.getComponentConfig("llm");
    this.provider = config["llm.provider"] as string;
  }
}
```

### 6.3 批量操作

```typescript
// 批量获取配置
const configs = ConfigComponent.getComponents(["agent", "session", "llm"]);

// 批量设置配置
ConfigComponent.setComponents("agent", {
  temperature: 0.9,
  maxTokens: 4096
});
```

---

## 7. 配置持久化

### 7.1 异步持久化机制

```
┌─────────────────────────────────────────────────────────────┐
│                    异步持久化流程                               │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   ConfigComponent.setComponent(key, value)                 │
│       │                                                     │
│       ├── 1. 立即写入 runtimeConfigs (内存)                 │
│       │                                                     │
│       ├── 2. 加入 persistQueue (防抖队列)                   │
│       │                                                     │
│       └── 3. 后台定时写入 (debounce 1s)                      │
│               │                                             │
│               └── 写入配置文件                                │
│                                                             │
│   优势:                                                    │
│   - setComponent 立即返回，不阻塞主流程                      │
│   - 批量写入，减少 IO 操作                                  │
│   - 程序异常退出时，最多丢失 1s 的配置修改                   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 7.2 持久化配置

```yaml
# .roy-bot/config.yaml
persist:
  # 持久化开关
  enabled: true
  
  # 持久化延迟 (ms)
  debounceMs: 1000
  
  # 持久化目录
  directory: ~/.config/roy-bot
  
  # 持久化格式
  format: jsonc
```

---

## 8. 配置验证

### 8.1 Schema 验证

```typescript
import { z } from "zod";

// 定义配置 Schema
const AgentConfigSchema = z.object({
  provider: z.string(),
  model: z.string().default("gpt-4"),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().int().positive().optional(),
  systemPrompt: z.string().optional(),
});

// 验证配置
const result = AgentConfigSchema.safeParse({
  provider: "openai",
  temperature: 0.9,
});

if (!result.success) {
  console.error("配置验证失败:", result.error.issues);
} else {
  const config = result.data; // 类型安全的配置对象
}
```

### 8.2 嵌套 Schema

```typescript
// 复杂配置的 Schema 定义
const LLMProviderConfigSchema = z.object({
  provider: z.enum(["openai", "anthropic", "azure", "custom"]),
  model: z.string(),
  apiKey: z.string().optional(),
  baseURL: z.string().url().optional(),
  
  // 嵌套配置
  retry: z.object({
    maxAttempts: z.number().default(3),
    backoff: z.enum(["exponential", "linear"]).default("exponential"),
  }).optional(),
  
  // 数组配置
  stopSequences: z.array(z.string()).optional(),
});

// 验证
const providerConfig = LLMProviderConfigSchema.parse({
  provider: "openai",
  model: "gpt-4",
  retry: {
    maxAttempts: 5,
  },
});
```

---

## 9. 配置变更监听

### 9.1 监听器 API

```typescript
// 监听单个 Component 的所有配置变更
const unwatch = ConfigComponent.watchComponent("agent", (key, newValue, oldValue) => {
  console.log(`agent.${key}: ${oldValue} → ${newValue}`);
});

// 监听所有 Component 的配置变更
const unwatchAll = ConfigComponent.watch((component, key, newValue, oldValue) => {
  console.log(`${component}.${key} changed`);
});

// 取消监听
unwatch();
```

### 9.2 监听器实现

```typescript
type ConfigWatcher = (
  component: string,
  key: string,
  newValue: unknown,
  oldValue: unknown
) => void;

class ConfigComponent {
  private watchers: Map<string, Set<ConfigWatcher>> = new Map();
  
  watchComponent(component: string, watcher: ConfigWatcher): () => void {
    if (!this.watchers.has(component)) {
      this.watchers.set(component, new Set());
    }
    this.watchers.get(component)!.add(watcher);
    
    // 返回取消监听函数
    return () => {
      this.watchers.get(component)?.delete(watcher);
    };
  }
  
  watchAll(watcher: ConfigWatcher): () => void {
    return this.watchComponent("*", watcher);
  }
  
  private notifyWatchers(component: string, key: string, newValue: unknown, oldValue: unknown): void {
    // 通知 Component 特定的监听器
    this.watchers.get(component)?.forEach(watcher => {
      watcher(component, key, newValue, oldValue);
    });
    
    // 通知全局监听器 (*)
    this.watchers.get("*")?.forEach(watcher => {
      watcher(component, key, newValue, oldValue);
    });
  }
}
```

---

## 10. CLI 集成

### 10.1 config 子命令

```bash
# 查看配置
roy config list                    # 列出所有配置
roy config get <key>               # 获取配置值
roy config set <key> <value>      # 设置配置
roy config delete <key>           # 删除配置

# Component 配置
roy config get agent               # 获取 agent 配置
roy config set agent temperature 0.9

# 导出/导入
roy config export > backup.json   # 导出配置
roy config import backup.json     # 导入配置
```

### 10.2 交互式配置

```bash
# 启动交互式配置向导
roy config wizard

# 输出示例:
# ? 选择要配置的 Component:
#   ❯ agent
#     session
#     llm
#     memory
```

---

## 11. 最佳实践

### 11.1 Component 配置设计

```typescript
class MyComponent implements Component {
  // 1. 定义静态 Schema
  static configSchema = z.object({
    // 必需配置
    apiKey: z.string(),
    
    // 带默认值的配置
    timeout: z.number().default(30000),
    
    // 可选配置
    debug: z.boolean().optional(),
    
    // 枚举配置
    logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  });
  
  // 2. 定义元信息
  readonly name = "my-component";
  readonly version = "1.0.0";
  
  // 3. 在 init 中注册
  async init(config?: ComponentConfig): Promise<void> {
    ConfigComponent.registerComponent({
      name: this.name,
      sources: [
        { type: "file", relativePath: "my-config.jsonc" },
        { type: "env", envPrefix: "MY" }
      ],
      keys: [
        { key: "my.apiKey", sources: ["env", "file", "memory"], required: true },
        { key: "my.timeout", sources: ["file", "memory"], default: 30000 },
        { key: "my.debug", sources: ["file", "env", "memory"] },
        { key: "my.logLevel", sources: ["file", "memory"], default: "info" },
      ],
      schema: MyComponent.configSchema,
    });
    
    // 4. 获取并验证配置
    const rawConfig = await ConfigComponent.getComponentConfig(this.name);
    const result = MyComponent.configSchema.safeParse(rawConfig);
    
    if (!result.success) {
      throw new Error(`Invalid config: ${result.error.message}`);
    }
    
    this.config = result.data;
  }
}
```

### 11.2 配置分层

```
┌─────────────────────────────────────────────────────────────┐
│                    配置分层结构                               │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   Layer 1: 默认值 (代码中)                                   │
│   └── Component.configSchema.defaults                      │
│                                                             │
│   Layer 2: 文件配置 (~/.config/roy-bot/*.jsonc)           │
│   └── 用户自定义配置                                        │
│                                                             │
│   Layer 3: 环境变量 (export MY_DEBUG=true)                  │
│   └── 环境级别覆盖                                          │
│                                                             │
│   Layer 4: 运行时配置 (setComponent API)                    │
│   └── 最高优先级                                            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 12. 相关文档

- [去中心化配置设计](./component-decentralized-config-design.md) - 去中心化配置注册的详细设计
- [配置引用协议](./config-reference-protocol.md) - 文件引用和变量替换机制
- [Architecture 设计文档](./architecture-design.md) - 整体架构设计
- [Environment 设计文档](./environment-design.md) - Environment 设计
