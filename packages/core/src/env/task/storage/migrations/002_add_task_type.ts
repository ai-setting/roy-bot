/**
 * @fileoverview Task Migration: Add type column
 * 
 * Migration ID: 002_add_task_type
 * Description: Add type column to task table (normal/cycle/longterm)
 * Date: 2026-06-04
 */

import { createCompatibleDatabase } from "../sqlite-task-store";
import { logMigration } from "./log-migration";

/**
 * Run migration to add type column
 * 
 * This migration is idempotent - safe to run multiple times.
 * Existing databases will have the column added if missing.
 */
export function runMigration(dbPath: string): void {
  logMigration(`[Migration 002] Starting migration for: ${dbPath}`);
  
  const db = createCompatibleDatabase(dbPath);
  
  try {
    // Add type column if not exists
    try {
      db.run(`ALTER TABLE task ADD COLUMN type TEXT NOT NULL DEFAULT 'normal'`);
      logMigration(`[Migration 002] Added type column`);
    } catch (e: any) {
      if (e.message?.includes("duplicate column name")) {
        logMigration(`[Migration 002] type column already exists, skipping`);
      } else {
        throw e;
      }
    }
    
    logMigration(`[Migration 002] Migration completed successfully`);
  } finally {
    db.close();
  }
}

// CLI runner for manual execution
if (require.main === module) {
  const dbPath = process.argv[2];
  if (!dbPath) {
    console.error("Usage: bun run 002_add_task_type.ts <db-path>");
    process.exit(1);
  }
  runMigration(dbPath);
}
