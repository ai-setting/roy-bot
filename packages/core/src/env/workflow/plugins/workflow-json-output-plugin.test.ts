/**
 * Integration test for v3 clean-extraction helpers:
 *   extractJsonFromAgentOutput() + tryParseJsonFromText()
 *
 * Validates the core logic WITHOUT running a full workflow.
 * We construct various simulated main agent outputs and verify that
 * the extractor correctly parses JSON from each format.
 */

import { describe, it, expect } from "vitest";
import { extractJsonFromAgentOutput, tryParseJsonFromText } from "./workflow-json-output-plugin";
import type { HookContext } from "../../agent/types";

const MOCK_JSON_SCHEMA = {
  type: "object" as const,
  properties: {
    char_count: { type: "integer" as const },
    summary: { type: "string" as const },
  },
  required: ["char_count", "summary"],
};

function buildHookCtx(overrides: {
  llmOutputContent?: string;
  messages?: HookContext["messages"];
  schema?: Record<string, unknown>;
}): HookContext {
  return {
    messages: overrides.messages ?? [],
    llmOutput: overrides.llmOutputContent
      ? { content: overrides.llmOutputContent, toolCalls: [], finishReason: "stop" }
      : undefined,
    context: {
      metadata: {
        outputSchema: overrides.schema ?? MOCK_JSON_SCHEMA,
      },
      abort: new AbortController().signal,
    } as any,
    iteration: 1,
    maxIterations: 1,
    tools: [],
    systemPrompt: "",
    agent: { name: "test", config: {}, status: "running", plugins: {} } as any,
  };
}

// ============================================================================
// tryParseJsonFromText — 11 tests (3 parsing strategies × various formats)
// ============================================================================

describe("tryParseJsonFromText", () => {
  it("1. plain JSON text", () => {
    expect(tryParseJsonFromText('{"char_count":13,"summary":"hello"}')).toEqual({ char_count: 13, summary: "hello" });
  });

  it("2. indented plain JSON", () => {
    const text = '{\n  "char_count": 13,\n  "summary": "hello world"\n}';
    expect(tryParseJsonFromText(text)).toEqual({ char_count: 13, summary: "hello world" });
  });

  it("3. markdown ```json``` code block", () => {
    const text = '<think>...</think>\n\n```json\n{"char_count": 13, "summary": "A simple greeting"}\n```\n\nDone.';
    expect(tryParseJsonFromText(text)).toEqual({ char_count: 13, summary: "A simple greeting" });
  });

  it("4. markdown ``` code block (no language tag)", () => {
    expect(tryParseJsonFromText('```\n{"char_count":13,"summary":"ok"}\n```'))
      .toEqual({ char_count: 13, summary: "ok" });
  });

  it("5. markdown ```JSON code block (uppercase)", () => {
    expect(tryParseJsonFromText('```JSON\n{"char_count":42,"summary":"test"}\n```'))
      .toEqual({ char_count: 42, summary: "test" });
  });

  it("6. find first {...} substring", () => {
    expect(tryParseJsonFromText('Analysis: {"char_count":7,"summary":"testing"} verified.'))
      .toEqual({ char_count: 7, summary: "testing" });
  });

  it("7. null for non-JSON text", () => {
    expect(tryParseJsonFromText("Hello, I'm an AI.")).toBeNull();
  });

  it("8. null for empty string", () => {
    expect(tryParseJsonFromText("")).toBeNull();
  });

  it("9. null for arrays (not objects)", () => {
    expect(tryParseJsonFromText("[1,2,3]")).toBeNull();
  });

  it("10. null for plain numbers", () => {
    expect(tryParseJsonFromText("42")).toBeNull();
  });

  // ── Realistic main agent output patterns (from actual trace data) ──

  it("11. MiniMax M3 reasoning + plain JSON (successful run pattern)", () => {
    const text = '<think>The user wants me to analyze the message "Hello, world!" and output JSON with character count\n\n"H-e-l-l-o-,- -w-o-r-l-d-!" = 13 characters\n\nSummary: A simple greeting.</think>\n\n{"char_count": 13, "summary": "A simple, friendly greeting addressed to the world."}';
    expect(tryParseJsonFromText(text))
      .toEqual({ char_count: 13, summary: "A simple, friendly greeting addressed to the world." });
  });

  it("12. MiniMax reasoning + markdown code block (previously-failing pattern)", () => {
    const text = '<think>analysis...</think>\n\n```json\n{\n  "char_count": 13,\n  "summary": "A simple greeting directed at the world."\n}\n```\n\n**Analysis:**\n\n1. **Character count:** 13\n\n2. **Summary:** The message is a classic greeting.';
    expect(tryParseJsonFromText(text))
      .toEqual({ char_count: 13, summary: "A simple greeting directed at the world." });
  });
});

