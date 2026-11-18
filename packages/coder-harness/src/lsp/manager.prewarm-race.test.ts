/**
 * @fileoverview LSPManager 并发预热去重测试 (NEW-1)
 *
 * 验证：多次并发调用 manager.prewarm([serverId]) 只会触发一次 server.createClient，
 * 避免在并发场景下创建重复的 LSP client 进程。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { LSPManager } from "./manager";
import { LSPServerRegistry } from "./server";

describe("LSPManager prewarm race dedupe (NEW-1)", () => {
  let manager: LSPManager | undefined;

  afterEach(async () => {
    await manager?.dispose();
    manager = undefined;
  });

  it("dedupes 3 concurrent prewarm([serverId]) calls into 1 createClient call", async () => {
    const stubServer = {
      id: "race-test-stub",
      extensions: [".racetest"],
      rootPattern: [],
      excludePattern: [],
      command: ["echo", "stub"],
    };
    LSPServerRegistry.register(stubServer);

    manager = new LSPManager({
      idleTimeout: 5000,
      maxConnections: 5,
      autoDownload: false,
      workspaceRoot: "/race/workspace",
    });

    // 替换该 server 的 LSPServer 实例，spy createClient
    const realServer = LSPServerRegistry.create(stubServer.id, {
      idleTimeout: 5000,
      maxConnections: 5,
      autoDownload: false,
      workspaceRoot: "/race/workspace",
    });
    expect(realServer).not.toBeNull();

    const createClientSpy = vi
      .spyOn(realServer!, "createClient")
      .mockImplementation(async () => {
        // 模拟慢启动 30ms 以确保 3 个 prewarm 都进入 in-flight 阶段
        await new Promise((r) => setTimeout(r, 30));
        return null; // 不需要真的 client，createClient 调用次数是核心断言
      });

    // 用 spy 的 server 替换 manager 内部的 server 实例
    (manager as any).servers.set(stubServer.id, realServer);

    // 并发 3 次 prewarm
    await Promise.all([
      manager.prewarm([stubServer.id]),
      manager.prewarm([stubServer.id]),
      manager.prewarm([stubServer.id]),
    ]);

    // 即使 3 次并发 prewarm，也只调用 1 次 createClient
    expect(createClientSpy).toHaveBeenCalledTimes(1);

    // 不影响其他测试，stubServer 会在 LSPServerRegistry 静态 map 中保留；
    // 这个 id 在 registry 中已注册但不会被 LSPManager 引用到（manager 已 dispose）。
  });
});