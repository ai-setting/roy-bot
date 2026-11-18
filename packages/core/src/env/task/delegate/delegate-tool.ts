/**
 * @fileoverview delegate_task Tool
 *
 * 基于 agent-core 的 delegate_task 实现
 * 参考: packages/core/src/core/environment/expend/task/task-tool.ts
 *
 * 功能：
 * - 委派子Agent执行任务（仅后台模式）
 * - 支持多种 subagent 类型
 * - 支持任务关联（task_id）
 * - 发布 task.background.* EnvEvent 事件供外部订阅
 *
 * Note: 自 2026-06 起，delegate_task 仅支持后台模式。
 * 父 agent 通过返回的 task_id 主动查询进度。
 */

import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../../tool/types";
import type { TaskComponent } from "../task-component";
import { createLogger } from "../../log-trace/logger";
import { TracedAs, wrapFunction } from "../../log-trace/decorator";
import { AgentComponent } from "../../agent";
import type { AgentRegistry } from "../../agent/agent-registry";
import { getCurrentTaskId, getEnvContext } from "../../context";
import {
  ProcessRegistry,
  runWithProcessRegistryAsync,
} from "./process-registry";
import { runWithBgTaskIdAsync } from "./bg-task-id-storage";
import { buildDelegateChannelHint } from "./delegate-channel-hint";
import { getSharedEventStore } from "../../event-source/event-store";
import {
  isKnownSubagentType,
  listKnownSubagentDescriptions,
  resolveSubAgentConfig,
} from "./subagent-resolver";
// Bundle-time 内置 prompts — 用 'roy' 作 builtInSubAgents 的 promptOverride 来源，
// 让 delegate_task tool description 在没有 AgentRegistry 的极端场景下也能展示 roy。
import { builtInPrompts } from "../../prompt/prompts-index";

// Hook 机制
import { globalHookManager } from "../../hook/global-hook-manager";
import { TaskHookPoints } from "../hooks";
import type { TaskDelegateContext } from "../hooks/contexts";
import { getOrCreateTaskReuseRegistry } from "../task-reuse-registry";
import { buildReuseCandidateSection } from "../task-reuse-context";
import type { Session } from '../../session/types';

const logger = createLogger("task:delegate");

// ============================================================================
// Background Task Event Types
// ============================================================================

/**
 * Background Task Event Types
 * 这些事件由 BackgroundTaskManager 发布，标识为 task.background.*
 */
export const BackgroundTaskEventTypes = {
  STARTED: "task.background.started",
  PROGRESS: "task.background.progress",
  COMPLETED: "task.background.completed",
  FAILED: "task.background.failed",
  TIMEOUT: "task.background.timeout",
  STOPPED: "task.background.stopped",
  /**
   * Task #3147 (subagent ask_user cascade → 标准 notify event)
   * 当 delegate_task 触发的 sub-agent 内部调用 ask_user tool 并抛出 AskUserError 时，
   * BackgroundTaskManager.executeTask 的 catch 块捕获后，发布此事件供 CLI EventHandler
   * 走**标准** notify 流程（与 task.background.completed 等完全一致）：
   *   - EventMessageFormatter 渲染 payload（含 question + subSessionId + rule-based hints）
   *   - handleEventMessageWithEnv → executeInternal 把消息喂给主 agent LLM
   *   - 主 agent 用 ask_user tool 展示问题、等用户答复
   *   - 拿到答复后用 delegate_task(subagent_type=..., sub_session_id=payload.subSessionId, ...)
   *     复用 sub-session 让 sub-agent 继承消息历史继续推进（无需 resume function）。
   *
   * 关键：hints 由 BackgroundTaskManager 在构造事件时 rule-based 填充（事件自带），
   * CLI 端 formatter 只渲染，handler 端零特殊化。
   */
  ASK_USER: "task.background.ask_user",
  /**
   * ★ 补充需求（22:31）：sub-agent 启动、**但尚未建 task**。
   *
   * ## 为什么需要独立一个事件（不能复用 STARTED）
   *
   * `STARTED` 在 `createTask()` 里就发，此刻 `associatedTaskId` 还是
   * `undefined`（sub-agent 还没跑、当然还没建 task）—— 所以它**无法**告诉
   * 卡片层「这是 task 卡还是 session 卡」。
   *
   * 而用户要的是：**只要跑起来了、且没建 task，就应该有卡片可点刷新**。
   *
   * ⇒ 在 sub-agent 完成「是否建了 task」的判定之后（即 `COMPLETED` 时
   *   反查 `associatedTaskId` 之后），若仍无 task，才补发本事件。
   *
   * 语义：`STARTED` = 「有后台任务在跑」（task 视角）；本事件 =
   * 「这次执行挂不到 task 上」（session 视角）。两者互补，不重复。
   */
  SESSION_STARTED: "task.background.session_started",
} as const;

// ============================================================================
// Payload Types
// ============================================================================

export interface BackgroundTaskStartedPayload {
  backgroundTaskId: string;
  subSessionId: string;
  parentSessionId: string;
  description: string;
  subagentType: string;
  /**
   * ★ Task #4552 (A1)：任务启动时刻（epoch ms）。
   *
   * 消费端（CLI EventHandler）把 telemetry 降级成一条纯 IM 进展提示后，
   * 文案要回答「跑了多久」，只能从这里读。缺失时文案降级（不渲染「已跑」）。
   */
  startedAt?: number;
  /**
   * ★ Task #4552 (A1)：本任务被允许的运行时长（毫秒）。
   *
   * 让用户看到「预计 17:23 超时（timeout 5h）」，避免以为「早该有结论了」——
   * 这正是 Task #4552 报障的认知错位（用户 16:40 以为超时，实际 17:23 才超）。
   */
  timeoutMs?: number;
}

export interface BackgroundTaskProgressPayload {
  backgroundTaskId: string;
  subSessionId: string;
  parentSessionId: string;
  status: string;
  progress?: number;
  description?: string;
  associatedTaskId?: number;
  /** ★ Task #4552 (A1)：见 BackgroundTaskStartedPayload.startedAt */
  startedAt?: number;
  /** ★ Task #4552 (A1)：见 BackgroundTaskStartedPayload.timeoutMs */
  timeoutMs?: number;
}

export interface BackgroundTaskCompletedPayload {
  backgroundTaskId: string;
  subSessionId: string;
  parentSessionId: string;
  status: "completed" | "failed" | "timeout" | "stopped";
  result?: string;
  error?: string;
  executionTimeMs: number;
  description?: string;
  associatedTaskId?: number;
}

/**
 * Task #3147 — ask_user 事件 payload（标准 notify event 流程）
 *
 * 当 BackgroundTaskManager.executeTask 的 catch 块识别到 AskUserError 时发布。
 * CLI 端 EventHandler 订阅 `task.background.ask_user` 事件后走**标准** notify
 * 流程（跟 task.background.completed 等完全一致，无任何特殊化）：
 *   - EventMessageFormatter 渲染 payload（question + subSessionId + hints）成消息
 *   - handleEventMessageWithEnv → executeInternal 把消息喂给主 agent LLM
 *   - 主 agent 用 ask_user tool 把 question 展示给用户
 *   - 拿到用户答复后用 delegate_task(subagent_type=payload.subagentType,
 *     sub_session_id=payload.subSessionId, prompt=<用户答复>)
 *     复用 sub-session 让 sub-agent 继承之前消息历史继续推进（无需 resume function）。
 *
 * hints 是 rule-based 提示数组，BackgroundTaskManager 在构造事件时填充。
 */
export interface BackgroundTaskAskUserPayload {
  backgroundTaskId: string;
  subSessionId: string;
  parentSessionId: string;
  subagentType: string;
  description: string;
  /**
   * 解码后的 AskUserError fields（来自 __ASK_USER_ERROR__:...JSON.parse）：
   * - query: 原始 ask_user 调用时传入的问题文本（含可选 "(选项: A, B)" 后缀）
   * - sessionId: AskUserError.sessionId（sub-agent 的 session id，与 subSessionId 一致）
   * - nodeId: AskUserError.nodeId（sub-agent 内部 ask_user 节点的 ID）
   * - nodeType: AskUserError.nodeType（默认 'agent'）
   * - agentSessionId: AskUserError.agentSessionId（optional，用于跨工具链 resume）
   */
  query: string;
  sessionId: string;
  nodeId: string;
  nodeType: string;
  agentSessionId?: string;
  /**
   * ★ Task #4983 — 问题**是否已投递到用户渠道**（工具层判定）。
   *
   * - `true`  → ask_user 工具已经把问题正文发到 IM 渠道，用户已看到 ⇒
   *              主 agent 那一轮**不得**再发（否则用户收到两条）。
   * - `false` → 工具层没投成（没有 replyChannel / 投递失败）⇒ 需要兜底投递。
   */
  delivered?: boolean;
  /** 原始 __ASK_USER_ERROR__:... 错误字符串（备份，便于诊断） */
  error: string;
  executionTimeMs: number;
  associatedTaskId?: number;
  /**
   * Task #3147 — Rule-based hints（事件载荷自带）
   *
   * 原本 #3142 写在 formatter 的 [🤖 Agent 操作提示] 块，按用户预期重做为
   * **事件 payload 自带** 的 hints 数组：rule-based 由 BackgroundTaskManager
   * 在构造 ASK_USER 事件时填充，formatter 只负责渲染，handler 端零特殊化。
   *
   * 内容：
   * - 「显示给用户」/「等待回复」/「delegate_task 续传」
   *
   * 包含必要 ID（subagentType / subSessionId / backgroundTaskId）便于 LLM
   * 看到消息后直接构造 delegate_task 续传调用。
   */
  hints: string[];
}

// ============================================================================
// SubAgent Types (简化版)
// ============================================================================

export interface SubAgentSpec {
  id: string;
  name: string;
  description: string;
  mode: "subagent" | "primary" | "all";
  promptOverride?: string;
  /** 允许的工具列表（白名单） */
  allowedTools?: string[];
  /** 拒绝的工具列表（黑名单） */
  deniedTools?: string[];
}

export const builtInSubAgents: SubAgentSpec[] = [
  {
    id: "general",
    name: "general",
    mode: "subagent",
    description: "General-purpose agent for researching complex questions and executing multi-step tasks.",
    promptOverride: `You are a subagent created by the main agent to handle a specific task.

## Your Role
- You were created to handle: {task_description}
- Complete this task. That's your entire purpose.
- You are NOT the main agent. Don't try to be.

## Task Context Awareness (Required Behavior)

**IMPORTANT: Before starting any work, you MUST gather task context to avoid working with outdated or missing information.**

**Step 0: Check if task_id is already provided**
- The session info above includes \`task_id\`.
- **If task_id is provided** (not N/A or 0):
  Use \`task_get\` with that task_id directly — this is your confirmed task.
  **Skip any searching.** Read its details and operations.
- **If no valid task_id** is provided:
  Use the task description to guide your work.
  Look for the task via \`task_list\` if needed.

**Then gather full context:**
1. **Read task details**: Use \`task_get\` to read the task's:
   - \`description\`: Detailed description of what needs to be done
   - \`goals_and_expected_deliverables\`: Clear success criteria and expected outputs
   - \`current_status\`: Current work progress
   - \`parent_task_id\`: If exists, this is a sub-task

2. **Read recent operations**: Use \`task_operation_list\` to get the last ~15 operation records
   - These provide history, progress, decisions, and context from previous work

3. **Read parent task context** (if \`parent_task_id\` exists):
   - Use \`task_get\` to read the parent task's description and goals
   - Use \`task_operation_list\` to get parent's recent operations
   - This forms the overall task background and ensures alignment

**Why this matters**: 
- The main agent may have made critical decisions recorded in operations
- Parent task goals provide the broader context for your sub-task
- Without this context, you risk working on wrong/outdated goals

## Rules
1. **Gather context first** - Always read task details and operations before starting
2. **Stay focused** - Do your assigned task, nothing else
3. **Complete the task** - Your final message will be automatically reported to the main agent
4. **Don't initiate** - No heartbeats, no proactive actions, no side quests
5. **Be ephemeral** - You may be terminated after task completion. That's fine.
6. **No nested delegation** - Do NOT use delegate_task or stop_task tools. Complete the task yourself.

## Execution
- Use the available tools to complete the task
- If you need more information, ask the main agent through the result
- Return a clear summary of what you did and the results`,
    // Prevent nested delegation by denying delegate_task and stop_task
    deniedTools: ["delegate_task", "stop_task"],
  },
  {
    id: "explore",
    name: "explore",
    mode: "subagent",
    description: "Fast agent specialized for exploring codebases, finding files, and searching for patterns.",
    allowedTools: ["read_file", "glob", "grep", "bash"],
    deniedTools: ["delegate_task", "stop_task"],
  },
  {
    // 内置 roy subagent — Roy Intelligent OS 的核心通用子智能体
    // prompt 来自 builtInPrompts['roy']（bundle-time 注入）
    // 实际运行时优先走 AgentRegistry.registerRoyAgent() 注册的 AgentDefinition
    // （保留 systemPromptRef 路径以便后续被 PromptComponent hook 装饰）；
    // 此处 builtInSubAgents 条目仅作 fallback / delegate_task tool description 提前可见性。
    id: "roy",
    name: "Roy",
    mode: "subagent",
    description:
      "Versatile AI assistant inspired by Jarvis — intelligent, proactive, and capable. Use for general-purpose tasks, coding, research, and complex multi-step work. Always available (built-in) without `agent add roy`.",
    promptOverride: builtInPrompts["roy"],
    // ★ Task #5007 — task_complete / task_cancel 移交 default agent（验收权分离，裁判 ≠ 运动员）。
    //   ★ Task #5073 — task_pre_complete 不禁用：执行方提交待验证的提交口。
    //   与 AgentRegistry.registerRoyAgent() 的 deniedTools 保持一致。
    deniedTools: ["delegate_task", "stop_task", "task_complete", "task_cancel"],
  },
];

export function getSubAgentSpec(id: string): SubAgentSpec | undefined {
  return builtInSubAgents.find((agent) => agent.id === id);
}

function listSubAgents(): SubAgentSpec[] {
  return [...builtInSubAgents];
}

// ============================================================================
// SubAgent Registration Helper
// ============================================================================

/**
 * 确保 subAgent 已注册到 AgentComponent
 * 
 * 对于 workflow type 的 agent，跳过注册（workflow agent 不需要 system prompt 和 runtime agent）。
 * 
 * @param agentComponent AgentComponent 实例
 * @param subagentType subAgent 类型（用作 agentName）
 * @param basePrompt 基础 system prompt
 * @param subAgent subAgent 配置（可能包含 allowedTools）
 * @param deniedTools 拒绝的工具列表
 * @returns 注册的 agent 实例，workflow agent 返回 null
 */
/**
 * ★ Task #5333（DS review 第 2 轮 MINOR-4）— 把松散来源的 extendTools 归一。
 *
 * `ToolContext.metadata` 是 `Record<string, unknown>`，从里面取出的值理论上
 * 可能是任意类型。`filterToolsByAgent` 用 `extendTools.includes(name)` 判断，
 * 若传进来一个对象或含非字符串的数组，既不报错也永不命中 —— 表现为
 * 「名单写了却不生效」的诡异静默失败。这里做一次运行时收敛：
 *
 * - 非数组 → undefined（视为未放行）
 * - 数组 → 只保留非空字符串（trim 后），全被过滤掉则返回 undefined
 *
 * @param raw 来自 ToolContext.metadata 的原始值
 * @returns 干净的字符串数组或 undefined
 */
export function normalizeExtendTools(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (trimmed.length === 0) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out.length > 0 ? out : undefined;
}

function ensureSubAgentRegistered(
  agentComponent: any,
  subagentType: string,
  basePrompt: string,
  subAgent: SubAgentSpec | undefined,
  deniedTools: string[]
): any {
  // ★ Workflow 类型 agent 跳过注册
  // workflow agent 不需要 system prompt 和 runtime agent 实例
  const registry = agentComponent.getRegistry?.() as AgentRegistry | undefined;
  if (registry) {
    const agentDef = registry.get(subagentType);
    if (agentDef?.type === "workflow") {
      logger.debug(`[delegate] Skipping registration for workflow agent: ${subagentType}`);
      return null;
    }
  }

  let agentInstance = agentComponent.getAgent(subagentType);
  if (!agentInstance) {
    const agentConfig: Record<string, unknown> = {
      type: "sub",
      systemPrompt: basePrompt,
    };

    // 添加 allowedTools（如果有）
    if (subAgent?.allowedTools && subAgent.allowedTools.length > 0) {
      agentConfig.allowedTools = subAgent.allowedTools;
    }

    // 添加 deniedTools（如果有）
    if (deniedTools.length > 0) {
      agentConfig.deniedTools = deniedTools;
    }

    agentInstance = agentComponent.registerAgent(subagentType, agentConfig as any);
    logger.debug(`[delegate] Registered subagent: ${subagentType}`);
  }
  return agentInstance;
}

// ============================================================================
// Tool Parameters Schema
// ============================================================================

