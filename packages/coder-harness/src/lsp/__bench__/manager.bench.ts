/**
 * @fileoverview LSP Manager 性能基准测试工具
 *
 * 模拟 LSP 客户端/服务器行为，测量 LSPManager 在不同场景下的响应延迟。
 * 使用 mock 而不是真实 LSP 二进制，避免依赖未安装的工具。
 *
 * 设计原则：
 * - 注入可控的"延迟"（initialize / ping / diagnostics）模拟真实 LSP server 行为
 * - 三类指标：cold（首次 getDiagnostics）、warm（after prewarm）、hit（cache hit）
 * - 与实际 server 实现无关，专注于 manager 层优化效果
 *
 * Determinism:
 * - 同一机器/同一次运行内 cold/warm/hit 数字会有 ±1-2ms 抖动
 *   （来源：event loop scheduler / GC pause / Node microtask 调度）
 * - bench 应跑 ≥3 轮取中位数，避免单次峰值误判优化效果
 * - 跨机器对比无意义，应在 CI runner 稳定环境中对比
 * - 报告数字时建议附带「min / median / max」三档而非单点
 */

import type { LSPClient } from "../client";
import type { LSPServer } from "../server";

export interface BenchResult {
  /** 场景名称 */
  name: string;
  /** cold 路径延迟（首次调用） */
  coldMs: number;
  /** warm 路径延迟（prewarm 后首次 getDiagnostics） */
  warmMs: number;
  /** hit 路径延迟（cache hit 或 in-flight dedupe） */
  hitMs: number;
  /** 100 次串行调用总耗时 */
  serial100Ms: number;
  /** 100 次并行调用总耗时（datasufficiency） */
  parallel100Ms: number;
  /** 备注 */
  notes?: string;
}

export interface BenchOptions {
  /** initialize 模拟延迟（ms） */
  initLatencyMs?: number;
  /** diagnostics 模拟延迟（ms） */
  diagnosticsLatencyMs?: number;
  /** ping 模拟延迟（ms） */
  pingLatencyMs?: number;
  /** workspaceRoot */
  workspaceRoot?: string;
  /** preloadLanguages */
  preloadLanguages?: string[];
}

/**
 * 创建可注入延迟的 mock LSPClient
 */
function createMockClient(opts: {
  initLatencyMs: number;
  diagnosticsLatencyMs: number;
  pingLatencyMs: number;
}) {
  let lastUsed = Date.now();
  let disposed = false;
  const client = {
    initialize: async () => {
      await sleep(opts.initLatencyMs);
    },
    isDisposed: () => disposed,
    getLastUsed: () => lastUsed,
    touch: () => {
      lastUsed = Date.now();
    },
    async getDiagnostics(_filePath: string) {
      await sleep(opts.diagnosticsLatencyMs);
      return [
        {
          filePath: _filePath,
          severity: 1 as const,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
          message: "mock diagnostic",
          source: "bench",
        },
      ];
    },
    async ping() {
      await sleep(opts.pingLatencyMs);
      return true;
    },
    async dispose() {
      disposed = true;
    },
    disposeSync() {
      disposed = true;
    },
  } as unknown as LSPClient & { touch: () => void };
  return client;
}

/**
 * 创建一个 mock LSPServer + 在 createClient 中调用 initialize
 * 这样 cold path 包含 init 时间，warm path（prewarm 已 init）跳过
 */
function createMockServer(
  factory: () => LSPClient & { touch: () => void; initialize: () => Promise<void> },
) {
  return {
    async createClient(_root: string) {
      const client = factory();
      // Simulate real LSP server initialize handshake on connection creation
      await client.initialize();
      return client;
    },
    async findRoot(_file: string) {
      return "/mock/workspace";
    },
  } as unknown as LSPServer;
}

/**
 * 创建 mock LSPServer，注册到全局 registry
 */
