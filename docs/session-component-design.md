# Session Component 设计文档

> 版本: 1.2.0 | 日期: 2026-04-01 | 状态: 🔄 规划中

---

## 1. 概述

### 1.1 设计目标

SessionComponent 是 roy-bot 的会话管理组件，负责：

- **会话生命周期管理**：创建、获取、列表、更新、删除
- **消息管理**：消息存储、检索、分页
- **Active Session 管理**：当前活跃会话的追踪
- **Checkpoint 管理**：会话压缩、状态快照 ⭐ 新增
- **Hook 扩展**：支持 before/after hooks 扩展点

### 1.2 核心设计原则

1. **Component 架构**：继承 `BaseComponent`，遵循统一的 Component 接口
2. **存储抽象**：通过 `SessionStore` 接口支持多种存储实现
3. **Hook 扩展**：支持 `before.session.*`、`after.session.*` 等扩展点
4. **类型安全**：使用 Zod 进行运行时验证
5. **Checkpoint 优先**：上下文读取默认从最新 checkpoint 开始 ⭐
6. **Agent 驱动**：通过 Summary Agent 生成 checkpoint 内容 ⭐

---

## 2. Compact 实现原理 ⭐⭐⭐

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              Compact 实现架构                                       │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │                         SessionComponent                                  │  │
│  │                                                                          │  │
│  │   compact(sessionId)                                                    │  │
│  │       │                                                                 │  │
│  │       ├── 1. 获取从最新 checkpoint 到当前的所有消息                        │  │
│  │       │                                                                 │  │
│  │       ├── 2. 调用 Summary Agent 提取信息                                 │  │
│  │       │                                                                 │  │
│  │       └── 3. 生成 checkpoint 并保存                                      │  │
│  │                                                                          │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                    │                    │                    │                  │
│                    ▼                    ▼                    ▼                  │
│  ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────┐  │
│  │   SessionStore       │  │   SummaryAgent       │  │  PromptComponent  │  │
│  │                      │  │                      │  │                   │  │
│  │  - 存储消息           │  │  - run(messages)    │  │  - compact-prompt │  │
│  │  - 存储 checkpoint    │  │  - 提取关键信息      │  │                   │  │
│  │  - 归档消息           │  │  - 返回 checkpoint   │  │                   │  │
│  └──────────────────────┘  └──────────────────────┘  └──────────────────┘  │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Compact 完整流程

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           Compact 详细流程                                        │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  Step 1: 收集消息                                                              │
│  ─────────────────                                                             │
│                                                                                 │
│  SessionComponent.compact(sessionId)                                            │
│      │                                                                         │
│      ▼                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │  从 SessionStore 获取消息：                                               │  │
│  │                                                                          │  │
│  │  latestCheckpoint = session.metadata.checkpoints.latestCheckpointId     │  │
│  │  startIndex = latestCheckpoint?.messageIndex ?? 0                      │  │
│  │  messages = getMessages(sessionId, offset: startIndex)                  │  │
│  │                                                                          │  │
│  │  示例：                                                                  │  │
│  │  checkpoint#1 @ msg_050                                                 │  │
│  │  ──────────────────────────────────────                                 │  │
│  │  msg_051, msg_052, msg_053, ..., msg_100  ← 需要压缩的消息               │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
│  Step 2: 调用 Summary Agent                                                    │
│  ─────────────────────────────                                                │
│                                                                                 │
│  SummaryAgent.run({                                                            │
│    messages: [msg_051, msg_052, ..., msg_100],                               │
│    task: "compact",                                                          │
│    userContext: "用户要求调查 API 问题"                                          │
│  })                                                                           │
│      │                                                                         │
│      ▼                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │  PromptComponent.render("session/compact")                              │  │
│  │                                                                          │  │
│  │  渲染变量：                                                              │  │
│  │  - messages: msg_051 到 msg_100 的内容                                   │  │
│  │  - userContext: 压缩提示（可选）                                          │  │
│  │  - timestamp: 当前时间                                                   │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│      │                                                                         │
│      ▼                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │  LLM 调用                                                               │  │
│  │                                                                          │  │
│  │  System: 你是一个会话分析助手，负责从对话中提取关键信息...                 │  │
│  │  User:                                                                 │  │
│  │    请分析以下对话，生成 checkpoint：                                      │  │
│  │                                                                          │  │
│  │    [msg_051] user: 帮我调查这个 API 问题                                  │  │
│  │    [msg_052] assistant: 我来分析...                                      │  │
│  │    ...                                                                  │  │
│  │                                                                          │  │
│  │    请按 JSON 格式输出...                                                 │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│      │                                                                         │
│      ▼                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │  LLM 返回：                                                             │  │
│  │                                                                          │  │
│  │  {                                                                       │  │
│  │    "title": "完成 Auth 模块修复",                                        │  │
│  │    "processKeyPoints": [                                               │  │
│  │      "确认问题出在 token 验证中间件",                                     │  │
│  │      "分析了 Auth 模块的请求处理流程",                                    │  │
│  │      "发现 refresh_token 计算公式有误",                                  │  │
│  │      "修复了过期时间戳的计算逻辑"                                         │  │
│  │    ],                                                                   │  │
│  │    "currentState": "Auth 模块修复已完成，需要测试 edge cases",            │  │
│  │    "nextSteps": "需要测试 token 刷新的边界情况"                           │  │
│  │  }                                                                       │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
│  Step 3: 保存 Checkpoint                                                      │
│  ────────────────────────                                                    │
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │  1. 生成 checkpoint ID: cp_{timestamp}_{random}                          │  │
│  │                                                                          │  │
│  │  2. 保存 checkpoint 到 session.metadata:                               │  │
│  │  session.metadata.checkpoints = {                                       │  │
│  │    latestCheckpointId: "cp_xxx",                                       │  │
│  │    checkpoints: [..., {                                                │  │
│  │      id: "cp_xxx",                                                     │  │
│  │      messageIndex: 50,                                                 │  │
│  │      title: "完成 Auth 模块修复",                                        │  │
│  │      createdAt: 1743480600000,                                         │  │
│  │      type: "compact"                                                   │  │
│  │    }]                                                                  │  │
│  │  }                                                                     │  │
│  │                                                                          │  │
│  │  3. 保存 checkpoint 详情到 metadata.checkpointDetails:                  │  │
│  │  session.metadata.checkpointDetails["cp_xxx"] = {                      │  │
│  │    ...fullCheckpointData                                               │  │
│  │  }                                                                     │  │
│  │                                                                          │  │
│  │  4. 归档消息（标记 isArchived）:                                         │  │
│  │  for msg in [msg_051, ..., msg_100]:                                  │  │
│  │    msg.isArchived = true                                              │  │
│  │    msg.checkpointId = "cp_xxx"                                        │  │
│  │    msg.archivedAt = timestamp                                          │  │
│  │                                                                          │  │
│  │  5. 更新 session.messageCount（不含归档）                               │  │
│  │                                                                          │  │
│  │  6. 生成 checkpoint 消息（user role）：                                 │  │
│  │  checkpoint_message = {                                                │  │
│  │    role: "user",                                                      │  │
│  │    content: "# Checkpoint: 完成 Auth 模块修复\n\n..."                  │  │
│  │  }                                                                     │  │
│  │  addMessage(sessionId, checkpoint_message)                              │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 2.3 Checkpoint 消息格式 ⭐

