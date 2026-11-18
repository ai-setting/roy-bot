# Session Command 增强设计文档

> 版本: 1.1.0 | 日期: 2026-04-01 | 状态: 📝 设计中

---

## 1. 概述

### 1.1 设计目标

基于 roy-bot 的 Component 架构和 CLI 设计规范，为 `@roy-bot/cli` 设计一套完整的 `sessions` 子命令系统，实现会话的 CRUD、消息管理、搜索过滤、导入导出、**Checkpoint 压缩**等能力。

### 1.2 设计原则

| 原则 | 说明 |
|------|------|
| **CLI 规范遵循** | 遵循 `cli-implementation-design.md` 中的设计模式 |
| **Component 驱动** | 通过 SessionComponent 提供的能力实现功能 |
| **非交互优先** | 所有操作通过命令行参数完成，适合脚本集成 |
| **渐进增强** | 支持 `--json` 输出原始数据，也支持友好的表格展示 |
| **类型安全** | 复用 core 中定义的 Session 类型 |
| **Checkpoint 优先** | 默认从最近 checkpoint 读取上下文，避免冗余 |

### 1.3 与现有命令的关系

```
roy act        # 自然语言交互（核心命令）
roy sessions   # 会话管理（本次设计）
roy tasks      # 任务管理（待实现）
roy memory     # 记忆管理（待实现）
roy config     # 配置管理（待实现）
```

---

## 2. 整体架构

### 2.1 命令结构

```
roy sessions [action] [options]

Actions:
  list       列出所有会话（默认）
  get        获取会话详情
  new        创建新会话
  rename     更新会话标题 ⭐ 新增
  delete     删除会话
  search     搜索会话
  messages   查看会话消息
  compact    压缩会话（创建Checkpoint） ⭐ 新增
  checkpoints 查看会话的检查点列表 ⭐ 新增
  export     导出会话
  import     导入会话
  use        切换活跃会话
  active     查看/设置当前活跃会话
```

### 2.2 目录结构

```
packages/cli/src/
├── cli.ts                    # 主入口（添加 sessions 命令）
│
├── commands/
│   ├── act.ts               # 已实现
│   ├── sessions/            # sessions 子命令目录
│   │   ├── index.ts        # sessions 命令入口
│   │   ├── list.ts         # list 子命令
│   │   ├── get.ts          # get 子命令
│   │   ├── new.ts          # new 子命令
│   │   ├── rename.ts        # rename 子命令 ⭐
│   │   ├── delete.ts       # delete 子命令
│   │   ├── search.ts       # search 子命令
│   │   ├── messages.ts     # messages 子命令
│   │   ├── compact.ts       # compact 子命令 ⭐
│   │   ├── checkpoints.ts  # checkpoints 子命令 ⭐
│   │   ├── export.ts       # export 子命令
│   │   ├── import.ts       # import 子命令
│   │   ├── use.ts          # use 子命令
│   │   └── active.ts       # active 子命令
│   │
│   └── shared/             # 共享工具
│       ├── session-formatter.ts  # 会话格式化
│       └── session-validator.ts  # 会话验证
│
└── services/
    └── environment.service.ts  # 复用（已存在）
```

---

## 3. 类型定义

### 3.1 CLI 层类型（复用 Core）

```typescript
// 复用 @roy-bot/core 中的类型
import type {
  Session,
  SessionMessage,
  SessionCheckpoint,     // ⭐ 新增
  CreateSessionOptions,
  UpdateSessionOptions,
  ListSessionsOptions,
  CompactOptions,         // ⭐ 新增
  CheckpointMeta,         // ⭐ 新增
} from "@roy-bot/core";
```

### 3.2 CLI 专用输出类型

```typescript
/**
 * CLI 会话列表项（精简版，用于 list 输出）
 */
export interface SessionListItem {
  id: string;
  title: string;
  directory: string;
  createdAt: string;      // 格式化的时间字符串
  updatedAt: string;
  messageCount: number;
  isActive: boolean;
  hasCheckpoint: boolean;  // ⭐ 是否有 checkpoint
  lastCheckpointAt?: string; // ⭐ 最近 checkpoint 时间
}

/**
 * CLI 会话详情
 */
export interface SessionDetail {
  id: string;
  title: string;
  directory: string;
  parentID?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  isActive: boolean;
  metadata?: Record<string, unknown>;
  checkpoints?: CheckpointItem[]; // ⭐ 包含 checkpoint 列表
}

/**
 * CLI Checkpoint 项
 */
export interface CheckpointItem {
  id: string;
  messageIndex: number;      // 起始消息索引
  type: "compact" | "manual"; // checkpoint 类型
  title: string;              // checkpoint 标题
  summary: string;           // 摘要内容
  processKeyPoints: string[]; // 过程要点 ⭐
  currentState: string;      // 现状提取 ⭐
  createdAt: string;
  messageCountBefore: number; // checkpoint 前的消息数
}

/**
 * CLI 消息项
 */
export interface MessageItem {
  id: string;
  role: string;
  content: string;
  timestamp: string;
  parts?: MessagePartItem[];
  afterCheckpoint?: string; // ⭐ 所属 checkpoint ID
}

/**
 * CLI Compact 结果
 */
export interface CompactResult {
  checkpoint: CheckpointItem;
  deletedMessageCount: number;
  remainingMessageCount: number;
  checkpointCount: number;
}

/**
 * CLI 导出格式
 */
export interface SessionExportData {
  version: "1.0";
  exportedAt: string;
  session: {
    id: string;
    title: string;
    directory: string;
    parentID?: string;
    createdAt: number;
    updatedAt: number;
    metadata?: Record<string, unknown>;
    checkpoints?: CheckpointMeta[]; // ⭐ 包含 checkpoints
  };
  messages: Array<{
    id: string;
    role: string;
    content: string;
    timestamp: number;
    parts?: unknown[];
  }>;
}
```

