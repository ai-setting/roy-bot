/**
 * RED tests for: AutoTaskPlugin multi-batch pairing bug
 *
 * Bug: When LLM emits MULTIPLE tool calls in a single ReAct iteration, and
 * iteration === threshold, AutoTaskPlugin sets toAddFakeUserMessage on the
 * FIRST tool's toolResult. The react loop then pushes the user reminder
 * IMMEDIATELY after the first tool result, BEFORE the remaining tool results
 * for the same assistant message. Result:
 *
 *   [assistant(tool_calls[A,B,C]), tool(A), user(reminder), tool(B), tool(C)]
 *                                  ^^^^^^^^^^^^^^^^
 *                                  user reminder breaks AI SDK adjacency
 *                                  → tool B/C become orphans → MissingToolResultsError
 *
 * Correct order must be:
 *   [assistant(tool_calls[A,B,C]), tool(A), tool(B), tool(C), user(reminder)]
 *
 * These tests reproduce the bug at the integration level (AgentComponent +
 * AutoTaskPlugin running together) — the bug is in agent-component.ts
 * meta-protocol CONSUMPTION timing (push happens inside for-loop instead of
 * after), not in the plugin itself (plugin's dedup + meta-protocol SET is fine).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentComponent } from "./agent-component";
import { createAutoTaskPlugin } from "../task/plugins/auto-task-plugin";
import { ConfigComponent } from "../../config/config-component";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

function createMockEnvironment(): any {
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

/**
 * Helper: extract parts array from a message (handles both `content` array
 * and `parts` array conventions used in the codebase and AI SDK).
 */
function getParts(msg: any): any[] {
  if (!msg) return [];
  if (Array.isArray(msg.parts)) return msg.parts;
  if (Array.isArray(msg.content)) return msg.content;
  return [];
}

/**
 * Verify: for the recorded message stream, every tool message is preceded by
 * an assistant message that contains matching tool-call parts. This counts
 * outstanding tool-call parts (decremented by each tool-result message) to
 * handle multi-tool-call assistant messages correctly.
 *
 * Returns: { paired: true } if all tool messages have a matching preceding
 *          assistant(tool-calls) and no intervening non-tool messages
 *          orphan the remaining tool results, or { paired: false, ... }.
 *
 * AI SDK v6 prompt converter rejects a session where a tool message appears
 * without a preceding assistant(tool-calls). Faithfully reproduces the
 * user's MissingToolResultsError symptom.
 */
function verifyToolPairing(recorded: any[]): { paired: true } | { paired: false; orphanAt: number; reason: string } {
  let outstandingToolCalls = 0; // count of unfulfilled tool-call parts
  for (let i = 0; i < recorded.length; i++) {
    const msg = recorded[i];
    if (!msg) continue;
    if (msg.role === "assistant") {
      const parts = getParts(msg);
      const toolCallParts = parts.filter((p: any) => p?.type === "tool-call");
      outstandingToolCalls = toolCallParts.length;
    } else if (msg.role === "tool") {
      if (outstandingToolCalls <= 0) {
        return {
          paired: false,
          orphanAt: i,
          reason: "tool message without preceding assistant(tool-calls)",
        };
      }
      outstandingToolCalls--;
    } else {
      // Non-assistant/non-tool message (user, system). If outstandingToolCalls > 0,
      // a non-tool message has been inserted between assistant(tool-calls) and
      // the trailing tool-result messages, orphaning them.
      if (outstandingToolCalls > 0) {
        return {
          paired: false,
          orphanAt: i,
          reason: `non-tool message (role=${msg.role}) between assistant(tool-calls) and remaining tool results (${outstandingToolCalls} unfulfilled)`,
        };
      }
    }
  }
  return { paired: true };
}

function findUserReminder(recorded: any[]): { index: number; content: string } | null {
  for (let i = 0; i < recorded.length; i++) {
    const msg = recorded[i];
    // The user reminder can be in `content` (string) or as a `parts` entry
    const text = typeof msg?.content === "string" ? msg.content : "";
    const parts = getParts(msg);
    const partsText = parts
      .filter((p: any) => p?.type === "text" || typeof p?.text === "string")
      .map((p: any) => p.text ?? p.content ?? "")
      .join(" ");
    const all = (text + " " + partsText).trim();
    if (msg?.role === "user" && (all.includes("delegate_task") || all.includes("iteration 阈值"))) {
      return { index: i, content: all };
    }
  }
  return null;
}

