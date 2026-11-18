/**
 * @fileoverview 跨平台进程树杀进程工具
 *
 * 用于 delegate_task 超时/stop 时彻底清理子 agent 派生的进程树（包括孙进程），
 * 防止端口、文件句柄、孤儿进程泄漏。
 *
 * 平台策略：
 * - POSIX (Linux / macOS)：要求子进程以 `detached: true` + 子进程是进程组 leader，
 *   通过 `process.kill(-pid, signal)` 杀进程组。如果子进程没有 detached（PID 不是负数），退化为直接杀 PID。
 * - Windows：永远用 `taskkill /pid <pid> /f /t` 杀进程树（不依赖 detached）。
 *
 * 验证 + 重试机制：
 * - 每次 kill 后等待 retryDelayMs，用 `process.kill(pid, 0)`（POSIX）或 `tasklist`（Windows）验证进程是否存活
 * - 如果仍存活，重试（最多 retry 次，默认 3 次）
 * - 全部重试完仍存活：记录 error 日志（由外层 process-registry 负责）
 *
 * 多平台代码路径在测试中可通过 `_setPlatformForTests()` 切换。
 */

// Lazy child_process imports — avoids static-import failures when other test files
// use `mock.module("child_process", ...)` with an incomplete mock that omits
// `spawnSync`. Batch 2 fix (Task #2372): the polluting mock in
// `event-source-handlers-builtin.test.ts` only exports `spawn` + `default`,
// which broke any subsequent file that statically imported `spawnSync`
// (e.g. this module → SyntaxError: Export named 'spawnSync' not found).
// The spawn and spawnSync functions are resolved on first use via require().
import type { ChildProcess, SpawnOptions, SpawnSyncOptions, SpawnSyncReturns } from "child_process";
import { createLogger } from "../../env/log-trace/logger";

const logger = createLogger("process-tree-killer");

// Lazy accessor: returns the current (possibly mock.module-replaced) child_process
// at call-time. Required lazily so a polluting mock.module doesn't break this
// module's top-level load (which would crash any test file that imports it).
function getChildProcess(): typeof import("child_process") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("child_process") as typeof import("child_process");
}

// ----------------------------------------------------------------------------
// Spawn injection (for tests / alternative runtimes)
// ----------------------------------------------------------------------------

type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;

let spawnInjector: SpawnFn | undefined;

export function _setSpawnForTests(s: SpawnFn | undefined): void {
  spawnInjector = s;
}

function spawn(cmd: string, args: string[], opts: SpawnOptions): ChildProcess {
  if (spawnInjector) return spawnInjector(cmd, args, opts);
  return getChildProcess().spawn(cmd, args, opts);
}

// ----------------------------------------------------------------------------
// SpawnSync injection (for tests / alternative runtimes)
// ----------------------------------------------------------------------------

type SpawnSyncFn = (cmd: string, args: string[], opts: SpawnSyncOptions) => SpawnSyncReturns<Buffer | string>;

let spawnSyncInjector: SpawnSyncFn | undefined;

export function _setSpawnSyncForTests(s: SpawnSyncFn | undefined): void {
  spawnSyncInjector = s;
}

function spawnSyncFn(
  cmd: string,
  args: string[],
  opts: SpawnSyncOptions
): SpawnSyncReturns<Buffer | string> | undefined {
  if (spawnSyncInjector) return spawnSyncInjector(cmd, args, opts);
  const cp = getChildProcess();
  if (typeof cp.spawnSync !== "function") {
    // Defensive: if a mock.module omits spawnSync (cross-file test pollution),
    // fall back so we don't crash with SyntaxError. Caller treats undefined
    // return as "unknown alive" → retry conservatively.
    return undefined;
  }
  return cp.spawnSync(cmd, args, opts);
}

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface KillProcessTreeOptions {
  /** 信号类型（仅 POSIX）。默认 SIGKILL */
  signal?: NodeJS.Signals;
  /** 已废弃字段，保留以兼容早期 API。SIGKILL 默认立即生效 */
  gracefulTimeoutMs?: number;
  /** 最大重试次数（默认 3） */
  retry?: number;
  /** 重试间隔（ms，默认 500） */
  retryDelayMs?: number;
}

/** 杀进程结果 */
export interface KillProcessTreeResult {
  /** 杀掉的进程 ID */
  pid: number;
  /** 使用的平台策略 */
  platform: NodeJS.Platform;
  /** 实际发出的信号（POSIX）或命令（Windows） */
  signal: string;
  /** 是否成功（不一定准确，例如 POSIX 中 ESRCH 被忽略视为软成功） */
  success: boolean;
  /** 实际尝试次数 */
  attempts: number;
  /** 最后一次尝试后进程是否仍存活（true=没杀干净） */
  stillAlive: boolean;
}

/**
 * 内部 helper 返回类型：不含 stillAlive（由主函数决定）
 */
interface KillAttemptResult {
  pid: number;
  platform: NodeJS.Platform;
  signal: string;
  success: boolean;
}

// ----------------------------------------------------------------------------
// Platform override (for testing only)
// ----------------------------------------------------------------------------

let platformOverride: NodeJS.Platform | undefined;

export function _setPlatformForTests(p: NodeJS.Platform): void {
  platformOverride = p;
}

