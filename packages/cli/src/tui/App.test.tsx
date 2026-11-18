/**
 * @fileoverview Tests for App (Ink root composition component).
 *
 * Task #2610 stage 2.
 *
 * The App composes:
 *   - <Static> for completed messages (rendered once, never updated)
 *   - dynamic region for the streaming / thinking / idle state
 *   - <StatusBar> footer with model / workdir / exit hint
 *
 * Tests focus on rendering (composition is verified structurally, the
 * dynamic region depends on a real OsEnv instance covered by integration
 * tests).
 */

import { describe, it, expect } from "bun:test";
import { isParallelRun } from "../test-utils/parallel-guard";
import { render } from "ink-testing-library";
import React from "react";
import { App } from "./App.js";
import type { HistoryItem } from "./App.js";

describe.skipIf(isParallelRun)("App (Ink root)", () => {
  const emptyHistory: HistoryItem[] = [];

  it("renders with no history without crashing", () => {
    const { lastFrame } = render(
      <App history={emptyHistory} status="idle" />
    );
    expect(lastFrame()).toBeDefined();
  });

  it("displays a header banner", () => {
    const { lastFrame } = render(
      <App history={emptyHistory} status="idle" />
    );
    expect(lastFrame()).toContain("Roy Agent");
  });

  it("renders user messages in history", () => {
    const history: HistoryItem[] = [
      { role: "user", content: "What is 2+2?" },
    ];
    const { lastFrame } = render(<App history={history} status="idle" />);
    expect(lastFrame()).toContain("What is 2+2?");
  });

  it("renders assistant messages in history", () => {
    const history: HistoryItem[] = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello, world!" },
    ];
    const { lastFrame } = render(<App history={history} status="idle" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Hi");
    expect(frame).toContain("Hello, world!");
  });

  it("distinguishes user vs assistant visually with role prefixes", () => {
    const history: HistoryItem[] = [
      { role: "user", content: "user-msg" },
      { role: "assistant", content: "assistant-msg" },
    ];
    const { lastFrame } = render(<App history={history} status="idle" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("👤");
    expect(frame).toContain("🤖");
    expect(frame).toContain("user-msg");
    expect(frame).toContain("assistant-msg");
  });

  it("renders markdown in assistant messages", () => {
    const history: HistoryItem[] = [
      { role: "assistant", content: "# Title\n\nSome **bold** text." },
    ];
    const { lastFrame } = render(<App history={history} status="idle" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Title");
    expect(frame).toContain("Some");
    expect(frame).toContain("bold");
  });

  it("shows thinking status with Spinner when status=thinking", () => {
    const { lastFrame } = render(
      <App history={emptyHistory} status="thinking" />
    );
    const frame = lastFrame() ?? "";
    expect(frame.toLowerCase()).toMatch(/thinking/);
  });

  it("shows streaming status when status=streaming", () => {
    const { lastFrame } = render(
      <App history={emptyHistory} status="streaming" />
    );
    const frame = lastFrame() ?? "";
    expect(frame.toLowerCase()).toMatch(/generating|working/);
  });

  it("renders streamingText when status=streaming and text provided", () => {
    const { lastFrame } = render(
      <App
        history={emptyHistory}
        status="streaming"
        streamingText="streaming partial answer"
      />
    );
    expect(lastFrame()).toContain("streaming partial answer");
  });

  it("does not show Spinner when status=idle", () => {
    const { lastFrame } = render(
      <App history={emptyHistory} status="idle" />
    );
    const frame = lastFrame() ?? "";
    // No thinking/generating label in idle state
    expect(frame.toLowerCase()).not.toMatch(/thinking|generating/);
  });

  it("displays current model in status bar", () => {
    const { lastFrame } = render(
      <App
        history={emptyHistory}
        status="idle"
        model="openai/gpt-4o"
      />
    );
    expect(lastFrame()).toContain("openai/gpt-4o");
  });

  it("displays workdir in status bar when provided", () => {
    const { lastFrame } = render(
      <App
        history={emptyHistory}
        status="idle"
        workdir="/tmp/test-workdir"
      />
    );
    expect(lastFrame()).toContain("/tmp/test-workdir");
  });

  it("displays token count in status bar when provided", () => {
    const { lastFrame } = render(
      <App
        history={emptyHistory}
        status="idle"
        tokenCount={1234}
      />
    );
    expect(lastFrame()).toContain("1234");
  });

  it("renders multiple messages in order", () => {
    const history: HistoryItem[] = [
      { role: "user", content: "first-user" },
      { role: "assistant", content: "first-assistant" },
      { role: "user", content: "second-user" },
      { role: "assistant", content: "second-assistant" },
    ];
    const { lastFrame } = render(<App history={history} status="idle" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("first-user");
    expect(frame).toContain("first-assistant");
    expect(frame).toContain("second-user");
    expect(frame).toContain("second-assistant");
  });

  it("renders tool messages in history with appropriate prefix", () => {
    const history: HistoryItem[] = [
      { role: "user", content: "list files" },
      { role: "tool", content: "ls: file1.txt file2.txt" },
      { role: "assistant", content: "I found 2 files." },
    ];
    const { lastFrame } = render(<App history={history} status="idle" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("list files");
    expect(frame).toContain("file1.txt");
    expect(frame).toContain("I found 2 files.");
    expect(frame).toContain("🔧");
  });

  it("renders structured tool rows as a ToolCall card (Task #4124)", () => {
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
    const { lastFrame } = render(<App history={history} status="idle" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Bash");
    expect(frame).toContain("ls");
    expect(frame).toContain("✓");
    expect(frame).toContain("file1.txt");
  });

  it("renders live tool cards in the dynamic region (Task #4124)", () => {
    const { lastFrame } = render(
      <App
        history={[]}
        status="streaming"
        liveTools={[{ name: "glob", args: { pattern: "**/*.ts" }, status: "running" }]}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Glob");
    expect(frame).toContain("**/*.ts");
    expect(frame).toContain("running");
  });

  it("renders empty content gracefully", () => {
    const history: HistoryItem[] = [
      { role: "user", content: "" },
      { role: "assistant", content: "" },
    ];
    const { lastFrame } = render(<App history={history} status="idle" />);
    expect(lastFrame()).toBeDefined();
  });
});