export const DelegateToolParameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z
    .string()
    .describe("The type of specialized agent to use for this task")
    .default("general"),
  timeout: z
    .number()
    .describe("Task timeout in milliseconds. Default: 1800000 (30 minutes). If set, task will be terminated after timeout.")
    .optional(),
  reason: z
    .string()
    .describe("Brief reason for calling this tool (max 30 chars, e.g., 'Delegate refactor task')")
    .optional(),
  similar_task_ids: z.array(z.number()).max(3)
    .describe("Similar task IDs (max 3) to reference for improving task execution. Search for similar tasks before calling this tool."),
  // ★ 新增 sub_session_id（可选参数，但续跑场景是硬约束）
  // 当后台任务超时/失败时，父 agent 可传入此参数复用 sub session，
  // 让 sub agent 继承之前的对话上下文继续推进。
  sub_session_id: z
    .string()
    .describe(
      "⚠️ 硬约束：同一任务链的续跑必须传此参数（从终态 notify 的「子 session:」行" +
      "或 delegate 返回的「🔗 Sub-session:」行复制）。" +
      "仅当旧 session 上下文已确认不可救（compact_session 后仍超限 / 迭代上限且无可复用断点）时才留空；" +
      "留空等于丢弃全部上下文，从零开始。"
    )
    .optional(),
  // ★ ESPlugin v2 (Task #4042)：EventStore trigger event ID。
  //
  // 当这次 delegate_task 由某个 ESEvent（飞书消息 / bounty-im / ...）触发时，
  // 主 agent 应传入由 EventSource handler 落库后返回的 triggerEventId。
  // BackgroundTaskManager 会把它透传到 task.background.* 事件的 metadata，
  // 主 agent 处理 notify event 时即可反查原始 chatId / messageId，正确处理回复目标。
  //
  // 不传：向后兼容（notify event metadata 无 triggerEventId，走老回复路径）。
  triggerEventId: z
    .string()
    .describe(
      "EventStore trigger event ID (ESPlugin v2). Pass it when this delegate_task " +
      "is triggered by an external event source (e.g. Feishu message) so the " +
      "completion notification can reply to the original chat instead of a " +
      "fallback channel. Leave empty if not triggered by an event source."
    )
    .optional(),
});

export type DelegateToolParams = z.infer<typeof DelegateToolParameters>;

// ============================================================================
// Delegate Tool Implementation
// ============================================================================

export interface DelegateToolResult {
  tool: Tool;
  backgroundTaskManager: BackgroundTaskManager;
}

export interface BackgroundTask {
  id: string;
  /**
   * Task #2590 follow-up — runId of the sub-agent run launched by this task.
   *
   * Pre-allocated in `executeWithAbort` and passed to `env.handle_query` via
   * `AgentContext.runId` so the record is populated BEFORE the run actually
   * starts. Used for run-scoped abort via `agentComponent.abortRun(runId)`
   * instead of the agent-name-scoped `agentComponent.abort(subagentType)`
   * (which silently killed concurrent same-type sub-agents and is the
   * root cause of silent-fail empty `result`).
   */
  runId?: string;
  subSessionId: string;
  parentSessionId: string;
  description: string;
  subagentType: string;
  status: "pending" | "running" | "completed" | "failed" | "timeout" | "stopped" | "awaiting-user";
  createdAt: number;
  /** Timestamp of the latest lifecycle state change or progress notification. */
  lastUpdatedAt?: number;
  startedAt?: number;
  /**
   * Task #4623 — 父 agent 本次 run 使用的模型（`providerId/modelId`）。
   *
   * `roy-bot act "..." --model X` 时，父 agent 的 AgentContext.model 会经
   * ToolContext 透传到 delegate_task，最终写在这里，并在
   * `executeWithAbort` 里作为 sub-agent 的 `AgentContext.model` 传入。
   *
   * 注意：**不写进 sub-agent 的注册配置**（`ensureSubAgentRegistered`）。
   * 注册只在首次发生（已存在则跳过），写注册期 model 会导致「第一次对、
   * 第二次旧」的状态漂移；per-run 透传天然每次都是最新值。
   */
  model?: string;
  /** Task #4623 — 父 agent 的兜底模型，同样透传给 sub-agent。 */
  fallbackModel?: string;
  /**
   * Task #4724 — 父 agent 的兜底模型**有序列表**，透传给 sub-agent。
   * 顺序 = 优先级（主模型失败后逐个尝试）。
   */
  fallbackModels?: string[];
  /**
   * ★ Task #5217 fix 2 — 父 agent 本次 run 的 channel systemPrompt
   * （context.metadata.systemPrompt，如 lean lark 渠道 prompt）。
   * 透传给 sub-agent 的 AgentContext.metadata.systemPrompt，
   * 使 AgentComponent._run 把它追加到 sub-agent 的 LLM system message。
   *
   * 注意：与 model 一样**不写进 sub-agent 的注册配置** —— per-run
   * 透传天然每次都是最新值（channel prompt 是 per-event 的）。
   */
  systemPrompt?: string;
  /**
   * ★ Task #5333 — 父 run 的渠道专用工具放行名单（AgentContext.extendTools）。
   *
   * 企微事件驱动的父 agent 有 `["wecom_respond"]`；委派出去的 sub-agent
   * 若拿不到这份名单，`wecom_respond`（channelOnly 工具）在 sub-agent 侧
   * 不可见 → 子任务无法给企微用户回复。因此随 task 一起透传。
   */
  extendTools?: string[];
  /**
   * ★ Task #4552 (A1)：本任务被允许的运行时长（毫秒，createTask 时确定）。
   *
   * 存到 task 上而不是每次重算：progress 心跳发生在 20 分钟后，那时
   * `timeout` 参数已不在作用域内，只能靠这里。同时保证 started / progress
   * 两条通知给出同一个超时时刻。
   */
  timeoutMs?: number;
  completedAt?: number;
  result?: string;
  error?: string;
  progress?: number;
  progressMessage?: string;
  abortController?: AbortController;
  associatedTaskId?: number;
  similarTaskIds?: number[];
  /**
   * Task #4042 (ESPlugin v2 Phase 2)：trigger event ID
   *
   * 由 ES 触发的 delegate_task 会把 triggerEventId 通过 publishBackgroundEvent
   * 透传到所有 task.background.* event，让事件 trigger CLI 可反查 EventStore
   * 拿原始 chatId。不存在时表示非 ES 触发（向后兼容）。
   */
  triggerEventId?: string;
  /**
   * ★ Task #4042 follow-up — delegate 时刻捕获的回复通道快照。
   *
   * 之前 notify event 不带 replyChannel，CLI EventHandler 处理 task.background.*
   * 时只能 fallback 到 REPL 的全局 `lastReplyChannel`（last-write-wins），
   * 多群并发时"最后来的群消息决定所有任务通知回哪个群"（#4035/#4038/#4039 串群）。
   *
   * 修复：createTask 时把 parent EnvContext 的 replyChannel 快照到 task，
   * publishBackgroundEvent 时写进 event.metadata.replyChannel，让每个通知自带
   * 自己 task 诞生时的回复目标；EventHandler.extractChatId 优先用它做
   * chat-keyed session 隔离与回复路由，不再依赖全局 lastReplyChannel。
   */
  replyChannel?: {
    type?: string;
    appId?: string;
    chatId?: string;
    messageId?: string;
    profile?: string;
    params?: Record<string, unknown>;
  };
  /**
   * ★ Task #5265 — delegate 时刻的 pluginEnabled 快照。
   *
   * 后台任务通知轮（task.background.* 合成 envEvent）此前
   * pluginEnabled={}（空）→ WecomTaskNotifyPlugin 等 ES 插件的
   * pluginEnabled 守卫拦截 → 不发卡（用户只见纯文本）。
   * createTask 时快照 parent EnvContext.pluginEnabled，
   * publishBackgroundEvent 时写进 event.metadata.pluginEnabled。
   */
  pluginEnabledSnapshot?: Record<string, boolean>;
}

/**
 * Task #4794 — BackgroundTaskManager.dispose() 的行为选项。
 *
 * `skipAbortRunningTasks`：跳过 abort 仍在运行的后台任务。
 * CLI `act` 一次性命令正常收尾时传 true —— 主 run 已结束，
 * 后台子 agent 是有意留下继续跑的，abort 会把它们误杀
 * （task_signal_abort）。用户主动退出（ESC cascade / 强杀）
 * 走默认（不传），保持 abort 全部语义。
 */
export interface DisposeOptions {
  /** true = 不 abort 仍在运行的任务（act 收尾路径） */
  skipAbortRunningTasks?: boolean;
  /**
   * Task #4794 — true = 等待所有运行中任务完成后再返回。
   * 与 skipAbortRunningTasks 配套：跳过 abort 后，若进程即将
   * exit，必须先等子 agent 跑完（子 agent 是同进程异步 run，
   * process.exit 会直接杀死它们）。默认 false（不等待）。
   */
  waitForRunningTasks?: boolean;
}

export interface CreateBackgroundTaskOptions {
  parentSessionId: string;
  description: string;
  prompt: string;
  subagentType: string;
  timeout?: number;
  similarTaskIds?: number[];
  /**
   * 如果 subagentType 是 workflow 类型被 entry-agent 中介，
   * 此字段记录原始 workflow 名称（用于日志/审计/追踪）。
   *
   * 背景：.roy/design/2026-06-29-workflow-subagent-entry-agent-design.md
   */
  originalWorkflowName?: string;
  /**
   * ★ 已有 sub-agent session ID（可选）。
   * 传入时跳过 sessionComponent.create()，改为 sessionComponent.get() 校验后复用。
   * 用于超时/失败后的重试场景，sub agent 继承之前会话上下文（消息历史保留），
   * 只需在 metadata 中标记 reused_sub_session=true + reused_at=timestamp。
   *
   * 2026-07-10 新增（Task #1752 subSessionId 复用与超时重试机制）
   */
  existingSubSessionId?: string;
  /**
   * ★ Task #4042 (ESPlugin v2 Phase 2)：trigger event ID
   *
   * 当 delegate_task 由 ES 触发时（用户在飞书群里说"调研 X"，主 agent 调 delegate_task），
   * ES 先通过 EventStore.insertTriggerEvent 把原始飞书消息落库，拿到 triggerEventId，
   * 然后调用 delegate_task 时把 triggerEventId 传到这里。
   *
   * BackgroundTaskManager 会：
   *  1. 把 triggerEventId 写到 sub-session.metadata.triggerEventId（sub-agent 读 ALS 仍可用）
   *  2. 透传到后续所有 task.background.* event metadata（让 CLI event-handler 反查 EventStore）
   */
  triggerEventId?: string;
  /**
   * Task #4623 — 父 agent 本次 run 的模型（`providerId/modelId`）。
   * 透传给 sub-agent，使 `--model` 对 delegate 出来的子 agent 同样生效。
   */
  model?: string;
  /** Task #4623 — 父 agent 的兜底模型，透传给 sub-agent。 */
  fallbackModel?: string;
  /**
   * Task #4724 — 父 agent 的兜底模型**有序列表**，透传给 sub-agent。
   */
  fallbackModels?: string[];
  /**
   * ★ Task #5217 fix 2 — 父 agent 本次 run 的 channel systemPrompt
   * （context.metadata.systemPrompt，如 lean lark 渠道 prompt）。
   * 透传给 sub-agent 的 AgentContext.metadata.systemPrompt。
   */
  systemPrompt?: string;
  /**
   * ★ Task #5333 — 父 run 的渠道专用工具放行名单（AgentContext.extendTools）。
   * 透传给 sub-agent 的 AgentContext.extendTools，使子 agent 也能看到
   * 本渠道的 channelOnly 工具（如 wecom_respond）。
   */
  extendTools?: string[];
}

/**
 * 构建 entry-agent 调度的 prompt 包装 (Task #2164 beta-compare divergence #2)
 *
 * 当 delegate_task 检测到 workflow 类型 subagent (或 5 legacy yaml alias) 时,
 * 用此函数包装原始 prompt, 明确告诉 entry-agent 要调度哪个 workflow.
 *
 * 结构化设计 (beta divergence vs reference #2146):
 * - 使用 `<workflow_name>NAME</workflow_name>` XML 标签作为唯一权威的 workflow 名来源
 * - 取代 reference 让 LLM 通过 pattern examples 解析 workflow 名的方案
 * - 工作流名应严格从这个标签解析 (避免 LLM 模式猜测)
 * - 用法: prompt.match(/<workflow_name>([^<]+)<\/workflow_name>/)?.[1]
 */
export function buildEntryAgentPrompt(options: {
  workflowName: string;
  originalPrompt: string;
  description: string;
}): string {
  const { workflowName, originalPrompt, description } = options;
  return `# Workflow 调度请求

你被调用是因为上游 \`delegate_task\` 检测到 workflow 类型 subagent **${workflowName}**。
请通过 \`workflow_run\` 命令调度对应 workflow。

<workflow_name>${workflowName}</workflow_name>

## 调度目标

- **Workflow 名称**: \`${workflowName}\` (权威来源: \`<workflow_name>\` 标签, 不要从上下文猜测)
- **任务描述**: ${description}

## 原始用户请求

${originalPrompt}

## 你的行动

1. \`workflow_get(${workflowName})\` 取 workflow 入参 schema
2. 从"原始用户请求"提取符合 schema 的 input 字段
3. \`workflow_run(${workflowName}, input)\` 触发 workflow
4. 把 output 原样回给 parent agent

不要做其他工作。只走 \`workflow_run\` 路径。
`;
}

/**
 * 5 个 legacy yaml subagent 名称 (Task #2164 兼容性)
 *
 * 用户历史上可能在 ~/.local/share/roy-bot/agents/ 下配置过这些名字的 yaml 文件，
 * 为了不破坏用户配置, Beta 把它们统一改写到 workflow-runner.
 *
 * 设计：Set 查找 O(1)，不引入额外 dispatcher 类。
 */
export const WORKFLOW_COMPAT_ALIASES: ReadonlySet<string> = new Set([
  "strict-task-agent",
  "code-review",
  "bench-agent-host",
  "workspace-analyzer",
  "test-workflow-agent",
]);

export const DEFAULT_TIMEOUT = 1800000; // 30 minutes
/**
 * Task #4888 — progress 心跳间隔。
 *
 * 历史：#4720 曾把它从 20 分钟下调到 10 分钟（想让 liveness 信号更细），
 * 但实测 10 分钟太频繁 —— 每条心跳都会占用飞书 lane 并触发一次额外
 * agent run，对用户是噪声。故回滚到 20 分钟。
 *
 * ⚠️ 真正的「细粒度活跃度」已由 #4720 的 Fix A/B 解决（sub-session 每轮
 * ReAct 增量落盘 + query_background_process 暴露 messageCount /
 * subSessionUpdatedAt），**不再依赖缩短心跳**。所以这个值不必再往下调。
 */
export const PROGRESS_INTERVAL = 1200000; // 20 minutes

/**
 * Background Task Manager (简化版)
 *
 * 管理后台任务的创建、执行、状态跟踪
 * 发布 task.background.* 事件供外部订阅
 */
export class BackgroundTaskManager {
  /**
   * Task #2539 — processRegistries 上限。超过上限时 createTask 拒绝（拒绝 throw），
   * 防止 spawn 出 bug 时无界累积。默认 1000（足够日常使用，又不至于无限增长）。
   * 实际活跃 task 数受 processRegistries.size 限制；正常 task 完成后 finalizeTask
   * 会清掉 map entry；残留 PID task（BL-4c）保留 map entry 直到 killAll 才清。
   */
  private readonly maxProcessRegistries: number = 1000;
  /**
   * Task #2539 — terminalTasks 上限。终态任务从 tasks Map 移到这里，cap 1000。
   * 超过上限时丢最旧的（保持 LRU 语义：最近完成的任务优先保留，便于 query_background_process 查询）。
   */
  private readonly maxTerminalTasks: number = 1000;
  private tasks: Map<string, BackgroundTask> = new Map();
  /**
   * Task #2539 — 终态任务镜像。
   * finalizeTask 时把 BackgroundTask 从 tasks Map 移到这里；getTask 优先查 tasks，其次 terminalTasks。
   * 上限 maxTerminalTasks，超过时丢最旧。
   */
  private terminalTasks: Map<string, BackgroundTask> = new Map();
  private abortControllers: Map<string, AbortController> = new Map();
  private progressTimers: Map<string, NodeJS.Timeout> = new Map();
  /**
   * Per-task ProcessRegistry（2026-07 新增）。
   * 跟踪该 task 派生的所有子进程 PID；timeout/stop/dispose 时遍历杀进程树。
   * 内部值是 ProcessRegistry 实例；存储而不暴露，便于测试访问。
   *
   * Task #2539 — 终态释放契约：transient registry（tasks / abortControllers /
   * workflowRunRegistries / 本 task 的 processRegistries entry）在 sub session
   * 终态触发后必须释放；processRegistries 仅在 size==0 时 delete map 入口
   * （保留 BL-4c force-stop 重试 contract）。
   */
  private processRegistries: Map<string, ProcessRegistry> = new Map();
  /**
   * Per-task workflow run registry (Task #2144).
   * 跟踪该 task 派生的所有 workflow_run runId；stopTask() 时遍历调 workflowService.stopRun。
   * 镜像 processRegistries 的 Map<bgTaskId, Set<workflowRunId>> 模式。
   */
  private workflowRunRegistries: Map<string, Set<string>> = new Map();
  /**
   * WorkflowService 引用（Task #2144 — 反向注入，避免 task → workflow 直接 import）。
   * WorkflowComponent 启动时通过 setWorkflowService() 注入。
   */
  private workflowService?: {
    stopRun(runId: string, reason?: string): Promise<void>;
  };

  constructor(private env: any) {
    // env 应该具有 pushEnvEvent 和 getComponent 方法
  }

  /**
   * Task #2144 — 注入 WorkflowService 引用。
   * 由 WorkflowComponent 在初始化时反向注入（避免 task → workflow 直接 import）。
   * 缺省时 propagateStopToWorkflowRuns 仅记录 warn 日志，不抛错。
   */
  setWorkflowService(svc: {
    stopRun(runId: string, reason?: string): Promise<void>;
  }): void {
    this.workflowService = svc;
  }

  /**
   * Task #2144 — Attach a workflow runId to a bgTask。
   * 当 sub-session 通过 workflow_run 启动 workflow 时调用，把 runId 注册到
   * 对应 bgTaskId 的 workflowRunRegistries，供 stopTask() 级联 stop。
   *
   * 空字符串 / 缺失参数静默忽略（避免脏数据）；重复 attach 同一 runId 幂等。
   */
  @TracedAs("task.background.attachWorkflowRun", {
    recordParams: true,
    recordResult: false,
    log: true,
  })
  attachWorkflowRun(bgTaskId: string, workflowRunId: string): void {
    if (!bgTaskId || !workflowRunId) return;
    let set = this.workflowRunRegistries.get(bgTaskId);
    if (!set) {
      set = new Set();
      this.workflowRunRegistries.set(bgTaskId, set);
    }
    set.add(workflowRunId);
  }

