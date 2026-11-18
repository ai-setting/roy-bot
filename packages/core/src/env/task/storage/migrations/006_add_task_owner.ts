/**
 * @fileoverview Task Migration 006: Add owner column
 *
 * Migration ID: 006_add_task_owner
 * Description: 给 task 表加 `owner` 列（负责人，可空）。
 *              Task #5440 —— roy-bot 接入 task-service 时，service 后端
 *              （Task #5443）已扩展 owner 字段，core 侧必须同源，
 *              否则 remote 模式的 owner 写不进去、读不回来。
 *
 * 语义：
 * - `owner TEXT`（NULL 表示未指派）—— 刻意**不**加 NOT NULL DEFAULT ''，
 *   因为「未指派」与「指派给空字符串」在业务上是两件事，null 更准确。
 * - 加索引 `idx_task_owner`（按负责人筛任务是主要用法）。
 *
 * 幂等：重复执行安全（列已存在则跳过）。
 *
 * Date: 2026-11-13
 */

import { createCompatibleDatabase } from "../sqlite-task-store";
import { logMigration } from "./log-migration";

/**
 * Run migration 006 on the given database file.
 *
 * @param dbPath SQLite database file path
 */
export function runMigration(dbPath: string): void {
  logMigration(`[Migration 006] Starting migration for: ${dbPath}`);

  const db = createCompatibleDatabase(dbPath);

  try {
    // 1. 幂等加列
    try {
      db.run(`ALTER TABLE task ADD COLUMN owner TEXT`);
      logMigration(`[Migration 006] Added owner column`);
    } catch (e: any) {
      if (e.message?.includes("duplicate column name")) {
        logMigration(`[Migration 006] owner column already exists, skipping`);
      } else {
        throw e;
      }
    }

    // 2. 索引（IF NOT EXISTS 本身幂等）
    db.run(`CREATE INDEX IF NOT EXISTS idx_task_owner ON task(owner)`);

    logMigration(`[Migration 006] Migration completed successfully`);
  } finally {
    db.close();
  }
}

// CLI runner for manual execution
if (require.main === module) {
  const dbPath = process.argv[2];
  if (!dbPath) {
    console.error("Usage: bun run 006_add_task_owner.ts <db-path>");
    process.exit(1);
  }
  runMigration(dbPath);
}
