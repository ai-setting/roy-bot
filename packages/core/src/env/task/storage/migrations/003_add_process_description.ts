/**
 * @fileoverview Task Migration: Add process_description column to task_operation
 *
 * Migration ID: 003_add_process_description
 * Description: Add process_description column to task_operation table.
 *              用于记录达成节点状态所采用的策略 + 工具步骤的过程概要，
 *              区别于 action_description（状态/结果描述）。
 *              字符范围 100-500（Task #4764 放宽；应用层 schema 校验，本字段不做 DB 长度约束）。
 * Date: 2026-07-20
 */

import { createCompatibleDatabase } from "../sqlite-task-store";
import { logMigration } from "./log-migration";

/**
 * Run migration to add process_description column.
 *
 * Idempotent: 重复执行安全。
 * - 已存在 process_description 列：跳过 ALTER
 * - 不存在：添加 TEXT NOT NULL DEFAULT ''
 *
 * 默认值空字符串且禁止 NULL（与应用层 rowToOperation 的空字符串语义一致）。
 */
export function runMigration(dbPath: string): void {
  logMigration(`[Migration 003] Starting migration for: ${dbPath}`);

  const db = createCompatibleDatabase(dbPath);

  try {
    try {
      db.run(`ALTER TABLE task_operation ADD COLUMN process_description TEXT NOT NULL DEFAULT ''`);
      logMigration(`[Migration 003] Added process_description column`);
    } catch (e: any) {
      if (e.message?.includes("duplicate column name")) {
        logMigration(`[Migration 003] process_description column already exists, skipping`);
      } else {
        throw e;
      }
    }

    logMigration(`[Migration 003] Migration completed successfully`);
  } finally {
    db.close();
  }
}

// CLI runner for manual execution
if (require.main === module) {
  const dbPath = process.argv[2];
  if (!dbPath) {
    console.error("Usage: bun run 003_add_process_description.ts <db-path>");
    process.exit(1);
  }
  runMigration(dbPath);
}
