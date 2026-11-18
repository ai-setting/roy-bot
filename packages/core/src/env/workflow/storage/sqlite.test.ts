import { describe, it, expect } from 'bun:test';
import { TagRepository } from './tag-repo';
import { migrateEmptyTagsToDefault } from './workflow-repo';

/**
 * SQLite Storage Tests
 * 
 * 根据运行环境自动选择 SQLite 实现：
 * - Bun 运行时：使用 bun:sqlite
 * - Node.js/Electron：使用 better-sqlite3
 * 
 * Note: After session-based refactoring, workflow runs are managed via SessionComponent.
 * Only the workflows table tests are relevant here.
 */

// ============================================================================
// SQLite Runtime Detection
// ============================================================================

function getDatabaseClass(): new (path: string) => any {
  // @ts-ignore - Bun global
  if (typeof Bun !== 'undefined') {
    // Bun 运行时使用 bun:sqlite
    const { Database } = require("bun:sqlite");
    return Database;
  } else {
    // Node.js/Electron 使用 better-sqlite3
    return require("better-sqlite3");
  }
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

describe('SQLite Storage', () => {
  // Helper to get in-memory database
  function createTestDatabase() {
    return createCompatibleDatabase(":memory:");
  }

  describe('getDatabase', () => {
    it('should return a Database instance', () => {
      const db = createTestDatabase();
      expect(db).toBeDefined();
      expect(typeof db.exec).toBe('function');
      expect(typeof db.prepare).toBe('function');
      db.close();
    });

    it('should support basic SQL execution', () => {
      const db = createTestDatabase();
      db.exec("CREATE TABLE test (id TEXT PRIMARY KEY, name TEXT)");
      
      const stmt = db.prepare("INSERT INTO test (id, name) VALUES (?, ?)");
      stmt.run("1", "test");
      
      const result = db.prepare("SELECT * FROM test").all();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("test");
      
      db.close();
    });
  });

  describe('initializeTables', () => {
    it('should create workflows table', () => {
      const db = createTestDatabase();
      
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
      
      // Verify table exists
      const tableInfo = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workflows'").get();
      expect(tableInfo).toBeDefined();
      
      db.close();
    });

    it('should create indexes', () => {
      const db = createTestDatabase();
      
      // Create workflows table first
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
      
      // Create indexes
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_workflows_name ON workflows(name);
        CREATE INDEX IF NOT EXISTS idx_workflows_tags ON workflows(tags);
        CREATE INDEX IF NOT EXISTS idx_workflows_task_id ON workflows(task_id);
      `);
      
      // Verify indexes exist
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all();
      const indexNames = indexes.map((idx: any) => idx.name);
      expect(indexNames).toContain("idx_workflows_name");
      expect(indexNames).toContain("idx_workflows_tags");
      expect(indexNames).toContain("idx_workflows_task_id");
      
      db.close();
    });
  });

  describe('getDatabasePath', () => {
    it('should return default database path', () => {
      const { getDatabasePath } = require("./sqlite");
      const path = getDatabasePath();
      expect(path).toBeDefined();
      expect(path).toContain("workflows.db");
    });
  });

  describe('closeDatabase', () => {
    it('should close database without error', () => {
      const db = createTestDatabase();
      expect(() => db.close()).not.toThrow();
    });
  });

  describe('integration: workflow table operations', () => {
    it('should perform CRUD operations on workflows table', () => {
      const db = createTestDatabase();
      
      // Create workflows table
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
      
      // Insert a workflow
      const now = new Date().toISOString();
      const workflowDef = JSON.stringify({ name: "Test", nodes: [] });
      
      db.prepare(`
        INSERT INTO workflows (id, name, version, description, definition, config, metadata, tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("wf-1", "TestWorkflow", "1.0", "A test workflow", workflowDef, "{}", "{}", "[]", now, now);
      
      // Verify data
      const workflow = db.prepare("SELECT * FROM workflows WHERE id = ?").get("wf-1");
      expect(workflow).toBeDefined();
      expect(workflow.name).toBe("TestWorkflow");
      expect(workflow.description).toBe("A test workflow");
      
      // Update workflow
      db.prepare(`
        UPDATE workflows SET description = ?, updated_at = ? WHERE id = ?
      `).run("Updated description", now, "wf-1");
      
      const updatedWorkflow = db.prepare("SELECT * FROM workflows WHERE id = ?").get("wf-1");
      expect(updatedWorkflow.description).toBe("Updated description");
      
      // Delete workflow
      db.prepare("DELETE FROM workflows WHERE id = ?").run("wf-1");
      
      const deletedWorkflow = db.prepare("SELECT * FROM workflows WHERE id = ?").get("wf-1");
      // SQLite's .get() returns null when no rows found
      expect(deletedWorkflow).toBeNull();
      
      db.close();
    });
  });
});

// ============================================================================
// Migration: v2 initializeTables (workflow_tags + empty tags → default)
// ============================================================================


/**
 * Local helper: initializeTables is normally private to the module (it operates
 * on the module-level dbInstance). For migration testing we accept an explicit
 * db handle. We re-export the table creation/migration by calling
 * `TagRepository.createTable` + `migrateEmptyTagsToDefault` directly.
 */
function initializeTablesOn(db: any): void {
  // Mirror what initializeTables does for the v2 part:
  TagRepository.createTable(db);
  const migrated = migrateEmptyTagsToDefault(db);
  if (migrated > 0) {
    // No-op in test (logger not needed)
  }
  const countRow = db
    .prepare("SELECT COUNT(*) as c FROM workflows WHERE tags LIKE ?")
    .get('%"default"%') as { c: number };
  if (countRow.c > 0) {
    const tagRepo = new TagRepository(db);
    const existing = tagRepo.get('default');
    const now = new Date().toISOString();
    if (!existing) {
      db.prepare(`
        INSERT INTO workflow_tags (name, usage_count, created_at, updated_at)
        VALUES ('default', ?, ?, ?)
      `).run(countRow.c, now, now);
    } else if (existing.usage_count !== countRow.c) {
      db.prepare(
        "UPDATE workflow_tags SET usage_count = ?, updated_at = ? WHERE name = 'default'"
      ).run(countRow.c, now);
    }
  }
}

describe('SQLite Storage v2 migration (workflow_tags + empty tags → default)', () => {
  /**
   * Helper: build a fresh in-memory DB, pre-populate workflows with raw rows
   * (mimicking a v1-era database), then call initializeTablesOn() and observe.
   */
  function buildV1Db(rows: Array<{ id: string; tags: string }>): any {
    // v1 schema (no workflow_tags table)
    const v1 = createCompatibleDatabase(":memory:");
    v1.exec(`
      CREATE TABLE workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL DEFAULT '1.0',
        description TEXT,
        definition TEXT NOT NULL,
        config TEXT NOT NULL DEFAULT '{}',
        metadata TEXT NOT NULL DEFAULT '{}',
        tags TEXT NOT NULL DEFAULT '[]',
        task_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    v1.exec(`CREATE INDEX idx_workflows_name ON workflows(name);`);

    const now = '2026-01-01T00:00:00.000Z';
    for (const r of rows) {
      v1.prepare(`
        INSERT INTO workflows
          (id, name, version, description, definition, config, metadata, tags, task_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        r.id,
        `wf-${r.id}`,
        '1.0',
        null,
        '{}',
        '{}',
        '{}',
        r.tags,
        null,
        now,
        now
      );
    }
    return v1;
  }

  it('Test 2: workflow_tags gets "default" with usage_count = N after init', () => {
    // Build a v1 DB with 4 rows that have empty tags
    const db = buildV1Db([
      { id: 'm-1', tags: '[]' },
      { id: 'm-2', tags: '[]' },
      { id: 'm-3', tags: '' },
      { id: 'm-4', tags: '[]' },
    ]);

    // Run v2 initialization (creates workflow_tags + migrates + syncs default)
    initializeTablesOn(db);

    // Assert: workflow_tags table exists
    const tableExists = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_tags'"
      )
      .get();
    expect(tableExists).toBeDefined();

    // Assert: 'default' tag row exists with usage_count = 4
    const defaultTag = db
      .prepare('SELECT * FROM workflow_tags WHERE name = ?')
      .get('default') as { name: string; usage_count: number } | undefined;
    expect(defaultTag).toBeDefined();
    expect(defaultTag!.name).toBe('default');
    expect(defaultTag!.usage_count).toBe(4);

    // Assert: all 4 rows have tags = '["default"]'
    const rows = db
      .prepare("SELECT id, tags FROM workflows WHERE tags LIKE '%\"default\"%'")
      .all() as Array<{ id: string; tags: string }>;
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.tags).toBe('["default"]');
    }

    db.close();
  });

  it('Test 2b: initializeTables is idempotent — re-running does not double-count', () => {
    // Build a v1 DB with 2 empty rows
    const db = buildV1Db([
      { id: 'i-1', tags: '[]' },
      { id: 'i-2', tags: '[]' },
    ]);

    // First init: migrates and seeds default tag with count=2
    initializeTablesOn(db);
    const firstDefault = db
      .prepare('SELECT * FROM workflow_tags WHERE name = ?')
      .get('default') as { name: string; usage_count: number };
    expect(firstDefault.usage_count).toBe(2);

    // Second init: should NOT bump usage_count to 4
    initializeTablesOn(db);
    const secondDefault = db
      .prepare('SELECT * FROM workflow_tags WHERE name = ?')
      .get('default') as { name: string; usage_count: number };
    expect(secondDefault.usage_count).toBe(2);

    db.close();
  });
});
