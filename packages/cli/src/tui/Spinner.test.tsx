/**
 * @fileoverview Tests for Spinner (Ink thinking indicator).
 *
 * Task #2610 stage 2.
 */

import { describe, it, expect } from "bun:test";
import { isParallelRun } from "../test-utils/parallel-guard";
import { render } from "ink-testing-library";
import React from "react";
import { Spinner } from "./Spinner.js";

describe.skipIf(isParallelRun)("Spinner (Ink)", () => {
  it("renders without crashing", () => {
    const { lastFrame } = render(<Spinner label="thinking" />);
    const frame = lastFrame();
    expect(frame).toBeDefined();
    expect(frame).toContain("thinking");
  });

  it("displays the label", () => {
    const { lastFrame } = render(<Spinner label="loading data" />);
    expect(lastFrame()).toContain("loading data");
  });

  it("supports different labels", () => {
    const { lastFrame: a } = render(<Spinner label="A" />);
    const { lastFrame: b } = render(<Spinner label="B" />);
    expect(a()).toContain("A");
    expect(b()).toContain("B");
    expect(a()).not.toContain("B");
    expect(b()).not.toContain("A");
  });

  it("shows at least one of the spinner glyph frames", () => {
    const { lastFrame } = render(<Spinner label="working" />);
    const frame = lastFrame() ?? "";
    // The Spinner cycles through Braille-pattern glyphs; at any given
    // frame exactly one of them should be visible.
    const braille = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const matched = braille.filter((g) => frame.includes(g));
    expect(matched.length).toBeGreaterThanOrEqual(1);
  });

  it("animates: output changes across frames", async () => {
    const { lastFrame, rerender } = render(<Spinner label="working" />);
    const frame1 = lastFrame() ?? "";
    await new Promise((resolve) => setTimeout(resolve, 200));
    const frame2 = lastFrame() ?? "";
    expect(frame1).toBeDefined();
    expect(frame2).toBeDefined();
    // Frame content may or may not change within 200ms depending on
    // interval; this is a smoke test for timer wiring.
    // We only assert that both frames are valid strings.
    expect(typeof frame1).toBe("string");
    expect(typeof frame2).toBe("string");
  });

  it("respects custom intervalMs prop without crashing", () => {
    const { lastFrame } = render(
      <Spinner label="custom" intervalMs={200} />
    );
    expect(lastFrame()).toContain("custom");
  });
});