/**
 * @fileoverview Unit tests for the tool-call presentation model (Task #4124).
 *
 * These are pure-function tests (no Ink / React) covering:
 *   - humanizeToolName
 *   - describeToolCall (icon/label/arg extraction + fallbacks)
 *   - stringifyToolOutput (string / { output } envelope / JSON)
 *   - formatToolOutput (line + char truncation, "+N more lines")
 *   - formatDuration
 */

import { describe, it, expect } from "bun:test";
import {
  describeToolCall,
  formatDuration,
  formatToolOutput,
  humanizeToolName,
  stringifyToolOutput,
} from "./tool-call.js";

describe("humanizeToolName", () => {
  it("snake_case → Title Case", () => {
    expect(humanizeToolName("read_file")).toBe("Read File");
  });

  it("kebab-case → Title Case", () => {
    expect(humanizeToolName("query-background-process")).toBe(
      "Query Background Process"
    );
  });

  it("camelCase → Title Case", () => {
    expect(humanizeToolName("delegateTask")).toBe("Delegate Task");
  });

  it("returns a fallback for empty input", () => {
    expect(humanizeToolName("")).toBe("Tool");
  });
});

describe("describeToolCall", () => {
  it("uses the tool metadata (icon + label) for known tools", () => {
    const d = describeToolCall("bash", { command: "ls -la" });
    expect(d.icon).toBe("❯");
    expect(d.label).toBe("Bash");
    expect(d.detail).toBe("ls -la");
  });

  it("extracts the primary arg by priority key (read_file → file_path)", () => {
    const d = describeToolCall("read_file", { file_path: "/tmp/a.ts" });
    expect(d.label).toBe("Read");
    expect(d.detail).toBe("/tmp/a.ts");
  });

  it("falls back to the first string arg when no priority key matches", () => {
    const d = describeToolCall("read_file", { offset: 10, path: "/x/y" });
    expect(d.detail).toBe("/x/y");
  });

  it("resolves aliases (read → Read)", () => {
    const d = describeToolCall("read", { path: "a.txt" });
    expect(d.label).toBe("Read");
    expect(d.detail).toBe("a.txt");
  });

  it("falls back to a generic marker for unknown tools", () => {
    const d = describeToolCall("some_new_tool", { foo: "bar" });
    expect(d.icon).toBe("⚙");
    expect(d.label).toBe("Some New Tool");
    expect(d.detail).toBe("bar");
  });

  it("collapses multi-line args to a single line", () => {
    const d = describeToolCall("bash", { command: "echo a\necho b" });
    expect(d.detail).toBe("echo a");
  });

  it("returns an empty detail when there are no usable args", () => {
    expect(describeToolCall("glob", {}).detail).toBe("");
    expect(describeToolCall("glob").detail).toBe("");
  });
});

describe("stringifyToolOutput", () => {
  it("returns strings as-is", () => {
    expect(stringifyToolOutput("hello")).toBe("hello");
  });

  it("unwraps the { output } envelope", () => {
    expect(stringifyToolOutput({ output: "cmd output" })).toBe("cmd output");
  });

  it("pretty-prints arbitrary JSON", () => {
    expect(stringifyToolOutput({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it("returns '' for null / undefined", () => {
    expect(stringifyToolOutput(null)).toBe("");
    expect(stringifyToolOutput(undefined)).toBe("");
  });
});

describe("formatToolOutput", () => {
  it("keeps short output intact", () => {
    expect(formatToolOutput("line1\nline2")).toBe("line1\nline2");
  });

  it("truncates beyond maxLines and reports the hidden count", () => {
    const out = formatToolOutput(
      Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n"),
      { maxLines: 5 }
    );
    expect(out.split("\n")).toHaveLength(6); // 5 lines + marker
    expect(out).toContain("… (+15 more lines)");
    expect(out).not.toContain("l5");
  });

  it("clamps very long lines to maxChars", () => {
    const out = formatToolOutput("x".repeat(500), { maxChars: 20 });
    expect(out.length).toBeLessThanOrEqual(21);
    expect(out.endsWith("…")).toBe(true);
  });

  it("handles the { output } envelope", () => {
    expect(formatToolOutput({ output: "abc" })).toBe("abc");
  });
});

describe("formatDuration", () => {
  it("formats sub-second durations as ms", () => {
    expect(formatDuration(250)).toBe("250ms");
  });

  it("formats seconds with one decimal under 10s", () => {
    expect(formatDuration(3200)).toBe("3.2s");
  });

  it("formats whole seconds without a decimal", () => {
    expect(formatDuration(12000)).toBe("12s");
  });

  it("formats minutes", () => {
    expect(formatDuration(65000)).toBe("1m05s");
  });

  it("returns '' for invalid input", () => {
    expect(formatDuration(Number.NaN)).toBe("");
    expect(formatDuration(-5)).toBe("");
  });
});
