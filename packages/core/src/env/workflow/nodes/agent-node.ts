/**
 * @fileoverview AgentNode - Delegate work to an AI agent
 * 
 * AgentNode delegates work to an AI agent with task description and context.
 */

import type { Node, NodeDefinition, NodeExecutionContext, NodeExecutionResult } from '../types';
import type { SessionComponent } from '../../session/session-component';
import { AskUserError } from '../types/workflow-hil';
import { TracedAs } from '../../log-trace/decorator';
import { parseAgentOutputConfig } from '../utils/parse-agent-output-config';
import { buildAgentNodeOutput } from '../utils/build-agent-node-output';

// ============================================================================
// Agent Types
// ============================================================================

/**
 * Agent 注册配置
 */
export interface AgentRegistrationConfig {
  /** Agent 类型 */
  type?: string;
  /** 系统提示词 */
  systemPrompt?: string;
  /** 模型名称 */
  model?: string;
  /** 最大迭代次数 */
  maxIterations?: number;
  /** 允许的工具列表 */
  allowedTools?: string[];
  /** 禁止的工具列表 */
  deniedTools?: string[];
}

/**
 * AgentRunner 接口
 *
 * 用于运行 AI Agent 的接口
 */
export interface AgentRunner {
  /**
   * 运行 Agent
   * @param config Agent 配置
   * @param resumeOptions 可选的恢复选项（用于恢复暂停的 agent）
   * @param signal AbortSignal — Task #1976: 当 workflow 节点超时或被 stop 时
   *   通过此 signal 通知 runner 取消。Runner 应当监听 signal.aborted 并
   *   尽快 resolve/reject（不要 hang）。Optional — 老 runner 不实现也 OK。
   * @returns Agent 执行结果
   */
  run(
    config: AgentConfig,
    resumeOptions?: { userQuery?: string; agentSessionId?: string },
    signal?: AbortSignal,
  ): Promise<AgentResult>;
  
  /**
   * 恢复暂停的 Agent
   * 
   * @param agentSessionId Agent session ID
   * @param userQuery 用户的响应
   * @param config 原始的 agent 配置
   * @returns Agent 执行结果
   */
  resumeAgent?(agentSessionId: string, userQuery: string, config: AgentConfig): Promise<AgentResult>;
  
  /**
   * 获取当前 agent session ID
   */
  getCurrentAgentSessionId?(): string | undefined;
  
  /**
   * 设置 SessionComponent
   */
  setSessionComponent?(sessionComponent: SessionComponent): void;
  
  /**
   * 获取待恢复的 session 信息
   */
  getPendingSession?(agentSessionId: string): { agentSessionId: string; nodeId: string; runId: string; createdAt: number } | undefined;
  
  /**
   * 注册 Agent（如果不存在）
   */
  registerAgent?(name: string, config: AgentRegistrationConfig): void;
  
  /**
   * 检查 Agent 是否已注册
   */
  hasAgent?(name: string): boolean;
  
  /**
   * 获取已注册 Agent 的配置
   * @param name Agent 名称
   * @returns Agent 注册配置，如果不存在则返回 undefined
   */
  getAgentConfig?(name: string): AgentRegistrationConfig | undefined;
}

/**
 * Agent 配置
 */
export interface AgentConfig {
  /** Agent 类型 */
  type: string;
  /** Prompt（任务描述） */
  prompt: string;
  /** 可选配置 */
  options?: {
    /** 超时时间（毫秒） */
    timeout?: number;
    /** 模型名称 */
    model?: string;
    /** 允许的工具列表（用于限制 agent 可用的工具） */
    allowedTools?: string[];
    /** 拒绝的工具列表 */
    deniedTools?: string[];
    /** JSON output schema (when output.mode=json) */
    outputSchema?: Record<string, unknown>;
  };
  /** Workflow 历史消息（来自前置 agent 节点） */
  workflowHistory?: Array<{
    role: 'user' | 'assistant' | 'tool';
    content: string;
    toolCallId?: string;
    toolName?: string;
    nodeId?: string;
  }>;
  /** 节点 ID（用于 history 标记） */
  nodeId?: string;
  /** Agent sub-session ID（用于 HiL resume） */
  agentSessionId?: string;
}

/**
 * Agent 执行结果
 */
