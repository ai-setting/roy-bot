/**
 * @fileoverview Electron API Type Definitions
 * 
 * Type definitions for the Electron preload API exposed via contextBridge.
 * These types mirror the methods defined in electron/preload.ts
 */

/**
 * ElectronAPI interface exposed to renderer process
 */
export interface ElectronAPI {
  // App info
  getAppInfo: () => Promise<AppInfo>;
  
  // Path utilities
  getUserDataPath: () => Promise<string>;
  getAppDataPath: () => Promise<string>;
  getTempPath: () => Promise<string>;
  getHomePath: () => Promise<string>;
  
  // File system operations
  readFile: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, data: string) => Promise<boolean>;
  fileExists: (filePath: string) => Promise<boolean>;
  mkdir: (dirPath: string, options?: { recursive?: boolean }) => Promise<boolean>;
  readDir: (dirPath: string) => Promise<FileEntry[]>;
  
  // Shell operations
  openExternal: (url: string) => Promise<boolean>;
  
  // Window controls
  minimizeWindow: () => Promise<void>;
  maximizeWindow: () => Promise<void>;
  closeWindow: () => Promise<void>;
  isWindowMaximized: () => Promise<boolean>;
  
  // Notifications
  showNotification: (title: string, body: string) => Promise<boolean>;
  
  // SQLite database operations
  sqlite: SQLiteAPI;
  
  // Key-value store
  store: StoreAPI;
  
  // Desktop Environment (Core - runs in main process)
  environment: EnvironmentAPI;
  
  // Window state listeners
  onMaximizeChange: (callback: (isMaximized: boolean) => void) => () => void;
  
  // Event listeners (for environment events)
  onEvent: (callback: (...args: unknown[]) => void) => void;
  offEvent: (callback: (...args: unknown[]) => void) => void;
  
  // Error listeners (for IPC errors)
  onError: (callback: (error: IPCError) => void) => void;
  offError: (callback: (error: IPCError) => void) => void;
  
  // Platform info
  platform: string;
  isElectron: boolean;
}

/**
 * Desktop Environment API - Core functionality in main process
 */
export interface EnvironmentAPI {
  /** Initialize the desktop environment (creates BaseEnvironment) */
  create: (options?: { envName?: string; configDir?: string }) => Promise<{ success: boolean }>;
  
  /** Handle a user query through the agent */
  handleQuery: (query: string, context?: { sessionId?: string; agentType?: string }) => Promise<string>;
  
  /** Get environment status */
  getStatus: () => Promise<{ initialized: boolean; envName?: string }>;
  
  /** Dispose the environment */
  dispose: () => Promise<{ success: boolean }>;
  
  /** Set up IPC sender for event forwarding */
  setIpcSender: () => Promise<{ success: boolean }>;
  
  /** Get desktop component API */
  getDesktopComponent: () => Promise<{ eventTypes: string[]; enabled: boolean; error?: string }>;
  
  /** Set event types to subscribe */
  setEventTypes: (types: string[]) => Promise<{ success: boolean }>;
  
  /** Set events enabled/disabled */
  setEventsEnabled: (enabled: boolean) => Promise<{ success: boolean }>;
}

/**
 * Env event type
 */
export interface EnvEvent {
  type: string;
  data?: unknown;
  timestamp: number;
}

/**
 * IPC error type
 */
export interface IPCError {
  code: string;
  message: string;
  details?: unknown;
}

/**
 * App info returned by getAppInfo
 */
export interface AppInfo {
  name: string;
  version: string;
  platform: string;
  arch: string;
}

/**
 * File entry returned by readDir
 */
export interface FileEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  path: string;
}

/**
 * SQLite API interface
 */
export interface SQLiteAPI {
  open: (dbPath: string) => Promise<string>;
  run: (dbId: string, sql: string, params?: unknown[]) => Promise<SQLiteResult>;
  select: (dbId: string, sql: string, params?: unknown[]) => Promise<unknown[]>;
  close: (dbId: string) => Promise<boolean>;
}

/**
 * SQLite result from run operation
 */
export interface SQLiteResult {
  lastInsertRowid: number | bigint;
  changes: number;
}

/**
 * Store API interface (key-value persistence)
 */
export interface StoreAPI {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<boolean>;
  delete: (key: string) => Promise<boolean>;
}

/**
 * Check if running in Electron environment
 */
export function isElectron(): boolean {
  return typeof window !== 'undefined' && window.electronAPI?.isElectron === true;
}

/**
 * Get ElectronAPI instance (throws if not in Electron)
 */
export function getElectronAPI(): ElectronAPI {
  if (!isElectron()) {
    throw new Error('Not running in Electron environment');
  }
  return window.electronAPI;
}

/**
 * Global window interface augmentation
 */
declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