**核心设计**：Checkpoint 是一个 **user role** 的消息，作为对话历史的一部分存在。

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        Checkpoint 消息格式                                       │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  Checkpoint 本质上是一个 user role 消息，内容包含结构化的 checkpoint 信息：        │
│                                                                                 │
│  role: "user"                                                                   │
│  content:                                                                        │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │ # Checkpoint: 完成 Auth 模块修复                                          │  │
│  │                                                                          │  │
│  │ ## Process Key Points                                                    │  │
│  │ 1. 确认问题出在 token 验证中间件                                           │  │
│  │ 2. 分析了 Auth 模块的请求处理流程                                          │  │
│  │ 3. 发现 refresh_token 计算公式有误                                          │  │
│  │ 4. 修复了过期时间戳的计算逻辑                                             │  │
│  │                                                                          │  │
│  │ ## Current State                                                         │  │
│  │ Auth 模块修复已完成，token 验证逻辑正确。需要测试 edge cases。              │  │
│  │                                                                          │  │
│  │ ## Next Steps                                                            │  │
│  │ - 测试 token 刷新的边界情况                                               │  │
│  │ - 验证 refresh_token 流程                                                │  │
│  │                                                                          │  │
│  │ ## Messages Compacted                                                   │  │
│  │ 50 messages (msg_051 ~ msg_100) compacted at 2026-04-01 10:30          │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
│  metadata:                                                                      │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │ {                                                                     │  │
│  │   checkpointId: "cp_xxx",                                            │  │
│  │   checkpointMeta: {                                                   │  │
│  │     id: "cp_xxx",                                                     │  │
│  │     messageIndex: 50,                                                 │  │
│  │     type: "compact",                                                  │  │
│  │     title: "完成 Auth 模块修复",                                        │  │
│  │     processKeyPoints: [...],                                          │  │
│  │     currentState: "...",                                              │  │
│  │     nextSteps: [...],                                                 │  │
│  │     createdAt: 1743480600000                                          │  │
│  │   }                                                                   │  │
│  │ }                                                                     │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
│  这样做的好处：                                                                 │
│  ✓ Checkpoint 自动成为对话历史的一部分                                          │
│  ✓ 读取时不需要特殊处理，消息列表即包含所有信息                                  │
│  ✓ 导出/导入时天然包含 checkpoint                                             │
│  ✓ 后续对话可以直接引用 checkpoint 内容                                         │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. PromptComponent 集成 ⭐

