/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview App usage-footer tests — **opentui/solid** edition
 * (Task #4679 片5).
 *
 * Ports the 5 assertions of `tui/App.usage-footer.test.tsx` (Task #4396).
 * The Ink file is **untouched** — it still guards the live Ink chain.
 *
 * ## Where the usage row comes from — a real contract difference
 *
 * The two chains carry the usage footer differently:
 *
 *   Ink   `tui/App.tsx`   → `HistoryItem.usage` (a `UsageLike` object);
 *                          `<UsageFooter usage={item.usage}/>` formats it.
 *   Solid `tui-solid/App.tsx` → `HistoryItem.content` (an **already
 *                          formatted string**); the row renders
 *                          `props.item.content` verbatim.
 *
 * The Solid side formats upstream, in `tui-solid/RunScreen.tsx`:
 *
 *   const text = formatUsageFooter(usage);   // ← tui/usage-format.ts
 *   commitHistory({ role: "usage", content: text, ... });
 *
 * `formatUsageFooter` is the **pure** helper extracted from the Ink
 * `UsageFooter` component (Task #4396 / Task #4278 片6), so the two chains
 * format the same numbers the same way. This port therefore:
 *
 *   - builds the history row exactly the way `RunScreen.tsx` builds it
 *     (`role: "usage"` + `content: formatUsageFooter(usage)`), and
 *   - additionally asserts that `formatUsageFooter` — the shared pure
 *     formatter — produces the expected text, which is the part of the
 *     original contract that the Solid chain actually owns.
 */

import { describe, it, test, expect } from "bun:test";
import { testRender } from "@opentui/solid";
import { App, type HistoryItem } from "./App.js";
import { formatUsageFooter, type UsageLike } from "../tui/usage-format.js";
import {
  isSolidReactive,
  SSR_SKIP_REASON,
} from "./test-utils/solid-test-env.js";

const SOLID_REACTIVE = isSolidReactive();
const describeIfClient = SOLID_REACTIVE ? describe : describe.skip;

/** The exact shape core publishes on `llm.completed`. */
const CORE_USAGE = {
  promptTokens: 113,
  completionTokens: 2,
  totalTokens: 14835,
  cacheRead: 14720,
  cacheWrite: 0,
  promptTokensTotal: 14833,
};

/**
 * Build the history row the way `tui-solid/RunScreen.tsx` does: the usage
 * text is formatted upstream and carried in `content`.
 */
function usageRow(usage: UsageLike, id: string): HistoryItem {
  return { role: "usage", content: formatUsageFooter(usage) ?? "", id };
}

/** Mount `App` headlessly and return its captured frame. */
async function frameOf(history: HistoryItem[]): Promise<string> {
  const t = await testRender(
    () => <App history={history} status="idle" model="deepseek-v4.1-flash" />,
    { width: 100, height: 16 },
  );
  await t.renderOnce();
  const f = t.captureCharFrame();
  await t.dispose();
  return f;
}

describeIfClient("App renders the assistant usage footer (Task #4396)", () => {
  test("renders cache hit rate and in/out tokens under the message", async () => {
    const history: HistoryItem[] = [
      { role: "user", content: "hello", id: "u1" },
      { role: "assistant", content: "world", id: "a1" },
      usageRow(CORE_USAGE, "u1f"),
    ];
    const frame = await frameOf(history);
    expect(frame).toContain("world");
    // 14720 / 14833 = 99.24% → 99.2%
    expect(frame).toContain("99.2%");
    expect(frame).toContain("in 113");
    expect(frame).toContain("out 2");
  });

  test("text-separates the footer from the assistant body (own line)", async () => {
    const history: HistoryItem[] = [
      { role: "assistant", content: "reply", id: "a1" },
      usageRow(CORE_USAGE, "a1f"),
    ];
    const frame = await frameOf(history);
    const lines = frame.split("\n");
    const bodyIdx = lines.findIndex((l) => l.includes("reply"));
    const footerIdx = lines.findIndex((l) => l.includes("99.2%"));
    expect(bodyIdx).toBeGreaterThanOrEqual(0);
    expect(footerIdx).toBeGreaterThan(bodyIdx);
  });

  test("a footer appended after the assistant row is painted (append semantics)", async () => {
    // Ink's <Static> never repaints a committed row, so the footer must be a
    // NEW item. The Solid chain commits rows into the scrollback one at a
    // time (`writeSolidToScrollback`), so the equivalent guard is: a history
    // that CONTAINS the usage row shows the footer, while the same history
    // WITHOUT it shows nothing. The Ink original additionally used
    // `rerender()` to append it — the opentui test renderer has no re-render
    // API, so this port asserts the two states separately.
    const base: HistoryItem[] = [
      { role: "assistant", content: "para one", id: "a1" },
    ];
    expect(await frameOf(base)).not.toContain("99.2%");
    expect(await frameOf([...base, usageRow(CORE_USAGE, "a1f")])).toContain("99.2%");
  });

  test("renders no footer when the provider reported no usage", async () => {
    const history: HistoryItem[] = [
      { role: "assistant", content: "plain reply", id: "a1" },
    ];
    const frame = await frameOf(history);
    expect(frame).toContain("plain reply");
    expect(frame).not.toContain("cache");
    expect(frame).not.toContain("NaN");
  });

  test("each assistant message carries its own footer", async () => {
    const history: HistoryItem[] = [
      { role: "assistant", content: "first", id: "a1" },
      usageRow(
        {
          promptTokens: 10,
          completionTokens: 1,
          cacheRead: 1000,
          cacheWrite: 0,
          promptTokensTotal: 1010,
        },
        "a1f",
      ),
      { role: "assistant", content: "second", id: "a2" },
      usageRow(
        {
          promptTokens: 20,
          completionTokens: 2,
          cacheRead: 500,
          cacheWrite: 0,
          promptTokensTotal: 520,
        },
        "a2f",
      ),
    ];
    const frame = await frameOf(history);
    expect(frame).toContain("99.0%"); // 1000/1010
    expect(frame).toContain("96.2%"); // 500/520
  });
});

describe("App usage footer (opentui/solid) — runtime gate", () => {
  it("reports WHY the suite is skipped under the SSR build", () => {
    // eslint-disable-next-line no-console
    console.log(
      `[片5] solid-reactive=${SOLID_REACTIVE} ` +
        `=> App.usage-footer suite ${SOLID_REACTIVE ? "RUN" : `SKIPPED: ${SSR_SKIP_REASON}`}`,
    );
    expect(typeof SOLID_REACTIVE).toBe("boolean");
  });
});
