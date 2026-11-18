/**
 * @fileoverview Memory Component 配置注册测试
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ConfigComponent } from "../../config/config-component";
import { MEMORY_CONFIG_REGISTRATION, MEMORY_DEFAULTS } from "./memory-config-registration";

describe("Memory Config Registration", () => {
  let configComponent: ConfigComponent;

  beforeEach(() => {
    configComponent = new ConfigComponent();
  });

  describe("MEMORY_CONFIG_REGISTRATION", () => {
    it("应该包含正确的 name", () => {
      expect(MEMORY_CONFIG_REGISTRATION.name).toBe("memory");
    });

    it("应该包含 env source 配置", () => {
      const envSource = MEMORY_CONFIG_REGISTRATION.sources.find(
        (s) => s.type === "env"
      );
      expect(envSource).toBeDefined();
      expect(envSource?.envPrefix).toBe("MEMORY");
      expect(envSource?.priority).toBe(20);
    });

    it("应该包含所有配置 keys", () => {
      const keys = MEMORY_CONFIG_REGISTRATION.keys;
      expect(keys).toContainEqual(
        expect.objectContaining({ key: "memory.recursive" })
      );
      expect(keys).toContainEqual(
        expect.objectContaining({ key: "memory.cacheEnabled" })
      );
      expect(keys).toContainEqual(
        expect.objectContaining({ key: "memory.cacheTTL" })
      );
      expect(keys).toContainEqual(
        expect.objectContaining({ key: "memory.memoryPaths" })
      );
    });
  });

  describe("MEMORY_DEFAULTS", () => {
    it("应该包含 recursive 默认值（完整格式）", () => {
      expect(MEMORY_DEFAULTS["memory.recursive"]).toBe(true);
    });

    it("应该包含 cacheEnabled 默认值（完整格式）", () => {
      expect(MEMORY_DEFAULTS["memory.cacheEnabled"]).toBe(true);
    });

    it("应该包含 cacheTTL 默认值（完整格式）", () => {
      expect(MEMORY_DEFAULTS["memory.cacheTTL"]).toBe(300000);
    });
  });

  describe("配置注册到 ConfigComponent", () => {
    it("应该能够注册 MEMORY_CONFIG_REGISTRATION", () => {
      configComponent.registerComponent(MEMORY_CONFIG_REGISTRATION);
      expect(() => configComponent.registerComponent(MEMORY_CONFIG_REGISTRATION)).not.toThrow();
    });
  });
});
