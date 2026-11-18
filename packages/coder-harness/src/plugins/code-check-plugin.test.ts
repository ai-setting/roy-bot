/**
 * @fileoverview CodeCheckPlugin 单元测试
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { CodeCheckPlugin } from "./code-check-plugin";
import type { PluginEnv, HookContext } from "@ai-setting/roy-bot-core";

// Mock PluginEnv
const createMockEnv = (): PluginEnv => ({
  getComponent: () => undefined,
  registerAgent: () => {},
  registerTool: () => {},
  registerHook: () => {},
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any,
});

describe("CodeCheckPlugin", () => {
  let plugin: CodeCheckPlugin;
  let registeredHooks: { point: string; priority: number; handler: Function }[] = [];

  beforeEach(() => {
    registeredHooks = [];
    plugin = new CodeCheckPlugin();
    plugin.init(createMockEnv() as any);
  });

  describe("init", () => {
    it("注册 tool:after.execute hook", () => {
      const mockEnv = createMockEnv();
      mockEnv.registerHook = (hook: any) => {
        registeredHooks.push(hook);
      };

      const newPlugin = new CodeCheckPlugin();
      newPlugin.init(mockEnv as any);

      expect(registeredHooks.length).toBe(1);
      expect(registeredHooks[0].point).toBe("tool:after.execute");
      expect(registeredHooks[0].priority).toBe(80);
    });
  });

  describe("getTargetFilePath", () => {
    it("从 args.path 提取路径", () => {
      const path = (plugin as any).getTargetFilePath("write_file", { path: "/tmp/test.ts" });
      expect(path).toBe("/tmp/test.ts");
    });

    it("从 args.filePath 提取路径", () => {
      const path = (plugin as any).getTargetFilePath("edit_file", { filePath: "/tmp/test.ts" });
      expect(path).toBe("/tmp/test.ts");
    });

    it("没有路径时返回 null", () => {
      const path = (plugin as any).getTargetFilePath("write_file", {});
      expect(path).toBeNull();
    });
  });

  describe("isSupported", () => {
    it("支持 TypeScript 文件", () => {
      expect((plugin as any).isSupported("test.ts")).toBe(true);
      expect((plugin as any).isSupported("test.tsx")).toBe(true);
      expect((plugin as any).isSupported("test.mts")).toBe(true);
      expect((plugin as any).isSupported("test.cts")).toBe(true);
    });

    it("支持 JavaScript 文件", () => {
      expect((plugin as any).isSupported("test.js")).toBe(true);
      expect((plugin as any).isSupported("test.jsx")).toBe(true);
      expect((plugin as any).isSupported("test.mjs")).toBe(true);
      expect((plugin as any).isSupported("test.cjs")).toBe(true);
    });

    it("支持 Python 文件", () => {
      expect((plugin as any).isSupported("test.py")).toBe(true);
    });

    it("支持其他常见文件类型", () => {
      expect((plugin as any).isSupported("test.rs")).toBe(true);
      expect((plugin as any).isSupported("test.go")).toBe(true);
      expect((plugin as any).isSupported("test.json")).toBe(true);
      expect((plugin as any).isSupported("test.yaml")).toBe(true);
      expect((plugin as any).isSupported("test.yml")).toBe(true);
    });

    it("不支持不支持的文件类型", () => {
      expect((plugin as any).isSupported("test.txt")).toBe(false);
      expect((plugin as any).isSupported("test.md")).toBe(false);
      expect((plugin as any).isSupported("test.html")).toBe(false);
    });
  });

  describe("onAfterTool", () => {
    it("跳过非 write/edit 工具（对象格式）", async () => {
      const ctx = {
        component: { name: "tool", version: "1.0.0" },
        data: {
          tool: { name: "read_file" },
          args: { path: "/tmp/test.ts" },
          result: { success: true, output: "" },
        },
        metadata: {},
        phase: "after" as const,
        hookPoint: "tool:after.execute",
      } as HookContext;

      const result = await (plugin as any).onAfterTool(ctx);
      expect(result.stopped).toBe(false);
    });

    it("跳过非 write/edit 工具（字符串格式）", async () => {
      const ctx = {
        component: { name: "tool", version: "1.0.0" },
        data: {
          tool: "read_file",
          args: { path: "/tmp/test.ts" },
          result: { success: true, output: "" },
        },
        metadata: {},
        phase: "after" as const,
        hookPoint: "tool:after.execute",
      } as HookContext;

      const result = await (plugin as any).onAfterTool(ctx);
      expect(result.stopped).toBe(false);
    });

    it("禁用时跳过", async () => {
      const disabledPlugin = new CodeCheckPlugin({ enabled: false });
      disabledPlugin.init(createMockEnv() as any);

      const ctx = {
        component: { name: "tool", version: "1.0.0" },
        data: {
          tool: { name: "write_file" },
          args: { path: "/tmp/test.ts" },
          result: { success: true, output: "" },
        },
        metadata: {},
        phase: "after" as const,
        hookPoint: "tool:after.execute",
      } as HookContext;

      const result = await (disabledPlugin as any).onAfterTool(ctx);
      expect(result.stopped).toBe(false);
    });

    it("跳过不支持的文件类型", async () => {
      const ctx = {
        component: { name: "tool", version: "1.0.0" },
        data: {
          tool: { name: "write_file" },
          args: { path: "/tmp/test.txt" },
          result: { success: true, output: "" },
        },
        metadata: {},
        phase: "after" as const,
        hookPoint: "tool:after.execute",
      } as HookContext;

      const result = await (plugin as any).onAfterTool(ctx);
      expect(result.stopped).toBe(false);
    });

    it("无路径时跳过", async () => {
      const ctx = {
        component: { name: "tool", version: "1.0.0" },
        data: {
          tool: { name: "write_file" },
          args: {},
          result: { success: true, output: "" },
        },
        metadata: {},
        phase: "after" as const,
        hookPoint: "tool:after.execute",
      } as HookContext;

      const result = await (plugin as any).onAfterTool(ctx);
      expect(result.stopped).toBe(false);
    });

    it("checkOnSave=false 时跳过 write_file", async () => {
      const pluginWithConfig = new CodeCheckPlugin({ checkOnSave: false });
      pluginWithConfig.init(createMockEnv() as any);

      const ctx = {
        component: { name: "tool", version: "1.0.0" },
        data: {
          tool: { name: "write_file" },
          args: { path: "/tmp/test.ts" },
          result: { success: true, output: "" },
        },
        metadata: {},
        phase: "after" as const,
        hookPoint: "tool:after.execute",
      } as HookContext;

      const result = await (pluginWithConfig as any).onAfterTool(ctx);
      expect(result.stopped).toBe(false);
    });

    it("checkOnEdit=false 时跳过 edit_file", async () => {
      const pluginWithConfig = new CodeCheckPlugin({ checkOnEdit: false });
      pluginWithConfig.init(createMockEnv() as any);

      const ctx = {
        component: { name: "tool", version: "1.0.0" },
        data: {
          tool: { name: "edit_file" },
          args: { path: "/tmp/test.ts" },
          result: { success: true, output: "" },
        },
        metadata: {},
        phase: "after" as const,
        hookPoint: "tool:after.execute",
      } as HookContext;

      const result = await (pluginWithConfig as any).onAfterTool(ctx);
      expect(result.stopped).toBe(false);
    });
  });

  describe("元信息", () => {
    it("有正确的 name 和 version", () => {
      expect(plugin.name).toBe("CodeCheckPlugin");
      expect(plugin.version).toBe("1.0.0");
    });

    it("有描述", () => {
      expect(plugin.description).toBeDefined();
      expect(plugin.description).toContain("code checking");
    });

    it("有正确的 priority", () => {
      expect(plugin.priority).toBe(80);
    });
  });

  describe("配置", () => {
    it("支持自定义支持的扩展名", () => {
      const pluginWithCustom = new CodeCheckPlugin({
        supportedExtensions: [".go", ".rs"],
      });
      pluginWithCustom.init(createMockEnv() as any);

      expect((pluginWithCustom as any).isSupported("test.go")).toBe(true);
      expect((pluginWithCustom as any).isSupported("test.rs")).toBe(true);
      expect((pluginWithCustom as any).isSupported("test.ts")).toBe(false);
    });

    it("支持自定义忽略模式", () => {
      const pluginWithIgnore = new CodeCheckPlugin({
        ignorePatterns: ["**/node_modules/**", "**/*.d.ts"],
      });
      pluginWithIgnore.init(createMockEnv() as any);

      expect((pluginWithIgnore as any).shouldIgnore("/node_modules/test.ts")).toBe(true);
      expect((pluginWithIgnore as any).shouldIgnore("/src/types.d.ts")).toBe(true);
      expect((pluginWithIgnore as any).shouldIgnore("/src/test.ts")).toBe(false);
    });
  });
});
