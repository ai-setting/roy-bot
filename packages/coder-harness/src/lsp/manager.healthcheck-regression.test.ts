/**
 * @fileoverview LSPManager 健康检查回归测试 (Task #2182)
 *
 * 复现并防护 LSP server 被 healthCheck 误杀的回归：
 *
 * 现场日志（2026-07-20 session_2418c859）：
 *   [LSPClient] Server process exited: typescript, code=null, signal=SIGTERM
 *   ❌ 执行失败: Error: The socket connection was closed unexpectedly.
 *
 * 根因：
 * 1. `LSPManager.performHealthCheck` 同时遍历 `connections` 和 `_prewarmedConnections`
 * 2. 对每个 client 调用 `client.ping()`
 * 3. `LSPClient.ping()` 发送 `window/showMessageRequest` → TypeScript LSP 不支持
 *    或响应超时 → ping 返回 false
 * 4. healthCheck 调用 `client.dispose()` → `process.kill("SIGTERM")`
 * 5. 健康的预热 LSP server 被错误回收
 *
 * 修复后应满足：
 * - 健康但 ping 返回 false 的预热连接不应被 dispose
 * - 健康但 ping 返回 false 的活跃连接不应被立即 dispose（应允许重试）
 * - ping 方法应使用更可靠的判断（进程存活 + 错误传播）
 * - dispose 期间 pending request 的错误应正常传播，不挂起，不 unhandled rejection
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { LSPManagerConfig } from "../types/linter";
import type { LSPClient } from "./client";
import { LSPManager } from "./manager";

/**
 * 创建 fake LSPClient。
 * - `ping()` 返回指定值（默认 false，模拟 window/showMessageRequest 失败的 TypeScript LSP）
 * - `dispose()` 记录被调用次数
 */
function makeFakeClient(opts: {
  healthy?: boolean;
  disposed?: boolean;
  serverId?: string;
} = {}) {
  const client = {
    getServerId: vi.fn().mockReturnValue(opts.serverId ?? "typescript"),
    getLastUsed: vi.fn().mockReturnValue(Date.now()),
    isDisposed: vi.fn().mockReturnValue(opts.disposed ?? false),
    ping: vi.fn().mockResolvedValue(opts.healthy ?? false),
    dispose: vi.fn().mockResolvedValue(undefined),
    openDocument: vi.fn().mockResolvedValue(undefined),
    getDiagnostics: vi.fn().mockResolvedValue([]),
  } as unknown as LSPClient;
  return client;
}

