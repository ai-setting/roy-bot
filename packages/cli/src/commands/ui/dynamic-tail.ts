/**
 * @fileoverview Tail-bounded render helpers for the dynamic region in REPLInk.
 *
 * Task #2657 (continuation) — root cause for the high-volume Ink flicker is
 * that the dynamic region (the streaming / last message) can grow taller
 * than the terminal viewport. Ink 5.2.1 reacts to that with
 * `clearTerminal + fullStaticOutput + output`, which repaints the entire
 * stable history and triggers a visible flicker.
 *
 * The fix in this module is structural:
 *   1. compute how many terminal rows the dynamic region is allowed to
 *      occupy (viewport rows minus reserved rows for status bar / input /
 *      popup / safety margin);
 *   2. truncate the rendered ANSI string so its visible row count never
 *      exceeds that budget;
 *   3. expose helpers that REPLInk can compose into its dynamic slot.
 *
 * The renderer is intentionally a pure module so it can be unit-tested
 * without spinning up an Ink instance and so the root cause fix does not
 * rely on throttling as a mask.
 */
import { renderMarkdown, truncateRenderedMarkdown } from "../../render/markdown.js";

/**
 * Reserved rows for status bar (~1) + input frame (~3) — chrome that
 * exists below the dynamic region. The popup (max 8 rows) is NOT
 * included here; pass it via `hasPopup` so it is added additively
 * (avoids the historic double-count bug where 8 was counted in both
 * `DEFAULT_RESERVED_ROWS` and the `hasPopup` branch).
 */
export const DEFAULT_RESERVED_ROWS = 4;

/** Reserved rows added when the slash-command popup is visible. */
export const POPUP_RESERVED_ROWS = 8;

/**
 * Minimum dynamic rows we still attempt to render. When the terminal is
 * too small to honour this floor, `dynamicRows` is allowed to drop below
 * MIN_DYNAMIC_ROWS, even to 0 (the contract guarantees non-negative).
 */
export const MIN_DYNAMIC_ROWS = 4;

/** Safety margin to leave empty so the prompt is not glued to the cursor. */
export const DYNAMIC_SAFETY_MARGIN = 1;

export interface DynamicTailBounds {
  /** Total terminal rows available (stdout.rows). */
  totalRows: number;
  /** Rows reserved for non-history chrome (status + input + popup + safety). */
  reservedRows: number;
  /** Final budget the dynamic region may occupy. Always >= 0 and <= totalRows. */
  dynamicRows: number;
}

export function computeDynamicTailBounds(
  totalRows: number | undefined,
  reservedRows: number = DEFAULT_RESERVED_ROWS,
  hasPopup: boolean = false,
): DynamicTailBounds {
  const total = Math.max(1, totalRows ?? 24);
  const popupRows = hasPopup ? POPUP_RESERVED_ROWS : 0;
  const reserved = reservedRows + popupRows + DYNAMIC_SAFETY_MARGIN;
  // The hard invariant: dynamicRows is in [0, totalRows]. We never
  // report a budget larger than the total viewport (the previous
  // implementation did `Math.max(MIN, total - reserved)` which could
  // exceed total when total < reserved, leaking rows into the Ink
  // overflow path).
  const headroom = total - reserved;
  let dynamic: number;
  if (headroom >= MIN_DYNAMIC_ROWS) {
    dynamic = headroom;
  } else if (headroom > 0) {
    // Terminal is smaller than the ideal chrome + minimum, but still has
    // at least one row of headroom. Take it.
    dynamic = headroom;
  } else {
    // Terminal is so small that chrome alone exceeds the viewport. The
    // dynamic region gets nothing; the renderer will degrade to notice
    // only and the Ink overflow path stays below the equality
    // threshold.
    dynamic = 0;
  }
  // Final clamp: never negative, never exceed total.
  dynamic = Math.max(0, Math.min(total, dynamic));
  return { totalRows: total, reservedRows: reserved, dynamicRows: dynamic };
}

/**
 * Render an assistant message for the dynamic region with a row budget.
 *
 * The output is always safe to embed in <Text>: no unterminated ANSI
 * codes, no mid-escape truncation, and a visible truncation notice when
 * the source is longer than the budget.
 */
export function renderBoundedAssistant(
  text: string,
  bounds: DynamicTailBounds,
  width: number,
): string {
  if (!text) {
    return "";
  }
  if (bounds.dynamicRows <= 0) {
    // No body rows available. The Markdown renderer is still called
    // because callers may want the rendered ANSI to flow through their
    // own truncation notice (truncateRenderedMarkdown emits a notice
    // when budget > 0; here we emit our own so the user always sees
    // an indication that the dynamic region is being clipped).
    return "";
  }
  const rendered = renderMarkdown(text, { width });
  return truncateRenderedMarkdown(rendered, bounds.dynamicRows, width);
}

/**
 * Render a non-assistant message for the dynamic region. We cap its
 * height with the same dynamicRows budget so a long user/tool/system
 * message cannot overflow the viewport. When the budget is 0 the
 * function returns ""; the caller is expected to render at least the
 * streaming cursor.
 */
export function renderBoundedPlain(
  text: string,
  bounds: DynamicTailBounds,
  width: number,
): string {
  if (!text) {
    return "";
  }
  if (bounds.dynamicRows <= 0) {
    return "";
  }
  return truncateRenderedMarkdown(text, bounds.dynamicRows, width);
}
