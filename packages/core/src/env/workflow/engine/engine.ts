/**
 * @fileoverview WorkflowEngine - Session-based workflow execution engine
 * 
 * 统一的 run() 方法同时支持：
 * - 初次运行：session 不存在 → 创建 session，从 entry node 开始
 * - 中断恢复：session 存在 + 有消息 → 从消息推断下一个节点继续执行
 * 
 * Session 通过 workflow.node.* 消息记录节点执行状态
 * 
 * @version v3.0 (移除 resume() 方法，统一使用 run())
 */

import { EventEmitter } from 'events';
import type {
  WorkflowDefinition,
  Workflow,
  RunOptions,
  RunResult,
  RunStatus,
  NodeExecutionContext,
  NodeDefinition,
} from '../types/index';
import { createWorkflowEvent, WorkflowEvent } from '../types/event';
import { createNodeInterruptEvent, AskUserError } from '../types/workflow-hil';
import { DAGManager } from './dag-manager';
import { EventBus } from './event-bus';
import { Scheduler } from './scheduler';
import { Executor, ExecutorOptions } from './executor';
import { NodeRegistry } from './node-registry';
import type { SessionComponent } from '../../session/session-component';
import {
  WorkflowHookPoints,
  emitWorkflowRunHook,
  emitWorkflowNodeHook,
} from '../hooks';
import type { WorkflowSessionMetadata, AgentSessionRef } from '../types/workflow-message';
import {
  updateAgentSessionStatus,
  markAgentSessionCompleted,
  markAgentSessionFailed,
  markAllAgentSessionsCompleted,
  markAllAgentSessionsStopped,
  markAllAgentSessionsFailed,
  upsertAgentSession,
} from '../utils/agent-session-metadata';
import type { Environment } from '../../interface';
import { createLogger } from '../../log-trace/logger';
import { TracedAs } from '../../log-trace/decorator';
import { TemplateResolver } from '../utils/template-resolver';
import { TemplateUnresolvedError, WorkflowError } from '../types/workflow-error';
import { redactSensitiveFields } from '../utils/sensitive-redact';
import type { EdgeDefinition } from '../types/edge';
import { RuntimeCancellationScope } from '../runtime/runtime-cancellation-scope';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

// Logger
const logger = createLogger("workflow:engine");

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Agent Session Recovery Info
 */
export interface AgentSessionRecoveryInfo {
  nodeId: string;
  agentSessionId: string;
}

/**
 * Options for creating WorkflowEngine via static factory
 */
export interface WorkflowEngineCreateOptions {
  env?: {
    getComponent<T>(name: string): T | undefined;
  };
  toolRegistry?: any;
  skillRegistry?: any;
  workflowRunner?: any;
  sessionComponent?: SessionComponent;
  /** Repository for loading workflow definitions during resume */
  workflowRepository?: WorkflowRepository;
}

/**
 * Workflow Repository interface (abstraction)
 */
export interface WorkflowRepository {
  getById(id: string): Workflow | null;
  getByName(name: string): Workflow | null;
}

/**
 * Active Session State
 * 内存中追踪正在运行的 workflow session
 */
interface ActiveSessionState {
  sessionId: string;
  workflowId: string;
  workflowName: string;
  status: RunStatus;
  startedAt: Date;
  eventBus: EventBus;
  dagManager: DAGManager;
  scheduler: Scheduler;
  executor: Executor;
  nodeRegistry: NodeRegistry;
  nodeOutputs: Map<string, any>;
  config: WorkflowEngineConfig;
  /**
   * Runtime cancellation scope owned by this session (Task #2275).
   * Replaces the bare `abortController` for stop semantics. The legacy
   * `abortController` field is kept for backward compat with existing
   * tests/code paths that read `sessionState.abortController`.
   *
   * Optional because some tests construct `ActiveSessionState` directly
   * via cast and don't pre-populate it. `engine.stop()` falls back to
   * the legacy `abortController` path when scope is missing.
   */
  cancellationScope?: RuntimeCancellationScope;
  /**
   * @deprecated Use `cancellationScope.signal` instead. Kept so existing
   * call sites that read `abortController` continue to compile and work.
   * Will be removed once all consumers migrate.
   */
  abortController: AbortController;
  completedPromise: Promise<RunResult>;
  resolveCompleted: (result: RunResult) => void;
  rejectCompleted: (error: Error) => void;
  // LLM history for agent nodes
  workflowHistory: Array<{
    role: 'user' | 'assistant' | 'tool';
    content: string;
    toolCallId?: string;
    toolName?: string;
    nodeId?: string;
  }>;
  // Agent sessions reference
  agentSessions: Map<string, string>;  // nodeId -> agentSessionId
  // Edge definitions for conditional edge evaluation
  edges: EdgeDefinition[];
  // Loop iteration counter (for back-edge triggers, not schedule rounds)
  loopIterationCount: number;
  /**
   * loop_guard consecutive-no-progress counters, keyed by nodeId.
   *
   * Task #2286 follow-up — Counter Persistence Fix.
   *
   * Previously the counter was stored inside `nodeOutputs[reEntryId]` as
   * a well-known key `_loop_guard_consecutive_<nodeId>`. The next agent
   * run overwrites that whole map entry via
   * `sessionState.nodeOutputs.set(nodeId, result.output)`, which resets
   * the counter to 0 on every back-edge re-entry. As a result, the
   * guard could never reach `max_consecutive_no_progress` unless max=1.
   *
   * This map is the engine-internal home for the counter, completely
   * independent of `nodeOutputs`. Read/write only via the helper below.
   */
  loopGuardCounters: Map<string, number>;
  /**
   * In-flight node executions, keyed by nodeId (Task #4392 P0-1).
   *
   * Before the fix, `scheduleAndExecute` awaited each `startNode()` inside the
   * ready-node `for` loop, so at most one node was ever in flight and the loop
   * itself was the join point. Now nodes are dispatched concurrently, which
   * means the engine needs an explicit join set: a run must not be considered
   * finished (and `cleanupSession` must not clear the event bus) while a node
   * is still mid-flight.
   *
   * Invariants:
   *  - An entry is added *synchronously* at dispatch (before any `await`), so
   *    no window exists where a dispatched node is untracked.
   *  - An entry's promise never rejects: node errors are converted into
   *    `scheduler.markFailed` + `node.failed` (which is what drives fail-fast),
   *    so `Promise.all()` here cannot short-circuit and strand siblings.
   *  - `scheduler.running` is reconciled from this map at the top of every
   *    scheduling round, because a dispatch may remove the node from `running`
   *    (via `node.failed` → `failWorkflow`, or a back-edge `resetNodeForReEntry`)
   *    before its promise settles.
   */
  inFlight: Map<string, Promise<void>>;
  /**
   * Serializes session-metadata read-modify-write cycles (Task #4392 P0-1).
   *
   * `getSessionMetadata()` + `sessionComponent.update()` is a classic RMW
   * pattern. It was safe while nodes ran one at a time; with concurrent nodes
   * (and the `node.completed` handler) it would lose updates — e.g. two nodes
   * completing simultaneously each read the same `agentSessions` array and the
   * second write clobbers the first's `completed` marker.
   *
   * This is a per-session, in-memory promutex (no dependency added): every
   * metadata mutation chains onto it, so mutations apply in a total order.
   *
   * Optional, and lazily initialized on first use (see `updateSessionMetadata`)
   * because several tests construct `ActiveSessionState` directly via cast —
   * same constraint as `cancellationScope` above.
   */
  sessionMetadataQueue?: Promise<unknown>;
}

/**
 * WorkflowEngine Configuration
 */
export interface WorkflowEngineConfig {
  parallelLimit: number | null;
  timeout: number | null;
  debug: boolean;
  /** Strict mode: fail on unresolved templates instead of warning */
  strict: boolean;
  /** Maximum iterations to prevent infinite loops (default: 100) */
  maxIterations: number;
  /** Global workflow input for condition evaluation (P0-3 fix) */
  workflowInput?: Record<string, unknown>;
  /** Enable loop mode to allow re-entry of completed nodes (P0-1 fix) */
  loopEnabled?: boolean;
  /**
   * Per-node runtime overrides.
   *
   * Task #1974 — Workflow Node-Level Config + Resume + Stop. Set by
   * `engine.initializeSessionState` from `RunOptions.nodeConfig`. Used
   * by `buildNodeContext` to shallow-merge into each node's effective
   * config (input wins over nodeDef.config).
   *
   * Always present (defaults to `{}`); engine treats `undefined` and
   * `{}` identically.
   */
  nodeConfig?: Record<string, Record<string, unknown>>;
}


// ============================================================================
// WorkflowEngine Class
// ============================================================================

/**
 * WorkflowEngine
 * 
 * Session-based workflow execution engine.
 * Uses Session to manage workflow run state and node execution history.
 */
export class WorkflowEngine extends EventEmitter {
  /** 活跃的 session 状态，key 为 sessionId */
  private activeSessions: Map<string, ActiveSessionState> = new Map();

  /** Session ID 计数器 */
  private sessionIdCounter = 0;

  /** Session component */
  private sessionComponent?: SessionComponent;

  /** Node registry */
  private nodeRegistry: NodeRegistry;

  /** Workflow repository for loading definitions during resume */
  private workflowRepository?: WorkflowRepository;

  /**
   * Create a new WorkflowEngine
   */
  constructor(
    nodeRegistry: NodeRegistry,
    sessionComponent?: SessionComponent,
    workflowRepository?: WorkflowRepository
  ) {
    super();
    this.nodeRegistry = nodeRegistry;
    this.sessionComponent = sessionComponent;
    this.workflowRepository = workflowRepository;
  }

  /**
   * Create a WorkflowEngine with automatic AgentComponent integration
   */
  static async create(options: WorkflowEngineCreateOptions): Promise<WorkflowEngine> {
    const agentComponent = options.env?.getComponent<any>('agent');
    const sessionComponent = options.sessionComponent;

    const nodeRegistry = new NodeRegistry({
      toolRegistry: options.toolRegistry,
      skillRegistry: options.skillRegistry,
      agentComponent,
      workflowRunner: options.workflowRunner,
      sessionComponent,
    });

    return new WorkflowEngine(nodeRegistry, sessionComponent, options.workflowRepository);
  }

  // =========================================================================
  // Session ID Utilities
  // =========================================================================

  /**
   * Generate a unique run ID
   */
  private generateRunId(): string {
    // Task #1837: runId now natively carries the `workflow_` prefix so that
    // runId === sessionId (no derivation needed). The legacy
    // `run_${Date.now()}_${counter}_${random}` format is replaced by
    // `workflow_${Date.now()}_${counter}_${random}`. The `workflow_` prefix
    // is still required by the CLI and tool schema (`run-workflow.ts`
    // session regex, `workflow_run_status` / `workflow_run_stop` tools).
    const random = Math.random().toString(36).substring(2, 8);
    return `workflow_${Date.now()}_${++this.sessionIdCounter}_${random}`;
  }

  /**
   * Get session ID for a run.
   *
   * Task #1837: now an identity function — runId already has the
   * `workflow_` prefix, so sessionId equals runId exactly. The legacy
   * `\`workflow_${runId}\`` mapping is collapsed.
   *
   * Kept as a public method for backward compatibility with external
   * callers that may still derive sessionId from runId.
   */
  getSessionId(runId: string): string {
    return runId;
  }

  /**
   * Extract runId from sessionId.
   *
   * Task #1837: sessionId IS the runId (no prefix to strip). Returns the
   * input verbatim. Existing callers (event emission, pause/stop) still
   * work because they don't care about the prefix format — they just
   * need a unique identifier for the workflow run.
   */
  private getRunIdFromSessionId(sessionId: string): string {
    return sessionId;
  }

  // =========================================================================
  // Public API: Session Management
  // =========================================================================

  /**
   * Create a new workflow session
   * 
   * @param workflow - Workflow definition or entity
   * @param options - Optional configuration
   * @returns Promise resolving to sessionId (format: workflow_{runId})
   */
  @TracedAs("workflow.engine.createSession", { recordParams: true, recordResult: true, log: true })
  async createSession(
    workflow: Workflow | WorkflowDefinition,
    options?: RunOptions
  ): Promise<string> {
    const definition = 'definition' in workflow
      ? workflow.definition
      : workflow;

    const workflowId = 'id' in workflow
      ? workflow.id
      : `inline_${definition.name}`;

    const workflowName = definition.name;

    // Task #2106 GREEN-B: when the caller provides a reserved runId via
    // RunOptions, honor it as both the runId and sessionId. This lets the
    // `workflow_run` tool pre-allocate a runId that the engine can use,
    // so the runId surfaced on timeout/abort/error paths is queryable
    // via `workflow_run_status` and stoppable via `workflow_run_stop`.
    //
    // Defensive validation: refuse malformed reserved IDs rather than
    // silently falling back to a fresh one, so callers can't accidentally
    // use a string that's not workflow_-prefixed.
    let runId: string;
    if (options?.runId) {
      const reserved = options.runId;
      if (typeof reserved !== "string" || !reserved.startsWith("workflow_")) {
        throw new Error(
          `[WorkflowEngine.createSession] reserved runId must start with 'workflow_'; got ${JSON.stringify(reserved)}`,
        );
      }
      runId = reserved;
    } else {
      runId = this.generateRunId();
    }
    const sessionId = this.getSessionId(runId);

    // Create Session
    const metadata: WorkflowSessionMetadata = {
      type: 'workflow',
      workflowId,
      workflowName,
      workflowVersion: definition.version,
      status: 'running',
      runId,
      startedAt: Date.now(),
      input: options?.input,
      agentSessions: [],
    };

    if (this.sessionComponent) {
      await this.sessionComponent.create({
        id: sessionId,
        title: `Workflow: ${workflowName} (${runId})`,
        // Persist the parent session id (Task #1739). Workflows spawned from
        // another session (e.g. via `workflow_run` tool or CLI) get tracked
        // here so `sessions list --graph` can render the hierarchy.
        parentSessionId: options?.parentSessionId ?? null,
        metadata,
      });
    }

    logger.info(`[WorkflowEngine] Created session: ${sessionId}`);

    // Task #1840: notify caller that the session now exists, so they can
    // capture the runId (== sessionId) before execution begins. This is
    // the only way for the `workflow_run` tool to surface run_id on
    // timeout / error / abort paths, because execution may never return.
    //
    // Defensive: a misbehaving callback must not corrupt session creation,
    // so we swallow + log any exception thrown by the callback.
    if (options?.onSessionCreated) {
      try {
        options.onSessionCreated(sessionId);
      } catch (cbErr) {
        logger.warn(
          `[WorkflowEngine] onSessionCreated callback threw: ${cbErr instanceof Error ? cbErr.message : String(cbErr)}`,
        );
      }
    }

    return sessionId;
  }

