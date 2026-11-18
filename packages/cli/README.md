# @ai-setting/roy-bot-cli

Command-line interface for roy-bot. Provides non-interactive command execution.

## 工具链协作

| 工具 | 职责 | 使用场景 |
|------|------|----------|
| **pnpm** | 包管理、依赖安装、发布 | `pnpm install`, `pnpm publish` |
| **bunup** | SDK bundle 编译 | `bun run build` |
| **build-cli-dev.ts** | Dev 构建（源码 sourcemap） | `bun run build:cli:dev:single` |
| **build-cli-prod.ts** | Prod 构建（standalone） | `bun run build:cli:prod:single` |

## Build

### 构建模式

| 模式 | 命令 | 产物 | 说明 |
|------|------|------|------|
| **SDK Bundle** | `bun run build` | `dist/index.js`, `dist/bin/roy-bot.js` | bunup 编译，用于 npm 发布 |
| **Dev** | `bun run build:cli:dev:single` | `dist/bin/roy-bot.js` + sourcemap | 本地平台，调试用 |
| **Prod Single** | `bun run build:cli:prod:single` | `dist/roy-bot-*/bin/roy-bot` | 本地平台，standalone |
| **Prod All** | `bun run build:cli:prod` | `dist/roy-bot-*/bin/roy-bot` | 全平台 5 个，standalone |

### Dev 模式

生成带有 **sourcemap** 的 bundle，日志可显示准确的 `.ts` 文件路径和行号。

```bash
bun run build:cli:dev:single

# 运行
bun packages/cli/dist/bin/roy-bot.js act "hello"
```

### Prod 模式

生成 **standalone 可执行文件**。

```bash
# 本地平台
bun run build:cli:prod:single

# 全平台（linux-x64, linux-arm64, darwin-x64, darwin-arm64, windows-x64）
bun run build:cli:prod
```

## Development

源码运行：

```bash
bun packages/cli/src/bin/roy-bot.ts
```

## Usage

### CLI Binary

```bash
# Interactive mode
roy-bot

# Execute task
roy-bot act "帮我写一个 hello world"

# With options
roy-bot act "任务" --model gpt-4 --quiet
```

### SDK Import

```typescript
import { runCli } from "@ai-setting/roy-bot-cli";

// Run CLI
await runCli();
```

## Publishing

```bash
# 1. SDK bundle 编译（bunup）
bun run build

# 2. 发布到 npm
cd packages/cli
pnpm publish --access public
```

## Dependencies

- `@ai-setting/roy-bot-core` - Core SDK
- `@ai-setting/roy-bot-coder-harness` - LSP harness
- `chalk` - Terminal colors
- `yargs` - CLI argument parsing
