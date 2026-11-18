/**
 * @fileoverview DesktopEnvironmentService (Renderer Version)
 * 
 * Renderer-side service that delegates to Electron main process.
 * 
 * Architecture:
 * - This file runs in the renderer process (browser)
 * - Actual core functionality runs in Electron main process
 * - Communication via IPC through preload API
 */

import { DesktopEnvironmentAdapter, getDefaultAdapter, isElectron } from '../electron';
import { eventBus } from './EventBusAdapter';

/**
 * Simple logger for renderer process
 */
const logger = {
  info: (message: string, ...args: unknown[]) => console.log(`[DesktopEnvironment] ${message}`, ...args),
  warn: (message: string, ...args: unknown[]) => console.warn(`[DesktopEnvironment] ${message}`, ...args),
  error: (message: string, ...args: unknown[]) => console.error(`[DesktopEnvironment] ${message}`, ...args),
};

/**
 * DesktopEnvironmentService configuration options
 */
export interface DesktopEnvironmentServiceOptions {
  /** Environment name */
  envName?: string;
  /** Config directory */
  configDir?: string;
  /** Use Electron mode (default: auto-detect) */
  useElectron?: boolean;
}

/**
 * DesktopEnvironmentService - Renderer-side service
 * 
 * This service delegates all core functionality to the Electron main process
 * where the actual DesktopEnvironment runs.
 */
export class DesktopEnvironmentService {
  private initialized = false;
  private adapter: DesktopEnvironmentAdapter;

  /**
   * Check if running in Electron environment
   */
  static isElectron(): boolean {
    return isElectron();
  }

  constructor() {
    this.adapter = getDefaultAdapter();
  }

  /**
   * Get the underlying adapter
   */
  getAdapter(): DesktopEnvironmentAdapter {
    return this.adapter;
  }

  /**
   * Check if environment is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Check if using Electron
   */
  isElectronMode(): boolean {
    return this.adapter.isInElectron();
  }

  /**
   * Get environment status (delegate to adapter)
   */
  getEnvironment(): { initialized: boolean; envName?: string } | null {
    if (!this.initialized) return null;
    // Return a simplified status object
    return { initialized: true, envName: 'roy-desktop' };
  }

  /**
   * Get session info (delegate to adapter)
   * Returns null in simplified renderer mode
   */
  getSession(): null {
    // In renderer mode, session is managed by main process
    return null;
  }

  /**
   * Get agent info (delegate to adapter)
   * Returns null in simplified renderer mode
   */
  getAgent(): null {
    // In renderer mode, agent is managed by main process
    return null;
  }

  /**
   * Get default config directory (left to main process to determine)
   * Returns undefined to let the main process use os.homedir() which works cross-platform.
   */
  private getDefaultConfigDir(): string | undefined {
    return undefined;
  }

  /**
   * Create and initialize the environment
   */
  async create(options?: DesktopEnvironmentServiceOptions): Promise<void> {
    if (this.initialized) {
      logger.warn("Environment already created");
      return;
    }

    const envName = options?.envName ?? "roy-desktop";
    const configDir = options?.configDir ?? this.getDefaultConfigDir();

    logger.info(`Creating desktop environment (renderer): ${envName}`);
    logger.info(`Using config dir: ${configDir}`);

    // Initialize adapter
    if (this.adapter.isInElectron()) {
      // In Electron: delegate to main process
      await this.adapter.create({ envName, configDir });
    }
    // In browser: use simplified mode (no-op)

    this.initialized = true;
    logger.info("Desktop environment created (renderer)");
  }

  /**
   * Handle user query
   */
  async handleQuery(query: string, context?: { sessionId?: string; agentType?: string }): Promise<string> {
    if (!this.initialized) {
      throw new Error("Environment not initialized. Call create() first.");
    }

    if (this.adapter.isInElectron()) {
      // Delegate to main process
      return this.adapter.handleQuery(query, context);
    }

    // Simplified mode (demo only)
    logger.info(`[handleQuery] Simplified mode: ${query}`);

    // Publish mock events to EventBus
    await eventBus.publish({
      type: "agent.start",
      data: { query },
      timestamp: Date.now(),
    } as any);

    await new Promise(resolve => setTimeout(resolve, 100));

    await eventBus.publish({
      type: "tool.call",
      data: { tool: "mock_tool", args: { query } },
      timestamp: Date.now(),
    } as any);

    await new Promise(resolve => setTimeout(resolve, 100));

    await eventBus.publish({
      type: "agent.completed",
      data: { response: "This is a demo response. Run in Electron for full functionality." },
      timestamp: Date.now(),
    } as any);

    return "This is a demo response. Run in Electron for full functionality.";
  }

