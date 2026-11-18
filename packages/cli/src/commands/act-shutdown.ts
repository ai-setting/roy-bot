/**
 * @fileoverview Act Shutdown Cleanup Helper
 *
 * 将 `act.ts` 内 `try { ... } finally { ... }` 里的清理逻辑提取为可独立测试的函数，
 * 并引入 Step 7 (TempFileManager 临时文件清理)。
 *
 * 提取原因：
 * - 旧实现把清理逻辑写在 yargs handler 的闭包里，无法独立测试
 * - 漏掉了 TempFileManager.cleanupAll() → /tmp 累积 159+ 文件
 * - 提取后新增 Step 7 有 RED 测试守护
 */

import { TempFileManager } from "@ai-setting/roy-bot-core/utils/temp-file-manager";

/**
 * Act 模式的 shutdown 依赖参数
 *
 * 字段命名注记：`stopTaskEventHandlerCleanup` 在调用方（act.ts）也是同名局部变量。
 * bun build 的 renamer 在 helper destructure 中会自动加 `2` 后缀（避让 collision），
 * 但 shorthand 对象字面量 `{ stopTaskEventHandlerCleanup }` 的 key/value 引用不会被同步 rename，
 * 会导致 dist 产物的 shorthand/key 与本地变量名脱钩、运行期报 ReferenceError。
 * 解决：保留外部字段名为 `stopTaskEventHandlerCleanup`，destructure 时用 alias 重命名。
 */
export interface ActShutdownDeps {
  /** Task Event Handler 的 stop 回调（如未启用则为 null） */
  stopTaskEventHandlerCleanup: (() => void) | null;
  /** LSP Manager 的 dispose 函数 */
  lspManagerDispose: (() => Promise<void>) | null;
  /** PluginAdapter 的 dispose 函数 */
  pluginAdapterDispose: (() => Promise<void>) | null;
  /** EnvironmentService（仅当 shouldDisposeEnvService=true 时调用 dispose） */
  envService: { dispose(): Promise<void> };
  /** 是否由 act 模块自己创建 envService（外部传入则不 dispose） */
  shouldDisposeEnvService: boolean;
  /** OutputService（用于打印警告，可选） */
  output?: { warn(msg: string): void };
  /** 日志器（duck-typing） */
  logger?: { debug(msg: string): void; warn(msg: string): void };
}

/**
 * 执行 act 模式的所有 shutdown 清理步骤（finally 块调用）。
 *
 * 步骤：
 * 0. 停止 Task Event Handler
 * 1. LSP Manager dispose
 * 2. PluginAdapter dispose
 * 3. envService.dispose()（如适用），**同时调用 process.exit(0)** 主动退出
 * 4. **新增**：TempFileManager.cleanupAll() — 清理 truncation 写入的临时文件
 *
 * 注意：act 是 CLI 一次性命令，envService.dispose() 后会主动调用 process.exit(0)
 * 避免事件循环残留，因此 TempFileManager 清理放在 process.exit 之前作为第 4 步。
 */
export async function runActShutdownCleanup(deps: ActShutdownDeps): Promise<void> {
  const {
    stopTaskEventHandlerCleanup: stopTaskEventHandlerCleanupFn,
    lspManagerDispose,
    pluginAdapterDispose,
    envService,
    shouldDisposeEnvService,
    output,
    logger,
  } = deps;

  const log = logger ?? {
    debug: () => {},
    warn: (msg: string) => console.warn(msg),
  };

  // 0. 停止 Task Event Handler（解构时用 alias 避免与调用方变量名同名，见 export interface 上方注释）
  try {
    if (typeof stopTaskEventHandlerCleanupFn === "function") {
      stopTaskEventHandlerCleanupFn();
    }
  } catch (err) {
    log.warn(`[Act-Shutdown] Task Event Handler stop failed: ${err}`);
  }

  // 1. 清理 LSP Manager（关闭所有 LSP 连接和进程）
  if (lspManagerDispose) {
    try {
      await lspManagerDispose();
    } catch (err) {
      log.warn(`[Act-Shutdown] LSP Manager dispose failed: ${err}`);
    }
  }

  // 2. 清理 PluginAdapter
  if (pluginAdapterDispose) {
    try {
      await pluginAdapterDispose();
    } catch (err) {
      log.warn(`[Act-Shutdown] PluginAdapter dispose failed: ${err}`);
    }
  }

  // 3. 只在内部创建 envService 时才 dispose
  if (shouldDisposeEnvService) {
    try {
      await envService.dispose();
    } catch (err) {
      log.warn(`[Act-Shutdown] envService.dispose failed: ${err}`);
    }
  }

  // 4. 清理 TempFileManager 临时文件（truncation 写入 /tmp 的临时文件）
  // 必须放在 process.exit 之前（exit 会跳过 await）
  // （test: runActShutdownCleanup - TempFileManager cleanup (Task #1676)）
  try {
    await TempFileManager.getInstance().cleanupAll();
    log.debug?.("[Act-Shutdown] TempFileManager cleaned up");
  } catch (err) {
    log.warn(`[Act-Shutdown] TempFileManager cleanup failed: ${err}`);
    if (output) output.warn(`⚠ TempFileManager cleanup failed: ${err}`);
  }

  // CLI 一次性命令：释放 watcher/MCP 句柄后主动退出，避免事件循环残留
  // 仅在内部创建 envService 的情况下主动 exit（外部传入时由调用方决定）
  if (
    shouldDisposeEnvService &&
    typeof process !== "undefined" &&
    process.env.ROY_AGENT_NO_EXIT !== "1"
  ) {
    process.exit(0);
  }
}
