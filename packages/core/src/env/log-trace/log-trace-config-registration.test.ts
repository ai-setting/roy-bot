/**
 * @fileoverview LogTrace Component 配置注册测试
 * 
 * TDD: 先写测试，验证配置注册机制
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ConfigComponent } from "../../config/config-component";
import { LogTraceComponent } from "./log-trace-component";
import { LOG_TRACE_CONFIG_REGISTRATION, LOG_TRACE_DEFAULTS } from "./log-trace-config-registration";

describe("LogTrace Config Registration (TDD)", () => {
  let configComponent: ConfigComponent;
  let component: LogTraceComponent;

  beforeEach(() => {
    configComponent = new ConfigComponent();
    component = new LogTraceComponent();
  });

  // ========================================================================
  // 核心验收标准：registerConfig 必须遵循 SessionComponent 模式
  // ========================================================================

  describe("【验收标准】默认值注册", () => {
    it("应该注册 log-trace.logging.enabled 的默认值为 true", async () => {
      await component.init({
        options: { configComponent },
      });

      const enabled = configComponent.get("log-trace.logging.enabled");
      expect(enabled).toBe(true);
    });

    it("应该注册 log-trace.logging.level 的默认值为 info", async () => {
      await component.init({
        options: { configComponent },
      });

      const level = configComponent.get("log-trace.logging.level");
      expect(level).toBe("info");
    });

    it("应该注册 log-trace.logging.quiet 的默认值为 false", async () => {
      await component.init({
        options: { configComponent },
      });

      const quiet = configComponent.get("log-trace.logging.quiet");
      expect(quiet).toBe(false);
    });

    it("应该注册 log-trace.tracing.enabled 的默认值为 true", async () => {
      await component.init({
        options: { configComponent },
      });

      const enabled = configComponent.get("log-trace.tracing.enabled");
      expect(enabled).toBe(true);
    });

    it("应该注册 log-trace.logging.dir 的默认值", async () => {
      await component.init({
        options: { configComponent },
      });

      const logDir = configComponent.get("log-trace.logging.dir");
      expect(logDir).toBeDefined();
      expect(typeof logDir).toBe("string");
    });

    it("应该注册 log-trace.logging.maxOutput 的默认值为 0", async () => {
      await component.init({
        options: { configComponent },
      });

      const maxOutput = configComponent.get("log-trace.logging.maxOutput");
      expect(maxOutput).toBe(0);
    });
  });

  describe("【验收标准】配置优先级 - config 对象覆盖默认值", () => {
    it("应该允许 config 对象覆盖 logging.level", async () => {
      await component.init({
        options: {
          configComponent,
          config: {
            logging: {
              level: "debug",
            },
          },
        },
      });

      const level = configComponent.get("log-trace.logging.level");
      expect(level).toBe("debug");
    });

    it("应该允许 config 对象覆盖 logging.enabled", async () => {
      await component.init({
        options: {
          configComponent,
          config: {
            logging: {
              enabled: false,
            },
          },
        },
      });

      const enabled = configComponent.get("log-trace.logging.enabled");
      expect(enabled).toBe(false);
    });

    it("应该允许 config 对象覆盖 tracing.enabled", async () => {
      await component.init({
        options: {
          configComponent,
          config: {
            tracing: {
              enabled: false,
            },
          },
        },
      });

      const enabled = configComponent.get("log-trace.tracing.enabled");
      expect(enabled).toBe(false);
    });
  });

  describe("【验收标准】环境变量覆盖", () => {
    it("应该通过环境变量覆盖 logging.level", async () => {
      // 设置环境变量：LOG_TRACE_LOGGING_LEVEL -> log-trace.logging.level
      const originalValue = process.env.LOG_TRACE_LOGGING_LEVEL;
      process.env.LOG_TRACE_LOGGING_LEVEL = "debug";

      try {
        await component.init({
          options: { configComponent },
        });

        const level = configComponent.get("log-trace.logging.level");
        expect(level).toBe("debug");
      } finally {
        if (originalValue !== undefined) {
          process.env.LOG_TRACE_LOGGING_LEVEL = originalValue;
        } else {
          delete process.env.LOG_TRACE_LOGGING_LEVEL;
        }
      }
    });

    // 注意：环境变量总是字符串，ConfigComponent.get 返回的也是字符串
    // 如果需要布尔值，应该在应用层进行类型转换
    it("应该通过环境变量覆盖 logging.enabled (字符串形式)", async () => {
      const originalValue = process.env.LOG_TRACE_LOGGING_ENABLED;
      process.env.LOG_TRACE_LOGGING_ENABLED = "false";

      try {
        await component.init({
          options: { configComponent },
        });

        const enabled = configComponent.get("log-trace.logging.enabled");
        expect(enabled).toBe("false");
      } finally {
        if (originalValue !== undefined) {
          process.env.LOG_TRACE_LOGGING_ENABLED = originalValue;
        } else {
          delete process.env.LOG_TRACE_LOGGING_ENABLED;
        }
      }
    });

    it("应该通过环境变量覆盖 tracing.enabled (字符串形式)", async () => {
      const originalValue = process.env.LOG_TRACE_TRACING_ENABLED;
      process.env.LOG_TRACE_TRACING_ENABLED = "false";

      try {
        await component.init({
          options: { configComponent },
        });

        const enabled = configComponent.get("log-trace.tracing.enabled");
        expect(enabled).toBe("false");
      } finally {
        if (originalValue !== undefined) {
          process.env.LOG_TRACE_TRACING_ENABLED = originalValue;
        } else {
          delete process.env.LOG_TRACE_TRACING_ENABLED;
        }
      }
    });
  });

  describe("【验收标准】LOG_TRACE_CONFIG_REGISTRATION 使用", () => {
    it("应该导出正确的 registration 对象", () => {
      expect(LOG_TRACE_CONFIG_REGISTRATION.name).toBe("log-trace");
    });

    it("应该包含所有必需的 keys", () => {
      const expectedKeys = [
        "log-trace.logging.enabled",
        "log-trace.logging.level",
        "log-trace.logging.quiet",
        "log-trace.tracing.enabled",
      ];

      for (const key of expectedKeys) {
        const found = LOG_TRACE_CONFIG_REGISTRATION.keys.some((k) => k.key === key);
        expect(found).toBe(true);
      }
    });

    it("应该导出默认值常量（完整格式）", () => {
      expect(LOG_TRACE_DEFAULTS).toBeDefined();
      expect(LOG_TRACE_DEFAULTS["log-trace.logging.enabled"]).toBe(true);
      expect(LOG_TRACE_DEFAULTS["log-trace.logging.level"]).toBe("info");
      expect(LOG_TRACE_DEFAULTS["log-trace.tracing.enabled"]).toBe(true);
    });
  });
});

// Legacy tests preserved for reference
describe("LogTrace Config Registration (Legacy)", () => {
  let configComponent: ConfigComponent;
  let component: LogTraceComponent;

  beforeEach(() => {
    configComponent = new ConfigComponent();
    component = new LogTraceComponent();
  });

  describe("LOG_TRACE_CONFIG_REGISTRATION", () => {
    it("应该包含正确的 name", () => {
      expect(LOG_TRACE_CONFIG_REGISTRATION.name).toBe("log-trace");
    });

    it("应该包含 env source 配置", () => {
      const envSource = LOG_TRACE_CONFIG_REGISTRATION.sources.find(
        (s) => s.type === "env"
      );
      expect(envSource).toBeDefined();
      expect(envSource?.envPrefix).toBe("LOG_TRACE");
      expect(envSource?.priority).toBe(20);
    });

    it("应该包含所有配置 keys", () => {
      const keys = LOG_TRACE_CONFIG_REGISTRATION.keys;
      expect(keys).toContainEqual(
        expect.objectContaining({ key: "log-trace.logging.enabled" })
      );
      expect(keys).toContainEqual(
        expect.objectContaining({ key: "log-trace.logging.level" })
      );
      expect(keys).toContainEqual(
        expect.objectContaining({ key: "log-trace.tracing.enabled" })
      );
    });
  });

  describe("LOG_TRACE_DEFAULTS", () => {
    it("应该包含 logging.enabled 默认值（完整格式）", () => {
      expect(LOG_TRACE_DEFAULTS["log-trace.logging.enabled"]).toBe(true);
    });

    it("应该包含 logging.level 默认值（完整格式）", () => {
      expect(LOG_TRACE_DEFAULTS["log-trace.logging.level"]).toBe("info");
    });

    it("应该包含 tracing.enabled 默认值（完整格式）", () => {
      expect(LOG_TRACE_DEFAULTS["log-trace.tracing.enabled"]).toBe(true);
    });
  });

  describe("配置注册到 ConfigComponent", () => {
    it("应该能够注册 LOG_TRACE_CONFIG_REGISTRATION", () => {
      configComponent.registerComponent(LOG_TRACE_CONFIG_REGISTRATION);
      expect(() => configComponent.registerComponent(LOG_TRACE_CONFIG_REGISTRATION)).not.toThrow();
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
      
      expect(component.name).toBe("log-trace");
      expect(component.version).toBe("1.0.0");
    });

    it("应该能够通过 config 对象传入配置", async () => {
      await component.init({
        options: {
          configComponent,
          config: {
            logging: {
              enabled: false,
              level: "debug",
            },
            tracing: {
              enabled: true,
            },
          },
        },
      } as any);
      
      expect(component.name).toBe("log-trace");
    });
  });

  describe("环境变量覆盖", () => {
    it("应该能够通过环境变量覆盖配置", async () => {
      // 设置环境变量
      const originalValue = process.env.LOG_TRACE_LOGGING_LEVEL;
      process.env.LOG_TRACE_LOGGING_LEVEL = "debug";
      
      try {
        await component.init({
          options: {
            configComponent,
          },
        } as any);
        
        expect(component.name).toBe("log-trace");
      } finally {
        // 恢复环境变量
        if (originalValue !== undefined) {
          process.env.LOG_TRACE_LOGGING_LEVEL = originalValue;
        } else {
          delete process.env.LOG_TRACE_LOGGING_LEVEL;
        }
      }
    });
  });
});
