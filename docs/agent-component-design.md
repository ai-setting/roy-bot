# Agent Component 设计文档

> 版本: 0.3.0 | 日期: 2026-03-27 | 状态: 🚧 进行中
>
> 参考 agent-core 源码设计，继承 roy-bot Component 架构
>
> **核心理念**: Environment 是 Agent 的运行时上下文，Agent 负责"想清楚做什么"，Environment 负责"在什么世界里、用什么能力、以什么约束去做"

---

## 1. 设计理念

### 1.1 核心主张

**Environment 是 Agent 的运行时上下文（且可交互）**

在 roy-bot / agent-core 中，**Environment 是 Agent 运行时的唯一上下文抽象**。它不仅是"配置容器"，更是一个可交互的环境实体：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Environment 核心职责                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   Agent 负责 "想清楚做什么"                                                   │
│   ├── 任务理解、计划、推理与决策                                              │
│   ├── 是否调用工具、调用哪个工具                                              │
│   ├── 如何组织消息、结构化输出                                               │
│   └── 错误恢复与计划调整                                                     │
│                                                                             │
│   Environment 负责 "在什么世界里、用什么能力、以什么约束去做"                  │
│   ├── 一切 I/O 与外部交互的落地                                              │
│   ├── 工具注册、执行入口与生命周期管理                                        │
│   ├── 安全策略与执行治理                                                     │
│   ├── 运行时可观测性                                                         │
│   └── 不同运行形态的差异屏蔽                                                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Environment 设计原则

**Environment 只做两件事，其他能力归属到对应 Component：**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Environment 核心职责边界                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌───────────────────────────────────────────────────────────────────┐    │
│   │  1. 组件管理：持有、注册、获取组件                                    │    │
│   │     - components: Map<string, Component>                            │    │
│   │     - registerComponent() / getComponent() / listComponents()       │    │
│   └───────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│   ┌───────────────────────────────────────────────────────────────────┐    │
│   │  2. 核心调度：handle_query / handle_action / EnvEvent              │    │
│   │     - handle_query(): 处理自然语言查询                              │    │
│   │     - handle_action(): 处理动作执行                                 │    │
│   │     - pushEnvEvent(): 事件发布                                     │    │
│   │     - subscribe(): 事件订阅                                        │    │
│   └───────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│   其他能力归属到对应 Component：                                              │
│   ├── LLMComponent: LLM 调用                                                │
│   ├── ToolComponent: 工具管理                                               │
│   ├── SessionComponent: 会话管理                                            │
│   ├── PromptComponent: 提示词管理                                           │
│   ├── LogTraceComponent: 日志与追踪                                         │
│   └── ConfigComponent: 配置中心                                             │
│                                                                             │
│   经验法则：当你在做"接入一种新能力/新边界约束/新运行形态"时，优先落在         │
│   Environment 或新建 Component，而不是修改已有 Component。                     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.3 与常见 Agent 框架的关键不同

| 维度 | 常见框架 | roy-bot / agent-core |
|------|----------|------------------------|
| **运行时抽象** | 工具集合 | **Environment** (一等实体) |
| **可观测性** | 调试附属 | **产品能力** (EnvEvent + 日志) |
| **可复用性** | Agent 与环境耦合 | **同一 Agent 在不同 Environment** |
| **工具治理** | 分散各处 | **统一执行入口** |

---