function installMockServer(
  registry: { create: (id: string, config: any) => LSPServer | null; getServerIds: () => string[] },
  serverId: string,
  factory: () => LSPClient,
) {
  // Monkey-patch the create method to return our mock server
  const originalCreate = registry.create.bind(registry);
  registry.create = ((id: string, config: any) => {
    if (id === serverId) {
      return createMockServer(
        factory as () => LSPClient & { touch: () => void; initialize: () => Promise<void> },
      );
    }
    return originalCreate(id, config);
  }) as typeof registry.create;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 基准测试场景：prewarm hit path
 *
 * 模拟：
 * 1. cold: 首次 createClient + initialize（initLatencyMs）
 * 2. warm: prewarm 后立即 getDiagnostics（应 hit，~diagnosticsLatencyMs）
 * 3. hit: 重复 getDiagnostics（应走 5s cache，~0ms）
 */
export async function benchPrewarmHit(
  prewarmedLanguages: string[],
  workspaceRoot: string,
  options: BenchOptions = {},
): Promise<BenchResult> {
  const opts = {
    initLatencyMs: options.initLatencyMs ?? 80,
    diagnosticsLatencyMs: options.diagnosticsLatencyMs ?? 60,
    pingLatencyMs: options.pingLatencyMs ?? 20,
    workspaceRoot: workspaceRoot,
    preloadLanguages: prewarmedLanguages,
  };

  const { LSPManager } = await import("../manager");
  const { LSPServerRegistry } = await import("../server");

  const manager = new LSPManager({
    idleTimeout: 60000,
    maxConnections: 5,
    autoDownload: false,
    preloadLanguages: prewarmedLanguages,
    workspaceRoot,
  });

  const factory = () =>
    createMockClient({
      initLatencyMs: opts.initLatencyMs,
      diagnosticsLatencyMs: opts.diagnosticsLatencyMs,
      pingLatencyMs: opts.pingLatencyMs,
    });

  // 注入 mock server
  for (const lang of prewarmedLanguages) {
    installMockServer(LSPServerRegistry as any, lang, factory);
  }

  try {
    // === Cold: 首次 getDiagnostics（无 prewarm） ===
    const coldStart = Date.now();
    await manager.getDiagnostics(`${workspaceRoot}/foo.ts`);
    const coldMs = Date.now() - coldStart;

    // 清理缓存以模拟独立的 prewarm 场景
    // (这里只能清掉 connection，cache 在新 manager 实例下自然为空)
    await manager.dispose();

    // === Prewarm hit path: 新 manager + prewarm + warm + hit ===
    const manager2 = new LSPManager({
      idleTimeout: 60000,
      maxConnections: 5,
      autoDownload: false,
      preloadLanguages: prewarmedLanguages,
      workspaceRoot,
    });

    await manager2.prewarm(prewarmedLanguages, workspaceRoot);

    const warmStart = Date.now();
    await manager2.getDiagnostics(`${workspaceRoot}/foo.ts`);
    const warmMs = Date.now() - warmStart;

    const hitStart = Date.now();
    await manager2.getDiagnostics(`${workspaceRoot}/foo.ts`);
    const hitMs = Date.now() - hitStart;

    // === 100 串行调用总耗时 ===
    const serialStart = Date.now();
    for (let i = 0; i < 100; i++) {
      await manager2.getDiagnostics(`${workspaceRoot}/foo-${i}.ts`);
    }
    const serial100Ms = Date.now() - serialStart;

    // === 100 并行调用总耗时（验证 inflight dedupe）===
    const parallelStart = Date.now();
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        manager2.getDiagnostics(`${workspaceRoot}/bar-${i % 5}.ts`),
      ),
    );
    const parallel100Ms = Date.now() - parallelStart;

    await manager2.dispose();

    return {
      name: prewarmedLanguages[0] ?? "unknown",
      coldMs,
      warmMs,
      hitMs,
      serial100Ms,
      parallel100Ms,
      notes: `init=${opts.initLatencyMs}ms diag=${opts.diagnosticsLatencyMs}ms ping=${opts.pingLatencyMs}ms`,
    };
  } finally {
    // Cleanup: restore registry
    // (vitest afterEach handles this for tests, this is for standalone)
  }
}
