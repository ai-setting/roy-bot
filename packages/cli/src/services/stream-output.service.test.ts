/**
 * @fileoverview StreamOutputService Tests
 */

import { describe, test, expect, beforeEach, vi } from "bun:test";
import { StreamOutputService, resetStreamAbort } from "./stream-output.service";
import type { EnvEvent } from "@ai-setting/roy-bot-core";

describe("StreamOutputService", () => {
  let service: StreamOutputService;
  
  beforeEach(() => {
    // 重置全局 abort 状态，避免被其他测试污染
    resetStreamAbort();
    service = new StreamOutputService();
  });

  describe("handleEvent", () => {
    test("should collect text deltas", () => {
      const textEvent: EnvEvent = {
        id: "1",
        type: "llm.text",
        timestamp: Date.now(),
        metadata: {},
        payload: { delta: "Hello" }
      };
      
      service.handleEvent(textEvent);
      expect(service.getFullText()).toBe("Hello");
    });

    test("should accumulate text deltas", () => {
      const event1: EnvEvent = {
        id: "1",
        type: "llm.text",
        timestamp: Date.now(),
        metadata: {},
        payload: { delta: "Hello " }
      };
      
      const event2: EnvEvent = {
        id: "2",
        type: "llm.text",
        timestamp: Date.now(),
        metadata: {},
        payload: { delta: "world" }
      };
      
      service.handleEvent(event1);
      service.handleEvent(event2);
      expect(service.getFullText()).toBe("Hello world");
    });

    test("should handle reasoning events when showReasoning is enabled", () => {
      const reasoningService = new StreamOutputService({ showReasoning: true });
      
      const reasoningEvent: EnvEvent = {
        id: "1",
        type: "llm.reasoning",
        timestamp: Date.now(),
        metadata: {},
        payload: { content: "Let me think...", delta: "Let me think..." }
      };
      
      // Should not throw
      expect(() => reasoningService.handleEvent(reasoningEvent)).not.toThrow();
    });

    test("should accumulate reasoning deltas", () => {
      const reasoningService = new StreamOutputService({ showReasoning: true });

      reasoningService.handleEvent({
        id: "1",
        type: "llm.reasoning",
        timestamp: Date.now(),
        metadata: {},
        payload: { content: "Let", delta: "Let" },
      });

      reasoningService.handleEvent({
        id: "2",
        type: "llm.reasoning",
        timestamp: Date.now(),
        metadata: {},
        payload: { content: "Let me", delta: " me" },
      });

      expect((reasoningService as any).fullReasoning).toBe("Let me");
    });

    test("should ignore reasoning events when showReasoning is disabled", () => {
      const reasoningService = new StreamOutputService({ showReasoning: false });
      
      const reasoningEvent: EnvEvent = {
        id: "1",
        type: "llm.reasoning",
        timestamp: Date.now(),
        metadata: {},
        payload: { content: "Let me think..." }
      };
      
      // Should not throw
      expect(() => reasoningService.handleEvent(reasoningEvent)).not.toThrow();
    });

    test("should close reasoning block before text, not re-open on post-text reasoning", () => {
      const reasoningService = new StreamOutputService({ showReasoning: true });
      const writes: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

      reasoningService.handleEvent({
        id: "1",
        type: "llm.reasoning",
        timestamp: Date.now(),
        metadata: {},
        payload: { delta: "thinking..." },
      });

      reasoningService.handleEvent({
        id: "2",
        type: "llm.text",
        timestamp: Date.now(),
        metadata: {},
        payload: { delta: "answer" },
      });

      const output = writes.join("");
      expect(output).toContain("思考过程");
      expect(output).toContain("thinking...");
      expect(output).toContain("answer");
      // Block closed by text → footer present
      expect(output).toMatch(/thinking\.\.\.\n└/);
      // answer should be AFTER the footer
      const footerIdx = output.search(/└─+/);
      const answerIdx = output.indexOf("answer");
      expect(answerIdx).toBeGreaterThan(footerIdx);

      vi.spyOn(process.stdout, "write").mockRestore();
    });

    test("should NOT close reasoning block on empty text deltas (thinkingInText mode)", () => {
      const reasoningService = new StreamOutputService({ showReasoning: true });
      const writes: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

      // reasoning delta — 被缓冲，不立即显示
      reasoningService.handleEvent({
        id: "1",
        type: "llm.reasoning",
        timestamp: Date.now(),
        metadata: {},
        payload: { delta: "思考中..." },
      });

      // empty text delta — should NOT flush the buffer or close
      reasoningService.handleEvent({
        id: "2",
        type: "llm.text",
        timestamp: Date.now(),
        metadata: {},
        payload: { delta: "" },
      });

      // more reasoning — still buffered, no box opened yet
      reasoningService.handleEvent({
        id: "3",
        type: "llm.reasoning",
        timestamp: Date.now(),
        metadata: {},
        payload: { delta: "更多思考..." },
      });

      const output = writes.join("");

      // Reasoning is buffered — NO header or divider yet
      expect((output.match(/思考过程/g) || []).length).toBe(0);
      expect(output).not.toMatch(/└─+/);

      // Now send substantive text — should flush buffer, open box, close, write text
      reasoningService.handleEvent({
        id: "4",
        type: "llm.text",
        timestamp: Date.now(),
        metadata: {},
        payload: { delta: "回答内容" },
      });

      const output2 = writes.join("");

      // After substantive text: ONE header, divider present
      expect((output2.match(/思考过程/g) || []).length).toBe(1);
      expect(output2).toMatch(/└─+/);
      // buffered reasoning should be inside the box
      expect(output2).toContain("思考中...");
      expect(output2).toContain("更多思考...");
      // "回答内容" should be AFTER the divider
      const divIdx = output2.search(/└─+/);
      const answerIdx2 = output2.indexOf("回答内容");
      expect(answerIdx2).toBeGreaterThan(divIdx);

      vi.spyOn(process.stdout, "write").mockRestore();
    });

    test("post-text reasoning from same LLM call should be silently dropped", () => {
      const reasoningService = new StreamOutputService({ showReasoning: true });
      const writes: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

      reasoningService.handleEvent({ id: "0", type: "llm.start", timestamp: Date.now(), metadata: {}, payload: {} });
      reasoningService.handleEvent({ id: "1", type: "llm.reasoning", timestamp: Date.now(), metadata: {}, payload: { delta: "第一段思考" } });
      reasoningService.handleEvent({ id: "2", type: "llm.text", timestamp: Date.now(), metadata: {}, payload: { delta: "第一段回答" } });
      // Same LLM call, more reasoning after text → DROPPED
      reasoningService.handleEvent({ id: "3", type: "llm.reasoning", timestamp: Date.now(), metadata: {}, payload: { delta: "后续思考" } });

      const output = writes.join("");
      expect((output.match(/思考过程/g) || []).length).toBe(1);
      expect(output).not.toContain("后续思考");
      expect(output).toContain("第一段思考");
      expect(output).toContain("第一段回答");
      vi.spyOn(process.stdout, "write").mockRestore();
    });

    test("second LLM call after tool should show its own reasoning (new llm.start resets state)", () => {
      const reasoningService = new StreamOutputService({ showReasoning: true, showToolCalls: true });
      const writes: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

      // First LLM call
      reasoningService.handleEvent({
        id: "0", type: "llm.start", timestamp: Date.now(), metadata: {}, payload: {},
      });
      reasoningService.handleEvent({
        id: "1", type: "llm.reasoning", timestamp: Date.now(), metadata: {},
        payload: { delta: "第一步思考" },
      });
      reasoningService.handleEvent({
        id: "2", type: "llm.text", timestamp: Date.now(), metadata: {},
        payload: { delta: "第一步回答" },
      });
      reasoningService.handleEvent({
        id: "3", type: "llm.completed", timestamp: Date.now(), metadata: {}, payload: {},
      });

      // Tool call
      reasoningService.handleEvent({
        id: "4", type: "tool.call", timestamp: Date.now(), metadata: {},
        payload: { name: "bash", arguments: { command: "ls" } },
      });

      // Second LLM call — should show its own reasoning
      reasoningService.handleEvent({
        id: "5", type: "llm.start", timestamp: Date.now(), metadata: {}, payload: {},
      });
      reasoningService.handleEvent({
        id: "6", type: "llm.reasoning", timestamp: Date.now(), metadata: {},
        payload: { delta: "第二步思考" },
      });
      reasoningService.handleEvent({
        id: "7", type: "llm.text", timestamp: Date.now(), metadata: {},
        payload: { delta: "第二步回答" },
      });

      const output = writes.join("");

      // TWO reasoning headers (one for each LLM call)
      expect((output.match(/思考过程/g) || []).length).toBe(2);
      // Both reasoning contents visible
      expect(output).toContain("第一步思考");
      expect(output).toContain("第二步思考");
      // Tool call present
      expect(output).toContain("🔧 [Tool]");

      vi.spyOn(process.stdout, "write").mockRestore();
    });

    test.skipIf(!!process.env.BUN_TEST_WORKER_ID)("should NOT split reasoning across interleaved text events (regression: 019e95304...)", () => {
      const reasoningService = new StreamOutputService({ showReasoning: true });
      const writes: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

      // Sequence from session 019e95304d43450bcb255fd28e8f85e1
      reasoningService.handleEvent({
        id: "1",
        type: "llm.reasoning",
        timestamp: Date.now(),
        metadata: {},
        payload: { content: "\n用户想", delta: "\n用户想" },
      });
      reasoningService.handleEvent({
        id: "2",
        type: "llm.text",
        timestamp: Date.now(),
        metadata: {},
        payload: { delta: "让我检索 GitHub 上的 hermes 项目。" },
      });
      reasoningService.handleEvent({
        id: "3",
        type: "llm.reasoning",
        timestamp: Date.now(),
        metadata: {},
        payload: {
          content: "\n用户想类任务，我应该使用 `delegate_task` 委托给子智能体执行。",
          delta: "类任务，我应该使用 `delegate_task` 委托给子智能体执行。",
        },
      });
      reasoningService.handleEvent({
        id: "4",
        type: "llm.text",
        timestamp: Date.now(),
        metadata: {},
        payload: { delta: "根据我的角色规则..." },
      });
      reasoningService.handleEvent({
        id: "5",
        type: "llm.text",
        timestamp: Date.now(),
        metadata: {},
        payload: { delta: "我来帮你检索..." },
      });
      reasoningService.handleEvent({
        id: "6",
        type: "llm.completed",
        timestamp: Date.now(),
        metadata: {},
        payload: { content: "Full response" },
      });

      const output = writes.join("");

      // REGRESSION: should be exactly ONE "思考过程" header (not two)
      const openCount = (output.match(/思考过程/g) || []).length;
      expect(openCount).toBe(1);

      // First reasoning content should come BEFORE the first text
      expect(output).toContain("用户想");
      const firstReasoningIdx = output.indexOf("用户想");
      const firstTextIdx = output.indexOf("让我检索");
      expect(firstReasoningIdx).toBeLessThan(firstTextIdx);

      // Post-text reasoning ("类任务") is silently dropped — NOT in output
      // Only text content appears after the divider
      expect(output).toContain("根据我的角色规则...");
      expect(output).toContain("我来帮你检索...");

      vi.spyOn(process.stdout, "write").mockRestore();
    });

    test("close footer should adapt to content width (no hardcoded 20-char divider)", () => {
      const reasoningService = new StreamOutputService({ showReasoning: true });
      const writes: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

      // Long reasoning
      reasoningService.handleEvent({
        id: "1",
        type: "llm.reasoning",
        timestamp: Date.now(),
        metadata: {},
        payload: { delta: "a".repeat(50) },
      });
      reasoningService.handleEvent({
        id: "2",
        type: "llm.completed",
        timestamp: Date.now(),
        metadata: {},
        payload: {},
      });

      const output = writes.join("");

      // Should have a divider
      const dividerMatch = output.match(/└(─+)/);
      expect(dividerMatch).not.toBeNull();

      // Should NOT have hardcoded 20-char divider (content is 50 chars, so divider should be 40)
      const dashCount = dividerMatch![1].length;
      expect(dashCount).not.toBe(20);
      // Dynamic width: 50 chars of content → capped at 40
      expect(dashCount).toBeGreaterThan(20);

      vi.spyOn(process.stdout, "write").mockRestore();
    });

    test("should handle tool.call events when showToolCalls is enabled", () => {
      const toolService = new StreamOutputService({ showToolCalls: true });
      
      const toolEvent: EnvEvent = {
        id: "1",
        type: "tool.call",
        timestamp: Date.now(),
        metadata: {},
        payload: { 
          id: "call_123",
          name: "bash",
          arguments: { command: "ls" },
        }
      };
      
      expect(() => toolService.handleEvent(toolEvent)).not.toThrow();
    });

    test("should close reasoning block on tool.error", () => {
      const reasoningService = new StreamOutputService({ showReasoning: true, showToolResults: true });
      const writes: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

      // Open reasoning block
      reasoningService.handleEvent({
        id: "1",
        type: "llm.reasoning",
        timestamp: Date.now(),
        metadata: {},
        payload: { delta: "thinking..." },
      });

      // Tool error occurs
      reasoningService.handleEvent({
        id: "2",
        type: "tool.error",
        timestamp: Date.now(),
        metadata: {},
        payload: { toolName: "bash", error: "command not found" },
      });

      const output = writes.join("");
      // Reasoning block should be closed before the error message
      expect(output).toMatch(/└─+/);
      expect(output).toContain("command not found");

      vi.spyOn(process.stdout, "write").mockRestore();
    });

    test("phase=end should NOT close reasoning block (native reasoning-end, text follows)", () => {
      const reasoningService = new StreamOutputService({ showReasoning: true });
      const writes: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

      // Open reasoning block
      reasoningService.handleEvent({
        id: "1",
        type: "llm.reasoning",
        timestamp: Date.now(),
        metadata: {},
        payload: { delta: "thinking...", phase: "start" },
      });

      // End reasoning with phase=end — should NOT close the block
      reasoningService.handleEvent({
        id: "2",
        type: "llm.reasoning",
        timestamp: Date.now(),
        metadata: {},
        payload: { content: "thinking...", phase: "end" },
      });

      const output = writes.join("");
      // No divider — block is still open
      expect(output).not.toMatch(/└─+/);

      // Now text arrives — should close the block
      reasoningService.handleEvent({
        id: "3",
        type: "llm.text",
        timestamp: Date.now(),
        metadata: {},
        payload: { delta: "回答内容" },
      });

      const output2 = writes.join("");
      // After text: divider appears
      expect(output2).toMatch(/└─+/);
      expect(output2).toContain("回答内容");

      vi.spyOn(process.stdout, "write").mockRestore();
    });

    test("should handle completed event and extract usage info", () => {
      const completedEvent: EnvEvent = {
        id: "1",
        type: "llm.completed",
        timestamp: Date.now(),
        metadata: {},
        payload: {
          content: "Final response",
          metadata: {
            model: "minimax/MiniMax-M2.5-highspeed",
            usage: {
              promptTokens: 1000,
              completionTokens: 500,
              totalTokens: 1500,
            },
          },
        },
      };

      // Should not throw
      expect(() => service.handleEvent(completedEvent)).not.toThrow();

      // Verify usage info is extracted
      const usageInfo = service.getUsageInfo();
      expect(usageInfo).toEqual({
        model: "MiniMax-M2.5-highspeed",
        providerId: "minimax",
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
      });
    });

    test("should handle completed event without usage info", () => {
      const completedEvent: EnvEvent = {
        id: "1",
        type: "llm.completed",
        timestamp: Date.now(),
        metadata: {},
        payload: {
          content: "Final response",
        },
      };

      // Should not throw
      expect(() => service.handleEvent(completedEvent)).not.toThrow();

      // Usage info should be undefined
      const usageInfo = service.getUsageInfo();
      expect(usageInfo).toBeUndefined();
    });

    test("should reset usage info on reset", () => {
      const completedEvent: EnvEvent = {
        id: "1",
        type: "llm.completed",
        timestamp: Date.now(),
        metadata: {},
        payload: {
          content: "Final response",
          metadata: {
            model: "minimax/MiniMax-M2.5-highspeed",
            usage: {
              promptTokens: 1000,
              completionTokens: 500,
              totalTokens: 1500,
            },
          },
        },
      };

      service.handleEvent(completedEvent);
      expect(service.getUsageInfo()).toBeDefined();

      service.reset();
      expect(service.getUsageInfo()).toBeUndefined();
    });

    test("should handle start event", () => {
      const startEvent: EnvEvent = {
        id: "1",
        type: "llm.start",
        timestamp: Date.now(),
        metadata: {},
        payload: { metadata: { model: "test-model" } }
      };
      
      // Should not throw
      expect(() => service.handleEvent(startEvent)).not.toThrow();
    });
  });

  describe("markdown rendering integration", () => {
    test("handleText injects ANSI for headings + bold", () => {
      const writes: string[] = [];
      const spy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk: string | Uint8Array) => {
          writes.push(typeof chunk === "string" ? chunk : chunk.toString());
          return true;
        });

      try {
        const svc = new StreamOutputService();
        svc.handleEvent({
          id: "1",
          type: "llm.text",
          timestamp: Date.now(),
          metadata: {},
          payload: { delta: "# Title\n**bold**" },
        });
        const joined = writes.join("");
        expect(joined).toContain("\x1b[1m");
        expect(joined).toContain("bold");
        expect(joined).toContain("Title");
        // Strong RED checks: raw markdown markers must be replaced by ANSI.
        expect(joined).not.toContain("# Title");
        expect(joined).not.toContain("**bold**");
      } finally {
        spy.mockRestore();
      }
    });

    test("handleText accumulates fenced code block across deltas", () => {
      const writes: string[] = [];
      const spy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk: string | Uint8Array) => {
          writes.push(typeof chunk === "string" ? chunk : chunk.toString());
          return true;
        });

      try {
        const svc = new StreamOutputService();
        svc.handleEvent({
          id: "1",
          type: "llm.text",
          timestamp: Date.now(),
          metadata: {},
          payload: { delta: "```ts\ncon" },
        });
        svc.handleEvent({
          id: "2",
          type: "llm.text",
          timestamp: Date.now(),
          metadata: {},
          payload: { delta: "st x = 1;\n```" },
        });
        const joined = writes.join("");
        expect(joined).toContain("const x = 1;");
        expect(joined).toContain("ts");
        // Strong RED checks: fence frame must be emitted, raw ``` must
        // not survive in output.
        expect(joined).toContain("┌─");
        expect(joined).toContain("└─");
        expect(joined).not.toContain("```");
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("reset", () => {
    test("should reset fullText", () => {
      const textEvent: EnvEvent = {
        id: "1",
        type: "llm.text",
        timestamp: Date.now(),
        metadata: {},
        payload: { delta: "Hello" }
      };

      service.handleEvent(textEvent);
      expect(service.getFullText()).toBe("Hello");

      service.reset();
      expect(service.getFullText()).toBe("");
    });
  });

  describe("tool.call rendering (Task #2213: simplified format)", () => {
    test("should render `🔧 [Tool] <name> call` without leaking arguments, commands, paths, or workdir", () => {
      const service = new StreamOutputService({ showToolCalls: true });
      const writes: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

      service.handleEvent({
        id: "tc-1",
        type: "tool.call",
        timestamp: Date.now(),
        metadata: {},
        payload: {
          id: "call_123",
          name: "bash",
          arguments: {
            command: "rm -rf / --no-preserve-root",
            workdir: "/tmp/secret",
            path: "/etc/passwd",
          },
        },
      });

      const output = writes.join("");

      // Required simplified shape
      expect(output).toContain("🔧 [Tool] bash call");
      expect(output).not.toContain("rm -rf");
      expect(output).not.toContain("/tmp/secret");
      expect(output).not.toContain("/etc/passwd");
      expect(output).not.toContain("workdir");
      expect(output).not.toContain('"command"');
      expect(output).not.toContain('"path"');
      expect(output).not.toContain('"arguments"');
      expect(output).not.toContain("call_123");

      vi.spyOn(process.stdout, "write").mockRestore();
    });

    test("should fallback to `unknown` while still emitting `🔧 [Tool] unknown call`", () => {
      const service = new StreamOutputService({ showToolCalls: true });
      const writes: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

      service.handleEvent({
        id: "tc-2",
        type: "tool.call",
        timestamp: Date.now(),
        metadata: {},
        payload: {},
      });

      const output = writes.join("");
      expect(output).toContain("🔧 [Tool] unknown call");

      vi.spyOn(process.stdout, "write").mockRestore();
    });
  });

  // ============================================================
  // Task #2237: handleText pure-whitespace delta preservation
  //
  // LLM streaming tokens can be split mid-sentence such that adjacent
  // tokens straddle a space boundary, e.g. `["via", " ", "JSONL"]` or
  // `["function", " ", "call"]`. The middle token is pure whitespace
  // and must be preserved as part of fullText/stdout — otherwise the
  // rendered output collapses to `viaJSONL` / `functioncall` / etc.
  // ============================================================
  describe("handleText: token-boundary whitespace (Task #2237)", () => {
    /** Helper: send a sequence of llm.text deltas and return joined stdout. */
    function streamDeltas(deltas: string[]): { output: string; fullText: string } {
      const writes: string[] = [];
      const spy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk: string | Uint8Array) => {
          writes.push(typeof chunk === "string" ? chunk : chunk.toString());
          return true;
        });
      try {
        const svc = new StreamOutputService();
        for (let i = 0; i < deltas.length; i++) {
          const d = deltas[i];
          if (d === undefined) continue;
          svc.handleEvent({
            id: `d${i}`,
            type: "llm.text",
            timestamp: Date.now(),
            metadata: {},
            payload: { delta: d },
          });
        }
        return { output: writes.join(""), fullText: svc.getFullText() };
      } finally {
        spy.mockRestore();
      }
    }

    test("RED: preserves pure-whitespace delta between tokens (via + space + JSONL)", () => {
      // Screenshot scenario: "Testing codex resume via JSONL output"
      // streamed as ["Testing", " codex", " resume", " via", " ", "JSONL", " output"]
      const { output, fullText } = streamDeltas([
        "Testing",
        " codex",
        " resume",
        " via",
        " ",          // ← pure-whitespace delta between "via" and "JSONL"
        "JSONL",
        " output",
      ]);

      // fullText should contain the literal space
      expect(fullText).toBe("Testing codex resume via JSONL output");
      // stdout should contain the readable text "via JSONL" (ANSI codes
      // may wrap the inner text — we assert on a stripped substring)
      const stripped = output.replace(/\x1b\[[0-9;]*m/g, "");
      expect(stripped).toContain("via JSONL");
      // Strong RED: the buggy form `viaJSONL` must NOT appear
      expect(stripped).not.toContain("viaJSONL");
    });

    test("RED: preserves single-space delta between two non-empty tokens (function + call)", () => {
      const { fullText } = streamDeltas(["function", " ", "call"]);
      expect(fullText).toBe("function call");
    });

    test("RED: preserves multi-space delta between tokens (a + 2 spaces + b)", () => {
      const { fullText } = streamDeltas(["a", "  ", "b"]);
      expect(fullText).toBe("a  b");
    });

    test("RED: preserves newline-only delta between lines", () => {
      const { fullText } = streamDeltas(["line1", "\n", "line2"]);
      expect(fullText).toBe("line1\nline2");
    });

    test("REGRESSION: empty-string delta still does not close reasoning block (Task #2237)", () => {
      // Bug guard: a true empty delta ("") must still be skipped so
      // reasoning frames are not closed prematurely. Pure whitespace
      // deltas (" ", "\n") are different — they are legitimate
      // token-boundary content and must NOT be skipped.
      const svc = new StreamOutputService({ showReasoning: true });
      const writes: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

      svc.handleEvent({
        id: "r1",
        type: "llm.reasoning",
        timestamp: Date.now(),
        metadata: {},
        payload: { delta: "思考中..." },
      });

      // True empty delta (not whitespace) — should NOT flush/close reasoning
      svc.handleEvent({
        id: "t0",
        type: "llm.text",
        timestamp: Date.now(),
        metadata: {},
        payload: { delta: "" },
      });

      svc.handleEvent({
        id: "r2",
        type: "llm.reasoning",
        timestamp: Date.now(),
        metadata: {},
        payload: { delta: "继续思考..." },
      });

      const output = writes.join("");
      // No reasoning header yet (both deltas buffered)
      expect((output.match(/思考过程/g) || []).length).toBe(0);

      // Now send substantive text → flushes buffer, opens box, closes, writes text
      svc.handleEvent({
        id: "t1",
        type: "llm.text",
        timestamp: Date.now(),
        metadata: {},
        payload: { delta: "回答" },
      });

      const output2 = writes.join("");
      // After substantive text: ONE reasoning header + divider + text
      expect((output2.match(/思考过程/g) || []).length).toBe(1);
      expect(output2).toContain("思考中...");
      expect(output2).toContain("继续思考...");
      expect(output2).toContain("回答");
      vi.spyOn(process.stdout, "write").mockRestore();
    });
  });
});
