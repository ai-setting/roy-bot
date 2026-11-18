# MemoryComponent

> 记忆管理核心组件

## 概述

MemoryComponent 是 roy-bot 的**记忆管理核心组件**，负责：
- 管理本地文件系统记忆存储
- 注册记忆操作工具（record_memory, recall_memory）
- 支持 project/global 两种作用域

## 快速开始

### 1. 在 Environment 中注册

```typescript
import { BaseEnvironment } from "@roy-bot/core";
import { MemoryComponent } from "@roy-bot/core";
import { ToolComponent } from "@roy-bot/core";

export class MyEnvironment extends BaseEnvironment {
  protected registerDefaultComponents(): void {
    // 注册 ToolComponent（MemoryComponent 依赖它）
    if (!this.getComponent("tool")) {
      this.registerComponent(new ToolComponent());
    }

    // 注册 MemoryComponent
    const memoryComponent = new MemoryComponent();
    this.registerComponent(memoryComponent);
  }
}
```

### 2. 初始化配置

```typescript
const memoryComponent = new MemoryComponent();
await memoryComponent.init({
  options: {
    config: {
      memoryPaths: [
        { type: "global", path: "~/.config/roy-bot/memory" },
        { type: "project", path: ".roy/memory" },
      ],
      recursive: true,
      cacheEnabled: true,
      cacheTTL: 5 * 60 * 1000, // 5 分钟
    },
  },
});
```

### 3. 启动组件

```typescript
await memoryComponent.start();
// MemoryComponent 会自动注册 2 个工具：
// - record_memory
// - recall_memory
```

## 工具 API

### record_memory

记录记忆到指定 scope 的 memory.md 文件。

```typescript
// 追加内容
await memoryComponent.recordMemory({
  scope: "project",
  mode: "append",
  content: "# 新记忆\n\n...",
  title: "项目架构更新",
});

// 覆盖内容
await memoryComponent.recordMemory({
  scope: "global",
  mode: "overwrite",
  content: "# 全局记忆\n\n...",
});

// 删除记忆
await memoryComponent.recordMemory({
  scope: "project",
  mode: "delete",
});
```

**参数**:
- `scope`: 作用域 - `"project"` 或 `"global"` (必填)
- `mode`: 操作模式 - `"append"`, `"prepend"`, `"overwrite"`, `"delete"`
- `content`: 记忆内容 (delete 模式不需要)
- `title`: 章节标题 (可选)

### recall_memory

回忆记忆，从指定 scope 读取 memory.md 文件。

```typescript
// 读取所有 scope 的记忆
const allMemory = await memoryComponent.recallMemory();

// 只读取 project scope
const projectMemory = await memoryComponent.recallMemory("project");

// 只读取 global scope
const globalMemory = await memoryComponent.recallMemory("global");
```

**参数**:
- `scope`: 作用域 - `"project"` 或 `"global"` (可选，不传则读取所有)

## 文件路径

```
~/.config/roy-bot/memory/
└── memory.md              # global scope（全局记忆）

.roy/memory/
└── memory.md              # project scope（项目记忆，根据工作目录动态）
```

## CLI 使用

```bash
# 记录记忆（必填 --scope 参数）
roy memory record --scope project --mode append --content "# 新内容" --title "标题"
roy memory record --scope global --mode overwrite --content "# 全局内容"

# 回忆记忆（可选 --scope 参数）
roy memory recall                    # 读取所有 scope
roy memory recall --scope project    # 只读取 project scope
roy memory recall --scope global     # 只读取 global scope
```

## 配置

### 默认配置

```typescript
{
  memoryPaths: [
    { type: "global", path: "~/.config/roy-bot/memory" },
    { type: "project", path: ".roy/memory" },
  ],
  recursive: true,
  cacheEnabled: true,
  cacheTTL: 5 * 60 * 1000,
  memoryFile: "memory.md",
}
```

### 环境变量

```bash
# 设置 memory paths
export MEMORY_MEMORYPATHS='[{"type":"global","path":"/home/user/.config/roy-bot/memory"},{"type":"project","path":".roy/memory"}]'

# 设置递归扫描
export MEMORY_RECURSIVE=true
```

## 类型定义

```typescript
import type {
  MemoryConfig,
  MemoryPath,
  RecordMemoryMode,
  RecordMemoryResult,
  RecordMemoryParams,
  RecallMemoryParams,
} from "@roy-bot/core";
```