## 2. 架构总览

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Client (TUI / API)                                │
└─────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           ServerEnvironment                                   │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐   │
│  │                       Environment                                       │   │
│  │                                                                       │   │
│  │  ┌─────────────────────────────────────────────────────────────────┐ │   │
│  │  │  1. 组件管理 (Component Management)                              │ │   │
│  │  │                                                               │ │   │
│  │  │     components: Map<string, Component>                          │ │   │
│  │  │     ├── "llm"        → LLMComponent                           │ │   │
│  │  │     ├── "tool"       → ToolComponent                          │ │   │
│  │  │     ├── "session"    → SessionComponent                        │ │   │
│  │  │     ├── "prompt"     → PromptComponent                         │ │   │
│  │  │     ├── "log-trace"  → LogTraceComponent                       │ │   │
│  │  │     └── "config"     → ConfigComponent                         │ │   │
│  │  └─────────────────────────────────────────────────────────────────┘ │   │
│  │                                                                       │   │
│  │  ┌─────────────────────────────────────────────────────────────────┐ │   │
│  │  │  2. 核心调度 (Core Scheduling)                                  │ │   │
│  │  │                                                               │ │   │
│  │  │     handle_query(query, context)                                │ │   │
│  │  │          │                                                     │ │   │
│  │  │          ▼                                                     │ │   │
│  │  │     ┌─────────────────────────────────────────────┐           │ │   │
│  │  │     │           Agent Logic (ReAct Loop)          │           │ │   │
│  │  │     │                                             │           │ │   │
│  │  │     │   ┌─────────┐    ┌─────────┐    ┌─────────┐│           │ │   │
│  │  │     │   │  Think  │───▶│  Act    │───▶│ Observe ││           │ │   │
│  │  │     │   └─────────┘    └────┬────┘    └─────────┘│           │ │   │
│  │  │     │                       │                      │           │ │   │
│  │  │     │                       ▼                      │           │ │   │
│  │  │     │              ┌─────────────┐                │           │ │   │
│  │  │     │              │ LLMComponent │               │           │ │   │
│  │  │     │              │  .invoke()   │                │           │ │   │
│  │  │     │              └─────────────┘                │           │ │   │
│  │  │     └─────────────────────────────────────────────┘           │ │   │
│  │  └─────────────────────────────────────────────────────────────────┘ │   │
│  │                                                                       │   │
│  │  ┌─────────────────────────────────────────────────────────────────┐ │   │
│  │  │  3. EnvEvent 机制 (Event Bus)                                   │ │   │
│  │  │                                                               │ │   │
│  │  │     pushEnvEvent(event) ──────▶ Event Handlers                 │ │   │
│  │  │          │                      ├── UI (SSE)                     │ │   │
│  │  │          │                      ├── Agent (继续执行)             │ │   │
│  │  │          │                      └── Log (持久化)                │ │   │
│  │  └─────────────────────────────────────────────────────────────────┘ │   │
│  │                                                                       │   │
│  └───────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 继承层次

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           继承层次结构                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   Environment (interface)                                                   │
│       │                                                                     │
│       ├── 定义核心接口：组件管理、核心调度、EnvEvent                          │
│       │                                                                     │
│       └── BaseEnvironment (concrete class)                                  │
│               │                                                             │
│               ├── 实现组件注册与管理                                          │
│               ├── 实现 EnvEvent 机制                                         │
│               ├── 定义 handle_query / handle_action 抽象方法                 │
│               │                                                             │
│               └── ServerEnvironment (concrete class)                         │
│                       │                                                     │
│                       ├── 实现 handle_query / handle_action                  │
│                       ├── 集成 MCP Server                                   │
│                       ├── 集成 EventSource                                  │
│                       └── 支持后台任务                                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Component 体系

### 3.1 Component 总览

| Component | 版本 | 状态 | 核心职责 |
|-----------|------|------|----------|
| **ConfigComponent** | 1.0.0 | ✅ | 配置中心，去中心化配置注册 |
| **LLMComponent** | 2.0.0 | ✅ | LLM 调用，集成 AI SDK |
| **ToolComponent** | 1.0.0 | ✅ | 工具注册、验证、执行 |
| **SessionComponent** | 1.0.0 | ✅ | 会话 CRUD、消息管理 |
| **PromptComponent** | 1.0.0 | ✅ | 提示词加载、变量替换 |
| **LogTraceComponent** | 1.0.0 | ✅ | 日志、追踪、Span 持久化 |
| **AgentComponent** | 0.1.0 | 🚧 | ReAct 循环编排 |

### 3.2 Component 目录结构

