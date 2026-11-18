# 智能化操作系统设计理念

## 1. 核心理念

智能化操作系统（Intelligent OS / tong-env）是智能体（Agent）的运行时环境，灵感来自传统操作系统和 Linux/Unix 设计哲学。

### 1.1 设计类比

| 传统操作系统 | 智能化操作系统 | 说明 |
|-------------|----------------|------|
| Shell (bash/zsh) | `act` 命令 | 自然语言交互入口 |
| 文件系统 | Memory 模块 | 持久化存储 |
| 进程管理 | Agent Component | 任务执行单元 |
| 系统调用 | Tool Component | 能力扩展 |
| 管道 (Pipe) | 嵌套调用 | 环境间协作 |
| man/help | `--help` | 渐进式探索 |

### 1.2 四大核心理念

```
┌─────────────────────────────────────────────────────────────┐
│                     智能化操作系统四大理念                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   1. 自然语言交互                                             │
│      "通过自然语言驱动整个操作系统"                              │
│      roy-bot act "帮我完成代码审查"                           │
│                                                             │
│   2. 渐进式探索                                              │
│      "不带参数时显示帮助，智能体可通过 --help 自我学习"           │
│      roy-bot --help                                        │
│      roy-bot --capabilities                                │
│                                                             │
│   3. 统一入口                                                │
│      "类似 shell/bash，智能体只需知道一个入口"                   │
│      roy-bot &lt;any-command&gt;                                 │
│                                                             │
│   4. 嵌套调用                                                │
│      "支持环境间相互调用"                                      │
│      roy-bot env1 act "调用 env2"                          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. 核心概念：Component

### 2.1 Component = 系统的基本单元

**Component** 是整个系统最基本的功能单元，是设计与实现的核心抽象。

```
┌─────────────────────────────────────────────────────────────┐
│                   Component = 系统的基本单元                    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   每一个核心能力都是一个 Component：                           │
│   - AgentComponent (智能体执行)                              │
│   - SessionComponent (会话管理)                              │
│   - TaskComponent (任务管理)                                │
│   - MemoryComponent (记忆存储)                              │
│   - ConfigComponent (配置中心)                              │
│   - ...                                                     │
│                                                             │
│   每个 Component 包含：                                     │
│   - 数据和状态                                               │
│   - 方法（CRUD 等操作）                                      │
│   - Hooks（扩展点）                                         │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Component 与 Opencode Plugin

| Opencode 概念 | roy-bot 概念 | 说明 |
|---------------|----------------|------|
| Plugin | Component | 功能单元 |
| Plugin.hooks | Component.hooks (HookManager) | 扩展点 |
| Hook: chat.message | AgentComponent.registerHook("before.start", ...) | 消息处理 |
| Hook: chat.params | AgentComponent.registerHook("before.llm", ...) | 参数调整 |
| Hook: tool.execute.before | AgentComponent.registerHook("before.tool", ...) | 工具执行前 |
| Hook: tool.execute.after | AgentComponent.registerHook("after.tool", ...) | 工具执行后 |

**关键理解：**
- Opencode 的 Plugin 是一种切面扩展模式
- roy-bot 将 Plugin 的 Hooks 机制内化为 Component 的扩展点
- AgentComponent 是 opencode "Agent 运行时" 对应的 Component

---

## 3. Hook 机制

### 3.1 Hook = Component 的扩展点

每个 Component 可以定义自己的 Hooks，作为该组件的扩展点：

```
┌─────────────────────────────────────────────────────────────┐
│                      Hook 机制                               │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   Component                                                  │
│   ├── 数据/状态                                             │
│   ├── 方法                                                  │
│   └── hooks: {                                             │
│         "before.xxx": [Hook1, Hook2],                      │
│         "after.xxx": [Hook3],                             │
│     }                                                      │
│                                                             │
│   Hook = {                                                 │
│     name: string,                                          │
│     before?: (input, output) =&gt; Promise&lt;void&gt;,            │
│     after?: (input, output) =&gt; Promise&lt;void&gt;,             │
│   }                                                        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 AgentComponent 的 Hooks

AgentComponent 是核心运行时组件，其 Hooks 与 Opencode Plugin 对应：

```typescript
// Hook 点定义（来自 agent/types.ts）
type HookPoint =
  | "before.start"      // Agent 开始执行前
  | "before.llm"        // 调用 LLM 前
  | "after.llm"          // 调用 LLM 后
  | "before.tool"        // 执行工具前
  | "after.tool"         // 执行工具后
  | "on.iteration"       // 每次迭代后
  | "on.threshold"       // 达到阈值时
  | "after.complete"    // 执行完成后
  | "on.error";          // 发生错误时

