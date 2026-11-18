/**
 * @fileoverview Task Migration 004: Rename action_* columns to milestone_*
 *
 * Migration ID: 004_rename_action_to_milestone
 * Description: Rename task_operation.action_type/action_title/action_description
 *              to milestone_type/milestone_title/milestone_description.
 *              这是 task_operation 状态语义重构的核心 schema 迁移。
 *              ActionTypeEnum 包含 create/progress/milestone/problem/solution/
 *              decision/review/completed，本身就是里程碑类型枚举；
 *              action_* 命名偏"动作/行为层"，不能准确表达"这一刻达到的
 *              里程碑/状态"。新命名 milestone_* 与 process_description（过程维度）
 *              形成清晰的"状态/里程碑 + 过程"双维度分工。
 *
 * 数据保留：
 * - SQLite ALTER TABLE RENAME COLUMN 自带数据保留
 * - 迁移完成后原有 action_* 列内容自动落到 milestone_* 列
 *
 * 兼容：
 * - task_operation 行旧字段 action_* 不可再读（已重命名）
 * - 旧 API 调用方仍能通过 rowToOperation 同时拿到 milestone_* + action_* (deprecated alias)
 *
 * Date: 2026-07-21
 */

import { createCompatibleDatabase } from "../sqlite-task-store";
import { logMigration } from "./log-migration";

/**
 * Column rename map.
 *
 * 保留 key（db 列名旧值）和 value（新值）。
 */
const RENAME_MAP: Array<{ oldName: string; newName: string }> = [
  { oldName: "action_type", newName: "milestone_type" },
  { oldName: "action_title", newName: "milestone_title" },
  { oldName: "action_description", newName: "milestone_description" },
];

/**
 * Run migration 004 on the given database file.
 *
 * Idempotent:
 * - 重复执行安全：检查 milestone_* 列是否已存在，已存在则跳过。
 *
 * Algorithm:
 * - 对 RENAME_MAP 每对 (oldName, newName)：
 *   - if oldName exists AND newName does NOT exist → ALTER TABLE RENAME COLUMN
 *   - else skip
 *
 * @param dbPath SQLite database file path
 */
export function runMigration(dbPath: string): void {
  logMigration(`[Migration 004] Starting migration for: ${dbPath}`);

  const db = createCompatibleDatabase(dbPath);

  try {
    const existingColumns = new Set<string>();
    const cols = db
      .query("PRAGMA table_info(task_operation)")
      .all() as Array<{ name: string }>;
    for (const c of cols) existingColumns.add(c.name);

    for (const { oldName, newName } of RENAME_MAP) {
      const hasOld = existingColumns.has(oldName);
      const hasNew = existingColumns.has(newName);

      if (hasOld && !hasNew) {
        // SQLite 3.25+ supports ALTER TABLE RENAME COLUMN
        db.run(`ALTER TABLE task_operation RENAME COLUMN ${oldName} TO ${newName}`);
        logMigration(`[Migration 004] Renamed ${oldName} -> ${newName}`);
      } else if (hasNew) {
        logMigration(`[Migration 004] ${newName} already exists, skipping rename of ${oldName}`);
      } else {
        // oldName 不存在（fresh database / 部分迁移）：跳过
        logMigration(`[Migration 004] ${oldName} not present, skipping rename to ${newName}`);
      }
    }

    logMigration(`[Migration 004] Migration completed successfully`);
  } finally {
    db.close();
  }
}

// CLI runner for manual execution
if (require.main === module) {
  const dbPath = process.argv[2];
  if (!dbPath) {
    console.error("Usage: bun run 004_rename_action_to_milestone.ts <db-path>");
    process.exit(1);
  }
  runMigration(dbPath);
}
