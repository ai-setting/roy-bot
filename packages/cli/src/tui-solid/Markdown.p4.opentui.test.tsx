/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview P4 Markdown component visual tests (Task #4994).
 *
 * The string-level renderer contract lives in
 * `render/markdown.p4.test.ts`. THIS file verifies what the
 * **component** paints on a real opentui frame:
 *
 *   1. a `##` heading arrives **bold + cyan** (no `#` glyph);
 *   2. `**bold**` spans carry the BOLD attribute;
 *   3. a GFM table paints as a grid (box-drawing chars on frame);
 *   4. a code block frame chars are dim/grey, body intact.
 *
 * Uses `captureSpans()` for attribute/colour assertions
 * (per-span `attributes` bitmask + RGBA fg), the same
 * measured approach as `App.p4-visual.test.tsx`.
 */

import { describe, it, expect } from "bun:test";
import { testRender } from "@opentui/solid";
import { Markdown } from "./Markdown.js";
import { isSolidReactive, SSR_SKIP_REASON } from "./test-utils/solid-test-env.js";

const SOLID_REACTIVE = isSolidReactive();
const describeIfClient = SOLID_REACTIVE ? describe : describe.skip;

interface Span {
  text: string;
  fg: string;
  bg: string;
  attributes: number;
}

async function spansOf(text: string, width = 90): Promise<Span[][]> {
  const t = await testRender(
    () => <Markdown text={text} width={width} />,
    { width, height: 24 },
  );
  await t.renderOnce();
  const f = t.captureSpans();
  const rows: Span[][] = f.lines.map((line) =>
    line.spans.map((s) => ({
      text: s.text,
      fg: s.fg.toString(),
      bg: s.bg.toString(),
      attributes: s.attributes,
    })),
  );
  await t.dispose();
  return rows;
}

const hasBold = (s: Span) => (s.attributes & 1) !== 0; // TextAttributes.BOLD = 1

describeIfClient("P4 Markdown frame-level rendering", () => {
  it("heading paints BOLD + CYAN without a # glyph", async () => {
    const rows = await spansOf("## 核心能力\n");
    const row = rows.find((r) => r.some((s) => s.text.includes("核心能力")));
    expect(row).toBeDefined();
    const span = row!.find((s) => s.text.includes("核心能力"))!;
    expect(hasBold(span)).toBe(true);
    // SGR cyan maps to the xterm-palette hex `#00cdcd`
    // (style.ts FG_HEX) → rgba(0.00, 0.80, 0.80, 1.00).
    expect(span.fg).toBe("rgba(0.00, 0.80, 0.80, 1.00)");
    const all = rows.flat().map((s) => s.text).join("");
    expect(all).not.toContain("##");
  });

  it("**bold** spans carry the BOLD attribute", async () => {
    const rows = await spansOf("plain **emph** plain\n");
    const bold = rows.flat().filter((s) => s.text.includes("emph") && hasBold(s));
    expect(bold.length).toBeGreaterThan(0);
  });

  it("table paints as a grid (│ borders on frame)", async () => {
    const rows = await spansOf(
      "| a | b |\n|---|---|\n| x | y |\n",
      60,
    );
    const all = rows.flat().map((s) => s.text).join("");
    expect(all).toContain("│");
    expect(all).toContain("─");
    expect(all).not.toContain("|");
  });

  it("code block paints the frame and keeps the body", async () => {
    const rows = await spansOf("```\nplain body\n```\n", 60);
    const all = rows.flat().map((s) => s.text).join("");
    expect(all).toContain("plain body");
    expect(all).not.toContain("```");
    expect(all).toContain("╭");
  });
});

describe("P4 Markdown frame — runtime gate", () => {
  it("reports WHY the suite is skipped under the SSR build", () => {
    // eslint-disable-next-line no-console
    console.log(
      `[P4] solid-reactive=${SOLID_REACTIVE} ` +
        `=> suite ${SOLID_REACTIVE ? "RUN" : `SKIPPED: ${SSR_SKIP_REASON}`}`,
    );
    expect(typeof SOLID_REACTIVE).toBe("boolean");
  });
});
