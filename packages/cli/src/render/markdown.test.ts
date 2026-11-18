/**
 * @fileoverview Tests for the CLI markdown renderer (marked + cli-highlight).
 *
 * Task #2610 (范围 C, 阶段 1): 引入 marked + cli-highlight，替换自实现的
 * markdown-renderer.tsx。本测试套件验证 ANSI 字符串渲染器的契约。
 *
 * 注意: 本文件不依赖 Ink，纯字符串 API。
 */

import { describe, it, expect } from "bun:test";
import {
  renderMarkdown,
  isMarkdownEnabled,
  setMarkdownEnabled,
  truncateForTerminal,
} from "./markdown.js";

describe("renderMarkdown", () => {
  describe("basic text", () => {
    it("should pass through plain text unchanged", () => {
      const out = renderMarkdown("hello world", { width: 80 });
      expect(out).toContain("hello world");
      expect(out.trim()).toBe("hello world");
    });

    it("should handle empty input", () => {
      const out = renderMarkdown("", { width: 80 });
      expect(out).toBe("");
    });

    it("should preserve newlines for plain text without markdown", () => {
      const out = renderMarkdown("line1\nline2", { width: 80 });
      expect(out).toContain("line1");
      expect(out).toContain("line2");
    });
  });

  describe("headings", () => {
    it("should render h1 with ANSI bold", () => {
      const out = renderMarkdown("# Title", { width: 80 });
      expect(out).toMatch(/\x1b\[1m/);
      expect(out).toContain("Title");
    });

    it("should render h2 with ANSI bold", () => {
      const out = renderMarkdown("## Section", { width: 80 });
      expect(out).toMatch(/\x1b\[1m/);
      expect(out).toContain("Section");
    });

    it("should render h3 with ANSI bold", () => {
      const out = renderMarkdown("### Sub", { width: 80 });
      expect(out).toMatch(/\x1b\[1m/);
      expect(out).toContain("Sub");
    });
  });

  describe("inline formatting", () => {
    it("should render bold text", () => {
      const out = renderMarkdown("**bold** text", { width: 80 });
      expect(out).toMatch(/\x1b\[1m.*bold/);
    });

    it("should render italic text", () => {
      const out = renderMarkdown("*italic* text", { width: 80 });
      expect(out).toMatch(/\x1b\[3m.*italic/);
    });

    it("should render inline code", () => {
      const out = renderMarkdown("Use `foo()` here", { width: 80 });
      expect(out).toContain("foo()");
    });

    it("should render links", () => {
      const out = renderMarkdown("[label](https://example.com)", {
        width: 80,
      });
      expect(out).toContain("label");
    });
  });

  describe("lists", () => {
    it("should render unordered list with bullets", () => {
      const out = renderMarkdown("- one\n- two\n- three", { width: 80 });
      expect(out).toContain("one");
      expect(out).toContain("two");
      expect(out).toContain("three");
    });

    it("should render ordered list with numbers", () => {
      const out = renderMarkdown("1. first\n2. second", { width: 80 });
      expect(out).toContain("first");
      expect(out).toContain("second");
    });
  });

  describe("code blocks", () => {
    it("should render fenced code block with border", () => {
      // Task #4994 (P4): the raw ``` fence text is concealed behind a
      // dim frame — the body text stays, the fence chars go.
      const out = renderMarkdown("```\nplain code\n```", { width: 80 });
      expect(out).toContain("plain code");
      expect(out).not.toContain("```");
      expect(out).toContain("╭");
    });

    it("should highlight javascript code block", () => {
      const out = renderMarkdown(
        "```javascript\nconst x = 42;\n```",
        { width: 80 }
      );
      expect(out).toContain("const");
      expect(out).toContain("x");
      expect(out).toMatch(/\x1b\[\d+m/);
    });

    it("should highlight python code block", () => {
      const out = renderMarkdown(
        "```python\ndef hello():\n    pass\n```",
        { width: 80 }
      );
      expect(out).toContain("def");
      expect(out).toContain("hello");
    });

    it("should fallback to dimmed text when language is not supported", () => {
      const out = renderMarkdown(
        "```notalanguage\nfoo bar\n```",
        { width: 80 }
      );
      expect(out).toContain("foo bar");
    });
  });

  describe("streaming safety", () => {
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

    it("should not crash on partial markdown (unclosed code fence)", () => {
      const out = renderMarkdown("```python\ndef foo", { width: 80 });
      expect(stripAnsi(out)).toContain("def foo");
    });

    it("should not crash on partial bold", () => {
      const out = renderMarkdown("**unclosed bold", { width: 80 });
      expect(stripAnsi(out)).toContain("unclosed bold");
    });

    it("should handle backticks in middle of text", () => {
      const out = renderMarkdown("use `code` here", { width: 80 });
      expect(stripAnsi(out)).toContain("code");
    });
  });

  describe("width handling", () => {
    it("should respect narrow width", () => {
      const longText =
        "This is a very long line that should wrap when given a narrow width";
      const out = renderMarkdown(longText, { width: 30 });
      const lines = out.split("\n");
      const firstLine = lines[0] ?? "";
      expect(firstLine.length).toBeLessThanOrEqual(30);
    });
  });

  describe("disabled mode (plain text)", () => {
    it("should pass through text when markdown disabled", () => {
      setMarkdownEnabled(false);
      try {
        const out = renderMarkdown("# Not a heading\n**not bold**", {
          width: 80,
        });
        expect(out).toContain("# Not a heading");
        expect(out).toContain("**not bold**");
      } finally {
        setMarkdownEnabled(true);
      }
    });
  });
});

describe("isMarkdownEnabled / setMarkdownEnabled", () => {
  it("should default to enabled", () => {
    setMarkdownEnabled(true);
    expect(isMarkdownEnabled()).toBe(true);
  });

  it("should toggle", () => {
    setMarkdownEnabled(false);
    expect(isMarkdownEnabled()).toBe(false);
    setMarkdownEnabled(true);
    expect(isMarkdownEnabled()).toBe(true);
  });
});

describe("truncateForTerminal", () => {
  it("should pass through short text", () => {
    const text = "short";
    expect(truncateForTerminal(text, 10)).toBe("short");
  });

  it("should truncate long text and append notice", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join(
      "\n"
    );
    const out = truncateForTerminal(text, 10);
    const lines = out.split("\n");
    expect(lines.length).toBeLessThanOrEqual(11);
    expect(out).toContain("more");
  });

  it("should not truncate when maxLines is 0", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join(
      "\n"
    );
    const out = truncateForTerminal(text, 0);
    expect(out).toBe(text);
  });

  it("should respect exact maxLines boundary", () => {
    const text = "a\nb\nc\nd\ne";
    const out = truncateForTerminal(text, 3);
    const lines = out.split("\n");
    expect(lines[0]).toBe("a");
    expect(lines[1]).toBe("b");
    expect(lines[2]).toBe("c");
    expect(out).toContain("more");
  });
});