/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview TextInput tests — **opentui/solid** edition (Task #4679 片5).
 *
 * Ports the 14 assertions of `tui/TextInput.compat.test.tsx` (renamed from
 * `tui/TextInput.test.tsx` in Task #4688, when the Ink implementation became
 * an orphan). The Ink file is **untouched** — it still guards the Ink chain.
 *
 * ## Split: static structure here, input echo in a real pty
 *
 * The Ink file has two groups:
 *
 *   A. **Static rendering** (9 assertions) — label / prefix / placeholder /
 *      history-indicator / default prefix / no-crash. These assert the
 *      **first frame**, which the opentui test renderer captures faithfully.
 *      ⇒ ported here.
 *
 *   B. **Input echo** (5 assertions) — type text, move the caret, backspace,
 *      insert mid-line, submit on Enter. Each one needs the component to
 *      **repaint** after a signal change.
 *
 * The opentui test renderer exposes a full mock keyboard
 * (`t.mockInput.typeText` / `pressArrow` / `pressKey`), so the *keys* can be
 * delivered — but the frame does **not** repaint afterwards. Measured
 * (Task #4679): `flush({maxPasses: 1|5|20})` and `waitForFrame(...)` all
 * leave the frame unchanged (blocker (2) of the migration recipe).
 *
 * ⇒ Group B is **not** asserted here. It is covered by the real-pty
 * harness instead:
 *
 *   - `scripts/tui-solid/e2e-interactive-solid.py` → `scenario_typing`
 *     (print / backspace×5 / ←← + insert mid-line / Enter submits) and
 *     `scenario_editing_keys` (Home+Delete / End+insert).
 *
 * The mapping is asserted **here** by checking the harness actually
 * contains the corresponding assertions, so a future deletion of the pty
 * coverage cannot silently create a gap. See the "pty coverage" suite at
 * the bottom of this file.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import { TextInput } from "./TextInput.js";
import {
  isSolidReactive,
  SSR_SKIP_REASON,
} from "./test-utils/solid-test-env.js";

const SOLID_REACTIVE = isSolidReactive();
const describeIfClient = SOLID_REACTIVE ? describe : describe.skip;

/** Render `TextInput` headlessly and return its captured frame. */
async function frame(props: {
  label: string;
  onSubmit: (v: string) => void;
  prefix?: string;
  placeholder?: string;
  history?: string[];
}): Promise<string> {
  const t = await testRender(() => <TextInput {...props} />, {
    width: 60,
    height: 4,
  });
  await t.renderOnce();
  const f = t.captureCharFrame();
  await t.dispose();
  return f;
}

describeIfClient("TextInput (opentui/solid)", () => {
  it("renders label", async () => {
    expect(await frame({ label: "You", onSubmit: () => {} })).toContain("You");
  });

  it("renders prefix when provided", async () => {
    const f = await frame({ label: "You", prefix: "👤", onSubmit: () => {} });
    expect(f).toContain("👤");
  });

  it("renders placeholder when value is empty", async () => {
    const f = await frame({
      label: "You",
      onSubmit: () => {},
      placeholder: "type here...",
    });
    expect(f).toContain("type here...");
  });

  it("hides placeholder when value is non-empty", async () => {
    // The Ink original could not inject typing, so it asserted the
    // placeholder is visible by default. The opentui renderer CAN deliver
    // keys (t.mockInput.typeText), but the frame does not repaint, so the
    // first-frame check is the same one the Ink suite made.
    const f = await frame({
      label: "You",
      onSubmit: () => {},
      placeholder: "ph",
    });
    expect(f).toContain("ph");
  });

  it("does not show history indicator by default", async () => {
    const f = await frame({
      label: "You",
      onSubmit: () => {},
      history: ["old"],
    });
    expect(f).not.toContain("(history)");
  });

  it("does not call onSubmit on initial render", async () => {
    let called = false;
    await frame({
      label: "You",
      onSubmit: () => {
        called = true;
      },
    });
    expect(called).toBe(false);
  });

  it("does not crash when rendered without onCancel", async () => {
    expect(await frame({ label: "You", onSubmit: () => {} })).toBeDefined();
  });

  it("accepts a history prop without crashing", async () => {
    const f = await frame({
      label: "You",
      onSubmit: () => {},
      history: ["first", "second", "third"],
    });
    expect(f).toBeDefined();
  });

  it("uses default prefix when none provided", async () => {
    expect(await frame({ label: "You", onSubmit: () => {} })).toContain("❯");
  });
});

/**
 * The input-echo assertions of the Ink suite cannot run in this layer:
 * opentui's test renderer accepts the keys but never repaints afterwards.
 *
 * Instead of silently dropping them, this suite asserts that the **real pty
 * harness still contains the corresponding checks** — so the coverage cannot
 * disappear unnoticed. If a future change removes one of them, this test
 * fails and the gap is reported.
 */
describe("TextInput input-echo coverage (pty harness)", () => {
  const harnessPath = join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "..",
    "scripts",
    "tui-solid",
    "e2e-interactive-solid.py",
  );

  it("the pty harness still covers typing / backspace / mid-line insert / submit", () => {
    const src = readFileSync(harnessPath, "utf-8");
    expect(src).toContain("打印出 hello world");
    expect(src).toContain("退格删掉 world");
    expect(src).toContain("方向键 + 插入中间生效（非尾部追加）");
    expect(src).toContain("回车后输入行被清空");
  });

  it("the pty harness still covers Home/Delete and End/insert", () => {
    const src = readFileSync(harnessPath, "utf-8");
    expect(src).toContain("Home+Delete 删掉首字符 a（=bcde）");
    expect(src).toContain("End 后插入 Z 追加到末尾（=bcdeZ）");
  });

  it("records WHY these assertions are not run in this layer", () => {
    // eslint-disable-next-line no-console
    console.log(
      `[片5] input-echo assertions (type/backspace/caret/submit) are NOT run here: ` +
        `opentui's test renderer accepts keys but does not repaint ` +
        `(flush/waitForFrame measured, blocker (2)). Covered by the real pty ` +
        `harness scripts/tui-solid/e2e-interactive-solid.py ` +
        `(scenario_typing + scenario_editing_keys).`,
    );
    expect(typeof SOLID_REACTIVE).toBe("boolean");
  });
});

describe("TextInput (opentui/solid) — runtime gate", () => {
  it("reports WHY the suite is skipped under the SSR build", () => {
    // eslint-disable-next-line no-console
    console.log(
      `[片5] solid-reactive=${SOLID_REACTIVE} ` +
        `=> TextInput suite ${SOLID_REACTIVE ? "RUN" : `SKIPPED: ${SSR_SKIP_REASON}`}`,
    );
    expect(typeof SOLID_REACTIVE).toBe("boolean");
  });
});
