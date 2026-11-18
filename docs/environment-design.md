# Environment 设计文档

## 1. 概述

本文档定义 roy-bot 中 Environment 的设计和实现，参考 agent-core 的设计并进行改进。

**核心概念：**
- Environment 是智能体运行时的核心抽象
- Component 是系统的基本单元
- Hook 是 Component 的扩展点
- EnvEvent 是统一的事件机制

---

## 2. 设计原则

### 2.1 Environment 保持简洁

**Environment 只做两件事：**

```
┌─────────────────────────────────────────────────────────────┐
│                      Environment                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   1. 组件管理                                               │
│      └── 持有、注册、获取组件                                │
│                                                             │
│   2. 核心调度                                               │
│      └── handle_query / handle_action / EnvEvent            │
│                                                             │
│   其他能力 → 归属到对应 Component                            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 能力归属

| 能力 | 归属 Component |
|------|----------------|
| LLM 调用 | LLMComponent |
| 工具管理 | ToolComponent |
| 提示词管理 | PromptComponent |
| 会话管理 | SessionComponent |
| 任务管理 | TaskComponent |
| 记忆存储 | MemoryComponent |
| 技能加载 | SkillComponent |
| 日志记录 | LogComponent |
| 配置中心 | ConfigComponent |
| Agent 执行 | AgentComponent |

---

## 3. Environment 接口

### 3.1 完整接口定义

```typescript
interface Environment {
  // === 组件管理（核心职责）===
  
  /**
   * 注册组件
   */
  registerComponent(component: Component): void;
  
  /**
   * 注销组件
   */
  unregisterComponent(name: string): void;
  
  /**
   * 获取组件
   */
  getComponent<T extends Component>(name: string): T | undefined;
  
  /**
   * 列出所有组件
   */
  listComponents(): Component[];
  
  // === 核心能力（Agent 调度）===
  
  /**
   * 处理自然语言查询（核心入口）
   * 
   * @param query 用户查询文本
   * @param context 执行上下文（可选）
   * @returns 完整的文本响应
   */
  handle_query(
    query: string,
    context?: AgentContext
  ): Promise<string>;
  
  /**
   * 处理动作
   */
  handle_action(
    action: Action,
    context: Context
  ): Promise<ToolResult>;
  
  // === EnvEvent 机制 ===
  
  /**
   * 订阅 EnvEvent
   */
  subscribe(handler: EnvEventHandler): () => void;
  
  /**
   * 订阅指定类型事件
   */
  subscribeTo(
    eventType: string | string[], 
    handler: EnvEventHandler
  ): () => void;
  
  /**
   * 订阅所有事件（通配符）
   */
  subscribeAll(handler: EnvEventHandler): () => void;
  
  /**
   * 推送事件
   */
  pushEnvEvent(event: EnvEvent): void;
}
```

### 3.2 接口简化对比

```
┌─────────────────────────────────────────────────────────────┐
│                    接口对比                                   │
├───────────────────────┬─────────────────────────────────────┤
│  agent-core           │  roy-bot                         │
├───────────────────────┼─────────────────────────────────────┤
│                       │                                     │
│  handle_query         │  handle_query                      │
│  handle_action        │  handle_action                     │
│  invokeLLM            │  → LLMComponent.invoke()          │
│  getTools             │  → ToolComponent.getTools()        │
│  registerTool         │  → ToolComponent.registerTool()    │
│  getPrompt            │  → PromptComponent.get()           │
│  createSession        │  → SessionComponent.create()        │
│  getSession          │  → SessionComponent.get()           │
│  listSessions        │  → SessionComponent.list()           │
│  listSkills          │  → SkillComponent.list()            │
│  getSkill            │  → SkillComponent.get()             │
│                       │                                     │
│  ────────────────    │  ─────────────────                 │
│  subscribe            │  subscribe                         │
│  unsubscribe          │  → subscribe 返回取消函数          │
│  getStream            │  → EnvEvent 事件中携带            │
│  pushToSubscribers    │  pushEnvEvent                     │
│  onStreamEvent        │  → EnvEvent 机制统一处理          │
│                       │                                     │
└───────────────────────┴─────────────────────────────────────┘
```

---

## 4. EnvEvent 机制

### 4.1 设计来源

参考 agent-core 中的 EnvEventBus 设计，提供统一的事件机制。

### 4.2 EnvEvent 类型

```typescript
interface EnvEvent<T = unknown> {
  /** 事件 ID */
  id: string;
  
