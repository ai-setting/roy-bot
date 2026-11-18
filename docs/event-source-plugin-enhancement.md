# EventSource Plugin 增强方案

> 版本: v6
> 更新时间: 2026-05-19

## 1. 概述

### 1.1 设计目标

在 EventSource 配置中添加 `handleRule` 配置项，实现：
- 事件源产生的事件可以指定使用哪个 agent 处理
- Plugin hooks 按需启用机制
- 支持第三方应用（如 `ai-agent-bounty`）的自定义插件
- Hook context 中包含完整 event 信息，用于实现 reply 等功能

### 1.2 核心设计思路

| 设计要点 | 说明 |
|----------|------|
| **Plugin 加载** | 由 EventSourceInstance 自己负责加载 plugins |
| **Hooks 注册** | 注册到 globalHookManager，携带 pluginName 和 sourceId |
| **按需启用** | 通过 `ctx.metadata.pluginEnabled` 控制 hook 是否执行 |
| **无需 reset** | pluginEnabled 只在当前 hook 执行上下文中有效 |

### 1.3 配置示例

#### 现有配置结构（部分支持）

```json
{
  "version": "1.0.0",
  "sources": [
    {
      "id": "es-lark-1",
      "name": "飞书消息监听",
      "type": "lark-cli",
      "enabled": true,
      "command": "lark-cli event +subscribe",
      "plugins": ["task-tag"]  // 现有字段
    }
  ]
}
```

#### 设计目标配置结构

```json
// ~/.roy-bot/event-sources.json
{
  "version": "1.0.0",
  "sources": [
    {
      "id": "es-lark-1",
      "name": "飞书消息监听",
      "type": "lark-cli",
      "enabled": true,
      "command": "lark-cli event +subscribe",
      "handleRule": {           // 新增嵌套结构
        "agent": "lark-agent",  // 处理事件的 agent
        "plugins": ["task-tag"] // 启用的 plugins
      }
    },
    {
      "id": "es-bounty-1",
      "name": "Bounty IM 监听",
      "type": "bounty-im",
      "enabled": true,
      "address": "agent-1@localhost",
      "handleRule": {
        "agent": "default",
        "plugins": ["bounty-plugin"]
      }
    }
  ]
}
```

#### 迁移说明

| 现有字段 | 迁移到 | 说明 |
|----------|--------|------|
| `plugins` | `handleRule.plugins` | 平铺字段迁移到嵌套结构 |
| `handleRule.agent` | 新增 | 指定处理 agent，无则用 default |

## 2. 配置结构

### 2.1 HandleRuleConfig

```typescript
// packages/core/src/env/event-source/types.ts

export interface HandleRuleConfig {
  /** 处理事件的 agent 名称（可选，默认使用 default） */
  agent?: string;
  
  /** 启用的插件列表（可选） */
  plugins?: string[];
}

export interface EventSourceConfig {
  // ... 现有字段 ...
  
  /** 事件处理规则 */
  handleRule?: HandleRuleConfig;
}
```

## 3. 类型定义

### 3.1 AgentContext 扩展

```typescript
// packages/core/src/env/agent/types.ts

export interface AgentContext {
  // ... 现有字段 ...
  
  /** 处理事件的 agent 名称 */
  agentName?: string;
  
  /** 启用的插件列表 */
  plugins?: string[];
  
  /** 关联的 EnvEvent */
  envEvent?: EnvEvent;
  
  /** Plugin 启用标记 { "sourceId:pluginName": true } */
  pluginEnabled?: Record<string, boolean>;
}
```

### 3.2 EnvEventMetadata 扩展

```typescript
// packages/core/src/env/types.ts

export interface EnvEventMetadata {
  source?: string;
  sourceId?: string;
  replyChannel?: ReplyChannel;
  plugins?: string[];
  [key: string]: unknown;
}
```

## 4. 核心机制

### 4.1 Hook 注册

```typescript
// Hook 注册时携带 plugin 信息
globalHookManager.register(hookPoint, {
  name: `${plugin.name}:${hook.point}`,
  priority: hook.priority ?? 0,
  pluginName: plugin.name,
  sourceId: this.config.id,
  execute: async (ctx) => {
    await plugin.execute(ctx);
  },
});
```

### 4.2 Hook 执行时检查

```typescript
// globalHookManager.execute 执行时检查
async execute(hookPoint: string, ctx: HookContext, metadata: Record<string, unknown> = {}): Promise<void> {
  const hooks = this._hooks.get(hookPoint);
  if (!hooks) return;
  
  const sortedHooks = this.sortHooks(hooks);
  const pluginEnabled = metadata.pluginEnabled || {};

  for (const hook of sortedHooks) {
    // 检查 pluginEnabled 是否启用
    const key = `${hook.sourceId}:${hook.pluginName}`;
    if (pluginEnabled[key] !== true) continue;
    
    await this.safeExecute(hook, ctx);
  }
}
```

