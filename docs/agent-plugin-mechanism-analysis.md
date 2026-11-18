# Agent Component 注册机制分析

## 1. 核心组件结构

### 1.1 目录结构
```
packages/core/src/env/agent/
├── types.ts                  # 类型定义（Plugin、HookContext、AgentInstance）
├── agent-component.ts        # 核心实现（registerPlugin/unregisterPlugin）
├── agent-config-registration.ts  # 配置注册
├── summary-agent.ts          # Summary Agent
└── index.ts                  # 导出
```

## 2. Plugin 注册机制

### 2.1 Plugin 接口定义（types.ts）
```typescript
export interface Plugin {
  name: string;                    // Plugin 唯一名称
  version: string;                // Plugin 版本
  description?: string;           // 描述
  hooks: Array<{
    point: HookPoint;             // Hook 点
    priority?: number;            // 优先级（默认0，数字越大越先执行）
  }>;
  execute: (ctx: HookContext) => HookResult | Promise<HookResult>;
}
```

### 2.2 AgentInstance 结构
```typescript
export interface AgentInstance {
  name: string;                   // Agent 名称
  config: Required<AgentInstanceConfig>;  // 配置
  status: AgentStatus;            // 状态：idle | running | paused | stopped | error
  plugins: Map<string, Plugin>;   // 注册的 Plugins
}
```

### 2.3 registerPlugin 实现（agent-component.ts:625-636）
```typescript
registerPlugin(agentName: string, plugin: Plugin): void {
  const agent = this.agents.get(agentName);
  if (!agent) {
    throw new Error(`Agent not found: ${agentName}`);
  }
  agent.plugins.set(plugin.name, plugin);
  logger.info(`Plugin registered: ${plugin.name} to ${agentName}`, {
    hooks: plugin.hooks.map(h => h.point),
  });
}
```

### 2.4 unregisterPlugin 实现（agent-component.ts:640-652）
```typescript
unregisterPlugin(agentName: string, pluginName: string): boolean {
  const agent = this.agents.get(agentName);
  if (!agent) {
    return false;
  }
  const deleted = agent.plugins.delete(pluginName);
  if (deleted) {
    logger.info(`Plugin unregistered: ${pluginName} from ${agentName}`);
  }
  return deleted;
}
```

## 3. Hook 系统架构

### 3.1 Hook 点枚举
```typescript
export type HookPoint =
  | "agent:before.start"      // Agent 开始执行前
  | "agent:before.llm"        // 调用 LLM 前
  | "agent:after.llm"         // 调用 LLM 后
  | "agent:before.tool"        // 执行工具前
  | "agent:after.tool"         // 执行工具后
  | "agent:on.iteration"       // 每次迭代后
  | "agent:on.threshold"       // 达到阈值时
  | "agent:after.complete"     // 执行完成后
  | "agent:on.error"           // 发生错误时
  | "agent:after.react"        // React 循环结束后
  | "on.error";               // 简化写法（兼容）
```

### 3.2 HookContext 结构
```typescript
export interface HookContext {
  // Hook 点特定字段
  llmOutput?: AgentLLMOutput;           // after.llm hook 可用
  currentToolCall?: ToolCall;          // before/after.tool hook 可用
  toolResult?: ToolCallResult;          // after.tool hook 可用
  threshold?: { type: string; value: number; limit?: number; };
  error?: Error;                       // on.error hook 可用
  
  // Agent 运行时状态
  agent: AgentInstance;
  iteration: number;
  maxIterations: number;
  messages: ModelMessage[];
  tools: Tool[];
  systemPrompt: string;
  context: AgentContext;               // 执行上下文
  
  // 内部状态
  _stopped?: boolean;                  // 是否已停止
  _stopReason?: string;                // 停止原因
  _pendingAction?: { type: HookActionType; payload?: unknown; };
  _errors?: Array<{ plugin: string; error: string; }>;
}
```

### 3.3 Hook 干预动作
```typescript
export type HookActionType =
  | "stop"             // 停止执行
  | "retry"            // 重试当前迭代
  | "compress"         // 执行压缩
  | "extract_memory"   // 提取记忆
  | "inject_message"   // 注入消息
  | "skip_tool";      // 跳过当前工具调用
```

