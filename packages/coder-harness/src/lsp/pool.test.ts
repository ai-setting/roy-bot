/**
 * @fileoverview LSPConnectionPool 测试
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LSPConnectionPool } from "./pool";
import type { LSPServerInfo } from "../types/linter";

describe("LSPConnectionPool", () => {
  let pool: LSPConnectionPool;

  beforeEach(() => {
    pool = new LSPConnectionPool();
  });

  afterEach(async () => {
    pool.disposeSync();
  });

  describe("constructor", () => {
    it("should create pool with default config", () => {
      const defaultPool = new LSPConnectionPool();
      expect(defaultPool).toBeDefined();
      expect(defaultPool.getActiveConnectionCount()).toBe(0);
      defaultPool.disposeSync();
    });

    it("should create pool with custom config", () => {
      const customPool = new LSPConnectionPool({
        idleTimeout: 30000,
        maxConnections: 5,
        autoDownload: true,
      });
      expect(customPool).toBeDefined();
      const config = customPool.getConfig();
      expect(config.idleTimeout).toBe(30000);
      expect(config.maxConnections).toBe(5);
      expect(config.autoDownload).toBe(true);
      customPool.disposeSync();
    });
  });

  describe("registerServer", () => {
    it("should register and retrieve server", () => {
      const info: LSPServerInfo = {
        id: "typescript",
        extensions: [".ts"],
        rootPattern: ["tsconfig.json"],
        command: ["tsserver"],
      };

      pool.registerServer(info);
      expect(pool.getServer("typescript")).toEqual(info);
    });

    it("should return undefined for non-existent server", () => {
      expect(pool.getServer("python")).toBeUndefined();
    });

    it("should register multiple servers", () => {
      const tsServer: LSPServerInfo = {
        id: "typescript",
        extensions: [".ts"],
        rootPattern: ["tsconfig.json"],
        command: ["tsserver"],
      };

      const pyServer: LSPServerInfo = {
        id: "python",
        extensions: [".py"],
        rootPattern: ["pyproject.toml"],
        command: ["pylsp"],
      };

      pool.registerServers([tsServer, pyServer]);

      expect(pool.getServer("typescript")).toEqual(tsServer);
      expect(pool.getServer("python")).toEqual(pyServer);
    });
  });

  describe("getActiveConnections", () => {
    it("should return empty map when no connections", () => {
      const connections = pool.getActiveConnections();
      expect(connections.size).toBe(0);
    });
  });

  describe("hasServer", () => {
    it("should return true for registered server", () => {
      const info: LSPServerInfo = {
        id: "typescript",
        extensions: [".ts"],
        rootPattern: ["tsconfig.json"],
        command: ["tsserver"],
      };

      pool.registerServer(info);
      expect(pool.hasServer("typescript")).toBe(true);
    });

    it("should return false for non-registered server", () => {
      expect(pool.hasServer("python")).toBe(false);
    });
  });

  describe("getAllServers", () => {
    it("should return empty array when no servers registered", () => {
      expect(pool.getAllServers()).toEqual([]);
    });

    it("should return all registered servers", () => {
      const servers: LSPServerInfo[] = [
        {
          id: "typescript",
          extensions: [".ts"],
          rootPattern: ["tsconfig.json"],
          command: ["tsserver"],
        },
        {
          id: "python",
          extensions: [".py"],
          rootPattern: ["pyproject.toml"],
          command: ["pylsp"],
        },
      ];

      pool.registerServers(servers);
      expect(pool.getAllServers()).toEqual(servers);
    });
  });

  describe("dispose", () => {
    it("should dispose all connections", async () => {
      await pool.dispose();
      expect(pool.getActiveConnectionCount()).toBe(0);
    });
  });
});
