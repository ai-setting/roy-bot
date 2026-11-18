/**
 * WorkflowService - Session-based Workflow Execution
 *
 * After session-based refactoring, workflow runs are managed via SessionComponent.
 * The workflows table is still used for storing workflow definitions.
 *
 * Key concepts:
 * - Session IS a workflow run (no separate runId concept)
 * - Session.metadata stores workflow run state (status, input, agentSessions)
 * - Session.messages stores node execution history with workflow.node.* roles
 * - Resume is based on session state and messages
 */

import { createLogger } from '../../log-trace/logger';

const logger = createLogger('WorkflowService');

import type {
  Workflow,
  WorkflowDefinition,
  RunOptions,
  RunResult,
  RunStatus,
  WorkflowMetadata,
  WorkflowConfig,
} from '../types';
import { TracedAs } from '../../log-trace/decorator';
import { sanitizeWorkflowDefinition } from '../utils/workflow-sanitize';

// Repository interfaces (abstraction for storage layer)
export interface WorkflowRepository {
  create(workflow: Omit<Workflow, 'id' | 'createdAt' | 'updatedAt'>): Workflow;
  getById(id: string): Workflow | null;
  getByName(name: string): Workflow | null;
  list(options?: ListOptions): Workflow[];
  update(id: string, updates: Partial<Workflow>): Workflow | null;
  delete(id: string): boolean;
  /** v2: 在事务中执行一个函数，回滚任何抛出 */
  transaction<T>(fn: () => T): T;
  /** v4: 拿过滤后的全局总数（不应用 limit/offset） */
  countAll(options?: {
    tag?: string;
    tags?: string[];
    taskId?: number;
    search?: string;
  }): number;
}

// v2: TagRepository 接口（供 service / tool / CLI 使用）
// v3: list() 新增 sortBy/order/limit 参数；返回结构含 created_at/updated_at
export interface ITagRepository {
  upsertMany(names: string[]): void;
  decrementMany(names: string[]): void;
  list(options?: {
    sortBy?: "usage_count" | "name" | "created_at";
    order?: "asc" | "desc";
    limit?: number;
  }): { name: string; usage_count: number; created_at: string; updated_at: string }[];
  get(name: string): { name: string; usage_count: number; created_at: string; updated_at: string } | undefined;
}

// v2: list/search 结果中包含 available_tags
export interface ListWorkflowsWithTagsResult {
  workflows: Workflow[];
  available_tags: { name: string; count: number }[];
  total: number;
}

export interface SearchWorkflowsWithTagsResult extends ListWorkflowsWithTagsResult {
  keyword?: string;
  tags?: string[];
}

// Need NodeDefinition for addNode
import type { NodeDefinition } from '../types';

// ==================== Options Interfaces ====================

/**
 * Tag validation constants
 *
 * Tags are required for all workflows and are constrained to:
 * - At least 1 tag
 * - At most 3 tags
 *
 * This supports fine-grained workflow discovery (filtering) while preventing
 * tag spam.
 */
export const TAG_MIN_COUNT = 1;
export const TAG_MAX_COUNT = 3;
export const DEFAULT_TAG = 'default';

export class TagValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TagValidationError';
  }
}

export interface CreateOptions {
  tags?: string[];
  metadata?: WorkflowMetadata;
  taskId?: number;
  force?: boolean;
}

export interface ListOptions {
  tag?: string;
  taskId?: number;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface SearchOptions {
  keyword?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
}

export interface WorkflowUpdates {
  definition?: WorkflowDefinition;
  config?: WorkflowConfig;
  tags?: string[];
  metadata?: WorkflowMetadata;
}

// Engine interface (abstraction for workflow execution)
// Note: Unified run() handles both fresh start and resume from session
// Note: pause is triggered internally by interrupts, not a manual operation
export interface WorkflowEngine {
  createSession(
    workflowId: string,
    options?: { input?: Record<string, any>; workflowName?: string; workflowVersion?: string }
  ): Promise<string>;
  
