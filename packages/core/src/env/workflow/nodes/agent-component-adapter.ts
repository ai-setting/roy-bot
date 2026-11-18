/**
 * @fileoverview AgentComponentAdapter - Bridge between Workflow AgentNode and AgentComponent
 * 
 * This adapter implements the AgentRunner interface required by AgentNode,
 * delegating actual execution to the AgentComponent.
 * 
 * Usage:
 * ```typescript
 * const agentComponent = env.getComponent<AgentComponent>('agent');
 * const adapter = new AgentComponentAdapter(agentComponent);
 * 
 * // Register agents that can be used in workflows
 * adapter.registerAgent('researcher', {
 *   systemPrompt: 'You are a research assistant...',
 *   type: 'general',
 *   model: 'gpt-4'
 * });
 * 
 * // Now AgentNode can use 'researcher' agent type
 * const workflow = {
 *   nodes: [{
 *     type: 'agent',
 *     config: { agent_type: 'researcher', prompt: '...' }
 *   }]
 * };
 * ```
 */

import type { AgentComponent } from '../../agent/agent-component';
import type { AgentContext } from '../../agent/types';
import type { AgentRunner, AgentConfig, AgentResult } from './agent-node';
import type { SessionComponent } from '../../session/session-component';
import { AskUserError } from '../types/workflow-hil';
import type { JsonSchemaObject } from '../utils/json-schema-to-zod';
import {
  WORKFLOW_JSON_OUTPUT_PLUGIN_KEY,
  registerWorkflowJsonOutputPlugin,
} from '../plugins/workflow-json-output-plugin';
import { TracedAs } from '../../log-trace/decorator';

// ============================================================================
// AgentComponentAdapter Class
// ============================================================================

/**
 * Pending Agent Session - Stores info needed to resume an agent after user input
 */
export interface PendingAgentSession {
  agentSessionId: string;
  nodeId: string;
  runId: string;
  createdAt: number;
}

/**
 * AgentComponentAdapter
 * 
 * Adapts AgentComponent to the AgentRunner interface expected by Workflow's AgentNode.
 * Provides session isolation for agent execution within workflow context.
 * 
 * Features:
 * - Creates dedicated agent sessions for each workflow agent node execution
 * - Tracks pending sessions for resume after user input
 * - Supports mapping agent sessions to workflow run session messages
 */
export class AgentComponentAdapter implements AgentRunner {
  /** Session prefix for agent sessions */
  private agentSessionPrefix = 'agent';
  
  /** Current agent session ID */
  private _currentAgentSessionId?: string;
  
  /** Pending agent sessions (waiting for user input) */
  private pendingSessions: Map<string, PendingAgentSession> = new Map();
  
  /** Map from workflow run session to agent sessions */
  private runSessionToAgentSessions: Map<string, string[]> = new Map();

  /** Ensure workflow JSON output plugin is registered once */
  private jsonOutputPluginRegistered = false;

  constructor(
    private agentComponent: AgentComponent,
    private options: AgentComponentAdapterOptions = {},
    private _sessionComponent?: SessionComponent
  ) {
    this.ensureJsonOutputPluginRegistered();
  }

  private ensureJsonOutputPluginRegistered(): void {
    if (this.jsonOutputPluginRegistered) {
      return;
    }
    // 注入 agentComponent 引用，使 plugin 能在 agent:after.react hook 中
    // 调用 json-extract sub-agent
    registerWorkflowJsonOutputPlugin({ agentComponent: this.agentComponent });
    this.jsonOutputPluginRegistered = true;
  }

  /**
   * Set the SessionComponent for agent session management
   */
  setSessionComponent(sessionComponent: SessionComponent): void {
    this._sessionComponent = sessionComponent;
  }

  /**
   * Get the current agent session ID
   */
  getCurrentAgentSessionId(): string | undefined {
    return this._currentAgentSessionId;
  }

  /**
   * Register an agent that can be used in workflows
   * 
   * @param name - Agent name (used as agent_type in workflow definition)
   * @param config - Agent configuration
   */
  registerAgent(
    name: string,
    config: AgentRegistrationConfig
  ): void {
    this.agentComponent.registerAgent(name, {
      type: (config.type || 'general') as any,
      model: config.model,
      systemPrompt: config.systemPrompt,
      maxIterations: config.maxIterations,
      allowedTools: config.allowedTools,
      deniedTools: config.deniedTools,
      timeout: (config as any).timeout,
      maxErrorRetries: config.maxErrorRetries,
    } as any);
    
    // Store session prefix for this agent
    if (config.sessionIdPrefix) {
      this.agentSessionPrefixes.set(name, config.sessionIdPrefix);
    }
  }

