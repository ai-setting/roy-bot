/**
 * @fileoverview LSPServer 测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LSPServer, LSPServerRegistry } from "./server";

describe("LSPServer", () => {
  describe("SERVERS", () => {
    it("should have typescript server defined", () => {
      const server = LSPServerRegistry.get("typescript");
      expect(server).toBeDefined();
      expect(server?.id).toBe("typescript");
      expect(server?.extensions).toContain(".ts");
    });

    it("should have python server defined", () => {
      const server = LSPServerRegistry.get("python");
      expect(server).toBeDefined();
      expect(server?.id).toBe("python");
      expect(server?.extensions).toContain(".py");
    });

    it("should have vue server defined", () => {
      const server = LSPServerRegistry.get("vue");
      expect(server).toBeDefined();
      expect(server?.id).toBe("vue");
      expect(server?.extensions).toContain(".vue");
    });

    it("should have css server defined", () => {
      const server = LSPServerRegistry.get("css");
      expect(server).toBeDefined();
      expect(server?.id).toBe("css");
      expect(server?.extensions).toContain(".css");
    });

    it("should have html server defined", () => {
      const server = LSPServerRegistry.get("html");
      expect(server).toBeDefined();
      expect(server?.id).toBe("html");
      expect(server?.extensions).toContain(".html");
    });

    it("should have json server defined", () => {
      const server = LSPServerRegistry.get("json");
      expect(server).toBeDefined();
      expect(server?.id).toBe("json");
      expect(server?.extensions).toContain(".json");
    });

    it("should have markdown server defined with clientFactory", () => {
      const server = LSPServerRegistry.get("markdown");
      expect(server).toBeDefined();
      expect(server?.id).toBe("markdown");
      expect(server?.extensions).toContain(".md");
      expect(server?.extensions).toContain(".markdown");
      // markdown server 必须提供自定义 clientFactory（用于注册 markdown/parse 处理器）
      expect(typeof server?.clientFactory).toBe("function");
    });
  });

  describe("LSPServerRegistry", () => {
    it("should return all server IDs", () => {
      const ids = LSPServerRegistry.getServerIds();
      expect(ids).toContain("typescript");
      expect(ids).toContain("python");
      expect(ids).toContain("vue");
    });

    it("should return undefined for unknown server", () => {
      const server = LSPServerRegistry.get("unknown");
      expect(server).toBeUndefined();
    });
  });

  describe("findRoot", () => {
    it("should be a function on LSPServer instance", () => {
      const server = LSPServerRegistry.create("typescript", {
        idleTimeout: 60000,
        maxConnections: 5,
        autoDownload: false,
      });
      expect(typeof server?.findRoot).toBe("function");
    });
  });

  describe("createClient", () => {
    it("should be a function on LSPServer instance", () => {
      const server = LSPServerRegistry.create("typescript", {
        idleTimeout: 60000,
        maxConnections: 5,
        autoDownload: false,
      });
      expect(typeof server?.createClient).toBe("function");
    });
  });
});