  run(sessionId: string, options?: RunOptions): Promise<RunResult>;
  runWorkflow(workflow: Workflow | WorkflowDefinition, options?: RunOptions): Promise<RunResult>;
  stop(sessionId: string, reason?: string): Promise<void>;
  addNode(sessionId: string, nodeDefinition: NodeDefinition): Promise<void>;
  removeNode(sessionId: string, nodeId: string): Promise<void>;
}

// Engine factory type for creating new engine instances per run
export type WorkflowEngineFactory = (
  workflow: Workflow,
  options?: RunOptions
) => Pick<WorkflowEngine, 'run' | 'stop' | 'runWorkflow'>;

// Session types
export interface SessionInfo {
  id: string;
  title: string;
  metadata: WorkflowSessionMetadata;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Task #1739 — top-level parent session id (mirrors legacy `parentID`).
   * Workflow sessions created by a sub-agent carry the sub-agent's session id
   * here, so cascade-stop queries (`WorkflowService.stopAllForParent`) can
   * find them. May be null for top-level sessions.
   */
  parentSessionId?: string | null;
}

export interface WorkflowSessionMetadata {
  type: 'workflow';
  runId?: string;  // Task #1837: legacy field, equals sessionId (which already has workflow_ prefix)
  workflowId?: string;
  workflowName: string;
  workflowVersion?: string;
  // Task #2245 — Codex P1-uncertain: 'cancelled' was widened "for legacy
  // caller compatibility" but no caller writes it. Dropped to keep the
  // type honest. 'stopped' covers the ESC cascade / force-stop case.
  status: 'running' | 'paused' | 'completed' | 'failed' | 'stopped';
  input?: any;
  rootNodeId?: string;
  agentSessions?: AgentSessionRef[];
}

export interface AgentSessionRef {
  nodeId: string;
  sessionId: string;
  status: 'active' | 'paused' | 'completed';
}

// ==================== WorkflowService ====================

export class WorkflowService {
  /**
   * v2: 可选 tag 仓库，用于维护 workflow_tags 表
   */
  public tagRepository?: ITagRepository;

  constructor(
    private workflowRepository: WorkflowRepository,
    private engineFactory: WorkflowEngineFactory,
    private sessionComponent?: {
      create(options: { id?: string; title: string; metadata: any }): Promise<{ id: string }>;
      get(id: string): Promise<SessionInfo | null | undefined>;
      list?(options?: { limit?: number; offset?: number }): Promise<SessionInfo[]>;
      update(id: string, updates: { metadata?: any }): Promise<boolean>;
      addMessage(sessionId: string, message: any): Promise<string>;
      getMessages(sessionId: string): Promise<any[]>;
    },
    tagRepository?: ITagRepository,
  ) {
    this.tagRepository = tagRepository;
    this.engineInstances = new Map();
  }

  /**
   * Task #2245 — Codex P1-2: paginated session fetch.
   *
   * Fetches ALL workflow sessions via `sessionComponent.list` with
   * `limit: 1000` chunks, accumulated until a short batch signals EOF.
   * This replaces the previous single-call `list({ limit: 1000 })`
   * which silently dropped sessions beyond the first 1000.
   *
   * Safety cap of 50,000 total sessions to prevent runaway fetches
   * against an unbounded `sessionComponent.list` implementation.
   */
  private async listAllSessions(): Promise<any[]> {
    if (!this.sessionComponent?.list) return [];
    const PAGE = 1000;
    const HARD_CAP = 50_000;
    const collected: any[] = [];
    let offset = 0;
    while (collected.length < HARD_CAP) {
      const batch = await this.sessionComponent.list({ limit: PAGE, offset });
      collected.push(...batch);
      if (batch.length < PAGE) break; // short batch → EOF
      offset += PAGE;
    }
    return collected;
  }

  /**
   * Task #2245 — Engine instance cache (BL-1).
   *
   * Maps sessionId → WorkflowEngine instance that actually owns the run.
   * The engineFactory returns a NEW WorkflowEngine on every call, but
   * `WorkflowEngine.activeSessions` is a private per-instance Map. So a
   * freshly-created engine has no record of the running session, and its
   * `stop(sessionId)` only updates the database (no abort, no executor
   * cancel). This cache lets `stopRun` locate the real engine.
   *
   * Lifecycle: `runWorkflow` registers the engine after `runWorkflow()`
   * returns (which synchronously populates `engine.activeSessions` before the
   * first await). `stopRun` consults the cache first; on miss it falls back
   * to a fresh engine (DB-only stop).
   */
  /**
   * Task #2245 — Codex P0-1: cache engine instance per workflowName so
   * `stopRun` can find the engine during in-flight execution.
   *
   * Previous design cached by `sessionId` AFTER `engine.runWorkflow()`
   * returned — useless for the in-flight case. New design caches by
   * `workflowName` (one engine owns the named workflow), so the engine
   * is registered BEFORE `runWorkflow` is awaited and is available
   * for `stopRun` at any time during execution.
   *
   * `workflowName` → `WorkflowEngine` (one engine owns the workflow's
   * `activeSessions` Map, including any in-flight or completed sessions).
   */
  private engineInstances: Map<string, any>;
  /**
   * Codex P0-1: reverse index `sessionId` → `engine` for O(1) stopRun lookup.
   * Populated when the engine is registered (BEFORE runWorkflow) and
   * cleaned up via pruneStaleEngines() / dispose().
   */
  private sessionToEngine: Map<string, any> = new Map();
  /**
   * P0-3 (Task #2269): reverse index `sessionId` → `parentSessionId` for
   * precise `hasActiveWorkflowForParent` lookup. Populated when runWorkflow
   * resolves (the engine factory call carries `parentSessionId` via
   * `options`) and cleaned up when the session is force-stopped / stopped
   * via stopRun. Without this, hasActiveWorkflowForParent would have to
   * iterate ALL engines and return true on any active session — false
   * positives in multi-REPL scenarios.
   */
  private sessionToParent: Map<string, string | undefined> = new Map();
  
