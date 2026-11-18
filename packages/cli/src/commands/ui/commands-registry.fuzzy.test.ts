/**
 * @fileoverview Fuzzy matching tests for slash commands.
 *
 * Task #2657 Round 2 (T-B): verify fuzzyMatch + filterCommandsFuzzy
 * implement subsequence matching so users can type abbreviated or
 * scrambled queries (e.g. "mdl" → /model, "hlp" → /help).
 *
 * pi-inspired: pi-mono's command palette uses subsequence fuzzy matching
 * (chars appear in order, not necessarily contiguous).
 *
 * Tests:
 *   - fuzzyMatch: 6 cases (empty / exact / subsequence / out-of-order /
 *     no-match / case-insensitive)
 *   - filterCommandsFuzzy: 3 cases (full list / single match / no match)
 */

import { describe, it, expect } from "bun:test";
import {
  fuzzyMatch,
  filterCommandsFuzzy,
  filterCommands,
  COMMANDS,
} from "./commands-registry";

describe("fuzzyMatch (commands-registry)", () => {
  it("returns true when query is empty (matches everything)", () => {
    expect(fuzzyMatch("", "model")).toBe(true);
    expect(fuzzyMatch("", "")).toBe(true);
  });

  it("returns true when query equals target exactly", () => {
    expect(fuzzyMatch("model", "model")).toBe(true);
    expect(fuzzyMatch("help", "help")).toBe(true);
  });

  it("returns true when query is a subsequence of target", () => {
    // "mdl" — m, d, l appear in order in "model" (m...d...l)
    expect(fuzzyMatch("mdl", "model")).toBe(true);
    // "hlp" — h, l, p appear in order in "help" (h...l...p)
    expect(fuzzyMatch("hlp", "help")).toBe(true);
    // "atach" — a, t, a, c, h appear in order in "attach" (a...t...a...c...h)
    expect(fuzzyMatch("atach", "attach")).toBe(true);
  });

  it("returns false when query chars appear out of order in target", () => {
    // "ldm" — l, d, m order in "model" is m...o...d...e...l (m,d,l reversed)
    expect(fuzzyMatch("ldm", "model")).toBe(false);
  });

  it("returns false when query chars are not all in target", () => {
    // "xyz" — x not in "model"
    expect(fuzzyMatch("xyz", "model")).toBe(false);
  });

  it("is case-insensitive (query lower, target mixed)", () => {
    expect(fuzzyMatch("model", "Model")).toBe(true);
    expect(fuzzyMatch("MODEL", "model")).toBe(true);
    expect(fuzzyMatch("MdL", "model")).toBe(true);
  });
});

describe("filterCommandsFuzzy (commands-registry)", () => {
  it("returns all commands when query is empty", () => {
    const result = filterCommandsFuzzy("");
    expect(result.length).toBe(COMMANDS.length);
  });

  it("finds a single command via subsequence match", () => {
    // "mdl" should find /model (and maybe /model via startsWith too, but
    // /model is the unique hit)
    const result = filterCommandsFuzzy("mdl");
    const cmds = result.map((c) => c.cmd);
    expect(cmds).toContain("/model");
  });

  it("returns empty when query matches nothing", () => {
    const result = filterCommandsFuzzy("xyzzy");
    expect(result).toEqual([]);
  });
});

describe("filterCommands (existing) preserves backward compat", () => {
  it("still returns all on empty query", () => {
    expect(filterCommands("").length).toBe(COMMANDS.length);
  });

  it("still matches via substring (existing behavior)", () => {
    // Substring "mo" — should match /model (startsWith + includes)
    const cmds = filterCommands("mo").map((c) => c.cmd);
    expect(cmds).toContain("/model");
  });
});