  /**
   * Task #2144 — Detach a workflow runId from a bgTask。
   * 当 workflow_run 自然完成（success）时调用，把 runId 从 registry 中移除，
   * 避免 propagateStopToWorkflowRuns 重复 stop 已完成的 workflow。
   * 缺省时 propagateStop 仍会 stopRun，但 stopRun 对已完成 workflow 是幂等的。
   */
  @TracedAs("task.background.detachWorkflowRun", {
    recordParams: true,
    recordResult: false,
    log: true,
  })
  detachWorkflowRun(bgTaskId: string, workflowRunId: string): void {
    this.workflowRunRegistries.get(bgTaskId)?.delete(workflowRunId);
  }

  /**
   * Task #2190 — Replace a placeholder runId with the real engine runId.
   * 触发时机：sub-session 调 workflow_run 时，wrapper 立即用 reservedRunId
   * 做 PRE-attach；engine 随后通过 onSessionCreated 报回真实 runId；tool 调
   * 此 hook 把 registry 里的占位 id 替换成真实 id，使后续 stop_task 能针对
   * 真实 workflow 调用 stopRun。
   *
   * 语义：若 oldRunId 存在则删除；若 newRunId 非空则加入（覆盖式 swap）。
   * 空字符串 / 缺失参数静默忽略；bgTaskId 不存在则 no-op。
   */
  @TracedAs("task.background.replaceWorkflowRun", {
    recordParams: true,
    recordResult: false,
    log: true,
  })
  replaceWorkflowRun(
    bgTaskId: string,
    oldRunId: string,
    newRunId: string,
  ): void {
    if (!bgTaskId) return;
    const set = this.workflowRunRegistries.get(bgTaskId);
    if (!set) return;
    if (oldRunId) {
      set.delete(oldRunId);
    }
    if (newRunId) {
      set.add(newRunId);
    }
  }

  /**
   * Task #2144 — 级联 stop 所有 attach 到 bgTaskId 的 workflow runs。
   * 在 stopTask() 的 killAll() 之后调；workflowService.stopRun 对已完成 workflow
   * 是幂等的（try/catch + logger.warn 吞掉 "Session not found" 等异常）。
   * 主 session 直接调用（无 bgTaskId）时 workflowRunRegistries 为空，no-op。
   *
   * Task #2190 — returns `{ runIds, stopResults }` so stopTask() can populate
   * `attached_workflow_run_ids` and `workflow_stop_results` in the payload.
   * `stopResults[i]` mirrors `runIds[i]` 1:1; entries carry `{ runId, success, error? }`.
   */
  @TracedAs("task.background.propagateStopToWorkflowRuns", {
    recordParams: true,
    recordResult: true,
    log: true,
  })
  private async propagateStopToWorkflowRuns(
    bgTaskId: string,
    reason: string
  ): Promise<{
    runIds: string[];
    stopResults: Array<{
      runId: string;
      success: boolean;
      error?: string;
    }>;
  }> {
    const set = this.workflowRunRegistries.get(bgTaskId);
    if (!set || set.size === 0) {
      return { runIds: [], stopResults: [] };
    }
    const runIds = Array.from(set);
    logger.info(
      `[BackgroundTaskManager] propagateStopToWorkflowRuns count=${runIds.length} bgTaskId=${bgTaskId}`
    );
    const stopResults: Array<{ runId: string; success: boolean; error?: string }> = [];
    for (const runId of runIds) {
      if (typeof this.workflowService?.stopRun !== "function") {
        logger.warn(
          `[BackgroundTaskManager] workflowService not injected; cannot stop ${runId}`
        );
        stopResults.push({
          runId,
          success: false,
          error: "workflowService not injected",
        });
        continue;
      }
      try {
        await this.workflowService.stopRun(runId, reason);
        stopResults.push({ runId, success: true });
      } catch (err) {
        // Idempotent: workflow may already be completed/failed/stopped.
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.warn(
          `[BackgroundTaskManager] workflowService.stopRun(${runId}) failed (likely already terminal): ${errMsg}`
        );
        stopResults.push({ runId, success: false, error: errMsg });
      }
    }
    set.clear();
    return { runIds, stopResults };
  }

  /**
   * Task #2539 — 终态联动释放 transient registry（success / error / cancel / timeout 共用）。
   *
   * 释放：
   * - tasks Map 中本 task entry（BackgroundTask 对象本身；持有者持有引用时可继续读，但不再可查询）
   * - abortControllers Map 中本 task entry
   * - workflowRunRegistries Map 中本 task entry（per-task Set）
   * - progressTimers Map 中本 task entry（通过 stopProgressReporter）
   *
   * 保留（BL-4c force-stop 重试 contract）：
   * - processRegistries Map 中本 task entry — 仅在 size==0 时 delete map 入口，
   *   残留 PID 时保留 map entry 供下一次 forceStopAllAcrossParents 重试。
   *
   * 幂等：重复调用 no-op（map 上 .delete 第二次返回 false）。
   * 不存在的 taskId：no-op，不报错。
   */
  @TracedAs("task.background.finalizeTask", { recordParams: true, recordResult: false, log: true })
  finalizeTask(taskId: string, reason: string): void {
    if (!taskId) return;

    // Stop progress reporter first to avoid late intervals firing on a finalized task
    this.stopProgressReporter(taskId);
    this.progressTimers.delete(taskId);

    // Task #2539 — tasks Map entry 释放：把 task 从 tasks 移到 terminalTasks（capped）。
    // - tasks Map 不再累积终态对象（解决 OOM 主因之一）
    // - terminalTasks Map 也 capped（防止 OOM）；丢最旧
    // - getTask / listTasks / forceStopAll 兼容两者
    const task = this.tasks.get(taskId);
    if (task) {
      this.tasks.delete(taskId);
      // terminalTasks LRU: 超过上限时丢最旧
      if (this.terminalTasks.size >= this.maxTerminalTasks) {
        const oldestKey = this.terminalTasks.keys().next().value;
        if (oldestKey !== undefined) {
          this.terminalTasks.delete(oldestKey);
        }
      }
      this.terminalTasks.set(taskId, task);
    }

    // Transient: abortController
    // Task #2590 follow-up — completed 路径不再主动 abort controller。
    // 原因：正常完成时 sub-agent 已经没有 in-flight 操作需要取消；
    // 反倒是 finalizeTask 的 abort 会被 `executeWithAbort` 残留的
    // signal listener 看到，触发 `agentComp.abortRun` 二次清理。
    // 跨 run 误杀的风险已经在 listener 内换成 `abortRun(task.runId)`，
    // 这里再 abort 没有收益。stopped/failed/timeout 路径下 abort 仍然
    // 必要（执行可能未结束），但 stop 已经在 stopTask 里主动 abort 过，
    // timeout/failed 路径由 executeWithAbort 的 catch 内部处理。
    const abortCtl = this.abortControllers.get(taskId);
    if (abortCtl && reason !== "completed") {
      if (!abortCtl.signal.aborted) {
        try {
          abortCtl.abort();
        } catch {
          // ignore
        }
      }
    }
    this.abortControllers.delete(taskId);

    // Transient: workflowRunRegistries
    this.workflowRunRegistries.delete(taskId);

    // processRegistries: BL-4c contract — 保留 map entry 供 forceStopAll retry。
    // 不在 finalizeTask 中立刻 delete（即使 size==0），保留到：
    //   - dispose() 全量清理
    //   - cleanupEmptyProcessRegistries() 显式调用（兜底）
    //   - 上限触发 createTask 拒绝时的兜底清理
    // 这样保证 forceStopAllAcrossParents / stopAllForParent 在 BL-4c 残留 PID 重试场景下
    // 一定能通过 processRegistries.get(taskId) 找到 registry 并调 killAll。
    const registry = this.processRegistries.get(taskId);
    if (registry && registry.size() > 0) {
      logger.debug(
        `[BackgroundTaskManager] finalizeTask保留 processRegistry ${taskId} (residualPIDs=${registry.size()}, reason=${reason})`,
      );
    }

    logger.debug(
      `[BackgroundTaskManager] finalizeTask taskId=${taskId} reason=${reason}`,
    );
  }

  /**
   * Task #2539 — processRegistries 当前 size（可观测）。
   * 用于 heap stress 测试 / 监控埋点。
   */
  getProcessRegistrySize(): number {
    return this.processRegistries.size;
  }

  /**
   * Task #2539 — processRegistries 上限。
   */
  getMaxProcessRegistries(): number {
    return this.maxProcessRegistries;
  }

  /**
   * Task #2539 — 清掉所有 size==0 的 processRegistry map entries（保守兜底）。
   * 不主动调用；正常路径由 finalizeTask 在 size==0 时 delete。
   * 提供这个 API 供测试 / 监控。
   *
   * @returns cleaned count
   */
  cleanupEmptyProcessRegistries(): number {
    let cleaned = 0;
    for (const [taskId, registry] of this.processRegistries) {
      if (registry.size() === 0) {
        this.processRegistries.delete(taskId);
        cleaned++;
      }
    }
    return cleaned;
  }

    /**
   * Workflow entry-agent 默认名称
   *
   * 当 delegate_task 检测到 workflow 类型 subagent 时，委托给该 entry-agent。
   * 详见 .roy/design/2026-06-29-workflow-subagent-entry-agent-design.md
   */
  static readonly DEFAULT_WORKFLOW_ENTRY_AGENT = "workflow-runner";

  /**
   * 检查 subagentType 是否需要走 entry-agent 路由（workflow 类型）
   *
   * 返回 entry-agent 名称（如果有），否则返回 undefined（走原路径）。
   *
   * 注意：这里必须 try/catch，因为 this.env?.getComponent 可能抛错。
   *
   * Task #2164 beta-compare divergence #1: 单一层 canonicalization
   * - 5 个 legacy yaml alias (strict-task-agent/code-review/...) 直接在这里重写,
   *   handleBackgroundTask 不再二次检测
   * - 参考 reference 在 createDelegateTool().execute() + handleBackgroundTask()
   *   两层 rewriting, beta 只 1 层
   */
  @TracedAs("task.background.resolveEntryAgent", { recordParams: true, recordResult: true })
  resolveEntryAgent(subagentType: string): string | undefined {
    try {
      // 第一层 (beta 新增): legacy yaml alias compat rewrite.
      // 任何 5 个 legacy yaml 名称 → "workflow-runner" (DEFAULT_WORKFLOW_ENTRY_AGENT)
      // 用 wrapFunction trace 暴露 rewrite 事件 (closes L0 trace gap from #2146)
      if (BackgroundTaskManager.detectWorkflowShortcutCompat(subagentType)) {
        logger.info(
          `[BackgroundTaskManager] Compat rewrite: '${subagentType}' → '${BackgroundTaskManager.DEFAULT_WORKFLOW_ENTRY_AGENT}'`,
        );
        return BackgroundTaskManager.DEFAULT_WORKFLOW_ENTRY_AGENT;
      }

      // 第二层 (unchanged): workflow 类型 agent 走 entryAgent 字段或默认值
      const agentComponent = this.env?.getComponent?.("agent") as AgentComponent | undefined;
      const registry = agentComponent?.getRegistry?.() as AgentRegistry | undefined;
      const agent = registry?.get?.(subagentType);
      if (!agent || agent.type !== "workflow") {
        return undefined; // 非 workflow 类型或无此 agent，不走中介
      }
      return agent.entryAgent ?? BackgroundTaskManager.DEFAULT_WORKFLOW_ENTRY_AGENT;
    } catch (err) {
      logger.warn(`[BackgroundTaskManager] resolveEntryAgent failed for ${subagentType}: ${err}`);
      return undefined;
    }
  }

  /**
   * Internal compat-rewrite detection (Task #2164 trace #3)
   *
   * 用 wrapFunction 包一层让 free-standing 检测逻辑也能进入 OTel span,
   * 参考 reference 把这逻辑标记为 "not-applicable" 因为 @TracedAs 不支持 free function.
   * Beta 用 wrapFunction 让 `delegate.detectWorkflowShortcut` span 被记录。
   */
  private static _detectWorkflowShortcutWrapped = wrapFunction(
    (subagentType: string) => WORKFLOW_COMPAT_ALIASES.has(subagentType),
    "delegate.detectWorkflowShortcut",
    { recordParams: true, recordResult: true, log: true },
  );

  /** 公开的 static 入口，wrapFunction 不污染 caller API */
  static detectWorkflowShortcutCompat(subagentType: string): boolean {
    return BackgroundTaskManager._detectWorkflowShortcutWrapped(subagentType);
  }

  /**
   * Get SessionComponent from env
   */
  private getSessionComponent(): any {
    return this.env?.getComponent?.("session");
  }

