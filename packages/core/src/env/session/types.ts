/**
 * @fileoverview Session Component Types
 */

import { z } from "zod";

// ============================================================================
// Config Schema
// ============================================================================

/**
 * Session Component configuration schema
 */
export const SessionConfigSchema = z.object({
  /** Default working directory */
  defaultDirectory: z.string().default("/tmp"),

  /** Default title template */
  defaultTitleTemplate: z.string().default("Session - {date}"),

  /** Maximum number of messages per session */
  maxMessages: z.number().default(100),

  /** Context compaction threshold (percentage) */
  compactionThreshold: z.number().default(80),

  /** Enable auto compaction */
  autoCompact: z.boolean().default(true),

  /** Storage configuration */
  storage: z.object({
    type: z.enum(["memory", "sqlite"]).default("sqlite"),
    dbPath: z.string().optional(),
  }).default({}),
}).transform((config) => ({
  ...config,
  // Set defaultDirectory to cwd if not provided and equals default
  defaultDirectory: config.defaultDirectory === "/tmp" ? (typeof process !== 'undefined' ? process.cwd() : "/tmp") : config.defaultDirectory,
}));

export type SessionConfig = z.infer<typeof SessionConfigSchema>;

// ============================================================================
// Checkpoint Types (new)
// ============================================================================

/**
 * Checkpoint type
 */
export type CheckpointType = "compact" | "manual";

/**
 * Checkpoint metadata (stored in Session.metadata)
 */
export interface CheckpointMeta {
  id: string;
  messageIndex: number;
  title: string;
  createdAt: number;
  type: CheckpointType;
}

/**
 * Recent message for checkpoint
 * 
 * Stores a simplified version of a message for context preservation
 */
export interface RecentMessage {
  role: string;
  content: string;
}

/**
 * Complete checkpoint information (includes generated content)
 */
export interface SessionCheckpoint extends CheckpointMeta {
  /**
   * ★ C 方案（Task #4933 重写）：整段自然语言 checkpoint 正文。
   *
   * 用户决策：压缩产物不再结构化 —— 没有 summary /
   * processKeyPoints / currentState / nextSteps / userIntents 五栏位，
   * 也没有固定 markdown 小节契约。正文形式自由（段落/列表/代码块都行）。
   *
   * 旧格式存量数据（生产 555 个）由 adaptLegacyCheckpoint()
   * 在读取时合成 content，不写回数据库。
   */
  content: string;
  messageCountBefore: number;

  /**
   * Recent messages preserved from the compacted conversation
   *
   * Contains the last N turns of user query + assistant text response
   * (excluding tool calls and tool results).
   * This allows the checkpoint to serve as a fresh history context.
   *
   * Format: [user, assistant, user, assistant, ...] from most recent
   */
  recentMessages?: RecentMessage[];
}

/**
 * Checkpoints metadata in session
 */
export interface SessionCheckpointsMeta {
  latestCheckpointId?: string;
  checkpoints: CheckpointMeta[];
}

/**
 * Checkpoint message metadata (stored in message metadata)
 */
export interface CheckpointMessageMeta {
  isCheckpoint: boolean;
  checkpointId: string;
  checkpointMeta: SessionCheckpoint;
}

// ============================================================================
// Session Entity
// ============================================================================

/**
 * Session entity
 */
