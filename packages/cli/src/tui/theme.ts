/**
 * @fileoverview tuiTheme — theme + terminal capability detection.
 *
 * Task #2657 Round 2: add a small theme module so the Ink components
 * (Spinner / StatusBar / App) can route colors through one place.
 *
 * Design:
 *   - getTheme(env) returns a TuiTheme with stable shape regardless of mode
 *   - default mode: cyan primary / yellow accent / dim / noColor / status colors
 *   - noColor mode: every color field is empty string (Ink <Text color=""> renders plain)
 *   - Detected via env.NO_COLOR (any truthy value) and env.TERM
 *
 * Defaults chosen to match the existing hardcoded colors:
 *   - primary: "cyan" (used by Spinner / App header / Markdown code)
 *   - accent:  "yellow" (used by StatusBar tokenCount)
 *   - dim:     undefined (Ink uses dimColor prop; theme.dim stays as boolean guidance)
 *
 * The module exports `getTheme(env?)` (env defaults to process.env) and
 * a `TuiTheme` interface so consumers can narrow the return type.
 *
 * pi-inspired: pi-mono packages/tui uses a similar "capability probe"
 * pattern (term-support / truecolor / noColor fallback).
 */

// Note: tracing is intentionally NOT added to this module because importing
// `@ai-setting/roy-bot-core` from tui/theme.ts pulls in BaseEnvironment
// (which has @TracedAs decorators that Bun's transformer mishandles in this
// context). getTheme() is a synchronous env-only probe that adds no
// observability value beyond what task-level spans already provide. If
// trace integration becomes important later, wrap the call site (not the
// theme module) with `wrapFunction`.

/**
 * Stable theme shape — same fields whether in default or noColor mode.
 *
 * Every field is a string color name accepted by Ink <Text color="...">
 * or "" (empty) for noColor mode. We intentionally do NOT include ANSI
 * escape codes here — those go through Ink's color prop pipeline.
 */
export interface TuiTheme {
  /** Mode identifier — useful for callers that want to branch on capability. */
  mode: "default" | "noColor";
  /** Primary brand color (Spinner glyph, header banner). */
  primary: string;
  /** Accent / highlight color (token counts, important callouts). */
  accent: string;
  /** Success / idle status color (status bar ● ready). */
  success: string;
  /** Warning / soft status color (executing, compact, shutdown). */
  warning: string;
  /** Error status color (errors, ❌ markers). */
  error: string;
  /** Muted / secondary text (footer hints, dim labels). */
  muted: string;
  /** User-role label color (👤 You). */
  user: string;
  /** Assistant-role label color (🤖 Agent). */
  assistant: string;
  /** Tool-role label color (🔧 Tool). */
  tool: string;
  /**
   * Task #4994 (P4): raised panel background for the **user
   * message block** (opencode UserMessage uses
   * `theme.background.raised.base`). Empty string = no panel
   * (NO_COLOR / plain terminal) — consumers must map `""` to
   * `undefined` via the `fg()`-style adapter before handing it to
   * opentui.
   */
  backgroundPanel: string;
  /**
   * Task #4994 (P4): left-rail border color for the user block
   * (opencode colors it with the agent hue; we reuse `user`).
   */
  borderUser: string;
}

const DEFAULT_THEME: TuiTheme = {
  mode: "default",
  primary: "cyan",
  accent: "yellow",
  success: "cyan",
  warning: "yellow",
  error: "red",
  muted: "gray",
  user: "green",
  assistant: "cyan",
  tool: "yellow",
  // Task #4994 (P4): user-block raised panel + rail. Both are
  // 256-colour-safe greys — `#262626` matches opencode's
  // dark `background.raised.base` family and stays readable on
  // both black and light terminal backgrounds.
  backgroundPanel: "#262626",
  borderUser: "green",
};

const NO_COLOR_THEME: TuiTheme = {
  mode: "noColor",
  primary: "",
  accent: "",
  success: "",
  warning: "",
  error: "",
  muted: "",
  user: "",
  assistant: "",
  tool: "",
  backgroundPanel: "",
  borderUser: "",
};

/**
 * Determine whether the current environment should suppress colors.
 *
 * Rules (industry standard NO_COLOR spec + common conventions):
 *   - NO_COLOR set to a truthy value (non-empty, "1", "true") → noColor
 *   - TERM=dumb → noColor (dumb terminals don't render ANSI)
 *   - Otherwise → default (colors OK)
 *
 * Note: cli-highlight and chalk already honor NO_COLOR upstream; this
 * module mirrors the same rules so the tui/ layer matches.
 */
function shouldSuppressColors(env: NodeJS.ProcessEnv): boolean {
  if (env.NO_COLOR && env.NO_COLOR !== "0" && env.NO_COLOR !== "false") {
    return true;
  }
  if (env.TERM === "dumb") {
    return true;
  }
  return false;
}

/**
 * Resolve the active TUI theme based on environment.
 *
 * @param env - environment variables to inspect (defaults to process.env)
 * @returns TuiTheme with stable shape (same fields in every mode)
 */
/**
 * Resolve the active TUI theme based on environment.
 *
 * @param env - environment variables to inspect (defaults to process.env)
 * @returns TuiTheme with stable shape (same fields in every mode)
 */
export function getTheme(env: NodeJS.ProcessEnv = process.env): TuiTheme {
  if (shouldSuppressColors(env)) {
    return NO_COLOR_THEME;
  }
  return DEFAULT_THEME;
}

// Re-export TuiTheme type for callers
export type { TuiTheme as TuiThemeType };

// Default export for ergonomic imports
export default getTheme;