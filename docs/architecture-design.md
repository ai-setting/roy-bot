# roy-bot 架构设计文档

## 1. 概述

roy-bot 是一个智能化操作系统框架，灵感来自 tong-env-core 设计。提供统一的 CLI 入口和丰富的子命令系统，支持会话、任务、提示词、智能体、记忆、工具、技能、配置、日志等核心实体的管理。

**核心设计理念：**
- **自然语言交互**：通过 `act` 命令以自然语言驱动整个操作系统
- **渐进式探索**：不带参数时显示帮助，智能体可通过 `--help` 自我学习
- **统一入口**：类似 shell/bash，智能体只需知道一个入口
- **嵌套调用**：支持环境间相互调用

---

## 2. 包结构

### 2.1 Monorepo 结构

```
roy-bot/
├── packages/
│   ├── core/                    # @roy-bot/core (SDK)
│   │   └── src/
│   │       └── ...
│   │
│   ├── coder/                  # @roy-bot/coder (Coder Harness)
│   │   └── src/
│   │       ├── index.ts
│   │       ├── coder-environment.ts
│   │       └── plugins/
│   │
│   └── cli/                    # @roy-bot/cli (命令行工具)
│       └── src/
│           └── ...
│
├── docs/
│   └── architecture-design.md  # 本文档
│
└── package.json                # Workspace 根配置
```

### 2.2 包职责

| 包名 | npm 包名 | 说明 |
|------|----------|------|
| `@roy-bot/core` | `core` | 核心 SDK，场景无关，包含 Environment + Component + Hook |
| `@roy-bot/coder` | `coder` | Coder Harness，编程场景适配，通过 Plugin 扩展 |
| `@roy-bot/cli` | `cli` | CLI 工具，提供命令行入口 |

---

## 3. 核心概念：Component

### 3.1 Component = 系统的基本单元

**Component** 是整个系统最基本的功能单元，每个 Component 都是一个独立的功能模块。

```
┌─────────────────────────────────────────────────────────────┐
│                      Component                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   ┌─────────────────────────────────────────────────────┐  │
│   │                   Component                            │  │
│   │                                                     │  │
│   │   name: string           // 组件名称                  │  │
│   │   version: string         // 组件版本                 │  │
│   │   status: ComponentStatus // 运行状态                  │  │
│   │                                                     │  │
│   │   init(): Promise<void>   // 初始化                  │  │
│   │   start(): Promise<void>  // 启动                    │  │
│   │   stop(): Promise<void>   // 停止                    │  │
│   │                                                     │  │
│   │   readonly hooks: HookMap  // 扩展点（关键！）        │  │
│   │                                                     │  │
│   └─────────────────────────────────────────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Component 接口定义

```typescript
// 组件状态
type ComponentStatus = "created" | "initializing" | "running" | "stopping" | "stopped" | "error";

// 组件配置
interface ComponentConfig {
  name: string;
  version: string;
  enabled: boolean;
  options?: Record<string, unknown>;
  env?: Environment;  // Environment 实例（可选）
}

// Hook 元信息
interface HookMeta {
  name: string;
  priority?: number;  // 执行优先级，数字越小越先执行
  description?: string;
}

// Hook 上下文
interface HookContext<T = unknown> {
  component: { name: string; version: string };
  data: T;           // Component 特定数据
  metadata: Record<string, unknown>;
  phase: "before" | "after" | "error";
  hookPoint: string;
}

// Hook 接口
interface Hook<T = unknown> extends HookMeta {
  execute(ctx: HookContext<T>): void | Promise<void>;
}

// Component 基类接口
interface Component {
  readonly name: string;
  readonly version: string;
  getStatus(): ComponentStatus;
  getConfig(): ComponentConfig;
  
