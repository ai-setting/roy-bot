# Bounty 插件化架构设计方案

> Roy-Agent 与 AI-Agent-Bounty 整合方案

## 一、背景与目标

### 1.1 现状

当前存在两个独立项目：

| 项目 | 描述 | CLI |
|------|------|-----|
| `roy-bot` | AI Agent 操作系统框架 | `roy` |
| `ai-agent-bounty` | 赏金任务平台 | `bounty` |

bounty 已依赖 `@ai-setting/roy-bot-core` 和 `@ai-setting/roy-bot-cli`，但两者独立运行。

### 1.2 目标

| 目标 | 描述 | 优先级 |
|------|------|--------|
| **目标 1** | bounty 独立运行，拥有自己的 CLI 入口 | P0 |
| **目标 2** | bounty 复用 roy-cli 的命令（import + 组合） | P0 |
| **目标 3** | 通过 roy cli 加载 bounty 的增强功能（无独立入口） | P1 |

### 1.3 两种使用模式

```
模式 A: 独立运行
────────────────
npm install @ai-setting/roy-bot-cli
npm install @ai-setting/roy-bot-core
npm install @ai-setting/agent-bounty

roy act "hello"              # roy CLI
bounty agent register ...   # bounty CLI (独立入口)


模式 B: 通过 roy 加载 bounty 插件
────────────────────────────────────
npm install @ai-setting/roy-bot-cli
npm install @ai-setting/roy-bot-core
npm install @ai-setting/agent-bounty

roy act "hello"              # roy CLI (内置命令)
roy agent register ...      # bounty 命令 (通过插件加载)
```

---

## 二、架构设计

### 2.1 依赖关系图

```
                          ┌──────────────────────────────────────┐
                          │    @ai-setting/roy-bot-core         │
                          │    (纯 SDK，底层依赖)                  │
                          │                                      │
                          │  • BaseEnvironment                   │
                          │  • Component 系统                   │
                          │  • 内置组件                          │
                          │    - AgentComponent                  │
                          │    - ToolComponent                  │
                          │    - LLMComponent                   │
                          │    - SessionComponent               │
                          │    - TaskComponent                  │
                          │  • 导出类型和 API                    │
                          └──────────────────────────────────────┘
                                            ▲
                                            │ npm 依赖
                          ┌─────────────────┴─────────────────┐
                          │                                   │
┌─────────────────────────┴───────────┐       ┌───────────────┴─────────────────┐
│    @ai-setting/roy-bot-cli       │       │    @ai-setting/agent-bounty        │
│                                    │       │                                   │
│  • 依赖 core                       │       │  • 依赖 core                      │
│  • 主 CLI 入口                     │       │  • 插件实现 (可选独立入口)         │
│  • 内置命令                         │       │  • 导出插件协议                    │
│    - act                           │       │    - 命令扩展                      │
│    - interactive                   │       │    - 组件扩展                      │
│    - sessions                      │       │    - 环境钩子                      │
│    - tasks                         │       │                                   │
│    - commands                      │       │                                   │
│  • 插件发现和加载机制 (新增)        │       │                                   │
└────────────────────────────────────┘       └───────────────────────────────────┘
```

### 2.2 现有 Plugin 概念区分

roy-bot 中存在两种不同层次的 Plugin：

| 类型 | 定义位置 | 作用域 | 用途 |
|------|----------|--------|------|
| **AgentPlugin** | `core/src/env/agent/types.ts` | 单个 Agent 实例 | Hook 干预 Agent 执行流程 |
| **RoyCliPlugin** (新增) | `cli/src/plugin/` | 整个 CLI + Environment | 注册命令、组件、环境钩子 |

### 2.3 发布物结构（不变）

> **重要**：本方案**不改变**现有发布物结构和 build 模式，仅新增插件发现机制。

#### roy-bot 发布物

```
@ai-setting/roy-bot-core
├── dist/
│   └── index.js              # SDK bundle
├── src/
│   └── *.ts                 # 源码
└── package.json

@ai-setting/roy-bot-cli
├── dist/
│   ├── lib/                  # CLI library (供其他项目 import)
│   │   ├── commands/
│   │   ├── services/
│   │   └── index.js
│   ├── bin/
│   │   └── roy.js           # CLI 可执行入口
│   ├── roy-bot-*/         # 各平台可执行文件
│   │   └── bin/roy
│   └── index.js
├── src/
│   └── *.ts                 # 源码
└── package.json
```

