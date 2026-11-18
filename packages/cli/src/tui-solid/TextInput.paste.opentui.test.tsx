/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview Task #4954 P2 — TextInput **paste channel** behaviour
 * tests (the `.opentui` layer).
 *
 * Coverage: the paste event traverses opentui's REAL stdin parser
 * (`renderer.stdin.emit("data", …)` feeds the same StdinParser
 * the production renderer uses) so a bracketed paste
 * (`ESC[200~ … ESC[201~`) is recognized and delivered as a
 * PasteEvent. Assertions are **behavioural** (onSubmit received …),
 * following the house rule set by `RunScreen.interrupt.test.tsx`.
 *
 * ⚠️ The components MUST be mounted as the testRender root with the
 * same `describeIfClient` gate the interrupt suite uses — measured
 * (probe80/81): a bare root without the gate leaves `onMount` un-run,
 * so `usePaste` never registers (this cost probe2–82 to find).
 *
 * Run with `bun --conditions=browser test` (gate prints the skip).
 */

import { describe, expect, it } from "bun:test";
import { createEffect, createSignal } from "solid-js";
import { testRender } from "@opentui/solid";
import { TextInput } from "./TextInput.js";

function isSolidReactive(): boolean {
  const seen: number[] = [];
  const [n, setN] = createSignal(0);
  createEffect(() => {
    seen.push(n());
  });
  setN(1);
  return seen.length > 1;
}
const SOLID_REACTIVE = isSolidReactive();
const describeIfClient = SOLID_REACTIVE ? describe : describe.skip;

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

describeIfClient("TextInput paste channel (bracketed paste → input)", () => {
  it("submits the EXPANDED text of a folded multi-line paste", async () => {
    const submits: string[] = [];
    const t = await testRender(() => (
      <TextInput
        label="You"
        onSubmit={(v: string) => { submits.push(v); }}
      />
    ));
    await t.renderOnce();
    t.renderer.stdin.emit(
      "data",
      Buffer.from(PASTE_START + "alpha\nbeta\ngamma" + PASTE_END, "utf8"),
    );
    await new Promise((r) => setTimeout(r, 200));
    await t.flush();
    // no premature submit during paste
    expect(submits.length).toBe(0);
    // Enter submits the EXPANDED text (trailing space is the
    // placeholder separator we insert with the placeholder).
    t.mockInput.pressEnter();
    await t.flush();
    expect(submits.length).toBe(1);
    expect(submits[0]).toBe("alpha\nbeta\ngamma ");
    await t.dispose();
  });

  it("submits a SHORT paste verbatim (no fold, no expansion)", async () => {
    const submits: string[] = [];
    const t = await testRender(() => (
      <TextInput
        label="You"
        onSubmit={(v: string) => { submits.push(v); }}
      />
    ));
    await t.renderOnce();
    t.renderer.stdin.emit(
      "data",
      Buffer.from(PASTE_START + "short paste" + PASTE_END, "utf8"),
    );
    await new Promise((r) => setTimeout(r, 200));
    await t.flush();
    t.mockInput.pressEnter();
    await t.flush();
    expect(submits.length).toBe(1);
    expect(submits[0]).toBe("short paste");
    await t.dispose();
  });

  it("expands two folded pastes in the right order (left-to-right)", async () => {
    const submits: string[] = [];
    const t = await testRender(() => (
      <TextInput
        label="You"
        onSubmit={(v: string) => { submits.push(v); }}
      />
    ));
    await t.renderOnce();
    t.renderer.stdin.emit(
      "data",
      Buffer.from(PASTE_START + "first1\nfirst2\nfirst3" + PASTE_END, "utf8"),
    );
    await new Promise((r) => setTimeout(r, 150));
    t.renderer.stdin.emit(
      "data",
      Buffer.from(PASTE_START + "second1\nsecond2\nsecond3" + PASTE_END, "utf8"),
    );
    await new Promise((r) => setTimeout(r, 200));
    await t.flush();
    t.mockInput.pressEnter();
    await t.flush();
    expect(submits.length).toBe(1);
    expect(submits[0]).toBe(
      "first1\nfirst2\nfirst3 second1\nsecond2\nsecond3 ",
    );
    await t.dispose();
  });

  it("normalizes CRLF pastes (Windows ConPTY)", async () => {
    const submits: string[] = [];
    const t = await testRender(() => (
      <TextInput
        label="You"
        onSubmit={(v: string) => { submits.push(v); }}
      />
    ));
    await t.renderOnce();
    t.renderer.stdin.emit(
      "data",
      Buffer.from(PASTE_START + "w1\r\nw2\r\nw3" + PASTE_END, "utf8"),
    );
    await new Promise((r) => setTimeout(r, 200));
    await t.flush();
    t.mockInput.pressEnter();
    await t.flush();
    expect(submits.length).toBe(1);
    expect(submits[0]).toBe("w1\nw2\nw3 ");
    await t.dispose();
  });
});