### 3.1 Compact Prompt 定义

```typescript
// packages/core/src/env/session/prompts/compact.md

---
name: session/compact
description: Session checkpoint generation prompt
version: 1.0.0
---

# System Prompt

你是一个专业的会话分析助手。你的任务是从一段对话中提取关键信息，生成一个结构化的 checkpoint。

checkpoint 应该包含：
1. **Process Key Points**: 过程要点，列出本次对话中的关键步骤、发现或决策
2. **Current State**: 当前状态，描述对话结束时的进展和现状
3. **Next Steps**: 后续待跟进，明确下一步需要做的事情

请用简洁、准确的语言描述，避免冗余。每个部分的字数要适中，不要过长。

---

# User Prompt Template

请分析以下对话，生成 checkpoint：

## 对话上下文

```json
{{userContext}}
```

## 对话内容

{{messages}}

---

## 输出要求

请按以下 JSON 格式输出：

```json
{
  "title": "简短的 checkpoint 标题（不超过 30 字）",
  "processKeyPoints": [
    "要点1：描述关键的发现或决策",
    "要点2：描述重要的步骤或结论",
    "要点3：..."
  ],
  "currentState": "当前状态描述，说明目前的进展和现状（50-100 字）",
  "nextSteps": [
    "下一步待办1",
    "下一步待办2"
  ]
}
```

请确保输出的 JSON 格式正确，可以被解析。
```

### 3.2 Prompt 渲染

```typescript
// CompactService 中渲染 prompt

import { PromptComponent } from "../prompt/prompt-component";

class CompactService {
  constructor(
    private promptComponent: PromptComponent,
    private llmComponent: LLMComponent,
    // ...
  ) {}

  async generateCheckpoint(
    session: Session,
    messages: SessionMessage[],
    options?: GenerateCheckpointOptions
  ): Promise<SessionCheckpoint> {
    // 1. 格式化消息
    const formattedMessages = messages
      .map((m, i) => `[${i}] ${m.role}: ${m.content}`)
      .join("\n\n");

    // 2. 渲染 prompt
    const rendered = await this.promptComponent.render("session/compact", {
      userContext: options?.summary || "无额外上下文",
      messages: formattedMessages,
      timestamp: new Date().toISOString(),
    });

    // 3. 调用 LLM
    const response = await this.llmComponent.invoke({
      messages: [
        { role: "system", content: rendered.system },
        { role: "user", content: rendered.user },
      ],
      // ...
    });

    // 4. 解析响应
    const checkpointData = JSON.parse(response.content);
    
    return {
      id: generateId(),
      messageIndex: messages[0].index,
      title: checkpointData.title,
      processKeyPoints: checkpointData.processKeyPoints,
      currentState: checkpointData.currentState,
      nextSteps: checkpointData.nextSteps,
      createdAt: Date.now(),
      type: "compact",
    };
  }
}
```

---

## 4. Summary Agent 设计 ⭐⭐

### 4.1 Agent 定义

