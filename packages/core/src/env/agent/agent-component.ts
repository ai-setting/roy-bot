/**
 * @fileoverview AgentComponent - Agent执行核心组件
 * 
 * 基于 roy-bot docs/agent-component-design.md
 * 参考 agent-core Agent.run 实现
 * 
 * 核心功能：
 * - ReAct 循环编排
 * - Hook 机制和 Plugin 扩展
 * - 多 Agent 管理
 * - 工具调用
 * 
 * 依赖：
 * - ../llm - LLMComponent 用于 LLM 调用
 * - ../log-trace/logger - createLogger 用于日志
 */

import { BaseComponent, type ComponentConfig } from "../component";
import { createLogger } from "../log-trace/logger";
import type {
  AgentInstance,
  AgentInstanceConfig,
  AgentRunResult,
  AgentContext,
  Plugin,
  HookContext,
  HookPoint,
  Tool,
  ToolCallResult,
  AgentLLMOutput,
  HookActionType,
} from "./types";
import type { AgentType, CacheSnapshot } from "./types";
import type { EnvEvent } from "../types";
import type { ModelMessage } from "ai";
import type { LLMMessage, LLMInvokeResult } from "../llm/types";
import type { ContentPart } from "../llm/types";
import { z } from "zod";
import { createMaxIterationReminderPlugin } from "../task/plugins/max-iteration-reminder-plugin";
import { createTaskOpWatermarkPlugin } from "../task/plugins/task-op-watermark-plugin";

// LLMComponent 和 ToolComponent 类型
import type { LLMComponent } from "../llm/llm";
import type { ToolComponent } from "../tool/tool-component";
import type { ToolContext, ToolExecuteRequest } from "../tool/types";
import type { ConfigComponent } from "../../config/config-component";
import { envKeyToConfigKey } from "../../config/env-key";
import { AGENT_CONFIG_REGISTRATION, AGENT_DEFAULTS } from "./agent-config-registration";
import { TracedAs } from "../log-trace/decorator";
import {
  agentRunParamFilter,
  llmInvokeParamFilter,
  llmInvokeResultFilter,
  messagesParamFilter,
  recordSessionMessagesParamFilter,
  toolExecParamFilter,
  toolExecResultFilter,
} from "../log-trace/trace-filters";
import { withTimeout } from "../llm/invoke";
import { isFallbackEligibleError, parseFallbackModel } from "../llm/model-fallback";
import { safeParseToolArgs, parseToolArgsStrict } from "../llm/tool-args-parser";
import { truncateOutputInline } from "../tool/tool-component";
// SessionComponent 类型
import type { SessionComponent, SessionMessage } from "../session/session-component";
import type { AddMessageOptions } from "../session/types";

// Session Message 转换器
import { SessionMessageConverter } from "../session/session-message-converter";

// globalHookManager
import { globalHookManager } from "../hook/global-hook-manager";

// EnvContext - 用于在线程中传递事件上下文
import {
  runWithEnvContextAsync,
  getCurrentTaskId,
  getEnvContext,
  resolveEnvParentTaskId,
  resolveToolEnv,
  type EnvContext
} from "../context";

// BackgroundTask-scoped ALS — read current bgTaskId for cascade abort diagnostics
// (Task #2606 Fix #1: getCurrentBgTaskId is NOT exported from ../context barrel;
// must import directly from bg-task-id-storage, mirroring run-workflow.ts:16.)
import { getCurrentBgTaskId } from "../task/delegate/bg-task-id-storage";

// AskUserError - 用于工作流暂停的特定错误
import { AskUserError } from "../workflow/types/workflow-hil";
import { isToolUnavailableError } from "../constants";

// ContextError - 用于上下文窗口超限的错误
import { ContextError } from "../errors";

// AgentRegistry - Agent 配置持久化管理
import { AgentRegistry, type AgentDefinition } from "./agent-registry";
import type { PromptComponent } from "../prompt/prompt-component";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Parse a tool list (allowedTools / deniedTools) from heterogeneous config sources.
 *
 * Task #2024 follow-up: EnvSource has no transform; when allowedTools/deniedTools
 * is set via env var (e.g. AGENT_AGENT_DEFAULT_AGENT_ALLOWED_TOOLS=tool_a,tool_b),
 * ConfigComponent.get() returns the raw string "tool_a,tool_b" rather than an array.
 * The previous `as string[] | undefined` cast was a TypeScript lie: at runtime
 * `allowedTools.includes(t.name)` became `String.prototype.includes` (substring match),
 * not `Array.prototype.includes` (element match).
 *
 * Behavior:
 *   - undefined / null → undefined (no filter)
 *   - Array → returned as-is (after filtering out non-string entries defensively)
 *   - String → split on ',', trim each entry, drop empty strings
 *   - Anything else → undefined (defensive default)
 *
 * @param v - The raw value from constructor, config, env, or file source
 * @returns Normalized string[] | undefined
 */
export function parseToolList(v: unknown): string[] | undefined {
  if (v === undefined || v === null) {
    return undefined;
  }
  if (Array.isArray(v)) {
    const arr = v.filter((x): x is string => typeof x === "string");
    return arr.length > 0 ? arr : undefined;
  }
  if (typeof v === "string") {
    const parts = v.split(",").map(s => s.trim()).filter(Boolean);
    return parts.length > 0 ? parts : undefined;
  }
  return undefined;
}

/**
 * Task #2391 — v0.7.3 unknown-error hardening.
 *
 * Compose the LLM-facing tool-output string from a `ToolResult`. The
 * previous code used `result.error || "Unknown error"` which silently
 * dropped the runId + recovery hint whenever the tool's error field was
 * empty. This helper produces a structured diagnostic instead, using
 * whatever runId / status / metadata bits are present.
 *
 * Behavior:
 *   - `success: true` → returns `output` (string or JSON-stringified record)
 *   - `success: false` with non-empty `error` → returns `error`
 *   - `success: false` with empty/missing `error` AND a runId →
 *       returns `[ErrorType=EmptyErrorField] tool=<name> status=<s> runId=<id>
 *               (no error message provided by tool — query workflow_run_status)`
 *   - `success: false` with empty/missing `error` AND no runId →
 *       returns `[ErrorType=EmptyErrorField] tool=<name> status=<s>
 *               (no error message and no runId — tool did not surface a diagnostic)`
 *
 * Exported for testability (so the fallback string can be asserted
 * directly without spinning up the full agent + LLM stack).
 */
export function composeToolOutputForLLM(
  toolName: string,
  result: { success: boolean; output: string | Record<string, unknown>; error?: string; metadata?: { run_id?: string | number; [k: string]: unknown } } | null | undefined,
): string {
  if (!result) {
    return `[ErrorType=NullResult] tool=${toolName} (no ToolResult returned by executeTool)`;
  }
  if (result.success) {
    const out = result.output;
    return typeof out === "string" ? out : JSON.stringify(out ?? "");
  }
  const rawError = result.error;
  if (typeof rawError === "string" && rawError.length > 0) {
    return rawError;
  }
  // Task #2391 (real Task #2387 production bug): historically
  // run-workflow.ts surfaced `success: false` with the diagnostic
  // buried at `output.error` (nested) but NO top-level `result.error`
  // field. The previous `toolResult.result.error || "Unknown error"`
  // fallback then dropped the diagnostic entirely, persisting 8 bare
  // `Unknown error` tool messages in sessions.db. When top-level error
  // is missing, fall back to the nested `output.error` before giving up.
  const meta = (result.metadata ?? {}) as Record<string, unknown>;
  const out = result.output;
  const outRec: Record<string, unknown> =
    out && typeof out === "object" && !Array.isArray(out)
      ? (out as Record<string, unknown>)
      : {};
  if (typeof outRec.error === "string" && outRec.error.length > 0) {
    return outRec.error;
  }
  const runId =
    (typeof meta.run_id === "string" && meta.run_id) ||
    (typeof outRec.run_id === "string" && outRec.run_id) ||
    (typeof outRec.session_id === "string" && outRec.session_id) ||
    "";
  const status = (typeof outRec.status === "string" && outRec.status) || "failed";
  const tag = "[ErrorType=EmptyErrorField]";
  if (runId) {
    return `${tag} tool=${toolName} status=${status} runId=${runId} (no error message provided by tool — query workflow_run_status for details)`;
  }
  return `${tag} tool=${toolName} status=${status} (no error message and no runId — tool did not surface a diagnostic)`;
}

// ============================================================================
// Logger
// ============================================================================

const logger = createLogger("agent:component");

// ============================================================================
// Type Conversion Utilities
// ============================================================================

/**
 * 将 ModelMessage 转换为 LLMMessage
 *
 * ModelMessage 来自 ai SDK，LLMMessage 是内部格式
 */
