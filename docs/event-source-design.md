# Event Source Component & Command 实现方案

## 1. 背景与目标

### 1.1 当前架构分析

#### roy-bot 现有组件系统
- **Component 基类**：`BaseComponent` 提供生命周期管理、Hook 系统、配置管理
- **Event 系统**：`EnvEvent` 统一事件格式，`subscribeAll`/`pushEnvEvent` 事件总线
- **ToolComponent**：工具注册和执行的标准模式

#### lark-cli event subscribe 机制
```bash
lark-cli event +subscribe
# 通过 WebSocket 接收飞书事件
# 输出 NDJSON 格式事件流
```

#### Interactive 命令的事件处理
```typescript
// EventHandler 订阅事件，格式化后触发 agent
eventHandler = new EventHandler({
  env,
  eventTypes: ["task.*"],
  isIdle: () => repl.isIdle(),
  onEvent: async (message) => {
    await repl.handleEventMessage(message);  // 作为用户输入处理
  },
});
```

### 1.2 目标
1. **Event Source Component**：抽象事件源，支持 lark-cli、WebSocket、定时器等
2. **Event Source Command**：管理事件源生命周期
3. **后台进程模式**：start 启动后台进程
4. **Interactive 集成**：事件转为 agent 输入

---

## 2. 设计方案

### 2.1 核心类型定义

```typescript
// src/env/event-source/types.ts

/**
 * EventSource 状态
 */
export type EventSourceStatus = 
  | "created"    // 已创建
  | "starting"   // 启动中
  | "running"    // 运行中
  | "stopping"   // 停止中
  | "stopped"    // 已停止
  | "error";     // 错误状态

/**
 * EventSource 类型
 */
export type EventSourceType = 
  | "lark-cli"        // 飞书 CLI 事件源
  | "websocket"        // WebSocket 事件源
  | "timer"            // 定时器事件源
  | "http-webhook"     // HTTP Webhook 事件源
  | "file-watcher";    // 文件监听事件源

/**
 * EventSource 配置
 */
export interface EventSourceConfig {
  /** 事件源 ID */
  id: string;
  /** 事件源名称 */
  name: string;
  /** 事件源类型 */
  type: EventSourceType;
  /** 是否启用 */
  enabled: boolean;
  /** 事件类型过滤（支持通配符） */
  eventTypes?: string[];
  /** 轮询间隔（毫秒，定时器用） */
  interval?: number;
  /** cron 表达式（定时器用） */
  cron?: string;
  /** 命令参数（lark-cli 用） */
  command?: string;
  /** WebSocket URL */
  url?: string;
  /** WebSocket headers */
  headers?: Record<string, string>;
  /** 自定义选项 */
  options?: Record<string, unknown>;
}

/**
 * EventSource 事件负载
 */
export interface EventSourceEventPayload {
  /** 事件源 ID */
  sourceId: string;
  /** 事件源类型 */
  sourceType: EventSourceType;
  /** 原始事件数据 */
  rawEvent: unknown;
  /** 处理后的消息 */
  message: string;
  /** 时间戳 */
  timestamp: number;
}

/**
 * EventSource 事件
 */
export interface EventSourceEvent {
  /** 事件源 ID */
  sourceId: string;
  /** 事件类型 */
  type: string;
  /** 时间戳 */
  timestamp: number;
  /** 事件负载 */
  payload: EventSourceEventPayload;
}
```

### 2.2 EventSourceComponent 接口

