/**
 * @fileoverview Input Slot 单元测试
 *
 * Task #2252: 改造点 2 — 输入区"槽位化"
 * Task #2262: 第二轮打磨 — 加 ❯ 输入前缀
 *
 * 验证:
 *   - buildTopBorder / buildBottomBorder 输出 ─ 字符
 *   - printSlotTop / printSlotBottom 在 TTY=false 时跳过输出
 *   - getSlotWidth 返回值在合理范围
 *   - buildPromptHint 含 "Try" 占位符
 *   - buildPromptPrefix 含 ❯ 字符 (Task #2262)
 *   - buildPromptLine 含 ❯ + "Try" 组合（Task #2262）
 *   - printSlotHint 输出 3 行（top + prompt + bottom）含 ❯
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as chalkNs from "chalk";
import {
  buildTopBorder,
  buildBottomBorder,
  buildPromptHint,
  buildPromptPrefix,
  buildPromptLine,
  printSlotTop,
  printSlotBottom,
  printSlotHint,
  printSlotTopBorder,
  printSlotBottomBorder,
  getSlotWidth,
} from "./input-slot";

const chalk = chalkNs.default;

describe("Input Slot (Task #2252 + #2262 polish)", () => {
  let originalIsTTY: boolean | undefined;
  let originalColumns: number | undefined;
  let originalLevel: 0 | 1 | 2 | 3;
  let consoleLogSpy: any;

  beforeEach(() => {
    originalIsTTY = process.stdout.isTTY;
    originalColumns = process.stdout.columns;
    originalLevel = chalk.level as 0 | 1 | 2 | 3;
    consoleLogSpy = null;
  });

  afterEach(() => {
    // 恢复
    if (originalIsTTY === undefined) {
      // @ts-ignore
      delete process.stdout.isTTY;
    } else {
      Object.defineProperty(process.stdout, "isTTY", { value: originalIsTTY, configurable: true });
    }
    if (originalColumns !== undefined) {
      Object.defineProperty(process.stdout, "columns", { value: originalColumns, configurable: true });
    }
    chalk.level = originalLevel;
    if (consoleLogSpy) consoleLogSpy.mockRestore();
  });

  describe("buildTopBorder / buildBottomBorder", () => {
    test("should output ─ characters with default width", () => {
      const out = buildTopBorder();
      expect(out).toContain("\u2500");
      // 默认宽度应该 >= 40
      const stripLen = out.replace(/\x1b\[[0-9;]*m/g, "").length;
      expect(stripLen).toBeGreaterThanOrEqual(40);
    });

    test("should respect custom width", () => {
      const out = buildTopBorder(20);
      const stripLen = out.replace(/\x1b\[[0-9;]*m/g, "").length;
      expect(stripLen).toBe(20);
    });

    test("buildBottomBorder === buildTopBorder (same implementation)", () => {
      expect(buildBottomBorder(50)).toBe(buildTopBorder(50));
    });
  });

  describe("buildPromptHint", () => {
    test("should contain 'Try'", () => {
      const hint = buildPromptHint();
      expect(hint).toContain("Try");
    });

    test("should contain '/help' as a hint", () => {
      const hint = buildPromptHint();
      expect(hint).toContain("/help");
    });

    test("should not throw", () => {
      expect(() => buildPromptHint()).not.toThrow();
    });
  });

  describe("buildPromptPrefix — Task #2262 ❯ 前缀", () => {
    test("should contain ❯ (U+276F) character", () => {
      const prefix = buildPromptPrefix();
      expect(prefix).toContain("\u276F");
    });

    test("should contain ❯ followed by space", () => {
      const prefix = buildPromptPrefix();
      // Strip ANSI and check the text starts with ❯ followed by space
      const visible = prefix.replace(/\x1b\[[0-9;]*m/g, "");
      expect(visible.startsWith("\u276F ")).toBe(true);
    });

    test("should use accent (warm red) for ❯ (true color)", () => {
      chalk.level = 3;
      const prefix = buildPromptPrefix();
      // chalk.hex("#ff6b6b") 在 true color 输出 \x1b[38;2;255;107;107m
      expect(prefix).toMatch(/\x1b\[38;2;255;107;107m/);
    });
  });

  describe("buildPromptLine — Task #2262 完整提示行", () => {
    test("should contain ❯ + 'Try' + '/help'", () => {
      const line = buildPromptLine();
      const visible = line.replace(/\x1b\[[0-9;]*m/g, "");
      expect(visible).toContain("\u276F");
      expect(visible).toContain("Try");
      expect(visible).toContain("/help");
    });

    test("should NOT contain │ (no border on prompt line, simpler look)", () => {
      const line = buildPromptLine();
      expect(line).not.toContain("\u2502");
    });
  });

  describe("getSlotWidth", () => {
    test("should return >= 40 (minimum)", () => {
      Object.defineProperty(process.stdout, "columns", { value: 10, configurable: true });
      const w = getSlotWidth();
      expect(w).toBeGreaterThanOrEqual(40);
    });

    test("should clamp at <= 100 (max)", () => {
      Object.defineProperty(process.stdout, "columns", { value: 500, configurable: true });
      const w = getSlotWidth();
      expect(w).toBeLessThanOrEqual(100);
    });

    test("should return default 80 area when columns is undefined", () => {
      Object.defineProperty(process.stdout, "columns", { value: undefined, configurable: true });
      const w = getSlotWidth();
      // 应该是 max(40, min(80-4, 100)) = 76
      expect(w).toBeGreaterThanOrEqual(40);
      expect(w).toBeLessThanOrEqual(100);
    });
  });

  describe("printSlotTop / printSlotBottom / printSlotHint", () => {
    test("printSlotTop should skip output when not TTY", () => {
      Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
      const calls: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => calls.push(args.join(" "));
      try {
        printSlotTop();
        expect(calls.length).toBe(0);
      } finally {
        console.log = origLog;
      }
    });

    test("printSlotBottom should skip output when not TTY", () => {
      Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
      const calls: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => calls.push(args.join(" "));
      try {
        printSlotBottom();
        expect(calls.length).toBe(0);
      } finally {
        console.log = origLog;
      }
    });

    test("printSlotHint should skip output when not TTY", () => {
      Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
      const calls: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => calls.push(args.join(" "));
      try {
        printSlotHint();
        expect(calls.length).toBe(0);
      } finally {
        console.log = origLog;
      }
    });

    test("printSlotTop should output when TTY=true", () => {
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      const calls: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => calls.push(args.join(" "));
      try {
        printSlotTop();
        expect(calls.length).toBeGreaterThanOrEqual(1);
        expect(calls[0]).toContain("\u2500");
      } finally {
        console.log = origLog;
      }
    });

    test("printSlotHint should output 3 lines: top + prompt + bottom", () => {
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      const calls: string[] = [];
      const origLog = console.log;
      console.log = (...args: any[]) => calls.push(args.join(" "));
      try {
        printSlotHint();
        expect(calls.length).toBe(3);
        // 第 1 行: top border (─)
        expect(calls[0]).toContain("\u2500");
        // 第 2 行: prompt line (含 ❯ + "Try")
        expect(calls[1]).toContain("\u276F");
        expect(calls[1]).toContain("Try");
        // 第 3 行: bottom border (─)
        expect(calls[2]).toContain("\u2500");
      } finally {
        console.log = origLog;
      }
    });
  });

  describe("printSlotTopBorder / printSlotBottomBorder — Task #2264 P0", () => {
    test("printSlotTopBorder should output the top border (─ repeated)", () => {
      let captured = "";
      const origLog = console.log;
      console.log = (...args: any[]) => { captured += args.join(" ") + "\n"; };
      try {
        Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
        printSlotTopBorder();
      } finally {
        console.log = origLog;
      }
      expect(captured).toContain("\u2500");
    });

    test("printSlotTopBorder should be a no-op when not TTY", () => {
      let captured = "";
      const origLog = console.log;
      console.log = (...args: any[]) => { captured += args.join(" ") + "\n"; };
      try {
        Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
        printSlotTopBorder();
      } finally {
        console.log = origLog;
      }
      expect(captured).toBe("");
    });

    test("printSlotBottomBorder should output the bottom border", () => {
      let captured = "";
      const origLog = console.log;
      console.log = (...args: any[]) => { captured += args.join(" ") + "\n"; };
      try {
        Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
        printSlotBottomBorder();
      } finally {
        console.log = origLog;
      }
      expect(captured).toContain("\u2500");
    });

    test("printSlotBottomBorder should be a no-op when not TTY", () => {
      let captured = "";
      const origLog = console.log;
      console.log = (...args: any[]) => { captured += args.join(" ") + "\n"; };
      try {
        Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
        printSlotBottomBorder();
      } finally {
        console.log = origLog;
      }
      expect(captured).toBe("");
    });

    test("printSlotTopBorder and printSlotBottomBorder should produce the same border string", () => {
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      let topCaptured = "";
      let botCaptured = "";
      const origLog = console.log;
      try {
        console.log = (...args: any[]) => { topCaptured += args.join(" ") + "\n"; };
        printSlotTopBorder();
        console.log = (...args: any[]) => { botCaptured += args.join(" ") + "\n"; };
        printSlotBottomBorder();
      } finally {
        console.log = origLog;
      }
      // 都应该是相同长度的 ─ 字符
      expect(topCaptured.replace(/\x1b\[[0-9;]*m/g, "").trim()).toBe(
        botCaptured.replace(/\x1b\[[0-9;]*m/g, "").trim()
      );
    });
  });
});
