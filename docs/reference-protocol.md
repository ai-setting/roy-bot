# 配置引用协议（Config Reference Protocol）

## 概述

配置引用协议是一种配置语法，允许在配置文件中：
1. 支持 JSONC（JSON with Comments）格式
2. 引用环境变量的值
3. 引用其他文件的配置值

## 功能模块

| 模块 | 说明 | 状态 |
|------|------|------|
| JSONC 解析 | 支持 `//` 和 `/* */` 注释（使用 jsonc-parser） | ✅ 已实现 |
| 环境变量替换 | `${VAR}` 和 `${VAR:-default}` 语法 | ✅ 已实现 |
| 协议引用 | `file://`, `env://` 协议 | ✅ 已实现 |

---

## Part 1: JSONC 解析

### 支持的注释格式

```jsonc
{
  // 单行注释
  "name": "test",
  
  /* 
   * 多行注释
   */
  "value": 123,
  
  "trailing": "test"  // 尾部注释
}
```

### 实现

```typescript
// packages/core/src/config/config-parser.ts

/**
 * Parse JSONC (JSON with Comments) content
 * Supports // and /* */ style comments
 */
export function parseJSONC(content: string): Record<string, unknown> {
  // Remove single-line comments
  let processed = content.replace(/\/\/.*$/gm, "");
  // Remove multi-line comments
  processed = processed.replace(
    /\/\*[\s\S]*?\*\//g,
    ""
  );
  
  return JSON.parse(processed);
}
```

---

## Part 2: 环境变量替换

### 语法

```typescript
// 简单变量
${VAR_NAME}

// 带默认值
${VAR_NAME:-default_value}

// 在对象中使用
{
  "apiKey": "${API_KEY:-EMPTY}",
  "timeout": "${TIMEOUT:-30000}"
}
```

### 实现

```typescript
export function substituteEnvVars(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([^}]+)\}/g, (match, varExpr) => {
      const [varName, defaultValue] = varExpr.split(":-");
      const envValue = process.env[varName.trim()];
      if (envValue !== undefined) {
        return envValue;
      }
      if (defaultValue !== undefined) {
        return defaultValue;
      }
      return "";
    });
  }
  
  if (Array.isArray(value)) {
    return value.map(item => substituteEnvVars(item));
  }
  
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = substituteEnvVars(val);
    }
    return result;
  }
  
  return value;
}
```

---

## Part 3: 协议引用

### 协议语法

| 协议 | 语法示例 | 说明 |
|------|----------|------|
| `file://` | `${file://path#key.subkey}` | 读取本地文件，取指定路径的值 |
| `env://` | `${env://VAR_NAME}` | 显式读取环境变量 |
| 默认 | `${VAR_NAME}` | 读取环境变量（简写，与当前行为一致） |

### 默认值语法

所有协议都支持默认值语法：

```
${protocol://path#key:-default_value}
```

### 路径解析规则

```
file://auth.json                          → ~/.local/share/auth.json
file://tong_work/agent-core/config.json  → ~/.local/share/tong_work/agent-core/config.json
file:///home/xxx/config.json             → /home/xxx/config.json (绝对路径保持原样)
file://~/config.json                     → /home/user/config.json (~ 替换为 HOME)
```

**解析逻辑：**
- 以 `/` 开头：绝对路径，直接使用
- 以 `~` 开头：`~` 替换为 HOME 目录
- 其他情况：相对路径，基于 `XDG_DATA_HOME`（默认 `~/.local/share`）解析

---

## ProtocolResolver 类

### API

```typescript
export type ProtocolType = "file" | "env";

export interface ProtocolRef {
  protocol: ProtocolType;
  path: string;
  key: string;
  raw: string;
}

export interface ResolveResult {
  value: unknown;
  source: ProtocolType;
}

export interface ProtocolResolverOptions {
  /** XDG 数据目录，默认 ~/.local/share */
  xdgDataHome?: string;
  /** 文件读取函数（用于测试注入） */
  readFileFn?: (path: string) => string;
}

export class ProtocolResolver {
  constructor(options?: ProtocolResolverOptions);
  
  /** 获取默认 XDG_DATA_HOME */
  static getDefaultXDGDataHome(): string;
  
  /** 解析协议引用 */
  parse(ref: string): ProtocolRef | null;
  
  /** 检查是否是协议引用 */
  isProtocolRef(value: string): boolean;
  
  /** 解析并获取协议引用的值 */
  resolve(ref: string): ResolveResult | null;
}
```

