# roy-bot

> Intelligent OS Framework for AI Agents — Build, Orchestrate, Deploy

[![Version](https://img.shields.io/badge/version-1.3.13-blue)](package.json)

Intelligent OS framework for AI agents. Build, orchestrate, and deploy AI agents with built-in Task lifecycle, Workflow engine, and multi-agent collaboration.


## Packages

| Package | Description | npm |
|---------|-------------|-----|
| [@ai-setting/roy-bot-core](./packages/core/) | Core SDK - Environment, Components, Tools, Sessions, Tasks | [npm](https://www.npmjs.com/package/@ai-setting/roy-bot-core) |
| [@ai-setting/roy-bot-coder-harness](./packages/coder-harness/) | LSP harness for code intelligence | [npm](https://www.npmjs.com/package/@ai-setting/roy-bot-coder-harness) |
| [@ai-setting/roy-bot-cli](./packages/cli/) | CLI SDK and standalone binary | [npm](https://www.npmjs.com/package/@ai-setting/roy-bot-cli) |
| [@ai-setting/roy-bot-standalone](./packages/roy-bot-standalone/) | Standalone binary for npx | [npm](https://www.npmjs.com/package/@ai-setting/roy-bot-standalone) |

### Subpath Exports

Core package 支持子模块导入：

```typescript
import { BaseEnvironment } from "@ai-setting/roy-bot-core";
import { parseJSONC } from "@ai-setting/roy-bot-core/config";
import { WorkflowComponent } from "@ai-setting/roy-bot-core/env/workflow";
import { createWorkflowExtractorAgent } from "@ai-setting/roy-bot-core/env/task/plugins";
import { WorkflowDefinitionSchema } from "@ai-setting/roy-bot-core/env/workflow/types";
```

## Plugin Notification

roy-bot 提供**统一的 Plugin 通知通道**：

- Plugin 通过 `env.notify({type, title, content, metadata})` 发送通知
- PluginComponent 按顺序路由到已注册的 `NotificationChannel`
- **默认通道**：`EventBusNotificationChannel` —— 把通知转成 `plugin.notification.<type>` 事件，通过 roy-bot 自身的 `env.pushEnvEvent` 发布
- **Legacy 通道**（@deprecated）：`LarkCliNotificationChannel` —— 直接调 `lark-cli` 子进程发飞书
- 上层 event subscriber（CLI / IM 适配器）监听 `plugin.notification.*` 事件做实际投递

> roy-bot（host 端）**不内建**任何示例 plugin — 真实 production consumer 见独立 plugin 仓 [`roy-plugin-task-show`](https://github.com/<org>/roy-plugin-task-show)（npm: `roy-plugin-task-show` v0.4.0+）。

### 快速示例

```typescript
import {
  BasePlugin,
  type PluginEnv,
} from "@ai-setting/roy-bot-core/env/plugin";

class MyPlugin extends BasePlugin {
  readonly name = "my-plugin";

  init(env: PluginEnv) {
    env.registerHook({
      point: "task:after.complete",
      handler: async (ctx) => {
        await env.notify({
          type: "task_completed",
          title: `Task #${ctx.data.taskId} done`,
          content: "Click to view report",
          metadata: { taskId: ctx.data.taskId },
        });
      },
    });
  }
}
```

详细设计、API reference、迁移指南（lark-cli → event-bus）见 **[docs/plugin-emit-notification.md](./docs/plugin-emit-notification.md)**。

## 工具链协作

项目使用 **pnpm + bun** 混合工具链，各司其职：

| 工具 | 职责 | 命令 |
|------|------|------|
| **pnpm** | 包管理、依赖安装、发布 | `pnpm install`, `pnpm -r publish` |
| **bunup** | SDK bundle 编译 | `bun run build` |
| **build-cli-dev.ts** | Dev 构建（源码 sourcemap） | `bun run build:cli:dev:single` |
| **build-cli-prod.ts** | Prod 构建（standalone） | `bun run build:cli:prod:single` |

### 依赖安装

```bash
pnpm install
```

### 编译 vs 构建

| 概念 | 说明 | 工具 |
|------|------|------|
| **编译 (compile)** | TypeScript → JavaScript | bunup |
| **构建 (build)** | 生成可分发产物 | 自定义脚本 + bun compile |

### 构建产物

| 产物 | 说明 |
|------|------|
| `dist/index.js` | SDK bundle |
| `dist/bin/roy-bot.js` | CLI SDK bundle |
| `dist/dev/bin/roy-bot.js` | Dev 构建，源码 sourcemap |
| `dist/roy-bot-*/bin/roy-bot` | Standalone 可执行文件 |

## Build

### 构建命令

```bash
# 依赖安装
pnpm install

# SDK 编译（bunup）
bun run build

# CLI 构建
bun run build:cli:dev:single     # Dev，本地平台，源码 sourcemap
bun run build:cli:prod:single     # Prod，本地平台，standalone
bun run build:cli:prod            # Prod，全平台 5 个，standalone
```

### Dev 模式

生成带有 **sourcemap** 的 bundle：

```bash
bun run build:cli:dev:single
bun packages/cli/dist/bin/roy-bot.js act "hello"
bun packages/cli/dist/bin/roy-bot.js act "任务" --agent roy    # 指定使用全功能 roy agent
```

> `--agent` 参数支持指定子智能体类型，如 `roy`（全功能助手）、`strict-task-agent`（严格验证编程任务）。查看完整列表：`roy-bot agents list`

### Prod 模式

生成 **standalone 可执行文件**：

```bash
bun run build:cli:prod
./packages/cli/dist/roy-bot-linux-x64/bin/roy-bot
```

## Desktop 应用

项目包含 Electron 桌面应用（位于 `packages/desktop/`）。

### 开发启动

```bash
# 开发模式
cd packages/desktop && pnpm dev:electron

# 或分步启动
pnpm dev              # 终端 1：Vite 开发服务器 (http://localhost:1420)
pnpm electron:dev     # 终端 2：Electron 应用
```

### Release 构建

```bash
bun run build:desktop     # 根目录脚本，一键构建
```

### 产物位置

```
packages/desktop/release/
├── Roy Agent Desktop-*.AppImage          # AppImage 安装包
└── linux-unpacked/                       # 解压版
```

## Publishing

发布到 npm（通过内置 Workflow 系统）：

```bash
# 触发发布 workflow
roy-bot workflow run roy-bot-build-publish-test
```

> ⚠️ 已从 GitHub Actions 迁移至内置 Workflow 系统，workflow 定义存储在 SQLite 数据库中。

### 发布包列表

| 包名 | 说明 | npx 安装 |
|------|------|----------|
| @ai-setting/roy-bot-core | Core SDK | `npm install @ai-setting/roy-bot-core` |
| @ai-setting/roy-bot-coder-harness | LSP harness | `npm install @ai-setting/roy-bot-coder-harness` |
| @ai-setting/roy-bot-cli | CLI SDK | `npm install @ai-setting/roy-bot-cli` |
| @ai-setting/roy-bot-standalone | Standalone binary | `npx @ai-setting/roy-bot-standalone` 或 `npm install -g @ai-setting/roy-bot-standalone` |

### 版本检查

publish workflow 会自动检查版本是否已发布：
- ✅ 未发布 → 正常发布
- ⚠️ 已发布 → 跳过并显示 WARNING，workflow 继续执行

## License

MIT
