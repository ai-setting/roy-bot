/**
 * @fileoverview Tool Component 配置注册测试
 * 
 * TDD: 先写测试，验证配置注册机制
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { ConfigComponent } from "../../config/config-component";
import { ToolComponent } from "./tool-component";
import { TOOL_CONFIG_REGISTRATION, TOOL_DEFAULTS } from "./tool-config-registration";

// 模拟 registerComponent 调用
const mockRegisterComponent = vi.fn();

describe("Tool Config Registration", () => {
  let configComponent: ConfigComponent;
  let component: ToolComponent;

  beforeEach(() => {
    configComponent = new ConfigComponent();
    component = new ToolComponent();
  });

  describe("TOOL_CONFIG_REGISTRATION", () => {
    it("应该包含正确的 name", () => {
      expect(TOOL_CONFIG_REGISTRATION.name).toBe("tool");
    });

    it("应该包含 env source 配置", () => {
      const envSource = TOOL_CONFIG_REGISTRATION.sources.find(
        (s) => s.type === "env"
      );
      expect(envSource).toBeDefined();
      expect(envSource?.envPrefix).toBe("TOOL");
      expect(envSource?.priority).toBe(20);
    });

    it("应该包含所有配置 keys", () => {
      const keys = TOOL_CONFIG_REGISTRATION.keys;
      expect(keys).toContainEqual(
        expect.objectContaining({ key: "tool.toolsDir" })
      );
      expect(keys).toContainEqual(
        expect.objectContaining({ key: "tool.builtInTools.enabled" })
      );
      expect(keys).toContainEqual(
        expect.objectContaining({ key: "tool.sandbox.enabled" })
      );
      expect(keys).toContainEqual(
        expect.objectContaining({ key: "tool.execution.timeout" })
      );
    });
  });

  describe("TOOL_DEFAULTS", () => {
    it("应该包含 toolsDir 默认值（完整格式）", () => {
      expect(TOOL_DEFAULTS["tool.toolsDir"]).toBe(".roy/tools");
    });

    it("应该包含 builtInTools.enabled 默认值（完整格式）", () => {
      expect(TOOL_DEFAULTS["tool.builtInTools.enabled"]).toBe(true);
    });

    it("应该包含 sandbox.enabled 默认值（完整格式）", () => {
      expect(TOOL_DEFAULTS["tool.sandbox.enabled"]).toBe(false);
    });

    it("应该包含 execution.timeout 默认值（完整格式）", () => {
      expect(TOOL_DEFAULTS["tool.execution.timeout"]).toBe(30000);
    });
  });

  describe("配置注册到 ConfigComponent", () => {
    it("应该能够注册 TOOL_CONFIG_REGISTRATION", () => {
      configComponent.registerComponent(TOOL_CONFIG_REGISTRATION);
      expect(() => configComponent.registerComponent(TOOL_CONFIG_REGISTRATION)).not.toThrow();
    });
  });

  describe("Component 配置加载", () => {
    it("应该需要 ConfigComponent 初始化", async () => {
      await expect(
        component.init({
          options: {},
        } as any)
      ).rejects.toThrow("ConfigComponent is required");
    });

    it("应该能够使用 ConfigComponent 初始化", async () => {
      await component.init({
        options: {
          configComponent,
        },
      } as any);
      
      expect(component.name).toBe("tool");
      expect(component.version).toBe("1.0.0");
    });

    it("应该能够通过 config 对象传入配置", async () => {
      await component.init({
        options: {
          configComponent,
          config: {
            toolsDir: "/custom/tools",
            sandbox: {
              enabled: true,
              type: "docker",
            },
          },
        },
      } as any);
      
      expect(component.name).toBe("tool");
    });
  });

  describe("环境变量覆盖", () => {
    it("应该能够通过环境变量覆盖配置", async () => {
      // 设置环境变量（Bug #2186 Bug 1 修复后：单层 TOOL 前缀 → TOOL_TOOLS_DIR）
      const originalValue = process.env.TOOL_TOOLS_DIR;
      process.env.TOOL_TOOLS_DIR = "/env/tools";

      try {
        await component.init({
          options: {
            configComponent,
          },
        } as any);

        expect(component.name).toBe("tool");
      } finally {
        // 恢复环境变量
        if (originalValue !== undefined) {
          process.env.TOOL_TOOLS_DIR = originalValue;
        } else {
          delete process.env.TOOL_TOOLS_DIR;
        }
      }
    });
  });

  describe("核心验收标准 - registerConfig 实现", () => {
    afterEach(() => {
      // 清理环境变量
      delete process.env.TOOL_TOOLS_DIR;
      delete process.env.TOOL_BUILT_IN_TOOLS_ENABLED;
    });

    it("应该使用 registerComponent 注册配置", async () => {
      const spy = vi.spyOn(configComponent, 'registerComponent');
      
      await component.init({
        options: {
          configComponent,
        },
      } as any);
      
      // 验证 registerComponent 被调用
      expect(spy).toHaveBeenCalledWith(TOOL_CONFIG_REGISTRATION);
      spy.mockRestore();
    });

    it("应该使用 load('tool') 加载配置", async () => {
      const loadSpy = vi.spyOn(configComponent, 'load');
      
      await component.init({
        options: {
          configComponent,
        },
      } as any);
      
      // 验证 load 被调用，且参数为 "tool"
      expect(loadSpy).toHaveBeenCalledWith("tool");
      loadSpy.mockRestore();
    });

    it("应该正确设置 TOOL_DEFAULTS 默认值", async () => {
      await component.init({
        options: {
          configComponent,
        },
      } as any);
      
      // 验证默认值被正确设置到 configComponent（通过 registerComponent 的 defaults 机制）
      expect(configComponent.get("tool.toolsDir")).toBe(".roy/tools");
      expect(configComponent.get("tool.builtInTools.enabled")).toBe(true);
      expect(configComponent.get("tool.execution.timeout")).toBe(30000);
    });

    it("环境变量应该能覆盖默认配置", async () => {
      // 设置环境变量覆盖
      process.env.TOOL_TOOLS_DIR = "/override/tools";
      
      await component.init({
        options: {
          configComponent,
        },
      } as any);
      
      // 验证环境变量覆盖了默认值
      expect(configComponent.get("tool.toolsDir")).toBe("/override/tools");
    });

    it("config 对象应该能覆盖环境变量和默认值", async () => {
      // 设置环境变量
      process.env.TOOL_TOOLS_DIR = "/env/tools";
      
      await component.init({
        options: {
          configComponent,
          config: {
            toolsDir: "/config/tools",
            sandbox: {
              enabled: true,
              type: "docker",
            },
          },
        },
      } as any);
      
      // 验证 config 对象覆盖了环境变量
      expect(configComponent.get("tool.toolsDir")).toBe("/config/tools");
    });

    it("registerConfig 应该处理 config 对象", async () => {
      const customConfig = {
        toolsDir: "/custom/tools",
        sandbox: {
          enabled: true,
          type: "docker",
        },
        execution: {
          timeout: 60000,
        },
      };
      
      await component.init({
        options: {
          configComponent,
          config: customConfig,
        },
      } as any);
      
      // 验证 config 对象被正确处理
      expect(configComponent.get("tool.toolsDir")).toBe("/custom/tools");
    });
  });
});
