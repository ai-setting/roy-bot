/**
 * @fileoverview SQLite Task Store
 * 
 * SQLite-based implementation of TaskStore.
 * 
 * 根据运行环境自动选择 SQLite 实现：
 * - Bun 运行时：使用 bun:sqlite
 * - Node.js/Electron：使用 better-sqlite3
 * 
 * 参考 Session SQLiteStore 实现模式：
 * - 内存缓存提高性能
 * - 默认路径：~/.local/share/roy-bot/tasks.db
 */

// ============================================================================
// SQLite Runtime Detection
// ============================================================================

/**
 * 获取 SQLite 数据库类
 *
 * 根据运行时环境选择正确的实现：
 * - Bun 运行时：使用 bun:sqlite（命名导出）
 * - Node.js 22.5+：使用 node:sqlite（内置，无需原生编译）
 * - 旧版 Node.js/Electron：使用 better-sqlite3（默认导出，需要原生编译）
 *
 * ⚠️ Task #4619：`node:sqlite` 优先于 `better-sqlite3`。
 *
 * `better-sqlite3` 是**原生插件**。插件的 Claude 侧 MCP server 是
 * `#!/usr/bin/env node` 的 `.mjs` 脚本 —— 纯 node 环境。它不能依赖一个
 * 需要编译的原生模块（插件自己的 `bridge.mjs` 注释记录了 better-sqlite3
 * 在 node 24 下 `Assertion failed: (env) != nullptr` 直接 abort 进程）。
 *
 * `node:sqlite`（Node 22.5+，Node 24 已 stable）是 **node 内置**的，
 * 且 `prepare(sql).all() / .get() / .run()` 与 better-sqlite3 同形，
 * 所以 `createCompatibleDatabase` 的 shim 无需改动即可工作。
 */
export function getDatabaseClass(): new (path: string) => any {
  // @ts-ignore - Bun global
  if (typeof Bun !== 'undefined') {
    // Bun 运行时使用 bun:sqlite
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require("bun:sqlite");
    return Database;
  }

  // Task #4619: 纯 node 优先用内置的 node:sqlite（无原生依赖）。
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite");
    if (typeof DatabaseSync === "function") {
      return DatabaseSync;
    }
  } catch {
    // node < 22.5 没有 node:sqlite —— 落到 better-sqlite3。
  }

  // Node.js/Electron 使用 better-sqlite3
  return require("better-sqlite3");
}

/**
 * 创建兼容的 Database 实例
 * 
 * bun:sqlite 和 better-sqlite3 的 API 略有不同：
 * - bun:sqlite 有 db.run() 方法
 * - better-sqlite3 没有 db.run()，需要用 db.exec() 或 db.prepare().run()
 * 
 * 此函数确保两种实现都有 run() 方法
 */
export function createCompatibleDatabase(path: string): any {
  const Database = getDatabaseClass();
  return createCompatibleDatabaseFrom(new Database(path));
}

/**
 * Apply the bun:sqlite ↔ better-sqlite3 / node:sqlite compat shim to an
 * **existing** database handle.
 *
 * Task #4619 — factored out of `createCompatibleDatabase` so the shim can be
 * applied to a `node:sqlite` handle (which the plugin's plain-node MCP
 * server uses) without going through the driver constructor.
 */
export function createCompatibleDatabaseFrom(db: any): any {
  // 如果 better-sqlite3，添加 run() / query() 兼容方法
  if (typeof db.run !== 'function') {
    db.run = function(sql: string, ...params: any[]) {
      if (params.length > 0) {
        return this.prepare(sql).run(...params);
      } else {
        return this.exec(sql);
      }
    };
  }

  // ── Task #4619 ────────────────────────────────────────────────────────
  // `query()` was missing from the shim — and the two runtimes disagree on
  // what it even means.
  //
  // * `bun:sqlite` has `db.query(sql, ...params)` → a statement-ish object
  //   with `.all()` / `.get()`. **But it silently IGNORES the params** —
  //   `db.query("SELECT a FROM t WHERE a = ?", "x").all()` returns `[]`.
  //   (Measured on bun 1.3.14.)
  // * `better-sqlite3` (the runtime under **plain node**) has neither
  //   `query()` nor `run()`; `prepare(sql).all(...params)` binds correctly.
  //
  // Without this shim, migrations 004 (`004_rename_action_to_milestone.ts`)
  // and 005 (`005_convert_blob_description_to_text.ts`) aborted under node
  // with `db.query is not a function` — and because the failure is swallowed
  // by a `logger.warn` inside a try/catch, the store silently came up with
  // the OLD `action_*` column names, so every `milestone_*` read then failed.
  //
  // The plugin's Claude-side MCP server runs under plain node (`.mjs` +
  // `#!/usr/bin/env node`), so this path is not optional.
  //
  // The shim is **unconditional** (it replaces bun's `query` too) so that
  // positional parameter binding behaves identically on both runtimes.
  db.query = function(sql: string, ...params: any[]) {
    if (params.length === 0) {
      // No params: both runtimes can serve this from a plain statement.
      const stmt = this.prepare(sql);
      return {
        all: () => stmt.all(),
        get: () => stmt.get(),
        run: () => stmt.run(),
      };
    }
    // With params, `prepare(...).all(...params)` is the only form that binds
    // correctly on BOTH runtimes (bun's own `query` ignores them).
    const stmt = this.prepare(sql);
    return {
      all: (...extra: any[]) => stmt.all(...params, ...extra),
      get: (...extra: any[]) => stmt.get(...params, ...extra),
      run: (...extra: any[]) => stmt.run(...params, ...extra),
    };
  };

  return db;
}

import { join } from "path";
import type {
  Task,
  TaskOperation,
  TaskTag,
  CreateTaskOptions,
  UpdateTaskOptions,
  ListTasksOptions,
  TaskListResult,
  SearchTasksOptions,
  CreateOperationOptions,
  ListOperationsOptions,
} from "../types";
import type { ListTagsOptions, SearchTagsOptions } from "../tag-service";
import { createLogger } from "../../log-trace/logger";
import { TracedAs } from "../../log-trace/decorator";

const logger = createLogger("task:store");

// ============================================================================
// Helpers
// ============================================================================

/**
 * Get default data directory for task storage
 */
function getDefaultDataDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  return join(home, ".local", "share");
}

/**
 * Get default database path for task storage
 */
function getDefaultTaskDbPath(): string {
  return join(getDefaultDataDir(), "roy-bot", "tasks.db");
}

// ============================================================================
// TaskStore Interface
// ============================================================================

export interface TaskStore {
  // ========== Task CRUD ==========
  createTask(options: CreateTaskOptions): Promise<Task>;
  getTask(id: number): Promise<Task | undefined>;
  updateTask(id: number, options: UpdateTaskOptions): Promise<Task | undefined>;
  deleteTask(id: number): Promise<boolean>;
  listTasks(options?: ListTasksOptions): Promise<TaskListResult>;
  /**
   * 按 session_id 反查该 session 里创建的第一个 task（用于 sub-session → task 的
   * 确定性映射：sub-agent 的 task_create 用 sessionId=sub-session id）。
   */
  getTaskIdBySessionId(sessionId: string): Promise<number | undefined>;
  /**
   * Task #5081（optional）— 按 session_id 反查该 session 关联的**全部**
   * task id（不限定 create 记录）。TaskOpWatermarkPlugin 对全部 task
   * 求并集水位。optional：外部宿主实现可不提供（调用方降级到
   * getTaskIdBySessionId 单值）。
   */
  getTaskIdsBySessionId?(sessionId: string): Promise<number[]>;
  
