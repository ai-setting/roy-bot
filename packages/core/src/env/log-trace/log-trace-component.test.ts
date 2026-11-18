/**
 * @fileoverview LogTraceComponent Tests
 * 
 * 使用 TDD 方法测试 LogTraceComponent 配置加载
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "bun:test";
import { LogTraceComponent } from "./log-trace-component";
import { ConfigComponent } from "../../config/config-component";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";
import type { Environment } from "../interface";

describe("LogTraceComponent Config Loading", () => {
  let component: LogTraceComponent;
  let configComponent: ConfigComponent;
  let mockEnv: Environment;
  let tempDir: string;

  beforeEach(() => {
    component = new LogTraceComponent();
    configComponent = new ConfigComponent();
    
    // Create temp directory for config files
    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "logtrace-config-test-"));
    
    // Set XDG_DATA_HOME to temp directory so ConfigComponent can find config files
    configComponent.setXdgDataHome(tempDir);
    
    // Mock environment
    mockEnv = {
      name: "test-env",
      version: "1.0.0",
      getComponent: vi.fn((name: string) => {
        if (name === "config") return configComponent;
        return undefined;
      }),
      hasComponent: vi.fn((name: string) => name === "config"),
      logger: vi.fn(),
      trace: vi.fn(),
    } as unknown as Environment;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Clean up environment variables
    delete process.env.LOG_TRACE_LOGGING_LEVEL;
    delete process.env.LOG_TRACE_LOGGING_QUIET;
    delete process.env.LOG_TRACE_TRACING_ENABLED;
    delete process.env.LOG_TRACE_TRACING_STORAGE;
    delete process.env.LOG_LOGGING_LEVEL;
    delete process.env.LOG_LOGGING_LEVEL;
    // Clean up temp directory
    try {
      fsSync.rmSync(tempDir, { recursive: true });
    } catch {}
  });

  describe("LogTraceComponentOptions", () => {
    test("should accept configComponent only", async () => {
      await component.init({
        name: "log-trace",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { configComponent }
      });
      expect(component.getStatus()).toBe("running");
    });

    test("should accept configPath option", async () => {
      fsSync.writeFileSync(path.join(tempDir, "config.jsonc"), JSON.stringify({
        "log-trace": {
          logging: {
            level: "debug"
          }
        }
      }), "utf-8");

      await component.init({
        name: "log-trace",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { configComponent, configPath: "config.jsonc" }
      });
      expect(component.getStatus()).toBe("running");
    });

    test("should accept envPrefix option", async () => {
      process.env.LOG_TRACE_LOGGING_LEVEL = "warn";
      
      await component.init({
        name: "log-trace",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { configComponent, envPrefix: "LOG_TRACE" }
      });
      expect(component.getStatus()).toBe("running");
      
      delete process.env.LOG_TRACE_LOGGING_LEVEL;
    });

    test("should accept config option with direct object", async () => {
      await component.init({
        name: "log-trace",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { 
          configComponent, 
          config: {
            logging: {
              level: "error"
            }
          }
        }
      });
      expect(component.getStatus()).toBe("running");
    });
  });

  describe("config priority: Object > Env > File", () => {
    test("should Object config override Env config", async () => {
      // Set environment variable (使用正确的格式)
      // LOG_TRACE_LOGGING_LEVEL -> log-trace.logging.level
      process.env.LOG_TRACE_LOGGING_LEVEL = "warn";
      
      // Create file config
      fsSync.writeFileSync(path.join(tempDir, "config.jsonc"), JSON.stringify({
        "log-trace": { logging: { level: "info" } }
      }), "utf-8");

      await component.init({
        name: "log-trace",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { 
          configComponent, 
          configPath: "config.jsonc",
          envPrefix: "LOG_TRACE",
          config: { logging: { level: "error" } }  // Object has highest priority
        }
      });
      
      // Object config should have highest priority
      expect(configComponent.get("log-trace.logging.level")).toBe("error");
      
      delete process.env.LOG_TRACE_LOGGING_LEVEL;
    });

    test("should Env config override File config", async () => {
      // Set environment variable (使用正确的格式: PREFIX + KEY)
      // LOG_TRACE_LOGGING_LEVEL -> log-trace.logging.level
      process.env.LOG_TRACE_LOGGING_LEVEL = "warn";
      
      // Create file config
      fsSync.writeFileSync(path.join(tempDir, "config.jsonc"), JSON.stringify({
        "log-trace": { logging: { level: "info" } }
      }), "utf-8");

      await component.init({
        name: "log-trace",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { 
          configComponent, 
          configPath: "config.jsonc",
          envPrefix: "LOG_TRACE"
        }
      });
      
      // Env should override file
      expect(configComponent.get("log-trace.logging.level")).toBe("warn");
      
      delete process.env.LOG_TRACE_LOGGING_LEVEL;
    });

    test("should File config be loaded when present", async () => {
      fsSync.writeFileSync(path.join(tempDir, "config.jsonc"), JSON.stringify({
        "log-trace": { 
          logging: { 
            level: "debug",
            quiet: true 
          },
          tracing: {
            enabled: false
          }
        }
      }), "utf-8");

      await component.init({
        name: "log-trace",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: {
          configComponent,
          configPath: "config.jsonc",
          cwd: tempDir,  // 隔离 project source，避免被 cwd 下的 .roy/config.jsonc 干扰
        }
      });

      expect(configComponent.get("log-trace.logging.level")).toBe("debug");
      expect(configComponent.get("log-trace.logging.quiet")).toBe(true);
      expect(configComponent.get("log-trace.tracing.enabled")).toBe(false);
    });

    test("should use default values when no config provided", async () => {
      await component.init({
        name: "log-trace",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { configComponent }
      });
      
      // Default values should be set from LOG_TRACE_DEFAULTS
      expect(configComponent.get("log-trace.logging.level")).toBe("info");
    });
  });

  describe("config hot reload", () => {
    test("should register config watcher for hot reload", async () => {
      const watcherFn = vi.fn();
      vi.spyOn(configComponent, "watch").mockReturnValue(watcherFn);
      
      await component.init({
        name: "log-trace",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { configComponent }
      });
      
      expect(configComponent.watch).toHaveBeenCalledWith("log-trace.*", expect.any(Function));
    });
  });
});
