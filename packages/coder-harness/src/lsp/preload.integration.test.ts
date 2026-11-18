/**
 * @fileoverview LSP 预加载和生命周期集成测试
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import { LSPManager, createGlobalLSPManager, getGlobalLSPManager, globalLSPManager, clearGlobalLSPManager } from "./manager";
import type { LSPManagerConfig } from "../types/linter";

// Mock LSPManager 内部组件
class MockLSPClient {
  disposed = false;
  lastUsed = Date.now();
  
  async ping(): Promise<boolean> { return true; }
  async getDiagnostics(): Promise<any[]> { return []; }
  getLastUsed(): number { return this.lastUsed; }
  async dispose(): Promise<void> { this.disposed = true; }
}

describe("LSP Preload Integration", () => {
  // 测试配置
  const testConfig: LSPManagerConfig = {
    idleTimeout: 5000,
    maxConnections: 5,
    autoDownload: false,
    preloadLanguages: ["typescript"],
  };

  // 清理全局状态，避免测试间相互影响
  afterEach(async () => {
    clearGlobalLSPManager();
  });

  describe("Global LSP Manager Lifecycle", () => {

    it("should create global manager with config", () => {
      const manager = createGlobalLSPManager(testConfig);
      expect(manager).toBeDefined();
      expect(typeof manager.dispose).toBe("function");
      expect(typeof manager.prewarm).toBe("function");
      expect(typeof manager.registerShutdownHandler).toBe("function");
    });

    it("should return same instance for multiple calls", () => {
      const manager1 = createGlobalLSPManager(testConfig);
      const manager2 = createGlobalLSPManager();
      expect(manager1).toBe(manager2);
    });

    it("should have shutdown handler registration", () => {
      const manager = createGlobalLSPManager(testConfig);
      expect(typeof manager.registerShutdownHandler).toBe("function");
      
      // 注册应该不抛出错误
      expect(() => manager.registerShutdownHandler()).not.toThrow();
    });

    it("should dispose all connections", async () => {
      const manager = createGlobalLSPManager(testConfig);
      
      // 调用 dispose 不应该抛出错误
      try {
        await manager.dispose();
      } catch (error) {
        expect(error).toBeUndefined();
      }
      
      // 多次调用应该安全
      try {
        await manager.dispose();
      } catch (error) {
        expect(error).toBeUndefined();
      }
    });
  });

  describe("Prewarm functionality", () => {
    it("should have prewarm method", () => {
      const manager = createGlobalLSPManager(testConfig);
      expect(typeof manager.prewarm).toBe("function");
    });

    it("should return promise from prewarm", async () => {
      const manager = createGlobalLSPManager(testConfig);
      const result = manager.prewarm();
      
      // prewarm 返回 Promise，但可能因为缺少二进制而失败
      expect(result).toBeInstanceOf(Promise);
      
      // Don't await - prewarm may fail in test env without LSP binaries
      // Just verify it returns a Promise
    });
  });

  describe("Connection stats", () => {
    it("should provide connection statistics", () => {
      const manager = createGlobalLSPManager(testConfig);
      const stats = manager.getStats();
      
      expect(stats).toBeDefined();
      expect(typeof stats.activeConnections).toBe("number");
      expect(typeof stats.prewarmedConnections).toBe("number");
      expect(typeof stats.totalServers).toBe("number");
      expect(Array.isArray(stats.connections)).toBe(true);
    });
  });
});

describe("LSP Preload Configuration", () => {
  it("should support preloadLanguages in config", () => {
    const config: LSPManagerConfig = {
      idleTimeout: 60000,
      maxConnections: 10,
      autoDownload: false,
      preloadLanguages: ["typescript", "python"],
    };
    
    const manager = new LSPManager(config);
    expect(manager).toBeDefined();
    manager.dispose();
  });

  it("should support cleanupInterval in config", () => {
    const config: LSPManagerConfig = {
      idleTimeout: 60000,
      maxConnections: 5,
      autoDownload: false,
      cleanupInterval: 15000, // 15 秒
    };
    
    const manager = new LSPManager(config);
    expect(manager).toBeDefined();
    manager.dispose();
  });

  it("should support healthCheckInterval in config", () => {
    const config: LSPManagerConfig = {
      idleTimeout: 60000,
      maxConnections: 5,
      autoDownload: false,
      healthCheckInterval: 30000, // 30 秒
    };
    
    const manager = new LSPManager(config);
    expect(manager).toBeDefined();
    manager.dispose();
  });
});
