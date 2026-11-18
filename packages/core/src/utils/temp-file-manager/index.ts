import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { createLogger } from "../../env/log-trace/logger";

const logger = createLogger("temp-file-manager");

/**
 * TempFileManager — singleton manager for tool output truncation temp files.
 *
 * When tool output is truncated, the full content is saved to a temp file so the
 * LLM can use `read_file` to retrieve specific portions.
 *
 * Features:
 * - Cross-platform: uses `os.tmpdir()` + `path.join()` (Linux/macOS/Windows)
 * - Process lifecycle: cleans up on exit/SIGINT/SIGTERM
 * - Stale file sweep: cleans up files older than 24h at startup
 * - Concurrent safe: uses `crypto.randomUUID()` for unique filenames
 * - Large file safety: warns for content > 10MB (does not block)
 * - Singleton: shared instance via `getInstance()`
 *
 * File naming: `roy-bot-truncation-{pid}-{uuid}-{prefix}.txt`
 * Examples:
 *   Linux:   /tmp/roy-bot-truncation-12345-abc123-def456-bash.txt
 *   macOS:   /var/folders/xx/yy/T/roy-bot-truncation-12345-abc123-def456-bash.txt
 *   Windows: C:\Users\xxx\AppData\Local\Temp\roy-bot-truncation-12345-abc123-def456-bash.txt
 */
export class TempFileManager {
  private static _instance: TempFileManager | null = null;
  private readonly _files: Set<string> = new Set();
  private _hooksRegistered: boolean = false;
  private static readonly FILE_PREFIX: string = "roy-bot-truncation";
  private static readonly FILE_EXT: string = ".txt";
  private static readonly LARGE_FILE_THRESHOLD: number = 10 * 1024 * 1024; // 10MB
  private static readonly STALE_FILE_AGE_MS: number = 24 * 60 * 60 * 1000; // 24 hours

  /**
   * Private constructor — use `getInstance()` instead.
   */
  private constructor() {
    // Sweep stale files from previous sessions on first instantiation
    this.sweepStaleFiles().catch((err) => {
      logger.warn(`[TempFileManager] Stale file sweep failed: ${err}`);
    });
  }

  /**
   * Get the singleton instance.
   *
   * Note: This intentionally holds a strong reference for the process lifetime
   * because process exit hooks reference the instance.
   */
  static getInstance(): TempFileManager {
    if (!TempFileManager._instance) {
      TempFileManager._instance = new TempFileManager();
    }
    return TempFileManager._instance;
  }

  /**
   * Reset the singleton instance (for testing only).
   *
   * @internal
   */
  static _resetForTesting(): void {
    if (TempFileManager._instance) {
      // Best effort cleanup
      TempFileManager._instance.cleanupAll().catch(() => {});
    }
    TempFileManager._instance = null;
  }

  /**
   * Write content to a temporary file and track it for later cleanup.
   *
   * @param content - The text content to write to the file
   * @param prefix - A short string to identify the source (e.g., tool name)
   * @returns Absolute path to the created temp file
   *
   * @example
   * const path = await TempFileManager.getInstance().writeTempFile(
   *   "large output...",
   *   "bash"
   * );
   * // → "/tmp/roy-bot-truncation-12345-abc123-bash.txt"
   */
  async writeTempFile(content: string, prefix: string = "default"): Promise<string> {
    // Ensure cleanup hooks are registered on first use
    this.ensureHooksRegistered();

    // Warn for large content (> 10MB)
    if (content.length > TempFileManager.LARGE_FILE_THRESHOLD) {
      logger.warn(
        `[TempFileManager] Writing large temp file: ${content.length} bytes (> ${TempFileManager.LARGE_FILE_THRESHOLD} bytes). Consider increasing maxOutputSize or filtering output.`,
      );
    }

    // Generate unique filename: roy-bot-truncation-{pid}-{uuid}-{prefix}.txt
    const sanitizedPrefix = this.sanitizePrefix(prefix);
    const uuid = crypto.randomUUID();
    const filename = `${TempFileManager.FILE_PREFIX}-${process.pid}-${uuid}-${sanitizedPrefix}${TempFileManager.FILE_EXT}`;

    // Build cross-platform path using os.tmpdir() + path.join
    const filePath = path.join(os.tmpdir(), filename);

    // Write file
    await fs.promises.writeFile(filePath, content, "utf-8");

    // Track for cleanup
    this._files.add(filePath);

    logger.debug(`[TempFileManager] Created temp file: ${filePath} (${content.length} bytes)`);

    return filePath;
  }

