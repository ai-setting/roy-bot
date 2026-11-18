import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { McpScanner } from "./scanner";
import type { McpPath } from "./config";

/**
 * TDD RED: 测试 McpScanner
 */

describe("McpScanner", () => {
  const tempDir = path.join(os.tmpdir(), "mcp-scanner-test-" + Date.now());

  beforeEach(async () => {
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("scan", () => {
    it("should return empty map when path does not exist", async () => {
      const scanner = new McpScanner([
        { type: "user" as const, path: "/non/existent/path" },
      ]);
      const servers = await scanner.scan();
      expect(servers.size).toBe(0);
    });

    it("should discover servers from directory", async () => {
      // 创建测试目录结构
      await fs.mkdir(path.join(tempDir, "test-mcp"));
      await fs.writeFile(
        path.join(tempDir, "test-mcp", "server.ts"),
        "console.log('hello')"
      );

      const scanner = new McpScanner([
        { type: "user" as const, path: tempDir },
      ]);
      const servers = await scanner.scan();

      expect(servers.size).toBe(1);
      expect(servers.has("test-mcp")).toBe(true);
    });

    it("should find entryPath for discovered server", async () => {
      await fs.mkdir(path.join(tempDir, "my-server"));
      await fs.writeFile(
        path.join(tempDir, "my-server", "server.ts"),
        "export default {}"
      );

      const scanner = new McpScanner([
        { type: "user" as const, path: tempDir },
      ]);
      const servers = await scanner.scan();

      const server = servers.get("my-server");
      expect(server?.entryPath).toContain("server.ts");
    });

    it("should skip non-directory entries", async () => {
      await fs.writeFile(path.join(tempDir, "not-a-server.txt"), "content");

      const scanner = new McpScanner([
        { type: "user" as const, path: tempDir },
      ]);
      const servers = await scanner.scan();

      expect(servers.size).toBe(0);
    });

    it("should find index.ts as entry point", async () => {
      await fs.mkdir(path.join(tempDir, "index-server"));
      await fs.writeFile(
        path.join(tempDir, "index-server", "index.ts"),
        "export default {}"
      );

      const scanner = new McpScanner([
        { type: "user" as const, path: tempDir },
      ]);
      const servers = await scanner.scan();

      const server = servers.get("index-server");
      expect(server?.entryPath).toContain("index.ts");
    });

    it("should load config.jsonc if exists", async () => {
      await fs.mkdir(path.join(tempDir, "config-server"));
      await fs.writeFile(
        path.join(tempDir, "config-server", "server.ts"),
        "export default {}"
      );
      await fs.writeFile(
        path.join(tempDir, "config-server", "config.jsonc"),
        JSON.stringify({ enabled: true, timeout: 60000 })
      );

      const scanner = new McpScanner([
        { type: "user" as const, path: tempDir },
      ]);
      const servers = await scanner.scan();

      const server = servers.get("config-server");
      expect(server?.configPath).toContain("config.jsonc");
      expect(server?.directoryConfig?.enabled).toBe(true);
    });

    it("should resolve npx command to local node_modules/.bin", async () => {
      const serverDir = path.join(tempDir, "npx-server");
      const binDir = path.join(serverDir, "node_modules", ".bin");
      await fs.mkdir(binDir, { recursive: true });
      const binPath = path.join(binDir, "demo-mcp");
      await fs.writeFile(binPath, "#!/usr/bin/env node\n");
      await fs.writeFile(
        path.join(serverDir, "config.jsonc"),
        JSON.stringify({ command: ["npx", "demo-mcp"] })
      );

      const scanner = new McpScanner([
        { type: "user" as const, path: tempDir },
      ]);
      const servers = await scanner.scan();

      const server = servers.get("npx-server");
      expect(server?.defaultCommand).toEqual([binPath]);
      expect(server?.serverDir).toBe(serverDir);
    });

    it("should map relative entry command from ENTRY_SCRIPT_CANDIDATES", async () => {
      const serverDir = path.join(tempDir, "entry-server");
      const entryPath = path.join(serverDir, "src", "server.ts");
      await fs.mkdir(path.dirname(entryPath), { recursive: true });
      await fs.writeFile(entryPath, "export {}");
      await fs.writeFile(
        path.join(serverDir, "config.jsonc"),
        JSON.stringify({ command: ["bun", "run", "src/server.ts"] })
      );

      const scanner = new McpScanner([
        { type: "user" as const, path: tempDir },
      ]);
      const servers = await scanner.scan();

      const server = servers.get("entry-server");
      expect(server?.defaultCommand).toEqual(["bun", "run", entryPath]);
    });

    it("should support multiple paths", async () => {
      const tempDir2 = path.join(os.tmpdir(), "mcp-scanner-test2-" + Date.now());
      await fs.mkdir(tempDir2, { recursive: true });

      await fs.mkdir(path.join(tempDir, "server1"));
      await fs.writeFile(
        path.join(tempDir, "server1", "server.ts"),
        "export default {}"
      );

      await fs.mkdir(path.join(tempDir2, "server2"));
      await fs.writeFile(
        path.join(tempDir2, "server2", "server.ts"),
        "export default {}"
      );

      const scanner = new McpScanner([
        { type: "user" as const, path: tempDir },
        { type: "custom" as const, path: tempDir2 },
      ]);
      const servers = await scanner.scan();

      expect(servers.size).toBe(2);
      expect(servers.has("server1")).toBe(true);
      expect(servers.has("server2")).toBe(true);

      await fs.rm(tempDir2, { recursive: true, force: true });
    });
  });

  describe("getServers", () => {
    it("should return scanned servers", async () => {
      await fs.mkdir(path.join(tempDir, "cached-server"));
      await fs.writeFile(
        path.join(tempDir, "cached-server", "server.ts"),
        "export default {}"
      );

      const scanner = new McpScanner([
        { type: "user" as const, path: tempDir },
      ]);
      await scanner.scan();

      const servers = scanner.getServers();
      expect(servers.size).toBe(1);
      expect(servers.has("cached-server")).toBe(true);
    });

    it("should return empty map before scan", () => {
      const scanner = new McpScanner([
        { type: "user" as const, path: tempDir },
      ]);

      const servers = scanner.getServers();
      expect(servers.size).toBe(0);
    });
  });
});
