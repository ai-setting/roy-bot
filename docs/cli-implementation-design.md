# CLI 实现设计文档

## 1. 概述

本文档定义 `@roy-bot/cli` 包的设计和实现方案。

**重要说明**：CLI 专注于非交互式的命令执行，不包含：
- TUI 交互模式（由独立的 server+tui 包实现）
- 服务器模式（由独立的 server+tui 包实现）

### 1.1 设计理念

```
┌─────────────────────────────────────────────────────────────┐
│              非交互式命令行工具                                │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   核心设计理念：                                             │
│                                                             │
│   1. 自然语言交互                                           │
│      "通过自然语言驱动整个操作系统"                              │
│      roy act "帮我完成代码审查"                               │
│                                                             │
│   2. 渐进式探索                                             │
│      "不带参数时显示帮助，智能体可通过 --help 自我学习"           │
│      roy --help                                             │
│      roy --capabilities                                     │
│                                                             │
│   3. 统一入口                                               │
│      "类似 shell/bash，智能体只需知道一个入口"                   │
│      roy <any-command>                                      │
│                                                             │
│   4. 非交互式执行                                           │
│      "所有操作通过命令行参数完成，适合脚本集成"                   │
│      roy sessions list --json                               │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 与 agent-core CLI 的关系

| agent-core | roy-bot | 说明 |
|------------|------------|------|
| `tong_work` | `roy` | CLI 主入口 |
| `tong_work run` | `roy act` | 自然语言交互（核心） |
| `tong_work session` | `roy sessions` | 会话管理 |
| `tong_work memory` | `roy memory` | 记忆管理 |
| - | `roy tasks` | 任务管理 |
| - | `roy prompts` | 提示词管理 |
| - | `roy agents` | Agent 管理 |
| - | `roy tools` | 工具管理 |
| - | `roy skills` | 技能管理 |
| - | `roy config` | 配置管理 |
| - | `roy logs` | 日志管理 |
| - | `roy env` | 环境管理 |
| - | `roy version` | 版本信息 |
| - | `roy capabilities` | 能力列表 |

### 1.3 定位说明

```
┌─────────────────────────────────────────────────────────────┐
│                       roy-bot                            │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   ┌─────────────────┐    ┌─────────────────────────────┐  │
│   │   @roy-bot/cli │    │   @roy-bot/server-tui   │  │
│   │   (非交互式)      │    │   (交互式 TUI + 服务器)     │  │
│   │                  │    │                            │  │
│   │  - act           │    │  - TUI 交互界面            │  │
│   │  - sessions      │    │  - WebSocket 服务器        │  │
│   │  - tasks         │    │  - HTTP API               │  │
│   │  - config        │    │  - MCP 服务器              │  │
│   │  - logs          │    │                            │  │
│   │  - ...           │    │                            │  │
│   └─────────────────┘    └─────────────────────────────┘  │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐  │
│   │                  @roy-bot/core                      │  │
│   │                  (核心 SDK)                           │  │
│   └─────────────────────────────────────────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. 包结构

### 2.1 目录结构

```
@roy-bot/cli
├── src/
│   ├── cli.ts                      # 主入口 (yargs 配置)
│   │
│   ├── bin/
│   │   └── roy.ts                  # bin 入口 (shebang)
│   │
│   ├── commands/                   # 子命令（非交互式）
│   │   ├── act.ts                 # 自然语言交互（核心命令）
│   │   ├── sessions.ts            # 会话管理
│   │   ├── tasks.ts               # 任务管理
│   │   ├── prompts.ts             # 提示词管理
│   │   ├── agents.ts              # Agent 管理
│   │   ├── memory.ts              # 记忆管理
│   │   ├── tools.ts               # 工具管理
│   │   ├── skills.ts              # 技能管理
│   │   ├── config.ts              # 配置管理
│   │   ├── logs.ts                # 日志管理
│   │   ├── env.ts                 # 环境管理
│   │   ├── version.ts             # 版本信息
│   │   └── capabilities.ts        # 能力列表
│   │
│   ├── components/                 # 共享组件
│   │   ├── output.ts              # 输出格式化
│   │   └── formatters.ts          # 格式化工具
│   │
│   ├── hooks/                     # 生命周期钩子
│   │   ├── global-options.ts      # 全局选项
│   │   └── error-handler.ts       # 错误处理
│   │
│   ├── services/                  # 服务层
│   │   ├── environment.service.ts # Environment 封装
│   │   ├── config.service.ts      # 配置服务
│   │   └── output.service.ts      # 输出服务
│   │
│   └── utils/
│       ├── config-loader.ts        # 配置加载
│       └── env-detector.ts         # 环境检测
│
├── package.json
├── tsconfig.json
└── README.md
```

