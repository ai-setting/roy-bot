# Log & Trace Component 设计文档

> 基于 agent-core 源码调研，参考其日志、追踪、Span 持久化机制

---

## 1. 概述

Log & Trace Component 负责统一管理系统日志和应用追踪（Trace），参考 agent-core 的实现。

### 核心能力

| 能力 | 说明 |
|------|------|
| **日志记录** | 结构化日志输出到文件和控制台 |
| **追踪（Trace）** | 记录函数调用链和执行时间 |
| **Span 持久化** | SQLite 存储追踪数据，支持查询 |
| **请求上下文** | 通过 AsyncLocalStorage 管理 requestId/traceId |

---

## 2. agent-core 调研总结

### 2.1 核心组件

| 组件 | 文件 | 职责 |
|------|------|------|
| `Logger` | `utils/logger.ts` | 日志输出（文件+控制台） |
| `SpanCollector` | `utils/span-collector.ts` | Span 管理（start/end） |
| `TraceContext` | `utils/trace-context.ts` | 异步上下文管理 |
| `SpanStorage` | `utils/span-storage.ts` | SQLite 持久化 |
| `@Traced` 装饰器 | `utils/wrap-function.ts` | 函数追踪封装 |

### 2.2 日志格式

```
{Timestamp} [{Level}][requestId={id}] [{Source}][{Category}] {Message} {Data}
```

**示例：**
```
2026-03-26T12:00:00.123 [INFO][requestId=req_123] [src/llm/invoke.ts:50][llm:invoke] Starting LLM call {"model":"gpt-4"}
```

### 2.3 追踪格式

```
[TRACE] >>> {method} enter: {args}
[TRACE] <<< {method} quit: {result}
[TRACE] !!! {method} error: {error}
```

### 2.4 traceId 与 requestId 复用

agent-core 中 **traceId = requestId**，统一使用：

```typescript
// TraceContext 生成
generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

// SpanCollector 使用
startSpan(name: string, attributes?: SpanAttributes): SpanContext {
  const traceCtx = getTraceContext();
  const traceId = traceCtx?.getRequestId() || this.generateTraceId();
  // ...
}
```

**流程：**
1. 请求入口调用 `initContext(requestId, sessionId)`
2. `AsyncLocalStorage` 存储当前上下文
3. 所有 Span 自动继承 `traceId = requestId`
4. 子 Span 通过 `parentSpanId` 构建调用链

### 2.5 Span 数据结构

```typescript
interface Span {
  traceId: string;          // = requestId
  spanId: string;           // 唯一 ID
  parentSpanId?: string;    // 父 Span ID
  
  name: string;             // "llm.invoke"
  kind: SpanKind;           // CLIENT/SERVER/INTERNAL
  status: SpanStatus;       // OK/ERROR
  
  startTime: number;        // 毫秒时间戳
  endTime?: number;
  
  attributes: SpanAttributes; // 参数
  result?: unknown;          // 返回值
  error?: string;            // 错误信息
  
  children?: Span[];         // 子 Span
}
```

### 2.6 SQLite 持久化

```sql
CREATE TABLE span (
  span_id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  parent_span_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  start_time INTEGER NOT NULL,
  end_time INTEGER,
  attributes TEXT,
  result TEXT,
  error TEXT,
  time_created INTEGER NOT NULL
)

CREATE INDEX idx_span_trace ON span(trace_id);
CREATE INDEX idx_span_parent ON span(parent_span_id);
CREATE INDEX idx_span_start_time ON span(start_time DESC);
```

### 2.7 存储路径

```typescript
// 日志路径 (XDG 标准)
XDG_DATA_HOME/roy-bot/logs/  // 默认 ~/.local/share/roy-bot/logs/

// Span 存储路径（可选配置）
// - 内存模式（默认）: :memory:（重启后数据丢失）
// - SQLite 模式: 通过 dbPath 配置指定路径
```

### 2.8 @Traced 装饰器

```typescript
@Traced({ name: "llm.invoke", recordParams: true, recordResult: false })
async invokeLLM(...) { }
```

**选项：**
- `recordParams`: 记录参数（默认 true）
- `recordResult`: 记录结果（默认 false）
- `recordError`: 记录错误（默认 true）
- `log`: 输出到日志（默认 false）
- `maxLogSize`: 最大日志大小（默认 500）
- `paramFilter`: 参数过滤器

---

## 3. 配置项设计

### 3.1 配置结构

