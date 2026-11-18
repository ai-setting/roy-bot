/**
 * @fileoverview Rendering tests for the opencode-style <ToolCall> card
 * (Task #4124).
 */

import { describe, it, expect } from "bun:test";
import { isParallelRun } from "../test-utils/parallel-guard";
import { render } from "ink-testing-library";
import React from "react";
import { ToolCall } from "./ToolCall.js";
import type { ToolCallInfo } from "./tool-call.js";

function frameOf(info: ToolCallInfo, showOutput?: boolean): string {
  const { lastFrame, unmount } = render(
    <ToolCall info={info} showOutput={showOutput} />
  );
  const frame = lastFrame() ?? "";
  unmount();
  return frame;
}

describe.skipIf(isParallelRun)("ToolCall card", () => {
  it("renders the humanised tool name and primary arg", () => {
    const frame = frameOf({
      name: "bash",
      args: { command: "ls -la" },
      status: "completed",
      output: "file1.txt",
    });
    expect(frame).toContain("Bash");
    expect(frame).toContain("ls -la");
  });

  it("shows a ✓ and duration for a completed call", () => {
    const frame = frameOf({
      name: "read_file",
      args: { file_path: "/a.ts" },
      status: "completed",
      output: "contents",
      durationMs: 320,
    });
    expect(frame).toContain("✓");
    expect(frame).toContain("320ms");
    expect(frame).toContain("contents");
  });

  it("shows a ✗ and the error text for a failed call", () => {
    const frame = frameOf({
      name: "bash",
      args: { command: "boom" },
      status: "error",
      error: "command not found",
    });
    expect(frame).toContain("✗");
    expect(frame).toContain("command not found");
  });

  it("shows a running indicator (and no ✓) while executing", () => {
    const frame = frameOf({
      name: "glob",
      args: { pattern: "**/*.ts" },
      status: "running",
    });
    expect(frame).toContain("Glob");
    expect(frame).toContain("**/*.ts");
    expect(frame).toContain("running");
    expect(frame).not.toContain("✓");
  });

  it("hides the output preview when showOutput=false", () => {
    const frame = frameOf(
      {
        name: "bash",
        args: { command: "ls" },
        status: "completed",
        output: "SECRET_OUTPUT",
      },
      false
    );
    expect(frame).toContain("Bash");
    expect(frame).not.toContain("SECRET_OUTPUT");
  });

  it("renders an icon for known tools", () => {
    const frame = frameOf({
      name: "read_file",
      args: { file_path: "a" },
      status: "completed",
    });
    expect(frame).toContain("📖");
  });
});
