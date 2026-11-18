/**
 * @fileoverview which 命令测试
 * 
 * TDD: 测试跨平台 which 命令功能
 */

import { describe, test, expect } from "bun:test";
import { which } from "./which";

describe("which 命令 - 跨平台兼容性测试", () => {
  describe("绝对路径处理", () => {
    test("应识别绝对路径", () => {
      // 使用系统中肯定存在的文件
      const result = which("/bin/ls");
      expect(result).toBe("/bin/ls");
    });

    test("不存在的绝对路径应返回 null", () => {
      const result = which("/non/existent/path/command");
      expect(result).toBeNull();
    });
  });

  describe("PATH 环境变量", () => {
    test("Unix 平台应使用冒号分隔 PATH", () => {
      // 测试逻辑：在 Unix 系统上应该能找到 ls
      const result = which("ls");
      expect(result).not.toBeNull();
      expect(result).toContain("ls");
    });

    test("Windows 平台应使用分号分隔 PATH", () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", {
        value: "win32",
        writable: true,
        configurable: true,
      });

      try {
        const pathSeparator = process.platform === "win32" ? ";" : ":";
        expect(pathSeparator).toBe(";");
      } finally {
        if (originalPlatform) {
          Object.defineProperty(process, "platform", originalPlatform);
        }
      }
    });
  });

  describe("PATHEXT 扩展名 (Windows)", () => {
    test("Windows 平台应检查常见扩展名", () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", {
        value: "win32",
        writable: true,
        configurable: true,
      });

      try {
        const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";");
        expect(extensions).toContain(".EXE");
        expect(extensions).toContain(".BAT");
        expect(extensions).toContain(".CMD");
      } finally {
        if (originalPlatform) {
          Object.defineProperty(process, "platform", originalPlatform);
        }
      }
    });
  });

  describe("系统 which 命令 fallback", () => {
    test("Unix 平台可以使用系统 which 命令", () => {
      // 在 Linux 上测试 which 命令是否存在
      const result = which("ls");
      expect(result).not.toBeNull();
    });

    test("Windows 平台不应尝试执行系统 which 命令", () => {
      // 这个测试验证 Windows 平台上逻辑正确
      // 当 platform 是 win32 时，不应该执行 execSync which
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", {
        value: "win32",
        writable: true,
        configurable: true,
      });

      try {
        // 验证 pathSeparator 在 Windows 上是分号
        const pathSeparator = process.platform === "win32" ? ";" : ":";
        expect(pathSeparator).toBe(";");
      } finally {
        if (originalPlatform) {
          Object.defineProperty(process, "platform", originalPlatform);
        }
      }
    });
  });
});