  /**
   * Run a workflow by sessionId (unified entry point)
   * 
   * This method supports both:
   * 1. First run: session doesn't exist → create session, start from entry node
   * 2. Resume: session exists with messages → infer next node from messages
   * 
   * @param sessionId - Session ID (format: workflow_{runId} or any string)
   * @param options - Optional configuration
   * @returns Promise resolving to RunResult
   */
  // result = RunResult（含全部节点 output，可能 MB 级）→ 不入库；params 仍保留
  @TracedAs("workflow.engine.run", { recordParams: true, recordResult: false, log: true })
  async run(
    sessionId: string,
    options?: RunOptions & { workflowId?: string }
  ): Promise<RunResult> {
    // 1. Try to get existing session
    let session = this.sessionComponent 
      ? await this.sessionComponent.get(sessionId) 
      : null;
    
    let workflowDef: WorkflowDefinition | null = null;
    let workflowId: string = '';
    let workflowName: string = '';
    
    if (session) {
      // Session exists - load workflow definition
      const metadata = session.metadata as WorkflowSessionMetadata;
      if (metadata.type === 'workflow' && metadata.workflowId) {
        workflowDef = this.findDefinitionForWorkflow(metadata.workflowId);
        workflowId = metadata.workflowId;
        workflowName = metadata.workflowName;
      }
      if (!workflowDef && metadata.workflowName) {
        workflowDef = this.findDefinitionForWorkflow(metadata.workflowName);
        workflowId = metadata.workflowName;
        workflowName = metadata.workflowName;
      }
    } else {
      // No session - this is a new run
      if (!options?.workflowId) {
        throw new Error('workflowId required for new session');
      }
      
      workflowDef = this.findDefinitionForWorkflow(options.workflowId);
      if (!workflowDef) {
        throw new Error(`Workflow not found: ${options.workflowId}`);
      }
      
      workflowId = options.workflowId;
      workflowName = workflowDef.name;
      
      // Create session
      if (this.sessionComponent) {
        const sessionMetadata: WorkflowSessionMetadata = {
          type: 'workflow',
          workflowId,
          workflowName,
          workflowVersion: workflowDef.version,
          status: 'running',
          // Task #2900 P1: redact sensitive fields (password / LDAP_PASSWORD /
          // apiKey / token / secret / etc.) before persisting to session metadata.
          input: redactSensitiveFields(options?.input),
          agentSessions: [],
        };
        
        await this.sessionComponent.create({
          id: sessionId,
          title: `Workflow: ${workflowName}`,
          // Persist the parent session id (Task #1739). When `workflow_run`
          // is invoked from inside an agent session, this surfaces the
          // parent→workflow hierarchy in `sessions list --graph`.
          parentSessionId: options?.parentSessionId ?? null,
          metadata: sessionMetadata,
        });
        
        session = await this.sessionComponent.get(sessionId);
      }
    }
    
    if (!session || !workflowDef) {
      throw new Error(`Cannot start workflow: session or workflow not found`);
    }

    // Task #1840: fire the callback for resume path too. The session is
    // either pre-existing (resume) or was just created (fresh) — both
    // are valid runId sources. Fire BEFORE the status checks below so
    // callers can capture the runId even if we short-circuit (completed/failed).
    if (options?.onSessionCreated) {
      try {
        options.onSessionCreated(sessionId);
      } catch (cbErr) {
        logger.warn(
          `[WorkflowEngine] onSessionCreated callback threw (resume path): ${cbErr instanceof Error ? cbErr.message : String(cbErr)}`,
        );
      }
    }

    // 2. Check session status
    const metadata = session.metadata as WorkflowSessionMetadata;
    if (metadata.status === 'completed') {
      return { runId: this.getRunIdFromSessionId(sessionId), status: 'completed' };
    }
    // Task #1977: do NOT short-circuit on 'failed' or 'stopped'. The user
    // expects `workflow run -s <runId>` to RESUME a failed/stopped workflow
    // (workflow-runner failure handling does stop-then-resume). For these
    // statuses we fall through to the resume path, which uses
    // inferNextNode() to determine the next node (e.g. retry a failed
    // node by detecting metadata.success === false in the last
    // workflow.node.end message). 'completed' is the only terminal
    // status — there's nothing to resume from.
    
    // 3. Update session metadata if new input is provided (for resume with user input)
    if (options?.input && this.sessionComponent) {
      const hasNewInput = typeof options.input === 'string' 
        ? options.input !== undefined && options.input !== ''
        : Object.keys(options.input as object).length > 0;
      
      if (hasNewInput) {
        // Merge with existing input or use new input
        const existingInput = metadata.input as Record<string, unknown> || {};
        const newInputRaw = typeof options.input === 'string' 
          ? { userQuery: options.input as string }
          : options.input as Record<string, unknown>;
        // Task #2900 P1: redact sensitive fields from newInput before merging
        // and persisting. The existingInput was already redacted on first
        // persist, but defensive redaction is cheap.
        const newInput = redactSensitiveFields(newInputRaw) as Record<string, unknown>;
        const mergedInput = { ...existingInput, ...newInput };
        
        await this.sessionComponent.update(sessionId, {
          metadata: {
            ...metadata,
            input: mergedInput,
          },
        });
        
        // Update local metadata reference for later use
        metadata.input = mergedInput;
        
        logger.info(`[WorkflowEngine] Updated session ${sessionId} input with resume user input`);
      }
    }
    
    // 3. Load messages and infer next node
    const messages = this.sessionComponent 
      ? await this.sessionComponent.getMessages(sessionId) 
      : [];
    
    // 4. Import and use session-recovery utilities
    const {
      inferNextNode,
      extractResumeInfo,
      enrichResumeInfoWithAgentSessions,
      enrichResumePointWithAgentSessions,
    } = await import('../utils/session-recovery');
    
    // Get entry node from workflow definition
    const entry = workflowDef.entry;
    const entryNode = Array.isArray(entry) ? entry[0] : entry;
    
    const agentSessions = (metadata.agentSessions as import('../types/workflow-message').AgentSessionRef[]) ?? [];
    
    // Extract resume info including node outputs from session messages
    const resumeInfo = enrichResumeInfoWithAgentSessions(
      extractResumeInfo(messages),
      agentSessions
    );
    
    const resumePoint = enrichResumePointWithAgentSessions(
      inferNextNode(messages, {
        entryNode: entryNode !== '__default_entry__' ? entryNode : undefined,
        edges: undefined, // edges not available in WorkflowDefinition, derived at runtime
      }),
      agentSessions
    );
    
    // 5. Initialize session state and execute
    const sessionState = await this.initializeSessionState(
      sessionId,
      workflowDef,
      workflowId,
      workflowName,
      options
    );
    
    this.activeSessions.set(sessionId, sessionState);

    // 6. Run with resume point, passing restored outputs from session messages
    return this.runWithResume(sessionId, resumePoint, resumeInfo, options);
  }

  /**
   * Initialize session state
   */
  @TracedAs("workflow.engine.initializeSessionState", { recordParams: true, recordResult: false })
  private async initializeSessionState(
    sessionId: string,
    definition: WorkflowDefinition,
    workflowId: string,
    workflowName: string,
    options?: RunOptions
  ): Promise<ActiveSessionState> {
    // Check if loop mode is enabled (allows cycles in workflow)
    const loopEnabled = options?.loopEnabled ?? definition.config?.loopEnabled ?? false;
    
    // Create DAG manager (allow cycles if loop mode is enabled)
    const dagManager = new DAGManager(definition, { allowCycles: loopEnabled });

    // Validate DAG (skip cycle check if loops are enabled)
    const validation = dagManager.validate({ skipCycleCheck: loopEnabled });
    if (!validation.valid) {
      throw new Error(`Invalid workflow: ${validation.errors.join(', ')}`);
    }

    // Get parallel limit
    const parallelLimit = options?.parallelLimit 
      ?? definition.config?.parallel_limit 
      ?? null;

    // Create scheduler
    const scheduler = new Scheduler(dagManager, { parallelLimit });

    // Create event bus
    const eventBus = new EventBus();

    // Create executor
    const executorOptions: ExecutorOptions = {
      globalTimeout: options?.timeout ?? definition.config?.timeout ?? null,
      globalRetry: definition.config?.retry ?? null,
      debug: options?.debug ?? definition.config?.debug ?? false,
    };
    const executor = new Executor(this.nodeRegistry, eventBus, executorOptions, this.sessionComponent);

    // Create engine config
    const rawRuntimeInput = (options?.workflowInput ?? options?.input) as
      | Record<string, unknown>
      | undefined;

    // Load persisted workflow input from session (exclude ephemeral userQuery)
    let persistedInput: Record<string, unknown> = {};
    if (this.sessionComponent) {
      const existingSession = await this.sessionComponent.get(sessionId);
      const metaInput = existingSession?.metadata?.input as Record<string, unknown> | undefined;
      if (metaInput) {
        const { userQuery: _omit, ...rest } = metaInput;
        persistedInput = rest;
      }
    }

    const { stripEphemeralResumeInput } = await import('../utils/session-recovery');
    const { workflowInput: runtimeInput } = stripEphemeralResumeInput(rawRuntimeInput);

    // Merge defaults from workflow definition inputs schema
    // Priority: schema defaults < persisted input < runtime input
    const defaultsFromSchema: Record<string, unknown> = {};
    if (definition.inputs) {
      for (const [key, param] of Object.entries(definition.inputs)) {
        if (param.default !== undefined) {
          defaultsFromSchema[key] = param.default;
        }
      }
    }
    const mergedWorkflowInput = { ...defaultsFromSchema, ...persistedInput, ...runtimeInput };
    const workflowInput =
      Object.keys(mergedWorkflowInput).length > 0 ? mergedWorkflowInput : undefined;

    const config: WorkflowEngineConfig = {
      parallelLimit,
      timeout: options?.timeout ?? definition.config?.timeout ?? null,
      debug: options?.debug ?? definition.config?.debug ?? false,
      strict: options?.strict ?? definition.config?.strict ?? false,
      maxIterations: options?.maxIterations ?? definition.config?.maxIterations ?? 100,
      loopEnabled,
      workflowInput,
      // Task #1974: store runtime nodeConfig on sessionState so buildNodeContext
      // can read it without changing the executor signature. Defaults to empty
      // object when caller didn't pass anything (backward compat).
      nodeConfig: options?.nodeConfig ?? {},
    };

    // Create abort controller (legacy — wrapped by RuntimeCancellationScope)
    const abortController = new AbortController();

    // Create runtime cancellation scope (Task #2275)
    const cancellationScope = new RuntimeCancellationScope();

    // Create completion promise
    let resolveCompleted!: (result: RunResult) => void;
    let rejectCompleted!: (error: Error) => void;
    const completedPromise = new Promise<RunResult>((resolve, reject) => {
      resolveCompleted = resolve;
      rejectCompleted = reject;
    });

    // Create session state
    const sessionState: ActiveSessionState = {
      sessionId,
      workflowId,
      workflowName,
      status: 'running',
      startedAt: new Date(),
      eventBus,
      dagManager,
      scheduler,
      executor,
      nodeRegistry: this.nodeRegistry,
      nodeOutputs: new Map(),
      config,
      cancellationScope,
      abortController,
      completedPromise,
      resolveCompleted,
      rejectCompleted,
      workflowHistory: [],
      agentSessions: new Map(),
      edges: dagManager.buildEdges(definition.edges || []),
      loopIterationCount: 0,
      // Task #2286 fix — dedicated counter map for loop_guard.
      loopGuardCounters: new Map(),
      // Task #4392 P0-1 — concurrent-dispatch bookkeeping.
      inFlight: new Map(),
      sessionMetadataQueue: Promise.resolve(),
    };

    // Setup event handlers
    this.setupEventHandlers(sessionState);

    return sessionState;
  }

