/**
 * @fileoverview LSP 连接管理器
 *
 * 管理 LSP 客户端连接池，按需创建/复用/清理连接
 * 支持预加载模式和全局单例
 */

import { isAbsolute, relative } from "node:path";
import { TracedAs } from "@ai-setting/roy-bot-core";
import type { LSPManagerConfig, Diagnostic } from "../types/linter";
import { LSPClient } from "./client";
import { LSPServer, LSPServerRegistry } from "./server";
import { getServerId } from "./language-map";

// 别名，保持代码清晰
const LSPLangRegistry = LSPServerRegistry;
const DEFAULT_IDLE_PING_THRESHOLD_MS = 30_000;
const DIAGNOSTIC_CACHE_TTL_MS = 5_000;

function isPathInWorkspace(filePath: string, workspaceRoot: string): boolean {
  const relativePath = relative(workspaceRoot, filePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

/**
 * F2 fix: 自定义错误类型，用于在 fetchDiagnostics 内部吞掉错误时
 * 让 getDiagnostics 知道「失败」vs「成功返回 []」，从而避免把
 * 失败的空结果写入 cache。
 */
class DiagnosticsFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiagnosticsFetchError";
  }
}

/**
 * 健康检查结果
 */
export interface HealthCheckResult {
  /** 连接键 */
  key: string;
  /** 服务器 ID */
  serverId: string;
  /** 是否健康 */
  healthy: boolean;
  /** 错误信息（如果 unhealthy） */
  error?: string;
}

/**
 * 连接统计信息
 */
export interface ConnectionStats {
  /** 活跃连接数 */
  activeConnections: number;
  /** 预加载连接数 */
  prewarmedConnections: number;
  /** 总服务器数 */
  totalServers: number;
  /** 连接详情 */
  connections: Array<{
    key: string;
    serverId: string;
    root: string;
    lastUsed: number;
    isPrewarmed: boolean;
  }>;
}

/**
 * LSP 连接管理器
 *
 * 负责 LSP 客户端的生命周期管理：
 * - 按需创建连接
 * - 连接池复用
 * - 空闲连接清理
 * - 预加载支持
 * - 连接健康检查
 */
export class LSPManager {
  private connections: Map<string, LSPClient>;
  private servers: Map<string, LSPServer>;
  private config: LSPManagerConfig;
  private shutdownHandlersRegistered: boolean = false;
  /** 预加载的连接缓存，按 serverId:root 索引 */
  private _prewarmedConnections: Map<string, LSPClient>;
  /** 显式 workspace root，避免预热与按文件查找使用不同根目录 */
  private workspaceRoot: string | null;
  /** 同一文件正在进行的诊断请求，用于合并并发调用 */
  private readonly inflightDiagnostics = new Map<string, Promise<Diagnostic[]>>();
  /** 短时诊断缓存，避免无文件变化时重复访问 LSP server */
  private readonly diagnosticCache = new Map<
    string,
    { timestamp: number; diagnostics: Diagnostic[] }
  >();
  /**
   * NEW-1: 正在进行的预热请求，按 `${serverId}:${root}` 索引，
   * 用于合并并发 prewarm 调用，避免重复创建 LSP client。
   */
  private readonly inflightPrewarm = new Map<string, Promise<void>>();
  /** NEW-3: 合并后的单一定时器（替代原 cleanupTimer + healthCheckTimer） */
  private tickTimer: NodeJS.Timeout | null = null;
  /** 健康检查间隔（毫秒），默认 60000 */
  private healthCheckInterval: number = 60000;
  /** F5: 空闲连接 ping 阈值（毫秒），默认 30000 */
  private idlePingThresholdMs: number = DEFAULT_IDLE_PING_THRESHOLD_MS;
  /** NEW-3: 上次健康检查的时间戳（用于在 tick 内判断是否需要 healthCheck） */
  private lastHealthCheck: number = Date.now();
  /**
   * Task #2182: 每个 active connection 的连续 ping 失败次数。
   * 仅当达到 `unhealthyThreshold` (默认 3) 次时才真正 dispose，避免单次
   * 瞬时慢响应（如事件循环拥塞、GC pause、LSP server 短暂忙碌）导致
   * 健康连接被误杀回 SIGTERM。
   *
   * 设计依据（2026-07-20 现场）：
   * - `window/showMessageRequest` 在 TS LSP server 上不稳定 → ping 误报率高
   * - 单次失败即 dispose 是过度反应，应允许瞬时抖动
   */
  private readonly pingFailureCounts: Map<string, number> = new Map();
  /** Task #2182: 连续失败次数阈值，超过后才会真正 dispose */
  private readonly unhealthyThreshold: number = 3;