```
packages/core/src/
├── index.ts                              # 统一导出入口
│
├── config/                              # ConfigComponent
│   ├── config-component.ts              # 配置中心实现
│   ├── config-parser.ts                 # 配置文件解析器
│   ├── env-source.ts                   # 环境变量配置源
│   ├── file-source.ts                  # 文件配置源
│   └── protocol-resolver.ts             # 协议解析器
│
└── env/                               # Environment & Components
    ├── component.ts                    # BaseComponent 基类
    ├── interface.ts                    # Environment 接口定义
    ├── types.ts                        # 核心类型定义
    ├── environment.ts                  # BaseEnvironment 实现
    └── paths.ts                        # XDG 路径管理
    │
    ├── llm/                           # LLMComponent
    │   ├── llm.ts                     # LLMComponent 主类
    │   ├── invoke.ts                  # AI SDK 调用封装
    │   ├── provider.ts               # Provider 管理
    │   ├── types.ts                   # 类型定义
    │   └── hooks.ts                  # Hook 类型
    │
    ├── tool/                          # ToolComponent
    │   ├── tool-component.ts         # ToolComponent 主类
    │   ├── registry.ts               # 工具注册中心
    │   ├── validator.ts               # 参数验证器
    │   ├── types.ts                  # 类型定义
    │   └── built-in/                 # 内置工具
    │       ├── bash.ts
    │       ├── glob.ts
    │       ├── read-file.ts
    │       ├── write-file.ts
    │       ├── edit-file.ts
    │       └── grep.ts
    │
    ├── session/                       # SessionComponent
    │   ├── session-component.ts     # SessionComponent 主类
    │   ├── session-store.ts         # 会话仓储接口
    │   ├── types.ts                 # 类型定义
    │   └── storage/
    │       └── memory.ts            # 内存存储实现
    │
    ├── prompt/                        # PromptComponent
    │   ├── prompt-component.ts     # PromptComponent 主类
    │   ├── renderer.ts              # 模板渲染器
    │   ├── types.ts                # 类型定义
    │   └── prompts/
    │       ├── default.md
    │       ├── coding.md
    │       └── review.md
    │
    └── log-trace/                    # LogTraceComponent
        ├── log-trace-component.ts  # LogTraceComponent 主类
        ├── logger.ts              # 日志输出器
        ├── tracer.ts              # 追踪器
        ├── trace-context.ts       # 异步上下文
        ├── span-storage.ts       # SQLite 持久化
        ├── decorator.ts          # @Traced 装饰器
        └── types.ts              # 类型定义
```

### 3.3 Component 间依赖关系

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Component 依赖关系图                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌───────────────────────────────────────────────────────────────────┐     │
│   │                    ConfigComponent (配置中心)                       │     │
│   │   └── 所有 Component 通过此注册配置 Schema                          │     │
│   └───────────────────────────────────────────────────────────────────┘     │
│                                    │                                        │
│           ┌────────────────────────┼────────────────────────┐              │
│           │                        │                        │              │
│           ▼                        ▼                        ▼              │
│   ┌─────────────┐         ┌─────────────┐         ┌─────────────┐       │
│   │LLMComponent │         │LogTrace     │         │ Prompt      │       │
│   │             │         │Component    │         │Component    │       │
│   └─────────────┘         └─────────────┘         └─────────────┘       │
│           │                        │                                     │
│           │                        │                                     │
│           ▼                        ▼                                     │
│   ┌─────────────────────────────────────────────────────────────────┐    │
│   │                    ToolComponent                                  │    │
│   │   ├── 内置工具: bash, glob, read-file, write-file, edit-file    │    │
│   │   ├── MCP 工具: 外部 MCP Server 集成                            │    │
│   │   └── Skill 工具: 领域特定能力封装                              │    │
│   └─────────────────────────────────────────────────────────────────┘    │
│                                    │                                        │
│                                    ▼                                        │
│   ┌─────────────────────────────────────────────────────────────────┐    │
│   │                    SessionComponent                               │    │
│   │   └── 管理会话消息、历史记录                                      │    │
│   └─────────────────────────────────────────────────────────────────┘    │
│                                    │                                        │
│                                    ▼                                        │
│   ┌─────────────────────────────────────────────────────────────────┐    │
│   │                    AgentComponent (设计中)                        │    │
│   │   └── 编排上述所有 Component，实现 ReAct 循环                     │    │
│   └─────────────────────────────────────────────────────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Environment 接口设计

### 4.1 Environment 接口定义

