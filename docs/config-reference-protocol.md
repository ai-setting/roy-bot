# 配置引用协议 (Config Reference Protocol)

## 概述

本文档描述配置系统中文件引用机制的原理和设计，支持去中心化配置注册架构。

**核心功能：**
- 引用其他配置文件中的值
- 环境变量替换
- 支持 JSONC 格式（带注释的 JSON）

---

## 1. 与去中心化配置的关系

```
┌─────────────────────────────────────────────────────────────┐
│              去中心化配置 + 引用协议                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   Component.init()                                          │
│       │                                                     │
│       ├── ConfigComponent.registerSource({                  │
│       │       type: "file",                               │
│       │       relativePath: "llm-config.jsonc"             │
│       │   })                                                │
│       │                                                     │
│       ├── ConfigComponent.registerKeys([                   │
│       │       { key: "llm.provider", sources: ["file", "env", "memory"] }
│       │   ])                                                │
│       │                                                     │
│       └── ConfigComponent.load()                            │
│                    │                                        │
│                    ├──→ FileSource 加载配置文件              │
│                    │       └──→ substituteEnvVars()         │
│                    │              └──→ 替换 ${file://...}   │
│                    │              └──→ 替换 ${env://...}    │
│                    │              └──→ 替换 ${VAR_NAME}     │
│                    │                                        │
│                    └──→ 返回最终配置对象                      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. XDG 路径管理

### 2.1 XDG_PATHS

`XDG_PATHS` 是全局的路径管理器，负责维护所有配置文件的路径映射。

```typescript
// paths.ts
export class XDGPathsCalculator {
  private _paths: XDGPaths;
  private _customPaths: Record<string, string> = {};

  // 注册路径别名
  register(alias: string, relativePath: string): void {
    this._customPaths[alias] = relativePath;
  }

  // 获取完整路径
  getPath(alias: string): string {
    // 优先查询自定义路径（基于 XDG_DATA_HOME）
    if (this._customPaths[alias]) {
      return path.join(this._paths.data, this._customPaths[alias]);
    }
    // 查询内置路径
    if (alias in this._paths) {
      return this._paths[alias as XDGDirType];
    }
    throw new Error(`Unknown path alias: ${alias}`);
  }
}
```

### 2.2 内置路径

| 别名 | 路径 | 说明 |
|------|------|------|
| `home` | `~/.local/share` | 用户数据目录 |
| `data` | `~/.local/share` | XDG 数据目录 |
| `config` | `~/.config` | XDG 配置目录 |
| `state` | `~/.local/state` | XDG 状态目录 |
| `cache` | `~/.cache` | 缓存目录 |

### 2.3 自定义路径注册

每个 Component 可以注册自己的路径别名：

```typescript
// LLMComponent.init()
XDG_PATHS.register("auth", "auth");  // 注册 auth 路径