## 5. Plugin 加载机制

### 5.1 EventSourceInstance 基类

```typescript
// packages/core/src/env/event-source/event-source-instance-base.ts

export class BaseEventSourceInstance implements EventSourceInstance {
  protected config: EventSourceConfig;
  protected plugins: any[] = [];
  
  constructor(config: EventSourceConfig) {
    this.config = config;
  }
  
  async start(): Promise<void> {
    await this.loadPlugins();
    await this.startListening();
  }
  
  protected async loadPlugins(): Promise<void> {
    const plugins = this.config.handleRule?.plugins || [];
    
    for (const pluginName of plugins) {
      const plugin = await this.importPlugin(pluginName);
      if (plugin) {
        this.plugins.push(plugin);
        this.registerPluginHooks(plugin);
      }
    }
  }
  
  protected async importPlugin(name: string): Promise<any> {
    const PLUGIN_PATHS: Record<string, string> = {
      "task-tag": "@ai-setting/roy-bot-core/env/task/plugins/task-tag-plugin",
    };
    
    const path = PLUGIN_PATHS[name] || name;
    
    try {
      const module = await import(path);
      const PluginClass = module.TaskPlugin || module.default;
      return new PluginClass();
    } catch (error) {
      console.error(`[ESInstance] Failed to load plugin ${name}:`, error);
      return null;
    }
  }
  
  protected registerPluginHooks(plugin: any): void {
    for (const hook of plugin.hooks) {
      globalHookManager.register(hook.point, {
        name: `${plugin.name}:${hook.point}`,
        priority: hook.priority ?? 0,
        pluginName: plugin.name,
        sourceId: this.config.id,
        execute: async (ctx) => {
          await plugin.execute(ctx);
        },
      });
    }
  }
}
```

## 6. 完整数据流

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Plugin Hook 按需启用流程                                 │
└─────────────────────────────────────────────────────────────────────────────┘

[阶段1: EventSourceInstance 初始化]
─────────────────────────────────────────────────────────────
[1] ES.startSource("es-lark-1")
    │
    │ 读取配置:
    │   handleRule = { agent: "lark-agent", plugins: ["task-tag"] }
    │
    ▼
[2] LarkCliInstance.loadPlugins()
    │
    │ 动态 import task-tag-plugin
    │
    ▼
[3] for (const hook of plugin.hooks) {
       globalHookManager.register(hook.point, {
         name: `${plugin.name}:${hook.point}`,
         priority: hook.priority ?? 0,
         pluginName: plugin.name,  // "task-tag"
         sourceId: this.config.id,  // "es-lark-1"
         execute: async (ctx) => { ... },
       });
     }

[阶段2: 事件产生]
─────────────────────────────────────────────────────────────
[4] LarkCliInstance 收到飞书消息
    │
    ▼
[5] pushEnvEvent({
       type: "event-source.event.es-lark-1",
       metadata: {
         source: "event-source",
         sourceId: "es-lark-1",
         replyChannel: {...},
         plugins: ["task-tag"],
       },
       payload: {
         sourceId: "es-lark-1",
         message: "...",
         rawEvent: {...}
       }
     })

[阶段3: CLI EventHandler 处理]
─────────────────────────────────────────────────────────────
[6] EventHandler.receive(envEvent)
    │
    │ 格式化消息
    │
    ▼
[7] enqueue(EventMessage { envEvent, message })
    │
    ▼

[阶段4: REPL 处理事件 + 构建 pluginEnabled]
─────────────────────────────────────────────────────────────
[8] REPL.handleEventMessage(eventMessage)
    │
    │ 提取 sourceId = "es-lark-1"
    │ 读取 ES 配置: handleRule.plugins = ["task-tag"]
    │
    ▼
[9] 构建 context.pluginEnabled
     │
     │ pluginEnabled = {
     │   "es-lark-1:task-tag": true
     │ }
     │
     ▼
[10] 构建 QueryHandleContext
     │
     │ context = {
     │   agentName: "lark-agent",
     │   plugins: ["task-tag"],
     │   envEvent: <完整 EnvEvent>,
     │   pluginEnabled: {
     │     "es-lark-1:task-tag": true
     │   }
     │ }
     │
     ▼

[阶段5: handle_query 执行]
─────────────────────────────────────────────────────────────
[11] env.handle_query(message, context)
     │
     ▼
[12] AgentComponent.run(agentName, query, context)
     │
     │ 创建 HookContext
     │
     ▼
