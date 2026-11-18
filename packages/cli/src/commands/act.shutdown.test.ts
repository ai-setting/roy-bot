/**
 * @fileoverview Act Command Shutdown Tests
 *
 * TDD: 验证 act 模式的 finally 清理块正确调用 TempFileManager.cleanupAll()
 * (Task #1676)
 *
 * Red → Green：先写失败测试验证 cleanupAll 缺失，再在 act-shutdown.ts 里加 Step 4。
 */

import { describe, test, expect, vi } from "bun:test";
import * as fs from "node:fs";
import { runActShutdownCleanup, type ActShutdownDeps } from "./act-shutdown";

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
      `[act shutdown test ${i}] some content`,
      `${prefix}-${i}`,
    );
    files.push(filePath);
  }
  return files;
}

/**
 * 构造 minimal ActShutdownDeps（不触发 process.exit）
 * - 设置 ROY_AGENT_NO_EXIT=1 让 helper 不主动调 process.exit
 */
function createMinimalActShutdownDeps(
  overrides: Partial<ActShutdownDeps> = {},
): ActShutdownDeps {
  // 重要：避免 process.exit 强制结束测试
  process.env.ROY_AGENT_NO_EXIT = "1";

  return {
    stopTaskEventHandlerCleanup: null,
    lspManagerDispose: null,
    pluginAdapterDispose: null,
    envService: { dispose: async () => {} },
    shouldDisposeEnvService: false,
    output: { warn: () => {} } as any,
    logger: { debug: () => {}, warn: () => {} } as any,
    ...overrides,
  };
}

describe("runActShutdownCleanup - TempFileManager cleanup (Task #1676)", () => {
  test("Step 4: should invoke TempFileManager.cleanupAll() and remove all temp files", async () => {
    // Arrange: 写 2 个真实临时文件
    const files = await writeTempFiles("act-test-A", 2);

    // sanity check
    for (const file of files) {
      expect(fs.existsSync(file)).toBe(true);
    }

    const deps = createMinimalActShutdownDeps();

    // Act
    await runActShutdownCleanup(deps);

    // Assert: 所有临时文件应该被 cleanupAll 删除
    for (const file of files) {
      expect(fs.existsSync(file)).toBe(false);
    }
  });

  test("Step 4 robust: cleanup still runs when dispose step throws", async () => {
    // Arrange
    const files = await writeTempFiles("act-test-B", 2);
    for (const file of files) {
      expect(fs.existsSync(file)).toBe(true);
    }

    // 让 envService.dispose 抛错
    const deps = createMinimalActShutdownDeps({
      shouldDisposeEnvService: true,
      envService: {
        dispose: vi.fn(async () => {
          throw new Error("envService dispose boom");
        }),
      } as any,
    });

    // Act: helper 整体不应抛错（每个步骤独立 try/catch）
    await expect(runActShutdownCleanup(deps)).resolves.toBeUndefined();

    // 关键断言：Step 4 仍然清理了临时文件
    for (const file of files) {
      expect(fs.existsSync(file)).toBe(false);
    }
  });
});