### 2.2 依赖关系

```json
{
  "name": "@roy-bot/cli",
  "version": "1.0.0",
  "description": "CLI for roy-bot - Non-interactive command execution",
  "bin": {
    "roy": "./dist/bin/roy.js"
  },
  "main": "./dist/index.js",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.ts",
  "dependencies": {
    "@roy-bot/core": "workspace:*",
    "yargs": "^17.7.2",
    "chalk": "^5.3.0"
  },
  "devDependencies": {
    "typescript": "^5.3.0"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

**注意**：
- 不依赖 `@roy-bot/coder`（coder 相关能力由 server-tui 包提供）
- 不使用 ora（加载动画是交互式的）
- 不使用 inquirer（交互提示是交互式的）

---

## 3. 命令设计

### 3.1 主命令 (roy)

```typescript
// cli.ts - 主入口配置
const CLI_USAGE = `
roy - 智能化操作系统命令行工具

使用方法:
  roy [command] [options]

命令:
  roy act [msg]    自然语言交互（核心命令）
  roy sessions     会话管理
  roy tasks        任务管理
  roy prompts      提示词管理
  roy agents       Agent 管理
  roy memory       记忆管理
  roy tools        工具管理
  roy skills       技能管理
  roy config       配置管理
  roy logs         日志管理
  roy env          环境管理
  roy version      显示版本信息
  roy capabilities 列出所有能力

示例:
  roy act "帮我写一个 hello world"
  roy act "继续上次任务" --continue
  roy sessions list
  roy tasks list --status active
  roy config get llm.provider

查看帮助:
  roy --help
  roy act --help
`;
```

### 3.2 核心命令：act

`act` 是整个 CLI 的核心命令，提供自然语言交互能力。

```typescript
// commands/act.ts
interface ActOptions {
  message?: string;          // 要执行的消息
  continue?: boolean;        // 继续上次会话
  session?: string;         // 指定会话 ID
  model?: string;           // 使用的模型
  env?: string;             // 使用的环境名称
  quiet?: boolean;           // 安静模式
  reasoning?: boolean;      // 显示思考过程
  toolCalls?: boolean;      // 显示工具调用
  toolResults?: boolean;    // 显示工具结果
}

export const ActCommand: CommandModule<{}, ActOptions> = {
  command: "act [message]",
  describe: "自然语言交互 - 通过自然语言驱动整个操作系统",
  
  builder: (yargs) => yargs
    .positional("message", {
      describe: "要执行的消息",
      type: "string",
    })
    .option("continue", {
      alias: "c",
      describe: "继续上次会话",
      type: "boolean",
      default: false,
    })
    .option("session", {
      alias: "s",
      describe: "指定会话 ID",
      type: "string",
    })
    .option("model", {
      describe: "使用的模型",
      type: "string",
    })
    .option("env", {
      alias: "e",
      describe: "使用的环境名称",
      type: "string",
    })
    .option("quiet", {
      alias: "q",
      describe: "安静模式：只输出最终结果",
      type: "boolean",
      default: false,
    })
    .option("reasoning", {
      alias: "r",
      describe: "显示 AI 思考过程",
      type: "boolean",
      default: false,
    })
    .option("tool-calls", {
      describe: "显示工具调用",
      type: "boolean",
      default: false,
    })
    .option("tool-results", {
      describe: "显示工具执行结果",
      type: "boolean",
      default: false,
    }),
    
  async handler(args) {
    // 实现逻辑...
  }
};
```

### 3.3 会话命令：sessions

```typescript
// commands/sessions.ts
interface SessionsOptions {
  list?: boolean;        // 列出所有会话
  show?: string;         // 显示会话详情
  delete?: string;       // 删除会话
  compact?: string;      // 压缩会话
}

