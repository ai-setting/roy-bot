# ToolComponent 设计文档

> 版本: 0.2.0 | 日期: 2026-03-27
>
> 基于 roy-bot Component 架构设计，参考 agent-core 工具实现
>
> **实现状态**: ✅ 已完成

---

## 1. 概述

### 1.1 设计目标

ToolComponent 是 roy-bot 的**工具管理核心组件**，负责：
- **工具注册与发现**：支持静态注册和动态注册
- **工具执行与调度**：参数验证、执行、超时控制
- **工具生命周期**：初始化、执行、结果处理
- **Hook 扩展**：支持 AgentComponent 在工具执行前后拦截
- **权限管理**：工具调用权限控制（声明式）

### 1.2 核心设计原则

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        ToolComponent 核心原则                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   ✓ 工具由 Component 管理                                                │
│     ToolComponent 负责管理所有工具的注册、发现、执行                       │
│                                                                         │
│   ✓ 声明式参数定义                                                      │
│     工具通过 Zod Schema 声明参数类型                                      │
│                                                                         │
│   ✓ 生命周期管理                                                        │
│     init → register → execute                                           │
│                                                                         │
│   ✓ Hook 扩展点                                                        │
│     before.execute / after.execute / before.register / after.register    │
│                                                                         │
│   ✓ 异步工具加载                                                        │
│     loadBuiltInTools() 支持异步加载内置工具                               │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 架构总览

### 2.1 模块结构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         ToolComponent 模块结构                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  packages/core/src/env/tool/                                            │
│  ├── index.ts                    # 导出入口                             │
│  ├── tool-component.ts           # Component 主类                       │
│  ├── types.ts                    # 类型定义                             │
│  ├── registry.ts                 # 工具注册中心                          │
│  ├── validator.ts                # 参数验证器                            │
│  ├── tool-component.test.ts     # 组件测试                             │
│  ├── registry.test.ts           # 注册中心测试                          │
│  ├── validator.test.ts          # 验证器测试                           │
│  └── built-in/                   # 内置工具                             │
│      ├── index.ts              # 内置工具导出                          │
│      ├── bash.ts / bash.test.ts                                       │
│      ├── glob.ts / glob.test.ts                                       │
│      ├── read-file.ts / read-file.test.ts                              │
│      ├── write-file.ts / write-file.test.ts                             │
│      ├── edit-file.ts / edit-file.test.ts                              │
│      └── grep.ts / grep.test.ts                                       │
│                                                                         │
│  注: sandbox 和 permission 模块预留接口，暂未实现                          │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 组件关系

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          组件关系图                                       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────┐                                                   │
│  │   Environment    │                                                   │
│  └────────┬────────┘                                                   │
│           │                                                            │
│     ┌─────┴─────┐                                                      │
│     │           │                                                      │
│  ┌──▼──────────▼──┐                                                   │
│  │ ToolComponent   │◄─────── 依赖 ───────► LLMComponent                 │
│  └────────┬────────┘                              │                    │
│           │                                       │                    │
│     ┌─────┴─────┐                                 │                    │
│     │           │                                 │                    │
│  ┌──▼──┐   ┌──▼───┐                    ┌─────────▼────────┐            │
│  │Registry│  │Validator│                 │  AgentComponent  │            │
│  │ 工具   │   │参数    │                   └─────────┬────────┘            │
│  │ 注册表 │   │验证器  │                             │                    │
│  └───────┘   └────────┘                             │                    │
│       │                                               │                    │
│       ▼                                               ▼                    │
│  ┌─────────────────────────────────────────────────────────────┐        │
│  │                    Hook 扩展点                                 │        │
│  │  before.execute ──► ToolComponent.execute() ──► after.execute │
│  └─────────────────────────────────────────────────────────────┘        │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 核心类型定义

### 3.1 工具上下文

```typescript
// packages/core/src/env/tool/types.ts

/**
 * 沙箱配置
 */
export interface SandboxConfig {
  enabled: boolean;
  type: "native" | "docker";
  actionFilter?: { include?: string[]; exclude?: string[] };
  filesystem?: { allowRead?: string[]; denyRead?: string[]; allowWrite?: string[]; denyWrite?: string[] };
  network?: { allowedDomains?: string[]; deniedDomains?: string[] };
  docker?: { image?: string; networkMode?: "bridge" | "host" | "none"; volumes?: Record<string, string> };
}

/**
 * 工具执行上下文
 */
export interface ToolContext {
  workdir?: string;
  user_id?: string;
  session_id?: string;
  message_id?: string;
  abort?: AbortSignal;
  metadata?: Record<string, unknown>;
  sandbox?: SandboxConfig;
  sandboxProvider?: unknown | null;
}
```

