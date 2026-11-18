# Session 消息格式改造设计文档

> 版本: 1.0.0 | 日期: 2026-04-01 | 状态: 📝 设计中

---

## 1. 概述

### 1.1 设计目标

重构 roy-bot 的 Session 消息存储格式，使其能够：
- 完整保存 AI SDK v6 的多模态消息内容（text, tool-call, tool-result, reasoning, file）
- 支持从 Session 中提取消息并转换为 AI SDK `ModelMessage` 格式
- 兼容下一轮 LLM 调用的 history 组织
- 与 agent-core-source 的 session 设计保持一致

### 1.2 当前问题

| 问题 | 说明 |
|------|------|
| 消息内容扁平化 | 当前 `SessionMessage.content` 为纯字符串，丢失结构信息 |
| Tool Call 信息丢失 | 工具调用参数、toolCallId 等信息无法保存 |
| 无 Reasoning 支持 | AI 思考过程（thinking）无法保存 |
| 缺少 AI SDK 转换 | 无法将 Session 消息转换为 `ModelMessage[]` 供 LLM 使用 |

---

## 2. 现状对比

### 2.1 Agent-Core (session-core) 的实现

**存储格式**：`MessageWithParts`
```typescript
interface MessageWithParts {
  info: MessageInfo;  // { id, sessionID, role, timestamp, ... }
  parts: Part[];     // [TextPart, ToolPart, ReasoningPart, ...]
}
```

**Part 类型**：
```typescript
interface TextPart {
  type: "text";
  text: string;
  ignored?: boolean;
  synthetic?: boolean;
}

interface ToolPart {
  type: "tool";
  callID: string;
  tool: string;
  state: "pending" | "running" | "completed" | "error";
  input: Record<string, unknown>;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  time?: { start: number; end?: number };
}

interface ReasoningPart {
  type: "reasoning";
  text: string;
  metadata?: Record<string, unknown>;
  time: { start: number; end?: number };
}

interface FilePart {
  type: "file";
  mime: string;
  url: string;
  filename?: string;
}
```

**AI SDK 转换**：通过 `sessionToHistory()` 转换回 `ModelMessage[]`

### 2.2 Roy-Agent 当前实现

**存储格式**：`SessionMessage`
```typescript
interface SessionMessage {
  id: string;
  sessionID: string;
  role: Role;
  content: string;        // 纯文本
  timestamp: number;
  parts?: MessagePart[];   // 可选，但结构简陋
}

interface MessagePart {
  type: "text" | "reasoning" | "tool" | "file" | "checkpoint";
  content: string;
  toolName?: string;
  toolCallId?: string;
}
```

**问题**：
- `content` 是纯文本，无法区分不同类型的内容
- `parts` 结构简陋，缺少状态、元数据等信息
- 无 `toModelMessage()` 转换函数
- Tool Call 和 Reasoning 信息丢失

---

## 3. 目标格式设计

### 3.1 新的 Part 类型