export function toLLMMessage(msg: ModelMessage): LLMMessage {
  // 处理 content 字段
  // - 简单文本：保持 string
  // - 多模态 (含 image/file part)：保持 ContentPart[]
  // - 其他 (tool 等)：提取 text
  let content: string | ContentPart[];
  let toolCallId: string | undefined;
  let toolName: string | undefined;
  // 使用 any 类型避免 ai SDK 和内部 ToolCall 类型不兼容
  let toolCalls: any[] | undefined;

  if (typeof msg.content === "string") {
    content = msg.content;
    // 对于 tool 消息，提取 toolCallId 和 toolName
    if (msg.role === "tool") {
      toolCallId = (msg as any).toolCallId;
      toolName = (msg as any).toolName;
    }
    // assistant 消息可能包含 toolCalls（ai SDK v6 格式）
    if (msg.role === "assistant" && (msg as any).toolCalls) {
      toolCalls = (msg as any).toolCalls;
    }
  } else if (Array.isArray(msg.content)) {
    // 处理 tool 消息（AI SDK v6 格式）
    if (msg.role === "tool") {
      // 提取 tool-result 的 output
      const toolResult = msg.content.find((part: any) => part.type === "tool-result") as any;
      // output 可能是 { type: 'text', value: '...' } 或纯字符串
      const output = toolResult?.output;
      if (typeof output === "string") {
        content = output;
      } else if (output && typeof output === "object" && "value" in output) {
        content = output.value?.toString() || "";
      } else {
        content = JSON.stringify(output) || "";
      }
      toolCallId = toolResult?.toolCallId;
      toolName = toolResult?.toolName;
    } else {
      // 处理多模态内容，提取文本 + reasoning + toolCalls
      const toolCallParts = msg.content.filter((part: any) => part.type === "tool-call");
      // P1 多模态：检测是否含 image/file part
      // 如果有，必须保留 ContentPart[] 形式（不能压平为 string）
      const hasMultimodalPart = msg.content.some(
        (part: any) => part.type === "image" || part.type === "file"
      );

      if (hasMultimodalPart) {
        // P1: 保留多模态内容
        //  - image part → ContentPart.image
        //  - file part  → ContentPart.file
        //  - text part  → ContentPart.text
        // reasoning part 故意丢弃（与 string 路径一致）
        const llmContentParts: ContentPart[] = [];
        for (const part of msg.content as any[]) {
          if (part.type === "text") {
            llmContentParts.push({ type: "text", text: (part.text as string) || "" });
          } else if (part.type === "image") {
            // AI SDK ImagePart.image: DataContent | URL
            // ContentPart.image: string | Uint8Array
            //  - URL 字符串直接传
            //  - DataContent (Uint8Array | string | ArrayBuffer) 也兼容
            llmContentParts.push({ type: "image", image: part.image as string | Uint8Array });
          } else if (part.type === "file") {
            // AI SDK FilePart.data: DataContent | URL
            // ContentPart.file: string | Uint8Array
            llmContentParts.push({
              type: "file",
              file: (part.data ?? part.file) as string | Uint8Array,
              mediaType: (part.mediaType as string) || "application/octet-stream",
            });
          }
          // 跳过 reasoning / tool-call (tool-call 在下方处理)
        }
        // 对于 assistant 消息，从 tool-call part 中提取 toolCalls
        if (msg.role === "assistant" && toolCallParts.length > 0) {
          for (const part of toolCallParts as any[]) {
            const argsString = typeof part.input === "string"
              ? part.input
              : JSON.stringify(part.input || {});
            toolCalls = (toolCalls ?? []).concat([{
              id: part.toolCallId,
              name: part.toolName || "unknown",
              arguments: argsString,
              function: { name: part.toolName || "unknown", arguments: argsString },
            }]);
          }
        }
        content = llmContentParts;
      } else {
        // 单模态路径：仅提取文本内容（跳过 reasoning part）
        // reasoning（链式思考）不应拼回 context，否则会导致 LLM 在后续迭代中
        // 误将自身思考链当作历史输出文本，产生文本重复。
        // MiniMax 的 think 标签已通过 rawFullContent 保留在 text part 中。
        const contentParts = msg.content
          .filter((part: any) => part.type === "text")
          .map((part: any) => part.text || "");
        content = contentParts.join("\n");

        // 对于 assistant 消息，从 tool-call part 中提取 toolCalls
        // 注意：toModelMessage 生成的格式是扁平的 { toolCallId, toolName, input }
        // 不是嵌套的 { toolCall: { name, arguments } }
        if (msg.role === "assistant" && toolCallParts.length > 0) {
          toolCalls = toolCallParts.map((part: any) => {
            // input 是已解析的参数对象，需要转回字符串给 convertToSDKMessages
            const argsString = typeof part.input === "string"
              ? part.input
              : JSON.stringify(part.input || {});
            const toolName = part.toolName || "unknown";

            return {
              id: part.toolCallId,
              name: toolName,
              arguments: argsString,
              function: {
                name: toolName,
                arguments: argsString,
              },
            };
          });
        }
      }
    }
  } else {
    content = "";
  }

  return {
    role: msg.role as "system" | "user" | "assistant" | "tool",
    content,
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolName ? { name: toolName } : {}),
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

// ============================================================================
// Config Schema
// ============================================================================

/**
 * AgentComponent 默认配置
 */
const DEFAULT_AGENT_CONFIG = {
  type: "primary" as const,
  maxIterations: 200,
  maxErrorRetries: 3,
  doomLoopThreshold: 5,
  toolTimeout: 60000,
  toolRetries: 3,
  /** 是否过滤 history 中的 tool 消息（默认不过滤，保留完整上下文） */
  filterHistory: false,
  /**
   * 工具过滤字段（Task #3336 修复）：
   * DEFAULT_AGENT_CONFIG 之前缺少这两个字段，导致 registerAgent 里
   * `config.allowedTools ?? this.config.defaultAgent.allowedTools` fallback 是 undefined，
   * 运行时 getAvailableTools 跳过过滤，allowedTools / deniedTools 配置失效。
   * 加上 undefined 默认值（注意不是 []，避免变成空白名单误拒绝所有工具）。
   */
  allowedTools: undefined,
  deniedTools: undefined,
};

/**
 * Agent 实例配置 Schema
 */
const AgentInstanceSchema = z.object({
  type: z.enum(["primary", "sub"]).default("primary"),
  systemPrompt: z.string().optional(),
  behaviorSpecId: z.string().optional(),
  model: z.string().optional(),
  maxIterations: z.number().default(200),
  maxErrorRetries: z.number().default(3),
  doomLoopThreshold: z.number().default(5),
  allowedTools: z.array(z.string()).optional(),
  deniedTools: z.array(z.string()).optional(),
  toolTimeout: z.number().default(60000),
  toolRetries: z.number().default(3),
  /** 是否过滤 history 中的 tool 消息（默认不过滤，保留完整上下文） */
  filterHistory: z.boolean().default(false),
});

/**
 * AgentComponent 配置 Schema
 */
export const AgentComponentConfigSchema = z.object({
  defaultAgent: AgentInstanceSchema,
});

export type AgentComponentConfig = z.infer<typeof AgentComponentConfigSchema>;

// ============================================================================
// AgentComponentOptions (统一配置机制)
// ============================================================================

/**
 * AgentComponent 配置选项（通过 options 传递）
 * 
 * 配置加载顺序（优先级从低到高）：
 * 1. File - 配置文件（通过 configPath 指定）
 * 2. Env - 环境变量（通过 envPrefix 配置前缀）
 * 3. Object - 直接传入的 config 对象（最高优先级）
 */
export interface AgentComponentOptions {
  /** ConfigComponent 实例（必填） */
  configComponent: ConfigComponent;
  
  /** 配置文件相对路径（可选，基于 XDG_DATA_HOME） */
  configPath?: string;
  
  /** 环境变量前缀（可选，默认 "AGENT"） */
  envPrefix?: string;
  
  /** 直接传入的配置对象（可选，优先级最高） */
  config?: Partial<AgentComponentConfig>;

  /**
   * Task #4794 — onStop() 时是否跳过 abort 所有运行中的 agent run。
   *
   * CLI `act` 一次性命令收尾时传 true：后台子 agent 是有意留下
   * 继续跑的，onStop 无条件 abort 会中断其 LLM 调用（finishReason=aborted）。
   * 子 agent 的存活由 TaskComponent.stop 的 waitForRunningTasks 保证。
   * REPL / ESC cascade 等用户主动退出场景保持默认 false（abort 全部）。
   */
  skipAbortRunningTasksOnStop?: boolean;
}

// ============================================================================
// AgentComponent
// ============================================================================

/**
 * 按 agent 的 `allowedAgentTypes` 工具级可见性过滤工具列表。
 *
 * 应用规则（与 ToolRegistry.listTools({ allowedAgent }) 保持一致）：
 * - `metadata.allowedAgentTypes` 未设置 / 空数组 → 工具对所有 agent 可见
 * - 非空数组 → 仅当 agent.name 命中任一元素时工具可见
 * - 字符串精确匹配，大小写敏感
 *
 * 用途（2026-07-15 修复 review #14143 Medium #3）：
 * - 统一在 AgentComponent.getAvailableTools 的三个入口（defaultTools / componentTools
 *   / extraTools）都调用一次，避免某些路径绕过此过滤
 * - ToolComponent.listTools 已经过滤过 componentTools 一次，此处再过滤属于
 *   防御性二次保险
 *
 * @param tools 待过滤的工具列表（不会修改入参）
 * @param agent 当前请求工具列表的 agent
 * @returns 过滤后的新数组（保留原数组的相对顺序）
 */
export function filterToolsByAgent(
  tools: Tool[],
  agent: AgentInstance,
  extendTools?: string[],
): Tool[] {
  if (!tools?.length) return tools ?? [];
  return tools.filter((t: Tool) => {
    // ★ Task #5333：channel-only 工具按会话渠道上下文放行
    // （必须在 allowedAgentTypes 之前判断：channelOnly 是更严格的附加条件）
    if (t.metadata?.channelOnly === true) {
      if (!extendTools || extendTools.length === 0) return false;
      if (!extendTools.includes(t.name)) return false;
    }
    const allowedList = t.metadata?.allowedAgentTypes;
    if (!allowedList || allowedList.length === 0) return true;
    return allowedList.includes(agent.name);
  });
}

/**
 * 构建一次 Agent run 的 EnvContext（effectiveContext + 父级 ALS 继承）。
 *
 * ★ Blocker 1（Task #4111 P0-2 / #4108 v2 根因）：把原先内联在
 *   `AgentComponent._run()` 里的 EnvContext 构建抽为**纯函数**，便于用真实生产
 *   代码做回归测试（此前测试 inline 复刻优先级，revert 生产代码后测试仍全绿 =
 *   tautological，无法捕获回归）。
 *
 * 继承策略：
 *   - 大部分字段沿用 `...parentEnvContext` 展开（父级 ALS 兜底）
 *   - `envEvent` / `replyChannel`：**effective（当前事件）优先**，parent 兜底
 *     —— 修复 #4106 → #3990 群送错群（parent ALS 缓存的上一事件 replyChannel
 *     污染了当前事件的 replyChannel）
 *   - 兼容：effective.envEvent.metadata 无 replyChannel（老 API 直接传 envEvent）时
 *     仍回落 parent ALS，保证子 Agent 可用父级 replyChannel 发通知
 */
export function buildRunEnvContext(inputs: {
  effectiveContext: AgentContext;
  parentEnvContext: EnvContext | undefined;
  envBoundParentTaskId: number | undefined;
}): EnvContext {
  const { effectiveContext, parentEnvContext, envBoundParentTaskId } = inputs;
  const effectiveEnvEvent = effectiveContext.envEvent as
    | { metadata?: { replyChannel?: unknown; sourceId?: unknown; sourceType?: unknown } }
    | undefined;

  return {
    ...parentEnvContext,
    // 确保 agentContext 始终存在（共享引用，子写父读）
    agentContext: parentEnvContext?.agentContext ?? {},
    // 仅覆盖本 agent 需要的字段
    traceId: effectiveContext.metadata?.traceId as string | undefined,
    sessionId: effectiveContext.sessionId,
    // 优先继承父级 ALS 上下文的 userId
    userId:
      parentEnvContext?.userId ??
      ((effectiveContext.metadata?.userId as string | undefined) ?? ""),
    // ★ Task #2326: messageId 优先级 parent → effectiveContext.metadata
    // （delegate 派生的 sub-agent 需继承父级 messageId 以 +messages-reply 关联原 query）
    messageId:
      parentEnvContext?.messageId ??
      (effectiveContext.metadata?.messageId as string | undefined),
    pluginEnabled: {
      ...(parentEnvContext?.pluginEnabled ?? {}),
      ...(effectiveContext.pluginEnabled ?? {}),
    },
    plugins: effectiveContext.plugins,
    // 【envEvent 优先级策略】effective 优先，parent 兜底
    envEvent: effectiveContext.envEvent ?? parentEnvContext?.envEvent,
    // 【replyChannel 优先级策略】effective 优先，parent 兜底（★ P0-2 修复）
    replyChannel:
      (effectiveEnvEvent?.metadata?.replyChannel as EnvContext["replyChannel"]) ??
      parentEnvContext?.replyChannel,
    // sourceId/sourceType 保持与既有行为一致（parent 优先），避免本次范围外的改动
    sourceId:
      parentEnvContext?.sourceId ??
      ((effectiveContext.envEvent as any)?.metadata?.sourceId),
    sourceType:
      parentEnvContext?.sourceType ??
      ((effectiveContext.envEvent as any)?.metadata?.sourceType),
    // ★ Task #4023 修复：本次事件的 chat↔task 绑定优先（已由 resolveEnvParentTaskId 规范化）
    parentTaskId: envBoundParentTaskId,
    // ★ Task #5659：工具子进程 env（ES config toolEnv）。
    //   本次事件优先，父级 ALS 兜底（sub-agent 继承父级 toolEnv）。
    toolEnv: resolveToolEnv(effectiveContext.envEvent, parentEnvContext),
    metadata: { ...effectiveContext.metadata },
  } as EnvContext;
}

/**
 * AgentComponent
 *
 * 提供 Agent 执行能力和 Hook 扩展机制
 */
export class AgentComponent extends BaseComponent {
  readonly name = "agent";
  readonly version = "1.0.0";

  private agents: Map<string, AgentInstance> = new Map();
  private config: AgentComponentConfig;
  private llmComponent: LLMComponent | null = null;
  private toolComponent: ToolComponent | null = null;
  private aborted: Map<string, boolean> = new Map();
  private abortControllers: Map<string, AbortController> = new Map();  // Agent Run 的 AbortController，使用 runId 作为 key
  private defaultTools: Tool[] = [];

  // Doom loop detection cache (per-agent for isolation)
  private doomLoopCaches: Map<string, Map<string, number>> = new Map();

  /**
   * ★ Task #5224 — session-scope cache snapshot（**内存级**，key = sessionId）。
   *
   * ## 为什么改成内存级
   *
   * 旧实现把快照持久化到 `session.metadata.cacheSnapshot`，带来三个问题：
   *
   * 1. **体积爆炸**：快照 = 整份 systemPrompt（含展开后的 memory），
   *    实测单 session metadata ≈ 102 KB —— `packages/cli/src/commands/shared/chat-session.ts:48`
   *    自述这是本地 `sessions.db` 膨胀到 3.3 GB 的直接原因。
   * 2. **跨进程时间差**：进程重启后复用的旧快照创建于渠道 prompt 引入之前，
   *    且失效检测只看 memory.md mtime → 旧快照被判「新鲜」永久复用
   *    → 渠道 prompt 永远进不了 LLM system message（Task #5210/#5217 根因）。
   * 3. **需要一堆补丁兜底**：fix③ 追加 + includes 判重（Task #5223）
   *    都是为了在「持久化 + 复用」模型下把渠道 prompt 塞回去。
   *
   * ## 新语义（用户确认）
   *
   * - 快照是**进程内**的一次性构建产物：session 生命周期内构建一次，之后一直用。
   * - **不持久化** sessions.db ⇒ 进程重启后全部重建（自然拿到最新 memory）。
   * - **渠道 prompt 在构建时注入**（唯一注入点）⇒ 无需任何复用轮补丁。
   * - **不做失效检测**（`_isMemorySnapshotStale` 已删除）⇒ session 内 memory
   *   变更不生效（冻结语义），新 session 自然用最新 memory。
   *
   * 生命周期 = AgentComponent 实例 = 生产环境进程生命周期
   * （`environment.service.ts` 只 `new AgentComponent()` 一次）。
   */
  private _cacheSnapshots: Map<string, CacheSnapshot> = new Map();

  /**
   * Task #4623 — per-run fallback state.
   *
   * Keyed by runId. The value is the model that the run has *already* been
   * downgraded to (or the primary model, once a downgrade happened).
   *
   * ⚠️ Why per-run and not global: a quota exhaustion is a durable condition
   * for the *current* run, but the next run may legitimately want the primary
   * model again (e.g. the user fixed the key). Scoping the sticky state to a
   * single run keeps the behaviour predictable and prevents a permanently
   * downgraded agent.
   */
  private fallbackState: Map<string, {
    /** 当前生效的模型（降级后就是兜底模型） */
    activeModel: string;
    /**
     * Task #4724 — 尚未尝试的兜底模型（顺序 = 优先级）。
     *
     * 链式降级时，若当前生效的模型在后续迭代又失败，
     * 就从这里继续往下试，而不是回头撞主模型。
     */
    remaining: string[];
  }> = new Map();
  
  /** ConfigComponent 用于配置管理 */
  private configComponent?: ConfigComponent;

  /**
   * Task #4794 — onStop() 时是否跳过 abort 运行中的 agent run
   * （act 一次性命令收尾 = true；用户主动退出 = false 默认）。
   */
  private skipAbortRunningTasksOnStop = false;
  
  /** 配置变更 watcher 清理函数 */
  private configWatcher?: () => void;
  
  /** Session 消息转换器 */
  private messageConverter = new SessionMessageConverter();
  
  /** 构造函数传入的配置（最高优先级） */
  private _constructorConfig?: { defaultAgent?: Partial<AgentComponentConfig["defaultAgent"]> };

  /** Run ID 计数器（用于生成唯一的 runId） */

  /** AgentRegistry 用于持久化 agent 配置 */
  private registry?: AgentRegistry;
  private runCounter = 0;

  constructor(options: {
    config?: Partial<AgentComponentConfig>;
  } = {}) {
    super();
    
    // 保存构造函数传入的配置（最高优先级）
    this._constructorConfig = options.config;
    
    this.config = {
      defaultAgent: {
        ...DEFAULT_AGENT_CONFIG,
        ...options.config?.defaultAgent,
      },
    };
  }

  /**
   * 初始化组件
   * 
   * 配置加载优先级（从高到低）：
   * 1. Object - 直接传入的 config 对象
   * 2. Env - 环境变量（通过 envPrefix 配置前缀）
   * 3. File - 配置文件（通过 configPath 指定）
   */
  async init(config: ComponentConfig): Promise<void> {
    // 调用基类 init，注入 env
    await super.init(config);

    // 从 options 获取 ConfigComponent
    const options = config.options as unknown as AgentComponentOptions | undefined;
    if (!options?.configComponent) {
      throw new Error("ConfigComponent is required for AgentComponent initialization");
    }

    this.configComponent = options.configComponent;
    // Task #4794 — act 收尾路径标记：onStop() 时跳过 abort 运行中的 agent run
    this.skipAbortRunningTasksOnStop = options.skipAbortRunningTasksOnStop === true;
    await this.registerConfig(options);
    await this.initRegistry(options.configComponent);

    this.setStatus("running");
  }

  /**
   * 注册配置到 ConfigComponent
   * 
   * 配置加载顺序（优先级从低到高）：
   * 1. Defaults - 默认值（最低）
   * 2. FileSource - 从配置文件加载
   * 3. EnvSource - 从环境变量加载
   * 4. config 对象 - 直接传入的配置（最高）
   */
  private async registerConfig(options: AgentComponentOptions): Promise<void> {
    const configComponent = options.configComponent;
    if (!configComponent) return;

    const { configPath, envPrefix, config } = options;
    const prefix = envPrefix ?? "AGENT";

    // 1. 使用 registerComponent 注册配置结构（keys 和 sources，不含 defaults）
    configComponent.registerComponent(AGENT_CONFIG_REGISTRATION);

    // 2. 注册 FileSource（如果提供了 configPath）
    if (configPath) {
      configComponent.registerSource({
        type: "file",
        relativePath: configPath,
        optional: true,
        watch: false
      });
    }

    // 3. 注册 EnvSource
    configComponent.registerSource({
      type: "env",
      envPrefix: prefix,
      priority: 20,
      watch: false
    });
    
    // 4. 从 sources 加载配置（FileSource 和 EnvSource）
    await configComponent.load("agent");
    
    // 5. 后备方案：直接读取环境变量（确保所有环境变量都被处理）
    for (const envKey of Object.keys(process.env)) {
      const configKey = envKeyToConfigKey(envKey, prefix, "agent");
      if (!configKey) continue;
      const value = process.env[envKey];
      if (value !== undefined) {
        await configComponent.set(configKey, value);
      }
    }

    // 6. 设置默认值（只有当配置不存在时）
    for (const [key, value] of Object.entries(AGENT_DEFAULTS)) {
      if (configComponent.get(key) === undefined) {
        await configComponent.set(key, value);
      }
    }

    // 7. 直接配置对象（最高优先级）
    if (config) {
      const flatConfig = this.flattenConfig(config);
      for (const [key, value] of Object.entries(flatConfig)) {
        await configComponent.set(key, value);
      }
    }

    // 8. 从 ConfigComponent 同步配置到 this.config
    // 重要：配置文件/环境变量的值必须同步回实例配置，供 registerAgent() 使用
    // 注意：构造函数传入的配置优先级最高
    const constructorDefaultAgent = this._constructorConfig?.defaultAgent;
    
    // 从 ConfigComponent 读取值，并设置默认值
    // 构造函数传入的值优先级最高，会覆盖从 ConfigComponent 读取的值
    this.config.defaultAgent = {
      maxIterations: constructorDefaultAgent?.maxIterations 
        ?? (configComponent.get("agent.defaultAgent.maxIterations") as number) 
        ?? 200,
      maxErrorRetries: constructorDefaultAgent?.maxErrorRetries
        ?? (configComponent.get("agent.defaultAgent.maxErrorRetries") as number) 
        ?? 3,
      doomLoopThreshold: constructorDefaultAgent?.doomLoopThreshold
        ?? (configComponent.get("agent.defaultAgent.doomLoopThreshold") as number) 
        ?? 5,
      toolTimeout: constructorDefaultAgent?.toolTimeout
        ?? (configComponent.get("agent.defaultAgent.toolTimeout") as number) 
        ?? 60000,
      toolRetries: constructorDefaultAgent?.toolRetries
        ?? (configComponent.get("agent.defaultAgent.toolRetries") as number) 
        ?? 3,
      filterHistory: constructorDefaultAgent?.filterHistory
        ?? (configComponent.get("agent.defaultAgent.filterHistory") as boolean) 
        ?? false,
      type: constructorDefaultAgent?.type
        ?? (configComponent.get("agent.defaultAgent.type") as "primary" | "sub") 
        ?? "primary",
      systemPrompt: constructorDefaultAgent?.systemPrompt
        ?? (configComponent.get("agent.defaultAgent.systemPrompt") as string | undefined),
      model: constructorDefaultAgent?.model
        ?? (configComponent.get("agent.defaultAgent.model") as string | undefined),
      behaviorSpecId: constructorDefaultAgent?.behaviorSpecId
        ?? (configComponent.get("agent.defaultAgent.behaviorSpecId") as string | undefined),
      // 工具过滤字段（Task #2024 修复 + Task #2024 follow-up 字符串→数组 修正）：
      // env 来源时 EnvSource 返回 raw string（如 "tool_a,tool_b"），必须通过
      // parseToolList split 为数组；否则 `.includes(t.name)` 会退化为
      // String.prototype.includes（子串匹配），导致误匹配/误拒绝。
      allowedTools: parseToolList(
        constructorDefaultAgent?.allowedTools
        ?? configComponent.get("agent.defaultAgent.allowedTools")
      ),
      deniedTools: parseToolList(
        constructorDefaultAgent?.deniedTools
        ?? configComponent.get("agent.defaultAgent.deniedTools")
      ),
    };

    logger.info(`[registerConfig] Synced config from ConfigComponent: maxIterations=${this.config.defaultAgent.maxIterations}`);

    // 9. 注册配置热更新监听
    this.registerConfigWatcher(configComponent);
  }

  /**
   * 将配置对象展平为点号路径
   */
  private flattenConfig(
    obj: Record<string, unknown>,
    prefix = "agent"
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const fullKey = `${prefix}.${key}`;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        Object.assign(
          result,
          this.flattenConfig(value as Record<string, unknown>, fullKey)
        );
      } else {
        result[fullKey] = value;
      }
    }
    return result;
  }

  /**
   * 注册配置热更新监听
   */
  private registerConfigWatcher(configComponent: ConfigComponent): void {
    if (typeof configComponent.watch !== "function") {
      return;
    }
    
    this.configWatcher = configComponent.watch("agent.*", (event) => {
      this.onConfigChange(event);
    });
  }

  /**
   * 处理配置变更
   */
  protected onConfigChange(event: { key: string; oldValue?: unknown; newValue?: unknown }): void {
    logger.info(`Agent config changed: ${event.key}`, {
      oldValue: event.oldValue,
      newValue: event.newValue
    });
  }

  /**
   * 初始化 AgentRegistry
   * 
   * 从 agent config folder 加载 agent 配置
   */
  @TracedAs("agent.component.initRegistry", { recordParams: true, recordResult: true, log: true })
  private async initRegistry(configComponent: ConfigComponent): Promise<void> {
    try {
      // 创建 AgentRegistry（延迟解析 PromptComponent，因 agent 先于 prompt 初始化）
      this.registry = new AgentRegistry({
        configComponent,
        resolvePromptComponent: () =>
          (this.env?.getComponent?.("prompt") as PromptComponent | undefined) ?? null,
      });
      
      // 从配置目录加载 agent 配置
      const loadedCount = await this.registry.load();
      logger.info(`[AgentComponent] Loaded ${loadedCount} agents from config directory`);

      // 注册内置 workflow-runner (Task #2164 beta-compare + Task #2247 fallback mode)
      // workflow-runner 是与 roy/explore 同层的 sub 类型子代理，
      // Task #2247: 移除 allowedTools 白名单（Roy 风格工具集），
      // 通过 deniedTools=[delegate_task, stop_task] 防止递归委托.
      this.registry.registerWorkflowRunner();
      logger.info("[AgentComponent] Registered built-in workflow-runner");

      // 注册内置 task-organizer agent (Task #2348)
      // task-organizer 是任务树整理子智能体，15 个任务管理工具白名单（含 task_tree /
      // task_search / task_batch_*），通过 deniedTools=[delegate_task, stop_task] 防止
      // 递归委托。默认 systemPrompt 来自 builtInPrompts['task-organizer']。
      this.registry.registerTaskOrganizer();
      logger.info("[AgentComponent] Registered built-in task-organizer");

      // 注册内置 json-extract agent
      // json-extract 是 workflow 结构化输出（output.mode=json）专用的子 agent，
      // 由 workflow-json-output-plugin 在 agent:after.react hook 中调用，
      // 通过 workflow_submit_output 工具提交 typed JSON
      this.registry.registerJsonExtractAgent();
      logger.info("[AgentComponent] Registered built-in json-extract agent");

      // 注册内置 workflow-creator agent (Task #2194)
      // workflow-creator 是与 workflow-runner / workflow-extract 同层的 sub 类型子代理，
      // 与用户多轮对话式协作设计、验证并注册 workflow（区别于 workflow-extract 的
      // one-shot 自动提取）。6 个 workflow_* 工具白名单，deniedTools 禁递归委托.
      this.registry.registerWorkflowCreator();
      logger.info("[AgentComponent] Registered built-in workflow-creator");

      // 注册内置 workflow-extract agent
      // workflow-extract 是 task completion 时从对话历史提取 Workflow 的子 agent，
      // 由 task-tag-plugin 在 task:operation:after.create (completed) hook 中调用，
      // 通过 generate→validate→fix→add 迭代循环构建 workflow
      this.registry.registerWorkflowExtractAgent();
      logger.info("[AgentComponent] Registered built-in workflow-extract agent");

      // 注册内置 compact agent
      // compact 是 session 压缩专用的子 agent，由 SessionComponent.compact() 调用，
      // 从父 session 历史中提取结构化 checkpoint JSON
      this.registry.registerCompactAgent();
      logger.info("[AgentComponent] Registered built-in compact agent");

      // 注册内置 compact-hint agent
      // compact-hint 是 session 压缩第一阶段子 agent（Phase 1），
      // 分析父 session 历史生成场景化压缩指导提示
      this.registry.registerCompactHintAgent();
      logger.info("[AgentComponent] Registered built-in compact-hint agent");

      // 注册内置 roy agent
      // roy 是 Roy Intelligent OS 的核心子智能体（type='sub'），
      // 提供通用 AI 助手能力：编码、研究、规划、执行、工具使用。
      // 内置注册让新装用户无需 `agent add roy` 即可在 agents list 中看到、
      // 通过 delegate_task(subagent_type="roy") 直接使用。
      this.registry.registerRoyAgent();
      logger.info("[AgentComponent] Registered built-in roy agent");

      // 注册从配置加载的 agent 到 AgentComponent（解析 systemPromptRef）
      for (const agentDef of this.registry.list()) {
        if (!this.agents.has(agentDef.name)) {
          const systemPrompt = await this.registry.getSystemPrompt(agentDef.name);
          this.registerAgent(agentDef.name, {
            type: agentDef.type as AgentType,
            systemPrompt,
            systemPromptRef: agentDef.systemPromptRef,  // 保留 systemPromptRef 以便后续延迟解析
            allowedTools: agentDef.allowedTools,
            deniedTools: agentDef.deniedTools,
            model: agentDef.model,
            maxIterations: agentDef.maxIterations,
          });
          logger.debug(`[AgentComponent] Registered agent from config: ${agentDef.name}`);
        }
      }
    } catch (error) {
      logger.warn(`[AgentComponent] Failed to initialize AgentRegistry: ${error}`);
    }
  }

  /**
   * 在 PromptComponent 就绪后，重新同步 registry agent 的 systemPrompt
   */
  @TracedAs("agent.component.syncRegistryAgentsFromConfig", { recordParams: false, recordResult: true, log: true })
  async syncRegistryAgentsFromConfig(): Promise<void> {
    if (!this.registry) {
      return;
    }

    for (const agentDef of this.registry.list()) {
      const systemPrompt = await this.registry.getSystemPrompt(agentDef.name);
      const existing = this.agents.get(agentDef.name);
      if (existing) {
        if (systemPrompt !== undefined) {
          existing.config.systemPrompt = systemPrompt;
        }
        if (agentDef.systemPromptRef) {
          existing.config.systemPromptRef = agentDef.systemPromptRef;
        }
      } else {
        this.registerAgent(agentDef.name, {
          type: agentDef.type as AgentType,
          systemPrompt,
          systemPromptRef: agentDef.systemPromptRef,
          allowedTools: agentDef.allowedTools,
          deniedTools: agentDef.deniedTools,
          model: agentDef.model,
          maxIterations: agentDef.maxIterations,
        });
      }
      logger.debug(`[AgentComponent] Synced registry agent: ${agentDef.name}`);
    }
  }

  /**
   * 获取 AgentRegistry
   */
  getRegistry(): AgentRegistry | undefined {
    return this.registry;
  }

  /**
   * 从 Registry 获取 agent 定义
   */
  getAgentFromRegistry(name: string): AgentDefinition | undefined {
    return this.registry?.get(name);
  }

  /**
   * 列出 Registry 中所有 agent 定义
   */
  listAgentsFromRegistry(): AgentDefinition[] {
    return this.registry?.list() ?? [];
  }

  /**
   * 组件停止时的清理逻辑
   * 
   * 清理内容：
   * 1. 终止所有正在运行的 Agent（调用 abort() 以中断 LLM 调用）
   * 2. 清空 AbortController 注册表
   * 3. 清空 Doom Loop 缓存
   * 4. 取消配置变更监听
   * 5. 清空 Agent 注册表
   */
  protected async onStop(): Promise<void> {
    logger.info("[AgentComponent] Stopping and cleaning up resources...");
    
    // Task #4794 — abort-scope control.
    //
    // 默认（无标记）：abort 全部运行中的 agent —— 用户主动退出
    // （ESC cascade / 强杀）语义不变。
    //
    // skipAbortRunningTasksOnStop=true：**跳过** abort —— 用于
    // CLI `act` 一次性命令的正常收尾。后台子 agent 是有意留下
    // 继续跑的，abort 会中断其 LLM 调用（finishReason=aborted）；
    // 其存活由 TaskComponent.stop 的 waitForRunningTasks 保证。
    const skipAbort = this.skipAbortRunningTasksOnStop === true;

    // 1. 终止所有正在运行的 Agent（调用 abort() 以中断 LLM 调用）
    if (!skipAbort) {
      for (const [name, agent] of this.agents) {
        if (agent.status === "running" || agent.status === "idle") {
          // 调用 abort() 方法会触发 AbortController.abort()，从而中断正在进行的 LLM 调用
          this.abort(name);
          logger.debug(`[AgentComponent] Aborted agent: ${name}`);
        }
      }
    } else {
      logger.info(
        "[AgentComponent] skipAbortRunningTasksOnStop=true — keeping running agent runs alive",
      );
    }
    
    // 2. 清空 AbortController 注册表
    this.abortControllers.clear();
    
    // 2.1 清空 aborted 标志表（Task #4794：skip 模式下也必须清，
    //     否则残留的 runId 标志会在下次 run 复用 runId 时误判）
    this.aborted.clear();
    
    // 3. 清空 Doom Loop 缓存
    this.doomLoopCaches.clear();
    
    // 4. 取消配置变更监听
    if (this.configWatcher) {
      this.configWatcher();
      this.configWatcher = undefined;
    }
    
    // 5. 清空 Agent 注册表
    this.agents.clear();
    
    this.setStatus("stopped");
    logger.info("[AgentComponent] Cleanup completed");
  }

  /**
   * 刷新依赖组件引用
   * 
   * 当组件被添加到 Environment 后调用，以确保获取到最新的组件引用
   */
  async refreshDependencies(): Promise<void> {
    if (this.env) {
      const llm = this.env.getComponent("llm");
      const tool = this.env.getComponent("tool");
      this.llmComponent = llm ? llm as unknown as LLMComponent : null;
      this.toolComponent = tool ? tool as unknown as ToolComponent : null;

      // ★ 注入 understand_image 工具的 LLM provider：
      // 让内置的 understand_image 工具能直接调用 LLMComponent.invoke()
      // （不带工具列表、不发流式事件给会话，单次性 LLM 视觉理解）
      if (this.llmComponent) {
        try {
          // 动态 import 避免循环依赖
          const mod = await import("../tool/built-in/understand-image");
          mod.setUnderstandImageLLMProvider(async (messages) => {
            // messages: LLMMessage[]（多模态 text + image）
            const result = await this.llmComponent!.invoke({
              messages,
              // 重要：不传 tools，避免 LLM 触发递归工具调用
              tools: [],
              // 跳过上下文阈值检查 —— understand_image 是单次调用，
              // 不应触发 session 压缩逻辑
              skipThresholdCheck: true,
              context: {
                sessionId: undefined,
                messageId: `understand_image-${Date.now()}`,
              },
            });
            return result.output?.content ?? "";
          });
          logger.debug("[refreshDependencies] understand_image LLM provider injected");
        } catch (err) {
          // 不阻断 refreshDependencies —— 失败仅表示视觉工具不可用
          logger.warn(`[refreshDependencies] failed to inject understand_image provider: ${(err as Error).message}`);
        }
      }
      
      logger.debug("[refreshDependencies] AgentComponent refreshed", {
        hasLLM: !!this.llmComponent,
        hasTool: !!this.toolComponent,
      });
    }
  }

  /**
   * 解析 agent 的 systemPrompt
   * 
   * 处理 PromptComponent 延迟初始化的情况：
   * - 若 agent 有 systemPromptRef 但尚无 systemPrompt，从 registry 延迟解析
   * - 若已有 systemPrompt 则跳过（sync 或上次 run 已解析）
   */
  @TracedAs("agent.component.resolveSystemPrompt", { recordParams: true, recordResult: true, log: true })
  private async resolveSystemPrompt(agent: AgentInstance, agentName: string): Promise<void> {
    if (agent.config.systemPrompt) {
      return;
    }

    if (!agent.config.systemPromptRef) {
      // 没有 systemPromptRef，保持 undefined（后续会使用默认值）
      return;
    }

    if (!this.registry) {
      logger.debug(`[resolveSystemPrompt] No registry available for ${agentName}`);
      return;
    }

    try {
      const resolvedPrompt = await this.registry.getSystemPrompt(agentName);
      if (resolvedPrompt) {
        agent.config.systemPrompt = resolvedPrompt;
        logger.debug(`[AgentComponent] Resolved systemPrompt for agent: ${agentName}`);
      }
    } catch (error) {
      logger.warn(`[AgentComponent] Failed to resolve systemPrompt for agent ${agentName}: ${error}`);
    }
  }

  /**
   * 获取 Agent 实例
   */
  getAgent(agentName: string): AgentInstance | undefined {
    return this.agents.get(agentName);
  }

  /**
   * 获取所有 Agent 实例
   */
  listAgents(): AgentInstance[] {
    return Array.from(this.agents.values());
  }

  /**
   * Add placeholder tool results for remaining unprocessed tool calls
   * 
   * This ensures that the message history maintains a 1:1 correspondence
   * between tool-calls and tool-results, which is required by AI SDK v6.
   * 
   * @param ctx - Hook context containing messages
   * @param allToolCalls - All tool calls from the LLM response
   * @param processedCount - Number of tool calls that have been processed
   * @param reason - Reason for the abort/interruption
   */
  private addRemainingToolResults(
    ctx: HookContext,
    allToolCalls: Array<{ id: string; name?: string; function?: { name?: string; arguments?: string | unknown } }>,
    processedCount: number,
    reason: string
  ): void {
    const remainingToolCalls = allToolCalls.slice(processedCount);
    
    for (const tc of remainingToolCalls) {
      const tcName = tc.function?.name || tc.name || "unknown";
      
      this.pushMessage(ctx, {
        role: "tool",
        content: [{
          type: "tool-result" as const,
          toolCallId: tc.id,
          toolName: tcName,
          output: JSON.stringify({ error: reason }),
        }],
      } as unknown as ModelMessage);
    }
  }

  /**
   * 注册 Agent
   * 
   * 配置优先级（从高到低）：
   * 1. registerAgent 传入的 config（来自 PromptComponent）
   * 2. defaultAgent 配置（来自 ConfigComponent，作为 fallback）
   */
  registerAgent(name: string, config: Partial<AgentInstanceConfig>): AgentInstance {
    // 合并配置：defaultAgent 填充默认值，传入的 config 覆盖
    // 注意：需要显式设置每个字段，避免 spread 操作导致默认值被覆盖的问题
    const mergedConfig = {
      // 基础字段
      type: config.type ?? this.config.defaultAgent.type,
      name,
      // 数值类型字段（显式设置以避免被覆盖）
      maxIterations: config.maxIterations ?? this.config.defaultAgent.maxIterations,
      maxErrorRetries: config.maxErrorRetries ?? this.config.defaultAgent.maxErrorRetries,
      doomLoopThreshold: config.doomLoopThreshold ?? this.config.defaultAgent.doomLoopThreshold,
      toolTimeout: config.toolTimeout ?? this.config.defaultAgent.toolTimeout,
      toolRetries: config.toolRetries ?? this.config.defaultAgent.toolRetries,
      // 字符串类型字段
      // 重要：如果有 systemPromptRef 但没有 systemPrompt，保留 undefined 以便后续延迟解析
      // 只有在没有 systemPromptRef 时才使用默认值
      systemPrompt: config.systemPrompt ?? (config.systemPromptRef ? undefined : this.config.defaultAgent.systemPrompt),
      systemPromptRef: config.systemPromptRef,
      model: config.model ?? this.config.defaultAgent.model,
      behaviorSpecId: config.behaviorSpecId ?? this.config.defaultAgent.behaviorSpecId,
      // 工具过滤字段
      allowedTools: config.allowedTools ?? this.config.defaultAgent.allowedTools,
      deniedTools: config.deniedTools ?? this.config.defaultAgent.deniedTools,
      // History 过滤字段
      filterHistory: config.filterHistory ?? this.config.defaultAgent.filterHistory,
    };

    const instance: AgentInstance = {
      name,
      config: mergedConfig as AgentInstance["config"],
      status: "idle",
      plugins: new Map(),
    };

    this.agents.set(name, instance);

    // ★ Task #2580 — Auto-register MaxIterationReminderPlugin on EVERY agent
    // (default, sub, custom user agents). It injects a user-role reminder at
    // iteration === maxIterations to ensure the sub-agent returns a meaningful
    // summary (or at least a placeholder) instead of silently looping out.
    // - All-agents scope (no agentName filter)
    // - Hook: agent:before.llm
    // - Idempotent via plugin.name dedup in agent.plugins Map
    this.registerPlugin(name, createMaxIterationReminderPlugin());

    // ★ Task #5081 — sub-agent 感知「任务被添加操作记录」
    // (TaskOpWatermarkPlugin, all-agents scope, same meta-protocol).
    // taskComponent 惰性解析：registerAgent 可能早于 TaskComponent
    // 注册，闭包把 getComponent("task") 推迟到首次 execute()
    // （env 组件已就绪）。plugin 内部对 undefined 防御性跳过。
    this.registerPlugin(
      name,
      createTaskOpWatermarkPlugin({
        resolveTaskComponent: () =>
          this.env?.getComponent?.("task") as any,
      }),
    );

    logger.info(`Agent registered: ${name}`, { type: instance.config.type });
    return instance;
  }

  /**
   * 注销 Agent
   */
  unregisterAgent(name: string): boolean {
    const deleted = this.agents.delete(name);
    if (deleted) {
      logger.info(`Agent unregistered: ${name}`);
    }
    return deleted;
  }

  /**
   * 注册 Plugin 到指定 Agent
   */
  registerPlugin(agentName: string, plugin: Plugin): void {
    const agent = this.agents.get(agentName);
    if (!agent) {
      throw new Error(`Agent not found: ${agentName}`);
    }

    agent.plugins.set(plugin.name, plugin);
    logger.info(`Plugin registered: ${plugin.name} to ${agentName}`, {
      hooks: plugin.hooks.map(h => h.point),
    });
  }

  /**
   * 注销 Plugin
   */
  unregisterPlugin(agentName: string, pluginName: string): boolean {
    const agent = this.agents.get(agentName);
    if (!agent) {
      return false;
    }

    const deleted = agent.plugins.delete(pluginName);
    if (deleted) {
      logger.info(`Plugin unregistered: ${pluginName} from ${agentName}`);
    }
    return deleted;
  }

  /**
   * 设置默认工具列表
   */
  setDefaultTools(tools: Tool[]): void {
    this.defaultTools = tools;
  }

  /**
   * 获取可用工具
   */
  getAvailableTools(agent: AgentInstance, context?: AgentContext): Tool[] {
    // ★ 2026-07-15 修复 review #14143 Medium #3：
    //   之前 defaultTools 和 extraTools 路径未应用 allowedAgentTypes 过滤，
    //   导致通过 setDefaultTools 注入或 AgentContext.extraTools 传入的工具
    //   可以绕过 Tool.metadata.allowedAgentTypes 可见性。
    //   修复：抽出 filterToolsByAgent() 在三个入口都应用一次。
    //
    // 1. defaultTools（来自 setDefaultTools 的 Memory Agent tools）— 之前未过滤
    const extendTools = context?.extendTools;
    let tools: Tool[] = filterToolsByAgent([...this.defaultTools], agent, extendTools);

    logger.debug(`[getAvailableTools] After defaultTools (filtered): ${tools.length} tools`, {
      toolNames: tools.map(t => t.name)
    });

    // 2. 如果有 ToolComponent，从组件获取
    if (this.toolComponent?.listTools) {
      // 类型转换：ToolComponent 的 Tool 与 AgentComponent 的 Tool 兼容
      // 传入 allowedAgent 让工具级 allowedAgentTypes 过滤生效（2026-07）
      const componentTools = this.toolComponent.listTools({
        allowedAgent: agent.name,
      }) as unknown as Tool[];
      // ⚠️ **channelOnly 可见性的唯一收敛点，勿删**（DS review 第 2 轮 MINOR-2）。
      //   ToolRegistry.listTools() 只过滤 allowedAgentTypes，**不做**
      //   channelOnly 过滤（它是存储目录，`tools list` / 调试路径会用到）。
      //   所以 channelOnly 的放行完全由这里承担 —— 删掉这一行会让
      //   wecom_respond 等渠道专用工具对所有 agent 泄露（Task #5333）。
      const filteredComponentTools = filterToolsByAgent(componentTools, agent, extendTools);
      tools = [...tools, ...filteredComponentTools];
      logger.debug(`[getAvailableTools] After adding componentTools: ${tools.length} tools`, {
        componentToolNames: filteredComponentTools.map(t => t.name)
      });
    }

    // 获取工具过滤配置（context 优先于 agent 配置）
    const allowedTools = context?.allowedTools ?? agent.config.allowedTools;
    const deniedTools = context?.deniedTools ?? agent.config.deniedTools;

    logger.debug(`[getAvailableTools] Filtering: allowed=${allowedTools}, denied=${deniedTools}`);

    // 应用 allowedTools 过滤
    // 注意：allowedTools 可为 undefined（不过滤）或数组（白名单过滤）
    // 空数组 [] 表示不允许任何工具，必须与 undefined 区分
    if (allowedTools !== undefined && allowedTools !== null) {
      tools = tools.filter(t => allowedTools.includes(t.name));
      logger.debug(`[getAvailableTools] After allowedTools filter: ${tools.length} tools`, {
        toolNames: tools.map(t => t.name)
      });
    }

    // 应用 deniedTools 过滤
    if (deniedTools?.length) {
      tools = tools.filter(t => !deniedTools.includes(t.name));
      logger.debug(`[getAvailableTools] After deniedTools filter: ${tools.length} tools`, {
        toolNames: tools.map(t => t.name)
      });
    }

    // 3. 追加 extraTools（上下文级别，不受 allowedTools/deniedTools 过滤）
    //    ★ 2026-07-15 修复：extraTools 路径也应用 allowedAgentTypes 过滤
    if (context?.extraTools?.length) {
      const filteredExtraTools = filterToolsByAgent(context.extraTools, agent, extendTools);
      tools = [...tools, ...filteredExtraTools];
      logger.debug(`[getAvailableTools] After extraTools (filtered): ${tools.length} tools`, {
        extraToolNames: filteredExtraTools.map(t => t.name)
      });
    }

    logger.debug(`[getAvailableTools] Final tools: ${tools.length}`, {
      toolNames: tools.map(t => t.name)
    });

    return tools;
  }

  /**
   * 执行 Agent
   * 
   * @param agentName Agent 名称
   * @param query 用户查询
   * @param context 执行上下文
   * @returns Agent 执行结果
   */
  async run(
    agentName: string,
    query: string | ContentPart[],
    context?: AgentContext
  ): Promise<AgentRunResult> {
    return this._run(agentName, query, context);
  }

  private pushMessage(hookCtx: HookContext, message: ModelMessage){
    hookCtx.messages.push(message);
    this.notifyMessageAdded(message);
  }

  /**
   * ✅ META PROTOCOL helper #1 — Task #2170.
   * Captures (reads-and-deletes) the `toAddFakeUserMessage` metadata set by plugins
   * such as `AutoTaskPlugin`. Idempotent: subsequent calls return undefined.
   *
   * Returns the captured `ModelMessage` (or undefined). The caller is responsible
   * for storing it in `pendingFakeUserMessage` and pushing it AFTER all
   * tool-results in the iteration complete (see `flushPendingFakeUserMessage`).
   *
   * Span: `agent.meta-protocol.consumeUserMessage`
   */
  @TracedAs("agent.meta-protocol.consumeUserMessage", { recordParams: false, recordResult: false, log: true })
  private consumeMetaProtocolUserMessage(hookCtx: HookContext): ModelMessage | undefined {
    const toolResultMeta = (hookCtx.toolResult as any)?.result?.metadata;
    if (!toolResultMeta || !("toAddFakeUserMessage" in toolResultMeta)) {
      return undefined;
    }
    const userMsg = toolResultMeta.toAddFakeUserMessage as ModelMessage | undefined;
    // Always delete the metadata to ensure idempotency (only one capture per plugin-request).
    delete toolResultMeta.toAddFakeUserMessage;
    if (!userMsg || (userMsg as any).role !== "user") {
      return undefined;
    }
    return userMsg;
  }

  /**
   * ✅ META PROTOCOL helper #2 — Task #2170.
   * Pushes the previously-captured `toAddFakeUserMessage` to `ctx.messages`.
   * Called ONCE per ReAct iteration AFTER the for-loop ends, so the user message
   * is appended after ALL tool-results (not between them), preserving AI SDK v6's
   * strict `tool_call` ↔ `tool_result` adjacency requirement.
   *
   * Span: `agent.meta-protocol.flushPendingUserMessage`
   */
  @TracedAs("agent.meta-protocol.flushPendingUserMessage", { recordParams: false, recordResult: false, log: true })
  private flushPendingFakeUserMessage(hookCtx: HookContext, pendingMsg: ModelMessage, iter: number): void {
    this.pushMessage(hookCtx, pendingMsg);
    logger.debug(
      `[ReAct] Meta-protocol: flushed user message AFTER all tool-results (iter=${iter})`
    );
  }

  /**
   * 执行 Agent（核心方法，内部实现）
   */
  /**
   * ★ 2026-10-22：**只存摘要**（Task #4479，CV 发现的漏网之鱼）。
   *
   * 实测：`agent.component.run` 单 span attributes 达 **70 KB**，
   * `query` 多模态时（base64 图片）可达 MB 级 ——
   * 等于把上一级 `env.handle_query` 省下来的体积**又吐回去一层**。
   */
  @TracedAs("agent.component.run", {
    paramFilter: agentRunParamFilter,
    recordResult: false,
    logResult: true,
    log: true,
  })
  private async _run(
    agentName: string,
    query: string | ContentPart[],
    context?: AgentContext
  ): Promise<AgentRunResult> {
    // 刷新依赖组件引用（确保获取到最新的组件）
    await this.refreshDependencies();
    
    const agent = this.getAgent(agentName);
    if (!agent) {
      throw new Error(`Agent not found: ${agentName}`);
    }

    // Task #2606 Fix #4 — explicitly reject empty / whitespace-only caller-
    // provided runIds. Without this, an empty runId would fall through to the
    // `?? internalRunId` fallback only when the caller didn't pass anything at
    // all, but a literal `""` would be truthy-checked past and silently leak
    // into the aborted/abortControllers Maps (used by abortRun() as a key).
    // We throw early so callers cannot accidentally pollute the abort registry.
    if (context?.runId !== undefined && context.runId.trim() === "") {
      throw new Error(
        `AgentComponent._run: caller-provided runId must not be empty`,
      );
    }

    // Task #2590 follow-up — caller-provided runId takes priority.
    // The caller (typically BackgroundTaskManager.executeWithAbort) pre-allocates
    // a unique runId so it can record (runId, taskRecord) BEFORE the run starts
    // and abort this specific run later via abortRun(runId).
    // If not provided, fall back to the internal counter (backward compat).
    //
    // We do NOT enforce a "must start with `${agentName}:`" prefix because the
    // actual agent that runs may resolve through an entry-agent (e.g. workflow
    // subagents are routed to `workflow-runner`); the caller doesn't always know
    // the resolved agentName. We do enforce uniqueness — the runId must not
    // already be present in either abort bookkeeping map.
    const internalRunId = `${agentName}:${++this.runCounter}`;
    const runId = context?.runId ?? internalRunId;
    if (context?.runId) {
      if (this.aborted.has(runId) || this.abortControllers.has(runId)) {
        throw new Error(
          `AgentComponent._run: caller-provided runId '${runId}' is already in use`,
        );
      }
    }
    // 多模态 query (ContentPart[]) 在日志中只取 text part 摘要
    const querySummary = typeof query === "string"
      ? query.substring(0, 100)
      : query
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join(" ")
          .substring(0, 100) || "[multimodal query]";
    logger.info(`Starting agent run: ${agentName} (runId=${runId})`, { query: querySummary });
    
    // Mark agent as running
    agent.status = "running";
    this.aborted.set(runId, false);

    // Create AbortController for this agent run
    const abortController = new AbortController();
    this.abortControllers.set(runId, abortController);

    // Initialize doom loop cache for this agent
    if (!this.doomLoopCaches.has(runId)) {
      this.doomLoopCaches.set(runId, new Map());
    }

    // 确保 systemPrompt 被正确解析（处理 PromptComponent 延迟初始化的情况）
    // 如果 agent 有 systemPromptRef 但 systemPrompt 未设置，尝试从 registry 解析
    await this.resolveSystemPrompt(agent, agentName);

    // 替换 systemPrompt 中的 {{workspace_dir}} 和 {{memory}} 变量
    // 这些变量在通过 agentComponent.run() 直接启动 agent 时不会被 environment.ts 的注入逻辑覆盖
    // （environment.ts 的变量注入只对 handle_query 中创建的 agent 生效）
    //
    // P1-1 修复（Task #1580）：不要原地修改 `agent.config.systemPrompt`。
    // 之前每次 run 都会把解析后的字符串写回 agent.config，导致：
    //   1. 原始模板丢失，多轮 run 时无法再次解析占位符
    //   2. memory 字符串随历史累积永久写入 agent.config，泄漏
    // 现在用局部变量 `resolvedSystemPrompt` 持有解析结果，并通过 hookCtx.systemPrompt 传递给 LLM。
    let resolvedSystemPrompt: string | undefined;
    if (agent.config.systemPrompt) {
      resolvedSystemPrompt = agent.config.systemPrompt;
      if (resolvedSystemPrompt.includes('{{workspace_dir}}')) {
        const workspaceDir = (this.env?.getComponent?.('config') as ConfigComponent | undefined)?.get?.('workspace_dir') || process.cwd();
        resolvedSystemPrompt = resolvedSystemPrompt.replaceAll('{{workspace_dir}}', String(workspaceDir));
      }
      // 【Task #2744】{{memory}} 替换延后到 cacheSnapshot 创建后执行（如果有 sessionId）
      // 原因：先做 cacheSnapshot 检查，如果 session 已经有 snapshot，则 {{memory}} 已经在
      // snapshot 中替换过，无需再次调用 recallMemory()，避免跨 run 重新计算 → cache miss。
      // 对于无 sessionId 的情况（sub-agent / 单元测试等），在下方 fallback 中执行替换。
    }

    // Merge context
    const effectiveContext: AgentContext = {
      ...context,
      agentType: agent.config.type,
      model: (context?.model) ?? agent.config.model,
      // 【修复 Code Review v2 报告 C1】把 metadata.traceId 提升到顶层 traceId
      // 下游消费者（如 auto-task-plugin 的 per-query 去重）依赖 ctx.context.traceId
      // 来实现 per-query 维度的精确去重。如果 traceId 一直为 undefined，
      // 去重会退化为按 sessionId 进行，等价于 per-query 去重功能未生效。
      // 优先级：context.metadata.traceId > context.traceId
      // rationale：AgentContext.metadata 是 trace 身份的规范载体，顶层
      // context.traceId 保留作为 legacy 调用点的 fallback。
      traceId:
        (context?.metadata as Record<string, unknown> | undefined)?.traceId as
          | string
          | undefined ??
        context?.traceId,
      // Task #2106 GREEN-A: compose the agent's internal abortController
      // signal with any incoming context.abort (per-run deadline signal,
      // executor external signal). Either source aborting must interrupt
      // the in-flight invoke, and abort(agentName) must still work through
      // the internal abortController.signal.
      abort: context?.abort
        ? AbortSignal.any([abortController.signal, context.abort])
        : abortController.signal,
    };

    // Initialize result
    const result: AgentRunResult = {
      iterations: 0,
      toolCalls: [],
    };

    // Phase B.11+: EventSource systemPrompt 注入
    // ------------------------------------------------------------------
    // EventSource（如 bounty-im）可在 EventSourceConfig.systemPrompt 配置专属 prompt，
    // 经过 EventSourceComponent 透传到 envEvent.metadata.systemPrompt，
    // 再经过 queryExecutor.execute → AgentComponent.run 的 context.metadata 抵达这里。
    //
    // 行为：把 EventSource systemPrompt 追加到 agent 已有 systemPrompt 之后（不覆盖）。
    // - 如果 agent 没有 systemPrompt，则直接使用 EventSource systemPrompt
    // - 多个 EventSource 同时触发时（罕见）：后者覆盖前者（保留最后一次），
    //   但当前架构下同一次 execute 只来自一个 event，竞态风险低。
    const eventSourceSystemPrompt = (context?.metadata as Record<string, unknown> | undefined)?.systemPrompt as
      | string
      | undefined;
    if (eventSourceSystemPrompt) {
      if (resolvedSystemPrompt) {
        resolvedSystemPrompt = resolvedSystemPrompt + "\n\n" + eventSourceSystemPrompt;
      } else {
        resolvedSystemPrompt = eventSourceSystemPrompt;
      }
    }

    // ================================================================
    // 【Task #2744】session-scope cache snapshot（对齐 pi-agent 96.6-96.8% cache 命中率）
    // ================================================================
    // 把 systemPrompt（{{memory}} 已替换 + 构建时注入的渠道 prompt）和 additionInfo
    // 绑定到 session 生命周期：构建一次后一直用 → 字节级一致。
    //
    // ★ Task #5224：快照改为**内存级**（`_cacheSnapshots`，key=sessionId），
    //   **不持久化** sessions.db，**不做失效检测**。
    //
    // ★ 2026-10-16 修复（sub-agent prompt 污染）：
    //   snapshot 是 **primary agent** 的 prompt-cache 优化，必须限定 primary 才能生效。
    //
    //   反例（生产 traceId=83eadac2316d5be7529ca42ce7057d63）：
    //     SessionComponent.compact() 调 `run("compact", ..., { sessionId: <父 session> })`
    //     —— compact 是 sub agent，为了读父 session 全量历史而复用了父 sessionId。
    //     父 session 已有 snapshot（内容 = default 接待员 prompt），于是 systemPromptOverride
    //     把 compact 自己的「Session Checkpoint Generator」prompt 覆盖成了接待员 prompt。
    //     接待员 prompt 里写着「`bash` — 执行简单 shell 命令」，而 compact 的
    //     allowedTools 只有 ['workflow_submit_output'] → LLM 调 bash → `Tool not found: bash`。
    //     又因 maxIterations=1，首轮即终局 → 写出全空 checkpoint（"Untitled Checkpoint"）
    //     → 657 条消息被归档且摘要为空（上下文永久丢失）。
    //
    //   同源影响：compact-hint 的 prompt 同样被覆盖（其 finalText 是
    //     "You are the Roy receptionist agent ..."）。
    //
    //   修复：只有 primary agent 复用 session snapshot；sub agent 一律走
    //   _fallbackReplaceMemory（即 P1-1 的 per-run {{memory}} 替换），保证子 agent
    //   永远拿到自己的 system prompt。
    const useCacheSnapshot = agent.config.type === "primary";
    const { snapshot: cacheSnapshot, systemPromptOverride } = useCacheSnapshot
      ? await this._loadOrCreateCacheSnapshot(
          effectiveContext.sessionId,
          effectiveContext,
          resolvedSystemPrompt,
          agent.config.systemPrompt,
        )
      : { snapshot: null, systemPromptOverride: undefined };
    if (systemPromptOverride !== undefined) {
      // ★ Task #5224：渠道 prompt **在构建时注入**（唯一注入点），
      //   复用轮**不再追加**。
      //
      //   背景（Task #5210/#5217/#5223 的补丁链）：
      //   - fix③（#5217）：snapshot 命中时追加 runtime 的 eventSourceSystemPrompt
      //     —— 因为旧快照（持久化 + 跨进程）创建于渠道 prompt 引入之前
      //   - includes 判重（#5223）：fix③ 追加导致新快照场景重复注入 ×2
      //
      //   现在这两个补丁的**根因都已消除**：
      //   - 快照不再持久化 ⇒ 进程重启后必然重建 ⇒ 快照必定含构建时的渠道 prompt
      //   - 渠道 prompt 是 per-**渠道**常量（ES 实例级缓存），
      //     而 session ↔ chat 一一对应 ⇒ 同 session 恒定同一渠道 prompt
      //   ⇒ 复用轮直接用快照里的那份即可（恰好 1 份，天然不重不漏）。
      resolvedSystemPrompt = systemPromptOverride;
    } else if (resolvedSystemPrompt) {
      // Fallback: 无 sessionId / 非 primary / snapshot 创建失败
      //   → 走原 P1-1 行为（每 run 重新替换 {{memory}}）
      resolvedSystemPrompt = await this._fallbackReplaceMemory(resolvedSystemPrompt);
    }

    // Create HookContext
    // P1-1 修复（Task #1580）：使用 resolvedSystemPrompt（局部变量）而非 agent.config.systemPrompt（持久引用）
    const hookCtx: HookContext = {
      agent,
      iteration: 0,
      maxIterations: agent.config.maxIterations,
      messages: [],
      tools: this.getAvailableTools(agent, effectiveContext),
      systemPrompt: resolvedSystemPrompt ?? agent.config.systemPrompt ?? "You are a helpful assistant.",
      context: effectiveContext,
      // Task #4623: per-run 标识，用于 fallback model 的粘性状态作用域
      _runId: runId,
      // Task #2744: 透传 cacheSnapshot 到 buildMessages（用于稳定 additionInfo）
      ...(cacheSnapshot ? { _cacheSnapshot: cacheSnapshot } : {}),
    };

    // Load session history messages
    let historyMessageCount = 0;
    // Issue #1694 Layer 2: caller-provided messages override (RESERVED).
    //
    // When effectiveContext.messages is provided AND non-empty, use it directly
    // instead of loading from session DB. This is the GREEN handler for the
    // type field added in Layer 1.
    //
    // NOTE: No current caller (as of c6c10707) passes `messages`, so this
    // branch is a no-op in production. It is kept for future callers who need
    // caller-controlled history (e.g., sanitized history injection).
    //
    // Behavior contract:
    //   - messages.length > 0 → use them as hookCtx.messages
    //   - messages is undefined OR empty array → fall through to session DB load
    if (effectiveContext.messages && effectiveContext.messages.length > 0) {
      hookCtx.messages = effectiveContext.messages as unknown as ModelMessage[];
      historyMessageCount = hookCtx.messages.length;
    } else if (effectiveContext.sessionId) {
      try {
        const sessionComponent = this.env.getComponent<SessionComponent>("session");
        if (sessionComponent) {
          // Get conversation history starting from the N-th latest user message
          // This ensures we have complete conversation context
          // Determine filterHistory: context > agent config > default (false)
          const filterHistory = effectiveContext.filterHistory ?? agent.config.filterHistory ?? false;
          const messages = await this.getConversationHistory(
            sessionComponent,
            effectiveContext.sessionId,
            { minUserMessages: 100, filterHistory }
          );

          hookCtx.messages = messages.map(msg => this.messageConverter.toModelMessage(msg)) as unknown as ModelMessage[];
          historyMessageCount = hookCtx.messages.length;
        }
      } catch (err) {
        logger.warn(`Failed to load session history: ${err}`);
      }
    }

    // 全量继承上游 EnvContext，确保 agentContext 引用共享
    const parentEnvContext = getEnvContext();

    // ★ Task #4023 修复：从本次事件（envEvent.metadata）提取 chat↔task 绑定
    // 注入的父任务 ID。event-source-handlers 已把它写进 evt.metadata.parentTaskId，
    // 但此前从未映射进 EnvContext，导致 task_create 的 env 继承分支永远拿不到值。
    // 只接受正整数（0 / 负数 / 非整数一律视为缺失，与 create-tool 的校验一致）。
    const envBoundParentTaskId = resolveEnvParentTaskId(
      effectiveContext.envEvent,
      parentEnvContext,
    );

    // 构建 EnvContext（从 agentContext 提取关键信息 + 父级 ALS 继承）。
    // ★ Blocker 1（#4111）：抽成纯函数 buildRunEnvContext，使 P0-2 replyChannel
    //   优先级修复可被真实生产代码的回归测试覆盖（不再 inline 复刻）。
    const envContext = buildRunEnvContext({
      effectiveContext,
      parentEnvContext,
      envBoundParentTaskId,
    });

    // 在 EnvContext 中执行整个 Agent 循环
    return await runWithEnvContextAsync(envContext, async () => {
      // Send start event via env
      this.pushEnvEvent({
        type: "agent.start",
        payload: {
          sessionId: effectiveContext.sessionId,
          model: effectiveContext.model,
        },
      });

      // Add user query when provided (workflow agents may run without user input)
      if (query) {
        this.pushMessage(hookCtx, {
          role: "user",
          content: query,
        } as unknown as ModelMessage);
      }
      
      // before.start hook
      await this.executePluginHooks(agent, "agent:before.start", hookCtx);
      if (hookCtx._stopped) {
        return this.finalizeResult(result, hookCtx);
      }

    // ReAct Loop
    let iteration = 0;
    let finalText: string | undefined;
    // ★ Task #4720 — incremental session persistence.
    // Previously recordSessionMessages() ran only AFTER the whole while-loop,
    // so a long-running sub-agent (e.g. 85 iterations / 30 min) kept every
    // message in memory (hookCtx.messages) and sessions.db showed
    // message_count=0 the whole time — observers (query_background_process /
    // sessions list) could not tell "running" from "dead".
    // We now persist each iteration's new messages at iteration end;
    // the post-loop call below remains as a safety net for messages pushed
    // after the last iteration (final text / error-path tool results).
    // ★ Task #4720 — INVARIANT: hookCtx.messages is APPEND-ONLY for the whole
    // ReAct loop (pushMessage appends; nothing splices/shifts/filters it).
    // persistedMessageCount is therefore a stable ARRAY INDEX into
    // hookCtx.messages. If a future plugin mutates that array in place
    // (e.g. context compaction that splices old messages out), the index
    // would drift and slice() could skip or duplicate messages.
    // Any such plugin must go through a path that keeps the array append-only.
    let persistedMessageCount = historyMessageCount;

    while (iteration < agent.config.maxIterations) {
      // Check _stopped state (may be set by previous iteration's hooks)
      if (hookCtx._stopped) {
        break;
      }

      // Check abort
      if (this.aborted.get(runId)) {
        hookCtx._stopped = true;
        hookCtx._stopReason = "aborted";
        break;
      }

      // Check abort signal
      if (effectiveContext.abort?.aborted) {
        hookCtx._stopped = true;
        hookCtx._stopReason = "abort_signal";
        break;
      }

      iteration++;
      hookCtx.iteration = iteration;
      result.iterations = iteration;

      logger.debug(`Iteration ${iteration} started`);

      // Reset doom loop cache at the start of each iteration
      // Doom loop detection should only apply within a single LLM response cycle
      this.doomLoopCaches.set(runId, new Map());

      // Reset currentToolCall at the start of each iteration
      // If not reset, a stale currentToolCall from a previous iteration can cause
      // orphaned tool result messages in the catch(error) handler when the LLM
      // throws a ContextError in the current iteration.
      // See Bug: "Messages with role 'tool' must be a response to a preceding
      // message with 'tool_calls'"
      hookCtx.currentToolCall = undefined;

      // 设置迭代信息，供 before.llm hook 使用（如 ReminderPlugin）
      hookCtx.maxIterations = agent.config.maxIterations;

      // Task #1975 (orphan tool-call bug fix):
      // Hoist iterAllToolCalls / iterProcessedCount to outer scope so the
      // outer catch (below) can call addRemainingToolResults() when an
      // exception (e.g. AskUserError) leaves some tool calls in the
      // assistant message without matching tool-result parts.
      //
      // Without this, the AI SDK v6 prompt converter raises
      // MissingToolResultsError on the next user input, surfacing to
      // users as:
      //   "AI_MissingToolResultsError: Tool results are missing for
      //    tool calls call_xxx, call_xxx, call_xxx"
      // right after ask_user times out and they type "hi".
      let iterAllToolCalls: any[] = [];
      let iterProcessedCount = 0;

      try {
        
        // 记录消息构建结果
        logger.debug(`[ReAct] Iteration ${iteration} buildMessages result: ${hookCtx.messages.length} messages`);

        // before.llm hook
        await this.executePluginHooks(agent, "agent:before.llm", hookCtx);
        if (hookCtx._stopped) break;

        // Call LLM
        const llmOutput = await this.invokeLLM(hookCtx);
        hookCtx.llmOutput = llmOutput;

        // Check abort after LLM call (important: abort might have interrupted the call)
        if (this.aborted.get(runId) || effectiveContext.abort?.aborted) {
          hookCtx._stopped = true;
          hookCtx._stopReason = "aborted";
          break;
        }

        // Task #1975 (orphan tool-call bug fix): hoist iterAllToolCalls and
        // iterProcessedCount to outer scope so the catch block below can call
        // addRemainingToolResults() when an exception (e.g. AskUserError)
        // leaves some tool calls in the assistant message without matching
        // tool-result parts. Without this, the AI SDK v6 prompt converter
        // raises MissingToolResultsError on the next user input.

        // after.llm hook
        await this.executePluginHooks(agent, "agent:after.llm", hookCtx);
        if (hookCtx._stopped) break;

        // Process LLM output
        if (llmOutput.content && !llmOutput.toolCalls?.length) {
          // Check abort before adding message and breaking
          if (this.aborted.get(runId) || effectiveContext.abort?.aborted) {
            hookCtx._stopped = true;
            hookCtx._stopReason = "aborted";
            break;
          }

          finalText = llmOutput.content;
          
          // Build content parts array: text + reasoning (if present)
          const assistantParts: any[] = [
            { type: "text" as const, text: llmOutput.content },
          ];
          if (llmOutput.reasoning) {
            assistantParts.push({
              type: "reasoning" as const,
              text: llmOutput.reasoning,
              reasoningType: "core" as const,
            });
          }
          
          this.pushMessage(hookCtx, {
            role: "assistant",
            content: assistantParts,
          } as unknown as ModelMessage);
          break;
        }

        if (llmOutput.toolCalls?.length) {
          // Add assistant message with tool calls to messages (CRITICAL: must be before tool results)
          // AI SDK v6 format: assistant message with content array containing text/reasoning/tool-call parts
          
          // Build assistant message content parts: text/reasoning + tool-call parts
          const assistantParts: any[] = [];
          
          // 1. Add text content if present
          if (llmOutput.content) {
            assistantParts.push({
              type: "text" as const,
              text: llmOutput.content,
            });
          }
          
          // 2. Add reasoning content if present (for reasoning models)
          if (llmOutput.reasoning) {
            assistantParts.push({
              type: "reasoning" as const,
              text: llmOutput.reasoning,
              reasoningType: "core",
            });
          }
          
          // 3. Add tool-call parts
          for (const tc of llmOutput.toolCalls) {
            let argsStr = "";
            let argsObj: Record<string, unknown> = {};
            
            // 提取参数：优先从 function.arguments 获取
            if (tc.function?.arguments) {
              if (typeof tc.function.arguments === "string") {
                argsStr = tc.function.arguments;
                argsObj = safeParseToolArgs(argsStr);
              } else {
                argsObj = tc.function.arguments as Record<string, unknown>;
                argsStr = JSON.stringify(argsObj);
              }
            } else if (tc.arguments) {
              if (typeof tc.arguments === "string") {
                argsStr = tc.arguments;
                argsObj = safeParseToolArgs(argsStr);
              } else {
                argsObj = tc.arguments as Record<string, unknown>;
                argsStr = JSON.stringify(argsObj);
              }
            }
            
            assistantParts.push({
              type: "tool-call" as const,
              toolCallId: tc.id,
              toolName: tc.function?.name || tc.name || "unknown",
              // 关键修复：添加 input 字段供 session-message-converter 读取和存储
              input: argsObj,
              // 保留 toolCall 以兼容某些依赖此结构的代码
              toolCall: {
                name: tc.function?.name || tc.name || "unknown",
                arguments: argsStr,
              }
            });
          }
          
          // 记录添加 assistant 消息
          const assistantContent = llmOutput.content?.substring(0, 80) || "(no text)";
          const toolCallNames = llmOutput.toolCalls?.map(tc => tc.function?.name || tc.name).join(", ") || "none";
          logger.debug(`[ReAct] Iteration ${iteration} Adding assistant message: text="${assistantContent}" toolCalls=[${toolCallNames}]`);
          
          this.pushMessage(hookCtx, {
            role: "assistant",
            content: assistantParts,
          } as unknown as ModelMessage);

          // Tool calls
          iterAllToolCalls = llmOutput.toolCalls ?? [];
          iterProcessedCount = 0; // Track number of successfully processed tool calls

          // ✅ META PROTOCOL: capture (deferred flush) — see Task #2170.
          // When LLM returns N tool-calls in one iteration, plugin may request a user-reminder
          // via `toolResult.result.metadata.toAddFakeUserMessage`. We CAPTURE here (inside loop)
          // and FLUSH once after the loop ends, so all tool-results come BEFORE the reminder.
          // This preserves AI SDK v6 strict adjacency: [assistant(tool_calls), tool(A), tool(B), tool(C), user(reminder)].
          let pendingFakeUserMessage: ModelMessage | undefined;

          for (const toolCall of iterAllToolCalls) {
            // Check abort before tool execution
            if (this.aborted.get(runId) || effectiveContext.abort?.aborted) {
              hookCtx._stopped = true;
              hookCtx._stopReason = "aborted";
              // Add placeholder results for remaining unprocessed tool calls
              this.addRemainingToolResults(hookCtx, iterAllToolCalls, iterProcessedCount, "Execution aborted");
              break;
            }

            // 优先使用 function.name，兼容旧格式
            const func = toolCall.function;
            const tcName = func?.name || toolCall.name || "unknown";
            // Task #2723: 在共享执行边界统一归一化两种上游 shape
            // (AI SDK `{id, function: {name, arguments: string}}` 与
            //  pi-ai 顶层 `{id, name, arguments: string}`),
            // 一律走 safeParseToolArgs() 避免 Zod "Expected object, received string"。
            const tcArgsParsed = this.parseToolCallArgumentsStrict(toolCall);

            // ★ Task #4231：参数不可解析（上游模型输出损坏，例如 GLM 把文本工具调用
            //   标记混进结构化 arguments / 重复字乱码）→ **绝不拿 {} 去执行工具**，
            //   而是把明确错误回给模型，让它重发；否则会执行乱码命令 + 模型盲目重试。
            if (!tcArgsParsed.ok) {
              const invalidMessage = tcArgsParsed.error ?? "invalid tool arguments";
              logger.warn(
                `[ReAct] 工具参数不可解析，已拒绝执行（未跑任何命令/无副作用）: ` +
                  `tool=${tcName} error=${invalidMessage}`
              );
              this.pushEnvEvent({
                type: "tool.error",
                payload: { error: invalidMessage, toolName: tcName },
              });
              // ① 把错误回给模型（AI SDK v6 要求每个 tool_call 都有对应 tool-result）
              this.pushMessage(hookCtx, {
                role: "tool",
                content: [{
                  type: "tool-result",
                  toolCallId: toolCall.id,
                  toolName: tcName,
                  output: JSON.stringify({
                    success: false,
                    error: invalidMessage,
                    hint: "上一次调用的 arguments 不是合法 JSON（上游输出可能损坏）。请重新调用，并确保 arguments 是合法 JSON 对象，不要包含任何 XML/标记文本。",
                  }),
                }],
              } as unknown as ModelMessage);
              // ② 记入统计（工具未真正执行 → 不算失败工具调用，但要让上层可见）
              hookCtx.toolResult = {
                id: toolCall.id,
                name: tcName,
                success: false,
                result: { success: false, output: "", error: invalidMessage },
              };
              iterProcessedCount++;
              continue;
            }

            const tcArgs = tcArgsParsed.args;

            hookCtx.currentToolCall = {
              id: toolCall.id,
              name: tcName,
              arguments: tcArgs,
            };

            // Doom loop detection
            const doomKey = `${tcName}:${JSON.stringify(tcArgs)}`;
            const agentCache = this.doomLoopCaches.get(runId) || new Map();
            const doomCount = agentCache.get(doomKey) || 0;
            if (doomCount >= agent.config.doomLoopThreshold) {
              hookCtx.error = new Error(`Doom loop detected: ${tcName}`);
              await this.executePluginHooks(agent, "on.error", hookCtx);
              result.error = hookCtx.error.message;
              // Add placeholder results for remaining unprocessed tool calls
              this.addRemainingToolResults(hookCtx, iterAllToolCalls, iterProcessedCount, "Execution aborted: Doom loop detected");
              break;
            }
            agentCache.set(doomKey, doomCount + 1);
            this.doomLoopCaches.set(runId, agentCache);

            // before.tool hook
            await this.executePluginHooks(agent, "agent:before.tool", hookCtx);
            if (hookCtx._stopped) {
              // Add placeholder results for remaining unprocessed tool calls
              this.addRemainingToolResults(hookCtx, iterAllToolCalls, iterProcessedCount, "Execution aborted by plugin hook");
              break;
            }

            // Execute tool
            const toolResult = await this.executeTool(hookCtx);
            hookCtx.toolResult = toolResult;

            // after.tool hook
            await this.executePluginHooks(agent, "agent:after.tool", hookCtx);
            if (hookCtx._stopped) {
              // Add placeholder results for remaining unprocessed tool calls
              this.addRemainingToolResults(hookCtx, iterAllToolCalls, iterProcessedCount + 1, "Execution aborted by plugin hook");
              break;
            }

            // Add tool result to messages (AI SDK v6 format)
            //
            // Task #2391 (v0.7.3 unknown-error hardening): the previous
            // expression `toolResult.result.error || "Unknown error"` silently
            // dropped the runId + any recovery hint when the tool's error
            // field was empty (e.g. an upstream exception with empty message,
            // or a serializer that stripped the error). The LLM then saw a
            // bare "Unknown error" and couldn't query status or resume.
            //
            // We delegate to `composeToolOutputForLLM` (exported above for
            // testability) which produces a structured diagnostic from
            // whatever runId / status / metadata bits are present.
            const toolOutput = composeToolOutputForLLM(
              toolResult.name,
              toolResult.result,
            );
            const toolOutputPreview = typeof toolOutput === "string" ? toolOutput.substring(0, 50) : JSON.stringify(toolOutput).substring(0, 50);
            logger.debug(`[ReAct] Iteration ${iteration} Adding tool message: tool=${toolResult.name} output="${toolOutputPreview}..."`);

            this.pushMessage(hookCtx, {
              role: "tool",
              content: [{
                type: "tool-result",
                toolCallId: hookCtx.currentToolCall!.id,
                toolName: toolResult.name,
                output: toolOutput,
              }],
            } as unknown as ModelMessage);

            // ✅ META PROTOCOL: capture (deferred flush) — see Task #2170.
            // Plugins (e.g., AutoTaskPlugin) can set hookCtx.toolResult.result.metadata.toAddFakeUserMessage
            // in the agent:after.tool hook to request a user-role message AFTER the tool result(s).
            // We CAPTURE it here (per-tool-call inside the for-loop) into local `pendingFakeUserMessage`
            // and FLUSH it once AFTER the for-loop ends, so all tool-results precede the reminder.
            // This preserves AI SDK v6 strict adjacency:
            //   [assistant(tool_calls), tool(A), tool(B), tool(C), user(reminder)]
            {
              const captured = this.consumeMetaProtocolUserMessage(hookCtx);
              if (captured) {
                pendingFakeUserMessage = captured;
                logger.debug(
                  `[ReAct] Meta-protocol: captured user message (tool=${toolResult.name}, iter=${iteration}); will flush after loop`
                );
              }
            }

            // Record tool call
            result.toolCalls.push(hookCtx.currentToolCall);
            iterProcessedCount++;
          }

          // ✅ META PROTOCOL flush: AFTER the for-loop ends, push the captured user message
          // (if any) so it follows ALL tool-results in the iteration. See Task #2170.
          if (pendingFakeUserMessage) {
            this.flushPendingFakeUserMessage(hookCtx, pendingFakeUserMessage, iteration);
          }

          // on.iteration hook
          await this.executePluginHooks(agent, "agent:on.iteration", hookCtx);

          // ★ Task #4720 — persist this iteration's messages now.
          // Keeps sessions.db fresh during long-running sub-agent runs
          // (delegate_task bg tasks), so message_count reflects progress
          // instead of staying 0 until the loop ends.
          if (effectiveContext.persistSession !== false) {
            const iterNewMessages = hookCtx.messages.slice(persistedMessageCount);
            if (iterNewMessages.length > 0) {
              const persisted = await this.recordSessionMessages(
                effectiveContext.sessionId,
                iterNewMessages
              );
              // ★ Task #4720 (DS review MINOR 3): only advance the cursor when the
              // batch was actually persisted. On failure the messages stay in
              // hookCtx.messages and the post-loop safety net retries them.
              if (persisted) {
                persistedMessageCount = hookCtx.messages.length;
              } else if (effectiveContext.sessionId) {
                // Only warn when there IS a session to write to — a missing
                // sessionId is a normal (non-persistable) configuration, not a
                // persistence failure. (DS review round-2 MINOR 3)
                logger.warn(
                  `[agent.component.run] Iteration ${iteration} session persist failed — ` +
                  `keeping ${iterNewMessages.length} message(s) for the post-loop retry.`
                );
              }
            }
          }
        }
      } catch (error) {
        logger.error(`Iteration ${iteration} error`, { error });
        hookCtx.error = error instanceof Error ? error : new Error(String(error));
        
        // ✅ ContextError 特殊处理：在抛出异常前，保存 LLM response 到 messages
        // 这样 session 中会有完整的 assistant message，后续 compact 可以正确提取信息
        if (error instanceof ContextError && error.llmOutput) {
          const llmOutput = error.llmOutput;
          
          if (llmOutput.toolCalls?.length) {
            // 如果 LLM 返回了 tool calls，保存带 tool call 的 assistant message
            const assistantParts: any[] = [];
            
            if (llmOutput.content) {
              assistantParts.push({
                type: "text" as const,
                text: llmOutput.content,
              });
            }
            
            if (llmOutput.reasoning) {
              assistantParts.push({
                type: "reasoning" as const,
                text: llmOutput.reasoning,
                reasoningType: "core" as const,
              });
            }
            
            for (const tc of llmOutput.toolCalls) {
              const tcInput = typeof tc.function?.arguments === "string" 
                ? safeParseToolArgs(tc.function!.arguments)
                : tc.arguments || {};
              assistantParts.push({
                type: "tool-call" as const,
                toolCallId: tc.id,
                toolName: tc.function?.name || tc.name || "unknown",
                input: tcInput,
              });
            }
            
            this.pushMessage(hookCtx, {
              role: "assistant",
              content: assistantParts,
            } as unknown as ModelMessage);

            // ✅ Task #4992 (Defence 1, orphan tool-call fix):
            // The ContextError fired in finalizeOutput AFTER the LLM
            // already returned tool-calls — but `iterAllToolCalls`
            // still holds the PREVIOUS iteration's value at this
            // point, so the generic post-loop
            // `addRemainingToolResults(...)` below NEVER fires for
            // this iteration's calls. Persist matching placeholder
            // tool-results right here, or the pending tool-calls
            // land in sessions.db with no results → next AI SDK
            // fallback throws AI_MissingToolResultsError and kills
            // the run (production kill chain: Task #4983,
            // session_1bba0d11).
            this.addRemainingToolResults(
              hookCtx,
              llmOutput.toolCalls,
              0,
              "[Tool result missing: run interrupted] ContextError",
            );
          } else if (llmOutput.content) {
            // 如果 LLM 返回了文本内容（无 tool calls），保存 assistant message
            const assistantParts: any[] = [];
            
            if (llmOutput.content) {
              assistantParts.push({
                type: "text" as const,
                text: llmOutput.content,
              });
            }
            
            if (llmOutput.reasoning) {
              assistantParts.push({
                type: "reasoning" as const,
                text: llmOutput.reasoning,
                reasoningType: "core" as const,
              });
            }
            
            this.pushMessage(hookCtx, {
              role: "assistant",
              content: assistantParts.length > 0 ? assistantParts : llmOutput.content,
            } as unknown as ModelMessage);
          }
        }
        
        await this.executePluginHooks(agent, "agent:on.error", hookCtx);
        
        // 设置 _stopped 标志（如果还没有被设置）
        if (!hookCtx._stopped) {
          hookCtx._stopped = true;
          // 如果是 AskUserError，特殊处理
          if (error instanceof AskUserError) {
            hookCtx._stopReason = "ask-user";

            // ✅ 关键修复：当 ask_user 抛出异常时，也需要添加 tool result 消息
            // 这样可以保证 session 中有完整的 tool-call + tool-result 配对
            // Resume 时可以用用户响应替换这个 tool result
            if (hookCtx.currentToolCall) {
              this.pushMessage(hookCtx, {
                role: "tool",
                content: [{
                  type: "tool-result",
                  toolCallId: hookCtx.currentToolCall.id,
                  toolName: "ask_user",
                  output: JSON.stringify({
                    error: "AskUserError",
                    query: error.query,
                    message: error.message,
                  }),
                }],
              } as unknown as ModelMessage);
            }

            // 将 AskUserError 信息编码到 result.error 中，供 AgentComponentAdapter 检测和恢复抛出
            // 使用 JSON 编码避免 query 中包含冒号导致解析错误
            //
            // ★ Task #4983：带上 `delivered` 标记（工具层是否已把问题投到 IM 渠道）。
            //   - true  → CLI 层**不**再兜底投递（防用户收到两条）
            //   - false → CLI 层**要**兜底投递（工具层没投成，问题会静默消失）
            const errorInfo = {
              query: error.query,
              sessionId: error.sessionId,
              nodeId: error.nodeId,
              nodeType: error.nodeType,
              agentSessionId: error.agentSessionId,
              delivered: error.delivered === true,
            };
            result.error = `__ASK_USER_ERROR__:${JSON.stringify(errorInfo)}`;
          } else {
            // 其他错误 - 也需要添加 tool result 消息保持配对完整
            result.error = hookCtx.error.message;
            // 保留原始错误对象（用于 ContextError 等类型检测）
            if (error instanceof Error) {
              result.originalError = error;
            }
            // 如果是 AbortError，保留 abort 相关的 reason
            if ((error as any)?.name === "AbortError") {
              hookCtx._stopReason = hookCtx._stopReason || "aborted";
            } else {
              hookCtx._stopReason = "error";
            }

            // ✅ 添加 tool result 消息（包含错误信息）
            if (hookCtx.currentToolCall) {
              this.pushMessage(hookCtx, {
                role: "tool",
                content: [{
                  type: "tool-result",
                  toolCallId: hookCtx.currentToolCall.id,
                  toolName: hookCtx.currentToolCall.name,
                  output: JSON.stringify({ error: hookCtx.error.message }),
                }],
              } as unknown as ModelMessage);
            }
          }

          // ✅ Task #1975 (orphan tool-call bug fix):
          // Close the remaining unprocessed tool calls (those AFTER the
          // failing one in this iteration) with placeholder tool-result
          // messages. Without this, the assistant message at the top of
          // the assistant→tool(s)→... block contains tool-call parts
          // whose tool-result parts never arrive, and the AI SDK v6
          // prompt converter raises MissingToolResultsError on the next
          // user input — surfacing to users as:
          //   "AI_MissingToolResultsError: Tool results are missing for
          //    tool calls call_xxx, call_xxx, call_xxx"
          //
          // iterProcessedCount reflects the number of tool calls that
          // were successfully executed BEFORE the failing one. So we
          // want to skip that failing one (iterProcessedCount + 1) and
          // emit placeholders for everything after.
          if (iterAllToolCalls.length > 0 && iterProcessedCount + 1 < iterAllToolCalls.length) {
            const orphanReason = error instanceof AskUserError
              ? "ask_user: tool execution aborted (user did not respond or session resumed before answering)"
              : `Execution aborted by tool error: ${error instanceof Error ? error.message : String(error)}`;
            this.addRemainingToolResults(
              hookCtx,
              iterAllToolCalls,
              iterProcessedCount + 1,
              orphanReason,
            );
          }
        } else {
          // 如果 _stopped 已经被设置为 true（例如在 executeTool 中），保留错误信息
          result.error = hookCtx.error.message;

          // ✅ 即使 _stopped 已为 true，也需要添加 tool result 消息
          // 这确保即使在 abort/doom-loop 等场景下，消息配对也是完整的
          if (hookCtx.currentToolCall) {
            const errorMsg = hookCtx.error?.message || "Execution interrupted";
            this.pushMessage(hookCtx, {
              role: "tool",
              content: [{
                type: "tool-result",
                toolCallId: hookCtx.currentToolCall.id,
                toolName: hookCtx.currentToolCall.name,
                output: JSON.stringify({ error: errorMsg }),
              }],
            } as unknown as ModelMessage);
          }
        }
        break;
      }
    }

    // Update result
    result.finalText = finalText;
    if (iteration >= agent.config.maxIterations && !result.finalText) {
      result.finalText = "Maximum iterations reached.";
    }

    const newMessages = hookCtx.messages.slice(persistedMessageCount);

    // ✅ 先把本轮新消息写入 session，再触发 agent:after.react hook
    // 这样 plugin 在 hook 里调用子 agent 时，子 agent 通过 sessionId 能读到完整历史
    // （典型场景：workflow-json-output-plugin 调用 json-extract sub-agent 复用主 session 历史）
    // ★ Task #4720: persistedMessageCount makes this a safety net —
    //   per-iteration messages were already flushed inside the loop;
    //   only messages pushed after the last iteration land here.
    if (effectiveContext.persistSession !== false) {
      const finalPersisted = await this.recordSessionMessages(
        effectiveContext.sessionId,
        newMessages
      );
      // ★ Task #4720 (DS review round-3 MINOR 3): the safety net can fail too
      // (SQLITE_BUSY under load is exactly the long-task scenario). Log it at
      // error level so the loss is visible instead of silent.
      if (!finalPersisted && newMessages.length > 0 && effectiveContext.sessionId) {
        logger.error(
          `[agent.component.run] Final session persist FAILED — ${newMessages.length} message(s) ` +
          `were not written to session ${effectiveContext.sessionId}. Session history is now ` +
          `incomplete relative to the LLM context.`
        );
      }
    } else {
      logger.debug(`Skipping session message recording (persistSession=false, sessionId=${effectiveContext.sessionId})`);
    }

    // ✅ agent:after.react hook - React 循环结束后，用于记忆提取
    const reactContext = {
      messages: hookCtx.messages,
      sessionId: effectiveContext.sessionId,
      summary: result.finalText,
    };
    const mergedHookCtx = { ...hookCtx, ...reactContext };
    await this.executePluginHooks(agent, "agent:after.react", mergedHookCtx);

    // 从 mergedHookCtx 中读取 plugin 写入的 structuredOutputExtracted
    // 注意：必须从 mergedHookCtx 读取，因为 executePluginHooks 修改的是传入的对象
    if (mergedHookCtx.structuredOutputExtracted) {
      result.structuredOutput = mergedHookCtx.structuredOutputExtracted;
    }

    // after.complete hook
    await this.executePluginHooks(agent, "agent:after.complete", hookCtx);

    // Finalize - 根据 abort 状态设置 agent 状态
    if (this.aborted.get(runId) === true || hookCtx._stopped) {
      agent.status = "stopped";
    } else {
      agent.status = "idle";
    }
    // P0-1 修复（Task #1580）：doomLoopCaches 必须在每次 run 结束时清理，
    // 否则在 interactive REPL 多轮会话中每轮泄漏 1 个 Map 引用。
    // 注意：catch 块（1379, 1793）会 fall-through 到这里，因为：
    //   - catch @1379 在 switch 内，break 后落到本清理块
    //   - catch @1793 在 invokeLLM 内，re-throw 由 1379 catch 处理
    // 因此只需在 1 处清理即可覆盖所有退出路径。
    this.aborted.delete(runId);
    this.abortControllers.delete(runId);
    this.doomLoopCaches.delete(runId);
    // Task #4623: fallback 粘性状态是 per-run 的，run 结束必须清理，
    // 否则下一次 run 会沿用旧的降级模型（用户修好额度也回不去）。
    this.fallbackState.delete(runId);

    if (result.error) {
      this.pushEnvEvent({
        type: "agent.error",
        payload: {
          error: result.error,
          iterations: result.iterations,
          stopReason: result.stopReason,
        },
      });
    } else {
      this.pushEnvEvent({
        type: "agent.completed",
        payload: {
          finalText: result.finalText,
          iterations: result.iterations,
          stopReason: result.stopReason,
        },
      });
    }

    logger.info(`Agent run completed: ${agentName}`, {
      iterations: result.iterations,
      hasError: !!result.error,
      hookCtxMessages: hookCtx.messages.length,
      historyMessageCount: historyMessageCount,
      sessionId: effectiveContext.sessionId,
    });
    // 注意：session 消息已在 agent:after.react hook 之前写入（让 plugin 能在 hook 中读到 session）
    // persistSession: false → 跳过 session 持久化（子 agent 复用父 session history 但不污染 DB）

    return this.finalizeResult(result, hookCtx);
    }); // end of runWithEnvContextAsync
  }

  /**
   * 中止 Agent
   * 
   * 调用此方法会：
   * 1. 设置 aborted 标志（用于 ReAct 循环检查）
   * 2. 触发 AbortController.abort()（用于中断正在进行的 LLM 调用）
   * 
   * 注意：不直接修改 agent.status，由 _run() 的 finally 统一处理
   */
  abort(agentName: string): void {
    // 设置 aborted 标志 - 遍历所有该 agent 的 runId
    for (const key of this.aborted.keys()) {
      if (key.startsWith(agentName + ":")) {
        this.aborted.set(key, true);
      }
    }

    // 触发 AbortController 中断正在进行的 LLM 调用
    for (const [key, controller] of this.abortControllers) {
      if (key.startsWith(agentName + ":")) {
        controller.abort();
        logger.debug(`[abort] AbortController.abort() called for run: ${key}`);
      }
    }

    logger.info(`Agent aborted: ${agentName}`);
  }

  /**
   * Task #2590 follow-up — run-scoped abort.
   *
   * Abort a single agent run by its runId, rather than by agent name. The
   * agent-name-scoped `abort(agentName)` is "every concurrent run of the
   * same type" — silent-fail root cause when invoked from a sub-agent's
   * signal listener that escaped after the sub-agent already finished.
   *
   * Caller contract: pass a runId that was either pre-allocated via
   * `AgentContext.runId` and stored on the caller's task record, or
   * otherwise observed through normal AgentComponent logging.
   *
   * Idempotent: aborting an already-aborted or already-finalized run is a
   * no-op. The AbortController itself is also idempotent.
   *
   * @returns true if the runId was found and the abort signal was issued,
   *          false if the runId had already finalized and was removed from
   *          the registry.
   */
  abortRun(runId: string, reason?: string): boolean {
    if (!runId) {
      return false;
    }

    const foundInAborted = this.aborted.has(runId);
    const foundInControllers = this.abortControllers.has(runId);
    if (!foundInAborted && !foundInControllers) {
      logger.debug(`[abort] abortRun: runId not found (already finalized?)`, {
        runId,
        reason,
      });
      return false;
    }

    if (foundInAborted) {
      this.aborted.set(runId, true);
    }

    const controller = this.abortControllers.get(runId);
    if (controller && !controller.signal.aborted) {
      try {
        controller.abort();
      } catch {
        // ignore — AbortController.abort is itself idempotent
      }
    }

    logger.info(`[abort] run-scoped abort`, {
      runId,
      reason,
      currentBgTaskId: getCurrentBgTaskId(),
      currentTaskId: getCurrentTaskId(),
    });
    return true;
  }

  /**
   * 中止所有正在运行的 Agent
   * 
   * 与 abort(name) 不同，此方法会终止全部 Agent run，
   * 包括父 agent 通过 delegate_task 创建的子 agent。
   * 用于 ESC/abort 等用户主动中断场景。
   */
  abortAll(): void {
    // 设置所有 aborted 标志
    for (const key of this.aborted.keys()) {
      this.aborted.set(key, true);
    }
    
    // 触发所有 AbortController
    for (const [key, controller] of this.abortControllers) {
      controller.abort();
      logger.debug(`[abortAll] AbortController.abort() called for run: ${key}`);
    }
    
    logger.info(`All agents aborted (${this.abortControllers.size} runs)`);
  }

  /**
   * 构建消息列表
   * 
   * 注意：ctx.messages 已经包含了历史消息（包括 system prompt 和 user query）
   * 这里只需要构建当前请求的消息，不重复添加
   */
  /**
   * 【Task #2744 / #5224】session-scope cache snapshot —— **内存级**构建/复用
   *
   * 设计目标：把 systemPrompt（{{memory}} 已替换 + **构建时注入的渠道 prompt**）
   * 和 additionInfo 绑定到 session 生命周期，构建一次后一直用
   * → 字节级一致 → LLM prompt cache 命中。
   *
   * ★ Task #5224 变更（用户确认的最终设计）：
   * - 存储：**内存 Map**（`_cacheSnapshots`，key = sessionId），**不持久化** sessions.db
   *   ⇒ 不再把整份 systemPrompt（~102KB）写进 session 行（本地库膨胀主因）
   * - 复用：同 sessionId 直接命中 Map；**不做失效检测**
   *   （`_isMemorySnapshotStale` 已删除）⇒ session 内 memory 变更不生效（冻结）
   * - 注入：渠道 prompt 在**构建时**并入快照（唯一注入点）
   *   ⇒ 不再需要 fix③ 复用轮追加 + includes 判重补丁
   *
   * @returns
   * - snapshot: 冻结的 { systemPrompt, additionInfo, snapshotAt } 快照
   * - systemPromptOverride: 如果 snapshot 命中，覆盖调用方的 resolvedSystemPrompt
   *   （值是 snapshot.systemPrompt，命中时与 snapshot.systemPrompt 相同）
   *
   * 错误处理：所有异常均降级为"返回 null"（调用方走 fallback 路径），不阻塞 run。
   */
  // 返回 systemPrompt + additionInfo（可达数十 KB）→ 只在内存，不入库
  @TracedAs("agent.component.loadOrCreateCacheSnapshot", { recordParams: true, recordResult: false, log: true })
  private async _loadOrCreateCacheSnapshot(
    sessionId: string | undefined,
    effectiveContext: AgentContext,
    initialSystemPrompt: string | undefined,
    agentConfigSystemPrompt: string | undefined,
  ): Promise<{
    snapshot: CacheSnapshot | null;
    systemPromptOverride: string | undefined;
  }> {
    if (!sessionId) {
      return { snapshot: null, systemPromptOverride: undefined };
    }

    try {
      // ★ 内存级复用：命中即返回（无 recallMemory 调用、无失效检测）
      const existingSnapshot = this._cacheSnapshots.get(sessionId);
      if (existingSnapshot) {
        logger.debug(
          `[AgentComponent._run] Reusing cacheSnapshot for session ${sessionId} (snapshotAt=${existingSnapshot.snapshotAt})`
        );
        return {
          snapshot: existingSnapshot,
          systemPromptOverride: existingSnapshot.systemPrompt,
        };
      }

      // First run: 计算 {{memory}} 替换 + 构建 snapshot（内存级）
      let resolvedSystemPrompt = initialSystemPrompt;
      if (resolvedSystemPrompt && resolvedSystemPrompt.includes("{{memory}}")) {
        try {
          const memoryComponent = this.env?.getComponent?.("memory") as { recallMemory?: () => Promise<string> | string } | undefined;
          if (memoryComponent && typeof memoryComponent.recallMemory === "function") {
            const memoryContent = await memoryComponent.recallMemory();
            resolvedSystemPrompt = resolvedSystemPrompt.replaceAll("{{memory}}", memoryContent || "(No memory)");
          } else {
            resolvedSystemPrompt = resolvedSystemPrompt.replaceAll("{{memory}}", "(Memory component not available)");
          }
        } catch (err) {
          logger.warn(`[AgentComponent._run] Failed to replace {{memory}}: ${err}`);
          resolvedSystemPrompt = resolvedSystemPrompt.replaceAll("{{memory}}", "(Failed to load memory)");
        }
      }

      const snapshot: CacheSnapshot = {
        systemPrompt: resolvedSystemPrompt ?? agentConfigSystemPrompt ?? "",
        additionInfo: effectiveContext.additionInfo || "",
        snapshotAt: Date.now(),
      };

      // ★ 内存级存储（进程内），**不写 sessions.db**
      this._cacheSnapshots.set(sessionId, snapshot);
      logger.debug(
        `[AgentComponent._run] Created cacheSnapshot for session ${sessionId} (snapshotAt=${snapshot.snapshotAt})`
      );

      return { snapshot, systemPromptOverride: resolvedSystemPrompt };
    } catch (err) {
      logger.warn(`[AgentComponent._run] Failed to load cacheSnapshot: ${err}`);
      return { snapshot: null, systemPromptOverride: undefined };
    }
  }

  /**
   * 【Task #2744】无 sessionId 时的 {{memory}} fallback 替换
   *
   * 场景：sub-agent 或单元测试不传 sessionId → 走原 P1-1 行为（每 run 重新 recallMemory）。
   * 这是为了保持对无 session 路径的向后兼容，不影响 cache 路径。
   */
  private async _fallbackReplaceMemory(systemPrompt: string): Promise<string> {
    if (!systemPrompt.includes("{{memory}}")) return systemPrompt;
    try {
      const memoryComponent = this.env?.getComponent?.("memory") as { recallMemory?: () => Promise<string> | string } | undefined;
      if (memoryComponent && typeof memoryComponent.recallMemory === "function") {
        const memoryContent = await memoryComponent.recallMemory();
        return systemPrompt.replaceAll("{{memory}}", memoryContent || "(No memory)");
      }
      return systemPrompt.replaceAll("{{memory}}", "(Memory component not available)");
    } catch (err) {
      logger.warn(`[AgentComponent._run] Failed to replace {{memory}}: ${err}`);
      return systemPrompt.replaceAll("{{memory}}", "(Failed to load memory)");
    }
  }

  /**
   * 构建 additionInfo（含 currentTaskId 上下文注入）
   *
   * 通过 @TracedAs 追踪，可在 debug trace / debug span 中查看
   * currentTaskId 是否成功注入到 LLM 上下文
   *
   * Task #2744 (session-scope cache optimization):
   * 如果 ctx._cacheSnapshot 存在（由 AgentComponent._run 在 first-run 时构建到
   * 内存快照 `_cacheSnapshots`，★ Task #5224 起不再持久化到
   * session.metadata.cacheSnapshot），则返回 snapshot 的 additionInfo，**跨多轮
   * 保持字节级一致** —— 这是 LLM prompt cache 命中的前提。
   *
   * 否则降级到当前行为：从 ctx.context.additionInfo 读取（每次 buildMessages 都
   * 重读，可能因 caller 传入不同值而变化 → cache miss）。
   */
  /**
   * ★ 2026-10-22：**只存摘要**（Task #4479）。改造前平均 158KB
   * —— 入参 `ctx` 挂着完整对话历史，返回值是完整 additionInfo 文本。
   */
  @TracedAs("agent.component.buildAdditionInfo", {
    paramFilter: messagesParamFilter,
    recordResult: false,
    logResult: true,
    log: true,
  })
  private async _buildAdditionInfo(ctx: HookContext): Promise<string> {
    if (ctx._cacheSnapshot) {
      // Session-scope snapshot exists — use frozen additionInfo
      return ctx._cacheSnapshot.additionInfo;
    }
    let additionInfo = ctx.context?.additionInfo || "";
    return additionInfo;
  }

  private async buildMessages(
    ctx: HookContext,
  ): Promise<ModelMessage[]> {
    const messages: ModelMessage[] = [];

    const additionInfo = await this._buildAdditionInfo(ctx);
    // 【Task #2748 §5.6 + Task #2760 Dim 6】Multi-block system prompt（cache-friendly structure）
    // 把 system prompt 拆分为 multi-block（characterSheet / toolDefinitions / memoryBlock / dynamicContext），
    // 稳定段挂 cache_control，独立 cache。
    //
    // 【Task #2760 Dim 6 修复】补全 4 段实现：之前只传 characterSheet + dynamicContext 2 段，
    // 漏掉 toolDefinitions + memoryBlock。修复后 4 段全部启用：
    //   [0] characterSheet: ctx.systemPrompt (稳定, 含 {{memory}} 替换, 挂 cache_control)
    //   [1] toolDefinitions: ctx.tools 格式化字符串 (config 不变就不变, 挂 cache_control)
    //   [2] memoryBlock: 已嵌入 characterSheet (P0 设计: cacheSnapshot 把 memory 折进 systemPrompt),
    //       此处保留空字段对齐 spec 但不重复注入
    //   [3] dynamicContext: additionInfo (currentTaskId 等, 不挂 cache_control)
    if (ctx.systemPrompt) {
      messages.push(
        ...buildMultiBlockSystem({
          characterSheet: ctx.systemPrompt,
          //toolDefinitions: this._formatToolDefinitions(ctx.tools),
          toolDefinitions:  undefined,
	  // memoryBlock intentionally empty: memory is already substituted into
          // characterSheet via cacheSnapshot (P0 #2744). Keeping it as a separate
          // segment would duplicate content. The spec design still has the field
          // for future use cases where memory is stored separately.
          memoryBlock: undefined,
          dynamicContext: additionInfo,
        })
      );
    } else if (additionInfo) {
      messages.push({
        role: "system",
        content: additionInfo,
      });
    }

    // History messages（包含之前的所有消息）
    messages.push(...ctx.messages);

    return messages;
  }

  /**
   * 【Task #2760 Dim 6】把 ctx.tools 格式化为 toolDefinitions 字符串
   *
   * 目的：让 buildMultiBlockSystem 输出一段独立的 toolDefinitions 段（挂 cache_control），
   * 这样 OpenAI-Compatible provider 也可以通过 prompt_cache_key 命中工具 schema 前缀。
   * Anthropic 已经有 applyToolCacheControl 在 tool 字段挂 cache_control（独立 cache），
   * 但 system prompt 内的 toolDefinitions 段是冗余但无害的（AI SDK 会去重）。
   *
   * 格式化策略：每行 `name: description` 的紧凑列表。JSON 序列化参数过于详细，
   * 紧凑列表足以让 LLM 列出可用工具。
   *
   * 内容稳定性：相同 ctx.tools 跨 run 输出 byte-equal → 缓存命中。
   * （按 name 排序，确保多 run 工具顺序变化也 byte-stable）
   */
  private _formatToolDefinitions(tools: HookContext["tools"]): string {
    if (!tools || tools.length === 0) return "";
    const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
    return sorted.map((t) => `${t.name}: ${t.description || ""}`).join("\n");
  }

  /**
   * 调用 LLM
   * 
   * 流式事件由 LLMComponent 通过 env.pushEnvEvent() 发布
   */
  /**
   * ★ 2026-10-22：**只存摘要**（Task #4479）。改造前平均 149KB
   * —— 入参 ctx 带全量消息，返回值是完整模型输出。
   */
  @TracedAs("agent.component.invokeLLM", {
    paramFilter: llmInvokeParamFilter,
    resultFilter: llmInvokeResultFilter,
    logResult: true,
    log: true,
  })
  private async invokeLLM(ctx: HookContext): Promise<AgentLLMOutput> {
    logger.debug("[invokeLLM] Starting LLM invocation");
    
    // 如果有 LLMComponent，使用它
    if (this.llmComponent?.invoke) {
      const llm = this.llmComponent;
      const messages = await this.buildMessages(ctx);
      const convertedMessages = messages.map(toLLMMessage);
      
      logger.debug(`[invokeLLM] Calling LLMComponent.invoke with ${convertedMessages.length} messages`);

      // ------------------------------------------------------------------
      // Task #4623 — fallback model（兜底模型）
      //
      // 触发条件：主模型调用失败且错误在白名单内（404 / 429 / 配额 / 5xx /
      // 超时 / 重试耗尽）。401/403/400/abort/上下文超限明确不触发。
      //
      // 语义：
      //   - per-run 粘性：一次 run 内降级后，后续迭代直接走 fallback，
      //     不再先撞一次主模型的失败（额度耗尽是持续状态，不是抖动）。
      //   - 单层降级：fallback 自己失败 → 抛**原始错误**，不再递归降级。
      //
      // 作用域选择：挂在 invokeLLM（default agent 与 sub agent 共用的唯一
      // LLM 入口），所以两边天然都生效。
      // ------------------------------------------------------------------
      const runKey = ctx._runId ?? ctx.context.sessionId ?? "default-run";
      const sticky = this.fallbackState.get(runKey);
      // ★ Task #4724：兜底模型改为**有序列表**（链式降级）。
      //   显式列表 > 显式单值 > 配置数组 > 配置旧单值（详见 resolveFallbackModels）。
      const configuredFallbacks = this.resolveFallbackModels(
        ctx.context.fallbackModels,
        ctx.context.fallbackModel,
      );
      const activeModel = sticky?.activeModel ?? ctx.context.model;
      // 尚未尝试过的兜底模型（sticky 生效时从断点继续，而不是回头撞主模型）
      const pendingFallbacks = sticky
        ? sticky.remaining
        : configuredFallbacks.filter((m) => !AgentComponent.sameModel(m, activeModel));

      const invokeWithModel = (model: string | undefined, signal?: AbortSignal) =>
        llm.invoke({
          // 类型转换：ModelMessage[] -> LLMMessage[]
          messages: convertedMessages,
          // 类型转换：Tool[] -> ToolInfo[]
          // 注意：Tool.parameters 是 ZodType，需要提取其 JSON schema
          tools: ctx.tools.map(t => ({
            name: t.name,
            description: t.description || "",
            parameters: (t.parameters as unknown as Record<string, unknown>) ?? {},
          })),
          model,
          // 传递上下文用于事件元数据
          context: {
            sessionId: ctx.context.sessionId,
            messageId: ctx.context.messageId,
          },
          // 传递 abort signal 以支持 Agent 的优雅终止
          // review P0-1：这里传的是「本次 attempt 的合并 signal」——超时后可以主动
          // abort 掉仍在飞的底层请求，避免 fallback 与 primary 并发写流式事件。
          abortSignal: signal,
          // Sub agent 跳过阈值检查：compact/compact-hint/json-extract 等子 agent
          // 的 LLM 调用不应触发 context threshold，否则会导致压缩死循环
          skipThresholdCheck: ctx.context.agentType === "sub",
          // Issue #1694 root-cause fix: propagate caller-provided toolChoice
          // to force the LLM to call a specific tool (or any tool). When
          // undefined, AI SDK defaults to "auto".
          ...(ctx.context.toolChoice
            ? { toolChoice: ctx.context.toolChoice as Parameters<typeof this.llmComponent.invoke>[0]["toolChoice"] }
            : {}),
        });
      
      /**
       * review P0-1：withTimeout 只是 Promise.race，**不会取消底层请求**。
       * 每次 attempt 自带一个 AbortController，超时/失败后立刻 abort，
       * 保证 fallback 发起时 primary 不会继续跑（否则两条流式输出交错、
       * usage 被计两次、primary 长期挂成孤儿请求）。
       */
      const startAttempt = (model: string | undefined, label: string) => {
        const attemptController = new AbortController();
        const signal = ctx.context.abort
          ? AbortSignal.any([ctx.context.abort, attemptController.signal])
          : attemptController.signal;
        return {
          promise: withTimeout(invokeWithModel(model, signal), 300000, label),
          cancel: () => {
            try {
              attemptController.abort();
            } catch {
              // best-effort
            }
          },
        };
      };

      // 在 try 外声明：catch 里需要 cancel()，块级 const 在 catch 中不可见。
      let primaryAttempt: ReturnType<typeof startAttempt> | undefined;
      try {
        // ★ 防止 LLM 调用卡死：超时保护（双层协作）
        //
        // - 外层：ctx.context.abort（run 级 deadline / 用户取消）直接中断调用
        // - 内层：withTimeout (300s) 兜底，超时后主动 abort 本次 attempt
        //
        // 注意：对 DeepSeek R1、MiniMax reasoning 等复杂推理模型，首次 token
        // 返回到完成输出可能超过 2 分钟；300s 足以覆盖正常推理时间。
        primaryAttempt = startAttempt(activeModel, "LLM invocation timeout after 300s");
        const result = await primaryAttempt.promise;

        logger.debug("[invokeLLM] LLMComponent.invoke returned successfully");

        return this.normalizeLLMOutput(result);
      } catch (error) {
        logger.error("[invokeLLM] LLMComponent.invoke threw an error:", error);

        // review P0-1：primary 已经失败/超时，确保它不再继续写流式事件。
        primaryAttempt?.cancel();

        // review P0-1：run 已被取消时，绝不再起第二次请求（尊重中断语义）。
        if (ctx.context.abort?.aborted) {
          throw error;
        }

        // ★ Task #4724：链式降级。
        //   没有待尝试的兜底模型，或错误不在白名单内 → 直接抛原始错误。
        if (pendingFallbacks.length === 0 || !isFallbackEligibleError(error, true)) {
          throw error;
        }

        // 逐个尝试兜底模型（顺序 = 优先级）。
        // 「全部失败才报错」：链上每个模型都试过仍失败 → 抛**本次迭代首个失败
        // 模型**的错误（首次迭代即 primary 的错误，保留 404 等技术细节）。
        // ⚠️ 严格说不是"最初的 primary 错误"：sticky 迭代里当前失败的是
        //    链首（可能已经是 F1），抛的是**当前**链首的错误。
        for (let i = 0; i < pendingFallbacks.length; i++) {
          const fallbackModel = pendingFallbacks[i]!;
          const remaining = pendingFallbacks.slice(i + 1);

          logger.warn(
            `[invokeLLM] model "${activeModel ?? "(default)"}" failed with a fallback-eligible error; ` +
              `downgrading to fallback model "${fallbackModel}" ` +
              `(${i + 1}/${pendingFallbacks.length}) for run ${runKey}`,
          );

          // per-run 粘性：本次 run 后续迭代从**当前这个兜底模型**继续，
          // 且记住还没试过的那些（链式降级断点）。
          this.fallbackState.set(runKey, {
            activeModel: fallbackModel,
            remaining,
          });

          const fallbackAttempt = startAttempt(
            fallbackModel,
            "LLM invocation timeout after 300s (fallback)",
          );
          try {
            const result = await fallbackAttempt.promise;
            logger.info(
              `[invokeLLM] fallback model "${fallbackModel}" succeeded for run ${runKey}`,
            );
            return this.normalizeLLMOutput(result);
          } catch (fallbackError) {
            fallbackAttempt.cancel();

            // review P1-4：fallback 命中小上下文窗口时抛的是 ContextError ——
            // 必须原样向上抛，让 ContextHandler 的自动压缩链路接管；
            // 若在这里 re-throw primary 的 404，压缩永远不会触发。
            if (fallbackError instanceof ContextError) {
              logger.warn(
                `[invokeLLM] fallback model "${fallbackModel}" hit a context limit; ` +
                  `re-throwing ContextError so the compaction pipeline can handle it`,
              );
              throw fallbackError;
            }

            // ★ Task #4724 review MINOR-2：兜底失败后**复检 abort**。
            //   primary 路径在进入降级前检查过一次（:2772），但用户在 F1 尝试
            //   期间按 Ctrl-C 时，链上剩余的 F2/F3 不该再发起请求
            //   （否则会产生无谓请求 + 误导性的 "downgrading to..." 日志）。
            if (ctx.context.abort?.aborted) {
              throw error;
            }

            // 这个兜底模型也失败 → 继续试链上下一个（如果有）。
            // 链上全部失败时，抛**本次迭代首个失败模型的错误**
            // （首次迭代即 primary 的错误，保留 404 等技术细节）。
            logger.error(
              `[invokeLLM] fallback model "${fallbackModel}" also failed; ` +
                (remaining.length > 0
                  ? `trying next fallback model "${remaining[0]}"`
                  : `no more fallback models left; re-throwing the ORIGINAL primary error`),
              fallbackError,
            );

            // 兜底模型的失败不再降级（否则会无限递归 / 放大成本）：
            // 下一个候选只来自 pendingFallbacks，与本次失败模型无关。
            if (remaining.length === 0) {
              // ★ Task #4724 review2 MINOR-6：链已耗尽 —— 把 sticky 复位回
              //   **主模型**，而不是停在「最后一个失败的兜底模型」上。
              //   否则下一次迭代会继续用一个刚被证伪的模型（链式下更容易发生），
              //   且永远不会再降级。复位后 primary 若恢复可用就能继续跑，
              //   不可用则重新走一遍链（语义与首次调用一致）。
              this.fallbackState.delete(runKey);
              throw error;
            }
          }
        }

        // 理论上不可达（循环内要么 return 要么 throw），保底抛原始错误。
        throw error;
      }
    }

    // Fallback: Mock response for testing
    logger.warn("[invokeLLM] No LLMComponent available, using mock");
    
    return {
      content: "Mock response: Hello!",
      finishReason: "stop",
    };
  }

  /**
   * Task #4724 — 解析最终的兜底模型**有序列表**。
   *
   * 优先级（高 → 低）：
   *   1. 显式传入的**数组**（`AgentContext.fallbackModels`，来自 CLI `--fallback-model a,b,c`）
   *   2. 显式传入的**单值**（`AgentContext.fallbackModel`，来自 CLI `--fallback-model xxx`）
   *   3. 配置 `llm.fallbackModels`（**有序数组**，与 Task #4722 对齐）
   *   4. 配置 `llm.fallbackModel`（旧单值，向后兼容）
   *
   * 显式传入（1/2）**完全覆盖**配置（3/4）—— CLI 覆盖 config。
   * 若结果只有 modelId（无 `provider/` 前缀）且配置了 `llm.fallbackProvider`，
   * 则补成 `providerId/modelId`（与 `--model` 同语义）。
   *
   * ★ Task #4722：`llm.fallbackModels` 是**有序数组**（顺序 = 优先级），
   *   由 `roy-bot fallback-model add/remove/reorder` 与飞书卡片
   *   `##command##: fallback-model ...` 维护。
   *   ★ Task #4724 把语义从「只消费首项」扩展为**整链消费**：
   *   数组第 2..N 项现在**真正参与降级**（主模型失败 → 依次尝试），
   *   所以卡片上调整顺序**会**改变运行时行为。
   *
   * @param explicitList 显式列表（CLI / AgentContext.fallbackModels）
   * @param explicitSingle 显式单值（CLI / AgentContext.fallbackModel）
   */
  private resolveFallbackModels(
    explicitList?: string[],
    explicitSingle?: string,
  ): string[] {
    const readConfig = (key: string): string | undefined => {
      const raw = this.configComponent?.get?.(key) as unknown;
      if (typeof raw !== "string") return undefined;
      const trimmed = raw.trim();
      return trimmed ? trimmed : undefined;
    };

    // 归一化单个候选：去空白 → 补 provider 前缀 → 丢弃残值（"provider/"）
    const normalize = (raw: string): string | undefined => {
      const trimmed = raw.trim();
      if (!trimmed) return undefined;
      const parsed = parseFallbackModel(trimmed);
      if (!parsed?.modelId) return undefined; // "provider/" 这类残值直接视为未配置
      if (parsed.providerId) return `${parsed.providerId}/${parsed.modelId}`;

      // 只写了 modelId：用显式配置的 fallbackProvider 补前缀；
      // 未配置时保持裸 modelId（由 LLMComponent 走 defaultProvider），
      // ⚠️ 此时可能落在与 primary 不同的 provider 上，属已知边界。
      const provider = readConfig("llm.fallbackProvider");
      return provider ? `${provider}/${parsed.modelId}` : parsed.modelId;
    };

    // 显式列表优先（CLI 数组）
    //
    // ★ Task #4724 review MINOR-3：显式项**存在**但归一化后全为空时
    //   （如 `--fallback-model "provider/"`），直接返回空数组 —— **不**继续
    //   向下穿透到 config。语义是「显式优先 = 显式决定一切」：
    //   用户显式传了一个无效值，就该按「没配兜底」处理，而不是悄悄用 config。
    if (Array.isArray(explicitList)) {
      const normalized = AgentComponent.dedupeModels(
        explicitList
          .map((m) => (typeof m === "string" ? normalize(m) : undefined))
          .filter((m): m is string => !!m),
      );
      return normalized;
    }

    // 显式单值次之（CLI 单值）
    if (explicitSingle?.trim()) {
      const normalized = normalize(explicitSingle);
      // 同 MINOR-3：显式单值无效 → 不穿透到 config
      return normalized ? [normalized] : [];
    }

    // 配置数组（Task #4722 对齐的有序列表）
    //
    // ⚠️ 值可能是**字符串**（环境变量 `LLM_FALLBACK_MODELS=a/M1,b/M2` 只能给
    // 字符串；config.jsonc 里写数组则给数组）—— 两种都要支持，
    // 字符串按逗号拆分，与 CLI 的 `--fallback-model a,b,c` 语法一致。
    const configuredList = this.configComponent?.get?.("llm.fallbackModels") as unknown;
    const configuredItems: unknown[] = Array.isArray(configuredList)
      ? configuredList
      : typeof configuredList === "string"
        ? configuredList.split(",")
        : [];
    if (configuredItems.length > 0) {
      const normalized = AgentComponent.dedupeModels(
        configuredItems
          .map((m) => (typeof m === "string" ? normalize(m) : undefined))
          .filter((m): m is string => !!m),
      );
      if (normalized.length > 0) return normalized;
    }

    // 配置旧单值（向后兼容）
    const legacy = readConfig("llm.fallbackModel");
    if (legacy) {
      const normalized = normalize(legacy);
      if (normalized) return [normalized];
    }

    return [];
  }

  /**
   * ★ Task #4724 review MINOR-4 — 兜底模型列表去重。
   *
   * `--fallback-model a/M1,a/M1` 会真的调两次 M1 —— 白白多一次请求 + 一次
   * 失败等待。按**归一化后的字符串**去重，并保持首次出现的顺序
   * （顺序 = 优先级，不能被去重打乱）。
   */
  private static dedupeModels(models: string[]): string[] {
    return Array.from(new Set(models));
  }

  /**
   * review P2-3 — 判断两个 model 标识是否"同一个模型"。
   *
   * `"GLM-5.3-Flash"` 与 `"tong/GLM-5.3-Flash"` 指向同一模型，仅前缀不同；
   * 若按字符串严格比较会误判为"换了模型"，白跑一次注定失败的 primary。
   */
  private static sameModel(a?: string, b?: string): boolean {
    const norm = (value?: string): string => {
      if (!value) return "";
      const trimmed = value.trim();
      const slash = trimmed.indexOf("/");
      return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
    };
    const left = norm(a);
    const right = norm(b);
    return !!left && left === right;
  }

  /**
   * Task #4623 — 归一化 LLM 返回值为内部 AgentLLMOutput。
   * 抽成方法以便 primary / fallback 两条路径共用同一套映射。
   */
  private normalizeLLMOutput(result: LLMInvokeResult): AgentLLMOutput {
    return {
      content: result.output?.content || "",
      reasoning: result.output?.reasoning,
      toolCalls: result.output?.toolCalls?.map((tc) => ({
        id: tc.id,
        function: tc.function ? {
          name: tc.function.name,
          arguments: typeof tc.function.arguments === "string" 
            ? tc.function.arguments 
            : JSON.stringify(tc.function.arguments),
        } : undefined,
        name: tc.name,
        arguments: tc.arguments,
      })),
      finishReason: result.output?.finishReason,
    };
  }

  /**
   * Task #2723: 归一化上游 tool-call shape → 内部 `Record<string, unknown>`。
   *
   * 两种上游 shape 都会在调用前被转换成 JSON object：
   * - AI SDK 兼容：`{ id, function: { name, arguments: string } }`
   * - pi-ai 顶层：`{ id, name, arguments: string }` (无 `function` 包装)
   *
   * `safeParseToolArgs()` 递归处理 normal / double-stringified / already-object /
   * malformed 输入，失败 fallback 到 `{}`，避免把 `_raw` 泄漏到 session。
   *
   * Trace 维度只记录 source / type / keys（不记录 raw value），以免污染 span store。
   */
  @TracedAs("agent.tool_call.parse", {
    recordParams: true,
    recordResult: true,
    log: true,
    paramFilter: (args: any[]) => {
      const toolCall = args[0] as
        | NonNullable<AgentLLMOutput["toolCalls"]>[number]
        | undefined;
      const hasFunctionArgs = toolCall?.function?.arguments !== undefined;
      const rawArgs = hasFunctionArgs
        ? toolCall.function!.arguments
        : toolCall?.arguments;
      return {
        tool_call_id: toolCall?.id,
        tool_name: toolCall?.function?.name ?? toolCall?.name ?? "unknown",
        argument_source: hasFunctionArgs ? "function.arguments" : "arguments",
        argument_type:
          rawArgs === null
            ? "null"
            : Array.isArray(rawArgs)
              ? "array"
              : typeof rawArgs,
      };
    },
    resultFilter: (result: Record<string, unknown>) => ({
      argument_type: "object",
      keys: Object.keys(result).sort(),
    }),
  })
  private parseToolCallArguments(
    toolCall: NonNullable<AgentLLMOutput["toolCalls"]>[number],
  ): Record<string, unknown> {
    // 优先 function.arguments（AI SDK），fallback 顶层 arguments（pi-ai）
    const rawArgs = toolCall.function?.arguments ?? toolCall.arguments;
    return safeParseToolArgs(rawArgs);
  }

  /**
   * 严格版参数解析（Task #4231）
   *
   * 与 `parseToolCallArguments` 的差别：失败时返回 `ok:false` 而不是空对象，
   * 让调用方能把错误回给模型、并**拒绝执行**这条工具调用。
   * 会先尝试抢救上游退化格式（GLM 的 `<arg_key>/<arg_value>` 文本标记）。
   */
  private parseToolCallArgumentsStrict(
    toolCall: NonNullable<AgentLLMOutput["toolCalls"]>[number],
  ): { ok: boolean; args: Record<string, unknown>; error?: string; salvaged?: boolean } {
    const rawArgs = toolCall.function?.arguments ?? toolCall.arguments;
    return parseToolArgsStrict(rawArgs);
  }

  /**
   * 执行工具
   *
   * errorIf：只有「工具根本不存在」（未注册 / 被 allowedTools|deniedTools 过滤掉）
   * 才把 span 标成 ERROR —— 这是 prompt 承诺与实际工具表不一致的**配置错误**，
   * 属于必须显式可见的 bug。
   *
   * 刻意不覆盖「工具执行失败」（`success:false` 且有真实 error，如 bash exit!=0）：
   * 那是正常运行时结果，全标 ERROR 会让 trace 里遍布红色噪音、反而掩盖真问题。
   */
  /**
   * ★ 2026-10-22：**只存摘要**（Task #4479）。改造前平均 259KB
   * —— `ctx` 里挂着完整对话历史 + 工具参数 + 工具返回值。
   * 现在只留工具名 / toolCallId / 参数键名列表。
   */
  @TracedAs("agent.component.executeTool", {
    paramFilter: toolExecParamFilter,
    resultFilter: toolExecResultFilter,
    logResult: true,
    log: true,
    errorIf: (result: ToolCallResult | undefined) => {
      const err = result?.result?.error;
      // 判定逻辑集中在 constants.isToolUnavailableError（单一事实来源，避免各处硬编码字面量漂移）
      if (result?.success === false && isToolUnavailableError(err)) {
        return new Error(String(err));
      }
      return undefined;
    },
  })
  private async executeTool(ctx: HookContext): Promise<ToolCallResult> {
    const toolCall = ctx.currentToolCall!;

    // ★ Task #4486 Phase 3: tool.* 事件补 sessionId（StreamOutputService 按 session 过滤用）
    const toolEventSessionId = ctx.context?.sessionId;

    // 获取工具名称：优先使用 function.name（AI SDK v6 格式），兼容 toolCall.name
    // AI SDK v6 格式: { id, name, function: { name, arguments } }
    const toolName = (toolCall as any).function?.name || toolCall.name || "unknown";
    
    // Debug: 打印工具查找信息
    logger.debug(`[executeTool] Looking for tool: "${toolName}"`);
    logger.debug(`[executeTool] Available tools: [${ctx.tools.map(t => t.name).join(", ")}]`);
    
    // Find tool
    const tool = ctx.tools.find(t => t.name === toolName);
    if (!tool) {
      // ★ 2026-10-16：升级为 ERROR 日志。
      //
      // 背景（生产 traceId=83eadac2316d5be7529ca42ce7057d63）：
      //   LLM 调用了 `bash`，但该 agent 的 allowedTools/deniedTools 过滤后没有这个工具，
      //   于是返回 "Tool not found: bash"。原来只打 debug 日志 + 发事件，span 的
      //   status 仍是 ok、result 里才是错误，导致 `debug trace --list` 完全看不出来，
      //   问题被静默吞掉（compact 子 agent 因此写出空 checkpoint，归档 657 条消息）。
      //
      //   这类失败几乎总是「system prompt 承诺的工具 ≠ 实际注册的工具」的信号，
      //   属于配置 / prompt 一致性错误，必须显式可见（含可用的工具清单以便对账）。
      logger.error(
        `[executeTool] Tool not found: "${toolName}" — agent="${ctx.agent?.name}" ` +
        `(type=${ctx.agent?.config?.type}). ` +
        `Available tools (${ctx.tools.length}): [${ctx.tools.map(t => t.name).join(", ")}]`
      );

      // 发送错误事件
      this.pushEnvEvent({
        type: "tool.error",
        payload: {
          error: `Tool not found: ${toolName}`,
          toolName: toolName,
          availableTools: ctx.tools.map(t => t.name),
          agentName: ctx.agent?.name,
        },
        sessionId: toolEventSessionId,
      });
      
      return {
        id: toolCall.id,
        name: toolName,
        success: false,
        result: {
          success: false,
          output: "",
          error: `Tool not found: ${toolName}`,
        },
      };
    }

    try {
      // 工具即将执行 — 由 agent 层发布事件（非 invoke 流）
      this.pushEnvEvent({
        type: "tool.call",
        payload: {
          id: toolCall.id,
          name: toolName,
          arguments: toolCall.arguments,
        },
        sessionId: toolEventSessionId,
      });

      // Convert AgentContext to ToolContext format
      // AgentContext uses sessionId (camelCase), ToolContext uses session_id (snake_case)
      // Task #4623 — 把本次 run 的 model 透传给工具，让 delegate_task 能把父
      // agent 的 --model / --fallback-model 继承给 sub-agent。
      //
      // review P1-5：如果本 run 已经降级（sticky 生效），这里必须传**当前生效**
      // 的 fallback model，否则降级期间 delegate 出来的子 agent 会先撞一次已经
      // 死掉的 primary（timeout 型故障时还会白等 300s）。
      const runKey = ctx._runId ?? ctx.context.sessionId ?? "default-run";
      const runFallbackState = this.fallbackState.get(runKey);
      const effectiveRunModel = runFallbackState?.activeModel ?? ctx.context.model;
      // ★ Task #4724：把**兜底模型列表**一起透传给工具，使 delegate_task
      //   能把父 agent 的多模型兜底链继承给 sub-agent（顺序 = 优先级）。
      //
      // ★ Task #4724 review2 MINOR-5：sticky 生效时只传**剩余的**兜底链
      //   （sticky.remaining），而不是整条链 —— 父 agent 已经证伪过的模型
      //   （比如刚失败过的 a/M1）不该让子 agent 再撞一次。
      const effectiveFallbackModels = runFallbackState
        ? runFallbackState.remaining
        : this.resolveFallbackModels(
            ctx.context.fallbackModels,
            ctx.context.fallbackModel,
          );
      // ★ Task #4724 review3 MINOR：父 agent **显式禁用**兜底
      //   （`fallbackModels: []`）时，子 agent 也必须禁用 ——
      //   否则「父禁用、子回落 config」造成语义分裂。
      //   判据：显式给了列表（哪怕是空的）→ 显式决定一切。
      const fallbackExplicitlySet =
        Array.isArray(ctx.context.fallbackModels) ||
        ctx.context.fallbackModel !== undefined;
      const toolContext: ToolContext = {
        session_id: ctx.context.sessionId,
        message_id: ctx.context.messageId,
        abort: ctx.context.abort,
        model: effectiveRunModel,
        fallbackModel: ctx.context.fallbackModel,
        ...(effectiveFallbackModels.length > 0
          ? { fallbackModels: effectiveFallbackModels }
          : fallbackExplicitlySet
            // 显式禁用：传一个**空数组**作为标记，子 agent 据此不再回落 config
            ? { fallbackModels: [] }
            : {}),
        workdir: ctx.context.metadata?.workdir as string | undefined,
        // ★ Task #4983：把本次 run 的标识补进 tool metadata。
        //
        // 为什么：ask_user 工具用 `metadata.runId` / `metadata.nodeId` 拼错误前缀
        // （`[agent:unknown] Ask user: …`）。此前这两个键**从不被写入** ⇒
        // 任何非 workflow 场景的 ask_user 错误前缀都是 `unknown` ⇒
        // 生产日志里完全无法定位是哪个 agent / 哪次 run 抛的
        // （Task #4983 铁证：traceId 01a1a686… 只能靠时间戳对齐）。
        //
        // 注意 metadata 整体仍是 `ctx.context.metadata`（不替换）——
        // 这里只是**追加**三个键，原有键全部保留。
        metadata: {
          ...(ctx.context.metadata ?? {}),
          ...(ctx._runId ? { runId: ctx._runId } : {}),
          ...(ctx.context.sessionId ? { sessionId: ctx.context.sessionId } : {}),
          ...(ctx.context.agentType ? { agentType: ctx.context.agentType } : {}),
          // ★ Task #5007 — 把执行工具的 agent 名透传给工具层。
          //   task_update 用它在「执行方不得自行置 completed」的关卡里做精确判定：
          //   只拦真正的执行型 sub-agent（如 roy），不误伤 task-organizer 这类
          //   **被授权做任务整理/验收**的 sub agent（它也允许 task_complete）。
          ...(ctx.agent?.name ? { agentName: ctx.agent.name } : {}),
          // ★ Task #5333 — 把本轮的渠道专用工具放行名单透传给工具层。
          //   delegate_task 用它在「父 agent 委派」时继承给 sub-agent，
          //   使企微事件委派出去的工作仍能调用 wecom_respond 回复
          //   （与 Task #5217 channel systemPrompt 继承同构）。
          ...(ctx.context.extendTools?.length
            ? { extendTools: ctx.context.extendTools }
            : {}),
        },
      };

      // Build ToolExecuteRequest
      const request: ToolExecuteRequest = {
        name: toolName,
        args: toolCall.arguments,
        context: toolContext,
      };

      // Use ToolComponent.execute() to trigger tool hooks
      // Check if we have a ToolComponent reference (via refreshDependencies)
      let result;
      
      // ★ delegate_task/stop_task/bash 自带内部超时机制，不额外加超时
      // ★ ask_user 通过 AskUserError 立即中断工作流，不需要超时
      // ★ workflow_run/run-workflow 自带 timeout 参数做超时控制，且 workflows 可能需要超长时间
      // ★ compact_session 内部要跑两次完整 LLM 调用（generateCompactHint() 起 compact-hint
      //   agent + compact() 起 compact agent），两次都读全量 history，耗时随 session
      //   消息条数线性增长（实测 69 条消息几秒完成，388 条消息就超过 120s），
      //   无法在 120s 内保证完成 —— 与 delegate_task / workflow_run 同性质的复合操作，
      //   必须豁免，否则会把「压缩其实成功」误报成「执行超时」
      // ★ 其他工具加 120s 超时防止卡死（常规工具如文件读写/搜索等应在几秒内完成）
      const isLongRunningTool = toolName === "delegate_task" || toolName === "stop_task" || toolName === "bash" || toolName === "workflow_run" || toolName === "run-workflow" || toolName === "compact_session";
      
      // 检查工具是否在注册表中（extraTools 不在注册表中，需要直接执行）
      const isExtraTool = this.toolComponent?.getTool 
        ? !this.toolComponent.getTool(toolName)
        : false;
      
      if (isExtraTool) {
        // extraTool 不在注册表中，直接执行（跳过 toolComponent.execute 的注册表查找）
        logger.debug(`[executeTool] Tool "${toolName}" is an extraTool, executing directly`);
        const toolPromise = tool.execute(toolCall.arguments, toolContext);
        if (isLongRunningTool) {
          result = await toolPromise;
        } else {
          result = await withTimeout(toolPromise, 120000, `Tool '${toolName}' execution timeout after 120s`);
        }
        // Re-enter the central truncation safety net. extraTool results
        // bypass `ToolComponent.execute()` (which normally truncates), so we
        // apply the same cap here. Pass the Tool so a tool that opts out of
        // truncation via `metadata.skipTruncation` keeps its full payload.
        result = truncateOutputInline(result, undefined, undefined, toolName, tool);
      } else if (this.toolComponent?.execute) {
        const toolPromise = this.toolComponent.execute(request);
        if (isLongRunningTool) {
          result = await toolPromise;
        } else {
          result = await withTimeout(toolPromise, 120000, `Tool '${toolName}' execution timeout after 120s`);
        }
      } else {
        // Fallback to direct tool execution (for backwards compatibility / testing)
        logger.debug(`[executeTool] No ToolComponent available, executing tool directly`);
        const toolPromise = tool.execute(toolCall.arguments, toolContext);
        if (isLongRunningTool) {
          result = await toolPromise;
        } else {
          result = await withTimeout(toolPromise, 120000, `Tool '${toolName}' execution timeout after 120s`);
        }
        // Re-enter the central truncation safety net. The fallback path
        // skips `ToolComponent.execute()` (which normally truncates), so we
        // apply the same cap here. Pass the Tool so a tool that opts out of
        // truncation via `metadata.skipTruncation` keeps its full payload.
        result = truncateOutputInline(result, undefined, undefined, toolName, tool);
      }

      // 发送工具结果事件
      this.pushEnvEvent({
        type: "tool.result",
        payload: {
          id: toolCall.id,
          name: toolName,
          result: result,
          success: result.success,
        },
        sessionId: toolEventSessionId,
      });

      return {
        id: toolCall.id,
        name: toolName,
        success: result.success,
        result,
      };
    } catch (error) {
      // 检测 AskUserError - 这是用于工作流暂停的特殊错误，需要向上传播
      if (error instanceof AskUserError) {
        throw error; // 重新抛出，让调用栈上层（AgentComponentAdapter）处理
      }

      // 发送错误事件
      this.pushEnvEvent({
        type: "tool.error",
        payload: {
          error: error instanceof Error ? error.message : String(error),
          toolName: toolName,
        },
        sessionId: toolEventSessionId,
      });

      return {
        id: toolCall.id,
        name: toolName,
        success: false,
        result: {
          success: false,
          output: "",
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  /**
   * 执行 Plugin Hooks (Agent 特有的 Hook 执行机制)
   * 
   * 执行顺序：
   * 1. Agent 自己的 plugins（通过 agent.plugins）
   * 2. EventSource 加载的 plugins（通过 globalHookManager + pluginEnabled 检查）
   */
  private async executePluginHooks(
    agent: AgentInstance,
    point: HookPoint,
    ctx: HookContext
  ): Promise<void> {
    // === 1. 执行 Agent 自己的 plugins ===
    const hooks: Array<{ plugin: Plugin; priority: number; execute: Function }> = [];
    
    for (const [name, plugin] of agent.plugins) {
      for (const hook of plugin.hooks) {
        if (hook.point === point) {
          hooks.push({
            plugin,
            priority: hook.priority ?? 0,
            execute: plugin.execute,
          });
        }
      }
    }

    // Sort by priority (higher first)
    hooks.sort((a, b) => b.priority - a.priority);

    // Execute agent hooks
    for (const { plugin, execute } of hooks) {
      try {
        const result = await execute(ctx);
        if (!result.continue) {
          ctx._stopped = true;
          ctx._stopReason = `Plugin ${plugin.name} stopped execution`;
          logger.info(`Hook ${point} stopped by plugin ${plugin.name}`);
          break;
        }

        // Handle actions
        if (result.action) {
          await this.handleHookAction(result.action, ctx);
        }
      } catch (error) {
        logger.error(`Hook ${point} error in plugin ${plugin.name}`, { error });
        ctx._errors = ctx._errors || [];
        ctx._errors.push({
          plugin: plugin.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // === 2. 执行 globalHookManager 中的 EventSource hooks ===
    // 构建 metadata 传递给 globalHookManager.execute()
    const metadata: Record<string, unknown> = {
      pluginEnabled: ctx.context?.pluginEnabled,
      envEvent: ctx.context?.envEvent,
    };
    
    // globalHookManager.execute() 会根据 hook.pluginName 和 hook.sourceId 检查 pluginEnabled
    await globalHookManager.execute(point, ctx, metadata);
  }

  /**
   * 处理 Hook 动作
   */
  private async handleHookAction(
    action: { type: string; payload?: unknown },
    ctx: HookContext
  ): Promise<void> {
    switch (action.type) {
      case "stop":
        ctx._stopped = true;
        ctx._stopReason = "stopped_by_hook";
        break;
      case "inject_message":
        if (action.payload && typeof action.payload === "object") {
          const msg = action.payload as ModelMessage;
          ctx.messages.push(msg);
        }
        break;
      case "skip_tool":
        // Skip current tool execution
        ctx._pendingAction = action as { type: HookActionType; payload?: unknown };
        break;
      // Other actions can be extended
    }
  }

  /**
   * 通知消息添加（扩展点）
   */
  protected notifyMessageAdded(message: ModelMessage): void {
    // 可被子类或插件覆盖
    logger.debug(`Message added: ${message.role}`);
  }

  /**
   * 结束结果
   */
  private finalizeResult(result: AgentRunResult, ctx: HookContext): AgentRunResult {
    return {
      ...result,
      stopped: ctx._stopped,
      stopReason: ctx._stopReason,
    };
  }

  /**
   * Record messages to session
   * 
   * 存储策略：
   * 1. 存储 allMessages 中的所有 user、assistant、tool 消息
   * 2. 跳过 system 消息
   * 3. 跳过空内容的 assistant/tool 消息
   * 
   * Layer 3 wiring (sessions.db fix): instead of N individual addMessage
   * calls (each = INSERT message + UPDATE session.message_count = 2
   * statements per row), we filter first and dispatch ONCE per React
   * iteration through sessionComponent.addMessages, which performs the
   * whole batch in a single BEGIN/COMMIT. This eliminates the lock
   * amplification that turned short contentions into full SQLITE_BUSY
   * storms (the root cause of the 2026-07-07 incident).
   */
  /**
   * ★ 2026-10-22：**只存摘要**（Task #4479，CV 发现的**最大漏网之鱼**）。
   *
   * 实测：`allMessages` 是**每一轮 ReAct 迭代的全部消息**（含工具输出），
   * 单 span attributes 达 **200 KB / 迭代** —— 这是剩余的体积大头。
   */
  @TracedAs("agent.component.recordSessionMessages", {
    paramFilter: recordSessionMessagesParamFilter,
    logResult: true,
    log: true,
  })
  private async recordSessionMessages(
    sessionId: string | undefined,
    allMessages: ModelMessage[] = []
  ): Promise<boolean> {
    if (!sessionId) {
      return false;
    }

    // Hoist `filtered` to function scope so the catch block below can
    // reference it (previously only visible inside try).
    let filtered: AddMessageOptions[] | undefined;
    try {
      const sessionComponent = this.env.getComponent<SessionComponent>("session");
      if (!sessionComponent) {
        logger.warn("SessionComponent not found, skipping session recording");
        return false;
      }

      // Filter first, batch second — never call addMessage N times in a row.
      filtered = [];
      for (const msg of allMessages) {
        // 跳过 system 消息
        if (msg.role === "system") {
          continue;
        }

        // 跳过空 user 消息（无需用户输入的 workflow agent）
        if (msg.role === "user" && this.isEmptyMessage(msg.content)) {
          continue;
        }

        // 跳过空内容的 assistant/tool 消息
        if (msg.role === "assistant" || msg.role === "tool") {
          if (this.isEmptyMessage(msg.content)) {
            continue;
          }
        }

        filtered.push(
          this.messageConverter.fromModelMessage(msg as unknown as ModelMessage, { sessionID: sessionId })
        );
      }

      if (filtered.length === 0) {
        return true;
      }

      await sessionComponent.addMessages(sessionId, filtered);
      return true;

    } catch (err) {
      // Code Review: this catch is the LAST line of defence against silent
      // message loss. The previous `logger.warn` would have been invisible
      // in production at the default log level; promote to error so that
      // a failed batch is at least observable, and tag the kind so it can
      // be alerted on separately.
      const kind =
        err && typeof err === "object" && "kind" in err
          ? (err as { kind?: string }).kind
          : undefined;
      if (kind === "lock_exhausted") {
        logger.error(
          `[recordSessionMessages] DROPPED ${filtered?.length ?? "?"} message(s) — SQLITE_BUSY retry exhausted after ${(err as { attempts?: number }).attempts ?? "?"} attempts. Session ${sessionId} is now inconsistent with LLM context. Original: ${err}`
        );
      } else {
        logger.error(
          `[recordSessionMessages] Failed to record session messages for ${sessionId}: ${err}`
        );
      }
      // ★ Task #4720 (DS review MINOR 3): persistence failed → return false so the
      // caller does NOT advance persistedMessageCount. The un-persisted messages
      // stay in hookCtx.messages and are retried by the post-loop safety net.
      return false;
    }
  }
  
  /**
   * 检查消息内容是否为空
   * 
   * 空内容定义：
   * - 空字符串 ""
   * - 空数组 []
   * - null
   * - undefined
   * 
   * @param content - 消息内容
   * @returns 是否为空
   */
  private isEmptyMessage(content: unknown): boolean {
    if (content === null || content === undefined) {
      return true;
    }
    if (typeof content === "string" && content.trim() === "") {
      return true;
    }
    if (Array.isArray(content) && content.length === 0) {
      return true;
    }
    return false;
  }

  /**
   * 通过 Environment 发送事件
   */
  /**
   * 发布 agent 层事件到 env。
   *
   * ★ Task #4486 Phase 3: 增加 `sessionId` 参数 —— tool.* / agent.* 事件此前
   * 只有 `{source, agent_name}`，没有 sessionId，导致并发多 session 时
   * StreamOutputService 无法按 session 过滤（只能渲染进"当前"流）。
   * `llm.*` 事件由 llm/invoke.ts 的 createEnvEventEmitter 已经带 sessionId，
   * 这里补齐 agent 侧。
   *
   * @param event.sessionId 归属会话（缺省时从 ctx/ALS 未必可靠，调用方显式传）
   */
  private pushEnvEvent(event: {
    type: string;
    payload: Record<string, unknown>;
    sessionId?: string;
  }): void {
    if (this.env && "pushEnvEvent" in this.env) {
      try {
        const fullEvent: EnvEvent = {
          id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          type: event.type,
          timestamp: Date.now(),
          metadata: {
            source: "agent",
            agent_name: this.name,
            ...(event.sessionId ? { sessionId: event.sessionId } : {}),
          },
          payload: event.payload,
        };
        this.env?.pushEnvEvent(fullEvent);
      } catch (err) {
        logger.warn(`[pushEnvEvent] Failed to push event: ${err}`);
      }
    }
  }

  /**
   * 获取会话对话历史
   * 
   * 核心逻辑：
   * 1. 使用 sessionComponent.getContext() 获取消息（自动从 checkpoint 开始）
   * 2. 根据 messageLimit 限制消息数量（向后兼容 minUserMessages）
   * 3. 过滤掉 tool_call/tool_result 消息（如果 filterHistory=true）
   * 
   * 关键改进：利用 checkpoint 概念，避免重复获取已压缩的历史消息，
   * 从而减少重复触发压缩的问题。
   * 
   * @param sessionComponent - SessionComponent 实例
   * @param sessionId - 会话 ID
   * @param options - 配置选项
   * @param options.minUserMessages - 最少包含的 user 消息数量（默认 100）
   * @param options.filterHistory - 是否过滤 tool 消息（默认 true）
   * @returns 过滤后的会话消息列表
   */
  /**
   * ★ 2026-10-22：**只存摘要**（Task #4479）。改造前平均 45KB
   * —— 返回值是完整会话历史数组（每条 message 的完整 content）。
   */
  @TracedAs("agent.component.getConversationHistory", {
    paramFilter: (args: any[]) => ({
      sessionId: args?.[1] ?? null,
      minUserMessages: args?.[2]?.minUserMessages ?? null,
      filterHistory: args?.[2]?.filterHistory ?? null,
    }),
    recordResult: false,
    logResult: true,
    log: true,
  })
  private async getConversationHistory(
    sessionComponent: SessionComponent,
    sessionId: string,
    options: { minUserMessages?: number; filterHistory?: boolean } = {}
  ): Promise<SessionMessage[]> {
    const minUserMessages = options.minUserMessages ?? 100;
    const filterHistory = options.filterHistory ?? false;
    
    // 使用 getContext 获取消息，自动从最新 checkpoint 开始
    // 且确保从 user 消息边界截取，避免 tool_call/tool_result 配对被截断
    const ctx = await sessionComponent.getContext(sessionId, {
      fullHistory: false,
      minUserMessages,
    });
    
    let messages = ctx.messages;
    
    // 根据 filterHistory 配置决定是否过滤 tool 消息
    if (filterHistory) {
      messages = messages.filter(msg => {
        if (msg.metadata?.type === "tool_call" || msg.metadata?.type === "tool_result") {
          return false;
        }
        return msg.role === "user" || msg.role === "assistant";
      });
    }

    return messages;
  }
}

/**
 * 【Task #2748 §5.6】Multi-block system prompt 构造（顶层 helper，可独立测试）
 *
 * 把 system prompt 拆分为 4 段独立 cache 块（每段独立 cache_control）：
 * - [0] characterSheet: 角色设定（极少变，独立 cache 长期命中）
 * - [1] toolDefinitions: 工具定义（config 不变就不变）
 * - [2] memoryBlock: 记忆块（变化频率低）
 * - [3] dynamicContext: 动态上下文（currentTaskId 等，可能变）
 *
 * 设计依据（参考 pi-agent multi-block system）：
 * - Anthropic 端原生支持多 system block + 每 block 独立 cache_control
 * - 拆段后，dynamic 段变化只让 [3] 段 cache 失效，[0][1][2] 仍命中
 *
 * 当前 buildMessages 仍使用单段 system message（向后兼容）。
 * 本函数作为 helper 暴露，便于测试 + 未来切到 multi-block 模式时复用。
 */
export function buildMultiBlockSystem(ctx: {
  characterSheet: string;
  toolDefinitions?: string;
  memoryBlock?: string;
  dynamicContext?: string;
}): ModelMessage[] {
  const ANTHROPIC_CACHE_CONTROL = {
    anthropic: { cacheControl: { type: "ephemeral" } },
  };
  const messages: ModelMessage[] = [];
  if (ctx.characterSheet) {
    messages.push({
      role: "system",
      content: ctx.characterSheet,
      providerOptions: ANTHROPIC_CACHE_CONTROL,
    } as ModelMessage);
  }
  if (ctx.toolDefinitions) {
    messages.push({
      role: "system",
      content: ctx.toolDefinitions,
      providerOptions: ANTHROPIC_CACHE_CONTROL,
    } as ModelMessage);
  }
  if (ctx.memoryBlock) {
    messages.push({
      role: "system",
      content: ctx.memoryBlock,
    } as ModelMessage);
  }
  if (ctx.dynamicContext) {
    messages.push({
      role: "system",
      content: ctx.dynamicContext,
    } as ModelMessage);
  }
  return messages;
}
