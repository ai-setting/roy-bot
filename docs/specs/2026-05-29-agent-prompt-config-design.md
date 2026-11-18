# Agent/Prompt 配置管理功能设计文档

> 日期：2026-05-29
> 状态：设计阶段

## 1. 概述

本功能为 Roy Agent 添加 Agent 和 Prompt 的配置管理能力，包括：

1. `roy-bot config list` 支持 prompt component 配置展示
2. `roy-bot prompt` 命令（add, get）
3. AgentComponent 持久化管理（agent config folder）
4. `roy-bot agents` 命令（list, get）
5. delegateTask 支持自定义 agent 配置

## 2. 设计决策

| 决策项 | 选择 |
|--------|------|
| Agent 配置存储格式 | YAML |
| System Prompt 引用方式 | 支持 `systemPromptRef`（引用 PromptComponent）和 `systemPrompt`（inline），优先 Ref |
| Agent Config Folder 位置 | XDG data 路径（`~/.local/share/roy-bot/agents/`），可通过配置覆盖 |
| delegateTask agent 选择 | 统一用 `subagent_type`，优先从 config folder 查找，找不到则回退到内置 |

## 3. 功能详细设计

### 3.1 Prompt Component 配置展示

**文件**：`packages/cli/src/commands/config/types.ts`

扩展 `SUPPORTED_COMPONENTS` 和 `COMPONENT_DESCRIPTIONS`：

```typescript
export const SUPPORTED_COMPONENTS = [
  // ...existing
  "prompt",
  // ...new
] as const;

export const COMPONENT_DESCRIPTIONS: Record<string, string> = {
  // ...existing
  prompt: "Prompt 管理 - 内置和外部 prompts",
  // ...new
};
```

**输出示例**：
```
# Prompt Component 配置

路径：
  - 数据目录: ~/.local/share/roy-bot
  - 配置目录: ~/.config/roy-bot

Prompts:
  - 内置: 5 个
  - 外部: 2 个
  - 默认 prompt: default

配置源：
  - prompt.defaultName: default (默认)
  - prompt.promptPaths: (未配置)

外部 Prompts 路径：
  - (空)
```

### 3.2 roy-bot prompt 命令

**文件**：`packages/cli/src/commands/prompt/`

```
roy-bot prompt list                    # 列出所有 prompts
roy-bot prompt get <name>             # 获取 prompt 内容
roy-bot prompt add <name> <content>   # 添加 prompt
roy-bot prompt get-builtin            # 获取内置 prompt 列表
```

#### 3.2.1 prompt list

```bash
roy-bot prompt list

# 输出
Available prompts:
  - default              (built-in)     内置默认 prompt
  - agent/general        (built-in)     General subagent prompt
  - subagent/explore     (directory)    从 ./prompts 加载
  - my-custom-prompt     (file)         从文件加载
```

#### 3.2.2 prompt get

```bash
roy-bot prompt get default
roy-bot prompt get subagent/explore

# 支持变量渲染
roy-bot prompt get default --var workspace_dir=/home/user

# JSON 格式输出
roy-bot prompt get default --json
```

#### 3.2.3 prompt add

```bash
# 从 stdin 添加
echo "You are a {{role}} agent" | roy-bot prompt add custom-role --stdin

# 从文件添加
roy-bot prompt add my-prompt --file ./prompts/my-prompt.md

# 直接添加
roy-bot prompt add my-prompt "You are a custom agent"
```

#### 3.2.4 prompt get-builtin

```bash
roy-bot prompt get-builtin

# 输出
Built-in prompts:
  - default              默认主 Agent prompt
  - subagent/general     General subagent prompt
  - session/compact      Session compact prompt
```

### 3.3 AgentComponent 持久化管理

**文件**：`packages/core/src/env/agent/agent-registry.ts`（新建）

#### 3.3.1 Agent 配置格式

```yaml
# ~/.local/share/roy-bot/agents/explore.yaml
name: explore
type: sub
description: Fast agent specialized for exploring codebases
systemPromptRef: subagent/explore  # 引用 PromptComponent
# 或
systemPrompt: |
  You are an explore agent...
allowedTools:
  - glob
  - grep
  - read
  - bash
deniedTools:
  - delegate_task
  - stop_task
```

#### 3.3.2 AgentRegistry 类

