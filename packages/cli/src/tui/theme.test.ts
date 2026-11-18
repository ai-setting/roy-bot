/**
 * @fileoverview Tests for theme.ts (NO_COLOR / capability detection).
 *
 * Task #2657 Round 2: theme system test. The theme module:
 *   - Returns default colors when env is normal
 *   - Returns noColor theme when NO_COLOR env is set
 *   - Returns colors when COLORTERM=truecolor is set
 *   - Accepts an env override for testing
 *   - Returns the same shape regardless of mode
 *
 * RED tests written first; GREEN implementation lives in theme.ts.
 */

import { describe, it, expect } from "bun:test";
import { getTheme, type TuiTheme } from "./theme.js";

describe("getTheme (theme.ts)", () => {
  it("returns a default theme when env is empty", () => {
    const env: NodeJS.ProcessEnv = {};
    const theme = getTheme(env);
    expect(theme).toBeDefined();
    expect(theme.mode).toBe("default");
    expect(theme.primary).toBeDefined();
    expect(theme.accent).toBeDefined();
    expect(theme.muted).toBeDefined();
  });

  it("returns noColor theme when NO_COLOR env is set", () => {
    const env: NodeJS.ProcessEnv = { NO_COLOR: "1" };
    const theme = getTheme(env);
    expect(theme.mode).toBe("noColor");
    // In noColor mode, every color should still exist but be safe (no ANSI)
    expect(theme.primary).toBe("");
    expect(theme.accent).toBe("");
    expect(theme.muted).toBe("");
  });

  it("returns default theme when NO_COLOR is empty string", () => {
    const env: NodeJS.ProcessEnv = { NO_COLOR: "" };
    const theme = getTheme(env);
    expect(theme.mode).toBe("default");
  });

  it("respects COLORTERM=truecolor (returns default theme)", () => {
    const env: NodeJS.ProcessEnv = { COLORTERM: "truecolor" };
    const theme = getTheme(env);
    expect(theme.mode).toBe("default");
    expect(theme.primary).toBeDefined();
  });

  it("returns the same shape regardless of mode (theme interface stable)", () => {
    const themes: TuiTheme[] = [
      getTheme({}),
      getTheme({ NO_COLOR: "1" }),
      getTheme({ COLORTERM: "truecolor" }),
    ];
    const keys0 = Object.keys(themes[0]!).sort();
    for (const t of themes) {
      expect(Object.keys(t).sort()).toEqual(keys0);
    }
  });
});