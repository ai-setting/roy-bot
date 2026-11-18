# config 命令设计文档

## 1. 概述

本文档定义 `roy config` 命令的设计和实现方案。

**核心功能**：提供一个统一的命令行接口，让用户查看、导出、导入 roy-bot 中各个 Component 的配置信息。

**设计理念**：
- **统一入口**：通过 `roy config list <component>` 查看配置
- **分层设计**：list/export/import 三个子命令各司其职
- **一致性**：遵循其他 CLI 命令的行为模式
- **ConfigComponent 驱动**：所有配置统一由 ConfigComponent 管理

---

## 2. 命令结构

### 2.1 命令树

```
roy config
├── list      # 查看配置
│   ├── list [component]     # 查看单个组件
│   └── list all            # 查看所有组件概览
├── export    # 导出配置
│   └── export [component]   # 导出到文件
└── import    # 导入配置
    └── import [component]   # 从文件导入
```

### 2.2 命令详情

#### config list

```
roy config list [component] [options]

位置参数:
  component    Component 名称 (可选)
               - tool, task, memory, session, skill, commands, eventsource, mcp
               - all: 显示所有 Component 概览
               - 无参数: 显示帮助信息

选项:
  --json, -j       JSON 格式输出
  --keys, -k       只显示配置键
  --sources, -s    只显示配置源
  --config, -c     配置文件路径
  --help, -h       显示帮助信息
```

#### config export

```
roy config export [component] [options]

位置参数:
  component    Component 名称 (必需)

选项:
  --output, -o    输出文件路径 (不指定则输出到 stdout)
  --pretty, -p    格式化输出 (默认 true)
  --help, -h      显示帮助信息
```

#### config import

```
roy config import [component] [options]

位置参数:
  component    Component 名称 (必需)

选项:
  --input, -i     输入文件路径 (必需)
  --dry-run       预览模式，不实际写入
  --verbose, -v   显示详细操作信息
  --help, -h      显示帮助信息
```

### 2.3 行为规范

| 场景 | 行为 |
|------|------|
| `roy config` | 显示帮助，列出子命令 |
| `roy config list` | 显示帮助信息，列出支持的 components |
| `roy config list tool` | 显示 tool component 配置 |
| `roy config list all` | 显示所有 components 概览 |
| `roy config list unknown` | 显示错误：未知 component，并列出支持的 components |
| `roy config list tool --json` | JSON 格式输出配置 |
| `roy config export tool -o backup.json` | 导出 tool 配置到文件 |
| `roy config import tool -i backup.json` | 从文件导入 tool 配置 |

---

## 3. 核心类型

### 3.1 types.ts

```typescript
/**
 * 所有支持的 Components 列表
 */
export const SUPPORTED_COMPONENTS = [
  'tool',
  'task',
  'memory',
  'session',
  'skill',
  'commands',
  'eventsource',
  'mcp',
  'agent',
  'log-trace',
  'lsp',
] as const;

export type SupportedComponent = typeof SUPPORTED_COMPONENTS[number];

/**
 * Component 别名映射（用户输入 -> 内部名称）
 */
export const COMPONENT_ALIASES: Record<string, string> = {
  session: 'session',
  sessions: 'session',
};

/**
 * 获取组件的内部名称（处理别名）
 */
export function resolveComponentName(name: string): string {
  return COMPONENT_ALIASES[name] ?? name;
}

/**
 * Component 描述映射
 */
export const COMPONENT_DESCRIPTIONS: Record<string, string> = {
  tool: 'Tool Component - 工具管理',
  task: 'Task Component - 任务管理',
  memory: 'Memory Component - 记忆管理',
  session: 'Session Component - 会话管理',
  skill: 'Skill Component - 技能管理',
  commands: 'Commands Component - 命令管理',
  eventsource: 'EventSource Component - 事件源管理',
  mcp: 'MCP Component - MCP 服务器管理',
  agent: 'Agent Component - Agent 配置和循环控制',
  'log-trace': 'LogTrace Component - 日志和追踪管理',
  lsp: 'LSP Component - 语言服务器协议管理',
};
```

### 3.2 ConfigService