```typescript
// env/interface.ts

export interface Environment {
  // ============ 标识 ============
  readonly name: string;
  readonly version: string;
  getConfig(): EnvironmentConfig;
  
  // ============ 组件管理（核心职责 1） ============
  registerComponent(component: Component): void;
  unregisterComponent(name: string): void;
  getComponent<T extends Component>(name: string): T | undefined;
  listComponents(): Component[];
  
  // ============ 核心调度（核心职责 2） ============
  handle_query(query: string, context?: AgentContext): Promise<string>;
  handle_action(action: Action, context: Context): Promise<ToolResult>;
  
  // ============ EnvEvent 机制 ============
  subscribe(handler: EnvEventHandler): () => void;
  subscribeTo(eventType: string | string[], handler: EnvEventHandler): () => void;
  subscribeAll(handler: EnvEventHandler): () => void;
  pushEnvEvent(event: EnvEvent): void;
}
```

### 4.2 BaseComponent 接口

```typescript
// env/component.ts

export type ComponentStatus =
  | "created"
  | "initializing"
  | "running"
  | "stopping"
  | "stopped"
  | "error";

export interface Component {
  readonly name: string;
  readonly version: string;
  getStatus(): ComponentStatus;
  getConfig(): ComponentConfig;
  init(config?: ComponentConfig): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  // Hooks 通过 hookManager 管理
}

export abstract class BaseComponent implements Component {
  abstract readonly name: string;
  abstract readonly version: string;
  
  protected _status: ComponentStatus = "created";
  protected _enabled: boolean = true;
  
  // Hook 管理器 - 继承自 BaseComponent
  protected readonly hookManager: HookManager = new HookManager();
  
  // env 实例（通过 init 注入）
  protected env!: Environment;
  
  async init(config?: ComponentConfig): Promise<void>;
  async start(): Promise<void>;
  async stop(): Promise<void>;
  
  protected async onInit(): Promise<void> {}
  protected async onStart(): Promise<void> {}
  protected async onStop(): Promise<void> {}
  
  // Hook 便捷方法
  protected registerHook<T = unknown>(hookPoint: string, hook: Hook<T>): void;
  protected addHook(hookPoint: string, name: string, fn: HookFn, priority?: number): void;
  protected executeHooks(hookPoint: string, data: unknown, metadata?: Record<string, unknown>): Promise<void>;
}
```

---

## 5. EnvEvent 事件机制

### 5.1 事件类型

```typescript
// env/types.ts

export interface EnvEvent<T = unknown> {
  id: string;
  type: string;
  timestamp: number;
  metadata: EnvEventMetadata;
  payload: T;
}

export interface EnvEventMetadata {
  trigger_session_id?: string;
  trigger_agent_id?: string;
  trigger_agent_name?: string;
  env_name?: string;
  source?: string;
  [key: string]: unknown;
}
```

### 5.2 预定义事件类型

| 事件类型 | 说明 | payload |
|----------|------|----------|
| `stream.start` | LLM 流开始 | `{ sessionId }` |
| `stream.text` | 流式文本 | `{ content, delta }` |
| `stream.completed` | 流完成 | `{ usage }` |
| `tool.call` | 工具调用 | `{ toolName, params }` |
| `tool.result` | 工具结果 | `{ toolName, result }` |
| `session.created` | 会话创建 | `{ session }` |
| `session.message` | 新消息 | `{ sessionId, message }` |
| `agent.thinking` | Agent 思考 | `{ content }` |
| `background_task.completed` | 后台任务完成 | `{ subSessionId, result }` |

### 5.3 事件流

```
Event Sources (Tool / Env / LLM / User)
         │
         ▼
   EventBus.publish(event)
         │
         ▼
   幂等检查 (seen.has(event.id))
         │
         ▼
   队列处理 (processQueue)
         │
         ▼
   规则匹配 (findMatchedRule)
         │
         ├──▶ session.* ──────────▶ 日志记录
         │
         ├──▶ background_task.* ──▶ 触发 Agent 继续执行
         │
         └──▶ * ──────────────────▶ EventHandlerAgent (通用处理)
                   │
                   ├──▶ UI (SSE 推送)
                   ├──▶ Agent (插入事件消息)
                   └──▶ Log (持久化)
```