export interface Session {
  id: string;
  title: string;
  directory: string;
  /**
   * Top-level parent session id (Task #1739).
   *
   * - `null` when this session has no parent, or when the underlying storage
   *   row pre-dates the field (no backward migration is performed).
   * - Persisted in SQLite via the existing `parent_id` column to avoid a
   *   schema migration; the column is shared with the legacy `parentID`.
   *
   * New code should prefer this field. `parentID` is kept as a deprecated
   * alias that always mirrors `parentSessionId`.
   */
  parentSessionId: string | null;
  /**
   * @deprecated Kept for backward compatibility. Mirrors `parentSessionId`.
   * New code should set/read `parentSessionId` instead.
   */
  parentID?: string;
  /*
   * ★ Task #5403：**alias / linkedTo 能力已整体废弃**（历史字段，已从类型移除）。
   *
   * 原语义：本 session 是另一个 session 的 alias，消息读写透传到 target。
   * 废弃原因（用户 2026-11-12 定稿）：
   *  1. 群 session 由 **default agent** 的 system prompt 驱动，sub session 由
   *     **sub agent** 驱动 —— 复用同一份 history 会让 LLM prefix cache 失效；
   *  2. sub agent 的 delegate prompt（「不要发飞书消息」等约束）会污染群对话。
   *
   * 新方案：建群后群 session 是**独立 session**，仅注入 1 条 user role 事件
   * 说明「原 session 可作背景，需要时用 `roy-bot sessions messages <id>`
   * 按需读取」。关联关系改存 session.metadata（见 SessionMetadata 注释）。
   *
   * DB 层 `session.linked_to` 列**保留但不写入**（避免破坏性迁移）。
   */
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  metadata?: SessionMetadata;
}

/**
 * Session metadata
 */
export interface SessionMetadata extends Record<string, unknown> {
  /** Total number of messages in the session */
  messageCount?: number;
  checkpoints?: SessionCheckpointsMeta;
  checkpointDetails?: Record<string, SessionCheckpoint>;

  // ==========================================================================
  // Task #4023: chat_id ↔ task_id 双向绑定
  // --------------------------------------------------------------------------
  // 每个飞书群聊（chat_id）对应的 session 里都会带一个 larkChat 子树，
  // 记录该群聊绑定的 task_id（用于群消息 → 自动新建子任务时复用父任务）。
  // 反向绑定（task → chat）走 task.context.larkPerTaskChatId（沿用 Task #3945）。
  // ==========================================================================
  larkChat?: ChatTaskBinding;

  // ==========================================================================
  // Task #5403: 群 ← 会话 关联（取代已废弃的 linkedTo / alias）
  // --------------------------------------------------------------------------
  // 建群后的群 session 是**独立 session**，不共享原会话的消息历史。关联关系
  // 记录在群 session 自己的 metadata 上，用于：
  //   1. 重复建群保护（给定原 sessionId 反查出它的群 chatId）
  //   2. 卡片显示「📨 进入专属群」链接
  //   3. 解绑时定位要解散哪个群
  // 反向查询实现：`SessionComponent.findGroupChatForSession(sessionId)`
  // （扫 metadata.linkedFromSessionId，走 JSON1 抽取，不依赖 schema 变更）
  // ==========================================================================

  /**
   * 建群时登记：这个群 session 是由哪个 session「关联建群」而来的。
   *
   * ⚠️ 语义仅作**溯源标注**，不代表消息透传 / 共享历史。群 session 自己的
   * 消息就是群里的实际对话；原会话历史需按需通过
   * `roy-bot sessions messages <linkedFromSessionId>` 读取。
   */
  linkedFromSessionId?: string;
  /** 关联建群时间（ISO 8601） */
  groupCreatedAt?: string;
}

/**
 * 飞书群聊 → task 绑定关系
 *
 * 存储位置：session.metadata.larkChat（session id = chat_id）
 *
 * 关键约束：
 * - chatId 是 session 主键（PRIMARY KEY），天然唯一
 * - taskId 与 chatId 是 1:1（每个 task 群对应唯一一个 task）
 * - rebindCount > 0 时表示曾尝试绑定到不同 task（保留旧 taskId 防误覆盖）
 */
export interface ChatTaskBinding {
  /** 飞书群聊 ID（与 session.id 相同，冗余便于诊断） */
  chatId: string;
  /** 绑定的 task ID */
  taskId: number;
  /** 创建群聊时使用的 lark-cli profile */
  profile?: string;
  /** 绑定时间（ISO 8601） */
  boundAt: string;
  /** 绑定状态：creating→ready 成功，failed 标记失败可重试 */
  status: "creating" | "ready" | "failed";
  /** 失败时的错误信息（成功时为 null） */
  errorMessage?: string | null;
  /** 不同 taskId 重绑次数（>0 时表示检测到冲突） */
  rebindCount: number;
}

/**
 * upsertChatTaskBinding 入参
 */