  // ========== Operation CRUD ==========
  createOperation(options: CreateOperationOptions): Promise<TaskOperation>;
  getOperation(id: number): Promise<TaskOperation | undefined>;
  updateOperation(id: number, updates: { milestoneTitle?: string; milestoneDescription?: string; processDescription?: string; actionTitle?: string; actionDescription?: string }): Promise<TaskOperation | undefined>;
  deleteOperation(id: number): Promise<boolean>;
  listOperations(options: ListOperationsOptions): Promise<TaskOperation[]>;
  /**
   * Task #5081（optional）— 绕过 operationsCache 的直读查询。
   *
   * 跨进程写入的 operation 不会失效本进程缓存 → `listOperations`
   * 可能读陈旧快照。本方法**直打 DB**（`ORDER BY id DESC`，不读写
   * 缓存），供 TaskOpWatermarkPlugin 的水位检查使用。
   *
   * optional：不破坏外部宿主实现的 TaskStore 契约（能力探测 +
   * 降级路径见 plugin 侧）。
   */
  listOperationsFresh?(options: ListOperationsOptions): Promise<TaskOperation[]>;
  /**
   * Task #5081（optional）— 主动失效 operationsCache。
   * 降级路径配套：`listOperations` 前调用，保证读到最新。
   */
  invalidateOperationsCache?(taskId: number): void;
  
  // ========== Tag CRUD ==========
  createTag(name: string): Promise<TaskTag>;
  getTag(id: number): Promise<TaskTag | undefined>;
  getTagByName(name: string): Promise<TaskTag | undefined>;
  listTags(options?: ListTagsOptions): Promise<TaskTag[]>;
  searchTags(options: SearchTagsOptions): Promise<TaskTag[]>;
  deleteTag(id: number): Promise<boolean>;
  
  // ========== Tag 与 Task 关联 ==========
  addTagsToTask(taskId: number, tagIds: number[]): Promise<void>;
  removeTagsFromTask(taskId: number, tagIds: number[]): Promise<void>;
  getTagsForTask(taskId: number): Promise<TaskTag[]>;
  getTaskIdsByTags(tagNames: string[]): Promise<number[]>;
  updateTaskTags(taskId: number, tagNames: string[]): Promise<void>;
  
  // ========== 检索能力（核心改造）==========
  /**
   * Search tasks by keywords (tags, description, goals, operations).
   * Returns { tasks, total } for pagination.
   *
   * 支持 depth 层级检索（参见 SearchTasksOptions.depth）。
   */
  searchTasksByKeywords(keywords: string[], options?: SearchTasksOptions): Promise<TaskListResult>;
  /** Find similar tasks using new keywords search */
  findSimilarTasksByKeywords(keywords: string[], options?: { limit?: number; excludeTaskId?: number }): Promise<Task[]>;

  /**
   * 获取任务的子树（包含所有后代）
   *
   * @param taskId 起始任务 ID
   * @param depth 层级深度，-1 表示无限层级（默认）
   * @returns 所有后代任务的扁平列表（不含 taskId 本身）
   *
   * 实现：BFS 逐层展开 children，每层 +1。depth 限制 BFS 展开层数。
   */
  getTaskTree(taskId: number, depth?: number): Promise<Task[]>;
  /**
   * 获取直接子任务（一层）。
   */
  getChildTasks(taskId: number, options?: ListTasksOptions): Promise<TaskListResult>;

  // ========== 检索能力（向后兼容）==========
  findSimilarTasks(taskId: number, limit?: number): Promise<Task[]>;
  searchTasks(query: string, limit?: number): Promise<Task[]>;
  /**
   * Task #4230 follow-up：按 context 里的字符串值反查 task
   *
   * 用途：已知一个飞书 chatId，反查"哪些 task 把这个群写进了自己的 context"
   * （用于判定"这个群是不是某个 task 的专属群"）。
   * 只用 LIKE 做粗筛，精确字段名/语义判断交给调用方（card-chat-routing）。
   */
  findTasksByContextValue(value: string, limit?: number): Promise<Task[]>;
  
  // ========== 生命周期 ==========
  close(): void;
}

// ============================================================================
// SQLiteTaskStore
// ============================================================================

/**
 * SQLite-based Task Store
 * 
 * 参考 Session SQLiteStore 实现模式：
 * - 使用 bun:sqlite 内置模块
 * - 内存缓存提高性能
 * - 默认路径：~/.local/share/roy-bot/tasks.db
 */
export class SQLiteTaskStore implements TaskStore {
  private db: any = null;
  private dbPath: string;
  private initialized = false;

  // 内存缓存（与 SessionStore 模式一致）
  private tasksCache = new Map<number, Task>();
  private operationsCache = new Map<number, TaskOperation[]>();

  constructor(dbPath?: string) {
    this.dbPath = dbPath || getDefaultTaskDbPath();
  }

  // ========================================================================
  // Initialization
  // ========================================================================