// Hook 注册示例
agentComp.registerHook("before.start", {
  name: "my-plugin",
  priority: 10,
  execute: async (ctx) => {
    console.log("Before agent start, iteration:", ctx.data.iteration);
  }
});
```

### 3.3 其他 Component 的 Hooks

```
ToolComponent.hookPoints = {
  "tool.before-execute": [],    // 工具执行前
  "tool.after-execute": [],     // 工具执行后
  "tool.before-register": [],   // 工具注册前
  "tool.after-register": [],    // 工具注册后
};

PromptComponent.hookPoints = {
  "prompt.before-render": [],   // Prompt 渲染前
  "prompt.after-render": [],    // Prompt 渲染后
};

SessionComponent.hookPoints = {
  "before.session.create": [],   // 创建会话前
  "after.session.create": [],   // 创建会话后
  "before.session.get": [],     // 获取会话前
  "after.session.get": [],      // 获取会话后
  "before.session.list": [],    // 列出会话前
  "after.session.list": [],     // 列出会话后
  "before.session.update": [],  // 更新会话前
  "after.session.update": [],   // 更新会话后
  "before.session.delete": [],  // 删除会话前
  "after.session.delete": [],   // 删除会话后
};

LLMComponent.hookPoints = {
  "before.invoke": [],   // LLM 调用前
  "after.invoke": [],    // LLM 调用后
};
```

---

## 4. 核心组件

### 4.1 组件全景

```
┌─────────────────────────────────────────────────────────────┐
│                      Environment                              │
│              (智能化操作系统核心抽象)                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   components: Map&lt;name, Component&gt;                          │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐  │
│   │                   Component (基类)                     │  │
│   │   - name, version                                    │  │
│   │   - init(), start(), stop()                          │  │
│   │   - hookManager: HookManager                        │  │
│   │     - register(hookPoint, hook)                      │  │
│   │     - execute(hookPoint, data)                       │  │
│   └─────────────────────────────────────────────────────┘  │
│                           │                                  │
│         ┌─────────────────┼─────────────────┐             │
│         ↓                 ↓                 ↓               │
│   ┌──────────┐     ┌──────────┐     ┌──────────┐        │
│   │  Agent   │     │ Session  │     │   Task   │        │
│   │Component │     │Component │     │Component │        │
│   │ (核心)   │     │          │     │          │        │
│   │hooks:    │     │hooks:    │     │hooks:    │        │
│   │run/llm  │     │create   │     │status   │        │
│   │/tool    │     │/compact │     │/assign  │        │
│   └──────────┘     └──────────┘     └──────────┘        │
│         │                 │                 │               │
│         ↓                 ↓                 ↓               │
│   ┌──────────┐     ┌──────────┐     ┌──────────┐        │
│   │  Memory  │     │  Config  │     │  Skill   │        │
│   │Component │     │Component │     │Component │        │
│   │hooks:    │     │hooks:    │     │hooks:    │        │
│   │write     │     │set/      │     │load/     │        │
│   │/search   │     │change    │     │unload    │        │
│   └──────────┘     └──────────┘     └──────────┘        │
│                                                             │
│   ┌──────────┐     ┌──────────┐                        │
│   │   LLM    │     │   Log   │                         │
│   │Component │     │Component │                        │
│   └──────────┘     └──────────┘                        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 组件职责

| 组件 | 职责 | Hooks |
|------|------|-------|
| **Agent** | 智能体执行、LLM 调用、工具编排 | before.start, before.llm, after.llm, before.tool, after.tool, on.iteration, on.threshold, after.complete, on.error |
| **Session** | 会话生命周期、消息历史 | before.session.create, after.session.create, before.session.get, after.session.get, before.session.list, after.session.list, before.session.update, after.session.update, before.session.delete, after.session.delete |
| **LLM** | 语言模型调用、多 Provider、流式事件、Token 统计 | before.invoke, after.invoke |
| **Tool** | 工具注册、参数验证 | tool.before-execute, tool.after-execute, tool.before-register, tool.after-register |
| **Task** | 任务 CRUD、状态流转 | before.create, on.statusChange, on.assign |
| **Memory** | 记忆存储、搜索 | before.write, before.search |
| **Config** | 配置中心、变更通知 | before.set, on.change |
| **Prompt** | 提示词存储、变量替换 | prompt.before-render, prompt.after-render |
| **Skill** | 技能加载、热插拔 | before.load, after.load |
| **Log** | 日志写入、查询 | before.write, before.query |

