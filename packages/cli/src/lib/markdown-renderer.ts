/**
 * @fileoverview Incremental Markdown → ANSI renderer.
 *
 * Streaming-friendly state machine designed for `StreamOutputService.handleText`
 * to feed one delta at a time. No new runtime deps; uses inline raw ANSI escape
 * sequences.
 *
 * Public API:
 *   - `renderMarkdownDelta(text)` — one-shot: full text → ANSI string.
 *   - `MarkdownRenderer` — stateful/incremental: push() returns the prefix
 *     safe to emit now; flush() returns accumulated output + closing
 *     escapes for any styles still in pending state.
 *   - `MarkdownRenderer.reset()` — clear all state (call between LLM
 *     responses if reusing the same StreamOutputService instance).
 *
 * Round-2 fixes (corrective TDD per QA rejection of #2193 round-1):
 *   - Heading H1–H4 STRIPS the `#` markers and replaces with a colored
 *     decorative bar + bold + colored heading text.
 *   - Link `[text](url)` is parsed and rendered as styled text + plain
 *     `(url)` (cyan underline + dim). Cross-chunk links are buffered
 *     transparently: when `[` opens a potential link, subsequent chars
 *     accumulate into a buffer (max 256 chars) until either:
 *       a) `[text](url)` matches → emit styled link, or
 *       b) buffer overflows / `\n` appears → flush as plain text.
 *   - Tail buffer maintained for cross-delta boundary detection.
 */

import { TracedAs } from "@ai-setting/roy-bot-core";

// ─── ANSI escape constants ────────────────────────────────────────────
const ANSI = {
  RESET: "\x1b[0m",
  BOLD_ON: "\x1b[1m",
  BOLD_OFF: "\x1b[22m",
  DIM: "\x1b[2m",
  UNDERLINE_ON: "\x1b[4m",
  UNDERLINE_OFF: "\x1b[24m",
  ITALIC_ON: "\x1b[3m",
  ITALIC_OFF: "\x1b[23m",
  FG_WHITE: "\x1b[37m",
  FG_DEFAULT: "\x1b[39m",
  FG_CYAN: "\x1b[36m",
  FG_BLUE: "\x1b[34m",
  FG_BRIGHT_CYAN: "\x1b[96m",
  FG_BRIGHT_BLUE: "\x1b[94m",
  BG_DEFAULT: "\x1b[49m",
  BG_GRAY: "\x1b[100m",
} as const;

/** Max chars to buffer when scanning for a cross-chunk `[text](url)`. */
const MAX_LINK_BUFFER = 256;

// ─── Renderer state shape ────────────────────────────────────────────

interface State {
  /** True while between ```<lang> and ``` close. */
  inCodeFence: boolean;
  /** Lang tag from the fence open line (e.g. "ts"). Purely cosmetic. */
  fenceLang: string;
  /** True while between `**` opener and `**` closer. */
  pendingBold: boolean;
  /** True while between `*` opener and `*` closer (single star, italic). */
  pendingItalic: boolean;
  /** True while between two single backticks `` ` ``. */
  pendingInlineCode: boolean;
  /** True while a heading line is being emitted; reset on `\n`. */
  pendingHeading: boolean;
  /** While non-null, chars are buffered in this string awaiting link resolution. */
  pendingLinkBuf: string | null;
  /** Logical line accumulator (resets on \n). Drives lineStart checks. */
  lineBuf: string;
  /**
   * Tail buffer (last 64 chars of raw input). Plain-text only.
   */
  tailBuf: string;
}

function newState(): State {
  return {
    inCodeFence: false,
    fenceLang: "",
    pendingBold: false,
    pendingItalic: false,
    pendingInlineCode: false,
    pendingHeading: false,
    pendingLinkBuf: null,
    lineBuf: "",
    tailBuf: "",
  };
}

// ─── Public helpers ───────────────────────────────────────────────────

