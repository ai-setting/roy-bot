/**
 * Bash Spawner - Effect 架构实现
 *
 * 借鉴 opencode 的 Effect/Scope 架构，实现正确的 stdin 生命周期管理。
 *
 * 进程树清理（2026-07 新增）：
 * - POSIX spawn 使用 `detached: true`，让子 shell 拥有独立的进程组（PGID == shell PID），
 *   这样 `process.kill(-shell_pid, SIGKILL)` 才能杀进程组（含孙进程）而不误伤父进程组。
 * - Windows 走 taskkill /F /T 杀进程树，不依赖 detached。
 * - 若当前在 delegate_task 的 ProcessRegistry 作用域内，bash 启动的 child.pid 会
 *   自动注册到 registry；child exit 时自动反注册。当外层 task 超时/stop 时
 *   registry.killAll() 会杀掉所有仍注册的进程（彻底解决"孙进程泄漏"问题）。
 */

import { Effect, Context, Layer } from "effect";
import {
  spawn as _childProcessSpawn,
  type ChildProcess,
  type SpawnOptions,
} from "child_process";

import { killProcessTree } from "../../../util/process/process-tree-killer";
import { getCurrentProcessRegistry } from "../../task/delegate/process-registry";
import { createLogger } from "../../log-trace/logger";

// ----------------------------------------------------------------------------
const logger = createLogger("bash-effect");

// Spawn injection (for tests / alternative runtimes)
// ----------------------------------------------------------------------------

let spawnInjector: typeof _childProcessSpawn | undefined;

export function _setSpawnForTests(s: typeof _childProcessSpawn | undefined): void {
  spawnInjector = s;
}

function spawn(
  command: string,
  args: readonly string[],
  options: SpawnOptions
): ChildProcess {
  if (spawnInjector) {
    return spawnInjector(command, args as string[], options);
  }
  return _childProcessSpawn(command, args as string[], options);
}

// ============================================================================
// Types
// ============================================================================

export interface BashSpawnerOptions {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
}

export interface BashSpawnerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
  timedOut: boolean;
}

// ============================================================================
// Service Definition
// ============================================================================

export const BashSpawner = Context.GenericTag<{
  run(command: string, options?: BashSpawnerOptions): Effect.Effect<BashSpawnerResult>;
}>("BashSpawner");

// ============================================================================
// Implementation
// ============================================================================

// Windows 平台检测
const isWindows = process.platform === "win32";

// SIGKILL 等待时间 (ms)
const SIGKILL_TIMEOUT_MS = 200;

/**
 * 杀死进程树（跨平台）
 */
