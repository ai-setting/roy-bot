# @roy-bot/coder - Coder Harness

> 编程场景专用环境扩展，为 roy-bot 提供代码智能能力

## 核心设计理念

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Coder Harness 设计理念                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Core (@roy-bot/core) 保持场景无关                                       │
│      │                                                                   │
│      └──► Coder Harness (@roy-bot/coder) 提供编程专用能力                  │
│              │                                                           │
│              ├──► LSP 集成 (代码智能)                                      │
│              ├──► LinterPlugin (代码检查)                                 │
│              ├──► TypeCheckPlugin (类型检查)                               │
│              └──► LSPPlugin (诊断信息)                                    │
│                                                                         │
│  不重新实现 tools，通过 Hook 机制扩展 ToolComponent                         │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## 模块结构

```
coder-harness/src/
├── index.ts                    # 导出入口
│
├── lsp/                        # LSP (Language Server Protocol) 模块
│   ├── client.ts              # LSP 客户端封装
│   ├── client.test.ts
│   ├── server.ts             # LSP 服务器定义和注册表
│   ├── server.test.ts
│   ├── manager.ts             # LSP 连接管理器
│   ├── manager.test.ts
│   ├── language-map.ts        # 语言到 LSP 服务器映射
│   └── language-map.test.ts
│
├── plugins/                    # Plugin 模块 (Hook 扩展)
│   ├── linter-plugin.ts       # 代码检查插件
│   ├── linter-plugin.test.ts
│   ├── type-check-plugin.ts   # 类型检查插件
│   ├── type-check-plugin.test.ts
│   ├── lsp-plugin.ts          # LSP 诊断信息插件
│   └── lsp-plugin.test.ts
│
├── type-check/                # 类型检查模块
│   ├── manager.ts             # TypeCheck 管理器
│   └── manager.test.ts
│
├── types/                     # 类型定义
│   └── linter.ts             # 诊断信息、类型检查结果等类型
│
├── util/                      # 工具模块
│   └── glob.ts                # Glob 模式匹配
│
└── integration/               # 集成测试
    ├── tool-plugin.integration.test.ts
    └── end-to-end.integration.test.ts
```

## 核心功能

### 1. LSP 模块

LSP (Language Server Protocol) 模块提供代码智能能力：

```typescript
import { LSPManager, getServerId } from "@roy-bot/coder";

// 创建 LSP 管理器
const manager = new LSPManager({
  idleTimeout: 60000,
  maxConnections: 5,
  healthCheckInterval: 60000, // 健康检查间隔（毫秒）
});

// 获取文件诊断信息
const diagnostics = await manager.getDiagnostics("/path/to/file.ts");

// 执行健康检查
const healthResults = await manager.healthCheck();

// 获取连接统计
const stats = manager.getStats();
```

#### 预加载功能

LSP 支持预加载功能，可以在 CLI 启动时预先启动 LSP 服务器：

```typescript
import { createGlobalLSPManager, createLSPConfigLoader } from "@roy-bot/coder";

// 加载配置
const configLoader = createLSPConfigLoader();
const config = configLoader.load();

// 使用配置创建管理器
const manager = createGlobalLSPManager({
  idleTimeout: config.idleTimeout,
  maxConnections: config.maxConnections,
  preloadLanguages: config.preloadLanguages,
});

// 预热服务器（异步）
await manager.prewarm();

// 注册退出清理
manager.registerShutdownHandler();

// 健康检查
const results = await manager.healthCheck();
```

**支持的语言和 LSP 服务器：**

| 语言 | 服务器 | 扩展名 |
|------|--------|--------|
| TypeScript/JavaScript | typescript-language-server | .ts, .tsx, .js, .jsx |
| Python | pyright-langserver | .py |
| Vue | vue-language-server | .vue |
| CSS/SCSS/Less | vscode-css-language-server | .css, .scss, .less |
| HTML | vscode-html-language-server | .html |
| JSON | vscode-json-language-server | .json |

#### LSP 配置

可以通过 `~/.config/roy-bot/lsp.json` 配置文件来控制 LSP 行为：

```json
{
  "enabled": true,
  "preload": true,
  "preloadLanguages": ["typescript", "python"],
  "installPath": "~/.local/share/roy-bot/lsp-servers",
  "idleTimeout": 60000,
  "maxConnections": 5,
  "autoInstall": false
}
```

**配置选项：**

| 选项 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| enabled | boolean | true | 是否启用 LSP 功能 |
| preload | boolean | false | 是否在启动时预加载 LSP 服务器 |
| preloadLanguages | string[] | 全部语言 | 要预加载的语言服务器 ID 列表 |
| installPath | string | ~/.local/share/roy-bot/lsp-servers | LSP 包安装路径 |
| idleTimeout | number | 60000 | 空闲超时时间（毫秒） |
| maxConnections | number | 5 | 最大并发连接数 |
| autoInstall | boolean | false | 是否自动安装缺失的依赖 |

### 2. LinterPlugin

在文件写入后自动执行 LSP lint：

