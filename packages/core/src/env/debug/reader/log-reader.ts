/**
 * @fileoverview Log Reader
 * 
 * Reads log files with support for streaming and filtering.
 */

import * as fs from 'fs';
import * as readline from 'readline';
import * as path from 'path';
import { glob } from 'glob';
import type { ParserOptions } from '../types';

/**
 * Default XDG log directory
 */
const DEFAULT_LOG_DIR = '.local/share/roy-bot/logs';

/**
 * Get XDG data home directory
 */
export function getXDGDataHome(): string {
  return process.env.XDG_DATA_HOME || 
    path.join(process.env.HOME || '/home/' + (process.env.USER || 'user'), '.local', 'share');
}

/**
 * Log Reader for reading and parsing log files
 */
export class LogReader {
  private logDir: string;

  constructor(options?: { logDir?: string }) {
    this.logDir = options?.logDir || 
      path.join(getXDGDataHome(), 'roy-bot', 'logs');
  }

  /**
   * Get the full path to a log file
   */
  getLogPath(filename?: string): string {
    if (!filename) {
      return path.join(this.logDir, 'app.log');
    }
    // If absolute path, use directly
    if (path.isAbsolute(filename)) {
      return filename;
    }
    return path.join(this.logDir, filename);
  }

  /**
   * Find log files matching a pattern
   * 
   * Uses forward slashes for glob patterns to ensure cross-platform compatibility.
   * The glob library requires forward slashes regardless of OS.
   */
  async findLogFiles(pattern: string = '*.log'): Promise<string[]> {
    try {
      // Use forward slashes for glob pattern to ensure Windows compatibility
      const normalizedDir = this.logDir.replace(/\\/g, "/");
      const fullPattern = `${normalizedDir}/${pattern}`;
      const files = await glob(fullPattern);
      return files.sort(); // Sort by name
    } catch {
      return [];
    }
  }

  /**
   * Get default log directory
   */
  getDefaultLogDir(): string {
    return this.logDir;
  }

  /**
   * Read lines from a log file with optional filtering
   */
  async *readLines(
    filepath: string,
    options?: ParserOptions
  ): AsyncGenerator<string> {
    const sinceTime = options?.since ? this.parseTime(options.since) : null;
    const untilTime = options?.until ? this.parseTime(options.until) : null;

    // Check if file exists
    if (!fs.existsSync(filepath)) {
      return;
    }

    const fileStream = fs.createReadStream(filepath, { encoding: 'utf-8' });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;

        // Filter by time if specified
        if (sinceTime || untilTime) {
          const lineTime = this.extractTimestamp(line);
          if (lineTime) {
            if (sinceTime && lineTime < sinceTime) continue;
            if (untilTime && lineTime > untilTime) continue;
          }
        }

        yield line;
      }
    } finally {
      rl.close();
      fileStream.destroy();
    }
  }

  /**
   * Extract timestamp from a log line
   */
  extractTimestamp(line: string): number | null {
    // Match format: 2026-04-08 19:12:36.134 or 2026-04-08T19:12:36.134
    const match = line.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
    if (!match) return null;

    const datePart = match[1];
    const timePart = match[2]; // Keep original format (10:00:00)
    const isoString = `${datePart}T${timePart}`;

    const timestamp = new Date(isoString).getTime();
    return isNaN(timestamp) ? null : timestamp;
  }

  /**
   * Parse time string to timestamp
   * Supports ISO format and relative time like "1h", "30m"
   */
  parseTime(timeStr: string): number {
    const now = Date.now();

    // Normalize the time string (replace T with space for parsing)
    const normalizedStr = timeStr.replace('T', ' ');

    // Try parsing as absolute time
    const absoluteTime = new Date(normalizedStr).getTime();
    if (!isNaN(absoluteTime) && absoluteTime > 0) {
      return absoluteTime;
    }

    // Also try original format
    const originalTime = new Date(timeStr).getTime();
    if (!isNaN(originalTime) && originalTime > 0) {
      return originalTime;
    }

    // Parse relative time
    const relativeMatch = timeStr.match(/^(\d+)([hms])$/);
    if (relativeMatch) {
      const value = parseInt(relativeMatch[1], 10);
      const unit = relativeMatch[2];

      switch (unit) {
        case 'h': return now - value * 60 * 60 * 1000;
        case 'm': return now - value * 60 * 1000;
        case 's': return now - value * 1000;
      }
    }

    // Default to current time if parsing fails
    return now;
  }

  /**
   * Read file content directly (for small files)
   */
  async readFile(filepath: string): Promise<string> {
    return fs.promises.readFile(filepath, 'utf-8');
  }

  /**
   * Check if a log file exists
   */
  exists(filepath: string): boolean {
    return fs.existsSync(filepath);
  }
}