[13] 执行 ReAct 循环
     │
     │ executePluginHooks(agent, point, hookCtx)
     │
     ▼
[14] Hook 执行检查
     │
     │ 2. globalHookManager.execute(point, hookCtx, metadata)
     │
     │ metadata = {
     │   pluginEnabled: context.pluginEnabled,
     │   envEvent: context.envEvent
     │ }
     │
     ▼
[15] globalHookManager.execute() 检查
     │
     │ for (const hook of sortedHooks) {
     │   
     │   // 通过 pluginName + sourceId 匹配
     │   const key = hook.sourceId + ":" + hook.pluginName;
     │   if (metadata.pluginEnabled[key] !== true) continue;
     │   
     │   await hook.execute(ctx);
     │ }
     │
     ▼

[阶段6: 完成处理]
─────────────────────────────────────────────────────────────
[16] handle_query 返回结果
    │
    │ 检查 context.envEvent.metadata.replyChannel
    │ 发送回复
    │
    ▼
```

## 7. 关键代码

### 7.1 AgentComponent.executePluginHooks() 集成 globalHookManager

```typescript
// packages/core/src/env/agent/agent-component.ts

private async executePluginHooks(
  agent: AgentInstance,
  point: HookPoint,
  ctx: HookContext
): Promise<void> {
  // === 1. 执行 Agent 自己的 plugins ===
  const agentHooks: Array<{ plugin: Plugin; priority: number; execute: Function }> = [];
  
  for (const [name, plugin] of agent.plugins) {
    for (const hook of plugin.hooks) {
      if (hook.point === point) {
        agentHooks.push({
          plugin,
          priority: hook.priority ?? 0,
          execute: plugin.execute,
        });
      }
    }
  }
  
  agentHooks.sort((a, b) => b.priority - a.priority);
  for (const { plugin, execute } of agentHooks) {
    await this.executeAgentPlugin(plugin, execute, point, ctx);
  }
  
  // === 2. 执行 globalHookManager 中的 ES hooks ===
  const metadata: Record<string, unknown> = {
    pluginEnabled: ctx.context?.pluginEnabled,
    envEvent: ctx.context?.envEvent,
  };
  
  await globalHookManager.execute(point, ctx, metadata);
}

private async executeAgentPlugin(
  plugin: Plugin,
  execute: Function,
  point: HookPoint,
  ctx: HookContext
): Promise<void> {
  try {
    if (ctx.context?.envEvent) {
      ctx.envEvent = ctx.context.envEvent;
    }
    
    const result = await execute(ctx);
    if (!result.continue) {
      ctx._stopped = true;
      ctx._stopReason = `Plugin ${plugin.name} stopped execution`;
    }
  } catch (error) {
    logger.error(`Hook ${point} error in plugin ${plugin.name}`, { error });
  }
}
```

### 7.2 HookContext 扩展

```typescript
// packages/core/src/env/agent/types.ts

export interface HookContext {
  agent: AgentInstance;
  iteration: number;
  maxIterations: number;
  messages: ModelMessage[];
  tools: Tool[];
  systemPrompt: string;
  context: AgentContext;  // 包含 envEvent, pluginEnabled
  
  envEvent?: EnvEvent;
  // ... 其他字段
}
```

### 7.3 REPL 构建 pluginEnabled

```typescript
// packages/cli/src/commands/run.ts

async handleEventMessage(eventMessage: EventMessage): Promise<void> {
  const { envEvent, message } = eventMessage;
  
  const sourceId = envEvent.metadata?.sourceId;
  const esConfig = eventSourceComponent.get(sourceId);
  const handleRule = esConfig?.handleRule || {};
  const plugins = handleRule.plugins || [];
  
  // 构建 pluginEnabled
  const pluginEnabled: Record<string, boolean> = {};
  for (const pluginName of plugins) {
    const key = `${sourceId}:${pluginName}`;
    pluginEnabled[key] = true;
  }
  
  const context: QueryHandleContext = {
    agentName: handleRule.agent || "default",
    plugins,
    envEvent,
    pluginEnabled,
  };
  
  await this.executeInternal(message, { showPrompt: true }, context);
}
```

### 7.4 Reply 处理

```typescript
// packages/cli/src/commands/shared/query-executor.ts

async execute(
  message: string,
  sessionId: string,
  options?: any,
  traceId?: string,
  context?: QueryHandleContext
): Promise<string> {
  const result = await this.env.handle_query(message, context);
  
  const replyChannel = context?.envEvent?.metadata?.replyChannel;
  if (replyChannel) {
    await this.sendReply(replyChannel, result);
  }
  
  return result;
}
```

## 8. 第三方扩展机制

```
ai-agent-bounty
│
├── 定义自己的 EventSourceHandler (bounty-im)
├── 定义自己的 Plugin (bounty-plugin)
│   └── hooks: [agent:before.llm, ...]
│
└── 在 ES 配置中指定:
    "plugins": ["bounty-plugin"]  // 或 "@ai-agent-bounty/plugin"
