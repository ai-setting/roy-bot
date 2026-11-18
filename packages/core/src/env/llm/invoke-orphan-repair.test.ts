/**
 * @fileoverview Defence 2 integration: invoke() (AI SDK fallback path) must
 * repair orphan tool-calls BEFORE calling streamText (Task #4992).
 *
 * Production kill chain (Task #4983, session_1bba0d11):
 *   litellm connection error → LLMComponent adapter fallback → invoke()
 *   → convertToLanguageModelPrompt throws AI_MissingToolResultsError on a
 *   ContextError-era orphan → run dies (iterations=143).
 *
 * After this fix invoke() repairs any orphan history before the wire, so the
 * converter can never throw for missing tool results.
 */

import { vi, describe, test, expect, beforeEach, afterEach } from "bun:test";

import { invoke } from "./invoke";
import type { InvokeConfig, InvokeOptions } from "./invoke";
import type { LLMMessage } from "./types";
import * as aiModule from "ai";
import { ORPHAN_PLACEHOLDER_PREFIX } from "./orphan-toolcall";

const streamTextSpy = vi.spyOn(aiModule, "streamText");

function orphanHistory(): LLMMessage[] {
  return [
    { role: "user", content: "continue the task" },
    {
      role: "assistant",
      content: "running the checks",
      toolCalls: [
        {
          id: "call_9ec9006712174ec39880253e",
          name: "bash",
          arguments: "{}",
          function: { name: "bash", arguments: "{}" },
        },
        {
          id: "call_e9270792f8434f1ca67209ef",
          name: "bash",
          arguments: "{}",
          function: { name: "bash", arguments: "{}" },
        },
      ],
    },
    // ContextError interrupted the run here — no tool results ever persisted.
  ];
}

describe("invoke — orphan tool-call repair (defence 2)", () => {
  beforeEach(() => {
    streamTextSpy.mockReset();
  });

  afterEach(() => {
    streamTextSpy.mockReset();
  });

  test("orphan history reaches streamText already repaired (no AI_MissingToolResultsError)", async () => {
    // streamText mock asserts the converter-equivalent invariant: every
    // assistant tool-call id must have a tool-result by the time we get here.
    (streamTextSpy as ReturnType<typeof vi.fn>).mockImplementation(
      async (opts: { messages: Array<{ role: string; content: unknown }> }) => {
        const callIds = new Set<string>();
        const resultIds = new Set<string>();
        for (const msg of opts.messages) {
          if (msg.role === "assistant" && Array.isArray(msg.content)) {
            for (const part of msg.content as Array<Record<string, unknown>>) {
              if (part.type === "tool-call") callIds.add(part.toolCallId as string);
            }
          }
          if (msg.role === "tool" && Array.isArray(msg.content)) {
            for (const part of msg.content as Array<Record<string, unknown>>) {
              if (part.type === "tool-result") resultIds.add(part.toolCallId as string);
            }
          }
        }
        const missing = [...callIds].filter((id) => !resultIds.has(id));
        if (missing.length > 0) {
          throw new Error(
            `AI_MissingToolResultsError: Tool result is missing for tool call ${missing.join(", ")}`,
          );
        }
        return { fullStream: (async function* () {})() };
      },
    );

    const config: InvokeConfig = { model: "openai/gpt-4o", apiKey: "sk-test" };
    const options: InvokeOptions = {
      messages: orphanHistory(),
      context: { sessionId: "session_1bba0d11-test" },
    };

    const result = await invoke(config, options, { abort: undefined });
    expect(result.isError).toBeFalsy();
    expect(streamTextSpy).toHaveBeenCalledTimes(1);
  });

  test("placeholder results carry the interruption reason and correct ids", async () => {
    let capturedMessages: Array<{ role: string; content: unknown }> = [];
    (streamTextSpy as ReturnType<typeof vi.fn>).mockImplementation(
      async (opts: { messages: Array<{ role: string; content: unknown }> }) => {
        capturedMessages = opts.messages;
        return { fullStream: (async function* () {})() };
      },
    );

    const config: InvokeConfig = { model: "openai/gpt-4o", apiKey: "sk-test" };
    const options: InvokeOptions = { messages: orphanHistory() };
    await invoke(config, options, { abort: undefined });

    const toolMessages = capturedMessages.filter((m) => m.role === "tool");
    expect(toolMessages.length).toBe(2);

    const results = toolMessages.flatMap((m) =>
      Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : [],
    );
    const ids = results.map((r) => r.toolCallId);
    expect(ids).toContain("call_9ec9006712174ec39880253e");
    expect(ids).toContain("call_e9270792f8434f1ca67209ef");
    for (const r of results) {
      const output = r.output as { type: string; value: string };
      expect(output.value).toContain(ORPHAN_PLACEHOLDER_PREFIX);
      expect(output.value).toContain("AI SDK fallback");
    }
  });

  test("healthy paired history passes through untouched (zero-orphan fast path)", async () => {
    let capturedMessages: Array<{ role: string; content: unknown }> = [];
    (streamTextSpy as ReturnType<typeof vi.fn>).mockImplementation(
      async (opts: { messages: Array<{ role: string; content: unknown }> }) => {
        capturedMessages = opts.messages;
        return { fullStream: (async function* () {})() };
      },
    );

    const healthy: LLMMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "checking",
        toolCalls: [
          { id: "call_ok", name: "bash", arguments: "{}", function: { name: "bash", arguments: "{}" } },
        ],
      },
      { role: "tool", content: '{"real":"output"}', toolCallId: "call_ok", name: "bash" },
    ];

    const config: InvokeConfig = { model: "openai/gpt-4o", apiKey: "sk-test" };
    const options: InvokeOptions = { messages: healthy };
    await invoke(config, options, { abort: undefined });

    // No extra tool messages injected; original output preserved.
    const toolMessages = capturedMessages.filter((m) => m.role === "tool");
    expect(toolMessages.length).toBe(1);
    const parts = toolMessages[0].content as Array<Record<string, unknown>>;
    expect(parts[0].toolCallId).toBe("call_ok");
    const output = parts[0].output as { type: string; value: string };
    expect(output.value).toBe('{"real":"output"}');
    expect(output.value).not.toContain(ORPHAN_PLACEHOLDER_PREFIX);
  });
});