  /**
   * Dispose the environment
   */
  async dispose(): Promise<void> {
    if (!this.initialized) {
      return;
    }

    logger.info("Disposing desktop environment (renderer)");

    if (this.adapter.isInElectron()) {
      await this.adapter.dispose();
    }

    this.initialized = false;
    logger.info("Desktop environment disposed (renderer)");
  }

  // ==================== Config ====================

  /**
   * Read configuration file
   */
  async readConfig<T = Record<string, unknown>>(filePath?: string): Promise<T | null> {
    if (!this.adapter.isInElectron()) return null;
    const path = filePath ?? `${await this.getDataPath()}/config.json`;
    return this.adapter.readConfig(path) as Promise<T | null>;
  }

  /**
   * Write configuration file
   */
  async writeConfig<T = Record<string, unknown>>(config: T, filePath?: string): Promise<boolean> {
    if (!this.adapter.isInElectron()) return false;
    const path = filePath ?? `${await this.getDataPath()}/config.json`;
    return this.adapter.writeConfig(path, config);
  }

  // ==================== Database ====================

  /**
   * Open database connection
   */
  async openDatabase(dbFileName: string): Promise<string> {
    if (!this.adapter.isInElectron()) return '';
    return this.adapter.openDatabase(dbFileName);
  }

  /**
   * Run SQL statement
   */
  async runSQL(dbId: string, sql: string, params?: unknown[]): Promise<{ lastInsertRowid: number | bigint; changes: number } | undefined> {
    if (!this.adapter.isInElectron()) return undefined;
    return this.adapter.runSQL(dbId, sql, params);
  }

  /**
   * Select from database
   */
  async select<T = unknown[]>(dbId: string, sql: string, params?: unknown[]): Promise<T> {
    if (!this.adapter.isInElectron()) return [] as T;
    return this.adapter.select<T>(dbId, sql, params);
  }

  /**
   * Close database connection
   */
  async closeDatabase(dbId: string): Promise<boolean> {
    if (!this.adapter.isInElectron()) return false;
    return this.adapter.closeDatabase(dbId);
  }

  // ==================== Key-Value Store ====================

  /**
   * Get value from store
   */
  async getStoreValue<T = unknown>(key: string): Promise<T | undefined> {
    if (!this.adapter.isInElectron()) return undefined;
    return this.adapter.getStoreValue<T>(key);
  }

  /**
   * Set value in store
   */
  async setStoreValue<T = unknown>(key: string, value: T): Promise<boolean> {
    if (!this.adapter.isInElectron()) return false;
    return this.adapter.setStoreValue(key, value);
  }

  /**
   * Delete value from store
   */
  async deleteStoreValue(key: string): Promise<boolean> {
    if (!this.adapter.isInElectron()) return false;
    return this.adapter.deleteStoreValue(key);
  }

  // ==================== Electron-specific methods ====================

  /**
   * Get app info
   */
  async getAppInfo(): Promise<{ name: string; version: string; platform: string; arch: string } | null> {
    if (!this.adapter.isInElectron()) return null;
    return this.adapter.getAppInfo();
  }

  /**
   * Get data path
   */
  async getDataPath(): Promise<string | null> {
    if (!this.adapter.isInElectron()) return null;
    return this.adapter.getDataPath();
  }

  /**
   * Show notification
   */
  async showNotification(title: string, body: string): Promise<boolean> {
    if (!this.adapter.isInElectron()) return false;
    return this.adapter.showNotification(title, body);
  }

  /**
   * Minimize window
   */
  async minimizeWindow(): Promise<void> {
    if (this.adapter.isInElectron()) {
      await this.adapter.minimizeWindow();
    }
  }

  /**
   * Maximize/restore window
   */
  async maximizeWindow(): Promise<void> {
    if (this.adapter.isInElectron()) {
      await this.adapter.maximizeWindow();
    }
  }

  /**
   * Close window
   */
  async closeWindow(): Promise<void> {
    if (this.adapter.isInElectron()) {
      await this.adapter.closeWindow();
    }
  }

  /**
   * Check if window is maximized
   */
  async isWindowMaximized(): Promise<boolean> {
    if (!this.adapter.isInElectron()) return false;
    return this.adapter.isWindowMaximized();
  }

  /**
   * Get platform
   */
  getPlatform(): string {
    return this.adapter.getPlatform();
  }
}