  /**
   * Run an agent
   * 
   * Implements AgentRunner interface.
   * Creates a dedicated agent session for each execution within workflow context.
   * 
   * @param config - Agent configuration
   * @param resumeOptions - Optional options for resuming a paused agent
   * @returns Agent execution result
   */
  // AgentResult.output + messages 可能很大 → 不入库
  @TracedAs("workflow.agent_adapter.run", { recordParams: true, recordResult: false, log: true })
  async run(
    config: AgentConfig,
    resumeOptions?: { userQuery?: string; agentSessionId?: string },
    signal?: AbortSignal, // Task #1976 — forwarded from executor via agentNode
  ): Promise<AgentResult> {
    const startTime = Date.now();
    
    // Extract context info from config (set by Executor)
    const nodeId = (config as any).nodeId || 'unknown';
    const runId = (config as any).runId || 'unknown';
    const workflowSessionId = (config as any).workflowSessionId;
    
    // Check if this is a resume (has userQuery)
    const isResume = !!resumeOptions?.userQuery;
    
    // Determine agent session ID - 优先使用 resumeOptions 中的 session ID
    // 因为 AgentNode 已经通过 createAgentSubSession() 创建了 session
    // 我们只需要使用它，不需要重复创建
    let agentSessionId = resumeOptions?.agentSessionId 
      || config.agentSessionId 
      || this._currentAgentSessionId;
    
    // 如果没有提供 session ID，生成一个 deterministic 的 sessionId。
    // 必须始终有 sessionId — downstream plugin (workflow-json-output-plugin) 在
    // agent:after.react hook 中需要它来调用 json-extract sub-agent 复用主 session 历史。
    if (!agentSessionId) {
      agentSessionId = `${this.agentSessionPrefix}_${runId}_${nodeId}_${Date.now()}`;
      // 如果有 session component 则尝试创建真实 session；否则用 placeholder ID
      if (this._sessionComponent) {
        try {
          await this._sessionComponent.create({
            title: `Agent Session: ${config.type} (${agentSessionId})`,
            // Persist parent session id (workflow run session) so that
            // `sessions list --graph` can render this agent under its
            // workflow run session (Task #1739).
            // Issue #5: only persist at the top-level — never mirror into
            // metadata (drift risk).
            ...(workflowSessionId ? { parentSessionId: workflowSessionId } : {}),
            metadata: {
              type: 'agent',
              workflowRunId: runId,
              workflowNodeId: nodeId,
            },
          });
        } catch (error) {
          console.warn(`Failed to create agent session ${agentSessionId}:`, error);
        }
      }
    }
    
    // 设置当前 session ID（用于 resume 时引用）
    if (agentSessionId) {
      this._currentAgentSessionId = agentSessionId;
      
      // 追踪 workflow session 到 agent session 的映射
      if (workflowSessionId && this._sessionComponent) {
        const mapping = this.runSessionToAgentSessions.get(workflowSessionId) || [];
        if (!mapping.includes(agentSessionId)) {
          mapping.push(agentSessionId);
          this.runSessionToAgentSessions.set(workflowSessionId, mapping);
        }
      }
      
      // 如果是 resume（有 userQuery），从 pending 中移除
      if (isResume) {
        this.pendingSessions.delete(agentSessionId);
      } else {
        // Fresh run - 记录为 pending session（等待 ask_user 恢复）
        this.pendingSessions.set(agentSessionId, {
          agentSessionId,
          nodeId,
          runId,
          createdAt: Date.now(),
        });
      }
    }
    
    // Task #2106 GREEN-A: declare the per-run deadline timer outside the
      // try/finally so the finally block can always clearTimeout.
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const outputSchema = config.options?.outputSchema as JsonSchemaObject | undefined;

      // Build context from options
      const context: AgentContext = {};
      
      // Pass model from config options to AgentContext
      // This flows through to AgentComponent which sets effectiveContext.model
      context.model = config.options?.model;
      
      // Add timeout if specified (Task #1974 — used to set inner AbortController)
      // Task #2099: enforce workflow-configured timeout.
      //
      // Task #2106 fix: the previous implementation (commit e8f8842c on this
      // branch) called `this.agentComponent.abort(config.type || "general")`
      // on deadline. That public API iterates ALL abortControllers whose key
      // starts with `${agentName}:` and aborts them all — meaning a single
      // timeout fired a name-wide abort and aborted every concurrent same-
      // type run. The setTimeout also survived successful completion (no
      // clearTimeout), so a stale timer could abort a later run.
      //
      // New behavior (Task #2106 GREEN-A):
      //   - When timeout > 0, create a per-run `AbortController` whose
      //     `signal` is composed with the executor's external signal and
      //     forwarded into the agent context.
      //   - The setTimeout aborts ONLY the per-run controller, never the
      //     name-wide public API.
      //   - The `finally` block calls `clearTimeout` so a fast run cannot
      //     have its deadline fire later.
      //
      // timeout === 0 or undefined → skip setTimeout, let AgentComponent's
      // internal 300s default LLM timeout handle it (backward compat).
      const configuredTimeout = config.options?.timeout;
      const deadlineController =
        typeof configuredTimeout === "number" && configuredTimeout > 0
          ? new AbortController()
          : undefined;

      if (deadlineController) {
        const timeoutMsFinal = configuredTimeout as number;
        timeoutHandle = setTimeout(() => {
          if (process.env["DEBUG"]) {
            console.warn(
              `[AgentComponentAdapter] agent '${config.type || "general"}' timeout ${timeoutMsFinal}ms elapsed, aborting THIS run only.`,
            );
          }
          deadlineController.abort(
            new Error(
              `Agent ${config.type || "general"} timed out after ${timeoutMsFinal}ms`,
            ),
          );
        }, timeoutMsFinal);
        // Use .unref() so the timer doesn't keep the Node process alive
        // after the workflow run finishes (e.g. when LLM returns quickly).
        if (typeof (timeoutHandle as any).unref === "function") {
          (timeoutHandle as any).unref();
        }
      }

      // Compose the executor's external AbortSignal (Task #1976) with the
      // per-run deadline signal. Both sources must reach the AgentComponent
      // so that either kind of abort interrupts only this single run.
      const signals = [signal, deadlineController?.signal].filter(
        (value): value is AbortSignal => value !== undefined,
      );
      if (signals.length === 1) {
        context.abort = signals[0];
      } else if (signals.length > 1) {
        context.abort = AbortSignal.any(signals);
      }
      
      // Use the agent session ID for isolation（必传，因为 plugin 依赖它）
      context.sessionId = agentSessionId;
      
      // Pass allowedTools from options to context
      // This is used by AgentComponent to filter available tools
      // For workflow agents, this includes 'ask_user' tool
      if (config.options?.allowedTools) {
        context.allowedTools = config.options.allowedTools;
      }
      
      // Pass deniedTools from options to context
      if (config.options?.deniedTools) {
        context.deniedTools = config.options.deniedTools;
      }

      context.metadata = {
        runId,
        nodeId,
        sessionId: agentSessionId,
        outputSchema,
        // ★ Task #4983：workflow 路径**不走**工具层 IM 直投。
        //
        // 原因：workflow 的 ask_user 有**自己的**呈现通道 ——
        // engine 的 node.interrupt → session metadata.pendingAskUserQuery
        // → workflow_run 工具返回 status='paused' + query
        // → CLI 的 `renderRunResult` 渲染「💬 Agent asked: <问题>」。
        //
        // 若工具层再投一次 IM ⇒ 用户会收到「CLI 渲染的那条」+「IM 那条」两条。
        // ⇒ workflow 显式关闭工具层投递，交给它自己的通道。
        //
        // ⚠️ 这**不影响**本次修复的目标场景（sub-agent ask_user）：
        //    那是 delegate_task 路径，不是 workflow 路径。
        askUserDelivery: 'off',
      };

      if (outputSchema) {
        context.pluginEnabled = {
          ...(context.pluginEnabled ?? {}),
          [WORKFLOW_JSON_OUTPUT_PLUGIN_KEY]: true,
        };
        // 不再向 main agent 注入 workflow_submit_output 工具
        // structured output 的提取由 workflow-json-output-plugin 在 agent:after.react hook 中
        // 调用独立的 json-extract sub-agent 完成。main agent 保持干净的 ReAct 流程。
      }
      
      // Pass workflow history to agent context
      if (config.workflowHistory) {
        (context as any).workflowHistory = config.workflowHistory;
      }
      
      // Pass the workflow node's prompt as additionInfo (with loop re-entry hint for json output)
      let additionInfo = config.prompt;
      let userInput = resumeOptions?.userQuery || additionInfo;

      if (agentSessionId && this._sessionComponent && !isResume) {
        try {
          const priorMessages = await this._sessionComponent.getMessages(agentSessionId);
          const hasPriorAssistant = priorMessages.some(
            (m) =>
              m.role === 'assistant' &&
              (Boolean(m.content?.trim()) ||
                m.parts?.some((p) => p.type === 'tool-call' || p.type === 'text'))
          );

          if (hasPriorAssistant && !userInput) {
            userInput =
              '[Workflow re-run] Inputs were updated since your last reply. Produce a new result for this run.';
          }
        } catch {
          // ignore session read errors
        }
      }

      context.additionInfo = additionInfo;

      // Task #2291 P0-3 / P0-1: when the workflow node forwarded a
      // cancellationScope on the config, register a real onForce handler
      // so the adapter participates in the structured-cancel contract.
      // Without this wire, scope.cancel({force:true}) reaches the agent
      // only via the composed AbortSignal — there is no force-distinct
      // path (e.g. for real subprocess kill) and the onForce mechanism
      // is dead code in production. The handler is intentionally
      // minimal: aborts the per-run deadline signal (if any) so any
      // in-flight per-attempt timer stops promptly. Real subprocess kill
      // remains the tool layer's responsibility.
      const ctxScope = (config as any).cancellationScope as
        | { onForce: (label: string, fn: () => void | Promise<void>) => () => void; forceSignal?: AbortSignal }
        | undefined;
      if (ctxScope && typeof ctxScope.onForce === "function") {
        ctxScope.onForce("agent-component-adapter-force", () => {
          if (deadlineController && !deadlineController.signal.aborted) {
            deadlineController.abort("force");
          }
        });
      }

      // Execute agent
      const result = await this.agentComponent.run(
        config.type || 'general',
        userInput,
        context
      );

      // Calculate duration
      // Check if agent stopped due to ask_user (encoded in result.error)
      if (result.error?.startsWith('__ASK_USER_ERROR__:')) {
        // Parse the JSON-encoded AskUserError info
        const jsonStr = result.error.substring('__ASK_USER_ERROR__:'.length);
        const errorInfo = JSON.parse(jsonStr);
        
        // Reconstruct and throw AskUserError
        //
        // ★ Task #4983：必须透传 `delivered`（工具层是否已把问题投到 IM 渠道）。
        //   丢了它 ⇒ CLI 层的兜底投递会**再投一次** ⇒ 用户收到两条同样的问题。
        //   （`agentSessionId` 也一并透传，见 AskUserError 构造签名。）
        throw new AskUserError(
          runId,
          errorInfo.sessionId,
          errorInfo.nodeId,
          errorInfo.nodeType || 'agent',
          errorInfo.query,
          errorInfo.agentSessionId,
          undefined,
          errorInfo.delivered === true,
        );
      }
      
      const duration = Date.now() - startTime;
      
      // Clear pending session on success
      if (agentSessionId) {
        this.pendingSessions.delete(agentSessionId);
      }

      // structuredOutput 来源：plugin 在 agent:after.react hook 中调用 json-extract sub-agent，
      // sub-agent 的 tool (workflow_submit_output) 把 validated JSON 写入 hookCtx.structuredOutputExtracted，
      // 然后 agent-component.ts:1533 读回 result.structuredOutput。这里直接 pass-through。
      const structuredOutput = result.structuredOutput;

      return {
        output: structuredOutput ?? result.finalText ?? (result as any).output,
        structuredOutput,
        metadata: {
          duration,
          iterations: result.iterations,
          toolCalls: result.toolCalls?.length,
          toolCallsDetail: result.toolCalls,
          agentSessionId,
        },
      };
    } catch (error) {
      // Check if this is AskUserError - don't clear pending session
      const isAskUserError = error instanceof Error && error.name === 'AskUserError';
      
      // Convert error to AgentResult format (unless AskUserError which should propagate)
      if (isAskUserError) {
        throw error; // Re-throw AskUserError to be handled by Executor
      }
      
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Clear pending session on other errors
      if (agentSessionId) {
        this.pendingSessions.delete(agentSessionId);
      }

      return {
        output: undefined,
        metadata: {
          duration,
          error: errorMessage,
          agentSessionId,
        },
      };
    } finally {
      // Task #2106 GREEN-A: always clear the timeout handle so a fast run
      // cannot have its stale setTimeout fire later and abort a different
      // run of the same agent type.
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      // Resume 时清除 current session（因为 resume 是一次性的）
      // Fresh run 时保留 current session（因为 workflow 可能需要 resume）
      if (isResume) {
        this._currentAgentSessionId = undefined;
      }
    }
  }
  
  /**
   * Resume a paused agent with user response
   * 
   * This method is called when workflow resumes after user input.
   * It retrieves the pending agent session and continues execution.
   * 
   * @param agentSessionId - The agent session ID to resume
   * @param userQuery - User's response to the ask_user query
   * @param config - Original agent config
   * @returns Agent execution result
   */
  async resumeAgent(
    agentSessionId: string,
    userQuery: string,
    config: AgentConfig
  ): Promise<AgentResult> {
    // Remove from pending
    this.pendingSessions.delete(agentSessionId);
    
    // Restore as current session
    this._currentAgentSessionId = agentSessionId;
    
    // Set agentSessionId in config so AgentComponent knows which session to load
    (config as any).agentSessionId = agentSessionId;
    
    // Pass userQuery in resumeOptions so _run() adds it as user query
    return this.run(config, { userQuery, agentSessionId });
  }
  
  /**
   * Get pending agent session by agent session ID
   */
  getPendingSession(agentSessionId: string): PendingAgentSession | undefined {
    return this.pendingSessions.get(agentSessionId);
  }
  
  /**
   * Get pending agent sessions for a workflow run
   */
  getPendingSessionsForRun(runId: string): PendingAgentSession[] {
    return Array.from(this.pendingSessions.values()).filter(
      session => session.runId === runId
    );
  }
  
  /**
   * Get all agent session IDs associated with a workflow session
   */
  getAgentSessionsForWorkflowSession(workflowSessionId: string): string[] {
    return this.runSessionToAgentSessions.get(workflowSessionId) || [];
  }

  /**
   * Check if an agent is registered
   */
  hasAgent(name: string): boolean {
    return this.agentComponent.getAgent(name) !== undefined;
  }

  /**
   * Get registered agent configuration
   * 
   * Returns the config of a registered agent, useful for workflow
   * agent_name lookups to inherit model, allowedTools, etc.
   * 
   * @param name - Agent name
   * @returns Agent registration config or undefined if not found
   */
  getAgentConfig(name: string): AgentRegistrationConfig | undefined {
    const agent = this.agentComponent.getAgent(name);
    if (!agent) return undefined;
    
    return {
      type: agent.config.type as any,
      model: agent.config.model,
      systemPrompt: agent.config.systemPrompt,
      maxIterations: agent.config.maxIterations,
      allowedTools: agent.config.allowedTools,
      deniedTools: agent.config.deniedTools,
    };
  }

  /**
   * List all registered agents
   */
  listAgents(): string[] {
    return this.agentComponent.listAgents().map(a => a.name);
  }

  /**
   * Get the underlying AgentComponent
   */
  getAgentComponent(): AgentComponent {
    return this.agentComponent;
  }

  // Session prefix map for workflow isolation
  private agentSessionPrefixes: Map<string, string> = new Map();
}

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Options for AgentComponentAdapter
 */
export interface AgentComponentAdapterOptions {
  /** Default timeout for agent execution (ms) */
  defaultTimeout?: number;
  /** Default session ID prefix */
  defaultSessionPrefix?: string;
}

/**
 * Configuration for registering an agent
 */
export interface AgentRegistrationConfig {
  /** Agent type */
  type?: 'general' | 'research' | 'coder' | 'critic';
  /** Model to use */
  model?: string;
  /** System prompt */
  systemPrompt?: string;
  /** Max iterations */
  maxIterations?: number;
  /** Allowed tools */
  allowedTools?: string[];
  /** Denied tools */
  deniedTools?: string[];
  /** Timeout (ms) */
  timeout?: number;
  /** Max error retries */
  maxErrorRetries?: number;
  /** Session ID prefix for workflow isolation */
  sessionIdPrefix?: string;
}
