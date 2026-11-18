# Component 生命周期与设计规范

> 版本: 1.0.0 | 日期: 2026-03-28
>
> **核心理念**：Component 是 roy-bot 的核心抽象，遵循统一规范可确保架构一致性

---

## 1. Component 架构概览

### 1.1 继承体系

```
Component (Interface)
    │
    └── BaseComponent (Abstract Class)
            │
            ├── LLMComponent
            ├── ToolComponent
            ├── AgentComponent
            ├── PromptComponent
            ├── SessionComponent
            ├── ConfigComponent
            ├── LogTraceComponent
            │
            └── Environment (extends BaseComponent)
```

### 1.2 BaseComponent 核心职责

| 职责 | 说明 |
|------|------|
| 状态管理 | 维护组件生命周期状态 |
| env 注入 | 接收 Environment 引用 |
| 钩子扩展 | 提供 onInit/onStart/onStop 扩展点 |

---

## 2. 生命周期规范

### 2.1 状态转换

```
created → initializing → running → stopping → stopped
```

| 状态 | 说明 |
|------|------|
| `created` | 组件实例已创建，未初始化 |
| `initializing` | 正在初始化 |
| `running` | 初始化完成，运行中 |
| `stopping` | 正在停止 |
| `stopped` | 已停止，资源已释放 |

### 2.2 生命周期方法

#### BaseComponent 标准方法

```typescript
abstract class BaseComponent implements Component {
  // 标识
  abstract readonly name: string;
  abstract readonly version: string;
  
  // 状态
  protected _status: ComponentStatus = "created";
  protected _enabled: boolean = true;
  
  // Environment 实例（使用 definite assignment assertion）
  protected env!: Environment;
  
  // Hook 管理器
  protected readonly hookManager: HookManager = new HookManager();
  
  // 标准生命周期
  async init(config?: ComponentConfig): Promise<void> {
    if (config?.env) {
      this.env = config.env;
    }
    this.setStatus("initializing");
    await this.onInit();   // 子类扩展
    this.setStatus("running");
  }
  
  async start(): Promise<void> {
    if (this._status === "running") return;
    await this.onStart();  // 子类扩展
    this.setStatus("running");
  }
  
  async stop(): Promise<void> {
    this.setStatus("stopping");
    // 清理 Hooks
    this.hookManager.clear();
    await this.onStop();   // 子类扩展
    this.setStatus("stopped");
  }
}
```

#### 子类必须实现

```typescript
// 必须调用 super.init(config)
async init(config?: ComponentConfig): Promise<void> {
  await super.init(config);  // ✅ 必须调用
  // 组件特定初始化...
}

// 覆盖扩展点
protected async onInit(): Promise<void> { }
protected async onStart(): Promise<void> { }
protected async onStop(): Promise<void> { }
```

#### Hook 便捷方法

```typescript
// 注册 Hook
protected registerHook<T = unknown>(hookPoint: string, hook: Hook<T>): void {
  this.hookManager.register(hookPoint, hook);
}

// 快速注册 Hook
protected addHook(
  hookPoint: string,
  name: string,
  fn: HookFn,
  priority?: number
): void {
  this.registerHook(hookPoint, createHook({ name, priority }, fn));
}

// 执行 Hooks
protected executeHooks(
  hookPoint: string,
  data: unknown,
  metadata?: Record<string, unknown>
): Promise<void> {
  return this.hookManager.execute(hookPoint, data, metadata);
}
```

### 2.3 ComponentConfig 规范

```typescript
interface ComponentConfig {
  name: string;           // 组件名称
  version: string;        // 组件版本
  enabled: boolean;       // 是否启用
  env?: Environment;      // 环境引用（可选，支持独立测试）
  options?: unknown;      // 组件特定配置
}
```

**设计原则**：
- `env` 字段可选，允许组件在无 Environment 情况下独立测试
- `options` 用于传递组件特定配置，使用类型断言或 Zod 解析

---

## 3. Environment 生命周期

### 3.1 Environment 特殊处理

Environment 继承自 BaseComponent，但有特殊行为：

```typescript
class BaseEnvironment extends BaseComponent implements Environment {
  // Environment 本身就是 env，所以 init() 设置自引用
  async init(): Promise<void> {
    Object.defineProperty(this, "env", { value: this });
    this.setStatus("initializing");
    await this.onInit();
    this.setStatus("running");
  }
}
```

### 3.2 分阶段组件初始化

