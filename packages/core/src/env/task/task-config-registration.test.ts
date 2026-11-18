/**
 * @fileoverview Task Component 配置注册测试
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ConfigComponent } from "../../config/config-component";
import { TASK_CONFIG_REGISTRATION, TASK_DEFAULTS } from "./task-config-registration";

describe("Task Config Registration", () => {
  let configComponent: ConfigComponent;

  beforeEach(() => {
    configComponent = new ConfigComponent();
  });

  describe("TASK_CONFIG_REGISTRATION", () => {
    it("应该包含正确的 name", () => {
      expect(TASK_CONFIG_REGISTRATION.name).toBe("task");
    });

    it("应该包含 env source 配置", () => {
      const envSource = TASK_CONFIG_REGISTRATION.sources.find(
        (s) => s.type === "env"
      );
      expect(envSource).toBeDefined();
      expect(envSource?.envPrefix).toBe("TASK");
      expect(envSource?.priority).toBe(20);
    });

    it("应该包含所有配置 keys", () => {
      const keys = TASK_CONFIG_REGISTRATION.keys;
      expect(keys).toContainEqual(
        expect.objectContaining({ key: "task.storage.type" })
      );
      expect(keys).toContainEqual(
        expect.objectContaining({ key: "task.storage.dbPath" })
      );
    });
  });

  describe("TASK_DEFAULTS", () => {
    it("应该包含 storage.type 默认值（完整格式）", () => {
      expect(TASK_DEFAULTS["task.storage.type"]).toBe("sqlite");
    });

    it("应该导出正确的默认值（完整格式）", () => {
      expect("task.storage.type" in TASK_DEFAULTS).toBe(true);
    });
  });

  describe("配置注册到 ConfigComponent", () => {
    it("应该能够注册 TASK_CONFIG_REGISTRATION", () => {
      configComponent.registerComponent(TASK_CONFIG_REGISTRATION);
      expect(() => configComponent.registerComponent(TASK_CONFIG_REGISTRATION)).not.toThrow();
    });
  });
});
