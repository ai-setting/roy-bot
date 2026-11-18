/**
 * @fileoverview Task #4954 P2 — **paste channel** pure functions.
 *
 * Pipeline (aligned with opencode v2.2.5
 * `packages/tui/src/component/prompt/index.tsx:1448-1478` and
 * `packages/tui/src/prompt/part.ts:expandPastedTextPlaceholders`):
 *
 *   raw bytes ──usePaste──▶ normalizePaste ──▶ shouldFoldPaste?
 *                                                │ no
 *                                                ▼        yes
 *                                     insertText(text)  foldedPlaceholder
 *                                                       ([Pasted ~N lines])
 *                                                                │
 *                                              Enter ──▶ expandPastedPlaceholders
 *                                                                ▼
 *                                                         onSubmit(real text)
 *
 * Everything here is a pure function so the fold policy and the
 * expand step are unit-testable without a terminal (the opentui
 * event wiring itself is covered by the `.opentui` behaviour tests).
 */

import { decodePasteBytes, stripAnsiSequences } from "@opentui/core";

/** opencode policy: fold when ≥3 lines OR >150 characters. */
const FOLD_MIN_LINES = 3;
const FOLD_MIN_CHARS = 150;

/**
 * Raw paste bytes → UI text.
 *
 * Mirrors opencode's pasteInputText boundary normalization:
 * strip any embedded ANSI (terminals sometimes echo SGR inside the
 * paste payload) and normalize CRLF / lone CR to LF.
 *
 * @param bytes raw payload between `ESC[200~` and `ESC[201~`
 *   (as delivered by opentui's PasteEvent) — or a pre-decoded string
 *   for tests / OSC52 paths.
 */
export function normalizePaste(input: Uint8Array | string): string {
  const decoded = typeof input === "string" ? input : decodePasteBytes(input);
  // Windows ConPTY/Terminal often sends CR-only newlines in bracketed
  // paste. Replace CRLF first, then any remaining CR (opencode-verified).
  return stripAnsiSequences(decoded).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Number of lines in a paste payload (LF-separated; ≥1). */
export function pasteLineCount(text: string): number {
  return (text.match(/\n/g)?.length ?? 0) + 1;
}

/**
 * Should this paste be folded into a placeholder?
 *
 * opencode policy (`config.prompt?.paste !== "full"`):
 * ≥3 lines OR >150 characters ⇒ fold; otherwise insert verbatim.
 */
export function shouldFoldPaste(text: string): boolean {
  return pasteLineCount(text) >= FOLD_MIN_LINES || text.length > FOLD_MIN_CHARS;
}

/**
 * The `[Pasted ~N lines]` placeholder shown in the input box.
 * Line counting matches opencode: LF count + 1.
 */
export function foldedPlaceholder(text: string): string {
  return `[Pasted ~${pasteLineCount(text)} lines]`;
}

/** One remembered paste: the real text + the placeholder that stands for it. */
export interface PastedPart {
  /** The full original pasted text (what gets submitted). */
  text: string;
  /** The placeholder shown in the input box (what the user sees). */
  placeholder: string;
}

/**
 * Expand every remembered placeholder back to its real content.
 *
 * Mirrors opencode's expandPastedTextPlaceholders: parts are matched
 * left-to-right (by placeholder text occurrence), so two pastes with
 * identical placeholder strings expand in insertion order. A part whose
 * placeholder no longer occurs (user deleted/edited it) is skipped —
 * the surrounding text stays untouched.
 */
export function expandPastedPlaceholders(
  text: string,
  parts: readonly PastedPart[],
): string {
  let cursor = 0;
  let result = "";
  for (const part of parts) {
    const index = text.indexOf(part.placeholder, cursor);
    if (index === -1) continue;
    result += text.slice(cursor, index) + part.text;
    cursor = index + part.placeholder.length;
  }
  return result + text.slice(cursor);
}
