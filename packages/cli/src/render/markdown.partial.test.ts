/**
 * @fileoverview Partial streaming markdown safety tests.
 *
 * Task #2657 Round 2 (T-C): verify renderMarkdown() handles partial / streaming
 * inputs gracefully. Streaming LLMs deliver tokens in chunks, so partial
 * markdown input (unclosed code fences, unclosed inline markers) is the
 * common case — renderMarkdown must not throw and must return SOMETHING.
 *
 * These tests verify the BEHAVIORAL contract; if a future change regresses
 * streaming safety, this test catches it before users see crashes.
 *
 * pi-inspired: pi-mono's markdown renderer explicitly handles partial input.
 */

import { describe, it, expect } from "bun:test";
import { renderMarkdown } from "./markdown.js";

describe("renderMarkdown partial / streaming input safety", () => {
  it("handles unclosed code fence without throwing", () => {
    // Typical streaming case: model is mid-code-block when chunk arrives.
    const partial = "Here is some code:\n\n```javascript\nconst x = ";
    expect(() => renderMarkdown(partial)).not.toThrow();
    const out = renderMarkdown(partial);
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("handles unclosed inline code marker without throwing", () => {
    // Streaming case: `foo is mid-token when chunk arrives.
    const partial = "Use the `console.";
    expect(() => renderMarkdown(partial)).not.toThrow();
    const out = renderMarkdown(partial);
    expect(typeof out).toBe("string");
  });

  it("handles partial heading without throwing", () => {
    // Streaming case: user just typed "# Ti" before more chars arrived.
    const partial = "# Ti";
    expect(() => renderMarkdown(partial)).not.toThrow();
    const out = renderMarkdown(partial);
    expect(out).toContain("Ti");
  });

  it("handles partial link without throwing", () => {
    // Streaming case: [text](http mid-URL.
    const partial = "Click [here](http://exa";
    expect(() => renderMarkdown(partial)).not.toThrow();
    const out = renderMarkdown(partial);
    expect(typeof out).toBe("string");
  });

  it("handles empty input gracefully", () => {
    const out = renderMarkdown("");
    expect(typeof out).toBe("string");
    // Empty input → empty output (or whitespace), never a crash
  });
});