  /**
   * sub-session → task 的确定性反查。
   *
   * sub-agent 的 `task_create` 用 `sessionId = ctx.session_id`（即 sub-session id），
   * 因此可按 session_id 反查它创建的第一个 task。用于在 completion 时稳定地确定
   * `associatedTaskId`，避免依赖易失的 `getCurrentTaskId()`（被 task_complete 清空）
   * 或有歧义的结果文本正则。
   */
  private async resolveAssociatedTaskIdBySubSession(
    subSessionId?: string,
  ): Promise<number | undefined> {
    if (!subSessionId) return undefined;
    try {
      const taskComponent = this.env?.getComponent?.("task") as
        | { getTaskIdBySessionId?: (sid: string) => Promise<number | undefined> }
        | undefined;
      const id = await taskComponent?.getTaskIdBySessionId?.(subSessionId);
      return typeof id === "number" && id > 0 ? id : undefined;
    } catch (err) {
      logger.debug(
        `[BackgroundTaskManager] resolveAssociatedTaskIdBySubSession failed for ${subSessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return undefined;
    }
  }

  /**
   * Publish a task.background.* event
   *
   * Task #4042 (ESPlugin v2 Phase 2)：可选 triggerEventId 参数。
   * 当 ES 触发 delegate_task 时，主 agent 会通过 EventStore.insertTriggerEvent
   * 先把原始飞书事件落库，拿到 triggerEventId；sub-agent 完成后 emit notify event
   * 携带 triggerEventId，主 agent 处理 notify event 时反查 EventStore 拿原始 chatId。
   *
   * 不传 triggerEventId 时，向后兼容老代码路径（metadata.triggerEventId 缺失）。
   */
  private publishBackgroundEvent<T>(
    type: string,
    payload: T,
    parentSessionId?: string,
    triggerEventId?: string,
    replyChannel?: BackgroundTask["replyChannel"],
    // ★ Task #5265：delegate 时刻的 pluginEnabled 快照（可选）
    pluginEnabledSnapshot?: Record<string, boolean>,
  ): void {
    if (this.env?.pushEnvEvent) {
      this.env.pushEnvEvent({
        type,
        payload,
        metadata: {
          source: "task.background",
          trigger_session_id: parentSessionId,
          // ★ Task #4042 ESPlugin v2：透传 triggerEventId
          ...(triggerEventId ? { triggerEventId } : {}),
          // ★ Task #4042 follow-up：透传 task 诞生时的 replyChannel 快照，
          //   让 EventHandler 用 chat-keyed session 隔离 + 正确的回复目标，
          //   不再依赖全局 lastReplyChannel（多群并发串群根因）。
          ...(replyChannel ? { replyChannel } : {}),
          // ★ Task #5265：透传 pluginEnabled 快照 —— 通知轮合成
          //   envEvent 自带 pluginEnabled，ES 插件守卫（如
          //   WecomTaskNotifyPlugin）不再被空对象拦截。
          ...(pluginEnabledSnapshot ? { pluginEnabled: pluginEnabledSnapshot } : {}),
        },
      });
      logger.info(`[BackgroundTaskManager] Event published: ${type}`, {
        triggerEventId,
        replyChannelChatId: replyChannel?.chatId,
      });
    }
  }

  /**
   * 带 triggerEventId 的 publishBackgroundEvent 公开版（用于测试和外部调用）
   *
   * @internal 测试 / 集成用，普通调用方走 publishBackgroundEvent 私有方法
   */
  publishBackgroundEventWithTrigger<T>(
    type: string,
    payload: T,
    parentSessionId: string | undefined,
    triggerEventId: string,
    replyChannel?: BackgroundTask["replyChannel"],
    pluginEnabledSnapshot?: Record<string, boolean>,
  ): void {
    this.publishBackgroundEvent(type, payload, parentSessionId, triggerEventId, replyChannel, pluginEnabledSnapshot);
  }

  /**
   * Task #3xxx — 解析 AskUserError 信息
   *
   * env.handle_query() 路径下，ask_user 抛出的 AskUserError 会被 agent-component 编码成
   * `__ASK_USER_ERROR__:{JSON}` 字符串，然后通过 `throw new Error(result.error)`
   * 抛出（environment.ts:417），所以 catch 块只能拿到 plain Error instance。
   * 直接 throw 的场景（如未来插件扩展）也能命中 instance / name 检查。
   *
   * 复用 interactive.ts:1300 parseAskUserError 的识别规则（避免重复实现）：
   *   1. error instanceof AskUserError
   *   2. error.name === 'AskUserError'
   *   3. error.message 包含 __ASK_USER_ERROR__: 前缀 → JSON.parse
   *
   * @returns 解码后的 AskUserErrorInfo；null 表示不是 ask_user 错误（继续走普通 error 分支）
   */
  private static parseAskUserErrorFromMessage(error: unknown): {
    query: string;
    sessionId: string;
    nodeId: string;
    nodeType: string;
    agentSessionId?: string;
    /**
     * ★ Task #4983：工具层是否已把问题投到 IM 渠道。
     * true ⇒ 用户已看到问题（CLI 层不得再投，防双发）。
     */
    delivered?: boolean;
    rawErrorMessage: string;
  } | null {
    const rawErrorMessage = error instanceof Error ? error.message : String(error);

    // 1. 直接 AskUserError 实例（防御性，几乎不会触发）
    if (error && typeof error === "object" && (error as any).name === "AskUserError" && (error as any).query) {
      const e = error as any;
      return {
        query: e.query,
        sessionId: e.sessionId,
        nodeId: e.nodeId,
        nodeType: e.nodeType || "agent",
        agentSessionId: e.agentSessionId,
        delivered: e.delivered === true,
        rawErrorMessage,
      };
    }

    // 2. __ASK_USER_ERROR__: 前缀（env.handle_query 路径下唯一会触发的分支）
    const prefix = "__ASK_USER_ERROR__:";
    if (rawErrorMessage.includes(prefix)) {
      try {
        const jsonStr = rawErrorMessage.substring(
          rawErrorMessage.indexOf(prefix) + prefix.length,
        );
        const parsed = JSON.parse(jsonStr);
        return {
          query: parsed.query,
          sessionId: parsed.sessionId,
          nodeId: parsed.nodeId,
          nodeType: parsed.nodeType || "agent",
          agentSessionId: parsed.agentSessionId,
          delivered: parsed.delivered === true,
          rawErrorMessage,
        };
      } catch (parseErr) {
        logger.warn(
          `[BackgroundTaskManager] Failed to parse __ASK_USER_ERROR__ payload`,
          { error: parseErr instanceof Error ? parseErr.message : String(parseErr) },
        );
        return null;
      }
    }

    return null;
  }

  @TracedAs("task.background.createTask", { recordParams: false, recordResult: true, log: true })
  async createTask(options: CreateBackgroundTaskOptions): Promise<{ taskId: string; subSessionId: string }> {
    const { parentSessionId, description, prompt, subagentType, timeout, similarTaskIds, existingSubSessionId, triggerEventId, model, fallbackModel, fallbackModels, systemPrompt, extendTools } = options;

    const taskIdGen = `process_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

    // Get SessionComponent
    const sessionComponent = this.getSessionComponent();
    if (!sessionComponent) {
      throw new Error("SessionComponent not found");
    }

    // Create sub-session
    const parentSession = await sessionComponent.get(parentSessionId);
    if (!parentSession) {
      throw new Error(`Parent session not found: ${parentSessionId}`);
    }

    // ★ 复用 vs 新建：2026-07-10 subSessionId 复用机制（Task #1752）
    // 复用模式：传入 existingSubSessionId 时跳过 create()，改为 get() 校验后复用 sub session
    // 适用场景：后台任务超时/失败重试，sub agent 继承之前消息历史继续推进
    let subSession: any;
    if (existingSubSessionId) {
      const reusedSession = await sessionComponent.get(existingSubSessionId);
      if (!reusedSession) {
        throw new Error(`Sub session not found for resume: ${existingSubSessionId}`);
      }
      // 软校验：不是 subagent 创建的 session 仅 warn，不 throw
      // ★ 2026-10-16 同源修复：Session 无 .info 包装层。
      //   独立 review P2-4：先前写 `(reusedSession as any)?` —— `as any` 恰好
      //   豁免了「收窄形参类型本要防的 TS2339」，等于自己抵消了收益。
      //   改为依赖真实类型（SessionMetadata extends Record<string, unknown>），
      //   只对读出的值做窄化 cast。
      const createdBy = reusedSession?.metadata?.created_by as string | undefined;
      if (createdBy && createdBy !== "subagent") {
        logger.warn(
          `[BackgroundTaskManager] Session ${existingSubSessionId} was not created by a sub-agent (created_by=${createdBy}); reusing anyway`
        );
      }
      subSession = reusedSession;
      // ★ 标记 metadata：reused_sub_session + reused_at（便于审计/追踪）
      try {
        // ★ 2026-10-16 同源修复：原读 `.info?.metadata` → 恒 {}，
        //   而下方 update() 会把 existingMeta 展开写回 → **反而清空**
        //   sub-session 已有的 metadata（含 subagent_type）
        const existingMeta = reusedSession?.metadata ?? {};
        await sessionComponent.update(existingSubSessionId, {
          metadata: {
            ...existingMeta,
            reused_sub_session: true,
            reused_at: Date.now(),
          },
        });
      } catch (err) {
        // metadata 更新失败不影响复用主流程
        logger.warn(
          `[BackgroundTaskManager] Failed to update reused session metadata`,
          { existingSubSessionId, error: err instanceof Error ? err.message : String(err) }
        );
      }
      logger.info(
        `[BackgroundTaskManager] Reusing sub session: ${existingSubSessionId} for task ${taskIdGen}`
      );
    } else {
      // 新建模式（原行为）
      const metadata: Record<string, unknown> = {
        subagent_type: subagentType,
        created_by: "subagent",
        task_description: description,
      };

      // ★ Task #2326: 把 parent EnvContext 的 lark 上下文透传到 sub-session metadata。
      // 这样后续 sub-agent 通过 effectiveContext.metadata?.messageId 也能拿到原 messageId，
      // 飞书回复优先用 +messages-reply --message-id 关联回原 user query。
      // ALS 继承路径已由 agent-component.ts 修复（parentEnvContext.messageId 优先），
      // 这里再加一层 metadata 持久化，确保 session 重建/查询也能拿回 messageId。
      const parentEnvContext = getEnvContext();
      if (parentEnvContext) {
        if (parentEnvContext.messageId) {
          metadata.messageId = parentEnvContext.messageId;
        }
        const replyChannel = parentEnvContext.replyChannel;
        if (replyChannel?.messageId) {
          metadata.larkMessageId = replyChannel.messageId;
        }
        if (replyChannel?.chatId) {
          metadata.chatId = replyChannel.chatId;
        }
        if (replyChannel?.userId) {
          metadata.larkUserId = replyChannel.userId;
        }
        const profile = (replyChannel as { profile?: string } | undefined)?.profile;
        if (profile) {
          metadata.larkProfile = profile;
        }
        // ★ Task #5423 — 渠道类型快照。executeWithAbort 里据此注入
        // 「渠道交付提示」（飞书云盘 / 企微文档）。落 metadata 而非只读 ALS：
        // resume / 重入 sub-session 时 ALS 可能已换成别的渠道。
        //   replyChannel.type 在 EnvContext 里是必填 string，无需 cast（CV MAJOR-2）。
        const channelType = replyChannel?.type;
        if (channelType) {
          metadata.channelType = channelType;
        }
      }

      // ★ Task #4042 (ESPlugin v2 Phase 2)：透传 triggerEventId 到 sub-session metadata。
      // 当 delegate_task 由 ES 触发时，triggerEventId 由 EventStore.insertTriggerEvent
      // 产生，存到 sub-session.metadata 后 sub-agent 也能读到（即使 ALS envContext 丢失）。
      if (triggerEventId) {
        metadata.triggerEventId = triggerEventId;
      }

      subSession = await sessionComponent.create({
        title: `${description} (@${subagentType} subagent)`,
        // Persist the parent session id at the top-level Session field so
        // `sessions list --graph` can render the hierarchy (Task #1739).
        parentSessionId,
        metadata,
      });

      if (!subSession) {
        throw new Error("Failed to create sub-session");
      }
    }

    // ★ Task #4042 follow-up：捕获 delegate 时刻的 replyChannel 快照。
    // 用于把本 task 的所有 task.background.* 通知路由回"task 诞生时的群"，
    // 而不是依赖 REPL 全局 lastReplyChannel（last-write-wins → 多群串会话）。
    const replyChannelSnapshot = captureReplyChannelSnapshot();

    // ★ Task #5265：捕获 delegate 时刻的 pluginEnabled 快照。
    // 通知轮合成 envEvent 此前 pluginEnabled={} → ES 插件守卫拦截
    // （WecomTaskNotifyPlugin 不发卡，用户只见纯文本）。
    const pluginEnabledSnapshot = capturePluginEnabledSnapshot();

    const abortController = new AbortController();

    // ★ Task #2539 — processRegistries 上限保护。BL-4c 残留 PID 不会被自动清理，
    // 如果上层 spawn 逻辑出 bug 导致大量残留，最终 processRegistries 会无界增长。
    // 这里硬性限制 size：超过上限直接拒绝 createTask，避免 OOM。
    if (this.processRegistries.size >= this.maxProcessRegistries) {
      // 尝试一次兜底清理（清掉 size==0 的 entries；残留 PID 的不动）
      this.cleanupEmptyProcessRegistries();
      if (this.processRegistries.size >= this.maxProcessRegistries) {
        throw new Error(
          `BackgroundTaskManager.processRegistries 达到上限 ${this.maxProcessRegistries}（含残留 PID），拒绝创建新 task（taskId=${taskIdGen}）。请清理 / 重启 / 调高 maxProcessRegistries。`,
        );
      }
    }

    // ★ Per-task ProcessRegistry（2026-07 新增）
    // 每个 delegate_task 持有一个独立 registry；bash 等工具从 ALS 拿到该 registry
    // 并 register 自己 spawn 的 child.pid，timeout/stop 时遍历杀进程组。
    // 这样"孙进程泄漏"问题彻底解决（之前只能杀直接子进程）。
    const processRegistry = new ProcessRegistry();
    this.processRegistries.set(taskIdGen, processRegistry);

    const createdAt = Date.now();
    // Task #2590 follow-up — pre-allocate a runId for the sub-agent run so
    // it's available BEFORE the run actually starts. The id is namespaced
    // with the subagentType so AgentComponent's "must start with
    // `${agentName}:`" validation passes, and suffixed with the bgTaskId for
    // log/debug traceability.
    const taskRunId = `${subagentType}:bg_${taskIdGen}`;
    const task: BackgroundTask = {
      id: taskIdGen,
      runId: taskRunId,
      subSessionId: subSession.id,
      parentSessionId,
      description,
      subagentType,
      status: "pending",
      createdAt,
      lastUpdatedAt: createdAt,
      // ★ Task #4552 (A1)：与 started payload 用同一个表达式，保证一致
      timeoutMs: timeout || DEFAULT_TIMEOUT,
      abortController,
      similarTaskIds,
      // ★ Task #4042 ESPlugin v2 Phase 2：把 triggerEventId 存到 task 本身，
      // 后续所有 publishBackgroundEvent 都从 task.triggerEventId 读。
      triggerEventId,
      // ★ Task #4623：父 agent 的 model / fallbackModel 随 task 走，
      // 在 executeWithAbort 里作为 sub-agent 的 AgentContext 透传。
      model,
      fallbackModel,
      // ★ Task #4724：兜底模型**有序列表**同样随 task 走（顺序 = 优先级）。
      fallbackModels,
      // ★ Task #5217 fix 2：父 run 的 channel systemPrompt 随 task 走，
      // executeWithAbort 里作为 sub-agent 的 AgentContext.metadata.systemPrompt 透传。
      systemPrompt,
      // ★ Task #5333：渠道专用工具放行名单随 task 走，
      // executeWithAbort 里作为 sub-agent 的 AgentContext.extendTools 透传。
      extendTools,
      // ★ Task #4042 follow-up：replyChannel 快照（delegate 时刻捕获）。
      replyChannel: replyChannelSnapshot,
      // ★ Task #5265：pluginEnabled 快照（delegate 时刻捕获）。
      pluginEnabledSnapshot,
    };
    this.tasks.set(taskIdGen, task);
    this.abortControllers.set(taskIdGen, abortController);

    // Publish task.background.started event
    // ★ Task #4552 (A1)：带上 startedAt + timeoutMs，让下游纯 IM 提示能算
    //   「已跑多久」与「预计几点超时」。
    //
    //   为什么用 `createdAt` 而不是再取一次 Date.now()：同一个 task 的
    //   started / progress 两次通知必须给出**同一个**绝对超时时刻，否则
    //   用户会看到两个不同的「预计 xx:xx 超时」。createdAt 是本 task 的唯一
    //   时间锚点，executeTask 里的 startedAt 会略晚（多几毫秒），用在这里会
    //   让两条通知差出几毫秒 → 极少数情况下跨分钟边界会出现「17:23」vs
    //   「17:24」的跳变。
    const startedPayload: BackgroundTaskStartedPayload = {
      backgroundTaskId: taskIdGen,
      subSessionId: subSession.id,
      parentSessionId,
      description,
      subagentType,
      startedAt: createdAt,
      timeoutMs: timeout || DEFAULT_TIMEOUT,
    };
    this.publishBackgroundEvent(BackgroundTaskEventTypes.STARTED, startedPayload, parentSessionId, triggerEventId, replyChannelSnapshot, task.pluginEnabledSnapshot);

    // ★ CV BLOCKER-2 修复：**开始时**就发 session 生命周期事件。
    //
    // 旧实现只在「完成」分支发，且写死 lifecycle:"completed" —— 语义与事件名
    // 相反（叫 started 实为 finished），结果是：无 task 的 sub-agent 跑很久
    // 期间用户**看不到任何卡片**，等看到时已经结束，恰好废掉了「点刷新看活性」
    // 的用途。
    //
    // 现在：开始发 running，结束再发终态（同一 session 主键，卡片 patch 到同一张）。
    this.publishBackgroundEvent(
      BackgroundTaskEventTypes.SESSION_STARTED,
      {
        backgroundTaskId: taskIdGen,
        subSessionId: subSession.id,
        parentSessionId,
        description,
        subagentType,
        // 此刻还没建 task（sub-agent 尚未执行）⇒ 卡片走 session-only 形态
        associatedTaskId: undefined,
        lifecycle: "running" as const,
        startedAt: createdAt,
      },
      parentSessionId,
      triggerEventId,
      replyChannelSnapshot,
      task.pluginEnabledSnapshot,
    );

    // Start execution asynchronously
    this.executeTask(taskIdGen, prompt, timeout, parentSessionId).catch((err) => {
      logger.error(`[BackgroundTaskManager] executeTask unhandled rejection`, {
        taskId: taskIdGen,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return { taskId: taskIdGen, subSessionId: subSession.id };
  }

  /**
   * Task #3146 — sub-agent ask_user cascade（移除 resume function）
   *
   * 历史：原 `resumeFromAskUserAnswer()` 由 Task #3142 引入，用于用户答复后
   * 通过 BackgroundTaskManager 复用 sub-session 续传 sub-agent。
   *
   * 决定（用户指令）：**无需实现 resume function**——续传完全由 delegate_task
   * 自然完成。具体流程：
   *   1. BackgroundTaskManager.executeTask 在 catch 块识别 AskUserError 后，
   *      保留 sub-session 并发布 `task.background.ask_user` 事件。
   *   2. CLI 收到事件后直接显示问题给用户（不送 LLM）。
   *   3. 用户答复后，主 agent（或用户命令）通过 `delegate_task` 工具调用
   *      `subagent_type=original.subagentType, sub_session_id=original.subSessionId`
   *      即可复用 sub-session（保留 message history）继续推进 sub-agent。
   *
   * 因此本方法不再提供；续传是 delegate_task + sub_session_id 参数内建能力。
   */

  @TracedAs("task.background.executeTask", { recordParams: true, recordResult: true, log: true })
  private async executeTask(
    taskId: string,
    prompt: string,
    timeout?: number,
    parentSessionId?: string
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      logger.warn(`[BackgroundTaskManager] executeTask: Task not found`, { taskId });
      return;
    }

    const startedAt = Date.now();
    task.status = "running";
    task.startedAt = startedAt;
    task.lastUpdatedAt = startedAt;

    const timeoutMs = timeout || DEFAULT_TIMEOUT;
    const abortController = this.abortControllers.get(taskId);

    // Start progress reporter
    this.startProgressReporter(taskId, parentSessionId || task.parentSessionId);

    try {
      const sessionComponent = this.getSessionComponent();
      const subSession = await sessionComponent.get(task.subSessionId);
      if (!subSession) {
        throw new Error(`Sub session not found: ${task.subSessionId}`);
      }

      // Execute with timeout and abort support
      const taskRegistry = this.processRegistries.get(taskId);
      const result = await this.executeWithAbort(
        subSession,
        prompt,
        timeoutMs,
        taskId, // ★ Task #2144 — bgTaskId for ALS propagation
        abortController?.signal,
        task.similarTaskIds,
        taskRegistry,
        // Task #2590 follow-up — timeout path: only abort the task's own
        // signal. Legacy code called `agentComponent.abort(subagentType)`
        // which silently killed every concurrent same-type sub-agent.
        () => abortController?.abort(),
        // ★ 2026-10-16：把本次委派的 subagentType 显式透传，作为
        //   sub-session metadata 缺失时的 fallback（此前只能靠 meta，读错即静默降级）
        task.subagentType,
      );

      if (abortController?.signal.aborted) {
        logger.info(`[BackgroundTaskManager] Task was aborted`, { taskId });
        return;
      }

      const completedAt = Date.now();
      task.status = "completed";
      task.completedAt = completedAt;
      task.lastUpdatedAt = completedAt;
      task.result = result;

      const executionTimeMs = task.completedAt - task.startedAt!;
      // Capture the sub-agent's self-created task_id (if any).
      //
      // Priority (Task #5007 调整):
      //   1. sub-session → task 的确定性反查（sub-agent 的 task_create 用
      //      sessionId = sub-session id；task_operation 里有 create 记录）。
      //   2. ALS shared agentContext.currentTaskId — 兜底。
      //
      // ★ 为什么 sub-session 反查优先于 ALS：
      //   Task #5007 把 task_complete 从 roy sub-agent 移交到 default agent，
      //   sub-agent 不再通过 task_complete 调用 setCurrentTaskId(undefined)。
      //   于是 agentContext.currentTaskId 在父会话里**粘滞**：
      //   若上一个 sub-agent 留下 currentTaskId=42，而本次 sub-agent 没有
      //   创建任务（或建了别的任务），这里就会把后台任务错误地关联到 #42
      //   ⇒ notify 精确投递到错误的群 / 卡片更新到错误任务。
      //   改为先按 sub-session 反查（确定性、不会串任务），查不到再退回 ALS。
      //
      // ★ 不能用结果文本正则 `/Task\s+#?(\d+)/`：它会把报告正文里提到的任意
      //   "Task #N"（例如 #4076 的调研报告里引用了 "Task #627"）误当成本任务，
      //   导致 associatedTaskId 指向无关任务 → notify 精确投递解析到错误/空的群。
      task.associatedTaskId = await this.resolveAssociatedTaskIdBySubSession(
        task.subSessionId,
      );
      if (task.associatedTaskId === undefined) {
        task.associatedTaskId = getCurrentTaskId();
      }

      // ★ 澄清（22:37）：sub-session 的**生命周期**要能上卡片 ——
      //   无论它有没有建 task。
      //
      // 为什么发在这里（而不是 createTask 时）：`associatedTaskId` 要等
      // sub-agent 跑完、反查完才知道。此刻我们已经有确定答案：
      // - 有 task  → task 卡链路（task:after.* hook）已经覆盖，本事件多余
      // - 无 task  → **只有**本事件能告诉卡片层「有这个 session、它跑完了」
      //
      // payload 用 session 主键 + 终态，让 session 卡能显示「已完成」
      // 而不是永远停在「运行中」。
      this.publishBackgroundEvent(
        BackgroundTaskEventTypes.SESSION_STARTED,
        {
          backgroundTaskId: task.id,
          subSessionId: task.subSessionId,
          parentSessionId: parentSessionId || task.parentSessionId,
          description: task.description,
          subagentType: task.subagentType,
          associatedTaskId: task.associatedTaskId,
          lifecycle: "completed" as const,
          executionTimeMs,
        },
        parentSessionId || task.parentSessionId,
        task.triggerEventId,
        task.replyChannel,
        task.pluginEnabledSnapshot,
      );

      // Publish task.background.completed event
      const completedPayload: BackgroundTaskCompletedPayload = {
        backgroundTaskId: task.id,
        subSessionId: task.subSessionId,
        parentSessionId: parentSessionId || task.parentSessionId,
        status: "completed",
        result: task.result,
        description: task.description,
        executionTimeMs,
        associatedTaskId: task.associatedTaskId,
      };
      this.publishBackgroundEvent(BackgroundTaskEventTypes.COMPLETED, completedPayload, parentSessionId || task.parentSessionId, task.triggerEventId, task.replyChannel, task.pluginEnabledSnapshot);

      logger.info(`[BackgroundTaskManager] Task completed successfully`, {
        taskId,
        executionTimeMs,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Task #3xxx — sub-agent ask_user cascade
      // ★ 必须在 stopped/timeout/failed 三个分支之前检测 AskUserError：
      //   - stopped: errorMessage 可能含 "stopped" / "aborted"，但 AskUserError
      //     message 也包含 agent node 路径，可能误判；优先识别 ask_user 更安全
      //   - timeout: errorMessage 以 "Task execution timeout after" 开头，与 AskUserError
      //     message 完全不冲突，但顺序上 ask_user 也应优先
      //   - failed: 默认分支，会把 ask_user 误判为 failed，必须前置拦截
      const askUserInfo = BackgroundTaskManager.parseAskUserErrorFromMessage(error);

      const isStoppedError =
        errorMessage.toLowerCase().includes("stopped") ||
        errorMessage.toLowerCase().includes("aborted");

      const executionTimeMs = task.startedAt ? Date.now() - task.startedAt : 0;
      const completedAt = Date.now();
      task.completedAt = completedAt;
      task.lastUpdatedAt = completedAt;
      // Capture task_id：sub-session 确定性反查优先，ALS currentTaskId 兜底。
      // ★ Task #5007 — 与 completed 分支同理：sub-agent 不再调 task_complete，
      //   共享 agentContext.currentTaskId 不再被清空，可能粘滞到上一次委托的
      //   任务号 ⇒ 先按 sub-session 反查，避免串任务。
      task.associatedTaskId = await this.resolveAssociatedTaskIdBySubSession(
        task.subSessionId,
      );
      if (task.associatedTaskId === undefined) {
        task.associatedTaskId = getCurrentTaskId();
      }

      if (askUserInfo) {
        // Task #3147 — sub-agent 在执行过程中调用了 ask_user tool。
        // 不能当作 failed 处理（否则父 agent 收到的是错误事件，无法引导用户回答）。
        // 必须把 task 标记为 awaiting-user 状态，并发布 task.background.ask_user 事件，
        // 让 CLI EventHandler 走标准 notify 流程（跟 task.background.completed 一致）：
        //   1. EventMessageFormatter 渲染 payload（含 hints）成用户/agent 可读消息
        //   2. handleEventMessageWithEnv → executeInternal 把消息喂给主 agent LLM
        //   3. 主 agent 看到 question + subSessionId + hints 后，用 ask_user tool
        //      把问题展示给用户并等答复
        //   4. 拿到用户答复后，LLM 通过 delegate_task(subagentType=...,
        //      sub_session_id=payload.subSessionId, prompt=<用户答复>)
        //      复用 sub-session 让 sub-agent 继承之前消息历史继续推进。
        //
        // 设计要点：
        // - aborted / stopped 检查放后面：如果 sub-agent 调用 ask_user 时
        //   同时被 abort（用户主动取消），外层 abort 路径已经设了 task.status='stopped'
        //   不会到达这里（executeWithAbort 走 reject new Error('Task execution stopped')）
        // - hints 是 rule-based 提示数组，由 BackgroundTaskManager 在构造 ASK_USER
        //   事件时填充，CLI 端零特殊化（formatter 渲染，handler 走标准 notify）。
        task.status = "awaiting-user";
        task.error = askUserInfo.rawErrorMessage;
        // 暂存 query 用于诊断（不写到 result，避免与 ask_user 语义冲突）
        (task as any).pendingAskUserQuery = askUserInfo.query;

        const askUserPayload: BackgroundTaskAskUserPayload = {
          backgroundTaskId: task.id,
          subSessionId: task.subSessionId,
          parentSessionId: parentSessionId || task.parentSessionId,
          subagentType: task.subagentType,
          description: task.description,
          query: askUserInfo.query,
          sessionId: askUserInfo.sessionId,
          nodeId: askUserInfo.nodeId,
          nodeType: askUserInfo.nodeType,
          agentSessionId: askUserInfo.agentSessionId,
          // ★ Task #4983：透传「工具层是否已投递」⇒ CLI 层据此决定要不要兜底投
          delivered: askUserInfo.delivered === true,
          error: askUserInfo.rawErrorMessage,
          executionTimeMs,
          // Task #3147 — rule-based hints（事件自带）由 BackgroundTaskManager 填充，
          // CLI 端 formatter 只负责渲染，handler 零特殊化（跟其他 task.background.*
          // 事件走相同 notify → executeInternal 路径）。
          hints: [
            "请把上面的问题原样通过 ask_user tool 展示给用户并等待答复",
            `得到用户回复后，通过 delegate_task(subagent_type="${task.subagentType}", sub_session_id="${task.subSessionId}", prompt=<基于用户回复>) 复用 sub-session 让 sub-agent 继承之前消息历史继续推进，无需实现 resume function`,
          ],
          associatedTaskId: task.associatedTaskId,
        };
        this.publishBackgroundEvent(
          BackgroundTaskEventTypes.ASK_USER,
          askUserPayload,
          parentSessionId || task.parentSessionId,
          task.triggerEventId,
          task.replyChannel,
          task.pluginEnabledSnapshot,
        );

        logger.info(
          `[BackgroundTaskManager] Task awaiting user input (ask_user cascade)`,
          {
            taskId,
            subSessionId: task.subSessionId,
            nodeId: askUserInfo.nodeId,
            queryPreview: askUserInfo.query.substring(0, 80),
          },
        );

        // ★ 跳过 stopped / timeout / failed 三段 publish。
        // 通过 flag 控制 finally 块中 endSessionCleanup 不调用（保留 sub-session
        // 给 CLI 续传流程），finalizeTask 仍调用（task 状态终态化 = awaiting-user）。
        (task as any)._preserveSubSessionOnExit = true;
        return;
      }

      if (isStoppedError) {
        task.status = "stopped";
        // Publish task.background.stopped event
        const stoppedPayload: BackgroundTaskCompletedPayload = {
          backgroundTaskId: task.id,
          subSessionId: task.subSessionId,
          parentSessionId: parentSessionId || task.parentSessionId,
          status: "stopped",
          description: task.description,
          error: errorMessage,
          executionTimeMs,
          associatedTaskId: task.associatedTaskId,
        };
        this.publishBackgroundEvent(BackgroundTaskEventTypes.STOPPED, stoppedPayload, parentSessionId || task.parentSessionId, task.triggerEventId, task.replyChannel, task.pluginEnabledSnapshot);

      // ★ CV BLOCKER-2：session 层终态（无 task 的 session 也要能显示「stopped」）
      this.publishBackgroundEvent(
        BackgroundTaskEventTypes.SESSION_STARTED,
        {
          backgroundTaskId: task.id,
          subSessionId: task.subSessionId,
          parentSessionId: parentSessionId || task.parentSessionId,
          description: task.description,
          subagentType: task.subagentType,
          associatedTaskId: task.associatedTaskId,
          lifecycle: "stopped" as const,
          executionTimeMs,
        },
        parentSessionId || task.parentSessionId,
        task.triggerEventId,
        task.replyChannel,
        task.pluginEnabledSnapshot,
      );      } else if (errorMessage.startsWith("Task execution timeout after")) {
        task.status = "timeout";
        // Publish task.background.timeout event
        const timeoutPayload: BackgroundTaskCompletedPayload = {
          backgroundTaskId: task.id,
          subSessionId: task.subSessionId,
          parentSessionId: parentSessionId || task.parentSessionId,
          status: "timeout",
          description: task.description,
          error: errorMessage,
          executionTimeMs,
          associatedTaskId: task.associatedTaskId,
        };
        this.publishBackgroundEvent(BackgroundTaskEventTypes.TIMEOUT, timeoutPayload, parentSessionId || task.parentSessionId, task.triggerEventId, task.replyChannel, task.pluginEnabledSnapshot);

      // ★ CV BLOCKER-2：session 层终态（无 task 的 session 也要能显示「timeout」）
      this.publishBackgroundEvent(
        BackgroundTaskEventTypes.SESSION_STARTED,
        {
          backgroundTaskId: task.id,
          subSessionId: task.subSessionId,
          parentSessionId: parentSessionId || task.parentSessionId,
          description: task.description,
          subagentType: task.subagentType,
          associatedTaskId: task.associatedTaskId,
          lifecycle: "timeout" as const,
          executionTimeMs,
        },
        parentSessionId || task.parentSessionId,
        task.triggerEventId,
        task.replyChannel,
        task.pluginEnabledSnapshot,
      );      } else {
        task.status = "failed";
        // Publish task.background.failed event
        const failedPayload: BackgroundTaskCompletedPayload = {
          backgroundTaskId: task.id,
          subSessionId: task.subSessionId,
          parentSessionId: parentSessionId || task.parentSessionId,
          status: "failed",
          error: errorMessage,
          executionTimeMs,
          associatedTaskId: task.associatedTaskId,
        };
        this.publishBackgroundEvent(BackgroundTaskEventTypes.FAILED, failedPayload, parentSessionId || task.parentSessionId, task.triggerEventId, task.replyChannel, task.pluginEnabledSnapshot);

      // ★ CV BLOCKER-2：session 层终态（无 task 的 session 也要能显示「failed」）
      this.publishBackgroundEvent(
        BackgroundTaskEventTypes.SESSION_STARTED,
        {
          backgroundTaskId: task.id,
          subSessionId: task.subSessionId,
          parentSessionId: parentSessionId || task.parentSessionId,
          description: task.description,
          subagentType: task.subagentType,
          associatedTaskId: task.associatedTaskId,
          lifecycle: "failed" as const,
          executionTimeMs,
        },
        parentSessionId || task.parentSessionId,
        task.triggerEventId,
        task.replyChannel,
        task.pluginEnabledSnapshot,
      );      }
      task.error = errorMessage;

      logger.error(`[BackgroundTaskManager] Task execution error`, {
        taskId,
        status: task.status,
        error: errorMessage,
      });
    } finally {
      // Task #2539 — 终态联动释放 transient registry（success / error / cancel / timeout 共用此路径）。
      // finalizeTask 幂等，重复调用 no-op；stopTask 路径也会再调一次（双保险）。
      this.finalizeTask(taskId, task.status);

      // Task #2539 — 联动 MemorySessionStore 释放 sub session 内存占用。
      // SQLite store 不实现该方法（duck-type 跳过），Memory store 会按 checkpoint 对齐裁剪。
      //
      // Task #3xxx — 当 task 处于 awaiting-user 状态时（sub-agent 触发 ask_user cascade），
      // 必须保留 sub-session 给 CLI 续传流程（用户答复后通过 sub_session_id 参数复用）。
      // 此时跳过 endSessionCleanup，让 session 在 CLI 端 handleBackgroundTask()
      // 复用并跑完后续 sub-agent 步骤后再清理。
      const preserveSubSession = (task as any)?._preserveSubSessionOnExit === true;
      const sessionComp = this.getSessionComponent() as any;
      if (!preserveSubSession && sessionComp?.endSessionCleanup && task?.subSessionId) {
        try {
          await sessionComp.endSessionCleanup(task.subSessionId);
        } catch (err) {
          logger.warn(
            `[BackgroundTaskManager] endSessionCleanup failed for ${task.subSessionId}`,
            { error: err instanceof Error ? err.message : String(err) },
          );
        }
      } else if (preserveSubSession) {
        logger.info(
          `[BackgroundTaskManager] Preserve sub session for ask_user resume: ${task.subSessionId}`,
        );
      }
    }
  }

  /**
   * Start progress reporter for a task
   */
  @TracedAs("task.background.startProgressReporter", { recordParams: false, recordResult: true, log: true })
  private startProgressReporter(taskId: string, parentSessionId: string): void {
    const timer = setInterval(() => {
      const task = this.tasks.get(taskId);
      if (!task || task.status !== "running") {
        this.stopProgressReporter(taskId);
        return;
      }

      // 注意：不再基于耗时计算虚假进度百分比。
      // 后台任务的真实进度由子代理通过 task_get / task_list 等工具主动查询，
      // 进度通知只确认"任务还在进行中"即可，避免 LLM 误判 "95% = 快结束"。
      // task.progress 字段保留（向后兼容 BackgroundTaskProgressPayload.progress?），
      // 但这里不再赋值。

      // Dynamically capture task_id from sub-agent via shared agentContext reference.
      // The sub-agent may have called task_create (which calls setCurrentTaskId())
      // after the progress reporter started, so we need to check every interval.
      //
      // ★ Task #5007 — 仅在**尚未关联**任务时才从共享 ALS 取值。
      //   原因：roy 不再调 task_complete（验收权移交 default agent），
      //   agentContext.currentTaskId 不再被清空，可能在父会话里粘滞。
      //   若不判空就覆盖，就会把已正确关联的任务号刷成上一个委托的旧号。
      const currentTaskId = getCurrentTaskId();
      if (currentTaskId !== undefined && task.associatedTaskId === undefined) {
        task.associatedTaskId = currentTaskId;
      }

      task.lastUpdatedAt = Date.now();

      // Publish progress event
      const progressPayload: BackgroundTaskProgressPayload = {
        backgroundTaskId: taskId,
        subSessionId: task.subSessionId,
        parentSessionId,
        description: task.description,
        status: task.status,
        // progress 字段可选，向后兼容：故意省略，不再渲染虚假百分比
        associatedTaskId: task.associatedTaskId,
        // ★ Task #4552 (A1)：超时可见性。
        //
        // 用 task.createdAt（不是 task.startedAt）：与 started 通知保持**同一个**
        // 时间锚点，保证两条通知算出的「预计 xx:xx 超时」完全一致。
        // startedAt 缺失时（理论不可能，防御）退到 createdAt。
        startedAt: task.createdAt,
        timeoutMs: task.timeoutMs,
      };
      this.publishBackgroundEvent(BackgroundTaskEventTypes.PROGRESS, progressPayload, parentSessionId, task.triggerEventId, task.replyChannel, task.pluginEnabledSnapshot);
    }, PROGRESS_INTERVAL);

    this.progressTimers.set(taskId, timer);
  }

  /**
   * Stop progress reporter for a task
   */
  @TracedAs("task.background.stopProgressReporter", { recordParams: false, recordResult: true, log: true })
  private stopProgressReporter(taskId: string): void {
    const timer = this.progressTimers.get(taskId);
    if (timer) {
      clearInterval(timer);
      this.progressTimers.delete(taskId);
    }
  }

  // result 是子 agent 的完整最终输出（可能很长）→ 不入库
  @TracedAs("delegate.executeWithAbort", { recordParams: true, recordResult: false, log: true })
  private async executeWithAbort(
    /**
     * ★ 2026-10-16：原为 `any` —— 正是它让 `subSession.info?.metadata` 这类
     * 错误假设逃过 `strict: true` 的类型检查（Session 是扁平对象，没有 `.info`）。
     * 收窄为 `Session` 后，同样的笔误会直接 TS2339 报错。
     */
    subSession: Session,
    prompt: string,
    timeoutMs: number,
    /**
     * Task #2144 — bgTaskId 透传用于 ALS 包装，让 sub-session 内的 workflow_run
     * 工具通过 getCurrentBgTaskId() 拿到对应 bgTaskId 并 attach runId。
     * 与内部 `taskId = metadata.task_id`（Task #）互不冲突。
     */
    bgTaskId: string,
    signal?: AbortSignal,
    similarTaskIds?: number[],
    processRegistry?: ProcessRegistry,
    /**
     * Task #2590 follow-up — invoked on timeout to abort the task's own
     * AbortController. Replaces the legacy `agentComponent.abort(subagentType)`
     * which targeted every concurrent same-type sub-agent (silent-fail).
     */
    abortTask?: () => void,
    /**
     * ★ 2026-10-16：本次 delegate 调用传入的 subagentType（来自 task.subagentType）。
     * 仅作 **fallback**：优先信任 sub-session metadata（resume/重入时 meta 才是真源），
     * meta 缺失时才用它，最后才回退 "general"（并打 WARN，不再静默降级）。
     */
    explicitSubagentType?: string
  ): Promise<string> {
    // ★ 2026-10-16 修复：Session 是**扁平对象**（无 `.info` 包装层）。
    //   原代码读 `subSession.info?.metadata` → 恒 undefined → metadata 恒 {}
    //   → subagent_type 恒回退 "general" → 所有 delegate_task 委托的 sub-agent
    //   都以 general 身份运行（专用 prompt / allowedTools 白名单全部失效）。
    //   trace 实证：delegate.executeWithAbort 的 subSession.metadata 里本来就有
    //   subagent_type="workflow-creator"，只是读错了路径。
    const metadata = subSession?.metadata ?? {};
    const taskId = metadata.task_id as number | undefined;
    const taskDescription = (metadata.task_description as string) || "";
    const sessionId = subSession.id;
    // 解析优先级（用户明确指定）：
    //   1) sub-session metadata 里的 subagent_type —— resume/重入时的唯一真源
    //   2) 本次 delegate 调用传入的 subagentType —— meta 缺失时兜底
    //   3) "general" —— 最后一档，且**不再静默**，打 WARN 便于事后定位
    const metaSubagentType = metadata.subagent_type as string | undefined;
    const subagentType =
      metaSubagentType || explicitSubagentType || "general";
    if (!metaSubagentType && !explicitSubagentType) {
      logger.warn(
        `[delegate] subagent_type unresolved (no session metadata, no explicit value) — falling back to "general". sessionId=${sessionId}`
      );
    }

    const agentComponent = this.env?.getComponent?.("agent") as AgentComponent | undefined;
    const registry = agentComponent?.getRegistry?.() as AgentRegistry | undefined;
    const resolved = await resolveSubAgentConfig(subagentType, { registry });
    const subAgent = getSubAgentSpec(subagentType);
    const basePrompt =
      resolved?.basePrompt ||
      subAgent?.promptOverride ||
      `You are a subagent. Complete this task: {task_description}`;
    const deniedTools = resolved?.deniedTools || subAgent?.deniedTools || [];
    const allowedTools = resolved?.allowedTools || subAgent?.allowedTools;

    // ★ Task #5179（v2，运行时构建）— user 消息永不嵌 basePrompt
    //
    // 用户明令（2026-11-08 13:55）：像 default 智能体一样——调用 LLM
    // 时再构建 system prompt。落库的 user 消息只含任务指令。
    //
    // 身份设定走运行时注入：ensureSubAgentRegistered 已把 basePrompt
    // 注册为 agent 的 systemPrompt，AgentComponent.buildMessages 每次
    // run 单独构建 system role 消息（不落库）；recordSessionMessages
    // 明确跳过 system 消息 ⇒ prompt 副本不会出现在 sessions.db。
    //
    // 注：{task_description} 占位符（来自 basePrompt 模板）在此无宿主，
    // 任务描述通过下方 Session Info 的 task_description 行提供。
    let fullPrompt = `# Session Info
- task_id: ${taskId || "N/A"}
- session_id: ${sessionId}
- task_description: ${taskDescription || "N/A"}

---

## 用户指令
${prompt}

---

## 执行规范
- 使用可用工具完成任务
- 返回清晰的任务执行结果摘要
- 适时调用 task_operation_create 记录进展
- 如果你通过 task_create 创建了任务，请在最终响应中明确报告 task_id（例如：Task #627）`;

    // Inject similar tasks reference into prompt if similarTaskIds provided
    if (similarTaskIds && similarTaskIds.length > 0) {
      try {
        const taskComponent = this.env?.getComponent?.("task") as (Pick<TaskComponent, "getTask" | "listOperations">) | undefined;
        if (taskComponent) {
          const similarTasksSections: string[] = [];

          for (const similarId of similarTaskIds) {
            try {
              const similarTask = await taskComponent.getTask(similarId);
              if (!similarTask) {
                logger.warn(`[delegate] Similar task #${similarId} not found, skipping`);
                continue;
              }

              // Fetch recent operations for the similar task
              const operations = await taskComponent.listOperations({ taskId: similarId, limit: 10 });

              let section = `### Task #${similarTask.id}: ${similarTask.title}\n`;
              section += `- Status: ${similarTask.status}\n`;
              if (similarTask.description) {
                section += `- Description: ${similarTask.description}\n`;
              }
              if (similarTask.goals_and_expected_deliverables) {
                section += `- Goals: ${similarTask.goals_and_expected_deliverables}\n`;
              }
              if (operations && operations.length > 0) {
                section += `- Recent Operations:\n`;
                for (const op of operations) {
                  section += `  - [${op.actionType}] ${op.actionTitle}: ${op.actionDescription || ""}\n`;
                }
              }

              similarTasksSections.push(section);
            } catch (err) {
              logger.warn(`[delegate] Failed to fetch similar task #${similarId}`, { error: err instanceof Error ? err.message : String(err) });
            }
          }

          if (similarTasksSections.length > 0) {
            fullPrompt += `\n\n---\n\n## Similar Tasks Reference\n\nThe following similar tasks and their operation records can serve as reference:\n\n`;
            fullPrompt += similarTasksSections.join(`\n`);
            fullPrompt += `\n\n---\n\nUse these as guidance to improve task execution efficiency.`;
          }
        }
      } catch (err) {
        logger.warn(`[delegate] Failed to inject similar tasks reference`, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (!agentComponent) {
      throw new Error("AgentComponent not found");
    }

    // Inject TaskCreationRegistry "reuse candidate" section (Task #2389).
    // Auto-surfaces recently-created tasks so sub-agents can prefer
    // task_get/task_update over creating duplicate Task entries. Dedupes
    // against similarTaskIds (the IDs already inlined above) and produces
    // no section when there are no candidates.
    try {
      if (this.env) {
        const reuseRegistry = getOrCreateTaskReuseRegistry(this.env);
        const reuseSection = buildReuseCandidateSection({
          registry: reuseRegistry,
          similarTaskIds: similarTaskIds ?? [],
          limit: 5,
          maxChars: 2000,
          maxDescriptionChars: 240,
        });
        if (!reuseSection.isEmpty) {
          fullPrompt += `\n\n---\n\n${reuseSection.markdown}`;
        }
      }
    } catch (err) {
      logger.warn(`[delegate] Failed to inject reuse candidate section`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // ★ Task #5423 — 渠道特性提示注入。
    //
    // 为什么需要：sub-agent 只拿到自己的 basePrompt（ensureSubAgentRegistered），
    // 拿不到主 agent 的渠道 systemPrompt。于是飞书渠道触发的文档类任务，
    // sub-agent 把产出落成 `/tmp/xxx.md`，飞书用户根本打不开。
    //
    // 渠道来源优先级：
    //   1. sub-session metadata.channelType（createTask 时快照，resume 也可靠）
    //   2. 当前 EnvContext.replyChannel.type（ALS 兜底）
    // 无渠道（CLI / REPL / timer / 未知）→ buildDelegateChannelHint 返回 undefined → 不注入。
    const channelTypeHint =
      (metadata.channelType as string | undefined) ??
      getEnvContext()?.replyChannel?.type;
    const channelHint = buildDelegateChannelHint(channelTypeHint);
    if (channelHint) {
      fullPrompt += `\n\n---\n\n${channelHint}`;
    }

    const subAgentForRegister: SubAgentSpec | undefined = subAgent
      ? { ...subAgent, allowedTools }
      : allowedTools
        ? {
            id: subagentType,
            name: subagentType,
            mode: "subagent",
            description: resolved?.description || "Custom agent",
            allowedTools,
            deniedTools,
          }
        : undefined;

    ensureSubAgentRegistered(
      agentComponent,
      subagentType,
      basePrompt,
      subAgentForRegister,
      deniedTools
    );

    // ★ P1: Workflow 类型 subagent — 传原始 prompt 而非包装后的 fullPrompt
    const isWorkflowAgent = registry?.get(subagentType)?.type === "workflow";
    const delegateQuery = isWorkflowAgent ? prompt : fullPrompt;

    return new Promise((resolve, reject) => {
      // ★ 关键：杀进程组的入口（2026-07 新增）
      // 必须先 kill 进程树再 reject，确保资源清理在 Promise 结算前完成。
      const killProcessTreeSafely = async (): Promise<void> => {
        try {
          await processRegistry?.killAll();
        } catch (err) {
          logger.warn(`[delegate] ProcessRegistry.killAll failed`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      };

      // Task #2590 follow-up — `settled` guard + listener cleanup.
      // The previous implementation:
      //   1. Registered an `abort` listener that called
      //      `agentComponent.abort(subagentType)` (agent-name-scoped,
      //      cross-run kill) and rejected.
      //   2. Never removed the listener.
      //   3. Never `settled`-guarded the abort handler.
      // Combined with `finalizeTask` calling `abortController.abort()` in
      // its finally block, a sub-agent that completed normally would
      // re-trigger the listener on finalize, killing every concurrent
      // same-type sub-agent → silent-fail (status=completed, result="").

      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      // capturedRunId is set by handle_query via the `runId` AgentContext
      // field. AgentComponent._run uses it as the runId, so the
      // BackgroundTaskManager owns the canonical identifier and can
      // call `agentComponent.abortRun(runId)` instead of the legacy
      // agent-name-scoped abort.
      let capturedRunId: string | undefined;
      const task = this.tasks.get(bgTaskId);
      if (task?.runId) {
        capturedRunId = task.runId;
      }

      const detachAbortListener = (): void => {
        if (signal && onAbort) {
          try {
            signal.removeEventListener("abort", onAbort);
          } catch {
            // ignore
          }
        }
      };

      let onAbort: (() => void) | undefined;
      onAbort = (): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        detachAbortListener();
        // Task #2590 follow-up — run-scoped abort (or no-op if runId unknown).
        // This is the second leg of the cross-run fix: even if the listener
        // somehow fires after settle, abortRun(runId) targets only this
        // task's own run, never a peer.
        try {
          const agentComp = this.env?.getComponent?.("agent") as
            | { abortRun?: (runId: string, reason?: string) => boolean }
            | undefined;
          if (agentComp?.abortRun && capturedRunId) {
            agentComp.abortRun(capturedRunId, "task_signal_abort");
          }
        } catch {
          // Best-effort
        }
        // kill process tree before rejecting
        killProcessTreeSafely()
          .catch(() => {})
          .then(() => {
            reject(new Error("Task execution stopped"));
          });
      };

      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        detachAbortListener();
        // Task #2590 follow-up — timeout path: abort the task's own
        // signal first (signal main path), then run-scoped abortRun as
        // a fallback if signal propagation didn't reach the LLM/tool.
        try {
          abortTask?.();
        } catch {
          // ignore
        }
        try {
          const agentComp = this.env?.getComponent?.("agent") as
            | { abortRun?: (runId: string, reason?: string) => boolean }
            | undefined;
          if (agentComp?.abortRun && capturedRunId) {
            agentComp.abortRun(capturedRunId, "task_timeout");
          }
        } catch {
          // Best-effort
        }
        killProcessTreeSafely()
          .catch(() => {})
          .then(() => {
            reject(new Error(`Task execution timeout after ${timeoutMs}ms`));
          });
      }, timeoutMs);

      if (signal) {
        signal.addEventListener("abort", onAbort);
      }

      // 包裹 handle_query 在 ProcessRegistry 的 ALS 作用域内。
      // 这样 bash 等工具可以从 ALS 拿到当前 registry 并 register 自己 spawn 的 child.pid。
      const invokeHandleQuery = () => {
        // Task #4623 — 把父 agent 的 model / fallbackModel 继承给 sub-agent。
        // 走 AgentContext（per-run）而不是注册配置：注册是「已存在则跳过」，
        // 写注册期 model 会导致第二次 delegate 仍沿用旧模型。
        // review P2-5：用作用域内的 `task`，不再回头查 this.tasks ——
        // finalizeTask（stop/timeout 竞态）会把 task 移出 tasks 表，
        // 那时 this.tasks.get(...) 返回 undefined，model 继承会静默丢失。
        const inheritedModel = task?.model;
        const inheritedFallbackModel = task?.fallbackModel;
        const inheritedFallbackModels = task?.fallbackModels;
        return this.env.handle_query?.(delegateQuery, {
          sessionId,
          deniedTools: deniedTools.length > 0 ? deniedTools : undefined,
          agentType: subagentType,
          abort: signal as AbortSignal,
          // Task #2590 follow-up — caller-provided runId so the
          // BackgroundTaskManager owns the identifier before the run starts.
          runId: capturedRunId,
          ...(inheritedModel ? { model: inheritedModel } : {}),
          ...(inheritedFallbackModel ? { fallbackModel: inheritedFallbackModel } : {}),
          // ★ Task #4724：兜底模型有序列表继承给 sub-agent（顺序 = 优先级）。
          // ★ Task #4724 review3 MINOR：显式禁用兜底时传**空数组**标记，
          //   让子 agent 也禁用（而不是回落 config）。
          //   判据：父 agent 显式给了列表（哪怕是空的）→ 显式决定一切。
          ...(Array.isArray(inheritedFallbackModels)
            ? { fallbackModels: inheritedFallbackModels }
            : {}),
          // ★ Task #5217 fix 2 — 把父 run 的 channel systemPrompt
          // （context.metadata.systemPrompt，如 lean lark 渠道 prompt）
          // 透传给 sub-agent：AgentComponent._run 读
          // context?.metadata?.systemPrompt 并追加到 sub-agent 的
          // LLM system message。修复前 sub-agent 路径拿不到 channel
          // prompt（Task #5210 排查的第三条断链）。
          ...(task?.systemPrompt
            ? { metadata: { systemPrompt: task.systemPrompt } }
            : {}),
          // ★ Task #5333 — 渠道专用工具放行名单继承给 sub-agent。
          //   否则企微事件委派出去的子任务里 wecom_respond（channelOnly）
          //   不可见，子 agent 无法给企微用户回复。
          ...(task?.extendTools?.length
            ? { extendTools: task.extendTools }
            : {}),
        });
      };

      const wrappedPromise = processRegistry
        ? runWithProcessRegistryAsync(processRegistry, () =>
            runWithBgTaskIdAsync(bgTaskId, () => invokeHandleQuery())
          )
        : runWithBgTaskIdAsync(bgTaskId, () => invokeHandleQuery());

      wrappedPromise
        ?.then((result: string) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          // Task #2590 follow-up — detach the abort listener so a
          // post-completion `finalizeTask → abortController.abort()`
          // cannot re-trigger it and accidentally call
          // `agentComp.abortRun` on a peer run.
          detachAbortListener();
          resolve(result);
        })
        .catch((error: Error) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          detachAbortListener();
          reject(error);
        });
    });
  }

  async stopTask(
    taskId: string,
  ): Promise<{
    success: boolean;
    task?: BackgroundTask;
    message: string;
    /**
     * Task #2190 — workflow runId list that was attached at stop time.
     * Main session can audit which workflow_runs were stopped as a
     * cascade of this stop_task. Always an array (empty if none).
     */
    attached_workflow_run_ids?: string[];
    /**
     * Task #2190 — per-id stop outcomes from `propagateStopToWorkflowRuns`.
     * 1:1 with `attached_workflow_run_ids` when both arrays have entries.
     * Each entry: `{ runId, success, error? }`.
     */
    workflow_stop_results?: Array<{
      runId: string;
      success: boolean;
      error?: string;
    }>;
  }> {
    // Task #2539 — 优先查 active tasks，再 fallback 到 terminalTasks（已完成 task 的 stopTask
    // 应返回「不能 stop」语义而不是「not found」，保留旧 API 行为）。
    const task = this.tasks.get(taskId) ?? this.terminalTasks.get(taskId);
    if (!task) {
      return { success: false, message: "Task not found" };
    }

    // terminalTasks 中的 task 永远处于终态，不能 stop
    if (this.terminalTasks.has(taskId)) {
      return {
        success: false,
        task,
        message: `Cannot stop task with status: ${task.status}`,
      };
    }

    if (task.status === "completed" || task.status === "failed" || task.status === "stopped" || task.status === "timeout") {
      return {
        success: false,
        task,
        message: `Cannot stop task with status: ${task.status}`,
      };
    }

    const completedAt = Date.now();
    task.status = "stopped";
    // Task #2590 follow-up — abort this task's own signal first; the
    // signal main path propagates through effectiveContext.abort in the
    // sub-agent's ReAct loop. Then issue a run-scoped abortRun for the
    // specific sub-agent runId as a fallback (legacy code path used
    // `agentComponent.abort(subagentType)` here which cross-killed peer
    // same-type sub-agents).
    task.abortController?.abort();
    if (task.runId) {
      try {
        const agentComp = this.env?.getComponent?.("agent") as
          | { abortRun?: (runId: string, reason?: string) => boolean }
          | undefined;
        agentComp?.abortRun?.(task.runId, "stop_task");
      } catch (err) {
        logger.warn(`[BackgroundTaskManager] abortRun failed during stopTask`, {
          taskId,
          runId: task.runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    task.completedAt = completedAt;
    task.lastUpdatedAt = completedAt;

    // ★ 杀掉该 task 派生的所有子进程（含孙进程），防止端口/句柄泄漏
    try {
      await this.processRegistries.get(taskId)?.killAll();
    } catch (err) {
      logger.warn(`[delegate] stopTask killAll failed`, {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // ★ Task #2144 — propagate stop to all workflow runs attached to this bgTask.
    // 必须在 publishBackgroundEvent STOPPED 之前调，确保主 session 在事件流里看到
    // "workflow 已被 stop"（而不是"sub-session 已 stop 但 workflow 还在跑"）。
    //
    // Task #2190 — capture the returned runIds + stopResults so the payload
    // and the function's return value both expose them.
    const { runIds, stopResults } = await this.propagateStopToWorkflowRuns(
      taskId,
      "Task stopped by user",
    );

    // Publish task.background.stopped event
    const stoppedPayload: BackgroundTaskCompletedPayload = {
      backgroundTaskId: task.id,
      subSessionId: task.subSessionId,
      parentSessionId: task.parentSessionId,
      status: "stopped",
      description: task.description,
      error: "Task stopped by user",
      executionTimeMs: task.startedAt ? task.completedAt - task.startedAt : 0,
      associatedTaskId: task.associatedTaskId,
    };
    this.publishBackgroundEvent(BackgroundTaskEventTypes.STOPPED, stoppedPayload, task.parentSessionId, task.triggerEventId, task.replyChannel, task.pluginEnabledSnapshot);

    // Task #2539 — cancel 终态触发后立即联动释放 transient registry。
    // 注意：executeTask 的 catch + finally 也会再调一次 finalizeTask（双保险，幂等）。
    // 这里是 stopTask 的「同步终态释放」：让 stopTask 返回后立即可观察 registry 已清理。
    this.finalizeTask(taskId, "stopped");

    return {
      success: true,
      task,
      message: "Task has been stopped",
      attached_workflow_run_ids: runIds,
      workflow_stop_results: stopResults,
    };
  }

  getTask(taskId: string): BackgroundTask | undefined {
    // Task #2539 — 优先查 active tasks，fallback 到 terminalTasks（最近完成的任务可查询）
    return this.tasks.get(taskId) ?? this.terminalTasks.get(taskId);
  }

  /**
   * ★ Task #4720 — 读取 sub-session 的实时活动（liveness 信号）。
   *
   * 背景：query_background_process 之前只能看到 BackgroundTask 自身的
   * lastUpdatedAt，而它由 20 分钟一次的心跳（PROGRESS_INTERVAL）刷新。
   * 于是「sub-agent 正在疯狂跑工具」和「sub-agent 卡死」在观察者眼里
   * 完全一样（lastUpdatedAt 停在创建时刻）。
   *
   * 现在 agent-component 已改为**每轮 ReAct 增量落盘**（Task #4720 Fix A），
   * sub-session 的 updatedAt 会随每一轮迭代推进，messageCount 也在增长。
   * 读取这两个值即可给出真实的活跃度：
   *   - messageCount 持续增长 → sub-agent 确实在产出
   *   - updatedAt 停滞     → sub-agent 真的卡住了
   *
   * 返回 undefined 表示「拿不到活动信息」（无 session 组件 / session 不存在），
   * 调用方应退化为旧行为而不是报错。
   */
  async getSubSessionActivity(
    bgProcessId: string,
  ): Promise<{ messageCount: number; updatedAt: number } | undefined> {
    // Note: the key into `tasks` is the bgProcessId (e.g. process_<ts>_<rand>),
    // NOT the session id — see BackgroundTask.id.
    const task = this.getTask(bgProcessId);
    if (!task) return undefined;

    const sessionComponent = this.getSessionComponent();
    if (!sessionComponent?.get) return undefined;

    try {
      const session = await sessionComponent.get(task.subSessionId);
      if (!session) return undefined;
      return {
        messageCount: session.messageCount ?? 0,
        updatedAt: session.updatedAt ?? task.lastUpdatedAt ?? task.createdAt,
      };
    } catch {
      // session store 不可用（DB 锁 / 组件未初始化）→ 退化为旧行为
      return undefined;
    }
  }

  listTasks(): BackgroundTask[] {
    // Task #2539 — active + terminal tasks 都返回，便于 CLI / query_background_process 列出全部
    return Array.from(this.tasks.values()).concat(Array.from(this.terminalTasks.values()));
  }

  /**
   * Task #2255 — ESC idle-with-active-descendant fix.
   *
   * Returns true if there is at least one background task whose
   * `parentSessionId` matches the given parent AND whose status is
   * `pending` or `running`. Used by REPL.handleEscKey() to decide
   * whether to cascade-stop the session tree even when the main LLM
   * is idle (isExecuting=false).
   *
   * Cheap: O(N) over the in-memory tasks Map (typically <10 active
   * per session). Not persisted to DB — runs from in-memory state only.
   */
  hasActiveTaskForParent(parentSessionId: string): boolean {
    if (!parentSessionId) return false;
    for (const task of this.tasks.values()) {
      if (
        task.parentSessionId === parentSessionId &&
        (task.status === "pending" || task.status === "running")
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Task #2245 — ESC cascade stop.
   *
   * Stop all BackgroundTask instances whose `parentSessionId` matches the given
   * parent, regardless of which sub-agent type created them. Calls the existing
   * `stopTask(taskId)` per entry, which already propagates to attached workflow
   * runs (Task #2144). Returns `{ stoppedTaskIds }` so callers (e.g. REPL ESC
   * handler / `cascadeStopSessionTree`) can audit cascade coverage.
   *
   * Only acts on `pending` / `running` tasks; `completed` / `failed` / `stopped`
   * / `timeout` are skipped (idempotent).
   *
   * Iron rule: does NOT mutate `parentSessionId` or any background-task identity.
   * No effect on tasks whose parent does not match.
   */
  @TracedAs("task.background.stopAllForParent", {
    recordParams: true,
    recordResult: true,
    log: true,
  })
  async stopAllForParent(
    parentSessionId: string,
  ): Promise<{ stoppedTaskIds: string[] }> {
    if (!parentSessionId) {
      return { stoppedTaskIds: [] };
    }
    const stoppedTaskIds: string[] = [];
    for (const [taskId, task] of this.tasks) {
      if (
        task.parentSessionId === parentSessionId &&
        (task.status === "running" || task.status === "pending")
      ) {
        try {
          const res = await this.stopTask(taskId);
          if (res?.success) {
            stoppedTaskIds.push(taskId);
          }
        } catch (err) {
          logger.warn(
            `[BackgroundTaskManager] stopAllForParent failed for ${taskId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
    return { stoppedTaskIds };
  }

  /**
   * Task #2245 — ESC force-stop (second-press within 2s window).
   *
   * Traverse ALL BackgroundTask entries (regardless of parent), kill their
   * process trees via ProcessRegistry, and mark them `stopped`. Used as the
   * force path when `stopAllForParent` (graceful) leaves residual orphans.
   *
   * Task #2245 — BL-4: iterates ALL tasks (not just running/pending) so that
   * tasks already marked `stopped` by graceful `stopTask()` but with leaked
   * PIDs can still be retried. Combined with `ProcessRegistry.killAll()`
   * retaining `stillAlive` PIDs, this enables second-ESC force retry.
   *
   * Task #2245 — P1-#1: also calls `propagateStopToWorkflowRuns` for each task
   * so that attached workflow runs are cascaded into the engine's stop
   * (the original cascade gap — only `dispose()` did this previously).
   *
   * Task #2245 — P1-#2: publishes `task.background.stopped` event for each
   * task that is freshly marked `stopped` by this force pass, so the parent
   * session and CLI UI see the stop signal (previously force path was silent).
   *
   * Task #2245 — P1-#8: renamed to `forceStopAllAcrossParents` to clarify
   * that this iterates ALL tasks (regardless of parent), unlike
   * `stopAllForParent(parentId)` which is parent-scoped. `forceStopAll` is
   * kept as a deprecated alias for backward compatibility.
   */
  @TracedAs("task.background.forceStopAllAcrossParents", {
    recordParams: false,
    recordResult: true,
    log: true,
  })
  async forceStopAllAcrossParents(): Promise<void> {
    // Task #2539 — 合并 tasks Map (active) + terminalTasks (recent terminal) + processRegistries
    // (残留 PID)。BL-4c 要求 force path 对「已 terminal 但 processRegistry 仍有残留 PID」的 task
    // 也调 killAll；这类 task 在 tasks Map 中可能不存在（已被 finalizeTask 移到 terminalTasks），
    // 但在 terminalTasks / processRegistries 中仍能找到。
    const seen = new Set<string>();
    const allTaskIds = new Set<string>([
      ...this.tasks.keys(),
      ...this.terminalTasks.keys(),
      ...this.processRegistries.keys(),
    ]);
    for (const taskId of allTaskIds) {
      if (seen.has(taskId)) continue;
      seen.add(taskId);
      const task = this.tasks.get(taskId) ?? this.terminalTasks.get(taskId);
      // task 可能为 undefined（processRegistries 残留但 tasks/terminalTasks 都没了）。
      // 这种情况下只能 retry killAll，不再 publish event 或更新 status。
      const taskSafe = task;

      // Task #2245 — BL-4: iterate ALL tasks (including stopped) so that
      // graceful-failed tasks with leaked PIDs get a second chance.
      try {
        await this.processRegistries.get(taskId)?.killAll();
      } catch (err) {
        logger.warn(
          `[BackgroundTaskManager] forceStopAllAcrossParents killAll failed for ${taskId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      // Task #2245 — P1-#1: cascade stop to attached workflow runs.
      // Wrap in try/catch so a single workflowService failure doesn't break
      // the rest of the force loop (P1-#5: capture and continue).
      try {
        await this.propagateStopToWorkflowRuns(taskId, "force stop all");
      } catch (err) {
        logger.warn(
          `[BackgroundTaskManager] forceStopAllAcrossParents propagateStopToWorkflowRuns failed for ${taskId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      // Skip status mutation for already-terminal tasks; only mark still-active
      // tasks as stopped (graceful may have already done this).
      let justMarkedStopped = false;
      if (taskSafe && (taskSafe.status === "running" || taskSafe.status === "pending")) {
        try {
          taskSafe.status = "stopped";
          taskSafe.completedAt = Date.now();
          taskSafe.lastUpdatedAt = taskSafe.completedAt;
          taskSafe.abortController?.abort();
          justMarkedStopped = true;
        } catch (err) {
          logger.warn(
            `[BackgroundTaskManager] forceStopAllAcrossParents mark stopped failed for ${taskId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      // Task #2245 — P1-#2: publish STOPPED event only for tasks we just
      // marked stopped (avoid duplicate events for already-terminal tasks
      // that may have been published by graceful stopTask previously).
      if (justMarkedStopped && taskSafe) {
        const stoppedPayload: BackgroundTaskCompletedPayload = {
          backgroundTaskId: taskSafe.id,
          subSessionId: taskSafe.subSessionId,
          parentSessionId: taskSafe.parentSessionId,
          status: "stopped",
          description: taskSafe.description,
          error: "force stop all",
          executionTimeMs: taskSafe.startedAt && taskSafe.completedAt ? taskSafe.completedAt - taskSafe.startedAt : 0,
          associatedTaskId: taskSafe.associatedTaskId,
        };
        this.publishBackgroundEvent(
          BackgroundTaskEventTypes.STOPPED,
          stoppedPayload,
          taskSafe.parentSessionId,
          taskSafe.triggerEventId,
          taskSafe.replyChannel,
          taskSafe.pluginEnabledSnapshot,
        );
      }
    }
  }

  /**
   * Task #2245 — P1-#8: deprecated alias for `forceStopAllAcrossParents`.
   * Kept for backward compatibility with code that still calls `forceStopAll`.
   * New code should call `forceStopAllAcrossParents` directly.
   * @deprecated use forceStopAllAcrossParents
   */
  async forceStopAll(): Promise<void> {
    return this.forceStopAllAcrossParents();
  }

  /**
   * Dispose and cleanup all resources
   * Call this when shutting down to prevent process from hanging
   */
  async dispose(options?: DisposeOptions): Promise<void> {
    // Task #2539 — dispose 也是一种终态，联动释放全部 transient registry。
    // 与 finalizeTask 不同的是：dispose 需要杀所有 processRegistry（即使是残留 PID 也要清），
    // 因为应用关闭时不再有 force-stop retry contract。

    // Stop all progress timers first
    for (const [, timer] of this.progressTimers) {
      try {
        clearInterval(timer);
      } catch {
        // ignore
      }
    }
    this.progressTimers.clear();

    // Task #4794 — abort-scope control.
    //
    // 默认（无 options）：abort 全部仍在运行的任务 —— 用户主动退出
    // （ESC cascade / 进程强杀）语义不变。
    //
    // options.skipAbortRunningTasks=true：**跳过** abort —— 用于
    // CLI `act` 一次性命令的正常收尾（runActShutdownCleanup）。
    // 此时主 run 已结束，后台子 agent 是「有意留下继续跑」的，
    // abort 会把它们误杀（task_signal_abort，3.5s 内死亡）。
    const skipAbortRunningTasks = options?.skipAbortRunningTasks === true;
    const waitForRunningTasks = options?.waitForRunningTasks === true;

    // Task #4794 — 等待运行中任务完成（act 收尾）。
    //
    // 子 agent 是同进程异步 run —— 主进程 process.exit(0)
    // 会直接杀死它们。skipAbortRunningTasks 只是不 abort，
    // 若收尾后进程立刻 exit，子 agent 依然活不成。
    // 因此 act 收尾必须先等运行中的任务自然完成。
    // 上限 10 分钟兜底（子 agent 自身有 timeout 契约）。
    if (waitForRunningTasks && skipAbortRunningTasks) {
      const waitStart = Date.now();
      const WAIT_TIMEOUT_MS = 10 * 60 * 1000;
      while (Date.now() - waitStart < WAIT_TIMEOUT_MS) {
        let running = 0;
        for (const [, t] of this.tasks) {
          if (t.status === "running" || t.status === "pending") running++;
        }
        if (running === 0) break;
        logger.info(
          `[BackgroundTaskManager] dispose waiting for ${running} running task(s)`,
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    // Abort all running tasks
    for (const [, controller] of this.abortControllers) {
      if (skipAbortRunningTasks) break;
      try {
        controller.abort();
      } catch {
        // ignore
      }
    }
    this.abortControllers.clear();

    // ★ 杀所有仍在注册的进程树（防止应用关闭时残留孤儿进程）
    for (const [, registry] of this.processRegistries) {
      try {
        await registry.killAll();
      } catch (err) {
        logger.warn(`[BackgroundTaskManager] dispose registry.killAll failed`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.processRegistries.clear();

    // ★ Task #2144 — propagate stop to all attached workflow runs（防止应用关闭时漏孤儿 workflow）
    for (const taskId of this.workflowRunRegistries.keys()) {
      await this.propagateStopToWorkflowRuns(
        taskId,
        "BackgroundTaskManager disposed"
      );
    }
    this.workflowRunRegistries.clear();

    // Clear all tasks
    this.tasks.clear();

    logger.info(`[BackgroundTaskManager] Disposed`);
  }
}

function getAgentRegistry(taskComponent: TaskComponent): AgentRegistry | undefined {
  const agentComponent = (taskComponent as any).env?.getComponent?.("agent") as
    | Pick<AgentComponent, "getRegistry">
    | undefined;
  return agentComponent?.getRegistry?.();
}

/**
 * Create delegate_task tool
 */
export function createDelegateTool(taskComponent: TaskComponent): Tool {
  // Pass taskComponent.env instead of taskComponent, so BackgroundTaskManager
  // can correctly call this.env.getComponent("session")
  const env = (taskComponent as any).env;
  // ★ Use shared BackgroundTaskManager from TaskComponent if available.
  //    This ensures delegate_task and stop_task share the same instance,
  //    so stop_task can find bgTaskId created by delegate_task.
  const existingManager = (taskComponent as any).backgroundTaskManager as BackgroundTaskManager | undefined;
  const backgroundTaskManager = existingManager ?? new BackgroundTaskManager(env);
  const registry = getAgentRegistry(taskComponent);

  // Expose backgroundTaskManager for testing
  (taskComponent as any)._backgroundTaskManager = backgroundTaskManager;

  const tool: Tool = {
    name: "delegate_task",
    description: `Launch a new sub-agent to handle complex, multistep tasks autonomously.

Available agent types:
${listKnownSubagentDescriptions(registry)}

When using the delegate_task tool, you must specify a subagent_type parameter to select which agent type to use.

## When to use delegate_task:
- When you need to perform complex, multi-step tasks that require independent execution
- When you need to explore a codebase thoroughly (use "explore" subagent)
- When you need to run long-running tasks without blocking the main agent

## How it works:
This tool **always runs in background mode**. It returns immediately with:
- **bgProcessId**: Internal background process ID (use with \`stop_task\` to cancel, different from Task #)
- **subSessionId**: Sub-agent session ID (use with \`session_get\` to see full execution log, always retained)

**After delegating, just WAIT for the notification.** The background process will automatically notify you when:
- ✅ **completed** — with \`bgprocess:\` + \`Task #\` (if it created a task) + result summary
- ⏱️ **timeout** — with \`bgprocess:\` + \`Task #\` (if available)
- ❌ **failed** — with \`bgprocess:\` + \`Task #\` + error details
- 🛑 **stopped** — with \`bgprocess:\` + \`Task #\`

The sub-agent runs independently and creates its own tasks via \`task_create\`.
No need to poll — just wait for the notification and use \`task_get\` with the Task # reported in it.

## Parameters:
- **description**: A short (3-5 words) description of the task
- **prompt**: The task for the agent to perform
- **subagent_type**: The type of specialized agent to use (e.g., "general", "explore")
- **timeout**: Task timeout in milliseconds (optional, default 30 minutes)
- **reason**: Brief reason for calling this tool (optional)
- **similar_task_ids**: Similar task IDs (max 3) to reference for improving sub-agent execution efficiency. Search for similar tasks using \`task_search\` or \`task_list\` before calling this tool.`,
    parameters: DelegateToolParameters,
    execute: async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const startTime = Date.now();
      const params = DelegateToolParameters.parse(args);
      const { description, prompt, subagent_type = "general", timeout, reason, similar_task_ids } = params;

      const parentSessionId = ctx.session_id || "default";

      // ★ ESPlugin v2 (Task #4042) — P0 生产路径修复：
      //
      // 之前 triggerEventId 必须由 LLM 在 delegate_task 参数里显式传入才会透传。
      // 但 triggerEventId（evt_xxx）对 LLM 是个晦涩 token，实测生产上几乎从不传，
      // 导致 notify event 缺 metadata.triggerEventId → CLI EventHandler 的 v2 path
      // （chatId 来自 trigger event）永远是 dead path（#4035/#4038/#4039 串群 bug
      // 实际未修复）。
      //
      // 修复：调用方未显式传时，从 ALS EnvContext 当前事件兜底派生 triggerEventId
      // （LarkCliInstance.handleEvent 已把它注入 evt.metadata/payload.triggerEventId）。
      const resolvedTriggerEventId =
        params.triggerEventId ?? deriveTriggerEventIdFromEnvContext();

      if (resolvedTriggerEventId && resolvedTriggerEventId !== params.triggerEventId) {
        logger.info(
          `[delegate_task] triggerEventId auto-derived from EnvContext: ${resolvedTriggerEventId}`,
        );
      }

      logger.info(`[delegate_task] Called: description=${description}, subagent_type=${subagent_type}, triggerEventId=${resolvedTriggerEventId ?? "(none)"}`);

      // ★ ESPlugin v2 (Task #4042) — P0: triggerEventId 生产校验。
      //
      // 当主 agent 传入（或派生）triggerEventId（说明本次 delegate 由外部 ESEvent
      // 触发）时，先从共享 EventStore 校验它确实存在，再把校验后的 ID 透传给 createTask。
      // 校验失败直接拒绝，避免 notify event 携带一个查不到的 ID 让回复链路静默降级。
      //
      // 未注册共享 EventStore（非 CLI / 单测）时无法校验，记录 warn 后透传
      // （向后兼容：无 triggerEventId 时此分支完全不进入）。
      if (resolvedTriggerEventId) {
        const store = getSharedEventStore();
        if (store) {
          try {
            const persisted = await store.getEventById(resolvedTriggerEventId);
            if (!persisted) {
              return {
                success: false,
                output: "",
                error: `Unknown triggerEventId: ${resolvedTriggerEventId} (not found in EventStore)`,
                metadata: { execution_time_ms: Date.now() - startTime },
              };
            }
          } catch (err) {
            return {
              success: false,
              output: "",
              error: `Failed to verify triggerEventId ${resolvedTriggerEventId}: ${err instanceof Error ? err.message : String(err)}`,
              metadata: { execution_time_ms: Date.now() - startTime },
            };
          }
        } else {
          logger.warn(
            `[delegate_task] triggerEventId=${resolvedTriggerEventId} supplied but no shared EventStore registered; skipping verification`,
          );
        }
      }

      const registry = getAgentRegistry(taskComponent);

      if (!isKnownSubagentType(subagent_type, registry)) {
        return {
          success: false,
          output: "",
          error: `Unknown subagent type: ${subagent_type}`,
          metadata: { execution_time_ms: Date.now() - startTime },
        };
      }

      // Get TagService from TaskComponent
      const tagService = taskComponent.getTagService();

      // Build initial prompt - hook will inject similar tasks info
      let promptWithTaskInfo = prompt;

      // Execute delegate:before Hook (can modify prompt, subagentType, etc.)
      const delegateCtx: TaskDelegateContext = {
        prompt: promptWithTaskInfo,
        subagentType: subagent_type,
        timeout,
        reason,
        tagService,
      };

      const hookCtx = {
        component: { name: "task", version: "1.0.0" },
        data: delegateCtx,
        metadata: { sessionId: parentSessionId },
        phase: "before" as const,
        hookPoint: TaskHookPoints.DELEGATE_BEFORE,
      };

      // ★ 直接传 delegateCtx，避免双重包装
      await globalHookManager.execute(TaskHookPoints.DELEGATE_BEFORE, delegateCtx, { sessionId: parentSessionId });

      // Use potentially modified prompt from hook
      promptWithTaskInfo = delegateCtx.prompt;

      // ★ delegate_task is always background execution now
      return await handleBackgroundTask(
        backgroundTaskManager,
        parentSessionId,
        description,
        promptWithTaskInfo,
        delegateCtx.subagentType,
        delegateCtx.timeout,
        similar_task_ids,
        params.sub_session_id,  // ★ 新增：复用 sub session 模式（超时/失败重试）
        resolvedTriggerEventId,  // ★ ESPlugin v2：透传到 notify event metadata（显式传入或从 EnvContext 派生）
        ctx.model,               // ★ Task #4623：父 run 的 model → sub-agent 继承
        ctx.fallbackModel,       // ★ Task #4623：父 run 的兜底 model → sub-agent 继承
        ctx.fallbackModels,      // ★ Task #4724：父 run 的兜底 model 列表 → sub-agent 继承
        // ★ Task #5217 fix 2：父 run 的 channel systemPrompt（per-event，
        // 由 agent-component.ts 写进 ToolContext.metadata.systemPrompt）
        // → sub-agent 继承，AgentComponent._run 追加到 sub-agent system message。
        ctx.metadata?.systemPrompt as string | undefined,
        // ★ Task #5333：父 run 的渠道专用工具放行名单
        // （由 agent-component.ts 写进 ToolContext.metadata.extendTools）
        // → sub-agent 继承，否则子 agent 看不到 wecom_respond 等 channelOnly 工具。
        // DS review 第 2 轮 MINOR-4：ToolContext.metadata 是松散类型，纯 as 断言
        // 不校验 —— 上游异常值（对象 / 含非字符串）会让 includes() 静默永不命中。
        normalizeExtendTools(ctx.metadata?.extendTools)
      );
    },
  };

  // ★ TracedAs (Task #4042)：给 delegate_task execute 加 span「delegate.execute」。
  // Tool.execute 是对象字面量方法（非 class method），无法直接用 @TracedAs 装饰器，
  // 用 wrapFunction（@TracedAs 的底层实现）包装，效果等价。
  tool.execute = wrapFunction(tool.execute, "delegate.execute", {
    recordParams: true,
    recordResult: false,
    recordError: true,
  });

  return tool;
}

/**
 * Task #4042 ESPlugin v2 P0（生产路径修复）：从当前 EnvContext 派生 triggerEventId。
 *
 * 完整 v2 链路：
 *   lark event → EventStore.insertTriggerEvent → triggerEventId
 *     → 主 agent delegate_task(triggerEventId) → task.background.* metadata.triggerEventId
 *     → CLI EventHandler 反查 EventStore 拿原始 chatId / messageId。
 *
 * 问题：triggerEventId 只在 LLM 显式传参时才透传，而它对 LLM 是个晦涩 token，
 * 生产上几乎不传 → notify event 缺 metadata.triggerEventId → v2 path 永不命中，
 * 退回老 replyChannel fallback（正是 #4035/#4038/#4039 串群根因）。
 *
 * 兜底来源（优先级从高到低）：
 *   1. EnvContext.envEvent.metadata.triggerEventId（LarkCliInstance.handleEvent 注入）
 *   2. EnvContext.envEvent.payload.triggerEventId（同上的 payload 副本）
 *
 * 非 ES 触发场景（普通 CLI / REPL 输入）返回 undefined，向后兼容。
 */
function _deriveTriggerEventIdFromEnvContext(): string | undefined {
  const env = getEnvContext();
  if (!env) return undefined;
  const envEvent = env.envEvent as
    | {
        metadata?: { triggerEventId?: unknown };
        payload?: { triggerEventId?: unknown };
      }
    | undefined;
  const fromMeta = envEvent?.metadata?.triggerEventId;
  if (typeof fromMeta === "string" && fromMeta.length > 0) return fromMeta;
  const fromPayload = envEvent?.payload?.triggerEventId;
  if (typeof fromPayload === "string" && fromPayload.length > 0) return fromPayload;
  return undefined;
}

/**
 * traced 版 deriveTriggerEventIdFromEnvContext（供 debug trace 观测派生结果）。
 */
export const deriveTriggerEventIdFromEnvContext = wrapFunction(
  _deriveTriggerEventIdFromEnvContext,
  "delegate.deriveTriggerEventId",
  { recordParams: false, recordResult: true, recordError: true },
);

/**
 * Task #4042 follow-up：把当前 EnvContext.replyChannel 拍成不可变快照。
 *
 * 为什么快照：replyChannel 对象可能被后续事件修改（父子共享/ALS 继承），
 * 而 BackgroundTask 生命周期长（sub-agent 可能跑几十分钟），必须固化 delegate
 * 时刻的回复目标，避免"通知发出时读到的 replyChannel 已经是别的群"。
 *
 * 返回 undefined 当没有 EnvContext / 没有 replyChannel / replyChannel 无 chatId+messageId
 * （无有效回复目标时不要塞空对象，保持向后兼容）。
 */
function _captureReplyChannelSnapshot(): BackgroundTask["replyChannel"] | undefined {
  const replyChannel = getEnvContext()?.replyChannel as
    | {
        type?: string;
        appId?: string;
        chatId?: string;
        messageId?: string;
        userId?: string;
        profile?: string;
        params?: Record<string, unknown>;
      }
    | undefined;
  if (!replyChannel) return undefined;
  if (!replyChannel.chatId && !replyChannel.messageId) return undefined;
  // ★ 保留原有 params（可能含 token / thread_id / sender_open_id 等业务自定义字段），
  //   只补 userId——否则下游路由可能因缺字段失败再回退到 lastReplyChannel（又串群）。
  const params: Record<string, unknown> = { ...(replyChannel.params ?? {}) };
  if (replyChannel.userId && params.userId === undefined) {
    params.userId = replyChannel.userId;
  }
  return {
    type: replyChannel.type,
    appId: replyChannel.appId,
    chatId: replyChannel.chatId,
    messageId: replyChannel.messageId,
    profile: replyChannel.profile,
    params: Object.keys(params).length > 0 ? params : undefined,
  };
}

/**
 * traced 版 captureReplyChannelSnapshot（供 debug trace 观测 task 的回复目标快照）。
 */
export const captureReplyChannelSnapshot = wrapFunction(
  _captureReplyChannelSnapshot,
  "delegate.captureReplyChannel",
  { recordParams: false, recordResult: true, recordError: true },
);

/**
 * ★ Task #5265 — 把当前 EnvContext.pluginEnabled 拍成不可变快照。
 *
 * ## 为什么需要（生产故障 2026-11-10 12:45）
 *
 * 后台任务完成通知链路（task.background.completed → 通知会话）的
 * 合成 envEvent **pluginEnabled={}（空）** →
 * WecomTaskNotifyPlugin.execute 的 pluginEnabled 守卫
 * （key=wecom-bot-2:WecomTaskNotifyPlugin）不通过 → 插件直接 return
 * 不发卡（用户只看到纯文本）。
 *
 * 主会话（事件轮直发）pluginEnabled 由 event-source-handlers 构建
 * （有 key）→ 有卡。合成事件（publishBackgroundEvent）此前不携带
 * pluginEnabled，dispatcher 的重建逻辑依赖 metadata.plugins（也为空）
 * → 守卫拦截。
 *
 * 修复：delegate 时刻快照 pluginEnabled，随 task 存
 * `BackgroundTask.pluginEnabledSnapshot`，publishBackgroundEvent 时
 * 写进 event.metadata.pluginEnabled —— 通知轮合成 envEvent 自带，
 * dispatcher / buildRunEnvContext 透传 → 守卫放行。
 *
 * 返回 undefined 当没有 EnvContext / 没有 pluginEnabled（向后兼容）。
 */
function _capturePluginEnabledSnapshot():
  | Record<string, boolean>
  | undefined {
  const pluginEnabled = getEnvContext()?.pluginEnabled;
  if (!pluginEnabled) return undefined;
  if (typeof pluginEnabled !== "object") return undefined;
  const keys = Object.keys(pluginEnabled);
  if (keys.length === 0) return undefined;
  return { ...pluginEnabled };
}

/**
 * traced 版 capturePluginEnabledSnapshot（供 debug trace 观测快照结果）。
 */
export const capturePluginEnabledSnapshot = wrapFunction(
  _capturePluginEnabledSnapshot,
  "delegate.capturePluginEnabled",
  { recordParams: false, recordResult: true, recordError: true },
);

async function handleBackgroundTask(
  backgroundTaskManager: BackgroundTaskManager,
  parentSessionId: string,
  description: string,
  prompt: string,
  subagentType: string,
  timeout?: number,
  similarTaskIds?: number[],
  /**
   * ★ 2026-07-10 新增（Task #1752 subSessionId 复用机制）
   * 已有 sub session ID。传入时 BackgroundTaskManager.createTask 跳过 create()，
   * 改为 get() 校验后复用 sub session；不传则保持新建模式。
   */
  existingSubSessionId?: string,
  /**
   * ★ Task #4042 ESPlugin v2：EventStore trigger event ID。
   * 传入时透传给 createTask → publishBackgroundEvent，写进 task.background.*
   * 事件 metadata，供主 agent 反查原始 chatId。
   */
  triggerEventId?: string,
  /**
   * Task #4623 — 父 agent 本次 run 的 model / fallbackModel。
   * 透传给 createTask → sub-agent 的 AgentContext。
   */
  model?: string,
  fallbackModel?: string,
  /**
   * Task #4724 — 父 agent 本次 run 的兜底模型**有序列表**。
   * 透传给 createTask → sub-agent 的 AgentContext（顺序 = 优先级）。
   */
  fallbackModels?: string[],
  /**
   * ★ Task #5217 fix 2 — 父 agent 本次 run 的 channel systemPrompt
   * （ToolContext.metadata.systemPrompt，per-event）。
   * 透传给 createTask → sub-agent 的 AgentContext.metadata.systemPrompt。
   */
  systemPrompt?: string,
  /**
   * ★ Task #5333 — 父 run 的渠道专用工具放行名单（AgentContext.extendTools）。
   * 透传给 createTask → sub-agent 的 AgentContext.extendTools，使委派出去的
   * 子任务仍能调用本渠道的 channelOnly 工具（如 wecom_respond）。
   */
  extendTools?: string[]
): Promise<ToolResult> {
  const startTime = Date.now();

  try {
    // ★ P1 fix: entry-agent 中介模式
    // 当 subagentType 是 workflow 类型时，不直接执行 workflow，
    // 而是委托给 entry-agent（默认 "workflow-runner"），由 entry-agent 调用
    // `workflow run <name>` 来真正启动 workflow。
    //
    // 背景：.roy/design/2026-06-29-workflow-subagent-entry-agent-design.md
    let actualSubagentType = subagentType;
    let actualPrompt = prompt;
    let originalWorkflowName: string | undefined;

    const entryAgent = backgroundTaskManager.resolveEntryAgent(subagentType);
    if (entryAgent) {
      originalWorkflowName = subagentType;
      actualSubagentType = entryAgent;
      // 包装 prompt：明确告诉 entry-agent 这是 workflow 调度请求
      actualPrompt = buildEntryAgentPrompt({
        workflowName: originalWorkflowName,
        originalPrompt: prompt,
        description,
      });
      logger.info(`[delegate_task] Routing workflow subagent '${subagentType}' → entry-agent '${entryAgent}'`);
    }

    // 创建后台任务（sub-agent 内部会自行通过 task_create 创建关联 Task）
    const { taskId: bgProcessId, subSessionId } = await backgroundTaskManager.createTask({
      parentSessionId,
      description,
      prompt: actualPrompt,
      subagentType: actualSubagentType,
      timeout,
      similarTaskIds,
      originalWorkflowName,
      existingSubSessionId,  // ★ 透传：复用 sub session 模式
      triggerEventId,        // ★ ESPlugin v2：透传 triggerEventId → 事件 metadata
      model,                 // ★ Task #4623：父 agent 的 model 继承给 sub-agent
      fallbackModel,         // ★ Task #4623：父 agent 的兜底 model 继承给 sub-agent
      fallbackModels,        // ★ Task #4724：父 agent 的兜底 model 列表继承给 sub-agent
      systemPrompt,          // ★ Task #5217 fix 2：父 run 的 channel systemPrompt 继承给 sub-agent
      extendTools,           // ★ Task #5333：父 run 的渠道专用工具放行名单继承给 sub-agent
    });

    const output = [
      `✅ Background task accepted`,
      "",
      `📋 Process ID: ${bgProcessId}`,
      `📝 Description: ${description}`,
      `🤖 Sub-agent: ${actualSubagentType}${originalWorkflowName ? ` (workflow: ${originalWorkflowName})` : ""}`,
      `⏱️ Timeout: ${(timeout || DEFAULT_TIMEOUT) / 1000}s`,
      "",
      // ★ Task #5462：显式回显 subSessionId + 续跑提示。
      // Task #5456 排查结论 RC-2：返回文案不打印 subSessionId，
      // 父 agent（LLM）无法感知，下一次 delegate 就可能新建 session 丢上下文。
      `🔗 Sub-session: ${subSessionId}   （续跑本任务：delegate_task(sub_session_id="${subSessionId}", prompt="...")）`,
      "",
      `Use stop_task with task_id="${bgProcessId}" to cancel this task.`,
    ].join("\n");

    return {
      success: true,
      output,
      metadata: {
        execution_time_ms: Date.now() - startTime,
        sessionId: subSessionId,
        background: true,
        status: "accepted",
        bgProcessId,
      },
    };
  } catch (error) {
    return {
      success: false,
      output: "",
      error: error instanceof Error ? error.message : String(error),
      metadata: { execution_time_ms: Date.now() - startTime },
    };
  }
}

// Export for stop_task tool
export { handleBackgroundTask };