```

## 9. 实现步骤（带状态）

### Step 1: 定义 HandleRuleConfig 并扩展 EventSourceConfig ✅

```typescript
// packages/core/src/env/event-source/types.ts

```typescript
// packages/core/src/env/event-source/types.ts

/**
 * HandleRuleConfig
 * 
 * 事件处理规则配置
 */
export interface HandleRuleConfig {
  /** 处理事件的 agent 名称（可选，默认使用 default） */
  agent?: string;
  
  /** 启用的插件列表（可选） */
  plugins?: string[];
}

/**
 * EventSourceConfig 扩展
 */
export interface EventSourceConfig {
  // ... 现有字段 ...
  
  /** 事件处理规则 */
  handleRule?: HandleRuleConfig;
}
```

### Step 2: 扩展 EnvEventMetadata

```typescript
// packages/core/src/env/types.ts

export interface EnvEventMetadata {
  /** 现有字段保持不变 */
  
  /** 事件来源：固定为 "event-source" */
  source?: "event-source";
  
  /** 事件源 ID */
  sourceId?: string;
  
  /** 反馈通道 */
  replyChannel?: ReplyChannel;
  
  /** 启用的插件列表 */
  plugins?: string[];
  
  [key: string]: unknown;
}
```

### Step 3: 扩展 AgentContext 添加 pluginEnabled 和 envEvent

```typescript
// packages/core/src/env/agent/types.ts

export interface AgentContext {
  // ... 现有字段 ...
  
  /** 处理事件的 agent 名称 */
  agentName?: string;
  
  /** 启用的插件列表 */
  plugins?: string[];
  
  /** 关联的 EnvEvent */
  envEvent?: EnvEvent;
  
  /** Plugin 启用标记 { "sourceId:pluginName": true } */
  pluginEnabled?: Record<string, boolean>;
}
```

### Step 4: Hook 接口添加 pluginName 和 sourceId

```typescript
// packages/core/src/env/hook/types.ts

export interface Hook<T = unknown> extends HookMeta {
  /** Hook 唯一名称 */
  name: string;
  /** 执行优先级，默认 0，数值越小越先执行 */
  priority?: number;
  /** 描述 */
  description?: string;
  
  // === 新增字段（用于 EventSource Plugin） ===
  /** Plugin 名称（EventSource 加载的 plugin） */
  pluginName?: string;
  /** 事件源 ID（EventSource 加载的 plugin） */
  sourceId?: string;
  
  /** 执行 Hook */
  execute(ctx: HookContext<T>): void | Promise<void>;
}
```

### Step 5: HookManager.execute() 支持 pluginEnabled 检查

```typescript
// packages/core/src/env/hook/hook-manager.ts

async execute(
  hookPoint: string,
  data: T,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  const hooks = this._hooks.get(hookPoint);
  if (!hooks || hooks.length === 0) return;

  const sortedHooks = this.sortHooks(hooks);
  const ctx = this.createContext(hookPoint, data, metadata, "before");
  
  // 获取 pluginEnabled 配置
  const pluginEnabled = metadata.pluginEnabled || {};

  for (const hook of sortedHooks) {
    // === 新增：检查 pluginEnabled ===
    if (hook.pluginName && hook.sourceId) {
      const key = `${hook.sourceId}:${hook.pluginName}`;
      if (pluginEnabled[key] !== true) {
        // 该 plugin 未启用，跳过执行
        continue;
      }
    }
    
    await this.safeExecute(hook, ctx);
  }
}
```

### Step 6: EventSourceInstance 实现 Plugin 加载

