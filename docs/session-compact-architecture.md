# Session Compact 架构分析

> 分析日期: 2025-07-17
> 源码路径: packages/core/src/env/session/session-component.ts

---

## 一、核心概念

### 1.1 什么是 Session Compact？

Session Compact（会话压缩）是将历史消息摘要为 Checkpoint，释放上下文空间的技术手段。

### 1.2 触发场景

| 触发方式 | 场景 | 执行组件 |
|---------|------|---------|
| **自动触发** | LLM 调用后检测到上下文阈值超限 | `ContextHandlerService` |
| **手动触发** | CLI 命令 `roy sessions compact <id>` | `CompactCommand` |

---

## 二、完整流程图

### 2.1 自动触发流程（LLM 阈值超限）

```
用户发送消息
    │
    ▼
┌─────────────────────────────────────────┐
│ QueryExecutor.execute()                  │
│   - 创建 ContextHandlerService           │
│   - 调用 handleQueryWithContext()        │
└────────────────────┬────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────┐
│ ContextHandlerService                    │
│  .handleQueryWithContext()               │
│   - 调用 env.handle_query()               │
│   - 捕获 ContextError (CTX_001)         │
└────────────────────┬────────────────────┘
                     │
         ┌───────────┴───────────┐
         │                       │
      成功返回                 抛出 ContextError
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │  threshold >= 配置阈值   │
                    │  (默认 90% 上下文窗口)   │
                    └───────────┬─────────────┘
                                │
                                ▼
                    ┌─────────────────────────┐
                    │ 发布事件:                │
                    │ context.threshold_exceeded│
                    │ (CLI 显示警告信息)       │
                    └───────────┬─────────────┘
                                │
                                ▼
                    ┌─────────────────────────┐
                    │ compactSession()        │
                    │  1. 发布: compacting     │
                    │  2. 调用 SessionComponent│
                    │     .compact()          │
                    │  3. 发布: compacted      │
                    │  4. 构造新 query        │
                    │  5. 重试 handle_query   │
                    └─────────────────────────┘
```

### 2.2 CLI 手动触发流程

```
roy sessions compact <session-id>
    │
    ▼
┌─────────────────────────────────────────┐
│ CompactCommand.handler()                │
│   - EnvironmentService.create()         │
│   - 获取 sessionComponent               │
│   - 获取 llmComponent, promptComponent  │
└────────────────────┬────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────┐
│ SessionComponent                         │
│  .setSummaryComponents()                 │
│   - 注入 llmComponent, promptComponent   │
└────────────────────┬────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────┐
│ SessionComponent.compact()              │
│   ✅ 与自动触发复用同一方法!             │
└─────────────────────────────────────────┘
```

---

## 三、SessionComponent.compact() 详解

### 3.1 方法签名

```typescript
compact(sessionId: string, options?: CompactOptions): Promise<CompactResult>
```

### 3.2 入参

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | `string` | ✅ | 要压缩的会话 ID |
| `options.summary` | `string` | ❌ | 用户提供的摘要提示 |
| `options.processKeyPoints` | `string[]` | ❌ | 用户提供的过程要点 |
| `options.currentState` | `string` | ❌ | 用户提供的当前状态 |
| `options.nextSteps` | `string[]` | ❌ | 用户提供的后续步骤 |
| `options.auto` | `boolean` | ❌ | 是否自动触发 |

### 3.3 返回值

```typescript
interface CompactResult {
  checkpoint: SessionCheckpoint;    // 生成的检查点
  deletedMessageCount: number;     // 被归档的消息数
  remainingMessageCount: number;    // 剩余消息数
  checkpointCount: number;          // 总检查点数
}
```

### 3.4 执行流程（12 步）

