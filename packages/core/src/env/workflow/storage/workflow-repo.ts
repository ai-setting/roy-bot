/**
 * @fileoverview Workflow Repository
 * 
 * SQLite-based repository for workflow CRUD operations.
 */

import { randomUUID } from 'crypto';
import type { Workflow, WorkflowDefinition, WorkflowMetadata, WorkflowConfig } from '../types';
import { getDatabase } from './sqlite';
import { parseJsonOrThrow, parseJsonObjectOrEmpty, parseTagsSafely } from './safe-json';

// Row interface matching database schema
export interface WorkflowRow {
  id: string;
  name: string;
  version: string;
  description: string | null;
  definition: string;
  config: string;
  metadata: string;
  tags: string;
  task_id: number | null;
  created_at: string;
  updated_at: string;
}

// Query options for listing workflows
export interface ListWorkflowsOptions {
  limit?: number;
  offset?: number;
  orderBy?: 'name' | 'created_at' | 'updated_at';
  order?: 'asc' | 'desc';
  tag?: string;
  taskId?: number;   // 新增：按任务 ID 精确过滤
  search?: string;    // 新增：搜索 description + tags
}

// Update options
export interface UpdateWorkflowOptions {
  name?: string;
  version?: string;
  description?: string;
  definition?: WorkflowDefinition;
  config?: WorkflowConfig;
  metadata?: WorkflowMetadata;
  tags?: string[];
}

/**
 * Row to Workflow conversion helper
 *
 * Bug 修复 Task #4037（sibling-risk of Task #4036）：
 *   原本 4 处裸 `JSON.parse` 没有任何错误处理；损坏的 metadata/definition
 *   会让整个 `workflow list` 命令挂掉（与 Bug #4033 的 tasks list 同源）。
 *
 *   修复策略按字段语义分流：
 *     - definition / metadata：业务关键，损坏时**抛错**（带 fieldName +
 *       row.name + row.id 的清晰错误信息），宁可在 ReportError 路径上挂掉
 *       也别返回 silent-corrupt 数据。
 *     - config / tags：辅助字段，**graceful fallback**（config → {}，
 *       tags 复用 task-store 的 parseTagsSafely 模式）。
 *
 *   实现细节见 `./safe-json.ts`。
 */