describe("AgentComponent — meta-protocol: multi-batch pairing (RED tests)", () => {
  let agentComponent: AgentComponent;
  let mockEnv: any;
  let configComponent: ConfigComponent;
  let tempDir: string;
  let emptyAgentsDir: string;
  let mockSessionComponent: any;
  let recordedMessages: any[];

  beforeEach(async () => {
    vi.clearAllMocks();
    agentComponent = new AgentComponent();
    configComponent = new ConfigComponent();

    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-multibatch-"));
    emptyAgentsDir = path.join(tempDir, "empty-agents");
    fsSync.mkdirSync(emptyAgentsDir, { recursive: true });
    configComponent.setXdgDataHome(tempDir);
    await configComponent.set("agent.configDir", emptyAgentsDir);

    recordedMessages = [];
    mockSessionComponent = {
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

  afterEach(() => {
    try {
      fsSync.rmSync(tempDir, { recursive: true });
    } catch {}
  });

  // ============================================================================
  // RED-1 (MAIN BUG): user reminder is inserted BETWEEN tool results of the same
  // assistant(tool_calls) — breaks tool_call/tool_result adjacency for trailing
  // tool_calls.
  // ============================================================================
  it("RED-1: with 3 tool calls in one iteration, user reminder is pushed AFTER all tool results (not in the middle)", async () => {
    agentComponent.registerAgent("test-agent", {
      type: "primary",
      systemPrompt: "You are a test assistant.",
      maxIterations: 5,
    });
    // threshold: 1 → plugin fires at iteration 1
    const plugin = createAutoTaskPlugin({ threshold: 1, agentName: "test-agent" });
    agentComponent.registerPlugin("test-agent", plugin);

    let llmCallCount = 0;
    const mockLLMComponent = {
      invoke: vi.fn().mockImplementation(() => {
        llmCallCount++;
        if (llmCallCount === 1) {
          // LLM emits 3 tool calls in ONE iteration → plugin fires on tc1,
          // react loop pushes user reminder after tc1's tool result, but tc2
          // and tc3 tool results come AFTER user reminder → orphan!
          return Promise.resolve({
            output: {
              content: "I'll use three tools",
              toolCalls: [
                { id: "tc1", function: { name: "echo_tool", arguments: "{}" } },
                { id: "tc2", function: { name: "echo_tool", arguments: "{}" } },
                { id: "tc3", function: { name: "echo_tool", arguments: "{}" } },
              ],
            },
            providerId: "openai",
            model: "gpt-4o",
            latencyMs: 100,
          });
        }
        // LLM acknowledges user reminder and stops
        return Promise.resolve({
          output: { content: "I'll delegate via delegate_task", toolCalls: [] },
          providerId: "openai",
          model: "gpt-4o",
          latencyMs: 50,
        });
      }),
    };
    (mockEnv.getComponent as any).mockImplementation((name: string) => {
      if (name === "llm") return mockLLMComponent;
      if (name === "session") return mockSessionComponent;
      if (name === "config") return configComponent;
      return undefined;
    });

    const mockTool: any = {
      name: "echo_tool",
      description: "Echo tool",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(() =>
        Promise.resolve({
          success: true,
          output: "tool_result_value",
          metadata: { execution_time_ms: 10 },
        })
      ),
    };
    agentComponent.setDefaultTools([mockTool]);

    await agentComponent.run("test-agent", "test query", { sessionId: "test-session" });

    // Assertions on recordedMessages:
    const recorded = recordedMessages;
    const userReminder = findUserReminder(recorded);
    expect(userReminder).not.toBeNull();

    // The tool messages from this iteration must come BEFORE the user reminder
    const toolMessages = recorded.filter(
      (m: any) =>
        m?.role === "tool" &&
        getParts(m).some((p: any) => p?.type === "tool-result")
    );
    expect(toolMessages.length).toBe(3);
    const lastToolIndex = recorded.lastIndexOf(toolMessages[toolMessages.length - 1]);

    // ★ Assertion: user reminder must come AFTER all tool results of the same assistant message
    expect(userReminder!.index).toBeGreaterThan(lastToolIndex);

    // ★ Assertion: every tool message must have matching tool_call_id in the preceding assistant message
    // (1:1 mapping check)
    for (const tm of toolMessages) {
      const toolResultId = getParts(tm).find((p: any) => p.type === "tool-result")?.toolCallId;
      // Find the most recent assistant message that contains a matching tool-call
      const ai = recorded
        .slice(0, recorded.indexOf(tm))
        .reverse()
        .find((m: any) => m.role === "assistant");
      const aiToolCallIds = getParts(ai).filter((p: any) => p.type === "tool-call").map((p: any) => p.toolCallId);
      expect(aiToolCallIds).toContain(toolResultId);
    }
  });

  // ============================================================================
  // RED-2: even when the for-loop breaks early (e.g., plugin stops execution
  // after tool A), if the plugin had set toAddFakeUserMessage on tool A, the
  // user reminder must still come AFTER all pushed tool results.
  // ============================================================================
  it("RED-2: plugin uses deferred push so user reminder is positioned after all tool results regardless of for-loop break", async () => {
    agentComponent.registerAgent("test-agent", {
      type: "primary",
      systemPrompt: "You are a test assistant.",
      maxIterations: 5,
    });
    // Custom plugin that fires iteration===threshold AND triggers stop after first tool
    let executionIndex = 0;
    const customPlugin = {
      name: "TestStoppingPlugin",
      version: "1.0.0",
      description: "Sets reminder + stops after first tool",
      hooks: [{ point: "agent:after.tool" as const, priority: 50 }],
      execute: async (ctx: any) => {
        executionIndex++;
        // Set user reminder meta-protocol when iteration === threshold
        if (ctx.iteration === 1 && ctx.toolResult?.result) {
          ctx.toolResult.result.metadata = ctx.toolResult.result.metadata ?? {};
          ctx.toolResult.result.metadata.toAddFakeUserMessage = {
            role: "user",
            content: "⚠️ Test reminder (delegate_task) at iteration 阈值",
          };
        }
        // Stop after first tool (doom loop simulation)
        if (executionIndex === 1) {
          ctx._stopped = true;
        }
        return { continue: true };
      },
    };
    agentComponent.registerPlugin("test-agent", customPlugin as any);

    let llmCallCount = 0;
    const mockLLMComponent = {
      invoke: vi.fn().mockImplementation(() => {
        llmCallCount++;
        if (llmCallCount === 1) {
          return Promise.resolve({
            output: {
              content: "Three tools",
              toolCalls: [
                { id: "tc1", function: { name: "echo_tool", arguments: "{}" } },
                { id: "tc2", function: { name: "echo_tool", arguments: "{}" } },
                { id: "tc3", function: { name: "echo_tool", arguments: "{}" } },
              ],
            },
            providerId: "openai",
            model: "gpt-4o",
            latencyMs: 100,
          });
        }
        return Promise.resolve({
          output: { content: "Stopped", toolCalls: [] },
          providerId: "openai",
          model: "gpt-4o",
          latencyMs: 50,
        });
      }),
    };
    (mockEnv.getComponent as any).mockImplementation((name: string) => {
      if (name === "llm") return mockLLMComponent;
      if (name === "session") return mockSessionComponent;
      if (name === "config") return configComponent;
      return undefined;
    });

    const mockTool: any = {
      name: "echo_tool",
      description: "Echo tool",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(() =>
        Promise.resolve({ success: true, output: "ok", metadata: {} })
      ),
    };
    agentComponent.setDefaultTools([mockTool]);

    await agentComponent.run("test-agent", "test query", { sessionId: "test-session" });

    // After plugin stop, addRemainingToolResults pushes placeholder results for tc2, tc3.
    // The user reminder must be pushed AFTER those placeholders.
    const reminder = findUserReminder(recordedMessages);
    expect(reminder).not.toBeNull();
    // The reminder must come AFTER any subsequent tool message (not between tc1 and tc2 placeholders)
    const toolMessages = recordedMessages.filter((m: any) => m?.role === "tool");
    const lastToolIndex = recordedMessages.lastIndexOf(toolMessages[toolMessages.length - 1]);
    expect(reminder!.index).toBeGreaterThan(lastToolIndex);
  });

  // ============================================================================
  // RED-3: AI SDK-style pairing check across the WHOLE conversation — no
  // orphan tool messages allowed, regardless of how many tool calls per
  // iteration.
  // ============================================================================
  it("RED-3: AI SDK pairing invariant — no orphan tool messages across any multi-tool-call iterations", async () => {
    agentComponent.registerAgent("test-agent", {
      type: "primary",
      systemPrompt: "You are a test assistant.",
      maxIterations: 5,
    });
    const plugin = createAutoTaskPlugin({ threshold: 1, agentName: "test-agent" });
    agentComponent.registerPlugin("test-agent", plugin);

    let llmCallCount = 0;
    const mockLLMComponent = {
      invoke: vi.fn().mockImplementation(() => {
        llmCallCount++;
        if (llmCallCount === 1) {
          // 3 tool calls → fires plugin (iteration 1 === threshold 1)
          return Promise.resolve({
            output: {
              content: "Plan: read 3 files",
              toolCalls: [
                { id: "tc1", function: { name: "echo_tool", arguments: "{}" } },
                { id: "tc2", function: { name: "echo_tool", arguments: "{}" } },
                { id: "tc3", function: { name: "echo_tool", arguments: "{}" } },
              ],
            },
            providerId: "openai",
            model: "gpt-4o",
            latencyMs: 100,
          });
        }
        return Promise.resolve({
          output: { content: "Done", toolCalls: [] },
          providerId: "openai",
          model: "gpt-4o",
          latencyMs: 50,
        });
      }),
    };
    (mockEnv.getComponent as any).mockImplementation((name: string) => {
      if (name === "llm") return mockLLMComponent;
      if (name === "session") return mockSessionComponent;
      if (name === "config") return configComponent;
      return undefined;
    });

    const mockTool: any = {
      name: "echo_tool",
      description: "Echo tool",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(() =>
        Promise.resolve({ success: true, output: "ok", metadata: {} })
      ),
    };
    agentComponent.setDefaultTools([mockTool]);

    await agentComponent.run("test-agent", "test query", { sessionId: "test-session" });

    const pairing = verifyToolPairing(recordedMessages);
    expect(pairing).toEqual({ paired: true });
  });
});