### 3.2 工具结果

```typescript
/**
 * 工具结果元数据
 */
export interface ToolResultMetadata {
  execution_time_ms: number;
  output_size?: number;
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  usage?: { inputTokens: number; outputTokens: number; totalTokens?: number };
  [key: string]: unknown;
}

/**
 * 工具执行结果
 */
export interface ToolResult {
  success: boolean;
  output: string | Record<string, unknown>;
  error?: string;
  metadata?: ToolResultMetadata;
}
```

### 3.3 工具定义

```typescript
import { z, ZodType, ZodError } from "zod";

/**
 * 工具元数据
 */
export interface ToolMetadata {
  category?: string;
  tags?: string[];
  version?: string;
  author?: string;
  experimental?: boolean;
}

/**
 * 工具沙箱配置
 */
export interface ToolSandboxConfig {
  enabled: boolean;
  config?: Partial<SandboxConfig>;
}

/**
 * 工具权限配置
 */
export interface ToolPermissionConfig {
  requireConfirmation?: boolean;
  level?: "safe" | "dangerous" | "critical";
}

/**
 * 工具信息
 */
export interface ToolInfo<Parameters extends ZodType = ZodType> {
  name: string;
  description: string;
  parameters: Parameters;
  init?: (ctx?: ToolContext) => Promise<void>;
  execute: (args: z.infer<Parameters>, ctx: ToolContext) => Promise<ToolResult>;
  formatValidationError?: (error: ZodError) => string;
  sandbox?: ToolSandboxConfig;
  permission?: ToolPermissionConfig;
  metadata?: ToolMetadata;
}

/**
 * 工具类型别名
 */
export type Tool = ToolInfo;
```

---

## 4. 组件设计

### 4.1 ToolComponent 接口

```typescript
/**
 * 工具注册信息
 */
export interface ToolRegistration {
  tool: Tool;
  registeredAt: number;
  source: "built-in" | "plugin" | "dynamic";
  enabled: boolean;
}

/**
 * 工具执行请求
 */
export interface ToolExecuteRequest {
  name: string;
  args: Record<string, unknown>;
  context: ToolContext;
  skipHooks?: boolean;
}

/**
 * 工具列表过滤器
 */
export interface ToolListFilter {
  name?: string | string[];
  category?: string;
  tags?: string[];
  source?: ToolRegistration["source"];
  enabledOnly?: boolean;
  exclude?: string[];
}

/**
 * ToolComponent 接口
 */
export interface ToolComponent extends Component {
  // 工具注册
  register(tool: Tool, source?: ToolRegistration["source"]): void;
  registerMany(tools: Tool[], source?: ToolRegistration["source"]): void;
  unregister(name: string): boolean;
  getTool(name: string): Tool | undefined;

  // 工具发现
  listTools(filter?: ToolListFilter): Tool[];
  getToolCount(): number;
  hasTool(name: string): boolean;
  getToolsByCategory(category: string): Tool[];

  // 工具执行
  execute(request: ToolExecuteRequest): Promise<ToolResult>;

  // 内置工具
  loadBuiltInTools(): Promise<void>;

  // Hooks (使用 HookManager)
  // 通过 hookManager.register() 注册
}

// ToolComponent Hook 点常量
export const ToolHookPoints = {
  BEFORE_EXECUTE: "tool.before-execute",
  AFTER_EXECUTE: "tool.after-execute",
  BEFORE_REGISTER: "tool.before-register",
  AFTER_REGISTER: "tool.after-register",
} as const;
```

### 4.2 ToolComponent 实现