---

## 4. 子命令设计

### 4.0 `sessions rename` - 更新会话标题 ⭐ 新增

**命令格式：**
```bash
roy sessions rename <session-id> <new-title>
roy sessions rename <session-id> --title <new-title>  # 别名方式
roy sessions mv <session-id> <new-title>              # 短别名
```

**选项：**

| 选项 | 别名 | 类型 | 说明 |
|------|------|------|------|
| `--title` | `-t` | string | 新标题（位置参数或选项） |
| `--json` | | boolean | JSON 格式输出 |

**输出示例：**
```
$ roy sessions rename sess_abc123 "API Bug Fix Task"
✓ Session updated: sess_abc123
✓ New title: API Bug Fix Task

# JSON 模式
$ roy sessions rename sess_abc123 "API Bug Fix Task" --json
{
  "success": true,
  "session": {
    "id": "sess_abc123",
    "title": "API Bug Fix Task",
    "updatedAt": "2026-04-01T10:30:00.000Z"
  }
}
```

---

### 4.1 `sessions list` - 列出所有会话

**命令格式：**
```bash
roy sessions list [options]
roy sessions ls [options]          # 别名
```

**选项：**

| 选项 | 别名 | 类型 | 默认值 | 说明 |
|------|------|------|--------|------|
| `--limit` | `-n` | number | 20 | 限制返回数量 |
| `--offset` | | number | 0 | 跳过数量（分页） |
| `--sort` | | string | "updatedAt" | 排序字段 |
| `--order` | | string | "desc" | 排序方向 |
| `--directory` | `-d` | string | | 按工作目录筛选 |
| `--active` | `-a` | boolean | | 只显示活跃会话 |
| `--has-checkpoint` | | boolean | | 只显示有 checkpoint 的会话 |
| `--json` | `-j` | boolean | false | JSON 格式输出 |
| `--quiet` | `-q` | boolean | false | 简洁输出（只显示 ID） |

**输出示例：**

```
# 默认表格输出（新增 checkpoint 列）
$ roy sessions list
┌─ Sessions ─────────────────────────────────────────────────────────────────┐
│ #   Title                    Directory        Msgs  Checkpoint  Updated           │
├────────────────────────────────────────────────────────────────────────────┤
│ 1   Session - 2026-04-01    /home/user/prj  12    ✓ 10:30     2026-04-01 10:30 │
│ 2 ▶ Code Review Task        /home/user/prj  5     -           2026-04-01 09:15 │
│ 3   API Investigation       /home/api/srv   156   ✓ 18:20     2026-03-31 18:20 │
└────────────────────────────────────────────────────────────────────────────┘
Total: 3 sessions, 2 with checkpoints
```

---

### 4.2 `sessions get` - 获取会话详情

**命令格式：**
```bash
roy sessions get <session-id> [options]
roy sessions show <session-id> [options]  # 别名
```

**选项：**

| 选项 | 类型 | 说明 |
|------|------|------|
| `--messages` | boolean | 同时获取消息列表 |
| `--limit` | number | 消息数量限制 |
| `--from-checkpoint` | string | 从指定 checkpoint 开始读取 ⭐ |
| `--include-checkpoints` | boolean | 包含 checkpoint 列表 ⭐ |
| `--json` | boolean | JSON 格式输出 |

**输出示例：**
```
$ roy sessions get sess_abc123 --include-checkpoints
┌─ Session Details ────────────────────────────────────────────────────┐
│ ID:          sess_abc123                                             │
│ Title:       API Investigation                                      │
│ Directory:   /home/api/srv                                          │
│ Created:     2026-04-01 08:00                                       │
│ Updated:     2026-04-01 10:30                                        │
│ Messages:    156                                                    │
│ Active:      ✓                                                       │
├─ Checkpoints (3) ────────────────────────────────────────────────────┤
│ #1  2026-03-31 18:20  "完成初步调研，定位问题在 Auth 模块"              │
│ #2  2026-03-30 15:00  "分析了请求流程，发现 token 验证问题"             │
│ #3  2026-03-30 09:00  "开始调查 API 响应超时问题"                      │
└────────────────────────────────────────────────────────────────────┘
```

---

