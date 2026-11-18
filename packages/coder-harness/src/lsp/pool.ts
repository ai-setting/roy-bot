/**
 * @fileoverview LSP 连接池实现
 * 
 * 管理多个 LSP 服务器连接，支持连接复用和生命周期管理
 */

import type { LSPClient } from "./client";
import type { LSPServerInfo, LSPManagerConfig } from "../types/linter";

/**
 * 连接键
 */
export interface ConnectionKey {
  /** 服务器 ID */
  serverId: string;
  /** 工作区根目录 */
  root: string;
}

/**
 * 连接键字符串化
 */
function toConnectionKey(key: ConnectionKey): string {
  return `${key.serverId}:${key.root}`;
}

/**
 * 部分 LSP 配置（允许部分属性缺失）
 */
interface PartialLSPManagerConfig {
  idleTimeout?: number;
  maxConnections?: number;
  autoDownload?: boolean;
  cleanupInterval?: number;
  healthCheckInterval?: number;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: Required<PartialLSPManagerConfig> = {
  idleTimeout: 60000,        // 1 分钟空闲超时
  maxConnections: 10,        // 最大连接数
  autoDownload: false,       // 不自动下载
  cleanupInterval: 30000,    // 30 秒清理间隔
  healthCheckInterval: 60000 // 60 秒健康检查间隔
};

/**
 * LSP 连接池
 * 
 * 管理 LSP 连接的创建、复用和销毁
 */
export class LSPConnectionPool {
  /** 连接映射表 */
  private connections: Map<string, LSPClient>;
  /** 服务器信息映射表 */
  private servers: Map<string, LSPServerInfo>;
  /** 配置 */
  private config: Required<PartialLSPManagerConfig>;

  constructor(config: PartialLSPManagerConfig = {}) {
    this.connections = new Map();
    this.servers = new Map();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 获取连接
   */
  getConnection(serverId: string, root: string): LSPClient | undefined {
    const key = toConnectionKey({ serverId, root });
    return this.connections.get(key);
  }

  /**
   * 设置连接
   */
  setConnection(key: ConnectionKey, client: LSPClient): void {
    const keyStr = toConnectionKey(key);
    
    // 如果已达最大连接数，清理一个空闲连接
    if (this.connections.size >= this.config.maxConnections) {
      this.cleanupIdleConnection();
    }
    
    this.connections.set(keyStr, client);
  }

  /**
   * 移除连接
   */
  removeConnection(key: string): void {
    const client = this.connections.get(key);
    if (client) {
      client.disposeSync();
      this.connections.delete(key);
    }
  }

  /**
   * 移除指定服务器和根目录的连接
   */
  removeConnectionByKey(serverId: string, root: string): void {
    const key = toConnectionKey({ serverId, root });
    this.removeConnection(key);
  }

  /**
   * 获取服务器信息
   */
  getServer(serverId: string): LSPServerInfo | undefined {
    return this.servers.get(serverId);
  }

  /**
   * 注册服务器
   */
  registerServer(info: LSPServerInfo): void {
    this.servers.set(info.id, info);
  }

  /**
   * 批量注册服务器
   */
  registerServers(infos: LSPServerInfo[]): void {
    for (const info of infos) {
      this.registerServer(info);
    }
  }

  /**
   * 获取所有活跃连接
   */
  getActiveConnections(): Map<string, LSPClient> {
    return new Map(this.connections);
  }

  /**
   * 获取活跃连接数
   */
  getActiveConnectionCount(): number {
    return this.connections.size;
  }

  /**
   * 清理一个空闲连接
   */
  private cleanupIdleConnection(): void {
    let oldest: { key: string; lastUsed: number } | null = null;

    for (const [key, client] of this.connections) {
      if (!oldest || client.getLastUsed() < oldest.lastUsed) {
        oldest = { key, lastUsed: client.getLastUsed() };
      }
    }

    if (oldest) {
      this.removeConnection(oldest.key);
    }
  }

  /**
   * 清理所有空闲连接
   */
  cleanupIdleConnections(): void {
    const now = Date.now();
    const keysToRemove: string[] = [];

    for (const [key, client] of this.connections) {
      if (now - client.getLastUsed() > this.config.idleTimeout) {
        keysToRemove.push(key);
      }
    }

    for (const key of keysToRemove) {
      this.removeConnection(key);
    }
  }

  /**
   * 获取配置
   */
  getConfig(): LSPManagerConfig {
    return { ...this.config };
  }

  /**
   * 检查服务器是否已注册
   */
  hasServer(serverId: string): boolean {
    return this.servers.has(serverId);
  }

  /**
   * 获取所有已注册的服务器
   */
  getAllServers(): LSPServerInfo[] {
    return Array.from(this.servers.values());
  }

  /**
   * 销毁连接池
   */
  async dispose(): Promise<void> {
    const disposePromises: Promise<void>[] = [];

    for (const [, client] of this.connections) {
      disposePromises.push(client.dispose());
    }

    await Promise.all(disposePromises);
    this.connections.clear();
    this.servers.clear();
  }

  /**
   * 同步销毁（用于进程退出时）
   */
  disposeSync(): void {
    for (const [, client] of this.connections) {
      client.disposeSync();
    }
    this.connections.clear();
    this.servers.clear();
  }
}
