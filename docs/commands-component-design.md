# CommandsComponent 设计文档

## 1. 概述

本文档定义 roy-bot 中 `CommandsComponent` 的设计和实现方案。

**核心设计理念：**
- **动态发现**：命令索引在 `list` 时实时扫描 PATH + 自定义目录
- **缓存复用**：30 分钟缓存提升性能，保证实时性
- **AI 友好**：为 AI 提供系统命令的"知识库"

**使用场景：**
- 构建命令库，方便 AI 了解系统中可用的命令行工具
- `roy` 本身默认在 PATH 中，会自动被发现

---

## 2. 设计决策

| 功能 | 决策 |
|------|------|
| 扫描策略 | 动态扫描：list 时实时扫描 PATH + 用户自定义目录 |
| CLI 过滤 | 必须有 `--help` 或 `-h` |
| 显示信息 | 名称 \| 路径 \| 来源 \| 简短描述 |
| info 展示 | 原始 --help 输出 |
| exec 执行 | 走 ToolComponent 的 bash 工具，捕获 stderr |
| 缓存 | 30 分钟有效期，目录可配置 |
| CLI 结构 | 扁平：list、info、exec、dirs、history |
| 进度提示 | 需要（避免用户失去耐心） |
| 同名命令 | 都保留并标记来源 |
| 过滤模式 | 支持 glob 模式过滤 |

---

## 3. 架构设计

### 3.1 组件职责

```
┌─────────────────────────────────────────────────────────────┐
│              CommandsComponent                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   职责：                                                    │
│   ├── 管理扫描目录配置（持久化）                             │
│   ├── 管理命令索引缓存（cache）                             │
│   ├── 提供命令发现、查询、执行能力                           │
│   └── 提供执行历史记录                                      │
│                                                             │
│   list --cached → 读缓存                                    │
│   list（无缓存）→ 扫描 + 更新缓存                           │
│   info/exec → 读缓存                                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 目录结构

```
packages/core/src/env/commands/
├── commands-component.ts      # 主组件
├── commands-scanner.ts        # 命令扫描器
├── commands-cache.ts          # 缓存管理
├── types.ts                   # 类型定义
└── index.ts                   # 导出

packages/cli/src/commands/
├── commands.ts                 # CLI 主命令（yargs）
├── commands-list.ts            # list 子命令
├── commands-info.ts            # info 子命令
├── commands-exec.ts            # exec 子命令
├── commands-dirs.ts            # dirs 子命令
└── commands-history.ts         # history 子命令
```

---

## 4. CLI 子命令设计

### 4.1 命令列表

```
roy commands list [pattern]              # 列出命令（支持 glob 过滤）
roy commands info <name>                # 查看命令详情（--help）
roy commands add <name> <target>        # 添加收藏命令
roy commands remove <name>              # 移除收藏命令
roy commands dirs                       # 显示命令目录
```

> **注意**：收藏的命令通过符号链接实现，直接执行命令文件即可，无需 `exec` 子命令。

### 4.2 list 子命令

```bash
# 列出所有命令
roy commands list

# 使用缓存（快）
roy commands list --cached

# 过滤命令（glob 模式）
roy commands list git*
roy commands list 'git*'
roy commands list 'npm|node'

# 组合使用
roy commands list --cached git*
```

**输出示例：**
```
NAME      PATH                          SOURCE      DESCRIPTION
────────────────────────────────────────────────────────────────────────────────
git       /usr/bin/git                  /usr/bin    Git version control system
git-lfs   /usr/bin/git-lfs              /usr/bin    Git large file storage
npm       /usr/bin/npm                  /usr/bin    package manager for Node.js
roy       /usr/local/bin/roy            /usr/local  AI CLI tool
node      /usr/bin/node                 /usr/bin    Node.js runtime
```

### 4.3 info 子命令

```bash
# 查看命令详情
roy commands info git

# 显示完整 --help 输出
roy commands info npm
```

**输出示例：**
```
Name: git
Path: /usr/bin/git
Source: /usr/bin (PATH)
────────────────────────────────────────────────────────────────

usage: git [--version] [--help] [-C <path>] [-c <name>=<value>]
           [--exec-path[=<path>]] [--html-path] [--man-path] [--info-path]
           [-p | --paginate | -P | --no-pager] [--no-run-if-empty]
           [--sql-literal-unsafe-squash-unsafe-squash-unsafe-literal-squash]
           [--bare] [--git-dir=<path>] [--work-tree=<path>]
           [--namespace=<name>] [--shared[=<permissions>]]
           <command> [<args>]

These are common Git commands used in various situations:

start a working area (see also: git help tutorial)
   clone     Clone a repository into a new directory
   init      Create an empty Git repository or reinitialize an existing one
   ...
```

### 4.4 dirs 子命令

```bash
# 添加自定义扫描目录
roy commands dirs add ~/.local/bin
roy commands dirs add ./node_modules/.bin

# 移除扫描目录
roy commands dirs remove ~/.local/bin