```typescript
import { LinterPlugin } from "@roy-bot/coder";
import { ToolComponent } from "@roy-bot/core";

const toolComponent = new ToolComponent();
const linterPlugin = new LinterPlugin({
  enabled: true,
  ignorePatterns: ["dist/**", "*.min.js"],
});

// 注册 Hook
toolComponent.registerHook("tool.after-execute", {
  name: linterPlugin.name,
  priority: linterPlugin.priority,
  execute: linterPlugin.onAfterTool.bind(linterPlugin),
});
```

### 3. TypeCheckPlugin

在文件写入后自动执行类型检查：

```typescript
import { TypeCheckPlugin } from "@roy-bot/coder";

const typeCheckPlugin = new TypeCheckPlugin({
  enabled: true,
  supportedExtensions: [".ts", ".tsx", ".py"],
  checkOnSave: true,
  checkOnEdit: true,
});

// 注册方式同 LinterPlugin
```

### 4. LSPPlugin

提供代码诊断信息增强：

```typescript
import { LSPPlugin } from "@roy-bot/coder";

const lspPlugin = new LSPPlugin({
  enabled: true,
  autoDownload: false,
});

// 注册后在 read_file 操作后自动获取诊断信息
```

## 集成示例

### 完整集成示例

```typescript
import { ToolComponent, type Hook } from "@roy-bot/core";
import {
  LinterPlugin,
  TypeCheckPlugin,
  LSPPlugin,
} from "@roy-bot/coder";

async function setupCoderHarness(toolComponent: ToolComponent) {
  // 创建 Plugins
  const linterPlugin = new LinterPlugin({
    ignorePatterns: ["dist/**", "node_modules/**", "*.min.js"],
  });

  const typeCheckPlugin = new TypeCheckPlugin({
    supportedExtensions: [".ts", ".tsx", ".py"],
  });

  const lspPlugin = new LSPPlugin();

  // 创建 Hooks
  const plugins = [linterPlugin, typeCheckPlugin, lspPlugin];

  for (const plugin of plugins) {
    const hook: Hook<any> = {
      name: plugin.name,
      description: plugin.description,
      priority: plugin.priority,
      execute: plugin.onAfterTool.bind(plugin),
    };
    toolComponent.registerHook("tool.after-execute", hook);
  }

  return { linterPlugin, typeCheckPlugin, lspPlugin };
}
```

### 创建自定义 Plugin

```typescript
import type { Hook, HookContext } from "@roy-bot/core";

// 自定义 Hook 数据类型
interface CustomHookData {
  toolName: string;
  args: Record<string, unknown>;
  result: { success: boolean; metadata?: Record<string, unknown> };
}

// 创建自定义 Plugin
const customPlugin = {
  name: "CustomPlugin",
  description: "Custom code analysis plugin",
  priority: 95,

  getHookPoint() {
    return "tool.after-execute";
  },

  async onAfterTool(ctx: HookContext<CustomHookData>) {
    const { toolName, result } = ctx.data;

    if (toolName !== "write_file") return;

    // 执行自定义分析
    const analysis = await performAnalysis(ctx.data.args.path);

    // 附加结果到 metadata
    if (!result.metadata) result.metadata = {};
    result.metadata.customAnalysis = analysis;
  },
};

// 注册
toolComponent.registerHook("tool.after-execute", customPlugin);
```

## API 参考

### 导出列表

```typescript
// LSP 模块
export { LSPClient, createLSPClient } from "./lsp/client";
export { LSPServer, LSPServerRegistry } from "./lsp/server";
export { LSPManager } from "./lsp/manager";
export { getServerId, getLanguageId, isSupported, getExtensionsByServer } from "./lsp/language-map";

// Plugins
export { LinterPlugin, createLinterPlugin } from "./plugins/linter-plugin";
export { TypeCheckPlugin, createTypeCheckPlugin } from "./plugins/type-check-plugin";
export { LSPPlugin, createLSPPlugin } from "./plugins/lsp-plugin";

// TypeCheck
export { TypeCheckManager, createTypeCheckManager } from "./type-check/manager";

// Types
export type {
  Diagnostic,
  LintResult,
  LinterPluginConfig,
  TypeCheckResult,
  TypeCheckPluginConfig,
  // ...
} from "./types/linter";
```

## 测试

```bash
# 运行所有测试
cd packages/coder-harness
npx vitest run

# 运行特定测试
npx vitest run src/plugins/linter-plugin.test.ts

# 运行集成测试
npx vitest run src/integration/
```

**测试覆盖率：**

| 模块 | 测试数 | 状态 |
|------|--------|------|
| LSP Module | 59 tests | ✅ |
| Plugin Module | 41 tests | ✅ |
| Utils | 11 tests | ✅ |
| Integration | 14 tests | ✅ |
| End-to-End | 9 tests | ✅ |
| **总计** | **125 tests** | **✅** |

## 设计原则

1. **不重新发明轮子**
   - 不重新实现 tools
   - 通过 Hook 机制扩展 ToolComponent

2. **场景解耦**
   - Core 保持场景无关
   - Coder Harness 只处理编程场景

3. **Graceful Degradation**
   - LSP 连接失败不影响工具执行
   - 类型检查失败只记录警告

4. **懒加载**
   - LSP 服务器按需启动
   - 空闲连接自动清理

## 扩展阅读

- [Architecture Design](../docs/architecture-design.md)
- [Tool Component Design](../docs/tool-component-design.md)
- [Hook System](../docs/hook-system-redesign.md)
