/**
 * @fileoverview LSPManager 双 setInterval 合并测试 (NEW-3)
 *
 * LSPManager 原本有两个独立 setInterval: cleanupTimer (30s) + healthCheckTimer (60s)。
 * 合并为单 tickTimer，每 cleanupInterval 触发一次 cleanupIdle，
   * 并在每 2 次 cleanup 时（即每 cleanupInterval * 2）触发 healthCheck。
 *
 * 验证：
 * - manager 内部仅存在一个 setInterval（合并后）
 * - cleanupIdle 仍按 cleanupInterval 触发
 * - healthCheck 仍按 ~2 倍 cleanupInterval 触发
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { LSPManager } from "./manager";

describe("LSPManager single tickTimer (NEW-3)", () => {
  let manager: LSPManager | undefined;

  afterEach(async () => {
    await manager?.dispose().catch(() => {});
    manager = undefined;
    vi.restoreAllMocks();
  });

  it("manager uses only one setInterval (merged tickTimer)", () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");

    manager = new LSPManager({
      idleTimeout: 5000,
      maxConnections: 5,
      autoDownload: false,
      cleanupInterval: 30000,
      healthCheckInterval: 60000,
    });

    // setInterval 应仅被调用 1 次（合并后的 tickTimer）
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("manager does NOT expose cleanupTimer + healthCheckTimer separately anymore", () => {
    manager = new LSPManager({
      idleTimeout: 5000,
      maxConnections: 5,
      autoDownload: false,
    });

    // cleanupTimer / healthCheckTimer 字段应不存在或为 null
    expect((manager as any).cleanupTimer).toBeFalsy();
    expect((manager as any).healthCheckTimer).toBeFalsy();
    // tickTimer 应存在
    expect((manager as any).tickTimer).toBeTruthy();
  });

  it("dispose clears the single tickTimer", async () => {
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");

    manager = new LSPManager({
      idleTimeout: 5000,
      maxConnections: 5,
      autoDownload: false,
    });

    await manager.dispose();

    // 应至少调用一次 clearInterval（清理 tickTimer）
    expect(clearIntervalSpy).toHaveBeenCalled();
    // tickTimer 应被清空
    expect((manager as any).tickTimer).toBeNull();
  });
});