  private async initialize(): Promise<void> {
    if (this.initialized) return;

    // 使用运行时检测获取兼容的 SQLite 实现
    // 确保 bun:sqlite 和 better-sqlite3 都有 run() 方法

    // 确保目录存在
    if (this.dbPath !== ":memory:") {
      const fs = require("fs");
      const path = require("path");
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.db = createCompatibleDatabase(this.dbPath);

    // 创建表（与 SessionStore 风格一致）
    this.db.run(`
      CREATE TABLE IF NOT EXISTS task (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        status TEXT DEFAULT 'todo',
        priority TEXT DEFAULT 'medium',
        type TEXT DEFAULT 'normal',
        progress INTEGER DEFAULT 0,
        current_status TEXT DEFAULT '',
        goals_and_expected_deliverables TEXT DEFAULT '',
        parent_task_id INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        due_date TEXT,
        tags TEXT,
        project_path TEXT NOT NULL DEFAULT 'unknown',
        context TEXT NOT NULL DEFAULT '{}',
        owner TEXT
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS task_operation (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        milestone_type TEXT NOT NULL,
        milestone_title TEXT NOT NULL,
        milestone_description TEXT DEFAULT '',
        process_description TEXT NOT NULL DEFAULT '',
        timestamp INTEGER NOT NULL,
        md_path TEXT,
        FOREIGN KEY (task_id) REFERENCES task(id) ON DELETE CASCADE
      )
    `);

    this.db.run("CREATE INDEX IF NOT EXISTS idx_task_operation_task_id ON task_operation(task_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_task_operation_session_id ON task_operation(session_id)");

    // Tag 池表
    this.db.run(`
      CREATE TABLE IF NOT EXISTS task_tag (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        task_count INTEGER DEFAULT 0
      )
    `);

    // Tag 与 Task 关联表
    this.db.run(`
      CREATE TABLE IF NOT EXISTS task_tag_relation (
        task_id INTEGER NOT NULL,
        tag_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (task_id, tag_id),
        FOREIGN KEY (task_id) REFERENCES task(id) ON DELETE CASCADE,
        FOREIGN KEY (tag_id) REFERENCES task_tag(id) ON DELETE CASCADE
      )
    `);

    this.db.run("CREATE INDEX IF NOT EXISTS idx_task_tag_relation_tag_id ON task_tag_relation(tag_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_task_parent_task_id ON task(parent_task_id)");

    // Run migrations for existing databases
    if (this.dbPath !== ":memory:") {
      try {
        const { runMigration: runMigration001 } = require("./migrations/001_add_project_path_context");
        runMigration001(this.dbPath);
      } catch (e: any) {
        logger.warn(`[Migration 001] Failed to run: ${e.message}`);
      }
      try {
        const { runMigration: runMigration002 } = require("./migrations/002_add_task_type");
        runMigration002(this.dbPath);
      } catch (e: any) {
        logger.warn(`[Migration 002] Failed to run: ${e.message}`);
      }
      try {
        const { runMigration: runMigration003 } = require("./migrations/003_add_process_description");
        runMigration003(this.dbPath);
      } catch (e: any) {
        logger.warn(`[Migration 003] Failed to run: ${e.message}`);
      }
      try {
        const { runMigration: runMigration004 } = require("./migrations/004_rename_action_to_milestone");
        runMigration004(this.dbPath);
      } catch (e: any) {
        logger.warn(`[Migration 004] Failed to run: ${e.message}`);
      }
      try {
        const { runMigration: runMigration005 } = require("./migrations/005_convert_blob_description_to_text");
        runMigration005(this.dbPath);
      } catch (e: any) {
        logger.warn(`[Migration 005] Failed to run: ${e.message}`);
      }
      try {
        const { runMigration: runMigration006 } = require("./migrations/006_add_task_owner");
        runMigration006(this.dbPath);
      } catch (e: any) {
        logger.warn(`[Migration 006] Failed to run: ${e.message}`);
      }
    }

    // owner 索引必须在 owner 列存在之后建：新库由上面的 DDL 提供，
    // 老库由 migration 006 补列 —— 所以放在迁移之后（否则老库首次打开
    // 会在 "no such column: owner" 上抛错，见 task-owner.test.ts）。
    try {
      this.db.run("CREATE INDEX IF NOT EXISTS idx_task_owner ON task(owner)");
    } catch (e: any) {
      logger.warn(`[TaskStore] idx_task_owner creation failed: ${e.message}`);
    }

    this.initialized = true;
    logger.info(`TaskStore initialized at ${this.dbPath}`);
  }

  // ========================================================================
  // Task CRUD
  // ========================================================================

  async createTask(options: CreateTaskOptions): Promise<Task> {
    await this.initialize();
    
    const now = Date.now();
    
    const stmt = this.db.prepare(`
      INSERT INTO task (title, description, priority, type, parent_task_id, 
        goals_and_expected_deliverables, due_date, tags, status, 
        current_status, created_at, updated_at, project_path, context, owner)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'todo', '', ?, ?, ?, ?, ?)
    `);
    
    const result = stmt.run(
      options.title,
      options.description || "",
      options.priority || "medium",
      options.type || "normal",
      options.parent_task_id || null,
      options.goals_and_expected_deliverables || "",
      options.due_date || null,
      options.tags ? JSON.stringify(options.tags) : null,
      now,
      now,
      options.project_path,
      options.context,
      // owner：null / "" 都表示未指派（与 update 的清空语义一致）
      options.owner || null
    );
    
    const task = await this.getTask(result.lastInsertRowid as number);
    if (task) {
      this.tasksCache.set(task.id, task);
      return task;
    }
    throw new Error("Failed to create task");
  }

  async getTask(id: number): Promise<Task | undefined> {
    await this.initialize();
    
    // 检查缓存
    if (this.tasksCache.has(id)) {
      return this.tasksCache.get(id);
    }
    
    const stmt = this.db.prepare("SELECT * FROM task WHERE id = ?");
    const row = stmt.get(id) as any;
    if (!row) return undefined;
    
    const task = this.rowToTask(row);
    this.tasksCache.set(id, task);
    return task;
  }

  async updateTask(id: number, options: UpdateTaskOptions): Promise<Task | undefined> {
    await this.initialize();
    
    const task = await this.getTask(id);
    if (!task) return undefined;
    
    const updates: string[] = [];
    const values: any[] = [];
    
    if (options.title !== undefined) { updates.push("title = ?"); values.push(options.title); }
    if (options.description !== undefined) { updates.push("description = ?"); values.push(options.description); }
    if (options.status !== undefined) { updates.push("status = ?"); values.push(options.status); }
    if (options.priority !== undefined) { updates.push("priority = ?"); values.push(options.priority); }
    if (options.type !== undefined) { updates.push("type = ?"); values.push(options.type); }
    if (options.progress !== undefined) { updates.push("progress = ?"); values.push(options.progress); }
    if (options.current_status !== undefined) { updates.push("current_status = ?"); values.push(options.current_status); }
    if (options.goals_and_expected_deliverables !== undefined) { updates.push("goals_and_expected_deliverables = ?"); values.push(options.goals_and_expected_deliverables); }
    if (options.due_date !== undefined) { updates.push("due_date = ?"); values.push(options.due_date); }
    if (options.tags !== undefined) { updates.push("tags = ?"); values.push(JSON.stringify(options.tags)); }
    if (options.project_path !== undefined) { updates.push("project_path = ?"); values.push(options.project_path); }
    if (options.context !== undefined) { updates.push("context = ?"); values.push(options.context); }
    if (options.parent_task_id !== undefined) { updates.push("parent_task_id = ?"); values.push(options.parent_task_id); }
    // owner：null / "" 都表示清空（未指派）
    if (options.owner !== undefined) { updates.push("owner = ?"); values.push(options.owner || null); }
    
    if (updates.length === 0) return task;
    
    updates.push("updated_at = ?");
    values.push(Date.now());
    values.push(id);
    
    const stmt = this.db.prepare(`UPDATE task SET ${updates.join(", ")} WHERE id = ?`);
    stmt.run(...values);
    
    // 清除缓存
    this.tasksCache.delete(id);
    
    return this.getTask(id);
  }

  async deleteTask(id: number): Promise<boolean> {
    await this.initialize();
    
    const stmt = this.db.prepare("DELETE FROM task WHERE id = ?");
    const result = stmt.run(id);
    
    if (result.changes > 0) {
      this.tasksCache.delete(id);
      this.operationsCache.delete(id);
    }
    
    return result.changes > 0;
  }

  async listTasks(options?: ListTasksOptions): Promise<TaskListResult> {
    await this.initialize();

    // 1. 处理 depth 层级过滤（如果有 depth 配置且未指定 parent_task_id）
    //    - parent_task_id 显式指定时：depth 仅作为额外子树限制（这里保持向后兼容，
    //      按指定 parent 查询，不做子树展开）
    //    - depth === 0：只查根任务
    //    - depth === 1：根 + 一层子任务
    //    - depth >= 2：根 + N 层子任务（BFS 展开）
    //    - depth < 0 或 undefined：不过滤
    //
    //    注意：depth 与 parent_task_id 同时使用是边界场景。
    //    若 parent_task_id 已指定，则视为"以该父节点为根展开 N 层"。
    //    若未指定 parent_task_id 且 depth >= 0，则从所有根任务开始展开。
    if (
      options?.depth !== undefined &&
      options.depth >= 0 &&
      // 若未指定 parent_task_id，则启用 depth 展开
      options.parent_task_id === undefined
    ) {
      return this.listTasksByDepth(options);
    }

    // Build WHERE clause (shared between COUNT and SELECT)
    const whereClauses: string[] = ["1=1"];
    const whereParams: any[] = [];

    if (options?.status) { whereClauses.push("status = ?"); whereParams.push(options.status); }
    if (options?.priority) { whereClauses.push("priority = ?"); whereParams.push(options.priority); }
    if (options?.type) { whereClauses.push("type = ?"); whereParams.push(options.type); }
    if (options?.parent_task_id !== undefined) { whereClauses.push("parent_task_id = ?"); whereParams.push(options.parent_task_id); }
    
    // 默认排除 archived（除非显式指定 include_archived=true 或 status=archived）
    if (!options?.include_archived && options?.status !== "archived") {
      whereClauses.push("status != 'archived'");
    }

    const whereSql = whereClauses.join(" AND ");

    // 1. COUNT query for total
    const countSql = `SELECT COUNT(*) as total FROM task WHERE ${whereSql}`;
    const countRow = this.db.prepare(countSql).get(...whereParams) as { total: number } | undefined;
    const total = countRow?.total ?? 0;

    // 2. SELECT query with LIMIT/OFFSET
    let sql = `SELECT * FROM task WHERE ${whereSql}`;
    const params: any[] = [...whereParams];

    sql += " ORDER BY updated_at DESC";

    if (options?.limit) { sql += " LIMIT ?"; params.push(options.limit); }
    if (options?.offset) { sql += " OFFSET ?"; params.push(options.offset); }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];

    const tasks = rows.map(row => {
      const task = this.rowToTask(row);
      this.tasksCache.set(task.id, task);
      return task;
    });

    return { tasks, total };
  }