  // ==================== Workflow CRUD ====================

  /**
   * Validate tag count is within allowed range (1-3 tags).
   * Throws TagValidationError with a friendly message on failure.
   */
  private validateTags(tags: string[] | undefined): string[] {
    const effective = tags ?? [];
    if (effective.length < TAG_MIN_COUNT) {
      throw new TagValidationError(
        `Workflow requires at least ${TAG_MIN_COUNT} tag (use --tags to provide 1-3 tags)`
      );
    }
    if (effective.length > TAG_MAX_COUNT) {
      throw new TagValidationError(
        `Workflow supports at most ${TAG_MAX_COUNT} tags (received ${effective.length}). Please reduce to 1-${TAG_MAX_COUNT} tags.`
      );
    }
    return effective;
  }

  /**
   * Create a new workflow from definition
   *
   * v2: create + tag upsert 在同一事务（由 WorkflowRepository.transaction 包装）
   */
  @TracedAs('workflow.service.createWorkflow', {
    recordParams: true,
    recordResult: false,
    log: false,
  })
  async createWorkflow(
    definition: WorkflowDefinition,
    options?: CreateOptions
  ): Promise<Workflow> {
    // Task #2926: sanitize the definition before persistence so that known
    // shell-script bugs (e.g. `python3 -c "; ..."` SyntaxError, bare
    // `$RANDOM` under dash + set -u) get fixed at write time rather than
    // relying on a one-off SQLite patch.
    const sanitized = sanitizeWorkflowDefinition(definition);

    // Resolve effective tags: options.tags > definition.metadata.tags
    const effectiveTags = this.validateTags(
      options?.tags || sanitized.metadata?.tags
    );

    // Check if workflow with same name exists
    const existing = this.workflowRepository.getByName(sanitized.name);

    if (existing) {
      if (options?.force !== true) {
        throw new Error(`Workflow already exists: ${definition.name}`);
      }
      // Update existing workflow
      const oldTags = existing.tags;
      const updated = this.workflowRepository.update(existing.id, {
        name: sanitized.name,
        version: sanitized.version,
        description: sanitized.description || existing.description,
        definition: sanitized,
        config: sanitized.config || {},
        metadata: {
          ...options.metadata || sanitized.metadata || existing.metadata || {},
          taskId: options.taskId || sanitized.metadata?.taskId || existing.metadata?.taskId,
        },
        tags: effectiveTags,
      })!;
      this.syncTagsOnUpdate(oldTags, effectiveTags);
      return updated;
    }

    // Create new workflow
    const workflow: Omit<Workflow, 'id' | 'createdAt' | 'updatedAt'> = {
      name: sanitized.name,
      version: sanitized.version,
      description: sanitized.description,
      definition: sanitized,
      config: sanitized.config || {},
      metadata: {
        ...options?.metadata || sanitized.metadata || {},
        taskId: options?.taskId || sanitized.metadata?.taskId,
      },
      tags: effectiveTags,
    };

    return this.workflowRepository.transaction(() => {
      const wf = this.workflowRepository.create(workflow);
      if (this.tagRepository) {
        this.tagRepository.upsertMany(effectiveTags);
      }
      return wf;
    });
  }

  /**
   * v2: 在 update 时同步 tag 表
   */
  private syncTagsOnUpdate(oldTags: string[], newTags: string[]): void {
    if (!this.tagRepository) return;
    const oldSet = new Set(oldTags);
    const newSet = new Set(newTags);
    const removed = oldTags.filter(t => !newSet.has(t));
    const added = newTags.filter(t => !oldSet.has(t));
    if (removed.length > 0) this.tagRepository.decrementMany(removed);
    if (added.length > 0) this.tagRepository.upsertMany(added);
  }
  