```typescript
import { ConfigComponent } from "@ai-setting/roy-bot-core";
import { OutputService } from "../../services/output.service";
import { deepMerge } from "./deep-merge";

/**
 * ConfigService - 配置服务
 * 
 * 职责：
 * 1. 从 ConfigComponent 获取配置
 * 2. 提供导出/导入功能
 * 3. 处理配置合并逻辑
 */
export class ConfigService {
  constructor(
    private configComponent: ConfigComponent,
    private output: OutputService
  ) {}

  /**
   * 获取 component 的运行时配置值
   * 
   * 从 ConfigComponent 的 memory source 读取该 component 的所有配置
   */
  getComponentConfig(componentName: string): Record<string, unknown> {
    const sources = this.configComponent.getSources();
    const memorySource = sources.find((s) => s.name === "memory");
    
    if (!memorySource) {
      return {};
    }

    const allEntries = memorySource.list();
    const prefix = `${componentName}.`;
    
    // 过滤并重建嵌套结构
    const result: Record<string, unknown> = {};
    for (const entry of allEntries) {
      if (entry.key === componentName) {
        result[entry.key] = entry.value;
      } else if (entry.key.startsWith(prefix)) {
        const restKey = entry.key.slice(prefix.length);
        this.setNestedValue(result, restKey, entry.value);
      }
    }

    return result;
  }

  /**
   * 获取 component 的 file source 物理路径
   */
  getComponentFilePath(componentName: string): string | undefined {
    const sources = this.configComponent.getSources();
    const fileSource = sources.find((s) => s.name === "file");
    
    if (fileSource && "filePath" in fileSource) {
      return fileSource.filePath as string;
    }
    
    return undefined;
  }

  /**
   * 导出配置到文件
   */
  async exportToFile(
    componentName: string,
    options: ConfigExportOptions
  ): Promise<string> {
    const config = this.getComponentConfig(componentName);
    const content = JSON.stringify(
      { [componentName]: config },
      null,
      options.pretty !== false ? 2 : 0
    );

    if (options.filePath) {
      // 写入文件
      await fsPromises.writeFile(options.filePath, content, "utf-8");
    }

    return content;
  }

  /**
   * 从文件导入配置（只写入 file source）
   */
  async importFromFile(
    componentName: string,
    options: ConfigImportOptions
  ): Promise<ImportResult> {
    // 1. 解析源文件
    // 2. 获取目标文件路径
    // 3. 读取目标文件现有内容
    // 4. 深度合并
    // 5. 写入文件
  }
}
```

---

## 4. 目录结构

```
packages/cli/src/commands/
├── config/
│   ├── index.ts              # 主命令入口 (roy config)
│   ├── list.ts               # list 子命令 (roy config list)
│   ├── export.ts             # export 子命令 (roy config export)
│   ├── import.ts             # import 子命令 (roy config import)
│   ├── config-service.ts     # 配置服务工具类
│   ├── config-service.test.ts # 配置服务测试
│   ├── deep-merge.ts          # 深度合并工具函数
│   ├── deep-merge.test.ts    # 深度合并测试
│   └── types.ts              # 类型定义
└── ...
```

---

## 5. 输出格式

### 5.1 config list 输出

```bash
$ roy config list tool

# tool Component Configuration

File:
  /home/user/.config/roy-bot/tool-config.jsonc

Configuration:
  tool.toolsDir: ./tools
  tool.builtInTools.enabled: true
  tool.sandbox.enabled: false
  tool.execution.timeout: 30000
```

### 5.2 config list all 输出

```bash
$ roy config list all

# All Components Overview

  Component       Keys       Description
  ───────────────────────────────────────────────────────────────
  tool            12         Tool Component - 工具管理
  task            8          Task Component - 任务管理
  memory          6          Memory Component - 记忆管理
  session         5          Session Component - 会话管理
  skill           4          Skill Component - 技能管理
  commands        3          Commands Component - 命令管理
  eventsource     2          EventSource Component - 事件源管理
  mcp             7          MCP Component - MCP 服务器管理
  agent           15         Agent Component - Agent 配置和循环控制
  log-trace       4          LogTrace Component - 日志和追踪管理
  lsp             6          LSP Component - 语言服务器协议管理
```

### 5.3 config export 输出

```bash
$ roy config export tool -o backup.json

✅ 已导出 tool 配置到 backup.json
```

### 5.4 config import 输出

```bash
$ roy config import tool -i backup.json

📋 发现 3 个配置变更
   tool.execution.timeout: 30000 → 60000
   tool.sandbox.enabled: false → true
✅ 已导入配置到 /home/user/.config/roy-bot/tool-config.jsonc
   3 个配置项已更新
```

---

## 6. deep-merge 工具

### 6.1 设计目标

- 深度合并两个配置对象
- 保留目标对象的已有值
- 正确处理嵌套对象
- 处理数组覆盖而非合并

### 6.2 实现

