/**
 * @fileoverview Lifecycle Shutdown Handler Tests (RED)
 *
 * TDD: 验证 registerShutdownHandlers() 提供给 run/interactive 统一的 SIGINT/SIGTERM
 * graceful shutdown 能力。
 *
 * Task #3000: roy-bot run cleanup hooks 优化
 * - 现状: interactive.ts 用 REPL.handleSigint + process.on("SIGINT")
 * - 现状: run.ts 完全没注册 signal handler, Ctrl-C 期间只剩 Ink default 的 SIGINT
 *         (exitOnCtrlC: true) 但 envService/dispose/eventSource/TempFileManager 全没清
 * - 目标: 提取 registerShutdownHandlers(cleanup) 给 interactive + run 共用
 *
 * RED 阶段验证:
 *   1. registerShutdownHandlers 注册 SIGINT listener
 *   2. registerShutdownHandlers 注册 SIGTERM listener
 *   3. 多次 signal 只触发一次 cleanup (shuttingDown flag)
 *   4. cleanup 抛错也不重复 process.exit
 *   5. cleanup 抛错被 logger 捕获, 仍 exit 0
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  registerShutdownHandlers,
  type ShutdownLogger,
} from "./lifecycle";

describe("registerShutdownHandlers - roy-bot run cleanup hooks (Task #3000)", () => {
  let originalExit: typeof process.exit;
  let originalListeners: {
    SIGINT: Array<(...args: any[]) => void>;
    SIGTERM: Array<(...args: any[]) => void>;
  };
  let exitCalls: number[] = [];
  let consoleOutput: string[] = [];

  beforeEach(() => {
    // Capture original handlers so we can restore them after each test
    originalListeners = {
      SIGINT: process.listeners("SIGINT").slice() as NodeJS.SignalsListener[],
      SIGTERM: process.listeners("SIGTERM").slice() as NodeJS.SignalsListener[],
    };
    // Remove existing listeners (set fresh state)
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");

    // Mock process.exit so we don't kill the test process
    exitCalls = [];
    originalExit = process.exit.bind(process);
    (process as any).exit = (code?: number) => {
      exitCalls.push(code ?? 0);
    };

    // Mock console.error so we capture logs without polluting test output
    consoleOutput = [];
    const origError = console.error.bind(console);
    (console as any).error = (...args: any[]) => {
      consoleOutput.push(args.join(" "));
      // suppress printing
    };
    // Stash original on global for afterEach restore
    (global as any).__origConsoleError = origError;
  });

  afterEach(() => {
    // Restore process.exit
    (process as any).exit = originalExit;

    // Restore console.error
    if ((global as any).__origConsoleError) {
      (console as any).error = (global as any).__origConsoleError;
      delete (global as any).__origConsoleError;
    }

    // Restore original listeners
    for (const listener of originalListeners.SIGINT) {
      process.on("SIGINT", listener);
    }
    for (const listener of originalListeners.SIGTERM) {
      process.on("SIGTERM", listener);
    }
  });

  test("registers SIGINT handler on process", () => {
    const cleanup = async () => {};
    registerShutdownHandlers(cleanup);
    expect(process.listenerCount("SIGINT")).toBeGreaterThanOrEqual(1);
  });

  test("registers SIGTERM handler on process", () => {
    const cleanup = async () => {};
    registerShutdownHandlers(cleanup);
    expect(process.listenerCount("SIGTERM")).toBeGreaterThanOrEqual(1);
  });

  test("cleanup runs exactly once even with multiple SIGINT signals (idempotent)", async () => {
    let cleanupCount = 0;
    const cleanup = async () => {
      cleanupCount++;
    };
    registerShutdownHandlers(cleanup);

    // Emit SIGINT twice — second should be no-op
    process.emit("SIGINT");
    // give async cleanup a tick to run
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.emit("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(cleanupCount).toBe(1);
  });

  test("cleanup runs exactly once even with SIGINT + SIGTERM mix (idempotent)", async () => {
    let cleanupCount = 0;
    const cleanup = async () => {
      cleanupCount++;
    };
    registerShutdownHandlers(cleanup);

    process.emit("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.emit("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.emit("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(cleanupCount).toBe(1);
  });

  test("cleanup error is logged but process still exits 0 (graceful)", async () => {
    const logger: ShutdownLogger = {
      warn: (msg: string) => {
        consoleOutput.push(`[warn] ${msg}`);
      },
    };
    const cleanup = async () => {
      throw new Error("dispose failed");
    };
    registerShutdownHandlers(cleanup, { logger });

    process.emit("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(exitCalls.length).toBe(1);
    expect(exitCalls[0]).toBe(0);
    // Logger should have captured the cleanup error
    const logged = consoleOutput.some((line) => line.includes("dispose failed"));
    expect(logged).toBe(true);
  });

  test("cleanup is awaited before process.exit (graceful shutdown ordering)", async () => {
    let cleanupCompleted = false;
    let exitCalledAfter = false;
    const cleanup = async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      cleanupCompleted = true;
    };
    registerShutdownHandlers(cleanup);

    process.emit("SIGINT");
    // Yield several times to let the microtask queue drain
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (exitCalls.length > 0) {
      exitCalledAfter = cleanupCompleted;
    }

    expect(cleanupCompleted).toBe(true);
    expect(exitCalledAfter).toBe(true);
  });

  test("without cleanup callback, only registers listeners (no-op safety)", () => {
    // Edge case: caller may want signal handler registration only
    registerShutdownHandlers();
    expect(process.listenerCount("SIGINT")).toBeGreaterThanOrEqual(1);
    expect(process.listenerCount("SIGTERM")).toBeGreaterThanOrEqual(1);
  });
});