```typescript
// packages/core/src/env/event-source/event-source-handlers.ts

import { globalHookManager } from "../hook/global-hook-manager";
import type { ReplyChannel } from "./types";

class LarkCliInstance implements EventSourceInstance {
  private config: EventSourceConfig;
  private status: EventSourceStatus = "created";
  private plugins: any[] = [];
  
  // ... 现有代码 ...

  async start(): Promise<void> {
    if (this.status === "running") return;
    
    // === 加载 plugins ===
    await this.loadPlugins();
    
    // ... 启动逻辑 ...
  }
  
  async stop(): Promise<void> {
    // ... 停止逻辑 ...
    
    // === 卸载 plugins ===
    this.unloadPlugins();
  }
  
  protected async loadPlugins(): Promise<void> {
    const plugins = this.config.handleRule?.plugins || [];
    
    for (const pluginName of plugins) {
      const plugin = await this.importPlugin(pluginName);
      if (plugin) {
        this.plugins.push(plugin);
        this.registerPluginHooks(plugin);
      }
    }
  }
  
  protected async importPlugin(name: string): Promise<any> {
    // Plugin 路径映射
    const PLUGIN_PATHS: Record<string, string> = {
      "task-tag": "@ai-setting/roy-bot-core/env/task/plugins/task-tag-plugin",
    };
    
    const path = PLUGIN_PATHS[name] || name;
    
    try {
      const module = await import(path);
      const PluginClass = module.TaskPlugin || module.default;
      return new PluginClass();
    } catch (error) {
      console.error(`[LarkCliInstance] Failed to load plugin ${name}:`, error);
      return null;
    }
  }
  
  protected registerPluginHooks(plugin: any): void {
    for (const hook of plugin.hooks) {
      globalHookManager.register(hook.point, {
        name: `${plugin.name}:${hook.point}`,
        priority: hook.priority ?? 0,
        pluginName: plugin.name,
        sourceId: this.config.id,
        execute: async (ctx) => {
          await plugin.execute(ctx);
        },
      });
    }
  }
  
  protected unloadPlugins(): void {
    for (const plugin of this.plugins) {
      for (const hook of plugin.hooks) {
        globalHookManager.unregister(
          hook.point,
          `${plugin.name}:${hook.point}`
        );
      }
    }
    this.plugins = [];
  }
}
```

### Step 7: AgentComponent.executePluginHooks() 集成 globalHookManager

```typescript
// packages/core/src/env/agent/agent-component.ts

private async executePluginHooks(
  agent: AgentInstance,
  point: HookPoint,
  ctx: HookContext
): Promise<void> {
  // === 1. 执行 Agent 自己的 plugins ===
  const agentHooks: Array<{ plugin: Plugin; priority: number; execute: Function }> = [];
  
  for (const [name, plugin] of agent.plugins) {
    for (const hook of plugin.hooks) {
      if (hook.point === point) {
        agentHooks.push({
          plugin,
          priority: hook.priority ?? 0,
          execute: plugin.execute,
        });
      }
    }
  }
  
  agentHooks.sort((a, b) => b.priority - a.priority);
  for (const { plugin, execute } of agentHooks) {
    await this.executeAgentPlugin(plugin, execute, point, ctx);
  }
  
  // === 2. 执行 globalHookManager 中的 ES hooks ===
  const metadata: Record<string, unknown> = {
    pluginEnabled: ctx.context?.pluginEnabled,
    envEvent: ctx.context?.envEvent,
  };
  
  await globalHookManager.execute(point, ctx, metadata);
}
```

### Step 8: REPL 构建 pluginEnabled

```typescript
// packages/cli/src/commands/run.ts

async handleEventMessage(eventMessage: EventMessage): Promise<void> {
  const { envEvent, message } = eventMessage;
  
  const sourceId = envEvent.metadata?.sourceId;
  const esConfig = eventSourceComponent.get(sourceId);
  const handleRule = esConfig?.handleRule || {};
  const plugins = handleRule.plugins || [];
  
  // 构建 pluginEnabled
  const pluginEnabled: Record<string, boolean> = {};
  for (const pluginName of plugins) {
    const key = `${sourceId}:${pluginName}`;
    pluginEnabled[key] = true;
  }
  
  const context: QueryHandleContext = {
    agentName: handleRule.agent || "default",
    plugins,
    envEvent,
    pluginEnabled,
  };
  
  await this.executeInternal(message, { showPrompt: true }, context);
}
```

### Step 9: Reply 处理逻辑

```typescript
// packages/cli/src/commands/shared/query-executor.ts

async execute(
  message: string,
  sessionId: string,
  options?: any,
  traceId?: string,
  context?: QueryHandleContext
): Promise<string> {
  const result = await this.env.handle_query(message, context);
  
  const replyChannel = context?.envEvent?.metadata?.replyChannel;
  if (replyChannel) {
    await this.sendReply(replyChannel, result);
  }
  
  return result;
}
```

### Step 10: 第三方扩展示例

```typescript
// ai-agent-bounty 包中定义自己的 Handler

export const BountyIMHandler: EventSourceHandler = {
  type: "bounty-im",
  validateConfig: (config) => {
    const errors = [];
    if (!config.address) errors.push("address is required for bounty-im");
    return errors;
  },
  createInstance: (config) => new BountyIMInstance(config),
};

// 注册到 EventSourceInitHooks
EventSourceInitHooks.register("bounty-im", async (component) => {
  component.registerHandler(BountyIMHandler);
});
```

---

## 10. 实现步骤（带状态）

