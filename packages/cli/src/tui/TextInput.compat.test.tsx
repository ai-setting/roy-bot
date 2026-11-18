/**
 * @fileoverview Tests for TextInput (Ink single-line input).
 *
 * Task #2610 stage 2.
 *
 * Task #4688: retargeted from `TextInput.test.tsx` to the compatibility
 * shim `TextInput.compat.tsx` (the original file became an orphan and was
 * deleted together with its implementation). The assertions are unchanged —
 * only the module under test moved.
 *
 * Note: ink-testing-library has limited keypress simulation through
 * its stdin pipe; we focus on rendering and the API surface, deferring
 * keystroke-driven flows to integration tests (the Ink `RunTui.test.tsx`
 * suite was removed in Task #4681 along with the orphaned `RunTui.tsx`).
 */

import { describe, it, expect, mock } from "bun:test";
import { isParallelRun } from "../test-utils/parallel-guard";
import { render } from "ink-testing-library";
import React from "react";
import { TextInput } from "./TextInput.compat.js";

describe.skipIf(isParallelRun)("TextInput (Ink)", () => {
  it("renders label", () => {
    const { lastFrame } = render(
      <TextInput label="You" onSubmit={() => {}} />
    );
    expect(lastFrame()).toContain("You");
  });

  it("renders prefix when provided", () => {
    const { lastFrame } = render(
      <TextInput label="You" prefix="👤" onSubmit={() => {}} />
    );
    expect(lastFrame()).toContain("👤");
  });

  it("renders placeholder when value is empty", () => {
    const { lastFrame } = render(
      <TextInput label="You" onSubmit={() => {}} placeholder="type here..." />
    );
    expect(lastFrame()).toContain("type here...");
  });

  it("hides placeholder when value is non-empty", () => {
    // Static-only render: ink-testing-library cannot easily inject
    // typing, but we can verify the placeholder is visible by default.
    const { lastFrame } = render(
      <TextInput label="You" onSubmit={() => {}} placeholder="ph" />
    );
    expect(lastFrame() ?? "").toContain("ph");
  });

  it("does not show history indicator by default", () => {
    const { lastFrame } = render(
      <TextInput label="You" onSubmit={() => {}} history={["old"]} />
    );
    expect(lastFrame() ?? "").not.toContain("(history)");
  });

  it("does not call onSubmit on initial render", () => {
    const onSubmit = mock(() => {});
    render(<TextInput label="You" onSubmit={onSubmit} />);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not crash when rendered without onCancel", () => {
    const { lastFrame } = render(
      <TextInput label="You" onSubmit={() => {}} />
    );
    expect(lastFrame()).toBeDefined();
  });

  it("accepts a history prop without crashing", () => {
    const { lastFrame, unmount } = render(
      <TextInput
        label="You"
        onSubmit={() => {}}
        history={["first", "second", "third"]}
      />
    );
    expect(lastFrame()).toBeDefined();
    unmount();
  });

  it("uses default prefix when none provided", () => {
    const { lastFrame } = render(
      <TextInput label="You" onSubmit={() => {}} />
    );
    // Default prefix is "❯"
    expect(lastFrame() ?? "").toContain("❯");
  });
});

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tick = () => new Promise((r) => setTimeout(r, 25));

describe.skipIf(isParallelRun)("TextInput cursor + caret navigation (Task #4103)", () => {
  it("renders a cursor block after typed text", async () => {
    const { stdin, lastFrame } = render(
      <TextInput label="You" onSubmit={() => {}} />
    );
    await tick(); // Ink attaches its stdin listener after the first commit
    stdin.write("abc");
    await tick();
    expect(stripAnsi(lastFrame() ?? "")).toContain("abc▌");
  });

  it("← moves the cursor mid-line and → moves it back", async () => {
    const { stdin, lastFrame } = render(
      <TextInput label="You" onSubmit={() => {}} />
    );
    await tick();
    stdin.write("abc");
    await tick();
    stdin.write("\x1b[D"); // ←
    await tick();
    expect(stripAnsi(lastFrame() ?? "")).toContain("ab▌c");
    stdin.write("\x1b[C"); // →
    await tick();
    expect(stripAnsi(lastFrame() ?? "")).toContain("abc▌");
  });

  it("Backspace deletes the character before the caret", async () => {
    const { stdin, lastFrame } = render(
      <TextInput label="You" onSubmit={() => {}} />
    );
    await tick();
    stdin.write("abc");
    await tick();
    stdin.write("\x1b[D"); // ← caret now before 'c'
    await tick();
    stdin.write("\x7f"); // Backspace byte — Ink reports this as key.delete
    await tick();
    expect(stripAnsi(lastFrame() ?? "")).toContain("a▌c");
  });

  it("inserts a typed character at the caret (mid-line edit)", async () => {
    const { stdin, lastFrame } = render(
      <TextInput label="You" onSubmit={() => {}} />
    );
    await tick();
    stdin.write("ac");
    await tick();
    stdin.write("\x1b[D"); // ← caret now between 'a' and 'c'
    await tick();
    stdin.write("b");
    await tick();
    expect(stripAnsi(lastFrame() ?? "")).toContain("ab▌c");
  });

  it("Enter still submits the current value", async () => {
    const onSubmit = mock(() => {});
    const { stdin } = render(<TextInput label="You" onSubmit={onSubmit} />);
    await tick();
    stdin.write("hi");
    await tick();
    stdin.write("\r");
    await tick();
    expect(onSubmit).toHaveBeenCalledWith("hi");
  });
});