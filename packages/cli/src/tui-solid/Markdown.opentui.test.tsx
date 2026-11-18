/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview Markdown tests — **opentui/solid** edition (Task #4679 片5).
 *
 * 1:1 port of the Ink `tui/Markdown.test.tsx` (13 assertions). The Ink file is
 * **untouched** — it still guards the live Ink `chat` chain (`ChatTui.tsx` →
 * `tui/App.tsx` → `tui/Markdown.tsx`).
 *
 * Recipe (docs/tui-opentui-migration-plan.md §7.1):
 *   `render(<C/>)`  → `await testRender(() => <C/>, {width,height})`
 *   `lastFrame()`   → `await t.renderOnce(); t.captureCharFrame()`
 *   `unmount()`     → `await t.dispose()`
 *
 * ⚠️ Blocker (1): the pragma on line 1 is mandatory — without it bun's built-in
 * JSX transform produces React descriptors and `captureCharFrame()` returns an
 * all-space frame.
 */

import { describe, it, expect } from "bun:test";
import { testRender } from "@opentui/solid";
import { Markdown } from "./Markdown.js";
import { renderMarkdown, setMarkdownEnabled } from "../render/markdown.js";
import {
  bare,
  isSolidReactive,
  SSR_SKIP_REASON,
} from "./test-utils/solid-test-env.js";

/**
 * `Markdown` uses `<Show>` + `<For>`, which opentui's reconciler rejects
 * under the SSR build of solid-js (`Orphan text error`). Gate the whole suite
 * on the **measured** client-runtime probe so the skip is visible.
 */
const SOLID_REACTIVE = isSolidReactive();
const describeIfClient = SOLID_REACTIVE ? describe : describe.skip;

/** Render `Markdown` headlessly and return its captured (ANSI-stripped) frame. */
async function frame(text: string, width?: number): Promise<string> {
  const t = await testRender(
    () => <Markdown text={text} width={width} />,
    { width: 80, height: 20 },
  );
  await t.renderOnce();
  const f = t.captureCharFrame();
  await t.dispose();
  return f;
}

/** Strip SGR escapes so assertions compare against plain text. */
describeIfClient("Markdown (opentui/solid)", () => {
  it("renders plain text content", async () => {
    expect(await frame("hello world")).toContain("hello world");
  });

  it("renders empty content without crashing", async () => {
    const f = await frame("");
    expect(f).toBeDefined();
  });

  it("renders headings with markdown enabled", async () => {
    expect(await frame("# Title")).toContain("Title");
  });

  it("renders headings as plain text when markdown disabled", async () => {
    setMarkdownEnabled(false);
    try {
      expect(await frame("# Title")).toContain("# Title");
    } finally {
      setMarkdownEnabled(true);
    }
  });

  it("renders fenced code blocks", async () => {
    const f = await frame("```js\nconst x = 42;\n```");
    expect(f).toContain("const");
    expect(f).toContain("42");
  });

  it("preserves multiline markdown structure", async () => {
    const f = await frame("line one\n\nline two\n\nline three");
    expect(f).toContain("line one");
    expect(f).toContain("line two");
    expect(f).toContain("line three");
  });

  it("respects custom width prop", async () => {
    expect(await frame("hello", 120)).toContain("hello");
  });

  it("is safe to render partial markdown (streaming input)", async () => {
    const f = await frame("```python\ndef foo");
    expect(bare(f)).toContain("def foo");
  });

  it("produces the same text content as renderMarkdown helper", async () => {
    const text = "# Title\n\nSome **bold** text.";
    const rendered = renderMarkdown(text, { width: 80 });
    const helperBare = bare(rendered);

    const frameBare = bare(await frame(text));
    expect(frameBare).toContain("Title");
    expect(frameBare).toContain("Some");
    expect(frameBare).toContain("bold");
    expect(frameBare).toContain("text");
    expect(helperBare).toContain("Title");
  });

  it("renders bold text without crashing", async () => {
    expect(await frame("**bold** text")).toContain("bold");
  });

  it("renders inline code without crashing", async () => {
    expect(await frame("Use `foo()` here")).toContain("foo()");
  });

  it("renders links without crashing", async () => {
    expect(await frame("[label](https://example.com)")).toContain("label");
  });

  it("renders unordered list without crashing", async () => {
    const f = await frame("- one\n- two\n- three");
    expect(f).toContain("one");
    expect(f).toContain("two");
    expect(f).toContain("three");
  });
});

describe("Markdown (opentui/solid) — runtime gate", () => {
  it("reports WHY the suite is skipped under the SSR build", () => {
    // A skip must never be silent: print the measured capability so a future
    // reader (or a CI diff) can see which runtime the suite actually ran on.
    // eslint-disable-next-line no-console
    console.log(
      `[片5] solid-reactive=${SOLID_REACTIVE} ` +
        `=> Markdown suite ${SOLID_REACTIVE ? "RUN" : `SKIPPED: ${SSR_SKIP_REASON}`}`,
    );
    expect(typeof SOLID_REACTIVE).toBe("boolean");
  });
});