```typescript
// 消息部分类型联合
type SessionPart = 
  | TextPart 
  | ToolCallPart 
  | ToolResultPart 
  | ReasoningPart
  | FilePart 
  | CheckpointPart;

// ============================================
// Text Part - 纯文本内容
// ============================================
interface TextPart {
  type: "text";
  content: string;
  /** 是否为自动生成的摘要文本 */
  synthetic?: boolean;
  /** 是否忽略（如已被 reasoning 替代） */
  ignored?: boolean;
}

// ============================================
// Tool Call Part - 工具调用
// ============================================
interface ToolCallPart {
  type: "tool-call";
  /** AI SDK 标准字段名 */
  toolCallId: string;
  toolName: string;
  arguments: string | Record<string, unknown>;
  state: "pending" | "running";
}

// ============================================
// Tool Result Part - 工具执行结果
// ============================================
interface ToolResultPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: string;
  error?: string;
  state: "completed" | "error";
}

// ============================================
// Reasoning Part - AI 思考过程
// ============================================
interface ReasoningPart {
  type: "reasoning";
  /** Reasoning 内容 */
  content: string;
  /** Reasoning 类型 */
  reasoningType?: "core" | "effort" | "summary";
  /** 状态 */
  state?: "thinking" | "completed";
  /** 是否折叠显示（类似 AI SDK 默认折叠） */
  isCollapsed?: boolean;
  /** 元数据 */
  metadata?: {
    tokenCount?: number;
    time?: { start: number; end?: number };
  };
}

// ============================================
// File Part - 文件附件
// ============================================
interface FilePart {
  type: "file";
  mime: string;
  url: string;
  filename?: string;
}

// ============================================
// Checkpoint Part - 压缩检查点
// ============================================
interface CheckpointPart {
  type: "checkpoint";
  checkpointId: string;
  summary: string;
  processKeyPoints?: string[];
  currentState?: string;
  nextSteps?: string[];
}
```

### 3.2 SessionMessage 改造

```typescript
interface SessionMessage {
  id: string;
  sessionID: string;
  role: "user" | "assistant" | "system" | "tool";
  timestamp: number;
  
  /** 主内容（兼容简单文本，向后兼容） */
  content?: string;
  
  /** 扩展 parts（支持多模态内容） */
  parts?: SessionPart[];
  
  /** 元数据 */
  metadata?: MessageMetadata;
}

interface MessageMetadata extends Record<string, unknown> {
  isCheckpoint?: boolean;
  checkpointId?: string;
  checkpointMeta?: SessionCheckpoint;
  model?: string;           // 用于此消息的模型
  contextUsage?: ContextUsage;  // Token 使用统计
}
```

---

## 4. AI SDK 转换设计

### 4.1 SessionMessage → ModelMessage

```typescript
import type { ModelMessage } from "ai";

/**
 * 将 SessionMessage 转换为 AI SDK ModelMessage 格式
 */
function toModelMessage(msg: SessionMessage): ModelMessage {
  // ============ Assistant Message ============
  if (msg.role === "assistant") {
    const content: any[] = [];
    
    // Text parts
    msg.parts?.filter(p => p.type === "text").forEach(p => {
      content.push({ type: "text", text: p.content });
    });
    
    // Reasoning parts
    msg.parts?.filter(p => p.type === "reasoning").forEach(p => {
      const reasoningPart = p as ReasoningPart;
      content.push({ 
        type: "reasoning", 
        text: reasoningPart.content,
        reasoningType: reasoningPart.reasoningType,
      });
    });
    
    // Tool call parts → AI SDK tool-call
    msg.parts?.filter(p => p.type === "tool-call").forEach(p => {
      const toolPart = p as ToolCallPart;
      content.push({
        type: "tool-call",
        toolCallId: toolPart.toolCallId,
        toolName: toolPart.toolName,
        input: typeof toolPart.arguments === "string" 
          ? JSON.parse(toolPart.arguments) 
          : toolPart.arguments,
      });
    });
    
    return { role: "assistant", content };
  }
  
  // ============ Tool Message ============
  if (msg.role === "tool") {
    const toolPart = msg.parts?.find(p => p.type === "tool-result") as ToolResultPart | undefined;
    return {
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: toolPart?.toolCallId || "",
        toolName: toolPart?.toolName || "",
        output: toolPart?.output || msg.content || "",
      }],
    };
  }
  
  // ============ User / System Message ============
  return {
    role: msg.role,
    content: msg.content || "",
  };
}

/**
 * 将 Session 消息列表转换为 AI SDK history
 */
function sessionToHistory(messages: SessionMessage[]): ModelMessage[] {
  return messages
    .filter(msg => !msg.metadata?.isArchived)
    .map(toModelMessage);
}
```

### 4.2 AI SDK ModelMessage → SessionMessage

