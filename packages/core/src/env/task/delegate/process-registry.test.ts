/**
 * @fileoverview ProcessRegistry TDD tests
 *
 * 每个 delegate_task 实例持有一个 ProcessRegistry，跟踪该 task 派生的所有子进程 PID。
 * 当 task 超时/stop 时遍历注册表对每个 PID 调用 killProcessTree。
 *
 * AsyncLocalStorage 隔离：每个 task 的 ProcessRegistry 通过 runWithProcessRegistryAsync
 * 进入异步作用域；bash 工具内部可以从 ALS 拿当前 registry 并 register 自己的 child.pid。
 *
 * v2: killAll() 改为 async（因 killProcessTree 改为 async）
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  ProcessRegistry,
  getCurrentProcessRegistry,
  runWithProcessRegistryAsync,
} from "./process-registry";

import {
  _setPlatformForTests,
  _setSpawnForTests,
  _setSpawnSyncForTests,
  _resetPlatformForTests,
} from "../../../util/process/process-tree-killer";

// Global mocks (killProcessTree delegates to these)
const spawnedCalls: Array<{ cmd: string; args: string[]; opts: any }> = [];
const mockSpawn = ((_cmd: string, args: string[], opts: any) => {
  spawnedCalls.push({ cmd: _cmd, args, opts });
  return { pid: 99999, unref: () => {} } as any;
}) as any;

// Track SIGKILL/SIGTERM calls (not verification signal 0)
const killCalls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
const mockKill = ((pid: number, signal: any) => {
  // signal 0 is the verification probe → ESRCH = dead (prevents retries)
  if (signal === 0) {
    const err = new Error("ESRCH") as NodeJS.ErrnoException;
    err.code = "ESRCH";
    throw err;
  }
  killCalls.push({ pid, signal });
}) as any;

// Mock spawnSync for Windows verification (returns empty → process not found)
const mockSpawnSync = ((_cmd: string, _args: string[], _opts: any) => {
  return {
    stdout: Buffer.from(""),
    stderr: Buffer.from(""),
    status: 0,
    signal: null,
    pid: 0,
    output: [Buffer.from("")],
  } as any;
}) as any;

// ★ Save original process.kill so we can restore it (NOT delete — delete causes
// cross-file pollution when bun test reuses the same Node process across test files).
const originalProcessKill = process.kill.bind(process);

beforeEach(() => {
  _setPlatformForTests("linux");
  _setSpawnForTests(mockSpawn);
  _setSpawnSyncForTests(mockSpawnSync);
  spawnedCalls.length = 0;
  killCalls.length = 0;
  (process as any).kill = mockKill;
});

afterEach(() => {
  _resetPlatformForTests();
  _setSpawnForTests(undefined);
  _setSpawnSyncForTests(undefined);
  // ★ Restore (not delete) to avoid cross-file pollution breaking subsequent tests
  (process as any).kill = originalProcessKill;
});

describe("ProcessRegistry", () => {
  describe("register/unregister", () => {
    test("starts with empty registry", () => {
      const reg = new ProcessRegistry();
      expect(reg.size()).toBe(0);
    });

    test("register adds a PID", () => {
      const reg = new ProcessRegistry();
      reg.register(123);
      expect(reg.size()).toBe(1);
    });

    test("register is idempotent (duplicates are absorbed)", () => {
      const reg = new ProcessRegistry();
      reg.register(123);
      reg.register(123);
      reg.register(123);
      expect(reg.size()).toBe(1);
    });

    test("unregister removes a registered PID", () => {
      const reg = new ProcessRegistry();
      reg.register(123);
      reg.unregister(123);
      expect(reg.size()).toBe(0);
    });

    test("unregister is silent for unknown PID", () => {
      const reg = new ProcessRegistry();
      expect(() => reg.unregister(999)).not.toThrow();
      expect(reg.size()).toBe(0);
    });

    test("handles many PIDs", () => {
      const reg = new ProcessRegistry();
      for (let i = 100; i < 200; i++) reg.register(i);
      expect(reg.size()).toBe(100);
      reg.unregister(150);
      expect(reg.size()).toBe(99);
    });
  });

  describe("killAll", () => {
    test("calls killProcessTree for every PID", async () => {
      const reg = new ProcessRegistry();
      reg.register(1111);
      reg.register(2222);
      reg.register(3333);
      await reg.killAll();

      // Each PID: 1 kill call (signal 0 verification throws ESRCH → dead → 1 attempt)
      expect(killCalls.length).toBe(3);
      // PID sent as negative (process group)
      expect(killCalls[0]).toEqual({ pid: -1111, signal: "SIGKILL" });
      expect(killCalls[1]).toEqual({ pid: -2222, signal: "SIGKILL" });
      expect(killCalls[2]).toEqual({ pid: -3333, signal: "SIGKILL" });
    });

    test("clears registry after killAll (no double-kill)", async () => {
      const reg = new ProcessRegistry();
      reg.register(1111);
      await reg.killAll();
      await reg.killAll();
      expect(killCalls.length).toBe(1);
      expect(reg.size()).toBe(0);
    });

    test("killAll on empty registry is a no-op", async () => {
      const reg = new ProcessRegistry();
      await reg.killAll();
      expect(killCalls.length).toBe(0);
    });

    test("killAll uses Windows strategy on win32 platform", async () => {
      _setPlatformForTests("win32");
      const reg = new ProcessRegistry();
      reg.register(4444);
      await reg.killAll();

      // Should spawn taskkill (no SIGKILL). Windows verification uses tasklist spawn.
      expect(killCalls.length).toBe(0);
      // At least 1 taskkill call (may have retries via tasklist verification)
      const taskkillCalls = spawnedCalls.filter((c) => c.cmd === "taskkill");
      expect(taskkillCalls.length).toBeGreaterThanOrEqual(1);
      expect(taskkillCalls[0].args).toContain("4444");
    });

    test("killAll silently skips PIDs that throw ESRCH on kill", async () => {
      // Custom mock: PID 2222 throws ESRCH on kill, signal 0 also throws ESRCH (dead)
      (process as any).kill = ((pid: number, _s: any) => {
        if (_s === 0) {
          const err = new Error("ESRCH") as NodeJS.ErrnoException;
          err.code = "ESRCH";
          throw err;
        }
        if (pid === -2222) {
          const err = new Error("esrch") as NodeJS.ErrnoException;
          err.code = "ESRCH";
          throw err;
        }
        killCalls.push({ pid, signal: _s });
      }) as any;

      const reg = new ProcessRegistry();
      reg.register(1111);
      reg.register(2222);
      await reg.killAll();
      // PID 1111: kill recorded, PID 2222: ESRCH caught (not recorded)
      // Filter to only our PIDs to avoid cross-test pollution from BackgroundTaskManager timeouts
      const ourKillCalls = killCalls.filter((c) => c.pid === -1111 || c.pid === -2222);
      expect(ourKillCalls.length).toBe(1);
      expect(ourKillCalls[0].pid).toBe(-1111);
    });
  });

  describe("AsyncLocalStorage (ALS) integration", () => {
    test("getCurrentProcessRegistry returns undefined outside any scope", () => {
      expect(getCurrentProcessRegistry()).toBeUndefined();
    });

    test("runWithProcessRegistryAsync makes the registry visible inside fn", async () => {
      const reg = new ProcessRegistry();
      let captured: ProcessRegistry | undefined;
      await runWithProcessRegistryAsync(reg, async () => {
        captured = getCurrentProcessRegistry();
        return undefined;
      });
      expect(captured).toBe(reg);
    });

    test("registry is invisible outside the scope", async () => {
      const reg = new ProcessRegistry();
      await runWithProcessRegistryAsync(reg, async () => {});
      expect(getCurrentProcessRegistry()).toBeUndefined();
    });

    test("nested scopes don't leak between siblings", async () => {
      const reg1 = new ProcessRegistry();
      const reg2 = new ProcessRegistry();

      let captured1: ProcessRegistry | undefined;
      let captured2: ProcessRegistry | undefined;
      let outsideScope: ProcessRegistry | undefined;

      await runWithProcessRegistryAsync(reg1, async () => {
        captured1 = getCurrentProcessRegistry();
        await runWithProcessRegistryAsync(reg2, async () => {
          captured2 = getCurrentProcessRegistry();
        });
        // After inner scope ends, outer should see reg1 again
        outsideScope = getCurrentProcessRegistry();
      });

      expect(captured1).toBe(reg1);
      expect(captured2).toBe(reg2);
      expect(outsideScope).toBe(reg1);
    });
  });

  describe("integration with killProcessTree", () => {
    test("register + unregister pattern works for normal lifecycle", async () => {
      const reg = new ProcessRegistry();
      reg.register(1111);
      reg.register(2222);
      expect(reg.size()).toBe(2);
      reg.unregister(1111);
      expect(reg.size()).toBe(1);
      await reg.killAll();
      expect(reg.size()).toBe(0);
      expect(killCalls.length).toBe(1);
      expect(killCalls[0].pid).toBe(-2222);
    });
  });
});