```
SessionComponent.compact(sessionId, options)
        │
        ▼
┌─────────────────────────────────────────────┐
│ 1. 校验 session                              │
│    session = this.get(sessionId)            │
│    不存在 → throw Error                     │
└─────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────┐
│ 2. 确定压缩起始位置                          │
│    latestCheckpoint = getLatestCheckpoint()  │
│    startIndex = latestCheckpoint?.          │
│        messageIndex ?? 0                    │
└─────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────┐
│ 3. 获取待压缩消息                            │
│    messages = store.getMessages(            │
│      sessionId,                             │
│      startIndex,                            │
│      MAX_SAFE_INTEGER,  // 获取全部          │
│      { includeArchived: false }             │
│    )                                        │
│                                             │
│    条件检查: messages.length >= 3           │
│    不满足 → throw Error                     │
└─────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────┐
│ 4. 初始化 SummaryAgent                       │
│    if (!this.summaryAgent) {                │
│      this.summaryAgent = new SummaryAgent(  │
│        this.promptComponent,                │
│        this.llmComponent                    │
│      )                                      │
│    }                                        │
└─────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────┐
│ 5. 执行 before hooks                        │
│    executeBeforeHooks("compact", {...})     │
└─────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────┐
│ 6. 调用 SummaryAgent 生成 checkpoint        │
│    summaryResult = summaryAgent.run({       │
│      messages: messages.map(m => ({         │
│        role: m.role,                        │
│        content: m.content                  │
│      })),                                   │
│      userContext: options?.summary,         │
│      outputFormat: "json"                   │
│    })                                       │
└─────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────┐
│ 7. 生成 checkpoint 对象                      │
│    checkpoint = {                          │
│      id: `cp_${timestamp}_${random}`,       │
│      messageIndex: startIndex,             │
│      title: summaryResult.title,           │
│      summary: [...],                       │
│      processKeyPoints: ...,                │
│      currentState: ...,                    │
│      nextSteps: ...,                       │
│      userIntents: ...,                     │
│      messageCountBefore: messages.length,  │
│      createdAt: Date.now(),                │
│      type: "compact"                       │
│    }                                       │
└─────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────┐
│ 8. 保存 checkpoint                           │
│    store.saveCheckpoint(sessionId,          │
│      checkpoint)                            │
└─────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────┐
│ 9. 归档消息                                 │
│    store.archiveMessages(                   │
│      sessionId,                             │
│      checkpointId,                          │
│      messages.length                        │
│    )                                        │
└─────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────┐
│ 10. 添加 checkpoint 消息                     │
│     checkpointMessage =                     │
│       createCheckpointMessage(checkpoint)    │
│     store.addMessage(sessionId,              │
│       checkpointMessage)                    │
└─────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────┐
│ 11. 执行 after hooks                        │
│     executeAfterHooks("compact", {...})     │
└─────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────┐
│ 12. 返回结果                                 │
│     return {                                │
│       checkpoint,                           │
│       deletedMessageCount: messages.length, │
│       remainingMessageCount,                │
│       checkpointCount                      │
│     }                                       │
└─────────────────────────────────────────────┘
```

---

## 四、LLM 阈值检测机制

### 4.1 阈值计算

```typescript
// packages/core/src/env/llm/llm.ts

getContextThresholdConfig(providerId, modelId) {
  const defaults = {
    contextWindow: 128000,  // 默认 128K 上下文窗口
    thresholdRatio: 0.9,   // 默认 90% 时触发
  };
  
  const limits = this.getModelLimits(providerId, modelId);
  if (!limits) return defaults;
  
  return {
    contextWindow: limits.contextWindow || defaults.contextWindow,
    thresholdRatio: limits.compactionThreshold ?? defaults.thresholdRatio,
  };
}

checkContextThreshold(usage, providerId, modelId, sessionId) {
  const config = this.getContextThresholdConfig(providerId, modelId);
  const threshold = config.contextWindow * config.thresholdRatio;
  
  if (usage.totalTokens >= threshold) {
    return new ContextError(
      `Context threshold exceeded: ${usage.totalTokens}/${config.contextWindow}`,
      ErrorCodes.CONTEXT_THRESHOLD_EXCEEDED,
      sessionId,
      { promptTokens, completionTokens, totalTokens },
      config.contextWindow
    );
  }
}
```

### 4.2 阈值检测时机