### 使用示例

```typescript
const resolver = new ProtocolResolver({
  xdgDataHome: "~/.local/share",
});

// 解析协议引用
const result = resolver.resolve("${file://config/auth.json#providers.deepseek.apiKey}");
console.log(result.value); // "sk-xxx..."
```

---

## 文件引用值提取

使用 `#` 分隔符指定嵌套路径：

```
${file://config.json#providers.minimax.apiKey}
  → 读取 config.json 的 providers.minimax.apiKey 字段
```

### 嵌套路径示例

```jsonc
// config.json
{
  "providers": {
    "minimax": {
      "apiKey": "sk-xxx...",
      "baseURL": "https://api.minimax.chat/v1"
    }
  }
}

// 使用
${file://config.json#providers.minimax.apiKey}  // → sk-xxx...
${file://config.json#providers.minimax.baseURL} // → https://api.minimax.chat/v1
```

---

## 错误处理

| 场景 | 行为 |
|------|------|
| 文件不存在 | 返回 `undefined` |
| key 路径不存在 | 返回 `undefined` |
| JSON 格式错误 | 返回文件内容（作为纯文本） |
| 不存在的环境变量 | 返回空字符串 |

---

## 工作流程

```
1. 用户配置 JSONC 文件
   ↓
2. parseJSONC() 解析 JSONC（移除注释）
   ↓
3. substituteEnvVars() 替换环境变量
   ↓
4. 对每个字符串值检查是否包含 ${...}
   ↓
5. ProtocolResolver.resolve() 解析协议引用
      ├── file:// → 读取文件，提取 key 值
      ├── env://  → 读取环境变量
      └── 默认    → 读取环境变量
   ↓
6. 返回解析后的配置对象
```

---

## 使用示例

### 配置示例（config.jsonc）

```jsonc
{
  // 直接使用环境变量
  "logLevel": "${LOG_LEVEL:-info}",
  
  // 显式使用 env:// 协议
  "apiKey": "${env://OPENAI_API_KEY}",
  
  // 使用 file:// 协议读取其他配置文件
  "database": {
    "host": "${file://config/db.json#host}",
    "port": "${file://config/db.json#port}"
  },
  
  // 使用 file:// 协议读取认证文件
  "providers": {
    "minimax": {
      "provider": "openai-compatible",
      "apiKey": "${file://config/auth.json#providers.minimax.apiKey}",
      "baseURL": "${file://config/auth.json#providers.minimax.baseURL}"
    },
    "openai": {
      "provider": "openai",
      "apiKey": "${file://config/auth.json#providers.openai.apiKey}"
    }
  }
}
```

### 认证文件示例

`config/auth.json`

```json
{
  "providers": {
    "minimax": {
      "apiKey": "sk-xxx...",
      "baseURL": "https://api.minimax.chat/v1"
    },
    "openai": {
      "apiKey": "sk-proj-xxx..."
    }
  }
}
```

---

## 实现清单

- [x] ProtocolResolver 类 ✅ 已实现
- [x] ConfigParser 集成 ProtocolResolver ✅ 已实现
- [x] FileSource 集成 ProtocolResolver ✅ 已实现
- [x] 完整的单测覆盖 ✅ 已实现

---

## 相关文件

| 文件 | 说明 | 状态 |
|------|------|------|
| `packages/core/src/config/config-parser.ts` | JSONC 解析 + 环境变量替换 | ✅ |
| `packages/core/src/config/protocol-resolver.ts` | 协议解析器 | ✅ |
| `packages/core/src/config/protocol-resolver.test.ts` | 协议解析器单测 | ✅ |
| `packages/core/src/config/file-source.ts` | 文件配置源 | ✅ |
| `packages/core/src/config/config-component.ts` | 配置组件 | ✅ |

---

## 参考文档

- 实现计划：`docs/superpowers/plans/2026-03-26-file-source-jsonc-envref.md`
