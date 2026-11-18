/**
 * @fileoverview Tests for the P4 message-visual renderer upgrade
 * (Task #4994, P4 of the opencode-alignment plan
 * docs/task-4954-interactive-tui-opencode-alignment-plan.md §P4).
 *
 * Covers the three `render/markdown.ts` changes:
 *   1. headings drop the `#` prefix (colour + bold instead) —
 *      the "## 核心能力" bare-hash complaint;
 *   2. tables render a grid frame with CJK-aware column widths
 *      (the 中文列对不齐 complaint);
 *   3. code blocks render a dim frame without the raw ``` fence.
 *
 * Pure string API — no Ink / no opentui here (same as markdown.test.ts).
 */

import { describe, it, expect } from "bun:test";
import { renderMarkdown, setMarkdownEnabled } from "./markdown.js";

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("P4 headings: drop the # prefix", () => {
  it("h2 renders the text WITHOUT a leading # prefix", () => {
    const out = stripAnsi(renderMarkdown("## 核心能力\n", { width: 80 }));
    expect(out).toContain("核心能力");
    expect(out).not.toContain("# 核心能力");
    expect(out).not.toContain("##");
  });

  it("h1 renders without the # prefix", () => {
    const out = stripAnsi(renderMarkdown("# Title\n", { width: 80 }));
    expect(out).toContain("Title");
    expect(out).not.toContain("# Title");
  });

  it("h3+ renders without the # prefix", () => {
    const out = stripAnsi(renderMarkdown("### Sub\n", { width: 80 }));
    expect(out).toContain("Sub");
    expect(out).not.toContain("#");
  });

  it("heading is still BOLD", () => {
    const out = renderMarkdown("## 核心能力\n", { width: 80 });
    expect(out).toMatch(/\x1b\[1m/);
  });

  it("heading is also coloured (primary, not plain white)", () => {
    // The heading text sits inside a non-reset colour sequence:
    // `\x1b[36m...\x1b[1m核心能力` — i.e. a colour SGR appears BEFORE
    // the bold-wrapped text, not just `\x1b[1m` alone (which plain
    // white bold would emit).
    const out = renderMarkdown("## 核心能力\n", { width: 80 });
    const beforeBold = out.indexOf("\x1b[1m");
    expect(beforeBold).toBeGreaterThan(0);
    expect(out.slice(0, beforeBold)).toMatch(/\x1b\[\d+m$/);
  });

  it("plain-text passthrough (markdown disabled) keeps the raw source", () => {
    setMarkdownEnabled(false);
    try {
      const out = renderMarkdown("## 核心能力\n", { width: 80 });
      expect(out).toContain("## 核心能力");
    } finally {
      setMarkdownEnabled(true);
    }
  });
});

describe("P4 tables: grid frame + CJK-aware widths", () => {
  const SRC =
    "| 函数名 | 用途 |\n|---|---|\n| renderMarkdown | 渲染 |\n| visibleLength | 测宽 |\n";

  it("no bare | column separators in the rendered output", () => {
    const out = stripAnsi(renderMarkdown(SRC, { width: 80 }));
    // The old renderer joined cells with " | " — that literal is gone.
    expect(out).not.toContain("|");
  });

  it("CJK cells do not misalign columns (双宽按 2 格计)", () => {
    // Grid rows all have the same VISUAL column span (cell width, not
    // UTF-16 length — CJK glyphs occupy 2 columns). Measured:
    // "函数名" row = 20 UTF-16 units but 19 cells; frame rows = 25
    // units = 23 cells. With the old .length() padEnd the header row
    // lost one cell per CJK cell and drifted 2 columns left.
    const out = stripAnsi(renderMarkdown(SRC, { width: 80 }));
    const bun = (globalThis as { Bun?: { stringWidth?: (s: string) => number } }).Bun;
    const cellWidth = (s: string) =>
      bun?.stringWidth ? bun.stringWidth(s) : s.length;
    const spans = out.split("\n").filter((l) => l.includes("│"));
    const cellWidths = new Set(spans.map((l) => cellWidth(l)));
    expect(cellWidths.size).toBe(1);
    // header col1 ("函数名" = 6 cells) is padded to 14 cells.
    const headerRow = spans.find((l) => l.includes("函数名"))!;
    expect(cellWidth(headerRow)).toBe(cellWidth(spans[0]!));
  });

  it("renders a grid frame (│ borders + ─ divider rows)", () => {
    const out = stripAnsi(renderMarkdown(SRC, { width: 80 }));
    expect(out).toContain("│");
    expect(out).toContain("─");
    // header separator row is the full-width grid line
    expect(out).toMatch(/─+┼─+/);
  });

  it("header row is bold", () => {
    const out = renderMarkdown(SRC, { width: 80 });
    expect(out).toMatch(/\x1b\[1m/);
  });

  it("does not crash on empty cells and keeps column count", () => {
    const out = stripAnsi(
      renderMarkdown("| a | b |\n|---|---|\n| x |  |\n", { width: 80 }),
    );
    expect(out).toContain("x");
  });
});

describe("P4 code blocks: dim frame, no raw ``` fence", () => {
  it("unlanguaged block renders without the ``` fence text", () => {
    const out = stripAnsi(renderMarkdown("```\nconst x = 1;\nconst y = 2;\n```\n", { width: 80 }));
    expect(out).toContain("const x = 1;");
    expect(out).not.toContain("```");
  });

  it("languaged block keeps a language tag but not the fence", () => {
    const out = stripAnsi(renderMarkdown("```js\nconst x = 42;\n```\n", { width: 80 }));
    expect(out).toContain("const x = 42;");
    expect(out).toContain("js");
    expect(out).not.toContain("```");
  });

  it("block body is dimmed", () => {
    const out = renderMarkdown("```\nplain body\n```\n", { width: 80 });
    expect(out).toMatch(/\x1b\[2m[\s\S]*plain body/);
  });
});
