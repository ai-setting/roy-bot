# Hook 系统统一设计文档

> 版本: 1.0.0 | 日期: 2026-03-28 | 状态: 待实现
>
> **核心理念**：所有 Component 的 Hook 接口统一，基于统一的 Hook Manager

---

## 📋 概览

### 目标
统一所有 Component 的 Hook 接口，实现一致的 Hook 注册、执行和错误隔离机制。

### 设计原则
1. **统一接口**：所有 Component 使用相同的 Hook 接口
2. **强类型上下文**：每个 Component 定义自己的上下文类型
3. **生命周期支持**：支持 `before`、`after`、`error` 三个阶段
4. **优先级执行**：Hook 按优先级排序执行
5. **错误隔离**：单个 Hook 失败不影响其他 Hook

---

## 🏗️ 统一 Hook 接口

### 核心类型定义

```typescript
// packages/core/src/env/hook/types.ts

/**
 * Hook 执行阶段
 */
export type HookPhase = "before" | "after" | "error";

/**
 * Hook 元信息
 */
export interface HookMeta {
  /** Hook 唯一名称 */
  name: string;
  /** 执行优先级，默认 0，数值越小越先执行 */
  priority?: number;
  /** 描述 */
  description?: string;
}

/**
 * 统一 Hook 上下文
 * 
 * 泛型参数 T 表示该 Component 的上下文类型
 */
export interface HookContext<T = unknown> {
  /** 当前组件 */
  component: {
    name: string;
    version: string;
  };
  /** 上下文数据（Component 特定） */
  data: T;
  /** 元数据 */
  metadata: Record<string, unknown>;
  /** 执行阶段 */
  phase: HookPhase;
  /** 关联的 hook 点名称 */
  hookPoint: string;
}

/**
 * 统一 Hook 接口
 * 
 * 所有 Component 的 Hook 都应实现此接口
 */
export interface Hook<T = unknown> extends HookMeta {
  /** 执行 Hook
   * @param ctx 上下文
   */
  execute(ctx: HookContext<T>): void | Promise<void>;
}

/**
 * Hook 函数类型（便捷别名）
 */
export type HookFn<T = unknown> = (ctx: HookContext<T>) => void | Promise<void>;

/**
 * 创建 Hook 的工厂函数
 */
export function createHook<T = unknown>(
  meta: HookMeta,
  fn: HookFn<T>
): Hook<T> {
  return {
    ...meta,
    execute: fn,
  };
}
```

---

## 📦 Hook Manager

### 职责
- 管理 Hook 注册
- 按优先级排序执行
- 提供错误隔离
- 支持动态添加/移除

### 接口

```typescript
// packages/core/src/env/hook/hook-manager.ts

import type { Hook, HookContext, HookPhase, HookMeta } from "./types";

/**
 * Hook Manager
 * 
 * 统一管理 Component 的 Hook
 */
export class HookManager<T = unknown> {
  private hooks: Map<string, Hook<T>[]> = new Map();
  private defaultPriority = 0;

  /**
   * 注册 Hook 到指定 hook 点
   */
  register(hookPoint: string, hook: Hook<T>): void;

  /**
   * 注册多个 Hook
   */
  registerMany(hookPoint: string, hooks: Hook<T>[]): void;

  /**
   * 按名称取消注册
   */
  unregister(hookPoint: string, name: string): boolean;

  /**
   * 取消注册所有指定 hook 点的 Hook
   */
  unregisterAll(hookPoint: string): void;

  /**
   * 执行指定 hook 点的所有 Hook
   */
  async execute(
    hookPoint: string,
    data: T,
    metadata?: Record<string, unknown>
  ): Promise<void>;

  /**
   * 执行并返回结果（用于收集多个 Hook 的返回值）
   */
  async executeAndCollect<R>(
    hookPoint: string,
    data: T,
    metadata?: Record<string, unknown>
  ): Promise<R[]>;

  /**
   * 获取指定 hook 点的 Hook 数量
   */
  count(hookPoint: string): number;

  /**
   * 清空所有 Hook
   */
  clear(): void;

  /**
   * 获取所有已注册的 hook 点
   */
  getHookPoints(): string[];
}
```

### 实现要点

```typescript
// 按优先级排序执行
private sortHooks(hooks: Hook<T>[]): Hook<T>[] {
  return [...hooks].sort((a, b) => {
    const priorityA = a.priority ?? this.defaultPriority;
    const priorityB = b.priority ?? this.defaultPriority;
    return priorityA - priorityB;
  });
}

// 错误隔离执行
private async safeExecute(hook: Hook<T>, ctx: HookContext<T>): Promise<void> {
  try {
    await hook.execute(ctx);
  } catch (error) {
    // 记录错误但不中断执行
    console.error(`Hook ${hook.name} failed:`, error);
  }
}
```

---

## 🔧 Component 基类集成

### BaseComponent 改造

```typescript
// packages/core/src/env/component.ts

import { HookManager } from "./hook/hook-manager";

export abstract class BaseComponent implements Component {
  // 替换原来的 hooks: HookMap
  protected readonly hookManager: HookManager = new HookManager();

  /**
   * 注册 Hook
   */
  protected registerHook(hookPoint: string, hook: Hook): void {
    this.hookManager.register(hookPoint, hook);
  }

  /**
   * 便捷方法：快速注册 before/after hook
   */
  protected addHook(
    hookPoint: string,
    name: string,
    fn: HookFn,
    priority?: number
  ): void {
    this.registerHook(hookPoint, createHook({ name, priority }, fn));
  }
}
```