---

## 5. Environment 抽象

### 5.1 设计思想

**Environment = Component 的容器 + 编排者**

- Environment 只负责组件管理和核心调度
- 其他能力（LLM、工具、会话等）归属到对应 Component
- Component 之间通过 Environment 协作
- 通过 Hooks 实现切面扩展

### 5.2 设计原则

```
┌─────────────────────────────────────────────────────────────┐
│                 Environment 职责                            │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   ✓ 组件管理（注册、获取、列表）                            │
│   ✓ 核心调度（handle_query、handle_action）                 │
│   ✓ 流式处理（subscribe/unsubscribe）                      │
│                                                             │
│   ✗ 其他能力（归属到 Component）                           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 分层架构

```
┌─────────────────────────────────────────────────────────────┐
│                      CLI Layer                              │
│              (用户交互层: act, sessions, tasks...)            │
├─────────────────────────────────────────────────────────────┤
│                    Environment Layer                        │
│         (核心抽象层: Environment, BaseEnvironment)          │
│                    Component Layer                          │
│    (组件层: Agent, Session, Task, Memory, Config...)     │
├─────────────────────────────────────────────────────────────┤
│                     Core SDK Layer                          │
│              (@roy-bot/core 场景无关)                       │
├─────────────────────────────────────────────────────────────┤
│                  Harness Layer (可选)                        │
│         (@roy-bot/coder 编程场景 Plugin 扩展)              │
└─────────────────────────────────────────────────────────────┘
```

### 5.3 环境类型

```
BaseEnvironment (抽象基类)
    │
    ├── CoderHarness (@roy-bot/coder 编程环境)
    │       ├── LSP 模块 (LSPClient, LSPServer, LSPManager)
    │       ├── Plugins: LinterPlugin, TypeCheckPlugin, LSPPlugin
    │       └── 扩展 ToolComponent 的 Hook 点
    │
    ├── ServerEnv (服务器环境)
    │       └── MCP, 外部工具, 网络...
    │
    └── CustomEnv (自定义环境)
            └── 领域特定扩展
```

**核心设计理念**：
- `BaseEnvironment` 保持通用，专注于 Component 管理和核心调度
- 特定场景通过 **Hook 机制** 扩展，而非修改核心
- `@roy-bot/coder` 复用 core 的 ToolComponent，通过 Hook 注入编程能力（LSP、Lint、TypeCheck）

### 5.4 Coder Harness (@roy-bot/coder)

Coder Harness 是编程场景专用扩展，通过 LSP 提供代码智能能力：

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Coder Harness 架构                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  @roy-bot/core                                                       │
│      │                                                                 │
│      └──► ToolComponent                                                 │
│              │                                                         │
│              └──► tool.after-execute Hook 点                            │
│                      │                                                 │
│              ┌───────┼───────┐                                       │
│              ↓               ↓                                       │
│      LinterPlugin   TypeCheckPlugin   LSPPlugin                       │
│      (代码检查)      (类型检查)       (诊断信息)                       │
│              │               │                                       │
│              └───────┬───────┘                                       │
│                      ↓                                                 │
│              LSPManager                                                │
│              │                                                         │
│              ├──► typescript-language-server                           │
│              ├──► pyright-langserver                                  │
│              ├──► vue-language-server                                  │
│              └──► vscode-css-language-server                          │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**使用示例：**

```typescript
import { ToolComponent } from "@roy-bot/core";
import { LinterPlugin, TypeCheckPlugin } from "@roy-bot/coder";

// 创建 ToolComponent
const toolComponent = new ToolComponent();
await toolComponent.init();

// 创建并注册 Plugins
const linterPlugin = new LinterPlugin({
  ignorePatterns: ["dist/**", "*.min.js"],
});

const typeCheckPlugin = new TypeCheckPlugin({
  supportedExtensions: [".ts", ".tsx", ".py"],
});