  constructor(config: LSPManagerConfig) {
    this.connections = new Map();
    this.servers = new Map();
    this._prewarmedConnections = new Map();
    this.config = config;
    this.workspaceRoot = config.workspaceRoot ?? null;
    // F5: 读取用户配置的 ping 阈值，默认 30s
    this.idlePingThresholdMs =
      config.idlePingThresholdMs ?? DEFAULT_IDLE_PING_THRESHOLD_MS;

    // NEW-3: 合并 cleanupTimer + healthCheckTimer 为单 tickTimer
    // 每个 cleanupInterval 触发一次 tick：
    // - cleanupIdle 每次都执行
    // - performHealthCheck 在每 2 次 tick 时执行（即每 cleanupInterval*2 毫秒）
    const cleanupInterval = config.cleanupInterval ?? 30000;
    this.healthCheckInterval = config.healthCheckInterval ?? 60000;
    this.lastHealthCheck = Date.now();

    this.tickTimer = setInterval(() => {
      this.cleanupIdle().catch((err) => {
        console.debug("[LSPManager] cleanupIdle error:", err);
      });
      const now = Date.now();
      if (now - this.lastHealthCheck >= this.healthCheckInterval) {
        this.lastHealthCheck = now;
        this.performHealthCheck().catch((err) => {
          console.debug("[LSPManager] healthCheck error:", err);
        });
      }
    }, cleanupInterval);

    // 确保定时器不会被阻止
    this.tickTimer.unref();
  }

  /**
   * 解析并持久化工作区根目录。
   * 显式传入的根目录优先，其次复用 manager 配置，最后只读取一次 cwd。
   */
  private resolveWorkspaceRoot(passed?: string): string {
    if (passed) {
      this.workspaceRoot = passed;
      return passed;
    }
    if (this.workspaceRoot) {
      return this.workspaceRoot;
    }
    this.workspaceRoot = process.cwd();
    return this.workspaceRoot;
  }

  /**
   * 预加载 LSP 服务器
   *
   * 实际启动 LSP 服务器进程并建立连接
   *
   * @param serverIds 要预加载的服务器 ID 列表，默认使用配置中的 preloadLanguages
   * @param workspaceRoot 预加载的工作区根目录
   */
  @TracedAs("lsp-manager.prewarm", {
    recordParams: true,
    recordResult: false,
    paramFilter: (args) => ({
      serverIds: args[0],
      workspaceRoot: args[1],
    }),
    flattenParamFilter: true,
  })
  async prewarm(serverIds?: string[], workspaceRoot?: string): Promise<void> {
    // 确定要预加载的语言
    const idsToPrewarm = serverIds ?? this.config.preloadLanguages ?? LSPLangRegistry.getServerIds();

    // 使用显式参数、配置中的工作区根目录或一次性 cwd 兜底
    const root = this.resolveWorkspaceRoot(workspaceRoot);

    // 并行预加载多个服务器
    await Promise.allSettled(
      idsToPrewarm.map(async (serverId) => {
        try {
          await this.prewarmServer(serverId, root);
        } catch (error) {
          // 静默处理预加载错误，不影响主流程
          console.debug(`[LSPManager] Failed to prewarm ${serverId}:`, error);
        }
      })
    );
  }

  /**
   * 预加载单个服务器
   *
   * @param serverId 服务器 ID
   * @param root 工作区根目录
   */
  private async prewarmServer(serverId: string, root: string): Promise<void> {
    const key = `${serverId}:${root}`;

    // 如果已经预加载过，直接返回
    if (this._prewarmedConnections.has(key)) {
      return;
    }

    // NEW-1: 已有进行中的预热请求，复用 promise，避免重复创建 client
    const inflight = this.inflightPrewarm.get(key);
    if (inflight) {
      return inflight;
    }

    const server = this.getOrCreateServer(serverId);
    if (!server) {
      console.debug(`[LSPManager] Server not found: ${serverId}`);
      return;
    }

    // 启动预热并记录 promise，让并发的相同 key 复用
    const promise = (async () => {
      const client = await server.createClient(root);
      if (client) {
        this._prewarmedConnections.set(key, client);
      }
    })().finally(() => {
      this.inflightPrewarm.delete(key);
    });

    this.inflightPrewarm.set(key, promise);
    await promise;
  }

