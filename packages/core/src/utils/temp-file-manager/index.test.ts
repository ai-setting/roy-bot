import { describe, test, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { TempFileManager } from "./index";

// ========================================================================
// Test Suite: TempFileManager
// ========================================================================

describe("TempFileManager", () => {
  afterEach(async () => {
    // Cleanup all files this manager created
    const manager = TempFileManager.getInstance();
    await manager.cleanupAll();
  });

  // ========================================================================
  // Test 1: writeTempFile creates file and returns path
  // ========================================================================
  test("writeTempFile should create file and return its path", async () => {
    const manager = TempFileManager.getInstance();
    const content = "Hello, world!\n".repeat(100);
    const filePath = await manager.writeTempFile(content, "test-prefix");

    expect(filePath).toBeTruthy();
    expect(filePath).toContain("roy-bot-truncation-");
    expect(filePath).toContain(`${process.pid}-`);
    expect(filePath).toMatch(/\.txt$/);

    // Verify file exists and has correct content
    const written = await fs.promises.readFile(filePath, "utf-8");
    expect(written).toBe(content);
  });

  // ========================================================================
  // Test 2: writeTempFile uses custom prefix in filename
  // ========================================================================
  test("writeTempFile should use custom prefix in filename", async () => {
    const manager = TempFileManager.getInstance();
    const filePath = await manager.writeTempFile("content", "my-tool");

    expect(filePath).toMatch(/roy-bot-truncation-.*\.txt$/);
    expect(path.basename(filePath)).toContain("my-tool");
  });

  // ========================================================================
  // Test 3: cleanupAll removes all tracked files
  // ========================================================================
  test("cleanupAll should remove all tracked files", async () => {
    const manager = TempFileManager.getInstance();

    const file1 = await manager.writeTempFile("content1", "test1");
    const file2 = await manager.writeTempFile("content2", "test2");
    const file3 = await manager.writeTempFile("content3", "test3");

    // All files should exist
    expect(fs.existsSync(file1)).toBe(true);
    expect(fs.existsSync(file2)).toBe(true);
    expect(fs.existsSync(file3)).toBe(true);

    expect(manager.getActiveFileCount()).toBeGreaterThanOrEqual(3);

    await manager.cleanupAll();

    // All files should be gone
    expect(fs.existsSync(file1)).toBe(false);
    expect(fs.existsSync(file2)).toBe(false);
    expect(fs.existsSync(file3)).toBe(false);
    expect(manager.getActiveFileCount()).toBe(0);
  });

  // ========================================================================
  // Test 4: getInstance returns singleton
  // ========================================================================
  test("getInstance should return the same instance", () => {
    const instance1 = TempFileManager.getInstance();
    const instance2 = TempFileManager.getInstance();

    expect(instance1).toBe(instance2);
  });

  // ========================================================================
  // Test 5: process exit hooks are registered
  // ========================================================================
  test("should register process exit hooks", () => {
    // Trigger hook registration
    TempFileManager.getInstance().ensureHooksRegistered();

    // Verify listeners are registered on the process object
    // (the singleton may have registered them earlier; we just verify presence)
    const exitListeners = process.listeners("exit");
    const sigintListeners = process.listeners("SIGINT");
    const sigtermListeners = process.listeners("SIGTERM");

    // At least one of each must be registered
    // (there may be others from other modules, so we just check >= 1)
    expect(exitListeners.length).toBeGreaterThan(0);
    expect(sigintListeners.length).toBeGreaterThan(0);
    expect(sigtermListeners.length).toBeGreaterThan(0);
  });

  // ========================================================================
  // Test 6: Windows path (mock os.tmpdir)
  // ========================================================================
  test("writeTempFile should use os.tmpdir() for cross-platform support (Windows)", async () => {
    // Create a fake Windows-style temp dir
    const fakeWinTmp = path.join(os.tmpdir(), "fake-windows-tmp");
    await fs.promises.mkdir(fakeWinTmp, { recursive: true });

    const spy = vi.spyOn(os, "tmpdir").mockReturnValue(fakeWinTmp);

    try {
      const manager = TempFileManager.getInstance();
      const filePath = await manager.writeTempFile("windows content", "win-test");

      // Path should include the fake Windows tmpdir
      expect(filePath).toContain(fakeWinTmp);
      expect(filePath).toContain("roy-bot-truncation-");

      // File should exist
      expect(fs.existsSync(filePath)).toBe(true);

      // Verify content
      const content = await fs.promises.readFile(filePath, "utf-8");
      expect(content).toBe("windows content");
    } finally {
      spy.mockRestore();
      // Cleanup fake dir
      await fs.promises.rm(fakeWinTmp, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ========================================================================
  // Test 7: macOS path (mock os.tmpdir)
  // ========================================================================
  test("writeTempFile should support macOS tmpdir paths", async () => {
    // Create a fake macOS-style temp dir
    const fakeMacTmp = path.join(os.tmpdir(), "fake-macos-tmp");
    await fs.promises.mkdir(fakeMacTmp, { recursive: true });

    const spy = vi.spyOn(os, "tmpdir").mockReturnValue(fakeMacTmp);

    try {
      const manager = TempFileManager.getInstance();
      const filePath = await manager.writeTempFile("mac content", "mac-test");

      expect(filePath).toContain(fakeMacTmp);
      expect(filePath).toContain("roy-bot-truncation-");
      expect(fs.existsSync(filePath)).toBe(true);

      const content = await fs.promises.readFile(filePath, "utf-8");
      expect(content).toBe("mac content");
    } finally {
      spy.mockRestore();
      // Cleanup fake dir
      await fs.promises.rm(fakeMacTmp, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ========================================================================
  // Test 8: large file warning (> 10MB)
  // ========================================================================
  test("writeTempFile should warn for very large content (> 10MB)", async () => {
    const manager = TempFileManager.getInstance();

    // Create content > 10MB
    const largeContent = "x".repeat(11 * 1024 * 1024);
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const filePath = await manager.writeTempFile(largeContent, "large-test");

    expect(filePath).toBeTruthy();
    expect(consoleWarnSpy).toHaveBeenCalled();
    const warnMessage = String(consoleWarnSpy.mock.calls[0][0]);
    expect(warnMessage.toLowerCase()).toMatch(/large|10mb/i);

    // Verify file size
    const stat = await fs.promises.stat(filePath);
    expect(stat.size).toBe(11 * 1024 * 1024);

    consoleWarnSpy.mockRestore();
  });

  // ========================================================================
  // Test 9: sweepStaleFiles cleans up old files
  // ========================================================================
  test("sweepStaleFiles should clean up old files", async () => {
    // Create a stale file (modify mtime to be old)
    const tmpDir = os.tmpdir();
    const staleFile = path.join(tmpDir, "roy-bot-truncation-99999-stale.txt");
    await fs.promises.writeFile(staleFile, "stale content");

    // Set mtime to 25 hours ago
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await fs.promises.utimes(staleFile, oldTime, oldTime);

    expect(fs.existsSync(staleFile)).toBe(true);

    const manager = TempFileManager.getInstance();
    const sweepedCount = await manager.sweepStaleFiles();

    expect(sweepedCount).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(staleFile)).toBe(false);
  });

  // ========================================================================
  // Test 10: concurrent writes don't conflict
  // ========================================================================
  test("concurrent writeTempFile should not conflict", async () => {
    const manager = TempFileManager.getInstance();

    const promises = Array.from({ length: 10 }, (_, i) =>
      manager.writeTempFile(`content-${i}`, `concurrent-${i}`),
    );

    const paths = await Promise.all(promises);
    const uniquePaths = new Set(paths);

    expect(uniquePaths.size).toBe(10); // All unique

    // All files should exist
    for (const p of paths) {
      expect(fs.existsSync(p)).toBe(true);
    }
  });

  // ========================================================================
  // Test 11: cleanup on missing files should not throw
  // ========================================================================
  test("cleanupAll should not throw on missing files", async () => {
    const manager = TempFileManager.getInstance();

    const filePath = await manager.writeTempFile("data", "test-missing");

    // Manually delete file before cleanup
    await fs.promises.unlink(filePath);

    // Should not throw — assert by reaching the count check
    let threwError: unknown = null;
    try {
      await manager.cleanupAll();
    } catch (err) {
      threwError = err;
    }
    expect(threwError).toBeNull();
    expect(manager.getActiveFileCount()).toBe(0);
  });
});