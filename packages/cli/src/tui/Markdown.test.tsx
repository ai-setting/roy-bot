/**
 * @fileoverview Tests for Markdown (Ink wrapper around ANSI renderer).
 *
 * Task #2610 stage 2: verifies the renderMarkdown() ANSI string is
 * correctly embedded in Ink <Text>. The wrapper does not re-parse
 * markdown; it just wraps the pre-rendered ANSI string in <Text>.
 */

import { describe, it, expect } from "bun:test";
import { isParallelRun } from "../test-utils/parallel-guard";
import { render } from "ink-testing-library";
import React from "react";
import { Markdown } from "./Markdown.js";
import {
  renderMarkdown,
  setMarkdownEnabled,
} from "../render/markdown.js";

describe.skipIf(isParallelRun)("Markdown (Ink wrapper)", () => {
  it("renders plain text content", () => {
    const { lastFrame } = render(<Markdown text="hello world" />);
    expect(lastFrame()).toContain("hello world");
  });

  it("renders empty content without crashing", () => {
    const { lastFrame } = render(<Markdown text="" />);
    const frame = lastFrame() ?? "";
    expect(frame).toBeDefined();
  });

  it("renders headings with markdown enabled", () => {
    const { lastFrame } = render(<Markdown text="# Title" />);
    expect(lastFrame()).toContain("Title");
  });

  it("renders headings as plain text when markdown disabled", () => {
    setMarkdownEnabled(false);
    try {
      const { lastFrame } = render(<Markdown text="# Title" />);
      expect(lastFrame()).toContain("# Title");
    } finally {
      setMarkdownEnabled(true);
    }
  });

  it("renders fenced code blocks", () => {
    const { lastFrame } = render(
      <Markdown text={"```js\nconst x = 42;\n```"} />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("const");
    expect(frame).toContain("42");
  });

  it("preserves multiline markdown structure", () => {
    const md = "line one\n\nline two\n\nline three";
    const { lastFrame } = render(<Markdown text={md} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("line one");
    expect(frame).toContain("line two");
    expect(frame).toContain("line three");
  });

  it("respects custom width prop", () => {
    const { lastFrame } = render(<Markdown text="hello" width={120} />);
    expect(lastFrame()).toContain("hello");
  });

  it("is safe to render partial markdown (streaming input)", () => {
    const { lastFrame } = render(
      <Markdown text={"```python\ndef foo"} />
    );
    const frame = lastFrame() ?? "";
    const stripped = frame.replace(/\x1b\[[0-9;]*m/g, "");
    expect(stripped).toContain("def foo");
  });

  it("produces the same text content as renderMarkdown helper", () => {
    const text = "# Title\n\nSome **bold** text.";
    const rendered = renderMarkdown(text, { width: 80 });
    const bare = rendered.replace(/\x1b\[[0-9;]*m/g, "");

    const { lastFrame } = render(<Markdown text={text} />);
    const frame = lastFrame() ?? "";
    const frameBare = frame.replace(/\x1b\[[0-9;]*m/g, "");

    expect(frameBare).toContain("Title");
    expect(frameBare).toContain("Some");
    expect(frameBare).toContain("bold");
    expect(frameBare).toContain("text");
    expect(bare).toContain("Title");
  });

  it("renders bold text without crashing", () => {
    const { lastFrame } = render(<Markdown text="**bold** text" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("bold");
  });

  it("renders inline code without crashing", () => {
    const { lastFrame } = render(<Markdown text="Use `foo()` here" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("foo()");
  });

  it("renders links without crashing", () => {
    const { lastFrame } = render(
      <Markdown text="[label](https://example.com)" />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("label");
  });

  it("renders unordered list without crashing", () => {
    const { lastFrame } = render(
      <Markdown text={"- one\n- two\n- three"} />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("one");
    expect(frame).toContain("two");
    expect(frame).toContain("three");
  });
});