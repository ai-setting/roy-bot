/**
 * @fileoverview Plugin Module Tests
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PluginRegistry,
  parseArgs,
  ToolHookPoints,
  BUILTIN_PLUGINS,
  executePlugin,
  type ToolPlugin,
  type ToolHookContext,
  type PluginConfig,
} from "./plugin.js";

describe("Plugin Module", () => {
  // ========================================================================
  // ToolHookPoints
  // ========================================================================
  describe("ToolHookPoints", () => {
    it("should have AFTER_EXECUTE hook point", () => {
      expect(ToolHookPoints.AFTER_EXECUTE).toBe("tool.after-execute");
    });

    it("should have BEFORE_EXECUTE hook point", () => {
      expect(ToolHookPoints.BEFORE_EXECUTE).toBe("tool.before-execute");
    });
  });

  // ========================================================================
  // BUILTIN_PLUGINS
  // ========================================================================
  describe("BUILTIN_PLUGINS", () => {
    it("should contain lsp plugin", () => {
      expect(BUILTIN_PLUGINS).toHaveProperty("lsp");
      expect(BUILTIN_PLUGINS.lsp).toContain("LSP");
    });

    it("should contain code-check plugin", () => {
      expect(BUILTIN_PLUGINS).toHaveProperty("code-check");
      expect(BUILTIN_PLUGINS["code-check"]).toContain("code checking");
    });

    it("should contain reminder plugin", () => {
      expect(BUILTIN_PLUGINS).toHaveProperty("reminder");
      expect(BUILTIN_PLUGINS.reminder).toContain("reminder");
    });
  });

  // ========================================================================
  // parseArgs
  // ========================================================================
  describe("parseArgs", () => {
    it("should parse single plugin name", () => {
      const result = parseArgs(["lsp"]);
      expect(result.plugins).toContain("lsp");
    });

    it("should parse multiple plugin names", () => {
      const result = parseArgs(["lsp", "code-check", "reminder"]);
      expect(result.plugins).toEqual(["lsp", "code-check", "reminder"]);
    });

    it("should parse plugin with config", () => {
      const result = parseArgs(["lsp:typescript"]);
      expect(result.plugins).toEqual([
        { name: "lsp", config: "typescript" },
      ]);
    });

    it("should parse plugin with path", () => {
      const result = parseArgs(["/path/to/my-plugin.js"]);
      expect(result.plugins).toContain("/path/to/my-plugin.js");
    });

    it("should return empty plugins for empty input", () => {
      const result = parseArgs([]);
      expect(result.plugins).toEqual([]);
    });

    it("should handle mixed plugins and paths", () => {
      const result = parseArgs([
        "lsp",
        "/custom/plugin.js",
        "code-check",
      ]);
      expect(result.plugins).toHaveLength(3);
      expect(result.plugins).toContain("lsp");
      expect(result.plugins).toContain("/custom/plugin.js");
      expect(result.plugins[2]).toBe("code-check");
    });

    it("should detect file type from path", () => {
      const result = parseArgs(["/path/to/test.ts"]);
      expect(result.fileTypes).toContain(".ts");
    });

    it("should extract file types from plugin configs", () => {
      const result = parseArgs(["lsp:typescript", "lsp:python"]);
      expect(result.fileTypes).toContain(".ts");
      expect(result.fileTypes).toContain(".tsx");
      expect(result.fileTypes).toContain(".py");
    });

    it("should return file types as unique set", () => {
      const result = parseArgs(["lsp:typescript", "lsp:typescript"]);
      expect(result.fileTypes).toEqual([".ts", ".tsx"]);
    });

    it("should handle empty config after colon", () => {
      const result = parseArgs(["lsp:"]);
      expect(result.plugins[0]).toEqual({ name: "lsp", config: "" });
    });

    it("should handle nested config paths", () => {
      const result = parseArgs(["linter:/path/to/config.json"]);
      expect(result.plugins[0]).toEqual({
        name: "linter",
        config: "/path/to/config.json",
      });
    });
  });
});

describe("PluginRegistry", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = new PluginRegistry();
  });

  describe("register", () => {
    it("should register a plugin", () => {
      const plugin: ToolPlugin = {
        name: "test-plugin",
        getHookPoint: () => "tool.after-execute",
      };
      registry.register(plugin);
      expect(registry.has("test-plugin")).toBe(true);
    });

    it("should not register duplicate plugins", () => {
      const plugin: ToolPlugin = {
        name: "test-plugin",
        getHookPoint: () => "tool.after-execute",
      };
      registry.register(plugin);
      expect(() => registry.register(plugin)).toThrow(
        "already registered"
      );
    });
  });

  describe("unregister", () => {
    it("should unregister a plugin", () => {
      const plugin: ToolPlugin = {
        name: "test-plugin",
        getHookPoint: () => "tool.after-execute",
      };
      registry.register(plugin);
      expect(registry.unregister("test-plugin")).toBe(true);
      expect(registry.has("test-plugin")).toBe(false);
    });

    it("should return false for non-existent plugin", () => {
      expect(registry.unregister("non-existent")).toBe(false);
    });
  });

  describe("get", () => {
    it("should get a registered plugin", () => {
      const plugin: ToolPlugin = {
        name: "test-plugin",
        getHookPoint: () => "tool.after-execute",
      };
      registry.register(plugin);
      expect(registry.get("test-plugin")).toBe(plugin);
    });

    it("should return undefined for non-existent plugin", () => {
      expect(registry.get("non-existent")).toBeUndefined();
    });
  });

  describe("getAll", () => {
    it("should return all registered plugins", () => {
      const plugin1: ToolPlugin = {
        name: "plugin-1",
        getHookPoint: () => "tool.after-execute",
      };
      const plugin2: ToolPlugin = {
        name: "plugin-2",
        getHookPoint: () => "tool.before-execute",
      };
      registry.register(plugin1);
      registry.register(plugin2);
      expect(registry.getAll()).toHaveLength(2);
    });
  });

  describe("getByHookPoint", () => {
    it("should return plugins for specific hook point", () => {
      const plugin1: ToolPlugin = {
        name: "after-hook-plugin",
        getHookPoint: () => "tool.after-execute",
      };
      const plugin2: ToolPlugin = {
        name: "before-hook-plugin",
        getHookPoint: () => "tool.before-execute",
      };
      registry.register(plugin1);
      registry.register(plugin2);

      const afterPlugins = registry.getByHookPoint("tool.after-execute");
      expect(afterPlugins).toHaveLength(1);
      expect(afterPlugins[0].name).toBe("after-hook-plugin");
    });
  });

  describe("clear", () => {
    it("should clear all plugins", () => {
      const plugin1: ToolPlugin = {
        name: "plugin-1",
        getHookPoint: () => "tool.after-execute",
      };
      const plugin2: ToolPlugin = {
        name: "plugin-2",
        getHookPoint: () => "tool.after-execute",
      };
      registry.register(plugin1);
      registry.register(plugin2);
      registry.clear();
      expect(registry.getAll()).toHaveLength(0);
    });
  });
});

describe("executePlugin", () => {
  it("should execute plugin onAfterExecute hook", async () => {
    const onAfterExecute = vi.fn();
    const plugin: ToolPlugin = {
      name: "test-plugin",
      getHookPoint: () => "tool.after-execute",
      onAfterExecute,
    };

    const context: ToolHookContext = {
      tool: { name: "write_file" },
      args: { path: "/test.ts" },
      result: { success: true },
    };

    await executePlugin(plugin, context);
    expect(onAfterExecute).toHaveBeenCalledWith(context);
  });

  it("should skip execution when shouldHandle returns false", async () => {
    const onAfterExecute = vi.fn();
    const plugin: ToolPlugin = {
      name: "ts-only",
      getHookPoint: () => "tool.after-execute",
      shouldHandle: (ctx) => {
        const path = ctx.args?.path as string | undefined;
        return path?.endsWith(".ts") || false;
      },
      onAfterExecute,
    };

    const context: ToolHookContext = {
      args: { path: "/test.py" },
    };

    await executePlugin(plugin, context);
    expect(onAfterExecute).not.toHaveBeenCalled();
  });

  it("should execute onBeforeExecute when hook point matches", async () => {
    const onBeforeExecute = vi.fn();
    const plugin: ToolPlugin = {
      name: "before-hook-plugin",
      getHookPoint: () => "tool.before-execute",
      onBeforeExecute,
    };

    const context: ToolHookContext = {
      tool: { name: "read_file" },
    };

    await executePlugin(plugin, context);
    expect(onBeforeExecute).toHaveBeenCalledWith(context);
  });
});