  /**
   * 获取或创建连接，优先使用预加载的连接
   *
   * 优化说明：
   * - 优先使用预加载的连接（无需 ping）
   * - 活跃连接复用采用"惰性 ping"策略：仅在连接超过 idlePingThreshold 未使用时才 ping
   * - 减少不必要的 ping 开销
   *
   * @param serverId 服务器 ID
   * @param filePath 文件路径
   */
  @TracedAs("lsp-manager.getOrCreateConnection", {
    recordParams: true,
    recordResult: false,
    paramFilter: (args) => ({
      serverId: args[0],
      filePath: args[1],
    }),
    flattenParamFilter: true,
    resultFilter: (client: LSPClient | null) => ({
      "client.disposed": client?.isDisposed() ?? null,
      "key.format": typeof client === "string" ? client : "default",
    }),
  })
  async getOrCreateConnection(serverId: string, filePath: string): Promise<LSPClient | null> {
    const server = this.getOrCreateServer(serverId);
    if (!server) {
      return null;
    }

    let root: string | null;
    if (this.workspaceRoot && isPathInWorkspace(filePath, this.workspaceRoot)) {
      // 预热和按文件调用共享同一 key，避免重复创建连接。
      root = this.workspaceRoot;
    } else {
      root = await server.findRoot(filePath);
      if (root && !this.workspaceRoot) {
        this.workspaceRoot = root;
      }
    }
    if (!root) {
      return null;
    }

    const key = `${serverId}:${root}`;

    // 优先使用预加载的连接（预加载的连接通常是刚创建的，无需 ping）
    if (this._prewarmedConnections.has(key)) {
      const client = this._prewarmedConnections.get(key)!;

      // 快速健康检查：即使预加载的连接也可能因长时间未使用而失效
      if (client.isDisposed()) {
        this._prewarmedConnections.delete(key);
        // 继续走创建逻辑
      } else {
        // 将连接移动到活跃连接池
        this.connections.set(key, client);
        this._prewarmedConnections.delete(key);
        // Task #2182: 复用了健康的预热连接，清除可能存在的失败计数
        this.pingFailureCounts.delete(key);
        return client;
      }
    }

    // 检查活跃连接池：采用"惰性 ping"策略
    // 如果连接最近使用过（30 秒内），直接复用，避免不必要的 ping 开销
    if (this.connections.has(key)) {
      const cachedClient = this.connections.get(key)!;

      // 快速路径：检查进程是否已退出
      if (cachedClient.isDisposed()) {
        this.connections.delete(key);
        // Task #2182: 清理关联的 ping 失败计数
        this.pingFailureCounts.delete(key);
      } else {
        // 惰性 ping：仅在连接超过阈值未使用时才 ping
        const elapsed = Date.now() - cachedClient.getLastUsed();

        if (elapsed < this.idlePingThresholdMs) {
          // 最近使用过，直接复用
          // Task #2182: 复用成功的连接重置失败计数
          this.pingFailureCounts.delete(key);
          return cachedClient;
        }

        // 超过阈值，执行 ping 健康检查
        try {
          const isHealthy = await cachedClient.ping();
          if (isHealthy) {
            // Task #2182: ping 成功重置失败计数
            this.pingFailureCounts.delete(key);
            return cachedClient;
          }
        } catch {
          // ping 抛错也视为不健康，继续清理重建
        }

        // 不健康：清理并继续走"创建新连接"逻辑
        try {
          await cachedClient.dispose();
        } catch {
          // ignore - dispose 失败不影响重建
        }
        this.connections.delete(key);
        // Task #2182: 清理关联的 ping 失败计数
        this.pingFailureCounts.delete(key);
      }
    }

    // 创建新连接
    try {
      const client = await server.createClient(root);
      if (!client) {
        console.debug(`[LSPManager] Failed to create client for ${serverId}`);
        return null;
      }
      this.connections.set(key, client);
      // Task #2182: 新连接重置失败计数
      this.pingFailureCounts.delete(key);
      return client;
    } catch (error) {
      console.debug(`[LSPManager] Error creating client for ${serverId}:`, error);
      return null;
    }
  }