export const SessionsCommand: CommandModule<{}, SessionsOptions> = {
  command: "sessions [action]",
  describe: "会话管理 - 列出、查看、删除会话",
  
  builder: (yargs) => yargs
    .positional("action", {
      describe: "操作类型: list, show, delete, compact",
      type: "string",
    })
    .option("list", {
      alias: "l",
      describe: "列出所有会话",
      type: "boolean",
      default: false,
    })
    .option("show", {
      alias: "s",
      describe: "显示会话详情",
      type: "string",
    })
    .option("delete", {
      alias: "d",
      describe: "删除指定会话",
      type: "string",
    })
    .option("compact", {
      alias: "c",
      describe: "压缩指定会话",
      type: "string",
    }),
    
  async handler(args) {
    // 实现逻辑...
  }
};
```

### 3.4 任务命令：tasks

```typescript
// commands/tasks.ts
interface TasksOptions {
  list?: boolean;       // 列出任务
  show?: string;         // 显示任务详情
  add?: string;          // 添加任务
  update?: string;       // 更新任务
  delete?: string;       // 删除任务
  complete?: string;     // 完成任务
  status?: string;       // 任务状态筛选
  priority?: string;     // 优先级筛选
}

export const TasksCommand: CommandModule<{}, TasksOptions> = {
  command: "tasks [action]",
  describe: "任务管理 - 创建、追踪、管理任务",
  
  builder: (yargs) => yargs
    .positional("action", {
      describe: "操作类型",
      type: "string",
    })
    .option("list", {
      alias: "l",
      describe: "列出所有任务",
      type: "boolean",
      default: false,
    })
    .option("add", {
      alias: "a",
      describe: "添加新任务",
      type: "string",
    })
    .option("show", {
      alias: "s",
      describe: "显示任务详情",
      type: "string",
    })
    .option("update", {
      alias: "u",
      describe: "更新任务",
      type: "string",
    })
    .option("delete", {
      alias: "d",
      describe: "删除任务",
      type: "string",
    })
    .option("complete", {
      describe: "完成任务",
      type: "string",
    })
    .option("status", {
      describe: "按状态筛选",
      type: "string",
      choices: ["todo", "active", "completed", "paused", "cancelled"],
    })
    .option("priority", {
      describe: "按优先级筛选",
      type: "string",
      choices: ["low", "medium", "high"],
    }),
    
  async handler(args) {
    // 实现逻辑...
  }
};
```

### 3.5 配置命令：config

```typescript
// commands/config.ts
interface ConfigOptions {
  get?: string;          // 获取配置项
  set?: string;          // 设置配置项
  list?: boolean;        // 列出所有配置
  edit?: boolean;        // 编辑配置文件
  env?: string;          // 指定环境
}

export const ConfigCommand: CommandModule<{}, ConfigOptions> = {
  command: "config [action]",
  describe: "配置管理 - 查看、修改配置",
  
  builder: (yargs) => yargs
    .option("get", {
      alias: "g",
      describe: "获取配置项",
      type: "string",
    })
    .option("set", {
      alias: "s",
      describe: "设置配置项 (key=value)",
      type: "string",
    })
    .option("list", {
      alias: "l",
      describe: "列出所有配置",
      type: "boolean",
      default: false,
    })
    .option("edit", {
      alias: "e",
      describe: "打开配置文件编辑器",
      type: "boolean",
      default: false,
    })
    .option("env", {
      alias: "E",
      describe: "指定环境名称",
      type: "string",
    }),
    
  async handler(args) {
    // 实现逻辑...
  }
};
```

### 3.6 日志命令：logs

```typescript
// commands/logs.ts
interface LogsOptions {
  list?: boolean;        // 列出日志文件
  show?: string;          // 查看日志内容
  search?: string;        // 搜索日志
  requestId?: string;     // 按请求 ID 筛选
  level?: string;         // 按级别筛选
  clear?: boolean;        // 清理日志
}

