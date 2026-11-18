/**
 * @fileoverview Task #4954 P2 — paste channel pure-function tests (RED first).
 *
 * The paste pipeline has three stages, all pure:
 *
 *   1. normalize   — raw paste bytes → UI text (strip ANSI, CRLF→LF)
 *   2. fold policy — decide whether the paste is "big" (opencode:
 *                    ≥3 lines OR >150 chars ⇒ `[Pasted ~N lines]`)
 *   3. expand      — submitted text with placeholders → real message
 *
 * The acceptance source is opencode `packages/tui/src/component/prompt/
 * index.tsx` (1448-1478) + `packages/tui/src/prompt/part.ts`
 * (expandPastedTextPlaceholders), vendored analysis of the v2.2.5 tag.
 */

import { describe, it, expect } from "bun:test";
import {
  normalizePaste,
  shouldFoldPaste,
  foldedPlaceholder,
  expandPastedPlaceholders,
} from "./paste.js";

describe("normalizePaste", () => {
  it("passes plain text through", () => {
    expect(normalizePaste("hello world")).toBe("hello world");
  });

  it("converts CRLF to LF", () => {
    expect(normalizePaste("a\r\nb")).toBe("a\nb");
  });

  it("converts lone CR to LF (Windows ConPTY bracketed paste)", () => {
    expect(normalizePaste("a\rb")).toBe("a\nb");
  });

  it("strips ANSI escape sequences (SGR, cursor, links)", () => {
    expect(normalizePaste("\x1b[31mred\x1b[0m")).toBe("red");
    expect(normalizePaste("\x1b[2J\x1b[Hx")).toBe("x");
  });
});

describe("shouldFoldPaste (opencode policy: ≥3 lines OR >150 chars)", () => {
  it("short single-line paste does NOT fold", () => {
    expect(shouldFoldPaste("short paste")).toBe(false);
  });

  it("exactly 2 lines does NOT fold", () => {
    expect(shouldFoldPaste("a\nb")).toBe(false);
  });

  it("3 lines folds", () => {
    expect(shouldFoldPaste("a\nb\nc")).toBe(true);
  });

  it("single line >150 chars folds", () => {
    expect(shouldFoldPaste("x".repeat(151))).toBe(true);
  });

  it("exactly 150 chars does NOT fold", () => {
    expect(shouldFoldPaste("x".repeat(150))).toBe(false);
  });
});

describe("foldedPlaceholder", () => {
  it("counts LF-separated lines", () => {
    expect(foldedPlaceholder("a\nb\nc")).toBe("[Pasted ~3 lines]");
  });

  it("a 10-line paste says ~10 lines", () => {
    const text = Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n");
    expect(foldedPlaceholder(text)).toBe("[Pasted ~10 lines]");
  });

  it("single-line long paste says ~1 line", () => {
    expect(foldedPlaceholder("x".repeat(200))).toBe("[Pasted ~1 lines]");
  });
});

describe("expandPastedPlaceholders", () => {
  it("returns text unchanged when no pasted parts", () => {
    expect(expandPastedPlaceholders("plain text", [])).toBe("plain text");
  });

  it("expands a single placeholder to its real content", () => {
    const submitted = `look: [Pasted ~3 lines] done`;
    const result = expandPastedPlaceholders(submitted, [
      { text: "alpha\nbeta\ngamma", placeholder: "[Pasted ~3 lines]" },
    ]);
    expect(result).toBe("look: alpha\nbeta\ngamma done");
  });

  it("expands multiple placeholders left-to-right", () => {
    const submitted = "[Pasted ~2 lines] and [Pasted ~2 lines]";
    const result = expandPastedPlaceholders(submitted, [
      { text: "ONE\none", placeholder: "[Pasted ~2 lines]" },
      { text: "TWO\ntwo", placeholder: "[Pasted ~2 lines]" },
    ]);
    expect(result).toBe("ONE\none and TWO\ntwo");
  });

  it("expands leftmost-first when two pastes share the same placeholder text", () => {
    const submitted = "[Pasted ~1 lines] [Pasted ~1 lines]";
    const result = expandPastedPlaceholders(submitted, [
      { text: "A", placeholder: "[Pasted ~1 lines]" },
      { text: "B", placeholder: "[Pasted ~1 lines]" },
    ]);
    expect(result).toBe("A B");
  });

  it("leaves text intact when placeholder was edited away (stale part)", () => {
    const submitted = "user removed the paste";
    const result = expandPastedPlaceholders(submitted, [
      { text: "gone", placeholder: "[Pasted ~1 lines]" },
    ]);
    expect(result).toBe("user removed the paste");
  });
});