```typescript
interface LogTraceConfig {
  // === 日志配置 ===
  log: {
    // 日志目录
    dir: string;
    
    // 日志级别
    level: "debug" | "info" | "warn" | "error";
    
    // 日志文件
    files: {
      app: { enabled: boolean; filename: string; maxSize: string };
      server: { enabled: boolean; filename: string; maxSize: string };
    };
    
    // 控制台输出
    console: {
      enabled: boolean;
      colorize: boolean;
      minLevel: "debug" | "info" | "warn" | "error";
    };
  };
  
  // === 追踪配置 ===
  trace: {
    // 是否启用追踪
    enabled: boolean;
    
    // 追踪输出
    output: {
      toFile: boolean;
      toConsole: boolean;
    };
    
    // 追踪级别
    level: "none" | "minimal" | "full";
    
    // 包含/排除模式
    include?: string[];
    exclude?: string[];
  };
  
  // === Span 持久化配置 ===
  span: {
    // 是否启用持久化
    enabled: boolean;
    
    // 存储类型
    storage: "sqlite" | "memory";
    
    // 存储目录（相对于 xdgDataHome，绝对路径直接使用）
    dir: string;
    
    // 文件名
    filename: string;  // "spans.db"
    
    // 保留天数（0 = 不清理）
    retainDays: number;
  };
  
  // === 请求上下文 ===
  context: {
    enableRequestId: boolean;
    requestIdHeader: string;
  };
}
```

### 3.2 默认配置

```typescript
const DEFAULT_CONFIG: LogTraceConfig = {
  log: {
    // 日志目录：优先级 LOG_DIR 环境变量 > setLogDirOverride > XDG 默认
    // XDG 标准路径: XDG_DATA_HOME/roy-bot/logs/ (默认 ~/.local/share/roy-bot/logs/)
    dir: "logs",
    level: "info",
    files: {
      app: { enabled: true, filename: "app.log", maxSize: "10MB" },
      server: { enabled: true, filename: "server.log", maxSize: "50MB" },
    },
    console: {
      enabled: true,
      colorize: true,
      minLevel: "debug",
    },
  },
  
  trace: {
    enabled: true,
    output: {
      toFile: true,
      toConsole: false,
    },
    level: "minimal",
    exclude: [
      "traced:heartbeat",
      "traced:poll",
    ],
  },
  
  span: {
    enabled: true,
    // 存储类型: "sqlite" 或 "memory"（默认内存模式）
    // SQLite 路径由 dbPath 配置指定，默认为 :memory:（内存模式）
    storage: "memory",
    dbPath: undefined,  // 未指定时使用内存模式
    
    // 保留天数（0 = 不清理）
    retainDays: 30,
  },
  
  context: {
    enableRequestId: true,
    requestIdHeader: "x-request-id",
  },
};
```

### 3.3 配置文件示例 (log_trace_config.jsonc)

```jsonc
{
  "$schema": "../packages/core/src/env/log-trace/config-schema.json",
  
  "log": {
    // 日志目录：支持绝对路径或相对于 XDG_DATA_HOME/roy-bot
    // 默认使用 XDG 标准路径: ~/.local/share/roy-bot/logs/
    "dir": "logs",
    "level": "debug",
    "files": {
      "app": { "enabled": true, "filename": "app.log", "maxSize": "10MB" },
      "server": { "enabled": true, "filename": "server.log", "maxSize": "50MB" }
    },
    "console": {
      "enabled": true,
      "colorize": true,
      "minLevel": "info"
    }
  },
  
  "trace": {
    "enabled": true,
    "output": {
      "toFile": true,
      "toConsole": false
    },
    "level": "minimal",
    "exclude": ["traced:heartbeat", "traced:poll"]
  },
  
  "span": {
    "enabled": true,
    // 存储类型: "memory" | "sqlite"
    // - memory: 内存模式，重启后数据丢失
    // - sqlite: 持久化模式，需要指定 dbPath
    "storage": "sqlite",
    
    // SQLite 数据库路径（绝对路径或相对于 XDG_DATA_HOME/roy-bot）
    // 留空或不指定则使用内存模式
    "dbPath": "storage/spans.db",
    
    "retainDays": 30
  },
  
  "context": {
    "enableRequestId": true,
    "requestIdHeader": "x-request-id"
  }
}
```

### 3.4 日志输出长度配置 (max_output)

`max_output` 配置项用于控制单条日志输出的最大长度，用于防止过长的日志输出被截断。

```jsonc
{
  "log_trace": {
    "logging": {
      // max_output: 控制日志输出的最大长度（字符数）
      // - 默认值: 0 (不限制)
      // - 用途: 当需要查看完整的长日志输出时，可以将此值设置为一个较大的数字
      // - 注意: TracedAs 装饰器的 maxLogSize 参数会优先使用此配置的值，如果配置未设置则使用默认值 500
      "max_output": 2000
    }
  }
}
```

**配置优先级**:
1. 装饰器 `maxLogSize` 参数（最高优先级）
2. `log_trace.logging.max_output` 配置
3. 默认值 500

### 3.5 路径解析规则

| 来源 | 处理方式 |
|------|----------|
| 绝对路径 | 直接使用 |
| 相对路径 | 相对于 `{xdgDataHome}/roy-bot` |
| LOG_DIR 环境变量 | 优先于配置，用于日志目录 |
| 未配置 | 使用 XDG 默认路径 `{xdgDataHome}/roy-bot/logs/` |

**日志目录优先级**：LOG_DIR 环境变量 > setLogDirOverride > XDG 默认

---

## 4. 接口设计

### 4.1 LogTraceComponent 接口

