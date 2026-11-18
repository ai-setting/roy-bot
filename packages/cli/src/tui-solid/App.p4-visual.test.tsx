/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview P4 message-visual component tests (Task #4994) —
 * **opentui/solid** edition.
 *
 * Covers the three `tui-solid/App.tsx` / `tui/theme.ts` P4 changes:
 *   1. **user message block** — a left rail (`border=["left"]`) +
 *      raised panel background (`backgroundPanel`), opencode
 *      UserMessage parity (packages/tui/src/routes/session/index.tsx
 *      UserMessage: border left + background raised);
 *   2. **role labels go plain-text** (`You` / `Agent` / `Tool`) —
 *      the emoji prefixes (👤/🤖/🔧) are dropped (glyph availability
 *      varies across terminals, and the plan §P4 mandates text tags);
 *   3. **meta info line** — `Build · <model> · <duration>s · <tok/s>`
 *      formatting (pure formatter `formatMetaLine` in
 *      `tui/usage-format.ts`, rendered by the usage history row).
 *
 * Uses `captureSpans()` (not `captureCharFrame`) so the assertions can
 * verify **colours/backgrounds**, not just text content.
 */

import { describe, it, expect } from "bun:test";
import { testRender } from "@opentui/solid";
import { App, type HistoryItem } from "./App.js";
import {
  formatMetaLine,
  type MetaInfo,
  type UsageLike,
} from "../tui/usage-format.js";
import { isSolidReactive, SSR_SKIP_REASON } from "./test-utils/solid-test-env.js";

const SOLID_REACTIVE = isSolidReactive();
const describeIfClient = SOLID_REACTIVE ? describe : describe.skip;

interface FrameSpan {
  text: string;
  fg: string;
  bg: string;
  attributes: number;
}

/** Mount `App` and flatten `captureSpans()` into (row → spans). */
async function spansOf(props: {
  history: HistoryItem[];
  status: "idle" | "thinking" | "streaming";
  model?: string;
}): Promise<FrameSpan[][]> {
  const t = await testRender(() => <App {...props} />, { width: 100, height: 20 });
  await t.renderOnce();
  const f = t.captureSpans();
  const rows: FrameSpan[][] = f.lines.map((line) =>
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

/** The exact shape core publishes on `llm.completed`. */
const USAGE: UsageLike = {
  promptTokens: 113,
  completionTokens: 25,
  cacheRead: 14720,
  cacheWrite: 0,
  promptTokensTotal: 14833,
};

describeIfClient("P4 user message block (left rail + panel bg)", () => {
  it("renders the user message on a raised panel background", async () => {
    const rows = await spansOf({
      history: [{ role: "user", content: "hello block", id: "u1" }],
      status: "idle",
    });
    const row = rows.find((r) => r.some((s) => s.text.includes("hello block")));
    expect(row).toBeDefined();
    const nonSpace = row!.filter((s) => s.text.trim() !== "");
    // every painted span of the block carries the panel bg (non-black)
    expect(nonSpace.length).toBeGreaterThan(0);
    for (const s of nonSpace) {
      expect(s.bg).not.toBe("rgba(0.00, 0.00, 0.00, 1.00)");
      // Task #4994 review MINOR-1: a transparent bg is NOT the raised
      // panel — assert the panel token actually painted (alpha 1.00).
      expect(s.bg).toContain("1.00");
    }
  });

  it("renders a left rail on the user block (border-left column)", async () => {
    const rows = await spansOf({
      history: [{ role: "user", content: "railed", id: "u1" }],
      status: "idle",
    });
    const row = rows.find((r) => r.some((s) => s.text.includes("railed")));
    expect(row).toBeDefined();
    // Task #4994 review MINOR-1: assert the rail itself — an actual box
    // drawing character painted in the user hue. Task #5086 P5:
    // theme.borderUser 从硬编码 green (rgba 0,0.5,0) 迁到 token secondary
    // （dark #5c9cf5 = rgb(92,156,245) = rgba(0.36,0.61,0.96,1.00)）。
    const painted = row!.filter((s) => s.text.trim() !== "");
    expect(painted.length).toBeGreaterThan(1);
    const rail = painted.find(
      (s) => /^[\u2502\u2503|]/.test(s.text.trim()) && s.fg === "rgba(0.36, 0.61, 0.96, 1.00)",
    );
    expect(rail).toBeDefined();
  });

  it("assistant messages do NOT carry the panel background", async () => {
    const rows = await spansOf({
      history: [{ role: "assistant", content: "plain reply", id: "a1" }],
      status: "idle",
    });
    const row = rows.find((r) => r.some((s) => s.text.includes("plain reply")));
    expect(row).toBeDefined();
    const body = row!.filter((s) => s.text.includes("plain reply"));
    for (const s of body) {
      // Task #5086 P5: the canvas bg is now the token
      // (dark #0a0a0a = rgba(0.04,0.04,0.04)) — the invariant is
      // "NOT the raised panel bg" (#141414 = rgba(0.08,0.08,0.08)).
      const isPanel = s.bg === "rgba(0.08, 0.08, 0.08, 1.00)";
      expect(isPanel).toBe(false);
    }
  });
});

describeIfClient("P4 role labels are plain text", () => {
  it("user row shows `You` and no emoji glyph", async () => {
    const rows = await spansOf({
      history: [{ role: "user", content: "x", id: "u1" }],
      status: "idle",
    });
    const all = rows.flat().map((s) => s.text).join("");
    expect(all).toContain("You");
    expect(all).not.toContain("👤");
  });

  it("assistant row shows `Agent` and no emoji glyph", async () => {
    const rows = await spansOf({
      history: [{ role: "assistant", content: "y", id: "a1" }],
      status: "idle",
    });
    const all = rows.flat().map((s) => s.text).join("");
    expect(all).toContain("Agent");
    expect(all).not.toContain("🤖");
  });

  it("tool row shows `Tool` and no emoji glyph", async () => {
    const rows = await spansOf({
      history: [{ role: "tool", content: "did a thing", id: "t1" }],
      status: "idle",
    });
    const all = rows.flat().map((s) => s.text).join("");
    expect(all).toContain("Tool");
    expect(all).not.toContain("🔧");
  });
});

describeIfClient("P4 meta info line (Build · model · duration · tok/s)", () => {
  it("formats the full meta line", () => {
    const meta: MetaInfo = { agent: "Build", model: "deepseek-v4.1-flash" };
    const line = formatMetaLine(meta, USAGE, 4210);
    expect(line).toContain("Build");
    expect(line).toContain("deepseek-v4.1-flash");
    expect(line).toContain("4.2s");
    expect(line).toContain("5.9 tok/s"); // 25 tokens / 4.21s ≈ 5.9
  });

  it("omits duration/tok/s when not provided", () => {
    const meta: MetaInfo = { agent: "Build", model: "m1" };
    const line = formatMetaLine(meta, USAGE);
    expect(line).toContain("Build · m1");
    expect(line).not.toContain("s ·");
    expect(line).not.toContain("tok/s");
  });

  it("renders the meta line under the assistant message", async () => {
    const meta: MetaInfo = { agent: "Build", model: "deepseek-v4.1-flash" };
    const rows = await spansOf({
      history: [
        { role: "assistant", content: "reply body", id: "a1" },
        { role: "usage", content: formatMetaLine(meta, USAGE, 4210), id: "a1m" },
      ],
      status: "idle",
    });
    const all = rows.map((r) => r.map((s) => s.text).join(""));
    const bodyIdx = all.findIndex((l) => l.includes("reply body"));
    const metaIdx = all.findIndex((l) => l.includes("deepseek-v4.1-flash"));
    expect(bodyIdx).toBeGreaterThanOrEqual(0);
    expect(metaIdx).toBeGreaterThan(bodyIdx);
 expect(all[metaIdx]).toContain("tok/s");
  });

  it("the usage row stays cache/token-aware (cache% still shown)", async () => {
    const meta: MetaInfo = { agent: "Build", model: "m1" };
    const line = formatMetaLine(meta, USAGE, 4210);
    // 14720 / 14833 = 99.2% cache hit — carried over from #4396.
    expect(line).toContain("99.2%");
  });
});
