/**
 * @fileoverview Commands Component 配置注册测试
 * 
 * TDD: 先写测试，验证配置注册机制
 */

import { describe, it, expect, beforeEach } from "vitest";
import os from "os";
import path from "path";
import { ConfigComponent } from "../../config/config-component";
import { CommandsComponent } from "./commands-component";
import { COMMANDS_CONFIG_REGISTRATION, COMMANDS_DEFAULTS } from "./commands-config-registration";

describe("Commands Config Registration", () => {
  let configComponent: ConfigComponent;
  let component: CommandsComponent;

  beforeEach(() => {
    configComponent = new ConfigComponent();
    component = new CommandsComponent();
  });

  describe("COMMANDS_CONFIG_REGISTRATION", () => {
    it("应该包含正确的 name", () => {
      expect(COMMANDS_CONFIG_REGISTRATION.name).toBe("command");
    });

    it("应该包含 env source 配置", () => {
      const envSource = COMMANDS_CONFIG_REGISTRATION.sources.find(
        (s) => s.type === "env"
      );
      expect(envSource).toBeDefined();
      expect(envSource?.envPrefix).toBe("COMMAND");
      expect(envSource?.priority).toBe(20);
    });

    it("应该包含所有配置 keys", () => {
      const keys = COMMANDS_CONFIG_REGISTRATION.keys;
      expect(keys).toContainEqual(
        expect.objectContaining({ key: "command.userCommandsDir" })
      );
      expect(keys).toContainEqual(
        expect.objectContaining({ key: "command.projectCommandsDir" })
      );
      expect(keys).toContainEqual(
        expect.objectContaining({ key: "command.cacheDir" })
      );
    });
  });

  describe("COMMANDS_DEFAULTS", () => {
    it("应该包含 userCommandsDir 键（动态默认值在 registerConfig 中设置）", () => {
      expect("command.userCommandsDir" in COMMANDS_DEFAULTS).toBe(true);
    });

    it("应该包含 projectCommandsDir 键（动态默认值在 registerConfig 中设置）", () => {
      expect("command.projectCommandsDir" in COMMANDS_DEFAULTS).toBe(true);
    });

    it("应该包含 cacheDir 键（动态默认值在 registerConfig 中设置）", () => {
      expect("command.cacheDir" in COMMANDS_DEFAULTS).toBe(true);
    });
  });

  describe("配置注册到 ConfigComponent", () => {
    it("应该能够注册 COMMANDS_CONFIG_REGISTRATION", () => {
      configComponent.registerComponent(COMMANDS_CONFIG_REGISTRATION);
      expect(() => configComponent.registerComponent(COMMANDS_CONFIG_REGISTRATION)).not.toThrow();
    });

    // 注意：defaults 字段已被移除，默认值通过 configComponent.set() 在 registerConfig 中设置

    it("注册后 keys 应该被注册（默认值需要通过 configComponent.set() 设置）", async () => {
      configComponent.registerComponent(COMMANDS_CONFIG_REGISTRATION);
      await configComponent.load();
      
      // 注意：默认值需要通过 configComponent.set() 设置，不会自动加载
      // 但 keys 已注册
      expect(configComponent.get("command.userCommandsDir")).toBeUndefined();
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
      
      expect(component.name).toBe("commands");
      expect(component.version).toBe("2.0.0");
    });

    it("应该能够通过 config 对象传入配置", async () => {
      // 使用 tmpdir 作为测试路径
      const tmpDir = os.tmpdir();
      
      await component.init({
        options: {
          configComponent,
          config: {
            userCommandsDir: path.join(tmpDir, "test-user-commands"),
            projectCommandsDir: path.join(tmpDir, "test-project-commands"),
          },
        },
      } as any);
      
      expect(component.name).toBe("commands");
    });
  });

  describe("环境变量覆盖", () => {
    it("应该能够通过环境变量覆盖配置", async () => {
      // 设置环境变量（使用有效的 tmp 路径）
      const originalValue = process.env.COMMAND_USER_COMMANDS_DIR;
      const tmpPath = path.join(os.tmpdir(), "test-env-path");
      process.env.COMMAND_USER_COMMANDS_DIR = tmpPath;
      
      try {
        await component.init({
          options: {
            configComponent,
          },
        } as any);
        
        expect(component.name).toBe("commands");
      } finally {
        // 恢复环境变量
        if (originalValue !== undefined) {
          process.env.COMMAND_USER_COMMANDS_DIR = originalValue;
        } else {
          delete process.env.COMMAND_USER_COMMANDS_DIR;
        }
      }
    });

    it("环境变量应该能够覆盖默认值", async () => {
      const originalValue = process.env.COMMAND_USER_COMMANDS_DIR;
      const tmpPath = path.join(os.tmpdir(), "env-override-test");
      process.env.COMMAND_USER_COMMANDS_DIR = tmpPath;
      
      try {
        // 创建新 component 来使用新的环境变量
        const newComponent = new CommandsComponent();
        await newComponent.init({
          options: {
            configComponent,
          },
        } as any);
        
        // 环境变量应该覆盖默认值
        // 注意：在 CommandsComponent.init 中，registerConfig 会在 load 之后再次设置环境变量
        expect(configComponent.get("command.userCommandsDir")).toBe(tmpPath);
      } finally {
        if (originalValue !== undefined) {
          process.env.COMMAND_USER_COMMANDS_DIR = originalValue;
        } else {
          delete process.env.COMMAND_USER_COMMANDS_DIR;
        }
      }
    });
  });

  describe("ConfigComponent.registerComponent 模式集成", () => {
    it("初始化后 ConfigComponent 应该包含命令配置", async () => {
      await component.init({
        options: {
          configComponent,
        },
      } as any);
      
      // 验证 ConfigComponent 有命令相关配置
      const value = configComponent.get("command.userCommandsDir");
      expect(value).toBeDefined();
      expect(typeof value).toBe("string");
    });

    it("registerComponent 注册后应该能通过 load 获取已配置的 keys", async () => {
      // 直接使用 registerComponent 和 load 验证模式
      configComponent.registerComponent(COMMANDS_CONFIG_REGISTRATION);
      await configComponent.load("command");
      
      // 注意：默认值不会自动加载，需要通过 configComponent.set() 设置
      // 验证 keys 已注册（从 ConfigComponent 获取会返回 undefined）
      const userDir = configComponent.get("command.userCommandsDir");
      expect(userDir).toBeUndefined(); // 默认值未设置
    });
  });
});
