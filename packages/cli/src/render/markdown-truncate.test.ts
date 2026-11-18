/**
 * @fileoverview Unit tests for truncateRenderedMarkdown (Task #2657 R2).
 *
 * The dynamic-tail of REPLInk renders markdown through Ink <Text>.
 * Once that tail is taller than the available terminal height, Ink's
 * renderer emits `clearTerminal + fullStaticOutput + output` and
 * repaints the entire stable history on every key press or delta.
 *
 * We bound the tail height by calling `truncateRenderedMarkdown` on
 * the rendered ANSI string with a `maxVisibleLines` derived from
 * `terminal rows - reserved rows` (status bar / input / popup). These
 * tests pin the post-wrap line count so that the fix does not regress.
 */
import { describe, test, expect } from "bun:test";
import { truncateRenderedMarkdown, renderMarkdown } from "./markdown";

// ANSI helpers for test readability
const RED = "\u001b[31m";
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";
const BG = "\u001b[41m";

describe("truncateRenderedMarkdown (Task #2657 R2)", () => {
  test("returns input unchanged when rendered output is short enough", () => {
    const rendered = "line1\nline2\nline3";
    const out = truncateRenderedMarkdown(rendered, 5, 80);
    expect(out).toBe(rendered);
  });

  test("truncates when visible line count exceeds maxVisibleLines (wraps long lines)", () => {
    const rendered = "0123456789".repeat(40);
    const width = 80;
    // Each line wraps to ceil(lineLength / width) = 5 rows for length 400.
    const out = truncateRenderedMarkdown(rendered, 4, width);
    expect(out).not.toBe(rendered);
    expect(out).toContain("[...");
    expect(out).toContain("more line(s) hidden");
    // Truncation must land on a newline boundary, never inside an escape sequence.
    expect(out.endsWith("\x1b[0m")).toBe(true);
  });

  test("counts newlines and wrap rows together", () => {
    const rendered = "AAAA\n" + "B".repeat(200) + "\nCCCC";
    const out = truncateRenderedMarkdown(rendered, 5, 50);
    // B line alone needs 4 wrap rows at width 50. Add A and C. So 6 needed > 5.
    expect(out).toContain("[...");
  });

  test("truncates a real markdown render to fit in viewport", () => {
    const long = "long line\n".repeat(80);
    const rendered = renderMarkdown(long, { width: 60 });
    const out = truncateRenderedMarkdown(rendered, 6, 60);
    expect(out).toContain("[...");
    expect(out.split("\n").length).toBeLessThanOrEqual(7);
  });

  test("maxVisibleLines=0 disables truncation", () => {
    const rendered = "x".repeat(800);
    const out = truncateRenderedMarkdown(rendered, 0, 80);
    expect(out).toBe(rendered);
  });

  test("empty input returns empty", () => {
    expect(truncateRenderedMarkdown("", 5, 80)).toBe("");
  });
});

describe("truncateRenderedMarkdown — terminal cell width correctness (Task #2657 R2 v2)", () => {
  test("ANSI escape sequences are not counted toward cell width", () => {
    // 12 visible characters but each is wrapped in SGR sequences.
    const colored = `${RED}hello world${RESET}`;
    // width 8 → 2 wrap rows visible. budget 1 → truncated.
    const out = truncateRenderedMarkdown(colored, 1, 8);
    expect(out).toContain("[...");
    // Whole visible content must be truncated out, leaving only the notice.
    expect(out).not.toContain("hello world");
  });

  test("CJK double-width characters consume 2 cells each", () => {
    // 你好世界 (4 chars × 2 cells = 8 cells). width 4 → wraps to 2 rows.
    const cjk = "你好世界";
    // budget 1 → only 1 row allowed → must truncate.
    const out = truncateRenderedMarkdown(cjk, 1, 4);
    expect(out).toContain("[...");
    expect(out).not.toBe(cjk);
  });

  test("emoji / ZWJ family grapheme counts as 2 cells (single wrap row)", () => {
    // 👨‍👩‍👧 = single grapheme = 2 cells
    const family = "👨‍👩‍👧";
    // width 2 → fits in 1 row
    expect(truncateRenderedMarkdown(family, 1, 2)).toBe(family);
    // width 1 → wraps to 2 rows, budget 1 → truncate
    const out = truncateRenderedMarkdown(family, 1, 1);
    expect(out).toContain("[...");
  });

  test("combining characters (café) counted as 4 cells, not 5", () => {
    const combining = "café"; // 4 code points, but 4 visible cells
    // width 4 → 1 row → fits
    expect(truncateRenderedMarkdown(combining, 1, 4)).toBe(combining);
    // width 3 → wraps to 2 rows → budget 1 → truncate
    const out = truncateRenderedMarkdown(combining, 1, 3);
    expect(out).toContain("[...");
  });

  test("a very long no-newline line does not silently drop the entire body when budget allows", () => {
    // 1000 chars on one line, width 80 → 13 wrap rows. budget 13 fits
    // exactly without notice.
    const long = "a".repeat(1000);
    const out = truncateRenderedMarkdown(long, 13, 80);
    expect(out).not.toContain("[...");

    // budget 5: body budget 4 → tail-truncate to the last 320 cells,
    // which keeps plenty of content (320 of the 1000 a's) plus the
    // notice line. The kept body MUST contain at least one 'a'.
    const truncated = truncateRenderedMarkdown(long, 5, 80);
    expect(truncated).toContain("a");
    expect(truncated).toContain("[..."); // notice shown because hidden > 0
    expect(truncated.length).toBeLessThan(long.length + 100);
  });
});