// 注册 Hooks
toolComponent.registerHook("tool.after-execute", {
  name: linterPlugin.name,
  priority: linterPlugin.priority,
  execute: linterPlugin.onAfterTool.bind(linterPlugin),
});
```

**测试覆盖：125 tests（全部通过）**

---

## 6. CLI 设计

### 6.1 类 Unix 设计

| Unix | 智能化 OS | 示例 |
|------|----------|------|
| `ls` | `sessions list` | 列出所有会话 |
| `cat` | `sessions read` | 读取会话 |
| `grep` | `sessions grep` | 搜索会话 |
| `man` | `--help` | 获取帮助 |
| `which` | `--capabilities` | 列出能力 |
| `pipe` | `嵌套调用` | 环境间协作 |

### 6.2 默认行为

```bash
# 不带任何参数 → 显示帮助
roy-bot

# 等价于
roy-bot --help
```

---

## 7. 渐进式探索

### 7.1 帮助层级

```
Level 1: 默认帮助 (roy-bot)
         └── 显示命令概览

Level 2: 全局帮助 (roy-bot --help)
         └── 显示详细命令列表

Level 3: 子命令帮助 (roy-bot sessions --help)
         └── 显示子命令操作

Level 4: 操作帮助 (roy-bot sessions compact --help)
         └── 显示操作详情
```

### 7.2 能力发现

```bash
# 查看所有能力
roy-bot --capabilities

# 输出示例
{
  "commands": ["sessions", "tasks", "prompts", ...],
  "components": ["agent", "session", "task", ...],
  "version": "1.0.0"
}
```

---

## 8. 自然语言交互

### 8.1 act 命令

```bash
roy-bot act [options] [prompt]
```

**设计理念：**
- **直接执行**：直接使用 AgentComponent 能力
- **流式输出**：实时显示 AI 响应
- **统一入口**：用自然语言描述需求，系统自动分解执行
- **上下文保持**：支持多轮对话

### 8.2 使用模式

```bash
# 模式 1: 单次执行
roy-bot act "帮我列出所有任务"

# 模式 2: 交互式对话
roy-bot act

# 模式 3: 继续会话
roy-bot act -S ses_xxx
```

---

## 9. 嵌套调用

### 9.1 环境间协作

```
┌─────────────────────────────────────────────────────────────┐
│                    roy-bot                                 │
│                                                             │
│   ┌──────────────┐          ┌──────────────┐               │
│   │   Env A     │ ─────── │   Env B     │               │
│   │ (Data OS)   │  调用     │ (Code OS)   │               │
│   └──────────────┘          └──────────────┘               │
│          │                          │                       │
│          └──────────┬───────────────┘                       │
│                      │                                       │
│              roy-bot act                                  │
│              "让 Data OS 分析数据，                            │
│               然后让 Code OS 生成代码"                         │
└─────────────────────────────────────────────────────────────┘
```

---

## 10. 设计维度

### 10.1 两个设计维度

```
┌─────────────────────────────────────────────────────────────┐
│                    设计维度分析                               │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   垂直维度（Component）     水平维度（Hook）                  │
│   ─────────────────────     ─────────────────               │
│                                                             │
│   Agent ────────────────→   before.run / before.llm / ...  │
│   Session ──────────────→   before.create / after.create   │
│   Task ─────────────────→   on.statusChange / on.assign     │
│   Memory ───────────────→   before.write / before.search   │
│   Config ───────────────→   on.change / before.set         │
│   ...                       ...                              │
│                                                             │
│   按功能/模块划分          按执行流程/时机划分                 │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 10.2 Component vs Hook

| 概念 | 说明 | 解决的问题 |
|------|------|-----------|
| **Component** | 功能单元，有数据有状态 | 模块化管理 |
| **Hook** | 扩展点，在特定时机插入逻辑 | 切面扩展 |

---

## 11. 设计原则总结

```
┌─────────────────────────────────────────────────────────────┐
│                      设计原则                                │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   ✓ 单一入口原则                                             │
│     智能体只需知道 roy-bot 一个入口                          │
│                                                             │
│   ✓ 渐进式透明原则                                            │
│     通过 --help 和 --capabilities 自我探索                    │
│                                                             │
│   ✓ 统一接口原则                                              │
│     所有组件通过 Environment 统一访问                         │
│                                                             │
│   ✓ 可组合原则                                               │
│     环境可以嵌套调用，协同工作                                 │
│                                                             │
│   ✓ Hook 扩展原则                                            │
│     每个 Component 通过 Hooks 支持切面扩展                     │
│                                                             │
│   ✓ 类 Unix 哲学                                             │
│     简单、一致、可组合                                        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 12. 相关文档

- [架构设计文档](./architecture-design.md) - 包结构和组件详情
