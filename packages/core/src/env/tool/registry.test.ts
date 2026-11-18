import { describe, test, expect, beforeEach } from "bun:test";
import { z } from "zod";
import { ToolRegistry } from "./registry";
import type { Tool, ToolRegistration, ToolListFilter } from "./types";

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  // Helper to create a mock tool
  const createMockTool = (name: string, category?: string): Tool => ({
    name,
    description: `Description for ${name}`,
    parameters: z.object({
      input: z.string().describe("Test input"),
    }),
    execute: async () => ({
      success: true,
      output: "ok",
      metadata: { execution_time_ms: 0 },
    }),
    metadata: category ? { category } : undefined,
  });

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  describe("register", () => {
    test("should register a tool", () => {
      const tool = createMockTool("test-tool");
      const registration: ToolRegistration = {
        tool,
        registeredAt: Date.now(),
        source: "built-in",
        enabled: true,
      };

      registry.register(tool, registration);

      expect(registry.has("test-tool")).toBe(true);
      expect(registry.getTool("test-tool")?.tool.name).toBe("test-tool");
    });

    test("should overwrite existing tool with same name", () => {
      const tool1 = createMockTool("test-tool");
      const tool2 = createMockTool("test-tool");

      registry.register(tool1, { tool: tool1, registeredAt: 1, source: "built-in", enabled: true });
      registry.register(tool2, { tool: tool2, registeredAt: 2, source: "dynamic", enabled: true });

      expect(registry.getTool("test-tool")?.tool).toBe(tool2);
      expect(registry.getTool("test-tool")?.source).toBe("dynamic");
    });
  });

  describe("unregister", () => {
    test("should unregister a tool", () => {
      const tool = createMockTool("test-tool");
      registry.register(tool, { tool, registeredAt: 1, source: "built-in", enabled: true });

      expect(registry.unregister("test-tool")).toBe(true);
      expect(registry.has("test-tool")).toBe(false);
    });

    test("should return false when unregistering non-existent tool", () => {
      expect(registry.unregister("non-existent")).toBe(false);
    });
  });

  describe("getTool", () => {
    test("should return registered tool", () => {
      const tool = createMockTool("test-tool");
      registry.register(tool, { tool, registeredAt: 1, source: "built-in", enabled: true });

      const result = registry.getTool("test-tool");
      expect(result?.tool.name).toBe("test-tool");
    });

    test("should return undefined for non-existent tool", () => {
      expect(registry.getTool("non-existent")).toBeUndefined();
    });
  });

  describe("listTools", () => {
    beforeEach(() => {
      // Register multiple tools
      registry.register(createMockTool("bash", "system"), {
        tool: createMockTool("bash", "system"),
        registeredAt: 1,
        source: "built-in",
        enabled: true,
      });
      registry.register(createMockTool("glob", "file"), {
        tool: createMockTool("glob", "file"),
        registeredAt: 2,
        source: "built-in",
        enabled: true,
      });
      registry.register(createMockTool("read_file", "file"), {
        tool: createMockTool("read_file", "file"),
        registeredAt: 3,
        source: "built-in",
        enabled: true,
      });
      registry.register(createMockTool("custom", "custom"), {
        tool: createMockTool("custom", "custom"),
        registeredAt: 4,
        source: "dynamic",
        enabled: true,
      });
      registry.register(createMockTool("disabled", "system"), {
        tool: createMockTool("disabled", "system"),
        registeredAt: 5,
        source: "built-in",
        enabled: false,
      });
    });

    test("should list all tools without filter", () => {
      const tools = registry.listTools();
      expect(tools).toHaveLength(5);
    });

    test("should filter by category", () => {
      const tools = registry.listTools({ category: "file" });
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name).sort()).toEqual(["glob", "read_file"]);
    });

    test("should filter by source", () => {
      const tools = registry.listTools({ source: "dynamic" });
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("custom");
    });

    test("should filter by enabledOnly", () => {
      const tools = registry.listTools({ enabledOnly: true });
      expect(tools).toHaveLength(4);
      expect(tools.find((t) => t.name === "disabled")).toBeUndefined();
    });

    test("should filter by exclude", () => {
      const tools = registry.listTools({ exclude: ["bash", "glob"] });
      expect(tools).toHaveLength(3);
      expect(tools.map((t) => t.name).sort()).toEqual(["custom", "disabled", "read_file"]);
    });

    test("should filter by name glob pattern", () => {
      const tools = registry.listTools({ name: "*_file" });
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("read_file");
    });

    test("should combine multiple filters", () => {
      const tools = registry.listTools({
        category: "system",
        enabledOnly: true,
      });
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("bash");
    });
  });

  describe("enable/disable", () => {
    test("should enable a tool", () => {
      const tool = createMockTool("test-tool");
      registry.register(tool, { tool, registeredAt: 1, source: "built-in", enabled: false });

      expect(registry.enable("test-tool")).toBe(true);
      expect(registry.getTool("test-tool")?.enabled).toBe(true);
    });

    test("should disable a tool", () => {
      const tool = createMockTool("test-tool");
      registry.register(tool, { tool, registeredAt: 1, source: "built-in", enabled: true });

      expect(registry.disable("test-tool")).toBe(true);
      expect(registry.getTool("test-tool")?.enabled).toBe(false);
    });

    test("should return false when enabling non-existent tool", () => {
      expect(registry.enable("non-existent")).toBe(false);
    });

    test("should return false when disabling non-existent tool", () => {
      expect(registry.disable("non-existent")).toBe(false);
    });
  });

  describe("getCount", () => {
    test("should return correct count", () => {
      expect(registry.getCount()).toBe(0);

      registry.register(createMockTool("tool1"), {
        tool: createMockTool("tool1"),
        registeredAt: 1,
        source: "built-in",
        enabled: true,
      });
      expect(registry.getCount()).toBe(1);

      registry.register(createMockTool("tool2"), {
        tool: createMockTool("tool2"),
        registeredAt: 2,
        source: "built-in",
        enabled: true,
      });
      expect(registry.getCount()).toBe(2);
    });
  });

  describe("clear", () => {
    test("should remove all tools", () => {
      registry.register(createMockTool("tool1"), {
        tool: createMockTool("tool1"),
        registeredAt: 1,
        source: "built-in",
        enabled: true,
      });
      registry.register(createMockTool("tool2"), {
        tool: createMockTool("tool2"),
        registeredAt: 2,
        source: "built-in",
        enabled: true,
      });

      registry.clear();
      expect(registry.getCount()).toBe(0);
    });
  });

  describe("snapshot/restore", () => {
    test("should snapshot and restore tools", () => {
      registry.register(createMockTool("tool1"), {
        tool: createMockTool("tool1"),
        registeredAt: 1,
        source: "built-in",
        enabled: true,
      });
      registry.register(createMockTool("tool2"), {
        tool: createMockTool("tool2"),
        registeredAt: 2,
        source: "dynamic",
        enabled: false,
      });

      const snapshot = registry.snapshot();
      registry.clear();

      expect(registry.getCount()).toBe(0);

      registry.restore(snapshot);
      expect(registry.getCount()).toBe(2);
      expect(registry.getTool("tool2")?.enabled).toBe(false);
    });
  });
});