```typescript
// packages/core/src/env/tool/tool-component.ts

export class ToolComponent extends BaseComponent {
  readonly name = "tool";
  readonly version = "1.0.0";

  // 继承自 BaseComponent 的 hookManager
  // 使用 ToolHookPoints 中定义的 hook 点名称

  private registry: ToolRegistry;
  private validator: ToolValidator;
  private config?: ToolComponentConfig;

  constructor() {
    super();
    this.registry = new ToolRegistry();
    this.validator = new ToolValidator();
  }

  async init(config?: ComponentConfig): Promise<void> {
    this.setStatus("initializing");
    // 解析配置...
    
    // 加载内置工具（异步）
    if (this.config?.builtInTools?.enabled !== false) {
      await this.loadBuiltInTools();
    }

    this.setStatus("running");
    logger.info(`ToolComponent initialized with ${this.getToolCount()} tools`);
  }

  async loadBuiltInTools(): Promise<void> {
    try {
      const { getAllBuiltInTools } = await import("./built-in/index");
      const tools = getAllBuiltInTools();
      this.registerMany(tools, "built-in");
      logger.info(`Loaded ${tools.length} built-in tools`);
    } catch (err) {
      logger.warn(`Failed to load built-in tools: ${(err as Error).message}`);
    }
  }

  async execute(request: ToolExecuteRequest): Promise<ToolResult> {
    const { name, args, context, skipHooks } = request;

    const registration = this.registry.getTool(name);
    if (!registration) {
      return { success: false, output: "", error: `Tool not found: ${name}` };
    }

    if (!registration.enabled) {
      return { success: false, output: "", error: `Tool disabled: ${name}` };
    }

    const tool = registration.tool;

    // 执行 tool.before-execute hooks
    if (!skipHooks) {
      await this.executeHooks(ToolHookPoints.BEFORE_EXECUTE, { tool, args, context });
    }

    const startTime = Date.now();

    try {
      // 参数验证
      const validationResult = await this.validator.validate(tool, args);
      if (!validationResult.success) {
        return {
          success: false,
          output: "",
          error: validationResult.error,
          metadata: { execution_time_ms: Date.now() - startTime },
        };
      }

      // 执行工具
      const result = await tool.execute(validationResult.data!, context);
      
      // 添加执行时间
      if (!result.metadata) result.metadata = {};
      result.metadata.execution_time_ms = Date.now() - startTime;

      // 执行 tool.after-execute hooks
      if (!skipHooks) {
        await this.executeHooks(ToolHookPoints.AFTER_EXECUTE, { tool, args, context, result });
      }

      return result;
    } catch (error) {
      const errorResult: ToolResult = {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
        metadata: { execution_time_ms: Date.now() - startTime },
      };

      if (!skipHooks) {
        await this.executeHooks(ToolHookPoints.AFTER_EXECUTE, { tool, args, context, result: errorResult });
      }

      return errorResult;
    }
  }
}
```

---

## 5. 工具注册中心

### 5.1 Registry 实现

```typescript
// packages/core/src/env/tool/registry.ts

export class ToolRegistry {
  private tools = new Map<string, ToolRegistration>();

  register(tool: Tool, registration: ToolRegistration): void {
    this.tools.set(tool.name, registration);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  getTool(name: string): ToolRegistration | undefined {
    return this.tools.get(name);
  }

  listTools(filter?: ToolListFilter): Tool[] {
    let tools = this.getAllTools();

    if (!filter) return tools.map((r) => r.tool);

    // 按名称过滤（支持 glob）
    if (filter.name) {
      const names = Array.isArray(filter.name) ? filter.name : [filter.name];
      tools = tools.filter((r) =>
        names.some((pattern) => this.matchGlob(r.tool.name, pattern))
      );
    }

    // 按分类过滤
    if (filter.category) {
      tools = tools.filter((r) => r.tool.metadata?.category === filter.category);
    }

    // 按来源过滤
    if (filter.source) {
      tools = tools.filter((r) => r.source === filter.source);
    }

    // 只返回启用的工具
    if (filter.enabledOnly) {
      tools = tools.filter((r) => r.enabled);
    }

    // 排除工具
    if (filter.exclude?.length) {
      tools = tools.filter((r) => !filter.exclude!.includes(r.tool.name));
    }

    return tools.map((r) => r.tool);
  }

  enable(name: string): boolean { /* ... */ }
  disable(name: string): boolean { /* ... */ }
  clear(): void { this.tools.clear(); }
  
  snapshot(): ToolRegistration[] { /* ... */ }
  restore(snapshot: ToolRegistration[]): void { /* ... */ }

  private matchGlob(str: string, pattern: string): boolean {
    if (pattern === "*") return true;
    if (!pattern.includes("*")) return str === pattern;
    const regexPattern = pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    return new RegExp(`^${regexPattern}$`).test(str);
  }
}
```

---

## 6. 参数验证器

### 6.1 Validator 实现

```typescript
// packages/core/src/env/tool/validator.ts

export interface ValidationResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

export class ToolValidator {
  async validate(tool: Tool, args: Record<string, unknown>): Promise<ValidationResult> {
    try {
      const parsed = await tool.parameters.parseAsync(args);
      return { success: true, data: parsed as Record<string, unknown> };
    } catch (error) {
      if (error instanceof ZodError) {
        const errorMessage = tool.formatValidationError
          ? tool.formatValidationError(error)
          : this.formatError(error);
        return {
          success: false,
          error: `Invalid arguments for tool '${tool.name}': ${errorMessage}`,
        };
      }
      return { success: false, error: `Validation error: ${error}` };
    }
  }

  private formatError(error: ZodError): string {
    return error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
  }
}
```

