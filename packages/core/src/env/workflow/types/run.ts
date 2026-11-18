import { z } from 'zod';
import type { EventBus } from '../engine/event-bus';
import { AskUserError } from './workflow-message';
import type { SessionComponent } from '../../session/session-component';
import type { TemplateResolver } from '../utils/template-resolver';

// ==================== 状态枚举 ====================

export const RunStatusSchema = z.enum([
  'idle', 'running', 'paused', 'stopped', 'completed', 'failed'
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const NodeStatusSchema = z.enum([
  'pending', 'scheduled', 'started', 'running', 'completed', 'failed', 'skipped'
]);
export type NodeStatus = z.infer<typeof NodeStatusSchema>;

// ==================== Workflow Run ====================

export interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowName: string;
  status: RunStatus;
  input?: Record<string, any>;
  output?: Record<string, any>;
  error?: string;
  startedAt?: Date;
  pausedAt?: Date;
  resumedAt?: Date;
  stoppedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
  debugMode: boolean;
  parentRunId?: string;
}

// ==================== Node Run ====================

export interface NodeRun {
  id: string;
  runId: string;
  nodeId: string;
  nodeType: string;
  status: NodeStatus;
  input?: any;
  output?: any;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
  retryCount: number;
}

// ==================== 运行选项 ====================

export interface RunOptions {
  input?: Record<string, any>;
  debug?: boolean;
  parallelLimit?: number | null;
  timeout?: number | null;
  /** Strict mode: fail on unresolved templates instead of warning */
  strict?: boolean;
  /** Maximum iterations to prevent infinite loops (default: 100) */
  maxIterations?: number;
  /** Enable loop mode to allow re-entry of completed nodes (for workflow cycles) */
  loopEnabled?: boolean;
  /** Global workflow input for condition evaluation */
  workflowInput?: Record<string, unknown>;
  /**
   * Caller-reserved runId for a fresh workflow run.
   *
   * When set, `WorkflowEngine.createSession` uses this runId (instead of
   * calling `generateRunId()`), so the caller can pre-allocate a runId
   * that the tool layer surfaces on every termination path (timeout /
   * abort / error). Task #1837 already established that runId ===
   * sessionId, and Task #2106 closes the gap where the `workflow_run`
   * tool's synthesized fallback runId was shape-compatible but not
   * queryable / stoppable on the engine.
   *
   * Contract:
   *  - Must start with `workflow_` (Task #1837 prefix requirement)
   *  - Must be unique across all active workflow sessions
   *  - On the resume path, callers should pass `sessionId` instead
   *
   * Task #2106 — required by `workflow_run` tool's reserved-ID contract.
   */
  runId?: string;
  /**
   * Parent session id — when set, the workflow run session will be created
   * with `parentSessionId === parentSessionId`. Used by `workflow_run` tool
   * and `roy-bot workflow run` CLI to track the parent→workflow session
   * hierarchy for `sessions list --graph` (Task #1739).
   */
  parentSessionId?: string | null;
  /**
   * Session id to resume — when set, the engine re-enters an existing
   * workflow session instead of starting a fresh run. Set by the
   * `workflow_run` tool's `session` field and `roy-bot workflow run --session`
   * CLI to power workflow-runner re-entry into paused/interrupted workflows.
   * (Task #1829)
   */
  sessionId?: string;
  /**
   * Callback fired immediately after the workflow session is created
   * (or resolved for resume). The sessionId argument is also the
   * runId (Task #1837: runId == sessionId).
   *
   * Use this to capture the runId/sessionId BEFORE execution, so callers
   * can still reference it when execution later times out, aborts, or
   * throws. Without this callback, the tool layer has no way to surface
   * the runId on failure paths (Task #1840).
   *
   * The callback must be safe to call: a throwing callback is caught
   * and logged, but does NOT abort session creation.
   */
  onSessionCreated?: (sessionId: string) => void;
  /**
   * Per-node runtime config overrides.
   *
   * Keyed by `node.id`. Values are shallow-merged into the node's
   * `nodeDef.config` at buildNodeContext time. Keys present in BOTH
   * nodeDef.config and nodeConfig[nodeId] are taken from nodeConfig
   * (input wins). Unknown node IDs are silently ignored.
   *
   * Common use cases:
   * - `timeout`: per-node execution timeout (ms), overrides engine's
   *   global timeout. Read by AgentNode and ToolNode.
   * - `maxIterations`: only honored when loopEnabled=true.
   * - `model`, `allowedTools`, `deniedTools`: forwarded to AgentNode
   *   via `options.*`.
   *
   * Task #1974 — Workflow Node-Level Config + Resume + Stop.
   * Backward compatible: when omitted (or empty), engine behavior is
   * unchanged.
   */
  nodeConfig?: Record<string, Record<string, unknown>>;
}

export interface RunResult {
  runId: string;
  /** Session ID — Task #1837: equals runId exactly (no derivation). */
  sessionId?: string;
  status: RunStatus;
  output?: Record<string, any>;
  error?: string;
  durationMs?: number;
  /** Pending node ID (when status is 'paused') */
  pendingNodeId?: string;
  /** Query from ask_user (when status is 'paused') */
  query?: string;
  /** Agent sub-session ID (for resuming agent nodes) */
  agentSessionId?: string;
}

// ==================== 节点执行上下文 ====================

/**
 * 节点执行上下文
 * 
 * 扩展后包含：
 * - sessionId: Session ID，用于消息持久化
 * - askUser(): 方法，让节点可以请求用户输入
 */
export interface NodeExecutionContext {
  runId: string;
  /** Task #1837: sessionId == runId (runId natively carries workflow_ prefix). */
  sessionId: string;
  workflowName: string;
  nodeId: string;
  input: unknown;
  previousOutputs: Map<string, unknown>;  // 依赖节点的输出 (用于模板解析)
  nodeOutputs: Map<string, unknown>;      // 所有节点的输出 (用于完整数据访问)
  config: Record<string, unknown>;       // 节点配置
  debug: boolean;
  eventBus: EventBus;
  
  // Workflow 历史消息（用于 agent 节点之间共享 LLM 对话历史）
  workflowHistory?: Array<{
    role: 'user' | 'assistant' | 'tool';
    content: string;
    toolCallId?: string;
    toolName?: string;
    nodeId?: string;
  }>;
  
  // Agent sub-session 支持
  // SessionComponent 用于创建和管理 agent sub-sessions
  sessionComponent?: SessionComponent;
  // Agent sub-session ID（当节点是 agent 类型时）
  agentSessionId?: string;
  
  // Workflow 全局输入参数（用于模板解析，如 {{inputs.key}}）
  workflowInput?: Record<string, unknown>;
  
  // Template resolver instance (unified template resolution)
  templateResolver?: TemplateResolver;
  
  /**
   * Pre-resolved node configuration
   * 
   * This is the node's config with all template references resolved
   * using the TemplateResolver. Nodes should use this instead of the
   * raw `config` to avoid duplicate template resolution.
   * 
   * Example: A node with config.prompt = "{{nodes.fetch.result}}" will have
   * resolvedConfig.prompt = "The weather is sunny" after resolution.
   */
  resolvedConfig?: Record<string, unknown>;
  
  // 新增方法
  /**
   * 请求用户输入
   *
   * 调用此方法会抛出 AskUserError，引擎捕获后会暂停 workflow
   *
   * @param query - 向用户询问的问题
   * @throws AskUserError - 总是抛出此异常
   */
  askUser(query: string): never;

  /** Patch agent sub-session id onto latest workflow.node.start (agent nodes) */
  attachAgentSessionToLastStart?(nodeId: string, agentSessionId: string): Promise<void>;

  /**
   * Register (or refresh) an agent sub-session entry in the parent workflow
   * session's `metadata.agentSessions` (Task #4412 C1).
   *
   * AgentNode must use this instead of doing its own
   * `get → push → update` on the parent metadata. That read-modify-write is
   * unsafe once dispatch is concurrent: N sibling agent nodes all read the
   * same parent snapshot and each writes back its own array-with-one-extra
   * entry, so the last writer wins and every sibling's marker is silently
   * dropped (measured: 4 concurrent agents → only 2 markers survive).
   *
   * The engine implements this by routing the mutation through the same
   * per-session serialization queue it uses for its own metadata writes, so
   * the whole class of lost updates is closed by construction.
   *
   * Optional for backward compatibility with hand-built contexts in tests;
   * AgentNode falls back to the legacy inline RMW when it is absent.
   */
  registerAgentSubSession?(nodeId: string, agentSessionId: string): Promise<void>;

  /**
   * Abort signal for this node's execution (Task #1976).
   *
   * Populated by the workflow executor from its per-node `AbortController`.
   * The signal fires when:
   *   1. The node's timeout elapses (timeoutPromise rejects the race → executor
   *      calls `this.cancelNode(nodeId)` which triggers this signal).
   *   2. The user issues `workflow_run_stop` (engine.stop → executor.cancelAll).
   *   3. The retry path on inner-attempt timeout (existing behavior preserved).
   *
   * Nodes SHOULD pass this signal to any long-running async operation they
   * own (e.g. AgentRunner.run, LLM calls, network requests) so that timeout
   * truly cancels the underlying work, not just the engine's wait.
   *
   * Optional for backward compat — nodes that don't opt in still work
   * (their execution will be leaked on timeout, which is the bug this field
   * is designed to fix).
   */
  abortSignal?: AbortSignal;
}

// ==================== 节点执行结果 ====================

export interface NodeExecutionResult {
  success?: boolean;
  output?: any;
  error?: string | Error;
  duration?: number;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

// ==================== Context Factory ====================

/**
 * 创建 NodeExecutionContext
 */
export function createNodeExecutionContext(
  params: {
    runId: string;
    workflowName: string;
    nodeId: string;
    input: unknown;
    previousOutputs: Map<string, unknown>;
    nodeOutputs: Map<string, unknown>;
    config: Record<string, unknown>;
    debug: boolean;
    eventBus: EventBus;
    sessionId: string;
    workflowHistory?: NodeExecutionContext['workflowHistory'];
    workflowInput?: Record<string, unknown>;
    templateResolver?: TemplateResolver;
    resolvedConfig?: Record<string, unknown>;
  }
): NodeExecutionContext {
  return {
    ...params,
    askUser: (query: string): never => {
      throw new AskUserError(
        params.runId,
        params.sessionId,
        params.nodeId,
        'unknown', // nodeType 会在外层设置
        query
      );
    },
  };
}