export const LogsCommand: CommandModule<{}, LogsOptions> = {
  command: "logs [action]",
  describe: "日志管理 - 查看、搜索、清理日志",
  
  builder: (yargs) => yargs
    .option("list", {
      alias: "l",
      describe: "列出日志文件",
      type: "boolean",
      default: false,
    })
    .option("show", {
      alias: "s",
      describe: "查看日志内容",
      type: "string",
    })
    .option("search", {
      alias: "S",
      describe: "搜索日志关键词",
      type: "string",
    })
    .option("request-id", {
      describe: "按请求 ID 筛选",
      type: "string",
    })
    .option("level", {
      describe: "按日志级别筛选",
      type: "string",
      choices: ["debug", "info", "warn", "error"],
    })
    .option("clear", {
      describe: "清理日志",
      type: "boolean",
      default: false,
    }),
    
  async handler(args) {
    // 实现逻辑...
  }
};
```

### 3.7 其他命令

| 命令 | 描述 | 核心选项 |
|------|------|----------|
| `prompts` | 提示词管理 | list, show, add, edit, delete |
| `agents` | Agent 管理 | list, show, inspect |
| `memory` | 记忆管理 | list, search, write, delete |
| `tools` | 工具管理 | list, show, inspect |
| `skills` | 技能管理 | list, show, load, unload |
| `env` | 环境管理 | list, create, delete, use |
| `version` | 版本信息 | - |
| `capabilities` | 能力列表 | --json |

---

## 4. 核心服务

### 4.1 EnvironmentService

直接使用 `@roy-bot/core` 中的 `BaseEnvironment`，注册核心组件实现功能。

```typescript
// services/environment.service.ts
import { 
  BaseEnvironment, 
  ConfigComponent,
  SessionComponent,
  TaskComponent,
  MemoryComponent,
  AgentComponent,
  LLMComponent,
  ToolComponent,
  LogTraceComponent,
} from "@roy-bot/core";

export class EnvironmentService {
  private environment: BaseEnvironment | null = null;
  
  /**
   * 创建 CLI 环境
   */
  async create(options?: {
    workDir?: string;
    envName?: string;
  }): Promise<BaseEnvironment> {
    // 1. 创建 BaseEnvironment
    const env = new BaseEnvironment({
      name: options?.envName ?? "roy-cli",
      version: "1.0.0",
    });
    
    // 2. 创建并注册核心组件
    const configComponent = new ConfigComponent({ basePath: options?.workDir ?? process.cwd() });
    const sessionComponent = new SessionComponent();
    const taskComponent = new TaskComponent();
    const memoryComponent = new MemoryComponent();
    const agentComponent = new AgentComponent();
    const llmComponent = new LLMComponent();
    const toolComponent = new ToolComponent();
    const logTraceComponent = new LogTraceComponent();
    
    env.registerComponent(configComponent);
    env.registerComponent(sessionComponent);
    env.registerComponent(taskComponent);
    env.registerComponent(memoryComponent);
    env.registerComponent(agentComponent);
    env.registerComponent(llmComponent);
    env.registerComponent(toolComponent);
    env.registerComponent(logTraceComponent);
    
    // 3. 初始化环境
    await env.init();
    
    this.environment = env;
    return env;
  }
  
  /**
   * 获取环境实例
   */
  getEnvironment(): BaseEnvironment {
    if (!this.environment) {
      throw new Error("Environment not initialized. Call create() first.");
    }
    return this.environment;
  }
  