---

## 7. 内置工具

### 7.1 内置工具列表

| 工具 | 描述 | 参数 | 沙箱 | 权限 |
|------|------|------|------|------|
| `bash` | 执行 Shell 命令 | `command`, `workdir?`, `timeout?`, `env?` | ✅ | dangerous |
| `glob` | 文件模式匹配 | `pattern`, `cwd?`, `maxResults?`, `ignore?` | ✅ | safe |
| `read_file` | 读取文件内容 | `path`, `offset?`, `limit?`, `encoding?` | ✅ | safe |
| `write_file` | 写入文件内容 | `path`, `content`, `createDirs?`, `append?` | ✅ | dangerous |
| `edit_file` | 编辑文件 | `path`, `oldString`, `newString`, `replaceAll?` | ✅ | dangerous |
| `grep` | 内容搜索 | `pattern`, `path?`, `include?`, `caseSensitive?`, `maxResults?`, `showLineNumbers?` | ✅ | safe |

### 7.2 Bash 工具示例

```typescript
// packages/core/src/env/tool/built-in/bash.ts

export const bashTool: Tool = {
  name: "bash",
  description: "Execute shell commands in the terminal.",
  parameters: z.object({
    command: z.string().describe("The shell command to execute"),
    workdir: z.string().optional().describe("Working directory"),
    timeout: z.number().int().positive().optional().describe("Timeout in ms"),
    env: z.record(z.string()).optional().describe("Environment variables"),
  }),
  sandbox: {
    enabled: true,
    config: {
      filesystem: {
        denyRead: ["/etc/shadow", "/etc/sudoers"],
        denyWrite: ["/etc", "/usr/bin", "/bin"],
      },
    },
  },
  permission: {
    requireConfirmation: true,
    level: "dangerous",
  },
  metadata: {
    category: "system",
    tags: ["shell", "command", "terminal", "exec"],
    version: "1.0.0",
  },
  execute: async (args, ctx): Promise<ToolResult> => {
    const startTime = Date.now();
    const { command, workdir, timeout = 60000, env } = args;

    try {
      const { stdout, stderr } = await execAsync(command, { cwd: workdir || ctx.workdir, timeout, env });
      return {
        success: true,
        output: stdout || "(no output)",
        metadata: { execution_time_ms: Date.now() - startTime, stdout, stderr, exit_code: 0 },
      };
    } catch (error: any) {
      return {
        success: false,
        output: error.stdout || "",
        error: error.stderr || error.message,
        metadata: { execution_time_ms: Date.now() - startTime, exit_code: error.code },
      };
    }
  },
};
```

### 7.3 文件操作工具

```typescript
// read_file
export const readFileTool: Tool = {
  name: "read_file",
  description: "Read the contents of a file.",
  parameters: z.object({
    path: z.string().describe("The file path to read"),
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
    encoding: z.enum(["utf-8", "base64"]).default("utf-8").optional(),
  }),
  permission: { level: "safe" },
  metadata: { category: "file", tags: ["read", "file", "io"] },
  execute: async (args, ctx) => { /* ... */ },
};

// write_file
export const writeFileTool: Tool = {
  name: "write_file",
  description: "Write content to a file.",
  parameters: z.object({
    path: z.string().describe("The file path to write to"),
    content: z.string().describe("The content to write"),
    createDirs: z.boolean().default(false).optional(),
    append: z.boolean().default(false).optional(),
  }),
  permission: { requireConfirmation: true, level: "dangerous" },
  metadata: { category: "file", tags: ["write", "file", "io"] },
  execute: async (args, ctx) => { /* ... */ },
};

// edit_file
export const editFileTool: Tool = {
  name: "edit_file",
  description: "Edit a file by replacing specific text.",
  parameters: z.object({
    path: z.string().describe("The file path to edit"),
    oldString: z.string().describe("The text to find"),
    newString: z.string().describe("The replacement text"),
    replaceAll: z.boolean().default(false).optional(),
  }),
  permission: { requireConfirmation: true, level: "dangerous" },
  metadata: { category: "file", tags: ["edit", "file", "replace"] },
  execute: async (args, ctx) => { /* ... */ },
};
```

---

## 8. 与 AgentComponent 集成

### 8.1 Hook 集成