#### ai-agent-bounty 发布物

```
@ai-setting/agent-bounty
├── dist/
│   ├── lib/                  # library
│   ├── bin/
│   │   └── bounty.js         # CLI 可执行入口 (目标1)
│   └── index.js
├── src/
│   └── *.ts                 # 源码
└── package.json
```

#### Build 模式（不变）

| 命令 | 说明 |
|------|------|
| `bun run build:core` | 构建 core 包 |
| `bun run build:cli:prod:single` | 构建当前平台的 CLI 可执行文件 |
| `bun run build:cli:prod` | 构建所有平台的 CLI 可执行文件 |

#### 新增内容

仅在源码层面新增插件发现机制，对发布物无影响：

```
roy-bot/packages/cli/src/
├── plugin/                  # 新增: 插件发现源码 (不发布)
│   ├── types.ts
│   ├── registry.ts
│   ├── discover.ts
│   ├── apply.ts
│   └── index.ts
└── ...

ai-agent-bounty/src/
├── plugin/                  # 新增: 插件实现源码
│   └── index.ts            # 导出 bountyPlugin
├── roy-plugin.js           # 新增: 插件入口文件 (发布)
└── ...
```

---

## 三、实现方案

### 3.1 目录结构

```
roy-bot/
├── packages/
│   ├── core/
│   │   └── src/
│   │       ├── env/
│   │       │   └── environment.ts    # 修改: 添加插件钩子
│   │       └── index.ts              # 修改: 导出插件相关类型
│   │
│   └── cli/
│       └── src/
│           ├── plugin/               # 新增: 插件系统
│           │   ├── types.ts          # 插件类型定义
│           │   ├── registry.ts       # 插件注册表
│           │   ├── discover.ts        # 插件发现机制
│           │   ├── apply.ts          # 应用插件到 yargs
│           │   └── index.ts
│           ├── commands/             # 现有命令
│           ├── cli.ts                # 修改: 集成插件
│           └── index.ts              # 修改: 导出命令
│
└── docs/
    └── plugin-architecture-design.md  # 本文档

ai-agent-bounty/
└── src/
    ├── bin/                          # 保留: 独立 CLI 入口 (目标1)
    │   └── bounty.ts
    │
    ├── plugin/                       # 新增: 插件实现
    │   ├── index.ts                 # 导出插件
    │   ├── types.ts                 # 插件类型 (继承 RoyCliPlugin)
    │   ├── commands/                 # 命令扩展
    │   │   ├── agent.ts
    │   │   ├── bounty.ts
    │   │   └── com.ts
    │   └── components/              # 组件扩展
    │       ├── agent/
    │       │   └── bounty-agent-component.ts
    │       └── mail/
    │           └── mail-component.ts
    │
    └── lib/                         # 现有服务 (保持不变)
        ├── agent/
        ├── bounty/
        ├── mail/
        └── storage/
```

### 3.2 RoyCliPlugin 协议定义

#### `roy-bot/packages/cli/src/plugin/types.ts`

```typescript
import type { CommandModule } from "yargs";
import type { Component } from "@ai-setting/roy-bot-core";

/**
 * 插件元信息
 */
export interface PluginInfo {
  name: string;
  version: string;
  description?: string;
}

/**
 * 插件组件定义
 */
export interface PluginComponentDefinition {
  name: string;
  component: new (...args: any[]) => Component;
  options?: Record<string, unknown>;
}

/**
 * CLI 命令定义
 */
export interface PluginCommandDefinition {
  command: CommandModule;
  default?: boolean;
}

/**
 * 环境钩子上下文
 */
export interface PluginEnvironmentContext {
  env: import("@ai-setting/roy-bot-core").BaseEnvironment;
}

/**
 * Roy CLI 插件接口
 * 
 * 用于扩展 roy-cli 的功能：
 * - 注册 CLI 命令
 * - 注册 Environment 组件
 * - 钩入 Environment 生命周期
 */
export interface RoyCliPlugin {
  readonly info: PluginInfo;
  
  /**
   * 获取插件提供的 CLI 命令
   */
  getCommands?(): PluginCommandDefinition[];
  
  /**
   * 获取插件提供的组件
   */
  getComponents?(): PluginComponentDefinition[];
  
  /**
   * Environment 初始化前调用
   */
  onBeforeInit?(ctx: PluginEnvironmentContext): void | Promise<void>;
  
  /**
   * Environment 初始化后调用
   */
  onAfterInit?(ctx: PluginEnvironmentContext): void | Promise<void>;
  
  /**
   * 优先级，数字越大越先加载
   */
  priority?: number;
}
```