| Step | 内容 | 文件 | 状态 | 说明 |
|------|------|------|------|------|
| 1 | 定义 `HandleRuleConfig` | types.ts | ✅ DONE | 已定义 HandleRuleConfig 和 EventSourceConfig.handleRule |
| 2 | `EnvEventMetadata` 添加 `sourceId`, `replyChannel`, `plugins` | types.ts | ✅ DONE | 已添加扩展字段 |
| 3 | `AgentContext` 添加 `agentName`, `plugins`, `envEvent`, `pluginEnabled` | agent/types.ts | ✅ DONE | 已添加 EventSource 扩展字段 |
| 4 | `Hook` 添加 `pluginName`, `sourceId` | hook/types.ts | ✅ DONE | 已在 HookMeta 中添加字段 |
| 5 | `HookManager.execute()` 检查 pluginEnabled | hook-manager.ts | ✅ DONE | 已实现 pluginEnabled 检查逻辑 |
| 6 | `LarkCliInstance` 实现 plugin 加载/卸载 | event-source-handlers.ts | ✅ DONE | 已实现 loadPlugins/importPlugin/registerPluginHooks/unloadPlugins |
| 7 | `AgentComponent.executePluginHooks()` 集成 globalHookManager | agent-component.ts | ✅ DONE | 已实现：先执行 agent.plugins，再执行 globalHookManager.execute() |
| 8 | `REPL` 构建 pluginEnabled | interactive.ts | ✅ DONE | EventHandler 支持 onEventWithEnv，REPL.handleEventMessageWithEnv() 构建 pluginEnabled |
| 9 | Reply 处理逻辑 | query-executor.ts | ⚠️ TODO | 需实现 replyChannel 回复逻辑 |
| 10 | 更新 TimerInstance/WebSocketInstance | event-source-handlers.ts | ⚠️ TODO | 复用 LarkCliInstance 模式 |

## 10. 待确认问题

1. **插件卸载** - ES stop 时是否需要卸载已注册的 hooks？
2. **pluginEnabled 传递** - 是否需要传递到每个 hook point 的 metadata？

## 11. 代码对比分析

### 11.1 设计 vs 现有实现差距

| 设计要求 | 现有实现 | 差距 |
|----------|----------|------|
| `HandleRuleConfig` | 无 | ❌ 缺失 |
| `EventSourceConfig.handleRule` | 有 `plugins` 但无 `agent` | ⚠️ 部分实现 |
| `AgentContext.pluginEnabled` | 无 | ❌ 缺失 |
| `AgentContext.envEvent` | 无 | ❌ 缺失 |
| `Hook.pluginName/sourceId` | 无 | ❌ 缺失 |
| `HookManager.execute()` 检查 | 无 | ❌ 缺失 |
| ES Instance plugin 加载 | 无 | ❌ 缺失 |
| `executePluginHooks()` 集成 | 只执行 agent.plugins | ⚠️ 需扩展 |

### 11.2 现有类型复用情况

| 类型 | 现有定义 | 位置 |
|------|----------|------|
| `EventSourceConfig.plugins` | ✅ 已存在 | types.ts |
| `ReplyChannel` | ✅ 已存在 | types.ts |
| `EventMetadata` | ✅ 已存在 | types.ts |
| `EnvEventMetadata` | ✅ 已存在，但缺 `sourceId`, `replyChannel` | env/types.ts |
| `EnvEvent` | ✅ 已存在 | env/types.ts |

---

## 12. 现有机制适配分析

### 12.1 三类 Hook 机制对比

| 机制 | 使用场景 | Hook 点 | 注册方式 | 执行方式 |
|------|----------|---------|----------|----------|
| **Agent Hooks** | ReAct 循环扩展 | `agent:before.llm`, `agent:after.tool` 等 | `agent.plugins` 注册 | `AgentComponent.executePluginHooks()` |
| **Task Hooks** | Task 操作扩展 | `task:before.create`, `task:delegate:before` 等 | `TaskComponent.registerPlugin()` | `globalHookManager.execute()` |
| **Prompt Hooks** | Prompt 后处理 | `prompt:before.render`, `prompt:after-render` | `globalHookManager.register()` | `PromptComponent.render()` |
| **ES Hooks** (设计) | EventSource 扩展 | 与 Agent/Task 相同 | ES Instance 加载时注册 | `globalHookManager.execute()` + pluginEnabled 检查 |

### 12.2 三类 Plugin 机制对比

| 机制 | 定义位置 | 注册方式 | 执行方式 | 典型用例 |
|------|----------|----------|----------|----------|
| **Task Plugin** | `core/src/env/task/plugins/` | `TaskComponent.registerPlugin()` | `globalHookManager.execute()` | task-tag-plugin |
| **LSP Plugin** | `coder-harness/src/lsp/plugins/` | `LSPPluginRegistry` | LSP Server 内联 | tslsp-plugin, pylsp-plugin |
| **CLI Plugin** | `cli/src/plugin/` | `PluginRegistry` | CLI 命令 + Component | bounty-plugin |