```typescript
/**
 * 从 AI SDK ModelMessage 转换回 SessionMessage
 */
function fromModelMessage(aiMsg: ModelMessage): SessionMessage {
  const parts: SessionPart[] = [];
  const content = aiMsg.content;
  
  if (typeof content === "string") {
    parts.push({ type: "text", content });
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === "text") {
        parts.push({ type: "text", content: part.text || "" });
      } 
      else if (part.type === "reasoning") {
        parts.push({
          type: "reasoning",
          content: part.text || "",
          reasoningType: (part as any).reasoningType,
          state: "completed",
        });
      }
      else if (part.type === "tool-call") {
        parts.push({
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          arguments: part.input,
          state: "pending",
        });
      }
      else if (part.type === "tool-result") {
        parts.push({
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: typeof part.output === "string" ? part.output : JSON.stringify(part.output),
          state: "completed",
        });
      }
      else if (part.type === "file") {
        parts.push({
          type: "file",
          mime: (part as any).mediaType || "application/octet-stream",
          url: (part as any).url || "",
          filename: (part as any).filename,
        });
      }
    }
  }
  
  return {
    id: `msg_${Date.now()}`,
    sessionID: "",
    role: aiMsg.role as Role,
    timestamp: Date.now(),
    parts,
    content: typeof content === "string" ? content : undefined,
  };
}
```

---

## 5. Provider Options 处理

### 5.1 Reasoning 提取

某些模型（如 DeepSeek R1、Kimi k2.5）需要通过 `providerOptions` 传递 reasoning 配置：

```typescript
/**
 * 从 SessionMessage 提取 provider-specific options
 */
function extractProviderOptions(msg: SessionMessage): Record<string, any> {
  const reasoningParts = msg.parts?.filter(p => p.type === "reasoning") || [];
  
  if (reasoningParts.length === 0) return {};
  
  const reasoningText = reasoningParts.map(p => p.content).join("\n");
  
  return {
    // OpenAI 兼容格式 (DeepSeek, Kimi 等)
    openaiCompatible: {
      reasoning_effort: reasoningParts[0].reasoningType || "high",
    },
    
    // Anthropic 格式
    anthropic: {
      thinking: {
        type: "enabled",
        budget_tokens: reasoningParts[0].metadata?.tokenCount || 10000,
      },
    },
  };
}
```

---

## 6. 完整消息示例

### 6.1 完整 Tool Call 流程

```typescript
// 1. User Message
{
  id: "msg_001",
  role: "user",
  content: "帮我搜索一下代码中的 TODO",
  parts: [
    { type: "text", content: "帮我搜索一下代码中的 TODO" }
  ],
  timestamp: 1743300000000
}

// 2. Assistant Reasoning（AI 的思考过程）
{
  id: "msg_002",
  role: "assistant",
  content: "",
  parts: [
    { 
      type: "reasoning", 
      content: "用户需要搜索 TODO 标记。我需要使用 grep 工具来搜索代码中的 TODO 关键字。",
      reasoningType: "core",
      state: "completed",
      isCollapsed: true,
      metadata: { tokenCount: 50, time: { start: 1743300000100, end: 1743300000150 } }
    }
  ],
  timestamp: 1743300000100
}

// 3. Assistant with Tool Call
{
  id: "msg_003",
  role: "assistant",
  content: "",
  parts: [
    { type: "text", content: "我来帮你搜索 TODO 标记。" },
    { 
      type: "tool-call", 
      toolCallId: "abc123", 
      toolName: "grep", 
      arguments: '{"pattern":"TODO"}', 
      state: "pending" 
    }
  ],
  timestamp: 1743300000200
}

// 4. Tool Result
{
  id: "msg_004",
  role: "tool",
  content: "找到 3 处 TODO:\n1. src/index.ts:15\n2. src/app.ts:42\n3. src/utils.ts:8",
  parts: [
    { 
      type: "tool-result", 
      toolCallId: "abc123", 
      toolName: "grep", 
      output: "找到 3 处 TODO:\n1. src/index.ts:15\n2. src/app.ts:42\n3. src/utils.ts:8", 
      state: "completed" 
    }
  ],
  timestamp: 1743300000300
}

// 5. Assistant Final Response
{
  id: "msg_005",
  role: "assistant",
  content: "代码中发现 3 处 TODO 标记...",
  parts: [
    { type: "text", content: "代码中发现 3 处 TODO 标记..." }
  ],
  timestamp: 1743300000400
}
```