  /**
   * Get workflow by id or name
   */
  getWorkflow(idOrName: string): Workflow | null {
    // Try by id first
    let workflow = this.workflowRepository.getById(idOrName);
    if (workflow) return workflow;
    
    // Then try by name
    return this.workflowRepository.getByName(idOrName);
  }
  
  /**
   * Get workflow by id
   */
  getWorkflowById(id: string): Workflow | null {
    return this.workflowRepository.getById(id);
  }
  
  /**
   * Get workflow by name
   */
  getWorkflowByName(name: string): Workflow | null {
    return this.workflowRepository.getByName(name);
  }
  
  /**
   * List workflows with optional filters
   */
  listWorkflows(options?: ListOptions): Workflow[] {
    return this.workflowRepository.list(options);
  }

  /**
   * Search workflows with combined keyword + multi-tag AND filter.
   *
   * - `keyword`: matched (case-insensitive) against name and description
   * - `tags`: ALL tags must be present on the workflow (AND filter)
   * - `limit`/`offset`: pagination
   */
  searchWorkflows(options: SearchOptions = {}): Workflow[] {
    const all = this.workflowRepository.list();
    const keyword = options.keyword?.trim().toLowerCase();
    const tags = options.tags ?? [];

    let filtered = all;

    if (tags.length > 0) {
      filtered = filtered.filter(w => tags.every(t => w.tags.includes(t)));
    }

    if (keyword && keyword.length > 0) {
      filtered = filtered.filter(w => {
        const nameMatch = w.name.toLowerCase().includes(keyword);
        const descMatch = w.description?.toLowerCase().includes(keyword) ?? false;
        return nameMatch || descMatch;
      });
    }

    if (options.offset !== undefined && options.offset > 0) {
      filtered = filtered.slice(options.offset);
    }
    if (options.limit !== undefined && options.limit > 0) {
      filtered = filtered.slice(0, options.limit);
    }

    return filtered;
  }
  
  /**
   * Update an existing workflow
   */
  async updateWorkflow(
    idOrName: string,
    updates: WorkflowUpdates,
    options?: { tags?: string[] }
  ): Promise<Workflow> {
    // Find the workflow
    let workflow = this.workflowRepository.getByName(idOrName);
    if (!workflow) {
      workflow = this.workflowRepository.getById(idOrName);
    }
    
    if (!workflow) {
      throw new Error(`Workflow not found: ${idOrName}`);
    }
    
    const updateData: Partial<Workflow> = {
      ...updates,
    };

    if (options?.tags !== undefined) {
      updateData.tags = options.tags;
    }

    // Task #2926: sanitize definition if it is being replaced through update
    // (e.g. CLI `roy-bot workflow update --file ...`).
    if (updateData.definition) {
      updateData.definition = sanitizeWorkflowDefinition(updateData.definition as WorkflowDefinition);
    }

    const updated = this.workflowRepository.update(workflow.id, updateData);
    if (!updated) {
      throw new Error(`Failed to update workflow: ${idOrName}`);
    }
    
    return updated;
  }
  
  /**
   * Delete a workflow by name or id
   *
   * v2: delete + tag decrement 在同一事务
   */
  @TracedAs('workflow.service.deleteWorkflow', {
    recordParams: true,
    recordResult: false,
    log: false,
  })
  async deleteWorkflow(idOrName: string): Promise<boolean> {
    // Find the workflow
    let workflow = this.workflowRepository.getByName(idOrName);
    if (!workflow) {
      workflow = this.workflowRepository.getById(idOrName);
    }

    if (!workflow) {
      return false;
    }

    const tagsToDecrement = [...workflow.tags];
    return this.workflowRepository.transaction(() => {
      const deleted = this.workflowRepository.delete(workflow!.id);
      if (deleted && this.tagRepository) {
        this.tagRepository.decrementMany(tagsToDecrement);
      }
      return deleted;
    });
  }

  /**
   * v2: list workflows + available_tags（按 usage_count DESC, name ASC）
   * v4: total 字段修复 — 使用 repository.countAll() 拿过滤后全局总数
   */
  @TracedAs('workflow.service.listWorkflowsWithTags', {
    recordParams: true,
    recordResult: false,
    log: false,
  })
  async listWorkflowsWithTags(options?: ListOptions): Promise<ListWorkflowsWithTagsResult> {
    const workflows = this.workflowRepository.list(options);
    const availableTags = this.tagRepository
      ? this.tagRepository.list().map(t => ({ name: t.name, count: t.usage_count }))
      : [];
    // v4: 拿过滤后全局总数（不受 limit/offset 影响）
    const total = this.workflowRepository.countAll(options);
    return {
      workflows,
      available_tags: availableTags,
      total,
    };
  }