### 4.3 `sessions new` - 创建新会话

**命令格式：**
```bash
roy sessions new [options]
roy sessions create [options]  # 别名
```

**选项：**

| 选项 | 别名 | 类型 | 默认值 | 说明 |
|------|------|------|--------|------|
| `--title` | `-t` | string | 自动生成 | 会话标题 |
| `--directory` | `-d` | string | cwd | 工作目录 |
| `--parent` | `-p` | string | | 父会话 ID（分支） |
| `--set-active` | `-s` | boolean | false | 创建后设为活跃 |
| `--json` | | boolean | false | JSON 格式输出 |

---

### 4.4 `sessions delete` - 删除会话

**命令格式：**
```bash
roy sessions delete <session-id> [options]
roy sessions rm <session-id> [options]  # 别名
```

**选项：**

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `--force` | boolean | false | 跳过确认 |
| `--keep-checkpoints` | boolean | false | ⭐ 只删除消息，保留 checkpoints |
| `--active` | boolean | false | 删除当前活跃会话 |

---

### 4.5 `sessions compact` - 压缩会话 ⭐ 核心新增

**命令格式：**
```bash
roy sessions compact <session-id> [options]
roy sessions compress <session-id> [options>  # 别名
roy sessions checkpoint <session-id> [options> # 别名
```

**选项：**

| 选项 | 别名 | 类型 | 默认值 | 说明 |
|------|------|------|--------|------|
| `--title` | `-t` | string | 自动生成 | Checkpoint 标题 |
| `--summary` | `-s` | string | | ⭐ 手动提供的摘要（AI 生成时用作提示） |
| `--process-key-points` | | string | | ⭐ 过程要点提示（逗号分隔） |
| `--current-state` | | string | | ⭐ 当前状态描述提示 |
| `--next-steps` | | string | | ⭐ 后续待跟进提示（逗号分隔） |
| `--auto` | | boolean | false | 自动触发（达到阈值时） |
| `--threshold` | | number | 80 | ⭐ 触发阈值（消息数或 context 百分比） |
| `--dry-run` | | boolean | false | 预览压缩效果，不实际执行 |
| `--force` | `-f` | boolean | false | 强制压缩，跳过确认 |
| `--json` | | boolean | false | JSON 格式输出 |

**Compact 实现原理：**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Compact 实现流程                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. 收集消息                                                                │
│     └─ 从最新 checkpoint 到当前的所有消息                                     │
│                                                                             │
│  2. 调用 Summary Agent                                                      │
│     ├─ PromptComponent 渲染 "session/compact" prompt                        │
│     ├─ LLM 提取：processKeyPoints / currentState / nextSteps                │
│     └─ 返回结构化 checkpoint 数据                                           │
│                                                                             │
│  3. 保存 Checkpoint                                                        │
│     ├─ checkpoint 存储到 session.metadata                                    │
│     ├─ 消息标记为 isArchived                                                │
│     └─ ⭐ 生成 user role 的 checkpoint 消息加入对话历史                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Checkpoint 消息格式（user role）：**

```markdown
# Checkpoint: 完成 Auth 模块修复

## Process Key Points
1. 确认问题出在 token 验证中间件
2. 分析了 Auth 模块的请求处理流程
3. 发现 refresh_token 计算公式有误
4. 修复了过期时间戳的计算逻辑

## Current State
Auth 模块修复已完成，token 验证逻辑正确。需要测试 edge cases。

## Next Steps
1. 测试 token 刷新的边界情况
2. 验证 refresh_token 流程

## Messages Compacted
50 messages compacted at 2026-04-01 10:30
```

**输出示例：**
```
$ roy sessions compact sess_abc123
🔍 Analyzing session context...
📊 Session: API Investigation
   Total messages: 156
   Since last checkpoint: 46 messages
   Context usage: 72%

✨ Creating checkpoint...

┌─ Checkpoint Created ──────────────────────────────────────────────────┐
│ ID:          cp_xyz789                                                │
│ Title:       完成 Auth 模块修复                                        │
│ Type:        compact                                                  │
│ Created:     2026-04-01 10:30                                        │
├─ Summary ─────────────────────────────────────────────────────────────┤
│ 分析了 API 请求流程，发现 token 验证逻辑存在问题。已定位到 Auth 模块    │
│ 的中间件配置错误，修复了 token 过期时间计算公式。                        │
├─ Process Key Points ──────────────────────────────────────────────────┤
│ 1. 确认问题出在 token 验证中间件                                       │
│ 2. 分析了 Auth 模块的请求处理流程                                       │
│ 3. 发现 refresh_token 计算公式有误                                       │
│ 4. 修复了过期时间戳的计算逻辑                                           │
├─ Current State ───────────────────────────────────────────────────────┤
│ Auth 模块修复已完成，token 验证逻辑正确。需要测试 edge cases。          │
└───────────────────────────────────────────────────────────────────────┘
✓ Messages compacted: 46
✓ Remaining messages: 110 (including this checkpoint)
```

