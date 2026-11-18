/**
 * @fileoverview Tests for progressive scrollback commit (Task #4103).
 *
 * These are the tests the original "jump" fix lacked: they verify that
 * exactly the stable markdown blocks are released to the transcript and the
 * volatile tail is held back.
 */

import { describe, it, expect } from "bun:test";
import { splitStable } from "./scrollback.js";

describe("splitStable (Task #4103 scrollback commit)", () => {
  it("returns everything stable on force (stream finished)", () => {
    expect(splitStable("a\n\nb", { force: true })).toEqual({
      stable: "a\n\nb",
      tail: "",
    });
  });

  it("empty input yields nothing stable", () => {
    expect(splitStable("")).toEqual({ stable: "", tail: "" });
  });

  it("holds back the whole buffer while no blank line has been seen", () => {
    expect(splitStable("just one paragraph")).toEqual({
      stable: "",
      tail: "just one paragraph",
    });
  });

  it("commits up to (and including) the last blank-line boundary", () => {
    expect(splitStable("para1\n\npara2")).toEqual({
      stable: "para1\n\n",
      tail: "para2",
    });
  });

  it("commits multiple stable blocks, keeping only the trailing tail", () => {
    const { stable, tail } = splitStable("a\n\nb\n\nc");
    expect(stable).toBe("a\n\nb\n\n");
    expect(tail).toBe("c");
  });

  it("does NOT treat a blank line inside a code fence as a boundary", () => {
    const text = "```js\nconst a = 1;\n\nconst b = 2;\n```\n\nafter";
    const { stable, tail } = splitStable(text);
    expect(stable).toBe("```js\nconst a = 1;\n\nconst b = 2;\n```\n\n");
    expect(tail).toBe("after");
  });

  it("keeps an unclosed code fence entirely volatile", () => {
    const text = "intro\n\n```js\nconst a = 1;\n\nconst b = 2;";
    const { stable, tail } = splitStable(text);
    // The blank line after "intro" is outside the fence, so "intro\n\n" is
    // stable; the open fence + everything after stays volatile.
    expect(stable).toBe("intro\n\n");
    expect(tail).toBe("```js\nconst a = 1;\n\nconst b = 2;");
  });

  it("safety valve commits all but the last line for a long paragraph", () => {
    const { stable, tail } = splitStable("l1\nl2\nl3\nl4", { maxTailLines: 2 });
    expect(stable).toBe("l1\nl2\nl3\n");
    expect(tail).toBe("l4");
  });

  it("safety valve is skipped inside an open fence", () => {
    const text = "```\nl1\nl2\nl3\nl4";
    expect(splitStable(text, { maxTailLines: 2 })).toEqual({
      stable: "",
      tail: text,
    });
  });

  it("commits a trailing blank line (so the next chunk starts clean)", () => {
    expect(splitStable("done\n\n")).toEqual({ stable: "done\n\n", tail: "" });
  });
});