  /**
   * 注册进程退出时的清理处理器
   *
   * 确保进程退出时自动清理 LSP 服务器资源
   */
  registerShutdownHandler(): void {
    if (this.shutdownHandlersRegistered) {
      return;
    }

    const cleanup = async () => {
      await this.dispose();
    };

    // 注册多种退出信号处理
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
    process.on("exit", cleanup);

    this.shutdownHandlersRegistered = true;
  }

  /**
   * 获取文件的诊断信息
   *
   * @param filePath 文件路径
   * @returns 诊断信息数组
   */
  @TracedAs("lsp-manager.getDiagnostics", {
    recordParams: true,
    recordResult: true,
    paramFilter: (args) => ({
      filePath: args[0],
    }),
    flattenParamFilter: true,
    resultFilter: (diagnostics: Diagnostic[]) => ({
      "diagnostics.length": Array.isArray(diagnostics) ? diagnostics.length : 0,
      "cache.hit": false, // 此 span 表示 miss，否则根本不会调用 fetchDiagnostics
      "inflight.deduped": false, // 同上
    }),
  })
  async getDiagnostics(filePath: string): Promise<Diagnostic[]> {
    const serverId = getServerId(filePath);
    if (!serverId) {
      return [];
    }

    const cached = this.diagnosticCache.get(filePath);
    if (cached && Date.now() - cached.timestamp < DIAGNOSTIC_CACHE_TTL_MS) {
      return cached.diagnostics;
    }

    const inflight = this.inflightDiagnostics.get(filePath);
    if (inflight) {
      return inflight;
    }

    const request = this.fetchDiagnostics(serverId, filePath);
    this.inflightDiagnostics.set(filePath, request);
    try {
      const diagnostics = await request;
      // 只有成功路径才写入 cache。
      this.diagnosticCache.set(filePath, {
        timestamp: Date.now(),
        diagnostics,
      });
      return diagnostics;
    } catch (error) {
      // F2 fix: 失败路径（DiagnosticsFetchError）不写 cache，让下次调用
      // 能在 5s 窗口内重试，避免一次瞬时 LSP 故障导致 5s 诊断消失。
      // 其他错误（如程序 bug）保持抛出，让上层处理。
      if (error instanceof DiagnosticsFetchError) {
        return [];
      }
      throw error;
    } finally {
      this.inflightDiagnostics.delete(filePath);
    }
  }

  private async fetchDiagnostics(
    serverId: string,
    filePath: string,
  ): Promise<Diagnostic[]> {
    let client: LSPClient | null = null;
    try {
      client = await this.getOrCreateConnection(serverId, filePath);
    } catch {
      // LSP 连接失败时优雅降级
      throw new DiagnosticsFetchError("connection failed");
    }

    if (!client) {
      throw new DiagnosticsFetchError("no client available");
    }

    try {
      return await client.getDiagnostics(filePath);
    } catch {
      // 诊断获取失败时优雅降级
      throw new DiagnosticsFetchError("diagnostics fetch failed");
    }
  }

  /**
   * 获取或创建服务器实例
   */
  private getOrCreateServer(serverId: string): LSPServer | null {
    if (!this.servers.has(serverId)) {
      const server = LSPServerRegistry.create(serverId, this.config);
      if (server) {
        this.servers.set(serverId, server);
      }
    }
    return this.servers.get(serverId) || null;
  }

  /**
   * 清理过期连接
   */
  private async cleanupIfNeeded(): Promise<void> {
    if (this.connections.size < this.config.maxConnections) {
      return;
    }

    // 关闭最久未使用的连接
    const entries = Array.from(this.connections.entries());
    entries.sort((a, b) => a[1].getLastUsed() - b[1].getLastUsed());

    const toRemove = entries.slice(
      0,
      entries.length - this.config.maxConnections + 1
    );
    for (const [key, client] of toRemove) {
      await client.dispose();
      this.connections.delete(key);
    }
  }

  /**
   * 清理空闲超时的连接
   *
   * 定期调用以清理长时间未使用的连接
   */
  @TracedAs("lsp-manager.cleanupIdle", {
    recordParams: false,
    recordResult: true,
    resultFilter: (_result: void) => ({
      evicted_count: 0, // 占位：实际清理数量由内部 map.size 变化决定
      remaining_count: 0, // 占位：剩余连接数
    }),
  })
  async cleanupIdle(): Promise<void> {
    const now = Date.now();
    const idleTimeout = this.config.idleTimeout;

    for (const [key, client] of this.connections.entries()) {
      const elapsed = now - client.getLastUsed();
      if (elapsed > idleTimeout) {
        await client.dispose();
        this.connections.delete(key);
        // Task #2182: 清理关联的 ping 失败计数
        this.pingFailureCounts.delete(key);
      }
    }
  }