**Dry Run 预览：**
```
$ roy sessions compact sess_abc123 --dry-run
🔍 Preview - no changes will be made

   Messages to compact: 46
   Checkpoint would include:
   - Summary: ~150 tokens
   - Process Key Points: ~80 tokens
   - Current State: ~60 tokens
   
   After compact:
   - Messages would be: 110
   - New checkpoint would be created
```

---

### 4.6 `sessions checkpoints` - 查看检查点列表 ⭐ 新增

**命令格式：**
```bash
roy sessions checkpoints <session-id> [options]
roy sessions checkpoints list <session-id> [options]  # 完整方式
roy sessions cps <session-id> [options]               # 短别名
```

**选项：**

| 选项 | 别名 | 类型 | 说明 |
|------|------|------|------|
| `--detail` | `-d` | boolean | 显示详细信息 |
| `--json` | `-j` | boolean | JSON 格式输出 |

**输出示例：**
```
$ roy sessions checkpoints sess_abc123
┌─ Checkpoints ─────────────────────────────────────────────────────────┐
│ #1  cp_xyz789   2026-03-31 18:20  ✓ Latest                            │
│     "完成 Auth 模块修复"                                                 │
│     Process: 4 points | State: Edge case testing needed              │
├────────────────────────────────────────────────────────────────────────┤
│ #2  cp_abc123   2026-03-30 15:00                                     │
│     "定位 token 验证问题"                                               │
│     Process: 3 points | State: Ready to fix                          │
├────────────────────────────────────────────────────────────────────────┤
│ #3  cp_001      2026-03-30 09:00                                     │
│     "开始调查 API 响应超时"                                             │
│     Process: 2 points | State: Problem located                      │
└────────────────────────────────────────────────────────────────────┘
Total: 3 checkpoints

# 查看详细信息
$ roy sessions checkpoints sess_abc123 --detail
┌─ Checkpoint: cp_xyz789 ───────────────────────────────────────────────┐
│ Title:       完成 Auth 模块修复                                        │
│ Type:        compact                                                  │
│ Message Index: 110 (compacted 46 messages)                            │
│ Created:     2026-04-01 10:30                                         │
├─ Summary ─────────────────────────────────────────────────────────────┤
│ 分析了 API 请求流程，发现 token 验证逻辑存在问题。已定位到 Auth 模块    │
│ 的中间件配置错误，修复了 token 过期时间计算公式。                        │
├─ Process Key Points ──────────────────────────────────────────────────┤
│ 1. 确认问题出在 token 验证中间件                                       │
│ 2. 分析了 Auth 模块的请求处理流程                                       │
│ 3. 发现 refresh_token 计算公式有误                                       │
│ 4. 修复了过期时间戳的计算逻辑                                           │
├─ Current State ───────────────────────────────────────────────────────┤
│ Auth 模块修复已完成，token 验证逻辑正确。需要测试 edge cases。          │
└────────────────────────────────────────────────────────────────────┘
```

---

### 4.7 `sessions search` - 搜索会话

**命令格式：**
```bash
roy sessions search <keyword> [options]
roy sessions find <keyword> [options>  # 别名
```

**选项：**

| 选项 | 类型 | 说明 |
|------|------|------|
| `--title` | boolean | 只搜索标题（默认） |
| `--checkpoint` | boolean | 搜索 checkpoints ⭐ |
| `--directory` | boolean | 搜索工作目录 |
| `--content` | boolean | 搜索消息内容 |
| `--limit` | number | 结果数量限制 |
| `--json` | boolean | JSON 格式输出 |

---

### 4.8 `sessions messages` - 查看消息

**命令格式：**
```bash
roy sessions messages <session-id> [options]
roy sessions msgs <session-id> [options>  # 别名
```

**选项：**

| 选项 | 别名 | 类型 | 默认值 | 说明 |
|------|------|------|--------|------|
| `--limit` | `-n` | number | 50 | 消息数量 |
| `--offset` | | number | 0 | 跳过数量 |
| `--checkpoint` | `-c` | string | | ⭐ 从指定 checkpoint 开始读取 |
| `--latest` | `-l` | boolean | false | ⭐ 只显示最近 checkpoint 之后的消息 |
| `--role` | | string | | 按角色筛选 |
| `--json` | | boolean | false | JSON 格式输出 |
| `--reverse` | `-r` | boolean | false | 倒序显示 |

**读取上下文语义（⭐ 核心设计）：**

