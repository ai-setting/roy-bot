/**
 * @fileoverview TaskCreationRegistry — In-process bounded index of recently
 * created/updated tasks with sanitization, LRU eviction and TTL.
 *
 * The registry is **observation only** — it never writes back to TaskComponent
 * and never deletes/merges tasks. It powers:
 *
 * 1. The "reuse candidate" prompt section injected into sub-agent prompts
 *    (see task-reuse-context.ts). The section lists recent candidate tasks so
 *    the sub-agent can decide to reuse instead of creating a new Task.
 *
 * 2. Programmatic queries from hooks / debug tools.
 *
 * Design choices (see docs/design/task-reuse-context.md):
 * - **In-process**: hook events fire at runtime; DB fallback is opt-in and
 *   intentionally not implemented in MVP. The registry is a "hot path" index.
 * - **LRU + TTL**: maxEntries caps memory; ttlMs drops stale entries from
 *   `recent()` (note: TTL only affects queries, not storage, to keep
 *   behavior predictable for tests).
 * - **Sanitization**: secrets are redacted before storage so they never leak
 *   into a prompt even by accident.
 *
 * Backward compatibility: zero — this is a new module. Caller code
 * (delegate-tool.ts, prompts-index.ts) is updated in subsequent commits.
 */

import type { Task, TaskStatus, TaskPriority, TaskType } from "./types";

// ============================================================================
// Public Types
// ============================================================================

/**
 * Provenance info for a task record. Captures which session / bg task /
 * sub-agent type created the task so we can scope "recent" queries.
 */
export interface TaskRecordSource {
  /** sessionId under which task_create was invoked (TaskComponent.createTask) */
  sessionId?: string;
  /** parent session id from sessions table (sub-session → main session) */
  parentSessionId?: string;
  /** BackgroundTaskManager task id (process_<ts>_<rand>) if applicable */
  bgTaskId?: string;
  /** Sub-agent type that triggered the task creation (roy / workflow-runner / ...) */
  subagentType?: string;
  /** OS process.pid (Node) of the host process at record time */
  processId?: number;
}

export interface TaskRecord {
  taskId: number;
  title: string;
  /** Sanitized + truncated description (never raw user input). */
  description: string;
  /** Sanitized + truncated goals (never raw user input). */
  goals: string;
  tags: string[];
  status: TaskStatus;
  priority: TaskPriority;
  type: TaskType;
  parentTaskId?: number;
  source: TaskRecordSource;
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601 — bumped on update() / refresh() */
  updatedAt: string;
  /** Approximate operation count for tie-breaking in sort */
  operationCount: number;
  /** Task #2395: cached from task.project_path */
  project_path?: string;
  /** Task #2395: cached from task.context JSON */
  branch?: string;
  /** Task #2395: cached from task.context JSON */
  worktree_path?: string;
  /** Task #2395: cached from task.context JSON */
  parentBranch?: string;
  /**
   * Task #2395: cached parent context object with sensitive fields stripped
   * (e.g. prior_context.commit). Stored only for delegation hints.
   */
  context?: Record<string, unknown>;
}

export interface RecentQueryOptions {
  scope?: {
    sessionId?: string;
    parentSessionId?: string;
    subagentType?: string;
  };
  /** Default: 10 */
  limit?: number;
  /** Default: all non-archived */
  statuses?: TaskStatus[];
  /** IDs to omit (e.g. similar_task_ids) so we don't show duplicates. */
  excludeIds?: number[];
  /** Exclude the subtree rooted at this task id (the task itself + all descendants). */
  excludeAncestorOf?: number;
  /** Task #2395: Exclude this id + its descendants (alias for clearer call-site intent). */
  excludeSelfOrDescendant?: number;
  /** Only return records updated within this window (hours). */
  sinceHours?: number;
  /** Task #2395: Promote candidates whose subtree contains an active child. */
  activeChildFirst?: boolean;
}

/**
 * Task #2395 — Subtree summary used by the reuse-candidate prompt to show
 * `Children: N (active: M, completed: K)` per parent.
 */
export interface SubtreeSummary {
  descendantCount: number;
  activeCount: number;
  completedCount: number;
  /** Furthest descendant depth from the root (1 = direct child). 0 when empty. */
  maxDepth: number;
}

export interface SubtreeSummaryOptions {
  /** Include archived descendants. Default false (matches recent() default). */
  includeArchived?: boolean;
}

