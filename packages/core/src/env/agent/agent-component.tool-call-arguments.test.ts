/**
 * @fileoverview TDD Tests for Tool Call Arguments Normalization in AgentComponent
 *
 * Feature: Tool call arguments must be normalized to JSON objects before reaching
 *          ToolComponent.execute / tool.execute, regardless of provider shape.
 *
 * Problem (Task #2723):
 * When pi-ai returns a top-level tool-call shape `{ id, name, arguments: string }`
 * (no `function` wrapper), AgentComponent._run() at lines 1755-1768 used the
 * raw `toolCall.arguments` string as `hookCtx.currentToolCall.arguments` and
 * never routed it through `safeParseToolArgs()`. The downstream ToolComponent
 * then fed the string into a Zod object schema and failed with
 * "Expected object, received string".
 *
 * The AI SDK provider shape `{ id, function: { name, arguments: string } }`
 * is already parsed through `safeParseToolArgs()` on the `function.arguments`
 * branch and worked correctly on main. This test suite locks in the contract
 * for both shapes plus a recursive (double-stringified) edge case.
 *
 * Solution:
 * Route the conversion of provider-specific shape into the internal
 * `HookContext.currentToolCall.arguments` object through a new
 * `AgentComponent.parseToolCallArguments()` method that always calls
 * `safeParseToolArgs()`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { AgentComponent } from "./agent-component";
import { ConfigComponent } from "../../config/config-component";
import type { Environment } from "../interface";

const schema = z.object({
  keywords: z.array(z.string()),
  limit: z.number(),
});

function createMockEnvironment(mockComponents: Record<string, any> = {}): Environment {
  return {
    name: "tool-args-test",
    version: "1.0.0",
    getConfig: vi.fn(() => ({ name: "tool-args-test", version: "1.0.0", enabled: true })),
    registerComponent: vi.fn(),
    unregisterComponent: vi.fn(),
    getComponent: vi.fn((name: string) => mockComponents[name]),
    listComponents: vi.fn(() => Object.keys(mockComponents)),
    handle_query: vi.fn(),
    handle_action: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    subscribeTo: vi.fn(() => () => {}),
    subscribeAll: vi.fn(() => () => {}),
    pushEnvEvent: vi.fn(),
  } as unknown as Environment;
}

async function runOneToolCall(toolCall: unknown) {
  const config = new ConfigComponent();
  const received: unknown[] = [];

  const tool = {
    name: "task_search",
    description: "Search tasks by keyword",
    parameters: schema,
    execute: vi.fn(async (args: unknown) => {
      received.push(args);
      const parsed = schema.safeParse(args);
      return parsed.success
        ? { success: true, output: "search-ok" }
        : { success: false, output: "", error: parsed.error.message };
    }),
  };

  const mockSessionComponent = {
    name: "session",
    create: vi.fn(async () => ({ id: "tool-args-session", title: "Test" })),
    get: vi.fn(async () => ({ id: "tool-args-session" })),
    addMessage: vi.fn(async () => "msg_id"),
    addMessages: vi.fn(async (_sessionId: string, _msgs: any[]) => ["msg_id"]),
    getMessages: vi.fn(async () => []),
    getContext: vi.fn(async () => ({
      session: { id: "tool-args-session" },
      messages: [],
    })),
  };

  let invocation = 0;
  const llm = {
    invoke: vi.fn(async () => {
      invocation += 1;
      return invocation === 1
        ? { output: { content: "", toolCalls: [toolCall], finishReason: "tool-calls" } }
        : { output: { content: "done", toolCalls: [], finishReason: "stop" } };
    }),
  };

  const env = createMockEnvironment({
    config,
    llm,
    session: mockSessionComponent,
  });

  const agent = new AgentComponent();
  await agent.init({
    name: "agent",
    version: "1.0.0",
    enabled: true,
    env,
    options: { configComponent: config },
  });
  agent.registerAgent("tool-args-agent", {
    type: "primary",
    systemPrompt: "Use task_search.",
    maxIterations: 2,
  });
  agent.setDefaultTools([tool]);

  const result = await agent.run("tool-args-agent", "search now", {
    sessionId: "tool-args-session",
    persistSession: false,
  });

  return { result, received, llm };
}

// ============================================================================
// RED Phase: Tool Call Arguments Normalization
// ============================================================================

describe("AgentComponent Tool Call Arguments Normalization (TDD Task #2723)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses pi-ai top-level JSON arguments before ToolComponent.execute", async () => {
    const expected = { keywords: ["特朗普"], limit: 5 };
    const { result, received } = await runOneToolCall({
      id: "call_pi_json",
      name: "task_search",
      arguments: JSON.stringify(expected),
    });
    expect(received[0]).toEqual(expected);
    expect(typeof received[0]).toBe("object");
    expect(result.error ?? "").not.toContain("Expected object, received string");
  });

  it("recursively parses pi-ai top-level double-stringified arguments", async () => {
    const expected = { keywords: ["Trump"], limit: 5 };
    const inner = JSON.stringify(expected);
    const { received } = await runOneToolCall({
      id: "call_pi_double",
      name: "task_search",
      arguments: JSON.stringify(inner),
    });
    expect(received[0]).toEqual(expected);
    expect(received[0]).not.toHaveProperty("_raw");
  });

  it("passes AI SDK function.arguments object to ToolComponent.execute (control)", async () => {
    const expected = { keywords: ["ai-sdk"], limit: 3 };
    const { result, received } = await runOneToolCall({
      id: "call_aisdk",
      function: { name: "task_search", arguments: JSON.stringify(expected) },
    });
    expect(received[0]).toEqual(expected);
    expect(typeof received[0]).toBe("object");
    expect(result.error ?? "").not.toContain("Expected object, received string");
  });

  it("passes object toolCall.arguments through unchanged (control)", async () => {
    const expected = { keywords: ["obj"], limit: 1 };
    const { result, received } = await runOneToolCall({
      id: "call_obj",
      function: { name: "task_search", arguments: expected },
    });
    expect(received[0]).toEqual(expected);
    expect(typeof received[0]).toBe("object");
    expect(result.error ?? "").not.toContain("Expected object, received string");
  });

  // ========================================================================
  // P1-4: Edge case tests (claude-minimax review)
  // ========================================================================

  it("handles function.arguments === undefined (falls back to top-level arguments)", async () => {
    // toolCall.function exists but function.arguments is undefined;
    // should fall back to toolCall.arguments (pi-ai top-level shape)
    const expected = { keywords: ["fallback"], limit: 2 };
    const { received } = await runOneToolCall({
      id: "call_fn_undef",
      name: "task_search",
      function: { name: "task_search" }, // arguments missing
      arguments: JSON.stringify(expected),
    });
    expect(received[0]).toEqual(expected);
    expect(typeof received[0]).toBe("object");
  });

  it("handles arguments === empty string (returns empty object, no crash)", async () => {
    const { received } = await runOneToolCall({
      id: "call_empty_str",
      name: "task_search",
      arguments: "",
    });
    expect(received[0]).toEqual({});
    expect(typeof received[0]).toBe("object");
  });

  it("handles arguments === 'null' (returns wrapped value, no _raw leak)", async () => {
    // JSON.parse('null') returns null, which is not a plain object,
    // so safeParseToolArgs wraps it as { value: null }
    const { received } = await runOneToolCall({
      id: "call_null_str",
      name: "task_search",
      arguments: "null",
    });
    expect(received[0]).toEqual({ value: null });
    expect(received[0]).not.toHaveProperty("_raw");
  });

  it("handles double-stringified arguments (JSON.stringify of JSON.stringify)", async () => {
    // Double stringify: JSON.stringify(JSON.stringify({ a: 1 }))
    const inner = { a: 1 };
    const doubleStr = JSON.stringify(JSON.stringify(inner));
    const { received } = await runOneToolCall({
      id: "call_double_str",
      name: "task_search",
      arguments: doubleStr,
    });
    expect(received[0]).toEqual(inner);
    expect(typeof received[0]).toBe("object");
  });
});