# 列出所有扫描目录
roy commands dirs list
```

**输出示例：**
```
SOURCE    PATH                      ADDED AT
─────────────────────────────────────────────────────────────────────
PATH      /usr/bin                  -
PATH      /usr/local/bin            -
PATH      /home/user/.npm-global/bin -
CUSTOM    ~/.local/bin              2026-04-03 10:30:00
CUSTOM    ./node_modules/.bin       2026-04-03 11:00:00
```

### 4.6 history 子命令

```bash
# 查看执行历史（默认最近 20 条）
roy commands history

# 指定数量
roy commands history 10
```

**输出示例：**
```
#   COMMAND              EXIT CODE   TIME
─────────────────────────────────────────────────────
1   git status           0           2026-04-03 10:30:00
2   npm install lodash   0           2026-04-03 10:28:00
3   git push             128         2026-04-03 10:25:00
```

---

## 5. 类型定义

### 5.1 配置

```typescript
/**
 * CommandsComponent 配置
 */
export interface CommandsComponentConfig {
  /** 缓存目录（默认：~/.cache/roy-bot/commands） */
  cacheDir?: string;
  /** 缓存有效期（默认：30分钟，单位ms） */
  cacheTTL?: number;
  /** 额外扫描目录（初始化时添加） */
  extraDirs?: string[];
}
```

### 5.2 扫描目录

```typescript
/**
 * 扫描目录
 */
export interface ScanDirectory {
  /** 目录路径 */
  path: string;
  /** 来源：path (PATH环境变量) | custom (用户添加) */
  source: 'path' | 'custom';
  /** 添加时间（仅 custom 目录） */
  addedAt?: number;
}
```

### 5.3 命令索引

```typescript
/**
 * 命令索引
 */
export interface CommandIndex {
  /** 命令名称 */
  name: string;
  /** 命令路径 */
  path: string;
  /** 所属目录 */
  sourceDir: string;
  /** 来源类型 */
  source: 'path' | 'custom';
  /** 简短描述（从 --help 第一行提取） */
  shortDescription: string;
  /** 完整 help 输出 */
  helpOutput?: string;
  /** 是否支持 --help 或 -h */
  hasHelp: boolean;
  /** 最后扫描时间 */
  lastScanned: number;
}
```

### 5.4 扫描结果

```typescript
/**
 * 扫描结果
 */
export interface ScanResult {
  /** 命令列表 */
  commands: CommandIndex[];
  /** 扫描耗时（ms） */
  scanTime: number;
  /** 扫描目录数 */
  totalDirs: number;
  /** 发现文件数 */
  totalFiles: number;
  /** 跳过文件数（非可执行/非CLI） */
  skippedFiles: number;
  /** 缓存时间戳 */
  cachedAt: number;
}
```

### 5.5 执行记录

```typescript
/**
 * 执行记录
 */
export interface ExecutionRecord {
  /** 命令名称 */
  name: string;
  /** 命令路径 */
  path: string;
  /** 执行参数 */
  args: string[];
  /** 工作目录 */
  cwd: string;
  /** 开始时间 */
  startTime: number;
  /** 结束时间 */
  endTime: number;
  /** 执行结果 */
  result: {
    stdout: string;
    stderr: string;
    exitCode: number;
    success: boolean;
  };
}
```

---

## 6. 缓存设计

### 6.1 缓存文件格式

```json
// ~/.cache/roy-bot/commands/index.json
{
  "version": "1.0.0",
  "cachedAt": 1743632400000,
  "ttl": 1800000,
  "commands": [
    {
      "name": "git",
      "path": "/usr/bin/git",
      "sourceDir": "/usr/bin",
      "source": "path",
      "shortDescription": "Git version control system",
      "helpOutput": "usage: git [--version] [--help] ...",
      "hasHelp": true,
      "lastScanned": 1743632400000
    }
  ],
  "stats": {
    "totalDirs": 50,
    "totalFiles": 1200,
    "skippedFiles": 800,
    "scanTime": 3200
  }
}
```

### 6.2 缓存策略

| 操作 | 行为 |
|------|------|
| `list` | 检查缓存存在且未过期（30min）→ 返回缓存，否则扫描 |
| `list --cached` | 强制使用缓存 |
| `list <pattern>` | 扫描后过滤，或从缓存过滤 |
| `info` | 从缓存获取，无缓存则扫描 |
| `exec` | 从缓存获取，无缓存则扫描 |

---

## 7. CommandsComponent API

```typescript
export class CommandsComponent extends BaseComponent {
  readonly name = "commands";
  readonly version = "1.0.0";

  // ========================
  // 目录管理
  // ========================
  
  /**
   * 添加扫描目录
   */
  addDirectory(path: string): Promise<void>;
  
  /**
   * 移除扫描目录
   */
  removeDirectory(path: string): Promise<boolean>;
  
  /**
   * 列出所有扫描目录
   */
  listDirectories(): ScanDirectory[];
  
  // ========================
  // 命令发现
  // ========================
  
  /**
   * 扫描所有目录，发现命令
   * @param options 选项
   * @param options.useCache 是否使用缓存（默认：false）
   * @param options.pattern glob 过滤模式
   * @returns 扫描结果
   */
  discover(options?: { useCache?: boolean; pattern?: string }): Promise<ScanResult>;
  