  /** 事件类型 */
  type: string;
  
  /** 时间戳 */
  timestamp: number;
  
  /** 元信息 */
  metadata: {
    /** 触发事件的 session */
    trigger_session_id?: string;
    /** 触发事件的 agent */
    trigger_agent_id?: string;
    /** Agent 名称 */
    trigger_agent_name?: string;
    /** 环境名称 */
    env_name?: string;
    /** 事件来源 */
    source?: string;
    /** 其他元数据 */
    [key: string]: unknown;
  };
  
  /** 事件负载 */
  payload: T;
}

/** EnvEvent 处理器 */
type EnvEventHandler = (event: EnvEvent) => void | Promise<void>;
```

### 4.3 预定义事件类型

使用 Zod Schema 定义类型安全的事件：

```typescript
// === Stream 事件 ===
const StreamStartEvent = BusEvent.define(
  "stream.start",
  z.object({
    sessionId: z.string(),
    messageId: z.string(),
    model: z.string(),
  })
);

const StreamTextEvent = BusEvent.define(
  "stream.text",
  z.object({
    sessionId: z.string(),
    messageId: z.string(),
    content: z.string(),      // 累积内容
    delta: z.string(),         // 新增量
  })
);

const StreamReasoningEvent = BusEvent.define(
  "stream.reasoning",
  z.object({
    sessionId: z.string(),
    messageId: z.string(),
    content: z.string(),
  })
);

const StreamToolCallEvent = BusEvent.define(
  "stream.tool.call",
  z.object({
    sessionId: z.string(),
    messageId: z.string(),
    toolName: z.string(),
    toolArgs: z.record(z.unknown()),
    toolCallId: z.string(),
    reason: z.string().optional(),
  })
);

const StreamToolResultEvent = BusEvent.define(
  "stream.tool.result",
  z.object({
    sessionId: z.string(),
    messageId: z.string(),
    toolName: z.string(),
    toolCallId: z.string(),
    result: z.unknown(),
    success: z.boolean(),
    metadata: z.unknown().optional(),
  })
);

const StreamCompletedEvent = BusEvent.define(
  "stream.completed",
  z.object({
    sessionId: z.string(),
    messageId: z.string(),
    usage: z.object({
      promptTokens: z.number(),
      completionTokens: z.number(),
      totalTokens: z.number(),
    }).optional(),
  })
);

const StreamErrorEvent = BusEvent.define(
  "stream.error",
  z.object({
    sessionId: z.string(),
    messageId: z.string().optional(),
    error: z.string(),
    code: z.string().optional(),
  })
);

// === Session 事件 ===
const SessionCreatedEvent = BusEvent.define(
  "session.created",
  z.object({
    sessionId: z.string(),
    title: z.string(),
    directory: z.string().optional(),
  })
);

const SessionUpdatedEvent = BusEvent.define(
  "session.updated",
  z.object({
    sessionId: z.string(),
    updates: z.record(z.unknown()),
  })
);

const SessionDeletedEvent = BusEvent.define(
  "session.deleted",
  z.object({
    sessionId: z.string(),
  })
);

// === Query 事件 ===
const QueryCompletedEvent = BusEvent.define(
  "query.completed",
  z.object({
    sessionId: z.string(),
    messageId: z.string(),
    response: z.string().optional(),
  })
);

// === Task 事件 ===
const TaskCreatedEvent = BusEvent.define(
  "task.created",
  z.object({
    taskId: z.number(),
    title: z.string(),
  })
);

const TaskUpdatedEvent = BusEvent.define(
  "task.updated",
  z.object({
    taskId: z.number(),
    updates: z.record(z.unknown()),
  })
);

