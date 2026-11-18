/**
 * @fileoverview TDD for orphan tool-call repair helper (Task #4992).
 *
 * RED phase: these tests must FAIL before the helper exists.
 */

import { describe, test, expect } from "bun:test";
import {
  findOrphanToolCalls,
  repairOrphanToolCalls,
  repairOrphanSdkMessages,
  ORPHAN_PLACEHOLDER_PREFIX,
} from "./orphan-toolcall";
import { convertToSDKMessages } from "./invoke";
import { convertToLanguageModelPrompt } from "ai/internal";
import type { ModelMessage } from "ai";
import type { LLMMessage } from "./types";

function assistantWithCalls(
  calls: Array<{ id: string; name: string }>,
  text = "working on it",
): LLMMessage {
  return {
    role: "assistant",
    content: text,
    toolCalls: calls.map((c) => ({
      id: c.id,
      name: c.name,
      arguments: "{}",
      function: { name: c.name, arguments: "{}" },
    })),
  };
}

function toolResult(id: string, name = "bash", output = '{"ok":true}'): LLMMessage {
  return { role: "tool", content: output, toolCallId: id, name };
}

describe("findOrphanToolCalls", () => {
  test("no orphans in a healthy paired history", () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "do something" },
      assistantWithCalls([{ id: "call_1", name: "bash" }]),
      toolResult("call_1"),
      { role: "assistant", content: "done" },
    ];
    expect(findOrphanToolCalls(messages)).toEqual([]);
  });

  test("detects a single orphan (the ContextError-interrupted shape)", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: "q" },
      assistantWithCalls([{ id: "call_orphan", name: "bash" }]),
      // <-- ContextError interrupted here: no tool result ever arrives
    ];
    const orphans = findOrphanToolCalls(messages);
    expect(orphans).toHaveLength(1);
    // End-of-history orphan → sentinel index (= messages.length).
    expect(orphans[0]).toMatchObject({
      toolCallId: "call_orphan",
      toolName: "bash",
      messageIndex: 2,
    });
  });

  test("detects multiple orphans in one assistant message (multi tool-call)", () => {
    const messages: LLMMessage[] = [
      assistantWithCalls([
        { id: "call_a", name: "bash" },
        { id: "call_b", name: "read_file" },
        { id: "call_c", name: "edit_file" },
      ]),
    ];
    const orphans = findOrphanToolCalls(messages);
    expect(orphans.map((o) => o.toolCallId)).toEqual(["call_a", "call_b", "call_c"]);
    // End-of-history orphans → sentinel index (= messages.length = 1).
    expect(orphans.every((o) => o.messageIndex === 1)).toBe(true);
  });

  test("partial pairing: only the unpaired call is an orphan", () => {
    const messages: LLMMessage[] = [
      assistantWithCalls([
        { id: "call_done", name: "bash" },
        { id: "call_missing", name: "bash" },
      ]),
      toolResult("call_done"),
    ];
    const orphans = findOrphanToolCalls(messages);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].toolCallId).toBe("call_missing");
  });

  test("a result AFTER the next user message does NOT pair (AI SDK positional semantics)", () => {
    // AI SDK v6 (index.mjs:1375-1387): on user/system, a
    // non-empty pending set throws MissingToolResultsError.
    // A later result cannot rescue it. DS review round-2
    // proved this with a real generateText() repro.
    const messages: LLMMessage[] = [
      assistantWithCalls([{ id: "call_1", name: "bash" }]),
      { role: "user", content: "interjected" },
      toolResult("call_1"),
    ];
    const orphans = findOrphanToolCalls(messages);
    expect(orphans.map((o) => o.toolCallId)).toEqual(["call_1"]);
    expect(orphans[0]!.messageIndex).toBe(1); // the user boundary
  });

  test("recognises ids inside array-content tool-result parts (AI SDK v6 shape)", () => {
    const messages: LLMMessage[] = [
      assistantWithCalls([{ id: "call_1", name: "bash" }]),
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "bash",
            output: { type: "text", value: "ok" },
          },
        ] as unknown as string,
      } as LLMMessage,
    ];
    expect(findOrphanToolCalls(messages)).toEqual([]);
  });

  test("orphans across several assistant messages keep their own indices", () => {
    const messages: LLMMessage[] = [
      assistantWithCalls([{ id: "call_1", name: "bash" }]),
      toolResult("call_1"),
      assistantWithCalls([{ id: "call_2", name: "bash" }]),
      assistantWithCalls([{ id: "call_3", name: "read_file" }]),
    ];
    const orphans = findOrphanToolCalls(messages);
    expect(orphans.map((o) => o.toolCallId)).toEqual(["call_2", "call_3"]);
    // Both pend at END OF HISTORY → sentinel index (= length = 4).
    expect(orphans.map((o) => o.messageIndex)).toEqual([4, 4]);
  });
});

