/**
 * @fileoverview Store Factory
 * 
 * Factory for creating SQLite database instances via Electron IPC.
 * Provides singleton database access throughout the application.
 */

import { getDefaultAdapter } from '../electron';

/**
 * Database instance type for Electron SQLite
 */
export interface ElectronDatabase {
  execute(sql: string, params?: unknown[]): Promise<{ lastInsertRowid: number | bigint; changes: number }>;
  select<T>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<boolean>;
}

/** Singleton database instance */
let dbInstance: ElectronDatabase | null = null;
let dbId: string | null = null;

/** Default SQLite database file name for tasks */
const DEFAULT_TASK_DB_FILE = 'tasks.db';

/**
 * Get the singleton database instance.
 * Creates a new connection if one doesn't exist.
 * 
 * @param dbFileName - Optional database file name (relative to user data path)
 * @returns Promise resolving to the database instance
 */
export async function getDatabase(dbFileName?: string): Promise<ElectronDatabase> {
  if (dbInstance && dbId) {
    return dbInstance;
  }

  const adapter = getDefaultAdapter();
  const fileName = dbFileName || DEFAULT_TASK_DB_FILE;
  
  // Open database via Electron IPC
  const id = await adapter.openDatabase(fileName);
  dbId = id;
  
  // Wrap the database to match our interface
  dbInstance = {
    execute: async (sql: string, params?: unknown[]) => {
      return adapter.runSQL(id, sql, params) as Promise<{ lastInsertRowid: number | bigint; changes: number }>;
    },
    select: async <T>(sql: string, params?: unknown[]) => {
      return adapter.select<T>(id, sql, params) as Promise<T[]>;
    },
    close: async () => {
      const result = await adapter.closeDatabase(id);
      dbInstance = null;
      dbId = null;
      return result;
    },
  };

  return dbInstance;
}

/**
 * Close the database connection.
 * Call this when the application is shutting down.
 */
export async function closeDatabase(): Promise<void> {
  if (dbInstance) {
    await dbInstance.close();
  }
}

/**
 * Check if database is initialized
 */
export function isDatabaseInitialized(): boolean {
  return dbInstance !== null;
}
