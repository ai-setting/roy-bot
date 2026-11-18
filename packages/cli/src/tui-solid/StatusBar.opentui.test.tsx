/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview StatusBar tests — **opentui/solid** edition (Task #4679 片5).
 *
 * Merges the two Ink sources into one opentui file:
 *   - `tui/StatusBar.test.tsx`          →  7 assertions (basic props)
 *   - `tui/StatusBar.compact.test.tsx`  → 11 assertions (compact/responsive)
 *
 * Both Ink files are **untouched** — they still guard the live Ink chain
 * (`repl-ink.tsx` / `ChatTui.tsx` → `tui/StatusBar.tsx`).
 *
 * Recipe (docs/tui-opentui-migration-plan.md §7.1):
 *   `render(<C/>)` → `await testRender(() => <C/>, {width,height})`
 *   `lastFrame()`  → `await t.renderOnce(); t.captureCharFrame()`
 *   `unmount()`    → `await t.dispose()`
 */

import { describe, it, expect } from "bun:test";
import { testRender } from "@opentui/solid";
import { StatusBar, type StatusBarProps } from "./StatusBar.js";
import {
  isSolidReactive,
  SSR_SKIP_REASON,
} from "./test-utils/solid-test-env.js";

/**
 * `StatusBar` uses `<For>`; under the SSR build of solid-js opentui's
 * reconciler rejects the fallback branch (`Orphan text error`). Gate on the
 * **measured** client-runtime probe so the skip is visible, never silent.
 */
const SOLID_REACTIVE = isSolidReactive();
const describeIfClient = SOLID_REACTIVE ? describe : describe.skip;

/**
 * Render `StatusBar` headlessly and return its captured frame.
 *
 * The `columns` prop is the width hint the Ink version used to drive the
 * compact layout; opentui's own layout width is passed separately via
 * `testRender({width})` so both the explicit hint and the real render width
 * agree.
 */
async function frame(props: StatusBarProps & { columns?: number }): Promise<string> {
  const { columns, ...rest } = props;
  const t = await testRender(() => <StatusBar {...rest} columns={columns} />, {
    width: columns ?? 120,
    height: 4,
  });
  await t.renderOnce();
  const f = t.captureCharFrame();
  await t.dispose();
  return f;
}

describeIfClient("StatusBar (opentui/solid)", () => {
  it("renders without crashing when no props provided", async () => {
    expect(await frame({})).toBeDefined();
  });

  it("shows model when provided", async () => {
    expect(await frame({ model: "openai/gpt-4o" })).toContain("openai/gpt-4o");
  });

  it("shows workdir when provided", async () => {
    expect(await frame({ workdir: "/tmp/test" })).toContain("/tmp/test");
  });

  it("shows token count when provided", async () => {
    expect(await frame({ tokenCount: 1234 })).toContain("1234");
  });

  it("hides token count when not provided", async () => {
    expect(await frame({})).not.toContain("tokens:");
  });

  it("shows hint only when provided (P1: single hint source)", async () => {
    // ★ Task #4954 P1：硬编码 "Ctrl+C to exit" 退役；
    //   hint 由调用方传（RunScreen 按 stream.status）。
    expect(await frame({})).not.toMatch(/Ctrl\+C/i);
    expect(await frame({ hint: "ctrl+c exit" })).toMatch(/ctrl\+C exit/i);
  });

  it("renders all props together without crashing", async () => {
    const f = await frame({
      model: "openai/gpt-4o",
      workdir: "/tmp/proj",
      tokenCount: 42,
    });
    expect(f).toContain("openai/gpt-4o");
    expect(f).toContain("/tmp/proj");
    expect(f).toContain("42");
  });
});

describeIfClient("StatusBar compact mode (Task #4160)", () => {
  const FULL_PROPS: StatusBarProps = {
    model: "openai/gpt-4o",
    workdir: "/home/user/projects/roy-bot",
    tokenCount: 1234,
  };

  it("renders as a single line (no border)", async () => {
    const f = await frame({ ...FULL_PROPS, columns: 120 });
    expect(f).not.toMatch(/[─│┌┐└┘├┤┬┴┼]/);
    // The Ink version counted non-empty lines, because Ink's `lastFrame()`
    // trims trailing blank rows. opentui's `captureCharFrame()` returns the
    // **full frame**, padded to the render height — so the equivalent check
    // is "rows that contain anything but whitespace". The intent (the status
    // bar occupies exactly one visual line) is preserved.
    const lines = f.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(1);
  });

  it("uses ' · ' as separator between segments", async () => {
    expect(await frame({ ...FULL_PROPS, columns: 120 })).toContain(" · ");
  });

  it("abbreviates tokens label to 'n='", async () => {
    const f = await frame({ ...FULL_PROPS, columns: 120 });
    expect(f).toContain("n=1234");
    expect(f).not.toContain("tokens:");
  });

  it("renders all segments when wide (>=80, P1: +status/hint)", async () => {
    const f = await frame({
      ...FULL_PROPS,
      status: "Build",
      hint: "ctrl+c exit",
      columns: 120,
    });
    expect(f).toContain("Build");
    expect(f).toContain("ctrl+c exit");
    expect(f).toContain("openai/gpt-4o");
    expect(f).toContain("/home/user/projects/roy-bot");
    expect(f).toContain("n=1234");
    expect(f).toMatch(/Ctrl\+C/i);
  });

  it("drops exit hint at 60-79 columns", async () => {
    const f = await frame({ ...FULL_PROPS, columns: 70 });
    expect(f).toContain("openai/gpt-4o");
    expect(f).toContain("/home/user/projects/roy-bot");
    expect(f).toContain("n=1234");
    expect(f).not.toMatch(/Ctrl\+C/i);
  });

  it("drops workdir at 40-59 columns", async () => {
    const f = await frame({ ...FULL_PROPS, columns: 50 });
    expect(f).toContain("openai/gpt-4o");
    expect(f).toContain("n=1234");
    expect(f).not.toContain("/home/user/projects/roy-bot");
    expect(f).not.toMatch(/Ctrl\+C/i);
  });

  it("keeps only model at <40 columns", async () => {
    const f = await frame({ ...FULL_PROPS, columns: 30 });
    expect(f).toContain("openai/gpt-4o");
    expect(f).not.toContain("n=1234");
    expect(f).not.toContain("/home/user/projects/roy-bot");
    expect(f).not.toMatch(/Ctrl\+C/i);
  });

  it("truncates long workdirs to ~30 chars max with ellipsis", async () => {
    const longPath =
      "~/work/codework/personal/roy_world/roy-bot/.worktrees/feat-run-ui-opencode";
    const f = await frame({ model: "openai/gpt-4o", workdir: longPath, columns: 120 });
    expect(f).toContain("…");
    expect(f).not.toContain(longPath);
    expect(f).toContain("feat-run-ui-opencode");
  });

  it("renders without crashing when no props are given and width is 0", async () => {
    expect(await frame({ columns: 0 })).toBeDefined();
  });

  it("renders without crashing when only model is given", async () => {
    expect(await frame({ model: "x", columns: 120 })).toContain("x");
  });

  it("renders without crashing when only tokens is given", async () => {
    expect(await frame({ tokenCount: 0, columns: 120 })).toContain("n=0");
  });
});

describe("StatusBar (opentui/solid) — runtime gate", () => {
  it("reports WHY the suite is skipped under the SSR build", () => {
    // eslint-disable-next-line no-console
    console.log(
      `[片5] solid-reactive=${SOLID_REACTIVE} ` +
        `=> StatusBar suite ${SOLID_REACTIVE ? "RUN" : `SKIPPED: ${SSR_SKIP_REASON}`}`,
    );
    expect(typeof SOLID_REACTIVE).toBe("boolean");
  });
});
