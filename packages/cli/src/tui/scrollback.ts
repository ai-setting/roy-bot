/**
 * @fileoverview Progressive scrollback commit (Task #4103).
 *
 * Mirrors opencode's "mini" split-footer technique: streaming text is split
 * into a **stable prefix** that can be committed to the transcript (Ink
 * `<Static>` → the terminal's native scrollback) and a small **volatile
 * tail** that stays in the live frame. Committing only stable, unlikely-to-
 * reflow content is what prevents the "jump + blank" seen when a whole
 * streamed message is dumped into the transcript at once.
 *
 * A boundary is a blank line that is **not inside an open code fence** —
 * i.e. a markdown block boundary. Committing there keeps each committed
 * chunk a self-contained set of markdown blocks, so rendering them
 * independently produces the same result as rendering the whole document.
 */

export interface StableSplit {
  /** Safe to commit to the transcript (stable markdown blocks). */
  stable: string;
  /** Volatile remainder that may still grow/reflow — keep it live. */
  tail: string;
}

export interface SplitOptions {
  /** Stream has finished → the whole text is stable. */
  force?: boolean;
  /**
   * Safety valve: if there is no blank-line boundary and the buffer has more
   * than this many lines, commit all but the final line so an unbounded
   * single paragraph cannot blow up the live frame. Ignored inside a fence.
   */
  maxTailLines?: number;
}

const FENCE_RE = /^\s*(```|~~~)/;

/** Offset just past the start of the line at `index` (lines split on "\n"). */
function lineStartOffset(lines: string[], index: number): number {
  let off = 0;
  for (let i = 0; i < index; i++) off += (lines[i] ?? "").length + 1;
  return off;
}

/** Split `text` into the stable prefix and the volatile tail. */
export function splitStable(text: string, opts: SplitOptions = {}): StableSplit {
  if (!text) return { stable: "", tail: "" };
  if (opts.force) return { stable: text, tail: "" };

  const lines = text.split("\n");
  let inFence = false;
  let boundary = -1; // offset just past the last stable blank line

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const isLast = i === lines.length - 1;
    const next = lineStartOffset(lines, i) + line.length + 1; // incl. "\n"
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
    } else if (!inFence && !isLast && line.trim() === "") {
      boundary = next;
    }
  }

  if (boundary > 0) {
    return { stable: text.slice(0, boundary), tail: text.slice(boundary) };
  }

  // Safety valve: no blank-line boundary (e.g. one long paragraph). Commit
  // all but the last line so the live frame stays bounded. Skip while inside
  // an unclosed fence (splitting a code block would mis-render it).
  const maxTailLines = opts.maxTailLines ?? 0;
  if (maxTailLines > 0 && !inFence && lines.length > maxTailLines) {
    const keepFrom = lines.length - 1;
    const off = lineStartOffset(lines, keepFrom);
    if (off > 0) {
      return { stable: text.slice(0, off), tail: text.slice(off) };
    }
  }

  return { stable: "", tail: text };
}