/** One-shot wrapper: render a complete string in a fresh renderer. */
export function renderMarkdownDelta(text: string): string {
  const r = new MarkdownRenderer();
  return r.push(text) + r.flush();
}

/** Stateful incremental renderer. See file header for usage. */
export class MarkdownRenderer {
  private state: State = newState();
  /** Accumulates every prefix returned by push() so flush() can be used by
   *  tests (and end-of-stream callers) to inspect the complete render. */
  private _accumulated: string = "";

  /** Process one delta chunk. Returns the prefix that is safe to emit to
   *  stdout now (escapes that depend on future deltas are NOT emitted here).
   *  Also accumulates the prefix internally for flush()/reset(). */
  @TracedAs("markdown.render-delta", {
    recordParams: true,
    recordResult: true,
    paramFilter: (args: any[] | undefined) => {
      const a = args && args[0];
      return {
        "delta.length": (a && typeof a === "string" ? a.length : 0) ?? 0,
        "delta.tail-window": (a && typeof a === "string" ? a.slice(-3) : "") ?? "",
      };
    },
    resultFilter: (result: string | undefined) => {
      const self = (this as unknown) as MarkdownRenderer | undefined;
      const state = self ? self.state : undefined;
      const len = result && typeof result === "string" ? result.length : 0;
      const r: Record<string, any> = {
        "output.length": len,
      };
      if (state) {
        r["state.inCodeFence"] = state.inCodeFence;
        r["state.pendingBold"] = state.pendingBold;
      } else {
        r["state.inCodeFence"] = false;
        r["state.pendingBold"] = false;
      }
      return r;
    },
  })
  push(delta: string): string {
    const out = this.renderDelta(delta);
    this._accumulated += out;
    return out;
  }

  /** Return accumulated output + any closing escapes for styles that are
   *  still in pending state at end-of-stream. After flush() the internal
   *  buffer is consumed (the state itself is preserved so a subsequent
   *  push() can still emit close escapes on a future flush()). */
  flush(): string {
    const result = this._accumulated + this.closePendingStyles();
    this._accumulated = "";
    return result;
  }

  /** Clear all state and the internal accumulator. */
  reset(): void {
    this.state = newState();
    this._accumulated = "";
  }

  // ─── Internal helpers ─────────────────────────────────────────────

  /** Whether inline-style escapes (bold / italic / heading / list / blockquote /
   *  link) are permitted here — i.e. we are NOT inside a fenced code block and
   *  NOT inside an inline-code run. */
  private canApplyInlineStyle(): boolean {
    return !this.state.inCodeFence && !this.state.pendingInlineCode;
  }

  /** Whether the cursor is currently at the start of a logical line —
   *  i.e. `lineBuf` is empty or whitespace-only since the last newline. */
  private isLineStart(): boolean {
    return this.state.lineBuf.trim() === "";
  }

  /** Push raw chars onto the tail buffer (max 64 chars). */
  private pushTail(s: string): void {
    this.state.tailBuf = (this.state.tailBuf + s).slice(-64);
  }

  /** Try to resolve a pending link buffer. Emits styled link if matched,
   *  otherwise returns null and the caller should fall back to plain text. */
  private tryResolveLink(buf: string): { text: string; url: string } | null {
    const m = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(buf);
    if (!m) return null;
    return { text: m[1] ?? "", url: m[2] ?? "" };
  }

  /** Emit closing escapes for any styles still in pending state.
   *  Does NOT clear state — caller may continue pushing. */
  private closePendingStyles(): string {
    let suffix = "";
    if (this.state.pendingBold) suffix += ANSI.BOLD_OFF;
    if (this.state.pendingItalic) suffix += ANSI.ITALIC_OFF;
    if (this.state.pendingInlineCode) suffix += ANSI.RESET;
    if (this.state.pendingHeading) {
      suffix += ANSI.RESET;
      this.state.pendingHeading = false;
    }
    if (this.state.pendingLinkBuf !== null) {
      // Stream cut mid-link: emit raw buffer as plain text to avoid loss.
      suffix += this.state.pendingLinkBuf;
      this.state.pendingLinkBuf = null;
    }
    if (this.state.inCodeFence) suffix += "└─\n";
    return suffix;
  }

