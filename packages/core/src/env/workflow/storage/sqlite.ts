/**
 * @fileoverview SQLite Storage for Workflow Component
 * 
 * 根据运行环境自动选择 SQLite 实现：
 * - Bun 运行时：使用 bun:sqlite
 * - Node.js/Electron：使用 better-sqlite3
 * 
 * 存储路径：~/.local/share/roy-bot/workflows.db
 * 
 * Note: After session-based refactoring, workflow runs are managed via SessionComponent.
 * Only the workflows table is used here for storing workflow definitions.
 */

import { join } from "path";
import { createLogger } from "../../log-trace/logger";
import { TagRepository } from "./tag-repo";
import { migrateEmptyTagsToDefault } from "./workflow-repo";

const logger = createLogger("workflow:sqlite");

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
 * ⚠️ Task #5592 CV 返工：`node:sqlite` 优先于 `better-sqlite3`
 * （#4619 只改了 task 侧，workflow 侧漏掉；better-sqlite3 已移入
 * optionalDependencies，全新 Node 环境无编译产物时必须走 node:sqlite）。
 */
function getDatabaseClass(): new (path: string) => any {
  // @ts-ignore - Bun global
  if (typeof Bun !== 'undefined') {
    // Bun 运行时使用 bun:sqlite
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require("bun:sqlite");
    return Database;
  }

  // Task #5592: 纯 node 优先用内置的 node:sqlite（无原生依赖）。
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite");
    if (typeof DatabaseSync === "function") {
      return DatabaseSync;
    }
  } catch {
    // node < 22.5 没有 node:sqlite —— 落到 better-sqlite3。
  }

  // 旧版 Node.js/Electron 使用 better-sqlite3
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
function createCompatibleDatabase(path: string): any {
  const Database = getDatabaseClass();
  const db = new Database(path);
  
  // 如果 better-sqlite3，添加 run() 兼容方法
  if (typeof db.run !== 'function') {
    db.run = function(sql: string, ...params: any[]) {
      if (params.length > 0) {
        return this.prepare(sql).run(...params);
      } else {
        return this.exec(sql);
      }
    };
  }
  
  return db;
}

// ============================================================================
// Database Path
// ============================================================================

/**
 * Get default data directory
 */
function getDefaultDataDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  return join(home, ".local", "share", "roy-bot");
}

/**
 * Get the database file path
 * Default: ~/.local/share/roy-bot/workflows.db
 */
export function getDatabasePath(): string {
  return join(getDefaultDataDir(), "workflows.db");
}

// ============================================================================
// Database Singleton
// ============================================================================

let dbInstance: any = null;

/**
 * Get the singleton database instance
 * @param path - Optional custom database path. If not provided, uses default path.
 *               Use ':memory:' for in-memory database (testing)
 */
export function getDatabase(path?: string): any {
  if (!dbInstance) {
    const dbPath = path ?? getDatabasePath();
    
    // 确保目录存在
    const dbDir = dbPath.substring(0, dbPath.lastIndexOf('/'));
    if (dbDir && dbDir !== '/') {
      try {
        const { mkdirSync } = require("fs");
        mkdirSync(dbDir, { recursive: true });
      } catch {
        // 目录可能已存在，忽略错误
      }
    }
    
    // 使用运行时检测获取兼容的 SQLite 实现
    // 确保 bun:sqlite 和 better-sqlite3 都有 run() 方法
    dbInstance = createCompatibleDatabase(dbPath);
    
    // Enable WAL mode for better performance (if available)
    // Some SQLite implementations may not have pragma method
    try {
      if (typeof dbInstance.pragma === 'function') {
        dbInstance.pragma("journal_mode = WAL");
      }
    } catch {
      // pragma is optional, continue without it
      logger?.debug("WAL mode not available, using default journal mode");
    }
  }
  return dbInstance;
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

// Re-export Database type for Bun
// Note: bun:sqlite types may not be available in all environments
// Use dynamic import at runtime and cast as needed
export type BunDatabase = {
  exec(sql: string): void;
  query<T>(sql: string): { all(): T[]; get(...params: any[]): T | null };
  run(sql: string, ...params: any[]): { lastInsertRowid: number; changes: number };
  close(): void;
  pragma?: (sql: string) => void;
};

// ============================================================================
// Table Initialization
// ============================================================================

/**
 * Initialize all required tables
 * 
 * Note: Only workflows table is created. Workflow runs are managed via SessionComponent
 * using the session/message storage, following the session-based design.
 */
export function initializeTables(): void {
  const db = getDatabase();
  
  // Create workflows table for storing workflow definitions
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      version TEXT NOT NULL DEFAULT '1.0',
      description TEXT,
      definition TEXT NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',
      metadata TEXT NOT NULL DEFAULT '{}',
      tags TEXT NOT NULL DEFAULT '[]',
      task_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  
  // Create indexes for better query performance
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflows_name ON workflows(name);
    CREATE INDEX IF NOT EXISTS idx_workflows_tags ON workflows(tags);
    CREATE INDEX IF NOT EXISTS idx_workflows_task_id ON workflows(task_id);
  `);

  // v2: create workflow_tags table for usage_count tracking (idempotent)
  TagRepository.createTable(db);

  // v2: migrate legacy empty/missing tags to ["default"] (idempotent)
  const migrated = migrateEmptyTagsToDefault(db);
  if (migrated > 0) {
    logger?.info?.(
      `[workflow:sqlite] Auto-migrated ${migrated} workflow(s) to default tag`
    );
  }

  // v2: ensure 'default' tag row in workflow_tags has correct count
  const countRow = db
    .prepare(
      "SELECT COUNT(*) as c FROM workflows WHERE tags LIKE ?"
    )
    .get('%"default"%') as { c: number };
  const expectedDefaultCount = countRow.c;
  if (expectedDefaultCount > 0) {
    const tagRepo = new TagRepository(db);
    const existing = tagRepo.get("default");
    const now = new Date().toISOString();
    if (!existing) {
      db.prepare(
        `INSERT INTO workflow_tags (name, usage_count, created_at, updated_at)
         VALUES ('default', ?, ?, ?)`
      ).run(expectedDefaultCount, now, now);
    } else if (existing.usage_count !== expectedDefaultCount) {
      db.prepare(
        "UPDATE workflow_tags SET usage_count = ?, updated_at = ? WHERE name = ?"
      ).run(expectedDefaultCount, now, "default");
    }
  }
}

// ============================================================================
// Re-initialize (for testing)
// ============================================================================

/**
 * Reset the database instance (for testing purposes)
 * This is useful for tests that need a fresh database
 */
export function resetDatabase(): void {
  closeDatabase();
  dbInstance = null;
}

/**
 * Initialize tables and return a ready database
 * This is a convenience function that combines getDatabase and initializeTables
 */
export function initDatabase(path?: string): any {
  const db = getDatabase(path);
  initializeTables();
  return db;
}