```typescript
// packages/core/src/env/agent/types.ts 新增

/**
 * Summary Agent 配置
 * 
 * 专门用于生成 session checkpoint 的 Agent
 */
export interface SummaryAgentConfig extends AgentInstanceConfig {
  /** Agent 类型 */
  type: "summary";
  
  /** 使用的 prompt */
  promptName: "session/compact";
  
  /** 默认模型 */
  model?: string;
  
  /** 最大迭代次数（summary 任务只需 1 次） */
  maxIterations: 1;
}

/**
 * Summary Agent 运行选项
 */
export interface SummaryAgentRunOptions {
  /** 消息列表 */
  messages: SessionMessage[];
  
  /** 用户提供的上下文/提示 */
  userContext?: string;
  
  /** 期望的输出格式 */
  outputFormat: "json";
}

/**
 * Summary Agent 运行结果
 */
export interface SummaryAgentResult {
  /** Checkpoint 标题 */
  title: string;
  
  /** 过程要点 */
  processKeyPoints: string[];
  
  /** 当前状态 */
  currentState: string;
  
  /** 后续待跟进 */
  nextSteps: string[];
  
  /** 原始 LLM 响应 */
  rawResponse?: string;
}
```

### 4.2 Summary Agent 实现

```typescript
// packages/core/src/env/agent/summary-agent.ts

import { AgentComponent } from "./agent-component";
import { PromptComponent } from "../prompt/prompt-component";
import type { 
  SummaryAgentConfig, 
  SummaryAgentRunOptions, 
  SummaryAgentResult 
} from "./types";

/**
 * Summary Agent
 * 
 * 专门用于生成 session checkpoint 的 Agent
 * 通过 PromptComponent 加载 compact prompt
 * 调用 LLM 提取关键信息
 */
export class SummaryAgent {
  private agentComponent: AgentComponent;
  private promptComponent: PromptComponent;
  private config: SummaryAgentConfig;

  constructor(
    agentComponent: AgentComponent,
    promptComponent: PromptComponent,
    config?: Partial<SummaryAgentConfig>
  ) {
    this.agentComponent = agentComponent;
    this.promptComponent = promptComponent;
    
    this.config = {
      type: "summary",
      promptName: "session/compact",
      maxIterations: 1,
      model: "auto",
      ...config,
    };
  }

  /**
   * 运行 Summary Agent
   * 
   * @param options 运行选项
   * @returns Summary Agent 结果
   */
  async run(options: SummaryAgentRunOptions): Promise<SummaryAgentResult> {
    const { messages, userContext, outputFormat } = options;

    // 1. 格式化消息
    const formattedMessages = this.formatMessages(messages);

    // 2. 渲染 prompt
    const prompt = await this.promptComponent.render(this.config.promptName, {
      userContext: userContext || "无额外上下文",
      messages: formattedMessages,
      timestamp: new Date().toISOString(),
    });

    // 3. 调用 LLM（直接调用，不走 ReAct 循环）
    const response = await this.agentComponent.llmComponent.invoke({
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      model: this.config.model,
    });

    // 4. 解析响应
    if (outputFormat === "json") {
      const result = this.parseJsonResponse(response.content);
      return {
        title: result.title,
        processKeyPoints: result.processKeyPoints,
        currentState: result.currentState,
        nextSteps: result.nextSteps || [],
        rawResponse: response.content,
      };
    }

    throw new Error(`Unsupported output format: ${outputFormat}`);
  }

  /**
   * 格式化消息用于 prompt
   */
  private formatMessages(messages: SessionMessage[]): string {
    return messages
      .map((m, i) => `[${i}] ${m.role}: ${m.content}`)
      .join("\n\n");
  }

  /**
   * 解析 JSON 响应
   */
  private parseJsonResponse(content: string): any {
    // 尝试提取 JSON 代码块
    const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) 
                   || content.match(/```\s*([\s\S]*?)\s*```/)
                   || [null, content];
    
    try {
      return JSON.parse(jsonMatch[1] || content);
    } catch {
      // 如果解析失败，尝试修复常见问题
      const fixed = content
        .replace(/,\s*}/g, "}")
        .replace(/,\s*]/g, "]");
      return JSON.parse(fixed);
    }
  }
}
```

### 4.3 SessionComponent 集成 Summary Agent