```typescript
// src/env/event-source/event-source-component.ts

import { BaseComponent } from "../component";
import type { EventSourceConfig, EventSourceStatus, EventSourceEvent } from "./types";

/**
 * EventSourceComponent
 * 
 * 事件源组件，管理所有事件源的注册、配置和生命周期
 */
export class EventSourceComponent extends BaseComponent {
  readonly name = "event-source";
  readonly version = "1.0.0";

  // 内部状态
  private sources: Map<string, EventSourceConfig> = new Map();
  private statuses: Map<string, EventSourceStatus> = new Map();
  private processes: Map<string, ChildProcess> = new Map();
  private handlers: Map<string, (event: EventSourceEvent) => void | Promise<void>> = new Map();
  private subscriptions: Map<string, () => void> = new Map();

  /**
   * 注册事件源
   */
  register(config: EventSourceConfig): void {
    if (this.sources.has(config.id)) {
      throw new Error(`EventSource already exists: ${config.id}`);
    }
    this.sources.set(config.id, config);
    this.statuses.set(config.id, "created");
  }

  /**
   * 注销事件源
   */
  unregister(id: string): boolean {
    const status = this.statuses.get(id);
    if (status === "running") {
      this.stop(id);  // 自动停止
    }
    this.sources.delete(id);
    this.statuses.delete(id);
    return true;
  }

  /**
   * 获取事件源配置
   */
  get(id: string): EventSourceConfig | undefined {
    return this.sources.get(id);
  }

  /**
   * 列出所有事件源
   */
  list(): EventSourceConfig[] {
    return Array.from(this.sources.values());
  }

  /**
   * 获取事件源状态
   */
  getStatus(id: string): EventSourceStatus | undefined {
    return this.statuses.get(id);
  }

  /**
   * 启动事件源（后台进程）
   */
  async start(id: string): Promise<void> {
    const config = this.sources.get(id);
    if (!config) {
      throw new Error(`EventSource not found: ${id}`);
    }

    const currentStatus = this.statuses.get(id);
    if (currentStatus === "running") {
      return;  // 已运行
    }

    this.statuses.set(id, "starting");

    try {
      switch (config.type) {
        case "lark-cli":
          await this.startLarkCli(id, config);
          break;
        case "timer":
          await this.startTimer(id, config);
          break;
        case "websocket":
          await this.startWebSocket(id, config);
          break;
        default:
          throw new Error(`Unsupported event source type: ${config.type}`);
      }

      this.statuses.set(id, "running");
      
      // 发布事件
      this.getEnv()?.pushEnvEvent({
        type: "event-source.started",
        payload: { sourceId: id, sourceType: config.type },
      });

    } catch (error) {
      this.statuses.set(id, "error");
      throw error;
    }
  }

  /**
   * 停止事件源
   */
  async stop(id: string): Promise<void> {
    const status = this.statuses.get(id);
    if (status !== "running") {
      return;
    }

    this.statuses.set(id, "stopping");

    // 停止进程
    const process = this.processes.get(id);
    if (process) {
      process.kill();
      this.processes.delete(id);
    }

    // 取消订阅
    const unsubscribe = this.subscriptions.get(id);
    if (unsubscribe) {
      unsubscribe();
      this.subscriptions.delete(id);
    }

    this.statuses.set(id, "stopped");

    // 发布事件
    const config = this.sources.get(id);
    this.getEnv()?.pushEnvEvent({
      type: "event-source.stopped",
      payload: { sourceId: id, sourceType: config?.type },
    });
  }

  /**
   * 启动 lark-cli 事件源
   */
  private async startLarkCli(id: string, config: EventSourceConfig): Promise<void> {
    const command = config.command || "lark-cli event +subscribe";
    
    // 启动子进程
    const child = spawn("sh", ["-c", command], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.processes.set(id, child);

    // 处理输出流
    let buffer = "";
    child.stdout?.on("data", (data: Buffer) => {
      buffer += data.toString();
      
      // 按行处理 NDJSON
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";  // 保留未完成行
      
      for (const line of lines) {
        if (line.trim()) {
          this.handleEvent(id, line);
        }
      }
    });

    // 处理错误流
    child.stderr?.on("data", (data: Buffer) => {
      console.error(`[EventSource ${id}] stderr:`, data.toString());
    });

    // 进程退出处理
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        console.error(`[EventSource ${id}] exited with code ${code}`);
        this.statuses.set(id, "error");
      }
    });
  }

  /**
   * 启动定时器事件源
   */
  private async startTimer(id: string, config: EventSourceConfig): Promise<void> {
    const interval = config.interval || 60000;  // 默认 1 分钟
    
    // 创建定时器
    const timer = setInterval(() => {
      const message = config.options?.message || `Timer event from ${config.name}`;
      this.handleEvent(id, JSON.stringify({
        type: "timer.tick",
        payload: {
          message,
          timestamp: Date.now(),
        },
      }));
    }, interval);

    // 保存定时器引用
    this.subscriptions.set(id, () => clearInterval(timer));
  }

  /**
   * 处理事件
   */
  private handleEvent(sourceId: string, rawData: string): void {
    const config = this.sources.get(sourceId);
    if (!config) return;

    try {
      // 解析事件
      const rawEvent = JSON.parse(rawData);
      const eventType = rawEvent.schema ? `lark.${rawEvent.schema}` : "lark.event";
      
      // 检查事件类型过滤
      if (config.eventTypes?.length && !this.matchEventType(eventType, config.eventTypes)) {
        return;
      }

      // 格式化消息
      const message = this.formatEventMessage(config.type, rawEvent);

      // 创建事件对象
      const event: EventSourceEvent = {
        sourceId,
        type: eventType,
        timestamp: Date.now(),
        payload: {
          sourceId,
          sourceType: config.type,
          rawEvent,
          message,
          timestamp: Date.now(),
        },
      };

      // 调用处理器
      const handler = this.handlers.get(sourceId);
      if (handler) {
        handler(event);
      }

      // 发布到环境事件总线
      this.getEnv()?.pushEnvEvent({
        type: `event-source.event.${config.type}`,
        payload: event,
      });

    } catch (error) {
      console.error(`[EventSource ${sourceId}] Failed to handle event:`, error);
    }
  }

  /**
   * 事件类型匹配（支持通配符）
   */
  private matchEventType(eventType: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
      if (pattern === "*") return true;
      if (pattern.endsWith(".*")) {
        const prefix = pattern.slice(0, -2);
        if (eventType.startsWith(prefix)) return true;
      }
      if (eventType === pattern) return true;
    }
    return false;
  }

  /**
   * 格式化事件消息
   */
  private formatEventMessage(sourceType: EventSourceType, rawEvent: unknown): string {
    const event = rawEvent as Record<string, unknown>;
    
    switch (sourceType) {
      case "lark-cli":
        // 提取消息内容
        if (event.message_id) {
          return `[飞书消息] ${event.sender?.sender_id?.open_id || "未知用户"}: ${event.text || event.content || ""}`;
        }
        return `[飞书事件] ${event.schema || "unknown"}`;

      case "timer":
        return `[定时任务] ${event.message || "tick"}`;

      default:
        return `[${sourceType}] ${JSON.stringify(rawEvent)}`;
    }
  }

  /**
   * 设置事件处理器
   */
  onEvent(id: string, handler: (event: EventSourceEvent) => void | Promise<void>): void {
    this.handlers.set(id, handler);
  }

  /**
   * 持久化配置
   */
  async saveConfig(): Promise<void> {
    // 保存到配置文件
    const configs = Array.from(this.sources.values());
    // ... 实现持久化逻辑
  }

  /**
   * 加载配置
   */
  async loadConfig(): Promise<void> {
    // 从配置文件加载
    // ... 实现加载逻辑
  }
}
```