const TaskCompletedEvent = BusEvent.define(
  "task.completed",
  z.object({
    taskId: z.number(),
  })
);
```

### 4.4 EnvEventBus 实现

```typescript
interface EnvEventBus {
  /**
   * 发布事件
   */
  publish(event: EnvEvent): Promise<void>;
  
  /**
   * 订阅指定类型事件
   * @param eventType 事件类型，支持数组和通配符（*、prefix.*）
   * @param handler 事件处理器
   * @returns 取消订阅函数
   */
  subscribe(
    eventType: string | string[], 
    handler: EnvEventHandler
  ): () => void;
  
  /**
   * 订阅所有事件
   */
  subscribeAll(handler: EnvEventHandler): () => void;
  
  /**
   * 订阅指定 session 的事件
   */
  subscribeToSession(
    sessionId: string, 
    handler: EnvEventHandler
  ): () => void;
  
  /**
   * 单次订阅
   */
  once(eventType: string, handler: EnvEventHandler): void;
}
```

### 4.5 EnvEvent 特性

| 特性 | 说明 |
|------|------|
| **类型安全** | 使用 Zod Schema 定义事件负载 |
| **通配符匹配** | 支持 `*` 匹配所有、`prefix.*` 前缀匹配 |
| **优先级** | 支持规则优先级，高优先级先执行 |
| **幂等性** | 相同 ID 的事件只处理一次 |
| **Session 隔离** | 支持按 session 订阅 |

---

## 5. BaseEnvironment 实现

### 5.1 实现框架

```typescript
abstract class BaseEnvironment implements Environment {
  // === 组件存储 ===
  protected components: Map<string, Component> = new Map();
  
  // === EnvEvent 总线 ===
  protected eventBus: EnvEventBus;
  
  // === 组件管理 ===
  
  registerComponent(component: Component): void {
    this.components.set(component.name, component);
  }
  
  unregisterComponent(name: string): void {
    const component = this.components.get(name);
    if (component) {
      component.stop();
      this.components.delete(name);
    }
  }
  
  getComponent<T extends Component>(name: string): T | undefined {
    return this.components.get(name) as T | undefined;
  }
  
  listComponents(): Component[] {
    return Array.from(this.components.values());
  }
  
  // === EnvEvent 机制 ===
  
  subscribe(handler: EnvEventHandler): () => void {
    return this.eventBus.subscribe("*", handler);
  }
  
  subscribeTo(eventType: string | string[], handler: EnvEventHandler): () => void {
    return this.eventBus.subscribe(eventType, handler);
  }
  
  subscribeAll(handler: EnvEventHandler): () => void {
    return this.eventBus.subscribeAll(handler);
  }
  
  pushEnvEvent(event: EnvEvent): void {
    this.eventBus.publish(event);
  }
  
  // === 核心能力（子类实现）===
  
  abstract handle_query(query: string, context?: Context): Promise<string>;
  abstract handle_action(action: Action, context: Context): Promise<ToolResult>;
}
```

### 5.2 组件初始化

```typescript
class BaseEnvironment {
  /**
   * 初始化所有组件
   */
  async initialize(): Promise<void> {
    // 1. 先初始化 ConfigComponent
    const config = new ConfigComponent();
    await config.init(this.getDefaultConfig());
    this.registerComponent(config);
    
    // 2. 初始化其他组件
    const defaultComponents = this.getDefaultComponents();
    for (const component of defaultComponents) {
      const componentConfig = config.getComponentConfig(component.name);
      await component.init(componentConfig);
      this.registerComponent(component);
    }
    
    // 3. 启动所有组件
    for (const component of this.listComponents()) {
      await component.start();
    }
  }
  
  protected getDefaultComponents(): Component[] {
    return [
      new LLMComponent(),
      new ToolComponent(),
      new PromptComponent(),
      new SessionComponent(),
      new AgentComponent(),
      new TaskComponent(),
      new MemoryComponent(),
      new SkillComponent(),
      new LogComponent(),
    ];
  }
}
```

---

## 6. Component 组件

### 6.1 Component 接口

```typescript
interface Component {
  readonly name: string;
  readonly version: string;
  
  getStatus(): ComponentStatus;
  getConfig(): ComponentConfig;
  