```typescript
/**
 * 深度合并两个对象
 * - 嵌套对象递归合并
 * - 数组直接覆盖（不合并）
 * - undefined 值不覆盖已有值
 */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>
): T {
  const result = { ...target };

  for (const key in source) {
    const sourceValue = source[key];
    const targetValue = target[key];

    if (
      sourceValue !== undefined &&
      isPlainObject(sourceValue) &&
      isPlainObject(targetValue)
    ) {
      // 递归合并嵌套对象
      result[key] = deepMerge(targetValue, sourceValue) as T[Extract<keyof T, string>];
    } else if (sourceValue !== undefined) {
      // 直接覆盖
      result[key] = sourceValue as T[Extract<keyof T, string>];
    }
  }

  return result;
}
```

---

## 7. ConfigComponent 集成

### 7.1 架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                    ConfigComponent 统一管理架构                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   CLI (roy config)                                                  │
│   ├── ConfigService                                                 │
│   │   ├── getComponentConfig() → 读取 memory source                 │
│   │   ├── exportToFile() → 序列化配置                               │
│   │   └── importFromFile() → 深度合并写入 file source                │
│   │                                                             │
│   └── OutputService → 格式化输出                                    │
│                                                                     │
│           │                                                         │
│           ▼                                                         │
│   ConfigComponent                                                   │
│   ├── getSources() → 获取所有 Source                               │
│   │   ├── MemorySource (优先级 0)                                  │
│   │   ├── FileSource (优先级 10)                                   │
│   │   └── EnvSource (优先级 20)                                    │
│   │                                                             │
│   └── 管理所有 Component 的配置注册                                  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 7.2 数据流

```
┌─────────────────────────────────────────────────────────────────────┐
│                    config list 命令数据流                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   roy config list tool                                             │
│       │                                                             │
│       ▼                                                             │
│   ConfigListCommand.handler()                                      │
│   ├── 创建 EnvironmentService                                      │
│   ├── 获取 ConfigComponent                                         │
│   └── 创建 ConfigService                                           │
│       │                                                             │
│       ▼                                                             │
│   ConfigService.getComponentConfig("tool")                         │
│   ├── configComponent.getSources()                                │
│   ├── 找到 memory source                                          │
│   ├── memorySource.list() → 获取所有配置项                          │
│   └── 过滤 prefix="tool." 的项，重建嵌套结构                        │
│       │                                                             │
│       ▼                                                             │
│   OutputService 输出                                                │
│   └── Console / JSON                                               │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 8. 与旧设计 (show-config) 的对比

### 8.1 命令结构变化

| 旧设计 | 新设计 |
|--------|--------|
| `roy show-config [component]` | `roy config list [component]` |
| `roy show-config --json` | `roy config list --json` |
| - | `roy config export [component]` |
| - | `roy config import [component]` |

### 8.2 架构变化

| 方面 | 旧设计 | 新设计 |
|------|--------|--------|
| 命令结构 | 单命令 + 参数 | config + 子命令 |
| 配置获取 | 各 Component 渲染器 | ConfigService 统一获取 |
| 配置源 | 分散管理 | ConfigComponent 统一管理 |
| 输出格式 | 多种渲染器 | ConfigService + OutputService |
| 导出/导入 | 不支持 | 完整支持 |

### 8.3 优势

1. **命令结构更清晰**：`config` 一级命令 + `list/export/import` 子命令
2. **职责分离**：ConfigService 专门处理配置相关操作
3. **统一配置源**：所有配置通过 ConfigComponent 管理
4. **易于扩展**：新增子命令只需添加新文件
5. **代码复用**：deep-merge 工具可在多处复用

---

## 9. 迁移指南

### 9.1 用户迁移

```bash
# 旧命令 → 新命令
roy show-config tool       → roy config list tool
roy show-config all        → roy config list all
roy show-config tool --json → roy config list tool --json
```

### 9.2 别名支持

为兼容旧命令，我们添加了别名支持：
- `session` / `sessions` → `session`

### 9.3 未来计划

- [ ] 添加 `config set` 命令（运行时修改配置）
- [ ] 添加 `config get` 命令（获取单个配置值）
- [ ] 添加交互式配置向导 `config wizard`
- [ ] 支持 YAML 格式导入/导出

---

## 10. 相关文档

- [ConfigComponent 设计](./config-component-design.md) - ConfigComponent 详细设计
- [去中心化配置设计](./component-decentralized-config-design.md) - 去中心化配置注册机制
- [配置引用协议](./config-reference-protocol.md) - 配置引用和变量替换机制