### 2.3 Event Source Command

```typescript
// src/commands/eventsource/index.ts

import { CommandModule } from "yargs";
import { EventSourceListCommand } from "./list";
import { EventSourceAddCommand } from "./add";
import { EventSourceRemoveCommand } from "./remove";
import { EventSourceStartCommand } from "./start";
import { EventSourceStopCommand } from "./stop";
import { EventSourceStatusCommand } from "./status";

/**
 * EventSource Command
 * 
 * 事件源管理命令
 */
export const EventSourceCommand: CommandModule = {
  command: "eventsource",
  aliases: ["es", "event-source"],
  describe: "事件源管理 - 添加、启动、停止各种事件源",

  builder: (yargs) =>
    yargs
      .command(EventSourceListCommand)
      .command(EventSourceAddCommand)
      .command(EventSourceRemoveCommand)
      .command(EventSourceStartCommand)
      .command(EventSourceStopCommand)
      .command(EventSourceStatusCommand)
      .demandCommand()
      .help(),

  handler: () => {
    console.log("Use 'roy eventsource --help' for usage information");
  },
};
```

```typescript
// src/commands/eventsource/list.ts

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { EventSourceComponent } from "@ai-setting/roy-bot-core";

interface ListOptions {
  json?: boolean;
  quiet?: boolean;
  config?: string;
}

export const EventSourceListCommand: CommandModule<object, ListOptions> = {
  command: "list",
  aliases: ["ls"],
  describe: "列出所有事件源",

  builder: (yargs) =>
    yargs
      .option("json", { alias: "j", type: "boolean", default: false })
      .option("quiet", { alias: "q", type: "boolean", default: false }),

  async handler(args) {
    const output = new OutputService();
    const envService = new EnvironmentService(output);

    try {
      await envService.create({ configPath: args.config });
      const env = envService.getEnvironment();
      const esComponent = env.getComponent("event-source") as EventSourceComponent | undefined;

      if (!esComponent) {
        output.error("EventSourceComponent not available");
        process.exit(1);
      }

      const sources = esComponent.list();

      if (args.json) {
        output.json({ sources, count: sources.length });
        return;
      }

      if (sources.length === 0) {
        output.log("No event sources configured. Use 'roy eventsource add' to add one.");
        return;
      }

      // 表格输出
      const rows = sources.map((s) => {
        const status = esComponent.getStatus(s.id) || "unknown";
        const statusColor = {
          running: chalk.green,
          stopped: chalk.gray,
          error: chalk.red,
          starting: chalk.yellow,
        }[status] || chalk.gray;

        return {
          id: s.id,
          name: s.name,
          type: s.type,
          status: statusColor(status),
          enabled: s.enabled ? chalk.green("✓") : chalk.gray("✗"),
        };
      });

      output.log([
        `┌─ Event Sources ${"─".repeat(40)}┐`,
        `│ ID       │ Name          │ Type      │ Status   │ Enabled │`,
        `├${"─".repeat(62)}┤`,
        ...rows.map((r) => 
          `│ ${r.id.padEnd(8)} │ ${r.name.padEnd(13)} │ ${r.type.padEnd(9)} │ ${r.status.padEnd(8)} │ ${r.enabled} │`
        ),
        "└" + "─".repeat(62) + "┘",
        "",
        chalk.gray(`Total: ${sources.length} event sources`),
      ].join("\n"));

    } finally {
      await envService.dispose();
    }
  },
};
```

