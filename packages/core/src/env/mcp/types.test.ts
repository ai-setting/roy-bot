import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  McpServerLocalConfigSchema,
  McpServerRemoteConfigSchema,
  McpServerConfigSchema,
  type DiscoveredMcpServer,
  type McpServerStatus,
} from "./types";

/**
 * TDD: 验证 MCP 类型定义
 */

describe("McpServerLocalConfigSchema", () => {
  it("should validate valid local server config", () => {
    const localConfig = {
      type: "local",
      command: ["bun", "run", "server.ts"],
    };

    const result = McpServerLocalConfigSchema.safeParse(localConfig);
    expect(result.success).toBe(true);
  });

  it("should accept optional fields", () => {
    const localConfig = {
      type: "local",
      command: ["bun", "run", "server.ts"],
      environment: { NODE_ENV: "production" },
      enabled: true,
      timeout: 60000,
    };

    const result = McpServerLocalConfigSchema.safeParse(localConfig);
    expect(result.success).toBe(true);
  });

  it("should reject empty command", () => {
    const localConfig = {
      type: "local",
      command: [],
    };

    const result = McpServerLocalConfigSchema.safeParse(localConfig);
    expect(result.success).toBe(false);
  });

  it("should reject wrong type", () => {
    const localConfig = {
      type: "remote",
      command: ["bun", "run", "server.ts"],
    };

    const result = McpServerLocalConfigSchema.safeParse(localConfig);
    expect(result.success).toBe(false);
  });
});

describe("McpServerRemoteConfigSchema", () => {
  it("should validate valid remote server config", () => {
    const remoteConfig = {
      type: "remote",
      url: "https://mcp.example.com",
    };

    const result = McpServerRemoteConfigSchema.safeParse(remoteConfig);
    expect(result.success).toBe(true);
  });

  it("should accept optional headers", () => {
    const remoteConfig = {
      type: "remote",
      url: "https://mcp.example.com",
      headers: { Authorization: "Bearer token" },
    };

    const result = McpServerRemoteConfigSchema.safeParse(remoteConfig);
    expect(result.success).toBe(true);
  });

  it("should reject invalid url", () => {
    const remoteConfig = {
      type: "remote",
      url: "not-a-url",
    };

    const result = McpServerRemoteConfigSchema.safeParse(remoteConfig);
    expect(result.success).toBe(false);
  });
});

describe("McpServerConfigSchema", () => {
  it("should validate local config", () => {
    const config = {
      type: "local",
      command: ["bun", "run", "server.ts"],
    };

    const result = McpServerConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("should validate remote config", () => {
    const config = {
      type: "remote",
      url: "https://mcp.example.com",
    };

    const result = McpServerConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("should reject invalid discriminated union", () => {
    const config = {
      type: "invalid",
    };

    const result = McpServerConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});

describe("DiscoveredMcpServer", () => {
  it("should have required name field", () => {
    const server: DiscoveredMcpServer = {
      name: "test-mcp",
    };

    expect(server.name).toBe("test-mcp");
    expect(server.entryPath).toBeUndefined();
  });

  it("should allow optional fields", () => {
    const server: DiscoveredMcpServer = {
      name: "test-mcp",
      entryPath: "/path/to/server.ts",
      configPath: "/path/to/config.jsonc",
      packagePath: "/path/to/package.json",
      directoryConfig: { enabled: true },
    };

    expect(server.entryPath).toBe("/path/to/server.ts");
    expect(server.directoryConfig?.enabled).toBe(true);
  });
});

describe("McpServerStatus", () => {
  it("should have required fields", () => {
    const status: McpServerStatus = {
      name: "test-server",
      status: "connected",
    };

    expect(status.name).toBe("test-server");
    expect(status.status).toBe("connected");
  });

  it("should allow optional fields", () => {
    const status: McpServerStatus = {
      name: "test-server",
      status: "error",
      error: "Connection failed",
      toolsCount: 5,
    };

    expect(status.status).toBe("error");
    expect(status.error).toBe("Connection failed");
    expect(status.toolsCount).toBe(5);
  });
});
