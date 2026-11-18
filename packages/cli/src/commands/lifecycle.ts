/**
 * @fileoverview Process Lifecycle — Shutdown Handlers (Task #3000)
 *
 * 提供 registerShutdownHandlers(cleanup) 给 roy-bot run / interactive / act / 其他 CLI
 * 子命令注册 SIGINT / SIGTERM graceful shutdown handler。
 *
 * 设计动机：
 * - `roy-bot run` 用 REPL.handleSigint + process.on("SIGINT")（line 2278），
 *   但没注册 SIGTERM，且没 shuttingDown idempotent flag
 * - `roy-bot interactive` 完全没注册 signal handler — Ctrl-C 期间 envService.dispose /
 *   EventSource.stop / TempFileManager.cleanupAll 全部漏掉
 * - 共享 lifecycle helper 让所有 CLI 子命令统一行为
 *
 * 关键设计：
 * 1. **Idempotent**：shuttingDown flag 保证 cleanup 只跑一次，即使收 SIGINT + SIGTERM 多次
 * 2. **Awaited cleanup**：cleanup 是 async，shutdown 会 await 它再 process.exit(0)
 * 3. **Errors don't abort exit**：cleanup 抛错被 logger 捕获，仍 exit(0) — graceful
 * 4. **No-op safety**：cleanup 可选，没传 callback 时仅注册 listeners
 *
 * 测试：lifecycle.test.ts (7 tests, all PASS)
 */

/**
 * ShutdownLogger 接口（duck-typing）— 不依赖具体 logger 库。
 */
export interface ShutdownLogger {
  warn(msg: string): void;
  debug?(msg: string): void;
}

export interface RegisterShutdownOptions {
  /** 用于记录 cleanup 错误（可选，默认 console.error） */
  logger?: ShutdownLogger;
  /** 自定义 exit code（默认 0） */
  exitCode?: number;
  /** 收到信号时的前缀文字（默认 "Cleaning up..."） */
  shutdownMessage?: string;
}

const DEFAULT_LOGGER: ShutdownLogger = {
  warn: (msg: string) => console.error(`[shutdown] ${msg}`),
};

/**
 * Register SIGINT + SIGTERM handlers that invoke `cleanup()` and exit gracefully.
 *
 * @param cleanup - Optional async cleanup callback (LSP dispose / plugin dispose /
 *                  eventSource stop / envService.dispose / TempFileManager.cleanupAll etc.)
 *                  If omitted, the handlers only perform the exit step.
 * @param options - { logger, exitCode, shutdownMessage }
 *
 * @example
 * ```ts
 * registerShutdownHandlers(async () => {
 *   await shutdownRunSteps({ envService, queryExecutor, ... });
 * });
 * ```
 */
export function registerShutdownHandlers(
  cleanup?: () => Promise<void>,
  options: RegisterShutdownOptions = {},
): { dispose: () => void } {
  const logger = options.logger ?? DEFAULT_LOGGER;
  const exitCode = options.exitCode ?? 0;
  const shutdownMessage = options.shutdownMessage ?? "Cleaning up...";

  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      // Already shutting down — second signal is a no-op (idempotent)
      return;
    }
    shuttingDown = true;

    try {
      logger.debug?.(`[${signal}] ${shutdownMessage}`);
    } catch {
      // Ignore logger errors
    }

    if (cleanup) {
      try {
        await cleanup();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          logger.warn(`Cleanup failed: ${message}`);
        } catch {
          // Last-resort fallback — print to stderr directly
          try {
            process.stderr.write(`[shutdown] Cleanup failed: ${message}\n`);
          } catch {
            // give up
          }
        }
      }
    }

    try {
      process.exit(exitCode);
    } catch {
      // In test environments process.exit may throw — fall through
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return {
    dispose: () => {
      process.removeListener("SIGINT", shutdown);
      process.removeListener("SIGTERM", shutdown);
    },
  };
}