```
LLMComponent.invoke()
        │
        ▼
┌─────────────────────────────────────────┐
│ 调用 LLM API 获取响应                     │
│ 解析 usage 信息                          │
└────────────────────┬────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│ if (!request.skipThresholdCheck) {       │  ← 关键判断
│   checkContextThreshold(usage, ...)     │
│ }                                        │
└────────────────────┬────────────────────┘
                   │
         ┌─────────┴─────────┐
         │                   │
      未超阈值             超阈值
         │                   │
         ▼                   ▼
      返回结果         抛出 ContextError
                              │
                              ▼
                    ContextHandlerService
                    捕获并触发 compact
```

### 4.3 skipThresholdCheck 参数

SummaryAgent 调用 LLM 时传入 `skipThresholdCheck: true`，防止循环触发：

```typescript
// packages/core/src/env/agent/summary-agent.ts

async run(options: SummaryAgentRunOptions): Promise<SummaryAgentResult> {
  const response = await this.llmComponent.invoke({
    messages: [...],
    model: this.config.model,
    skipThresholdCheck: true,  // ⚠️ 防止循环触发
  });
}
```

---

## 五、CLI Compact 命令

### 5.1 命令格式

```bash
roy sessions compact <session-id> [options]

Options:
  --summary, -s          摘要提示
  --dry-run, -d         预览压缩效果
  --json, -j            JSON 输出
  --process-key-points  过程要点（逗号分隔）
  --current-state       当前状态
  --next-steps         后续待跟进（逗号分隔）
```

### 5.2 执行流程对比

| 步骤 | 自动触发 | CLI 手动触发 |
|------|---------|-------------|
| 1 | `ContextHandlerService.handleQueryWithContext()` | `CompactCommand.handler()` |
| 2 | 捕获 `ContextError` | 获取 `SessionComponent` |
| 3 | 发布 `context.threshold_exceeded` | 获取 `LLMComponent`, `PromptComponent` |
| 4 | 调用 `compactSession()` | 调用 `setSummaryComponents()` |
| 5 | **调用 `SessionComponent.compact()`** ✅ | **调用 `SessionComponent.compact()`** ✅ |
| 6 | 构造新 query 并重试 | 输出 checkpoint 结果 |

---

## 六、关键设计决策

### 6.1 复用同一 Agent

✅ **确认：CLI `compact` 命令与自动触发 compact 复用相同的 `SummaryAgent`**

两者的核心执行逻辑都在 `SessionComponent.compact()` 中，统一调用 `SummaryAgent.run()`。

### 6.2 防止循环触发

SummaryAgent 调用 LLM 时传入 `skipThresholdCheck: true`，避免 compact 过程中再次触发阈值。

### 6.3 事件发布

Compact 过程中发布事件，供 UI 监听：

| 事件 | 时机 | Payload |
|------|------|---------|
| `context.threshold_exceeded` | 阈值超限 | `{ sessionId, totalTokens, contextWindow, attempt }` |
| `context.compacting` | 压缩开始 | `{ sessionId }` |
| `context.compacted` | 压缩完成 | `{ checkpointId, messagesCompacted }` |

---

## 七、配置项

| 配置项 | 默认值 | 说明 |
|-------|-------|------|
| `session.compactionThreshold` | 80 | 自动压缩阈值（百分比） |
| `llm.providers.<id>.limits.<model>.compactionThreshold` | 0.8 | 模型级别阈值（0-1） |

**配置示例** (`~/.config/roy-bot/roy-config.yaml`):

```yaml
session:
  compactionThreshold: 80  # 80% 时触发自动压缩

llm:
  providers:
    minimax:
      limits:
        "MiniMax-M2.5":
          compactionThreshold: 0.8  # 80%
```

---

## 八、关键文件索引

| 文件 | 说明 |
|------|------|
| `packages/core/src/env/session/session-component.ts` | SessionComponent.compact() 实现 |
| `packages/core/src/env/agent/summary-agent.ts` | SummaryAgent（checkpoint 生成） |
| `packages/core/src/env/llm/llm.ts` | 阈值检测逻辑 |
| `packages/core/src/env/errors.ts` | ContextError 定义 |
| `packages/cli/src/services/context-handler.service.ts` | 自动触发 compact |
| `packages/cli/src/commands/sessions/compact.ts` | CLI compact 命令 |
| `packages/cli/src/commands/shared/query-executor.ts` | 查询执行器 |
