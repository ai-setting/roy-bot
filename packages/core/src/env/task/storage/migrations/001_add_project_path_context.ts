/**
 * @fileoverview Task Migration: Add project_path and context columns
 * 
 * Migration ID: 001_add_project_path_context
 * Description: Add project_path and context columns to task table
 * Date: 2026-05-12
 */

import { createCompatibleDatabase } from "../sqlite-task-store";
import { logMigration } from "./log-migration";

/**
 * Run migration to add project_path and context columns
 * 
 * This migration is idempotent - safe to run multiple times.
 * Existing databases will have columns added if missing.
 */
export function runMigration(dbPath: string): void {
  logMigration(`[Migration 001] Starting migration for: ${dbPath}`);
  
  const db = createCompatibleDatabase(dbPath);
  
  try {
    // Add project_path column if not exists
    try {
      db.run(`ALTER TABLE task ADD COLUMN project_path TEXT`);
      logMigration(`[Migration 001] Added project_path column`);
    } catch (e: any) {
      if (e.message?.includes("duplicate column name")) {
        logMigration(`[Migration 001] project_path column already exists, skipping`);
      } else {
        throw e;
      }
    }
    
    // Add context column if not exists
    try {
      db.run(`ALTER TABLE task ADD COLUMN context TEXT`);
      logMigration(`[Migration 001] Added context column`);
    } catch (e: any) {
      if (e.message?.includes("duplicate column name")) {
        logMigration(`[Migration 001] context column already exists, skipping`);
      } else {
        throw e;
      }
    }
    
    logMigration(`[Migration 001] Migration completed successfully`);
  } finally {
    db.close();
  }
}

// CLI runner for manual execution
if (require.main === module) {
  const dbPath = process.argv[2];
  if (!dbPath) {
    console.error("Usage: bun run 001_add_project_path_context.ts <db-path>");
    process.exit(1);
  }
  runMigration(dbPath);
}