#### `roy-bot/packages/cli/src/plugin/registry.ts`

```typescript
import type { RoyCliPlugin, PluginCommandDefinition, PluginComponentDefinition } from "./types";

/**
 * 插件注册表
 */
export class PluginRegistry {
  private plugins = new Map<string, RoyCliPlugin>();
  
  /**
   * 注册插件
   */
  register(plugin: RoyCliPlugin): void {
    if (this.plugins.has(plugin.info.name)) {
      throw new Error(`Plugin "${plugin.info.name}" is already registered`);
    }
    this.plugins.set(plugin.info.name, plugin);
  }
  
  /**
   * 注销插件
   */
  unregister(name: string): void {
    this.plugins.delete(name);
  }
  
  /**
   * 获取插件
   */
  get(name: string): RoyCliPlugin | undefined {
    return this.plugins.get(name);
  }
  
  /**
   * 获取所有已注册插件
   */
  getAll(): RoyCliPlugin[] {
    return Array.from(this.plugins.values())
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }
  
  /**
   * 获取所有插件提供的命令
   */
  getAllCommands(): PluginCommandDefinition[] {
    const commands: PluginCommandDefinition[] = [];
    for (const plugin of this.getAll()) {
      commands.push(...(plugin.getCommands?.() ?? []));
    }
    return commands;
  }
  
  /**
   * 获取所有插件提供的组件
   */
  getAllComponents(): PluginComponentDefinition[] {
    const components: PluginComponentDefinition[] = [];
    for (const plugin of this.getAll()) {
      components.push(...(plugin.getComponents?.() ?? []));
    }
    return components;
  }
}

/** 全局插件注册表 */
export const globalPluginRegistry = new PluginRegistry();
```

#### `roy-bot/packages/cli/src/plugin/discover.ts`

```typescript
import type { RoyCliPlugin } from "./types";
import { globalPluginRegistry } from "./registry";
import { glob } from "glob";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

/**
 * 插件包识别配置
 */
const PLUGIN_PATTERNS = [
  "@ai-setting/agent-*",
  "@roy-bot/plugin-*",
];

const PLUGIN_ENTRY_FILE = "roy-plugin.js";

/**
 * 插件包元信息 (package.json 中的字段)
 */
interface PackageRoyPluginMeta {
  name: string;
  version: string;
}

/**
 * 扫描 node_modules 发现已安装的插件
 */
export async function discoverPlugins(): Promise<void> {
  const nodeModules = process.env.NODE_PATH?.split(":") ?? [];
  
  for (const pattern of PLUGIN_PATTERNS) {
    for (const basePath of nodeModules) {
      try {
        const matches = await glob(pattern, {
          cwd: basePath,
          onlyDirectories: true,
        });
        
        for (const match of matches) {
          const pkgPath = join(basePath, match);
          await loadPlugin(pkgPath);
        }
      } catch {
        // 忽略扫描错误
      }
    }
  }
}

/**
 * 加载单个插件
 */
async function loadPlugin(pkgPath: string): Promise<void> {
  const pluginFile = join(pkgPath, PLUGIN_ENTRY_FILE);
  
  if (!existsSync(pluginFile)) {
    return;
  }
  
  try {
    const plugin = await import(pluginFile);
    
    if (plugin.default && isRoyCliPlugin(plugin.default)) {
      globalPluginRegistry.register(plugin.default);
      console.log(`[roy] Loaded plugin: ${plugin.default.info.name}`);
    }
  } catch (err) {
    console.warn(`[roy] Failed to load plugin from ${pkgPath}:`, err);
  }
}

/**
 * 类型守卫
 */
function isRoyCliPlugin(obj: unknown): obj is RoyCliPlugin {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "info" in obj &&
    typeof (obj as any).info.name === "string"
  );
}
```