describe("truncateRenderedMarkdown — newest-first semantics (Task #2657 R2 v2)", () => {
  test("keeps the LAST source lines, drops the FIRST ones", () => {
    // 20 lines. budget 5. We reserve 1 row for the notice, so 4 body lines.
    // After truncating we expect the LAST 4 lines (line-16..line-19)
    // to be present and the FIRST 16 to be dropped.
    const lines = Array.from({ length: 20 }, (_, i) => `line-${String(i).padStart(2, "0")}`);
    const rendered = lines.join("\n");
    const out = truncateRenderedMarkdown(rendered, 5, 80);
    expect(out).toContain("line-19");
    expect(out).toContain("line-16");
    expect(out).not.toContain("line-00");
    expect(out).not.toContain("line-15");
  });

  test("long single line: keeps the LAST cells, drops the FIRST cells", () => {
    const long = "X".repeat(200) + "TAIL-MARKER" + "Y".repeat(200);
    // 411 cells, wraps to ceil(411/80) = 6 rows. budget 1 → body budget
    // 0, so the body is invisible and only the notice is shown. This
    // is acceptable: with budget 1 we cannot fit even 1 row of body +
    // the notice, so we degrade to notice-only.
    const out = truncateRenderedMarkdown(long, 1, 80);
    expect(out).toContain("[...");

    // With budget 4: body budget 3 → 240 cells kept (the last 240 chars),
    // which includes TAIL-MARKER (chars 200..211) plus some trailing Y's.
    const out2 = truncateRenderedMarkdown(long, 4, 80);
    expect(out2).toContain("TAIL-MARKER");
    expect(out2).not.toContain("X".repeat(50)); // earliest 50 chars are dropped
  });

  test("reserves 1 row for the truncation notice so visible rows never exceed maxVisibleLines", () => {
    // 50 lines, budget 5 → keep last 4 lines + notice
    const lines = Array.from({ length: 50 }, (_, i) => `L${i}`);
    const rendered = lines.join("\n");
    const out = truncateRenderedMarkdown(rendered, 5, 80);
    const outLines = out.split("\n");
    // The notice line must be the last one. Body lines (not the notice)
    // must be at most 4.
    expect(outLines[outLines.length - 1]).toContain("[...");
    // Count body lines (everything before the notice line)
    expect(outLines.length - 1).toBeLessThanOrEqual(4);
  });

  test("truncation notice always ends with an ANSI reset to avoid color bleed", () => {
    const rendered = "AAA\n".repeat(50);
    const out = truncateRenderedMarkdown(rendered, 3, 80);
    expect(out.endsWith(RESET)).toBe(true);
  });
});

// Helper: visible (ANSI-stripped) cell width of a line, using Bun.stringWidth.
function visibleCellWidth(s: string): number {
  // Strip CSI / OSC / SGR sequences for cell measurement
  // eslint-disable-next-line no-control-regex
  const stripped = s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
  return Bun.stringWidth(stripped);
}

describe("truncateRenderedMarkdown — edge cases (Task #2657 R2 v2)", () => {
  test("width=1 with empty budget is a no-op", () => {
    const out = truncateRenderedMarkdown("hello", 0, 1);
    expect(out).toBe("hello");
  });

  test("multi-line input where last line is incomplete wrap stays bounded", () => {
    // 5 lines, last line is 30 cells wide → 2 wrap rows. Total = 4 + 2 = 6.
    // budget 5 → must truncate.
    const rendered = "AA\nBB\nCC\nDD\nEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";
    const out = truncateRenderedMarkdown(rendered, 5, 16);
    expect(out).toContain("[...");
  });

  test("long markdown render keeps newest tokens visible", () => {
    const md = "old-para-1\nold-para-2\nold-para-3\n" +
      "newest-para-A\nnewest-para-B";
    const rendered = renderMarkdown(md, { width: 80 });
    const out = truncateRenderedMarkdown(rendered, 3, 80);
    expect(out).toContain("newest-para-B");
    expect(out).not.toContain("old-para-1");
  });

  test("zero-width input is preserved unchanged", () => {
    expect(truncateRenderedMarkdown("anything", 10, 0)).toBe("anything");
  });
});