## 4. Plugin 与 Hook 的关系

### 4.1 双层 Hook 执行架构
```
┌─────────────────────────────────────────────────────────────────┐
│                  AgentComponent.executePluginHooks()             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Layer 1: Agent 自己的 plugins（高优先级）                        │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  agent.plugins (Map<string, Plugin>)                      │   │
│  │  └── 按 priority 排序后执行                                │   │
│  │      └── 可修改 HookContext、设置 _stopped、干预执行       │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
│                              ▼                                   │
│  Layer 2: EventSource hooks（通过 globalHookManager）             │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  globalHookManager (全局单例)                             │   │
│  │  └── 根据 pluginEnabled 配置选择性执行                     │   │
│  │      └── { "sourceId:pluginName": true } 格式检查         │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 executePluginHooks 实现（agent-component.ts:1552-1607）
```typescript
private async executePluginHooks(
  agent: AgentInstance,
  point: HookPoint,
  ctx: HookContext
): Promise<void> {
  // === Layer 1: 执行 Agent 自己的 plugins ===
  const hooks: Array<{ plugin: Plugin; priority: number; execute: Function }> = [];
  
  for (const [name, plugin] of agent.plugins) {
    for (const hook of plugin.hooks) {
      if (hook.point === point) {
        hooks.push({
          plugin,
          priority: hook.priority ?? 0,
          execute: plugin.execute,
        });
      }
    }
  }

  hooks.sort((a, b) => b.priority - a.priority);

  for (const { plugin, execute } of hooks) {
    try {
      const result = await execute(ctx);
      if (!result.continue) {
        ctx._stopped = true;
        break;
      }
      if (result.action) {
        await this.handleHookAction(result.action, ctx);
      }
    } catch (error) {
      ctx._errors = ctx._errors || [];
      ctx._errors.push({ plugin: plugin.name, error: error.message });
    }
  }

  // === Layer 2: 执行 globalHookManager 中的 EventSource hooks ===
  const metadata: Record<string, unknown> = {
    pluginEnabled: ctx.context?.pluginEnabled,
    envEvent: ctx.context?.envEvent,
  };
  await globalHookManager.execute(point, ctx, metadata);
}
```

## 5. 架构图

### 5.1 AgentComponent 整体架构
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           AgentComponent                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────────────┐ │
│  │   agents        │    │  defaultTools   │    │     config              │ │
│  │  Map<name,      │    │     Tool[]      │    │  AgentComponentConfig   │ │
│  │   AgentInstance>│    └─────────────────┘    └─────────────────────────┘ │
│  │                 │                                                          │
│  │  ┌───────────┐  │    ┌─────────────────┐                                  │
│  │  │ name      │  │    │ toolComponent   │                                  │
│  │  │ config    │  │    │ llmComponent    │                                  │
│  │  │ status    │◀─┼────│ sessionComponent│                                  │
│  │  │ plugins   │  │    │ configComponent │                                  │
│  │  │  ↓        │  │    └─────────────────┘                                  │
│  │  │ Map<name, │  │                                                          │
│  │  │  Plugin>  │  │                                                          │
│  │  └───────────┘  │                                                          │
│  └─────────────────┘                                                          │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                       核心方法                                            │ │
│  │  registerPlugin(agentName, plugin)                                       │ │
│  │  unregisterPlugin(agentName, pluginName)                                 │ │
│  │  getAgent(name) → AgentInstance                                          │ │
│  │  registerAgent(name, config) → AgentInstance                            │ │
│  │  run(agentName, input, context) → AgentRunResult                        │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 5.2 ReAct 执行循环中的 Hook 调用
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        ReAct 执行循环                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│     ┌────────────────────────────────────────────────────────────────┐      │
│     │                     Hook: agent:before.start                   │      │
│     └────────────────────────────────────────────────────────────────┘      │
│                                    │                                         │
│                                    ▼                                         │
│  ┌──────────────────────┐     ┌──────────────┐     ┌─────────────────────┐  │
│  │  1. THINK            │────▶│  2. LLM Call │────▶│  Hook: before.llm   │  │
│  │  (Reasoning)         │     │              │     │  Hook: after.llm    │  │
│  └──────────────────────┘     └──────────────┘     └─────────────────────┘  │
│                                    │                      │                   │
│                                    │    ┌─────────────────┘                   │
│                                    ▼    ▼                                    │
│     ┌────────────────────────────────────────────────────────────────┐      │
│     │              3. ACT (工具调用)                                  │      │
│     │  ┌──────────────────┐    ┌────────────────────────────────┐  │      │
│     │  │ Hook: before.tool │    │ Hook: after.tool               │  │      │
│     │  └──────────────────┘    └────────────────────────────────┘  │      │
│     └────────────────────────────────────────────────────────────────┘      │
│                                    │                                         │
│                                    ▼                                         │
│     ┌────────────────────────────────────────────────────────────────┐      │
│     │                     Hook: agent:on.iteration                   │      │
│     └────────────────────────────────────────────────────────────────┘      │
│                                    │                                         │
│                       ┌────────────┴────────────┐                           │
│                       │                         │                           │
│                       ▼                         ▼                           │
│              ┌────────────────┐          ┌───────────────┐                   │
│              │  未达到阈值     │          │  达到阈值     │                   │
│              │  继续循环       │          │ Hook: on.threshold │
│              └────────────────┘          └───────────────┘                   │
│                                                                              │
│                                    │                                         │
│                                    ▼                                         │
│     ┌────────────────────────────────────────────────────────────────┐      │
│     │                     Hook: agent:after.complete                 │      │
│     │                     Hook: agent:after.react                   │      │
│     └────────────────────────────────────────────────────────────────┘      │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 6. 关键设计要点

### 6.1 Plugin 注册特点
1. **按 Agent 隔离**：每个 AgentInstance 有独立的 `plugins: Map<string, Plugin>`
2. **动态注册**：支持运行时 `registerPlugin()` / `unregisterPlugin()`
3. **强校验**：注册到不存在的 Agent 会抛出错误

### 6.2 Hook 执行特点
1. **双层执行**：Agent plugins 先执行 → globalHookManager 后执行
2. **优先级排序**：按 `priority` 降序执行（数字越大越先）
3. **干预机制**：可通过返回 `{ continue: false }` 或 `{ action: {...} }` 干预执行
4. **错误隔离**：单个 Plugin 错误不影响其他 Plugin 执行

### 6.3 EventSource 集成
1. **pluginEnabled 配置**：通过 `ctx.context.pluginEnabled` 控制哪些 EventSource plugin 生效
2. **sourceId:pluginName 格式**：唯一标识一个 plugin

## 7. 使用示例

```typescript
// 创建 Agent
agentComponent.registerAgent("my-agent", { type: "primary" });

// 注册 Plugin
agentComponent.registerPlugin("my-agent", {
  name: "my-logger-plugin",
  version: "1.0.0",
  description: "日志记录插件",
  hooks: [
    { point: "agent:before.llm", priority: 10 },
    { point: "agent:after.tool", priority: 5 },
  ],
  execute: async (ctx) => {
    console.log(`Hook at ${ctx.iteration}`);
    
    if (ctx.iteration > 10) {
      return { 
        continue: true,
        action: { type: "compress" }
      };
    }
    return { continue: true };
  }
});

// 注销 Plugin
agentComponent.unregisterPlugin("my-agent", "my-logger-plugin");
```

## 8. 文件清单

| 文件 | 作用 |
|------|------|
| `types.ts` | Plugin、HookContext、AgentInstance 等核心类型定义 |
| `agent-component.ts` | registerPlugin/unregisterPlugin/executePluginHooks 实现 |
| `agent-config-registration.ts` | ConfigComponent 配置注册 |
| `global-hook-manager.ts` | 全局 Hook 单例管理 |
| `hook-manager.ts` | HookManager 类实现 |
| `hook/types.ts` | 统一 Hook 接口定义 |