#### `roy-bot/packages/cli/src/plugin/apply.ts`

```typescript
import type yargs from "yargs";
import type { CommandModule } from "yargs";
import { globalPluginRegistry } from "./registry";

/**
 * 将插件命令应用到 yargs 实例
 */
export function applyPluginCommands(yargsInstance: yargs.Argv<any>): yargs.Argv<any> {
  const commands = globalPluginRegistry.getAllCommands();
  
  for (const { command } of commands) {
    yargsInstance = yargsInstance.command(command);
  }
  
  return yargsInstance;
}

/**
 * 将插件命令转换为 yargs command 对象
 * 用于组合多个插件命令
 */
export function createPluginCommandsCommand(): CommandModule {
  return {
    command: "$0",
    describe: false,
    handler: () => {
      // 不做任何事，由其他命令处理
    },
  };
}
```

#### `roy-bot/packages/cli/src/plugin/index.ts`

```typescript
export type {
  PluginInfo,
  PluginComponentDefinition,
  PluginCommandDefinition,
  PluginEnvironmentContext,
  RoyCliPlugin,
} from "./types";

export {
  PluginRegistry,
  globalPluginRegistry,
} from "./registry";

export {
  discoverPlugins,
} from "./discover";

export {
  applyPluginCommands,
  createPluginCommandsCommand,
} from "./apply";
```

### 3.3 roy-cli 集成插件

#### `roy-bot/packages/cli/src/cli.ts` (修改)

```typescript
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { discoverPlugins, applyPluginCommands } from "./plugin";
import { ActCommand } from "./commands/act";
import { InteractiveCommand } from "./commands/interactive";
import { SessionsCommand } from "./commands/sessions";
import { TasksCommand } from "./commands/tasks";
import { CommandsCommand } from "./commands/commands";

export async function runCli(): Promise<void> {
  const pkg = await import("../package.json", { with: { type: "json" } });

  // 发现并加载已安装的插件
  await discoverPlugins();

  await yargs(hideBin(process.argv))
    .scriptName("roy")
    .version(pkg.default.version)
    
    // 内置命令
    .command(ActCommand)
    .command(InteractiveCommand)
    .command(SessionsCommand)
    .command(TasksCommand)
    .command(CommandsCommand)
    
    // 应用插件命令
    .command(applyPluginCommands(yargs))
    
    .demandCommand()
    .help()
    .alias("h", "help")
    .parse();
}
```

### 3.4 Environment 集成插件

#### `roy-bot/packages/core/src/env/environment.ts` (修改)

在 `BaseEnvironment` 中添加插件钩子：

```typescript
import type { RoyCliPlugin } from "../../cli/plugin/types";

export class BaseEnvironment extends BaseComponent implements Environment {
  // ... 现有代码 ...

  /**
   * 注册插件组件 (由 CLI 调用)
   */
  registerPluginComponents(components: RoyCliPlugin["getComponents"] extends () => infer R ? R : never): void {
    for (const def of (components ?? [])) {
      const component = new def.component(def.options);
      this.registerComponent(component);
    }
  }
}
```

### 3.5 bounty 插件实现

#### `ai-agent-bounty/src/plugin/index.ts`

```typescript
import type { RoyCliPlugin, PluginInfo } from "@ai-setting/roy-bot-cli/plugin";
import { AgentCommand } from "./commands/agent";
import { BountyCommand } from "./commands/bounty";
import { ComCommand } from "./commands/com";

/**
 * Bounty 插件元信息
 */
export const bountyPluginInfo: PluginInfo = {
  name: "bounty",
  version: "1.0.0",
  description: "AI Agent Bounty System - Task publishing, grabbing, and communication",
};

/**
 * Bounty CLI 插件实现
 */
export const bountyPlugin: RoyCliPlugin = {
  info: bountyPluginInfo,
  
  getCommands() {
    return [
      { command: AgentCommand },
      { command: BountyCommand },
      { command: ComCommand },
    ];
  },
  
  getComponents() {
    // 返回 bounty 特有的组件（如果有）
    return [];
  },
};
```

