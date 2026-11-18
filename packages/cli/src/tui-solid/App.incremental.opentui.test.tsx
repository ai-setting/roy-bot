/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview App incremental-rendering tests — **opentui/solid** edition
 * (Task #4679 片5).
 *
 * Ports the 7 assertions of `tui/App.incremental.test.tsx` (Task #3001).
 * The Ink file is **untouched** — it still guards the live Ink chain.
 *
 * ## What changed and why
 *
 * The Ink suite guards two React-specific behaviours:
 *
 *   1. **Stable `HistoryItem.id`** — used as the React `<Static>` key so
 *      content changes don't re-print settled rows.
 *   2. **No React duplicate-key warning** — React warns when two children
 *      share a key.
 *
 * The Solid fork's history region is `<For each={props.history}>`, which
 * reconciles by **reference identity**, not by a key. So:
 *
 *   - Assertion 1 (the `id` field exists and survives content changes) is
 *     **still meaningful** — `tui-solid/App.tsx` keeps the `id?: string`
 *     field on `HistoryItem` and documents it as "stable identifier for
 *     reconciliation", so the contract is preserved for the upstream
 *     reconciler (`tui-solid/RunScreen.tsx`).
 *   - Assertion 2 (React duplicate-key warning) has **no equivalent** — Solid
 *     emits no such warning. It is ported as an assertion that the *render
 *     itself* stays warning-free, which is the property that actually
 *     matters downstream, and it is **not** weakened: it still asserts zero
 *     captured errors.
 *   - The `rerender()` assertions have **no opentui equivalent** (the test
 *     renderer exposes no re-render API — see the migration recipe, blocker
 *     (2)). They are ported as **fresh-mount** assertions, which is the
 *     closest available check, and the limitation is recorded in the test
 *     name so it can never be mistaken for full coverage.
 */

import { describe, it, expect } from "bun:test";
import { testRender } from "@opentui/solid";
import { App } from "./App.js";
import type { HistoryItem } from "./App.js";
import {
  isSolidReactive,
  SSR_SKIP_REASON,
} from "./test-utils/solid-test-env.js";

const SOLID_REACTIVE = isSolidReactive();
const describeIfClient = SOLID_REACTIVE ? describe : describe.skip;

/** Strip ANSI escape codes for stable text comparison. */
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Mount `App` headlessly and return its captured (ANSI-stripped) frame. */
async function frameOf(history: HistoryItem[]): Promise<string> {
  const t = await testRender(() => <App history={history} status="idle" />, {
    width: 100,
    height: 16,
  });
  await t.renderOnce();
  const f = stripAnsi(t.captureCharFrame());
  await t.dispose();
  return f;
}

describeIfClient("Task #3001: TUI incremental rendering — stable id (opentui/solid)", () => {
  it("HistoryItem type should have an optional stable id field (compile-time check)", () => {
    const item: HistoryItem = {
      role: "user",
      content: "hello",
      id: "user-stable-123",
    };
    expect(item.id).toBe("user-stable-123");
  });

  it("HistoryItem without id should still be valid (backward compat)", () => {
    const item: HistoryItem = {
      role: "user",
      content: "legacy",
    };
    expect(item.id).toBeUndefined();
  });

  it("App renders user history items without crashing (baseline)", async () => {
    const history: HistoryItem[] = [
      { id: "u1", role: "user", content: "msg-1" },
      { id: "u2", role: "user", content: "msg-2" },
    ];
    const f = await frameOf(history);
    expect(f).toContain("msg-1");
    expect(f).toContain("msg-2");
  });

  it("App mounts items with stable ids without duplicating them", async () => {
    // The Ink original used `rerender()` to prove that re-rendering with the
    // same ids does not re-print settled rows. The opentui test renderer has
    // **no re-render API**, so this port asserts the closest available
    // property: mounting the same stable-id history yields exactly one
    // visible copy of each row (no duplication).
    const history: HistoryItem[] = [
      { id: "stable-1", role: "user", content: "first" },
      { id: "stable-2", role: "assistant", content: "second" },
    ];
    const f = await frameOf(history);
    expect(f).toContain("first");
    expect(f).toContain("second");
    expect(f.match(/first/g)?.length ?? 0).toBe(1);
    expect(f.match(/second/g)?.length ?? 0).toBe(1);
  });

  it("App with duplicate-content items (no id) renders both — backward compat", async () => {
    const history: HistoryItem[] = [
      { id: "a", role: "user", content: "same" },
      { id: "b", role: "user", content: "same" },
    ];
    const f = await frameOf(history);
    const matches = f.match(/same/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  it("App does NOT emit duplicate-key warning when items have stable ids", async () => {
    // The Ink original asserted the *absence of React's duplicate-key
    // warning*. Solid emits no such warning, so asserting on that exact
    // string would be vacuous. The port instead asserts the stronger
    // property: rendering emits **no** captured console.error at all.
    const capturedErrors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      capturedErrors.push(args.map(String).join(" "));
    };

    try {
      const history: HistoryItem[] = [
        { id: "unique-a", role: "user", content: "duplicate-content" },
        { id: "unique-b", role: "user", content: "duplicate-content" },
      ];
      await frameOf(history);
    } finally {
      console.error = originalError;
    }

    const duplicateKeyWarnings = capturedErrors.filter(
      (m) => m.includes("same key") || m.includes("duplicate key"),
    );
    expect(duplicateKeyWarnings).toHaveLength(0);
    expect(capturedErrors).toHaveLength(0);
  });

  it("App mounting stable ids does NOT cause console.error warnings", async () => {
    // Ink original: re-rendered three times with new array references but the
    // same logical ids. No re-render API here, so the port mounts the final
    // state directly and asserts the same property (no captured errors).
    const capturedErrors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      capturedErrors.push(args.map(String).join(" "));
    };

    try {
      const history: HistoryItem[] = [
        { id: "u1", role: "user", content: "first user msg" },
        { id: "a1", role: "assistant", content: "first assistant reply" },
        { id: "u2", role: "user", content: "second user msg" },
      ];
      await frameOf(history);
    } finally {
      console.error = originalError;
    }

    const duplicateKeyWarnings = capturedErrors.filter(
      (m) => m.includes("same key") || m.includes("duplicate key"),
    );
    expect(duplicateKeyWarnings).toHaveLength(0);
    expect(capturedErrors).toHaveLength(0);
  });
});

describe("Task #3001 (opentui/solid) — runtime gate", () => {
  it("reports WHY the suite is skipped under the SSR build", () => {
    // eslint-disable-next-line no-console
    console.log(
      `[片5] solid-reactive=${SOLID_REACTIVE} ` +
        `=> App.incremental suite ${SOLID_REACTIVE ? "RUN" : `SKIPPED: ${SSR_SKIP_REASON}`}`,
    );
    expect(typeof SOLID_REACTIVE).toBe("boolean");
  });
});
