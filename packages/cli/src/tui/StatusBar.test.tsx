/**
 * @fileoverview Tests for StatusBar (Ink footer status line).
 *
 * Task #2610 stage 2: verify the footer renders model / workdir /
 * tokenCount gracefully when each prop is provided or omitted.
 */

import { describe, it, expect } from "bun:test";
import { isParallelRun } from "../test-utils/parallel-guard";
import { render } from "ink-testing-library";
import React from "react";
import { StatusBar } from "./StatusBar.js";

describe.skipIf(isParallelRun)("StatusBar", () => {
  it("renders without crashing when no props provided", () => {
    const { lastFrame } = render(<StatusBar />);
    expect(lastFrame()).toBeDefined();
  });

  it("shows model when provided", () => {
    const { lastFrame } = render(<StatusBar model="openai/gpt-4o" />);
    expect(lastFrame()).toContain("openai/gpt-4o");
  });

  it("shows workdir when provided", () => {
    const { lastFrame } = render(<StatusBar workdir="/tmp/test" />);
    expect(lastFrame()).toContain("/tmp/test");
  });

  it("shows token count when provided", () => {
    const { lastFrame } = render(<StatusBar tokenCount={1234} />);
    expect(lastFrame()).toContain("1234");
  });

  it("hides token count when not provided", () => {
    const { lastFrame } = render(<StatusBar />);
    expect(lastFrame()).not.toContain("tokens:");
  });

  it("shows exit hint", () => {
    const { lastFrame } = render(<StatusBar />);
    expect(lastFrame() ?? "").toMatch(/Ctrl\+C/i);
  });

  it("renders all props together without crashing", () => {
    const { lastFrame } = render(
      <StatusBar
        model="openai/gpt-4o"
        workdir="/tmp/proj"
        tokenCount={42}
      />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("openai/gpt-4o");
    expect(frame).toContain("/tmp/proj");
    expect(frame).toContain("42");
  });
});