/**
 * @fileoverview Interactive Shutdown Helper
 *
 * 将 `interactive.ts:createInteractiveCommand` 内部的 `onShutdown` / SIGINT 清理逻辑
 * 提取为可独立测试的函数，同时引入 Step 7 (TempFileManager 临时文件清理)。
 *
 * 设计原则（与现有的 `interactive-event-sources.ts` 一致）：
 * 1. 通过 `deps` 参数注入所有外部依赖，便于测试时 mock
 * 2. 不依赖 process.exit
 * 3. 单独的步骤失败不应阻断后续清理（这是 Step 7 存在的前提）
 *
 * 提取原因：
 * - 旧实现把清理逻辑写在 `createInteractiveCommand` 的闭包里，无法独立测试
 * - 漏掉了 TempFileManager.cleanupAll() → /tmp 累积 159+ 文件
 * - 提取后新增 Step 7 有 RED 测试守护
 */

import type { BaseEnvironment } from "@ai-setting/roy-bot-core";
import { TempFileManager } from "@ai-setting/roy-bot-core/utils/temp-file-manager";
import { CliQuietModeService } from "../services/quiet-mode.service";

/**
 * MemoryPlugin 暴露给 shutdown 的接口（duck-typing 兼容，便于 mock）
 */
export interface MemoryPluginShutdownInstance {
  hasPendingTasks?(): boolean;
  waitForCompletion?(): Promise<void>;
}

/**
 * OutputService 接口（duck-typing）
 */