  /**
   * Run with resume point
   * 
   * Simplified logic:
   * - input is passed directly to execution (string or object)
   * - For resume with ask_user, the input should contain userQuery
   * - agentSessionId comes from session messages via resumePoint
   */
  @TracedAs("workflow.engine.runWithResume", { recordParams: true, recordResult: false })
  private async runWithResume(
    sessionId: string,
    resumePoint: { type: string; nodeId?: string; nodeIds?: string[]; agentSessionId?: string },
    resumeInfo?: { nodeOutputs: Map<string, unknown>; pendingNodeId?: string; hasInterrupt?: boolean },
    options?: RunOptions & { input?: unknown }
  ): Promise<RunResult> {
    const sessionState = this.activeSessions.get(sessionId);
    if (!sessionState) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const runId = this.getRunIdFromSessionId(sessionId);

    // Publish workflow started event
    await sessionState.eventBus.publish(
      createWorkflowEvent('workflow.started', runId, {
        workflow_name: sessionState.workflowName,
        input: options?.input,
      })
    );

    // ★ Workflow lifecycle hook：run 起点（首次运行或 resume）
    //   与上方 workflow.started 同位置，保证「事件」与「Hook」语义一致。
    //   Hook 抛错由 HookManager 隔离，不会影响运行。
    await emitWorkflowRunHook(WorkflowHookPoints.BEFORE_RUN, {
      runId,
      sessionId: sessionState.sessionId,
      workflowId: sessionState.workflowId,
      workflowName: sessionState.workflowName,
      status: 'running',
      input: options?.input,
      totalNodes: this.safeNodeCount(sessionState),
      completedNodes: sessionState.nodeOutputs.size,
    });

    // Determine what to execute based on resume point
    let pendingNodeId: string | undefined;
    let agentSessionId: string | undefined;
    
    switch (resumePoint.type) {
      case 'entry_node':
      case 'next_nodes':
        // Normal execution - scheduler will handle it
        pendingNodeId = undefined;
        break;
      case 'resume_node':
      case 'ask_user':
        // Resume specific node (interrupt or incomplete call)
        pendingNodeId = resumePoint.nodeId;
        agentSessionId = resumePoint.agentSessionId;
        break;
    }

    // Normalize input:
    // - string input -> { userQuery: string }
    // - object input -> use as-is
    let inputForExecution: Record<string, any> | undefined;
    
    if (typeof options?.input === 'string') {
      // CLI passes: --input "Yes" -> normalize to { userQuery: "Yes" }
      inputForExecution = { userQuery: options.input as string };
    } else if (options?.input && typeof options.input === 'object') {
      // Object input - use as-is
      inputForExecution = options.input as Record<string, any>;
    }
    
    // Mark completed nodes from restored state to prevent re-execution
    if (resumeInfo?.nodeOutputs) {
      const completedNodeIds = Array.from(resumeInfo.nodeOutputs.keys());
      sessionState.scheduler.markCompletedFromRestore(completedNodeIds);
    }

    // Task #2275: when the cancellation scope fires (graceful or force),
    // resolve the session's completedPromise with {status:'stopped'} so
    // that `runWorkflow()` and `waitForCompletion()` actually return. The
    // stop() method also sets `sessionState.status='stopped'` before the
    // scope fires; this listener guards against the case where node-level
    // event handlers haven't observed the abort yet.
    const resolveStoppedOnce = () => {
      if (sessionState.status === 'stopped') {
        try {
          sessionState.resolveCompleted({
            runId: this.getRunIdFromSessionId(sessionState.sessionId),
            status: 'stopped',
          });
        } catch {
          // Already resolved — ignore (idempotent).
        }
      }
    };
    sessionState.cancellationScope?.signal.addEventListener('abort', resolveStoppedOnce, { once: true });

    this.scheduleAndExecute(sessionState, {
      input: inputForExecution,
      pendingNodeId,
      agentSessionId,
      restoredOutputs: resumeInfo?.nodeOutputs,
    }).catch((error) => {
      logger.error(`Workflow ${sessionId} scheduling error:`, error);
      this.failWorkflow(sessionState, error);
    });

    // If sync mode, wait for completion
    // Use options.timeout first, fallback to config.timeout from definition
    // Task #2086: workflow_run is unified to "call → wait for completion" —
    // the `options?.sync` guard and the `return { runId, status: 'running' }`
    // fire-and-forget branch are removed. Callers needing post-completion
    // polling should use `workflow_run_status` on the returned run_id.
    const wfTimeout = options?.timeout ?? sessionState.config.timeout ?? undefined;
    return this.waitForCompletion(sessionId, wfTimeout);
  }

  /**
   * Convenience method to run a workflow directly
   */
  @TracedAs("workflow.engine.runWorkflow", { recordParams: true, recordResult: false, log: true })
  async runWorkflow(
    workflow: Workflow | WorkflowDefinition,
    options?: RunOptions
  ): Promise<RunResult> {
    const definition = 'definition' in workflow 
      ? workflow.definition 
      : workflow;
    
    const workflowId = 'id' in workflow 
      ? workflow.id 
      : `inline_${definition.name}`;
    
    const workflowName = definition.name;

    // Create session
    const sessionId = await this.createSession(workflow, options);
    
    // Initialize session state
    const sessionState = await this.initializeSessionState(
      sessionId,
      definition,
      workflowId,
      workflowName,
      options
    );
    
    this.activeSessions.set(sessionId, sessionState);

    // Run with default entry node (no resume info needed for fresh start)
    return this.runWithResume(sessionId, { type: 'entry_node' }, undefined, options);
  }

  /**
   * Pause a running workflow
   */
  @TracedAs("workflow.engine.pause", { recordParams: true, recordResult: true, log: true })
  async pause(sessionId: string): Promise<void> {
    const sessionState = this.activeSessions.get(sessionId);
    
    if (!sessionState) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (sessionState.status !== 'running') {
      throw new Error(`Session ${sessionId} is not running (current: ${sessionState.status})`);
    }

    sessionState.status = 'paused';
    sessionState.abortController.abort();
    sessionState.executor.cancelAll();

    // Update session metadata
    //
    // Task #4412 B1: routed through the serialized queue for the same reason as
    // the terminal writes — a node handler's queued write carrying a stale
    // `status: 'running'` snapshot would otherwise land after this one.
    if (this.sessionComponent) {
      await this.updateSessionMetadata(sessionState, (metadata) => ({
        ...metadata,
        status: 'paused',
      }));
    }

    // Publish pause event
    await sessionState.eventBus.publish(
      createWorkflowEvent('workflow.paused', this.getRunIdFromSessionId(sessionId), {})
    );

    logger.info(`[WorkflowEngine] Workflow paused: ${sessionId}`);
  }


  /**
   * Stop a running or paused workflow.
   *
   * Task #2275: now structured through `RuntimeCancellationScope` so that:
   *   - The session's `completedPromise` is resolved with `{status:'stopped'}`
   *     once tracked cleanup settles, NOT just metadata update.
   *   - `force=true` escalates to the scope's force level and fires any
   *     registered force handlers (e.g. process kill paths).
   *   - Cooperative runners listening to the scope signal will abort.
   *   - The legacy `abortController` is also aborted for backward compat.
   *
   * The function is idempotent — calling it twice (or stop+stop(force))
   * coalesces into a single transition.
   */
  @TracedAs("workflow.engine.stop", { recordParams: true, recordResult: true, log: true })
  async stop(
    sessionId: string,
    reason?: string,
    options: { force?: boolean } = {},
  ): Promise<void> {
    const force = options.force === true;
    const stopReason = reason ?? (force ? 'Force stop requested' : 'User requested stop');

    const sessionState = this.activeSessions.get(sessionId);

    if (!sessionState) {
      // Not in memory, try to update database
      if (this.sessionComponent) {
        const metadata = await this.getSessionMetadata(sessionId);
        // Task #2291 P1-4: respect an already-terminal status in the DB
        // (completed/failed). The previous code unconditionally wrote
        // 'stopped' even when the workflow had settled naturally before
        // this stop call arrived.
        if (
          metadata?.status === 'completed' ||
          metadata?.status === 'failed'
        ) {
          return;
        }
        await this.sessionComponent.update(sessionId, {
          metadata: {
            ...metadata,
            status: 'stopped',
            agentSessions: markAllAgentSessionsStopped(
              metadata.agentSessions as AgentSessionRef[] | undefined
            ),
          } as any,
        });
        // Task #2275: still propagate stop to any pending child sessions
        // (e.g. children created during the brief window between first
        // and second ESC, or after the session was torn down by a
        // resolved completedPromise).
        await this.propagateStopToChildSessions(sessionId, stopReason);
      }
      return;
    }

    // Task #2291 P1-4: if the session is already in a terminal state
    // (completed/failed), do NOT overwrite it. The race window was:
    // completeWorkflow sets status='completed' → engine.stop was called
    // concurrently → engine.stop unconditionally wrote status='stopped'
    // on top of the legitimate 'completed' status. We now bail out early
    // when the workflow already settled on its own.
    if (
      sessionState.status === 'completed' ||
      sessionState.status === 'failed'
    ) {
      return;
    }

    // Mark status first so node-level guards (startNode / resumeNode) short-circuit.
    sessionState.status = 'stopped';

    // Drive the cancellation scope (graceful by default, force if requested).
    // This fires the scope.signal which every node / runner is listening on,
    // AND, on force, fires forceSignal for any process-kill handlers.
    // Backward compat: when scope is missing (older test fixtures that
    // bypass initializeSessionState), the legacy abortController is used.
    if (sessionState.cancellationScope) {
      await sessionState.cancellationScope.cancel(stopReason, { force });
    }

    // Best-effort abort the legacy controller so any code path still
    // reading `abortController.signal` (older tests / internals) sees it.
    if (!sessionState.abortController.signal.aborted) {
      sessionState.abortController.abort(stopReason);
    }
    sessionState.executor.cancelAll();

    // Update session metadata
    //
    // Task #4412 B1: routed through the serialized queue (see the terminal-write
    // note in `completeWorkflow`) so a queued stale snapshot cannot revert the
    // terminal 'stopped' status back to 'running'.
    if (this.sessionComponent) {
      await this.updateSessionMetadata(sessionState, (metadata) => ({
        ...metadata,
        status: 'stopped',
        agentSessions: markAllAgentSessionsStopped(
          metadata.agentSessions as AgentSessionRef[] | undefined
        ),
      }));

      // Task #2275 — propagate the terminal stop status to each actual
      // child session record. Previously only the workflow session's
      // `agentSessions[]` references were marked, leaving the child
      // session's own metadata.status stale (a user-visible gap in
      // `sessions list --graph` where child agents still appeared active
      // after workflow stop). Each child is updated independently; one
      // update failure does not block siblings.
      await this.propagateStopToChildSessions(sessionId, stopReason);
    }

    // Publish stop event
    await sessionState.eventBus.publish(
      createWorkflowEvent('workflow.stopped', this.getRunIdFromSessionId(sessionId), {
        reason: stopReason,
      })
    );

    // ★ Workflow lifecycle hook：run 终态（stopped）
    await emitWorkflowRunHook(WorkflowHookPoints.AFTER_RUN, {
      runId: this.getRunIdFromSessionId(sessionId),
      sessionId: sessionState.sessionId,
      workflowId: sessionState.workflowId,
      workflowName: sessionState.workflowName,
      status: 'stopped',
      stopReason,
      totalNodes: this.safeNodeCount(sessionState),
      completedNodes: sessionState.nodeOutputs?.size,
    });

    // Wait briefly for tracked cleanup. The completedPromise will be
    // resolved by the path that observes the scope.signal (runWithResume
    // / scheduler loop) — we do NOT resolve it here because that would
    // race with normal completion/failure paths.
    try {
      await sessionState.cancellationScope?.waitForCleanup(force ? 500 : 1500);
    } catch {
      // waitForCleanup never throws; this catch is purely defensive.
    }

    // Task #2275: only remove from activeSessions if this was a terminal
    // stop (no further escalation possible). When called with force=false
    // on a still-living runtime, KEEP the session in activeSessions so a
    // subsequent stop({force:true}) can locate it and escalate. Cleanup
    // happens via the sessionState.status terminal check inside
    // isSessionActive (status === 'stopped' is treated as inactive).
    //
    // Task #2291 P1-2: schedule a delayed cleanupSession so the
    // sessionState (and its cancellationScope closure) does not leak
    // forever. The grace window matches SessionTreeStopper's ESC
    // double-press window so force-escalation within that window still
    // finds the session. The timer is unref'd so it does not block CLI
    // shutdown on its own.
    if (force || !sessionState.cancellationScope) {
      // Force path always cleans up. Legacy path (no scope, used by
      // existing tests that bypass initializeSessionState) also cleans
      // up immediately to preserve backward compat.
      this.cleanupSession(sessionState);
    } else {
      // Graceful path: keep the session in activeSessions for a bounded
      // window so a follow-up stop({force:true}) can escalate. After
      // the window, evict.
      const GRACE_MS = 2000;
      const timer = setTimeout(() => {
        // Only evict if the entry is still a 'stopped' sessionState (i.e.
        // a force-escalation did not re-arm the session in the meantime).
        const current = this.activeSessions.get(sessionId);
        if (current === sessionState && current.status === 'stopped') {
          this.cleanupSession(current);
        }
      }, GRACE_MS);
      if (typeof (timer as any).unref === "function") {
        (timer as any).unref();
      }
    }
  }

  /**
   * Get session status
   */
  getSessionStatus(sessionId: string): RunStatus | null {
    const sessionState = this.activeSessions.get(sessionId);
    return sessionState?.status ?? null;
  }