export interface UpsertChatTaskBindingOptions {
  /** 飞书群聊 ID（必填） */
  chatId: string;
  /** 绑定的 task ID（必填，必须为正整数） */
  taskId: number;
  /** lark-cli profile（可选） */
  profile?: string;
  /** 绑定状态，默认 "ready" */
  status?: "creating" | "ready" | "failed";
  /** 失败时的错误信息 */
  errorMessage?: string | null;
}

// ============================================================================
// Workflow Session Types (new)
// ============================================================================

/**
 * Agent Sub-session reference
 */
export interface AgentSessionRef {
  nodeId: string;
  sessionId: string;
  status: 'active' | 'paused' | 'completed';
}

/**
 * Workflow Session metadata
 * Extends SessionMetadata with workflow-specific fields
 */
export interface WorkflowSessionMetadata extends SessionMetadata {
  type: 'workflow';
  workflowId?: string;
  workflowName: string;
  workflowVersion?: string;
  status: 'running' | 'paused' | 'completed' | 'failed';
  input?: unknown;
  rootNodeId?: string;
  agentSessions?: AgentSessionRef[];
}

/**
 * Session message
 */
export interface SessionMessage {
  id: string;
  sessionID: string;
  role: Role;
  content: string;
  timestamp: number;
  parts?: MessagePart[];
  
  /** Whether the message has been archived (compacted) */
  isArchived?: boolean;
  
  /** Timestamp when the message was archived */
  archivedAt?: number;
  
  /** Checkpoint ID this message belongs to */
  checkpointId?: string;
  
  /** Message metadata (includes checkpoint info if this is a checkpoint message) */
  metadata?: MessageMetadata;
}

/**
 * Message metadata
 */
export interface MessageMetadata extends Record<string, unknown> {
  /** 消息类型标识，用于过滤和分类 */
  type?: "tool_call" | "tool_result" | "checkpoint" | "user_intent" 
    | "workflow.node.start"      // Workflow node execution started (对应 tool-call)
    | "workflow.node.interrupt"  // Workflow node waiting for user input
    | "workflow.node.end"         // Workflow node execution completed (对应 tool-result)
    | "workflow.node.resume";     // Workflow node resumed after user response
  isCheckpoint?: boolean;
  checkpointId?: string;
  checkpointMeta?: SessionCheckpoint;
  
  // Workflow-specific metadata fields
  /** Workflow node ID (for workflow.node.* messages) */
  workflowNodeId?: string;
  /** Workflow node type (for workflow.node.* messages) */
  workflowNodeType?: string;
  /** Agent session ID (for agent nodes in workflow) */
  agentSessionId?: string;
  /** User response (for workflow.node.resume messages) */
  response?: string;
  /** Success flag (for workflow.node.end messages) */
  success?: boolean;
}

/**
 * Message role
 */
export type Role = "user" | "assistant" | "system" | "tool"
  | "workflow.node.start"      // Workflow node execution started (对应 tool-call)
  | "workflow.node.interrupt"  // Workflow node waiting for user input
  | "workflow.node.end"        // Workflow node execution completed (对应 tool-result)
  | "workflow.node.resume";    // Workflow node resumed after user response

/**
 * Message part
 */
export type MessagePart = SessionPart;

// ============================================================================
// New Session Part Types (AI SDK v6 compatible)
// ============================================================================

/**
 * Text part - plain text content
 */
export interface TextPart {
  type: "text";
  content: string;
  /** If true, this part was generated by the system (e.g., auto-summary) */
  synthetic?: boolean;
  /** If true, this part should be ignored (e.g., replaced by reasoning) */
  ignored?: boolean;
}

/**
 * Tool call part - represents a tool invocation
 */
export interface ToolCallPart {
  type: "tool-call";
  /** AI SDK standard field name */
  toolCallId: string;
  toolName: string;
  /** Tool arguments - can be string (JSON) or object */
  arguments: string | Record<string, unknown>;
  state: "pending" | "running";
}

/**
 * Tool result part - represents the result of a tool execution
 */
export interface ToolResultPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: string;
  error?: string;
  state: "completed" | "error";
}

/**
 * Reasoning part - AI thinking/thought content
 */
