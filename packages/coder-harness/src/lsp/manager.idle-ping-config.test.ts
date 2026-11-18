/**
 * @fileoverview LSPManager idlePingThresholdMs 配置化测试 (F5)
 *
 * 验证：用户传入的 idlePingThresholdMs 应当覆盖默认的 30_000ms 阈值，
 * 而不是硬编码常量。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { LSPManager } from "./manager";

describe("LSPManager idlePingThresholdMs config (F5)", () => {
  let manager: LSPManager | undefined;

  afterEach(async () => {
    await manager?.dispose();
    manager = undefined;
    vi.restoreAllMocks();
  });

  it("exposes idlePingThresholdMs on LSPManagerConfig and uses it over default 30s", async () => {
    manager = new LSPManager({
      idleTimeout: 5000,
      maxConnections: 5,
      autoDownload: false,
      idlePingThresholdMs: 100, // 100ms 阈值，远小于默认 30s
      workspaceRoot: "/fake/workspace",
    });

    const config = (manager as any).config;
    expect(config.idlePingThresholdMs).toBe(100);

    // 注入 fake client 到 active connections，路径在 workspaceRoot 内
    const fakeClient = {
      isDisposed: vi.fn().mockReturnValue(false),
      getLastUsed: vi.fn().mockReturnValue(Date.now() - 200), // 200ms 前用过
      ping: vi.fn().mockResolvedValue(true),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    (manager as any).connections.set("typescript:/fake/workspace", fakeClient);

    const result = await manager.getOrCreateConnection(
      "typescript",
      "/fake/workspace/src/index.ts",
    );

    expect(result).toBe(fakeClient);
    // 100ms 阈值下，200ms 前的连接应触发 ping（默认 30s 则不会触发）
    expect(fakeClient.ping).toHaveBeenCalledTimes(1);
  });

  it("falls back to default 30000ms when config.idlePingThresholdMs is omitted", async () => {
    manager = new LSPManager({
      idleTimeout: 5000,
      maxConnections: 5,
      autoDownload: false,
      workspaceRoot: "/fake/workspace",
      // 注意：没有 idlePingThresholdMs
    });

    const config = (manager as any).config;
    expect(config.idlePingThresholdMs).toBeUndefined();

    // manager 内部应使用 30_000 默认值
    const fakeClient = {
      isDisposed: vi.fn().mockReturnValue(false),
      getLastUsed: vi.fn().mockReturnValue(Date.now() - 200), // 200ms 前
      ping: vi.fn().mockResolvedValue(true),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    (manager as any).connections.set("typescript:/fake/workspace", fakeClient);

    const result = await manager.getOrCreateConnection(
      "typescript",
      "/fake/workspace/src/index.ts",
    );

    expect(result).toBe(fakeClient);
    // 默认 30s 阈值下，200ms 前的连接**不**触发 ping
    expect(fakeClient.ping).not.toHaveBeenCalled();
  });
});