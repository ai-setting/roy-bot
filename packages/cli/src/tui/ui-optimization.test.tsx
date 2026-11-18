/**
 * @fileoverview Regression tests for the Task #4103 "run TUI" layout bugs.
 *
 * Covers the two *layout* defects reported by the user:
 *   1. A large empty GAP below the header — caused by a `flexGrow` spacer
 *      (plus `minHeight={20}`) that inflated the frame when there was no
 *      history to fill it.
 *   3. A vertical "jump" + blank on stream completion — same spacer: when
 *      the dynamic (streaming) region collapsed, the spacer re-expanded and
 *      shifted the output.
 *
 * The third reported bug (missing input cursor) is covered by
 * `TextInput.compat.test.tsx` and `text-input-editing.test.ts`.
 *
 * These are genuine regression tests: restoring the flexGrow spacer (or
 * `minHeight={20}`) in App.tsx makes the Bug-1 tests fail.
 */

import { describe, it, expect } from "bun:test";
import { isParallelRun } from "../test-utils/parallel-guard";
import { render } from "ink-testing-library";
import React from "react";
import { App, type HistoryItem } from "./App.js";

function blankRun(frame: string): number {
  // Longest run of consecutive newlines (proxy for blank rows).
  let max = 0;
  for (const m of frame.matchAll(/\n+/g)) {
    if (m[0].length > max) max = m[0].length;
  }
  return max;
}

describe.skipIf(isParallelRun)("TUI layout regression (Task #4103)", () => {
  describe("Bug 1 — oversized GAP below the header", () => {
    it("empty history + idle: no oversized blank region and a compact frame", () => {
      const { lastFrame } = render(
        <App history={[]} status="idle" model="m" workdir="/tmp" />,
      );
      const frame = lastFrame() ?? "";
      // No run of 6+ blank rows, and the whole frame stays small.
      expect(blankRun(frame)).toBeLessThan(6);
      expect(frame.split("\n").length).toBeLessThan(12);
    });

    it("header and status bar are adjacent (gap not viewport-sized)", () => {
      const { lastFrame } = render(
        <App history={[]} status="idle" model="m" workdir="/tmp" />,
      );
      const lines = (lastFrame() ?? "").split("\n");
      const headerIdx = lines.findIndex((l) => l.includes("Roy Agent"));
      const statusIdx = lines.findIndex((l) => l.includes("Ctrl+C to exit"));
      // Both markers MUST exist — otherwise the assertion below would be
      // skipped and the test would pass vacuously.
      expect(headerIdx).toBeGreaterThanOrEqual(0);
      expect(statusIdx).toBeGreaterThanOrEqual(0);
      expect(statusIdx - headerIdx).toBeLessThan(8);
    });
  });

  describe("Bug 3 — jump / blank on stream completion", () => {
    it("streaming with text renders it exactly once without a blank explosion", () => {
      const { lastFrame } = render(
        <App
          history={[]}
          status="streaming"
          streamingText="hello stream"
          model="m"
          workdir="/tmp"
        />,
      );
      const frame = lastFrame() ?? "";
      expect(frame.split("hello stream").length - 1).toBe(1);
      expect(blankRun(frame)).toBeLessThan(6);
    });

    it("idle after finish shows the finalized history row once and no spinner", () => {
      const history: HistoryItem[] = [
        { role: "assistant", content: "done response", id: "h1" },
      ];
      const { lastFrame } = render(
        <App history={history} status="idle" model="m" workdir="/tmp" />,
      );
      const frame = lastFrame() ?? "";
      expect(frame.split("done response").length - 1).toBe(1);
      // No leftover dynamic spinner once the stream is finished.
      expect(frame).not.toContain("Generating response");
      expect(blankRun(frame)).toBeLessThan(6);
    });
  });

  describe("Streamed-message grouping (Task #4123)", () => {
    it("shows the 🤖 Agent heading once for a message split into continuation blocks", () => {
      const history: HistoryItem[] = [
        { role: "assistant", content: "para one", id: "h1" },
        { role: "assistant", content: "para two", id: "h2", continuation: true },
        { role: "assistant", content: "para three", id: "h3", continuation: true },
      ];
      const { lastFrame } = render(
        <App history={history} status="idle" model="m" workdir="/tmp" />,
      );
      const frame = lastFrame() ?? "";
      // One logical reply → exactly one role heading.
      expect(frame.split("🤖 Agent").length - 1).toBe(1);
      expect(frame).toContain("para one");
      expect(frame).toContain("para two");
      expect(frame).toContain("para three");
    });
  });
});