describe("LSPManager healthCheck regression (Task #2182)", () => {
  let manager: LSPManager | undefined;

  afterEach(async () => {
    if (manager) {
      await manager.dispose();
      manager = undefined;
    }
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // RED 1: 健康的预热连接不应被 healthCheck 回收
  // -------------------------------------------------------------------------
  // 现场：ts LSP prewarm 成功后闲置 ~60s，被 healthCheck ping 后错误判断为不健康
  //       → process.kill(SIGTERM) → 用户在交互中看到 server exited + AI fetch 失败
  //
  // 期望：healthCheck 应仅 ping **活跃** 连接（`connections`），不应 ping 预热连接
  //       （`_prewarmedConnections`），因为：
  //       1. 预热连接尚未被任何请求使用，本来就是 "ready but idle"
  //       2. ping 误判概率高于真正出问题的概率（特别是 window/showMessageRequest
  //          在 TS LSP 上不可靠）
  it("healthCheck does NOT dispose prewarmed client when ping returns false", async () => {
    const config: LSPManagerConfig = {
      idleTimeout: 60000,
      maxConnections: 5,
      autoDownload: false,
    };
    manager = new LSPManager(config);

    // 注入一个"进程活着 + ping 返回 false"的预热 client
    // （模拟 TypeScript LSP：进程在跑，但 window/showMessageRequest 不可靠）
    const key = "typescript:/tmp/test-root";
    const prewarmedClient = makeFakeClient({ healthy: false });
    (manager as any)._prewarmedConnections.set(key, prewarmedClient);

    // 触发 healthCheck
    await manager.healthCheck();

    // 预期：预热连接不应被 dispose（健康的预热 server 不应被 SIGTERM）
    expect(prewarmedClient.dispose).not.toHaveBeenCalled();
    // 预期：预热连接仍在 _prewarmedConnections 中（可继续被复用）
    expect((manager as any)._prewarmedConnections.has(key)).toBe(true);
    // 预期：healthCheck 不应主动调用 ping 预热连接（避免误判）
    //      注：当前实现会 ping 预热连接——这是 bug
    expect(prewarmedClient.ping).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // RED 2: 活跃连接 ping 失败不应立即 dispose（应有 retry 容忍）
  // -------------------------------------------------------------------------
  // 现场：ts LSP 在 idle 状态被 ping，可能因 GC、事件循环占用等瞬时慢响应
  //       当前实现：单次失败 → 立即 dispose → SIGTERM
  //
  // 期望：单次 ping 失败只标记为 unhealthy，不立即 dispose。
  //       连续 N 次失败（例如 3 次）才真正 dispose。
  it("healthCheck does NOT immediately dispose active client on single ping failure", async () => {
    const config: LSPManagerConfig = {
      idleTimeout: 60000,
      maxConnections: 5,
      autoDownload: false,
    };
    manager = new LSPManager(config);

    // 注入一个"进程活着 + ping 返回 false"的活跃 client
    const key = "typescript:/tmp/test-root-active";
    const activeClient = makeFakeClient({ healthy: false });
    (manager as any).connections.set(key, activeClient);

    // 触发一次 healthCheck
    await manager.healthCheck();

    // 预期：单次 ping 失败不应立即 dispose
    //      （应当有 retry 容忍：连续 N 次失败才回收）
    expect(activeClient.dispose).not.toHaveBeenCalled();
    // 预期：连接仍在 connections 中
    expect((manager as any).connections.has(key)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // RED 3: 进程已退出的活跃连接仍应被回收（保留正常清理路径）
  // -------------------------------------------------------------------------
  // 期望：isDisposed() === true 的 client 应被正常回收（不是"误杀"）
  //       这是健康检查的正当用途，不能因为新策略而被破坏
  it("healthCheck still disposes active client whose process has exited", async () => {
    const config: LSPManagerConfig = {
      idleTimeout: 60000,
      maxConnections: 5,
      autoDownload: false,
    };
    manager = new LSPManager(config);

    // 注入一个"进程已退出"的活跃 client
    const key = "typescript:/tmp/test-root-dead";
    const deadClient = makeFakeClient({ disposed: true });
    (manager as any).connections.set(key, deadClient);

    // 触发 healthCheck
    await manager.healthCheck();

    // 预期：disposed client 仍应被回收
    expect(deadClient.dispose).toHaveBeenCalled();
    expect((manager as any).connections.has(key)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // GREEN 1: 连续 N 次 ping 失败才真正 dispose
  // -------------------------------------------------------------------------
  it("healthCheck only disposes active client after N consecutive ping failures", async () => {
    const config: LSPManagerConfig = {
      idleTimeout: 60000,
      maxConnections: 5,
      autoDownload: false,
    };
    manager = new LSPManager(config);

    // 注入一个"进程活着 + ping 永远返回 false"的活跃 client
    const key = "typescript:/tmp/test-root-flaky";
    const flakyClient = makeFakeClient({ healthy: false });
    (manager as any).connections.set(key, flakyClient);

    // 第一次 healthCheck：ping 失败 1 次，不应 dispose
    await manager.healthCheck();
    expect(flakyClient.dispose).not.toHaveBeenCalled();
    expect((manager as any).connections.has(key)).toBe(true);

    // 第二次 healthCheck：累计 2 次，仍未达阈值（默认 3）
    await manager.healthCheck();
    expect(flakyClient.dispose).not.toHaveBeenCalled();
    expect((manager as any).connections.has(key)).toBe(true);

    // 第三次 healthCheck：累计 3 次，达到阈值，应 dispose
    await manager.healthCheck();
    expect(flakyClient.dispose).toHaveBeenCalledTimes(1);
    expect((manager as any).connections.has(key)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // GREEN 2: 瞬时 ping 失败后恢复成功，应重置失败计数
  // -------------------------------------------------------------------------
  it("healthCheck resets failure count when ping succeeds", async () => {
    const config: LSPManagerConfig = {
      idleTimeout: 60000,
      maxConnections: 5,
      autoDownload: false,
    };
    manager = new LSPManager(config);

    // 注入一个"瞬时失败 2 次后恢复健康"的 client
    const key = "typescript:/tmp/test-root-recovering";
    const recoveringClient = makeFakeClient({ healthy: false });
    (manager as any).connections.set(key, recoveringClient);

    // 第 1 次失败
    await manager.healthCheck();
    // 第 2 次失败
    await manager.healthCheck();

    // 中途恢复：ping 改为返回 true
    (recoveringClient.ping as any).mockResolvedValue(true);

    // 这次 healthCheck：ping 成功，应重置失败计数
    await manager.healthCheck();
    expect(recoveringClient.dispose).not.toHaveBeenCalled();
    expect((manager as any).connections.has(key)).toBe(true);

    // 验证计数已重置：再次失败 2 次仍不应 dispose
    (recoveringClient.ping as any).mockResolvedValue(false);
    await manager.healthCheck(); // 1 次失败
    await manager.healthCheck(); // 2 次失败（重置后）
    expect(recoveringClient.dispose).not.toHaveBeenCalled();
    expect((manager as any).connections.has(key)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // GREEN 3: 预热连接被 getOrCreateConnection 复用时，应清除失败计数
  // -------------------------------------------------------------------------
  it("getOrCreateConnection clears failure count when reusing prewarmed client", async () => {
    const config: LSPManagerConfig = {
      idleTimeout: 60000,
      maxConnections: 5,
      autoDownload: false,
    };
    manager = new LSPManager(config);

    const serverId = "typescript";
    const fakeRoot = "/tmp/test-root-pickup";
    const key = `${serverId}:${fakeRoot}`;

    const fakeServer: any = {
      findRoot: vi.fn().mockResolvedValue(fakeRoot),
      createClient: vi.fn(),
    };
    (manager as any).servers.set(serverId, fakeServer);

    // 注入一个"瞬时失败"预热 client（模拟历史 ping 失败记录）
    const prewarmedClient = makeFakeClient({ healthy: false });
    (manager as any)._prewarmedConnections.set(key, prewarmedClient);
    (manager as any).pingFailureCounts.set(key, 5); // 假设历史失败 5 次

    // 触发：复用预热连接
    const result = await manager.getOrCreateConnection(serverId, `${fakeRoot}/index.ts`);

    // 预期：预热 client 被成功复用
    expect(result).toBe(prewarmedClient);
    // 预期：失败计数被重置（不应该保留 5 次）
    expect((manager as any).pingFailureCounts.get(key)).toBeUndefined();
    // 预期：连接移到 active pool
    expect((manager as any).connections.has(key)).toBe(true);
    expect((manager as any)._prewarmedConnections.has(key)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // GREEN 4: ping 抛出异常（如 timeout）也应走失败计数路径
  // -------------------------------------------------------------------------
  it("healthCheck counts ping exceptions as failures (not immediate dispose)", async () => {
    const config: LSPManagerConfig = {
      idleTimeout: 60000,
      maxConnections: 5,
      autoDownload: false,
    };
    manager = new LSPManager(config);

    const key = "typescript:/tmp/test-root-throws";
    const throwingClient = makeFakeClient({ healthy: false });
    // 让 ping 抛出（模拟 sendRequest 异常）
    (throwingClient.ping as any).mockRejectedValue(new Error("connection broken"));
    (manager as any).connections.set(key, throwingClient);

    // 第 1 次：抛异常，应计入失败 1 次
    await manager.healthCheck();
    expect(throwingClient.dispose).not.toHaveBeenCalled();
    expect((manager as any).pingFailureCounts.get(key)).toBe(1);

    // 第 2 次：抛异常
    await manager.healthCheck();
    expect(throwingClient.dispose).not.toHaveBeenCalled();
    expect((manager as any).pingFailureCounts.get(key)).toBe(2);

    // 第 3 次：抛异常，达到阈值
    await manager.healthCheck();
    expect(throwingClient.dispose).toHaveBeenCalled();
    expect((manager as any).connections.has(key)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // GREEN 5: ping 异常时不产生 unhandled rejection
  // -------------------------------------------------------------------------
  it("healthCheck does not throw unhandled rejection when ping throws", async () => {
    const config: LSPManagerConfig = {
      idleTimeout: 60000,
      maxConnections: 5,
      autoDownload: false,
    };
    manager = new LSPManager(config);

    const key = "typescript:/tmp/test-root-unhandled";
    const client = makeFakeClient({ healthy: false });
    (client.ping as any).mockRejectedValue(new Error("network broken"));
    (manager as any).connections.set(key, client);

    // 监听 unhandled rejection
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      // 多次触发 healthCheck，确保不抛 unhandled rejection
      await manager.healthCheck();
      await manager.healthCheck();
      await manager.healthCheck();
      // 给事件循环一个 tick 处理可能的 rejection
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    // 预期：没有任何 unhandled rejection
    expect(unhandled).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // GREEN 6: dispose() 时清理 pingFailureCounts
  // -------------------------------------------------------------------------
  it("dispose clears pingFailureCounts to allow clean shutdown", async () => {
    const config: LSPManagerConfig = {
      idleTimeout: 60000,
      maxConnections: 5,
      autoDownload: false,
    };
    manager = new LSPManager(config);

    // 注入一些失败计数
    (manager as any).pingFailureCounts.set("key1", 2);
    (manager as any).pingFailureCounts.set("key2", 5);
    expect((manager as any).pingFailureCounts.size).toBe(2);

    await manager.dispose();

    // 预期：dispose 后 pingFailureCounts 已清空
    expect((manager as any).pingFailureCounts.size).toBe(0);
    manager = undefined; // 已 dispose
  });
});

describe("LSPClient.ping() should not rely on window/showMessageRequest (Task #2182)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // RED 4: ping 失败不应触发 SIGTERM 或任何副作用
  // -------------------------------------------------------------------------
  // 现场：window/showMessageRequest 在 TS LSP 上行为不稳定
  //       → ping 返回 false → dispose → SIGTERM
  //
  // 期望：ping() 失败应返回 false 但不应自动 dispose / kill
  //       决策（是否 dispose）应由上层 healthCheck 决定
  it("ping() returning false does NOT call process.kill on its own", async () => {
    const { LSPClient } = await import("./client");

    // 创建一个 mock child process：process 存活但 ping 会失败
    const killMock = vi.fn();
    const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
    const mockStdout = {
      on: vi.fn(),
      cork: vi.fn(),
      uncork: vi.fn(),
      destroy: vi.fn(),
      end: vi.fn(),
      setDefaultEncoding: vi.fn(),
      writev: vi.fn(),
      _destroy: vi.fn(),
      closed: false,
      destroyed: false,
      readable: true,
      readableFlowing: null,
      readableHighWaterMark: 16384,
      readableLength: 0,
    };
    const mockStdin = {
      write: vi.fn(),
      on: vi.fn(),
      cork: vi.fn(),
      uncork: vi.fn(),
      destroy: vi.fn(),
      end: vi.fn(),
      setDefaultEncoding: vi.fn(),
      writev: vi.fn(),
      _destroy: vi.fn(),
      closed: false,
      destroyed: false,
      writable: true,
      writableEnded: false,
      writableCorked: 0,
      writableHighWaterMark: 16384,
      writableLength: 0,
    };
    const mockProcess: any = {
      pid: 12345,
      stdout: mockStdout,
      stdin: mockStdin,
      exitCode: null,
      signalCode: null,
      killed: false,
      on: vi.fn((event: string, cb: any) => {
        if (event === "exit") exitListeners.push(cb);
        return mockProcess;
      }),
      kill: killMock,
      connected: true,
    };

    const client = new LSPClient(mockProcess, {
      id: "typescript",
      extensions: [".ts"],
      rootPattern: ["package.json"],
      command: ["typescript-language-server", "--stdio"],
    }, "/tmp");

    // 调用 ping——返回 false（mock 的 connection.sendRequest 会失败）
    const result = await client.ping();
    expect(result).toBe(false);

    // 关键：ping 失败不应调用 process.kill（避免 SIGTERM 副作用）
    expect(killMock).not.toHaveBeenCalled();

    await client.dispose();
  });

  // -------------------------------------------------------------------------
  // GREEN 7: dispose 是幂等的（多次调用不抛错、不重复 SIGTERM）
  // -------------------------------------------------------------------------
  it("dispose() is idempotent and does not double-kill the process", async () => {
    const { LSPClient } = await import("./client");

    const killMock = vi.fn();
    const mockStdout = {
      on: vi.fn(),
      cork: vi.fn(),
      uncork: vi.fn(),
      destroy: vi.fn(),
      end: vi.fn(),
      setDefaultEncoding: vi.fn(),
      writev: vi.fn(),
      _destroy: vi.fn(),
      closed: false,
      destroyed: false,
      readable: true,
      readableFlowing: null,
      readableHighWaterMark: 16384,
      readableLength: 0,
    };
    const mockStdin = {
      write: vi.fn(),
      on: vi.fn(),
      cork: vi.fn(),
      uncork: vi.fn(),
      destroy: vi.fn(),
      end: vi.fn(),
      setDefaultEncoding: vi.fn(),
      writev: vi.fn(),
      _destroy: vi.fn(),
      closed: false,
      destroyed: false,
      writable: true,
      writableEnded: false,
      writableCorked: 0,
      writableHighWaterMark: 16384,
      writableLength: 0,
    };
    const mockProcess: any = {
      pid: 12345,
      stdout: mockStdout,
      stdin: mockStdin,
      exitCode: null,
      signalCode: null,
      killed: false,
      on: vi.fn(),
      kill: killMock,
      connected: true,
    };

    const client = new LSPClient(mockProcess, {
      id: "typescript",
      extensions: [".ts"],
      rootPattern: ["package.json"],
      command: ["typescript-language-server", "--stdio"],
    }, "/tmp");

    // 多次 dispose
    await client.dispose();
    await client.dispose();
    await client.dispose();

    // 关键：kill 只被调用 1 次（dispose 幂等）
    expect(killMock).toHaveBeenCalledTimes(1);
    // 第一次 kill 是 SIGTERM（dispose 的默认行为）
    expect(killMock).toHaveBeenCalledWith("SIGTERM");
  });
});