#### `ai-agent-bounty/src/plugin/commands/agent.ts`

```typescript
import type { CommandModule } from "yargs";
import { BountyContext } from "../../cli/services/context";
import { BountyService } from "../../lib/bounty";
import chalk from "chalk";

export const AgentCommand: CommandModule<object, object> = {
  command: "agent",
  describe: "Agent management commands",
  
  builder: (yargs) =>
    yargs
      .command({
        command: "register",
        describe: "Register a new agent",
        builder: (yargs) =>
          yargs
            .option("name", { type: "string", demandOption: true })
            .option("email", { type: "string", demandOption: true }),
        handler: async (args) => {
          const ctx = new BountyContext();
          const agent = ctx.agentService.register({
            name: args.name,
            email: args.email,
          });
          console.log(chalk.green(`Agent registered: ${agent.id}`));
        },
      })
      .command({
        command: "list",
        describe: "List all agents",
        handler: async () => {
          const ctx = new BountyContext();
          const agents = ctx.agentService.list();
          console.table(agents.map(a => ({
            id: a.id.substring(0, 8),
            name: a.name,
            email: a.email,
            credits: a.credits,
            status: a.status,
          })));
        },
      })
      .demandCommand(1),
  
  handler: () => {},
};
```

#### `ai-agent-bounty/roy-plugin.js`

```typescript
// 插件入口文件
// 由 roy-cli 扫描并加载

export { bountyPlugin } from "./dist/plugin/index.js";
```

#### `ai-agent-bounty/package.json` (修改)

```json
{
  "name": "@ai-setting/agent-bounty",
  "exports": {
    ".": "./dist/index.js",
    "./plugin": "./dist/plugin/index.js",
    "./roy-plugin": "./roy-plugin.js"
  },
  "files": [
    "dist/**/*.js",
    "roy-plugin.js",
    "src/**/*.ts"
  ],
  "scripts": {
    "build": "tsc",
    "build:plugin": "tsc --project tsconfig.plugin.json"
  }
}
```

---

## 四、文件变更清单

> **说明**：以下变更**仅涉及源码层面**，发布物结构和 build 模式**保持不变**。

### 4.1 roy-bot

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/core/src/env/environment.ts` | 修改 | 添加 `registerPluginComponents()` |
| `packages/core/src/index.ts` | 修改 | 导出相关类型 |
| `packages/cli/src/plugin/types.ts` | 新增 | `RoyCliPlugin` 接口定义 |
| `packages/cli/src/plugin/registry.ts` | 新增 | `PluginRegistry` 实现 |
| `packages/cli/src/plugin/discover.ts` | 新增 | 插件发现机制 |
| `packages/cli/src/plugin/apply.ts` | 新增 | 应用插件到 yargs |
| `packages/cli/src/plugin/index.ts` | 新增 | 插件模块导出 |
| `packages/cli/src/cli.ts` | 修改 | 集成插件发现和加载 |
| `packages/cli/src/commands/index.ts` | 新增 | 导出内置命令 |

**发布物**：`@ai-setting/roy-bot-core` 和 `@ai-setting/roy-bot-cli` **结构不变**

### 4.2 ai-agent-bounty

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/plugin/` | 新增 | 插件实现目录 |
| `src/plugin/index.ts` | 新增 | 导出 `bountyPlugin` |
| `src/plugin/types.ts` | 新增 | 类型定义 |
| `src/plugin/commands/agent.ts` | 新增 | agent 命令 |
| `src/plugin/commands/bounty.ts` | 新增 | bounty 命令 |
| `src/plugin/commands/com.ts` | 新增 | com 命令 |
| `src/plugin/components/` | 新增 | 组件扩展目录 |
| `roy-plugin.js` | 新增 | 插件入口文件 (放入 dist 发布) |
| `package.json` | 修改 | 添加 `roy-plugin.js` 到 files |
| `src/bin/bounty.ts` | 保留 | 独立 CLI 入口 (目标1) |
| `src/cli/` | 保留 | 现有 CLI 实现 |
| `src/lib/` | 保留 | 现有服务 |

**发布物**：`@ai-setting/agent-bounty` **结构不变**，新增 `roy-plugin.js` 到发布文件

