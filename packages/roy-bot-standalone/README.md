# @ai-setting/roy-bot-standalone

Intelligent OS for AI agents - Standalone binary for all platforms.

## Installation

```bash
npm install -g @ai-setting/roy-bot-standalone
```

Or use it directly with npx:

```bash
npx @ai-setting/roy-bot-standalone --version
```

### 本地安装（不发布到 npm）

从源码构建后直接装到 PATH 上，完全不走 npm：

```bash
bun run install:local                # → ~/.local/bin/roy-bot（当前平台）
bun run install:local -- --build     # 先构建再安装
bun run install:local -- --link      # 软链（开发期改完重建立即生效）
bun run install:local -- --uninstall
```

发布前想验证「npm 安装链路」（bin 链接 / run.js / 平台判定）能否正常工作，
不需要先发到 npmjs：

```bash
bun run verify:npm-install           # npm pack + npm install -g 到临时 prefix + 冒烟测试
```

详见 [docs/publish-and-local-install.md](../../docs/publish-and-local-install.md)。

## Supported Platforms

| Platform | Architecture | Binary |
|----------|-------------|--------|
| Linux | x64 | `roy-bot-linux-x64` |
| Linux | arm64 | `roy-bot-linux-arm64` |
| macOS | x64 | `roy-bot-darwin-x64` |
| macOS | arm64 (Apple Silicon) | `roy-bot-darwin-arm64` |
| Windows | x64 | `roy-bot-windows-x64.exe` |

> 一个版本只包含「发布时本次构建」的平台二进制：`bun run publish:full` 默认只构建并发布当前平台，
> 此时包的 `os`/`cpu` 会收窄到该平台（其他平台安装会得到 `EBADPLATFORM`）。
> 需要覆盖全平台的版本，显式列出平台：
>
> ```bash
> bun run publish:full -- --platforms linux-x64,darwin-arm64,darwin-x64,windows-x64,linux-arm64
> ```
>
> ⚠️ 直接裸 `npm publish` 会把 `bin/` 下所有累积的旧二进制一起打包。
> `prepublishOnly` 会做校验（缺当前平台产物 / 版本不一致则失败），
> 迂回方式为 `STANDALONE_SKIP_PREPUBLISH_CHECK=1`。详见 [docs/publish-and-local-install.md](../../docs/publish-and-local-install.md)。

## Usage

```bash
# Show version
roy-bot --version

# Run interactive mode
roy-bot

# Run a command
roy-bot act "Hello, world!"
```

## Development Build

To build standalone binaries locally, use the root workspace scripts:

```bash
cd /path/to/roy-bot

# Build current platform only
bun run scripts/build-standalone.ts

# Build all platforms (linux, macOS, Windows)
bun run scripts/build-standalone.ts --all

# Build and publish to npmjs
bun run scripts/build-standalone.ts --publish

# Build all platforms and publish
bun run scripts/build-standalone.ts --all --publish

# Specify version
bun run scripts/build-standalone.ts --version 1.6.0 --publish

# Show help
bun run scripts/build-standalone.ts --help
```

Or use the npm scripts in the root package.json:

```bash
# Build current platform
pnpm run build:standalone

# Build all platforms
pnpm run build:standalone:all

# Build and publish to npmjs
pnpm run build:standalone:publish

# Build all platforms and publish
pnpm run build:standalone:all:publish
```

## License

MIT
