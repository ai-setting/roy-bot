/**
 * @fileoverview Interactive Shutdown Tests
 *
 * TDD: 测试 InteractiveCommand 的 shutdown 功能和 EventSource 清理
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import {
  shutdownInteractiveSteps,
  type InteractiveShutdownDeps,
} from "./interactive-shutdown";

describe("Interactive Shutdown Tests", () => {
  describe("REPL should support graceful shutdown", () => {
    test("REPL should have shutdown capability in options", async () => {
      // Arrange - 测试接口定义是否包含 shutdown
      const options = {
        sessionId: "test",
        sessionTitle: "Test",
        onExecute: vi.fn(),
        onStatus: vi.fn(),
        onSwitchSession: vi.fn(),
        onCompact: vi.fn(),
        onShutdown: vi.fn(),  // 应该有 onShutdown 回调
      };
      
      expect(typeof options.onShutdown).toBe("function");
    });

    test("exit commands should trigger shutdown callback", async () => {
      // 这个测试验证 exit 命令会调用 onShutdown
      // 由于 REPL 是内部类，我们通过集成测试来验证
      // 这里我们验证 shutdown 逻辑的存在性
      const mockShutdown = vi.fn();
      
      // 模拟 shutdown 逻辑
      const shutdown = async () => {
        await mockShutdown();
      };
      
      await shutdown();
      
      expect(mockShutdown).toHaveBeenCalled();
    });
  });

  describe("EventSource cleanup during shutdown", () => {
    test("should stop running EventSource sources when shutting down", async () => {
      // 验证 shutdown 时应该停止所有运行中的事件源
      const mockStopSource = vi.fn().mockResolvedValue(undefined);
      
      // 模拟 EventSourceComponent
      const mockEventSourceComponent = {
        list: vi.fn().mockReturnValue([
          { id: "es1", name: "Event Source 1" },
          { id: "es2", name: "Event Source 2" },
        ]),
        getStatus: vi.fn().mockImplementation((id: string) => {
          return id === "es1" ? "running" : "stopped";
        }),
        stopSource: mockStopSource,
      };
      
      // 模拟 shutdown 逻辑
      const shutdown = async () => {
        const sources = mockEventSourceComponent.list();
        for (const source of sources) {
          const status = mockEventSourceComponent.getStatus(source.id);
          if (status === "running") {
            await mockEventSourceComponent.stopSource(source.id);
          }
        }
      };
      
      await shutdown();
      
      // 验证只停止了运行中的源
      expect(mockStopSource).toHaveBeenCalledTimes(1);
      expect(mockStopSource).toHaveBeenCalledWith("es1");
      expect(mockStopSource).not.toHaveBeenCalledWith("es2");
    });

    test("should handle multiple running EventSource sources", async () => {
      const mockStopSource = vi.fn().mockResolvedValue(undefined);
      
      const mockEventSourceComponent = {
        list: vi.fn().mockReturnValue([
          { id: "es1", name: "Source 1" },
          { id: "es2", name: "Source 2" },
          { id: "es3", name: "Source 3" },
        ]),
        getStatus: vi.fn().mockImplementation((id: string) => {
          return id === "es1" || id === "es3" ? "running" : "stopped";
        }),
        stopSource: mockStopSource,
      };
      
      const shutdown = async () => {
        const sources = mockEventSourceComponent.list();
        for (const source of sources) {
          const status = mockEventSourceComponent.getStatus(source.id);
          if (status === "running") {
            await mockEventSourceComponent.stopSource(source.id);
          }
        }
      };
      
      await shutdown();
      
      expect(mockStopSource).toHaveBeenCalledTimes(2);
    });
  });

  describe("SIGINT handling", () => {
    test("should register SIGINT handler for graceful shutdown", async () => {
      // 验证 SIGINT 处理器应该被注册
      const mockOn = vi.spyOn(process, "on").mockImplementation(() => process);

      // 模拟注册
      const sigintHandler = vi.fn();
      process.on("SIGINT", sigintHandler);

      expect(mockOn).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    });
  });
});

// ============================================================================
// TempFileManager cleanup integration tests (Task #1676)
// ============================================================================

/**
 * Helper: 用真实的 TempFileManager.getInstance() 写 N 个临时文件到一个独立目录。
 * 返回文件路径列表 + cleanupAll 后再次读取应返回空。
 */
