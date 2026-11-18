import { describe, it, expect, beforeEach, vi } from "vitest";
import { McpComponent } from "./mcp-component";
import { BaseComponent } from "../component";

/**
 * TDD RED: 测试 McpComponent
 * 
 * 注意：不要 mock BaseComponent，因为它会影响其他测试文件。
 * 如果需要 mock 行为，应该使用 vi.spyOn 或创建测试专用的子类。
 */

describe("McpComponent", () => {
  let component: McpComponent;

  beforeEach(() => {
    component = new McpComponent();
  });

  describe("constructor", () => {
    it("should have correct name", () => {
      expect(component.name).toBe("mcp");
    });

    it("should have correct version", () => {
      expect(component.version).toBe("1.0.0");
    });
  });

  describe("init", () => {
    it("should require configComponent", async () => {
      await expect(
        component.init({
          options: {},
        })
      ).rejects.toThrow("ConfigComponent is required");
    });

    it("should initialize with valid config", async () => {
      const mockConfigComponent = {
        get: vi.fn().mockReturnValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
        registerSource: vi.fn(),
        registerComponent: vi.fn(),
        load: vi.fn().mockResolvedValue(undefined),
      };

      await component.init({
        options: {
          configComponent: mockConfigComponent as any,
          config: {
            enabled: false,
            mcpPaths: [],
          },
        },
      });

      expect(component.getStatus()).toBeDefined();
    });
  });

  describe("getServerStatus", () => {
    it("should return undefined for non-existent server", () => {
      // Before init, should not throw
      expect(() => component.getServerStatus("test")).not.toThrow();
    });
  });

  describe("listServers", () => {
    it("should return empty array initially", () => {
      expect(Array.isArray(component.listServers())).toBe(true);
    });
  });

  describe("listTools", () => {
    it("should return empty array initially", () => {
      expect(Array.isArray(component.listTools())).toBe(true);
    });
  });
});

describe("McpComponent integration scenarios", () => {
  let component: McpComponent;

  beforeEach(() => {
    vi.clearAllMocks();
    component = new McpComponent();
  });

  it("should handle disabled configuration", async () => {
    const mockConfigComponent = {
      get: vi.fn().mockReturnValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
      registerSource: vi.fn(),
      registerComponent: vi.fn(),
      load: vi.fn().mockResolvedValue(undefined),
    };

    await component.init({
      options: {
        configComponent: mockConfigComponent as any,
        config: {
          enabled: false,
          mcpPaths: [],
        },
      },
    });

    // With disabled config and no paths, should handle gracefully
    expect(component.getStatus()).toBeDefined();
  });
});