export function _resetPlatformForTests(): void {
  platformOverride = undefined;
}

function currentPlatform(): NodeJS.Platform {
  return platformOverride ?? process.platform;
}

// ----------------------------------------------------------------------------
// Verification helpers
// ----------------------------------------------------------------------------

/**
 * POSIX: 用 `process.kill(pid, 0)` 验证进程是否存活。
 * - 无错误 / EPERM → 进程存活
 * - ESRCH → 进程已死
 */
function isProcessAlivePosix(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true; // no error → alive
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return false; // ESRCH → dead
    }
    // EPERM or other errors → process exists (alive)
    return true;
  }
}

/**
 * Windows: 用 `tasklist /fi "PID eq <pid>" /nh` 验证进程是否存活。
 * 使用 spawnSync 同步等待输出（spawn 是异步的，之前导致永远返回 true）。
 * - stdout 含 PID 号 → 存活
 * - stdout 不含 PID → 已死
 * - spawnSync 异常 → 保守视为存活（不应 block retry）
 */
function isProcessAliveWindows(pid: number): boolean {
  try {
    const result = spawnSyncFn(
      "tasklist",
      ["/fi", `PID eq ${pid}`, "/nh"],
      {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        timeout: 3000,
      }
    );
    // Defensive: spawnSyncFn may return undefined if child_process is mocked
    // without spawnSync (cross-file test pollution). Treat as "unknown alive"
    // so retry logic conservatively continues — same semantics as catch block.
    if (!result) return true;
    return result.stdout.toString().includes(String(pid));
  } catch {
    return true; // 保守：获取信息失败就当还活着
  }
}

// ----------------------------------------------------------------------------
// Delay helper
// ----------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

/**
 * 杀进程树（跨平台）。不会 throw；ESRCH / EPERM 等"进程已不存在"类错误静默忽略。
 *
 * 验证 + 重试：
 * - 每次 kill 后等待 retryDelayMs（默认 500ms）
 * - 用 `process.kill(pid, 0)`（POSIX）或 `tasklist`（Windows）验证进程是否存活
 * - 如果仍存活，重试（最多 retry 次，默认 3 次）
 * - 全部重试完仍存活：通过 stillAlive: true 返回，由外层记录 error 日志
 *
 * POSIX 默认使用 SIGKILL 杀进程组，要求子进程 spawn 时带 `detached: true`。
 * Windows 调用 `taskkill /f /t` 杀进程树（不依赖 detached）。
 *
 * @param pid 进程 PID（必须为正整数）
 * @param options 可选项
 */
export async function killProcessTree(
  pid: number,
  options?: KillProcessTreeOptions
): Promise<KillProcessTreeResult> {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid PID: ${pid} (must be a positive integer)`);
  }

  const platform = currentPlatform();
  const signal = options?.signal ?? "SIGKILL";
  const maxRetries = options?.retry ?? 3;
  const retryDelayMs = options?.retryDelayMs ?? 500;

  logger.info(`[bg-process:kill-begin] pid=${pid} signal=${signal} retry=${maxRetries} delayMs=${retryDelayMs}`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Step 1: Kill
    const attemptResult: KillAttemptResult =
      platform === "win32"
        ? doKillOnWindows(pid)
        : doKillOnPosix(pid, signal, platform as NodeJS.Platform);

    // Step 2: Wait for kill to take effect before verifying
    await delay(retryDelayMs);

    // Step 3: Verify
    const alive =
      platform === "win32"
        ? isProcessAliveWindows(pid)
        : isProcessAlivePosix(pid);

    if (!alive) {
      logger.info(`[bg-process:kill-done] pid=${pid} attempts=${attempt} stillAlive=false`);
      return {
        pid,
        platform,
        signal: attemptResult.signal,
        success: true,
        attempts: attempt,
        stillAlive: false,
      };
    }

    // Process still alive after attempt
    if (attempt < maxRetries) {
      logger.warn(`[bg-process:kill-retry] pid=${pid} attempt=${attempt}/${maxRetries}`);
    }
  }

  // All retries exhausted, process still alive
  logger.error(`[bg-process:kill-failed] pid=${pid} attempts=${maxRetries} stillAlive=true`);
  return {
    pid,
    platform,
    signal: platform === "win32" ? "taskkill /f /t" : signal,
    success: false,
    attempts: maxRetries,
    stillAlive: true,
  };
}

// ----------------------------------------------------------------------------
// Kill implementations (synchronous — do not include retry logic)
// ----------------------------------------------------------------------------

function doKillOnWindows(pid: number): KillAttemptResult {
  try {
    spawn("taskkill", ["/pid", String(pid), "/f", "/t"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return {
      pid,
      platform: "win32",
      signal: "taskkill /f /t",
      success: true,
    };
  } catch {
    return {
      pid,
      platform: "win32",
      signal: "taskkill /f /t",
      success: false,
    };
  }
}

function doKillOnPosix(
  pid: number,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform
): KillAttemptResult {
  try {
    process.kill(-pid, signal);
    return {
      pid,
      platform,
      signal,
      success: true,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH" || code === "EPERM") {
      return {
        pid,
        platform,
        signal,
        success: true, // soft success
      };
    }
    return {
      pid,
      platform,
      signal,
      success: false,
    };
  }
}