  init(config?: ComponentConfig): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

### 3.3 Component 与 Opencode Plugin 的关系

| Opencode 概念 | roy-bot 概念 | 说明 |
|---------------|----------------|------|
| Plugin | Component | 功能单元 |
| Plugin.hooks | Component.hookManager | 扩展点 |
| tool | AgentComponent (内置) | 工具 |
| Hook: chat.message | AgentComponent.registerHook("before.start", ...) | 消息处理 |
| Hook: chat.params | AgentComponent.registerHook("before.llm", ...) | 参数调整 |
| Hook: tool.execute.before | AgentComponent.registerHook("before.tool", ...) | 工具执行前 |
| Hook: tool.execute.after | AgentComponent.registerHook("after.tool", ...) | 工具执行后 | |

### 3.4 去中心化配置注册

每个 Component 自主声明需要的配置源（Source）和配置键（Key），ConfigComponent 统一管理和加载。

详细设计请参阅 [component-decentralized-config-design.md](./component-decentralized-config-design.md)。

```
┌─────────────────────────────────────────────────────────────┐
│                    去中心化配置注册流程                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   Component.init()                                          │
│       │                                                     │
│       ├──→ ConfigComponent.registerSource({                 │
│       │       type: "file",                               │
│       │       relativePath: "llm-config.jsonc"             │
│       │   })                                                │
│       │                                                     │
│       ├──→ ConfigComponent.registerKeys([                 │
│       │       { key: "llm.provider", sources: ["file", "env", "memory"] },
│       │       { key: "llm.model", sources: ["file", "memory"] },
│       │   ])                                                │
│       │                                                     │
│       └──→ ConfigComponent.load()  // 按需加载配置           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Source 优先级**：

| Source | 优先级 | 说明 |
|--------|--------|------|
| MemorySource | 0 | 运行时内存，最先查询 |
| FileSource | 10 | 本地配置文件 |
| EnvSource | 20 | 环境变量，最高优先级 |

### 3.5 EnvEvent 机制

参考 agent-core 的 EnvEventBus 设计，提供统一的事件机制：

```typescript
// EnvEvent 类型
interface EnvEvent<T = unknown> {
  id: string;
  type: string;
  timestamp: number;
  metadata: {
    trigger_session_id?: string;
    trigger_agent_id?: string;
    trigger_agent_name?: string;
    env_name?: string;
    source?: string;
    [key: string]: unknown;
  };
  payload: T;
}

// 预定义事件
const StreamStartEvent = BusEvent.define("stream.start", z.object({...}));
const StreamTextEvent = BusEvent.define("stream.text", z.object({...}));
const StreamToolCallEvent = BusEvent.define("stream.tool.call", z.object({...}));
const StreamToolResultEvent = BusEvent.define("stream.tool.result", z.object({...}));
const StreamCompletedEvent = BusEvent.define("stream.completed", z.object({...}));
const StreamErrorEvent = BusEvent.define("stream.error", z.object({...}));
const SessionCreatedEvent = BusEvent.define("session.created", z.object({...}));
const SessionUpdatedEvent = BusEvent.define("session.updated", z.object({...}));
const SessionDeletedEvent = BusEvent.define("session.deleted", z.object({...}));
const QueryCompletedEvent = BusEvent.define("query.completed", z.object({...}));
```

**特性：**
- 类型安全（Zod Schema）
- 通配符匹配（*、prefix.*）
- 优先级支持
- 幂等性
- Session 隔离

---

## 4. 核心组件列表

### 4.1 组件总览

| # | 组件 | 说明 | 对应子命令 |
|---|------|------|-----------|
| 1 | **agent** | 智能体执行逻辑（核心） | `agents` |
| 2 | **session** | 会话管理、历史、上下文 | `sessions` |
| 3 | **llm** | LLM 调用封装 | 内置能力 |
| 4 | **tool** | 工具注册与执行 | `tools` |
| 5 | **prompt** | 提示词管理 | `prompts` |
| 6 | **task** | 任务管理 | `tasks` |
| 7 | **memory** | 记忆存储与检索 | `memory` |
| 8 | **skill** | 技能动态加载 | `skills` |
| 9 | **log** | 日志记录与查询 | `logs` |
| 10 | **config** | 配置管理（配置中心） | `config` |

### 4.2 组件 Hooks 设计

每个 Component 可以定义自己的 Hooks，作为该组件的扩展点：

#### AgentComponent（智能体）

```typescript
AgentComponent.hooks = {
  "before.run": [],           // Agent 执行前（chat.message + chat.params）
  "before.llm": [],          // LLM 调用前（chat.headers）
  "before.tool": [],         // 工具执行前
  "after.tool": [],          // 工具执行后
  "before.permission": [],    // 权限询问前
  "after.run": [],           // Agent 执行后
};
```

#### SessionComponent（会话）

```typescript
SessionComponent.hooks = {
  "before.create": [],        // 创建会话前
  "after.create": [],        // 创建会话后
  "before.addMessage": [],    // 添加消息前
  "after.addMessage": [],     // 添加消息后
  "before.compact": [],      // 压缩前
  "after.compact": [],       // 压缩后
  "before.delete": [],       // 删除前
};
```

#### TaskComponent（任务）

```typescript
TaskComponent.hooks = {
  "before.create": [],        // 创建任务前
  "after.create": [],        // 创建任务后
  "before.update": [],       // 更新任务前
  "after.update": [],       // 更新任务后
  "on.statusChange": [],     // 状态变更时
  "on.assign": [],          // 分配时
  "on.complete": [],         // 完成任务时
};
```

#### MemoryComponent（记忆）

```typescript
MemoryComponent.hooks = {
  "before.write": [],        // 写入前
  "after.write": [],         // 写入后
  "before.search": [],       // 搜索前
  "after.search": [],        // 搜索后
  "before.delete": [],       // 删除前
  "on.expire": [],          // 过期时
};
```

#### ConfigComponent（配置中心）

```typescript
ConfigComponent.hooks = {
  "before.set": [],          // 设置配置前
  "after.set": [],           // 设置配置后
  "on.change": [],          // 配置变更时
  "on.validate": [],        // 验证时
  "before.get": [],         // 获取配置前
};
```

### 4.3 组件详情

#### Agent（智能体）

智能体执行单元，是整个系统的核心：
- 用户查询处理
- 工具调用循环
- 消息历史管理
- 重试机制（指数退避）
- Doom Loop 检测
- **Hooks 扩展**：before.run, before.llm, before.tool, after.tool 等

#### Session（会话）

会话管理组件：
- 会话生命周期管理
- 消息历史存储与检索
- 会话压缩（Compaction）
- **Hooks 扩展**：before.create, after.create, before.addMessage 等

#### LLM（语言模型）

LLM 调用封装：
- **多 Provider 支持**：OpenAI、Anthropic、Google、OpenAI Compatible 等
- **模型配置与管理**：
  - 全局默认配置（temperature, maxTokens）
  - Provider 级别配置
  - 模型限制（contextWindow, compactionThreshold）
- **Provider 能力配置**：
  - 推理能力（reasoning）
  - 工具调用（toolcall）
  - 文本内思考标签（thinkingInText）
- **流式输出支持**：通过 StreamEventHandler 回调
- **Token 用量统计**：promptTokens, completionTokens, totalTokens
- **AI SDK 集成**：使用 `streamText` 进行统一调用

#### Tool（工具）

工具注册与执行：
- 工具注册/注销
- 参数验证（Zod Schema）
- 执行上下文管理

#### Prompt（提示词）

提示词管理：
- 提示词存储与加载
- 变量替换
- 模板渲染

#### Task（任务）

任务管理：
- 任务 CRUD 操作
- 状态流转（todo → active → completed）
- 进度跟踪
- **Hooks 扩展**：on.statusChange, on.assign 等

#### Memory（记忆）

记忆存储与检索：
- 记忆文件存储
- 全文搜索
- 标签管理
- **Hooks 扩展**：before.write, before.search 等

#### Skill（技能）

技能动态加载：
- 技能发现与加载
- 热插拔支持

#### Log（日志）

日志记录与查询：
- 日志写入
- 日志查询
- 日志统计

#### Config（配置）

配置中心，支持去中心化配置注册：
- **配置读取**：环境变量、文件、内存（按优先级）
- **配置写入**：内存级别实时设置
- **去中心化注册**：各 Component 自主声明 Source 和 Key
- **配置发现**：查看环境中的组件
- **配置订阅/通知**：监听配置变更
- **异步持久化**：后台队列 + 防抖写入
- **引用协议**：支持 `${file://}` 和 `${env://}` 引用
- **Hooks 扩展**：on.change, before.set 等

详细设计请参阅 [component-decentralized-config-design.md](./component-decentralized-config-design.md)

---

## 5. Environment 架构

### 5.1 核心抽象

**Environment** 是整个系统的核心抽象，它是一个容器/编排者，持有所有 Component 实例并编排它们之间的协作。

```
┌─────────────────────────────────────────────────────────────┐
│                      Environment                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   components: Map<string, Component>                        │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐  │
│   │                   Component (基类)                     │  │
│   │   - name, version                                    │  │
│   │   - init(), start(), stop()                          │  │
│   │   - hooks: HookMap                                   │  │
│   └─────────────────────────────────────────────────────┘  │
│                           │                                  │
│         ┌─────────────────┼─────────────────┐             │
│         ↓                 ↓                 ↓               │
│   ┌──────────┐     ┌──────────┐     ┌──────────┐        │
│   │  Agent   │     │ Session  │     │   Task   │        │
│   │Component │     │Component │     │Component │        │
│   │          │     │          │     │          │        │
│   │hooks:    │     │hooks:    │     │hooks:    │        │
│   │run/llm  │     │create   │     │status   │        │
│   │/tool    │     │/compact │     │/assign  │        │
│   └──────────┘     └──────────┘     └──────────┘        │
│         │                 │                 │               │
│         ↓                 ↓                 ↓               │
│   ┌──────────┐     ┌──────────┐     ┌──────────┐        │
│   │  Memory  │     │  Config  │     │  Skill   │        │
│   │Component │     │Component │     │Component │        │
│   │          │     │          │     │          │        │
│   │hooks:    │     │hooks:    │     │hooks:    │        │
│   │write     │     │set/      │     │load/     │        │
│   │/search   │     │change    │     │unload    │        │
│   └──────────┘     └──────────┘     └──────────┘        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 Environment 接口

**设计原则：Environment 只做容器和核心调度，其他能力归属到 Component。**

```typescript
interface Environment {
  // === 组件管理（核心职责）===
  registerComponent(component: Component): void;
  unregisterComponent(name: string): void;
  getComponent<T extends Component>(name: string): T | undefined;
  listComponents(): Component[];
  
  // === 核心能力（Agent 调度）===
  handle_query(query: string, context?: Context): Promise<string>;
  handle_action(action: Action, context: Context): Promise<ToolResult>;
  
  // === 流式处理 ===
  subscribe(handler: StreamHandler): void;
  unsubscribe(handler: StreamHandler): void;
  pushToSubscribers(event: LLMStreamEvent): void;
}
```

### 5.3 能力归属

| 能力 | 归属 Component |
|------|---------------|
| LLM 调用 | LLMComponent |
| 工具管理 | ToolComponent |
| 会话管理 | SessionComponent |
| 配置中心 | ConfigComponent |
| ... | ... |

### 5.3 Hooks 工作机制

```typescript
// Component 内部定义并触发 hooks
class AgentComponent implements Component {
  readonly hooks: HookMap = {
    "before.run": [],
    "before.llm": [],
    "before.tool": [],
    "after.tool": [],
    "after.run": [],
  };
  
  async run(query: string, context: Context) {
    // 触发 before.run hooks
    for (const hook of this.hooks["before.run"]) {
      await hook.before?.({ query, context }, {});
    }
    
    // 核心逻辑：LLM 调用
    for (const hook of this.hooks["before.llm"]) {
      await hook.before?.({ messages }, { params });
    }
    
    // 工具执行
    for (const tool of tools) {
      for (const hook of this.hooks["before.tool"]) {
        await hook.before?.({ tool, args }, { modifiedArgs });
      }
      const result = await tool.execute(args);
      for (const hook of this.hooks["after.tool"]) {
        await hook.after?.({ tool, args }, { result });
      }
    }
    
    // 触发 after.run hooks
    for (const hook of this.hooks["after.run"]) {
      await hook.after?.({ query, result }, {});
    }
  }
}

// 注册自定义 Hook
env.getComponent("agent").hooks["before.run"].push({
  name: "myLoggingHook",
  before: async (input, output) => {
    console.log("Agent running:", input.query);
  }
});
```

---

## 6. 包内部结构

### 6.1 @roy-bot/core

```
@roy-bot/core
└── src/
    ├── component/              # Component 核心
    │   ├── component.ts        # Component 接口
    │   ├── hook.ts             # Hook 定义
    │   └── index.ts
    │
    ├── env/                    # Environment 核心
    │   ├── environment.ts      # Environment 接口
    │   ├── base-env.ts         # BaseEnvironment 实现
    │
    │   ├── agent/              # Agent 组件
    │   │   ├── agent.ts
    │   │   └── hooks.ts        # Agent hooks 定义
    │
    │   ├── session/            # Session 组件
    │   │   ├── session.ts
    │   │   ├── types.ts
    │   │   └── hooks.ts
    │
    │   ├── llm/                # LLM 组件
    │   │   ├── llm.ts
    │   │   ├── provider.ts
    │   │   └── hooks.ts
    │
    │   ├── tool/               # Tool 组件
    │   │   ├── tool.ts
    │   │   ├── registry.ts
    │   │   └── hooks.ts
    │
    │   ├── prompt/             # Prompt 组件
    │   │   ├── prompt.ts
    │   │   ├── renderer.ts
    │   │   └── hooks.ts
    │
    │   ├── task/               # Task 组件
    │   │   ├── task.ts
    │   │   ├── types.ts
    │   │   └── hooks.ts
    │
    │   ├── memory/             # Memory 组件
    │   │   ├── memory.ts
    │   │   ├── search.ts
    │   │   └── hooks.ts
    │
    │   ├── skill/              # Skill 组件
    │   │   ├── skill.ts
    │   │   ├── loader.ts
    │   │   └── hooks.ts
    │
    │   ├── log/                # Log 组件
    │   │   ├── logger.ts
    │   │   ├── query.ts
    │   │   └── hooks.ts
    │
    │   └── config/             # Config 组件
    │       ├── config.ts
    │       ├── source.ts
    │       └── hooks.ts
    │
    └── types/                  # 共享类型
        ├── context.ts
        ├── event.ts
        ├── action.ts
        ├── stream.ts
        └── index.ts
```

### 6.2 @roy-bot/coder (Coder Harness)

```
@roy-bot/coder
└── src/
    ├── index.ts                    # 入口导出（所有 API）
    │
    ├── lsp/                        # LSP 模块
    │   ├── client.ts               # LSP 客户端封装
    │   ├── server.ts              # LSP 服务器定义和注册表
    │   ├── manager.ts             # LSP 连接管理器
    │   └── language-map.ts        # 语言到 LSP 服务器映射
    │
    ├── plugins/                    # Plugin 模块 (Hook 扩展)
    │   ├── linter-plugin.ts       # 代码检查插件
    │   ├── type-check-plugin.ts   # 类型检查插件
    │   └── lsp-plugin.ts         # LSP 诊断信息插件
    │
    ├── type-check/                 # 类型检查模块
    │   └── manager.ts             # TypeCheck 管理器
    │
    ├── types/                      # 类型定义
    │   └── linter.ts             # 诊断信息、类型检查结果等
    │
    ├── util/                       # 工具模块
    │   └── glob.ts                # Glob 模式匹配
    │
    └── integration/               # 集成测试
        ├── tool-plugin.integration.test.ts
        └── end-to-end.integration.test.ts
```

**核心设计理念**：
- **Core 保持通用**：`@roy-bot/core` 是场景无关的核心 SDK
- **Coder Harness 专用**：`@roy-bot/coder` 通过 Hook 机制扩展编程能力
- **不重新实现工具**：复用 core 的 ToolComponent，通过 Hook 注入额外能力
- **LSP 驱动**：以 Language Server Protocol 为核心提供代码智能

**支持的 LSP 服务器：**

| 语言 | 服务器 | 扩展名 |
|------|--------|--------|
| TypeScript/JavaScript | typescript-language-server | .ts, .tsx, .js, .jsx |
| Python | pyright-langserver | .py |
| Vue | vue-language-server | .vue |
| CSS/SCSS/Less | vscode-css-language-server | .css, .scss, .less |
| HTML | vscode-html-language-server | .html |
| JSON | vscode-json-language-server | .json |

```typescript
// Coder Harness 使用示例
import { ToolComponent } from "@roy-bot/core";
import { LinterPlugin, TypeCheckPlugin } from "@roy-bot/coder";

// 创建 ToolComponent
const toolComponent = new ToolComponent();
await toolComponent.init();

// 创建 Plugins
const linterPlugin = new LinterPlugin({
  ignorePatterns: ["dist/**", "*.min.js"],
});

const typeCheckPlugin = new TypeCheckPlugin({
  supportedExtensions: [".ts", ".tsx", ".py"],
});

// 注册 Hooks（通过 ToolComponent 的 hook 机制）
toolComponent.registerHook("tool.after-execute", {
  name: linterPlugin.name,
  priority: linterPlugin.priority,
  execute: linterPlugin.onAfterTool.bind(linterPlugin),
});
```

**测试覆盖：125 tests**

| 模块 | 测试数 |
|------|--------|
| LSP Module | 59 tests |
| Plugin Module | 41 tests |
| Utils | 11 tests |
| Integration | 14 tests |
| End-to-End | 9 tests |

### 6.3 @roy-bot/cli

```
@roy-bot/cli
└── src/
    ├── cli.ts                    # 主入口
    ├── bin/                      # bin 入口
    │   └── roy-bot.ts
    │
    └── commands/                 # 子命令
        ├── act.ts                # 自然语言交互（核心）
        ├── sessions.ts
        ├── tasks.ts
        ├── prompts.ts
        ├── agents.ts
        ├── memory.ts
        ├── tools.ts
        ├── skills.ts
        ├── config.ts
        ├── logs.ts
        └── env.ts
```

---

## 7. 设计维度

### 7.1 两个设计维度

```
┌─────────────────────────────────────────────────────────────┐
│                    设计维度分析                               │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   垂直维度（Component）     水平维度（Hook）                  │
│   ─────────────────────     ─────────────────               │
│                                                             │
│   Session ──────────→      before.create                    │
│   Task ────────────→       on.statusChange                  │
│   Memory ──────────→       before.write                     │
│   Config ──────────→       on.change                        │
│   Agent ───────────→       before.run / before.llm / ...    │
│   ...                       ...                              │
│                                                             │
│   按功能/模块划分          按执行流程/时机划分                 │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 7.2 Component vs Hook

| 概念 | 说明 | 解决的问题 |
|------|------|-----------|
| **Component** | 功能单元 | "有什么" - 模块化管理 |
| **Hook** | 扩展点 | "怎么做" - 切面扩展 |

---

## 8. CLI 子命令设计

### 8.1 全局参数

| 参数 | 简写 | 说明 |
|------|------|------|
| `--help` | `-h` | 显示帮助 |
| `--version` | `-v` | 显示版本 |
| `--capabilities` | `-c` | 显示能力列表（JSON） |
| `--quiet` | `-q` | 安静模式 |
| `--json` | `-j` | JSON 格式输出 |

### 8.2 子命令列表

| 命令 | 操作 | 说明 |
|------|------|------|
| `act` | - | 自然语言交互（核心命令） |
| `sessions` | list/read/grep/compact/keywords/title/delete/export | 会话管理 |
| `tasks` | list/get/create/update/complete/delete | 任务管理 |
| `prompts` | list/get/set/variables/render | 提示词管理 |
| `agents` | list/info/spec/skills/history | 智能体管理 |
| `memory` | list/search/read/write/delete | 记忆管理 |
| `tools` | list/info/categories/register/unregister | 工具管理 |
| `skills` | list/info/load/reload/unload | 技能管理 |
| `config` | list/get/set/reset/sources | 配置管理 |
| `logs` | query/tail/stats | 日志查询 |
| `env` | info/status/stats/profiles | 环境信息 |

---

## 9. 相关文档

- [智能化OS设计理念](./intelligent-os-design.md) - 设计理念和核心概念

---

## 10. 更新记录

| 日期 | 版本 | 说明 |
|------|------|------|
| 2026-03-25 | v0.1.0 | 初始版本 |
| 2026-03-25 | v0.2.0 | 引入 Component + Hook 设计 |