```typescript
export interface AgentDefinition {
  name: string;
  type: "primary" | "sub";
  description?: string;
  systemPromptRef?: string;  // 引用 PromptComponent
  systemPrompt?: string;     // inline prompt
  model?: string;
  maxIterations?: number;
  allowedTools?: string[];
  deniedTools?: string[];
}

export class AgentRegistry {
  private agents: Map<string, AgentDefinition> = new Map();
  
  constructor(options: {
    configComponent: ConfigComponent;
    promptComponent: PromptComponent;
  });
  
  // 加载内置 + 外部 agent configs
  async load(): Promise<void>;
  
  // 获取 agent 定义
  get(name: string): AgentDefinition | undefined;
  
  // 列出所有 agent
  list(): AgentDefinition[];
  
  // 注册 agent（运行时）
  register(agent: AgentDefinition): void;
  
  // 注销 agent（运行时）
  unregister(name: string): boolean;
  
  // 获取 system prompt（解析 Ref 或 inline）
  async getSystemPrompt(name: string): Promise<string>;
  
  // 获取配置文件夹路径
  getConfigDir(): string;
}
```

#### 3.3.3 AgentComponent 集成

```typescript
export class AgentComponent {
  private registry: AgentRegistry;
  
  async init(config: ComponentConfig): Promise<void> {
    // 初始化 AgentRegistry
    this.registry = new AgentRegistry({
      configComponent: this.configComponent!,
      promptComponent: this.env.getComponent("prompt"),
    });
    
    // 加载 agent configs
    await this.registry.load();
  }
  
  // 新增方法：从 registry 获取 agent
  getAgentFromRegistry(name: string): AgentDefinition | undefined {
    return this.registry.get(name);
  }
  
  listAgentsFromRegistry(): AgentDefinition[] {
    return this.registry.list();
  }
}
```

#### 3.3.4 配置项

```typescript
// agent-config-registration.ts
export const AGENT_CONFIG_REGISTRATION: ComponentRegistration = {
  name: "agent",
  sources: [
    { type: "env", envPrefix: "AGENT", priority: 20, watch: false },
  ],
  keys: [
    // ...existing
    { key: "agent.configDir", sources: ["env", "file"] },  // 新增
  ],
};

export const AGENT_DEFAULTS: Record<string, unknown> = {
  // ...existing
  "agent.configDir": "",  // 空 = 使用 XDG data/roy-bot/agents
};
```

### 3.4 roy-bot agents 命令

**文件**：`packages/cli/src/commands/agents/`（新建）

```
roy-bot agents list                 # 列出所有 agents
roy-bot agents get <name>          # 获取 agent 配置
roy-bot agents add <name>          # 添加 agent（交互式）
roy-bot agents delete <name>        # 删除 agent
roy-bot agents config-dir           # 显示配置目录
```

#### 3.4.1 agents list

```bash
roy-bot agents list

# 输出
Registered Agents (2):
  [Primary]
  - default                     内置主 Agent

  [SubAgents]
  - general                     内置通用 subagent
  - explore                     自定义 (~/agents/explore.yaml)
  - my-web-agent                自定义 (~/agents/my-web-agent.yaml)

Agent Config Directory:
  ~/.local/share/roy-bot/agents
```

#### 3.4.2 agents get

```bash
roy-bot agents get explore

# 输出
Name: explore
Type: sub
Description: Fast agent specialized for exploring codebases
Source: ~/agents/explore.yaml

System Prompt:
  (引用 PromptComponent: subagent/explore)

Allowed Tools:
  - glob
  - grep
  - read
  - bash

Denied Tools:
  - delegate_task
  - stop_task
```

#### 3.4.3 agents add

```bash
roy-bot agents add my-agent

# 交互式输入
? Name: my-agent
? Type: (sub/primary)
? Description: My custom agent
? System Prompt (Ref or inline): subagent/my-prompt
? Allowed tools (comma separated): glob, grep
? Denied tools (comma separated): delegate_task, stop_task

# 生成配置文件
# ~/.local/share/roy-bot/agents/my-agent.yaml
```

#### 3.4.4 agents delete

```bash
roy-bot agents delete explore

# 确认
? Delete agent 'explore'? This will remove ~/agents/explore.yaml
  (Y/n)

# 输出
✓ Agent 'explore' deleted
```

#### 3.4.5 agents config-dir