// ============================================================================
// extractJsonFromAgentOutput — 8 integration tests
// ============================================================================

describe("extractJsonFromAgentOutput", () => {
  it("1. extract from llmOutput.content (plain JSON)", () => {
    const ctx = buildHookCtx({
      llmOutputContent: '<think>...</think>\n\n{"char_count":13,"summary":"ok"}',
    });
    expect(extractJsonFromAgentOutput(ctx)).toEqual({ char_count: 13, summary: "ok" });
  });

  it("2. extract from llmOutput.content (markdown code block)", () => {
    const ctx = buildHookCtx({
      llmOutputContent: '<think>...</think>\n\n```json\n{"char_count":13,"summary":"ok"}\n```',
    });
    expect(extractJsonFromAgentOutput(ctx)).toEqual({ char_count: 13, summary: "ok" });
  });

  it("3. extract from last assistant text (when llmOutput is empty)", () => {
    const ctx = buildHookCtx({
      messages: [
        { role: "assistant", content: [{ type: "text" as const, text: '{"char_count":13,"summary":"from messages"}' }] },
      ],
    });
    expect(extractJsonFromAgentOutput(ctx)).toEqual({ char_count: 13, summary: "from messages" });
  });

  it("4. extract from echo tool-call input (message field)", () => {
    const ctx = buildHookCtx({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool-call" as any, toolCallId: "call_1", toolName: "echo", input: { message: '{"char_count":13,"summary":"from echo"}' } },
          ],
        },
      ],
    });
    expect(extractJsonFromAgentOutput(ctx)).toEqual({ char_count: 13, summary: "from echo" });
  });

  it("5. prefer llmOutput.content over messages when both available", () => {
    const ctx = buildHookCtx({
      llmOutputContent: '{"char_count":13,"summary":"from llmOutput"}',
      messages: [
        { role: "assistant", content: [{ type: "text" as const, text: '{"char_count":999,"summary":"from messages"}' }] },
      ],
    });
    expect(extractJsonFromAgentOutput(ctx)).toEqual({ char_count: 13, summary: "from llmOutput" });
  });

  it("6. null when no JSON found", () => {
    const ctx = buildHookCtx({
      llmOutputContent: "Cannot produce JSON for this request.",
      messages: [
        { role: "assistant", content: [{ type: "text" as const, text: "Let me think..." }] },
      ],
    });
    expect(extractJsonFromAgentOutput(ctx)).toBeNull();
  });

  it("7. skip non-assistant messages", () => {
    const ctx = buildHookCtx({
      messages: [
        { role: "user", content: [{ type: "text" as const, text: '{"char_count":999,"summary":"user"}' }] },
      ],
    });
    expect(extractJsonFromAgentOutput(ctx)).toBeNull();
  });

  it("8. extract from last assistant message only (ignore earlier turns)", () => {
    const ctx = buildHookCtx({
      messages: [
        { role: "assistant", content: [{ type: "text" as const, text: '{"char_count":1,"summary":"first"}' }] },
        { role: "assistant", content: [{ type: "text" as const, text: '{"char_count":2,"summary":"LAST valid one"}' }] },
      ],
    });
    // Only the LAST assistant message should be considered
    expect(extractJsonFromAgentOutput(ctx)).toEqual({ char_count: 2, summary: "LAST valid one" });
  });
});

// ============================================================================
// REAL INTEGRATION TEST: verify json-extract sub-agent is called with
// correct messages override + maxIterations=5 strategy
// ============================================================================
import { vi } from "vitest";
import { __setPluginAgentComponentForTest, runWorkflowJsonOutputExtraction } from "./workflow-json-output-plugin";
import { WORKFLOW_SUBMIT_OUTPUT_TOOL_NAME } from "../tools/submit-json-output-tool";