export interface TaskCreationRegistryConfig {
  /** Hard cap on entries; oldest are evicted (LRU) once exceeded. Default: 500 */
  maxEntries?: number;
  /** TTL in ms; entries older than this are skipped by `recent()`. Default: 24h */
  ttlMs?: number;
  /** Max chars for description / goals. Default: 240 */
  maxDescriptionChars?: number;
}

// ============================================================================
// Sanitization helpers
// ============================================================================

/**
 * Token redaction patterns. Conservative — only obvious well-known formats.
 * Order matters: longer prefixes first.
 */
const TOKEN_PATTERNS: ReadonlyArray<RegExp> = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, // OpenAI sk- / sk-proj-
  /\bxox[abprs]-[A-Za-z0-9-]{8,}\b/g, // Slack
  /\bghp_[A-Za-z0-9]{16,}\b/g, // GitHub PAT
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, // GitHub fine-grained PAT
  /\bBearer\s+[A-Za-z0-9._\-+/=]{12,}\b/g, // HTTP Bearer
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
];

function redactTokens(s: string): string {
  let out = s;
  for (const pat of TOKEN_PATTERNS) {
    out = out.replace(pat, "<redacted>");
  }
  return out;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 3) return s.slice(0, max);
  return s.slice(0, max - 1) + "…";
}

function sanitize(s: string, max: number): string {
  return truncate(redactTokens(s), max);
}

// ============================================================================
// Implementation
// ============================================================================

export class TaskCreationRegistry {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly maxDescriptionChars: number;

  /** Map preserves insertion order; we re-insert on update() for LRU. */
  private readonly records = new Map<number, TaskRecord>();
  /** parent_task_id → list of child taskIds, for excludeAncestorOf traversal */
  private readonly childrenIndex = new Map<number, Set<number>>();

  constructor(config: TaskCreationRegistryConfig = {}) {
    this.maxEntries = config.maxEntries ?? 500;
    this.ttlMs = config.ttlMs ?? 24 * 60 * 60 * 1000; // 24h
    this.maxDescriptionChars = config.maxDescriptionChars ?? 240;
  }

  // ------------------------------------------------------------------------
  // CRUD
  // ------------------------------------------------------------------------

  /**
   * Insert (or upsert) a task record. Safe to call on existing id — overwrites.
   * Auto-tracks parent/child relationships for excludeAncestorOf.
   */
  record(task: Task, source: TaskRecordSource = {}): TaskRecord {
    const now = new Date().toISOString();
    const record = this.toRecord(task, source, now);
    this.upsert(record);
    this.indexParentChild(record);
    this.evictIfNeeded();
    return record;
  }

  /**
   * Mutate an existing record. If the id is unknown, returns undefined
   * (callers can choose to follow up with record() if they want upsert
   * semantics — but the standard contract is "update only existing").
   */
  update(task: Task, source?: TaskRecordSource): TaskRecord | undefined {
    const existing = this.records.get(task.id);
    if (!existing) return undefined;
    const now = new Date().toISOString();
    // Re-insert to refresh LRU position
    this.records.delete(task.id);
    const merged: TaskRecord = {
      ...existing,
      ...this.toRecord(task, source ?? existing.source, now),
      createdAt: existing.createdAt, // never overwrite createdAt
      source: source ?? existing.source,
    };
    this.records.set(task.id, merged);
    // Re-index parent/child in case parent_task_id changed
    this.childrenIndex.delete(merged.taskId);
    this.indexParentChild(merged);
    this.evictIfNeeded();
    return merged;
  }

  /**
   * Remove a record. No-op if id is unknown.
   */
  remove(id: number): boolean {
    const rec = this.records.get(id);
    if (!rec) return false;
    this.records.delete(id);
    // Remove from parent index
    if (rec.parentTaskId !== undefined) {
      const siblings = this.childrenIndex.get(rec.parentTaskId);
      siblings?.delete(id);
      if (siblings && siblings.size === 0) {
        this.childrenIndex.delete(rec.parentTaskId);
      }
    }
    return true;
  }

  /**
   * Get a record by id. Returns undefined if the entry has expired
   * (TTL) so callers don't accidentally resurrect stale state.
   */
  getById(id: number): TaskRecord | undefined {
    const rec = this.records.get(id);
    if (!rec) return undefined;
    if (Date.now() - Date.parse(rec.updatedAt) > this.ttlMs) {
      // Lazy cleanup so storage stays bounded.
      this.remove(id);
      return undefined;
    }
    return rec;
  }

