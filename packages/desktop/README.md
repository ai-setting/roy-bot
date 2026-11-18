# @ai-setting/roy-bot-desktop

Desktop GUI application for roy-bot. Built with Electron + React + Vite.

## Prerequisites

- Node.js >= 18
- pnpm >= 9
- Bun >= 1.3

## Installation

```bash
# Install dependencies
pnpm install
```

## Development

### Development Mode

Run Vite dev server and Electron in parallel:

```bash
# Start both Vite dev server and Electron
bun run dev:electron
```

This will:
1. Start Vite dev server at `http://localhost:1420`
2. Start Electron app with hot reload

### Vite Dev Server Only

```bash
# Start Vite dev server only (for UI development)
bun run dev
```

## Build

### Build for Production

Build Vite frontend and package with electron-builder:

```bash
# From root: build current platform
bun run build:desktop

# Or from this directory
bun run build
```

Output:
- `release/` - Packaged installers
  - Linux: `*.AppImage`
  - macOS: `*.dmg`
  - Windows: `*.exe`

### Type Check

```bash
# Type check frontend and electron
bun run build:check

# Type check only
npx tsc --noEmit
```

## Testing

```bash
# Run tests (Node.js)
bun run test

# Run tests with watch mode
bun run test:watch

# Run tests with Bun
bun run test:bun
```

## Electron Builder

### Package Configuration

See `electron-builder.json` for packaging configuration.

### Build Installers

```bash
# Build for current platform
bun run electron:build

# Build for specific platform
bunx electron-builder --config electron-builder.json --linux
bunx electron-builder --config electron-builder.json --mac
bunx electron-builder --config electron-builder.json --win
```

### Build Unpacked Directory

```bash
# Build unpacked directory (for testing)
bunx electron-builder --config electron-builder.json --dir
```

Output: `release/linux-unpacked/`, `release/mac-unpacked/`, etc.

## Project Structure

```
desktop/
├── src/                    # React frontend source
│   ├── components/         # React components
│   ├── contexts/           # React contexts
│   ├── core/               # Core adapters
│   ├── hooks/              # Custom hooks
│   ├── stores/             # Zustand stores
│   └── electron/           # Electron integration
├── electron/               # Electron main process source
│   └── src/               # Main process code
│       ├── main.ts        # Main entry
│       ├── preload.ts      # Preload script
│       └── environment.ts  # Environment adapter
├── dist/                   # Built frontend assets
├── electron/dist/          # Built electron main process
├── release/                # Packaged installers
├── vite.config.ts         # Vite configuration
├── electron-builder.json   # Electron builder config
└── tailwind.config.js      # Tailwind CSS config
```

## Publishing

### GitHub Releases

Multi-platform builds are automated via GitHub Actions:

```yaml
# .github/workflows/desktop-release.yml
# Triggers:
# - workflow_dispatch: Manual trigger
# - release: Auto trigger on new release
```

### Local Build & Publish

```bash
# 1. Build for current platform
bun run build:desktop

# 2. Publish to npm (optional)
npm publish --access public
```

## Dependencies

- `@ai-setting/roy-bot-core` - Core SDK for environment/adapters
- `react` - UI framework
- `zustand` - State management
- `better-sqlite3` - Local database
- `electron-store` - Electron persistent storage
- `electron` - Desktop runtime