```typescript
// src/commands/eventsource/add.ts

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import { v4 as uuid } from "uuid";
import type { EventSourceComponent, EventSourceType } from "@ai-setting/roy-bot-core";

interface AddOptions {
  name: string;
  type: EventSourceType;
  "event-types"?: string;
  "command"?: string;
  "url"?: string;
  interval?: number;
  cron?: string;
  config?: string;
}

export const EventSourceAddCommand: CommandModule<object, AddOptions> = {
  command: "add <name> <type>",
  describe: "添加新的事件源",

  builder: (yargs) =>
    yargs
      .positional("name", { type: "string", demandOption: true })
      .positional("type", { 
        type: "string", 
        demandOption: true,
        choices: ["lark-cli", "websocket", "timer", "http-webhook", "file-watcher"],
      })
      .option("event-types", { 
        type: "string", 
        description: "逗号分隔的事件类型过滤（支持通配符）" 
      })
      .option("command", { 
        type: "string", 
        description: "执行的命令（lark-cli 类型）" 
      })
      .option("url", { 
        type: "string", 
        description: "WebSocket URL" 
      })
      .option("interval", { 
        type: "number", 
        description: "定时器间隔（毫秒）" 
      })
      .option("cron", { 
        type: "string", 
        description: "Cron 表达式" 
      }),

  async handler(args) {
    const output = new OutputService();
    const envService = new EnvironmentService(output);

    try {
      await envService.create({ configPath: args.config });
      const env = envService.getEnvironment();
      const esComponent = env.getComponent("event-source") as EventSourceComponent | undefined;

      if (!esComponent) {
        output.error("EventSourceComponent not available");
        process.exit(1);
      }

      // 解析事件类型
      const eventTypes = args["event-types"]?.split(",").map(s => s.trim());

      // 构建配置
      const config = {
        id: uuid(),
        name: args.name,
        type: args.type,
        enabled: true,
        eventTypes,
        command: args.command,
        url: args.url,
        interval: args.interval,
        cron: args.cron,
      };

      // 注册
      esComponent.register(config);

      // 持久化
      await esComponent.saveConfig();

      output.success(chalk.green(`Event source '${args.name}' added successfully!`));
      output.log(`  ID: ${config.id}`);
      output.log(`  Type: ${args.type}`);
      output.log("");
      output.log(`Use 'roy eventsource start ${config.id}' to start it.`);

    } finally {
      await envService.dispose();
    }
  },
};
```