  init(config?: ComponentConfig): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  
  readonly hooks: HookMap;
}

type ComponentStatus = 
  | "created" 
  | "initializing" 
  | "running" 
  | "stopping" 
  | "stopped" 
  | "error";

interface ComponentConfig {
  name: string;
  version: string;
  enabled: boolean;
  options?: Record<string, unknown>;
}
```

### 6.2 组件关系图

```
┌─────────────────────────────────────────────────────────────┐
│                      Environment                              │
│                                                             │
│   components: Map<string, Component>                        │
│   eventBus: EnvEventBus                                    │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐  │
│   │                   Component (基类)                     │  │
│   │   name, version                                      │  │
│   │   init(), start(), stop()                            │  │
│   │   hooks: HookMap                                     │  │
│   └─────────────────────────────────────────────────────┘  │
│                           │                                  │
│         ┌─────────────────┼─────────────────┐             │
│         ▼                 ▼                 ▼               │
│   ┌──────────┐     ┌──────────┐     ┌──────────┐        │
│   │   LLM    │     │   Tool   │     │  Prompt  │        │
│   │Component │     │Component │     │Component │        │
│   │invoke()  │     │register()│     │  get()   │        │
│   └──────────┘     └──────────┘     └──────────┘        │
│         │                 │                 │               │
│         ▼                 ▼                 ▼               │
│   ┌──────────┐     ┌──────────┐     ┌──────────┐        │
│   │  Agent   │     │ Session  │     │   Task   │        │
│   │Component │     │Component │     │Component │        │
│   │run()    │     │create()  │     │create()  │        │
│   └──────────┘     └──────────┘     └──────────┘        │
│         │                 │                 │               │
│         ▼                 ▼                 ▼               │
│   ┌──────────┐     ┌──────────┐     ┌──────────┐        │
│   │  Memory  │     │  Config  │     │  Skill   │        │
│   │Component │     │Component │     │Component │        │
│   │write()  │     │get/set() │     │ load()   │        │
│   └──────────┘     └──────────┘     └──────────┘        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 7. 组件详解

### 7.1 LLMComponent

```typescript
interface LLMComponent extends Component {
  readonly name = "llm";
  readonly hooks: HookMap = {
    "before.invoke": [],
    "after.invoke": [],
  };
  
  /**
   * 调用 LLM
   */
  invoke(
    messages: ModelMessage[], 
    tools?: ToolInfo[],
    options?: LLMOptions
  ): Promise<ToolResult>;
  
  /**
   * 配置 LLM
   */
  configure(model: string, baseURL?: string, apiKey?: string): void;
  
  /**
   * 获取当前模型
   */
  getModel(): string;
}
```

#### 7.1.1 LLM 配置结构

```typescript
// LLMConfig - 完整配置结构
interface LLMConfig {
  // 全局默认配置
  default?: {
    temperature?: number;
    maxTokens?: number;
  };
  
  // 默认模型（格式: "providerId/modelId"）
  defaultModel?: string;
  
  // Provider 配置映射
  providers: Record<string, ProviderConfig>;
  
  // 默认 Provider
  defaultProvider: string;
  
  // 全局覆盖参数
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stream?: boolean;
}

// ProviderConfig - Provider 配置
interface ProviderConfig {
  // Provider 类型
  provider: ProviderType | string;
  
  // Provider 元信息
  name?: string;
  description?: string;
  
  // API 配置
  apiKey: string;
  baseURL?: string;
  
  // 模型配置
  models?: string[];
  defaultModel?: string;
  
  // 默认参数
  temperature?: number;
  maxTokens?: number;
  
  // Provider 能力
  capabilities?: ProviderCapabilities;
  
  // 模型限制
  limits?: Record<string, ModelLimits>;
  
  // Provider 特定选项
  providerOptions?: Record<string, unknown>;
}

// ProviderCapabilities - Provider 能力配置
interface ProviderCapabilities {
  // 支持推理（CoT）
  reasoning?: boolean;
  
  // 支持工具调用
  toolcall?: boolean;
  
  // 混合内容字段
  interleaved?: {
    field: string;
  };
  
  // 文本内思考标签
  thinkingInText?: {
    enabled?: boolean;
    tags?: string[];
    removeFromOutput?: boolean;
  };
}

// ModelLimits - 模型限制
interface ModelLimits {
  // 上下文窗口大小
  contextWindow: number;
  
  // 压缩阈值（超过此比例触发压缩）
  compactionThreshold?: number;
  
  // 最大输出 Token
  maxOutputTokens?: number;
}
```

