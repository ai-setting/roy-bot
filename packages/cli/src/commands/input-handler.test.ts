/**
 * @fileoverview InputHandler - TDD Tests
 * 
 * 核心设计：
 * - 纯粹 buffer 管理
 * - 只负责 pushLine, getBuffer, reset, getPrompt
 */

import { describe, test, expect } from "bun:test";
import { InputHandler } from "./input-handler";

describe("InputHandler", () => {

  describe("pushLine - 添加输入", () => {

    test("添加单行内容", () => {
      const handler = new InputHandler();
      handler.pushLine("hello");
      expect(handler.getBuffer()).toBe("hello");
    });

    test("添加多行内容", () => {
      const handler = new InputHandler();
      handler.pushLine("line1");
      handler.pushLine("line2");
      expect(handler.getBuffer()).toBe("line1\nline2");
    });

    test("添加空行", () => {
      const handler = new InputHandler();
      handler.pushLine("hello");
      handler.pushLine("");
      expect(handler.getBuffer()).toBe("hello\n");
    });

    test("支持空白行", () => {
      const handler = new InputHandler();
      handler.pushLine("line1");
      handler.pushLine("");
      handler.pushLine("");
      handler.pushLine("line2");
      expect(handler.getBuffer()).toBe("line1\n\n\nline2");
    });
  });

  describe("reset - 重置", () => {

    test("重置后 buffer 为空", () => {
      const handler = new InputHandler();
      handler.pushLine("hello");
      handler.reset();
      expect(handler.getBuffer()).toBe("");
    });
  });

  describe("getPrompt - 获取提示符", () => {

    test("初始状态返回用户提示符", () => {
      const handler = new InputHandler();
      expect(handler.getPrompt()).toBe("❯ ");
    });

    test("有多行输入时返回继续提示符", () => {
      const handler = new InputHandler();
      handler.pushLine("hello");
      expect(handler.getPrompt()).toBe("... ");
    });

    test("reset 后恢复用户提示符", () => {
      const handler = new InputHandler();
      handler.pushLine("hello");
      handler.reset();
      expect(handler.getPrompt()).toBe("❯ ");
    });
  });

  describe("getBuffer - 边界", () => {

    test("空 buffer 返回空字符串（不是 undefined）", () => {
      const handler = new InputHandler();
      expect(handler.getBuffer()).toBe("");
    });

    test("reset 后多次调用仍返回空字符串", () => {
      const handler = new InputHandler();
      handler.pushLine("x");
      handler.reset();
      handler.reset();
      expect(handler.getBuffer()).toBe("");
    });
  });

  describe("pushLine - 健壮性", () => {

    test("推送空字符串不 crash", () => {
      const handler = new InputHandler();
      expect(() => handler.pushLine("")).not.toThrow();
      expect(handler.getBuffer()).toBe("");
    });

    test("推送 null 不 crash（防御性）", () => {
      const handler = new InputHandler();
      // 故意传入 null —— 应该被当作空字符串处理，不应让整个 REPL 崩溃
      expect(() => handler.pushLine(null as any)).not.toThrow();
    });

    test("推送 undefined 不 crash（防御性）", () => {
      const handler = new InputHandler();
      expect(() => handler.pushLine(undefined as any)).not.toThrow();
    });

    test("过滤控制字符 \\x00-\\x08（除 \\t）", () => {
      const handler = new InputHandler();
      handler.pushLine("a\x00b\x01c\x02");
      // 控制字符 \x00, \x01, \x02 应当被过滤
      expect(handler.getBuffer()).toBe("abc");
    });

    test("过滤 \\x0b-\\x0c（VT, FF）", () => {
      const handler = new InputHandler();
      handler.pushLine("a\x0bb\x0cc");
      expect(handler.getBuffer()).toBe("abc");
    });

    test("过滤 \\x0e-\\x1f（SO-US，不含 \\x1b 已被独立处理）", () => {
      const handler = new InputHandler();
      // 这些是除了 Esc (\x1b) 之外的 C0 控制字符
      handler.pushLine("a\x0eb\x0fc\x10d");
      expect(handler.getBuffer()).toBe("abcd");
    });

    test("保留 \\t (tab) 字符", () => {
      const handler = new InputHandler();
      handler.pushLine("a\tb");
      expect(handler.getBuffer()).toBe("a\tb");
    });

    test("保留 \\n (newline) 字符（行内 newline 通常不会进 pushLine）", () => {
      const handler = new InputHandler();
      handler.pushLine("a\nb");
      // 内部用 join("\n") 拼接，传入含 \n 的字符串是允许的
      expect(handler.getBuffer()).toBe("a\nb");
    });

    test("保留可打印字符", () => {
      const handler = new InputHandler();
      handler.pushLine("Hello, World! 你好 🚀");
      expect(handler.getBuffer()).toBe("Hello, World! 你好 🚀");
    });
  });

  describe("filterControlChars - 静态方法", () => {

    test("过滤所有 C0 控制字符", () => {
      // 期望保留：\t (\x09), \n (\x0a), \r (\x0d) — 这些是常用空白
      // 期望过滤：\x00-\x08, \x0b-\x0c, \x0e-\x1f, \x7f (DEL)
      const filtered = (InputHandler as any).filterControlChars("a\x00b\x01\x7fc");
      expect(filtered).toBe("abc");
    });

    test("保留 tab/newline/CR", () => {
      const filtered = (InputHandler as any).filterControlChars("a\tb\nc\rd");
      expect(filtered).toBe("a\tb\nc\rd");
    });

    test("空字符串返回空字符串", () => {
      const filtered = (InputHandler as any).filterControlChars("");
      expect(filtered).toBe("");
    });
  });
});
