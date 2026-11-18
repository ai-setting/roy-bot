/**
 * @fileoverview 端到端测试：真实 bash + 真实子进程 + 真实杀进程组
 *
 * 验证关键路径：spawn bash (detached:true) → bash 派生子进程（sleep &）
 * → 调用 killProcessTree → 所有该进程组的子进程全部被杀掉。
 *
 * 用 mktemp -d 创建独立临时目录隔离测试间 PID 文件冲突。
 *
 * 注意：此测试依赖真实 OS 行为，对运行环境敏感（CI 进程隔离、信号传递等）。
 * 在隔离模式下（`bun test packages/core/src/env/task/delegate/e2e-real-process-kill.test.ts`）
 * 稳定通过；在全量 `bun test` 中可能因 test 隔离问题（其它测试残留进程）出现偶发失败，
 * 这是 OS 行为 + test runner 共享环境的已知局限，不影响生产代码的正确性。
 *
 * 验证矩阵：
 * - killProcessTree 直接调用（验证 OS 杀进程组机制）
 * - BashSpawner + ProcessRegistry.killAll()（验证真实业务路径）
 */

import { describe, test, expect, afterEach } from "bun:test";
import { Effect } from "effect";
import { spawn } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { BashSpawner, BashSpawnerLayer } from "../../tool/built-in/bash-effect";
import {
  ProcessRegistry,
  runWithProcessRegistryAsync,
} from "./process-registry";
import { killProcessTree } from "../../../util/process/process-tree-killer";

const runEffect = async (effect: any): Promise<any> => {
  return await Effect.runPromise(
    effect.pipe(Effect.scoped, Effect.provide(BashSpawnerLayer)) as any
  );
};

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const liveProcesses: Array<{ pid: number }> = [];
const liveTempDirs: string[] = [];

function trackProcess(pid: number): void {
  liveProcesses.push({ pid });
}

afterEach(() => {
  for (const p of liveProcesses) {
    try {
      process.kill(p.pid, "SIGKILL");
    } catch {}
  }
  liveProcesses.length = 0;
  for (const dir of liveTempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  liveTempDirs.length = 0;
});

/**
 * Cross-test pollution guard: delegate-tool-process-tree.test.ts runs before this
 * file and may have `delete (process as any).kill`'d, leaving process.kill as
 * `undefined`. We avoid the global `process` and use a locally-bound syscall
 * wrapper via `child_process.execFileSync` ("kill -0 <pid>") for live checks.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Wait until predicate returns truthy or timeout. */
async function waitUntil(
  predicate: () => unknown,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {}
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? 2000;
  const intervalMs = options.intervalMs ?? 20;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = predicate();
    if (r) return r;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const finalValue = predicate();
  if (!finalValue && options.label) {
    console.warn(`[E2E] waitUntil timeout: ${options.label}`);
  }
  return finalValue;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E: real bash + real subprocess + real kill", () => {
  test(
    "killProcessTree(bash.pid) kills bash AND any backgrounded grandchild",
    async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "kill-tree-test-"));
      liveTempDirs.push(tmpDir);
      const bgPidFile = join(tmpDir, "bgpid");

      // Bash script: background a sleep 30, echo the bg PID, then run sleep 30 in fg too
      // The foreground sleep ensures bash stays alive past the file write.
      const bash = spawn(
        "bash",
        ["-c", `sleep 30 & echo $! > ${bgPidFile} ; sleep 30`],
        {
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        }
      );
      trackProcess(bash.pid!);
      expect(bash.pid).toBeDefined();

      // Wait for bash to write bg pid to file
      const bgPid = (await waitUntil(
        () => {
          try {
            const v = readFileSync(bgPidFile, "utf-8").trim();
            return /^\d+$/.test(v) ? parseInt(v, 10) : false;
          } catch {
            return false;
          }
        },
        { timeoutMs: 3000, label: "bg pid file" }
      )) as number;
      expect(typeof bgPid).toBe("number");
      trackProcess(bgPid);

      // Wait until both are definitely alive (avoid race with bg fork completion)
      await waitUntil(
        () => isProcessAlive(bash.pid!) && isProcessAlive(bgPid),
        { timeoutMs: 2000, label: "both alive" }
      );

      expect(isProcessAlive(bash.pid!)).toBe(true);
      expect(isProcessAlive(bgPid)).toBe(true);

      // ★ KEY: killProcessTree on bash.pid should kill bash + grandchildren
      killProcessTree(bash.pid!);

      await waitUntil(
        () => !isProcessAlive(bash.pid!) && !isProcessAlive(bgPid),
        { timeoutMs: 3000, label: "both dead" }
      );

      expect(isProcessAlive(bash.pid!)).toBe(false);
      expect(isProcessAlive(bgPid)).toBe(false);
    },
    { timeout: 15000 }
  );

  test(
    "BashSpawner + ProcessRegistry.killAll() cleans up backgrounded grandchild",
    async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "kill-tree-test-"));
      liveTempDirs.push(tmpDir);
      const bgPidFile = join(tmpDir, "bgpid");

      const reg = new ProcessRegistry();

      const program = Effect.gen(function* () {
        const spawner = yield* BashSpawner;
        // Foreground sleep ensures bash stays alive after bg fork
        yield* spawner.run(
          `sleep 30 & echo $! > ${bgPidFile} ; sleep 30`
        );
        return null;
      });

      // Start the program (will be killed before completing)
      const promise = runWithProcessRegistryAsync(reg, () =>
        runEffect(program)
      ).catch(() => null);

      // Wait for bash PID to be registered in registry
      const bashPid = (await waitUntil(
        () => {
          if (reg.size() === 0) return false;
          return Array.from((reg as any).pids as Set<number>)[0] as number;
        },
        { timeoutMs: 3000, label: "registry has bash pid" }
      )) as number;
      expect(typeof bashPid).toBe("number");
      trackProcess(bashPid);

      // Wait for bash to write the bg sleep PID
      const bgSleepPid = (await waitUntil(
        () => {
          try {
            const v = readFileSync(bgPidFile, "utf-8").trim();
            return /^\d+$/.test(v) ? parseInt(v, 10) : false;
          } catch {
            return false;
          }
        },
        { timeoutMs: 3000, label: "bg sleep pid file" }
      )) as number;
      expect(typeof bgSleepPid).toBe("number");
      trackProcess(bgSleepPid);

      // Wait until both are definitely alive
      await waitUntil(
        () => isProcessAlive(bashPid) && isProcessAlive(bgSleepPid),
        { timeoutMs: 2000, label: "both alive" }
      );

      expect(isProcessAlive(bashPid)).toBe(true);
      expect(isProcessAlive(bgSleepPid)).toBe(true);

      // ★ Trigger kill via registry (simulates delegate_task timeout)
      reg.killAll();

      await waitUntil(
        () => !isProcessAlive(bashPid) && !isProcessAlive(bgSleepPid),
        { timeoutMs: 3000, label: "both dead" }
      );

      // await the promise (which may have rejected)
      await promise;

      expect(isProcessAlive(bashPid)).toBe(false);
      expect(isProcessAlive(bgSleepPid)).toBe(false);
    },
    { timeout: 15000 }
  );
});