  /**
   * Remove all temp files created by this instance.
   *
   * Missing files are silently skipped (no error thrown).
   */
  async cleanupAll(): Promise<void> {
    const files = Array.from(this._files);
    this._files.clear();

    const results = await Promise.allSettled(
      files.map(async (filePath) => {
        try {
          await fs.promises.unlink(filePath);
        } catch (err: any) {
          // ENOENT is OK — file already gone
          if (err.code !== "ENOENT") {
            logger.warn(`[TempFileManager] Failed to delete ${filePath}: ${err.message}`);
          }
        }
      }),
    );

    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    logger.debug(`[TempFileManager] Cleanup complete: ${succeeded}/${files.length} files deleted`);
  }

  /**
   * Get the count of currently tracked temp files.
   *
   * Useful for tests and diagnostics.
   */
  getActiveFileCount(): number {
    return this._files.size;
  }

  /**
   * Sweep stale temp files from previous sessions (older than 24h).
   *
   * Called automatically on first instantiation. Can also be called manually
   * for housekeeping (e.g., on a timer).
   *
   * @param maxAgeMs - Maximum age in milliseconds (default: 24 hours)
   * @returns Number of files deleted
   */
  async sweepStaleFiles(maxAgeMs: number = TempFileManager.STALE_FILE_AGE_MS): Promise<number> {
    const tmpDir = os.tmpdir();
    const now = Date.now();
    let deletedCount = 0;

    let entries: string[];
    try {
      entries = await fs.promises.readdir(tmpDir);
    } catch (err: any) {
      logger.warn(`[TempFileManager] Failed to read tmpdir ${tmpDir}: ${err.message}`);
      return 0;
    }

    for (const entry of entries) {
      if (!entry.startsWith(`${TempFileManager.FILE_PREFIX}-`)) continue;

      const filePath = path.join(tmpDir, entry);
      try {
        const stat = await fs.promises.stat(filePath);
        const age = now - stat.mtimeMs;
        if (age > maxAgeMs) {
          await fs.promises.unlink(filePath);
          deletedCount++;
        }
      } catch (err: any) {
        // ENOENT is OK (race condition with another process)
        if (err.code !== "ENOENT") {
          logger.warn(`[TempFileManager] Failed to sweep ${filePath}: ${err.message}`);
        }
      }
    }

    if (deletedCount > 0) {
      logger.info(`[TempFileManager] Swept ${deletedCount} stale files from ${tmpDir}`);
    }

    return deletedCount;
  }

  /**
   * Ensure process exit hooks are registered (idempotent).
   *
   * Hooks clean up all tracked temp files when the process exits.
   */
  ensureHooksRegistered(): void {
    if (this._hooksRegistered) return;
    if (typeof process === "undefined" || !process.on) {
      // Non-Node environment (e.g., browser) — skip
      return;
    }

    const cleanup = (): void => {
      // Use synchronous unlink in exit handlers (async may not complete)
      for (const filePath of this._files) {
        try {
          fs.unlinkSync(filePath);
        } catch (err: any) {
          // Ignore — file may already be gone
        }
      }
      this._files.clear();
    };

    process.on("exit", cleanup);
    process.on("SIGINT", () => {
      cleanup();
      // Re-raise default behavior
      process.exit(130);
    });
    process.on("SIGTERM", () => {
      cleanup();
      process.exit(143);
    });

    this._hooksRegistered = true;
    logger.debug("[TempFileManager] Process exit hooks registered");
  }

  /**
   * Sanitize the prefix string to be safe for filenames.
   *
   * Removes characters that are problematic on any platform:
   * - Path separators (/, \)
   * - Reserved characters (<, >, :, ", |, ?, *)
   * - Control characters
   * - Spaces (replaced with -)
   */
  private sanitizePrefix(prefix: string): string {
    return prefix
      .replace(/[\/\\<>:"|?*\x00-\x1f]/g, "-")
      .replace(/\s+/g, "-")
      .substring(0, 32) // Limit length
      || "default";
  }
}