```typescript
// packages/core/src/env/session/session-component.ts

export class SessionComponent extends BaseComponent {
  // ...
  
  private summaryAgent?: SummaryAgent;
  private promptComponent?: PromptComponent;

  /**
   * Compact 会话
   * 
   * 1. 获取从最新 checkpoint 到当前的消息
   * 2. 调用 Summary Agent 生成 checkpoint
   * 3. 保存 checkpoint 并归档消息
   */
  async compact(
    sessionId: string,
    options?: CompactOptions
  ): Promise<CompactResult> {
    const session = await this.get(sessionId);
    if (!session) throw new Error("Session not found");

    // 1. 确定起始位置
    const latestCheckpoint = this.getLatestCheckpoint(session);
    const startIndex = latestCheckpoint?.messageIndex ?? 0;

    // 2. 获取需要压缩的消息
    const messages = await this.store.getMessages(sessionId, startIndex);
    if (messages.length < 3) {
      throw new Error("Not enough messages to compact");
    }

    // 3. 初始化 Summary Agent（如果需要）
    if (!this.summaryAgent) {
      this.summaryAgent = new SummaryAgent(
        this.agentComponent!,
        this.promptComponent!
      );
    }

    // 4. 调用 Summary Agent
    const summaryResult = await this.summaryAgent.run({
      messages,
      userContext: options?.summary,
      outputFormat: "json",
    });

    // 5. 生成 checkpoint ID
    const checkpointId = `cp_${Date.now()}_${randomId(6)}`;

    // 6. 创建 checkpoint 对象
    const checkpoint: SessionCheckpoint = {
      id: checkpointId,
      messageIndex: startIndex,
      title: summaryResult.title,
      summary: [
        `Process: ${summaryResult.processKeyPoints.join("; ")}`,
        `State: ${summaryResult.currentState}`,
      ].join("\n"),
      processKeyPoints: summaryResult.processKeyPoints,
      currentState: summaryResult.currentState,
      nextSteps: summaryResult.nextSteps,
      messageCountBefore: messages.length,
      createdAt: Date.now(),
      type: "compact",
    };

    // 7. 保存 checkpoint 到 session.metadata
    await this.saveCheckpoint(sessionId, checkpoint);

    // 8. 归档消息
    await this.store.archiveMessages(sessionId, checkpointId, messages.length);

    // 9. 生成 checkpoint 消息（user role）并添加
    const checkpointMessage = this.createCheckpointMessage(checkpoint);
    await this.store.addMessage(sessionId, checkpointMessage);

    // 10. 更新 session
    session.messageCount = await this.store.getMessageCount(sessionId, false);
    session.updatedAt = Date.now();
    await this.store.update(sessionId, session);

    return {
      checkpoint,
      deletedMessageCount: messages.length,
      remainingMessageCount: session.messageCount,
      checkpointCount: this.getCheckpointCount(session),
    };
  }

  /**
   * 创建 checkpoint 消息（user role）
   */
  private createCheckpointMessage(checkpoint: SessionCheckpoint): AddMessageOptions {
    const content = [
      `# Checkpoint: ${checkpoint.title}`,
      "",
      "## Process Key Points",
      ...checkpoint.processKeyPoints.map((p, i) => `${i + 1}. ${p}`),
      "",
      "## Current State",
      checkpoint.currentState,
      "",
      ...(checkpoint.nextSteps?.length ? [
        "## Next Steps",
        ...checkpoint.nextSteps.map((s, i) => `${i + 1}. ${s}`),
        "",
      ] : []),
      `## Messages Compacted`,
      `${checkpoint.messageCountBefore} messages compacted at ${new Date(checkpoint.createdAt).toISOString()}`,
    ].join("\n");

    return {
      role: "user",
      content,
      parts: [{ type: "checkpoint" as const, content: "" }],
      metadata: {
        checkpointId: checkpoint.id,
        checkpointMeta: checkpoint,
        isCheckpoint: true,
      },
    };
  }
}
```

---

## 5. 目录结构

```
packages/core/src/
└── env/
    ├── session/                  # Session Component
    │   ├── index.ts            
    │   ├── session-component.ts  # SessionComponent 实现
    │   ├── session-store.ts     # 会话仓储接口
    │   ├── types.ts             # 类型定义
    │   ├── hooks.ts             # Hooks 类型定义
    │   ├── compact.ts           # ⭐ Compact 服务接口
    │   ├── summary-agent.ts     # ⭐ Summary Agent
    │   └── storage/             # 存储层
    │       ├── index.ts
    │       └── memory.ts
    │
    ├── prompt/                   # Prompt Component
    │   ├── index.ts
    │   ├── prompt-component.ts
    │   ├── types.ts
    │   ├── renderer.ts
    │   └── prompts/             # 内置 Prompts
    │       └── session/
    │           └── compact.md   # ⭐ Compact Prompt
    │
    └── agent/                    # Agent Component
        ├── index.ts
        ├── agent-component.ts
        ├── types.ts             # ⭐ 包含 SummaryAgent 类型
        └── summary-agent.ts     # ⭐ Summary Agent 实现