  /**
   * Like getById but ignores TTL — useful for tests / debugging.
   */
  peekById(id: number): TaskRecord | undefined {
    return this.records.get(id);
  }

  /**
   * Clear all records. Mainly for tests.
   */
  clear(): void {
    this.records.clear();
    this.childrenIndex.clear();
  }

  /** Total stored records (ignores TTL). Useful for tests/debugging. */
  size(): number {
    return this.records.size;
  }

  // ------------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------------

  recent(options: RecentQueryOptions = {}): TaskRecord[] {
    const limit = options.limit ?? 10;
    const statuses = options.statuses; // undefined = default (exclude archived)
    const excludeIds = new Set(options.excludeIds ?? []);
    const excludeAncestorId =
      options.excludeAncestorOf ?? options.excludeSelfOrDescendant;
    const excludeAncestorIds = excludeAncestorId
      ? this.collectSubtree(excludeAncestorId)
      : new Set<number>();
    const sinceMs = options.sinceHours
      ? Date.now() - options.sinceHours * 60 * 60 * 1000
      : 0;
    const now = Date.now();

    // Collect descendants of excluded ancestors too
    const excludeAll = new Set<number>([...excludeIds, ...excludeAncestorIds]);

    const all: TaskRecord[] = [];
    for (const rec of this.records.values()) {
      // TTL filter
      if (now - Date.parse(rec.updatedAt) > this.ttlMs) continue;
      // sinceHours filter
      if (sinceMs > 0 && Date.parse(rec.updatedAt) < sinceMs) continue;
      // exclude filter
      if (excludeAll.has(rec.taskId)) continue;
      // scope filter (AND)
      if (options.scope) {
        if (
          options.scope.sessionId !== undefined &&
          rec.source.sessionId !== options.scope.sessionId
        )
          continue;
        if (
          options.scope.parentSessionId !== undefined &&
          rec.source.parentSessionId !== options.scope.parentSessionId
        )
          continue;
        if (
          options.scope.subagentType !== undefined &&
          rec.source.subagentType !== options.scope.subagentType
        )
          continue;
      }
      // status filter
      if (statuses) {
        if (!statuses.includes(rec.status)) continue;
      } else {
        // default: exclude archived
        if (rec.status === "archived") continue;
      }
      all.push(rec);
    }

    // Task #2395: Active-child-first promotion.
    // Candidates whose subtree has an active child are ranked higher
    // (sub-agent should consider child task creation before reusing completed parent).
    if (options.activeChildFirst) {
      const activeChildBoost = new Map<number, boolean>();
      for (const rec of all) {
        activeChildBoost.set(rec.taskId, this.hasActiveChild(rec.taskId));
      }
      all.sort((a, b) => {
        const aBoost = activeChildBoost.get(a.taskId) ? 1 : 0;
        const bBoost = activeChildBoost.get(b.taskId) ? 1 : 0;
        if (aBoost !== bBoost) return bBoost - aBoost;
        const cmp = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
        if (cmp !== 0) return cmp;
        return b.taskId - a.taskId;
      });
    } else {
      // Stable sort by updatedAt DESC, ties broken by taskId DESC.
      all.sort((a, b) => {
        const cmp = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
        if (cmp !== 0) return cmp;
        return b.taskId - a.taskId;
      });
    }

    return all.slice(0, limit);
  }

  /**
   * Task #2395: Subtree summary used by the reuse-candidate prompt.
   * Returns { descendantCount, activeCount, completedCount, maxDepth } for
   * the given parent task id. Returns all zeros for unknown parent or empty
   * subtree (does not throw).
   */
  getSubtreeSummary(
    parentId: number,
    options: SubtreeSummaryOptions = {}
  ): SubtreeSummary {
    const includeArchived = options.includeArchived === true;
    const summary: SubtreeSummary = {
      descendantCount: 0,
      activeCount: 0,
      completedCount: 0,
      maxDepth: 0,
    };
    if (!this.records.has(parentId) && !this.childrenIndex.has(parentId)) {
      return summary;
    }
    // BFS to compute depth + counts
    const directChildren = this.childrenIndex.get(parentId);
    const currentLevel: number[] = directChildren
      ? Array.from(directChildren)
      : [];
    let depth = currentLevel.length > 0 ? 1 : 0;
    summary.maxDepth = depth;
    let levelIds = currentLevel;
    while (levelIds.length > 0) {
      const nextLevel: number[] = [];
      for (const id of levelIds) {
        const rec = this.records.get(id);
        if (!rec) continue;
        if (!includeArchived && rec.status === "archived") continue;
        summary.descendantCount++;
        if (rec.status === "active") {
          summary.activeCount++;
        } else if (rec.status === "completed") {
          summary.completedCount++;
        }
        const grandchildren = this.childrenIndex.get(id);
        if (grandchildren && grandchildren.size > 0) {
          for (const gc of grandchildren) nextLevel.push(gc);
        }
      }
      if (nextLevel.length > 0) {
        depth++;
        summary.maxDepth = depth;
      }
      levelIds = nextLevel;
    }
    return summary;
  }

