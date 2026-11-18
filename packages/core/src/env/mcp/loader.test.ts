import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import { McpLoader } from "./loader";
import type { DiscoveredMcpServer, McpServerConfig } from "./types";

describe("McpLoader", () => {
  let loader: McpLoader;

  beforeEach(() => {
    loader = new McpLoader(30000);
  });

  describe("buildDefaultConfig", () => {
    it("should build local config with bun run command", () => {
      const server: DiscoveredMcpServer = {
        name: "test-mcp",
        serverDir: "/path/to/server",
        entryPath: "/path/to/server.ts",
      };

      const config = loader.buildDefaultConfig(server);

      expect(config.type).toBe("local");
      expect((config as any).command).toEqual(["bun", "run", "/path/to/server.ts"]);
      expect((config as any).cwd).toBe("/path/to/server");
    });

    it("should omit cwd when serverDir is undefined", () => {
      const server: DiscoveredMcpServer = {
        name: "test-mcp",
        entryPath: "/path/to/server.ts",
      };

      const config = loader.buildDefaultConfig(server) as McpServerConfig & { cwd?: string };

      expect(config.type).toBe("local");
      expect(config.cwd).toBeUndefined();
    });

    it("should use directoryConfig command if present", () => {
      const server: DiscoveredMcpServer = {
        name: "test-mcp",
        entryPath: "/path/to/server.ts",
        directoryConfig: {
          command: ["node", "/path/to/server.js"],
        },
        defaultCommand: ["node", "/path/to/server.js"],
      };

      const config = loader.buildDefaultConfig(server);

      expect(config.type).toBe("local");
      expect((config as any).command).toEqual(["node", "/path/to/server.js"]);
    });

    it("should build remote config from directoryConfig", () => {
      const server: DiscoveredMcpServer = {
        name: "remote-mcp",
        directoryConfig: {
          type: "remote",
          url: "https://mcp.example.com",
          enabled: true,
        },
      };

      const config = loader.buildDefaultConfig(server);

      expect(config.type).toBe("remote");
      expect((config as any).url).toBe("https://mcp.example.com");
    });

    it("should set enabled by default", () => {
      const server: DiscoveredMcpServer = {
        name: "test-mcp",
      };

      const config = loader.buildDefaultConfig(server);

      expect(config.enabled).toBe(true);
    });

    it("should use directoryConfig timeout if present", () => {
      const server: DiscoveredMcpServer = {
        name: "test-mcp",
        directoryConfig: {
          timeout: 60000,
        },
      };

      const config = loader.buildDefaultConfig(server);

      expect((config as any).timeout).toBe(60000);
    });
  });

  describe("mergeConfig", () => {
    it("should merge explicit config over default", () => {
      const defaultConfig: McpServerConfig = {
        type: "local",
        command: ["bun", "run", "server.ts"],
        enabled: true,
      };

      const merged = loader.mergeConfig(defaultConfig, {
        timeout: 60000,
      });

      expect((merged as any).command).toEqual(["bun", "run", "server.ts"]);
      expect((merged as any).timeout).toBe(60000);
    });

    it("should disable when explicit enabled is false", () => {
      const defaultConfig: McpServerConfig = {
        type: "local",
        command: ["bun", "run", "server.ts"],
        enabled: true,
      };

      const merged = loader.mergeConfig(defaultConfig, {
        enabled: false,
      });

      expect(merged.enabled).toBe(false);
    });

    it("should return default when no explicit config", () => {
      const defaultConfig: McpServerConfig = {
        type: "local",
        command: ["bun", "run", "server.ts"],
        enabled: true,
      };

      const merged = loader.mergeConfig(defaultConfig, undefined);

      expect(merged).toBe(defaultConfig);
    });

    it("should merge local config correctly", () => {
      const defaultConfig: McpServerConfig = {
        type: "local",
        command: ["bun", "run", "server.ts"],
        enabled: true,
        environment: { NODE_ENV: "development" },
      };

      const merged = loader.mergeConfig(defaultConfig, {
        environment: { NODE_ENV: "production" },
      });

      expect((merged as any).environment).toEqual({ NODE_ENV: "production" });
    });
  });

  describe("getClient", () => {
    it("should return undefined for non-existent client", () => {
      const client = loader.getClient("non-existent");
      expect(client).toBeUndefined();
    });
  });

  describe("getAllClients", () => {
    it("should return empty map initially", () => {
      const clients = loader.getAllClients();
      expect(clients.size).toBe(0);
    });
  });

  describe("isConnected", () => {
    it("should return false for non-connected server", () => {
      expect(loader.isConnected("test")).toBe(false);
    });
  });

  describe("loadMinimaxApiKey", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("should return minimax API key from auth.json", async () => {
      vi.spyOn(fs, "readFile").mockResolvedValue(
        JSON.stringify({ providers: { minimax: { apiKey: "test-key-123" } } })
      );

      const apiKey = await loader.loadMinimaxApiKey();

      expect(apiKey).toBe("test-key-123");
    });

    it("should return undefined when auth.json is missing", async () => {
      vi.spyOn(fs, "readFile").mockRejectedValue(new Error("ENOENT"));

      const apiKey = await loader.loadMinimaxApiKey();

      expect(apiKey).toBeUndefined();
    });
  });

  describe("injectMinimaxEnv", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("should inject MINIMAX_API_KEY and MINIMAX_API_HOST into env", async () => {
      vi.spyOn(fs, "readFile").mockResolvedValue(
        JSON.stringify({ providers: { minimax: { apiKey: "injected-key" } } })
      );

      const env: Record<string, string> = {};
      await loader.injectMinimaxEnv(env);

      expect(env["MINIMAX_API_KEY"]).toBe("injected-key");
      expect(env["MINIMAX_API_HOST"]).toBe("https://api.minimaxi.com");
    });

    it("should not overwrite existing MINIMAX_API_KEY", async () => {
      const readFileSpy = vi.spyOn(fs, "readFile");

      const env: Record<string, string> = {
        MINIMAX_API_KEY: "existing-key",
      };
      await loader.injectMinimaxEnv(env);

      expect(env["MINIMAX_API_KEY"]).toBe("existing-key");
      expect(readFileSpy).not.toHaveBeenCalled();
    });

    it("should not inject when auth.json has no minimax key", async () => {
      vi.spyOn(fs, "readFile").mockResolvedValue(JSON.stringify({ providers: {} }));

      const env: Record<string, string> = {};
      await loader.injectMinimaxEnv(env);

      expect(env["MINIMAX_API_KEY"]).toBeUndefined();
    });
  });
});