---

## 6. Component 详细设计

### 6.1 ConfigComponent

**文件**: `config/config-component.ts`

**核心职责**:
- Component 配置 Schema 注册
- 多配置源管理（file/env/memory）
- 配置变更监听
- 去中心化配置注册

**关键 API**:
```typescript
class ConfigComponentImpl {
  register(schema: ComponentSchema): void;
  registerSource(source: ConfigSource): void;
  registerKeys(keys: KeyRegistration[]): void;
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  watch(key: string, callback: ComponentWatchCallback): void;
  async load(): Promise<void>;
  async persist(): Promise<void>;
}
```

### 6.2 LLMComponent

**文件**: `env/llm/llm.ts`

**核心职责**:
- 管理 LLM 调用配置和 Provider
- 集成 AI SDK 进行实际调用
- 支持流式/非流式输出
- Hook 扩展点

**关键 API**:
```typescript
class LLMComponent extends BaseComponent {
  readonly name = "llm";
  readonly version = "2.0.0";

  async invoke(request: LLMInvokeRequest): Promise<LLMInvokeResult>;
  async invokeStream(request: LLMInvokeRequest, handler: StreamEventHandler): Promise<void>;
  getConfig(): LLMConfig;
}
```

### 6.3 ToolComponent

**文件**: `env/tool/tool-component.ts`

**核心职责**:
- 工具注册与发现
- 参数验证（Zod Schema）
- 工具执行与超时控制
- Hook 扩展点

**关键 API**:
```typescript
class ToolComponent extends BaseComponent {
  readonly name = "tool";
  readonly version = "1.0.0";

  register(tool: Tool): void;
  unregister(name: string): boolean;
  get(name: string): Tool | undefined;
  list(): Tool[];
  async execute(name: string, params: unknown): Promise<ToolResult>;
  validate(name: string, params: unknown): ZodSafeParseResult;
}
```

### 6.4 SessionComponent

**文件**: `env/session/session-component.ts`

**核心职责**:
- 会话 CRUD 操作
- 消息存储与检索
- Active Session 管理
- Hook 扩展点

**关键 API**:
```typescript
class SessionComponent extends BaseComponent {
  readonly name = "session";
  readonly version = "1.0.0";

  async create(options?: CreateSessionOptions): Promise<Session>;
  async get(id: string): Promise<Session | undefined>;
  async list(options?: ListSessionsOptions): Promise<Session[]>;
  async delete(id: string): Promise<boolean>;
  async addMessage(sessionId: string, message: AddMessageOptions): Promise<string>;
  async getMessages(sessionId: string, options?: PaginationOptions): Promise<SessionMessage[]>;
  getActiveSession(): Session | undefined;
  async setActiveSession(id: string): Promise<boolean>;
}
```

### 6.5 PromptComponent

**文件**: `env/prompt/prompt-component.ts`

**核心职责**:
- 内置 Prompt 管理
- 外部路径加载
- 模板变量替换
- Hook 扩展点

**关键 API**:
```typescript
class PromptComponent extends BaseComponent {
  readonly name = "prompt";
  readonly version = "1.0.0";

  add(name: string, content: string, source?: PromptSource): void;
  get(name: string): string | undefined;
  render(template: string, variables: Record<string, string>): string;
  async getPrompt(name: string, variables?: Record<string, string>): Promise<string>;
  async loadFromFile(path: string, name?: string): Promise<void>;
  async loadFromDirectory(path: string, ext?: string, recursive?: boolean): Promise<void>;
}
```

### 6.6 LogTraceComponent

**文件**: `env/log-trace/log-trace-component.ts`

**核心职责**:
- 结构化日志输出（文件 + 控制台）
- 追踪记录函数调用链
- Span 管理（start/end）
- SQLite 持久化追踪数据
- AsyncLocalStorage 管理 requestId/traceId

**关键 API**:
```typescript
class LogTraceComponent extends BaseComponent {
  readonly name = "log-trace";
  readonly version = "1.0.0";

  log(level: LogLevel, category: string, message: string, data?: unknown): void;
  startSpan(name: string, attributes?: SpanAttributes): SpanContext;
  endSpan(spanId: string, result?: unknown): void;
  traced(options?: TracedOptions): MethodDecorator;
}
```