export interface AgentResult {
  /** Agent 输出 */
  output: unknown;
  /** Structured JSON output (when output.mode=json) */
  structuredOutput?: Record<string, unknown>;
  /** 执行元数据 */
  metadata?: {
    /** 消耗的 token 数量 */
    tokens?: number;
    /** 执行耗时（毫秒） */
    duration?: number;
    /** 其他元数据 */
    [key: string]: unknown;
  };
  /** 生成的消息列表（用于 workflow history 累积） */
  messages?: Array<{
    role: 'user' | 'assistant' | 'tool';
    content: string;
    toolCallId?: string;
    toolName?: string;
    nodeId?: string;
  }>;
}

// ============================================================================
// AgentNode Implementation
// ============================================================================

/**
 * AgentNode 类
 * 
 * 委托 AI Agent 执行任务的节点类型
 */
export class AgentNode implements Node {
  /** 节点类型 */
  readonly type = 'agent';
  /** 节点 ID */
  readonly id: string;

  /**
   * 创建 AgentNode
   * @param definition 节点定义
   * @param agentRunner Agent 运行器
   */
  constructor(
    private definition: NodeDefinition,
    private agentRunner: AgentRunner
  ) {
    this.id = definition.id;
  }

  /**
   * 执行 AgentNode
   * 
   * 流程：
   * 1. 从 definition.config 获取 agent 配置
   * 2. 解析 prompt 模板（可能引用前置节点输出）
   * 3. 通过 agentRunner 运行 agent
   * 4. 返回 agent 结果
   * 
   * @param context 执行上下文
   * @returns 执行结果
   */
  // NodeExecutionResult.output 是 agent 完整输出 → 不入库
  @TracedAs("workflow.agent.execute", { recordResult: false })
  async execute(context: NodeExecutionContext): Promise<NodeExecutionResult> {
    const startTime = Date.now();

    try {
      // 1. 从配置中获取 agent 参数
      // Use pre-resolved config from context if available (avoids duplicate resolution)
      // Falls back to raw config for backward compatibility
      const config = (context.resolvedConfig ?? this.definition.config ?? {}) as Record<string, unknown>;
      const agentType = (config.agent_type as string) || 'general';
      const agentName = (config.agent_name as string) || undefined;
      const options = (config.options as AgentConfig['options']) || {};
      const outputConfig = parseAgentOutputConfig(config);

      // Task #1974: per-node timeout resolution. We support two shapes:
      //   - Legacy / nested: `config.options.timeout` (read by `options` above)
      //   - New / flat: `config.timeout` — populated either by YAML
      //     (`config.timeout: 5000`) or by `RunOptions.nodeConfig[nodeId].timeout`
      //     merged at buildNodeContext time.
      // Flat takes precedence over nested when both are present (input wins,
      // consistent with the engine's merge order).
      const flatTimeout = typeof config.timeout === "number" && config.timeout > 0
        ? config.timeout
        : undefined;
      const resolvedTimeout = flatTimeout ?? options.timeout;

      // 2. 获取 prompt - already resolved if resolvedConfig is provided
      // If resolvedConfig is used, prompt should already be resolved
      // Otherwise, resolve it using templateResolver
      let resolvedPrompt: string;
      if (context.resolvedConfig && context.templateResolver) {
        // resolvedConfig already contains resolved prompt
        resolvedPrompt = (config.prompt as string) || '';
      } else {
        // Fallback: resolve prompt template using templateResolver
        const promptTemplate = (config.prompt as string) || '';
        resolvedPrompt = (context.templateResolver?.resolveValue(promptTemplate) as string) ?? promptTemplate;
      }

      // Task #2135: Apply workflow input prompt injection (if any).
      // Caller-controlled extra context appended AFTER template resolution,
      // so callers can provide runtime hints without re-running the entire
      // template engine. Empty / missing → identity passthrough.
      resolvedPrompt = this.applyPromptInjection(
        resolvedPrompt,
        context.workflowInput?.prompt_injection,
      );

      // 3. 处理 agent_name 引用已注册 agent
      // 如果指定了 agent_name，从 registry 查找已注册 agent 的配置
      let resolvedAgentType = agentType;
      let inheritedModel: string | undefined;
      let inheritedAllowedTools: string[] | undefined;
      let inheritedDeniedTools: string[] | undefined;
      // Task #2060: track whether we found an agent config via agent_name lookup,
      // so we know whether to also try the resolvedAgentType after auto-registration.
      let inheritedFromAgentName = false;
      // Task #2060: when resolvedAgentType is found in the registry (after
      // auto-registration) and that registry entry has allowedTools === undefined,
      // we treat it as "no restriction" (all tools allowed) — do NOT fall back
      // to the ['ask_user'] default. This handles `agent_type: roy` properly.
      let agentTypeAllowsAllTools = false;

      if (agentName && this.agentRunner.hasAgent && this.agentRunner.getAgentConfig) {
        if (this.agentRunner.hasAgent(agentName)) {
          const agentConfig = this.agentRunner.getAgentConfig(agentName);
          if (agentConfig) {
            // Use agent_name as the type (routes to the correct registered agent)
            resolvedAgentType = agentName;
            // Inherit config from registered agent as defaults
            inheritedModel = agentConfig.model;
            inheritedAllowedTools = agentConfig.allowedTools;
            inheritedDeniedTools = agentConfig.deniedTools;
            inheritedFromAgentName = true;
          }
        }
      }

      // 4. 自动注册 agent（如果不存在且未被 agent_name 覆盖）
      if (this.agentRunner.registerAgent && this.agentRunner.hasAgent) {
        if (!this.agentRunner.hasAgent(resolvedAgentType)) {
          this.agentRunner.registerAgent(resolvedAgentType, {
            type: resolvedAgentType,
            systemPrompt: (config.system_prompt as string) || `You are a ${resolvedAgentType} agent.`,
            model: options.model || inheritedModel,
          });
        }
      }

      // Task #2060: if we didn't inherit from agent_name (e.g. workflow uses
      // `agent_type: roy` without explicit `agent_name`), try the
      // resolvedAgentType AFTER auto-registration. This way the built-in
      // 'roy' agent (deniedTools=[delegate_task,stop_task], allowedTools
      // undefined → all tools allowed) is picked up, and workflow nodes
      // such as `roy-rd-pipeline` init-task get a full tool stack instead
      // of the restrictive ['ask_user'] default.
      //
      // For allowedTools: distinguish "not set anywhere" (default
      // ['ask_user']) from "set to undefined on registered agent"
      // (no restriction). Only the first case should fall back.
      if (
        !inheritedFromAgentName &&
        this.agentRunner.hasAgent &&
        this.agentRunner.getAgentConfig
      ) {
        if (this.agentRunner.hasAgent(resolvedAgentType)) {
          const typeConfig = this.agentRunner.getAgentConfig(resolvedAgentType);
          if (typeConfig) {
            if (inheritedModel === undefined && typeConfig.model !== undefined) {
              inheritedModel = typeConfig.model;
            }
            if (inheritedDeniedTools === undefined && typeConfig.deniedTools !== undefined) {
              inheritedDeniedTools = typeConfig.deniedTools;
            }
            if (typeConfig.allowedTools === undefined) {
              // Registered agent has no whitelist → "all tools allowed"
              agentTypeAllowsAllTools = true;
            } else if (inheritedAllowedTools === undefined) {
              inheritedAllowedTools = typeConfig.allowedTools;
            }
          }
        }
      }

      // 5. 获取 userQuery 和 agentSessionId
      // - input.userQuery: CLI 传入的用户响应（resume 时）
      // - agentSessionId: 从 session messages 恢复或新创建
      const userQuery =
        (context as any).input?.userQuery ?? context.workflowInput?.userQuery;
      let agentSessionId = (context as any).agentSessionId;
      
      // Resume: resolve agent sub-session from workflow metadata if not in context
      if (!agentSessionId && context.sessionComponent) {
        agentSessionId = await this.resolveAgentSessionIdFromWorkflow(context);
        if (agentSessionId) {
          (context as any).agentSessionId = agentSessionId;
        }
      }
      
      // Fresh run: create agent sub-session when none exists
      if (!agentSessionId && context.sessionComponent) {
        agentSessionId = await this.createAgentSubSession(context);
        (context as any).agentSessionId = agentSessionId;
        if (context.attachAgentSessionToLastStart) {
          await context.attachAgentSessionToLastStart(this.definition.id, agentSessionId);
        }
      }
      
      // 5. 构建 AgentConfig
      // Use inherited values from registered agent as defaults, YAML options override.
      //
      // Task #2060: three-tier inheritance for allowedTools:
      //   1. YAML `options.allowedTools` (explicit override)
      //   2. Inherited from registered agent via `agent_name` or `agent_type`
      //      (with `undefined` meaning "no restriction")
      //   3. Fallback `['ask_user']` ONLY when no agent info is available
      const effectiveModel = options.model || inheritedModel;
      const effectiveAllowedTools: string[] | undefined = options.allowedTools?.length
        ? options.allowedTools
        : (agentTypeAllowsAllTools
            ? undefined
            : (inheritedAllowedTools?.length ? inheritedAllowedTools : ['ask_user']));
      const effectiveDeniedTools = options.deniedTools?.length
        ? options.deniedTools
        : inheritedDeniedTools;

      const agentConfig: AgentConfig = {
        type: resolvedAgentType,
        prompt: resolvedPrompt,
        options: {
          timeout: resolvedTimeout,
          model: effectiveModel,
          allowedTools: effectiveAllowedTools,
          deniedTools: effectiveDeniedTools,
          outputSchema: outputConfig.schema,
        },
        // 传递 workflow history（来自前置 agent 节点）
        workflowHistory: context.workflowHistory,
        // 传递节点信息（用于 history 标记）
        nodeId: this.definition.id,
        // 传递 agent sub-session ID
        agentSessionId,
      };

      // Task #2275: forward the cancellation scope to the runner config so
      // AgentComponentAdapter / mock runners can register force handlers
      // for real-process kill. The scope is exposed via `(context as any)
      // .cancellationScope` and threaded here as `(agentConfig as any
      // ).cancellationScope`. Existing AgentComponentAdapter reads other
      // fields (runId / workflowSessionId) via `(config as any)` casts
      // elsewhere — we do NOT add them here to avoid destabilizing tests
      // that assert exact agentConfig shape with `toHaveBeenCalledWith`.
      const ctxScope = (context as any).cancellationScope;
      if (ctxScope && !(agentConfig as any).cancellationScope) {
        (agentConfig as any).cancellationScope = ctxScope;
      }

      // 6. 构建 resumeOptions（用于 AgentComponentAdapter）
      const resumeOptions = {
        userQuery,
        agentSessionId,
      };

      // 7. 运行 agent (Task #1976: pass abortSignal so runner can cancel on timeout/stop)
      // Only pass the 3rd arg when defined so existing 2-arg-only callers / mocks
      // see exactly 2 args (backward compat at the call-site level too).
      let result: AgentResult;
      if (context.abortSignal) {
        result = await this.agentRunner.run(agentConfig, resumeOptions, context.abortSignal);
      } else {
        result = await this.agentRunner.run(agentConfig, resumeOptions);
      }

      // 8. 计算执行耗时
      const duration = Date.now() - startTime;

      // 9. 返回成功结果
      return {
        output: buildAgentNodeOutput(result, outputConfig),
        error: undefined,
        duration,
      };
    } catch (error) {
      // 检查是否是 AskUserError - 这是用于工作流暂停的特殊错误，需要向上传播
      // 以便 Executor 能够正确处理暂停逻辑
      if (error instanceof AskUserError) {
        // 确保 AskUserError 携带 agentSessionId（如果有的话）
        const contextAgentSessionId = (context as any).agentSessionId;
        if (contextAgentSessionId && !error.agentSessionId) {
          // 创建一个新的 AskUserError 携带 agentSessionId
          throw new AskUserError(
            error.runId,
            error.sessionId,
            error.nodeId,
            error.nodeType,
            error.query,
            contextAgentSessionId,
            error.timestamp
          );
        }
        throw error; // 重新抛出，让 Executor 处理
      }

      // 其他错误处理
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      return {
        output: undefined,
        error: errorMessage,
        duration,
      };
    }
  }