  /**
   * 按层级深度检索任务（BFS 展开）
   *
   * - depth === 0：只查根任务（parent_task_id IS NULL）
   * - depth === 1：根 + 一层子任务
   * - depth >= 2：根 + N 层子任务
   *
   * 支持 status / priority / type 过滤（在每层展开时复用）。
   * limit/offset 在合并所有层级结果后应用（注意：total 是展开后的总数）。
   */
  private async listTasksByDepth(
    options: ListTasksOptions
  ): Promise<TaskListResult> {
    const depth = options.depth ?? 0;
    const filterClauses: string[] = ["1=1"];
    const filterParams: any[] = [];
    if (options.status) { filterClauses.push("status = ?"); filterParams.push(options.status); }
    if (options.priority) { filterClauses.push("priority = ?"); filterParams.push(options.priority); }
    if (options.type) { filterClauses.push("type = ?"); filterParams.push(options.type); }
    // 默认排除 archived（除非显式指定 include_archived=true 或 status=archived）
    if (!options?.include_archived && options?.status !== "archived") {
      filterClauses.push("status != 'archived'");
    }
    const filterSql = filterClauses.join(" AND ");

    const collected: Task[] = [];

    // depth === 0：只根任务
    if (depth === 0) {
      const rootSql = `SELECT * FROM task WHERE parent_task_id IS NULL AND ${filterSql} ORDER BY updated_at DESC`;
      const rows = this.db.prepare(rootSql).all(...filterParams) as any[];
      for (const row of rows) {
        const t = this.rowToTask(row);
        this.tasksCache.set(t.id, t);
        collected.push(t);
      }
    } else {
      // depth >= 1：BFS 展开
      // 1) 取所有根任务
      const rootRows = this.db.prepare(
        `SELECT * FROM task WHERE parent_task_id IS NULL AND ${filterSql} ORDER BY updated_at DESC`
      ).all(...filterParams) as any[];

      let currentLevel: Task[] = rootRows.map(row => {
        const t = this.rowToTask(row);
        this.tasksCache.set(t.id, t);
        return t;
      });
      collected.push(...currentLevel);

      // 2) 逐层展开
      for (let level = 1; level <= depth; level++) {
        if (currentLevel.length === 0) break;
        const ids = currentLevel.map(t => t.id);
        const placeholders = ids.map(() => "?").join(",");
        // 子任务可能继承父任务的 status/priority/type 之外的过滤条件
        const childSql = `SELECT * FROM task WHERE parent_task_id IN (${placeholders}) AND ${filterSql} ORDER BY updated_at DESC`;
        const childRows = this.db.prepare(childSql).all(...ids, ...filterParams) as any[];

        const nextLevel: Task[] = childRows.map(row => {
          const t = this.rowToTask(row);
          this.tasksCache.set(t.id, t);
          return t;
        });
        collected.push(...nextLevel);
        currentLevel = nextLevel;
      }
    }

    // 应用 limit / offset
    const total = collected.length;
    const offset = options.offset ?? 0;
    const limit = options.limit ?? total;
    const sliced = collected.slice(offset, offset + limit);
    return { tasks: sliced, total };
  }

  /**
   * 获取任务的子树（包含所有后代）
   *
   * @param taskId 起始任务 ID
   * @param depth 层级深度，-1 表示无限层级（默认）
   * @returns 所有后代任务的扁平列表（不含 taskId 本身）
   */
  async getTaskTree(taskId: number, depth: number = -1): Promise<Task[]> {
    await this.initialize();

    const result: Task[] = [];
    // BFS：用 ID 队列按层推进
    let currentLevel: number[] = [taskId];
    let currentDepth = 0;

    while (currentLevel.length > 0) {
      if (depth !== -1 && currentDepth >= depth) break;
      const placeholders = currentLevel.map(() => "?").join(",");
      const rows = this.db.prepare(
        `SELECT * FROM task WHERE parent_task_id IN (${placeholders}) ORDER BY updated_at DESC`
      ).all(...currentLevel) as any[];

      const nextLevel: number[] = [];
      for (const row of rows) {
        const t = this.rowToTask(row);
        this.tasksCache.set(t.id, t);
        result.push(t);
        nextLevel.push(t.id);
      }
      currentLevel = nextLevel;
      currentDepth++;
    }

    return result;
  }

  /**
   * 获取直接子任务（一层）
   */
  async getChildTasks(
    taskId: number,
    options: ListTasksOptions = {}
  ): Promise<TaskListResult> {
    return this.listTasks({ ...options, parent_task_id: taskId });
  }

  // ========================================================================
  // Operation CRUD
  // ========================================================================

