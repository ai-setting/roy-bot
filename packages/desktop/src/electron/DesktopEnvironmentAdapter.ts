/**
 * @fileoverview DesktopEnvironmentAdapter (Renderer Version)
 * 
 * Adapter that bridges renderer process with Electron's IPC API.
 * 
 * This is a thin wrapper around the preload API that provides
 * a clean interface for the renderer to interact with the main process.
 * 
 * NOTE: This version delegates all core functionality to the main process.
 * The actual DesktopEnvironment runs in the main process.
 */

import { isElectron, getElectronAPI } from './types';

/**
 * DesktopEnvironmentAdapter configuration
 */
export interface DesktopEnvironmentAdapterConfig {
  /** Environment name */
  envName?: string;
  /** Config directory */
  configDir?: string;
}

/**
 * DesktopEnvironmentAdapter - Renderer-side adapter for desktop environment
 * 
 * This adapter uses the preload API to communicate with the main process
 * where the actual DesktopEnvironment runs.
 */
export class DesktopEnvironmentAdapter {
  private initialized = false;

  /**
   * Create a new DesktopEnvironmentAdapter
   */
  constructor() {
    if (!isElectron()) {
      console.warn('[DesktopEnvironmentAdapter] Not in Electron environment');
    }
  }

  /**
   * Check if in Electron environment
   */
  isInElectron(): boolean {
    return isElectron();
  }

  // ==================== Environment Lifecycle ====================

  /**
   * Create and initialize the environment (delegates to main process)
   */
  async create(options?: DesktopEnvironmentAdapterConfig): Promise<void> {
    const api = getElectronAPI();
    await api.environment.create(options);
    this.initialized = true;
  }

  /**
   * Check if environment is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get environment status from main process
   */
  async getStatus(): Promise<{ initialized: boolean; envName?: string }> {
    const api = getElectronAPI();
    return api.environment.getStatus();
  }

  /**
   * Handle user query through the agent
   */
  async handleQuery(query: string, context?: { sessionId?: string; agentType?: string }): Promise<string> {
    const api = getElectronAPI();
    return api.environment.handleQuery(query, context);
  }

  /**
   * Dispose the environment
   */
  async dispose(): Promise<void> {
    const api = getElectronAPI();
    await api.environment.dispose();
    this.initialized = false;
  }

  // ==================== App Info ====================

  /**
   * Get application info
   */
  async getAppInfo(): Promise<{ name: string; version: string; platform: string; arch: string }> {
    const api = getElectronAPI();
    return api.getAppInfo();
  }

  /**
   * Get platform
   */
  getPlatform(): string {
    return getElectronAPI().platform;
  }

  // ==================== Paths ====================

  /**
   * Get user data path
   */
  async getDataPath(): Promise<string> {
    const api = getElectronAPI();
    return api.getUserDataPath();
  }

  /**
   * Get home directory path
   */
  async getHomePath(): Promise<string> {
    const api = getElectronAPI();
    return api.getHomePath();
  }

  /**
   * Get temp directory path
   */
  async getTempPath(): Promise<string> {
    const api = getElectronAPI();
    return api.getTempPath();
  }

  // ==================== Config ====================

  /**
   * Read configuration file
   */
  async readConfig<T = Record<string, unknown>>(filePath: string): Promise<T | null> {
    try {
      const api = getElectronAPI();
      const content = await api.readFile(filePath);
      return JSON.parse(content) as T;
    } catch {
      return null;
    }
  }

  /**
   * Write configuration file
   */
  async writeConfig<T = Record<string, unknown>>(filePath: string, config: T): Promise<boolean> {
    const api = getElectronAPI();
    const content = JSON.stringify(config, null, 2);
    return api.writeFile(filePath, content);
  }

  // ==================== File System ====================

  /**
   * Read file content
   */
  async readFile(filePath: string): Promise<string> {
    const api = getElectronAPI();
    return api.readFile(filePath);
  }

  /**
   * Write file content
   */
  async writeFile(filePath: string, data: string): Promise<boolean> {
    const api = getElectronAPI();
    return api.writeFile(filePath, data);
  }

  /**
   * Check if file exists
   */
  async fileExists(filePath: string): Promise<boolean> {
    const api = getElectronAPI();
    return api.fileExists(filePath);
  }

  /**
   * Create directory
   */
  async mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<boolean> {
    const api = getElectronAPI();
    return api.mkdir(dirPath, options);
  }

  /**
   * Read directory contents
   */
  async readDir(dirPath: string) {
    const api = getElectronAPI();
    return api.readDir(dirPath);
  }

  // ==================== Window Controls ====================

  /**
   * Minimize window
   */
  async minimizeWindow(): Promise<void> {
    const api = getElectronAPI();
    return api.minimizeWindow();
  }

  /**
   * Maximize/restore window
   */
  async maximizeWindow(): Promise<void> {
    const api = getElectronAPI();
    return api.maximizeWindow();
  }