  /**
   * Apply caller-provided prompt injection to a resolved base prompt.
   *
   * Task #2135 — Workflow input may carry an optional `prompt_injection`
   * string (via `workflow run --input '{"prompt_injection": "..."}'`). When
   * present and non-empty, we append it to the resolved base prompt with a
   * unified separator so the caller can supply runtime hints / context /
   * constraints without re-running template resolution.
   *
   * Behavior:
   * - `promptInjection` undefined / null / empty string → return basePrompt unchanged
   * - otherwise → append with `\n\n---\n[Caller Injection]\n<injection>`
   *
   * Trace: span name `workflow.agent.applyPromptInjection`,
   * `recordParams: true` (record `basePrompt` and `promptInjection` for
   * debugging "injection didn't take effect" bugs), `recordResult: false`
   * (basePrompt may contain sensitive info → never leak it back).
   */
  @TracedAs("workflow.agent.applyPromptInjection", { recordParams: true, recordResult: false })
  private applyPromptInjection(basePrompt: string, promptInjection: unknown): string {
    // Identity passthrough for missing / empty injection — keeps backward
    // compatibility for callers that never set prompt_injection.
    if (typeof promptInjection !== 'string' || promptInjection.length === 0) {
      return basePrompt;
    }
    // Task #2135: unified separator between base prompt and caller injection.
    return `${basePrompt}\n\n---\n[Caller Injection]\n${promptInjection}`;
  }