describe("repairOrphanToolCalls", () => {
  test("zero-orphan fast path returns the SAME array reference (no copy)", () => {
    const messages: LLMMessage[] = [
      assistantWithCalls([{ id: "call_1", name: "bash" }]),
      toolResult("call_1"),
    ];
    const result = repairOrphanToolCalls(messages);
    expect(result.repairedCount).toBe(0);
    expect(result.messages).toBe(messages); // reference equality
  });

  test("inserts a placeholder BEFORE the end-of-history boundary (last message)", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: "q" },
      assistantWithCalls([{ id: "call_orphan", name: "bash" }]),
    ];
    const result = repairOrphanToolCalls(messages, { reason: "run interrupted by context limit" });

    expect(result.repairedCount).toBe(1);
    expect(result.messages).toHaveLength(3);
    // The placeholder is inserted at index 2 (before the
    // end-of-history boundary), i.e. AFTER the assistant.
    const repairMsg = result.messages[2];
    expect(repairMsg.role).toBe("tool");
    expect(repairMsg.toolCallId).toBe("call_orphan");
    expect(repairMsg.name).toBe("bash");
    expect(String(repairMsg.content)).toContain(ORPHAN_PLACEHOLDER_PREFIX);
    expect(String(repairMsg.content)).toContain("run interrupted by context limit");

    // And the repaired history has no orphans left.
    expect(findOrphanToolCalls(result.messages)).toEqual([]);
  });

  test("multi-orphan single assistant message: one tool message per call", () => {
    const messages: LLMMessage[] = [
      assistantWithCalls([
        { id: "call_a", name: "bash" },
        { id: "call_b", name: "bash" },
      ]),
    ];
    const result = repairOrphanToolCalls(messages);
    expect(result.repairedCount).toBe(2);
    expect(result.messages).toHaveLength(3);
    // Both placeholders sit after the assistant (before the
    // end-of-history boundary): [assistant, tool(a), tool(b)].
    expect(result.messages[1].toolCallId).toBe("call_a");
    expect(result.messages[2].toolCallId).toBe("call_b");
    expect(findOrphanToolCalls(result.messages)).toEqual([]);
  });

  test("does NOT touch healthy pairs (mixed healthy + orphan history)", () => {
    const messages: LLMMessage[] = [
      assistantWithCalls([{ id: "call_ok", name: "bash" }]),
      toolResult("call_ok", "bash", '{"real":"output"}'),
      assistantWithCalls([{ id: "call_orphan", name: "bash" }]),
    ];
    const result = repairOrphanToolCalls(messages);
    expect(result.repairedCount).toBe(1);
    // original healthy result untouched
    expect(result.messages[1].content).toBe('{"real":"output"}');
    expect(result.messages).toHaveLength(4);
    expect(findOrphanToolCalls(result.messages)).toEqual([]);
  });

  test("does not mutate the input array", () => {
    const messages: LLMMessage[] = [
      assistantWithCalls([{ id: "call_orphan", name: "bash" }]),
    ];
    const before = messages.length;
    repairOrphanToolCalls(messages);
    expect(messages).toHaveLength(before);
  });

  test("repaired history survives convertToSDKMessages (AI SDK prompt converter)", () => {
    // This is the production failure: convertToLanguageModelPrompt throws
    // AI_MissingToolResultsError on the un-repaired history.
    const messages: LLMMessage[] = [
      { role: "user", content: "q" },
      assistantWithCalls([
        { id: "call_9ec9006712174ec39880253e", name: "bash" },
        { id: "call_e9270792f8434f1ca67209ef", name: "bash" },
      ]),
    ];
    const repaired = repairOrphanToolCalls(messages, {
      reason: "run interrupted by context limit",
    });
    const sdkMessages = convertToSDKMessages(repaired.messages, { provider: "openai-compatible" });

    // The repaired history now contains tool-result parts for BOTH orphans.
    const toolResults = sdkMessages.flatMap((m) =>
      m.role === "tool" && Array.isArray(m.content)
        ? (m.content as Array<{ type: string; toolCallId?: string }>).filter(
            (p) => p.type === "tool-result",
          )
        : [],
    );
    const resultIds = toolResults.map((p) => p.toolCallId);
    expect(resultIds).toContain("call_9ec9006712174ec39880253e");
    expect(resultIds).toContain("call_e9270792f8434f1ca67209ef");
  });

  test("REAL AI SDK: unrepaired orphan history throws AI_MissingToolResultsError; repaired passes", async () => {
    // Reproduces the production kill chain from Task #4983 (session_1bba0d11):
    // litellm connection error → AI SDK fallback → convertToLanguageModelPrompt
    // throws on the ContextError-era orphan → run dies.
    const messages: LLMMessage[] = [
      { role: "user", content: "q" },
      assistantWithCalls([{ id: "call_9ec9006712174ec39880253e", name: "bash" }]),
    ];
    const orphanSdk = convertToSDKMessages(messages, { provider: "openai-compatible" });
    await expect(
      convertToLanguageModelPrompt({
        prompt: { system: "sys", messages: orphanSdk as never },
        supportedUrls: {},
      }),
    ).rejects.toThrow(/Tool result is missing|MissingToolResults/);

    // After repair the exact same history is accepted.
    const repaired = repairOrphanToolCalls(messages, {
      reason: "run interrupted by context limit",
    });
    const repairedSdk = convertToSDKMessages(repaired.messages, {
      provider: "openai-compatible",
    });
    const prompt = await convertToLanguageModelPrompt({
      prompt: { system: "sys", messages: repairedSdk as never },
      supportedUrls: {},
    });
    expect(prompt).toBeDefined();
  });
});