  /**
   * 获取单个命令详情（从缓存或重新扫描）
   */
  getCommand(name: string): Promise<CommandIndex | undefined>;
  
  /**
   * 获取命令帮助信息
   */
  getHelp(name: string): Promise<string | undefined>;
  
  // ========================
  // 命令执行
  // ========================
  
  /**
   * 执行命令（通过 bash 工具）
   */
  execute(name: string, args?: string[]): Promise<ExecutionRecord>;
  
  /**
   * 获取执行历史
   * @param limit 限制数量
   */
  getHistory(limit?: number): ExecutionRecord[];
  
  // ========================
  // 缓存管理
  // ========================
  
  /**
   * 清除缓存
   */
  clearCache(): Promise<void>;
  
  /**
   * 获取缓存状态
   */
  getCacheStatus(): { exists: boolean; age: number; ttl: number };
}
```

---

## 8. 工作流程

### 8.1 list 工作流程

```
┌─────────────────────────────────────────────────────────────────────┐
│                    roy commands list                                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   1. 检查缓存                                                        │
│      ├── 缓存存在且未过期（30min）→ 返回缓存                         │
│      └── 缓存不存在或已过期 → 继续扫描                               │
│                                                                     │
│   2. 扫描目录                                                        │
│      ├── 获取 $PATH 目录                                            │
│      ├── 合并自定义目录                                              │
│      └── 显示进度：[1/50] 扫描 /usr/bin ...                         │
│                                                                     │
│   3. 发现命令                                                        │
│      ├── 遍历每个目录                                                │
│      ├── 跳过非可执行文件                                            │
│      ├── 检查 --help / -h 支持                                      │
│      └── 提取简短描述（第一行）                                      │
│                                                                     │
│   4. 去重 & 排序                                                    │
│      ├── 同名命令：都保留，标记不同来源                               │
│      └── 按名称排序                                                 │
│                                                                     │
│   5. 保存缓存                                                        │
│      └── 写入 cache/commands-index.json                             │
│                                                                     │
│   6. 应用 glob 过滤（如指定）                                        │
│                                                                     │
│   7. 显示结果                                                        │
│      └── 格式化输出：NAME | PATH | SOURCE | DESCRIPTION            │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 8.2 exec 工作流程

```
┌─────────────────────────────────────────────────────────────────────┐
│                    roy commands exec <name> [args...]                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   1. 查找命令                                                        │
│      ├── 从缓存查找命令路径                                          │
│      └── 未找到则返回错误                                            │
│                                                                     │
│   2. 执行命令                                                        │
│      ├── 调用 ToolComponent 的 bash 工具                             │
│      ├── 传入命令和参数                                             │
│      ├── 捕获 stdout 和 stderr                                       │
│      └── 记录执行结果                                                │
│                                                                     │
│   3. 显示结果                                                        │
│      ├── 输出 stdout                                                 │
│      ├── 如果有 stderr，显示错误                                     │
│      └── 显示退出码和状态                                            │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 9. 进度提示设计

### 9.1 扫描进度

```
$ roy commands list

🔍 正在扫描命令...
[1/50] 扫描 /usr/bin       - 120 个文件
[2/50] 扫描 /usr/local/bin - 45 个文件
[3/50] 扫描 ~/.npm/bin     - 80 个文件
...
[50/50] 扫描完成

✅ 发现 520 个命令（跳过 680 个非 CLI 工具）
⏱️  扫描耗时 3.2s

NAME      PATH                          SOURCE      DESCRIPTION
────────────────────────────────────────────────────────────────────────────────
...
```

### 9.2 进度更新策略

- 每秒更新一次进度
- 显示当前目录和已扫描文件数
- 避免频繁刷新（设置最小间隔 100ms）

---

## 10. 与其他组件的关系

### 10.1 依赖关系

```
┌─────────────────────────────────────────────────────────────┐
│              CommandsComponent 依赖关系                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   CommandsComponent                                          │
│   ├── 依赖 ConfigComponent（配置管理）                       │
│   ├── 依赖 ToolComponent（bash 工具执行）                    │
│   └── 依赖 SessionComponent（持久化机制参考）                 │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 10.2 持久化参考 SessionComponent

- 目录配置：存储到 state/commands/directories.json
- 缓存索引：存储到 cache/commands/index.json
- 执行历史：存储到 state/commands/history.json

---

## 11. 实现优先级

### Phase 1: 核心功能
1. CommandsComponent 基础框架
2. 命令扫描器（Scanner）
3. 缓存管理（Cache）
4. list 子命令

### Phase 2: 增强功能
5. info 子命令
6. exec 子命令
7. dirs 子命令

### Phase 3: 完善功能
8. history 子命令
9. 进度提示优化
10. glob 过滤

---

## 12. 注意事项

1. **性能考虑**：PATH 可能包含大量目录，需要异步扫描和进度提示
2. **安全考虑**：不限制执行命令，由用户自行决定
3. **缓存一致性**：30 分钟过期保证实时性
4. **同名命令处理**：都保留，用户可通过 `name@source` 区分

---

*文档版本：1.0.0*
*创建时间：2026-04-03*
