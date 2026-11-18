/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview style.ts — Ink → opentui style adapters (Task #4278 片2).
 *
 * Three measured Ink/opentui differences are normalised here so the component
 * files stay declarative:
 *
 * 1. **Colour sentinel (`""`)** — Ink renders `<Text color="">` as plain text
 *    (this is what `theme.ts` emits in NO_COLOR / `TERM=dumb` mode). opentui's
 *    `parseColor("")` logs *"Invalid hex color: , defaulting to magenta"* and
 *    paints magenta. `fg()` maps `"" → undefined` so the default foreground wins.
 *
 * 2. **ANSI escapes are NOT parsed by `<text content>`** — Ink's `<Text>`
 *    interprets nested SGR sequences; opentui renders them as literal `[1m`
 *    text. `ansiToSpans()` converts an SGR-styled string into a list of
 *    `{ text, style }` runs that are rendered as `<span style={...}>`.
 *
 * 3. **Attribute flags** — Ink uses boolean props (`bold` / `dimColor` /
 *    `italic` / `underline` / `inverse`); opentui uses a bitmask
 *    (`TextAttributes.*`). `attrsFromFlags()` does the mapping.
 *
 * Only SGR (CSI `m`) sequences are handled — that is the entire surface emitted
 * by `render/markdown.ts`. Non-SGR escapes are stripped so they can never leak
 * into a frame as literal text.
 */

import { TextAttributes } from "@opentui/core";

/** Ink boolean style props → opentui attribute bitmask. */
export interface StyleFlags {
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strikethrough?: boolean;
}

export function attrsFromFlags(flags: StyleFlags): number {
  let attrs = 0;
  if (flags.bold) attrs |= TextAttributes.BOLD;
  if (flags.dim) attrs |= TextAttributes.DIM;
  if (flags.italic) attrs |= TextAttributes.ITALIC;
  if (flags.underline) attrs |= TextAttributes.UNDERLINE;
  if (flags.inverse) attrs |= TextAttributes.INVERSE;
  if (flags.strikethrough) attrs |= TextAttributes.STRIKETHROUGH;
  return attrs;
}

/**
 * Ink-style colour (which may be `""` in NO_COLOR mode) → opentui-ready value.
 *   - `""` / undefined  → undefined (inherit default fg; never magenta)
 *   - named / hex       → passthrough (opentui accepts both)
 */
export function fg(color: string | undefined): string | undefined {
  if (!color) return undefined;
  if (color === "none" || color === "transparent") return undefined;
  return color;
}

/** Re-export the Ink→opentui colour adapter under one namespace. */
export const color = { fg };

// ---------------------------------------------------------------------------
// ANSI (SGR) → span runs
// ---------------------------------------------------------------------------

/** A styled run of text; `style` is directly spreadable into a `<span style>`. */
export interface StyledRun {
  text: string;
  style: {
    fg?: string;
    bg?: string;
    /**
     * Task #4994 (P4): opentui's span style → attributes pipeline
     * (`createTextAttributes`) consumes **boolean flags**, not a
     * numeric bitmask — a numeric `attributes` is silently dropped
     * (measured: probe span `attributes: 1` renders attr=0). Keep
     * the flags the reconciler understands.
     */
    bold?: boolean;
    dim?: boolean;
    italic?: boolean;
    underline?: boolean;
    strikethrough?: boolean;
    inverse?: boolean;
  };
}

/** SGR code → basic ANSI colour name (0-7) and bright variant (8-15). */
const SGR_BASE_FG = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;
const SGR_BASE_BG = [
  "bgBlack",
  "bgRed",
  "bgGreen",
  "bgYellow",
  "bgBlue",
  "bgMagenta",
  "bgCyan",
  "bgWhite",
] as const;

/**
 * opentui's palette for the 16 basic colours. opentui accepts named colours
 * (e.g. `"red"`) and CSS hex; we map SGR 30-37/90-97 to hex so the output is
 * identical across terminals and never depends on the host 256-colour palette
 * (which is what Ink effectively does too, via ansi-styles).
 */
const FG_HEX = [
  "#000000",
  "#cd0000",
  "#00cd00",
  "#cdcd00",
  "#0000ee",
  "#cd00cd",
  "#00cdcd",
  "#e5e5e5",
] as const;
const FG_HEX_BRIGHT = [
  "#7f7f7f",
  "#ff0000",
  "#00ff00",
  "#ffff00",
  "#5c5cff",
  "#ff00ff",
  "#00ffff",
  "#ffffff",
] as const;
const BG_HEX = FG_HEX;
const BG_HEX_BRIGHT = FG_HEX_BRIGHT;

/** Matches CSI sequences (SGR and non-SGR alike). */
// eslint-disable-next-line no-control-regex
const CSI_RE = /\u001b\[([0-9;?]*)([ -/]*)([@-~])/g;
/** Matches OSC / DCS / APC / PM string sequences (never valid inside text). */
// eslint-disable-next-line no-control-regex
const STRING_ESC_RE = /\u001b(P|_|\^|\]|X)[^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

function codeToStyle(
  code: number,
  base: Partial<StyledRun["style"]>,
  /** Baseline colours (the caller's `baseStyle`) — SGR 0/39/49 fall back to these. */
  baseline: Partial<StyledRun["style"]> = {},
): Partial<StyledRun["style"]> {
  // Task #4994 (P4 measured fix): opentui's span style handler
  // (`setProperty` → `createTextAttributes({bold,...})`) consumes
  // BOOLEAN flags — a numeric `attributes` bitmask is silently
  // dropped (probe span with `attributes: 1` rendered attr=0).
  // So every SGR attribute maps to a boolean field here.
  // Reset + attribute on/off
  if (code === 0) {
    // Task #5086 P5 (DS r2 MAJOR-1 fix): SGR 0 resets ATTRIBUTES **and
    // colours**. The colour must fall back to the caller's base
    // (Markdown.tsx feeds fg: theme.text as the token baseline) —
    // NOT to the terminal default (undefined) and NOT to the colour
    // that was active before the reset.
    //
    // `base` here is the **base style** (see ansiToRuns), so this
    // returns the baseline colours with all attribute flags cleared.
    return {
      fg: baseline.fg,
      bg: baseline.bg,
      bold: false,
      dim: false,
      italic: false,
      underline: false,
      inverse: false,
      strikethrough: false,
    };
  }
  if (code === 1) return { ...base, bold: true };
  if (code === 2) return { ...base, dim: true };
  if (code === 3) return { ...base, italic: true };
  if (code === 4) return { ...base, underline: true };
  if (code === 7) return { ...base, inverse: true };
  if (code === 9) return { ...base, strikethrough: true };
  if (code === 22) return { ...base, bold: false, dim: false };
  if (code === 23) return { ...base, italic: false };
  if (code === 24) return { ...base, underline: false };
  if (code === 27) return { ...base, inverse: false };
  if (code === 29) return { ...base, strikethrough: false };
  // Foregrounds
  if (code >= 30 && code <= 37) return { ...base, fg: FG_HEX[code - 30] };
  // Task #5086 P5 (DS r3 MINOR-1): SGR 39 ("default foreground") must
  // fall back to the **base** colour (theme.text) like SGR 0 does —
  // returning undefined would drop back to the terminal default
  // (near-white) and break light mode.
  if (code === 39) return { ...base, fg: baseline.fg };
  if (code >= 90 && code <= 97) return { ...base, fg: FG_HEX_BRIGHT[code - 90] };
  // Backgrounds
  if (code >= 40 && code <= 47) return { ...base, bg: BG_HEX[code - 40] };
  // Same as SGR 39 for the background.
  if (code === 49) return { ...base, bg: baseline.bg };
  if (code >= 100 && code <= 107) return { ...base, bg: BG_HEX_BRIGHT[code - 100] };
  // 38;5;n / 48;5;n / 38;2;r;g;b — handled by the caller (needs lookahead)
  return { ...base };
}

function xterm256ToHex(n: number): string {
  if (n < 16) return (n < 8 ? FG_HEX : FG_HEX_BRIGHT)[n % 8]!;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `#${v.toString(16).padStart(2, "0").repeat(3)}`;
  }
  const c = n - 16;
  const r = Math.floor(c / 36);
  const g = Math.floor((c % 36) / 6);
  const b = c % 6;
  const ch = (x: number) => (x === 0 ? 0 : 55 + x * 40).toString(16).padStart(2, "0");
  return `#${ch(r)}${ch(g)}${ch(b)}`;
}

/**
 * Convert an SGR-styled string into styled runs.
 *
 * Unknown / unsupported codes are ignored (never emitted as text). Plain text
 * between escapes becomes an unstyled run (or keeps the inherited style if the
 * caller passes `baseStyle`).
 */
export function ansiToRuns(input: string, baseStyle: StyledRun["style"] = {}): StyledRun[] {
  if (!input) return [];

  // Drop OSC/DCS/APC/PM payloads entirely — they must never render.
  let text = input.replace(STRING_ESC_RE, "");

  const runs: StyledRun[] = [];
  let current: StyledRun["style"] = { ...baseStyle };
  let cursor = 0;
  const push = (slice: string) => {
    if (!slice) return;
    const hasStyle =
      current.fg !== undefined ||
      current.bg !== undefined ||
      current.bold === true ||
      current.dim === true ||
      current.italic === true ||
      current.underline === true ||
      current.inverse === true ||
      current.strikethrough === true;
    if (!hasStyle) {
      runs.push({ text: slice, style: {} });
      return;
    }
    runs.push({ text: slice, style: { ...current } });
  };

  CSI_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CSI_RE.exec(text)) !== null) {
    const [, params, , final] = m;
    push(text.slice(cursor, m.index));
    cursor = m.index + m[0].length;
    if (final !== "m") continue; // non-SGR CSI: consume silently

    const codes = (params || "0").split(";").map((p) => (p === "" ? 0 : Number(p)));
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]!;
      if (c === 38 || c === 48) {
        const mode = codes[i + 1];
        const isFg = c === 38;
        if (mode === 5) {
          const n = codes[i + 2] ?? 0;
          current = { ...current, [isFg ? "fg" : "bg"]: xterm256ToHex(n) };
          i += 2;
          continue;
        }
        if (mode === 2) {
          const [r, g, b] = [codes[i + 2] ?? 0, codes[i + 3] ?? 0, codes[i + 4] ?? 0];
          const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
          current = { ...current, [isFg ? "fg" : "bg"]: hex };
          i += 4;
          continue;
        }
        continue;
      }
      // SGR 0 (reset) must fall back to the **baseline** colours
      // (theme.text) instead of the active colour; every other code
      // continues from the current style.
      current = codeToStyle(c, current, baseStyle) as StyledRun["style"];
    }
  }
  push(text.slice(cursor));
  // Merge adjacent runs with identical styles for fewer DOM nodes.
  const merged: StyledRun[] = [];
  for (const r of runs) {
    const prev = merged[merged.length - 1];
    if (prev && sameStyle(prev.style, r.style)) prev.text += r.text;
    else merged.push({ ...r, style: { ...r.style } });
  }
  return merged;
}

function sameStyle(a: StyledRun["style"], b: StyledRun["style"]): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    (a.bold ?? false) === (b.bold ?? false) &&
    (a.dim ?? false) === (b.dim ?? false) &&
    (a.italic ?? false) === (b.italic ?? false) &&
    (a.underline ?? false) === (b.underline ?? false) &&
    (a.inverse ?? false) === (b.inverse ?? false) &&
    (a.strikethrough ?? false) === (b.strikethrough ?? false)
  );
}

/** Count printable cells, ignoring SGR/OSC escapes (CJK-aware when Bun is present). */
export function visibleWidth(s: string): number {
  // eslint-disable-next-line no-control-regex
  const stripped = s.replace(CSI_RE, "").replace(STRING_ESC_RE, "");
  const bun = (globalThis as unknown as { Bun?: { stringWidth?: (s: string) => number } }).Bun;
  if (bun && typeof bun.stringWidth === "function") return bun.stringWidth(stripped);
  return stripped.length;
}