### 6.7 AgentComponent (设计中)

**文件**: `env/agent/agent-component.ts`

**核心职责**:
- ReAct 循环编排
- 多 Agent 管理（primary + subAgents）
- Hook 扩展点

**设计中的 Hook 流程**:

```
before.start ──────────────────────────────────────────────
     │
     ▼
┌────────────────────────────────────────────────────────┐
│  before.llm ──► [Plugin: token-counter]                │
│                 [Plugin: context-injector]             │
│                 [Plugin: memory-summarizer]           │
└────────────────────────────────────────────────────────┘
     │
     ▼
┌────────────────────────────────────────────────────────┐
│  LLMComponent.invoke()                                  │
└────────────────────────────────────────────────────────┘
     │
     ├──► 文本响应 ──► after.complete
     │
     └──► 工具调用
             │
             ▼
      ┌─────────────────────┐
      │  before.tool ──►   │
      │    [Plugin: tool-permission] │
      └─────────────────────┘
             │
             ▼
      ┌─────────────────────┐
      │  ToolComponent.execute()      │
      └─────────────────────┘
             │
             ▼
      ┌─────────────────────┐
      │  after.tool ──►    │
      │    [Plugin: result-processor] │
      └─────────────────────┘
             │
             ▼
      on.iteration ──► [Plugin: iteration-checker]
                   ──► [Plugin: token-monitor]
             │
             └──────────► 循环回到 before.llm
```

---

## 7. 与 agent-core 的映射关系

| roy-bot Component | agent-core 对应实现 |
|---------------------|---------------------|
| BaseEnvironment | `core/environment/index.ts` - BaseEnvironment |
| Environment | `core/environment/Environment` - 接口定义 |
| ServerEnvironment | `server/environment.ts` - 具体实现 |
| LLMComponent | `llm/invoke.ts` - AI SDK 集成 |
| LogTraceComponent | `utils/logger.ts`, `utils/tracer.ts`, `utils/span-collector.ts` |
| ToolComponent | `env_spec/server.ts` - 工具定义和执行 |
| SessionComponent | `core/session.ts` + `server/active-session-manager.ts` |
| PromptComponent | 参考 `agent-prompt-file-design.md` |
| ConfigComponent | `config/*.ts` - 配置管理 |
| EnvEvent | `server/event/*.ts` - 事件总线 |
| AgentComponent | 待设计 |

---

## 8. 后续计划

### 8.1 AgentComponent 实现

- [ ] 定义 Agent 实例数据结构
- [ ] 实现 ReAct 循环引擎
- [ ] 实现多 Agent 管理
- [ ] 实现 Hook 扩展机制
- [ ] 实现 SubAgent 委派逻辑
- [ ] 实现后台任务机制

### 8.2 Component 增强

- [ ] LogTraceComponent: 完善 SQLite 持久化
- [ ] ToolComponent: 添加沙箱执行支持
- [ ] SessionComponent: 添加持久化存储支持
- [ ] ConfigComponent: 完善配置热更新机制

### 8.3 ServerEnvironment 扩展

- [ ] 集成 MCP Server
- [ ] 集成 EventSource
- [ ] 实现 SSE 流式推送
- [ ] 实现后台任务管理

---

## 9. 参考文档

- [Environment 设计哲学](../agent-core-source/docs/environment-design-philosophy.md)
- [Env Spec 设计](../agent-core-source/docs/env-spec-design-and-implementation.md)
- [Environment 事件机制](../agent-core-source/docs/environment-event-mechanism.md)
- [Agent-Core 核心概念](../agent-core-source/docs/agent-core-concepts.md)
- [Task & SubAgent 设计](../agent-core-source/docs/task-tool-subagent-design.md)
- [ToolComponent 设计](./tool-component-design.md)
- [SessionComponent 设计](./session-component-design.md)
- [LogTraceComponent 设计](./log-trace-component-design.md)
- [PromptComponent 设计](./prompt-component-design.md)
- [ConfigComponent 设计](./config-component-design.md)
- [去中心化配置设计](./component-decentralized-config-design.md)
