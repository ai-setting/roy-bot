/**
 * @fileoverview Tests for ChatTui (one-shot Ink screen).
 *
 * Task #2610 stage 3.
 */

import { describe, it, expect } from "bun:test";
import { isParallelRun } from "./test-utils/parallel-guard";
import { render } from "ink-testing-library";
import React from "react";
import ChatScreen from "./ChatTui.js";

describe.skipIf(isParallelRun)("ChatTui (one-shot Ink screen)", () => {
  it("shows user message immediately", () => {
    const { lastFrame, unmount } = render(
      <ChatScreen
        handleQuery={async () => "fake reply"}
        message="hello"
        maxLines={500}
        markdownEnabled={true}
      />
    );
    expect(lastFrame() ?? "").toContain("hello");
    unmount();
  });

  it("shows thinking state initially", () => {
    const { lastFrame, unmount } = render(
      <ChatScreen
        handleQuery={async () => ""}
        message="test"
        maxLines={500}
        markdownEnabled={true}
      />
    );
    const frame = lastFrame() ?? "";
    expect(frame.toLowerCase()).toMatch(/thinking|generating/);
    unmount();
  });

  it("displays the model in the status bar when provided", () => {
    const { lastFrame, unmount } = render(
      <ChatScreen
        handleQuery={async () => ""}
        message="test"
        model="openai/gpt-4o"
        maxLines={500}
        markdownEnabled={true}
      />
    );
    expect(lastFrame() ?? "").toContain("openai/gpt-4o");
    unmount();
  });

  it("displays workdir in the status bar when provided", () => {
    const { lastFrame, unmount } = render(
      <ChatScreen
        handleQuery={async () => ""}
        message="test"
        workdir="/tmp/chat-test"
        maxLines={500}
        markdownEnabled={true}
      />
    );
    expect(lastFrame() ?? "").toContain("/tmp/chat-test");
    unmount();
  });

  it("accepts markdownEnabled=false without crashing", () => {
    const { lastFrame, unmount } = render(
      <ChatScreen
        handleQuery={async () => ""}
        message="test"
        maxLines={500}
        markdownEnabled={false}
      />
    );
    expect(lastFrame() ?? "").toBeDefined();
    unmount();
  });

  it("accepts maxLines=0 (no truncation) without crashing", () => {
    const { lastFrame, unmount } = render(
      <ChatScreen
        handleQuery={async () => ""}
        message="test"
        maxLines={0}
        markdownEnabled={true}
      />
    );
    expect(lastFrame() ?? "").toBeDefined();
    unmount();
  });

  it("renders with no model and no workdir without crashing", () => {
    const { lastFrame, unmount } = render(
      <ChatScreen
        handleQuery={async () => ""}
        message="hi"
        maxLines={500}
        markdownEnabled={true}
      />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("hi");
    unmount();
  });
});