/**
 * Task #4396 — pinned constraint discovered during cross-validation.
 *
 * Ink's <Static> only ever APPENDS: a row already committed is never
 * repainted. This test documents that hard constraint so nobody "simplifies"
 * the usage footer back into a `usage` property patched onto an existing
 * assistant row — that approach silently renders nothing.
 *
 * The implementation therefore emits the footer as its OWN history item
 * (`role: "usage"`), appended once the turn's text is settled.
 */
import { describe, test, expect } from "bun:test";
import { isParallelRun } from "../test-utils/parallel-guard";
import { render } from "ink-testing-library";
import React from "react";
import { App, type HistoryItem } from "./App.js";

const USAGE = {
  promptTokens: 113,
  completionTokens: 2,
  cacheRead: 14720,
  cacheWrite: 0,
  promptTokensTotal: 14833,
};

describe.skipIf(isParallelRun)("Static re-render semantics (Task #4396)", () => {
  test("patching usage onto an already-rendered assistant row renders nothing", () => {
    const base: HistoryItem[] = [
      { role: "assistant", content: "para one", id: "a1" },
    ];
    const { lastFrame, rerender } = render(
      <App history={base} status="idle" />,
    );
    expect(lastFrame() ?? "").toContain("para one");
    expect(lastFrame() ?? "").not.toContain("99.2%");

    // Patch the committed row in place — the tempting but broken approach.
    const patched: HistoryItem[] = [
      { role: "assistant", content: "para one", id: "a1", usage: USAGE },
    ];
    rerender(<App history={patched} status="idle" />);

    // Documents the constraint: Ink did NOT repaint the row, so no footer.
    expect(lastFrame() ?? "").not.toContain("99.2%");

    // Appending a NEW item does paint (this is what the implementation does).
    rerender(
      <App
        history={[
          ...patched,
          { role: "usage", content: "", id: "a1f", usage: USAGE },
        ]}
        status="idle"
      />,
    );
    expect(lastFrame() ?? "").toContain("99.2%");
  });
});
