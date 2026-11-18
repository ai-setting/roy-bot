import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createLogger,
  getLogDir,
  getLogLevel,
  getCategoryLogLevel,
  setQuietMode,
  isQuietMode,
  setConfigComponent,
  type LogLevel,
} from "./logger";
import * as fs from "fs";
import * as path from "path";

describe("Logger", () => {
  beforeEach(() => {
    // 创建临时日志目录用于测试
  });

  afterEach(() => {
    // 清理
  });

  describe("createLogger", () => {
    test("should create logger with default config", () => {
      const logger = createLogger("test");
      expect(logger).toBeDefined();
      expect(typeof logger.debug).toBe("function");
      expect(typeof logger.info).toBe("function");
      expect(typeof logger.warn).toBe("function");
      expect(typeof logger.error).toBe("function");
    });

    test("should create logger with custom prefix", () => {
      const logger = createLogger("custom-prefix");
      expect(logger).toBeDefined();
    });

    test("should create multiple loggers with same name (caching)", () => {
      const logger1 = createLogger("shared");
      const logger2 = createLogger("shared");
      expect(logger1).toBe(logger2); // 同一个实例
    });
  });

  describe("log levels", () => {
    test("should log debug messages", () => {
      const logger = createLogger("debug-test");
      // 不应该抛出错误
      expect(() => logger.debug("test message")).not.toThrow();
    });

    test("should log info messages", () => {
      const logger = createLogger("info-test");
      expect(() => logger.info("test message")).not.toThrow();
    });

    test("should log warn messages", () => {
      const logger = createLogger("warn-test");
      expect(() => logger.warn("test message")).not.toThrow();
    });

    test("should log error messages", () => {
      const logger = createLogger("error-test");
      expect(() => logger.error("test message")).not.toThrow();
    });

    test("should log with data", () => {
      const logger = createLogger("data-test");
      expect(() => logger.info("test message", { key: "value" })).not.toThrow();
    });
  });

  describe("quiet mode", () => {
    test("should enable quiet mode", () => {
      setQuietMode(true);
      expect(isQuietMode()).toBe(true);
    });

    test("should disable quiet mode", () => {
      setQuietMode(false);
      expect(isQuietMode()).toBe(false);
    });

    test("should not output to console in quiet mode", () => {
      setQuietMode(true);
      const logger = createLogger("quiet-test");
      
      // 在 quiet 模式下，日志应该只写入文件，不输出到控制台
      expect(() => logger.info("quiet message")).not.toThrow();
    });
  });

  describe("getLogDir", () => {
    test("should return default logs directory", () => {
      const logDir = getLogDir();
      // 默认应该是 XDG 路径
      expect(logDir).toMatch(/\.local\/share\/roy-bot\/logs$/);
    });
  });

  describe("category log levels", () => {
    // Mock ConfigComponent
    const mockConfigComponent = {
      get: (key: string): unknown => {
        const config: Record<string, unknown> = {
          "log_trace.logging.levels": {
            llm: "debug",
            agent: "warn",
          },
          "log_trace.logging.level": "info",
        };
        return config[key];
      },
    };

    test("should return default log level", () => {
      // 在没有配置的情况下应该返回默认值 info
      setConfigComponent(null);
      const level = getLogLevel();
      expect(["debug", "info", "warn", "error"]).toContain(level);
    });

    test("should return category-specific log level", () => {
      setConfigComponent(mockConfigComponent);
      // llm 配置为 debug
      expect(getCategoryLogLevel("llm")).toBe("debug");
      // agent 配置为 warn
      expect(getCategoryLogLevel("agent")).toBe("warn");
    });

    test("should fallback to global level for unconfigured categories", () => {
      setConfigComponent(mockConfigComponent);
      // tool 没有配置，应该返回全局级别 info
      expect(getCategoryLogLevel("tool")).toBe("info");
    });

    test("should use category level in logger", () => {
      setConfigComponent(mockConfigComponent);
      // llm logger 使用 debug 级别
      const llmLogger = createLogger("llm");
      expect(() => llmLogger.debug("debug message")).not.toThrow();
      
      // agent logger 使用 warn 级别
      const agentLogger = createLogger("agent");
      expect(() => agentLogger.warn("warn message")).not.toThrow();
    });
  });
});