```typescript
// src/commands/eventsource/start.ts

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";

interface StartOptions {
  id: string;
  config?: string;
  "background"?: boolean;
}

export const EventSourceStartCommand: CommandModule<object, StartOptions> = {
  command: "start <id>",
  describe: "启动指定的事件源",

  builder: (yargs) =>
    yargs
      .positional("id", { type: "string", demandOption: true })
      .option("background", { 
        alias: "b", 
        type: "boolean", 
        default: false,
        description: "后台运行" 
      }),

  async handler(args) {
    const output = new OutputService();
    const envService = new EnvironmentService(output);

    try {
      await envService.create({ configPath: args.config });
      const env = envService.getEnvironment();
      const esComponent = env.getComponent("event-source") as any;

      if (!esComponent) {
        output.error("EventSourceComponent not available");
        process.exit(1);
      }

      const source = esComponent.get(args.id);
      if (!source) {
        output.error(`Event source not found: ${args.id}`);
        process.exit(1);
      }

      output.info(`Starting event source '${source.name}'...`);

      await esComponent.start(args.id);

      output.success(chalk.green(`Event source '${source.name}' started!`));
      
      if (!args.background) {
        output.log(chalk.gray("Press Ctrl+C to stop..."));
        
        // 等待信号
        await new Promise<void>((resolve) => {
          process.on("SIGINT", resolve);
          process.on("SIGTERM", resolve);
        });
      }

    } catch (error) {
      output.error(`Failed to start event source: ${error}`);
      process.exit(1);
    }
  },
};
```

### 2.4 Interactive 集成

```typescript
// 在 interactive.ts 中集成 EventSource

// 在启动 REPL 前初始化事件源
const esComponent = env.getComponent("event-source") as EventSourceComponent | undefined;

if (esComponent) {
  // 获取所有运行中的事件源
  const sources = esComponent.list();
  
  for (const source of sources) {
    if (source.enabled && esComponent.getStatus(source.id) === "stopped") {
      // 自动启动已配置的事件源
      await esComponent.start(source.id);
    }
    
    // 设置事件处理器
    esComponent.onEvent(source.id, async (event) => {
      // 检查是否空闲
      if (!repl.isIdle()) {
        // 队列等待
        eventHandler.enqueue(event.payload.message);
        return;
      }
      
      // 直接处理
      await repl.handleEventMessage(event.payload.message);
    });
  }
}
```

---

## 3. 实现计划

### 3.1 阶段一：核心框架

| 任务 | 文件 | 说明 |
|------|------|------|
| 类型定义 | `src/env/event-source/types.ts` | EventSourceConfig, EventSourceEvent 等 |
| Component 基类 | `src/env/event-source/event-source-component.ts` | 核心组件实现 |
| Component 注册 | `src/env/index.ts` | 注册到 Environment |
| 单元测试 | `src/env/event-source/*.test.ts` | 核心功能测试 |

### 3.2 阶段二：Command 实现

| 任务 | 文件 | 说明 |
|------|------|------|
| Command 入口 | `src/commands/eventsource/index.ts` | 命令聚合 |
| List 命令 | `src/commands/eventsource/list.ts` | 列出事件源 |
| Add 命令 | `src/commands/eventsource/add.ts` | 添加事件源 |
| Remove 命令 | `src/commands/eventsource/remove.ts` | 移除事件源 |
| Start 命令 | `src/commands/eventsource/start.ts` | 启动事件源 |
| Stop 命令 | `src/commands/eventsource/stop.ts` | 停止事件源 |
| Status 命令 | `src/commands/eventsource/status.ts` | 查看状态 |