  /**
   * Close window
   */
  async closeWindow(): Promise<void> {
    const api = getElectronAPI();
    return api.closeWindow();
  }

  /**
   * Check if window is maximized
   */
  async isWindowMaximized(): Promise<boolean> {
    const api = getElectronAPI();
    return api.isWindowMaximized();
  }

  /**
   * Subscribe to window maximize state changes
   */
  onMaximizeChange(callback: (isMaximized: boolean) => void): () => void {
    const api = getElectronAPI();
    return api.onMaximizeChange(callback);
  }

  // ==================== Notifications ====================

  /**
   * Show system notification
   */
  async showNotification(title: string, body: string): Promise<boolean> {
    const api = getElectronAPI();
    return api.showNotification(title, body);
  }

  // ==================== Shell ====================

  /**
   * Open URL in external browser
   */
  async openExternal(url: string): Promise<boolean> {
    const api = getElectronAPI();
    return api.openExternal(url);
  }

  // ==================== SQLite ====================

  /**
   * Open database (path is relative to user data)
   */
  async openDatabase(dbFileName: string): Promise<string> {
    const dataPath = await this.getDataPath();
    const dbPath = `${dataPath}/${dbFileName}`;
    const api = getElectronAPI();
    return api.sqlite.open(dbPath);
  }

  /**
   * Run SQL statement
   */
  async runSQL(dbId: string, sql: string, params?: unknown[]): Promise<{ lastInsertRowid: number | bigint; changes: number }> {
    const api = getElectronAPI();
    return api.sqlite.run(dbId, sql, params);
  }

  /**
   * Select from database
   */
  async select<T = unknown[]>(dbId: string, sql: string, params?: unknown[]): Promise<T> {
    const api = getElectronAPI();
    return api.sqlite.select(dbId, sql, params) as Promise<T>;
  }

  /**
   * Close database connection
   */
  async closeDatabase(dbId: string): Promise<boolean> {
    const api = getElectronAPI();
    return api.sqlite.close(dbId);
  }

  // ==================== Key-Value Store ====================

  /**
   * Get value from store
   */
  async getStoreValue<T = unknown>(key: string): Promise<T | undefined> {
    const api = getElectronAPI();
    return api.store.get(key) as Promise<T | undefined>;
  }

  /**
   * Set value in store
   */
  async setStoreValue<T = unknown>(key: string, value: T): Promise<boolean> {
    const api = getElectronAPI();
    return api.store.set(key, value);
  }

  /**
   * Delete value from store
   */
  async deleteStoreValue(key: string): Promise<boolean> {
    const api = getElectronAPI();
    return api.store.delete(key);
  }

  // ==================== Event Subscription ====================

  /**
   * Set up IPC sender for event forwarding (call after environment create)
   */
  async setupEventForwarding(): Promise<void> {
    const api = getElectronAPI();
    await api.environment.setIpcSender();
  }

  /**
   * Subscribe to environment events
   * @param callback - Called when events are received
   * @returns Unsubscribe function
   */
  onEnvEvent(callback: (event: { type: string; data: unknown; timestamp: number }) => void): () => void {
    const api = getElectronAPI();
    
    api.onEvent(callback);
    
    return () => {
      api.offEvent(callback);
    };
  }

  /**
   * Subscribe to IPC errors
   * @param callback - Called when IPC errors occur
   * @returns Unsubscribe function
   */
  onError(callback: (error: { code: string; message: string; details?: unknown }) => void): () => void {
    const api = getElectronAPI();
    
    api.onError(callback);
    
    // Return unsubscribe function
    return () => {
      api.offError(callback);
    };
  }

  /**
   * Get desktop component info
   */
  async getDesktopComponentInfo(): Promise<{ eventTypes: string[]; enabled: boolean } | null> {
    const api = getElectronAPI();
    const result = await api.environment.getDesktopComponent();
    if (result.error) {
      console.warn('[DesktopEnvironmentAdapter] getDesktopComponent error:', result.error);
      return null;
    }
    return {
      eventTypes: result.eventTypes,
      enabled: result.enabled,
    };
  }

  /**
   * Set event types to subscribe
   */
  async setEventTypes(types: string[]): Promise<void> {
    const api = getElectronAPI();
    await api.environment.setEventTypes(types);
  }

  /**
   * Set events enabled/disabled
   */
  async setEventsEnabled(enabled: boolean): Promise<void> {
    const api = getElectronAPI();
    await api.environment.setEventsEnabled(enabled);
  }
}

/**
 * Default adapter instance (singleton)
 */
let defaultAdapter: DesktopEnvironmentAdapter | null = null;

/**
 * Get default adapter instance
 */
export function getDefaultAdapter(): DesktopEnvironmentAdapter {
  if (!defaultAdapter) {
    defaultAdapter = new DesktopEnvironmentAdapter();
  }
  return defaultAdapter;
}