```typescript
protected async initializeComponents(): Promise<void> {
  // 第一阶段：ConfigComponent 最先初始化
  // 其他组件可能依赖配置
  const configComp = this.components.get("config");
  if (configComp?.getStatus() === "created") {
    await configComp.init({ name, version, enabled: true, env: this });
  }
  
  // 第二阶段：其他组件
  for (const component of this.components.values()) {
    if (component.getStatus() === "created") {
      await component.init({ name, version, enabled: true, env: this });
    }
  }
}
```

### 3.3 完整生命周期流程

```
┌─────────────────────────────────────────────────────────────┐
│                    new Environment()                         │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 1. super()                                          │   │
│  │ 2. this.name = config?.name ?? "..."               │   │
│  │ 3. this.registerDefaultComponents()               │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    env.init()                                │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 1. 设置 self-reference (this.env = this)            │   │
│  │ 2. setStatus("initializing")                        │   │
│  │ 3. onInit() → initializeComponents()              │   │
│  │    ├─ [阶段1] 初始化 ConfigComponent               │   │
│  │    └─ [阶段2] 初始化其他组件                      │   │
│  │ 4. setStatus("running")                           │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    env.start()                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 1. if 已 running → return                          │   │
│  │ 2. onStart() → startComponents()                  │   │
│  │ 3. setStatus("running")                           │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    env.stop()                                │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 1. setStatus("stopping")                           │   │
│  │ 2. onStop() → stopComponents()                    │   │
│  │ 3. 清理事件处理器                                   │   │
│  │ 4. setStatus("stopped")                            │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. 设计规范

### 4.1 init 方法签名统一

所有 Component 必须使用统一的 `init(config: ComponentConfig)` 签名：

```typescript
// ✅ 正确
async init(config: ComponentConfig): Promise<void> {
  await super.init(config);
  const options = config.options as MyOptions | undefined;
  // ...
}

// ❌ 错误：参数不一致
async init(options: MyOptions): Promise<void> { }
async init(name: string, env: Environment): Promise<void> { }
```

### 4.2 必须调用 super.init()

```typescript
// ✅ 正确
class MyComponent extends BaseComponent {
  async init(config: ComponentConfig): Promise<void> {
    await super.init(config);  // 必须调用
    // 组件特定初始化...
  }
}

// ❌ 错误：忘记调用 super
class MyComponent extends BaseComponent {
  async init(config: ComponentConfig): Promise<void> {
    // 忘记调用 super.init(config)
    this.env = config.env;  // 自己处理 env
  }
}
```

### 4.3 状态检查

在生命周期方法中进行适当的状态检查：

```typescript
async start(): Promise<void> {
  if (this._status !== "running") {
    await this.onStart();
  }
}

async stop(): Promise<void> {
  if (this._status === "stopped") return;
  this.setStatus("stopping");
  await this.onStop();
  this.setStatus("stopped");
}
```

### 4.4 统一配置管理

采用混合模式处理配置默认值：

| 配置类型 | 处理方式 | 说明 |
|---------|---------|------|
| **静态配置** | Zod Schema + `safeParse` | 组件初始化参数，init 时解析一次 |
| **动态配置** | `getRuntimeConfig()` | 运行时参数，支持热更新 |

**BaseComponent 提供的方法**：

```typescript
// 获取 ConfigComponent
protected getConfigComponent(): { get(key: string): unknown } | undefined {
  return this.env?.getComponent("config") as { get(key: string): unknown } | undefined;
}

// 动态获取运行时配置（支持热更新）
protected getRuntimeConfig<T>(key: string, defaultValue: T): T {
  const configComponent = this.getConfigComponent();
  if (configComponent) {
    const value = configComponent.get(key);
    if (value !== undefined) {
      return value as T;
    }
  }
  return defaultValue;
}
```

**使用示例**：

```typescript
// 静态配置 - 在 init 时解析（使用 Zod Schema）
async init(config: ComponentConfig): Promise<void> {
  await super.init(config);
  if (config.options) {
    const parsed = MyComponentConfigSchema.safeParse(config.options);
    if (parsed.success) {
      this.config = parsed.data;
    }
  }
}

// 动态配置 - 每次调用时获取（支持热更新）
someMethod(): void {
  // 从 ConfigComponent 实时获取，可能变化的值
  const temperature = this.getRuntimeConfig("llm.temperature", 0.7);
  const apiKey = this.getRuntimeConfig<string>("llm.providers.openai.apiKey");
}
```

### 4.5 env 访问安全

```typescript
// ✅ 安全访问：使用可选链
this.env?.getComponent("llm");
this.env?.pushEnvEvent(event);