  /**
   * v2: search workflows + available_tags
   * v4: total 字段修复 — 使用 repository.countAll() 拿过滤后全局总数
   */
  @TracedAs('workflow.service.searchWorkflowsWithTags', {
    recordParams: true,
    recordResult: false,
    log: false,
  })
  async searchWorkflowsWithTags(options: SearchOptions = {}): Promise<SearchWorkflowsWithTagsResult> {
    const workflows = this.searchWorkflows(options);
    const availableTags = this.tagRepository
      ? this.tagRepository.list().map(t => ({ name: t.name, count: t.usage_count }))
      : [];
    // v4: 拿过滤后全局总数（支持多 tag AND）
    const total = this.workflowRepository.countAll({
      tag: options.tags?.length === 1 ? options.tags[0] : undefined,
      tags: options.tags && options.tags.length > 1 ? options.tags : undefined,
      search: options.keyword,
    });
    return {
      workflows,
      available_tags: availableTags,
      total,
      keyword: options.keyword,
      tags: options.tags,
    };
  }

  /**
   * v3: List all tags from the workflow_tags table with flexible sort/limit.
   *
   * Used by:
   * - `workflow_tag_list` MCP tool (lets agents discover the tag pool)
   * - `workflow tag list` CLI subcommand
   *
   * Default sort: usage_count DESC, name ASC (most-used tags first).
   */
  @TracedAs('workflow.service.listTags', {
    recordParams: true,
    recordResult: false,
    log: false,
  })
  async listTags(options?: {
    sortBy?: 'usage_count' | 'name' | 'created_at';
    order?: 'asc' | 'desc';
    limit?: number;
  }): Promise<{
    tags: Array<{
      name: string;
      usage_count: number;
      created_at: string;
      updated_at: string;
    }>;
    total: number;
  }> {
    const sortBy = options?.sortBy ?? 'usage_count';
    const order = options?.order ?? 'desc';
    const limit = options?.limit ?? 100;

    const list = this.tagRepository
      ? this.tagRepository.list({ sortBy, order, limit })
      : [];

    return { tags: list, total: list.length };
  }

  /**
   * v3: Get a single tag by name (returns undefined when not found).
   */
  @TracedAs('workflow.service.getTag', {
    recordParams: true,
    recordResult: false,
    log: false,
  })
  getTag(name: string):
    | { name: string; usage_count: number; created_at: string; updated_at: string }
    | undefined {
    if (!this.tagRepository) return undefined;
    return this.tagRepository.get(name);
  }
  
  // ==================== Workflow Execution (Session-based) ====================
  