// 注册后，XDG_PATHS.getPath("auth") 返回 ~/.local/share/auth
```

---

## 3. 引用协议语法

### 3.1 协议格式

```
${<protocol>://<resource>}<selector>
```

### 3.2 支持的协议

| 协议 | 语法 | 说明 |
|------|------|------|
| `file://` | `${file://<alias>#<key>}` | 读取注册路径对应的文件 |
| `env://` | `${env://<VAR_NAME>}` | 读取环境变量 |
| 默认 | `${<VAR_NAME>}` | 读取环境变量（简写） |

### 3.3 协议详解

#### 1. file:// 协议

用于引用注册路径中的文件内容。

**语法**:
```
${file://<alias>#<jsonpath>}
```

**参数**:
- `alias`: XDG_PATHS 中注册的路径别名
- `jsonpath`: JSON 文件中的点号路径

**示例**:

```jsonc
// config.jsonc
{
  "providers": {
    "minimax": {
      "provider": "openai-compatible",
      "apiKey": "${file://auth#minimax.key}",
      "baseURL": "${file://auth#minimax.baseURL}"
    }
  }
}
```

#### 2. env:// 协议

用于读取环境变量。

**语法**:
```
${env://<VAR_NAME>}
```

**示例**:

```jsonc
{
  "apiKey": "${env://OPENAI_API_KEY}"
}
```

#### 3. 默认协议

环境变量的简写语法。

**语法**:
```
${<VAR_NAME>}
```

**示例**:

```jsonc
{
  "apiKey": "${OPENAI_API_KEY}"
}
```

---

## 4. 工作流程

### 4.1 完整加载流程

```
LLMComponent.init()
    │
    ├─→ ConfigComponent.registerSource({
    │       type: "file",
    │       relativePath: "llm-config.jsonc"
    │   })
    │
    ├─→ XDG_PATHS.register("auth", "auth")
    │
    └─→ ConfigComponent.load()
              │
              └─→ FileSource.load()
                        │
                        └─→ 1. 读取 config.jsonc 文件
                             2. parseJSONC() 解析 JSONC
                             3. substituteEnvVars() 替换引用
                             4. 返回最终配置对象
```

### 4.2 引用替换流程

当 `substituteEnvVars()` 遇到 `${file://auth#minimax.key}` 时：

```
1. 解析协议
   "file://auth#minimax.key"
         ↓
   protocol: "file"
   resource: "auth"
   key: "minimax.key"

2. 获取文件路径
   XDG_PATHS.getPath("auth")
         ↓
   path.join(XDG_DATA_HOME, "auth")
         ↓
   "~/.local/share/auth"

3. 读取并解析文件
   JSON.parse(fs.readFileSync("~/.local/share/auth"))
         ↓
   { "minimax": { "key": "sk-xxx", "baseURL": "..." } }

4. 提取目标值
   getNestedValue(data, "minimax.key")
         ↓
   "sk-xxx"
```

---

## 5. 实现详解

### 5.1 ConfigParser

`config-parser.ts` 提供配置解析和引用替换功能。

```typescript
// substituteEnvVars 函数核心逻辑
export function substituteEnvVars(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\${([^}]+)}/g, (match, expr) => {
      // file:// 协议
      const fileMatch = expr.match(/^file:\/\/([^#]+)#(.+)$/);
      if (fileMatch) {
        const alias = fileMatch[1];
        const key = fileMatch[2];
        const filePath = XDG_PATHS.getPath(alias);
        const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        return getNestedValue(data, key);
      }

      // env:// 协议或默认协议
      const varName = expr.replace(/^env:\/\//, "");
      return process.env[varName] ?? "";
    });
  }

  // 递归处理数组
  if (Array.isArray(value)) {
    return value.map(item => substituteEnvVars(item));
  }

  // 递归处理对象
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = substituteEnvVars(v);
    }
    return result;
  }

  return value;
}
```

### 5.2 FileSource

`file-source.ts` 使用 ConfigParser 加载配置文件。

```typescript
export class FileSource implements ConfigSource {
  constructor(options: FileSourceOptions) {
    this.filePath = options.filePath;
    this.initSync(); // 同步初始化
  }

  private initSync(): void {
    const content = fs.readFileSync(this.filePath, "utf-8");
    const parsed = parseJSONC(content);           // 解析 JSONC
    this.data = substituteEnvVars(parsed);        // 替换引用
  }
}
```

### 5.3 Component 中的使用

```typescript
export class LLMComponent extends BaseComponent {
  async init(config?: ComponentConfig): Promise<void> {
    // 1. 注册 auth 路径 (用于存放敏感信息)
    XDG_PATHS.register("auth", "auth");

    // 2. 注册配置源和键 (去中心化方式)
    ConfigComponent.registerComponent({
      name: "llm",
      sources: [
        {
          type: "file",
          relativePath: "llm-config.jsonc"
        },
        {
          type: "env",
          envPrefix: "LLM"
        }
      ],
      keys: [
        { key: "llm.provider", sources: ["file", "env", "memory"] },
        { key: "llm.apiKey", sources: ["env", "file", "memory"] },
      ]
    });

    // 3. 加载配置 (自动处理引用替换)
    const parsed = LLMConfigSchema.safeParse(config.options.config);
    if (!parsed.success) {
      throw new Error(`Invalid LLM config: ${parsed.error.message}`);
    }
    this.config = parsed.data;
  }
}
```

---

## 6. 使用示例

### 6.1 基础配置

```jsonc
// ~/.local/share/llm-config.jsonc
{
  // 引用环境变量 (简写形式)
  "provider": "openai",
  "model": "gpt-4",
  
  // 引用环境变量 (完整形式)
  "apiKey": "${env://OPENAI_API_KEY}",
  
  // 带默认值的环境变量
  "temperature": "${LLM_TEMPERATURE:0.7}",
  
  // 嵌套配置
  "retry": {
    "maxAttempts": 3,
    "backoff": "exponential"
  }
}
```

### 6.2 敏感信息分离

```jsonc
// ~/.local/share/llm-config.jsonc
{
  "providers": {
    "openai": {
      "provider": "openai",
      "apiKey": "${file://auth#openai.key}",      // 从 auth 文件读取
      "baseURL": "${file://auth#openai.baseURL}"  // 从 auth 文件读取
    },
    "minimax": {
      "provider": "openai-compatible",
      "apiKey": "${MINIMAX_API_KEY}",             // 从环境变量读取
      "baseURL": "https://api.minimax.chat/v1"
    }
  }
}
```

```jsonc
// ~/.local/share/auth.jsonc (敏感信息，与源码分离)
{
  "openai": {
    "key": "sk-xxxxx",
    "baseURL": "https://api.openai.com/v1"
  },
  "anthropic": {
    "key": "sk-ant-xxxxx"
  }
}
```

### 6.3 环境特定配置

```jsonc
// ~/.local/share/llm-config.jsonc
{
  // 根据环境变量选择配置
  "model": "${ENV:development#gpt-3.5-turbo:gpt-4}",
  
  // 条件配置
  "debug": "${DEBUG:false}",
  "logLevel": "${LOG_LEVEL:info}"
}
```

### 6.4 多环境配置

```jsonc
// development.jsonc
{
  "env": "development",
  "debug": true,
  "logLevel": "debug"
}

// production.jsonc
{
  "env": "production",
  "debug": false,
  "logLevel": "error"
}
```

---

## 7. Source 优先级与引用

参见 [component-decentralized-config-design.md](./component-decentralized-config-design.md#33-source-优先级)

```
┌─────────────────────────────────────────────────────────────┐
│              配置源优先级 (低 → 高)                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   MemorySource (0)  ← 最低优先级                             │
│   ├── 运行时设置的配置                                        │
│   └── Component.set()                                       │
│                                                             │
│   FileSource (10)                                          │
│   ├── ~/.local/share/llm-config.jsonc                      │
│   ├── 包含 ${file://} 和 ${env://} 引用                     │
│   └── 引用替换在加载时完成                                    │
│                                                             │
│   EnvSource (20)   ← 最高优先级                             │
│   ├── LLM_PROVIDER=gpt-4                                   │
│   ├── LLM_API_KEY=sk-xxx                                   │
│   └── 直接覆盖文件配置                                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 8. 最佳实践

### 8.1 安全建议

1. **敏感信息分离**：API Key 等敏感信息存储在单独的 `auth.jsonc` 文件中
2. **不提交到 Git**：将 `auth.jsonc` 加入 `.gitignore`
3. **环境变量优先**：生产环境使用环境变量而非配置文件

```bash
# .gitignore
auth.jsonc
*.local.jsonc
```

### 8.2 配置组织

```
~/.local/share/
├── llm-config.jsonc         # LLM 配置 (可提交)
├── auth.jsonc                # 敏感信息 (不提交)
├── session-config.jsonc     # 会话配置
└── memory-config.jsonc      # 记忆配置
```

### 8.3 调试引用

```typescript
// 调试模式下打印引用替换结果
if (process.env.DEBUG_CONFIG) {
  console.log("原始配置:", rawConfig);
  console.log("替换后:", substitutedConfig);
}
```

---

## 9. 相关文档

- [去中心化配置设计](./component-decentralized-config-design.md) - 去中心化配置注册的详细设计
- [ConfigComponent 设计](./config-component-design.md) - ConfigComponent 详细设计
- [Architecture 设计文档](./architecture-design.md) - 整体架构设计
