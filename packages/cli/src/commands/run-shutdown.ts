/**
 * @fileoverview Run Shutdown Cleanup Helper (Task #3000)
 *
 * 将 `interactive.ts` 内 `try { ... } finally { ... }` 里的清理逻辑提取为可独立测试的函数，
 * 完整对齐 `interactive-shutdown.ts` 的 7 步标准（Task #1676 Step 7 守护）。
 *
 * 提取原因：
 * - 旧 finally 只清理 3 项（stopEventHandler + stopTaskEventHandler + queryExecutor.dispose）
 * - 漏掉了 lspManagerDispose / pluginAdapterDispose / eventSource.stop / envService.dispose / TempFileManager.cleanupAll
 * - 漏掉了 SIGINT/SIGTERM signal handling（interactive-shutdown 用 onShutdown 兜底）
 * - 提取后有 RED 测试守护 + 可被 lifecycle.ts 共用
 *
 * 设计原则（与 `interactive-shutdown.ts` 一致）：
 * 1. 通过 `deps` 参数注入所有外部依赖，便于测试时 mock
 * 2. 不依赖 process.exit（由 lifecycle.ts registerShutdownHandlers 处理）
 * 3. 单独的步骤失败不应阻断后续清理
 */

import { TempFileManager } from "@ai-setting/roy-bot-core/utils/temp-file-manager";
import type { BaseEnvironment } from "@ai-setting/roy-bot-core";

/**
 * RunCommand 的 shutdown 依赖参数
 *
 * 字段命名注记：与 `interactive-shutdown.ts` 同名约定，避免 shorthand 对象字面量
 * 的 key/value 引用脱钩（bun build renamer 在 helper destructure 中加 `2` 后缀）。
 */
export interface RunShutdownDeps {
  /** LSP Manager 的 dispose 函数（如未启用则为 null） */
  lspManagerDispose: (() => Promise<void>) | null;
  /** PluginAdapter 的 dispose 函数 */
  pluginAdapterDispose: (() => Promise<void>) | null;
  /** EventHandler.stop() 回调 */
  stopEventHandler: () => void;
  /** TaskEventHandler.stop() 回调 */
  stopTaskEventHandler: () => void;
  /** QueryExecutor.dispose() 回调 */
  queryExecutor: { dispose(): void };
  /** 当前环境（用于查询 event-source component） */
  env: BaseEnvironment;
  /** EnvironmentService（仅当 shouldDisposeEnvService=true 时调用 dispose） */
  envService: { dispose(): Promise<void> };
  /** 是否由 run 模块自己创建 envService（外部传入则不 dispose） */
  shouldDisposeEnvService: boolean;
  /** OutputService（用于打印消息，可选） */
  output?: { info(msg: string): void; warn(msg: string): void };
  /** 日志器（duck-typing） */
  logger?: { debug(msg: string): void; warn(msg: string): void };
}

/**
 * 执行 run 模式的所有 shutdown 清理步骤（finally 块调用）。
 *
 * 步骤：
 * 0. 停止 EventHandler + TaskEventHandler（同步）
 * 1. LSP Manager dispose
 * 2. PluginAdapter dispose
 * 3. QueryExecutor.dispose()
 * 4. 停止所有运行中的 EventSource
 * 5. envService.dispose()（如适用）
 * 6. **TempFileManager.cleanupAll()** — 清理 truncation 写入的临时文件
 *
 * 每个步骤独立 try/catch，避免单个失败阻断后续清理。
 */
export async function shutdownRunSteps(deps: RunShutdownDeps): Promise<void> {
  const {
    lspManagerDispose,
    pluginAdapterDispose,
    stopEventHandler,
    stopTaskEventHandler,
    queryExecutor,
    env,
    envService,
    shouldDisposeEnvService,
    output,
    logger,
  } = deps;

  // 0. 停止 EventHandler + TaskEventHandler（同步）
  try {
    stopEventHandler();
  } catch (err) {
    logger?.warn?.(`[Shutdown] EventHandler.stop failed: ${err}`);
  }
  try {
    stopTaskEventHandler();
  } catch (err) {
    logger?.warn?.(`[Shutdown] TaskEventHandler.stop failed: ${err}`);
  }

  // 1. 清理 LSP Manager（关闭所有 LSP 连接和进程）
  if (lspManagerDispose) {
    try {
      await lspManagerDispose();
    } catch (err) {
      logger?.warn?.(`[Shutdown] LSP Manager dispose failed: ${err}`);
    }
  }

  // 2. 清理 PluginAdapter
  if (pluginAdapterDispose) {
    try {
      await pluginAdapterDispose();
    } catch (err) {
      logger?.warn?.(`[Shutdown] PluginAdapter dispose failed: ${err}`);
    }
  }

  // 3. 停止 QueryExecutor（取消环境事件订阅）
  try {
    queryExecutor.dispose();
  } catch (err) {
    logger?.warn?.(`[Shutdown] QueryExecutor.dispose failed: ${err}`);
  }

  // 4. 停止所有运行中的事件源
  try {
    const eventSourceComponent = env.getComponent("event-source") as any;
    if (eventSourceComponent) {
      const sources = eventSourceComponent.list?.();
      if (sources && sources.length > 0) {
        for (const source of sources) {
          const status = eventSourceComponent.getStatus?.(source.id);
          logger?.debug?.(`[Shutdown] 检查事件源: ${source.id}, 状态: ${status}`);

          // 停止任何非 stopped/created 状态的事件源
          if (status !== "stopped" && status !== "created") {
            try {
              await eventSourceComponent.stopSource(source.id);
              output?.info?.(`✓ 已停止事件源: ${source.name} (${status})`);
            } catch (error) {
              output?.warn?.(`⚠️ 停止事件源 ${source.name} 失败: ${error}`);
            }
          }
        }
      }
    }
  } catch (err) {
    logger?.warn?.(`[Shutdown] EventSource cleanup failed: ${err}`);
  }

  // 5. 只在内部创建 envService 时才 dispose
  if (shouldDisposeEnvService) {
    try {
      await envService.dispose();
    } catch (err) {
      logger?.warn?.(`[Shutdown] envService.dispose failed: ${err}`);
    }
  }

  // 6. 清理 TempFileManager 临时文件（truncation 写入 /tmp 的临时文件）
  // 单独 try/catch：即便 cleanupAll 失败，也不能影响其它已完成的清理
  try {
    await TempFileManager.getInstance().cleanupAll();
    logger?.debug?.("[Shutdown] TempFileManager cleaned up");
  } catch (err) {
    logger?.warn?.(`[Shutdown] TempFileManager cleanup failed: ${err}`);
  }
}
