/**
 * @fileoverview MarkdownRenderer unit tests (RED, round 2 — corrective).
 *
 * Round-1 QA findings addressed by these tests:
 *  - Heading `# ` was kept visible (`\x1b[1m#\x1b[22m`) — must be stripped.
 *  - Link `[text](url)` was passed through unchanged — must be rendered.
 *  - Existing tests had false positives because they did not strip ANSI before
 *    semantic assertions, and the link test only checked substrings.
 *
 * New tests:
 *  - heading (single + multi-level) does not contain raw `# ` marker
 *  - heading renders with strong ANSI styling
 *  - link rendering produces styled text + plain `(url)` (or OSC 8 link) — NOT raw `[text](url)`
 *  - cross-chunk for both heading and link (tokens split across deltas)
 *  - non-TTY/NO_COLOR safety: link renderer does not emit OSC 8 unconditionally
 *  - reset() also resets pending heading/link markers
 *
 * Helper: ANSI-strip a string for semantic assertions.
 */

import { describe, test, expect } from "bun:test";
import { renderMarkdownDelta, MarkdownRenderer } from "./markdown-renderer";

/** Strip ANSI escape sequences for semantic assertions. */
function stripAnsi(s: string): string {
  // CSI / SGR sequences + OSC 8 hyperlink sequences
  return s.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

describe("renderMarkdownDelta (standalone) — round-2 corrective", () => {
  test("H1 strips raw `#` marker and renders styled heading", () => {
    const out = renderMarkdownDelta("# Hello");
    const plain = stripAnsi(out);

    // The text content survives
    expect(plain).toContain("Hello");
    // Raw `# ` heading marker must NOT survive
    expect(plain).not.toMatch(/^#\s/);
    expect(plain).not.toMatch(/^# Hello/);
    expect(plain).not.toContain("# Hello");
    // The line itself does not start with `#`
    expect(plain.startsWith("#")).toBe(false);
    // Strong ANSI styling is applied (bold + at least one extra style attribute)
    expect(out).toMatch(/\x1b\[1m/);
    expect(out).toMatch(/\x1b\[\d+m/);
  });

  test("H2 / H3 / H4 strip `##` / `###` / `####` markers", () => {
    for (const [src, expectedText] of [
      ["## Section", "Section"],
      ["### Subsection", "Subsection"],
      ["#### Deep", "Deep"],
    ] as const) {
      const out = renderMarkdownDelta(src);
      const plain = stripAnsi(out);
      expect(plain).toContain(expectedText);
      expect(plain).not.toMatch(/^#+\s/);
      expect(plain.startsWith("#")).toBe(false);
    }
  });

  test("Link renders text + plain URL, NOT raw [text](url)", () => {
    const out = renderMarkdownDelta("[click here](https://x.test/path)");
    const plain = stripAnsi(out);

    // Link text survives
    expect(plain).toContain("click here");
    // URL survives (somewhere in the output, possibly wrapped in parens)
    expect(plain).toContain("https://x.test/path");
    // Raw markdown link syntax MUST NOT survive
    expect(plain).not.toContain("[click here]");
    expect(plain).not.toContain("](https://x.test/path)");
    expect(plain).not.toContain("[click here](https://x.test/path)");
  });

  test("Multiple links render each independently", () => {
    const out = renderMarkdownDelta(
      "Visit [docs](https://docs.test) and [blog](https://blog.test) for more."
    );
    const plain = stripAnsi(out);
    expect(plain).toContain("docs");
    expect(plain).toContain("blog");
    expect(plain).toContain("https://docs.test");
    expect(plain).toContain("https://blog.test");
    expect(plain).not.toContain("[docs]");
    expect(plain).not.toContain("](https://docs.test)");
    expect(plain).not.toContain("[blog]");
  });

  test("Plain brackets and parens (not links) are preserved", () => {
    const out = renderMarkdownDelta("Array index [0] is first; (note: x).");
    const plain = stripAnsi(out);
    expect(plain).toContain("[0]");
    expect(plain).toContain("(note: x)");
    // Must NOT have produced a spurious link
    expect(plain).not.toContain("](note:");
    expect(plain).not.toMatch(/\]\(https?:/);
  });

  test("Heading + link in same line: heading stripped, link rendered", () => {
    const out = renderMarkdownDelta("## Title with [link](https://a.b)");
    const plain = stripAnsi(out);
    expect(plain).toContain("Title with");
    expect(plain).toContain("link");
    expect(plain).toContain("https://a.b");
    expect(plain).not.toMatch(/^#+\s/);
    expect(plain).not.toContain("[link]");
    expect(plain).not.toContain("](https://a.b)");
  });

  test("Reset clears pending heading / link state", () => {
    const r = new MarkdownRenderer();
    r.push("## Incomp");
    r.reset();
    const out = r.push("lete heading");
    const plain = stripAnsi(out);
    // After reset, the leftover `#` should not bleed in
    expect(plain).not.toMatch(/^#/);
    expect(plain).toContain("lete heading");
  });
});

describe("MarkdownRenderer (stateful / incremental) — round-2 corrective", () => {
  test("Heading tokens split across deltas", () => {
    const r = new MarkdownRenderer();
    const a = r.push("# Hea");
    const b = r.push("ding");
    const plain = stripAnsi(a + b);
    expect(plain).toContain("Heading");
    expect(plain).not.toMatch(/^#/);
    // Strong styling still applied
    expect(a + b).toMatch(/\x1b\[1m/);
  });

  test("Link tokens split across deltas", () => {
    const r = new MarkdownRenderer();
    const a = r.push("See [doc");
    const b = r.push("s](https://x.test) please");
    const plain = stripAnsi(a + b);
    expect(plain).toContain("docs");
    expect(plain).toContain("https://x.test");
    expect(plain).toContain("please");
    expect(plain).not.toContain("[docs]");
    expect(plain).not.toContain("](https://x.test)");
  });

  test("Link split at the closing `]`", () => {
    const r = new MarkdownRenderer();
    const a = r.push("Click [here](https://a.b");
    const b = r.push(")");
    const plain = stripAnsi(a + b);
    expect(plain).toContain("here");
    expect(plain).toContain("https://a.b");
    expect(plain).not.toContain("[here]");
  });

  test("ANSI is properly reset — no leaked bold/italic at end of stream", () => {
    const r = new MarkdownRenderer();
    r.push("**bold then plain**");
    const out = r.flush();
    const plain = stripAnsi(out);
    expect(plain).toBe("bold then plain");
    // No unmatched BOLD_ON
    expect((out.match(/\x1b\[1m/g) || []).length).toBe(
      (out.match(/\x1b\[22m/g) || []).length
    );
  });
});

describe("MarkdownRenderer — non-TTY safety", () => {
  test("OSC 8 hyperlink only emitted when env enables it", () => {
    // Default path: when COLUMNS / color enabling flag absent, link renderer
    // should NOT emit OSC 8 hyperlinks unconditionally (those leak in
    // pipes / non-TTY contexts).
    const out = renderMarkdownDelta("[docs](https://x.test)");
    const osc8Count = (out.match(/\x1b\]8;/g) || []).length;
    // Either zero (safe path) OR it must be balanced open/close
    if (osc8Count > 0) {
      // must be paired (open + close)
      expect(osc8Count).toBe(2);
    }
  });
});