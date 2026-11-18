# Tauri 到 Electron 迁移计划

> **Date**: 2026-05-09
> **Status**: In Progress
> **Branch**: `feature/migrate-tauri-to-electron`

## 背景

### 问题分析
1. **core 包依赖 `bun:sqlite`**，这是 Bun 特有模块
2. **Tauri Node Polyfills 方案不可行**：无法 polyfill `bun:sqlite`
3. **Tauri 重构需要 6-9 人天**来重写所有 sqlite 相关代码
4. **Electron 零改动**：因为 Electron 支持 Node.js 原生模块
5. **OpenCode 参考实现使用 Electron**：确认技术选型方向

### 技术选型决策
| 方案 | 工作量 | 风险 | 决策 |
|------|--------|------|------|
| Tauri 重构 | 6-9 人天 | 高（需要重写 sqlite） | ❌ 不采用 |
| Electron 迁移 | 零改动 | 低（Node.js 原生支持） | ✅ 采用 |

## 当前状态

### ✅ 已完成
1. [x] 创建 feature 分支 `feature/migrate-tauri-to-electron`
2. [x] 隔离工作区 `.worktrees/migrate`
3. [x] 迁移 Tauri 代码（从 `feature/desktop-app` worktree）
   - `src/core/*` - DesktopEnvironmentService, EventBridge, EventBusAdapter 等
   - `src/components/layout/*` - PanelL1/L2/Center/Right, TitleBar, StatusBar 等
   - `src/contexts/*` - DesktopEnvironmentContext.tsx
   - `src/hooks/*` - useDesktopEnvironment.ts
   - `src/stores/*` - uiStore, sessionStore, eventStore, taskStore
   - `electron/main/index.ts` - Electron 主进程（IPC handlers）
   - `electron/preload/index.ts` - contextBridge API
   - `__tests__/*` - TDD 测试用例
   - `docs/event-bridge-design.md` - Event Bridge 设计文档
4. [x] 添加 Electron 配置
   - `package.json` - Electron 依赖（electron, electron-builder, better-sqlite3, electron-store）
   - `electron-builder.json` - 跨平台构建配置
   - `electron/tsconfig.json` - 主进程 TypeScript 配置

### 📋 待完成

#### Phase 1: 核心配置（当前）
- [ ] 安装依赖：`pnpm install`
- [ ] 编译 Electron 主进程：`npm run electron:build`
- [ ] 验证 preload 脚本类型定义

#### Phase 2: 渲染进程适配
- [ ] 创建 `src/adapters/DesktopEnvironmentAdapter.ts` - 适配 Electron API
- [ ] 修改 `DesktopEnvironmentServiceStub.ts` - 使用 electronAPI 替代 Tauri invoke
- [ ] 创建 `src/electron/index.ts` - Electron API 入口

#### Phase 3: 功能验证
- [ ] 运行 Vite 开发服务器：`npm run dev`
- [ ] 运行 Electron 应用：`npm run electron:dev`
- [ ] 验证 EventBridge 事件流
- [ ] 验证 PanelCenter 事件显示

#### Phase 4: 打包发布
- [ ] 配置 electron-builder
- [ ] 测试 macOS 打包
- [ ] 测试 Linux 打包
- [ ] 测试 Windows 打包

## 项目结构

```
packages/desktop/
├── electron/
│   ├── src/
│   │   ├── main.ts          # Electron 主进程
│   │   └── preload.ts       # Preload 脚本
│   ├── tsconfig.json        # 主进程编译配置
│   └── dist/                # 编译产物
├── src/
│   ├── core/
│   │   ├── DesktopEnvironmentService.ts
│   │   ├── DesktopEnvironmentServiceStub.ts  # ⚠️ 需适配
│   │   ├── EventBridge.ts
│   │   ├── EventBusAdapter.ts
│   │   ├── SessionAdapter.ts
│   │   ├── TaskAdapter.ts
│   │   └── store-factory.ts
│   ├── adapters/            # ⚠️ 新增：Electron 适配器
│   │   └── DesktopEnvironmentAdapter.ts
│   ├── electron/            # ⚠️ 新增：Electron API 入口
│   │   └── index.ts
│   ├── components/layout/
│   ├── contexts/
│   ├── hooks/
│   ├── stores/
│   └── styles/
├── __tests__/
├── dist/                    # Vite 构建产物
├── package.json
├── vite.config.ts
├── electron-builder.json     # Electron 构建配置
└── tsconfig.json
```

## Tauri vs Electron API 对照

| 功能 | Tauri | Electron |
|------|-------|----------|
| 调用主进程 | `invoke<T>(cmd, args)` | `ipcRenderer.invoke(cmd, args)` |
| 文件系统 | `@tauri-apps/plugin-fs` | Node.js `fs` 模块 |
| 存储 | `@tauri-apps/plugin-store` | `electron-store` |
| SQLite | `@tauri-apps/plugin-sql` | `better-sqlite3` |
| 通知 | `@tauri-apps/plugin-notification` | `Notification` API |
| Shell | `@tauri-apps/plugin-shell` | `shell.openExternal` |

## 迁移命令对照

```typescript
// Tauri
import { invoke } from '@tauri-apps/api/tauri';
const result = await invoke<ReturnType>('command_name', { arg1, arg2 });

// Electron (via preload)
const result = await window.electronAPI.someMethod(arg1, arg2);
```

## 风险与缓解

### 风险 1: bun:sqlite 无法直接替代
**影响**: core 包依赖 `bun:sqlite`，无法在 Electron 中使用
**缓解**: 
- 检查 `@ai-setting/roy-bot-core` 是否已发布 npm 版本
- 如果已发布，Electron 可直接使用 npm 包而非本地 workspace

### 风险 2: Preload 脚本类型定义
**影响**: TypeScript 可能无法识别 `window.electronAPI`
**缓解**:
- 在 `vite.config.ts` 中添加 `vite-plugin-electron` 类型注入
- 或在 `src/electron.d.ts` 中手动定义全局类型

### 风险 3: Electron 主进程编译
**影响**: Node.js ESM 模块可能需要特殊配置
**缓解**:
- 使用 `electron-builder` 自带编译能力
- 或使用 `vite-plugin-electron` 简化开发流程

## 参考资料

- [Electron 官方文档](https://www.electronjs.org/docs)
- [electron-builder 配置](https://www.electron.build/configuration/configuration)
- [OpenCode Electron 实现](https://github.com/opencodeai/opencode)
- [better-sqlite3 npm](https://www.npmjs.com/package/better-sqlite3)
- [electron-store npm](https://www.npmjs.com/package/electron-store)