```bash
roy-bot agents config-dir

# 输出
Agent Config Directory: ~/.local/share/roy-bot/agents
```

### 3.5 delegateTask 集成

**文件**：`packages/core/src/env/task/delegate/delegate-tool.ts`

> **注**：自 2026-06 起，delegateTask 只支持后台模式。`handleSyncTask` 已移除，`background` 参数已废弃。

#### 3.5.1 修改逻辑

```typescript
async function handleSyncTask(...) {
  // 1. 优先从 AgentRegistry 查找
  const agentComponent = (taskComponent as any).env?.getComponent?.("agent");
  const registry = agentComponent?.registry;
  
  let agentDef: AgentDefinition | undefined;
  let systemPrompt: string;
  
  if (registry) {
    agentDef = registry.get(subagentType);
  }
  
  if (agentDef) {
    // 使用 AgentRegistry 中的配置
    if (agentDef.systemPromptRef) {
      // 引用 PromptComponent
      const promptComponent = (taskComponent as any).env?.getComponent?.("prompt");
      systemPrompt = await promptComponent.get(agentDef.systemPromptRef) 
        || agentDef.systemPrompt 
        || DEFAULT_SUBAGENT_PROMPT;
    } else {
      systemPrompt = agentDef.systemPrompt || DEFAULT_SUBAGENT_PROMPT;
    }
  } else {
    // 回退到内置 builtInSubAgents
    const subAgent = getSubAgentSpec(subagentType);
    systemPrompt = subAgent?.promptOverride || DEFAULT_SUBAGENT_PROMPT;
  }
  
  // 2. 构建 full prompt
  // ...existing logic
}
```

#### 3.5.2 工具描述更新

```typescript
// 动态生成 agent 列表
function getAgentToolDescription(): string {
  const builtIn = builtInSubAgents.map(
    (agent) => `- ${agent.id}: ${agent.description}`
  ).join("\n");
  
  // 从 registry 获取自定义 agent
  const custom = registry?.list().map(
    (agent) => `- ${agent.name}: ${agent.description || "Custom agent"}`
  ).join("\n") || "";
  
  return `Available agent types:\n${builtIn}\n${custom ? "\nCustom agents:\n" + custom : ""}`;
}
```

## 4. 文件结构

```
packages/
├── core/src/env/
│   ├── agent/
│   │   ├── agent-registry.ts      # 新增：AgentRegistry 类
│   │   ├── agent-config-registration.ts  # 修改：添加 configDir 配置
│   │   └── agent-component.ts      # 修改：集成 AgentRegistry
│   └── prompt/
│       └── prompt-component.ts      # 可能需要添加一些方法
│
└── cli/src/commands/
    ├── config/
    │   ├── types.ts                # 修改：添加 prompt component
    │   └── list.ts                 # 修改：支持 prompt component
    │
    ├── prompt/                     # 新增目录
    │   ├── index.ts                # 命令入口
    │   ├── list.ts                 # prompt list
    │   ├── get.ts                  # prompt get
    │   ├── add.ts                  # prompt add
    │   └── get-builtin.ts          # prompt get-builtin
    │
    └── agents/                    # 新增目录
        ├── index.ts                # 命令入口
        ├── list.ts                 # agents list
        ├── get.ts                  # agents get
        ├── add.ts                  # agents add
        ├── delete.ts               # agents delete
        └── config-dir.ts           # agents config-dir
```

## 5. 测试策略

### 5.1 单元测试

| 文件 | 测试内容 |
|------|----------|
| `agent-registry.test.ts` | load, get, list, register, unregister |
| `prompt/commands.test.ts` | list, get, add 命令 |
| `agents/commands.test.ts` | list, get, add, delete 命令 |

### 5.2 集成测试

| 文件 | 测试内容 |
|------|----------|
| `delegate-task-agent-config.integration.test.ts` | delegateTask 读取自定义 agent |

## 6. 依赖关系

```
Feature 实现顺序：
1. AgentRegistry 类（核心）
2. AgentComponent 集成
3. agents 命令
4. prompt 命令
5. config list prompt 支持
6. delegateTask 集成
```

## 7. 向后兼容性

- 内置 `builtInSubAgents` 保持不变
- delegateTask 的 `subagent_type` 参数保持不变
- 现有 `subagent_type: "general"` 仍然有效
