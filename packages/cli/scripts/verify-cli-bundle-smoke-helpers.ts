/**
 * @fileoverview Pure helpers for verify-cli-bundle-smoke.ts
 *
 * Extracted from the main smoke script so they can be unit-tested independently
 * via `bun test scripts/verify-cli-bundle-smoke-helpers.test.ts`.
 *
 * What lives here:
 *   - getDefaultSessionDbPath(): derives the real sessions.db path (must match
 *     `packages/core/src/env/session/session-component.ts:getDefaultSessionDbPath`).
 *   - snapshotDbFiles(): captures mtime+size for SQLite's main/wal/shm triplet.
 *   - snapshotsEqual(): compares two snapshots for byte-equality.
 *   - diffDbSnapshot(): human-readable diff of two snapshots (for diagnostics).
 *   - buildIsolatedDbPath(): builds the per-process temp DB path.
 *   - cleanupIsolatedDbFiles(): removes main/wal/shm for a given path.
 *
 * What does NOT live here (intentionally):
 *   - runCli() / process spawning — those need the real CLI binary and
 *     are exercised by the smoke script itself, not by unit tests.
 *   - The orchestrator (runCheck, console output, exit code).
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 计算默认真实 session DB 路径：~/.local/share/roy-bot/sessions.db
 *
 * 必须与 `packages/core/src/env/session/session-component.ts:239`
 * 中 `getDefaultSessionDbPath()` 保持一致；如果未来默认路径变更，
 * 这里也要同步。
 */
export function getDefaultSessionDbPath(
  env: NodeJS.ProcessEnv = process.env
): string {
  const home = env.HOME || env.USERPROFILE || "/tmp";
  return path.join(home, ".local", "share", "roy-bot", "sessions.db");
}

/**
 * SQLite 一组文件 (.db + -wal + -shm) 的 mtime/size 快照。
 *
 * SQLite 即使在 main 文件 mtime 不变的情况下，也会通过 WAL/SHM 写入新数据。
 * 因此必须同时快照这三个文件才能完整判断 DB 是否被"触碰"。
 */
export interface DbFileSnapshot {
  mainMtime: number;
  mainSize: number;
  walMtime: number;
  walSize: number;
  shmMtime: number;
  shmSize: number;
  mainExists: boolean;
  walExists: boolean;
  shmExists: boolean;
}

/**
 * Empty sentinel for a "no file exists" snapshot.
 */
export const EMPTY_DB_SNAPSHOT: DbFileSnapshot = {
  mainMtime: 0,
  mainSize: 0,
  walMtime: 0,
  walSize: 0,
  shmMtime: 0,
  shmSize: 0,
  mainExists: false,
  walExists: false,
  shmExists: false,
};

export function snapshotDbFiles(dbPath: string): DbFileSnapshot {
  const stat = (p: string) => {
    if (!fs.existsSync(p)) {
      return { exists: false, mtime: 0, size: 0 };
    }
    const s = fs.statSync(p);
    return { exists: true, mtime: Math.floor(s.mtimeMs), size: s.size };
  };
  const main = stat(dbPath);
  const wal = stat(dbPath + "-wal");
  const shm = stat(dbPath + "-shm");
  return {
    mainMtime: main.mtime,
    mainSize: main.size,
    walMtime: wal.mtime,
    walSize: wal.size,
    shmMtime: shm.mtime,
    shmSize: shm.size,
    mainExists: main.exists,
    walExists: wal.exists,
    shmExists: shm.exists,
  };
}

export function snapshotsEqual(a: DbFileSnapshot, b: DbFileSnapshot): boolean {
  return (
    a.mainMtime === b.mainMtime &&
    a.mainSize === b.mainSize &&
    a.walMtime === b.walMtime &&
    a.walSize === b.walSize &&
    a.shmMtime === b.shmMtime &&
    a.shmSize === b.shmSize
  );
}