export interface ReasoningPart {
  type: "reasoning";
  /** Reasoning content */
  content: string;
  /** Reasoning type (for different models) */
  reasoningType?: "core" | "effort" | "summary";
  /** State */
  state?: "thinking" | "completed";
  /** Whether to collapse by default (like AI SDK default) */
  isCollapsed?: boolean;
  /** Metadata */
  metadata?: {
    tokenCount?: number;
    time?: { start: number; end?: number };
  };
}

/**
 * File part - file attachment
 */
export interface FilePart {
  type: "file";
  mime: string;
  url: string;
  filename?: string;
}

/**
 * Image part - multimodal image attachment
 *
 * Used in user messages for vision-capable LLM calls. Field shape mirrors
 * the AI SDK v6 `ImagePart` ({ type: 'image', image: DataContent | URL })
 * so that round-trip through `toModelMessage` / `fromModelMessage` is
 * lossless. Stores the image data as a `data:` URL string, a remote URL
 * string, or a `URL` object instance.
 *
 * @see packages/core/src/env/llm/invoke.ts convertToSDKMessages
 *      for how LLMMessage.image parts map to the AI SDK ImagePart shape.
 */
export interface ImagePart {
  type: "image";
  /** Image data (data: URL / base64 / remote URL / URL object) */
  image: string | URL;
  /** Optional MIME type (e.g. "image/png") — best-effort metadata */
  mimeType?: string;
}

/**
 * Checkpoint part - compaction checkpoint marker
 * 
 * Represents a checkpoint message in the conversation history.
 * This is stored as a user role message with markdown content summarizing
 * the compacted conversation segment.
 */
export interface CheckpointPart {
  type: "checkpoint";
  /** Checkpoint ID reference */
  checkpointId: string;
  /** Checkpoint content (整段自然语言正文) */
  content: string;
  /** Title of the checkpoint */
  title?: string;
  /** Number of messages that were compacted */
  messageCountBefore?: number;
  /** Creation timestamp */
  createdAt?: number;
}

/**
 * Union type for all Session Part types
 */
export type SessionPart = 
  | TextPart 
  | ToolCallPart 
  | ToolResultPart 
  | ReasoningPart
  | FilePart 
  | ImagePart
  | CheckpointPart
  // Workflow-specific parts
  | WorkflowNodeStartPart
  | WorkflowNodeInterruptPart
  | WorkflowNodeEndPart
  | WorkflowNodeResumePart;

/**
 * workflow.node.start 消息 part (对应 tool-call)
 */
export interface WorkflowNodeStartPart {
  type: 'workflow-node-start';
  nodeId: string;
  nodeType: string;
  input?: unknown;
  startTime: number;
  /** Agent session ID (only for agent nodes) */
  agentSessionId?: string;
}

/**
 * workflow.node.interrupt 消息 part
 */
export interface WorkflowNodeInterruptPart {
  type: 'workflow-node-interrupt';
  nodeId: string;
  nodeType: string;
  query: string;
  options?: string[];
  timestamp: number;
  /** Agent session ID (only for agent nodes) */
  agentSessionId?: string;
}

/**
 * workflow.node.end 消息 part (对应 tool-result)
 */
export interface WorkflowNodeEndPart {
  type: 'workflow-node-end';
  nodeId: string;
  nodeType: string;
  output?: unknown;
  error?: string;
  durationMs: number;
  /** Agent session ID (only for agent nodes) */
  agentSessionId?: string;
}

/**
 * workflow.node.resume 消息 part
 */
export interface WorkflowNodeResumePart {
  type: 'workflow-node-resume';
  nodeId: string;
  response: string;
  timestamp: number;
  /** Agent session ID (only for agent nodes) */
  agentSessionId?: string;
}

/**
 * Context usage statistics
 */
export interface ContextUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextWindow?: number;
  usagePercent?: number;
  requestCount: number;
  lastUpdated: number;
}

// ============================================================================
// Options
// ============================================================================

/**
 * Options for creating a session
 */