  /** Emit a single char to output + update lineBuf + tailBuf. */
  private emitChar(out: string, ch: string): string {
    if (ch === "\n") {
      this.state.lineBuf = "";
      if (this.state.pendingHeading) {
        out += ANSI.RESET;
        this.state.pendingHeading = false;
      }
    } else {
      this.state.lineBuf += ch;
    }
    this.pushTail(ch);
    return out + ch;
  }

  // ─── Internal: per-delta state machine ───────────────────────────

  private renderDelta(delta: string): string {
    let out = "";
    let i = 0;
    while (i < delta.length) {
      const remaining = delta.slice(i);
      let advance = 1;
      let handled = false;

      // 0) If we are mid-link-buffer, accumulate chars and try resolve.
      if (this.state.pendingLinkBuf !== null) {
        const buf = this.state.pendingLinkBuf + remaining;
        const resolved = this.tryResolveLink(buf);
        if (resolved) {
          // Consume only the matched prefix
          const matchedLen = resolved.text.length + resolved.url.length + 4;
          // Re-emit the rest as plain text (after the link)
          const after = buf.slice(matchedLen);
          this.state.pendingLinkBuf = null;
          this.pushTail(buf.slice(0, matchedLen));
          // Emit styled link
          out +=
            ANSI.UNDERLINE_ON +
            ANSI.FG_BRIGHT_CYAN +
            resolved.text +
            ANSI.RESET +
            ANSI.DIM +
            " (" +
            resolved.url +
            ")" +
            ANSI.RESET;
          this.state.lineBuf = "l";
          // Push remainder back as plain chars
          for (const ch of after) {
            out = this.emitChar(out, ch);
          }
          i += remaining.length;
          continue;
        }
        // Check abort conditions: newline, second `[`, or overflow
        if (buf.length > MAX_LINK_BUFFER || buf.includes("\n") || /\[/.test(buf.slice(1))) {
          // Not a link — flush buf as plain text
          for (const ch of buf) {
            out = this.emitChar(out, ch);
          }
          this.state.pendingLinkBuf = null;
          i += remaining.length;
          continue;
        }
        // Still buffering; consume whole chunk
        this.state.pendingLinkBuf = buf;
        this.pushTail(remaining);
        i += remaining.length;
        continue;
      }

      // 1) Triple backtick (fence open or close).
      if (remaining.startsWith("```")) {
        handled = true;
        if (this.state.inCodeFence) {
          this.state.inCodeFence = false;
          out += "└─\n";
          advance = 3;
          this.pushTail("```");
        } else if (!this.state.pendingInlineCode) {
          this.state.inCodeFence = true;
          const afterTicks = remaining.slice(3);
          const nlIdx = afterTicks.indexOf("\n");
          let lang: string;
          if (nlIdx === -1) {
            lang = afterTicks.trim() || "code";
            out += `\n┌─ ${lang}`;
            advance = remaining.length;
            this.pushTail("```" + afterTicks);
          } else {
            lang = afterTicks.slice(0, nlIdx).trim() || "code";
            out += `\n┌─ ${lang}\n`;
            advance = 3 + nlIdx + 1;
            this.pushTail("```" + afterTicks.slice(0, nlIdx + 1));
          }
          this.state.fenceLang = lang;
        } else {
          advance = 1;
          this.pushTail("`");
        }
      }
      // 2) Single backtick (inline code toggle)
      else if (remaining[0] === "`" && !this.state.inCodeFence) {
        handled = true;
        if (this.state.pendingInlineCode) {
          this.state.pendingInlineCode = false;
          out += ANSI.RESET;
        } else {
          this.state.pendingInlineCode = true;
          out += ANSI.BG_GRAY + ANSI.FG_WHITE;
        }
        advance = 1;
        this.pushTail("`");
      }
      // 3) Bold (**)
      else if (
        remaining.startsWith("**") &&
        this.canApplyInlineStyle()
      ) {
        handled = true;
        out += this.state.pendingBold ? ANSI.BOLD_OFF : ANSI.BOLD_ON;
        this.state.pendingBold = !this.state.pendingBold;
        advance = 2;
        this.pushTail("**");
      }
      // 4) Italic (*)
      else if (
        remaining[0] === "*" &&
        this.canApplyInlineStyle() &&
        !this.state.pendingBold
      ) {
        handled = true;
        out += this.state.pendingItalic ? ANSI.ITALIC_OFF : ANSI.ITALIC_ON;
        this.state.pendingItalic = !this.state.pendingItalic;
        advance = 1;
        this.pushTail("*");
      }
      // 5) Heading: #+ at line start
      else if (
        remaining[0] === "#" &&
        this.isLineStart() &&
        this.canApplyInlineStyle()
      ) {
        handled = true;
        let hashes = 0;
        while (
          i + hashes < delta.length &&
          delta[i + hashes] === "#" &&
          hashes < 6
        ) {
          hashes++;
        }
        const level = Math.min(hashes, 6);
        let spaceLen = 0;
        while (
          i + hashes + spaceLen < delta.length &&
          delta[i + hashes + spaceLen] === " "
        ) {
          spaceLen++;
        }
        advance = hashes + spaceLen;
        this.pushTail(delta.slice(i, i + advance));
        const barChar = "━";
        const barLen = Math.max(3, 7 - level);
        const bar = barChar.repeat(barLen);
        const colorByLevel = [
          ANSI.FG_BRIGHT_CYAN,
          ANSI.FG_CYAN,
          ANSI.FG_BLUE,
          ANSI.FG_BRIGHT_BLUE,
          ANSI.FG_DEFAULT,
          ANSI.FG_DEFAULT,
        ];
        const color = colorByLevel[level - 1] ?? ANSI.FG_DEFAULT;
        out += color + bar + ANSI.RESET + "\n";
        out += ANSI.BOLD_ON + color;
        this.state.lineBuf = "h";
        this.state.pendingHeading = true;
      }
      // 6) List bullet: - at line start
      else if (
        remaining[0] === "-" &&
        this.isLineStart() &&
        this.canApplyInlineStyle()
      ) {
        handled = true;
        out += ANSI.FG_CYAN + "•" + ANSI.FG_DEFAULT + " ";
        this.state.lineBuf = "-";
        advance = 1;
        this.pushTail("-");
      }
      // 7) Blockquote: > at line start
      else if (
        remaining[0] === ">" &&
        this.isLineStart() &&
        this.canApplyInlineStyle()
      ) {
        handled = true;
        out += ANSI.DIM + "│ " + ANSI.RESET;
        this.state.lineBuf = " ";
        advance = 1;
        this.pushTail(">");
      }
      // 8) Link open: `[` opens a buffer that resolves to either a link or plain text.
      else if (
        remaining[0] === "[" &&
        this.canApplyInlineStyle()
      ) {
        // Try to resolve within this chunk immediately (fast path).
        const m = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(remaining);
        if (m) {
          handled = true;
          const text = m[1] ?? "";
          const url = m[2] ?? "";
          advance = m[0].length;
          this.pushTail(m[0]);
          out +=
            ANSI.UNDERLINE_ON +
            ANSI.FG_BRIGHT_CYAN +
            text +
            ANSI.RESET +
            ANSI.DIM +
            " (" +
            url +
            ")" +
            ANSI.RESET;
          this.state.lineBuf = "l";
        } else {
          // Begin buffering for cross-chunk resolution
          handled = true;
          this.state.pendingLinkBuf = "[";
          this.pushTail("[");
          advance = 1;
        }
      }

      if (!handled) {
        out = this.emitChar(out, remaining[0]);
        advance = 1;
      }

      i += advance;
    }
    return out;
  }
}