```typescript
// AgentComponent 中的工具调用

class AgentComponent {
  private toolComponent: ToolComponent;

  private async executeToolCall(toolCall: ToolCall, context: RunContext): Promise<void> {
    // 执行 before.tool hooks
    await this.executeHooks("before.tool", { toolCall, context });

    // 调用 ToolComponent 执行
    const result = await this.toolComponent.execute({
      name: toolCall.name,
      args: JSON.parse(toolCall.arguments),
      context: {
        workdir: context.workdir,
        session_id: context.sessionId,
        message_id: toolCall.id,
      },
    });

    // 执行 after.tool hooks
    await this.executeHooks("after.tool", { toolCall, result, context });

    // 添加到消息历史
    context.messages.push({
      role: "tool",
      content: result.success ? String(result.output) : result.error!,
      toolCallId: toolCall.id,
    });
  }
}
```

### 8.2 工具注册到 AgentComponent

```typescript
// 在 Environment 中注册
const toolComponent = new ToolComponent();
await toolComponent.init();

// 获取所有工具用于 LLM
const tools = toolComponent.listTools({ enabledOnly: true });

// 转换为 LLM 格式
const llmTools = tools.map((tool) => ({
  name: tool.name,
  description: tool.description,
  parameters: tool.parameters,
}));
```

---

## 9. 配置设计

### 9.1 工具配置 Schema

```typescript
const ToolComponentConfigSchema = z.object({
  toolsDir: z.string().optional(),
  builtInTools: z.object({
    enabled: z.boolean().default(true),
    loadAll: z.boolean().default(true),
    names: z.array(z.string()).optional(),
  }).default({}),
  sandbox: z.object({
    enabled: z.boolean().default(false),
    type: z.enum(["native", "docker"]).default("native"),
    defaultConfig: z.record(z.unknown()).optional(),
  }).default({}),
  execution: z.object({
    timeout: z.number().int().positive().default(60000),
    maxConcurrency: z.number().int().positive().default(4),
  }).default({}),
});
```

---

## 10. 实现计划

### 10.1 里程碑

| 阶段 | 任务 | 状态 |
|------|------|------|
| 1 | 实现 ToolRegistry 注册中心 | ✅ 完成 |
| 2 | 实现 ToolValidator 参数验证器 | ✅ 完成 |
| 3 | 实现 ToolComponent 主类 | ✅ 完成 |
| 4 | 实现内置工具（bash, glob, read_file, write_file, edit_file, grep） | ✅ 完成 |
| 5 | Hook 机制实现 | ✅ 完成 |
| 6 | 单元测试覆盖 | ✅ 完成 (103 tests) |
| 7 | 实现沙箱隔离 | 🔜 预留接口 |
| 8 | 实现权限管理 | 🔜 预留接口 |
| 9 | 实现动态工具发现 | 🔜 预留接口 |

### 10.2 文件清单

```
packages/core/src/env/tool/
├── index.ts                     # 导出入口
├── tool-component.ts           # Component 主类 (349 行)
├── tool-component.test.ts      # 组件测试 (288 行)
├── types.ts                    # 类型定义 (261 行)
├── registry.ts                 # 工具注册中心 (167 行)
├── registry.test.ts            # 注册中心测试 (257 行)
├── validator.ts               # 参数验证器 (44 行)
├── validator.test.ts           # 验证器测试 (143 行)
└── built-in/
    ├── index.ts              # 内置工具导出
    ├── bash.ts / bash.test.ts (91 / 83 行)
    ├── glob.ts / glob.test.ts (65 / 94 行)
    ├── read-file.ts / read-file.test.ts (71 / 84 行)
    ├── write-file.ts / write-file.test.ts (68 / 119 行)
    ├── edit-file.ts / edit-file.test.ts (92 / 136 行)
    └── grep.ts / grep.test.ts (108 / 122 行)
```

### 10.3 测试覆盖

| 模块 | 测试数 | 覆盖内容 |
|------|--------|----------|
| ToolRegistry | 20 | 注册、注销、过滤、启用/禁用、快照 |
| ToolValidator | 8 | 参数验证、错误格式化 |
| ToolComponent | 18 | 生命周期、注册、执行、Hooks |
| bash | 10 | 命令执行、错误处理、超时 |
| glob | 9 | 模式匹配、限制、排除 |
| read_file | 9 | 读取、offset/limit、元数据 |
| write_file | 10 | 写入、创建目录、追加 |
| edit_file | 11 | 替换、全局替换、找不到 |
| grep | 10 | 搜索、大小写、行号 |

**总计: 103 tests passing**

---

## 11. 参考

- [agent-core 工具类型定义](https://github.com/ai-setting/agent-core/blob/main/packages/core/src/core/types/tool.ts)
- [Architecture Design](./architecture-design.md)
- [AgentComponent Design](./agent-component-design.md)
- [Component 基类](../packages/core/src/env/component.ts)