```
┌─────────────────────────────────────────────────────────────────┐
│                    Session 上下文读取顺序                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  默认读取（无参数）:                                             │
│  ┌──────────┐   ┌────────────────┐   ┌────────────────────────┐ │
│  │ Summary  │ + │ Latest Check  │ + │ Messages since check  │ │
│  │ (init)   │   │ (cp_xyz789)   │   │ (msg_111, 112, ...)   │ │
│  └──────────┘   └────────────────┘   └────────────────────────┘ │
│                                                                 │
│  读取完整历史:                                                    │
│  ┌──────────┐   ┌────────────────┐   ┌────────────────────────┐ │
│  │ Summary  │ + │   Checkpoint   │ + │ All Messages          │ │
│  │ (init)   │   │   1, 2, 3...   │   │ (msg_001, 002, ...)   │ │
│  └──────────┘   └────────────────┘   └────────────────────────┘ │
│                                                                 │
│  从特定 checkpoint 读取:                                          │
│  --checkpoint cp_abc123                                          │
│  ┌──────────┐   ┌────────────────┐   ┌────────────────────────┐ │
│  │ Summary  │ + │ Checkpoint     │ + │ Messages since cp     │ │
│  │ (init)   │   │ cp_abc123      │   │ (msg_xxx, ...)        │ │
│  └──────────┘   └────────────────┘   └────────────────────────┘ │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

### 4.9 `sessions export` - 导出会话

**命令格式：**
```bash
roy sessions export <session-id> [options]
roy sessions dump <session-id> [options>  # 别名
```

**选项：**

| 选项 | 类型 | 说明 |
|------|------|------|
| `--output` | string | 输出文件路径（默认 stdout） |
| `--include-messages` | boolean | 包含消息（默认 true） |
| `--include-checkpoints` | boolean | ⭐ 包含 checkpoints（默认 true） |
| `--from-checkpoint` | string | ⭐ 从指定 checkpoint 开始导出 |
| `--format` | string | 格式: json (默认) |

**导出格式：**
```json
{
  "version": "1.0",
  "exportedAt": "2026-04-01T10:30:00.000Z",
  "session": {
    "id": "sess_abc123",
    "title": "API Investigation",
    "directory": "/home/api/srv",
    "createdAt": 1743475200000,
    "updatedAt": 1743480600000
  },
  "checkpoints": [
    {
      "id": "cp_001",
      "messageIndex": 0,
      "title": "开始调查 API 响应超时",
      "summary": "...",
      "processKeyPoints": ["分析请求流程", "确认问题位置"],
      "currentState": "问题已定位到 Auth 模块",
      "createdAt": 1743475200000
    }
  ],
  "messages": [...]
}
```

---

### 4.10 `sessions import` - 导入会话

**命令格式：**
```bash
roy sessions import <file> [options]
roy sessions load <file> [options>  # 别名
```

**选项：**

| 选项 | 类型 | 说明 |
|------|------|------|
| `--title` | string | 覆盖会话标题 |
| `--directory` | string | 覆盖工作目录 |
| `--set-active` | boolean | 导入后设为活跃 |
| `--generate-id` | boolean | 生成新 ID（默认 true） |
| `--import-checkpoints` | boolean | ⭐ 导入 checkpoints（默认 true） |

---

### 4.11 `sessions use` - 切换会话

**命令格式：**
```bash
roy sessions use <session-id>
roy sessions switch <session-id>  # 别名
```

**输出示例：**
```
$ roy sessions use sess_abc123
✓ Switched to session: sess_abc123
✓ Title: API Investigation
✓ Context: Loading from checkpoint cp_xyz789 (110 messages)
```

---

### 4.12 `sessions active` - 活跃会话管理

**命令格式：**
```bash
roy sessions active [options]
roy sessions current [options>  # 别名
```

**选项：**

| 选项 | 类型 | 说明 |
|------|------|------|
| `--clear` | boolean | 清除活跃会话 |
| `--checkpoint` | string | ⭐ 设置活跃会话的起始 checkpoint |
| `--json` | boolean | JSON 格式输出 |

---

## 5. 全局选项

所有 `sessions` 子命令支持以下全局选项：

| 选项 | 说明 |
|------|------|
| `--config <path>` | 指定配置文件路径 |
| `--env <name>` | 指定环境名称 |
| `--quiet` | 安静模式 |
| `--json` | JSON 输出格式 |
| `--no-color` | 禁用颜色输出 |

---

## 6. 实现设计

### 6.1 核心服务封装

```typescript
// src/commands/sessions/session-service.ts

import { BaseEnvironment, SessionComponent } from "@roy-bot/core";
import { OutputService } from "../../services/output.service";
import type {
  Session,
  SessionMessage,
  SessionCheckpoint,      // ⭐ 新增
  CreateSessionOptions,
  UpdateSessionOptions,
  ListSessionsOptions,
  CompactOptions,         // ⭐ 新增
  SessionListItem,
  SessionDetail,
  MessageItem,
  CheckpointItem,        // ⭐ 新增
  CompactResult,          // ⭐ 新增
  SessionExportData,
} from "./types";

export class SessionService {
  private env: BaseEnvironment;
  private sessionComponent: SessionComponent;
  private output: OutputService;

  constructor(env: BaseEnvironment, output: OutputService) {
    this.env = env;
    this.sessionComponent = env.getComponent("session") as SessionComponent;
    this.output = output;
  }

  // === List ===
  async list(options?: ListSessionsOptions): Promise<SessionListItem[]>;

  // === Get ===
  async get(id: string, options?: GetOptions): Promise<SessionDetail | undefined>;

  // === Create ===
  async create(options?: CreateSessionOptions): Promise<Session>;

  // === Rename ⭐ ===
  async rename(id: string, newTitle: string): Promise<Session>;

  // === Delete ===
  async delete(id: string, options?: DeleteOptions): Promise<boolean>;

  // === Search ===
  async search(keyword: string, options?: SearchOptions): Promise<SessionListItem[]>;

  // === Messages ===
  async getMessages(sessionId: string, options?: MessageQueryOptions): Promise<MessageItem[]>;

  // === Compact ⭐ ===
  async compact(sessionId: string, options?: CompactOptions): Promise<CompactResult>;
  async previewCompact(sessionId: string, options?: CompactOptions): Promise<CompactPreview>;

  // === Checkpoints ⭐ ===
  async getCheckpoints(sessionId: string): Promise<CheckpointItem[]>;
  async getCheckpoint(sessionId: string, checkpointId: string): Promise<CheckpointItem | undefined>;
  async deleteCheckpoint(sessionId: string, checkpointId: string): Promise<boolean>;

  // === Export/Import ===
  async export(sessionId: string, options?: ExportOptions): Promise<SessionExportData>;
  async import(data: SessionExportData, options?: ImportOptions): Promise<Session>;

  // === Active Session ===
  getActiveSession(): Session | undefined;
  getActiveSessionId(): string | undefined;
  async setActiveSession(id: string, checkpointId?: string): Promise<boolean>;
  async clearActiveSession(): Promise<void>;

  // === Context Reading ⭐ ===
  async getContext(sessionId: string, options?: ContextOptions): Promise<ContextResult>;

  // === 辅助方法 ===
  private formatSession(session: Session): SessionListItem;
  private formatCheckpoint(checkpoint: SessionCheckpoint): CheckpointItem;
  private formatMessage(message: SessionMessage, checkpointId?: string): MessageItem;
  private formatTimestamp(ts: number): string;
}
```

### 6.2 Context 读取接口 ⭐

```typescript
// Context 读取选项
interface ContextOptions {
  /** 从指定 checkpoint 开始读取 */
  fromCheckpoint?: string;
  
  /** 从最新 checkpoint 开始读取（默认 true） */
  fromLatestCheckpoint?: boolean;
  
  /** 包含 checkpoints 信息 */
  includeCheckpoints?: boolean;
  
  /** 消息数量限制 */
  messageLimit?: number;
  
  /** 读取完整历史（忽略 checkpoints） */
  fullHistory?: boolean;
}

// Context 读取结果
interface ContextResult {
  session: Session;
  
  /** 上下文摘要 */
  summary?: string;
  
  /** 包含的 checkpoints */
  checkpoints: CheckpointItem[];
  
  /** 起始 checkpoint */
  startCheckpoint?: CheckpointItem;
  
  /** 消息列表（从起始 checkpoint 开始） */
  messages: MessageItem[];
  
  /** 总消息数 */
  totalMessageCount: number;
  
  /** 上下文使用的 token 估算 */
  estimatedTokens: number;
}
```

### 6.3 Compact 服务 ⭐

```typescript
// src/commands/sessions/compact-service.ts

export interface CompactServiceOptions {
  /** LLM 用于生成 checkpoint */
  llmComponent: LLMComponent;
  
  /** 用于 token 计数 */
  tokenizer?: Tokenizer;
}

/**
 * CompactService - 负责会话压缩和 checkpoint 生成
 */
export class CompactService {
  constructor(options: CompactServiceOptions);
  
  /**
   * 生成 checkpoint
   * 
   * 1. 收集需要压缩的消息
   * 2. 调用 LLM 生成 checkpoint 内容
   * 3. 返回生成的 checkpoint
   */
  async generateCheckpoint(
    session: Session,
    messages: SessionMessage[],
    options?: GenerateCheckpointOptions
  ): Promise<GeneratedCheckpoint>;
  
  /**
   * 预览压缩效果
   */
  async preview(
    session: Session,
    options?: PreviewOptions
  ): Promise<CompactPreview>;
  
  /**
   * 执行压缩
   */
  async execute(
    sessionId: string,
    checkpoint: GeneratedCheckpoint
  ): Promise<CompactResult>;
}

/**
 * 生成的 checkpoint
 */
interface GeneratedCheckpoint {
  title: string;
  summary: string;
  processKeyPoints: string[];
  currentState: string;
  messageCount: number;
  estimatedTokens: number;
}

/**
 * 压缩预览
 */
interface CompactPreview {
  sessionId: string;
  messageCountToCompact: number;
  estimatedCheckpointTokens: number;
  estimatedRemainingTokens: number;
  wouldTrigger: boolean;
}

/**
 * 压缩结果
 */
interface CompactResult {
  checkpoint: CheckpointItem;
  deletedMessageCount: number;
  remainingMessageCount: number;
  checkpointCount: number;
  newContextTokens: number;
}
```

### 6.4 LLM Prompt 模板 ⭐

```typescript
// src/prompts/compact-prompt.ts

/**
 * Checkpoint 生成 Prompt
 */
export const COMPACT_SYSTEM_PROMPT = `你是一个专业的会话分析助手。你的任务是从一段对话中提取关键信息，生成一个结构化的 checkpoint。

checkpoint 应该包含：
1. **Summary**: 整体摘要，简要描述这段对话的核心内容和目标
2. **Process Key Points**: 过程要点，列出本次对话中的关键步骤、发现或决策
3. **Current State**: 当前状态，描述对话结束时的进展和下一步方向

请用简洁、准确的语言描述，避免冗余。`;

/**
 * User Prompt 模板
 */
export function buildCompactUserPrompt(
  messages: SessionMessage[],
  manualSummary?: string
): string {
  const messageList = messages
    .map((m) => `[${m.role}]: ${m.content}`)
    .join("\n\n");
  
  let prompt = `请分析以下对话，生成 checkpoint：\n\n${messageList}`;
  
  if (manualSummary) {
    prompt += `\n\n用户提供的摘要提示：${manualSummary}`;
  }
  
  return prompt;
}

/**
 * 输出格式要求
 */
export const COMPACT_OUTPUT_FORMAT = `请按以下 JSON 格式输出：

{
  "title": "简短的 checkpoint 标题（不超过 50 字）",
  "summary": "整体摘要（100-200 字）",
  "processKeyPoints": ["要点1", "要点2", "要点3"],
  "currentState": "当前状态描述（50-100 字）"
}`;
```

---

## 7. 输出格式化

### 7.1 表格格式化

```typescript
// src/commands/shared/session-formatter.ts

import chalk from "chalk";
import type { SessionListItem, CheckpointItem } from "../sessions/types";

/**
 * 格式化会话表格（带 checkpoint 列）
 */
export function formatSessionTable(sessions: SessionListItem[]): string {
  // ... 实现带 checkpoint 列的表格
}

/**
 * 格式化 Checkpoint 列表
 */
export function formatCheckpointList(
  checkpoints: CheckpointItem[],
  options?: { detail?: boolean }
): string {
  // ... 实现 checkpoint 列表展示
}
```

---

## 8. 实现计划

### Phase 1: 基础命令
- [ ] `sessions list` - 列出所有会话（更新：带 checkpoint 列）
- [ ] `sessions get` - 获取会话详情（更新：支持 checkpoints）
- [ ] `sessions new` - 创建新会话
- [ ] `sessions rename` - 更新会话标题 ⭐
- [ ] `sessions delete` - 删除会话

### Phase 2: Checkpoint 功能 ⭐
- [ ] `sessions compact` - 压缩会话（核心）
- [ ] `sessions checkpoints` - 查看检查点列表
- [ ] LLM Prompt 模板
- [ ] Checkpoint 生成服务
- [ ] Context 读取接口

### Phase 3: 增强功能
- [ ] `sessions search` - 搜索会话（支持 checkpoint）
- [ ] `sessions messages` - 查看消息（支持 from-checkpoint）
- [ ] `sessions active` - 活跃会话管理（支持 checkpoint）
- [ ] `sessions use` - 切换会话

### Phase 4: 导入导出
- [ ] `sessions export` - 导出会话（支持 checkpoints）
- [ ] `sessions import` - 导入会话

### Phase 5: 自动化
- [ ] 自动 compact 触发器
- [ ] 上下文使用监控
- [ ] 智能 checkpoint 建议

---

## 9. Checkpoint 核心设计 ⭐

### 9.1 Checkpoint 数据结构

```typescript
/**
 * Checkpoint 元信息
 */
interface CheckpointMeta {
  id: string;
  messageIndex: number;           // 起始消息的索引位置
  title: string;                 // 简短的标题
  createdAt: number;             // 创建时间
  type: "compact" | "manual";    // 类型
}

/**
 * 完整 Checkpoint 信息（包含生成的内容）
 */
interface SessionCheckpoint extends CheckpointMeta {
  summary: string;              // 整体摘要
  processKeyPoints: string[];    // 过程要点
  currentState: string;         // 当前状态
  messageCountBefore: number;   // checkpoint 前的消息数量
  metadata?: Record<string, unknown>;
}

/**
 * Session.metadata 中 checkpoints 字段结构
 */
interface SessionCheckpointsMeta {
  latestCheckpointId?: string;  // 最新 checkpoint ID
  checkpoints: CheckpointMeta[]; // checkpoint 列表（简化信息）
}
```

### 9.2 Session.metadata 结构

```typescript
interface Session {
  id: string;
  title: string;
  directory: string;
  parentID?: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  metadata?: {
    // ... 其他字段
    
    // ⭐ Checkpoint 相关
    checkpoints?: {
      latestCheckpointId?: string;
      checkpoints: Array<{
        id: string;
        messageIndex: number;
        title: string;
        createdAt: number;
        type: "compact" | "manual";
      }>;
    };
    
    // 完整 checkpoint 内容（可选，可分离存储）
    checkpointDetails?: Record<string, SessionCheckpoint>;
  };
}
```

### 9.3 消息存储结构

```typescript
interface SessionMessage {
  id: string;
  sessionID: string;
  role: Role;
  content: string;
  timestamp: number;
  parts?: MessagePart[];
  
  // ⭐ 新增字段
  isArchived?: boolean;           // 是否已归档（被 compact）
  archivedAt?: number;           // 归档时间
  checkpointId?: string;         // 所属 checkpoint
}
```

### 9.4 上下文读取算法

```typescript
/**
 * 获取会话上下文
 * 
 * @param sessionId 会话 ID
 * @param options 读取选项
 * @returns 上下文字符串
 */
async function getSessionContext(
  sessionId: string,
  options: {
    fromCheckpoint?: string;      // 从指定 checkpoint 开始
    fromLatestCheckpoint?: boolean; // 从最新 checkpoint 开始（默认）
    fullHistory?: boolean;         // 读取完整历史
    messageLimit?: number;         // 消息数量限制
  }
): Promise<string> {
  const session = await sessionComponent.get(sessionId);
  const checkpoints = session.metadata?.checkpoints?.checkpoints || [];
  
  let startIndex = 0;
  let startCheckpoint: SessionCheckpoint | undefined;
  
  if (!options.fullHistory) {
    // 默认行为：从最新 checkpoint 开始
    if (options.fromCheckpoint) {
      const cp = checkpoints.find(c => c.id === options.fromCheckpoint);
      if (cp) {
        startIndex = cp.messageIndex;
        startCheckpoint = cp;
      }
    } else if (options.fromLatestCheckpoint !== false) {
      const latestCpId = session.metadata?.checkpoints?.latestCheckpointId;
      if (latestCpId) {
        const latestCp = checkpoints.find(c => c.id === latestCpId);
        if (latestCp) {
          startIndex = latestCp.messageIndex;
          startCheckpoint = latestCp;
        }
      }
    }
  }
  
  // 构建上下文
  const parts: string[] = [];
  
  // 1. 收集 checkpoints 信息（如果需要）
  if (startCheckpoint) {
    const detail = session.metadata?.checkpointDetails?.[startCheckpoint.id];
    if (detail) {
      parts.push(`=== Checkpoint: ${detail.title} ===`);
      parts.push(`Summary: ${detail.summary}`);
      parts.push(`Process: ${detail.processKeyPoints.join(", ")}`);
      parts.push(`Current State: ${detail.currentState}`);
      parts.push("");
    }
  }
  
  // 2. 获取消息
  const messages = await sessionComponent.getMessages(sessionId, {
    offset: startIndex,
    limit: options.messageLimit,
    includeArchived: options.fullHistory, // 完整历史才包含归档消息
  });
  
  // 3. 格式化消息
  for (const msg of messages) {
    if (msg.isArchived && !options.fullHistory) continue;
    parts.push(`[${msg.role}]: ${msg.content}`);
  }
  
  return parts.join("\n");
}
```

---

## 10. 参考文档

| 文档 | 说明 |
|------|------|
| `architecture-design.md` | roy-bot 整体架构设计 |
| `cli-implementation-design.md` | CLI 实现设计规范 |
| `session-component-design.md` | SessionComponent 组件设计（需同步更新） |
| `agent-core-source/docs/sessions-command-design.md` | agent-core sessions 命令参考 |

---

## 11. 附录

### A. 错误处理

| 错误码 | 错误消息 | 说明 |
|--------|----------|------|
| `SESSION_NOT_FOUND` | Session not found | 会话不存在 |
| `SESSION_DELETE_FAILED` | Failed to delete session | 删除失败 |
| `SESSION_CREATE_FAILED` | Failed to create session | 创建失败 |
| `SESSION_UPDATE_FAILED` | Failed to update session | 更新失败 |
| `SESSION_RENAME_FAILED` | Failed to rename session | ⭐ 重命名失败 |
| `INVALID_SESSION_ID` | Invalid session ID format | 无效的会话 ID |
| `ACTIVE_SESSION_REQUIRED` | No active session set | 需要设置活跃会话 |
| `CHECKPOINT_NOT_FOUND` | Checkpoint not found | ⭐ Checkpoint 不存在 |
| `COMPACT_FAILED` | Failed to compact session | ⭐ 压缩失败 |
| `LLM_NOT_AVAILABLE` | LLM service not available | LLM 服务不可用 |

### B. 环境变量

| 变量 | 说明 |
|------|------|
| `ROY_SESSIONS_LIMIT` | 默认列表数量限制 |
| `ROY_SESSIONS_DIR` | 会话数据目录 |
| `ROY_ACTIVE_SESSION` | 当前活跃会话 ID |
| `ROY_COMPACT_THRESHOLD` | ⭐ 自动压缩阈值（消息数或百分比） |
| `ROY_COMPACT_AUTO` | ⭐ 启用自动压缩 |
| `ROY_CONTEXT_FROM_CHECKPOINT` | ⭐ 默认从 checkpoint 开始读取 |

### C. 设计变更日志

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-04-01 | 初始版本 |
| 1.1.0 | 2026-04-01 | 新增 rename、compact、checkpoint 功能 |