```

---

## 6. 类型定义（完整）

### 6.1 Checkpoint 相关类型

```typescript
// env/session/types.ts

/**
 * Checkpoint 元信息（存储在 Session.metadata 中）
 */
export interface CheckpointMeta {
  id: string;
  messageIndex: number;          // 起始消息的索引位置
  title: string;                 // 简短的标题
  createdAt: number;             // 创建时间
  type: "compact" | "manual";
}

/**
 * 完整 Checkpoint 信息（包含生成的内容）
 */
export interface SessionCheckpoint extends CheckpointMeta {
  summary: string;              // 整体摘要（多行）
  processKeyPoints: string[];   // 过程要点
  currentState: string;         // 当前状态
  nextSteps: string[];          // ⭐ 后续待跟进
  messageCountBefore: number;   // checkpoint 前的消息数量
  metadata?: Record<string, unknown>;
}

/**
 * Session 元数据
 */
export interface SessionMetadata {
  [key: string]: unknown;
  
  checkpoints?: {
    latestCheckpointId?: string;
    checkpoints: CheckpointMeta[];
  };
  
  checkpointDetails?: Record<string, SessionCheckpoint>;
}

/**
 * Compact 选项
 */
export interface CompactOptions {
  /** 手动提供的摘要提示 */
  summary?: string;
  
  /** 过程要点提示 */
  processKeyPoints?: string[];
  
  /** 当前状态提示 */
  currentState?: string;
  
  /** 后续待跟进提示 */
  nextSteps?: string[];
  
  /** 是否自动触发 */
  auto?: boolean;
}

/**
 * Compact 结果
 */
export interface CompactResult {
  checkpoint: SessionCheckpoint;
  deletedMessageCount: number;
  remainingMessageCount: number;
  checkpointCount: number;
}
```

### 6.2 SessionMessage 更新

```typescript
// env/session/types.ts

export interface SessionMessage {
  id: string;
  sessionID: string;
  role: Role;
  content: string;
  timestamp: number;
  parts?: MessagePart[];
  
  // ⭐ Checkpoint 相关
  isArchived?: boolean;
  archivedAt?: number;
  checkpointId?: string;
  
  // ⭐ Checkpoint 消息元数据
  metadata?: {
    isCheckpoint?: boolean;
    checkpointId?: string;
    checkpointMeta?: SessionCheckpoint;
  };
}
```

---

## 7. Context 读取（Checkpoint 消息驱动）

### 7.1 读取策略

```typescript
// env/session/session-component.ts

/**
 * 获取会话上下文
 * 
 * 读取逻辑：
 * 1. 扫描消息列表，找出所有 checkpoint 消息
 * 2. 从最新的 checkpoint 消息开始读取
 * 3. checkpoint 消息本身作为上下文的一部分（user role）
 */