// ============================================================================
// AI SDK ModelMessage variant — defence 2 (invoke.ts fallback path)
// ============================================================================

describe("repairOrphanSdkMessages (AI SDK ModelMessage shape)", () => {
  function sdkOrphanHistory(): ModelMessage[] {
    // Same shape convertToSDKMessages produces for an orphan assistant message.
    return [
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "working" },
          { type: "tool-call", toolCallId: "call_orphan", toolName: "bash", input: {} },
        ],
      } as ModelMessage,
    ];
  }

  test("detects and repairs orphan tool-call parts in assistant content", () => {
    const repaired = repairOrphanSdkMessages(sdkOrphanHistory(), {
      reason: "run interrupted by context limit",
    });
    expect(repaired.repairedCount).toBe(1);
    // End-of-history orphan → sentinel index (= length = 2).
    expect(repaired.orphans[0]).toMatchObject({
      toolCallId: "call_orphan",
      toolName: "bash",
      messageIndex: 2,
    });
    expect(repaired.messages).toHaveLength(3);
    const toolMsg = repaired.messages[2] as {
      role: string;
      content: Array<Record<string, unknown>>;
    };
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.content[0]).toMatchObject({
      type: "tool-result",
      toolCallId: "call_orphan",
      toolName: "bash",
    });
    const output = toolMsg.content[0].output as { type: string; value: string };
    expect(output.type).toBe("text");
    expect(output.value).toContain(ORPHAN_PLACEHOLDER_PREFIX);
  });

  test("zero-orphan fast path returns the SAME array reference", () => {
    const healthy: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call_1", toolName: "bash", input: {} },
        ],
      } as ModelMessage,
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "bash",
            output: { type: "text", value: "ok" },
          },
        ],
      } as ModelMessage,
    ];
    const result = repairOrphanSdkMessages(healthy);
    expect(result.repairedCount).toBe(0);
    expect(result.messages).toBe(healthy);
  });

  test("partial pairing inside one assistant message: only missing call repaired", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call_ok", toolName: "bash", input: {} },
          { type: "tool-call", toolCallId: "call_missing", toolName: "bash", input: {} },
        ],
      } as ModelMessage,
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_ok",
            toolName: "bash",
            output: { type: "text", value: "ok" },
          },
        ],
      } as ModelMessage,
    ];
    const repaired = repairOrphanSdkMessages(messages);
    expect(repaired.repairedCount).toBe(1);
    expect(repaired.orphans[0].toolCallId).toBe("call_missing");
    expect(repaired.messages).toHaveLength(3);
  });

  test("end-to-end: repaired SDK history passes the REAL AI SDK prompt converter", async () => {
    const repaired = repairOrphanSdkMessages(sdkOrphanHistory(), {
      reason: "run interrupted by context limit",
    });
    const prompt = await convertToLanguageModelPrompt({
      prompt: { system: "sys", messages: repaired.messages as never },
      supportedUrls: {},
    });
    expect(prompt).toBeDefined();
  });
});