/**
 * Strict check: ONLY main DB file is unchanged.
 *
 * Why this exists:
 *   SQLite WAL mode appends to `-wal`/`-shm` on every write, but the main `.db`
 *   file only changes on a checkpoint. In a dev environment, external agents
 *   routinely touch WAL/SHM (just by holding a connection), causing false
 *   positives if we check those.
 *
 *   The main `.db` file is the strongest signal that an actual write+checkpoint
 *   happened. If `mainMtime` and `mainSize` are both unchanged, we have high
 *   confidence no write+checkpoint occurred during the smoke window.
 *
 *   On a CI runner with no other agents, even checking WAL/SHM works fine.
 *   On a dev machine with other agents running, this stricter-but-stable
 *   variant avoids flakes.
 */
export function mainFilesUnchanged(a: DbFileSnapshot, b: DbFileSnapshot): boolean {
  return a.mainMtime === b.mainMtime && a.mainSize === b.mainSize;
}

/**
 * Human-readable diff of two snapshots.
 * Returns `label` plus per-file lines for any change.
 * If no changes, returns `label\n  (no changes)`.
 */
export function diffDbSnapshot(
  label: string,
  before: DbFileSnapshot,
  after: DbFileSnapshot
): string {
  const lines: string[] = [label];
  const mainSizeChanged = before.mainSize !== after.mainSize;
  const mainMtimeChanged = before.mainMtime !== after.mainMtime;
  const walSizeChanged = before.walSize !== after.walSize;
  const walMtimeChanged = before.walMtime !== after.walMtime;
  const shmSizeChanged = before.shmSize !== after.shmSize;
  const shmMtimeChanged = before.shmMtime !== after.shmMtime;

  if (mainSizeChanged) {
    lines.push(
      `  main:  size ${before.mainSize} → ${after.mainSize}, mtime ${before.mainMtime} → ${after.mainMtime}`
    );
  } else if (mainMtimeChanged) {
    lines.push(
      `  main:  mtime ${before.mainMtime} → ${after.mainMtime} (size unchanged ${before.mainSize})`
    );
  }
  if (walSizeChanged) {
    lines.push(
      `  wal:   size ${before.walSize} → ${after.walSize}, mtime ${before.walMtime} → ${after.walMtime}`
    );
  } else if (walMtimeChanged) {
    lines.push(
      `  wal:   mtime ${before.walMtime} → ${after.walMtime} (size unchanged ${before.walSize})`
    );
  }
  if (shmSizeChanged) {
    lines.push(
      `  shm:   size ${before.shmSize} → ${after.shmSize}, mtime ${before.shmMtime} → ${after.shmMtime}`
    );
  } else if (shmMtimeChanged) {
    lines.push(
      `  shm:   mtime ${before.shmMtime} → ${after.shmMtime} (size unchanged ${before.shmSize})`
    );
  }
  if (
    !mainSizeChanged &&
    !mainMtimeChanged &&
    !walSizeChanged &&
    !walMtimeChanged &&
    !shmSizeChanged &&
    !shmMtimeChanged
  ) {
    lines.push("  (no changes)");
  }
  return lines.join("\n");
}

/**
 * 构造本次 smoke 进程唯一的隔离 session DB 路径。
 *
 * 进程内复用同一路径：act 跑完后临时 DB 自然留在 /tmp 供验证，
 * 下次 smoke 跑时会先清理。如果多次 act check 都用独立路径，会留下多个文件。
 *
 * @param pid - process pid (defaults to current process)
 * @param rand - random suffix (defaults to a fresh random value)
 */
export function buildIsolatedDbPath(
  pid: number = process.pid,
  rand: string = Math.random().toString(36).slice(2, 8)
): string {
  return `/tmp/roy-smoke-sessions-${pid}-${rand}.db`;
}

/**
 * 清理 /tmp/roy-smoke-sessions-*.db 残留（main + wal + shm），
 * 以及指定路径的临时 db 文件。
 *
 * Errors are swallowed (file in use, etc.) — cleanup is best-effort.
 */
export function cleanupIsolatedDbFiles(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      if (fs.existsSync(dbPath + suffix)) {
        fs.unlinkSync(dbPath + suffix);
      }
    } catch {
      // 忽略清理失败（文件被占用等）
    }
  }
}