export interface ShutdownOutputLike {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/**
 * Logger 接口（duck-typing）
 */
export interface ShutdownLoggerLike {
  debug(msg: string): void;
  warn(msg: string): void;
}

/**
 * interactive 模式的 shutdown 依赖参数
 */
export interface InteractiveShutdownDeps {
  /** MemoryPlugin 的 dispose 函数（如未启用则为 null） */
  memoryPluginDispose: (() => Promise<void>) | null;
  /** MemoryPlugin 实例（用于检查是否有待完成任务） */
  memoryPluginInstance: MemoryPluginShutdownInstance | null;
  /** LSP Manager 的 dispose 函数 */
  lspManagerDispose: (() => Promise<void>) | null;
  /** PluginAdapter 的 dispose 函数 */
  pluginAdapterDispose: (() => Promise<void>) | null;
  /** EventHandler（含 .stop()） */
  eventHandler: { stop(): void };
  /** QueryExecutor（含 .dispose()） */
  queryExecutor: { dispose(): void };
  /** 当前环境（用于查询 event-source component） */
  env: BaseEnvironment;
  /** EnvironmentService（仅当 shouldDisposeEnvService=true 时调用 dispose） */
  envService: { dispose(): Promise<void> };
  /** 是否由 interactive 模块自己创建 envService（外部传入则不 dispose） */
  shouldDisposeEnvService: boolean;
  /** OutputService（用于打印消息） */
  output: ShutdownOutputLike;
  /** 日志器 */
  logger: ShutdownLoggerLike;
  /** console 输出（用于记忆保存提示，可选） */
  console?: Pick<Console, "log">;
}

/**
 * 执行 interactive 模式的所有 shutdown 清理步骤。
 *
 * 步骤：
 * 0. MemoryPlugin dispose（等待待处理任务完成）
 * 1. LSP Manager dispose
 * 2. PluginAdapter dispose
 * 3. EventHandler.stop()
 * 4. QueryExecutor.dispose()
 * 5. 停止所有运行中的 EventSource
 * 6. envService.dispose()（如适用）
 * 7. **TempFileManager.cleanupAll()** — 清理 truncation 写入的临时文件
 *
 * 每个步骤独立 try/catch，避免单个失败阻断后续清理。
 */
export async function shutdownInteractiveSteps(
  deps: InteractiveShutdownDeps,
): Promise<void> {
  const {
    memoryPluginDispose,
    memoryPluginInstance,
    lspManagerDispose,
    pluginAdapterDispose,
    eventHandler,
    queryExecutor,
    env,
    envService,
    shouldDisposeEnvService,
    output,
    logger,
    console: consoleLike,
  } = deps;

  const log = (msg: string) => consoleLike?.log?.(msg) ?? console.log(msg);

  // 0. 清理 MemoryPlugin（等待待处理任务完成）
  if (memoryPluginDispose) {
    try {
      if (memoryPluginInstance?.hasPendingTasks?.()) {
        log("💾 正在保存记忆，请稍候...");
        await memoryPluginInstance.waitForCompletion?.();
      }
      await memoryPluginDispose();
      log("💾 记忆已保存完毕");
    } catch (err) {
      logger.warn(`[Shutdown] MemoryPlugin dispose failed: ${err}`);
      output.warn(`⚠️ 记忆保存失败: ${err}`);
    }
  }

  // 1. 清理 LSP Manager（关闭所有 LSP 连接和进程）
  if (lspManagerDispose) {
    try {
      await lspManagerDispose();
    } catch (err) {
      logger.warn(`[Shutdown] LSP Manager dispose failed: ${err}`);
    }
  }

  // 2. 清理 PluginAdapter
  if (pluginAdapterDispose) {
    try {
      await pluginAdapterDispose();
    } catch (err) {
      logger.warn(`[Shutdown] PluginAdapter dispose failed: ${err}`);
    }
  }

  // 3. 停止 EventHandler
  try {
    eventHandler.stop();
  } catch (err) {
    logger.warn(`[Shutdown] EventHandler.stop failed: ${err}`);
  }

  // 4. 停止 QueryExecutor（取消环境事件订阅）
  try {
    queryExecutor.dispose();
  } catch (err) {
    logger.warn(`[Shutdown] QueryExecutor.dispose failed: ${err}`);
  }

  // 5. 停止所有运行中的事件源
  try {
    const eventSourceComponent = env.getComponent("event-source") as any;
    if (eventSourceComponent) {
      const sources = eventSourceComponent.list?.();
      if (sources && sources.length > 0) {
        for (const source of sources) {
          const status = eventSourceComponent.getStatus?.(source.id);
          logger.debug(`[Shutdown] 检查事件源: ${source.id}, 状态: ${status}`);

          // 停止任何非 stopped/created 状态的事件源
          if (status !== "stopped" && status !== "created") {
            try {
              await eventSourceComponent.stopSource(source.id);
              // ★ Task #5117 (M1)：headless 下 [lifecycle] es-stopped
              //   由 run 侧摘要行输出，这里不打 stdout。
              if (!CliQuietModeService.getInstance().isQuiet()) {
                output.info(`✓ 已停止事件源: ${source.name} (${status})`);
              }
            } catch (error) {
              output.warn(`⚠️ 停止事件源 ${source.name} 失败: ${error}`);
            }
          }
        }
      }
    }
  } catch (err) {
    logger.warn(`[Shutdown] EventSource cleanup failed: ${err}`);
  }

  // 6. 只在内部创建 envService 时才 dispose
  if (shouldDisposeEnvService) {
    try {
      await envService.dispose();
    } catch (err) {
      logger.warn(`[Shutdown] envService.dispose failed: ${err}`);
    }
  }

  // 7. 清理 TempFileManager 临时文件（truncation 写入 /tmp 的临时文件）
  // 单独 try/catch：即便 cleanupAll 失败，也不能影响其它已完成的清理
  // （test: shutdownInteractiveSteps - TempFileManager cleanup (Task #1676)）
  try {
    await TempFileManager.getInstance().cleanupAll();
    logger.debug("[Shutdown] TempFileManager cleaned up");
  } catch (err) {
    logger.warn(`[Shutdown] TempFileManager cleanup failed: ${err}`);
  }
}
