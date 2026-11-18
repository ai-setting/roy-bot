/**
 * @fileoverview Debug Log Command - TDD Tests
 * 
 * TDD 开发流程:
 * 1. RED - 编写失败的测试
 * 2. GREEN - 编写最小代码让测试通过
 * 3. REFACTOR - 重构
 * 
 * 测试目标: debug log --tail -n xxx
 * 功能: 读取 log-trace component 的日志文件配置的尾部 n 行
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";

describe("Debug Log Command - TDD", () => {
  let tempDir: string;
  let tempLogFile: string;

  beforeEach(() => {
    // Create temp directory and file
    tempDir = fs.mkdtempSync("/tmp/debug-log-test-");
    tempLogFile = path.join(tempDir, "test.log");
  });

  afterEach(() => {
    // Cleanup
    try {
      if (fs.existsSync(tempLogFile)) {
        fs.unlinkSync(tempLogFile);
      }
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("RED: getDefaultLogFile()", () => {
    test("should return path in XDG_DATA_HOME/roy-bot/logs/app.log by default", async () => {
      const { getDefaultLogFile } = await import("./log");
      
      // Clear environment variables
      delete process.env.LOG_TRACE_LOGGING_DIR;
      delete process.env.LOG_TRACE_LOGGING_FILE;
      
      const logFile = getDefaultLogFile();
      
      expect(logFile).toContain("roy-bot");
      expect(logFile).toContain("logs");
      expect(logFile).toContain("app.log");
    });

    test("should use LOG_TRACE_LOGGING_DIR environment variable when set", async () => {
      const { getDefaultLogFile } = await import("./log");
      
      const customDir = "/custom/logs/dir";
      process.env.LOG_TRACE_LOGGING_DIR = customDir;
      
      const logFile = getDefaultLogFile();
      
      expect(logFile).toStartWith(customDir);
      expect(logFile).toEndWith("app.log");
      
      delete process.env.LOG_TRACE_LOGGING_DIR;
    });

    test("should use LOG_TRACE_LOGGING_FILE environment variable when set to absolute path", async () => {
      const { getDefaultLogFile } = await import("./log");
      
      const customFile = "/absolute/path/custom.log";
      process.env.LOG_TRACE_LOGGING_FILE = customFile;
      
      const logFile = getDefaultLogFile();
      
      expect(logFile).toBe(customFile);
      
      delete process.env.LOG_TRACE_LOGGING_FILE;
    });

    test("should use custom filename in default log dir when LOG_TRACE_LOGGING_FILE is just filename", async () => {
      const { getDefaultLogFile } = await import("./log");
      
      process.env.LOG_TRACE_LOGGING_DIR = "/custom/logs";
      process.env.LOG_TRACE_LOGGING_FILE = "custom-app.log";
      
      const logFile = getDefaultLogFile();
      
      expect(logFile).toBe("/custom/logs/custom-app.log");
      
      delete process.env.LOG_TRACE_LOGGING_DIR;
      delete process.env.LOG_TRACE_LOGGING_FILE;
    });
  });

  describe("RED: readTailLines()", () => {
    test("should read last n lines from file", async () => {
      // Write test file
      const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
      fs.writeFileSync(tempLogFile, lines.join("\n"));
      
      const { readTailLines } = await import("./log");
      
      const tailLines = await readTailLines(tempLogFile, 10);
      
      expect(tailLines).toHaveLength(10);
      expect(tailLines[0]).toBe("Line 91");
      expect(tailLines[9]).toBe("Line 100");
    });

    test("should return all lines if file has fewer lines than n", async () => {
      const lines = ["Line 1", "Line 2", "Line 3"];
      fs.writeFileSync(tempLogFile, lines.join("\n"));
      
      const { readTailLines } = await import("./log");
      
      const tailLines = await readTailLines(tempLogFile, 10);
      
      expect(tailLines).toHaveLength(3);
      expect(tailLines[0]).toBe("Line 1");
    });

    test("should return empty array for empty file", async () => {
      fs.writeFileSync(tempLogFile, "");
      
      const { readTailLines } = await import("./log");
      
      const tailLines = await readTailLines(tempLogFile, 10);
      
      expect(tailLines).toHaveLength(0);
    });

    test("should handle file with trailing newline", async () => {
      const lines = ["Line 1", "Line 2", "Line 3"];
      fs.writeFileSync(tempLogFile, lines.join("\n") + "\n");
      
      const { readTailLines } = await import("./log");
      
      const tailLines = await readTailLines(tempLogFile, 3);
      
      // readline treats each newline as end of line
      expect(tailLines).toHaveLength(3);
    });

    test("should handle n=0 and return empty array", async () => {
      const lines = ["Line 1", "Line 2", "Line 3"];
      fs.writeFileSync(tempLogFile, lines.join("\n"));
      
      const { readTailLines } = await import("./log");
      
      const tailLines = await readTailLines(tempLogFile, 0);
      
      expect(tailLines).toHaveLength(0);
    });

    test("should reject promise when file does not exist", async () => {
      const { readTailLines } = await import("./log");
      
      await expect(readTailLines("/non/existent/file.log", 10)).rejects.toThrow();
    });
  });

  describe("GREEN: LogCommand structure", () => {
    test("should have correct command name 'log'", async () => {
      const { LogCommand } = await import("./index");
      
      expect(LogCommand.command).toBe("log");
    });

    test("should have describe text mentioning tail functionality", async () => {
      const { LogCommand } = await import("./index");
      
      expect(LogCommand.describe).toContain("tail");
    });

    test("should have builder that adds --tail option", async () => {
      const { LogCommand } = await import("./index");
      
      let capturedOptions: Record<string, any> = {};
      let optionCalls = 0;
      const mockYargs = {
        option: (name: string, config: any) => {
          optionCalls++;
          capturedOptions[name] = config;
          return mockYargs;
        },
      };
      
      LogCommand.builder(mockYargs as any);
      
      expect(optionCalls).toBeGreaterThanOrEqual(1);
      expect(capturedOptions.tail).toBeDefined();
      expect(capturedOptions.tail.alias).toBe("n");
      expect(capturedOptions.tail.type).toBe("number");
    });

    test("should have --tail option with default value 50", async () => {
      const { LogCommand } = await import("./index");
      
      let capturedOptions: Record<string, any> = {};
      const mockYargs = {
        option: (name: string, config: any) => {
          capturedOptions[name] = config;
          return mockYargs;
        },
      };
      
      LogCommand.builder(mockYargs as any);
      
      expect(capturedOptions.tail.default).toBe(50);
    });

    test("should have --file option for custom log file path", async () => {
      const { LogCommand } = await import("./index");
      
      let capturedOptions: Record<string, any> = {};
      const mockYargs = {
        option: (name: string, config: any) => {
          capturedOptions[name] = config;
          return mockYargs;
        },
      };
      
      LogCommand.builder(mockYargs as any);
      
      expect(capturedOptions.file).toBeDefined();
      expect(capturedOptions.file.alias).toBe("f");
      expect(capturedOptions.file.type).toBe("string");
    });
  });
});