export interface CreateSessionOptions {
  /** Custom session ID (optional, will be generated if not provided) */
  id?: string;
  title?: string;
  directory?: string;
  /**
   * @deprecated Use `parentSessionId` instead. Retained as alias for
   * backward compatibility — passing `parentID` is equivalent to
   * passing `parentSessionId` and the same value will be set on both
   * fields of the resulting Session.
   */
  parentID?: string;
  /**
   * ID of the parent session whose execution spawned this one.
   * Mirrored to the legacy `parentID` field on the resulting Session.
   */
  parentSessionId?: string | null;
  metadata?: Record<string, unknown>;
  hooks?: SessionHooksConfig;
}

/**
 * Options for updating a session
 */
export interface UpdateSessionOptions {
  title?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Options for listing sessions
 */
export interface ListSessionsOptions {
  filter?: {
    metadata?: Record<string, unknown>;
    startTime?: number;
    endTime?: number;
  };
  sort?: {
    field: "updatedAt" | "createdAt" | "title";
    order: "asc" | "desc";
  };
  offset?: number;
  limit?: number;
}

/**
 * Options for adding a message
 */
export interface AddMessageOptions {
  role: Role;
  content: string;
  parts?: MessagePart[];
  metadata?: MessageMetadata;
}

// ============================================================================
// Compact Options & Result (new)
// ============================================================================

/**
 * Options for compact operation
 *
 * ★ Task #4933（C 方案）：只剩 `scenarioHint` 一个语义字段。
 *   旧的 processKeyPoints / currentState / nextSteps 三栏位 hint 已删除
 *   （它们是「五栏位结构化」时代的遗留 —— C 方案下压缩产物是整段自然语言，
 *   用户/CLI 再拼装结构化栏位没有意义，且会让后续开发者误以为五栏位仍是契约）。
 *   `summary` 同样未在 compact() 中被读取（HEAD 之前即如此），一并移除。
 */
export interface CompactOptions {
  /** Whether this is auto-triggered compact */
  auto?: boolean;
  
  /** 
   * Scenario hint for guiding checkpoint generation
   * 
   * A natural language description that provides context about the current scenario.
   * This helps the checkpoint generator produce more relevant content based on the
   * specific situation. Examples:
   * - "Task execution in progress: implementing feature X, current working directory is /path/to/project"
   * - "Bug investigation: analyzing crash dump, current hypothesis is memory corruption"
   * - "Code review session: reviewing PR #123, focus on security implications"
   * 
   * When provided, it is injected into the compact agent's query as a focus hint.
   */
  scenarioHint?: string;
}

/**
 * Result of compact operation
 */
export interface CompactResult {
  checkpoint: SessionCheckpoint;
  deletedMessageCount: number;
  remainingMessageCount: number;
  checkpointCount: number;
}

/**
 * Preview of compact operation
 */
export interface CompactPreview {
  messageCountToCompact: number;
  estimatedCheckpointTokens: number;
  wouldTrigger: boolean;
}

/**
 * 存量 checkpoint 适配报告（Task #4933 C 方案）
 *
 * 生产库有 555 个旧格式 checkpoint（五栏位，无 content）。
 * `adaptStoredCheckpoints()` 默认 dry-run，返回本报告用于人工核对。
 */
export interface CheckpointAdaptReport {
  sessionId: string;
  /** checkpoint 总数 */
  total: number;
  /** 旧格式（无 content）数量 */
  legacy: number;
  /** 新格式（已有 content）数量 */
  modern: number;
  /** 实际写回的数量（dry-run 时恒为 0） */
  applied: number;
  /** 抽样（最多 3 条），用于人工确认合成正文质量 */
  samples: Array<{
    id: string;
    title: string;
    contentLength: number;
    contentPreview: string;
  }>;
}

// ============================================================================
// Context Reading Options (new)
// ============================================================================

/**
 * Options for getting session context
 */
export interface GetContextOptions {
  /** Start from specified checkpoint */
  fromCheckpoint?: string;
  
  /** Start from latest checkpoint (default: true) */
  fromLatestCheckpoint?: boolean;
  
  /** Read full history (ignore checkpoints) */
  fullHistory?: boolean;
  
  /** Message limit */
  messageLimit?: number;
  
