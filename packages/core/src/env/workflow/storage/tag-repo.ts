/**
 * @fileoverview TagRepository
 *
 * Owns the `workflow_tags` table:
 *   - name TEXT PRIMARY KEY
 *   - usage_count INTEGER NOT NULL DEFAULT 0
 *   - created_at TEXT NOT NULL
 *   - updated_at TEXT NOT NULL
 *
 * - `upsertMany(names)` inserts new tags (with count=1) or increments existing ones by 1
 * - `decrementMany(names)` clamps usage_count at 0 (rows are NOT deleted)
 * - `list()` returns tags sorted by usage_count DESC, name ASC
 * - `get(name)` returns single tag info or undefined
 *
 * Concurrency: All write methods use prepared statements. Callers may wrap
 * multiple operations in an outer `db.transaction(...)` to make them atomic.
 */

import { TracedAs } from "../../log-trace/decorator";

export interface TagInfo {
  name: string;
  usage_count: number;
  created_at: string;
  updated_at: string;
}

/**
 * v3: Extended list options for TagRepository.list().
 *
 * - `sortBy`: "usage_count" (default), "name", or "created_at"
 * - `order`:  "desc" (default) or "asc"
 * - `limit`:  optional cap on number of rows returned
 */
export interface ListTagsOptions {
  sortBy?: "usage_count" | "name" | "created_at";
  order?: "asc" | "desc";
  limit?: number;
}

export class TagRepository {
  private db: any;

  constructor(db: any) {
    this.db = db;
  }

  /**
   * Static helper to create the workflow_tags table (and its usage index).
   * Safe to call multiple times (idempotent).
   */
  static createTable(db: any): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_tags (
        name TEXT PRIMARY KEY,
        usage_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_workflow_tags_usage
        ON workflow_tags(usage_count DESC);
    `);
  }

  /**
   * Insert new tags with count=1, or increment existing tags by 1.
   * Empty input is a no-op.
   */
  @TracedAs("workflow.tag_repo.upsertMany", {
    recordParams: true,
    recordResult: false,
    log: false,
  })
  upsertMany(names: string[]): void {
    if (!names || names.length === 0) return;

    const insertStmt = this.db.prepare(`
      INSERT INTO workflow_tags (name, usage_count, created_at, updated_at)
      VALUES (?, 1, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        usage_count = usage_count + 1,
        updated_at = excluded.updated_at
    `);

    const now = new Date().toISOString();
    for (const name of names) {
      const trimmed = (name ?? "").trim();
      if (!trimmed) continue; // skip empty/whitespace
      insertStmt.run(trimmed, now, now);
    }
  }

  /**
   * Decrement usage_count for each given tag by 1, clamped at 0.
   * Rows are NEVER deleted (preserve history).
   * Non-existent tags are silently ignored.
   */
  @TracedAs("workflow.tag_repo.decrementMany", {
    recordParams: true,
    recordResult: false,
    log: false,
  })
  decrementMany(names: string[]): void {
    if (!names || names.length === 0) return;

    const updateStmt = this.db.prepare(`
      UPDATE workflow_tags
         SET usage_count = MAX(0, usage_count - 1),
             updated_at = ?
       WHERE name = ?
    `);

    const now = new Date().toISOString();
    for (const name of names) {
      const trimmed = (name ?? "").trim();
      if (!trimmed) continue;
      updateStmt.run(now, trimmed);
    }
  }

  /**
   * List all tags with v3 sort/limit options.
   *
   * Default: usage_count DESC, name ASC (backward compatible).
   */
  @TracedAs("workflow.tag_repo.list", {
    recordParams: true,
    recordResult: true,
    log: false,
  })
  list(options: ListTagsOptions = {}): TagInfo[] {
    const sortBy = options.sortBy ?? "usage_count";
    const order = (options.order ?? "desc").toUpperCase();
    const limit = options.limit ?? undefined;

    // Map sortBy to a safe column name (SQL column whitelist prevents injection)
    let sortColumn: string;
    switch (sortBy) {
      case "name":
        sortColumn = "name";
        break;
      case "created_at":
        sortColumn = "created_at";
        break;
      case "usage_count":
      default:
        sortColumn = "usage_count";
        break;
    }

    // Always add a tiebreaker on name ASC for deterministic ordering
    let sql = `SELECT name, usage_count, created_at, updated_at
                 FROM workflow_tags
                ORDER BY ${sortColumn} ${order}, name ASC`;
    if (typeof limit === "number" && limit > 0) {
      sql += ` LIMIT ${Math.floor(limit)}`;
    }

    const rows = this.db
      .prepare(sql)
      .all() as Array<{
        name: string;
        usage_count: number;
        created_at: string;
        updated_at: string;
      }>;

    return rows.map((r) => ({
      name: r.name,
      usage_count: r.usage_count,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
  }

  /**
   * Get a single tag by name (returns undefined if not found).
   */
  get(name: string): TagInfo | undefined {
    const row = this.db
      .prepare(
        `SELECT name, usage_count, created_at, updated_at
           FROM workflow_tags
          WHERE name = ?`
      )
      .get(name) as
      | { name: string; usage_count: number; created_at: string; updated_at: string }
      | undefined;
    if (!row) return undefined;
    return {
      name: row.name,
      usage_count: row.usage_count,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