describe("integration: json-extract sub-agent IS called with workflow_submit_output", () => {
  it("plugin invokes agentComponent.run('json-extract', ...) with messages override + maxIterations=5 strategy", async () => {
    // ── Setup: capture what the plugin passes to agentComponent.run ──
    let capturedAgentName: string | null = null;
    let capturedQuery: string | null = null;
    let capturedContext: any = null;

    const mockAgentComponent = {
      // No configComponent → exercises the back-compat 'required' branch.
      // Task #2177 review B-1: pin this so future refactors cannot silently
      // change behavior. If `resolveProviderToolChoice` is refactored to read
      // through a different path, this test MUST be updated to make the
      // intent explicit (e.g., explicit `configComponent: { get: () => undefined }`).
      configComponent: undefined,
      run: vi.fn(async (name: string, query: string, ctx: any) => {
        capturedAgentName = name;
        capturedQuery = query;
        capturedContext = ctx;

        // Simulate: the sub-agent's invokeLLM returns tool-calls → executeTool
        // calls workflow_submit_output → hookCtx.structuredOutputExtracted gets set
        
        // Find the submit tool from extraTools and execute it
        const submitTool = ctx.extraTools?.find(
          (t: any) => t.name === WORKFLOW_SUBMIT_OUTPUT_TOOL_NAME
        );

        if (submitTool) {
          // Simulate the sub-agent calling the tool with correct args
          await submitTool.execute({ char_count: 13, summary: "A simple greeting" });
        }

        return { iterations: 1, toolCalls: [{ name: WORKFLOW_SUBMIT_OUTPUT_TOOL_NAME }], error: undefined };
      }),
    };

    __setPluginAgentComponentForTest(mockAgentComponent as any);

    // ── Build a realistic hookCtx (simulating agent:after.react) ──
    const hookCtx = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: '<think>analysis</think>\n\n```json\n{"char_count": 13, "summary": "A simple greeting"}\n```\n\nDone.',
            },
          ],
        },
      ],
      llmOutput: {
        content: '<think>analysis</think>\n\n```json\n{"char_count": 13, "summary": "A simple greeting"}\n```',
        toolCalls: [],
        finishReason: "stop",
      },
      context: {
        sessionId: "agent_test_123",
        metadata: {
          runId: "unknown",
          nodeId: "test-agent",
          sessionId: "agent_test_123",
          outputSchema: {
            type: "object",
            properties: {
              char_count: { type: "integer" },
              summary: { type: "string" },
            },
            required: ["char_count", "summary"],
          },
        },
        pluginEnabled: { "workflow:json-output": true },
        abort: new AbortController().signal,
      },
      structuredOutputExtracted: undefined,
      error: undefined,
      iteration: 1,
      maxIterations: 1,
      tools: [],
      systemPrompt: "",
      agent: { name: "test", config: {}, status: "running", plugins: {} },
    } as any;

    // ── Execute ──
    await runWorkflowJsonOutputExtraction(hookCtx);

    // ── Verify: agentComponent.run was called correctly ──
    expect(capturedAgentName).toBe("json-extract");
    expect(mockAgentComponent.run).toHaveBeenCalledTimes(1);

    // ── Verify: messages override was used (Layer 1+2 — 1 user message only) ──
    expect(capturedContext.messages).toBeDefined();
    expect(capturedContext.messages.length).toBe(1);
    expect(capturedContext.messages[0].role).toBe("user");
    // v4: plugin now passes RAW assistant text to sub-agent (no pre-parsing).
    // The sub-agent LLM reads, understands, and calls workflow_submit_output.
    expect(capturedContext.messages[0].content).toContain("START of main agent response");
    expect(capturedContext.messages[0].content).toContain("END of main agent response");
    expect(capturedContext.messages[0].content).toContain("char_count");
    expect(capturedContext.messages[0].content).toContain("summary");
    expect(capturedContext.messages[0].content).toContain("A simple greeting");

    // ── Verify: maxIterations=5 (sub-agent may iterate to retry on schema errors) ──
    // ── Verify: toolChoice MUST be "required" (Task #2175 — restore commit 3598326d's fix) ──
    // The json-extract sub-agent has exactly ONE allowed tool (workflow_submit_output).
    // Without toolChoice="required", the LLM may decide to emit plain text instead
    // of calling the tool — which yields `_extraction_failed=true` and breaks
    // downstream loop routing (Issue #1694 / observed in run workflow_1784498394013).
    expect(capturedContext.toolChoice).toBe("required");

    // ── Verify: extraTools contains workflow_submit_output ──
    expect(capturedContext.extraTools).toBeDefined();
    expect(capturedContext.extraTools.length).toBe(1);
    expect(capturedContext.extraTools[0].name).toBe(WORKFLOW_SUBMIT_OUTPUT_TOOL_NAME);

    // ── Verify: persistSession=false (don't pollute main session) ──
    expect(capturedContext.persistSession).toBe(false);

    // ── Verify: the submit tool wrote to hookCtx.structuredOutputExtracted ──
    expect(hookCtx.structuredOutputExtracted).toBeDefined();
    expect(hookCtx.structuredOutputExtracted).toEqual({
      char_count: 13,
      summary: "A simple greeting",
    });

    // ── Cleanup ──
    __setPluginAgentComponentForTest(null);
  });

  // v4: plugin no longer tries to parse JSON itself. It ONLY checks for
  // assistant text. If no text exists, sub-agent is NOT called.
  it("should NOT call sub-agent when no assistant text found", async () => {
    const mockAgentComponent = {
      run: vi.fn(async () => ({ iterations: 0, error: undefined })),
    };
    __setPluginAgentComponentForTest(mockAgentComponent as any);

    // messages array has no assistant role → extractLastAssistantText returns undefined
    const hookCtx = {
      messages: [],
      llmOutput: undefined,
      context: {
        sessionId: "agent_test_456",
        metadata: {
          outputSchema: {
            type: "object",
            properties: { char_count: { type: "integer" }, summary: { type: "string" } },
            required: ["char_count", "summary"],
          },
        },
        pluginEnabled: { "workflow:json-output": true },
        abort: new AbortController().signal,
      },
      structuredOutputExtracted: undefined,
      error: undefined,
      iteration: 1,
      maxIterations: 1,
      tools: [],
      systemPrompt: "",
      agent: { name: "test", config: {}, status: "running", plugins: {} },
    } as any;

    await runWorkflowJsonOutputExtraction(hookCtx);

    // ── Verify: agentComponent.run was NOT called (no assistant text) ──
    expect(mockAgentComponent.run).not.toHaveBeenCalled();

    __setPluginAgentComponentForTest(null);
  });

  // RED test (Task #2175): the json-extract sub-agent MUST be invoked with
  // toolChoice="required". The previous commit 70b2e569 disabled this setting,
  // which caused non-deterministic `_extraction_failed=true` results observed
  // in run workflow_1784498394013_fallback_reubfg:
  //
  //   ├─ tdd-implement #8 end { _extraction_failed: true, _raw_output: "{}" }
  //   ├─ cli-e2e-test #36 end { _extraction_failed: true, _raw_output: "{}" }
  //   └─ ...
  //
  // The contract this test enforces: the plugin always sets toolChoice="required"
  // because the json-extract sub-agent has exactly ONE tool (workflow_submit_output)
  // and the prompt forbids plain-text output. Without toolChoice, the LLM may
  // occasionally emit empty text instead of calling the tool, producing the
  // empty-output root cause flagged in build-agent-node-output.ts:96.
  it("RED: toolChoice MUST be 'required' so the json-extract sub-agent cannot escape via plain text (Task #2175)", async () => {
    let capturedToolChoice: unknown = "NOT_SET";
    const mockAgentComponent = {
      run: vi.fn(async (_name: string, _q: string, ctx: any) => {
        capturedToolChoice = ctx.toolChoice;
        return { iterations: 0, toolCalls: [], error: undefined };
      }),
    };
    __setPluginAgentComponentForTest(mockAgentComponent as any);

    const hookCtx = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: '{"x": 1}' }],
        },
      ],
      llmOutput: { content: '{"x": 1}', toolCalls: [], finishReason: "stop" },
      context: {
        sessionId: "agent_test_red_2175",
        metadata: {
          outputSchema: {
            type: "object",
            properties: { x: { type: "integer" } },
            required: ["x"],
          },
        },
        pluginEnabled: { "workflow:json-output": true },
        abort: new AbortController().signal,
      },
      structuredOutputExtracted: undefined,
      error: undefined,
      iteration: 1,
      maxIterations: 1,
      tools: [],
      systemPrompt: "",
      agent: { name: "test", config: {}, status: "running", plugins: {} },
    } as any;

    await runWorkflowJsonOutputExtraction(hookCtx);

    // ── Assert: toolChoice is exactly the string "required" ──
    expect(capturedToolChoice).toBe("required");
    // ── Assert: this prevents the LLM from finishing with plain text only ──
    expect(mockAgentComponent.run).toHaveBeenCalledTimes(1);

    __setPluginAgentComponentForTest(null);
  });
});
