/**
 * @fileoverview Defence 1 (Task #4992): when a ContextError interrupts the
 * ReAct loop while the LLM had already returned tool-calls, the catch block
 * persists the assistant(toolCalls) message. Previously it did NOT persist
 * matching tool-result messages → orphan tool-calls in the session history
 * → AI SDK fallback (convertToLanguageModelPrompt) throws
 * AI_MissingToolResultsError on the next invoke → run dies
 * (production kill chain: Task #4983, session_1bba0d11).
 *
 * After Defence 1, the catch block must pair EVERY persisted tool-call with
 * a placeholder tool-result (prefix ORPHAN_PLACEHOLDER_PREFIX).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentComponent } from "./agent-component";
import type { Environment } from "../interface";
import { ConfigComponent } from "../../config/config-component";
import { ContextError, ErrorCodes } from "../errors";
import { ORPHAN_PLACEHOLDER_PREFIX } from "../llm/orphan-toolcall";

function createMockEnvironment(): Environment {
  return {
    name: "test-env",
    version: "1.0.0",
    getConfig: vi.fn(() => ({ name: "test-env", version: "1.0.0", enabled: true })),
    registerComponent: vi.fn(),
    unregisterComponent: vi.fn(),
    getComponent: vi.fn(),
    listComponents: vi.fn(() => []),
    handle_query: vi.fn(),
    handle_action: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    subscribeTo: vi.fn(() => () => {}),
    subscribeAll: vi.fn(() => () => {}),
    pushEnvEvent: vi.fn(),
  };
}

describe("Defence 1: ContextError orphan repair (Task #4992)", () => {
  let agentComponent: AgentComponent;
  let configComponent: ConfigComponent;
  let mockEnv: Environment;
  let mockSessionComponent: any;
  let recordedMessages: any[];

  beforeEach(async () => {
    vi.clearAllMocks();

    agentComponent = new AgentComponent();
    configComponent = new ConfigComponent();
    recordedMessages = [];

    mockSessionComponent = {
      addMessage: vi.fn(async (_sessionId: string, message: any) => {
        recordedMessages.push(message);
      }),
      addMessages: vi.fn(async (_sessionId: string, messages: any[]) => {
        for (const m of messages) recordedMessages.push(m);
        return messages.map(() => "mock-id");
      }),
      getContext: vi.fn(async () => ({
        messages: [],
        checkpoint: undefined,
      })),
    };

    mockEnv = createMockEnvironment();
    (mockEnv.getComponent as any).mockImplementation((name: string) => {
      if (name === "session") return mockSessionComponent;
      if (name === "config") return configComponent;
      return undefined;
    });

    await agentComponent.init({ env: mockEnv, options: { configComponent } });
  });

  it("ContextError with toolCalls → persisted tool-calls all get placeholder results", async () => {
    // Arrange
    agentComponent.registerAgent("test-agent", {
      type: "primary",
      maxIterations: 10,
    });

    const mockLLMComponent = {
      invoke: vi.fn().mockImplementation(() => {
        // Iteration 1: throws ContextError WITH tool-calls — the exact
        // production orphan scenario (LLM returned tool-calls but the
        // run was interrupted before they could be executed).
        const llmOutput = {
          content: "Starting the checks",
          toolCalls: [
            { id: "call_9ec9006712174ec39880253e", function: { name: "bash", arguments: "{}" } },
            { id: "call_e9270792f8434f1ca67209ef", function: { name: "bash", arguments: "{}" } },
          ],
        };
        throw new ContextError(
          "Context threshold exceeded",
          ErrorCodes.CONTEXT_THRESHOLD_EXCEEDED,
          "session_1bba0d11-test",
          { promptTokens: 120000, completionTokens: 500, totalTokens: 120500 },
          128000,
          llmOutput,
        );
      }),
    };
    (mockEnv.getComponent as any).mockImplementation((name: string) => {
      if (name === "llm") return mockLLMComponent;
      if (name === "session") return mockSessionComponent;
      if (name === "config") return configComponent;
      return undefined;
    });

    // Act
    const result = await agentComponent.run("test-agent", "trigger", {
      sessionId: "session_1bba0d11-test",
    });
    // The run surfaces the ContextError through result.error
    // (environment.handle_query re-throws it as ContextError).
    expect(result.error).toBeDefined();

    // Assert — every persisted tool-call id must have a tool-result
    // in the recorded history.
    // NOTE: the session component receives messages AFTER
    // SessionMessageConverter.fromModelMessage, i.e. in SessionMessage
    // format (tool-call/tool-result live in `m.parts`, NOT
    // `m.content` — content is ""). We therefore check BOTH shapes:
    // `parts` (SessionMessage) and `content` (ModelMessage).
    const collectIds = (m: any, kind: string, into: Set<string>) => {
      const parts = Array.isArray(m?.parts) ? m.parts : [];
      for (const part of parts) {
        if (part?.type === kind && part.toolCallId) into.add(part.toolCallId);
      }
      const content = Array.isArray(m?.content) ? m.content : [];
      for (const part of content) {
        if (part?.type === kind && part.toolCallId) into.add(part.toolCallId);
      }
    };
    const collectPlaceholder = (m: any): any[] => {
      const found: any[] = [];
      const parts = Array.isArray(m?.parts) ? m.parts : [];
      for (const part of parts) {
        if (part?.type === "tool-result") found.push(part);
      }
      const content = Array.isArray(m?.content) ? m.content : [];
      for (const part of content) {
        if (part?.type === "tool-result") found.push(part);
      }
      return found;
    };

    const callIds = new Set<string>();
    const resultIds = new Set<string>();
    for (const m of recordedMessages) {
      collectIds(m, "tool-call", callIds);
      collectIds(m, "tool-result", resultIds);
    }
    expect(callIds.size).toBe(2);
    expect(resultIds.size).toBe(2);
    for (const id of callIds) {
      expect(resultIds.has(id)).toBe(true);
    }

    // The placeholder results must carry the interruption marker.
    const placeholderResults = recordedMessages.flatMap(collectPlaceholder);
    expect(placeholderResults.length).toBe(2);
    for (const r of placeholderResults) {
      const outputStr =
        typeof r.output === "string" ? r.output : JSON.stringify(r.output);
      expect(outputStr).toContain(ORPHAN_PLACEHOLDER_PREFIX);
    }
  });
});