---

## 🎯 各 Component Hook 定义

### ToolComponent

```typescript
// packages/core/src/env/tool/types.ts

/**
 * Tool Hook 上下文
 */
export interface ToolHookContext {
  /** 工具信息 */
  tool?: Tool;
  /** 工具参数 */
  args?: Record<string, unknown>;
  /** 执行上下文 */
  context?: ToolContext;
  /** 执行结果 */
  result?: ToolResult;
}

/**
 * Tool Hook 点
 */
export const ToolHookPoints = {
  BEFORE_EXECUTE: "tool.before-execute",
  AFTER_EXECUTE: "tool.after-execute",
  ON_ERROR: "tool.on-error",
} as const;
```

### PromptComponent

```typescript
// packages/core/src/env/prompt/types.ts

/**
 * Prompt Hook 上下文
 */
export interface PromptHookContext {
  /** Prompt 名称 */
  name: string;
  /** Prompt 内容 */
  content?: string;
  /** 变量 */
  variables?: Record<string, unknown>;
  /** 渲染后的内容 */
  rendered?: string;
}

/**
 * Prompt Hook 点
 */
export const PromptHookPoints = {
  BEFORE_RENDER: "prompt.before-render",
  AFTER_RENDER: "prompt.after-render",
} as const;
```

### AgentComponent

```typescript
// packages/core/src/env/agent/types.ts

/**
 * Agent Hook 上下文（复用现有 HookContext，但添加统一字段）
 */
export interface AgentHookContext {
  // 现有字段保持兼容
  agent: AgentInstance;
  iteration: number;
  messages: ModelMessage[];
  tools: Tool[];
  systemPrompt: string;
  context: AgentContext;
  // 新增统一字段
  _stopped?: boolean;
  _stopReason?: string;
  _errors?: Array<{ plugin: string; error: string }>;
}

/**
 * Agent Hook 点
 */
export const AgentHookPoints = {
  BEFORE_START: "agent.before-start",
  BEFORE_LLM: "agent.before-llm",
  AFTER_LLM: "agent.after-llm",
  BEFORE_TOOL: "agent.before-tool",
  AFTER_TOOL: "agent.after-tool",
  ON_ERROR: "agent.on-error",
  AFTER_COMPLETE: "agent.after-complete",
} as const;
```

### LLMComponent

```typescript
// packages/core/src/env/llm/types.ts

/**
 * LLM Hook 上下文
 */
export interface LLMHookContext {
  /** 请求 */
  request: LLMInvokeRequest;
  /** Provider ID */
  providerId: string;
  /** 模型名称 */
  model: string;
  /** 结果（after-invoke 可用） */
  result?: LLMInvokeResult;
  /** 流式事件（stream 可用） */
  event?: StreamEvent;
}

/**
 * LLM Hook 点
 */
export const LLMHookPoints = {
  BEFORE_INVOKE: "llm.before-invoke",
  AFTER_INVOKE: "llm.after-invoke",
  STREAM: "llm.stream",
  ON_ERROR: "llm.on-error",
} as const;
```

---

## 📁 文件结构

```
packages/core/src/env/hook/
├── types.ts              # 统一类型定义
├── hook-manager.ts       # HookManager 类
├── hook-manager.test.ts  # HookManager 单元测试
└── index.ts              # 导出

# 更新现有文件
├── component.ts          # BaseComponent 使用 HookManager
├── tool/
│   ├── tool-component.ts # 使用统一 Hook
│   └── types.ts          # 添加 ToolHookContext
├── prompt/
│   ├── prompt-component.ts
│   └── types.ts          # 添加 PromptHookContext
├── agent/
│   ├── agent-component.ts
│   └── types.ts          # 添加 AgentHookContext
└── llm/
    ├── llm.ts
    └── types.ts          # 添加 LLMHookContext
```

---

## ✅ 实现步骤

### Phase 1: 核心类型和 HookManager
1. 创建 `env/hook/types.ts` - 定义统一类型
2. 创建 `env/hook/hook-manager.ts` - 实现 HookManager
3. 编写 HookManager 单元测试

### Phase 2: BaseComponent 集成
4. 更新 `env/component.ts` - 使用 HookManager
5. 更新组件测试

### Phase 3: 各 Component 统一
6. 更新 ToolComponent 使用统一 Hook
7. 更新 PromptComponent 使用统一 Hook
8. 更新 AgentComponent 使用统一 Hook
9. 更新 LLMComponent 使用统一 Hook

### Phase 4: 清理
10. 移除旧的重复类型定义
11. 更新导出和索引
12. 完整测试验证

---

## 📊 与现有系统对比

| 特性 | 现有系统 | 新系统 |
|------|---------|--------|
| Hook 接口 | 分散在各处 | 统一在 `Hook<T>` |
| Context | 自定义 | 泛型 `HookContext<T>` |
| 执行管理 | 各 Component 自行实现 | `HookManager` 统一管理 |
| 错误隔离 | 部分实现 | 统一 `safeExecute` |
| 优先级 | 仅 AgentComponent 支持 | 所有 Hook 支持 |
| 类型安全 | 中等 | 强类型 |
