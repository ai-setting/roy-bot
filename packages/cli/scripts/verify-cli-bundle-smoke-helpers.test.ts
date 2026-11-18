/**
 * @fileoverview Unit tests for verify-cli-bundle-smoke-helpers.ts
 *
 * TDD: covers the pure helpers that are too risky to leave untested:
 *   - getDefaultSessionDbPath: must match the production default path
 *   - snapshotDbFiles / mainFilesUnchanged / snapshotsEqual: SQLite triplet
 *     comparison logic
 *   - diffDbSnapshot: human-readable diagnostic output
 *   - buildIsolatedDbPath: temp path shape & uniqueness
 *   - cleanupIsolatedDbFiles: removes main + wal + shm
 *
 * Run via: `bun test packages/cli/scripts/verify-cli-bundle-smoke-helpers.test.ts`
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  buildIsolatedDbPath,
  cleanupIsolatedDbFiles,
  diffDbSnapshot,
  getDefaultSessionDbPath,
  mainFilesUnchanged,
  snapshotDbFiles,
  snapshotsEqual,
  EMPTY_DB_SNAPSHOT,
} from "./verify-cli-bundle-smoke-helpers";

// ============================================================================
// getDefaultSessionDbPath
// ============================================================================

describe("getDefaultSessionDbPath", () => {
  test("uses $HOME when set", () => {
    const fakeHome = "/tmp/fake-home-for-smoke-helper-test";
    const result = getDefaultSessionDbPath({ HOME: fakeHome });
    expect(result).toBe(path.join(fakeHome, ".local", "share", "roy-bot", "sessions.db"));
  });

  test("falls back to $USERPROFILE on Windows-style env", () => {
    const result = getDefaultSessionDbPath({ USERPROFILE: "/c/Users/tester" });
    expect(result).toBe("/c/Users/tester/.local/share/roy-bot/sessions.db");
  });

  test("falls back to /tmp when neither HOME nor USERPROFILE", () => {
    const result = getDefaultSessionDbPath({});
    expect(result).toBe("/tmp/.local/share/roy-bot/sessions.db");
  });

  test("matches production getDefaultSessionDbPath() shape", () => {
    // 该路径必须与 packages/core/src/env/session/session-component.ts:239
    // 中的 getDefaultSessionDbPath() 保持一致。
    const real = getDefaultSessionDbPath();
    expect(real.endsWith("/.local/share/roy-bot/sessions.db")).toBe(true);
  });
});

// ============================================================================
// buildIsolatedDbPath
// ============================================================================

describe("buildIsolatedDbPath", () => {
  test("matches expected template", () => {
    const p = buildIsolatedDbPath(12345, "abc123");
    expect(p).toBe("/tmp/roy-smoke-sessions-12345-abc123.db");
  });

  test("produces unique paths for different rand suffixes", () => {
    const paths = new Set<string>();
    for (let i = 0; i < 50; i++) {
      paths.add(buildIsolatedDbPath(12345, i.toString(36).padStart(6, "0")));
    }
    // 50 unique rand values should produce 50 unique paths
    expect(paths.size).toBe(50);
  });

  test("lives under /tmp", () => {
    expect(buildIsolatedDbPath().startsWith("/tmp/")).toBe(true);
  });

  test("ends in .db", () => {
    expect(buildIsolatedDbPath().endsWith(".db")).toBe(true);
  });

  test("uses random suffix by default (not deterministic)", () => {
    // Two consecutive calls with default args should produce different paths
    // (vanishingly small chance of collision)
    const a = buildIsolatedDbPath();
    const b = buildIsolatedDbPath();
    expect(a).not.toBe(b);
  });
});

// ============================================================================
// snapshotDbFiles / mainFilesUnchanged / snapshotsEqual
// ============================================================================

describe("snapshotDbFiles", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "roy-smoke-helpers-test-"));
    dbPath = path.join(tmpDir, "test.db");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns all zeros for non-existent path", () => {
    const snap = snapshotDbFiles(dbPath);
    expect(snap.mainExists).toBe(false);
    expect(snap.walExists).toBe(false);
    expect(snap.shmExists).toBe(false);
    expect(snap.mainSize).toBe(0);
    expect(snap.walSize).toBe(0);
    expect(snap.shmSize).toBe(0);
    expect(snap).toEqual(EMPTY_DB_SNAPSHOT);
  });

  test("captures main file size + mtime", () => {
    fs.writeFileSync(dbPath, "hello world");
    // Date.now() and fs.statSync().mtimeMs both come from the same clock,
    // but there's no atomic guarantee they share the same tick. Allow ±2 ms
    // tolerance to absorb scheduler jitter.
    const before = Math.floor(Date.now()) - 2;
    const snap = snapshotDbFiles(dbPath);
    const after = Math.floor(Date.now()) + 2;
    expect(snap.mainExists).toBe(true);
    expect(snap.mainSize).toBe(11);
    expect(snap.mainMtime).toBeGreaterThanOrEqual(before);
    expect(snap.mainMtime).toBeLessThanOrEqual(after);
  });

  test("captures wal and shm file sizes when they exist", () => {
    fs.writeFileSync(dbPath, "main");
    fs.writeFileSync(dbPath + "-wal", "wal-data");
    fs.writeFileSync(dbPath + "-shm", "shm-data");
    const snap = snapshotDbFiles(dbPath);
    expect(snap.mainExists).toBe(true);
    expect(snap.walExists).toBe(true);
    expect(snap.shmExists).toBe(true);
    expect(snap.mainSize).toBe(4);
    expect(snap.walSize).toBe(8);
    expect(snap.shmSize).toBe(8);
  });
});

describe("mainFilesUnchanged", () => {
  test("returns true when main mtime+size are equal", () => {
    const a = { ...EMPTY_DB_SNAPSHOT, mainMtime: 100, mainSize: 200 };
    const b = { ...EMPTY_DB_SNAPSHOT, mainMtime: 100, mainSize: 200 };
    expect(mainFilesUnchanged(a, b)).toBe(true);
  });

  test("returns false when main mtime differs (even if size same)", () => {
    const a = { ...EMPTY_DB_SNAPSHOT, mainMtime: 100, mainSize: 200 };
    const b = { ...EMPTY_DB_SNAPSHOT, mainMtime: 101, mainSize: 200 };
    expect(mainFilesUnchanged(a, b)).toBe(false);
  });

  test("returns false when main size differs", () => {
    const a = { ...EMPTY_DB_SNAPSHOT, mainMtime: 100, mainSize: 200 };
    const b = { ...EMPTY_DB_SNAPSHOT, mainMtime: 100, mainSize: 201 };
    expect(mainFilesUnchanged(a, b)).toBe(false);
  });

  test("ignores wal/shm changes (those are noisy on dev machines)", () => {
    const a = { ...EMPTY_DB_SNAPSHOT, mainMtime: 100, mainSize: 200, walMtime: 1, walSize: 1, shmMtime: 1, shmSize: 1 };
    const b = { ...EMPTY_DB_SNAPSHOT, mainMtime: 100, mainSize: 200, walMtime: 999, walSize: 999, shmMtime: 999, shmSize: 999 };
    expect(mainFilesUnchanged(a, b)).toBe(true);
  });
});

describe("snapshotsEqual", () => {
  test("returns true for byte-identical snapshots", () => {
    const snap = { ...EMPTY_DB_SNAPSHOT, mainMtime: 100, mainSize: 200, walMtime: 300, walSize: 400, shmMtime: 500, shmSize: 600 };
    expect(snapshotsEqual(snap, snap)).toBe(true);
  });

  test("returns false when ANY field differs (stricter than mainFilesUnchanged)", () => {
    const a = { ...EMPTY_DB_SNAPSHOT, mainMtime: 100, mainSize: 200, walMtime: 300, walSize: 400, shmMtime: 500, shmSize: 600 };
    const onlyWalDifferent = { ...a, walMtime: 301 };
    expect(snapshotsEqual(a, onlyWalDifferent)).toBe(false);
  });
});

// ============================================================================
// diffDbSnapshot
// ============================================================================

describe("diffDbSnapshot", () => {
  test("reports no changes for identical snapshots", () => {
    const snap = { ...EMPTY_DB_SNAPSHOT };
    const out = diffDbSnapshot("before → after:", snap, snap);
    expect(out).toContain("before → after:");
    expect(out).toContain("(no changes)");
  });

  test("reports main file size change", () => {
    const before = { ...EMPTY_DB_SNAPSHOT, mainMtime: 100, mainSize: 200 };
    const after = { ...EMPTY_DB_SNAPSHOT, mainMtime: 100, mainSize: 300 };
    const out = diffDbSnapshot("real DB diff:", before, after);
    expect(out).toContain("main:  size 200 → 300");
  });

  test("reports wal file size change", () => {
    const before = { ...EMPTY_DB_SNAPSHOT, walMtime: 100, walSize: 200 };
    const after = { ...EMPTY_DB_SNAPSHOT, walMtime: 100, walSize: 300 };
    const out = diffDbSnapshot("real DB diff:", before, after);
    expect(out).toContain("wal:   size 200 → 300");
  });

  test("reports shm file size change", () => {
    const before = { ...EMPTY_DB_SNAPSHOT, shmMtime: 100, shmSize: 200 };
    const after = { ...EMPTY_DB_SNAPSHOT, shmMtime: 100, shmSize: 300 };
    const out = diffDbSnapshot("real DB diff:", before, after);
    expect(out).toContain("shm:   size 200 → 300");
  });

  test("reports mtime change when size is same", () => {
    const before = { ...EMPTY_DB_SNAPSHOT, mainMtime: 100, mainSize: 200 };
    const after = { ...EMPTY_DB_SNAPSHOT, mainMtime: 101, mainSize: 200 };
    const out = diffDbSnapshot("real DB diff:", before, after);
    expect(out).toContain("main:  mtime 100 → 101");
    expect(out).toContain("size unchanged 200");
  });

  test("reports all changed fields together", () => {
    const before = { ...EMPTY_DB_SNAPSHOT, mainMtime: 100, mainSize: 200, walMtime: 100, walSize: 400, shmMtime: 100, shmSize: 600 };
    const after = { ...EMPTY_DB_SNAPSHOT, mainMtime: 999, mainSize: 999, walMtime: 999, walSize: 999, shmMtime: 999, shmSize: 999 };
    const out = diffDbSnapshot("real DB diff:", before, after);
    expect(out).toContain("main:  size 200 → 999");
    expect(out).toContain("wal:   size 400 → 999");
    expect(out).toContain("shm:   size 600 → 999");
  });
});

// ============================================================================
// cleanupIsolatedDbFiles
// ============================================================================

describe("cleanupIsolatedDbFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "roy-smoke-cleanup-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("removes main + wal + shm files", () => {
    const dbPath = path.join(tmpDir, "test.db");
    fs.writeFileSync(dbPath, "main");
    fs.writeFileSync(dbPath + "-wal", "wal");
    fs.writeFileSync(dbPath + "-shm", "shm");

    cleanupIsolatedDbFiles(dbPath);

    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(dbPath + "-wal")).toBe(false);
    expect(fs.existsSync(dbPath + "-shm")).toBe(false);
  });

  test("does not throw when files do not exist (idempotent)", () => {
    const dbPath = path.join(tmpDir, "nonexistent.db");
    // Should not throw
    expect(() => cleanupIsolatedDbFiles(dbPath)).not.toThrow();
  });

  test("does not throw when file exists but is read-only / busy", () => {
    const dbPath = path.join(tmpDir, "readonly.db");
    fs.writeFileSync(dbPath, "data");
    // Make the parent dir read-only so unlink fails on Linux
    fs.chmodSync(tmpDir, 0o555);
    try {
      // Should swallow the error (best-effort cleanup)
      expect(() => cleanupIsolatedDbFiles(dbPath)).not.toThrow();
    } finally {
      fs.chmodSync(tmpDir, 0o755);
    }
  });

  test("only removes the targeted path triplet (not other files)", () => {
    const dbPath = path.join(tmpDir, "test.db");
    const otherPath = path.join(tmpDir, "other.db");
    fs.writeFileSync(dbPath, "main");
    fs.writeFileSync(otherPath, "preserved");
    fs.writeFileSync(otherPath + "-wal", "preserved");

    cleanupIsolatedDbFiles(dbPath);

    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(otherPath)).toBe(true);
    expect(fs.existsSync(otherPath + "-wal")).toBe(true);
  });
});

// ============================================================================
// End-to-end: realistic scenario
// ============================================================================

describe("realistic isolation scenario", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "roy-smoke-e2e-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("mainFilesUnchanged stays true when only wal/shm mtime ticks (external noise)", () => {
    // Simulate: real DB has main + wal + shm. Another process bumps wal/shm
    // mtime but doesn't change main. Our check should pass.
    const realDb = path.join(tmpDir, "real.db");
    fs.writeFileSync(realDb, "real-main-content");
    fs.writeFileSync(realDb + "-wal", "real-wal-content");
    fs.writeFileSync(realDb + "-shm", "real-shm-content");

    const before = snapshotDbFiles(realDb);

    // Simulate external process touching wal/shm mtime
    const future = new Date(Date.now() + 1000);
    fs.utimesSync(realDb + "-wal", future, future);
    fs.utimesSync(realDb + "-shm", future, future);

    const after = snapshotDbFiles(realDb);

    // mainFilesUnchanged should be true (only wal/shm touched)
    expect(mainFilesUnchanged(before, after)).toBe(true);

    // But snapshotsEqual should be false (wal/shm changed)
    expect(snapshotsEqual(before, after)).toBe(false);
  });

  test("mainFilesUnchanged returns false after a real write+checkpoint", () => {
    const realDb = path.join(tmpDir, "real.db");
    fs.writeFileSync(realDb, "initial");
    const before = snapshotDbFiles(realDb);

    // Simulate a real write that grows the main file
    fs.writeFileSync(realDb, "much-larger-content-after-write");

    const after = snapshotDbFiles(realDb);

    expect(mainFilesUnchanged(before, after)).toBe(false);
    expect(after.mainSize).toBeGreaterThan(before.mainSize);
  });
});