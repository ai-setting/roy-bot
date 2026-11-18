/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview Static append semantics — **opentui/solid** edition
 * (Task #4679 片5).
 *
 * Ports the single assertion of `tui/static-rerender-repro.test.tsx`
 * (Task #4396). The Ink file is **untouched**.
 *
 * ## What the original pinned, and what the Solid chain does instead
 *
 * Ink's `<Static>` only ever **appends** — a committed row is never
 * repainted. The Ink test documents the resulting hard constraint: patching
 * `usage` onto an already-rendered assistant row renders **nothing**, so the
 * footer must be emitted as its OWN history item.
 *
 * The Solid chain satisfies the same constraint by construction, and more
 * strongly: `tui-solid/RunScreen.tsx` commits each row into the scrollback
 * via `writeSolidToScrollback` (write-once), so a row is never patched
 * either. The usage footer is committed as its own `role: "usage"` row whose
 * `content` is the pre-formatted `formatUsageFooter(usage)` string.
 *
 * The opentui test renderer exposes **no re-render API**, so the "patch, then
 * re-render" sequence cannot be reproduced literally. This port asserts the
 * equivalent invariant through the two states that the chain can produce:
 *
 *   - a history WITHOUT a usage row shows no footer;
 *   - a history WITH an appended usage row shows the footer.
 *
 * The second point is what the original test was protecting: the footer must
 * arrive as a **new item**, never as a patch onto an existing one.
 */

import { describe, test, expect } from "bun:test";
import { testRender } from "@opentui/solid";
import { App, type HistoryItem } from "./App.js";
import { formatUsageFooter, type UsageLike } from "../tui/usage-format.js";
import {
  isSolidReactive,
  SSR_SKIP_REASON,
} from "./test-utils/solid-test-env.js";

const SOLID_REACTIVE = isSolidReactive();
const describeIfClient = SOLID_REACTIVE ? describe : describe.skip;

const USAGE: UsageLike = {
  promptTokens: 113,
  completionTokens: 2,
  cacheRead: 14720,
  cacheWrite: 0,
  promptTokensTotal: 14833,
};

/** Mount `App` headlessly and return its captured frame. */
async function frameOf(history: HistoryItem[]): Promise<string> {
  const t = await testRender(() => <App history={history} status="idle" />, {
    width: 100,
    height: 16,
  });
  await t.renderOnce();
  const f = t.captureCharFrame();
  await t.dispose();
  return f;
}

describeIfClient("Static append semantics (Task #4396)", () => {
  test("the usage footer only appears when it is committed as its own row (fresh mount — the opentui test renderer has no re-render API)", async () => {
    const base: HistoryItem[] = [
      { role: "assistant", content: "para one", id: "a1" },
    ];

    // State 1 — the assistant row, without a footer row.
    const withoutFooter = await frameOf(base);
    expect(withoutFooter).toContain("para one");
    expect(withoutFooter).not.toContain("99.2%");

    // State 2 — the footer arrives as a NEW item (never as a patch onto the
    // committed assistant row). `RunScreen.tsx` formats the usage text
    // upstream via `formatUsageFooter` and commits it as `role: "usage"`.
    const appended: HistoryItem[] = [
      ...base,
      {
        role: "usage",
        content: formatUsageFooter(USAGE) ?? "",
        id: "a1f",
      },
    ];
    expect(await frameOf(appended)).toContain("99.2%");
  });
});

describe("Static append semantics (opentui/solid) — runtime gate", () => {
  test("reports WHY the suite is skipped under the SSR build", () => {
    // eslint-disable-next-line no-console
    console.log(
      `[片5] solid-reactive=${SOLID_REACTIVE} ` +
        `=> static-rerender-repro suite ${SOLID_REACTIVE ? "RUN" : `SKIPPED: ${SSR_SKIP_REASON}`}`,
    );
    expect(typeof SOLID_REACTIVE).toBe("boolean");
  });
});