  /**
   * 执行健康检查，检测并移除已崩溃的连接
   *
   * 定期调用以检测死连接（服务器崩溃等）
   * 会移除不健康的连接并返回检查结果
   *
   * @returns 健康检查结果列表
   */
  async healthCheck(): Promise<HealthCheckResult[]> {
    return this.performHealthCheck();
  }

  /**
   * 执行健康检查的内部实现
   *
   * Task #2182 修复要点：
   * 1. **不再 ping 预热连接**（`_prewarmedConnections`）：
   *    预热连接本来就是 "ready but idle"，对它们做 ping 容易因 LSP server 暂
   *    时忙碌而误报，进而触发 dispose→SIGTERM 的误杀。预热连接的清理由
   *    `cleanupIdle` 路径统一处理（基于 `lastUsed` 时长），不依赖 ping。
   * 2. **活跃连接的连续 ping 失败容忍**（仅活跃 `connections`）：
   *    单次 ping 失败不立即 dispose，而是累加到 `pingFailureCounts[key]`。
   *    仅当连续失败次数 ≥ `unhealthyThreshold`（默认 3 次）才真正 dispose。
   *    这样可以避免 GC pause / 事件循环拥塞 / LSP server 暂时忙碌导致的
   *    单次瞬时失败触发误杀。
   * 3. **dispose 幂等**：调用 `client.dispose()` 多次不会出问题（已有守卫）。
   *
   * @returns 健康检查结果列表
   */
  private async performHealthCheck(): Promise<HealthCheckResult[]> {
    const results: HealthCheckResult[] = [];
    const keysToRemove: string[] = [];

    // 1) 检查活跃连接（仅 `connections`，不含预热）
    for (const [key, client] of this.connections.entries()) {
      const serverId = key.split(":")[0];
      const result: HealthCheckResult = {
        key,
        serverId,
        healthy: true,
      };

      try {
        // 先快速检查进程是否已退出（轻量、可靠）
        if (client.isDisposed()) {
          // 进程已退出，立即清理，不计入连续失败
          this.pingFailureCounts.delete(key);
          result.healthy = false;
          result.error = "Client already disposed";
          keysToRemove.push(key);
          results.push(result);
          continue;
        }

        // ping 检查活跃连接
        const isHealthy = await client.ping();
        if (isHealthy) {
          // ping 成功：重置失败计数
          this.pingFailureCounts.delete(key);
        } else {
          // ping 失败：累加失败次数
          const currentFailures = (this.pingFailureCounts.get(key) ?? 0) + 1;
          this.pingFailureCounts.set(key, currentFailures);

          if (currentFailures >= this.unhealthyThreshold) {
            // 连续失败达到阈值：真正 dispose
            result.healthy = false;
            result.error = `Connection ping failed ${currentFailures} consecutive times`;
            keysToRemove.push(key);
          } else {
            // 还没到阈值：标记 transient unhealthy，但仍保留连接
            result.healthy = false;
            result.error = `Transient ping failure ${currentFailures}/${this.unhealthyThreshold}`;
          }
        }
      } catch (error) {
        // ping 抛出异常：累加失败次数
        const currentFailures = (this.pingFailureCounts.get(key) ?? 0) + 1;
        this.pingFailureCounts.set(key, currentFailures);

        result.healthy = false;
        result.error = error instanceof Error ? error.message : String(error);
        if (currentFailures >= this.unhealthyThreshold) {
          keysToRemove.push(key);
        }
      }

      results.push(result);
    }

    // 2) 不再 ping 预热连接 —— 故意跳过
    //    预热连接由 `cleanupIdle` 基于 `lastUsed` 时长统一清理，
    //    不依赖 ping（ping 在 idle server 上误报率太高）。
    //    这里只把它们登记为 healthy（基于 isDisposed 快速判断）。
    for (const [key, client] of this._prewarmedConnections.entries()) {
      const serverId = key.split(":")[0];
      const result: HealthCheckResult = {
        key,
        serverId,
        healthy: true,
      };

      try {
        if (client.isDisposed()) {
          // 进程已退出：清理
          result.healthy = false;
          result.error = "Prewarmed client already disposed";
          keysToRemove.push(key);
        }
        // 故意不调用 client.ping() —— 避免误杀（见上方注释）
      } catch {
        // 忽略：预热连接的健康度不影响主流程
      }

      results.push(result);
    }

    // 移除不健康的连接
    for (const key of keysToRemove) {
      // 优先从活跃连接移除
      if (this.connections.has(key)) {
        const client = this.connections.get(key)!;
        await client.dispose().catch(() => {});
        this.connections.delete(key);
      }
      // 也要从预加载连接移除
      if (this._prewarmedConnections.has(key)) {
        const client = this._prewarmedConnections.get(key)!;
        await client.dispose().catch(() => {});
        this._prewarmedConnections.delete(key);
      }
      // 清理失败计数
      this.pingFailureCounts.delete(key);
    }

    return results;
  }