### 12.3 Task Plugin 机制详解

```typescript
// TaskComponent.registerPlugin() 实现
// packages/core/src/env/task/task-component.ts

registerPlugin(plugin: TaskPlugin): void {
  // 1. 保存 plugin 引用
  this.plugins.set(plugin.name, plugin);
  
  // 2. 注入组件引用
  plugin.setComponents?.(llmComponent, this);
  
  // 3. 自动注册依赖的 Agents
  const getRequiredAgents = (plugin.constructor as any).getRequiredAgents;
  if (typeof getRequiredAgents === 'function') {
    agentComponent.registerAgent(agentConfig);
  }
  
  // 4. 注册 Hook 到 globalHookManager
  for (const hook of plugin.hooks) {
    globalHookManager.register(hook.point, {
      name: `${this.name}:${plugin.name}:${hook.point}`,
      priority: hook.priority ?? 0,
      execute: async (ctx) => {
        // 包装 ctx 并调用 plugin.execute()
        await pluginRef.execute(pluginCtx);
      },
    });
  }
}
```

**关键点**：
- TaskPlugin hooks 注册时**不带** `pluginName`/`sourceId`
- 通过命名约定 `task:task-tag:hook-point` 区分
- **全局有效**：一旦注册，所有事件都会触发（除非有 pluginEnabled 机制）

### 12.4 Prompt Hook 机制详解

```typescript
// ai-agent-bounty/src/cli/hooks/bounty-prompt-hook.ts

const bountyPromptHook = {
  name: 'bounty-prompt-hook',
  priority: 100,
  async execute(ctx) {
    const hookContext = ctx.data;  // PromptHookContext
    if (hookContext.name !== 'default') return;
    hookContext.renderedContent += BOUNTY_CAPABILITIES;
  },
};

// 注册到全局
globalHookManager.register('prompt.after-render', bountyPromptHook);
```

**关键点**：
- Prompt hooks 通过 `prompt.after-render` 或 `prompt:before.render` 触发
- 由 `PromptComponent.render()` 调用 `globalHookManager.execute()`
- **全局有效**：一旦注册，所有 prompt 渲染都会触发

### 12.5 LSP Plugin 机制详解

```typescript
// coder-harness/src/lsp/plugins/registry.ts

class LSPPluginRegistry {
  private factories: Map<string, factory>;
  
  registerFactory(id: string, factory: (config) => LanguageLSPPlugin): void {
    this.factories.set(id, factory);
  }
  
  getOrCreate(id: string, config?): LanguageLSPPlugin | undefined {
    if (this.plugins.has(id)) return this.plugins.get(id);
    const factory = this.factories.get(id);
    if (factory) {
      const plugin = factory(config);
      this.plugins.set(plugin.name, plugin);
      return plugin;
    }
  }
}
```

**关键点**：
- LSP Plugin 是语言服务插件，与 Agent Hook 系统**无关**
- 通过 LSP 协议与编辑器集成
- 两种注册方式：内置工厂 + 第三方 `registerFactory()`

### 12.6 CLI Plugin 机制详解

```typescript
// packages/cli/src/plugin/types.ts

interface RoyCliPlugin {
  info: PluginInfo;
  getCommands?(): PluginCommandDefinition[];
  getComponents?(): PluginComponentDefinition[];
  getComponentPlugins?(): ComponentPluginDefinition[];
  onBeforeInit?(ctx): void;
  onAfterInit?(ctx): void;
}

// bounty-plugin 示例
export const bountyPlugin: RoyCliPlugin = {
  info: { name: "bounty", version: "1.0.0" },
  getCommands() { return [registerAgentCommands, bountyTaskCommands]; },
  getComponentPlugins() { /* 暂未使用 */ },
};
```

**关键点**：
- CLI Plugin 通过 `getComponentPlugins()` 提供 Component 扩展
- `getRequiredAgents()` 自动注册依赖的 Agents
- 与 Hook 系统**独立**，但通过 `ComponentPluginInstance` 间接使用 Hook

### 12.7 EventSource Handler 机制详解

```typescript
// ai-agent-bounty/src/im/eventsource/bounty-im-handler.ts

export const bountyIMHandler: EventSourceHandler = {
  type: "bounty-im",
  validateConfig: (config) => { /* ... */ },
  createInstance: (config) => new BountyIMInstance(config),
};

// 通过 EventSourceInitHooks 自动注册
EventSourceInitHooks.register("bounty-im", async (component) => {
  component.registerHandler(bountyIMHandler);
});
```

