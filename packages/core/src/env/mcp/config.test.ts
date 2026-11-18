import { describe, it, expect } from "vitest";
import path from "path";
import os from "os";
import {
  DEFAULT_MCP_CONFIG,
  MCP_CONFIG_KEYS,
  getMcpPathPriority,
} from "./config";

/**
 * TDD: 验证 MCP 配置
 */

describe("DEFAULT_MCP_CONFIG", () => {
  it("should have default mcpPaths with user type", () => {
    const userPath = DEFAULT_MCP_CONFIG.mcpPaths.find(p => p.type === "user");
    expect(userPath).toBeDefined();
    expect(userPath?.type).toBe("user");
    expect(userPath?.path).toContain(".config");
    expect(userPath?.path).toContain("roy-bot");
    expect(userPath?.path).toContain("mcp");
  });

  it("should have default mcpPaths with project type", () => {
    const projectPath = DEFAULT_MCP_CONFIG.mcpPaths.find(p => p.type === "project");
    expect(projectPath).toBeDefined();
    expect(projectPath?.type).toBe("project");
    expect(projectPath?.path).toBe(".roy/mcp");
  });

  it("should have default timeout of 30000", () => {
    expect(DEFAULT_MCP_CONFIG.timeout).toBe(30000);
  });

  it("should be enabled by default", () => {
    expect(DEFAULT_MCP_CONFIG.enabled).toBe(true);
  });
});

describe("MCP_CONFIG_KEYS", () => {
  it("should include mcp.enabled key", () => {
    expect(MCP_CONFIG_KEYS).toContain("mcp.enabled");
  });

  it("should include mcp.timeout key", () => {
    expect(MCP_CONFIG_KEYS).toContain("mcp.timeout");
  });

  it("should include mcp.mcpPaths key", () => {
    expect(MCP_CONFIG_KEYS).toContain("mcp.mcpPaths");
  });

  it("should include mcp.servers key", () => {
    expect(MCP_CONFIG_KEYS).toContain("mcp.servers");
  });
});

describe("getMcpPathPriority", () => {
  it("should return correct priority for user", () => {
    expect(getMcpPathPriority("user")).toBe(1);
  });

  it("should return correct priority for project", () => {
    expect(getMcpPathPriority("project")).toBe(2);
  });

  it("should return correct priority for custom", () => {
    expect(getMcpPathPriority("custom")).toBe(3);
  });

  it("should return 0 for unknown type", () => {
    expect(getMcpPathPriority("unknown")).toBe(0);
  });
});