  /**
   * Task #2275 — propagate a workflow stop to each actual child agent
   * session record. The previous engine.stop only updated the workflow
   * session's `agentSessions[]` references, leaving child session
   * metadata.status stale (a gap visible in `sessions list --graph`
   * where the user saw `agent_plan_*` and `agent_init-task_*` still
   * listed without a stopped status after the workflow was stopped).
   *
   * Behavior:
   *   - Iterates ALL sessions whose parentSessionId matches this
   *     workflow session (not just refs in metadata.agentSessions, so
   *     children created in the brief window between schedule and stop
   *     are also caught).
   *   - For each child session:
   *     - Skip if status is already terminal (completed/failed/stopped)
   *     - Update metadata.status = "stopped", append stop reason
   *   - Errors are isolated per child — one failure does not block siblings
   *   - No-op when sessionComponent is missing or workflow has no children
   *
   * Idempotency: a second invocation only touches children that are
   * still non-terminal, so double-stop is safe.
   */
  @TracedAs("workflow.engine.propagateStopToChildSessions", { recordParams: false, recordResult: true })
  private async propagateStopToChildSessions(
    workflowSessionId: string,
    reason: string,
  ): Promise<void> {
    if (!this.sessionComponent?.list || !this.sessionComponent.update) return;
    let allChildSessions: Array<{ id: string; metadata?: any }>;
    try {
      // Task #2291 P1-1: paginate sessionComponent.list to avoid the
      // silent-drop bug that Task #2245 Codex P1-2 already fixed in
      // WorkflowService.listAllSessions. The previous single-call
      // `list({ limit: 10_000 })` dropped any children past index 10K —
      // a real risk in long-lived REPL sessions with >10K total sessions.
      // Mirrors the WorkflowService pagination pattern: PAGE=1000,
      // HARD_CAP=50_000, EOF on short batch.
      const PAGE = 1000;
      const HARD_CAP = 50_000;
      const allSessions: Array<{ id: string; parentSessionId?: string | null; metadata?: any }> = [];
      let offset = 0;
      while (allSessions.length < HARD_CAP) {
        const batch = (await this.sessionComponent.list({
          limit: PAGE,
          offset,
        })) as Array<{ id: string; parentSessionId?: string | null; metadata?: any }>;
        allSessions.push(...batch);
        if (batch.length < PAGE) break; // short batch → EOF
        offset += PAGE;
      }
      allChildSessions = allSessions
        .filter((s) => s?.parentSessionId === workflowSessionId)
        .map((s) => ({ id: s.id, metadata: s.metadata }));
    } catch (err) {
      logger.warn(
        `[WorkflowEngine] propagateStopToChildSessions list failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    if (!allChildSessions?.length) return;
    for (const ref of allChildSessions) {
      if (!ref?.id) continue;
      try {
        const child = await this.sessionComponent.get(ref.id);
        if (!child) continue;
        const childMeta = (child.metadata as Record<string, unknown>) ?? {};
        const currentStatus = childMeta.status as string | undefined;
        // Preserve terminal states (completed/failed/stopped).
        if (
          currentStatus === "completed" ||
          currentStatus === "failed" ||
          currentStatus === "stopped"
        ) {
          continue;
        }
        await this.sessionComponent.update(ref.id, {
          metadata: {
            ...childMeta,
            status: "stopped",
            stopReason: reason,
            stoppedAt: Date.now(),
          },
        });
      } catch (err) {
        logger.warn(
          `[WorkflowEngine] propagateStopToChildSessions failed for ${ref.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /**
   * Check if session is active
   */
  isSessionActive(sessionId: string): boolean {
    const s = this.activeSessions.get(sessionId);
    if (!s) return false;
    // Task #2275: a 'stopped' session kept around for force escalation
    // is NOT active. Active means truly running.
    return s.status === 'running' || s.status === 'paused';
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  /**
   * Setup event handlers for a run
   */
  private setupEventHandlers(sessionState: ActiveSessionState): void {
    const { sessionId, eventBus, scheduler } = sessionState;
    const runId = this.getRunIdFromSessionId(sessionId);

    // Handle node completed — history only; edge processing runs in validateAndExecute
    eventBus.on('node.completed', async (event: WorkflowEvent) => {
      if (event.type !== 'node.completed') return;

      if (event.output && typeof event.output === 'object' && 'workflowHistory' in event.output) {
        const messages = (event.output as any).workflowHistory;
        if (Array.isArray(messages)) {
          sessionState.workflowHistory.push(...messages);
        }
      }

      // Mark this node's agent session as completed (BUG-C, Task #2178)
      // Task #4392 P0-1: routed through the serialized RMW helper — with
      // concurrent nodes, two completions could otherwise interleave
      // get→update and lose one another's agentSessions marker.
      await this.updateSessionMetadata(sessionState, (metadata) => ({
        ...metadata,
        agentSessions: markAgentSessionCompleted(
          metadata.agentSessions as AgentSessionRef[] | undefined,
          event.node_id
        ),
      }));
    });

    // Handle node failed
    eventBus.on('node.failed', async (event: WorkflowEvent) => {
      if (event.type !== 'node.failed') return;

      // Mark this node's agent session as failed FIRST (BUG-D, Task #2178)
      // This gives explicit per-node attribution; the bulk markAllAgentSessionsFailed
      // inside failWorkflow() preserves the already-failed entry.
      await this.updateSessionMetadata(sessionState, (metadata) => ({
        ...metadata,
        agentSessions: markAgentSessionFailed(
          metadata.agentSessions as AgentSessionRef[] | undefined,
          event.node_id
        ),
      }));

      scheduler.markFailed(event.node_id);
      await this.failWorkflow(sessionState, new Error(event.error.message));
    });

    // Handle node interrupt (ask_user pause)
    eventBus.on('node.interrupt', async (event: WorkflowEvent) => {
      if (event.type !== 'node.interrupt') return;

      logger.info(`Workflow paused at node "${event.node_id}" - ask_user pending`);

      sessionState.status = 'paused';
      sessionState.abortController.abort();

      // Update session metadata (P2)
      //
      // Task #4412 B1: this handler runs concurrently with node.completed /
      // node.failed, and it writes `status`. A bare get → spread → update can
      // both lose a sibling's `agentSessions` marker and resurrect a stale
      // `status`, so it goes through the same serialized queue as the terminal
      // writes. `updateAgentSessionStatus` moved inside the callback because it
      // must operate on the freshly-read array.
      if (this.sessionComponent) {
        await this.updateSessionMetadata(sessionState, (metadata) => {
          const agentSessions = updateAgentSessionStatus(
            metadata.agentSessions as AgentSessionRef[] | undefined,
            event.node_id,
            'paused'
          );
          return {
            ...metadata,
            status: 'paused',
            pendingNodeId: event.node_id,
            pauseReason: 'ask_user',
            pendingAskUserQuery: (event as any).query,
            pendingAskUserAgentSessionId: (event as any).agent_session_id,
            agentSessions,
          };
        });
      }

      // Publish workflow.paused event
      await eventBus.publish(
        createWorkflowEvent('workflow.paused', runId, {
          pendingNodeId: event.node_id,
          query: (event as any).query,
        })
      );

      // Write interrupt message via executor (P0 unified path)
      await sessionState.executor.writeNodeInterrupt(
        sessionId,
        event.node_id,
        event.node_type,
        (event as any).query,
        (event as any).agent_session_id
      );

      // Resolve with paused status
      sessionState.resolveCompleted({
        runId,
        status: 'paused',
        pendingNodeId: event.node_id,
        query: (event as any).query,
        agentSessionId: (event as any).agent_session_id,
      });
    });
  }

  /**
   * Main scheduling loop
   */
  @TracedAs("workflow.engine.scheduleAndExecute", { recordParams: true, recordResult: true })

  private async scheduleAndExecute(
    sessionState: ActiveSessionState,
    options?: {
      input?: Record<string, any>;
      pendingNodeId?: string;
      agentSessionId?: string;
      restoredOutputs?: Map<string, unknown>;
    }
  ): Promise<void> {
    const { scheduler, executor, eventBus, abortController, nodeOutputs } = sessionState;
    const { input: globalInput, pendingNodeId, agentSessionId, restoredOutputs } = options || {};

    const { stripEphemeralResumeInput } = await import('../utils/session-recovery');
    const { workflowInput: inputToPersist, userQuery: resumeUserQuery } =
      stripEphemeralResumeInput(globalInput as Record<string, unknown> | undefined);

    // Keep session config in sync with runtime input (userQuery is ephemeral — not persisted)
    if (inputToPersist) {
      sessionState.config.workflowInput = {
        ...(sessionState.config.workflowInput || {}),
        ...inputToPersist,
      };
    }

    // Reset loop iteration counter (tracks back-edge triggers, not schedule rounds)
    sessionState.loopIterationCount = 0;
    const maxIterations = sessionState.config.maxIterations;

    // Merge restored outputs if any
    if (restoredOutputs) {
      for (const [nodeId, output] of restoredOutputs) {
        nodeOutputs.set(nodeId, output);
      }
    }

    // Helper to schedule available nodes
    const scheduleAvailableNodes = async (): Promise<boolean> => {
      const state = scheduler.getState();
      const completedNodes = new Set(state.completed);

      const readyNodes = scheduler.getReadyNodes(completedNodes);
      const canStart = scheduler.canStartMore();

      if (readyNodes.length === 0 || !canStart) {
        return false;
      }

      const parallelLimit = sessionState.config.parallelLimit ?? Infinity;

      let scheduled = 0;
      for (const nodeId of readyNodes) {
        if (!scheduler.canStartMore()) break;
        if (scheduled >= parallelLimit) break;
        // ── Dispatch without awaiting completion (Task #4392 P0-1) ──────────
        //
        // The bug: `await this.startNode(...)` did not resolve until the node
        // had *finished*, so a fan-out DAG ran strictly one node at a time.
        // Production trace evidence (#4385 §3.6): 6 ready build nodes with
        // `parallel_limit=6` started at t+0.1 / 827.3 / 1639.5 / 2464.5 /
        // 3277.8s — back-to-back, zero overlap, ~61.5 wasted minutes.
        //
        // The fix keeps `await` but moves it off the dispatch path: the node's
        // promise is stored in `sessionState.inFlight` and joined by the main
        // loop. Backpressure is preserved by `canStartMore()` (which reads
        // `scheduler.running`, incremented *synchronously* by
        // `startNode → scheduler.markStarted()`), so `parallel_limit` still
        // gates fan-out exactly as before.
        //
        // Two invariants matter for correctness:
        //  1. `markStarted` happens synchronously inside `startNode`'s first
        //     tick, i.e. before the first `await`. So the next loop iteration
        //     already sees the node as running and `canStartMore()` accounts
        //     for it — no over-dispatch.
        //  2. The tracked promise must NEVER reject: `startNode` funnels node
        //     errors into `scheduler.markFailed` + a `node.failed` event, which
        //     is what drives fail-fast. Rejections here would escape to the
        //     `.catch` in `runWithResume` and could strand siblings.
        //
        // `dispatchNode` returns false when another path already claimed the
        // node (edge processing or a previous round), in which case it must
        // not count against the concurrency budget.
        if (this.dispatchNode(sessionState, nodeId, sessionState.config.workflowInput)) {
          scheduled++;
        }
      }

      return true;
    };

    // Initial scheduling
    if (pendingNodeId) {
      // Resume mode: only schedule the pending node with agentSessionId.
      // Kept awaited: there is exactly one node and the caller's resume
      // semantics ("continue this node") are inherently sequential.
      await this.resumeNode(sessionState, pendingNodeId, {
        agentSessionId,
        userQuery: resumeUserQuery as string | undefined,
      });
    } else {
      await scheduleAvailableNodes();
    }

    // Event-driven loop
    // Task #2291 P0-2 (Claude review): also observe the cancellationScope
    // signal so that any code path which fires the scope independently of
    // the legacy abortController (e.g. a future force-handler-driven
    // cleanup branch) still breaks the loop. Without this, scope-only
    // cancels leave the scheduler hanging.
    while (
      sessionState.status === 'running' &&
      !abortController.signal.aborted &&
      !sessionState.cancellationScope?.signal.aborted
    ) {
      const state = scheduler.getState();
      // Task #4392 P0-1: `inFlight` is the authoritative "work outstanding"
      // signal now that dispatches are concurrent. `running` can be empty
      // while a node is still finishing its tail work (AFTER_NODE hook,
      // conditional-edge processing, checkAndFinalize) — exiting here would
      // tear down the event bus mid-flight and drop those writes.
      if (state.pending.length === 0 && state.running.length === 0 && sessionState.inFlight.size === 0) {
        break;
      }

      // Check max iterations (based on loopIterationCount, not schedule rounds)
      // Only meaningful when loopEnabled is true
      //
      // Task #4392 P0-1: two adjustments, both required now that re-entries are
      // driven with an *inline await* from `processConditionalEdgesAfterCompletion`
      // (which is the authority on loop accounting) instead of running nested
      // while this loop was parked:
      //  1. `>` not `>=` — the edge path permits `nextCount === maxIterations`
      //     and rejects only `nextCount > maxIterations`. Using `>=` here fired
      //     a beat early and truncated the final iteration (measured:
      //     `plan`/`verify` ran 3x instead of the expected 4x).
      //  2. `failWorkflow` not `rejectCompleted` — the run must settle with a
      //     `{status:'failed'}` RunResult, identical to the edge-path outcome.
      if (sessionState.config.loopEnabled && sessionState.loopIterationCount > maxIterations) {
        logger.error(`[WorkflowEngine] Max loop iterations ${maxIterations} exceeded`);
        await this.failWorkflow(
          sessionState,
          new WorkflowError(`Workflow exceeded maximum loop iterations: ${maxIterations}`)
        );
        return;
      }

      try {
        await this.waitForNextNodeEvent(sessionState, abortController.signal);
      } catch {
        break;
      }

      await scheduleAvailableNodes();
    }

    // Final join (Task #4392 P0-1).
    //
    // Reaching here means the loop observed a terminal/aborted state. Any node
    // dispatched in the last round may still be settling; await it so that
    // `cleanupSession()` (which clears the event bus) never runs underneath a
    // live node. `allSettled` — not `all` — because a rejected promise here
    // must not mask an already-recorded node failure.
    while (sessionState.inFlight.size > 0) {
      const pending = Array.from(sessionState.inFlight.values());
      await Promise.allSettled(pending);
      // Prune settled entries; a node may have re-entered (back-edge) and
      // registered a fresh promise, so re-check rather than assuming empty.
      for (const [nodeId, promise] of Array.from(sessionState.inFlight.entries())) {
        if (pending.includes(promise)) {
          sessionState.inFlight.delete(nodeId);
        }
      }
    }
  }

  /**
   * Dispatch a node without waiting for it to finish (Task #4392 P0-1).
   *
   * Registers the node's promise in `sessionState.inFlight` **synchronously**
   * so the scheduler loop can (a) join it and (b) never mistake "no tracked
   * work" for "done". The returned promise is intentionally swallowed: node
   * outcomes propagate through `scheduler.markFailed` and the `node.failed`
   * event, exactly as they did when the dispatch path awaited them.
   *
   * ## Claim guard — why this is not just "call startNode"
   *
   * A node can be reachable from **two** dispatch paths:
   *   1. `scheduleAvailableNodes()` → `scheduler.getReadyNodes()` (DAG readiness)
   *   2. `processConditionalEdgesAfterCompletion()` → `edgeResult.toStart`
   *
   * Under the old serial loop this never mattered: path 2 awaited each target
   * to completion, so path 1 always found them `completed` already. Once
   * dispatch became concurrent the two paths race and the *same* node was
   * executed twice (proven by `engine-parallel-scheduling.test.ts`:
   * `parallelLimit=2` produced peak concurrency 3 with 4 of 6 leaves run twice).
   *
   * `scheduler.running` is the tie-breaker. `startNode` calls
   * `scheduler.markStarted()` before its first `await`, so the claim is visible
   * synchronously to the next dispatcher on the same tick — no interleaving
   * window. Returns `true` only for the caller that actually won the claim.
   *
   * ⚠️ The guard deliberately keys off `scheduler.running` and **not** off
   * `inFlight`, even though both look equivalent. A self-loop back-edge
   * (`implement → implement`) re-dispatches the node *from inside its own
   * completion handler*, i.e. while its own promise is still in `inFlight` but
   * after `resetNodeForReEntry()` cleared `running`. Guarding on `inFlight`
   * deadlocks exactly that case: the node waits for itself forever.
   */
  private dispatchNode(
    sessionState: ActiveSessionState,
    nodeId: string,
    input?: Record<string, any>
  ): boolean {
    const { scheduler } = sessionState;

    // Already claimed (running) or already settled — skip.
    if (
      scheduler.isRunning(nodeId) ||
      scheduler.isCompleted(nodeId) ||
      scheduler.isFailed(nodeId)
    ) {
      return false;
    }

    const promise = this.startNode(sessionState, nodeId, input)
      .catch((error) => {
        // `startNode` should already have converted node errors into
        // scheduler/event state. If something escaped anyway (e.g. an event
        // handler or hook threw), record it rather than leaving a floating
        // rejection — but do not rethrow: the run's terminal state is decided
        // by `failWorkflow` / `completeWorkflow`.
        logger.error(`[WorkflowEngine] Unhandled dispatch error for node "${nodeId}":`, error);
      })
      .finally(() => {
        // Only clear our own entry (a back-edge re-entry overwrites it).
        if (sessionState.inFlight.get(nodeId) === promise) {
          sessionState.inFlight.delete(nodeId);
        }
      });

    sessionState.inFlight.set(nodeId, promise);
    return true;
  }

  /**
   * Wait for next node event
   * 
   * Optimization: When there are running nodes, use pure event-driven waiting
   * (no polling). When there are only pending nodes (dependencies not yet met),
   * use a small timeout to re-check scheduling conditions.
   *
   * Task #4392 P0-1 — two additions that concurrent dispatch makes necessary:
   *
   * 1. **`inFlight` also arms the timeout.** `scheduler.running` is cleared by
   *    `markCompleted` inside `validateAndExecute`, but the node's promise is
   *    still settling (AFTER_NODE hook, conditional edges, `checkAndFinalize`).
   *    In that window `hasRunningNodes` is false while real work continues, so
   *    we must keep a wakeup source armed or the loop could park forever.
   *
   * 2. **`node.scheduled` resolves the wait.** Concurrent dispatch publishes
   *    `node.scheduled` for sibling nodes (and for loop re-entries) *after* this
   *    waiter subscribed — with `node.completed`/`node.failed` as the only
   *    trigger, a round whose completion event fired during the synchronous
   *    dispatch section would leave the loop blocked until the 100ms poll.
   *    Subscribing to `node.scheduled` closes that lost-wakeup window.
   */
  @TracedAs("workflow.engine.waitForNextNodeEvent", { recordParams: true, recordResult: true })
  private waitForNextNodeEvent(
    sessionState: ActiveSessionState,
    signal: AbortSignal
  ): Promise<void> {
    return new Promise((resolve) => {
      const state = sessionState.scheduler.getState();
      const hasRunningNodes = state.running.length > 0;
      const hasInFlight = sessionState.inFlight.size > 0;

      // Wakeup policy (Task #4392 P0-1):
      //
      // Event-driven waiting is only safe when *two* conditions hold:
      //   (a) some node is running or in flight, AND
      //   (b) nothing is waiting on a free concurrency slot.
      //
      // (b) is the subtle one. Edge-triggered starts that did not fit in the
      // concurrency budget are deliberately deferred (see
      // `processConditionalEdgesAfterCompletion`), and a deferred node emits no
      // event of its own — it can only be picked up by a scheduling round. If
      // the loop parked event-driven while in-flight work was at the limit, the
      // deferred node would wait for a `node.completed` that never gets the
      // loop to re-schedule (measured: `parallel_limit=1` deadlocked for 5s).
      //
      // So: keep the 100ms wakeup unless genuinely blocked on an event.
      const limit = sessionState.config.parallelLimit ?? Infinity;
      const atCapacity = sessionState.inFlight.size >= limit;
      const mayHaveDeferredWork = atCapacity && state.pending.length + state.ready.length > 0;

      const pureEventDriven = hasRunningNodes && hasInFlight && !mayHaveDeferredWork;

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      if (!pureEventDriven) {
        timeoutId = setTimeout(() => {
          cleanup();
          resolve();
        }, 100);
      }
      
      const cleanup = () => {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        sessionState.eventBus.off('node.completed', onCompleted);
        sessionState.eventBus.off('node.failed', onFailed);
        sessionState.eventBus.off('node.scheduled', onScheduled);
      };
      
      const onCompleted = (event: WorkflowEvent) => {
        if (event.type === 'node.completed') {
          cleanup();
          resolve();
        }
      };
      
      const onFailed = (event: WorkflowEvent) => {
        if (event.type === 'node.failed') {
          cleanup();
          resolve();
        }
      };

      const onScheduled = (event: WorkflowEvent) => {
        if (event.type === 'node.scheduled') {
          cleanup();
          resolve();
        }
      };
      
      sessionState.eventBus.on('node.completed', onCompleted);
      sessionState.eventBus.on('node.failed', onFailed);
      sessionState.eventBus.on('node.scheduled', onScheduled);
      
      if (signal.aborted) {
        cleanup();
        resolve();
      }
    });
  }

  /**
   * Start execution of a single node
   */
  @TracedAs("workflow.engine.startNode", { recordParams: true, recordResult: true })

  private async startNode(
    sessionState: ActiveSessionState,
    nodeId: string,
    input?: Record<string, any>
  ): Promise<void> {
    const { scheduler, executor, eventBus, dagManager } = sessionState;
    const sessionId = sessionState.sessionId;
    const runId = this.getRunIdFromSessionId(sessionId);
    
    scheduler.markStarted(nodeId);

    // Publish scheduled event
    await eventBus.publish(
      createWorkflowEvent('node.scheduled', runId, {
        node_id: nodeId,
      })
    );

    // Get node definition
    const nodeDef = dagManager.getNode(nodeId);
    if (!nodeDef) {
      scheduler.markFailed(nodeId);
      return;
    }

    // Build execution context
    // Note: writeNodeStart is called by executor.executeNode to avoid double-write
    const context = this.buildNodeContext(sessionState, nodeId, input);

    // Validate and execute using common method
    await this.validateAndExecute(nodeDef, context, sessionState);
  }

  /**
   * Write workflow.node.start message
   */
  @TracedAs("workflow.engine.writeNodeStart", { recordParams: true, recordResult: true })

  private async writeNodeStart(
    sessionId: string,
    nodeId: string,
    nodeType: string,
    input?: any
  ): Promise<void> {
    if (this.sessionComponent) {
      await this.sessionComponent.addMessage(sessionId, {
        role: 'workflow.node.start',
        content: JSON.stringify({ input }),
        metadata: {
          type: 'workflow.node.start',
          workflowNodeId: nodeId,
          workflowNodeType: nodeType,
          timestamp: Date.now(),
        },
      });
    }
  }

  /**
   * Resume execution of a paused node
   * 
   * Simplified logic:
   * - Load agent session from agentSessionId
   * - Pass userQuery from input to agentNode
   * - No complex userResponse distinction
   */
  @TracedAs("workflow.engine.resumeNode", { recordParams: true, recordResult: true })
  private async resumeNode(
    sessionState: ActiveSessionState,
    nodeId: string,
    options?: {
      agentSessionId?: string;
      userQuery?: string;
    }
  ): Promise<void> {
    const { scheduler, executor, eventBus, dagManager } = sessionState;
    const sessionId = sessionState.sessionId;
    const runId = this.getRunIdFromSessionId(sessionId);
    
    scheduler.markStarted(nodeId);

    const nodeDef = dagManager.getNode(nodeId);
    if (!nodeDef) {
      scheduler.markFailed(nodeId);
      return;
    }

    // Resolve agentSessionId: explicit option → workflow metadata.agentSessions fallback
    let agentSessionId = options?.agentSessionId;
    if (!agentSessionId && this.sessionComponent) {
      const session = await this.sessionComponent.get(sessionId);
      const agentSessions = (session?.metadata as { agentSessions?: import('../types/workflow-message').AgentSessionRef[] })?.agentSessions;
      const { resolveAgentSessionId } = await import('../utils/session-recovery');
      agentSessionId = resolveAgentSessionId(nodeId, undefined, agentSessions);
    }

    // Write workflow.node.resume via executor (P0 unified path)
    await sessionState.executor.writeNodeResume(
      sessionId,
      nodeId,
      nodeDef.type,
      options?.userQuery ?? '',
      agentSessionId
    );

    // Publish resume event
    await eventBus.publish(
      createWorkflowEvent('node.started', runId, {
        node_id: nodeId,
        agentSessionId,
        userQuery: options?.userQuery,
      })
    );

    // Build execution context — userQuery is injected directly, not via workflowInput
    const context = this.buildNodeContext(
      sessionState,
      nodeId,
      sessionState.config.workflowInput
    );

    if (options?.userQuery !== undefined) {
      // context.input is typed as unknown; narrow with cast (minimal change)
      (context.input as { userQuery?: unknown }).userQuery = options.userQuery;
    }

    // agentSessionId is passed to agentNode so it can load the correct sub-session
    if (agentSessionId) {
      (context as any).agentSessionId = agentSessionId;
    }

    // Validate and execute using common method (applies strict mode validation)
    await this.validateAndExecute(nodeDef, context, sessionState);
  }

  /**
   * Pre-execute validation
   * Validates node configuration before execution
   * Checks for unresolved templates and throws in strict mode
   */
  @TracedAs('workflow.engine.preExecuteValidation')
  private async preExecuteValidation(
    nodeId: string,
    nodeDef: { config?: Record<string, unknown> },
    context: NodeExecutionContext,
    options?: { strict?: boolean }
  ): Promise<void> {
    // Validate node configuration
    if (!nodeDef) {
      logger.warn(`Node ${nodeId} has no configuration`);
      return;
    }
    
    const config = nodeDef.config || {};
    
    // Log context for debugging
    if (context.debug) {
      logger.debug(`Pre-execute validation for node ${nodeId}`, {
        workflowInput: context.workflowInput,
        previousOutputs: Array.from(context.previousOutputs.keys()),
        hasTemplateResolver: !!context.templateResolver,
      });
    }
    
    // Template resolution validation
    if (context.templateResolver) {
      const { unresolved } = context.templateResolver.resolveAndValidate(config);
      
      if (unresolved.length > 0) {
        if (options?.strict) {
          // In strict mode, resolveStrict throws on unresolved templates
          // Pass nodeId as context (execution node, not referenced node)
          // Note: resolveStrict internally calls resolveAndValidate and throws appropriate
          // TemplateUnresolvedError/NodeNotFoundError/PathNotFoundError based on template type
          context.templateResolver.resolveStrict(config, nodeId);
          // Should not reach here - resolveStrict throws on unresolved templates
        }
        // In warn mode, just log a warning
        logger.warn(`[WorkflowEngine] Node "${nodeId}" has unresolved templates:`, unresolved);
      }
    }
  }

  /**
   * Validate node configuration and execute it
   * Common method used by both startNode and resumeNode
   */
  @TracedAs("workflow.engine.validateAndExecute", { recordParams: true, recordResult: true })
  private async validateAndExecute(
    nodeDef: NodeDefinition,
    context: NodeExecutionContext,
    sessionState: ActiveSessionState
  ): Promise<void> {
    const { scheduler, executor, eventBus } = sessionState;
    const { nodeId } = context;
    
    // Pre-execute validation - must await to prevent race condition
    // In strict mode, validation failure means skip execution
    const strictMode = sessionState.config?.strict ?? false;
    try {
      await this.preExecuteValidation(nodeId, nodeDef, context, { strict: strictMode });
    } catch (err) {
      // Strict validation failed - mark node as failed and skip execution
      logger.error(`[WorkflowEngine] Strict validation failed for node ${nodeId}:`, err);
      scheduler.markFailed(nodeId);
      return;
    }

    // ★ Workflow lifecycle hook：节点即将执行
    //   载荷里带上 totalNodes / completedNodes，插件无需回查 engine 内部状态
    //   即可渲染进度条。
    await emitWorkflowNodeHook(WorkflowHookPoints.BEFORE_NODE, {
      runId: context.runId,
      sessionId: context.sessionId,
      workflowName: context.workflowName,
      nodeId,
      nodeType: nodeDef.type,
      status: 'running',
      input: context.input,
      totalNodes: this.safeNodeCount(sessionState),
      completedNodes: sessionState.nodeOutputs.size,
      agentSessionId: (context as any).agentSessionId,
    });

    // Execute node and await completion (including conditional edge processing)
    try {
      const result = await executor.executeNode(nodeDef, context);

      if (result.error) {
        // ★ Workflow lifecycle hook：节点失败
        await emitWorkflowNodeHook(WorkflowHookPoints.AFTER_NODE, {
          runId: context.runId,
          sessionId: context.sessionId,
          workflowName: context.workflowName,
          nodeId,
          nodeType: nodeDef.type,
          status: 'failed',
          output: result.output,
          error: result.error instanceof Error ? result.error.message : String(result.error),
          durationMs: result.durationMs,
          totalNodes: this.safeNodeCount(sessionState),
          completedNodes: sessionState.nodeOutputs.size,
          agentSessionId: (context as any).agentSessionId,
        });
        return;
      }

      sessionState.nodeOutputs.set(nodeId, result.output);
      scheduler.markCompleted(nodeId);

      // ★ Workflow lifecycle hook：节点成功
      //   注意：先 set nodeOutputs 再触发，让 completedNodes 反映该节点已计入。
      await emitWorkflowNodeHook(WorkflowHookPoints.AFTER_NODE, {
        runId: context.runId,
        sessionId: context.sessionId,
        workflowName: context.workflowName,
        nodeId,
        nodeType: nodeDef.type,
        status: 'completed',
        output: result.output,
        durationMs: result.durationMs,
        totalNodes: this.safeNodeCount(sessionState),
        completedNodes: sessionState.nodeOutputs.size,
        agentSessionId: (context as any).agentSessionId,
      });

      if (result.output && typeof result.output === 'object' && 'workflowHistory' in result.output) {
        const messages = (result.output as any).workflowHistory;
        if (Array.isArray(messages)) {
          sessionState.workflowHistory.push(...messages);
        }
      }

      await this.processConditionalEdgesAfterCompletion(sessionState, nodeId);
      this.checkAndFinalize(sessionState);
    } catch (error) {
      if (error instanceof AskUserError) {
        await eventBus.publish(createNodeInterruptEvent(
          context.runId,
          nodeId,
          nodeDef.type,
          error.query,
          error.agentSessionId
        ));
        return;
      }

      scheduler.markFailed(nodeId);
    }
  }

  /**
   * Loop-guard check for a single back-edge re-entry.
   *
   * Task #2283 — engine-side progress guard. Reads the node's
   * `config.loop_guard` and decides whether the upcoming re-entry would
   * be a no-progress attempt. If the no-progress counter reaches
   * `max_consecutive_no_progress`, the function returns
   * `{ trip: true, failMessage }` so the caller can short-circuit the
   * agent and inject a fail output.
   *
   * Behavior matrix for the `value_unchanged` type:
   *   - previous_value === current_value (after JSON.stringify)
   *       → increment counter; if >= maxAllowed → trip; else allow
   *   - previous_value !== current_value
   *       → reset counter to 0; allow
   *   - previous_value is undefined (first run for this node)
   *       → first re-entry: count this as a "change" (we don't know the
   *         prior state); allow
   *   - current_signal_command fails to execute
   *       → allow (defensive: don't false-positive on transient shell errors)
   *
   * The counter is persisted in `sessionState.loopGuardCounters`
   * (Task #2286 fix — dedicated map, independent of `nodeOutputs`).
   *
   * Earlier versions stored the counter under the well-known key
   * `_loop_guard_consecutive_<nodeId>` directly on the node's prior
   * output map. That broke once `max_consecutive_no_progress >= 2`,
   * because the next agent run overwrote the whole output via
   * `sessionState.nodeOutputs.set(nodeId, result.output)`, clobbering
   * the counter on every back-edge. The dedicated map survives agent
   * output writes because nothing else mutates it.
   *
   * The caller MUST pass a `templateResolver` whose previousOutputs
   * already include the pre-cascade-reset snapshot for `reEntryId`.
   * The post-reset state would otherwise resolve `{{nodes.<reEntryId>.*}}`
   * to undefined.
   */
  private async checkLoopGuardWithSnapshot(
    sessionState: ActiveSessionState,
    templateResolver: TemplateResolver,
    reEntryId: string,
    snapshotPreviousOutput: Record<string, unknown>,
  ): Promise<
    | { trip: true; failMessage: string; counterKey: string; nextCount: number }
    | { trip: false; counterKey: string; nextCount: number }
  > {
    const guard = sessionState.dagManager.getLoopGuard(reEntryId);
    if (!guard) {
      // Defensive — caller already filters by getLoopGuard, but be safe.
      return { trip: false, counterKey: '', nextCount: 0 };
    }

    const counterKey = `_loop_guard_consecutive_${reEntryId}`;
    // Task #2286 fix — read the counter from sessionState.loopGuardCounters
    // (NOT from snapshotPreviousOutput[counterKey]). The agent's next run
    // overwrites nodeOutputs entirely, which used to clobber the counter.
    const previousCount = sessionState.loopGuardCounters.get(reEntryId) ?? 0;

    // Resolve the previous value via the template resolver. Use
    // resolveValue so the user can write either "{{nodes.x.y}}" or a
    // literal string. resolveValue preserves objects/arrays for pure
    // template references, which lets us compare structured values
    // against the command's stdout.
    const previousValue = templateResolver.resolveValue(guard.previous_signal);

    // Resolve the working directory and current_signal_command through
    // the same TemplateResolver so workflow YAML can legitimately store
    // template strings (e.g. `{{input.worktree_path}}`,
    // `{{input.branch_name}}`) in the loop_guard config. Without this,
    // `execFileAsync` would receive the raw `{{...}}` and fail
    // (silently absorbed by the catch below → "allow re-entry forever"
    // silent short-circuit, Task #2438 root cause B).
    const resolvedCwdRaw = templateResolver.resolveValue(guard.cwd);
    const resolvedCwd =
      typeof resolvedCwdRaw === 'string' && resolvedCwdRaw.length > 0
        ? resolvedCwdRaw
        : undefined;
    const resolvedCommandRaw = templateResolver.resolveValue(guard.current_signal_command);
    const resolvedCommand =
      typeof resolvedCommandRaw === 'string' && resolvedCommandRaw.length > 0
        ? resolvedCommandRaw
        : guard.current_signal_command;

    // Determine the working directory. Resolved guard.cwd wins;
    // otherwise fall back to the workflow input's project_path;
    // otherwise use process.cwd() so a misconfigured guard at least
    // runs in a sane place.
    const cwd =
      resolvedCwd ??
      (sessionState.config.workflowInput?.project_path as string | undefined) ??
      process.cwd();

    let currentValue: unknown;
    try {
      const { stdout } = await execFileAsync('/bin/sh', ['-c', resolvedCommand], {
        cwd,
        timeout: 10_000,
      });
      currentValue = stdout.trim();
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      // Task #2438 fix C (fail-closed): a shell error is a no-progress
      // signal, not a pass. Pre-fix the engine silently swallowed the
      // error and returned trip:false, letting the agent re-run
      // forever. Now we count it as one more no-progress re-entry and
      // trip once we hit `max_consecutive_no_progress`.
      logger.error(
        `[WorkflowEngine] loop_guard command failed for ${reEntryId}: ${errMessage}. Counting as no-progress.`,
      );
      const nextCount = previousCount + 1;
      const maxAllowed = guard.max_consecutive_no_progress;
      if (nextCount >= maxAllowed) {
        const failMessage =
          guard.fail_message ??
          `loop_guard command failed for ${reEntryId} after ${nextCount} consecutive re-entries: ${errMessage}`;
        return { trip: true, failMessage, counterKey, nextCount };
      }
      sessionState.loopGuardCounters.set(reEntryId, nextCount);
      return { trip: false, counterKey, nextCount };
    }

    // Task #2438 fix A (distinguish "first run" from "previous_signal
    // path unresolved"). Pre-fix the engine treated any
    // `previousValue === undefined` as a first-run and ALWAYS allowed
    // re-entry, which let production workflows (where the agent
    // outputs `commits:[]` on every re-run due to a missing worktree
    // pre-condition) re-enter the agent forever. Now we only treat
    // empty/undefined as a true first run when there's literally no
    // prior snapshot; if the snapshot IS non-empty, the missing path
    // is a no-progress signal (the agent ran but failed to produce
    // the expected field) and we trip the guard.
    if (previousValue === undefined) {
      const snapshotHasContent =
        snapshotPreviousOutput !== undefined &&
        snapshotPreviousOutput !== null &&
        typeof snapshotPreviousOutput === 'object' &&
        Object.keys(snapshotPreviousOutput as Record<string, unknown>).length > 0;
      if (snapshotHasContent) {
        // Treat as a no-progress re-entry.
        const nextCount = previousCount + 1;
        const maxAllowed = guard.max_consecutive_no_progress;
        if (nextCount >= maxAllowed) {
          const failMessage =
            guard.fail_message ??
            `loop_guard previous_signal path unresolved for ${reEntryId} after ${nextCount} consecutive re-entries: ${guard.previous_signal}`;
          return { trip: true, failMessage, counterKey, nextCount };
        }
        sessionState.loopGuardCounters.set(reEntryId, nextCount);
        return { trip: false, counterKey, nextCount };
      }
      // True first run (no prior snapshot) — allow so the agent can bootstrap.
      return { trip: false, counterKey, nextCount: 0 };
    }

    const isUnchanged =
      JSON.stringify(previousValue) === JSON.stringify(currentValue);
    if (!isUnchanged) {
      return { trip: false, counterKey, nextCount: 0 };
    }

    const nextCount = previousCount + 1;
    const maxAllowed = guard.max_consecutive_no_progress;
    if (nextCount >= maxAllowed) {
      const failMessage =
        guard.fail_message ??
        `no progress: loop_guard detected unchanged signal for ${reEntryId} after ${nextCount} consecutive re-entries`;
      return { trip: true, failMessage, counterKey, nextCount };
    }
    return { trip: false, counterKey, nextCount };
  }

  /**
   * Evaluate conditional edges after a node completes and start matching targets.
   *
   * IMPORTANT: For conditional edge workflows to work correctly:
   * 1. All non-entry nodes MUST specify depends_on for their expected upstream node(s)
   * 2. edges.when acts as a gate AFTER depends_on is satisfied
   * 3. If depends_on is empty, the node will be scheduled at start regardless of edges
   */
  @TracedAs("workflow.engine.processConditionalEdgesAfterCompletion", { recordParams: true, recordResult: true })
  private async processConditionalEdgesAfterCompletion(
    sessionState: ActiveSessionState,
    completedNodeId: string
  ): Promise<void> {
    if (!sessionState.edges || sessionState.edges.length === 0) {
      return;
    }

    const { scheduler, eventBus } = sessionState;
    const runId = this.getRunIdFromSessionId(sessionState.sessionId);

    const templateResolver = new TemplateResolver({
      input: sessionState.config.workflowInput || {},
      previousOutputs: new Map(sessionState.nodeOutputs),
    });

    logger.debug(
      `[WorkflowEngine] Processing edges after "${completedNodeId}" completed. edges=${JSON.stringify(sessionState.edges)}`
    );

    const edgeResult = scheduler.processEdgesAfterCompletion(
      completedNodeId,
      sessionState.edges,
      templateResolver,
      sessionState.config.loopEnabled
    );

    logger.debug(`[WorkflowEngine] Edge processing result: ${JSON.stringify(edgeResult)}`);

    // === Task #4412 (B2): claim back-edge re-entry targets IMMEDIATELY ===
    //
    // `processEdgesAfterCompletion` already called `resetNodeForReEntry()` on
    // every re-entry target, which clears them from `completed`/`running` and
    // pushes them back into `pending`. From the DAG's point of view they are
    // ready again.
    //
    // Everything below this line `await`s — most importantly
    // `checkLoopGuardWithSnapshot()`, which spawns a real `/bin/sh` subprocess
    // (tens to hundreds of ms). While the loop_guard is being evaluated the
    // main scheduling loop is in poll mode (a pending node keeps
    // `mayHaveDeferredWork` true, so `waitForNextNodeEvent` arms a 100ms
    // timer). A poll landing in that window calls `getReadyNodes()`, sees the
    // re-entry target as ready, and `dispatchNode()` claims + runs it. Then the
    // edge path below runs it *again* via `await this.startNode()` — a call
    // that bypasses `dispatchNode`'s claim guard entirely.
    //
    // Measured effect on `30967e4a`: a loop body with
    // `max_consecutive_no_progress: 1` executed 3× instead of 1×, i.e.
    // `loop_guard` never got the chance to trip before extra runs happened.
    // Every surplus execution is a real LLM / tool call.
    //
    // Fix: take the claim synchronously, before the first `await`, so the DAG
    // path can never observe the node as ready. `startNode`'s own
    // `scheduler.markStarted()` is idempotent, so the eventual
    // `await startNode(...)` (and `markFailed` when the guard trips) still work.
    //
    // Why not `resetNodeForReEntry` itself claim? Downstream nodes in
    // `resetNodes` must stay `pending` — they legitimately re-run after this
    // iteration finishes. Claiming is a property of the *edge path's intent*,
    // not of the reset.
    for (const reEntryId of edgeResult.reEntries) {
      scheduler.markStarted(reEntryId);
    }

    // === NEW (Task #2283): snapshot re-entry targets' previous outputs
    // BEFORE the cascade-reset deletes them, so loop_guard can still read
    // the prior `previous_signal` value.
    const loopGuardSnapshots = new Map<string, Record<string, unknown>>();
    for (const reEntryId of edgeResult.reEntries) {
      const guard = sessionState.dagManager.getLoopGuard(reEntryId);
      if (!guard) continue;
      const previousOutput =
        (sessionState.nodeOutputs.get(reEntryId) as Record<string, unknown> | undefined) ?? {};
      loopGuardSnapshots.set(reEntryId, previousOutput);
    }

    // A back-edge reset includes the completed source node in the downstream
    // cascade. Keep that source output available while the re-entry target
    // runs: standard `{{nodes.*}}` templates must be able to read the
    // feedback that triggered the loop. All other reset nodes keep the
    // existing behavior and are cleared.
    const resetNodeIds = edgeResult.reEntries.length > 0
      ? edgeResult.resetNodes.filter((nodeId) => nodeId !== completedNodeId)
      : edgeResult.resetNodes;
    for (const nodeId of resetNodeIds) {
      sessionState.nodeOutputs.delete(nodeId);
    }

    for (const { nodeId, reason } of edgeResult.skipped) {
      await eventBus.publish(
        createWorkflowEvent('node.skipped', runId, {
          node_id: nodeId,
          reason,
        })
      );
    }

    if (edgeResult.reEntries.length > 0) {
      if (sessionState.config.loopEnabled) {
        const nextCount =
          sessionState.loopIterationCount + edgeResult.reEntries.length;
        if (nextCount > sessionState.config.maxIterations) {
          logger.error(
            `[WorkflowEngine] Max loop iterations ${sessionState.config.maxIterations} exceeded (next=${nextCount})`
          );
          await this.failWorkflow(
            sessionState,
            new WorkflowError(
              `Workflow exceeded maximum loop iterations: ${sessionState.config.maxIterations}`
            )
          );
          return;
        }
        sessionState.loopIterationCount = nextCount;
      } else {
        sessionState.loopIterationCount += edgeResult.reEntries.length;
      }
      logger.debug(
        `[WorkflowEngine] Loop iteration #${sessionState.loopIterationCount}: re-entering ${edgeResult.reEntries.join(', ')}`
      );
    }

    // === NEW (Task #2283): loop_guard check on back-edge re-entries ===
    //
    // For every re-entry target that has a `loop_guard` configured, decide
    // whether the upcoming agent run would be a no-progress attempt. If
    // so, short-circuit the agent and inject a fail output. This runs
    // BEFORE `toStart` is processed so we can mark guarded nodes as
    // failed and remove them from the toStart list.
    //
    // We pass the snapshot captured before the cascade-reset (see above)
    // so the template resolver can still see the previous output, even
    // though it has already been deleted from `sessionState.nodeOutputs`.
    const loopGuardTripped = new Set<string>();
    for (const reEntryId of edgeResult.reEntries) {
      const guard = sessionState.dagManager.getLoopGuard(reEntryId);
      if (!guard) continue;

      const snapshotPreviousOutput = loopGuardSnapshots.get(reEntryId) ?? {};
      // Build a sibling resolver that has the same input but uses the
      // pre-reset previousOutputs (with the snapshot for the re-entry
      // target restored). The default `templateResolver` is built from
      // the post-reset state and would resolve `{{nodes.X}}` to
      // undefined for the re-entry target.
      const previousOutputsForGuard = new Map(sessionState.nodeOutputs);
      previousOutputsForGuard.set(reEntryId, snapshotPreviousOutput);
      const guardResolver = new TemplateResolver({
        input: sessionState.config.workflowInput || {},
        previousOutputs: previousOutputsForGuard,
      });

      const verdict = await this.checkLoopGuardWithSnapshot(
        sessionState,
        guardResolver,
        reEntryId,
        snapshotPreviousOutput,
      );

      if (verdict.trip) {
        // Build a fail output that:
        //   - marks the node as having been short-circuited
        //   - carries the engine-supplied fail message
        //   - retains the previous payload (so downstream nodes can still
        //     see what the agent produced before being tripped)
        //
        // The counter is ALSO pinned in nodeOutputs for visibility — but
        // the source of truth lives in sessionState.loopGuardCounters
        // (Task #2286 fix).
        const failOutput = {
          ...snapshotPreviousOutput,
          _loop_guard_triggered: true,
          fail_reason: verdict.failMessage,
          [verdict.counterKey]: verdict.nextCount,
        };
        sessionState.nodeOutputs.set(reEntryId, failOutput);
        sessionState.loopGuardCounters.set(reEntryId, verdict.nextCount);
        scheduler.markFailed(reEntryId);
        loopGuardTripped.add(reEntryId);
        logger.warn(
          `[WorkflowEngine] loop_guard tripped for ${reEntryId} after ${verdict.nextCount} consecutive no-progress re-entries: ${verdict.failMessage}`,
        );
        await eventBus.publish(
          createWorkflowEvent('node.failed', runId, {
            node_id: reEntryId,
            error: {
              message: verdict.failMessage,
            },
          }),
        );
      } else if (verdict.nextCount > 0) {
        // No-trip case but the counter advanced — persist it on the
        // dedicated counter map (Task #2286 fix). We deliberately do
        // NOT write to nodeOutputs here: the next agent run will
        // overwrite nodeOutputs entirely, which would silently zero
        // the counter on every back-edge.
        sessionState.loopGuardCounters.set(reEntryId, verdict.nextCount);
      }
    }

    const workflowInput = sessionState.config.workflowInput || {};

    // Task #4392 P0-1: edge-triggered starts must respect the same concurrency
    // budget as the main scheduling loop, otherwise a completed node that fans
    // out to N successors bypasses `parallel_limit` entirely (measured: limit=2
    // produced peak concurrency 6). Defer whatever does not fit — the main loop
    // re-picks deferred nodes via `getReadyNodes()` as slots free up, because
    // their dependencies are already satisfied.
    const parallelLimit = sessionState.config.parallelLimit ?? Infinity;
    const reEntries = new Set(edgeResult.reEntries);

    for (const targetId of edgeResult.toStart) {
      if (loopGuardTripped.has(targetId)) {
        // Skip the agent — the loop_guard has already failed the node.
        continue;
      }
      if (targetId === '__end__' || targetId === '__END__') {
        logger.info(`[WorkflowEngine] Workflow terminated via __end__ edge from node "${completedNodeId}"`);
        scheduler.markCompleted('__end__');
        await this.completeWorkflow(sessionState);
      } else if (reEntries.has(targetId)) {
        // ── Back-edge re-entry: MUST stay awaited ──────────────────────────
        //
        // A loop iteration is semantically sequential: the re-entered node
        // replaces the state its own completion handler just produced, and
        // `nodeOutputs` for the reset cascade has already been cleared. Running
        // it concurrently would let the *next* iteration observe a half-reset
        // graph. It is also what the pre-P0-1 code did (await), and the
        // loop_guard / maxIterations accounting depends on it
        // (measured regression: 2 loop_guard tests deadlocked, 1 exceeded
        // maxIterations when this was dispatched instead of awaited).
        //
        // This does not cost DAG parallelism: re-entries exist only when
        // `loopEnabled` and are inherently one-at-a-time.
        await this.startNode(sessionState, targetId, workflowInput);
      } else {
        // Respect the budget: an in-flight count at/over the limit means the
        // node waits for the next scheduling round.
        if (sessionState.inFlight.size >= parallelLimit) {
          logger.debug(
            `[WorkflowEngine] Deferring edge-triggered node "${targetId}" — in-flight ${sessionState.inFlight.size} >= parallel_limit ${parallelLimit}`,
          );
          continue;
        }
        // Task #4392 P0-1: dispatch instead of awaiting. This path used to run
        // downstream nodes to completion inline; with concurrent scheduling
        // that both serialized the fan-out *and* double-executed nodes (see
        // `dispatchNode`'s claim-guard notes). `dispatchNode` is idempotent, so
        // whichever path wins the claim runs the node exactly once.
        this.dispatchNode(sessionState, targetId, workflowInput);
      }
    }
  }

  /**
   * Build node execution context (renamed from createExecutionContext)
   * 
   * @param sessionState - Active session state
   * @param nodeId - Node ID to create context for
   * @param globalInput - Global workflow input
   */
  /**
   * 安全取 DAG 节点总数（供 hook payload 用）。
   *
   * ★ 2026-10-16 独立 review P0：hook payload 的构造**绝不能**让 engine 抛错。
   *   原实现直接写 `sessionState.dagManager.getNodeCount()`，而 legacy 测试 fixture
   *   会直接 cast 构造 ActiveSessionState（可能没有 dagManager）→
   *   `TypeError: undefined is not an object`。
   *
   *   致命点：该异常发生在 **HookManager 之前**（还在构造 payload），所以
   *   "hook 抛错由 safeExecute 隔离"这条保护**完全救不了** —— 异常是 engine 自己
   *   抛的，会连带吞掉 `resolveCompleted` / agentSessions 传播 / 原始 error。
   *   实测它打红了 7 条既有测试
   *   （engine-fail-agentsessions ×4、engine-node-completed-agentsessions ×3）。
   *
   *   兜底返回 undefined：hook 消费方（如通知插件）本就把 totalNodes 当可选。
   */
  private safeNodeCount(sessionState: ActiveSessionState | undefined): number | undefined {
    try {
      return sessionState?.dagManager?.getNodeCount?.();
    } catch {
      return undefined;
    }
  }

  @TracedAs('workflow.engine.buildNodeContext')
  private buildNodeContext(
    sessionState: ActiveSessionState,
    nodeId: string,
    globalInput?: Record<string, any>
  ): NodeExecutionContext {
    const nodeDef = sessionState.dagManager.getNode(nodeId)!;
    const runId = this.getRunIdFromSessionId(sessionState.sessionId);
    
    // Collect inputs from dependencies
    const deps = nodeDef.depends_on || [];
    const input: Record<string, any> = {};
    
    for (const depId of deps) {
      const depOutput = sessionState.nodeOutputs.get(depId);
      if (depOutput !== undefined) {
        input[depId] = depOutput;
      }
    }

    // Unified workflowInput for templates (userQuery is ephemeral resume input — excluded)
    const rawWorkflowInput = globalInput ?? sessionState.config.workflowInput ?? {};
    const { userQuery: _ephemeral, ...workflowInput } = rawWorkflowInput;

    // Create TemplateResolver for unified template resolution
    const templateResolver = new TemplateResolver({
      input: workflowInput,
      previousOutputs: new Map(sessionState.nodeOutputs),
    });

    // Ask user function
    const askUser = (query: string): never => {
      throw new AskUserError(
        runId,
        sessionState.sessionId,
        nodeId,
        nodeDef.type,
        query
      );
    };

    // Task #1974: merge per-node runtime overrides into the effective config.
    // Precedence: nodeDef.config (lowest) < sessionState.config.nodeConfig[nodeId] (highest).
    // Unknown node IDs are silently ignored (caller's responsibility).
    // Backward compat: when sessionState.config.nodeConfig is empty/undefined,
    // effectiveConfig === nodeDef.config exactly.
    const nodeConfigOverride = sessionState.config.nodeConfig?.[nodeId];
    const effectiveConfig = nodeConfigOverride
      ? { ...(nodeDef.config ?? {}), ...nodeConfigOverride }
      : (nodeDef.config ?? {});

    const context: NodeExecutionContext = {
      runId,
      sessionId: sessionState.sessionId,
      workflowName: sessionState.workflowName,
      nodeId,
      input,
      previousOutputs: sessionState.nodeOutputs,
      config: effectiveConfig,
      debug: sessionState.config.debug,
      eventBus: sessionState.eventBus,
      nodeOutputs: sessionState.nodeOutputs,
      workflowHistory: sessionState.workflowHistory,
      sessionComponent: this.sessionComponent,
      askUser,
      attachAgentSessionToLastStart: async (targetNodeId: string, agentSessionId: string) => {
        await sessionState.executor.attachAgentSessionToLastStart(
          sessionState.sessionId,
          targetNodeId,
          agentSessionId
        );
      },
      // Task #4412 C1: agent sub-session registration must go through the
      // engine's serialized metadata queue. See the interface doc comment —
      // the inline RMW in AgentNode loses markers under concurrent dispatch.
      registerAgentSubSession: async (targetNodeId: string, agentSessionId: string) => {
        await this.updateSessionMetadata(sessionState, (metadata) => {
          const existing = Array.isArray(metadata.agentSessions)
            ? (metadata.agentSessions as AgentSessionRef[])
            : [];
          return {
            ...metadata,
            agentSessions: upsertAgentSession(existing, targetNodeId, agentSessionId),
          };
        });
      },
      // New fields for unified template resolution
      workflowInput,
      templateResolver,
      // Pre-resolve config for nodes that need it
      // Use effectiveConfig (post-override) so template references like
      // {{config.timeout}} resolve against the runtime override too.
      resolvedConfig: templateResolver.resolveValue(effectiveConfig) as Record<string, unknown>,
      // Task #2275: propagate the session-level cancellation scope's signal
      // into the node context. The executor will compose this with its
      // per-node AbortController so BOTH can abort the node (engine stop
      // OR node timeout OR retry inner-attempt abort).
      abortSignal: sessionState.cancellationScope?.signal ?? sessionState.abortController.signal,
      // Forward the cancellation scope object itself so AgentNode can
      // register force handlers when it spawns an AgentRunner. We use
      // a typed cast here because NodeExecutionContext doesn't yet
      // declare `cancellationScope` (kept narrow on purpose to avoid
      // surface area; consumers read it via `(context as any).cancellationScope`).
      ...(sessionState.cancellationScope
        ? ({ cancellationScope: sessionState.cancellationScope } as { cancellationScope: RuntimeCancellationScope })
        : {} as { cancellationScope: RuntimeCancellationScope }),
    };

    // Note: preExecuteValidation is called in startNode with proper await
    // to prevent race conditions in strict mode

    return context;
  }

  /**
   * Check if workflow is complete and finalize
   */
  @TracedAs("workflow.engine.checkAndFinalize", { recordParams: true, recordResult: true })
  private checkAndFinalize(sessionState: ActiveSessionState): void {
    const state = sessionState.scheduler.getState();

    if (state.pending.length === 0 && 
        state.running.length === 0 && 
        state.ready.length === 0) {
      
      if (state.failed.length > 0) {
        this.failWorkflow(sessionState, new Error(`Nodes failed: ${state.failed.join(', ')}`));
      } else {
        this.completeWorkflow(sessionState);
      }
    }
  }

  /**
   * Complete a workflow successfully.
   *
   * === RunResult Output Behavior ===
   *
   * 1. ALL node outputs (intermediate + exit) are included in the final
   *    RunResult.output as { nodeId: output, ... }. The shape stays
   *    consistent regardless of how many nodes or exit points a
   *    workflow has.
   *
   * 2. The same all-node-outputs map is also stored in session metadata
   *    for debugging/reference.
   *
   * 3. Intermediate node outputs are additionally recorded in session
   *    messages via workflow.node.end messages written by
   *    executor.writeNodeEnd().
   *
   * 4. Consumers can always access a node's output via
   *    result.output[nodeId], including agents that need to chain state
   *    across pause/resume cycles (see agent-resume-history.test.ts,
   *    dual-agent-resume-userquery.test.ts).
   */
  @TracedAs("workflow.engine.completeWorkflow", { recordParams: true, recordResult: true })
  private async completeWorkflow(sessionState: ActiveSessionState): Promise<void> {
    if (sessionState.status !== 'running') {
      return;
    }
    sessionState.status = 'completed';

    const durationMs = Date.now() - sessionState.startedAt.getTime();
    const sessionId = sessionState.sessionId;
    const runId = this.getRunIdFromSessionId(sessionId);

    // Collect ALL node outputs (intermediate + exit) into the final
    // RunResult. Consumers rely on per-node keys (e.g.,
    // result.output.confirm, result.output['agent-b']) regardless of
    // whether a node is an exit node or not. This restores the
    // pre-5ec81dcf behavior.
    const finalOutput: Record<string, any> = {};
    for (const [nodeId, nodeOutput] of sessionState.nodeOutputs) {
      finalOutput[nodeId] = nodeOutput;
    }

    // Keep ALL node outputs in session metadata for debugging/reference
    const allNodeOutputs: Record<string, any> = {};
    for (const [nodeId, nodeOutput] of sessionState.nodeOutputs) {
      allNodeOutputs[nodeId] = nodeOutput;
    }

    // Update session metadata (P2)
    //
    // Task #4412 B1: this MUST go through the serialized queue. P0-1 made node
    // dispatch concurrent but only routed the *node event handlers* through
    // `updateSessionMetadata()`; the terminal write stayed a bare
    // get → spread → update. The queue is still holding writes computed from a
    // pre-terminal snapshot, and those land afterwards — spreading the stale
    // metadata (whose `status` is `'running'`) back over this one. Result:
    // `metadata.status` ends as `running` for a run that actually completed,
    // which is exactly what `sessions list --graph` renders.
    //
    // Going through the queue fixes the ordering by construction: it applies
    // after every already-enqueued mutation, so the terminal status is the last
    // one written.
    if (this.sessionComponent) {
      await this.updateSessionMetadata(sessionState, (metadata) => ({
        ...metadata,
        status: 'completed',
        completedAt: Date.now(),
        durationMs,
        output: allNodeOutputs,
        pendingNodeId: undefined,
        pauseReason: undefined,
        agentSessions: markAllAgentSessionsCompleted(
          metadata.agentSessions as AgentSessionRef[] | undefined
        ),
      }));
    }

    // Publish completed event
    await sessionState.eventBus.publish(
      createWorkflowEvent('workflow.completed', runId, {
        result: finalOutput,
        duration_ms: durationMs,
      }),
      true
    );

    // ★ Workflow lifecycle hook：run 终态（completed）
    await emitWorkflowRunHook(WorkflowHookPoints.AFTER_RUN, {
      runId,
      sessionId: sessionState.sessionId,
      workflowId: sessionState.workflowId,
      workflowName: sessionState.workflowName,
      status: 'completed',
      output: finalOutput,
      durationMs,
      totalNodes: this.safeNodeCount(sessionState),
      completedNodes: sessionState.nodeOutputs.size,
    });

    // Resolve completion
    sessionState.resolveCompleted({
      runId,
      status: 'completed',
      output: finalOutput,
      durationMs,
    });

    // Cleanup
    this.cleanupSession(sessionState);
  }

  /**
   * Fail a workflow
   */
  @TracedAs("workflow.engine.failWorkflow", { recordParams: true, recordResult: true })
  private async failWorkflow(sessionState: ActiveSessionState, error: Error): Promise<void> {
    if (sessionState.status !== 'running') {
      return;
    }
    sessionState.status = 'failed';

    const durationMs = Date.now() - sessionState.startedAt.getTime();
    const sessionId = sessionState.sessionId;
    const runId = this.getRunIdFromSessionId(sessionId);

    sessionState.executor.cancelAll();

    // Update session metadata (P2)
    //
    // Task #4412 B1: same fix as `completeWorkflow` — the terminal write must
    // go through the serialized queue, otherwise the queued node-handler writes
    // (whose snapshot predates this transition) land afterwards and revert
    // `metadata.status` from 'failed' to 'running'.
    if (this.sessionComponent) {
      await this.updateSessionMetadata(sessionState, (metadata) => ({
        ...metadata,
        status: 'failed',
        failedAt: Date.now(),
        durationMs,
        agentSessions: markAllAgentSessionsFailed(
          metadata.agentSessions as AgentSessionRef[] | undefined
        ),
      }));
    }

    // Publish failed event
    await sessionState.eventBus.publish(
      createWorkflowEvent('workflow.failed', runId, {
        error: { message: error.message, stack: error.stack },
        failed_at: new Date().toISOString(),
      }),
      true
    );

    // ★ Workflow lifecycle hook：run 终态（failed）
    await emitWorkflowRunHook(WorkflowHookPoints.AFTER_RUN, {
      runId,
      sessionId: sessionState.sessionId,
      workflowId: sessionState.workflowId,
      workflowName: sessionState.workflowName,
      status: 'failed',
      error: error.message,
      totalNodes: this.safeNodeCount(sessionState),
      completedNodes: sessionState.nodeOutputs.size,
    });

    // Resolve with error. Include the partial node-outputs so consumers
    // can inspect which node's payload caused the failure (Task #2283:
    // loop_guard tripping is the canonical case — the failed node's
    // _loop_guard_triggered + fail_reason are preserved in output).
    const partialOutput: Record<string, any> = {};
    for (const [nodeId, nodeOutput] of sessionState.nodeOutputs) {
      partialOutput[nodeId] = nodeOutput;
    }
    sessionState.resolveCompleted({
      runId,
      status: 'failed',
      error: error.message,
      output: partialOutput,
      durationMs,
    });

    // Cleanup
    this.cleanupSession(sessionState);
  }

  /**
   * Cleanup session resources
   */
  private cleanupSession(sessionState: ActiveSessionState): void {
    sessionState.eventBus.clear();
    this.activeSessions.delete(sessionState.sessionId);
  }

  /**
   * Wait for a run to complete
   */
  @TracedAs("workflow.engine.waitForCompletion", {
    recordParams: true,
    recordResult: false,
  })
  private async waitForCompletion(
    sessionId: string,
    timeout?: number | null
  ): Promise<RunResult> {
    const sessionState = this.activeSessions.get(sessionId);
    
    if (!sessionState) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const timeoutMs = timeout ?? 1200000; // 20 min default to match delegate_task DEFAULT_TIMEOUT

    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<RunResult>((_, reject) => {
      timer = setTimeout(() => {
        // Task #2140: the engine owns this timeout, so it must interrupt
        // in-flight nodes before propagating the timeout to its caller.
        void this.stop(sessionId, "execution timeout").catch((stopError) => {
          logger.warn(
            `[WorkflowEngine.waitForCompletion] Failed to stop ${sessionId} after execution timeout: ${
              stopError instanceof Error ? stopError.message : String(stopError)
            }`,
          );
        });
        reject(new Error(`Workflow execution timeout: ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([
        sessionState.completedPromise,
        timeoutPromise,
      ]);
    } finally {
      // ★ 清除定时器，防止 workflow 正常完成后定时器仍 pending
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Get session metadata
   */
  private async getSessionMetadata(sessionId: string): Promise<WorkflowSessionMetadata> {
    if (!this.sessionComponent) {
      return { type: 'workflow', workflowId: '', workflowName: '', status: 'running' };
    }
    const session = await this.sessionComponent.get(sessionId);
    return (session?.metadata as WorkflowSessionMetadata) || { type: 'workflow', workflowId: '', workflowName: '', status: 'running' };
  }

  /**
   * Serialized session-metadata read-modify-write (Task #4392 P0-1).
   *
   * Every `node.completed` / `node.failed` handler and every terminal-state
   * transition mutates metadata via `get → spread → update`. That is safe only
   * if mutations never interleave. Now that nodes are dispatched concurrently,
   * two completions can both `await get()` the same snapshot and the later
   * `update()` silently drops the other's `agentSessions` marker.
   *
   * `mutate` receives the freshly-read metadata and must return the next
   * metadata object. Mutations are chained onto `sessionState.sessionMetadataQueue`
   * so they apply in a strict total order, and the queue never rejects (a
   * failed mutation is logged and skipped) so one bad update cannot poison
   * every later write.
   */
  private async updateSessionMetadata(
    sessionState: ActiveSessionState,
    mutate: (metadata: WorkflowSessionMetadata) => WorkflowSessionMetadata
  ): Promise<void> {
    if (!this.sessionComponent) return;

    const sessionId = sessionState.sessionId;
    const run = (sessionState.sessionMetadataQueue ?? Promise.resolve()).then(async () => {
      try {
        const metadata = await this.getSessionMetadata(sessionId);
        await this.sessionComponent!.update(sessionId, { metadata: mutate(metadata) });
      } catch (error) {
        logger.error(`[WorkflowEngine] Failed to update session metadata for ${sessionId}:`, error);
      }
    });

    sessionState.sessionMetadataQueue = run;
    await run;
  }

  /**
   * Find workflow definition from repository
   */
  private findDefinitionForWorkflow(workflowIdOrName: string): WorkflowDefinition | null {
    if (!this.workflowRepository) {
      return null;
    }
    
    // Try by ID first
    let workflow = this.workflowRepository.getById(workflowIdOrName);
    if (workflow) return workflow.definition;
    
    // Try by name
    workflow = this.workflowRepository.getByName(workflowIdOrName);
    if (workflow) return workflow.definition;
    
    return null;
  }
}