```typescript
export interface LogTraceComponent {
  // === 组件标识 ===
  readonly name: string;        // "log-trace"
  readonly version: string;     // "1.0.0"
  
  // === 日志 API ===
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, error?: Error, data?: Record<string, unknown>): void;
  log(entry: LogEntry): void;
  
  // === 追踪 API ===
  traceEnter(method: string, args?: unknown[]): string;  // 返回 spanId
  traceExit(spanId: string, result?: unknown, error?: Error): void;
  
  // 追踪作用域（自动 start/end）
  trace<T>(
    method: string,
    fn: () => T | Promise<T>,
    options?: TraceOptions
  ): Promise<T>;
  
  // === Span API ===
  recordSpan(span: Omit<Span, "spanId" | "startTime">): string;
  getSpanById(spanId: string): Span | undefined;
  getTrace(traceId: string): Span[];
  listTraces(limit?: number): TraceInfo[];
  
  // === 上下文 API ===
  getRequestId(): string | undefined;
  setRequestId(requestId: string): void;
  initContext(requestId: string, sessionId?: string): void;
  createContext<T>(requestId: string, sessionId: string | undefined, fn: () => T): T;
  
  // === 配置 API ===
  setLogLevel(level: LogLevel): void;
  setTraceEnabled(enabled: boolean): void;
  getSpanDir(): string;
  flush(): Promise<void>;
}
```

### 4.2 类型定义

```typescript
// 日志条目
interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  requestId?: string;
  source?: { file: string; line: number };
  category?: string;
  data?: Record<string, unknown>;
  error?: { message: string; stack?: string };
}

// 追踪选项
interface TraceOptions {
  category?: string;
  recordParams?: boolean;
  recordResult?: boolean;
  recordError?: boolean;
  log?: boolean;
  maxLogSize?: number;
}

// Span
interface Span {
  spanId: string;
  parentSpanId?: string;
  traceId: string;           // = requestId
  
  name: string;
  kind: "client" | "server" | "internal";
  status: "ok" | "error";
  
  startTime: number;
  endTime?: number;
  duration?: number;
  
  attributes: Record<string, unknown>;
  result?: unknown;
  error?: string;
  
  children?: Span[];
}

// 追踪信息
interface TraceInfo {
  traceId: string;
  rootSpanName: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  spanCount: number;
  status: "ok" | "error" | "mixed";
}
```

---

## 5. 与现有组件的集成

### 5.1 LLMComponent

```typescript
const result = await logTrace.trace("llm.invoke", async () => {
  logTrace.info("[invoke] Starting LLM call", { model, messageCount: messages.length });
  
  const result = await invoke(...);
  
  logTrace.info("[invoke] LLM call completed", { 
    hasUsage: !!result.usage,
    usage: result.usage 
  });
  
  return result;
}, { 
  recordParams: true,
  recordResult: false,
});
```

### 5.2 请求入口

```typescript
// 请求入口初始化上下文
logTrace.initContext(requestId, sessionId);

// 在上下文中执行
logTrace.createContext(requestId, sessionId, async () => {
  await agent.run();
});
```

---

## 6. 文件结构

```
src/env/log-trace/
├── index.ts                    # 导出
├── log-trace-component.ts      # 主组件
├── logger.ts                   # Logger 实现
├── tracer.ts                  # SpanCollector 实现
├── trace-context.ts            # AsyncLocalStorage 上下文
├── span-storage.ts            # SQLite 存储
├── formatter.ts               # 日志格式化
├── types.ts                   # 类型定义
├── config.ts                  # 配置 Schema
└── paths.ts                  # 路径解析
```

---

## 7. 参考实现

| 模块 | agent-core 源码 |
|------|----------------|
| Logger | `packages/core/src/utils/logger.ts` |
| SpanCollector | `packages/core/src/utils/span-collector.ts` |
| TraceContext | `packages/core/src/utils/trace-context.ts` |
| SpanStorage | `packages/core/src/utils/span-storage.ts` |
| @Traced | `packages/core/src/utils/wrap-function.ts` |
| Paths | `packages/core/src/config/paths.ts` |

---

## 8. 关键设计决策

### 8.1 traceId = requestId

统一使用 requestId 作为 traceId，简化追踪关联。

### 8.2 AsyncLocalStorage 管理上下文

使用 `async_hooks` 的 `AsyncLocalStorage` 实现：
- 请求入口调用 `initContext()`
- 所有异步操作自动继承上下文
- 无需手动传递 context 参数

### 8.3 SQLite 持久化

使用 SQLite 而非 JSONL：
- 支持复杂查询（按时间、状态等过滤）
- 支持索引加速查询
- 已有工具可直接使用（get_trace, get_span_detail）

### 8.4 追踪与日志分离

| 功能 | 存储 | 用途 |
|------|------|------|
| 日志 | 文件 (app.log, server.log) | 人工排查 |
| 追踪 | SQLite (spans.db) | 程序化分析 |

### 8.5 路径解析优先级

1. 配置文件中指定（绝对路径直接用，相对路径基于 xdgDataHome）
2. 环境变量 `LOG_TRACE_DIR`
3. 默认 `{xdgDataHome}/roy-bot/spans`
