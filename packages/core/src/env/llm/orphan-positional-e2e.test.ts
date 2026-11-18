/**
 * @fileoverview End-to-end positional-semantics regression
 * (Task #4992 R3): the DS review round-2 BLOCKER reproduced
 * with the REAL AI SDK — a repaired-in-the-wrong-place (global
 * id set) history still throws AI_MissingToolResultsError
 * because the converter uses positional pending-set pairing
 * (node_modules/ai/dist/index.mjs:1359-1387).
 *
 * These tests run the REAL generateText() from "ai" with a
 * dummy mock provider over REAL production-shaped histories,
 * proving:
 *   1. an orphan whose result arrives after the next user
 *      message STILL throws without repair (documents the
 *      AI SDK behavior);
 *   2. after repairOrphanSdkMessages the SAME history passes
 *      the converter (no throw);
 *   3. a positional-orphan history repaired at session end
 *      (the R2 bug) still throws — guarding against a
 *      regression back to the wrong model.
 */

import { describe, test, expect } from "bun:test";
import { generateText, streamText, type ModelMessage, type LanguageModelV1, type LanguageModelV1CallOptions } from "ai";
import { convertToSDKMessages } from "./invoke";
import { repairOrphanSdkMessages, ORPHAN_PLACEHOLDER_PREFIX } from "./orphan-toolcall";
import type { LLMMessage } from "./types";

/** Minimal dummy model (v2 spec): never reached for content — the
 * converter throws BEFORE any model call when pairing is
 * broken, which is exactly what we assert. */
function dummyModel(): LanguageModelV1 {
  return {
    specificationVersion: "v2",
    provider: "dummy",
    modelId: "dummy-model",
    doGenerate: async () => ({
      content: [{ type: "text", text: "ok" }],
      finishReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1 },
      warnings: [],
    }),
    doStream: async () => {
      throw new Error("dummy doStream should not be reached in these tests");
    },
  } as unknown as LanguageModelV1;
}

/** The production-shaped orphan history of session_1bba0d11
 * (Task #4983): assistant tool-calls, then user messages, and
 * the placeholder results appended at session END (the R2
 * backfill bug). */
function productionLikeHistory(): LLMMessage[] {
  return [
    { role: "user", content: "continue the task" },
    {
      role: "assistant",
      content: "running the checks",
      toolCalls: [
        { id: "call_9ec9006712174ec39880253e", name: "bash", arguments: "{}", function: { name: "bash", arguments: "{}" } },
        { id: "call_e9270792f8434f1ca67209ef", name: "bash", arguments: "{}", function: { name: "bash", arguments: "{}" } },
      ],
    },
    // ContextError interrupted here — user input follows.
    { role: "user", content: "why did it stop?" },
  ];
}

describe("positional pending-set semantics — REAL AI SDK e2e (R3)", () => {
  test("unrepaired orphan with a user boundary throws the AI SDK error", async () => {
    const sdk = convertToSDKMessages(productionLikeHistory()) as ModelMessage[];
    let threw: unknown;
    try {
      await generateText({ model: dummyModel(), messages: sdk, maxRetries: 0 });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeDefined();
    expect(String((threw as Error)?.name ?? threw)).toContain("AI_MissingToolResultsError");
  });

  test("after repairOrphanSdkMessages the REAL converter accepts the history", async () => {
    const sdk = convertToSDKMessages(productionLikeHistory()) as ModelMessage[];
    const repaired = repairOrphanSdkMessages(sdk, {
      reason: "repaired before AI SDK fallback (Task #4992 defence 2)",
    });
    expect(repaired.repairedCount).toBe(2);
    // Placeholders must sit BEFORE the following user message,
    // not at session end. The orphan boundary is the LAST user
    // message (messageIndex=2), so the repaired array is
    // [u, a, tool, tool, u] — tools right before the user at idx 2.
    expect(repaired.messages.filter((m) => m.role === "tool").length).toBe(2);
    const lastUserIdx = repaired.messages.map((m) => m.role).lastIndexOf("user");
    expect(lastUserIdx).toBe(4);
    expect(repaired.messages[2]!.role).toBe("tool");
    expect(repaired.messages[3]!.role).toBe("tool");

    let threw: unknown;
    try {
      await generateText({ model: dummyModel(), messages: repaired.messages, maxRetries: 0 });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeUndefined();
  });

  test("regression guard: repair at session END (R2 bug) does NOT satisfy positional pairing", async () => {
    const sdk = convertToSDKMessages(productionLikeHistory()) as ModelMessage[];
    // Simulate the R2 (wrong) backfill: placeholders appended at end.
    const wrong = [
      ...sdk,
      ...([
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "call_9ec9006712174ec39880253e", toolName: "bash", output: { type: "text", value: ORPHAN_PLACEHOLDER_PREFIX } },
          ],
        },
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "call_e9270792f8434f1ca67209ef", toolName: "bash", output: { type: "text", value: ORPHAN_PLACEHOLDER_PREFIX } },
          ],
        },
      ] as ModelMessage[]),
    ];
    let threw: unknown;
    try {
      await generateText({ model: dummyModel(), messages: wrong, maxRetries: 0 });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeDefined();
    expect(String((threw as Error)?.name ?? threw)).toContain("AI_MissingToolResultsError");
  });

  test("streamText path: repaired history does not throw (fallback wire path)", async () => {
    const sdk = convertToSDKMessages(productionLikeHistory()) as ModelMessage[];
    const repaired = repairOrphanSdkMessages(sdk, { reason: "fallback" });
    let threw: unknown;
    try {
      const result = streamText({ model: dummyModel(), messages: repaired.messages, maxRetries: 0 });
      // Consume at least the first tick to force the converter.
      for await (const _ of result.fullStream) break;
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeUndefined();
  });
});