  /**
   * 获取组件便捷方法
   */
  getSession(): SessionComponent {
    return this.environment!.getComponent("session") as SessionComponent;
  }
  
  getTask(): TaskComponent {
    return this.environment!.getComponent("task") as TaskComponent;
  }
  
  getAgent(): AgentComponent {
    return this.environment!.getComponent("agent") as AgentComponent;
  }
  
  getConfig(): ConfigComponent {
    return this.environment!.getComponent("config") as ConfigComponent;
  }
  
  /**
   * 销毁环境
   */
  async dispose(): Promise<void> {
    await this.environment?.stop();
    this.environment = null;
  }
}
```

### 4.2 OutputService

统一的输出格式化服务（非交互式）。

```typescript
// services/output.service.ts
export class OutputService {
  private quiet: boolean = false;
  private json: boolean = false;
  
  configure(options: {
    quiet?: boolean;
    json?: boolean;
  }): void {
    this.quiet = options.quiet ?? this.quiet;
    this.json = options.json ?? this.json;
  }
  
  /**
   * 输出普通消息
   */
  info(message: string): void {
    if (!this.quiet) console.log(message);
  }
  
  /**
   * 输出成功消息
   */
  success(message: string): void {
    if (!this.quiet) console.log(chalk.green("✓ ") + message);
  }
  
  /**
   * 输出警告消息
   */
  warn(message: string): void {
    if (!this.quiet) console.warn(chalk.yellow("⚠ ") + message);
  }
  
  /**
   * 输出错误消息
   */
  error(message: string): void {
    console.error(chalk.red("✗ ") + message);
  }
  
  /**
   * 格式化 JSON 输出
   */
  json(data: unknown, pretty: boolean = true): void {
    console.log(JSON.stringify(data, null, pretty ? 2 : 0));
  }
  
  /**
   * 简单表格输出（无交互）
   */
  table(data: Record<string, unknown>[], columns: { key: string; header: string }[]): void {
    // 简单实现，用于脚本集成
  }
}
```

### 4.3 ConfigService

配置加载和管理服务。

```typescript
// services/config.service.ts
export class ConfigService {
  private config: ConfigComponent | null = null;
  
  /**
   * 加载配置
   */
  async load(options?: {
    envName?: string;
    workDir?: string;
  }): Promise<ConfigComponent> {
    // 1. 查找环境路径
    const envPath = await this.findEnvironmentPath(options?.envName);
    
    // 2. 创建配置组件
    this.config = new ConfigComponent({
      basePath: envPath,
    });
    
    // 3. 注册配置源
    this.config.registerSource({
      type: "file",
      path: "config.jsonc",
      optional: true,
    });
    
    this.config.registerSource({
      type: "env",
      prefix: "ROY_",
    });
    
    // 4. 加载配置
    await this.config.init();
    
    return this.config;
  }
  
  /**
   * 获取配置值
   */
  get<T>(key: string, fallback?: T): T | undefined {
    return this.config?.get<T>(key) ?? fallback;
  }
  