  async createOperation(options: CreateOperationOptions): Promise<TaskOperation> {
    await this.initialize();

    // 兼容 action_* 与 milestone_* 字段：优先使用 milestone_*，否则 fallback 到 action_*
    const finalMilestoneType = options.milestoneType ?? options.actionType;
    const finalMilestoneTitle = options.milestoneTitle ?? options.actionTitle;
    const finalMilestoneDesc = options.milestoneDescription ?? options.actionDescription;

    if (!finalMilestoneType || !finalMilestoneTitle) {
      throw new Error(
        "createOperation requires milestoneType and milestoneTitle (or legacy actionType/actionTitle)"
      );
    }

    const now = Date.now();

    const stmt = this.db.prepare(`
      INSERT INTO task_operation (task_id, session_id, milestone_type, milestone_title,
        milestone_description, process_description, timestamp, md_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      options.taskId,
      options.sessionId,
      finalMilestoneType,
      finalMilestoneTitle,
      finalMilestoneDesc || "",
      options.processDescription || "",
      now,
      options.mdPath || null
    );

    // 清除操作缓存
    this.operationsCache.delete(options.taskId);

    const operation = await this.getOperation(result.lastInsertRowid as number);
    if (!operation) {
      throw new Error("Failed to create operation");
    }
    return operation;
  }

  async getOperation(id: number): Promise<TaskOperation | undefined> {
    await this.initialize();
    
    const stmt = this.db.prepare("SELECT * FROM task_operation WHERE id = ?");
    const row = stmt.get(id) as any;
    if (!row) return undefined;
    return this.rowToOperation(row);
  }

  async updateOperation(id: number, updates: { milestoneTitle?: string; milestoneDescription?: string; processDescription?: string; actionTitle?: string; actionDescription?: string }): Promise<TaskOperation | undefined> {
    await this.initialize();

    const op = await this.getOperation(id);
    if (!op) return undefined;

    // 兼容 action_* 与 milestone_* 字段：优先使用 milestone_*，否则 fallback 到 action_*
    const titleValue = updates.milestoneTitle ?? updates.actionTitle;
    const descValue = updates.milestoneDescription ?? updates.actionDescription;

    const setClauses: string[] = [];
    const values: any[] = [];

    if (titleValue !== undefined) { setClauses.push("milestone_title = ?"); values.push(titleValue); }
    if (descValue !== undefined) { setClauses.push("milestone_description = ?"); values.push(descValue); }
    if (updates.processDescription !== undefined) { setClauses.push("process_description = ?"); values.push(updates.processDescription); }

    if (setClauses.length === 0) return op;

    const stmt = this.db.prepare(`UPDATE task_operation SET ${setClauses.join(", ")} WHERE id = ?`);
    stmt.run(...values, id);

    // 清除缓存
    this.operationsCache.delete(op.taskId);

    return this.getOperation(id);
  }

  async deleteOperation(id: number): Promise<boolean> {
    await this.initialize();
    
    const op = await this.getOperation(id);
    if (!op) return false;
    
    const stmt = this.db.prepare("DELETE FROM task_operation WHERE id = ?");
    const result = stmt.run(id);
    
    if (result.changes > 0) {
      this.operationsCache.delete(op.taskId);
    }
    
    return result.changes > 0;
  }

  async listOperations(options: ListOperationsOptions): Promise<TaskOperation[]> {
    await this.initialize();
    
    // 检查缓存
    const cacheKey = options.taskId;
    if (!this.operationsCache.has(cacheKey)) {
      const stmt = this.db.prepare("SELECT * FROM task_operation WHERE task_id = ? ORDER BY timestamp DESC");
      const rows = stmt.all(options.taskId) as any[];
      this.operationsCache.set(cacheKey, rows.map(row => this.rowToOperation(row)));
    }
    
    let ops = this.operationsCache.get(cacheKey)!;

    // 按 milestone_type 筛选（兼容 actionType alias）
    const filterType = options.milestoneType ?? options.actionType;
    if (filterType) {
      ops = ops.filter(op => op.milestoneType === filterType);
    }

    // 分页
    const offset = options.offset || 0;
    const limit = options.limit || 20;

    return ops.slice(offset, offset + limit);
  }

  /**
   * Task #5081 — 绕过 operationsCache 的直读查询（optional 能力）。
   *
   * 为什么必须有：operationsCache 只在本进程 create/update/delete 时
   * 失效（:744/:785/:800），**跨进程写入的 operation 不会失效本进程
   * 缓存** —— CLI 探针 / 另一 daemon 进程写的记录，本进程的
   * `listOperations` 永远看不到（读陈旧快照）→ TaskOpWatermarkPlugin
   * 的水位检查会漏报。
   *
   * 要点：
   * - `ORDER BY id DESC`：水位语义要求**单调自增 id**（timestamp 同
   *   毫秒多条会漏），id 是 AUTOINCREMENT 严格单调。
   * - **只读，不写 operationsCache**：不污染其它调用方的缓存语义。
   */
  async listOperationsFresh(options: ListOperationsOptions): Promise<TaskOperation[]> {
    await this.initialize();

    const stmt = this.db.prepare(
      "SELECT * FROM task_operation WHERE task_id = ? ORDER BY id DESC",
    );
    const rows = stmt.all(options.taskId) as any[];

    let ops = rows.map(row => this.rowToOperation(row));

    // 按 milestone_type 筛选（兼容 actionType alias），语义与 listOperations 一致
    const filterType = options.milestoneType ?? options.actionType;
    if (filterType) {
      ops = ops.filter(op => op.milestoneType === filterType);
    }

    const offset = options.offset || 0;
    const limit = options.limit || 20;
    return ops.slice(offset, offset + limit);
  }

  /**
   * Task #5081 — 主动失效 operationsCache（optional 能力）。
   *
   * 供不支持 `listOperationsFresh` 的外部宿主 backend 走降级路径：
   * `listOperations` 之前先失效缓存，保证下次读到最新。
   */
  invalidateOperationsCache(taskId: number): void {
    this.operationsCache.delete(taskId);
  }

  /**
   * 按 session_id 反查该 session 创建的第一个 task。
   *
   * task 表本身不存 session_id，但 createTask 会写一条 milestone_type='create'
   * 的 task_operation（带 session_id）。sub-agent 的 task_create 用
   * sessionId=sub-session id，所以这里能确定性地把 sub-session 映射回它创建的 task，
   * 不依赖易失的 EnvContext.currentTaskId（会被 task_complete 清空）或结果文本正则。
   */
  async getTaskIdBySessionId(sessionId: string): Promise<number | undefined> {
    await this.initialize();
    if (!sessionId) return undefined;
    const row = this.db
      .prepare(
        "SELECT task_id FROM task_operation WHERE session_id = ? AND milestone_type = 'create' ORDER BY timestamp ASC LIMIT 1",
      )
      .get(sessionId) as { task_id?: number } | undefined;
    return typeof row?.task_id === "number" ? row.task_id : undefined;
  }

  /**
   * Task #5081 — 按 session_id 反查该 session 关联的**全部** task id
   * （optional 能力，TaskStore 接口同款 optional）。
   *
   * 与 getTaskIdBySessionId 的区别：不限定 milestone_type='create'、
   * 不 LIMIT 1 —— sub-session 往同一 task 写过任何 operation 记录
   * （记进度 / milestone / pre_complete 留痕）都算关联。
   */
  async getTaskIdsBySessionId(sessionId: string): Promise<number[]> {
    await this.initialize();
    if (!sessionId) return [];
    const rows = this.db
      .prepare(
        "SELECT DISTINCT task_id FROM task_operation WHERE session_id = ? ORDER BY task_id ASC",
      )
      .all(sessionId) as Array<{ task_id?: number }>;
    return rows
      .map((r) => r.task_id)
      .filter((id): id is number => typeof id === "number");
  }

  // ========================================================================
  // Helpers
  // ========================================================================

  @TracedAs("task.rowToTask", { recordParams: true, recordResult: true, log: true })
  private rowToTask(row: any): Task {
    // 防御性 String() 转换：BLOB 列（如 Task #2084 description 15619 字节）经
    // better-sqlite3 / bun:sqlite 读出为 Buffer 对象。Buffer truthy 但无 toLowerCase，
    // 必须在 row 边界强制 string 化，避免下游 searchTasksByKeywords 抛 TypeError。
    // 参考：Task #2226。
    return {
      id: row.id,
      title: String(row.title ?? ""),
      description: String(row.description ?? ""),
      status: String(row.status ?? "todo"),
      priority: String(row.priority ?? "medium"),
      type: String(row.type ?? "normal"),
      progress: row.progress,
      current_status: String(row.current_status ?? ""),
      goals_and_expected_deliverables: String(
        row.goals_and_expected_deliverables ?? "",
      ),
      parent_task_id: row.parent_task_id || undefined,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      due_date: row.due_date ? String(row.due_date) : undefined,
      tags: SQLiteTaskStore.parseTagsSafely(row.tags),
      project_path: String(row.project_path ?? "unknown"),
      context: row.context,
      // 老库补列前的老行 owner 是 NULL → 归一化为 null（不是 undefined）
      owner: row.owner === undefined || row.owner === null ? null : String(row.owner),
    };
  }

  /**
   * 安全解析 tags 字段。
   *
   * 历史背景：Bug 修复 Task #4033 — 任务 [HTML 样式重构] v33 → v34 的 tags 字段
   * 被存成了 CSV 字符串 `'html-styling, css-refactor, v34, feishu, slides'` 而非
   * 合法 JSON 数组，导致裸 `JSON.parse` 抛 SyntaxError，`tasks list` 命令
   * `ORDER BY updated_at DESC` 第一条就挂掉，整个 CLI 不显示任何任务。
   *
   * 策略（按优先级 fallback，不抛错）：
   *   1. null/undefined/空串 → undefined
   *   2. 合法 JSON 数组 → 原样返回
   *   3. 合法 JSON 但不是数组（如 "tag1" 单字符串）→ 包成单元素数组（向后兼容）
   *   4. 非法 JSON（CSV / 纯文本）→ 当作单个 tag 字符串，包成单元素数组
   *   5. 其他类型（数字、对象等）→ undefined
   */
  private static parseTagsSafely(raw: unknown): string[] | undefined {
    if (raw === null || raw === undefined || raw === "") {
      return undefined;
    }
    const str = typeof raw === "string" ? raw : String(raw);
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed)) {
        return parsed as string[];
      }
      if (typeof parsed === "string") {
        return [parsed];
      }
      // 其他类型（number/object 等）按"无法识别"处理
      return undefined;
    } catch {
      // 损坏数据 fallback：整段 raw 当作单个 tag
      return [str];
    }
  }

  private rowToOperation(row: any): TaskOperation {
    // 双字段读取：milestone_* 是主命名，action_* 是 deprecated alias（自动代理回 milestone_*）
    const milestoneType = (row.milestone_type ?? row.action_type) as TaskOperation["milestoneType"];
    const milestoneTitle = (row.milestone_title ?? row.action_title) as string;
    const milestoneDescription = (row.milestone_description ?? row.action_description ?? "") as string;

    return {
      id: row.id,
      taskId: row.task_id,
      sessionId: row.session_id,
      // 主命名（状态/里程碑维度）
      milestoneType,
      milestoneTitle,
      milestoneDescription,
      // 过程维度
      processDescription: row.process_description ?? "",
      timestamp: new Date(row.timestamp).toISOString(),
      mdPath: row.md_path || undefined,
      // 兼容旧调用方：deprecated alias 直接镜像主字段值
      actionType: milestoneType,
      actionTitle: milestoneTitle,
      actionDescription: milestoneDescription,
    };
  }

  // ========================================================================
  // Tag CRUD
  // ========================================================================

  async createTag(name: string): Promise<TaskTag> {
    await this.initialize();
    
    const now = Date.now();
    
    // 检查是否已存在
    const existing = await this.getTagByName(name);
    if (existing) {
      return existing;
    }
    
    const stmt = this.db.prepare(`
      INSERT INTO task_tag (name, created_at, task_count)
      VALUES (?, ?, 0)
    `);
    
    const result = stmt.run(name, now);
    
    return {
      id: result.lastInsertRowid as number,
      name,
      createdAt: new Date(now).toISOString(),
      taskCount: 0,
    };
  }

  async getTag(id: number): Promise<TaskTag | undefined> {
    await this.initialize();
    
    const stmt = this.db.prepare("SELECT * FROM task_tag WHERE id = ?");
    const row = stmt.get(id) as any;
    if (!row) return undefined;
    return this.rowToTag(row);
  }

  async getTagByName(name: string): Promise<TaskTag | undefined> {
    await this.initialize();
    
    const stmt = this.db.prepare("SELECT * FROM task_tag WHERE name = ?");
    const row = stmt.get(name) as any;
    if (!row) return undefined;
    return this.rowToTag(row);
  }

  async listTags(options?: ListTagsOptions): Promise<TaskTag[]> {
    await this.initialize();
    
    let sql = "SELECT * FROM task_tag";
    const params: any[] = [];
    
    // 排序
    const orderBy = options?.orderBy || "count";
    if (orderBy === "count") {
      sql += " ORDER BY task_count DESC";
    } else if (orderBy === "name") {
      sql += " ORDER BY name ASC";
    } else {
      sql += " ORDER BY created_at DESC";
    }
    
    // 分页
    if (options?.limit) { sql += " LIMIT ?"; params.push(options.limit); }
    if (options?.offset) { sql += " OFFSET ?"; params.push(options.offset); }
    
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];
    
    return rows.map(row => this.rowToTag(row));
  }

  async searchTags(options: SearchTagsOptions): Promise<TaskTag[]> {
    await this.initialize();
    
    const sql = `
      SELECT * FROM task_tag 
      WHERE name LIKE ? 
      ORDER BY task_count DESC 
      LIMIT ?
    `;
    
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(`%${options.query}%`, options.limit || 20) as any[];
    
    return rows.map(row => this.rowToTag(row));
  }

  async deleteTag(id: number): Promise<boolean> {
    await this.initialize();
    
    const stmt = this.db.prepare("DELETE FROM task_tag WHERE id = ?");
    const result = stmt.run(id);
    
    return result.changes > 0;
  }

  // ========================================================================
  // Tag 与 Task 关联
  // ========================================================================

  async addTagsToTask(taskId: number, tagIds: number[]): Promise<void> {
    await this.initialize();
    
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO task_tag_relation (task_id, tag_id, created_at)
      VALUES (?, ?, ?)
    `);
    
    for (const tagId of tagIds) {
      stmt.run(taskId, tagId, now);
      
      // 更新 task_count
      this.db.run(`
        UPDATE task_tag SET task_count = task_count + 1 WHERE id = ?
      `, tagId);
    }
    
    // 更新 task.tags JSON 字段
    await this.syncTaskTagsJson(taskId);
  }

