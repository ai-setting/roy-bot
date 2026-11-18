/**
 * @fileoverview Tests for formatMessageContent
 *
 * TDD: 测试所有 10 个截断点对 detail=true/false 的行为
 */

import { describe, test, expect } from "bun:test";
import type { SessionMessage } from "@ai-setting/roy-bot-core";
import {
  formatMessageContent,
  formatCheckpointContent,
} from "./format-message-content";

// ============================================================================
// Helper: build a text message with given content length
// ============================================================================
function makeTextMessage(content: string, opts: Partial<SessionMessage> = {}): SessionMessage {
  return {
    id: "msg-1",
    sessionID: "test",
    role: "assistant",
    content,
    timestamp: Date.now(),
    parts: [{ type: "text", content }],
    ...opts,
  } as SessionMessage;
}

function makePartsMessage(parts: any[], opts: Partial<SessionMessage> = {}): SessionMessage {
  return {
    id: "msg-1",
    sessionID: "test",
    role: "assistant",
    content: "",
    timestamp: Date.now(),
    parts,
    ...opts,
  } as SessionMessage;
}

function makeLongText(n: number): string {
  return "x".repeat(n);
}

// ============================================================================
// 1. Text part truncation (300 chars)
// ============================================================================
describe("formatMessageContent: text part", () => {
  test("truncates text part when detail=false and content > 300 chars", () => {
    const m = makeTextMessage(makeLongText(500));
    const lines = formatMessageContent(m, { detail: false });
    // Should contain "..." marker and the text should be truncated
    const joined = lines.join("\n");
    expect(joined).toContain("...");
    expect(joined.length).toBeLessThan(500);
  });

  test("does NOT truncate text part when detail=true and content > 300 chars", () => {
    const longText = makeLongText(500);
    const m = makeTextMessage(longText);
    const lines = formatMessageContent(m, { detail: true });
    const joined = lines.join("\n");
    expect(joined).not.toContain("..."); // no truncation marker
    expect(joined).toBe(longText);
  });

  test("does not add '...' when content is exactly at or under limit", () => {
    const m = makeTextMessage("short text");
    const lines = formatMessageContent(m, { detail: false });
    const joined = lines.join("\n");
    expect(joined).toBe("short text");
    expect(joined).not.toContain("...");
  });
});

// ============================================================================
// 2. tool-call args truncation (200 chars)
// ============================================================================
describe("formatMessageContent: tool-call args", () => {
  test("truncates tool-call args when detail=false and args > 200 chars", () => {
    const longArgs = "y".repeat(500);
    const m = makePartsMessage([
      { type: "tool-call", toolCallId: "c1", toolName: "bash", arguments: longArgs, state: "pending" },
    ]);
    const lines = formatMessageContent(m, { detail: false });
    const joined = lines.join("\n");
    expect(joined).toContain("[Tool Call] bash");
    expect(joined).toContain("...");
  });

  test("does NOT truncate tool-call args when detail=true", () => {
    const longArgs = "y".repeat(500);
    const m = makePartsMessage([
      { type: "tool-call", toolCallId: "c1", toolName: "bash", arguments: longArgs, state: "pending" },
    ]);
    const lines = formatMessageContent(m, { detail: true });
    const joined = lines.join("\n");
    expect(joined).toContain("[Tool Call] bash");
    expect(joined).toContain(longArgs);
  });

  test("handles tool-call with undefined arguments without throwing (detail=true)", () => {
    const m = makePartsMessage([
      { type: "tool-call", toolCallId: "c1", toolName: "bash", arguments: undefined, state: "pending" },
    ]);
    expect(() => formatMessageContent(m, { detail: true })).not.toThrow();
    const lines = formatMessageContent(m, { detail: true });
    expect(lines.join("\n")).toContain("[Tool Call] bash");
  });

  test("handles tool-call with object arguments", () => {
    const m = makePartsMessage([
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "write",
        arguments: { file: "foo.ts", content: "bar" },
        state: "pending",
      },
    ]);
    const lines = formatMessageContent(m, { detail: true });
    const joined = lines.join("\n");
    expect(joined).toContain("foo.ts");
    expect(joined).toContain("bar");
  });
});

