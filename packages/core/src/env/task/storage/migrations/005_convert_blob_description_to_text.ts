/**
 * @fileoverview Task Migration 005: Convert BLOB description to TEXT
 *
 * Migration ID: 005_convert_blob_description_to_text
 * Description: Some tasks (notably Task #2084 with 15619-byte markdown
 *              description) had their `description` column stored as BLOB
 *              instead of TEXT. SQLite type affinity rules allow this when
 *              an INSERT/UPDATE uses a BLOB literal. The result is that
 *              better-sqlite3 / bun:sqlite return a Buffer object (truthy,
 *              no toLowerCase) instead of a string, crashing
 *              searchTasksByKeywords at line 1082.
 *
 *              The rowToTask defensive String() coercion (Task #2226) is
 *              the load-bearing fix. This migration is a data-hygiene pass
 *              that converts any existing BLOB descriptions to TEXT in
 *              place so the column's declared type matches the storage
 *              class on every row.
 *
 * Data preservation:
 * - CAST(description AS TEXT) decodes the bytes as UTF-8 and stores
 *   the result back into the same column. The column's type affinity
 *   (TEXT) is then respected for the new value.
 * - Original content is preserved (the Buffer payload was the same UTF-8
 *   bytes that a TEXT column would have stored).
 *
 * Idempotent:
 * - WHERE typeof(description) = 'blob' gates the update; re-running the
 *   migration on an already-migrated DB is a no-op.
 *
 * Date: 2026-07-21
 */

import { createCompatibleDatabase } from "../sqlite-task-store";
import { logMigration } from "./log-migration";

/**
 * Run migration 005 on the given database file.
 *
 * Algorithm:
 *  1. Open DB.
 *  2. Verify the `task` table exists (fresh DBs may not have it yet).
 *  3. Count rows where typeof(description) = 'blob' (BLOB-stored values).
 *  4. If count > 0, run UPDATE task SET description = CAST(description AS TEXT)
 *     WHERE typeof(description) = 'blob'.
 *  5. Close DB.
 *
 * @param dbPath SQLite database file path
 * @returns Migration result: { blobCountBefore, blobCountAfter, ran }
 */
export interface Migration005Result {
  blobCountBefore: number;
  blobCountAfter: number;
  ran: boolean;
}

export function runMigration(dbPath: string): Migration005Result {
  logMigration(`[Migration 005] Starting migration for: ${dbPath}`);

  const db = createCompatibleDatabase(dbPath);
  const result: Migration005Result = {
    blobCountBefore: 0,
    blobCountAfter: 0,
    ran: false,
  };

  try {
    // Check task table exists
    const tableCheck = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='task'",
      )
      .all() as Array<{ name: string }>;
    if (tableCheck.length === 0) {
      logMigration(`[Migration 005] task table does not exist, skipping`);
      return result;
    }

    // Count BLOB descriptions before
    const beforeRows = db
      .query(
        "SELECT COUNT(*) as cnt FROM task WHERE typeof(description) = 'blob'",
      )
      .all() as Array<{ cnt: number }>;
    result.blobCountBefore = beforeRows[0]?.cnt ?? 0;

    if (result.blobCountBefore === 0) {
      logMigration(`[Migration 005] No BLOB descriptions found, no action needed`);
      return result;
    }

    // Convert BLOB → TEXT in place
    db.run(
      "UPDATE task SET description = CAST(description AS TEXT) WHERE typeof(description) = 'blob'",
    );
    result.ran = true;

    // Verify
    const afterRows = db
      .query(
        "SELECT COUNT(*) as cnt FROM task WHERE typeof(description) = 'blob'",
      )
      .all() as Array<{ cnt: number }>;
    result.blobCountAfter = afterRows[0]?.cnt ?? 0;

    logMigration(
      `[Migration 005] Converted ${result.blobCountBefore - result.blobCountAfter} BLOB description(s) to TEXT`,
    );
    logMigration(`[Migration 005] Migration completed successfully`);
  } finally {
    db.close();
  }

  return result;
}

// CLI runner for manual execution
if (require.main === module) {
  const dbPath = process.argv[2];
  if (!dbPath) {
    console.error("Usage: bun run 005_convert_blob_description_to_text.ts <db-path>");
    process.exit(1);
  }
  const result = runMigration(dbPath);
  logMigration("[Migration 005] Result:", JSON.stringify(result, null, 2));
}