  async removeTagsFromTask(taskId: number, tagIds: number[]): Promise<void> {
    await this.initialize();
    
    const stmt = this.db.prepare("DELETE FROM task_tag_relation WHERE task_id = ? AND tag_id = ?");
    
    for (const tagId of tagIds) {
      stmt.run(taskId, tagId);
      
      // 减少 task_count
      this.db.run(`
        UPDATE task_tag SET task_count = MAX(0, task_count - 1) WHERE id = ?
      `, tagId);
    }
    
    // 更新 task.tags JSON 字段
    await this.syncTaskTagsJson(taskId);
  }

  async getTagsForTask(taskId: number): Promise<TaskTag[]> {
    await this.initialize();
    
    const sql = `
      SELECT t.* FROM task_tag t
      INNER JOIN task_tag_relation r ON t.id = r.tag_id
      WHERE r.task_id = ?
      ORDER BY t.name ASC
    `;
    
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(taskId) as any[];
    
    return rows.map(row => this.rowToTag(row));
  }

  async getTaskIdsByTags(tagNames: string[]): Promise<number[]> {
    await this.initialize();
    
    if (tagNames.length === 0) return [];
    
    const placeholders = tagNames.map(() => "?").join(", ");
    const sql = `
      SELECT DISTINCT r.task_id FROM task_tag_relation r
      INNER JOIN task_tag t ON r.tag_id = t.id
      WHERE t.name IN (${placeholders})
    `;
    
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...tagNames) as any[];
    