// ❌ 不安全：假设 env 一定存在
this.env.getComponent("llm");  // 可能抛出错误
```

---

## 5. Zod 配置 Schema 规范

### 5.1 Schema 定义模式

```typescript
// 1. 定义默认值常量
const DEFAULT_CONFIG = {
  timeout: 60000,
  retries: 3,
} as const;

// 2. 定义无默认值的 Schema
const MyConfigSchema = z.object({
  timeout: z.number(),
  retries: z.number(),
  optional: z.string().optional(),
});

// 3. 创建带默认值的 Schema
export const MyComponentConfigSchema = z.object({
  options: MyConfigSchema.default(DEFAULT_CONFIG),
});

// 4. 推断类型
export type MyComponentConfig = z.infer<typeof MyComponentConfigSchema>;
```

### 5.2 避免嵌套 default

```typescript
// ❌ 问题：嵌套 default 可能导致类型推断问题
const schema = z.object({
  nested: z.object({
    value: z.number().default(100),
  }).default({ value: 100 }),
});

// ✅ 正确：使用独立常量
const schema = z.object({
  nested: z.object({
    value: z.number(),
  }).default({ value: 100 }),
});
```

---

## 6. 错误处理规范

### 6.1 生命周期中的错误隔离

Hook 执行应该使用 try-catch 隔离错误：

```typescript
private async executeHooks(hookType: string, ctx: HookContext): Promise<void> {
  for (const hook of this.hooks[hookType] || []) {
    try {
      await hook.before?.(ctx, ctx);
    } catch (err) {
      logger.warn(`Hook ${hook.name} failed:`, err);
      // 可配置：是否在错误时停止
      if (this.config?.strictMode) {
        throw err;
      }
    }
  }
}
```

### 6.2 资源清理

```typescript
protected async onStop(): Promise<void> {
  // 清理资源
  this.cleanup?.();
  this.subscriptions?.forEach(unsub => unsub());
  this.subscriptions = [];
}
```

### 6.3 日志配置

使用 `createLogger` 创建组件日志器，支持按类别配置日志级别：

```typescript
import { createLogger } from "../log-trace/logger";

// 创建带类别前缀的 logger
const logger = createLogger("llm");  // 使用 "llm" 类别
const agentLogger = createLogger("agent:component");  // 使用 "agent:component" 类别
```

**配置日志级别**：

```yaml
# config.yaml
log-trace:
  logging:
    level: info          # 全局日志级别
    levels:
      llm: debug         # LLM 组件详细日志
      agent: warn         # Agent 组件警告以上
      tool: error         # Tool 组件仅错误
```

**环境变量支持**：

```bash
# 全局日志级别
LOG_LEVEL=debug

# 按类别日志级别（环境变量会自动转换）
LOG_LEVEL_LLM=debug
LOG_LEVEL_AGENT=warn
```

---

## 7. 最佳实践清单

### 7.1 创建新 Component

- [ ] 继承 `BaseComponent`
- [ ] 定义 `name` 和 `version` 属性
- [ ] 实现 `init()` 调用 `super.init()`
- [ ] 覆盖 `onInit()`, `onStart()`, `onStop()` 扩展点
- [ ] 使用 `ComponentConfig` 获取配置
- [ ] 编写单元测试
- [ ] 更新导出 `index.ts`

### 7.2 组件注册

```typescript
// Environment 子类中
protected registerDefaultComponents(): void {
  this.registerComponent(new LLMComponent());
  this.registerComponent(new ToolComponent());
  this.registerComponent(new AgentComponent());
}
```

### 7.3 组件获取

```typescript
// 在组件内部
const llm = this.env?.getComponent<LLMComponent>("llm");

// 在环境外部
const env = new MyEnvironment();
await env.init();
const llm = env.getComponent<LLMComponent>("llm");
```

---

## 8. 相关文档

- [architecture-design.md](./architecture-design.md) - 整体架构设计
- [environment-design.md](./environment-design.md) - Environment 设计
- [component-decentralized-config-design.md](./component-decentralized-config-design.md) - 去中心化配置设计
- [code-review.md](./code-review.md) - 代码审查报告

---

## 9. 变更记录

| 日期 | 版本 | 变更内容 | 作者 |
|------|------|----------|------|
| 2026-03-28 | 1.0.0 | 初始版本 | Agent |