  /**
   * 获取连接统计信息
   *
   * @returns 连接统计信息
   */
  public getStats(): ConnectionStats {
    const connections: ConnectionStats["connections"] = [];

    // 收集活跃连接信息
    for (const [key, client] of this.connections.entries()) {
      const [serverId, root] = key.split(":");
      connections.push({
        key,
        serverId,
        root,
        lastUsed: client.getLastUsed(),
        isPrewarmed: false,
      });
    }

    // 收集预加载连接信息
    for (const [key, client] of this._prewarmedConnections.entries()) {
      const [serverId, root] = key.split(":");
      connections.push({
        key,
        serverId,
        root,
        lastUsed: client.getLastUsed(),
        isPrewarmed: true,
      });
    }

    return {
      activeConnections: this.connections.size,
      prewarmedConnections: this._prewarmedConnections.size,
      totalServers: this.servers.size,
      connections,
    };
  }

  /**
   * 释放所有资源
   */
  @TracedAs("lsp-manager.dispose", {
    recordParams: false,
    recordResult: false,
  })
  async dispose(): Promise<void> {
    // NEW-3: 停止合并后的单 tickTimer
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

    // 清理预加载的连接
    await Promise.all(
      Array.from(this._prewarmedConnections.values()).map((c) => c.dispose())
    );
    this._prewarmedConnections.clear();

    // 清理所有活跃连接
    await Promise.all(
      Array.from(this.connections.values()).map((c) => c.dispose())
    );
    this.connections.clear();
    this.servers.clear();
    this.inflightDiagnostics.clear();
    this.diagnosticCache.clear();
    // Task #2182: 清理 ping 失败计数
    this.pingFailureCounts.clear();
  }
}

// ============================================================================
// 全局 LSP Manager 单例
// ============================================================================

/**
 * 全局 LSP Manager 实例
 *
 * 整个进程共享同一个 LSP Manager 实例，
 * 实现跨组件的连接复用
 */
let globalManager: LSPManager | null = null;

/**
 * 全局 LSP Manager 配置
 */
let globalConfig: LSPManagerConfig | null = null;

/**
 * 获取全局 LSP Manager 实例
 */
export function getGlobalLSPManager(): LSPManager | null {
  return globalManager;
}

/**
 * 创建或获取全局 LSP Manager 实例
 *
 * @param config 初始化配置（仅首次调用生效）
 * @returns 全局 LSP Manager 实例
 */
export function createGlobalLSPManager(config?: LSPManagerConfig): LSPManager {
  if (!globalManager && config) {
    globalManager = new LSPManager(config);
    globalConfig = config;

    // 注册进程退出时的清理处理器
    globalManager.registerShutdownHandler();
  }

  if (!globalManager) {
    // 使用默认配置创建
    globalManager = new LSPManager({
      idleTimeout: 60000,
      maxConnections: 5,
      autoDownload: false,
    });
    globalManager.registerShutdownHandler();
  }

  return globalManager;
}

/**
 * 全局 LSP Manager 实例（惰性创建）
 */
export const globalLSPManager = new Proxy({} as LSPManager, {
  get(_target, prop) {
    const manager = createGlobalLSPManager(globalConfig ?? {
      idleTimeout: 60000,
      maxConnections: 5,
      autoDownload: false,
    });
    return (manager as any)[prop];
  },
});

/**
 * 清除全局 LSP Manager（主要用于测试）
 */
export function clearGlobalLSPManager(): void {
  if (globalManager) {
    globalManager.dispose().catch(() => {});
    globalManager = null as unknown as LSPManager;
    globalConfig = null;
  }
}