    return rows.map(row => row.task_id);
  }

  async updateTaskTags(taskId: number, tagNames: string[]): Promise<void> {
    await this.initialize();
    
    // 先删除所有关联
    const currentTags = await this.getTagsForTask(taskId);
    if (currentTags.length > 0) {
      await this.removeTagsFromTask(taskId, currentTags.map(t => t.id));
    }
    
    // 再添加新关联
    const tagIds: number[] = [];
    for (const name of tagNames) {
      let tag = await this.getTagByName(name);
      if (!tag) {
        tag = await this.createTag(name);
      }
      tagIds.push(tag.id);
    }
    
    if (tagIds.length > 0) {
      await this.addTagsToTask(taskId, tagIds);
    }
  }

  // ========================================================================
  // 检索能力（核心改造）
  // ========================================================================

  /**
   * Search tasks by keywords list
   * Searches in: tags (JSON), description, goals_and_expected_deliverables, operations
   *
   * 支持 depth 参数：depth=0 只匹配根任务（AND 关系），depth=1 根+子，依此类推
   */
  @TracedAs("task.searchTasksByKeywords", { recordParams: true, recordResult: true, log: true })
  async searchTasksByKeywords(
    keywords: string[],
    options: SearchTasksOptions = {}
  ): Promise<TaskListResult> {
    await this.initialize();

    if (!keywords || keywords.length === 0) {
      return { tasks: [], total: 0 };
    }

    const { limit = 20, offset = 0, excludeTaskId, status, priority, type, depth } = options;

    // 0. depth 预处理：计算允许的任务 ID 集合
    //    - depth === 0：只根任务
    //    - depth >= 1：BFS 展开到 N 层
    //    - depth < 0 或 undefined：不过滤
    let allowedTaskIds: Set<number> | null = null;
    if (depth !== undefined && depth >= 0) {
      allowedTaskIds = await this.collectTaskIdsByDepth(depth);
    }
    const tasks: Map<number, { task: Task; matchCount: number }> = new Map();

    // 1. Search in task fields (tags JSON, description, goals)
    // Build WHERE for status/priority/type filters at SQL level
    let taskSql = "SELECT * FROM task WHERE 1=1";
    const taskParams: any[] = [];

    if (excludeTaskId) {
      taskSql += " AND id != ?";
      taskParams.push(excludeTaskId);
    }
    if (status) {
      taskSql += " AND status = ?";
      taskParams.push(status);
    }
    if (priority) {
      taskSql += " AND priority = ?";
      taskParams.push(priority);
    }
    if (type) {
      taskSql += " AND type = ?";
      taskParams.push(type);
    }

    // 默认排除 archived（必须放在 if(type) 块外部，否则 type 未指定时也不生效）
    if (!options?.include_archived && options?.status !== "archived") {
      taskSql += " AND status != 'archived'";
    }

    // We need to scan more rows because we're doing in-memory relevance filtering.
    // Use a generous multiplier or, if no filters are set, scan all matching candidates.
    // For correctness with pagination, we should NOT slice here before relevance.
    const scanLimit = Math.max(limit * 5, 200);
    taskSql += " ORDER BY updated_at DESC LIMIT ?";
    taskParams.push(scanLimit);

    const taskRows = this.db.prepare(taskSql).all(...taskParams) as any[];

    for (const row of taskRows) {
      const task = this.rowToTask(row);
      const matchedKeywords = new Set<string>(); let matchCount = 0;

      // Check title (case-insensitive)
      if (typeof task.title === "string" && task.title) {
        const lowerTitle = task.title.toLowerCase();
        for (const keyword of keywords) {
          if (lowerTitle.includes(keyword.toLowerCase())) {
            { matchCount++; matchedKeywords.add(keyword); }
          }
        }
      }

      // Check tags (JSON array) - higher weight
      if (task.tags && Array.isArray(task.tags)) {
        for (const keyword of keywords) {
          const lowerKeyword = keyword.toLowerCase();
          if (task.tags.some(tag => tag.toLowerCase().includes(lowerKeyword))) {
            { matchCount += 2; matchedKeywords.add(keyword); } // Tags have higher weight
          }
        }
      }

      // Check description
      if (typeof task.description === "string" && task.description) {
        const lowerDesc = task.description.toLowerCase();
        for (const keyword of keywords) {
          if (lowerDesc.includes(keyword.toLowerCase())) {
            { matchCount++; matchedKeywords.add(keyword); }
          }
        }
      }

      // Check goals
      if (typeof task.goals_and_expected_deliverables === "string" && task.goals_and_expected_deliverables) {
        const lowerGoals = task.goals_and_expected_deliverables.toLowerCase();
        for (const keyword of keywords) {
          if (lowerGoals.includes(keyword.toLowerCase())) {
            { matchCount++; matchedKeywords.add(keyword); }
          }
        }
      }

      if (matchedKeywords.size === keywords.length) {
        tasks.set(task.id, { task, matchCount });
      }
    }

    // 2. Search in operations (supports AND logic across fields+ops)
    const allOps = this.db.prepare(
      "SELECT DISTINCT task_id FROM task_operation WHERE 1=1"
    ).all() as any[];

    for (const opRow of allOps) {
      const opSql = `
        SELECT * FROM task_operation
        WHERE task_id = ?
          AND (milestone_title LIKE ? OR milestone_description LIKE ? OR process_description LIKE ?)
        LIMIT 10
      `;

      // Collect which keywords match in operations for this task
      const opMatchedKeywords = new Set<string>();
      for (const keyword of keywords) {
        const pattern = `%${keyword}%`;
        const ops = this.db.prepare(opSql).all(opRow.task_id, pattern, pattern, pattern) as any[];
        if (ops.length > 0) {
          opMatchedKeywords.add(keyword);
        }
      }

      if (opMatchedKeywords.size === 0) continue;

      const taskRow = this.db.prepare("SELECT * FROM task WHERE id = ?").get(opRow.task_id) as any;
      if (!taskRow) continue;
      const task = this.rowToTask(taskRow);
      if (excludeTaskId && task.id === excludeTaskId) continue;
      if (status && task.status !== status) continue;
      if (priority && task.priority !== priority) continue;
      if (type && task.type !== type) continue;
      // 默认排除 archived
      if (!options?.include_archived && task.status === "archived") continue;

      const existing = tasks.get(task.id);
      if (existing) {
        // Task already matched in field search (AND passed) — just boost
        existing.matchCount += 2;
      } else {
        // Task not matched by fields — check if ops + fields satisfy AND
        // Re-check field keywords (cheap enough for ops-matched tasks)
        const combinedKeywords = new Set(opMatchedKeywords);
        if (typeof task.title === "string" && task.title) {
          const lowerTitle = task.title.toLowerCase();
          for (const kw of keywords) {
            if (lowerTitle.includes(kw.toLowerCase())) combinedKeywords.add(kw);
          }
        }
        if (typeof task.description === "string" && task.description) {
          const lowerDesc = task.description.toLowerCase();
          for (const kw of keywords) {
            if (lowerDesc.includes(kw.toLowerCase())) combinedKeywords.add(kw);
          }
        }
        if (
          typeof task.goals_and_expected_deliverables === "string" &&
          task.goals_and_expected_deliverables
        ) {
          const lowerGoals = task.goals_and_expected_deliverables.toLowerCase();
          for (const kw of keywords) {
            if (lowerGoals.includes(kw.toLowerCase())) combinedKeywords.add(kw);
          }
        }
        if (task.tags && Array.isArray(task.tags)) {
          for (const kw of keywords) {
            if (task.tags.some(tag => tag.toLowerCase().includes(kw.toLowerCase()))) combinedKeywords.add(kw);
          }
        }
        // Only include if ALL keywords matched across fields + operations
        if (combinedKeywords.size === keywords.length) {
          tasks.set(task.id, { task, matchCount: 2 });
        }
      }
    }

    // Sort by match count (descending) and paginate
    let sorted = Array.from(tasks.values())
      .sort((a, b) => b.matchCount - a.matchCount);

    // 应用 depth 过滤（如果之前计算了 allowedTaskIds）
    if (allowedTaskIds !== null) {
      sorted = sorted.filter(item => allowedTaskIds!.has(item.task.id));
    }

    const total = sorted.length;
    const sliced = sorted.slice(offset, offset + limit);
    const resultTasks = sliced.map(item => item.task);

    return { tasks: resultTasks, total };
  }

  /**
   * 内部方法：BFS 展开根任务到指定深度，返回所有可达任务 ID 集合
   *
   * - depth === 0：只根任务 ID
   * - depth >= 1：根 + 1..N 层所有后代 ID
   */
  private async collectTaskIdsByDepth(depth: number): Promise<Set<number>> {
    const ids = new Set<number>();
    const rootRows = this.db.prepare(
      "SELECT id FROM task WHERE parent_task_id IS NULL"
    ).all() as any[];
    let currentLevel: number[] = rootRows.map(r => r.id);
    for (const id of currentLevel) ids.add(id);

    if (depth === 0) return ids;

    for (let level = 1; level <= depth; level++) {
      if (currentLevel.length === 0) break;
      const placeholders = currentLevel.map(() => "?").join(",");
      const rows = this.db.prepare(
        `SELECT id FROM task WHERE parent_task_id IN (${placeholders})`
      ).all(...currentLevel) as any[];
      currentLevel = rows.map(r => r.id);
      for (const id of currentLevel) ids.add(id);
    }
    return ids;
  }

  /**
   * Find similar tasks by keywords
   * Excludes the target task and sorts by relevance
   * Default limit is 5 to keep prompt concise
   * 
   * Note: Returns only the tasks array (not {tasks, total}) for backwards
   * compatibility with internal callers (e.g. plugin similar-task injection).
   */
  async findSimilarTasksByKeywords(
    keywords: string[],
    options: { limit?: number; excludeTaskId?: number } = {}
  ): Promise<Task[]> {
    // Default to 5 for similar tasks search to keep prompt concise
    const mergedOptions = { ...options, limit: options.limit ?? 5 };
    const result = await this.searchTasksByKeywords(keywords, mergedOptions);
    return result.tasks;
  }

  // ========================================================================
  // 检索能力（向后兼容）
  // ========================================================================

  async findSimilarTasks(taskId: number, limit: number = 5): Promise<Task[]> {
    await this.initialize();
    
    // 获取当前 Task 的 Tags
    const taskTags = await this.getTagsForTask(taskId);
    if (taskTags.length === 0) {
      return [];
    }
    
    const tagIds = taskTags.map(t => t.id);
    const placeholders = tagIds.map(() => "?").join(", ");
    
    // 查找有相同 Tag 的 Task（排除自己），按匹配数量排序
    const sql = `
      SELECT t.*, COUNT(r2.tag_id) as match_count
      FROM task t
      INNER JOIN task_tag_relation r ON t.id = r.task_id
      INNER JOIN task_tag_relation r2 ON t.id = r2.task_id
      WHERE r.tag_id IN (${placeholders})
        AND t.id != ?
      GROUP BY t.id
      ORDER BY match_count DESC, t.updated_at DESC
      LIMIT ?
    `;
    
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...tagIds, taskId, limit) as any[];
    
    return rows.map(row => this.rowToTask(row));
  }

  async searchTasks(query: string, limit: number = 20): Promise<Task[]> {
    await this.initialize();
    
    const sql = `
      SELECT * FROM task 
      WHERE title LIKE ? OR description LIKE ?
      ORDER BY updated_at DESC
      LIMIT ?
    `;
    
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(`%${query}%`, `%${query}%`, limit) as any[];
    
    return rows.map(row => this.rowToTask(row));
  }

  /**
   * Task #4230 follow-up：按 context 值反查 task（LIKE 粗筛）
   *
   * 用途：已知一个飞书 chatId，反查"哪些 task 把这个群写进了自己的 context"
   * （用于判定"这个群是不是某个 task 的专属群"）。精确的字段名 / 语义判断
   * 交给调用方（card-chat-routing），这里只做粗筛。
   *
   * @param value 目标值（通常是一个 chatId）
   * @param limit 最多返回条数（默认 50）
   */
  async findTasksByContextValue(value: string, limit: number = 50): Promise<Task[]> {
    await this.initialize();
    if (!value) return [];
    const sql = `
      SELECT * FROM task
      WHERE context LIKE ?
      ORDER BY updated_at DESC
      LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(`%${value}%`, limit) as any[];
    return rows.map((row) => this.rowToTask(row));
  }

  // ========================================================================
  // 私有方法
  // ========================================================================

  private rowToTag(row: any): TaskTag {
    return {
      id: row.id,
      name: row.name,
      createdAt: new Date(row.created_at).toISOString(),
      taskCount: row.task_count,
    };
  }

  private async syncTaskTagsJson(taskId: number): Promise<void> {
    const tags = await this.getTagsForTask(taskId);
    const tagNames = tags.map(t => t.name);
    
    const stmt = this.db.prepare("UPDATE task SET tags = ? WHERE id = ?");
    stmt.run(tagNames.length > 0 ? JSON.stringify(tagNames) : null, taskId);
    
    // 清除缓存
    this.tasksCache.delete(taskId);
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initialized = false;
    }
    // 清理内存缓存，防止内存泄漏
    this.tasksCache.clear();
    this.operationsCache.clear();
  }
}

// 导出默认路径
export { getDefaultTaskDbPath, getDefaultDataDir };
