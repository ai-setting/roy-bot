/**
 * Simple Store - A minimal key-value store implementation
 * 
 * Provides basic get/set/delete functionality without external dependencies.
 * Uses a JSON file for persistence.
 * 
 * This replaces electron-store to avoid dependency issues in bundled apps.
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

export class SimpleStore {
  private data: Record<string, unknown>;
  private filePath: string;
  private dirty = false;

  constructor(options?: {
    name?: string;
    defaults?: Record<string, unknown>;
  }) {
    const name = options?.name ?? 'config';
    const defaults = options?.defaults ?? {};

    this.data = { ...defaults };
    
    // Get user data path
    const userDataPath = app.getPath('userData');
    
    // Ensure directory exists
    if (!fs.existsSync(userDataPath)) {
      fs.mkdirSync(userDataPath, { recursive: true });
    }
    
    this.filePath = path.join(userDataPath, `${name}.json`);
    
    // Load existing data
    this.load();
  }

  /**
   * Get a value by key
   */
  get(key: string): unknown {
    return this.data[key];
  }

  /**
   * Set a value
   */
  set(key: string, value: unknown): void {
    this.data[key] = value;
    this.dirty = true;
  }

  /**
   * Delete a key
   */
  delete(key: string): void {
    delete this.data[key];
    this.dirty = true;
  }

  /**
   * Check if a key exists
   */
  has(key: string): boolean {
    return key in this.data;
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.data = {};
    this.dirty = true;
  }

  /**
   * Get all keys
   */
  keys(): string[] {
    return Object.keys(this.data);
  }

  /**
   * Get all entries
   */
  entries(): [string, unknown][] {
    return Object.entries(this.data);
  }

  /**
   * Load data from disk
   */
  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const content = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(content);
        this.data = { ...this.data, ...parsed };
      }
    } catch (err) {
      console.warn('[SimpleStore] Failed to load config:', err);
    }
  }

  /**
   * Save data to disk
   */
  private save(): void {
    if (!this.dirty) return;
    
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
      this.dirty = false;
    } catch (err) {
      console.error('[SimpleStore] Failed to save config:', err);
    }
  }

  /**
   * Ensure data is saved
   */
  flush(): void {
    this.save();
  }
}
