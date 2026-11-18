/**
 * @fileoverview Test suite for TaskEventHandler logger routing (Task #2959)
 *
 * ## History
 *
 * - Task #2950 (BAD): tried regex `stripPluginNoise()` to remove
 *   `[TaskEventHandler]` markers from chat output. Band-aid.
 * - Task #2953 (BETTER): moved markers from `console.log` (stdout)
 *   to `console.error` (stderr) so chat plugins that parse stdout
 *   don't see them.
 * - Task #2959 (FINAL): user feedback on #2953:
 *   "我的意思是不用 console.log / console.error，用 logger.info 就好
 *   了，不会输出到 stdout 或 stderr 中"
 *
 *   Even stderr is "polluting" because plugin subprocesses don't
 *   always isolate streams cleanly. The correct fix: route everything
 *   through `logger.info`. Under quiet mode (default in `roy-bot
 *   act`), `logger.info` is silent on console and writes only to the
 *   log file. Under `--no-quiet`, it writes to console on demand.
 *
 * ## What this test pins
 *
 * The handler MUST use the unified logger from
 * `@ai-setting/roy-bot-core` and MUST NOT call `console.log`,
 * `console.error`, or `console.warn` directly with task content.
 *
 *   RED-1: TaskEventHandler.start() and stop() do not call console.*
 *          with `[TaskEventHandler]` markers. (Handler does not
 *          directly invoke console methods.)
 *
 *   RED-2: task.* event handlers do not call console.* with
 *          diagnostic task content.
 *
 *   RED-3: full sweep — every task.* event type + start/stop: zero
 *          console.* calls with task-event-handler content.
 *
 * ## Verification of logger routing
 *
 * We can't easily mock the module-level `createLogger` call (the
 * handler captures the logger instance at import time in a const).
 * Instead we use an indirect verification: the captured-logger
 * helper module is patched at import time so that when the handler
 * calls `createLogger("task-event-handler")`, it returns a fake
 * logger whose `info` calls we record.
 *
 * Test technique: bun's `mock.module()` runs before the handler
 * import; the handler's `import { createLogger } from
 * "@ai-setting/roy-bot-core"` resolves to our mock.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { BaseEnvironment, EnvEvent } from "@ai-setting/roy-bot-core";

// ---------------------------------------------------------------------------
// Captured-logger stub (registered as a module mock before handler import)
// ---------------------------------------------------------------------------

interface CapturedCall {
  level: "info" | "warn" | "error" | "debug";
  message: string;
  data?: unknown;
}

interface CapturedLogger {
  prefix: string;
  calls: CapturedCall[];
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  debug(message: string, data?: unknown): void;
}

const allLoggers: CapturedLogger[] = [];

function makeCapturedLogger(prefix: string): CapturedLogger {
  const calls: CapturedCall[] = [];
  const logger: CapturedLogger = {
    prefix,
    calls,
    info(message, data) { calls.push({ level: "info", message, data }); },
    warn(message, data) { calls.push({ level: "warn", message, data }); },
    error(message, data) { calls.push({ level: "error", message, data }); },
    debug(message, data) { calls.push({ level: "debug", message, data }); },
  };
  allLoggers.push(logger);
  return logger;
}

// Read the actual module to copy over other exports the handler
// doesn't use, then override createLogger.
import * as RoyAgentCore from "@ai-setting/roy-bot-core";
mock.module("@ai-setting/roy-bot-core", () => ({
  __esModule: true,
  ...(RoyAgentCore as any),
  createLogger: (prefix: string) => makeCapturedLogger(prefix),
}));

// Defer handler import so the mock above is in place.
const { TaskEventHandler } = await import("./task-event-handler");

// ---------------------------------------------------------------------------
// Minimal fake environment — `TaskEventHandler` only needs `subscribeAll`.
// ---------------------------------------------------------------------------
function makeFakeEnv(opts: { subscribeAll?: (handler: (e: EnvEvent) => void) => () => void } = {}): BaseEnvironment {
  const subscribeAll = opts.subscribeAll ?? (() => () => {});
  return {
    subscribeAll,
    subscribe: () => () => {},
    publish: () => {},
    notify: () => {},
    emit: () => {},
    on: () => () => {},
    off: () => {},
    once: () => () => {},
    getEnvVar: () => undefined,
    setEnvVar: () => {},
    unsetEnvVar: () => {},
    getConfig: () => ({}),
    getComponent: () => null,
    getWorkingDir: () => "/tmp",
  } as unknown as BaseEnvironment;
}

describe("[Task #2959] TaskEventHandler routes through logger (no console.*)", () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;
  let logCalls: string[];
  let errorCalls: string[];
  let warnCalls: string[];

  // Regex matching anything TaskEventHandler would have printed:
  // lifecycle markers + task.* event log lines + emoji markers.
  // The handler MUST NOT do this directly; it must use logger.info.
  const TASK_HANDLER_CONTENT = /\[TaskEventHandler\]|📝|✏️|✅|🗑️|📋|\[task\./;

  // The handler's logger prefix (created at module load via createLogger).
  const HANDLER_PREFIX = "task-event-handler";

  beforeEach(() => {
    logCalls = [];
    errorCalls = [];
    warnCalls = [];
    logSpy = spyOn(console, "log").mockImplementation((...args: any[]) => {
      logCalls.push(args.map((a) => String(a)).join(" "));
    });
    errorSpy = spyOn(console, "error").mockImplementation((...args: any[]) => {
      errorCalls.push(args.map((a) => String(a)).join(" "));
    });
    warnSpy = spyOn(console, "warn").mockImplementation((...args: any[]) => {
      warnCalls.push(args.map((a) => String(a)).join(" "));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  function getHandlerLogger(): CapturedLogger {
    const handlerLogger = allLoggers.find((l) => l.prefix === HANDLER_PREFIX);
    if (!handlerLogger) {
      throw new Error(`Captured logger with prefix "${HANDLER_PREFIX}" was never created. The handler did not call createLogger().`);
    }
    return handlerLogger;
  }

  it("RED-1: TaskEventHandler.start() invokes logger.info for [TaskEventHandler] Started; never console.*", () => {
    const handlerLogger = getHandlerLogger();
    handlerLogger.calls.length = 0;

    const env = makeFakeEnv();
    const handler = new TaskEventHandler({ env });
    handler.start();

    const infoMessages = handlerLogger.calls
      .filter((c) => c.level === "info")
      .map((c) => c.message);
    expect(infoMessages).toContain("[TaskEventHandler] Started");

    // Console.* must NOT have been called with task-event-handler content
    const all = [...logCalls, ...errorCalls, ...warnCalls];
    const taskInConsole = all.filter((c) => TASK_HANDLER_CONTENT.test(c));
    expect(taskInConsole).toEqual([]);
  });

  it("RED-2: task.created event invokes logger.info (not console.*)", () => {
    const handlerLogger = getHandlerLogger();
    handlerLogger.calls.length = 0;

    let capturedHandler: ((e: EnvEvent) => void) | null = null;
    const env = makeFakeEnv({
      subscribeAll: (h) => {
        capturedHandler = h;
        return () => {};
      },
    });
    const handler = new TaskEventHandler({ env });
    handler.start();
    expect(capturedHandler).not.toBeNull();

    capturedHandler!({
      type: "task.created",
      payload: {
        task: {
          id: 1,
          title: "demo",
          status: "active",
          priority: "medium",
        },
      },
    } as unknown as EnvEvent);

    const infoMessages = handlerLogger.calls
      .filter((c) => c.level === "info")
      .map((c) => c.message);
    expect(infoMessages.some((m) => m.includes("Task created: #1"))).toBe(true);

    const all = [...logCalls, ...errorCalls, ...warnCalls];
    const taskInConsole = all.filter((c) => TASK_HANDLER_CONTENT.test(c));
    expect(taskInConsole).toEqual([]);
  });

  it("RED-3: full sweep — every task.* event type + start/stop: zero console.* calls, all routed through logger.info", () => {
    const handlerLogger = getHandlerLogger();
    handlerLogger.calls.length = 0;

    let capturedHandler: ((e: EnvEvent) => void) | null = null;
    const env = makeFakeEnv({
      subscribeAll: (h) => {
        capturedHandler = h;
        return () => {};
      },
    });
    const handler = new TaskEventHandler({ env });
    handler.start();

    const events: EnvEvent[] = [
      { type: "task.created", payload: { task: { id: 1, title: "a", status: "todo", priority: "low", type: "normal" } } },
      { type: "task.updated", payload: { task: { id: 1, title: "a", status: "active", priority: "low", type: "normal", progress: 50 } } },
      { type: "task.completed", payload: { task: { id: 1, title: "a", progress: 100, updatedAt: "now" } } },
      { type: "task.deleted", payload: { taskId: 1 } },
      { type: "task.operation_added", payload: { taskId: 1, operation: { milestoneType: "create", milestoneTitle: "init", sessionId: "s1" } } },
      { type: "task.delegated", payload: { taskId: 1, backgroundTaskId: 99, subagentType: "general", description: "work" } },
      { type: "task.unknown_future_type", payload: { foo: "bar" } },
    ];

    for (const e of events) {
      capturedHandler!(e as EnvEvent);
    }
    handler.stop();

    // Every event type must have generated at least one logger.info call
    const allInfo = handlerLogger.calls.filter((c) => c.level === "info");
    expect(allInfo.length).toBeGreaterThan(5);

    // Specific assertions: each event type produced a logger.info call
    const messages = allInfo.map((c) => c.message);
    expect(messages.some((m) => m.includes("Task created"))).toBe(true);
    expect(messages.some((m) => m.includes("Task updated"))).toBe(true);
    expect(messages.some((m) => m.includes("Task completed"))).toBe(true);
    expect(messages.some((m) => m.includes("Task deleted"))).toBe(true);
    expect(messages.some((m) => m.includes("Operation added"))).toBe(true);
    expect(messages.some((m) => m.includes("Task delegated"))).toBe(true);
    expect(messages.some((m) => m.includes("[task.unknown_future_type]"))).toBe(true);

    // Strict: NO console.* for task-event-handler content
    const all = [...logCalls, ...errorCalls, ...warnCalls];
    const taskInConsole = all.filter((c) => TASK_HANDLER_CONTENT.test(c));
    expect(taskInConsole).toEqual([]);
  });
});