### 6.2 转换为 AI SDK ModelMessage（用于 LLM 调用）

```typescript
// sessionToHistory() 输出
[
  { role: "user", content: "帮我搜索一下代码中的 TODO" },
  
  { 
    role: "assistant", 
    content: [
      { type: "reasoning", text: "用户需要搜索 TODO 标记...", reasoningType: "core" },
      { type: "text", text: "我来帮你搜索 TODO 标记。" },
      { type: "tool-call", toolCallId: "abc123", toolName: "grep", input: { pattern: "TODO" } }
    ]
  },
  
  { 
    role: "tool", 
    content: [
      { type: "tool-result", toolCallId: "abc123", toolName: "grep", output: "找到 3 处 TODO..." }
    ]
  },
  
  { role: "assistant", content: [{ type: "text", text: "代码中发现 3 处 TODO 标记..." }] }
]
```

---

## 7. 实现计划

### 7.1 第一阶段：类型定义改造

- [ ] 更新 `SessionMessage` 类型定义
- [ ] 添加完整的 `SessionPart` 联合类型
- [ ] 实现 `TextPart`, `ToolCallPart`, `ToolResultPart`, `ReasoningPart` 等接口
- [ ] 更新 `MessageMetadata` 类型

### 7.2 第二阶段：转换函数

- [ ] 实现 `toModelMessage()` 函数
- [ ] 实现 `fromModelMessage()` 函数
- [ ] 实现 `sessionToHistory()` 函数
- [ ] 添加 `extractProviderOptions()` 函数

### 7.3 第三阶段：存储层改造

- [ ] 更新 SQLite storage 的 schema
- [ ] 更新 Memory storage 的实现
- [ ] 确保向后兼容（旧数据仍可读取）

### 7.4 第四阶段：集成测试

- [ ] 更新 mock 命令生成符合新格式的消息
- [ ] 测试 compact 命令能够正确处理新格式
- [ ] 测试 `roy act` 命令能够正确保存和读取消息

---

## 8. 向后兼容性

### 8.1 旧数据迁移

```typescript
/**
 * 将旧格式消息转换为新格式
 */
function migrateMessage(oldMsg: any): SessionMessage {
  // 如果已经有 parts 且符合新格式，直接返回
  if (oldMsg.parts && oldMsg.parts.length > 0) {
    const firstPart = oldMsg.parts[0];
    if (firstPart.type === "text" || firstPart.type === "tool-call") {
      return oldMsg as SessionMessage;
    }
  }
  
  // 旧格式：content 为纯文本，需要包装为 text part
  return {
    ...oldMsg,
    content: oldMsg.content,
    parts: oldMsg.content ? [{ type: "text", content: oldMsg.content }] : [],
  };
}
```

### 8.2 读取兼容

- 读取时自动迁移旧格式消息
- 写入时始终使用新格式
- `content` 字段保留用于简单展示

---

## 9. 参考资料

- [AI SDK v6 文档](https://sdk.vercel.ai/docs/foundations/messages)
- [agent-core-source session 实现](../agent-core-source/packages/core/src/core/session/)
- [agent-core-source history 转换](../agent-core-source/packages/core/src/core/session/history.ts)
- [LLM Transform 层](../agent-core-source/packages/core/src/llm/transform.ts)