const killTree = (proc: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void => {
  if (isWindows) {
    spawn("taskkill", ["/pid", String(proc.pid), "/f", "/t"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }

  const pid = proc.pid;
  if (!pid) return;

  try {
    process.kill(-pid, "SIGTERM");
    setTimeout(() => {
      try {
        process.kill(-pid, 0);
        process.kill(-pid, signal);
      } catch {
        // ignore
      }
    }, SIGKILL_TIMEOUT_MS);
  } catch {
    // ignore
  }
};

/**
 * 创建 BashSpawner 实现
 */
const makeBashSpawner = (): {
  run(command: string, options?: BashSpawnerOptions): Effect.Effect<BashSpawnerResult>;
} => {
  return {
    run: (command: string, options?: BashSpawnerOptions): Effect.Effect<BashSpawnerResult> => {
      // Effect.gen 隐式注入 Scope 需求（因 addFinalizer），用 Effect.scoped 提供
      // Scope 即可消除 Effect<A, E, Scope> 中的 Scope 通道，使返回类型符合
      // BashSpawner 接口契约 Effect<A, E, never>。
      return Effect.scoped(Effect.gen(function* () {
        const cwd = options?.cwd;
        const timeout = options?.timeout ?? 60000;
        const env = options?.env ?? {};

        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let child: ChildProcess | null = null;
        let exitResolve: ((code: number) => void) | null = null;
        let exited = false;

        // 构建 spawn 选项
        // - POSIX: detached: true 让子 shell 成为独立进程组 leader（PGID == shell PID），
        //   这样 killProcessTree 用负数 PID 杀整个进程组时不会误伤父进程组，
        //   同时能清理 bash 派生的所有孙进程（sleep &, npm start &, ...）。
        // - Windows: detached 不需要（taskkill /F /T 走进程树遍历），但加上不影响。
        const spawnOpts: SpawnOptions = {
          shell: true,
          cwd,
          env: { ...process.env, ...env },
          stdio: ["pipe", "pipe", "pipe"],
          detached: !isWindows,
        };

        // 创建子进程
        child = spawn(command, [], spawnOpts);

        // 检查进程是否已退出
        const checkExited = (): boolean => exited || !child || !child.pid || child.killed || child.exitCode !== null;

        // ProcessRegistry 集成：若在 delegate_task 的 ALS 作用域内，
        // 把 child.pid 注册到当前 task 的 registry，child exit 时自动反注册。
        // 这样 delegate_task 超时/stop 时 registry.killAll() 能彻底清理孙进程。
        const currentRegistry = getCurrentProcessRegistry();
        if (currentRegistry && child.pid) {
          logger.info(`[bg-process:start] pid=${child.pid} command=${command.slice(0, 80)}`);
          currentRegistry.register(child.pid);
          child.once("exit", (code, signal) => {
            const reason = signal ? `signal=${signal}` : `code=${code}`;
            logger.info(`[bg-process:exit] pid=${child.pid} ${reason}`);
            currentRegistry.unregister(child.pid!);
          });
        }

        // 设置超时
        if (timeout > 0) {
          timer = setTimeout(() => {
            if (!checkExited()) {
              timedOut = true;
              killTree(child!, "SIGKILL");
              // 强制退出
              if (exitResolve) {
                exitResolve(-1);
                exited = true;
              }
            }
          }, timeout);
        }

        // 注册 finalizer 确保进程被清理
        // 升级为 killProcessTree：杀整个进程组（POSIX）/ 进程树（Windows），
        // 防止"bash 退出但孙进程成孤儿"问题。
        yield* Effect.addFinalizer(() => {
          return Effect.sync(() => {
            if (timer) clearTimeout(timer);
            if (!checkExited() && child && child.pid) {
              try {
                killProcessTree(child.pid);
              } catch {
                // killProcessTree 内部已吞掉 ESRCH/EPERM；这里兜底任何意外
              }
            }
          });
        });

        // 收集输出
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];

        child.stdout?.on("data", (data: Buffer) => {
          stdoutChunks.push(data);
        });

        child.stderr?.on("data", (data: Buffer) => {
          stderrChunks.push(data);
        });

        // 使用 Effect.async 等待进程退出
        const exitCode = yield* Effect.async<number, never>((resume) => {
          // ★ 修复竞态条件：子进程可能在 listener 注册前已退出
          // （如 echo 'hello world' 这类瞬间完成的命令）
          if (child!.exitCode !== null) {
            exited = true;
            resume(Effect.succeed(child!.exitCode));
            return;
          }
          if (child!.killed) {
            exited = true;
            resume(Effect.succeed(1));
            return;
          }
          
          exitResolve = (code: number) => {
            if (!exited) {
              exited = true;
              resume(Effect.succeed(code));
            }
          };
          
          child!.on("exit", (code) => {
            if (!exited) {
              exited = true;
              resume(Effect.succeed(code ?? 0));
            }
          });
          child!.on("error", () => {
            if (!exited) {
              exited = true;
              resume(Effect.succeed(1));
            }
          });
        });

        if (timer) clearTimeout(timer);

        stdout = Buffer.concat(stdoutChunks).toString("utf-8");
        stderr = Buffer.concat(stderrChunks).toString("utf-8");

        return {
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: timedOut ? -1 : exitCode,
          success: !timedOut && exitCode === 0,
          timedOut,
        };
      }));
    },
  };
};

// ============================================================================
// Layer
// ============================================================================

export const BashSpawnerLayer = Layer.succeed(BashSpawner, makeBashSpawner());