// ============================================================================
// 3. tool-result output truncation (200 chars)
// ============================================================================
describe("formatMessageContent: tool-result output", () => {
  test("truncates tool-result output when detail=false", () => {
    const longOutput = "z".repeat(500);
    const m = makePartsMessage([
      { type: "tool-result", toolCallId: "c1", toolName: "bash", output: longOutput },
    ]);
    const lines = formatMessageContent(m, { detail: false });
    const joined = lines.join("\n");
    expect(joined).toContain("[Tool Result] bash");
    expect(joined).toContain("...");
  });

  test("does NOT truncate tool-result output when detail=true", () => {
    const longOutput = "z".repeat(500);
    const m = makePartsMessage([
      { type: "tool-result", toolCallId: "c1", toolName: "bash", output: longOutput },
    ]);
    const lines = formatMessageContent(m, { detail: true });
    const joined = lines.join("\n");
    expect(joined).toContain(longOutput);
  });
});

// ============================================================================
// 4. Reasoning part (5 lines)
// ============================================================================
describe("formatMessageContent: reasoning", () => {
  test("truncates reasoning to 5 lines when detail=false", () => {
    const manyLines = Array.from({ length: 20 }, (_, i) => `reason line ${i + 1}`).join("\n");
    const m = makePartsMessage([{ type: "reasoning", content: manyLines }]);
    const lines = formatMessageContent(m, { detail: false });
    const reasoningLines = lines.filter((l) => l.startsWith("reason line "));
    expect(reasoningLines.length).toBe(5);
  });

  test("does NOT truncate reasoning when detail=true", () => {
    const manyLines = Array.from({ length: 20 }, (_, i) => `reason line ${i + 1}`).join("\n");
    const m = makePartsMessage([{ type: "reasoning", content: manyLines }]);
    const lines = formatMessageContent(m, { detail: true });
    const reasoningLines = lines.filter((l) => l.startsWith("reason line "));
    expect(reasoningLines.length).toBe(20);
  });
});

// ============================================================================
// 5. workflow-node-call input values (50 chars/value)
// ============================================================================
describe("formatMessageContent: workflow-node-call input", () => {
  test("truncates input values when detail=false", () => {
    const longVal = "v".repeat(100);
    const m = makePartsMessage([
      {
        type: "workflow-node-call",
        nodeId: "n1",
        nodeType: "agent",
        input: { prompt: longVal, path: "/foo" },
      },
    ]);
    const lines = formatMessageContent(m, { detail: false });
    const joined = lines.join("\n");
    expect(joined).toContain("[Node Call]");
    // 'v' repeated 100 should be truncated to 50 chars in the value rendering
    // We expect NOT to see the full 100 'v's
    const matches = joined.match(/v+/g) || [];
    const longestV = matches.reduce((a, b) => (a.length > b.length ? a : b), "");
    expect(longestV.length).toBeLessThanOrEqual(50);
  });

  test("does NOT truncate input values when detail=true", () => {
    const longVal = "v".repeat(100);
    const m = makePartsMessage([
      {
        type: "workflow-node-call",
        nodeId: "n1",
        nodeType: "agent",
        input: { prompt: longVal },
      },
    ]);
    const lines = formatMessageContent(m, { detail: true });
    const joined = lines.join("\n");
    expect(joined).toContain(longVal);
  });
});

// ============================================================================
// 6. workflow-node-result output (200 chars / 5 lines)
// ============================================================================
describe("formatMessageContent: workflow-node-result", () => {
  test("truncates result output (200 chars / 5 lines) when detail=false", () => {
    const bigOutput = Array.from({ length: 20 }, (_, i) => `result line ${i + 1}`).join("\n");
    const m = makePartsMessage([
      { type: "workflow-node-result", nodeId: "n1", nodeType: "agent", output: bigOutput, durationMs: 100 },
    ]);
    const lines = formatMessageContent(m, { detail: false });
    const resultLines = lines.filter((l) => l.includes("result line "));
    expect(resultLines.length).toBeLessThanOrEqual(5);
  });

  test("does NOT truncate result output when detail=true", () => {
    const bigOutput = Array.from({ length: 20 }, (_, i) => `result line ${i + 1}`).join("\n");
    const m = makePartsMessage([
      { type: "workflow-node-result", nodeId: "n1", nodeType: "agent", output: bigOutput, durationMs: 100 },
    ]);
    const lines = formatMessageContent(m, { detail: true });
    const resultLines = lines.filter((l) => l.includes("result line "));
    expect(resultLines.length).toBe(20);
  });
});