async getContext(
  sessionId: string,
  options?: GetContextOptions
): Promise<ContextResult> {
  const session = await this.get(sessionId);
  if (!session) throw new Error("Session not found");

  // 1. 获取消息（包含 checkpoint 消息）
  const allMessages = await this.store.getMessages(sessionId, 0, undefined, {
    includeArchived: options?.fullHistory,
  });

  // 2. 如果不读取完整历史，筛选出 checkpoint 之后的消息
  let contextMessages: SessionMessage[] = allMessages;
  
  if (!options?.fullHistory) {
    // 找到最新 checkpoint
    let latestCheckpointIndex = -1;
    
    for (let i = allMessages.length - 1; i >= 0; i--) {
      if (allMessages[i].metadata?.isCheckpoint) {
        latestCheckpointIndex = i;
        break;
      }
    }
    
    if (latestCheckpointIndex >= 0) {
      // 从 checkpoint 开始
      contextMessages = allMessages.slice(latestCheckpointIndex);
    }
  }

  // 3. 应用消息限制
  if (options?.messageLimit) {
    contextMessages = contextMessages.slice(-options.messageLimit);
  }

  // 4. 提取 checkpoint 信息
  const checkpoints = contextMessages
    .filter((m) => m.metadata?.isCheckpoint)
    .map((m) => m.metadata!.checkpointMeta!);

  return {
    session,
    checkpoints,
    startCheckpoint: checkpoints[checkpoints.length - 1],
    messages: contextMessages,
    totalMessageCount: allMessages.length,
    activeMessageCount: allMessages.filter((m) => !m.isArchived).length,
    archivedMessageCount: allMessages.filter((m) => m.isArchived).length,
    estimatedTokens: this.estimateTokens(contextMessages),
  };
}
```

### 7.2 Context 消息流

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          Context 读取消息流                                        │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  原始消息存储：                                                                   │
│  ┌─────┬─────┬─────┬─────┬─────┬─────┬─────┬─────┬─────┬─────┐              │
│  │cp#1 │ 052 │ 053 │ ... │ 100 │cp#2 │ 101 │ 102 │ 103 │ 104 │              │
│  │ msg │     │     │     │     │ msg │     │     │     │     │              │
│  └─────┴─────┴─────┴─────┴─────┴─────┴─────┴─────┴─────┴─────┘              │
│    archived      archived       archived    ↑ active messages                 │
│                                                                                 │
│  读取上下文（默认，从最新 checkpoint）：                                           │
│  ┌─────┬─────┬─────┬─────┬─────┐                                               │
│  │cp#2 │ 101 │ 102 │ 103 │ 104 │  ← 带 checkpoint 消息的上下文                  │
│  │ msg │     │     │     │     │                                               │
│  └─────┴─────┴─────┴─────┴─────┘                                               │
│                                                                                 │
│  checkpoint 消息内容（user role）：                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │ # Checkpoint: 完成 Auth 模块修复                                          │  │
│  │                                                                          │  │
│  │ ## Process Key Points                                                    │  │
│  │ 1. 确认问题出在 token 验证中间件                                           │  │
│  │ 2. 分析了 Auth 模块的请求处理流程                                          │  │
│  │                                                                          │  │
│  │ ## Current State                                                         │  │
│  │ Auth 模块修复已完成，需要测试 edge cases。                                 │  │
│  │                                                                          │  │
│  │ ## Next Steps                                                            │  │
│  │ - 测试 token 刷新的边界情况                                               │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 8. 实现计划

### Phase 1: Prompt 定义
- [ ] 创建 `prompts/session/compact.md` prompt 文件
- [ ] 注册 prompt 到 PromptComponent
- [ ] 实现 prompt 渲染测试

### Phase 2: Summary Agent
- [ ] 定义 SummaryAgent 类型（types.ts）
- [ ] 实现 SummaryAgent 类（summary-agent.ts）
- [ ] 实现 `run()` 方法
- [ ] 实现 JSON 响应解析
- [ ] 单元测试

### Phase 3: Compact 集成
- [ ] SessionComponent 引入 SummaryAgent
- [ ] 实现 `compact()` 方法
- [ ] 实现 checkpoint 消息创建
- [ ] 实现消息归档
- [ ] 集成测试

### Phase 4: Context 读取
- [ ] 实现 `getContext()` 方法
- [ ] 实现 checkpoint 消息解析
- [ ] 测试上下文恢复

### Phase 5: CLI 命令
- [ ] 实现 `sessions compact` 命令
- [ ] 实现 `sessions checkpoints` 命令
- [ ] 实现 `sessions messages --from-checkpoint` 命令

---

## 9. 参考文档

| 文档 | 说明 |
|------|------|
| `architecture-design.md` | roy-bot 整体架构设计 |
| `cli-implementation-design.md` | CLI 实现设计规范 |
| `prompt-component-design.md` | PromptComponent 组件设计 |
| `agent-component-design.md` | AgentComponent 组件设计 |
| `session-command-design.md` | CLI Session 命令设计 |
