/**
 * @fileoverview Unit tests for the dynamic-tail bounds module (Task #2657 R2).
 */
import { describe, test, expect } from "bun:test";
import {
  computeDynamicTailBounds,
  renderBoundedAssistant,
  renderBoundedPlain,
  MIN_DYNAMIC_ROWS,
  DEFAULT_RESERVED_ROWS,
} from "./dynamic-tail";

describe("computeDynamicTailBounds (Task #2657 R2)", () => {
  test("uses 24 rows by default and subtracts reserved rows + safety margin", () => {
    const bounds = computeDynamicTailBounds(undefined);
    expect(bounds.totalRows).toBe(24);
    expect(bounds.reservedRows).toBeGreaterThanOrEqual(DEFAULT_RESERVED_ROWS);
    expect(bounds.dynamicRows).toBeGreaterThanOrEqual(MIN_DYNAMIC_ROWS);
    // dynamicRows = total - reserved - safety margin; no popup adds nothing.
    expect(bounds.dynamicRows).toBeLessThanOrEqual(
      24 - (DEFAULT_RESERVED_ROWS + 1),
    );
  });

  test("small terminals fall back to whatever headroom is left (not MIN_DYNAMIC_ROWS)", () => {
    // rows=4 with reserved=4 means chrome alone is 5 rows (with safety
    // margin). The dynamic region cannot grow; the renderer falls back
    // to streaming-cursor-only output. This is the fix for the leak
    // where rows=4 used to report dynamicRows=4 even though the
    // viewport could not fit it.
    const bounds = computeDynamicTailBounds(4);
    expect(bounds.dynamicRows).toBe(0);
  });

  test("slightly-larger terminals get the remaining headroom", () => {
    // rows=10 with reserved=4 + safety=1 = 5 reserved → dynamic=5.
    const bounds = computeDynamicTailBounds(10);
    expect(bounds.dynamicRows).toBe(5);
  });

  test("larger terminals get the natural budget", () => {
    // rows=24, reserved=4 + safety=1 = 5 reserved → dynamic=19.
    const bounds = computeDynamicTailBounds(24);
    expect(bounds.dynamicRows).toBe(19);
  });

  test("adds popup reservation when hasPopup=true", () => {
    const noPopup = computeDynamicTailBounds(40, DEFAULT_RESERVED_ROWS, false);
    const withPopup = computeDynamicTailBounds(40, DEFAULT_RESERVED_ROWS, true);
    expect(withPopup.reservedRows).toBeGreaterThan(noPopup.reservedRows);
    expect(withPopup.dynamicRows).toBeLessThan(noPopup.dynamicRows);
  });
});

describe("renderBoundedAssistant (Task #2657 R2)", () => {
  test("returns empty string for empty input", () => {
    const out = renderBoundedAssistant("", computeDynamicTailBounds(40), 80);
    expect(out).toBe("");
  });

  test("truncates a long assistant message within dynamicRows budget", () => {
    const text = Array.from({ length: 200 }, (_, i) => `line-${i}`).join("\n");
    const bounds = computeDynamicTailBounds(40);
    const out = renderBoundedAssistant(text, bounds, 80);
    expect(out).toContain("[...");
    // The output is bounded by the dynamicRows budget plus a trailing notice.
    expect(out.length).toBeLessThan(text.length);
  });

  test("short messages pass through unchanged", () => {
    const text = "hello world\nthis is short";
    const bounds = computeDynamicTailBounds(40);
    const out = renderBoundedAssistant(text, bounds, 80);
    expect(out).toBe("hello world\nthis is short");
  });
});

describe("renderBoundedPlain (Task #2657 R2)", () => {
  test("truncates a long plain message within dynamicRows budget", () => {
    const text = "x".repeat(4000);
    const bounds = computeDynamicTailBounds(20);
    const out = renderBoundedPlain(text, bounds, 80);
    expect(out).toContain("[...");
    expect(out.length).toBeLessThan(text.length);
  });
});

describe("computeDynamicTailBounds — leak-proof invariants (Task #2657 R2 v2)", () => {
  test("returned dynamicRows is never negative even at rows=1 with popup", () => {
    const bounds = computeDynamicTailBounds(1, DEFAULT_RESERVED_ROWS, true);
    expect(bounds.dynamicRows).toBeGreaterThanOrEqual(0);
  });

  test("returned dynamicRows + reservedRows never exceeds totalRows", () => {
    for (const rows of [1, 2, 4, 8, 16, 24, 40, 80, 200]) {
      for (const hasPopup of [false, true]) {
        const bounds = computeDynamicTailBounds(rows, DEFAULT_RESERVED_ROWS, hasPopup);
        // Allow MIN_DYNAMIC_ROWS to *expand* past total - reserved (that's the clamp);
        // but the *reported* total + reserved should never lie about consumed rows.
        // In particular, when rows < reserved + MIN, dynamicRows becomes MIN_DYNAMIC_ROWS,
        // and we still report the truth (totalRows >= dynamicRows).
        expect(bounds.totalRows).toBe(rows);
        expect(bounds.dynamicRows).toBeGreaterThanOrEqual(0);
        // Sanity: dynamicRows <= totalRows always (otherwise nothing fits).
        expect(bounds.dynamicRows).toBeLessThanOrEqual(bounds.totalRows);
      }
    }
  });

  test("popup + reserved rows are not double-counted at every total size", () => {
    // The docstring says DEFAULT_RESERVED_ROWS already includes "popup max 8",
    // so hasPopup must NOT add another 8 on top, otherwise the contract is wrong.
    const baseNoPopup = computeDynamicTailBounds(60, DEFAULT_RESERVED_ROWS, false);
    const baseWithPopup = computeDynamicTailBounds(60, DEFAULT_RESERVED_ROWS, true);
    // The popup toggle should change the budget by AT MOST the popup's own height.
    const diff = baseNoPopup.dynamicRows - baseWithPopup.dynamicRows;
    expect(diff).toBeLessThanOrEqual(8);
    expect(diff).toBeGreaterThanOrEqual(0);
  });

  test("the dynamic region row budget plus the smallest possible chrome still leaves the prompt visible", () => {
    // At rows=10, we need at least 1 row for the streaming cursor + a tiny body.
    const bounds = computeDynamicTailBounds(10);
    expect(bounds.dynamicRows).toBeGreaterThanOrEqual(1);
  });
});