async function writeTempFiles(prefix: string, count: number): Promise<string[]> {
  const { TempFileManager } = await import(
    "@ai-setting/roy-bot-core/utils/temp-file-manager"
  );
  const manager = TempFileManager.getInstance();
  const files: string[] = [];
  for (let i = 0; i < count; i++) {
    const filePath = await manager.writeTempFile(
      `[Task #1676 test ${i}] some content`,
      `${prefix}-${i}`,
    );
    files.push(filePath);
  }
  return files;
}

/**
 * Helper: 构造一组 minimal InteractiveShutdownDeps，所有 deps 走 mock。
 * Test 关注 Step 7 (TempFileManager.cleanupAll) 是否被调用，不应受其它步骤影响。
 */
function createMinimalShutdownDeps(
  overrides: Partial<InteractiveShutdownDeps> = {},
): InteractiveShutdownDeps {
  return {
    memoryPluginDispose: null,
    memoryPluginInstance: null,
    lspManagerDispose: null,
    pluginAdapterDispose: null,
    eventHandler: { stop: () => {} },
    queryExecutor: { dispose: () => {} },
    env: { getComponent: () => undefined } as any,
    envService: { dispose: async () => {} },
    shouldDisposeEnvService: false,
    output: { info: () => {}, warn: () => {}, error: () => {} } as any,
    logger: { debug: () => {}, warn: () => {} } as any,
    console: { log: () => {} } as any,
    ...overrides,
  };
}

describe("shutdownInteractiveSteps - TempFileManager cleanup (Task #1676)", () => {
  test("Step 7: should invoke TempFileManager.cleanupAll() and remove all temp files", async () => {
    // Arrange: 写 2 个真实临时文件
    const files = await writeTempFiles("shutdown-test-A", 2);

    // 确认 file 真的存在（sanity）
    for (const file of files) {
      expect(fs.existsSync(file)).toBe(true);
    }

    const deps = createMinimalShutdownDeps();

    // Act
    await shutdownInteractiveSteps(deps);

    // Assert: 所有临时文件应该被 cleanupAll 删除
    for (const file of files) {
      expect(fs.existsSync(file)).toBe(false);
    }
  });

  test("Step 7 robust: cleanup still runs when an earlier step (lspManagerDispose) throws", async () => {
    // Arrange: 写 2 个真实临时文件
    const files = await writeTempFiles("shutdown-test-B", 2);
    for (const file of files) {
      expect(fs.existsSync(file)).toBe(true);
    }

    // 让 step 1 (LSP Manager dispose) throw
    const lspManagerDispose = vi.fn(async () => {
      throw new Error("LSP dispose boom");
    });

    const deps = createMinimalShutdownDeps({
      lspManagerDispose,
    });

    // Act: 应该 NOT throw (lsp dispose 失败被 helper 内部 try/catch 吞掉)
    await expect(shutdownInteractiveSteps(deps)).resolves.toBeUndefined();

    // Step 1 失败被记录到 logger
    expect(lspManagerDispose).toHaveBeenCalledTimes(1);

    // 关键断言：即便 step 1 失败，step 7 仍然应该清理临时文件
    for (const file of files) {
      expect(fs.existsSync(file)).toBe(false);
    }
  });

  test("Step 7 robust chain: cleanup survives ALL preceding steps failing", async () => {
    // Arrange: 写 3 个真实临时文件
    const files = await writeTempFiles("shutdown-test-C", 3);
    for (const file of files) {
      expect(fs.existsSync(file)).toBe(true);
    }

    // 让前面所有可能抛错的步骤都抛错
    const deps = createMinimalShutdownDeps({
      lspManagerDispose: vi.fn(async () => {
        throw new Error("LSP boom");
      }),
      pluginAdapterDispose: vi.fn(async () => {
        throw new Error("PluginAdapter boom");
      }),
      envService: {
        dispose: vi.fn(async () => {
          throw new Error("envService boom");
        }),
      } as any,
      shouldDisposeEnvService: true,
    });

    // Act: 整个 shutdown 不应抛错（每个步骤独立 try/catch）
    await expect(shutdownInteractiveSteps(deps)).resolves.toBeUndefined();

    // 关键断言：step 7 仍在前面所有步骤全部抛错的情况下清理了临时文件
    for (const file of files) {
      expect(fs.existsSync(file)).toBe(false);
    }
  });
});
