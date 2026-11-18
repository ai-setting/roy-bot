/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview App tests — **opentui/solid** edition (Task #4679 片5).
 *
 * 1:1 port of the 18 Ink assertions in `tui/App.test.tsx`. The Ink file is
 * **untouched** — it still guards the live Ink chain (`ChatTui.tsx` →
 * `tui/App.tsx`).
 *
 * Recipe (docs/tui-opentui-migration-plan.md §7.1):
 *   `render(<C/>)` → `await testRender(() => <C/>, {width,height})`
 *   `lastFrame()`  → `await t.renderOnce(); t.captureCharFrame()`
 *   `unmount()`    → `await t.dispose()`
 */

import { describe, it, expect } from "bun:test";
import { testRender } from "@opentui/solid";
import { App } from "./App.js";
import type { HistoryItem } from "./App.js";
import {
  isSolidReactive,
  SSR_SKIP_REASON,
} from "./test-utils/solid-test-env.js";

/**
 * `App` uses `<Show>` / `<For>`; under the SSR build of solid-js opentui's
 * reconciler rejects the fallback branch (`Orphan text error`). Gate on the
 * **measured** client-runtime probe so the skip is visible, never silent.
 */
const SOLID_REACTIVE = isSolidReactive();
const describeIfClient = SOLID_REACTIVE ? describe : describe.skip;

/** Render `App` headlessly and return its captured frame. */
async function frame(props: {
  history: HistoryItem[];
  status: "idle" | "thinking" | "streaming";
  model?: string;
  workdir?: string;
  tokenCount?: number;
  streamingText?: string;
  liveTools?: Array<{
    name: string;
    args?: Record<string, unknown>;
    status: string;
    output?: string;
  }>;
}): Promise<string> {
  const t = await testRender(() => <App {...props} />, { width: 100, height: 20 });
  await t.renderOnce();
  const f = t.captureCharFrame();
  await t.dispose();
  return f;
}

describeIfClient("App (opentui/solid)", () => {
  const emptyHistory: HistoryItem[] = [];

  it("renders with no history without crashing", async () => {
    expect(await frame({ history: emptyHistory, status: "idle" })).toBeDefined();
  });

  it("displays a header banner", async () => {
    expect(await frame({ history: emptyHistory, status: "idle" })).toContain("Roy Agent");
  });

  it("renders user messages in history", async () => {
    const history: HistoryItem[] = [{ role: "user", content: "What is 2+2?" }];
    expect(await frame({ history, status: "idle" })).toContain("What is 2+2?");
  });

  it("renders assistant messages in history", async () => {
    const history: HistoryItem[] = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello, world!" },
    ];
    const f = await frame({ history, status: "idle" });
    expect(f).toContain("Hi");
    expect(f).toContain("Hello, world!");
  });

  it("distinguishes user vs assistant visually with role prefixes", async () => {
    const history: HistoryItem[] = [
      { role: "user", content: "user-msg" },
      { role: "assistant", content: "assistant-msg" },
    ];
    const f = await frame({ history, status: "idle" });
    // Task #4994 (P4): role labels are plain text (You / Agent)
    // — the emoji glyphs are gone.
    expect(f).toContain("You");
    expect(f).toContain("Agent");
    expect(f).toContain("user-msg");
    expect(f).toContain("assistant-msg");
  });

  it("renders markdown in assistant messages", async () => {
    const history: HistoryItem[] = [
      { role: "assistant", content: "# Title\n\nSome **bold** text." },
    ];
    const f = await frame({ history, status: "idle" });
    expect(f).toContain("Title");
    expect(f).toContain("Some");
    expect(f).toContain("bold");
  });

  it("shows thinking status with Spinner when status=thinking", async () => {
    const f = await frame({ history: emptyHistory, status: "thinking" });
    expect(f.toLowerCase()).toMatch(/thinking/);
  });

  it("shows streaming status when status=streaming", async () => {
    const f = await frame({ history: emptyHistory, status: "streaming" });
    expect(f.toLowerCase()).toMatch(/generating|working/);
  });

  it("renders streamingText when status=streaming and text provided", async () => {
    const f = await frame({
      history: emptyHistory,
      status: "streaming",
      streamingText: "streaming partial answer",
    });
    expect(f).toContain("streaming partial answer");
  });

  it("does not show Spinner when status=idle", async () => {
    const f = await frame({ history: emptyHistory, status: "idle" });
    expect(f.toLowerCase()).not.toMatch(/thinking|generating/);
  });

  it("displays current model in status bar", async () => {
    const f = await frame({
      history: emptyHistory,
      status: "idle",
      model: "openai/gpt-4o",
    });
    expect(f).toContain("openai/gpt-4o");
  });

  it("displays workdir in status bar when provided", async () => {
    const f = await frame({
      history: emptyHistory,
      status: "idle",
      workdir: "/tmp/test-workdir",
    });
    expect(f).toContain("/tmp/test-workdir");
  });

  it("displays token count in status bar when provided", async () => {
    const f = await frame({
      history: emptyHistory,
      status: "idle",
      tokenCount: 1234,
    });
    expect(f).toContain("1234");
  });

  it("renders multiple messages in order", async () => {
    const history: HistoryItem[] = [
      { role: "user", content: "first-user" },
      { role: "assistant", content: "first-assistant" },
      { role: "user", content: "second-user" },
      { role: "assistant", content: "second-assistant" },
    ];
    const f = await frame({ history, status: "idle" });
    expect(f).toContain("first-user");
    expect(f).toContain("first-assistant");
    expect(f).toContain("second-user");
    expect(f).toContain("second-assistant");
    // order: first-user < first-assistant < second-user < second-assistant
    expect(f.indexOf("first-user")).toBeLessThan(f.indexOf("first-assistant"));
    expect(f.indexOf("first-assistant")).toBeLessThan(f.indexOf("second-user"));
    expect(f.indexOf("second-user")).toBeLessThan(f.indexOf("second-assistant"));
  });

  it("renders tool messages in history with appropriate prefix", async () => {
    const history: HistoryItem[] = [
      { role: "user", content: "list files" },
      { role: "tool", content: "ls: file1.txt file2.txt" },
      { role: "assistant", content: "I found 2 files." },
    ];
    const f = await frame({ history, status: "idle" });
    expect(f).toContain("list files");
    expect(f).toContain("file1.txt");
    expect(f).toContain("I found 2 files.");
    // Task #4994 (P4): tool label is plain text.
    expect(f).toContain("Tool");
  });

  it("renders structured tool rows as a ToolCall card (Task #4124)", async () => {
    const history: HistoryItem[] = [
      {
        role: "tool",
        content: "",
        id: "h1",
        tool: {
          name: "bash",
          args: { command: "ls" },
          status: "completed",
          output: "file1.txt",
        },
      },
    ];
    const f = await frame({ history, status: "idle" });
    expect(f).toContain("Bash");
    expect(f).toContain("ls");
    expect(f).toContain("✓");
    expect(f).toContain("file1.txt");
  });

  it("renders live tool cards in the dynamic region (Task #4124)", async () => {
    const f = await frame({
      history: [],
      status: "streaming",
      liveTools: [
        { name: "glob", args: { pattern: "**/*.ts" }, status: "running" },
      ],
    });
    expect(f).toContain("Glob");
    expect(f).toContain("**/*.ts");
    expect(f).toContain("running");
  });

  it("renders empty content gracefully", async () => {
    const history: HistoryItem[] = [
      { role: "user", content: "" },
      { role: "assistant", content: "" },
    ];
    expect(await frame({ history, status: "idle" })).toBeDefined();
  });
});

describe("App (opentui/solid) — runtime gate", () => {
  it("reports WHY the suite is skipped under the SSR build", () => {
    // eslint-disable-next-line no-console
    console.log(
      `[片5] solid-reactive=${SOLID_REACTIVE} ` +
        `=> App suite ${SOLID_REACTIVE ? "RUN" : `SKIPPED: ${SSR_SKIP_REASON}`}`,
    );
    expect(typeof SOLID_REACTIVE).toBe("boolean");
  });
});
