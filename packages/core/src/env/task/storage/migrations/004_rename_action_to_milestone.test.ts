/**
 * @fileoverview RED: Migration 004 renames task_operation action_* columns to milestone_*
 *
 * 设计目标：
 * - 把 action_type/action_title/action_description 列重命名为 milestone 类型三字段
 * - 保留所有历史数据（ALTER TABLE RENAME COLUMN 自带数据保留）
 * - 幂等：重复运行不报错
 * - 兼容：迁移前已有列不存在时不报错
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigration } from "./004_rename_action_to_milestone";

const cleanupPaths: string[] = [];

function createLegacyDatabase(): string {
  const path = join(
    tmpdir(),
    `migration-004-milestone-${process.pid}-${Date.now()}-${Math.random()}.db`
  );
  cleanupPaths.push(path, `${path}-shm`, `${path}-wal`);

  const db = new Database(path);
  db.run(`
    CREATE TABLE task (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL
    )
  `);
  // 还原 task_operation 的 v1 schema（仅含 action_*，无 process_description 也无 milestone_*）
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

function createMilestoneDatabase(): string {
  // 已迁移库：列已是 milestone_*
  const path = join(
    tmpdir(),
    `migration-004-milestone-already-${process.pid}-${Date.now()}-${Math.random()}.db`
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
      milestone_type TEXT NOT NULL,
      milestone_title TEXT NOT NULL,
      milestone_description TEXT DEFAULT '',
      process_description TEXT NOT NULL DEFAULT '',
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

describe("Migration 004: rename action_* columns to milestone_*", () => {
  it("renames action_type/action_title/action_description to milestone_* on a legacy database", () => {
    const path = createLegacyDatabase();

    runMigration(path);

    const db = new Database(path);
    const columns = db.query("PRAGMA table_info(task_operation)").all() as Array<{
      name: string;
    }>;
    const colNames = columns.map((c) => c.name);

    expect(colNames).toContain("milestone_type");
    expect(colNames).toContain("milestone_title");
    expect(colNames).toContain("milestone_description");
    // action_* 应已被重命名（不存在）
    expect(colNames).not.toContain("action_type");
    expect(colNames).not.toContain("action_title");
    expect(colNames).not.toContain("action_description");
    db.close();
  });

  it("preserves legacy data when renaming columns", () => {
    const path = createLegacyDatabase();

    // 先写入一条历史 operation
    const seedDb = new Database(path);
    seedDb.run(
      `INSERT INTO task_operation
        (task_id, session_id, action_type, action_title, action_description, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [1, "sess-legacy", "progress", "Old progress title", "Old progress desc", Date.now()]
    );
    seedDb.close();

    runMigration(path);

    const db = new Database(path);
    const row = db
      .query(
        "SELECT milestone_type, milestone_title, milestone_description FROM task_operation LIMIT 1"
      )
      .get() as {
      milestone_type: string;
      milestone_title: string;
      milestone_description: string;
    };

    expect(row.milestone_type).toBe("progress");
    expect(row.milestone_title).toBe("Old progress title");
    expect(row.milestone_description).toBe("Old progress desc");
    db.close();
  });

  it("is idempotent when milestone_* columns already exist", () => {
    const path = createMilestoneDatabase();

    // 不应抛错
    expect(() => runMigration(path)).not.toThrow();

    // 再跑一次也应不抛错
    expect(() => runMigration(path)).not.toThrow();

    const db = new Database(path);
    const columns = db.query("PRAGMA table_info(task_operation)").all() as Array<{
      name: string;
    }>;
    const colNames = columns.map((c) => c.name);

    // milestone_* 仍在
    expect(colNames).toContain("milestone_type");
    expect(colNames).toContain("milestone_title");
    expect(colNames).toContain("milestone_description");
    db.close();
  });
});