---

## 五、测试验证

### 5.1 独立运行 bounty (目标1)

```bash
cd ai-agent-bounty

# 构建
bun run build

# 运行
bun run src/bin/bounty.ts --help
# 或
./dist/bin/bounty --help

# 测试命令
bounty agent register --name "Test" --email "test@example.com"
bounty bounty publish --title "Test Task" ...
```

### 5.2 通过 roy 加载 bounty (目标3)

```bash
# 方式1: 在项目目录安装
cd my-project
npm install @ai-setting/roy-bot-cli
npm install @ai-setting/roy-bot-core
npm install @ai-setting/agent-bounty

# 验证插件加载
roy --help
# 应该能看到 bounty 的命令

# 使用 bounty 命令
roy agent register --name "Test" --email "test@example.com"
roy bounty publish ...

# 方式2: 全局安装
npm install -g @ai-setting/roy-bot-cli
npm install -g @ai-setting/agent-bounty
```

---

## 六、版本发布流程

> **说明**：build 命令与现有流程**完全一致**，无新增命令。

### 6.1 发布顺序

```bash
# 1. 发布 roy-bot-core
cd roy-bot
bun run build:core
cd packages/core
npm version patch
npm publish --registry=https://npm.pkg.github.com

# 2. 发布 roy-bot-cli (包含插件系统)
cd ../cli
bun run build:cli:prod:single   # 与现有命令相同
npm version patch
npm publish --registry=https://npm.pkg.github.com

# 3. 发布 ai-agent-bounty
cd ../../ai-agent-bounty
bun run build                   # 与现有命令相同
npm version patch
npm publish --registry=https://npm.pkg.github.com
```

### 6.2 Build 命令对照表

| 包 | 命令 | 说明 |
|---|------|------|
| core | `bun run build:core` | 构建 core 包 (不变) |
| cli | `bun run build:cli:prod:single` | 构建当前平台 CLI (不变) |
| cli | `bun run build:cli:prod` | 构建所有平台 CLI (不变) |
| bounty | `bun run build` | 构建 bounty (不变) |

### 6.3 依赖版本更新

ai-agent-bounty 更新依赖（与现有流程相同）：

```bash
cd ai-agent-bounty
npm install @ai-setting/roy-bot-core@x.x.x
npm install @ai-setting/roy-bot-cli@x.x.x
```

### 6.2 依赖版本更新

ai-agent-bounty 更新依赖：

```bash
# 更新到新版本
cd ai-agent-bounty
npm install @ai-setting/roy-bot-core@x.x.x
npm install @ai-setting/roy-bot-cli@x.x.x
```

---

## 七、风险与注意事项

| 风险 | 缓解措施 |
|------|----------|
| 插件加载失败影响主程序 | 插件加载错误不应阻塞 CLI 启动 |
| 命令命名冲突 | 插件命令应使用明确的前缀或命名空间 |
| 版本兼容性 | 插件协议稳定后保持向后兼容 |
| 插件扫描性能 | 缓存已发现的插件，避免重复扫描 |

### 7.1 命令冲突处理

如果 bounty 和 roy 有同名命令，优先级策略：

1. 内置命令优先于插件命令
2. 高优先级插件优先于低优先级插件
3. 同优先级按注册顺序

### 7.2 插件加载失败处理

```typescript
async function loadPlugin(pkgPath: string): Promise<void> {
  try {
    const plugin = await import(pluginFile);
    if (isValidPlugin(plugin.default)) {
      globalPluginRegistry.register(plugin.default);
    }
  } catch (err) {
    // 仅警告，不阻塞启动
    console.warn(`[roy] Plugin ${pkgPath} failed to load:`, err.message);
  }
}
```

---

## 八、附录

### 8.1 插件协议版本

当前版本: `1.0.0`

未来可能扩展:

```typescript
interface RoyCliPlugin {
  // 现有字段...
  
  // 未来扩展
  getMiddleware?(): yargs.MiddlewareFunction[];
  getCompletions?(): string[];
}
```

### 8.2 相关文档

- [Agent Plugin 设计](./agent-component-design.md)
- [CLI 实现设计](./cli-implementation-design.md)
- [Bounty 系统设计](./bounty-system-design.md)
