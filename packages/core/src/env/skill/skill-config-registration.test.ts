/**
 * @fileoverview Skill Component 配置注册测试
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ConfigComponent } from "../../config/config-component";
import { SKILL_CONFIG_REGISTRATION, SKILL_DEFAULTS } from "./skill-config-registration";

describe("Skill Config Registration", () => {
  let configComponent: ConfigComponent;

  beforeEach(() => {
    configComponent = new ConfigComponent();
  });

  describe("SKILL_CONFIG_REGISTRATION", () => {
    it("应该包含正确的 name", () => {
      expect(SKILL_CONFIG_REGISTRATION.name).toBe("skill");
    });

    it("应该包含 env source 配置", () => {
      const envSource = SKILL_CONFIG_REGISTRATION.sources.find(
        (s) => s.type === "env"
      );
      expect(envSource).toBeDefined();
      expect(envSource?.envPrefix).toBe("SKILL");
      expect(envSource?.priority).toBe(20);
    });

    it("应该包含所有配置 keys", () => {
      const keys = SKILL_CONFIG_REGISTRATION.keys;
      expect(keys).toContainEqual(
        expect.objectContaining({ key: "skill.skillPaths" })
      );
      expect(keys).toContainEqual(
        expect.objectContaining({ key: "skill.recursive" })
      );
      expect(keys).toContainEqual(
        expect.objectContaining({ key: "skill.cacheEnabled" })
      );
    });
  });

  describe("SKILL_DEFAULTS", () => {
    it("应该包含 recursive 默认值（完整格式）", () => {
      expect(SKILL_DEFAULTS["skill.recursive"]).toBe(true);
    });

    it("应该包含 cacheEnabled 默认值（完整格式）", () => {
      expect(SKILL_DEFAULTS["skill.cacheEnabled"]).toBe(true);
    });
  });

  describe("配置注册到 ConfigComponent", () => {
    it("应该能够注册 SKILL_CONFIG_REGISTRATION", () => {
      configComponent.registerComponent(SKILL_CONFIG_REGISTRATION);
      expect(() => configComponent.registerComponent(SKILL_CONFIG_REGISTRATION)).not.toThrow();
    });
  });
});