#### 7.1.2 配置示例

```jsonc
{
  // 全局默认配置
  "default": {
    "temperature": 0.7,
    "maxTokens": 4000
  },
  
  // 默认模型
  "defaultModel": "minimax/MiniMax-M2.5",
  
  // Provider 配置
  "providers": {
    "minimax": {
      "name": "MiniMax",
      "description": "MiniMax AI models",
      "provider": "minimax",
      "apiKey": "${MINIMAX_API_KEY}",
      "baseURL": "https://api.minimax.chat/v1",
      "models": ["MiniMax-M2.7", "MiniMax-M2.5"],
      "defaultModel": "MiniMax-M2.5",
      "temperature": 1.0,
      "maxTokens": 8192,
      
      // Provider 能力
      "capabilities": {
        "reasoning": true,
        "toolcall": true,
        "thinkingInText": {
          "enabled": true,
          "tags": ["think"],
          "removeFromOutput": true
        }
      },
      
      // 模型限制
      "limits": {
        "MiniMax-M2.5": {
          "contextWindow": 200000,
          "compactionThreshold": 0.8
        }
      },
      
      // Provider 特定选项
      "providerOptions": {
        "__dangerous__": {
          "validateResponse": false
        }
      }
    }
  }
}
```

### 7.2 ToolComponent

```typescript
interface ToolComponent extends Component {
  readonly name = "tool";
  readonly hooks: HookMap = {
    "before.register": [],
    "after.register": [],
    "before.execute": [],
    "after.execute": [],
  };
  
  register(tool: Tool): ToolRegistration;
  unregister(name: string): boolean;
  getTool(name: string): Tool | undefined;
  listTools(): Tool[];
  findByCategory(category: string): Tool[];
  execute(name: string, args: unknown, context: ToolContext): Promise<ToolResult>;
}
```

### 7.3 SessionComponent

```typescript
interface SessionComponent extends Component {
  readonly name = "session";
  readonly hooks: HookMap = {
    "before.create": [],
    "after.create": [],
    "before.addMessage": [],
    "after.addMessage": [],
    "before.compact": [],
    "after.compact": [],
    "before.delete": [],
  };
  
  create(options?: SessionCreateOptions): Session;
  get(id: string): Session | undefined;
  list(filter?: SessionFilter): Session[];
  delete(id: string): void;
  addMessage(sessionId: string, message: Message): void;
  compact(sessionId: string, options?: CompactOptions): CompactResult;
}
```

### 7.4 AgentComponent

```typescript
interface AgentComponent extends Component {
  readonly name = "agent";
  readonly hooks: HookMap = {
    "before.run": [],
    "after.run": [],
    "before.llm": [],
    "after.llm": [],
    "before.tool": [],
    "after.tool": [],
    "before.permission": [],
  };
  
  run(query: string, context?: Context): Promise<string>;
  getBehaviorSpec(agentId?: string): BehaviorSpec;
  getEnvRules(): string;
  filterTools(tools: Tool[], agentId?: string): Tool[];
  getProfiles(): EnvironmentProfile[];
}
```

### 7.5 ConfigComponent

```typescript
interface ConfigComponent extends Component {
  readonly name = "config";
  readonly hooks: HookMap = {
    "before.set": [],
    "after.set": [],
    "on.change": [],
  };
  
  // 基本配置操作
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  has(key: string): boolean;
  delete(key: string): boolean;
  
  // 组件配置
  getComponentConfig(name: string): ComponentConfig | undefined;
  setComponentConfig(name: string, config: ComponentConfig): void;
  listComponentConfigs(): ComponentConfig[];
  
  // 观察者
  watch(key: string, callback: (value: unknown) => void): () => void;
  
  // 配置源
  addSource(source: ConfigSource): void;
}
```