// ============================================================================
// 7. workflow-node-end output (300 chars / 6 lines)
// ============================================================================
describe("formatMessageContent: workflow-node-end", () => {
  test("truncates end output (300 chars / 6 lines) when detail=false", () => {
    const bigOutput = Array.from({ length: 30 }, (_, i) => `end line ${i + 1}`).join("\n");
    const m = makePartsMessage([
      { type: "workflow-node-end", nodeId: "n1", output: bigOutput, durationMs: 100 },
    ]);
    const lines = formatMessageContent(m, { detail: false });
    const endLines = lines.filter((l) => l.includes("end line "));
    expect(endLines.length).toBeLessThanOrEqual(6);
  });

  test("does NOT truncate end output when detail=true", () => {
    const bigOutput = Array.from({ length: 30 }, (_, i) => `end line ${i + 1}`).join("\n");
    const m = makePartsMessage([
      { type: "workflow-node-end", nodeId: "n1", output: bigOutput, durationMs: 100 },
    ]);
    const lines = formatMessageContent(m, { detail: true });
    const endLines = lines.filter((l) => l.includes("end line "));
    expect(endLines.length).toBe(30);
  });
});

// ============================================================================
// 8. Legacy content (string-only, 200 chars)
// ============================================================================
describe("formatMessageContent: legacy content (string only)", () => {
  test("truncates legacy content when detail=false", () => {
    const m = makeTextMessage(makeLongText(500));
    // Force legacy mode: no parts
    (m as any).parts = undefined;
    const lines = formatMessageContent(m, { detail: false });
    const joined = lines.join("\n");
    expect(joined).toContain("...");
    expect(joined.length).toBeLessThan(500);
  });

  test("does NOT truncate legacy content when detail=true", () => {
    const longText = makeLongText(500);
    const m = makeTextMessage(longText);
    (m as any).parts = undefined;
    const lines = formatMessageContent(m, { detail: true });
    expect(lines.join("\n")).toBe(longText);
  });
});

// ============================================================================
// 9. Empty message handling
// ============================================================================
describe("formatMessageContent: empty messages", () => {
  test("returns ['(empty)'] for completely empty message", () => {
    const m: SessionMessage = {
      id: "empty",
      sessionID: "test",
      role: "user",
      content: "",
      timestamp: Date.now(),
    } as SessionMessage;
    const lines = formatMessageContent(m);
    expect(lines).toEqual(["(empty)"]);
  });

  test("returns ['(empty)'] for empty parts", () => {
    const m = makePartsMessage([]);
    const lines = formatMessageContent(m);
    expect(lines).toEqual(["(empty)"]);
  });
});

// ============================================================================
// 10. Checkpoint content (10 lines)
// ============================================================================
describe("formatCheckpointContent: checkpoint", () => {
  test("truncates to 10 lines + '\\n...' marker when detail=false", () => {
    const longContent = Array.from({ length: 30 }, (_, i) => `cp line ${i + 1}`).join("\n");
    const result = formatCheckpointContent(longContent, { detail: false });
    const lines = result.split("\n");
    // 10 cp lines + 1 trailing "..." line
    const cpLines = lines.filter((l) => l.startsWith("cp line "));
    expect(cpLines.length).toBe(10);
    expect(result).toContain("...");
  });

  test("does NOT truncate when detail=true", () => {
    const longContent = Array.from({ length: 30 }, (_, i) => `cp line ${i + 1}`).join("\n");
    const result = formatCheckpointContent(longContent, { detail: true });
    const lines = result.split("\n");
    const cpLines = lines.filter((l) => l.startsWith("cp line "));
    expect(cpLines.length).toBe(30);
    expect(result).not.toContain("...");
  });

  test("does not add '...' when under limit", () => {
    const content = "short\ncontent\nlines";
    const result = formatCheckpointContent(content, { detail: false });
    expect(result).toBe(content);
  });
});

// ============================================================================
// Backward compatibility: detail=undefined defaults to false
// ============================================================================
describe("formatMessageContent: default behavior", () => {
  test("truncates when opts is empty (detail defaults to false)", () => {
    const m = makeTextMessage(makeLongText(500));
    const lines = formatMessageContent(m); // no opts
    const joined = lines.join("\n");
    expect(joined).toContain("...");
  });

  test("truncates when opts.detail is explicitly false", () => {
    const m = makeTextMessage(makeLongText(500));
    const lines = formatMessageContent(m, { detail: false });
    const joined = lines.join("\n");
    expect(joined).toContain("...");
  });
});