### 3.3 阶段三：事件源实现

| 任务 | 说明 |
|------|------|
| lark-cli 事件源 | 启动子进程，解析 NDJSON |
| Timer 事件源 | setInterval 实现 |
| WebSocket 事件源 | WebSocket 连接 |

### 3.4 阶段四：Interactive 集成

| 任务 | 说明 |
|------|------|
| 自动启动 | 启动 Interactive 时自动启动已配置事件源 |
| 事件处理 | 将事件转为用户输入触发 agent |
| 后台模式 | 支持后台运行，不阻塞 REPL |

---

## 4. 使用示例

### 4.1 添加飞书事件源

```bash
# 添加飞书事件源
roy eventsource add my-lark lark-cli \
  --event-types "im.message.*,contact.*" \
  --command "lark-cli event +subscribe"

# 列出事件源
roy eventsource list

# 启动
roy eventsource start my-lark

# 或后台运行
roy eventsource start my-lark --background
```

### 4.2 添加定时器事件源

```bash
# 每分钟触发一次
roy eventsource add daily-check timer \
  --interval 60000 \
  --event-types "timer.tick"

# 启动
roy eventsource start daily-check --background
```

### 4.3 Interactive 模式

```bash
# 启动交互模式，自动启动已配置的事件源
roy interactive

# 在 Interactive 中会看到事件消息作为输入
> [飞书消息] 用户123: 你好
[AI 回复] 你好！有什么可以帮你的吗？

> [定时任务] 每日检查完成
[AI 回复] 好的，收到定时任务通知。
```

---

## 5. 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                     Interactive Command                      │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────┐   ┌─────────────┐   ┌────────────────────┐    │
│  │  REPL   │──▶│ EventHandler│──▶│  Agent (处理输入)   │    │
│  └─────────┘   └─────────────┘   └────────────────────┘    │
│                      ▲                                        │
│                      │ pushEnvEvent()                        │
├─────────────────────────────────────────────────────────────┤
│                    EventSourceComponent                      │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Event Sources:                                       │   │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐    │   │
│  │  │ lark-cli   │  │   timer    │  │ websocket  │    │   │
│  │  │  (子进程)   │  │ (setInterval)│ │  (ws连接)  │    │   │
│  │  └─────┬──────┘  └──────┬─────┘  └──────┬─────┘    │   │
│  │        │                │                │          │   │
│  │        └────────────────┼────────────────┘          │   │
│  │                         ▼                            │   │
│  │                  Event Pipeline                       │   │
│  │                  ┌─────────────┐                     │   │
│  │                  │ parse/filter│                     │   │
│  │                  │   format    │                     │   │
│  │                  └──────┬──────┘                     │   │
│  │                         │                            │   │
│  └─────────────────────────┼────────────────────────────┘   │
└─────────────────────────────┼────────────────────────────────┘
                              │
                    pushEnvEvent()
                              │
                              ▼
                    ┌─────────────────┐
                    │  Environment     │
                    │  (事件总线)       │
                    └─────────────────┘
```

---

## 6. 配置持久化

```yaml
# ~/.config/roy-bot/event-sources.yaml

eventSources:
  - id: "550e8400-e29b-41d4-a716-446655440000"
    name: "my-lark"
    type: "lark-cli"
    enabled: true
    eventTypes:
      - "im.message.*"
      - "contact.*"
    command: "lark-cli event +subscribe"

  - id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
    name: "daily-check"
    type: "timer"
    enabled: true
    interval: 60000
    options:
      message: "每日健康检查"
```

---

## 7. 未来扩展

1. **HTTP Webhook 事件源**：接收外部 HTTP POST 请求
2. **文件监听事件源**：监控文件变化
3. **MQTT 事件源**：支持 MQTT 协议
4. **事件源链式处理**：Filter → Transform → Route
5. **事件源集群**：分布式事件源管理