  /**
   * 设置配置值
   */
  async set(key: string, value: unknown): Promise<void> {
    await this.config?.set(key, value);
  }
}
```

---

## 5. 生命周期钩子

### 5.1 全局选项

```typescript
// hooks/global-options.ts
export const globalOptions = {
  "--quiet": {
    alias: "-q",
    describe: "安静模式：只输出必要信息",
    type: "boolean",
  },
  "--json": {
    alias: "-j",
    describe: "JSON 输出格式",
    type: "boolean",
  },
  "--no-color": {
    describe: "禁用颜色输出",
    type: "boolean",
  },
  "--env": {
    alias: "-e",
    describe: "指定环境名称",
    type: "string",
  },
};
```

### 5.2 错误处理

```typescript
// hooks/error-handler.ts
export function setupErrorHandler(output: OutputService): void {
  process.on("uncaughtException", (error) => {
    output.error(`未捕获的异常: ${error.message}`);
    if (process.env.DEBUG) {
      console.error(error.stack);
    }
    process.exit(1);
  });
  
  process.on("unhandledRejection", (reason) => {
    output.error(`未处理的 Promise 拒绝: ${reason}`);
    process.exit(1);
  });
}
```

---

## 6. 实现计划

### 6.1 Phase 1: 基础框架

- [ ] 创建目录结构
- [ ] 配置 package.json
- [ ] 实现主入口 (cli.ts)
- [ ] 实现 bin 入口 (roy.ts)
- [ ] 实现全局选项钩子
- [ ] 实现错误处理钩子
- [ ] 实现 OutputService

### 6.2 Phase 2: 核心命令

- [ ] 实现 `act` 命令（自然语言交互）
- [ ] 实现 `sessions` 命令
- [ ] 实现 `tasks` 命令
- [ ] 实现 `config` 命令
- [ ] 实现 `version` 命令

### 6.3 Phase 3: 管理命令

- [ ] 实现 `prompts` 命令
- [ ] 实现 `agents` 命令
- [ ] 实现 `memory` 命令
- [ ] 实现 `tools` 命令
- [ ] 实现 `skills` 命令
- [ ] 实现 `logs` 命令

### 6.4 Phase 4: 辅助功能

- [ ] 实现 `env` 命令
- [ ] 实现 `capabilities` 命令
- [ ] 实现 ConfigService
- [ ] 实现 EnvironmentService

---

## 7. 使用示例

### 7.1 自然语言交互

```bash
# 直接执行任务
roy act "帮我写一个 hello world"

# 继续上次会话
roy act "继续上次任务" --continue

# 指定会话
roy act "继续" --session abc123

# 安静模式（只输出最终结果）
roy act "写一个冒泡排序" --quiet

# 显示工具调用过程
roy act "帮我分析代码" --tool-calls --tool-results
```

### 7.2 会话管理

```bash
# 列出所有会话
roy sessions list

# 显示会话详情
roy sessions show abc123

# 删除会话
roy sessions delete abc123

# 压缩会话
roy sessions compact abc123

# JSON 输出
roy sessions list --json
```

### 7.3 任务管理

```bash
# 列出任务
roy tasks list

# 添加任务
roy tasks add "完成代码审查" --priority high

# 完成任务
roy tasks complete 123

# 按状态筛选
roy tasks list --status active

# JSON 输出
roy tasks list --json
```

### 7.4 配置管理

```bash
# 列出所有配置
roy config list

# 获取配置项
roy config get llm.provider

# 设置配置项
roy config set llm.provider openai

# 指定环境
roy config list --env dev

# JSON 输出
roy config list --json
```

### 7.5 日志管理

```bash
# 列出日志文件
roy logs list

# 查看日志
roy logs show app.log

# 搜索日志
roy logs search "error" --level error

# JSON 输出
roy logs list --json
```

---

## 8. 技术选型

| 技术 | 选型 | 原因 |
|------|------|------|
| CLI 框架 | yargs | 功能完善，TypeScript 支持好 |
| 颜色输出 | chalk | 简洁易用 |

**注意**：不引入交互式库（ora、inquirer 等），保持 CLI 的非交互特性。

---

## 9. 注意事项

1. **非交互式设计**：所有操作通过命令行参数完成，适合脚本集成
2. **JSON 输出支持**：每个命令都支持 `--json` 参数，方便程序解析
3. **安静模式**：支持 `--quiet` 参数，只输出必要信息
4. **错误处理**：所有命令都需要捕获并友好展示错误
5. **环境初始化顺序**：必须先初始化 ConfigComponent，再初始化其他组件
6. **运行时要求**：由于使用 ESM 模块系统，需要使用 bun 运行：
   - 开发：`bun run src/bin/roy.ts`
   - 或 `bun run cli`（已配置 npm script）
   - 生产：使用 `bun build` 打包后可直接运行
