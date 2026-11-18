/**
 * @fileoverview Tests for StatusBar compact mode (Task #4160).
 */

import { describe, it, expect } from "bun:test";
import { isParallelRun } from "../test-utils/parallel-guard";
import { render } from "ink-testing-library";
import React from "react";
import { StatusBar, type StatusBarProps } from "./StatusBar.js";

function renderStatusBar(props: StatusBarProps & { columns: number }) {
  const { columns, ...rest } = props;
  return render(<StatusBar {...rest} columns={columns} />);
}

const FULL_PROPS: StatusBarProps = {
  model: "openai/gpt-4o",
  workdir: "/home/user/projects/roy-bot",
  tokenCount: 1234,
};

describe.skipIf(isParallelRun)("StatusBar compact mode (Task #4160)", () => {
  it("renders as a single line (no border)", () => {
    const { lastFrame } = renderStatusBar({ ...FULL_PROPS, columns: 120 });
    const frame = lastFrame() ?? "";
    expect(frame).not.toMatch(/[\u2500\u2502\u250C\u2510\u2514\u2518\u251C\u2524\u252C\u2534\u253C]/);
    const lines = frame.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
  });

  it("uses ' · ' as separator between segments", () => {
    const { lastFrame } = renderStatusBar({ ...FULL_PROPS, columns: 120 });
    expect(lastFrame() ?? "").toContain(" \u00b7 ");
  });

  it("abbreviates tokens label to 'n='", () => {
    const { lastFrame } = renderStatusBar({ ...FULL_PROPS, columns: 120 });
    expect(lastFrame() ?? "").toContain("n=1234");
    expect(lastFrame() ?? "").not.toContain("tokens:");
  });

  it("renders all 4 segments when wide (>=80)", () => {
    const { lastFrame } = renderStatusBar({ ...FULL_PROPS, columns: 120 });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("openai/gpt-4o");
    expect(frame).toContain("/home/user/projects/roy-bot");
    expect(frame).toContain("n=1234");
    expect(frame).toMatch(/Ctrl\+C/i);
  });

  it("drops exit hint at 60-79 columns", () => {
    const { lastFrame } = renderStatusBar({ ...FULL_PROPS, columns: 70 });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("openai/gpt-4o");
    expect(frame).toContain("/home/user/projects/roy-bot");
    expect(frame).toContain("n=1234");
    expect(frame).not.toMatch(/Ctrl\+C/i);
  });

  it("drops workdir at 40-59 columns", () => {
    const { lastFrame } = renderStatusBar({ ...FULL_PROPS, columns: 50 });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("openai/gpt-4o");
    expect(frame).toContain("n=1234");
    expect(frame).not.toContain("/home/user/projects/roy-bot");
    expect(frame).not.toMatch(/Ctrl\+C/i);
  });

  it("keeps only model at <40 columns", () => {
    const { lastFrame } = renderStatusBar({ ...FULL_PROPS, columns: 30 });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("openai/gpt-4o");
    expect(frame).not.toContain("n=1234");
    expect(frame).not.toContain("/home/user/projects/roy-bot");
    expect(frame).not.toMatch(/Ctrl\+C/i);
  });

  it("truncates long workdirs to ~30 chars max with ellipsis", () => {
    const longPath =
      "~/work/codework/personal/roy_world/roy-bot/.worktrees/feat-run-ui-opencode";
    const { lastFrame } = renderStatusBar({
      model: "openai/gpt-4o",
      workdir: longPath,
      columns: 120,
    });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("\u2026");
    expect(frame).not.toContain(longPath);
    expect(frame).toContain("feat-run-ui-opencode");
  });

  it("renders without crashing when no props are given and width is 0", () => {
    const { lastFrame } = renderStatusBar({ columns: 0 });
    expect(lastFrame()).toBeDefined();
  });

  it("renders without crashing when only model is given", () => {
    const { lastFrame } = renderStatusBar({ model: "x", columns: 120 });
    expect(lastFrame() ?? "").toContain("x");
  });

  it("renders without crashing when only tokens is given", () => {
    const { lastFrame } = renderStatusBar({ tokenCount: 0, columns: 120 });
    expect(lastFrame() ?? "").toContain("n=0");
  });
});