**关键点**：
- EventSourceHandler 通过 `EventSourceInitHooks` 注册
- 每个 Instance 处理一个配置
- **当前无 Plugin 加载机制**（这是设计要补充的）

### 12.8 适配变更清单

#### 12.8.1 TaskPlugin 机制适配

| 变更点 | 当前 | 设计 | 说明 |
|--------|------|------|------|
| Hook 注册 | 不带 pluginName/sourceId | 携带 pluginName/sourceId | 与 ES Hook 统一 |
| Hook 执行 | 直接执行 | 通过 pluginEnabled 检查 | 需修改 HookManager.execute() |

#### 12.8.2 PromptHook 适配

| 变更点 | 当前 | 设计 | 说明 |
|--------|------|------|------|
| Hook 注册 | 不带 pluginName/sourceId | 携带 pluginName/sourceId | 需支持 prompt hook 按需启用 |
| 执行检查 | 无 | 通过 pluginEnabled 检查 | 可选，建议支持 |

#### 12.8.3 LSP Plugin 适配

| 变更点 | 当前 | 设计 | 说明 |
|--------|------|------|------|
| 插件注册 | LSPPluginRegistry | 不变 | LSP Plugin 与本设计无关 |
| 依赖声明 | 静态 | 不变 | 不涉及 Hook 系统 |

#### 12.8.4 CLI Plugin 适配

| 变更点 | 当前 | 设计 | 说明 |
|--------|------|------|------|
| ComponentPlugin | 通过 getComponentPlugins | 不变 | 继续使用 TaskComponent.registerPlugin() |
| getRequiredAgents | 自动注册 | 不变 | Hook 机制与 Agent 注册分离 |
| Bounty PromptHook | 直接 register | 改为 handleRule.plugins | 可选，保持兼容 |

#### 12.8.5 EventSource Handler 适配

| 变更点 | 当前 | 设计 | 说明 |
|--------|------|------|------|
| BountyIMHandler | 无 Plugin 加载 | 支持 handleRule.plugins | 核心新增 |
| EnvEvent 推送 | 手动推送 | 自动包含 metadata | 补充 replyChannel 等 |

---

## 13. Changelog

### v10 (2026-05-19) - 已实现
- **Step 8 完成**: EventHandler 支持 onEventWithEnv，REPL.handleEventMessageWithEnv() 构建 pluginEnabled
- **修改文件**: 
  - `event-message-formatter.ts`: 添加 formatWithEvent() 方法和 FormattedEvent 类型
  - `event-handler.ts`: 支持 onEventWithEnv 回调，队列改为 QueueItem[]
  - `interactive.ts`: REPL 支持 currentAgentContext，handleEventMessageWithEnv() 构建 pluginEnabled
  - `query-executor.ts`: execute() 支持 agentContext 参数
- **测试通过**: 93 tests pass

### v9 (2026-05-19) - 已实现
- **Step 1-7 已完成**: HandleRuleConfig、EnvEventMetadata、AgentContext、Hook接口、HookManager.execute()、LarkCliInstance plugin加载、AgentComponent.executePluginHooks() 集成
- **TDD 测试**: 为 HookManager.execute() 添加 4 个 pluginEnabled 检查测试，全部通过
- **测试通过**: AgentComponent 52 tests pass, EventSource 64 tests pass

### v8 (2026-05-19)
- **增加现有机制适配分析**: Task Plugin、Prompt Hook、LSP Plugin、CLI Plugin、EventSource Handler
- **明确各机制关系**: Hook 注册方式、执行方式、典型用例
- **补充适配变更清单**: 各机制需要配合的变更点

### v7 (2026-05-19)
- **增加实现细节**: 补充 Step 1-10 详细代码示例
- **增加代码对比分析**: 明确设计与实现的差距
- **更新实现步骤表**: 10 个步骤带详细说明

### v6 (2026-05-19)
- **简化设计**: 移除 enabled 标记和 hookEnabled
- **pluginEnabled**: 通过 `sourceId:pluginName` 键值对控制 hook 是否执行
- **无需 reset**: pluginEnabled 只在当前 hook 执行上下文中有效

### v5 (2026-05-19)
- 移除 EventInfo，直接使用 EnvEvent 传递事件信息

### v4 (2026-05-19)
- Plugin 加载改由 EventSourceInstance 负责
- 移除 PluginRegistry，直接利用 globalHookManager

### v3 (2026-05-19)
- 统一 agent 和 plugins 到 handleRule 配置项

### v2 (2026-05-19)
- 增加 EnvEventMetadata.replyChannel 字段

### v1 (2026-05-19)
- 初始设计版本
