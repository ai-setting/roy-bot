/**
 * @fileoverview Migration 003 tests: task_operation.process_description
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigration } from "./003_add_process_description";

const cleanupPaths: string[] = [];

function createLegacyDatabase(): string {
  const path = join(
    tmpdir(),
    `migration-003-process-description-${process.pid}-${Date.now()}-${Math.random()}.db`
  );
  cleanupPaths.push(path, `${path}-shm`, `${path}-wal`);

  const db = new Database(path);
  db.run(`
    CREATE TABLE task (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE task_operation (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      action_title TEXT NOT NULL,
      action_description TEXT DEFAULT '',
      timestamp INTEGER NOT NULL,
      md_path TEXT
    )
  `);
  db.close();

  return path;
}

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    if (existsSync(path)) unlinkSync(path);
  }
});

describe("Migration 003: add process_description", () => {
  it("adds a NOT NULL TEXT column with empty-string default to a legacy database", () => {
    const path = createLegacyDatabase();

    runMigration(path);

    const db = new Database(path);
    const columns = db.query("PRAGMA table_info(task_operation)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const column = columns.find((item) => item.name === "process_description");

    expect(column).toBeDefined();
    expect(column?.type).toBe("TEXT");
    expect(column?.notnull).toBe(1);
    expect(column?.dflt_value).toBe("''");
    db.close();
  });

  it("is idempotent and legacy inserts receive the empty-string default", () => {
    const path = createLegacyDatabase();

    runMigration(path);
    expect(() => runMigration(path)).not.toThrow();

    const db = new Database(path);
    db.run(
      `INSERT INTO task_operation
        (task_id, session_id, action_type, action_title, action_description, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [1, "sess", "progress", "Legacy insert", "state", Date.now()]
    );
    const row = db
      .query("SELECT process_description FROM task_operation LIMIT 1")
      .get() as { process_description: string };

    expect(row.process_description).toBe("");
    db.close();
  });
});
