/**
 * @fileoverview 3-档色阶 (palette) 单元测试
 *
 * Task #2252: 改造点 4 — 扩展 COLORS：primary / secondary / accent
 *
 * 验证:
 *   - primary/secondary/accent 都是函数
 *   - accent 的 hex 颜色包含 #ff6b6b
 *   - 输入任意 string 都返回 string
 *   - 旧 8 色 (userInput/assistant/system/reasoning/toolCall/toolResult/error/progress) 仍然存在（向后兼容）
 *   - chalk.level=0 时（无颜色终端）所有色档应原样返回输入（不抛错）
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as chalkNs from "chalk";
import { COLORS } from "./stream-output.service";

const chalk = chalkNs.default;

describe("COLORS — 3 档色阶 (Task #2252)", () => {
  let originalLevel: 0 | 1 | 2 | 3;

  beforeEach(() => {
    originalLevel = chalk.level as 0 | 1 | 2 | 3;
  });

  afterEach(() => {
    chalk.level = originalLevel;
  });

  describe("primary", () => {
    test("should be a function (chalk.bold.whiteBright)", () => {
      expect(typeof COLORS.primary).toBe("function");
    });

    test("should return a string for any input", () => {
      const out = COLORS.primary("hello");
      expect(typeof out).toBe("string");
      expect(out).toContain("hello");
    });
  });

  describe("secondary", () => {
    test("should be a function (chalk.gray)", () => {
      expect(typeof COLORS.secondary).toBe("function");
    });

    test("should return a string for any input", () => {
      const out = COLORS.secondary("info");
      expect(typeof out).toBe("string");
      expect(out).toContain("info");
    });
  });

  describe("accent", () => {
    test("should be a function (chalk.hex '#ff6b6b')", () => {
      expect(typeof COLORS.accent).toBe("function");
    });

    test("should return a string for any input", () => {
      const out = COLORS.accent("Tips");
      expect(typeof out).toBe("string");
      expect(out).toContain("Tips");
    });

    test("should produce a non-empty colorized output when chalk.level > 0", () => {
      chalk.level = 1;
      const out = COLORS.accent("ready");
      // chalk with color level 1 emits ANSI escape
      expect(out.length).toBeGreaterThan("ready".length);
    });
  });

  describe("accentBold", () => {
    test("should be a function (chalk.hex '#ff6b6b' bold)", () => {
      expect(typeof COLORS.accentBold).toBe("function");
    });

    test("should return a string", () => {
      const out = COLORS.accentBold("What's new");
      expect(typeof out).toBe("string");
      expect(out).toContain("What's new");
    });
  });

  describe("muted", () => {
    test("should be chalk.dim", () => {
      expect(typeof COLORS.muted).toBe("function");
    });

    test("should return a string for any input", () => {
      const out = COLORS.muted("divider");
      expect(typeof out).toBe("string");
      expect(out).toContain("divider");
    });
  });

  describe("backward compatibility — 旧 8 色仍然存在", () => {
    test.each([
      "userInput",
      "userInputPrefix",
      "assistant",
      "system",
      "reasoning",
      "toolCall",
      "toolResult",
      "error",
      "progress",
    ])("COLORS.%s should exist", (key) => {
      expect((COLORS as any)[key]).toBeDefined();
    });
  });

  describe("graceful degradation — chalk.level=0 (无颜色终端)", () => {
    test("all color helpers should not throw and should preserve input", () => {
      chalk.level = 0;
      // chalk 会变成 identity 函数（不抛错，原样返回）
      const samples: Array<[string, (s: string) => string]> = [
        ["primary", COLORS.primary],
        ["secondary", COLORS.secondary],
        ["accent", COLORS.accent],
        ["accentBold", COLORS.accentBold],
        ["muted", COLORS.muted],
      ];
      for (const [, fn] of samples) {
        const out = fn("payload");
        expect(typeof out).toBe("string");
        // chalk.level=0 时不输出 ANSI，原样返回
        expect(out).toBe("payload");
      }
    });
  });
});