  /** Minimum user messages to include (ensures starting from user message boundary) */
  minUserMessages?: number;
  
  /** Include checkpoint details */
  includeCheckpoints?: boolean;
}

/**
 * Result of getting session context
 */
export interface GetContextResult {
  session: Session;
  checkpoints: SessionCheckpoint[];
  startCheckpoint?: SessionCheckpoint;
  messages: SessionMessage[];
  totalMessageCount: number;
  activeMessageCount: number;
  archivedMessageCount: number;
  estimatedTokens: number;
}

// ============================================================================
// Get Messages Options (new)
// ============================================================================

/**
 * Options for getting messages
 */
export interface GetMessagesOptions {
  /** Include archived messages */
  includeArchived?: boolean;
  
  /** From checkpoint ID */
  fromCheckpointId?: string;
  
  /** Reverse order */
  reverse?: boolean;
}

// ============================================================================
// Hooks
// ============================================================================

/**
 * Session hook type
 */
export type SessionHookType =
  | "before.session.create"
  | "after.session.create"
  | "before.session.get"
  | "after.session.get"
  | "before.session.list"
  | "after.session.list"
  | "before.session.update"
  | "after.session.update"
  | "before.session.delete"
  | "after.session.delete"
  | "before.session.compact"           // (new)
  | "after.session.compact"             // (new)
  | "before.session.createCheckpoint"   // (new)
  | "after.session.createCheckpoint"    // (new)
  | "before.session.deleteCheckpoint"  // (new)
  | "after.session.deleteCheckpoint";   // (new)

/**
 * Session hook context
 */
export interface SessionHookContext {
  session?: Session;
  id?: string;
  options?: CreateSessionOptions | UpdateSessionOptions;
  checkpoint?: SessionCheckpoint;  // [new] For checkpoint hooks
}

/**
 * Session hook callback
 */
export type SessionHookCallback = (context?: any) => Promise<void>;

/**
 * Session hook definition
 */
export interface SessionHook {
  name: string;
  before?: SessionHookCallback;
  after?: SessionHookCallback;
}

/**
 * Session hooks configuration
 */
export interface SessionHooksConfig {
  [key: string]: SessionHook[];
}

// ============================================================================
// Search Types (new)
// ============================================================================

/**
 * Options for searching messages
 */
export interface SearchMessagesOptions {
  /** Search query (supports AND/OR/NOT syntax) */
  query: string;
  
  /** Limit search to specific session ID */
  sessionId?: string;
  
  /** Maximum number of results per session */
  limit?: number;
  
  /** Maximum total results */
  maxResults?: number;
  
  /** Only search messages before this timestamp */
  beforeTime?: number;
  
  /** Only search messages after this timestamp */
  afterTime?: number;
  
  /** Include archived messages */
  includeArchived?: boolean;
  
  /** Include context (messages before/after matches) */
  includeContext?: boolean;
  
  /** Number of context lines before/after */
  contextLines?: number;
}

/**
 * A single message match
 */
export interface MessageMatch {
  /** Message ID */
  messageId: string;
  
  /** Session ID */
  sessionId: string;
  
  /** Message role */
  role: Role;
  
  /** Message content */
  content: string;
  
  /** Message timestamp */
  timestamp: number;
  
  /** Context before the match (if enabled) */
  contextBefore?: string;
  
  /** Context after the match (if enabled) */
  contextAfter?: string;
  
  /** Match score (relevance) */
  score?: number;
}

/**
 * Search result aggregated by session
 */
export interface SearchResult {
  /** Session ID */
  sessionId: string;
  
  /** Session title */
  sessionTitle: string;
  
  /** Session directory */
  sessionDirectory: string;
  
  /** Session update timestamp */
  updatedAt: number;
  
  /** Total message count in session */
  messageCount: number;
  
  /** Matching messages in this session */
  matches: MessageMatch[];
}

/**
 * Search result with metadata
 */
export interface SearchResultWithMeta {
  /** Total number of matching messages */
  totalMatches: number;
  
  /** Number of sessions with matches */
  sessionCount: number;
  
  /** Results grouped by session */
  results: SearchResult[];
}