  /**
   * Run a workflow by definition or name
   * 
   * This creates a Session that represents the workflow run.
   * The Session ID is used as the run identifier for pause/resume.
   */
  async runWorkflow(
    idOrNameOrDefinition: string | WorkflowDefinition,
    input?: Record<string, any>,
    options?: RunOptions
  ): Promise<RunResult> {
    // Resolve workflow
    let workflow: Workflow | null = null;
    let definition: WorkflowDefinition | null = null;
    
    if (typeof idOrNameOrDefinition === 'string') {
      // Running by name - workflow must exist
      workflow = this.getWorkflow(idOrNameOrDefinition);
      if (!workflow) {
        throw new Error(`Workflow not found: ${idOrNameOrDefinition}`);
      }
      definition = workflow.definition;
    } else {
      // Running by definition - create inline workflow if needed
      definition = idOrNameOrDefinition;
      workflow = this.getWorkflowByName(definition.name);
      
      // If workflow doesn't exist, create a temporary one for execution
      if (!workflow) {
        workflow = {
          id: `wf_inline_${definition.name}`,
          name: definition.name,
          version: definition.version,
          description: definition.description,
          definition,
          config: definition.config || {},
          metadata: definition.metadata || {},
          tags: definition.metadata?.tags || [],
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      }
    }
    
    // Codex P0-1: register engine in cache BEFORE awaiting runWorkflow.
    // We cache by `workflowName` (one engine owns the named workflow's
    // activeSessions across all sessions of that workflow). This way,
    // any stopRun call during the in-flight window of runWorkflow can
    // find the SAME engine that is currently running the session.
    let engine = this.engineInstances.get(workflow.name);
    if (!engine) {
      engine = this.engineFactory(workflow, {
        ...options,
        input,
      });
      this.engineInstances.set(workflow.name, engine);
    }

    // Run the workflow (this creates the session internally).
    // Same forward note: `...options` carries `parentSessionId` straight through.
    const result = await engine.runWorkflow(workflow, {
      ...options,
      input,
    });

    // Codex P0-1: register the sessionId → engine mapping immediately
    // after runWorkflow resolves (so the cache stays consistent for
    // post-completion stopRun calls as well).
    const resolvedSessionId = result.sessionId || result.runId;
    if (resolvedSessionId) {
      this.sessionToEngine.set(resolvedSessionId, engine);
      // P0-3 (Task #2269): also record the parentSessionId so
      // hasActiveWorkflowForParent can filter precisely per parent
      // (avoiding the cross-REPL false positive).
      const parentSid = options?.parentSessionId;
      this.sessionToParent.set(
        resolvedSessionId,
        typeof parentSid === "string" ? parentSid : undefined,
      );
    }

    // Task #1837: runId == sessionId natively. Use whichever the engine
      // returned (both are valid and identical); fall back to empty for safety.
      return {
        ...result,
        runId: result.runId || result.sessionId || '',
        sessionId: result.sessionId || result.runId || '',
      };
  }

  /**
   * Run workflow by name (convenience method)
   */
  async runWorkflowByName(
    name: string,
    input?: Record<string, any>,
    options?: RunOptions
  ): Promise<RunResult> {
    const workflow = this.getWorkflowByName(name);
    if (!workflow) {
      throw new Error(`Workflow not found: ${name}`);
    }

    return this.runWorkflow(name, input, options);
  }

  /**
   * Stop a running workflow session
   */
  async stopRun(sessionId: string, reason?: string): Promise<void> {
    const session = await this.sessionComponent?.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const metadata = session.metadata as WorkflowSessionMetadata;
    if (metadata.type !== 'workflow') {
      throw new Error(`Session is not a workflow session: ${sessionId}`);
    }

    const workflow = this.getWorkflowByName(metadata.workflowName);
    if (!workflow) {
      throw new Error(`Workflow not found: ${metadata.workflowName}`);
    }

    // Codex P0-1: try session → engine first, then workflowName → engine.
    // The engine that originally ran this session is the only one with
    // the session in its `activeSessions` map; a fresh engine's `stop()`
    // would only update the database without aborting the in-flight execution.
    const cachedBySession = this.sessionToEngine.get(sessionId);
    const cachedByName = this.engineInstances.get(metadata.workflowName);
    const engine = cachedBySession ?? cachedByName ?? this.engineFactory(workflow);
    try {
      await engine.stop(sessionId, reason);
    } finally {
      // Codex P0-2: evict the engine from the cache after stop to prevent
      // memory leaks when the engine no longer has any active sessions.
      this.sessionToEngine.delete(sessionId);
      // P0-3 (Task #2269): also evict the parentSessionId reverse index
      // so hasActiveWorkflowForParent doesn't count this stopped session.
      this.sessionToParent.delete(sessionId);
      this.pruneStaleEngines();
    }
  }

  /**
   * Codex P0-2: prune engineInstances entries whose `activeSessions` map
   * no longer contains any session (engine is "stale" — no in-flight work).
   * Called after stopRun / dispose to prevent the engine cache from
   * accumulating engines across long-running REPL sessions.
   */
  private pruneStaleEngines(): void {
    for (const [workflowName, engine] of this.engineInstances) {
      if (!engine?.activeSessions || engine.activeSessions.size === 0) {
        this.engineInstances.delete(workflowName);
      }
    }
  }

  /**
   * Codex P0-2: dispose all engine caches. Called from
   * BackgroundTaskManager.dispose() or directly on service shutdown.
   */
  async dispose(): Promise<void> {
    // Stop all in-flight workflow sessions first
    for (const [, engine] of this.engineInstances) {
      if (engine?.activeSessions) {
        for (const sessionId of engine.activeSessions.keys()) {
          try {
            await engine.stop(sessionId, "WorkflowService disposed");
          } catch {
            // best effort
          }
        }
      }
    }
    this.engineInstances.clear();
    this.sessionToEngine.clear();
  }

  /**
   * Task #2245 — ESC cascade stop.
   *
   * Stop all workflow sessions whose `parentSessionId === parentSessionId` and
   * whose metadata is type=workflow with status in {running, paused}. Calls
   * the existing `stopRun(sessionId, reason)` per entry, which already invokes
   * `engine.stop()` and cascades mark of nested agent sessions (Task #1837).
   *
   * Returns `{ stoppedSessionIds, errors }` for audit / caller logging.
   * P1-#7: errors array includes per-session failure details so
   * cascadeStopSessionTree can surface them in CascadeStopResult.errors.
   *
   * Idempotent: re-running on an already-stopped set is a no-op for those
   * sessions; running/paused entries that succeeded are returned.
   */
  @TracedAs('workflow.service.hasActiveWorkflowForParent', {
    recordParams: true,
    recordResult: true,
    log: false, // hot path — keep quiet; debug only
  })
  hasActiveWorkflowForParent(parentSessionId: string): boolean {
    if (!parentSessionId) return false;
    // P0-3 (Task #2269): precise parent filter. The previous coarse check
    // returned true if ANY engine had activeSessions.size > 0, which caused
    // false positives in multi-REPL scenarios (REPL A with no workflow
    // child would misclassify as "has active descendant" because REPL B
    // had a running workflow). We now track each active session's
    // parentSessionId in `sessionToParent` and filter precisely.
    //
    // Defensive: skip sessions with undefined parent (corrupted state) and
    // only match sessions where the recorded parent === requested parent.
    for (const [sessionId, recordedParent] of this.sessionToParent) {
      if (recordedParent === undefined) continue; // skip corrupt entries
      if (recordedParent === parentSessionId) {
        // Confirm the session is still actually active (not just in our map).
        // If the engine evicted the session from activeSessions but the
        // sessionToParent entry lingered, treat as not active.
        const engine = this.sessionToEngine.get(sessionId);
        const active = engine?.activeSessions as Map<string, unknown> | undefined;
        if (active && active.has(sessionId)) return true;
      }
    }
    return false;
  }

  @TracedAs('workflow.service.stopAllForParent', {
    recordParams: true,
    recordResult: true,
    log: true,
  })
  async stopAllForParent(
    parentSessionId: string,
  ): Promise<{
    stoppedSessionIds: string[];
    errors: Array<{ sessionId: string; error: string; stack?: string }>;
  }> {
    if (!parentSessionId || !this.sessionComponent?.list) {
      return { stoppedSessionIds: [], errors: [] };
    }
    // Codex P1-2: paginated fetch (previous limit 1000 silently dropped tail)
    const allSessions = await this.listAllSessions();
    const stoppedSessionIds: string[] = [];
    const errors: Array<{ sessionId: string; error: string; stack?: string }> = [];
    for (const session of allSessions) {
      const meta = session.metadata as WorkflowSessionMetadata | undefined;
      if (
        session.parentSessionId === parentSessionId &&
        meta?.type === 'workflow' &&
        (meta?.status === 'running' || meta?.status === 'paused')
      ) {
        try {
          await this.stopRun(session.id, 'ESC cascade stop');
          stoppedSessionIds.push(session.id);
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error ? err.stack : undefined;
          logger.warn(
            `[WorkflowService] stopAllForParent failed for ${session.id}: ${errorMsg}`,
          );
          // P1-#7: return per-item failure to caller instead of swallowing
          errors.push({ sessionId: session.id, error: errorMsg, stack });
        }
      }
    }
    return { stoppedSessionIds, errors };
  }

  /**
   * Task #2245 — ESC force-stop (second-press within 2s window).
   *
   * Traverse ALL workflow sessions (regardless of parent), mark running/paused
   * ones as `stopped` via sessionComponent.update. Used as the force path when
   * `stopAllForParent` (graceful) leaves residual orphans.
   *
   * Idempotent: re-running on already-stopped sessions is a no-op.
   * Does NOT invoke engine.stop() — direct DB mark is sufficient for force
   * cleanup; engine session has either completed or is being torn down.
   */
  @TracedAs('workflow.service.forceStopAll', {
    recordParams: false,
    recordResult: true,
    log: true,
  })
  async forceStopAll(): Promise<void> {
    if (!this.sessionComponent?.list || !this.sessionComponent.update) {
      return;
    }
    // Codex P1-2: paginated fetch
    const allSessions = await this.listAllSessions();
    // P0-1 (Task #2269): we must actually stop the in-flight engine, not
    // just update the DB. Otherwise the workflow's abortController is
    // never triggered and the LLM call / agentNode children / nested
    // workflows keep running while the DB says "stopped".
    // Track sessions whose engine.stop() was invoked vs. DB-only mark
    // (engine may be missing if the service restarted between runWorkflow
    // and forceStopAll — fall back to DB-only mark in that case).
    const evictedSessionIds: string[] = [];
    for (const session of allSessions) {
      const meta = session.metadata as WorkflowSessionMetadata | undefined;
      if (
        meta?.type === 'workflow' &&
        (meta?.status === 'running' || meta?.status === 'paused')
      ) {
        // P0-1: try to stop the in-flight engine first. engine.stop()
        // aborts the engine's abortController + publishes workflow.stopped
        // event; if no engine is cached (e.g. service restart), fall back
        // to DB-only mark for that session.
        const cachedEngine = this.sessionToEngine.get(session.id);
        if (cachedEngine && typeof cachedEngine.stop === 'function') {
          try {
            await cachedEngine.stop(session.id, 'force stop all');
          } catch (err) {
            logger.warn(
              `[WorkflowService] forceStopAll engine.stop failed for ${session.id}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            // Fall through to DB mark so this session isn't left in
            // running state — better DB drift than leaked engine.
          }
        }
        try {
          await this.sessionComponent.update(session.id, {
            metadata: { ...meta, status: 'stopped' },
          });
          evictedSessionIds.push(session.id);
        } catch (err) {
          logger.warn(
            `[WorkflowService] forceStopAll update failed for ${session.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
    // Codex P1-1: drop engineInstances + sessionToEngine entries for
    // the just-stopped sessions. Also clear activeSessions on each
    // affected engine so a subsequent stopRun doesn't try to abort
    // an already-aborted controller.
    for (const sid of evictedSessionIds) {
      const engine = this.sessionToEngine.get(sid);
      if (engine?.activeSessions) {
        engine.activeSessions.delete(sid);
      }
      this.sessionToEngine.delete(sid);
      // P0-3 (Task #2269): also evict the parentSessionId reverse index
      // so hasActiveWorkflowForParent doesn't count this stopped session.
      this.sessionToParent.delete(sid);
    }
    // Codex P0-2: prune any engines that no longer have any active sessions
    this.pruneStaleEngines();
  }

  /**
   * Resume an existing workflow session.
   *
   * Looks up the session, verifies it's a workflow session, resolves the
   * workflow definition from session metadata, then re-enters execution
   * via `engine.run(sessionId, options)`. The engine's unified `run()`
   * detects the existing session and infers the resume point from
   * persisted messages (Task #1829).
   *
   * Replaces the CLI's `(service as any).engineFactory` hack with a
   * proper public API.
   *
   * @param sessionId - Existing workflow runId/sessionId (Task #1837:
   *                    runId == sessionId, both start with `workflow_`)
   * @param options - Optional RunOptions (input is forwarded as userResponse
   *                  for ask_user interrupt resume paths)
   * @returns Promise resolving to RunResult
   * @throws Error when session not found / not a workflow session / workflow not registered
   */
  @TracedAs('workflow.service.resumeSession', {
    recordParams: true,
    recordResult: false,
    log: false,
  })
  async resumeSession(
    sessionId: string,
    options?: RunOptions
  ): Promise<RunResult> {
    if (!this.sessionComponent) {
      throw new Error('SessionComponent not available');
    }

    const session = await this.sessionComponent.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const metadata = session.metadata as WorkflowSessionMetadata;
    if (metadata?.type !== 'workflow') {
      throw new Error(`Session is not a workflow session: ${sessionId}`);
    }

    const workflowName = metadata.workflowName;
    if (!workflowName) {
      throw new Error(`Workflow name not found in session metadata for ${sessionId}`);
    }

    const workflow = this.getWorkflowByName(workflowName);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowName}`);
    }

    // Build engine options: forward everything, plus explicit sessionId so the
    // engine can verify resume intent even if its own session lookup races.
    const engineOptions: RunOptions = {
      ...(options ?? {}),
      sessionId,
    };

    const engine = this.engineFactory(workflow, engineOptions);
    const result = await engine.run(sessionId, engineOptions);

    // Task #1837: runId == sessionId natively. Use whichever the engine
    // returned; fall back to the input sessionId for safety.
    return {
      ...result,
      runId: result.runId || result.sessionId || sessionId,
      sessionId: result.sessionId || result.runId || sessionId,
    };
  }
  
  /**
   * Get workflow session by ID
   */
  async getSession(sessionId: string): Promise<SessionInfo | null> {
    if (!this.sessionComponent) {
      return null;
    }
    const session = await this.sessionComponent.get(sessionId);
    return session ?? null;
  }
  
  /**
   * List workflow sessions
   */
  async listSessions(options?: { limit?: number; offset?: number }): Promise<SessionInfo[]> {
    if (!this.sessionComponent?.list) {
      return [];
    }
    return this.sessionComponent.list(options);
  }
  
  /**
   * Get messages from a workflow session
   */
  async getSessionMessages(sessionId: string): Promise<any[]> {
    if (!this.sessionComponent) {
      return [];
    }
    return this.sessionComponent.getMessages(sessionId);
  }
}