  /**
   * Task #2395: True if any direct child of the given parent is active or todo.
   * Used internally by the activeChildFirst sort.
   */
  private hasActiveChild(parentId: number): boolean {
    const children = this.childrenIndex.get(parentId);
    if (!children) return false;
    for (const childId of children) {
      const rec = this.records.get(childId);
      if (!rec) continue;
      if (rec.status === "active" || rec.status === "todo") return true;
    }
    return false;
  }

  // ------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------

  private toRecord(
    task: Task,
    source: TaskRecordSource,
    isoNow: string
  ): Omit<TaskRecord, "createdAt"> & { createdAt: string } {
    // Task #2395: parse parent context safely, strip sensitive keys.
    const parsedContext = this.safeParseContext(task.context);
    const safeContext = parsedContext
      ? (this.stripSensitiveKeys(parsedContext) as Record<string, unknown>)
      : undefined;

    return {
      taskId: task.id,
      title: task.title,
      description: sanitize(task.description || "", this.maxDescriptionChars),
      goals: sanitize(
        task.goals_and_expected_deliverables || "",
        this.maxDescriptionChars
      ),
      tags: task.tags ?? [],
      status: task.status,
      priority: task.priority,
      type: task.type,
      parentTaskId: task.parent_task_id,
      source,
      createdAt: task.createdAt || isoNow,
      updatedAt: task.updatedAt || isoNow,
      operationCount: 0,
      project_path: task.project_path,
      branch: this.pickString(safeContext, "branch"),
      worktree_path: this.pickString(safeContext, "worktree_path"),
      parentBranch: this.pickString(safeContext, "parent_branch"),
      context: safeContext,
    };
  }

  private safeParseContext(raw: string | undefined): Record<string, unknown> | undefined {
    if (!raw || !raw.trim()) return undefined;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private pickString(obj: Record<string, unknown> | undefined, key: string): string | undefined {
    if (!obj) return undefined;
    const v = obj[key];
    return typeof v === "string" ? v : undefined;
  }

  private static STRIPPED_KEYS = ["commit", "token", "secret", "password", "api_key"];

  private stripSensitiveKeys(obj: unknown): unknown {
    if (obj === null || obj === undefined) return obj;
    if (Array.isArray(obj)) return obj.map((v) => this.stripSensitiveKeys(v));
    if (typeof obj !== "object") return obj;
    const out: Record<string, unknown> = {};
    const strippedKeys = TaskCreationRegistry.STRIPPED_KEYS;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const lower = k.toLowerCase();
      if (strippedKeys.some((s: string) => lower.includes(s))) continue;
      out[k] = this.stripSensitiveKeys(v);
    }
    return out;
  }

  private upsert(record: TaskRecord): void {
    this.records.set(record.taskId, record);
  }

  private indexParentChild(record: TaskRecord): void {
    if (record.parentTaskId === undefined || record.parentTaskId === null)
      return;
    const parentId = record.parentTaskId;
    let set = this.childrenIndex.get(parentId);
    if (!set) {
      set = new Set();
      this.childrenIndex.set(parentId, set);
    }
    set.add(record.taskId);
  }

  private collectSubtree(rootId: number): Set<number> {
    const out = new Set<number>([rootId]);
    const queue: number[] = [rootId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      const children = this.childrenIndex.get(id);
      if (!children) continue;
      for (const child of children) {
        if (!out.has(child)) {
          out.add(child);
          queue.push(child);
        }
      }
    }
    return out;
  }

  private evictIfNeeded(): void {
    if (this.records.size <= this.maxEntries) return;
    const overflow = this.records.size - this.maxEntries;
    // Map iteration order = insertion order; first N are oldest.
    const keys = Array.from(this.records.keys()).slice(0, overflow);
    for (const k of keys) {
      this.remove(k);
    }
  }
}