---

## 8. 使用示例

### 8.1 创建 Environment

```typescript
class MyEnvironment extends BaseEnvironment {
  handle_query(query: string, context?: Context): Promise<string> {
    return this.getComponent("agent").run(query, context);
  }
  
  handle_action(action: Action, context: Context): Promise<ToolResult> {
    return this.getComponent("tool").execute(action.name, action.args, context);
  }
}

// 使用
const env = new MyEnvironment();
await env.initialize();

const result = await env.handle_query("帮我写一个 hello world");
```

### 8.2 订阅 EnvEvent

```typescript
// 订阅所有事件
const unsubscribe = env.subscribe((event) => {
  console.log("Event:", event.type, event.payload);
});

// 订阅特定类型
const unsubscribeText = env.subscribeTo("stream.text", (event) => {
  console.log("Text delta:", event.payload.delta);
});

// 订阅多个类型
const unsubscribeStream = env.subscribeTo([
  "stream.start", 
  "stream.completed"
], (event) => {
  console.log("Stream event:", event.type);
});

// 取消订阅
unsubscribe();
```

### 8.3 发布自定义事件

```typescript
env.pushEnvEvent({
  id: generateId(),
  type: "custom.event",
  timestamp: Date.now(),
  metadata: {
    trigger_session_id: context.session_id,
  },
  payload: {
    message: "Hello",
  },
});
```

### 8.4 LLMComponent 发布 Stream 事件

```typescript
class LLMComponent {
  async invoke(messages: ModelMessage[], tools?: ToolInfo[]) {
    // 发布 stream.start 事件
    env.pushEnvEvent({
      id: generateId(),
      type: "stream.start",
      timestamp: Date.now(),
      metadata: { sessionId: context.session_id },
      payload: { sessionId: context.session_id, model: this.model },
    });
    
    // 流式处理...
    for await (const chunk of stream) {
      // 发布 stream.text 事件
      env.pushEnvEvent({
        id: generateId(),
        type: "stream.text",
        timestamp: Date.now(),
        metadata: {},
        payload: { 
          sessionId: context.session_id,
          content: chunk.content,
          delta: chunk.delta,
        },
      });
    }
    
    // 发布 stream.completed 事件
    env.pushEnvEvent({
      id: generateId(),
      type: "stream.completed",
      timestamp: Date.now(),
      metadata: {},
      payload: { sessionId: context.session_id, usage },
    });
  }
}
```

---

## 9. 文件结构

```
roy-bot/packages/core/src/
├── component/                 # Component 核心
│   ├── component.ts          # Component 接口
│   ├── hook.ts              # Hook 定义
│   └── index.ts
│
├── event/                   # EnvEvent 机制
│   ├── event.ts             # EnvEvent 类型定义
│   ├── event-bus.ts         # EnvEventBus 实现
│   ├── bus-event.ts         # BusEvent 类型安全定义
│   ├── events/              # 预定义事件
│   │   ├── stream.ts        # Stream 事件
│   │   ├── session.ts       # Session 事件
│   │   ├── task.ts          # Task 事件
│   │   └── index.ts
│   └── index.ts
│
├── env/                     # Environment
│   ├── environment.ts        # Environment 接口
│   ├── base-env.ts          # BaseEnvironment 实现
│   │
│   ├── llm/                # LLMComponent
│   ├── tool/                # ToolComponent
│   ├── agent/               # AgentComponent
│   ├── session/             # SessionComponent
│   ├── config/              # ConfigComponent
│   └── ...                  # 其他组件
│
└── types/                   # 共享类型
    ├── context.ts
    └── index.ts
```

---

## 10. 相关文档

- [架构设计文档](./architecture-design.md)
- [智能化OS设计理念](./intelligent-os-design.md)

---

## 11. 更新记录

| 日期 | 版本 | 说明 |
|------|------|------|
| 2026-03-25 | v0.1.0 | 初始版本 |
| 2026-03-25 | v0.2.0 | 简化 Environment 接口，能力归属到 Component |
| 2026-03-25 | v0.3.0 | 引入 EnvEvent 机制，统一事件处理 |