export function rowToWorkflow(row: WorkflowRow): Workflow {
  const rowCtx = { id: row.id, name: row.name };
  const metadata = parseJsonOrThrow<WorkflowMetadata>(row.metadata, "metadata", rowCtx);
  // Merge task_id from column into metadata
  if (row.task_id !== null) {
    metadata.taskId = row.task_id;
  }
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    description: row.description || undefined,
    definition: parseJsonOrThrow<WorkflowDefinition>(row.definition, "definition", rowCtx),
    config: parseJsonObjectOrEmpty<WorkflowConfig>(row.config, "config"),
    metadata,
    tags: parseTagsSafely(row.tags),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * WorkflowRepository class
 * 
 * Provides CRUD operations for workflows in SQLite.
 */
export class WorkflowRepository {
  private db: ReturnType<typeof getDatabase>;

  constructor(db?: ReturnType<typeof getDatabase>) {
    this.db = db || getDatabase();
  }

  /**
   * Create a new workflow
   */
  create(workflow: Omit<Workflow, 'id' | 'createdAt' | 'updatedAt'>): Workflow {
    const id = randomUUID();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO workflows (id, name, version, description, definition, config, metadata, tags, task_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      workflow.name,
      workflow.version,
      workflow.description || null,
      JSON.stringify(workflow.definition),
      JSON.stringify(workflow.config),
      JSON.stringify(workflow.metadata),
      JSON.stringify(workflow.tags),
      workflow.metadata?.taskId || null,  // 新增
      now,
      now
    );

    return {
      ...workflow,
      id,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    };
  }

  /**
   * Create a workflow from definition only
   */
  createFromDefinition(definition: WorkflowDefinition, options?: {
    config?: WorkflowConfig;
    metadata?: WorkflowMetadata;
    tags?: string[];
  }): Workflow {
    const workflow: Omit<Workflow, 'id' | 'createdAt' | 'updatedAt'> = {
      name: definition.name,
      version: definition.version,
      description: definition.description,
      definition,
      config: options?.config || definition.config || {},
      metadata: options?.metadata || definition.metadata || {},
      tags: options?.tags || definition.metadata?.tags || [],
    };

    return this.create(workflow);
  }

  /**
   * Get a workflow by ID
   */
  getById(id: string): Workflow | undefined {
    const row = this.db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as WorkflowRow | undefined;
    if (!row) return undefined;
    return rowToWorkflow(row);
  }

  /**
   * Get a workflow by name (returns latest version)
   */
  getByName(name: string): Workflow | undefined {
    const row = this.db.prepare(
      'SELECT * FROM workflows WHERE name = ? ORDER BY updated_at DESC LIMIT 1'
    ).get(name) as WorkflowRow | undefined;
    if (!row) return undefined;
    return rowToWorkflow(row);
  }

  /**
   * Get a specific version of a workflow by name
   */
  getByNameAndVersion(name: string, version: string): Workflow | undefined {
    const row = this.db.prepare(
      'SELECT * FROM workflows WHERE name = ? AND version = ?'
    ).get(name, version) as WorkflowRow | undefined;
    if (!row) return undefined;
    return rowToWorkflow(row);
  }

  /**
   * List workflows with optional filtering and pagination
   */
  list(options?: ListWorkflowsOptions): Workflow[] {
    let sql = 'SELECT * FROM workflows';
    const params: any[] = [];
    const conditions: string[] = [];

    // Filter by tag
    if (options?.tag) {
      conditions.push('tags LIKE ?');
      params.push(`%${options.tag}%`);
    }

    // Filter by taskId - SQLite INTEGER comparison
    if (options?.taskId !== undefined) {
      conditions.push('task_id = ?');
      params.push(options.taskId);
    }

    // Apply WHERE clause
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    // Order by
    const orderBy = options?.orderBy || 'updated_at';
    const order = options?.order || 'desc';
    sql += ` ORDER BY ${orderBy} ${order.toUpperCase()}`;

    // Pagination
    if (options?.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }
    if (options?.offset !== undefined) {
      sql += ' OFFSET ?';
      params.push(options.offset);
    }

    const rows = this.db.prepare(sql).all(...params) as WorkflowRow[];
    let workflows = rows.map(rowToWorkflow);

    // Apply search filter in-memory (description + tags)
    if (options?.search) {
      // Lazy import to avoid circular dependency
      const { parseSearchQuery, matchesQuery } = require('../../session/search-query-parser');
      const query = parseSearchQuery(options.search);
      workflows = workflows.filter(w => {
        // Search in description
        const descMatch = w.description ? matchesQuery(w.description, query) : false;
        // Search in tags
        const tagsMatch = w.tags.some(tag => matchesQuery(tag, query));
        // Match if description OR any tag matches
        return descMatch || tagsMatch;
      });
    }

    return workflows;
  }

  /**
   * List all versions of a workflow by name
   */
  listVersions(name: string): Workflow[] {
    const rows = this.db.prepare(
      'SELECT * FROM workflows WHERE name = ? ORDER BY version DESC'
    ).all(name) as WorkflowRow[];
    return rows.map(rowToWorkflow);
  }

  /**
   * Update a workflow
   */
  update(id: string, updates: UpdateWorkflowOptions): Workflow | undefined {
    const existing = this.getById(id);
    if (!existing) return undefined;

    const now = new Date().toISOString();
    const setClauses: string[] = ['updated_at = ?'];
    const params: any[] = [now];

    if (updates.name !== undefined) {
      setClauses.push('name = ?');
      params.push(updates.name);
    }
    if (updates.version !== undefined) {
      setClauses.push('version = ?');
      params.push(updates.version);
    }
    if (updates.description !== undefined) {
      setClauses.push('description = ?');
      params.push(updates.description);
    }
    if (updates.definition !== undefined) {
      setClauses.push('definition = ?');
      params.push(JSON.stringify(updates.definition));
    }
    if (updates.config !== undefined) {
      setClauses.push('config = ?');
      params.push(JSON.stringify(updates.config));
    }
    if (updates.metadata !== undefined) {
      setClauses.push('metadata = ?');
      params.push(JSON.stringify(updates.metadata));
      // Update task_id column if taskId is present in metadata
      if (updates.metadata.taskId !== undefined) {
        setClauses.push('task_id = ?');
        params.push(updates.metadata.taskId);
      }
    }
    if (updates.tags !== undefined) {
      setClauses.push('tags = ?');
      params.push(JSON.stringify(updates.tags));
    }

    params.push(id);

    this.db.prepare(`UPDATE workflows SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);

    return this.getById(id);
  }

  /**
   * Delete a workflow
   */
  delete(id: string): boolean {
    const existing = this.getById(id);
    if (!existing) return false;

    this.db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
    return true;
  }

  /**
   * Check if a workflow exists
   */
  exists(id: string): boolean {
    const result = this.db.prepare('SELECT 1 FROM workflows WHERE id = ?').get(id);
    return result !== undefined;
  }

  /**
   * Check if a workflow with name and version exists
   */
  existsByNameAndVersion(name: string, version: string): boolean {
    const result = this.db.prepare('SELECT 1 FROM workflows WHERE name = ? AND version = ?').get(name, version);
    return result !== undefined;
  }

  /**
   * Get total count of workflows
   */
  count(): number {
    const result = this.db.prepare('SELECT COUNT(*) as count FROM workflows').get() as { count: number };
    return result.count;
  }

  /**
   * v4: Get count of workflows matching the given filters.
   *
   * Unlike `list()`, this method:
   * - Returns the **total** count of matching rows (not paginated)
   * - Ignores `limit` / `offset` options
   * - Applies SQL filters (tag, taskId) in SQL
   * - Applies multi-tag AND + search filter in-memory
   *
   * Used by `WorkflowService.listWorkflowsWithTags` and `searchWorkflowsWithTags`
   * to populate the `total` field correctly.
   *
   * @param options - Filter options (no limit/offset)
   * @returns Number of workflows matching the filters
   */
  countAll(options?: {
    tag?: string;
    tags?: string[];   // v4: AND filter (all tags must match)
    taskId?: number;
    search?: string;
  }): number {
    let sql = 'SELECT * FROM workflows';
    const params: any[] = [];
    const conditions: string[] = [];

    // Filter by single tag (SQL: JSON-array LIKE)
    if (options?.tag) {
      conditions.push('tags LIKE ?');
      params.push(`%${options.tag}%`);
    }

    // Filter by taskId (SQL: integer equality)
    if (options?.taskId !== undefined) {
      conditions.push('task_id = ?');
      params.push(options.taskId);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    const rows = this.db.prepare(sql).all(...params) as WorkflowRow[];
    let workflows = rows.map(rowToWorkflow);

    // v4: Multi-tag AND filter (in-memory, matches searchWorkflows logic)
    if (options?.tags && options.tags.length > 0) {
      const requiredTags = options.tags;
      workflows = workflows.filter(w => requiredTags.every(t => w.tags.includes(t)));
    }

    // Apply search filter in-memory (same as list())
    if (options?.search) {
      // Lazy import to avoid circular dependency
      const { parseSearchQuery, matchesQuery } = require('../../session/search-query-parser');
      const query = parseSearchQuery(options.search);
      workflows = workflows.filter(w => {
        const descMatch = w.description ? matchesQuery(w.description, query) : false;
        const tagsMatch = w.tags.some(tag => matchesQuery(tag, query));
        return descMatch || tagsMatch;
      });
    }

    return workflows.length;
  }

  /**
   * Search workflows by name (partial match)
   */
  search(query: string, limit?: number): Workflow[] {
    let sql = 'SELECT * FROM workflows WHERE name LIKE ? ORDER BY updated_at DESC';
    const params: any[] = [`%${query}%`];

    if (limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(limit);
    }

    const rows = this.db.prepare(sql).all(...params) as WorkflowRow[];
    return rows.map(rowToWorkflow);
  }

  /**
   * Migrate workflows with empty/missing tags to ["default"].
   *
   * @returns number of rows updated
   */
  migrateEmptyTagsToDefault(): number {
    return migrateEmptyTagsToDefault(this.db);
  }

  /**
   * v2: 在事务中执行一个函数，回滚任何抛出
   */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // 忽略 ROLLBACK 失败
      }
      throw e;
    }
  }
}

/**
 * Module-level helper — migrate workflows with empty/missing tags to `["default"]`.
 *
 * Updates workflows where `tags IS NULL`, `tags = ''`, or `tags = '[]'`.
 * Other workflows are untouched. Idempotent.
 *
 * @param db - SQLite database instance (must have workflows table with tags column)
 * @returns number of workflows that were updated
 */
export function migrateEmptyTagsToDefault(db: any): number {
  const DEFAULT_TAG_VALUE = "default";

  const rows = db
    .prepare(
      "SELECT id FROM workflows WHERE tags IS NULL OR tags = '' OR tags = '[]'"
    )
    .all() as Array<{ id: string }>;

  if (rows.length === 0) return 0;

  const updateStmt = db.prepare(
    "UPDATE workflows SET tags = ?, updated_at = ? WHERE id = ?"
  );
  const now = new Date().toISOString();
  const defaultTagsJson = JSON.stringify([DEFAULT_TAG_VALUE]);

  for (const row of rows) {
    updateStmt.run(defaultTagsJson, now, row.id);
  }

  return rows.length;
}