  /**
   * Resolve agent sub-session ID from workflow session metadata.agentSessions
   */
  private async resolveAgentSessionIdFromWorkflow(
    context: NodeExecutionContext
  ): Promise<string | undefined> {
    const sessionComponent = context.sessionComponent;
    if (!sessionComponent) {
      return undefined;
    }

    const workflowSession = await sessionComponent.get(context.sessionId);
    const agentSessions = (workflowSession?.metadata as {
      agentSessions?: Array<{ nodeId: string; sessionId: string }>;
    })?.agentSessions;

    if (!agentSessions?.length) {
      return undefined;
    }

    return agentSessions.find((ref) => ref.nodeId === this.definition.id)?.sessionId;
  }

  /**
   * 创建 agent sub-session
   * 
   * Sub-session 用于存储 agent 的对话历史，支持 human-in-loop resume
   */
  @TracedAs("agent.node.createAgentSubSession", { recordParams: true, recordResult: true, log: true })
  private async createAgentSubSession(context: NodeExecutionContext): Promise<string> {
    const sessionComponent = context.sessionComponent;
    if (!sessionComponent) {
      return '';
    }
    
    const nodeId = this.definition.id || 'unknown';
    const agentSessionId = `agent_${nodeId}_${Date.now()}`;
    
    // 1. 创建 agent sub-session
    await sessionComponent.create({
      id: agentSessionId,
      title: `Agent: ${nodeId}`,
      // Task #1739: Persist the workflow run session id as the top-level
      // parentSessionId so `sessions list --graph` can render the agent
      // under its workflow run session.
      parentSessionId: context.sessionId,
      metadata: {
        type: 'agent',
        // Issue #5: parentSessionId must NOT be duplicated in metadata —
        // the top-level Session.parentSessionId is the canonical source.
        nodeId: nodeId,
        workflowName: context.workflowName,
      },
    });
    
    // 2. 更新 workflow session 的 metadata，添加 agentSessions 引用
    //
    // Task #4412 C1: prefer the engine-provided registration hook. It runs the
    // mutation inside the engine's per-session serialization queue, which is
    // the only way to be safe now that node dispatch is concurrent — the
    // legacy inline get/push/update below loses siblings' entries (measured:
    // 4 concurrent agent nodes → only 2 markers survive).
    //
    // The inline path is kept as a fallback for hand-built contexts (tests,
    // external callers) where the hook is absent.
    if (typeof context.registerAgentSubSession === 'function') {
      await context.registerAgentSubSession(this.definition.id, agentSessionId);
      return agentSessionId;
    }

    const workflowSession = await sessionComponent.get(context.sessionId);
    if (workflowSession) {
      const metadata = workflowSession.metadata as any || {};
      const agentSessions = metadata.agentSessions || [];
      
      // 检查是否已经存在
      const existingIndex = agentSessions.findIndex(
        (s: any) => s.nodeId === this.definition.id
      );
      
      if (existingIndex >= 0) {
        agentSessions[existingIndex] = {
          nodeId: this.definition.id,
          sessionId: agentSessionId,
          status: 'active',
          createdAt: Date.now(),
        };
      } else {
        agentSessions.push({
          nodeId: this.definition.id,
          sessionId: agentSessionId,
          status: 'active',
          createdAt: Date.now(),
        });
      }
      
      await sessionComponent.update(context.sessionId, {
        metadata: {
          ...metadata,
          agentSessions,
        },
      });
    }
    
    return agentSessionId;
  }
}

// ============================================================================
// Exports
// ============================================================================

export { AgentNode as default };
