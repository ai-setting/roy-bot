/**
 * @fileoverview Session Component 配置注册测试
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SessionComponent } from "./session-component";
import { ConfigComponent } from "../../config/config-component";
import { SESSION_CONFIG_REGISTRATION, SESSION_DEFAULTS } from "./session-config-registration";

describe("SessionComponent Config Registration", () => {
  let configComponent: ConfigComponent;
  let sessionComponent: SessionComponent;

  beforeEach(() => {
    configComponent = new ConfigComponent();
    sessionComponent = new SessionComponent();
  });

  describe("默认值注册", () => {
    it("应该注册 session.storage.type 的默认值为 sqlite", async () => {
      await sessionComponent.init({
        options: { configComponent },
      });

      const storageType = configComponent.get("session.storage.type");
      expect(storageType).toBe("sqlite");
    });

    it("应该注册 session.storage.dbPath 的默认值", async () => {
      await sessionComponent.init({
        options: { configComponent },
      });

      const dbPath = configComponent.get("session.storage.dbPath");
      expect(dbPath).toBeDefined();
      expect(typeof dbPath).toBe("string");
      expect(dbPath).toContain("roy-bot");
      expect(dbPath).toContain("sessions.db");
    });

    it("应该注册 session.maxMessages 的默认值为 100", async () => {
      await sessionComponent.init({
        options: { configComponent },
      });

      const maxMessages = configComponent.get("session.maxMessages");
      expect(maxMessages).toBe(100);
    });

    it("应该注册 session.defaultTitleTemplate 的默认值", async () => {
      await sessionComponent.init({
        options: { configComponent },
      });

      const template = configComponent.get("session.defaultTitleTemplate");
      expect(template).toBe("Session - {date}");
    });

    it("应该注册 session.autoCompact 的默认值为 true", async () => {
      await sessionComponent.init({
        options: { configComponent },
      });

      const autoCompact = configComponent.get("session.autoCompact");
      expect(autoCompact).toBe(true);
    });

    it("应该注册 session.compactionThreshold 的默认值为 80", async () => {
      await sessionComponent.init({
        options: { configComponent },
      });

      const threshold = configComponent.get("session.compactionThreshold");
      expect(threshold).toBe(80);
    });
  });

  describe("配置优先级", () => {
    it("应该允许 config 对象覆盖默认值", async () => {
      await sessionComponent.init({
        options: {
          configComponent,
          config: {
            storage: { type: "memory" },
          },
        },
      });

      const storageType = configComponent.get("session.storage.type");
      expect(storageType).toBe("memory");
    });

    it("应该允许 config 对象覆盖 dbPath", async () => {
      const customPath = "/custom/path/sessions.db";

      await sessionComponent.init({
        options: {
          configComponent,
          config: {
            storage: { dbPath: customPath },
          },
        },
      });

      const dbPath = configComponent.get("session.storage.dbPath");
      expect(dbPath).toBe(customPath);
    });
  });

  describe("SESSION_CONFIG_REGISTRATION 常量", () => {
    it("应该导出正确的 registration 对象", () => {
      expect(SESSION_CONFIG_REGISTRATION.name).toBe("session");
    });

    it("应该包含所有必需的 keys", () => {
      const expectedKeys = [
        "session.defaultDirectory",
        "session.defaultTitleTemplate",
        "session.maxMessages",
        "session.compactionThreshold",
        "session.autoCompact",
        "session.storage.type",
        "session.storage.dbPath",
      ];

      for (const key of expectedKeys) {
        const found = SESSION_CONFIG_REGISTRATION.keys.some((k) => k.key === key);
        expect(found).toBe(true);
      }
    });

    it("应该导出默认值常量（完整格式）", () => {
      expect(SESSION_DEFAULTS).toBeDefined();
      expect(SESSION_DEFAULTS["session.storage.type"]).toBe("sqlite");
      expect(SESSION_DEFAULTS["session.maxMessages"]).toBe(100);
    });
  });
});
