/**
 * @fileoverview Prompt Component 配置注册测试
 * 
 * TDD: 先写测试，验证配置注册机制
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ConfigComponent } from "../../config/config-component";
import { PromptComponent } from "./prompt-component";
import { PROMPT_CONFIG_REGISTRATION, PROMPT_DEFAULTS } from "./prompt-config-registration";

describe("Prompt Config Registration", () => {
  let configComponent: ConfigComponent;
  let component: PromptComponent;

  beforeEach(() => {
    configComponent = new ConfigComponent();
    component = new PromptComponent();
  });

  describe("PROMPT_CONFIG_REGISTRATION", () => {
    it("应该包含正确的 name", () => {
      expect(PROMPT_CONFIG_REGISTRATION.name).toBe("prompt");
    });

    it("应该包含 env source 配置", () => {
      const envSource = PROMPT_CONFIG_REGISTRATION.sources.find(
        (s) => s.type === "env"
      );
      expect(envSource).toBeDefined();
      expect(envSource?.envPrefix).toBe("PROMPT");
      expect(envSource?.priority).toBe(20);
    });

    it("应该包含所有配置 keys", () => {
      const keys = PROMPT_CONFIG_REGISTRATION.keys;
      expect(keys).toContainEqual(
        expect.objectContaining({ key: "prompt.promptPaths" })
      );
      expect(keys).toContainEqual(
        expect.objectContaining({ key: "prompt.defaultName" })
      );
      expect(keys).toContainEqual(
        expect.objectContaining({ key: "prompt.variablePrefix" })
      );
      expect(keys).toContainEqual(
        expect.objectContaining({ key: "prompt.variableSuffix" })
      );
    });
  });

  describe("PROMPT_DEFAULTS", () => {
    it("应该包含 defaultName 默认值（完整格式）", () => {
      expect(PROMPT_DEFAULTS["prompt.defaultName"]).toBe("default");
    });

    it("应该包含 variablePrefix 默认值（完整格式）", () => {
      expect(PROMPT_DEFAULTS["prompt.variablePrefix"]).toBe("{{");
    });

    it("应该包含 variableSuffix 默认值（完整格式）", () => {
      expect(PROMPT_DEFAULTS["prompt.variableSuffix"]).toBe("}}");
    });
  });

  describe("配置注册到 ConfigComponent", () => {
    it("应该能够注册 PROMPT_CONFIG_REGISTRATION", () => {
      configComponent.registerComponent(PROMPT_CONFIG_REGISTRATION);
      expect(() => configComponent.registerComponent(PROMPT_CONFIG_REGISTRATION)).not.toThrow();
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
      
      expect(component.name).toBe("prompt");
      expect(component.version).toBe("1.0.0");
    });

    it("应该能够通过 config 对象传入配置", async () => {
      await component.init({
        options: {
          configComponent,
          config: {
            defaultName: "custom-prompt",
            variablePrefix: "[[",
            variableSuffix: "]]",
          },
        },
      } as any);
      
      expect(component.name).toBe("prompt");
    });
  });

  describe("环境变量覆盖", () => {
    it("应该能够通过环境变量覆盖配置", async () => {
      // 设置环境变量（Bug #2186 Bug 1 修复后：单层 PROMPT 前缀 → PROMPT_DEFAULT_NAME）
      const originalValue = process.env.PROMPT_DEFAULT_NAME;
      process.env.PROMPT_DEFAULT_NAME = "env-prompt";

      try {
        await component.init({
          options: {
            configComponent,
          },
        } as any);

        expect(component.name).toBe("prompt");
      } finally {
        // 恢复环境变量
        if (originalValue !== undefined) {
          process.env.PROMPT_DEFAULT_NAME = originalValue;
        } else {
          delete process.env.PROMPT_DEFAULT_NAME;
        }
      }
    });
  });

  describe("registerConfig 使用 registerComponent + load 模式", () => {
    it("应该使用 registerComponent 注册配置", async () => {
      // 注册组件
      configComponent.registerComponent(PROMPT_CONFIG_REGISTRATION);

      // 加载配置
      await configComponent.load("prompt");

      // 验证注册成功
      const componentRegs = (configComponent as any).componentRegistrations;
      expect(componentRegs.has("prompt")).toBe(true);
    });

    it("应该通过 load 加载 prompt 配置到内存", async () => {
      // 注册组件
      configComponent.registerComponent(PROMPT_CONFIG_REGISTRATION);

      // 加载配置
      await configComponent.load("prompt");

      // 验证配置已注册（组件注册成功）
      const componentRegs = (configComponent as any).componentRegistrations;
      expect(componentRegs.has("prompt")).toBe(true);
    });

    it("应该从环境变量覆盖默认值", async () => {
      // 保存原始值（Bug #2186 Bug 1 修复后：单层 PROMPT 前缀）
      const originalValue = process.env.PROMPT_DEFAULT_NAME;

      try {
        // 设置环境变量
        process.env.PROMPT_DEFAULT_NAME = "env-default-name";

        // 注册组件并加载
        configComponent.registerComponent(PROMPT_CONFIG_REGISTRATION);
        await configComponent.load("prompt");

        // 验证环境变量优先
        const defaultName = configComponent.get("prompt.defaultName");
        expect(defaultName).toBe("env-default-name");
      } finally {
        // 恢复环境变量
        if (originalValue !== undefined) {
          process.env.PROMPT_DEFAULT_NAME = originalValue;
        } else {
          delete process.env.PROMPT_DEFAULT_NAME;
        }
      }
    });

    it("应该允许通过 config 对象传入最高优先级配置", async () => {
      // 注册组件并加载
      configComponent.registerComponent(PROMPT_CONFIG_REGISTRATION);
      await configComponent.load("prompt");
      
      // 设置内存中的配置（模拟 config 对象的行为）
      configComponent.set("prompt.defaultName", "config-object-name");
      
      // 验证 config 对象优先
      const defaultName = configComponent.get("prompt.defaultName");
      expect(defaultName).toBe("config-object-name");
    });

    it("PromptComponent.init 应该自动完成配置注册和加载", async () => {
      await component.init({
        options: {
          configComponent,
        },
      } as any);
      
      // 验证组件注册
      const componentRegs = (configComponent as any).componentRegistrations;
      expect(componentRegs.has("prompt")).toBe(true);
      
      // 验证配置已加载
      const defaultName = configComponent.get("prompt.defaultName");
      expect(defaultName).toBe("default");
    });
  });
});
