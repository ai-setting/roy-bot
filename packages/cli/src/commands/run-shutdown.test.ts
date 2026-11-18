/**
 * @fileoverview Run Shutdown Tests (RED → GREEN)
 *
 * TDD: 验证 run 模式的 finally 清理块正确调用所有 shutdown 步骤，特别是
 * TempFileManager.cleanupAll()（对齐 interactive-shutdown.ts Step 7 + act-shutdown.ts Step 4）。
 *
 * Task #3000: roy-bot run cleanup hooks 优化
 */

import { describe, test, expect, vi } from "bun:test";
import { shutdownRunSteps, type RunShutdownDeps } from "./run-shutdown";

/**
 * 用真实的 TempFileManager 写 N 个临时文件
 */
async function writeTempFiles(prefix: string, count: number): Promise<string[]> {
  const { TempFileManager } = await import(
    "@ai-setting/roy-bot-core/utils/temp-file-manager"
  );
  const manager = TempFileManager.getInstance();
  const files: string[] = [];
  for (let i = 0; i < count; i++) {
    const filePath = await manager.writeTempFile(
      `[run shutdown test ${i}] some content`,
      `${prefix}-${i}`,
    );
    files.push(filePath);
  }
  return files;
}

/**
 * 构造 minimal RunShutdownDeps
 */
function createMinimalRunShutdownDeps(
  overrides: Partial<RunShutdownDeps> = {},
): RunShutdownDeps {
  return {
    lspManagerDispose: null,
    pluginAdapterDispose: null,
    stopEventHandler: vi.fn(),
    stopTaskEventHandler: vi.fn(),
    queryExecutor: { dispose: vi.fn() },
    env: { getComponent: vi.fn() } as any,
    envService: { dispose: async () => {} },
    shouldDisposeEnvService: false,
    output: { info: () => {}, warn: () => {} } as any,
    logger: { debug: () => {}, warn: () => {} } as any,
    ...overrides,
  };
}

describe("shutdownRunSteps - cleanup hooks (Task #3000)", () => {
  test("Step 0: stopEventHandler is called", async () => {
    const stopEventHandler = vi.fn();
    const deps = createMinimalRunShutdownDeps({ stopEventHandler });
    await shutdownRunSteps(deps);
    expect(stopEventHandler).toHaveBeenCalledTimes(1);
  });

  test("Step 0: stopTaskEventHandler is called", async () => {
    const stopTaskEventHandler = vi.fn();
    const deps = createMinimalRunShutdownDeps({ stopTaskEventHandler });
    await shutdownRunSteps(deps);
    expect(stopTaskEventHandler).toHaveBeenCalledTimes(1);
  });

  test("Step 1: lspManagerDispose is called when provided", async () => {
    const lspManagerDispose = vi.fn(async () => {});
    const deps = createMinimalRunShutdownDeps({ lspManagerDispose });
    await shutdownRunSteps(deps);
    expect(lspManagerDispose).toHaveBeenCalledTimes(1);
  });

  test("Step 2: pluginAdapterDispose is called when provided", async () => {
    const pluginAdapterDispose = vi.fn(async () => {});
    const deps = createMinimalRunShutdownDeps({ pluginAdapterDispose });
    await shutdownRunSteps(deps);
    expect(pluginAdapterDispose).toHaveBeenCalledTimes(1);
  });

  test("Step 3: queryExecutor.dispose() is called", async () => {
    const dispose = vi.fn();
    const deps = createMinimalRunShutdownDeps({
      queryExecutor: { dispose } as any,
    });
    await shutdownRunSteps(deps);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("Step 5: envService.dispose() is called when shouldDisposeEnvService=true", async () => {
    const envServiceDispose = vi.fn(async () => {});
    const deps = createMinimalRunShutdownDeps({
      envService: { dispose: envServiceDispose } as any,
      shouldDisposeEnvService: true,
    });
    await shutdownRunSteps(deps);
    expect(envServiceDispose).toHaveBeenCalledTimes(1);
  });

  test("Step 5: envService.dispose() is NOT called when shouldDisposeEnvService=false", async () => {
    const envServiceDispose = vi.fn(async () => {});
    const deps = createMinimalRunShutdownDeps({
      envService: { dispose: envServiceDispose } as any,
      shouldDisposeEnvService: false,
    });
    await shutdownRunSteps(deps);
    expect(envServiceDispose).not.toHaveBeenCalled();
  });

  test("Step 6: TempFileManager.cleanupAll() removes all temp files", async () => {
    // Arrange: 写 3 个真实临时文件
    const files = await writeTempFiles("run-shutdown-test", 3);

    // sanity check
    const { existsSync } = await import("node:fs");
    for (const f of files) {
      expect(existsSync(f)).toBe(true);
    }

    const deps = createMinimalRunShutdownDeps();
    await shutdownRunSteps(deps);

    // 清理后所有临时文件应被删除
    for (const f of files) {
      expect(existsSync(f)).toBe(false);
    }
  });

  test("Step 4: EventSource.stopSource is called for running sources", async () => {
    const stopSource = vi.fn(async () => {});
    const getStatus = vi.fn((id: string) => "running");
    const eventSourceComponent = {
      list: () => [{ id: "es-1", name: "test-source" }],
      getStatus,
      stopSource,
    };
    const env = {
      getComponent: vi.fn((name: string) =>
        name === "event-source" ? eventSourceComponent : null,
      ),
    } as any;

    const deps = createMinimalRunShutdownDeps({ env });
    await shutdownRunSteps(deps);

    expect(stopSource).toHaveBeenCalledWith("es-1");
  });

  test("Step 4: EventSource.stopSource is NOT called for already-stopped sources", async () => {
    const stopSource = vi.fn(async () => {});
    const eventSourceComponent = {
      list: () => [{ id: "es-1", name: "test-source" }],
      getStatus: () => "stopped",
      stopSource,
    };
    const env = {
      getComponent: () => eventSourceComponent,
    } as any;

    const deps = createMinimalRunShutdownDeps({ env });
    await shutdownRunSteps(deps);

    expect(stopSource).not.toHaveBeenCalled();
  });

  test("All steps continue even if one fails (resilience)", async () => {
    const stopEventHandler = vi.fn(() => {
      throw new Error("EventHandler.stop failed");
    });
    const lspManagerDispose = vi.fn(async () => {});
    const pluginAdapterDispose = vi.fn(async () => {});
    const dispose = vi.fn();
    const envServiceDispose = vi.fn(async () => {});

    const deps = createMinimalRunShutdownDeps({
      stopEventHandler,
      lspManagerDispose,
      pluginAdapterDispose,
      queryExecutor: { dispose } as any,
      envService: { dispose: envServiceDispose } as any,
      shouldDisposeEnvService: true,
    });

    // 不应抛出
    await expect(shutdownRunSteps(deps)).resolves.toBeUndefined();

    // 后续步骤仍应执行
    expect(lspManagerDispose).toHaveBeenCalledTimes(1);
    expect(pluginAdapterDispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(envServiceDispose).toHaveBeenCalledTimes(1);
  });
});
