import { vi, describe, test, expect, beforeEach, afterEach } from "bun:test";

const isParallelRun = "BUN_TEST_WORKER_ID" in process.env;

import { parseModelString, createInvokeConfig, getStreamPartText, invoke, convertToSDKMessages, extractUsageInfo, sortObjectKeysDeep } from "./invoke";
import type { InvokeConfig, InvokeOptions } from "./invoke";
import type { LLMMessage } from "./types";
import * as aiModule from "ai";

// Spy on streamText — 替代 vi.mock, 避免对其他测试文件造成影响
const streamTextSpy = vi.spyOn(aiModule, "streamText");
const jsonSchemaSpy = vi.spyOn(aiModule, "jsonSchema");
jsonSchemaSpy.mockImplementation((schema: unknown) => schema as any);

describe("invoke module", () => {
  describe("parseModelString", () => {
    test("should parse full model string with provider", () => {
      const result = parseModelString("openai/gpt-4o");
      expect(result.providerId).toBe("openai");
      expect(result.modelId).toBe("gpt-4o");
    });

    test("should parse model string with multiple slashes", () => {
      const result = parseModelString("openai/gpt-4o-turbo");
      expect(result.providerId).toBe("openai");
      expect(result.modelId).toBe("gpt-4o-turbo");
    });

    test("should return default provider for model-only string", () => {
      const result = parseModelString("gpt-4o");
      expect(result.providerId).toBe("openai");
      expect(result.modelId).toBe("gpt-4o");
    });

    test("should return defaults for undefined input", () => {
      const result = parseModelString(undefined);
      expect(result.providerId).toBe("openai");
      expect(result.modelId).toBe("gpt-4o");
    });

    test("should handle anthropic provider", () => {
      const result = parseModelString("anthropic/claude-3-5-sonnet");
      expect(result.providerId).toBe("anthropic");
      expect(result.modelId).toBe("claude-3-5-sonnet");
    });

    test("should handle google provider", () => {
      const result = parseModelString("google/gemini-2.0-flash");
      expect(result.providerId).toBe("google");
      expect(result.modelId).toBe("gemini-2.0-flash");
    });

    test("should handle openai-compatible provider", () => {
      const result = parseModelString("openai-compatible/deepseek-chat");
      expect(result.providerId).toBe("openai-compatible");
      expect(result.modelId).toBe("deepseek-chat");
    });
  });

  describe("getStreamPartText", () => {
    test("should prefer text over delta", () => {
      expect(getStreamPartText({ text: "hello", delta: "world" })).toBe("hello");
    });

    test("should fall back to delta and textDelta", () => {
      expect(getStreamPartText({ delta: "delta" })).toBe("delta");
      expect(getStreamPartText({ textDelta: "legacy" })).toBe("legacy");
    });

    test("should return empty string for missing or non-string values", () => {
      expect(getStreamPartText({})).toBe("");
      expect(getStreamPartText({ text: null, delta: undefined })).toBe("");
      expect(getStreamPartText({ text: 42 })).toBe("");
    });
  });

  describe("createInvokeConfig", () => {
    test("should create config with all fields", () => {
      const config = createInvokeConfig("openai/gpt-4o", "sk-test", "https://api.openai.com/v1");
      expect(config.model).toBe("openai/gpt-4o");
      expect(config.apiKey).toBe("sk-test");
      expect(config.baseURL).toBe("https://api.openai.com/v1");
    });

    test("should create config without baseURL", () => {
      const config = createInvokeConfig("gpt-4o", "sk-test");
      expect(config.model).toBe("gpt-4o");
      expect(config.apiKey).toBe("sk-test");
      expect(config.baseURL).toBeUndefined();
    });

    test("should handle undefined baseURL", () => {
      const config = createInvokeConfig("gpt-4o", "sk-test", undefined);
      expect(config.model).toBe("gpt-4o");
      expect(config.apiKey).toBe("sk-test");
      expect(config.baseURL).toBeUndefined();
    });
  });

  describe.skipIf(isParallelRun)("toolChoice", () => {
    let mockFullStream: AsyncGenerator<never, void, unknown>;

    beforeEach(() => {
      // 创建一个空的异步生成器作为 mock fullStream
      mockFullStream = (async function* () {})();
      streamTextSpy.mockReset();
    });

    afterEach(() => {
      streamTextSpy.mockReset();
    });

    test("should pass toolChoice to streamText when specified as function call", async () => {
      (streamTextSpy as ReturnType<typeof vi.fn>).mockResolvedValue({
        fullStream: mockFullStream,
      });

      const config: InvokeConfig = {
        model: "openai/gpt-4o",
        apiKey: "sk-test",
      };

      const options: InvokeOptions = {
        messages: [{ role: "user", content: "hello" }],
        toolChoice: { type: "function", function: { name: "test_tool" } },
      };

      await invoke(config, options, { abort: undefined });

      expect(streamTextSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          toolChoice: { type: "tool", toolName: "test_tool" },
        })
      );
    });

    test("should pass toolChoice as 'none' to streamText", async () => {
      (streamTextSpy as ReturnType<typeof vi.fn>).mockResolvedValue({
        fullStream: mockFullStream,
      });

      const config: InvokeConfig = {
        model: "openai/gpt-4o",
        apiKey: "sk-test",
      };

      const options: InvokeOptions = {
        messages: [{ role: "user", content: "hello" }],
        toolChoice: "none",
      };

      await invoke(config, options, { abort: undefined });

      expect(streamTextSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          toolChoice: "none",
        })
      );
    });

    test("should default to undefined when toolChoice is not specified", async () => {
      (streamTextSpy as ReturnType<typeof vi.fn>).mockResolvedValue({
        fullStream: mockFullStream,
      });

      const config: InvokeConfig = {
        model: "openai/gpt-4o",
        apiKey: "sk-test",
      };

      const options: InvokeOptions = {
        messages: [{ role: "user", content: "hello" }],
      };

      await invoke(config, options, { abort: undefined });

      expect(streamTextSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          toolChoice: undefined,
        })
      );
    });

    test("should pass 'required' toolChoice to streamText to force tool calling", async () => {
      (streamTextSpy as ReturnType<typeof vi.fn>).mockResolvedValue({
        fullStream: mockFullStream,
      });

      const config: InvokeConfig = {
        model: "openai/gpt-4o",
        apiKey: "sk-test",
      };

      const options: InvokeOptions = {
        messages: [{ role: "user", content: "submit JSON now" }],
        tools: [
          {
            name: "workflow_submit_output",
            description: "Submit JSON",
            parameters: {},
            execute: async () => ({ success: true, output: "{}" }),
          },
        ],
        toolChoice: "required",
      };

      await invoke(config, options, { abort: undefined });

      expect(streamTextSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          toolChoice: "required",
        })
      );
    });

    test("should pass toolChoice as 'auto' to streamText", async () => {
      (streamTextSpy as ReturnType<typeof vi.fn>).mockResolvedValue({
        fullStream: mockFullStream,
      });

      const config: InvokeConfig = {
        model: "openai/gpt-4o",
        apiKey: "sk-test",
      };

      const options: InvokeOptions = {
        messages: [{ role: "user", content: "hello" }],
        toolChoice: "auto",
      };

      await invoke(config, options, { abort: undefined });

      expect(streamTextSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          toolChoice: "auto",
        })
      );
    });

    test("should pass toolChoice as 'required' to streamText", async () => {
      (streamTextSpy as ReturnType<typeof vi.fn>).mockResolvedValue({
        fullStream: mockFullStream,
      });

      const config: InvokeConfig = {
        model: "openai/gpt-4o",
        apiKey: "sk-test",
      };

      const options: InvokeOptions = {
        messages: [{ role: "user", content: "hello" }],
        toolChoice: "required",
      };

      await invoke(config, options, { abort: undefined });

      expect(streamTextSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          toolChoice: "required",
        })
      );
    });

    test("should pass toolChoice with empty function name as undefined", async () => {
      (streamTextSpy as ReturnType<typeof vi.fn>).mockResolvedValue({
        fullStream: mockFullStream,
      });

      const config: InvokeConfig = {
        model: "openai/gpt-4o",
        apiKey: "sk-test",
      };

      const options: InvokeOptions = {
        messages: [{ role: "user", content: "hello" }],
        toolChoice: { type: "function", function: { name: "" } },
      };

      await invoke(config, options, { abort: undefined });

      expect(streamTextSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          toolChoice: undefined,
        })
      );
    });

    test("should pass toolChoice for workflow_submit_output to streamText", async () => {
      (streamTextSpy as ReturnType<typeof vi.fn>).mockResolvedValue({
        fullStream: mockFullStream,
      });

      const config: InvokeConfig = {
        model: "openai/gpt-4o",
        apiKey: "sk-test",
      };

      const options: InvokeOptions = {
        messages: [{ role: "user", content: "hello" }],
        toolChoice: { type: "function", function: { name: "workflow_submit_output" } },
      };

      await invoke(config, options, { abort: undefined });

      expect(streamTextSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          toolChoice: { type: "tool", toolName: "workflow_submit_output" },
        })
      );
    });
  });
  describe("thinkingInText", () => {
    beforeEach(() => {
      streamTextSpy.mockReset();
    });

    afterEach(() => {
      streamTextSpy.mockReset();
    });

    test("should remove think tags from returned content when removeFromOutput is true", async () => {
      async function* generateStream() {
        yield { type: "text-delta", textDelta: "<think>I need to analyze this carefully</think>" };
        yield { type: "text-delta", textDelta: "Based on my analysis, the answer is 42." };
        yield { type: "finish", usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } };
      }

      (streamTextSpy as ReturnType<typeof vi.fn>).mockResolvedValue({
        fullStream: generateStream(),
      });

      const config: InvokeConfig = {
        model: "openai-compatible/minimax-m3",
        apiKey: "sk-test",
        baseURL: "https://api.minimax.chat/v1",
      };
      (config as any).options = {
        thinkingInText: {
          enabled: true,
          tags: ["think"],
          removeFromOutput: true,
        },
      };

      const result = await invoke(config, {
        messages: [{ role: "user", content: "What is 6*7?" }],
      }, { abort: undefined });

      const parsed = JSON.parse(result.result);

      // Content must NOT contain think tags — core fix for duplication.
      // Use a regex that catches the full <think>...</think> pair (not just
      // the opening or closing tag in isolation), so we don't miss partial
      // tag fragments that could be left behind by a broken strip pass.
      expect(parsed.content).not.toMatch(/<think>[\s\S]*?<\/think>/);
      expect(parsed.content).toContain("Based on my analysis, the answer is 42.");

      // Reasoning must still be extracted and preserved
      expect(parsed.reasoning).toContain("I need to analyze this carefully");
    });

    test("should keep think tags in returned content when removeFromOutput is false", async () => {
      async function* generateStream() {
        yield { type: "text-delta", textDelta: "<think>Some thinking</think>Clean response" };
        yield { type: "finish", usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } };
      }

      (streamTextSpy as ReturnType<typeof vi.fn>).mockResolvedValue({
        fullStream: generateStream(),
      });

      const config: InvokeConfig = {
        model: "openai-compatible/minimax-m3",
        apiKey: "sk-test",
      };
      (config as any).options = {
        thinkingInText: {
          enabled: true,
          tags: ["think"],
          removeFromOutput: false,
        },
      };

      const result = await invoke(config, {
        messages: [{ role: "user", content: "Hello" }],
      }, { abort: undefined });

      const parsed = JSON.parse(result.result);

      // When removeFromOutput is false, think tags stay in content
      expect(parsed.content).toContain("<think>");
    });

    test("should not fail when thinkingInText is not configured", async () => {
      async function* generateStream() {
        yield { type: "text-delta", textDelta: "Hello, world!" };
        yield { type: "finish", usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 } };
      }

      (streamTextSpy as ReturnType<typeof vi.fn>).mockResolvedValue({
        fullStream: generateStream(),
      });

      const config: InvokeConfig = {
        model: "openai/gpt-4o",
        apiKey: "sk-test",
      };

      const result = await invoke(config, {
        messages: [{ role: "user", content: "Hello" }],
      }, { abort: undefined });

      const parsed = JSON.parse(result.result);
      expect(parsed.content).toBe("Hello, world!");
      expect(parsed.reasoning).toBeUndefined();
    });

    /**
     * Bug fix: when `thinkingInText.enabled === true`, reasoning is sourced
     * from inline <think> tags inside text-delta (via `processThinkingStream`).
     * Native `reasoning-delta` events from the SDK (which carry
     * `reasoning_content` from providers like DeepSeek) MUST be suppressed,
     * otherwise the same reasoning would appear twice — once in `content`
     * (after tag stripping) and once in `reasoning`.
     *
     * Stream shape exercised here:
     *   1. reasoning-start
     *   2. reasoning-delta: "Let me think..."   (would duplicate if not suppressed)
     *   3. reasoning-end
     *   4. text-delta: "Result: 42"             (no inline tags in this mock,
     *                                            so processThinkingStream is a
     *                                            no-op pass-through)
     *   5. finish
     */
    test("should suppress reasoning-delta when thinkingInText enabled (deepseek duplicate-output fix)", async () => {
      async function* generateStream() {
        yield { type: "reasoning-start", id: "reasoning-0" };
        yield { type: "reasoning-delta", id: "reasoning-0", delta: "Let me think..." };
        yield { type: "reasoning-end", id: "reasoning-0" };
        yield { type: "text-start", id: "txt-0" };
        yield { type: "text-delta", id: "txt-0", textDelta: "Result: 42" };
        yield { type: "text-end", id: "txt-0" };
        yield { type: "finish", usage: { promptTokens: 5, completionTokens: 15, totalTokens: 20 } };
      }

      (streamTextSpy as ReturnType<typeof vi.fn>).mockResolvedValue({
        fullStream: generateStream(),
      });

      const config: InvokeConfig = {
        model: "openai-compatible/deepseek-v4-flash",
        apiKey: "sk-test",
      };
      (config as any).options = {
        thinkingInText: {
          enabled: true,
          tags: ["think"],
          removeFromOutput: true,
        },
      };

      const result = await invoke(config, {
        messages: [{ role: "user", content: "Compute" }],
      }, { abort: undefined });

      const parsed = JSON.parse(result.result);

      // Content: text-delta has no think tags, so processThinkingStream is
      // a pass-through. Only "Result: 42" survives in content.
      expect(parsed.content).toBe("Result: 42");

      // Reasoning: native reasoning-delta is suppressed when thinkingInText
      // is enabled (to avoid duplication with the inline-tag reasoning
      // source). `reasoning` must be empty / undefined.
      expect(parsed.reasoning).toBeUndefined();
    });

    /**
     * Regression: when the model sends the same text in two separate text-delta
     * events (no think tags involved), invoke() must faithfully accumulate both
     * without deduplication. The outputContent should reflect EXACTLY what the
     * model sent across all text-delta events.
     *
     * This test documents that duplication in the FINAL output means the MODEL
     * sent duplicate text — not a code bug in invoke.ts.
     *
     * Also pins down the symmetry: when `thinkingInText` is NOT enabled,
     * native `reasoning-delta` events still accumulate (existing behavior
     * preserved for models that emit `reasoning_content` without inline
     * tags, e.g. some OpenAI-style endpoints or non-reasoning models using
     * a custom server).
     */
    test("should faithfully accumulate all text-delta events (no dedup) when model sends duplicate text", async () => {
      async function* generateStream() {
        yield { type: "text-start", id: "txt-0" };
        yield { type: "text-delta", id: "txt-0", textDelta: "The test file diffs got truncated. Let me read the full changes." };
        yield { type: "text-delta", id: "txt-0", textDelta: "\nThe test file diffs got truncated. Let me read the full changes." };
        yield { type: "text-end", id: "txt-0" };
        yield { type: "finish", usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } };
      }

      (streamTextSpy as ReturnType<typeof vi.fn>).mockResolvedValue({
        fullStream: generateStream(),
      });

      // DeepSeek config: NO thinkingInText
      const config: InvokeConfig = {
        model: "openai-compatible/deepseek-v4-flash",
        apiKey: "sk-test",
      };

      const result = await invoke(config, {
        messages: [{ role: "user", content: "Check diffs" }],
      }, { abort: undefined });

      const parsed = JSON.parse(result.result);

      // outputContent must contain both text-delta chunks — exactly what the model sent
      expect(parsed.content).toContain("The test file diffs got truncated. Let me read the full changes.");
      expect(parsed.content!.split("The test file diffs got truncated").length - 1).toBe(2);
      // No reasoning from text-delta when thinkingInText is disabled
      expect(parsed.reasoning).toBeUndefined();
    });

    test("should preserve native reasoning-delta when thinkingInText is disabled", async () => {
      async function* generateStream() {
        yield { type: "reasoning-start", id: "reasoning-0" };
        yield { type: "reasoning-delta", id: "reasoning-0", delta: "Thinking via API field..." };
        yield { type: "reasoning-end", id: "reasoning-0" };
        yield { type: "text-start", id: "txt-0" };
        yield { type: "text-delta", id: "txt-0", textDelta: "The actual answer." };
        yield { type: "text-end", id: "txt-0" };
        yield { type: "finish", usage: { promptTokens: 5, completionTokens: 15, totalTokens: 20 } };
      }

      (streamTextSpy as ReturnType<typeof vi.fn>).mockResolvedValue({
        fullStream: generateStream(),
      });

      const config: InvokeConfig = {
        model: "openai-compatible/test-model",
        apiKey: "sk-test",
      };
      // thinkingInText NOT configured → preserve native reasoning-delta behavior
      const result = await invoke(config, {
        messages: [{ role: "user", content: "Hello" }],
      }, { abort: undefined });

      const parsed = JSON.parse(result.result);
      expect(parsed.reasoning).toBe("Thinking via API field...");
      expect(parsed.content).toBe("The actual answer.");
    });
  });

  describe("convertToSDKMessages", () => {
    test("should preserve text content for assistant message with toolCalls", () => {
      const messages: LLMMessage[] = [{
        role: "assistant",
        content: "Let me search the web for that information.",
        toolCalls: [{
          id: "call_1",
          name: "bash",
          arguments: '{"command":"ls"}',
          function: { name: "bash", arguments: '{"command":"ls"}' },
        }],
      }];
      
      const result = convertToSDKMessages(messages);
      
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe("assistant");
      expect(Array.isArray(result[0].content)).toBe(true);
      const contentParts = result[0].content as unknown[];
      
      // Should contain a text part with the text content
      const textPart = contentParts.find((p: any) => p.type === "text");
      expect(textPart).toBeDefined();
      expect((textPart as any).text).toBe("Let me search the web for that information.");
      
      // Should also contain the tool-call part
      const toolCallPart = contentParts.find((p: any) => p.type === "tool-call");
      expect(toolCallPart).toBeDefined();
      expect((toolCallPart as any).toolCallId).toBe("call_1");
    });

    test("should handle assistant message with only toolCalls (no text)", () => {
      const messages: LLMMessage[] = [{
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call_2",
          name: "read_file",
          arguments: '{"path":"/tmp/test.txt"}',
          function: { name: "read_file", arguments: '{"path":"/tmp/test.txt"}' },
        }],
      }];
      
      const result = convertToSDKMessages(messages);
      
      const contentParts = result[0].content as unknown[];
      const textPart = contentParts.find((p: any) => p.type === "text");
      // When content is empty, no text part should be added (tool-call-only message)
      expect(textPart).toBeUndefined();
      
      const toolCallPart = contentParts.find((p: any) => p.type === "tool-call");
      expect(toolCallPart).toBeDefined();
    });

    test("should preserve text content with multiple toolCalls", () => {
      const messages: LLMMessage[] = [{
        role: "assistant",
        content: "Let me check multiple things at once.",
        toolCalls: [
          { id: "call_1", name: "bash", arguments: '{"command":"ls"}', function: { name: "bash", arguments: '{"command":"ls"}' } },
          { id: "call_2", name: "grep", arguments: '{"pattern":"test"}', function: { name: "grep", arguments: '{"pattern":"test"}' } },
        ],
      }];
      
      const result = convertToSDKMessages(messages);
      
      const contentParts = result[0].content as unknown[];
      const textPart = contentParts.find((p: any) => p.type === "text");
      expect(textPart).toBeDefined();
      expect((textPart as any).text).toBe("Let me check multiple things at once.");
      
      // Should have 3 parts total: 1 text + 2 tool-call
      expect(contentParts.length).toBe(3);
    });

    test("should pass through assistant message without toolCalls unchanged", () => {
      const messages: LLMMessage[] = [{
        role: "assistant",
        content: "This is a final response without tool calls.",
      }];
      
      const result = convertToSDKMessages(messages);
      
      // Without toolCalls, the message should pass through unchanged (content is a string)
      expect(result[0].content).toBe("This is a final response without tool calls.");
    });

    test("should convert tool message correctly", () => {
      const messages: LLMMessage[] = [{
        role: "tool",
        content: "command output",
        toolCallId: "call_1",
        name: "bash",
      }];
      
      const result = convertToSDKMessages(messages);
      
      expect(result[0].role).toBe("tool");
      expect(Array.isArray(result[0].content)).toBe(true);
      const parts = result[0].content as unknown[];
      const toolResultPart = parts.find((p: any) => p.type === "tool-result");
      expect(toolResultPart).toBeDefined();
      expect((toolResultPart as any).toolCallId).toBe("call_1");
    });

    test("should convert user message with array content (text + image)", () => {
      const messages: LLMMessage[] = [{
        role: "user",
        content: [
          { type: "text", text: "What's in this image?" },
          { type: "image", image: "data:image/jpeg;base64,/9j/4AAQ..." },
        ],
      }];
      
      const result = convertToSDKMessages(messages);
      
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe("user");
      expect(Array.isArray(result[0].content)).toBe(true);
      const contentParts = result[0].content as Array<Record<string, unknown>>;
      
      expect(contentParts).toHaveLength(2);
      expect(contentParts[0].type).toBe("text");
      expect(contentParts[0].text).toBe("What's in this image?");
      expect(contentParts[1].type).toBe("image");
      expect(contentParts[1].image).toContain("data:image/jpeg");
    });

    test("should convert user message with file part (data + mediaType)", () => {
      // v2.1: ContentPart.file maps to AI SDK FilePart { type: 'file', data, mediaType }
      const messages: LLMMessage[] = [{
        role: "user",
        content: [
          { type: "text", text: "Summarize this PDF" },
          { type: "file", file: "data:application/pdf;base64,JVBERi0=", mediaType: "application/pdf" },
        ],
      }];

      const result = convertToSDKMessages(messages);
      const contentParts = result[0].content as Array<Record<string, unknown>>;
      expect(contentParts).toHaveLength(2);
      expect(contentParts[1].type).toBe("file");
      expect(contentParts[1].data).toBe("data:application/pdf;base64,JVBERi0=");
      expect(contentParts[1].mediaType).toBe("application/pdf");
    });


    test("should pass through user and system messages unchanged", () => {
      const messages: LLMMessage[] = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello!" },
      ];
      
      const result = convertToSDKMessages(messages);
      
      expect(result[0].content).toBe("You are a helpful assistant.");
      expect(result[1].content).toBe("Hello!");
    });

    // ============================================================
    // Regression tests for code-review blockers B1 + B2
    // ============================================================

    test("B1 regression: assistant + ContentPart[] + toolCalls must NOT produce malformed text field", () => {
      // Regression: when assistant message has both ContentPart[] content AND toolCalls,
      // the ContentPart[] must NOT be naively shoved into a { type: "text", text: <array> } part.
      // Expected: text parts joined into a single string; tool-call parts kept alongside.
      const messages: LLMMessage[] = [{
        role: "assistant",
        content: [
          { type: "text", text: "Looking at the image..." },
          { type: "image", image: "data:image/png;base64,..." },
        ],
        toolCalls: [{
          id: "call_1",
          name: "search",
          arguments: '{"query":"cat"}',
          function: { name: "search", arguments: '{"query":"cat"}' },
        }],
      }];

      const result = convertToSDKMessages(messages);

      expect(result).toHaveLength(1);
      expect(result[0].role).toBe("assistant");
      const contentParts = result[0].content as unknown[];

      // Find the text part and ensure it does NOT contain the array
      const textPart = contentParts.find((p: any) => p.type === "text");
      expect(textPart).toBeDefined();
      expect(typeof (textPart as any).text).toBe("string");           // must be string, not array
      expect((textPart as any).text).toBe("Looking at the image...");  // actual text content

      // Ensure no ContentPart / base64 payload leaked into the text
      expect((textPart as any).text).not.toContain("data:image/png");
      expect((textPart as any).text).not.toContain("base64");

      // Ensure tool-call is still present
      const toolCallPart = contentParts.find((p: any) => p.type === "tool-call");
      expect(toolCallPart).toBeDefined();
      expect((toolCallPart as any).toolCallId).toBe("call_1");
      expect((toolCallPart as any).toolName).toBe("search");
    });

    test("B1 regression: assistant + ContentPart[] with only non-text parts joins empty text and keeps toolCalls", () => {
      // Edge case: assistant has ContentPart[] where every part is image (no text).
      // Expected: empty text string, tool-call still present, no malformed payload.
      const messages: LLMMessage[] = [{
        role: "assistant",
        content: [
          { type: "image", image: "data:image/png;base64,abc" },
        ],
        toolCalls: [{
          id: "call_2",
          name: "describe",
          arguments: "{}",
          function: { name: "describe", arguments: "{}" },
        }],
      }];

      const result = convertToSDKMessages(messages);

      expect(result).toHaveLength(1);
      const contentParts = result[0].content as unknown[];
      const textPart = contentParts.find((p: any) => p.type === "text");
      // No text in ContentPart[] → text part must be empty string (fallback), not the raw array
      expect(textPart).toBeDefined();
      expect((textPart as any).text).toBe("");

      const toolCallPart = contentParts.find((p: any) => p.type === "tool-call");
      expect(toolCallPart).toBeDefined();
      expect((toolCallPart as any).toolCallId).toBe("call_2");
    });

    test("B2 regression: image ContentPart converts to AI SDK ImagePart { type: 'image', image }", () => {
      // Regression: ContentPart.image must map to AI SDK's ImagePart shape (NOT image_url).
      const messages: LLMMessage[] = [{
        role: "user",
        content: [
          { type: "image", image: "data:image/png;base64,iVBORw0KGgo=" },
        ],
      }];

      const result = convertToSDKMessages(messages);
      const contentParts = result[0].content as unknown[];

      expect(contentParts).toHaveLength(1);
      // Must use AI SDK's "image" type, not "image_url"
      expect((contentParts[0] as any).type).toBe("image");
      expect((contentParts[0] as any).image).toBe("data:image/png;base64,iVBORw0KGgo=");
      // Legacy field must not appear
      expect((contentParts[0] as any).image_url).toBeUndefined();
    });

    test("B2 regression: file ContentPart produces AI SDK FilePart with required mediaType (not mimeType)", () => {
      // Regression: ContentPart.file must map to AI SDK's FilePart which requires
      // `data` (not `file`) and `mediaType` (not `mimeType`). mediaType must be set.
      const messages: LLMMessage[] = [{
        role: "user",
        content: [
          { type: "file", file: "data:application/pdf;base64,JVBERi0=", mediaType: "application/pdf" },
        ],
      }];

      const result = convertToSDKMessages(messages);
      const contentParts = result[0].content as unknown[];

      expect(contentParts).toHaveLength(1);
      expect((contentParts[0] as any).type).toBe("file");
      // AI SDK FilePart uses `data`, not `file`
      expect((contentParts[0] as any).data).toBe("data:application/pdf;base64,JVBERi0=");
      // AI SDK FilePart uses `mediaType` (required), not `mimeType`
      expect((contentParts[0] as any).mediaType).toBe("application/pdf");
      expect((contentParts[0] as any).mimeType).toBeUndefined();
      expect((contentParts[0] as any).file).toBeUndefined();
    });
  });

  // ============================================================
  // I4: extractUsageInfo exposes cacheRead / cacheWrite
  // (review-cache-stability.md: extractUsageInfo was dropping these fields)
  // ============================================================

  describe("extractUsageInfo - cache field pass-through (I4)", () => {
    test("should expose cacheRead from AI SDK inputTokens.cacheRead (v6 format)", () => {
      // AI SDK LanguageModelV3Usage: inputTokens is an object with { total, cacheRead, cacheWrite, noCache }
      const usage = {
        inputTokens: { total: 1500, cacheRead: 1400, noCache: 100 },
        outputTokens: { total: 50 },
        totalTokens: 1550,
      };
      const result = extractUsageInfo(usage);
      expect(result).toBeDefined();
      expect(result!.cacheRead).toBe(1400);
      expect(result!.promptTokens).toBe(1500);
      expect(result!.completionTokens).toBe(50);
      expect(result!.totalTokens).toBe(1550);
    });

    test("should expose cacheWrite from AI SDK inputTokens.cacheWrite", () => {
      const usage = {
        inputTokens: { total: 2000, cacheWrite: 2000 },
        outputTokens: { total: 30 },
        totalTokens: 2030,
      };
      const result = extractUsageInfo(usage);
      expect(result).toBeDefined();
      expect(result!.cacheWrite).toBe(2000);
    });

    test("should expose cacheRead from legacy inputTokenDetails.cacheReadTokens fallback", () => {
      // Legacy / MiniMax format: cacheRead/cacheWrite live inside inputTokenDetails
      const usage = {
        inputTokenDetails: { tokens: 1500, cacheReadTokens: 1400, cacheWriteTokens: 50 },
        outputTokenDetails: { tokens: 30 },
        totalTokens: 1530,
      };
      const result = extractUsageInfo(usage);
      expect(result).toBeDefined();
      expect(result!.cacheRead).toBe(1400);
      expect(result!.cacheWrite).toBe(50);
    });

    test("should return undefined cacheRead/cacheWrite when fields are missing (no throw)", () => {
      const usage = {
        inputTokens: { total: 100 },
        outputTokens: { total: 20 },
        totalTokens: 120,
      };
      const result = extractUsageInfo(usage);
      expect(result).toBeDefined();
      expect(result!.cacheRead).toBeUndefined();
      expect(result!.cacheWrite).toBeUndefined();
      // Standard fields still populated
      expect(result!.promptTokens).toBe(100);
    });

    test("should expose cacheRead=0 and cacheWrite=0 explicitly (real zero values, not undefined)", () => {
      const usage = {
        inputTokens: { total: 100, cacheRead: 0, cacheWrite: 0, noCache: 100 },
        outputTokens: { total: 20 },
        totalTokens: 120,
      };
      const result = extractUsageInfo(usage);
      expect(result).toBeDefined();
      // 0 is meaningful (cache was checked, none hit) — keep it as 0, not undefined
      expect(result!.cacheRead).toBe(0);
      expect(result!.cacheWrite).toBe(0);
    });
  });

  describe("invoke - end-to-end cacheRead propagation via stream finish event (I4)", () => {
    test("should publish cacheRead in completed event metadata when AI SDK yields cacheRead", async () => {
      async function* generateStream() {
        yield { type: "text-delta", textDelta: "hi" };
        yield {
          type: "finish",
          totalUsage: {
            inputTokens: { total: 1500, cacheRead: 1400, noCache: 100 },
            outputTokens: { total: 20 },
            totalTokens: 1520,
          },
        };
      }
      (streamTextSpy as ReturnType<typeof vi.fn>).mockResolvedValue({
        fullStream: generateStream(),
      });

      let capturedCompleted: any = null;
      const fakeEnv = {
        pushEnvEvent: (evt: any) => {
          if (evt.type === "llm.completed") capturedCompleted = evt;
        },
        subscribeTo: () => () => {},
        getComponent: () => undefined,
      } as any;

      const config: InvokeConfig = {
        model: "anthropic/claude-sonnet-4.5",
        apiKey: "sk-test",
      };
      const opts: InvokeOptions = {
        messages: [{ role: "user", content: "hi" }],
        env: fakeEnv,
        context: { sessionId: "s1", messageId: "m1" },
      };

      await invoke(config, opts, { abort: undefined });

      expect(capturedCompleted).not.toBeNull();
      expect(capturedCompleted.payload.metadata.usage.cacheRead).toBe(1400);
    });
  });

  // ============================================================
  // I1: convertToSDKMessages inserts Anthropic cacheControl breakpoints
  // (review-cache-stability.md: AI SDK v6 anthropic provider only emits
  //  cache_control: { type: "ephemeral" } when providerOptions.anthropic.
  //  cacheControl is set on a content part. Without these breakpoints
  //  Anthropic will not cache anything and we'll pay full input price
  //  on every turn.)
  //
  // We set at most 2 breakpoints (system + last user) — well below the
  //  Anthropic limit of 4 per request.
  // ============================================================

  describe("convertToSDKMessages - Anthropic cacheControl breakpoints (I1)", () => {
    test("system message carries providerOptions.anthropic.cacheControl=ephemeral", () => {
      const messages: LLMMessage[] = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "hi" },
      ];

      const result = convertToSDKMessages(messages);
      const sysMsg = result.find((m) => m.role === "system");
      expect(sysMsg).toBeDefined();
      expect((sysMsg as any).providerOptions).toEqual({
        anthropic: { cacheControl: { type: "ephemeral" } },
      });
    });

    test("last user message carries providerOptions.anthropic.cacheControl=ephemeral", () => {
      const messages: LLMMessage[] = [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "first question" },
        { role: "assistant", content: "answer 1" },
        { role: "user", content: "second question" }, // ← last user
      ];

      const result = convertToSDKMessages(messages);
      const userMsgs = result.filter((m) => m.role === "user");
      expect(userMsgs).toHaveLength(2);

      // First user message MUST NOT have cacheControl (intermediate)
      expect((userMsgs[0] as any).providerOptions).toBeUndefined();

      // Last user message MUST have cacheControl
      expect((userMsgs[1] as any).providerOptions).toEqual({
        anthropic: { cacheControl: { type: "ephemeral" } },
      });
    });

    test("intermediate user messages do NOT carry cacheControl (only last does)", () => {
      const messages: LLMMessage[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
        { role: "assistant", content: "a2" },
        { role: "user", content: "u3 (last)" },
      ];

      const result = convertToSDKMessages(messages);
      const userMsgs = result.filter((m) => m.role === "user");
      expect(userMsgs).toHaveLength(3);
      expect((userMsgs[0] as any).providerOptions).toBeUndefined();
      expect((userMsgs[1] as any).providerOptions).toBeUndefined();
      expect((userMsgs[2] as any).providerOptions).toEqual({
        anthropic: { cacheControl: { type: "ephemeral" } },
      });
    });

    test("multimodal last user message attaches cacheControl to the last text part", () => {
      // When the user message has ContentPart[] (multimodal), cacheControl
      // should land on the LAST part — Anthropic treats the cache breakpoint
      // as "everything before this part is cacheable".
      const messages: LLMMessage[] = [
        { role: "system", content: "sys" },
        {
          role: "user",
          content: [
            { type: "text", text: "what's in this image?" },
            { type: "image", image: "data:image/png;base64,AAAA" },
          ],
        },
      ];

      const result = convertToSDKMessages(messages);
      const userMsg = result.find((m) => m.role === "user")!;
      const parts = userMsg.content as Array<Record<string, unknown>>;
      expect(parts).toHaveLength(2);

      // Last part must carry providerOptions.anthropic.cacheControl
      const lastPart = parts[parts.length - 1];
      expect((lastPart as any).providerOptions).toEqual({
        anthropic: { cacheControl: { type: "ephemeral" } },
      });
    });

    test("total cacheControl breakpoints never exceed Anthropic limit of 4", () => {
      // Build a long conversation (5 user messages) — only the LAST should
      // get cacheControl, so we have at most 2 breakpoints total
      // (system + last user).
      const messages: LLMMessage[] = [];
      messages.push({ role: "system", content: "sys" });
      for (let i = 0; i < 5; i++) {
        messages.push({ role: "user", content: `u${i}` });
        if (i < 4) messages.push({ role: "assistant", content: `a${i}` });
      }

      const result = convertToSDKMessages(messages);

      // Count breakpoints
      let count = 0;
      for (const msg of result) {
        const po = (msg as any).providerOptions as
          | { anthropic?: { cacheControl?: { type: string } } }
          | undefined;
        if (po?.anthropic?.cacheControl) count++;

        // Also check inline parts (multimodal user msg)
        if (Array.isArray((msg as any).content)) {
          for (const part of (msg as any).content) {
            const partPo = part?.providerOptions as
              | { anthropic?: { cacheControl?: { type: string } } }
              | undefined;
            if (partPo?.anthropic?.cacheControl) count++;
          }
        }
      }

      // system (1) + last user (1) = 2, well below limit of 4
      expect(count).toBeLessThanOrEqual(4);
      expect(count).toBe(2); // exact assertion
    });

    test("cacheControl uses type='ephemeral' (Anthropic's only valid value)", () => {
      const messages: LLMMessage[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ];

      const result = convertToSDKMessages(messages);
      const sysPo = (result.find((m) => m.role === "system") as any).providerOptions;
      const userPo = (result.find((m) => m.role === "user") as any).providerOptions;

      // Anthropic only accepts { type: "ephemeral" } at the moment
      expect(sysPo.anthropic.cacheControl.type).toBe("ephemeral");
      expect(userPo.anthropic.cacheControl.type).toBe("ephemeral");
    });
  });

  // ============================================================
  // I2: tool-call input serialization stability
  // (review-cache-stability.md: AI SDK's JSON.stringify of tool-call
  //  input is key-order sensitive; if the LLM emits the same tool call
  //  with keys in different orders across turns, the cache prefix shifts
  //  and Anthropic sees a miss. We sort keys recursively to make the
  //  bytes deterministic regardless of LLM key ordering.)
  // ============================================================

  describe("sortObjectKeysDeep - tool-call input serialization (I2)", () => {
    test("returns primitives unchanged", () => {
      expect(sortObjectKeysDeep(1)).toBe(1);
      expect(sortObjectKeysDeep("hello")).toBe("hello");
      expect(sortObjectKeysDeep(true)).toBe(true);
      expect(sortObjectKeysDeep(null)).toBe(null);
      expect(sortObjectKeysDeep(undefined)).toBe(undefined);
    });

    test("sorts top-level keys alphabetically", () => {
      const input = { b: 2, a: 1, c: 3 };
      const result = sortObjectKeysDeep(input);
      expect(Object.keys(result as object)).toEqual(["a", "b", "c"]);
      // Original input is unchanged (we return a new object)
      expect(Object.keys(input)).toEqual(["b", "a", "c"]);
    });

    test("sorts nested object keys recursively", () => {
      const input = { b: { d: 1, c: 2 }, a: 1 };
      const result = sortObjectKeysDeep(input) as Record<string, unknown>;
      expect(Object.keys(result)).toEqual(["a", "b"]);
      const nested = result.b as Record<string, unknown>;
      expect(Object.keys(nested)).toEqual(["c", "d"]);
      expect(nested.c).toBe(2);
      expect(nested.d).toBe(1);
    });

    test("does not reorder array elements (order is meaningful in arrays)", () => {
      const input = { list: [3, 1, 2] };
      const result = sortObjectKeysDeep(input) as Record<string, unknown>;
      expect((result.list as number[])).toEqual([3, 1, 2]); // unchanged
    });

    test("preserves Uint8Array / Buffer without serializing their bytes", () => {
      const buf = Buffer.from([1, 2, 3, 4]);
      const input = { data: buf, name: "img" };
      const result = sortObjectKeysDeep(input) as Record<string, unknown>;
      // Buffer is a Uint8Array subclass — preserve identity
      expect(result.data).toBe(buf);
      expect(Object.keys(result)).toEqual(["data", "name"]);
    });

    test("JSON.stringify output is byte-level stable for two equivalent inputs with different key orders", () => {
      const inputA = { a: 1, b: 2, c: 3, nested: { x: 10, y: 20 } };
      const inputB = { nested: { y: 20, x: 10 }, c: 3, b: 2, a: 1 };

      const sortedA = JSON.stringify(sortObjectKeysDeep(inputA));
      const sortedB = JSON.stringify(sortObjectKeysDeep(inputB));

      expect(sortedA).toBe(sortedB);
      // And the canonical order should be alphabetical
      expect(sortedA).toBe('{"a":1,"b":2,"c":3,"nested":{"x":10,"y":20}}');
    });

    test("integration: tool-call input from LLM is byte-stable across key orderings", () => {
      // Simulate LLM emitting the same tool call with different key orders
      const tcA = [{ type: "tool-call", toolCallId: "x", toolName: "search", input: { query: "cat", limit: 5 } }];
      const tcB = [{ type: "tool-call", toolCallId: "x", toolName: "search", input: { limit: 5, query: "cat" } }];

      const messages: LLMMessage[] = [{
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "x",
          name: "search",
          arguments: JSON.stringify(tcA[0].input),
          function: { name: "search", arguments: JSON.stringify(tcA[0].input) },
        }],
      }];

      const resultA = convertToSDKMessages(messages);
      const contentA = (resultA[0].content as Array<{ input: unknown }>)[0].input;

      messages[0].toolCalls![0].arguments = JSON.stringify(tcB[0].input);
      messages[0].toolCalls![0].function!.arguments = JSON.stringify(tcB[0].input);

      const resultB = convertToSDKMessages(messages);
      const contentB = (resultB[0].content as Array<{ input: unknown }>)[0].input;

      // Both should be deeply equal AND serialize to the same bytes
      expect(JSON.stringify(contentA)).toBe(JSON.stringify(contentB));
    });

    // ============================================================================
    // Major #1: special-type identity preservation (review-cache-stability-v2.md)
    // Major #2: cycle detection
    // ============================================================================

    test("passes Date through with identity (not coerced to {})", () => {
      const d = new Date("2026-07-06T00:00:00Z");
      const result = sortObjectKeysDeep(d);
      expect(result).toBe(d); // identity preserved
      expect(result instanceof Date).toBe(true);
      expect((result as Date).getTime()).toBe(d.getTime());
    });

    test("passes RegExp through with identity (preserves source + flags)", () => {
      const re = /pattern/gi;
      const result = sortObjectKeysDeep(re);
      expect(result).toBe(re); // identity preserved
      expect(result instanceof RegExp).toBe(true);
      expect((result as RegExp).source).toBe("pattern");
      expect((result as RegExp).flags).toBe("gi");
    });

    test("converts Map to plain object with sorted keys + recursively sorted values", () => {
      const m = new Map<string, unknown>([
        ["b", 2],
        ["a", 1],
      ]);
      const result = sortObjectKeysDeep(m) as Record<string, unknown>;
      expect(result instanceof Map).toBe(false);
      expect(Object.keys(result)).toEqual(["a", "b"]);
      expect(result.a).toBe(1);
      expect(result.b).toBe(2);
    });

    test("converts Set to a sorted array of elements", () => {
      const s = new Set([3, 1, 2]);
      const result = sortObjectKeysDeep(s);
      expect(result instanceof Set).toBe(false);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toEqual([1, 2, 3]);
    });

    test("preserves nested Date inside an object (does not coerce to {})", () => {
      const meta = { created: new Date("2026-07-06T00:00:00Z"), name: "log" };
      const result = sortObjectKeysDeep(meta) as Record<string, unknown>;
      expect(Object.keys(result)).toEqual(["created", "name"]);
      expect(result.created instanceof Date).toBe(true);
      expect((result.created as Date).getTime()).toBe(meta.created.getTime());
      expect(result.name).toBe("log");
    });

    test("passes class instances through with identity (preserves prototype methods)", () => {
      class Counter {
        public readonly n: number;
        constructor(n: number) {
          this.n = n;
        }
        public inc(): number {
          return this.n + 1;
        }
      }
      const c = new Counter(41);
      const result = sortObjectKeysDeep(c);
      // Identity preserved so prototype methods remain accessible
      expect(result).toBe(c);
      expect(result instanceof Counter).toBe(true);
      expect((result as Counter).inc()).toBe(42);
    });

    test("cyclic reference does not throw RangeError (cycle node kept as-is)", () => {
      const cyc: Record<string, unknown> = { a: 1 };
      cyc.self = cyc;
      // Must not throw — the cycle node should be preserved as-is rather than recursed into infinitely
      expect(() => sortObjectKeysDeep(cyc)).not.toThrow();
      const result = sortObjectKeysDeep(cyc) as Record<string, unknown>;
      expect(result.a).toBe(1);
      // The cycle reference is preserved as-is (identity) — recursing would RangeError
      expect(result.self).toBe(cyc);
    });

    test("nested cyclic reference inside array also does not throw", () => {
      const cyc: Record<string, unknown> = { x: 1 };
      cyc.self = cyc;
      const arr = [{ wrap: cyc }];
      expect(() => sortObjectKeysDeep(arr)).not.toThrow();
      const result = sortObjectKeysDeep(arr) as Array<Record<string, unknown>>;
      expect(Array.isArray(result)).toBe(true);
      expect(result[0].wrap.x).toBe(1);
      // Cycle preserved via identity
      expect((result[0].wrap as { self: unknown }).self).toBe(cyc);
    });

    test("WeakSet/WeakMap do not throw (pass-through acceptable)", () => {
      const ws = new WeakSet();
      const wm = new WeakMap();
      // Pure identity passthrough is acceptable — these are intentionally opaque from JSON standpoint
      expect(() => sortObjectKeysDeep(ws)).not.toThrow();
      expect(() => sortObjectKeysDeep(wm)).not.toThrow();
    });
  });
});
