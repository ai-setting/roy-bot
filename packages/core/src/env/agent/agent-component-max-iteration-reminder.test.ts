/**
 * @fileoverview AgentComponent + MaxIterationReminderPlugin integration tests
 *                  (round 2 — same meta-protocol as AutoTaskPlugin)
 *
 * Verifies the max-iteration final reminder:
 *  - Is signaled by the plugin via toolResult.result.metadata.toAddFakeUserMessage
 *    (SAME field as AutoTaskPlugin, not a new side-channel)
 *  - Triggers at iter === maxIter-1, so iter === maxIter's LLM call sees it
 *  - AgentComponent's existing meta-protocol flushes it after tool_results
 *  - Is idempotent across re-entries in the same query
 *  - For maxIterations <= 1: defensive skip (no fake toolResult)
 *  - Coexists with AutoTaskPlugin's delegate-threshold reminder:
 *    - When they fire on different iters: both reminders appear in messages
 *    - When they fire on same iter: merged into ONE user message with
 *      max-iter at the END (final instruction)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentComponent } from "./agent-component";
import { ConfigComponent } from "../../config/config-component";
import { createAutoTaskPlugin } from "../task/plugins/auto-task-plugin";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

// ============================================================================
// Helpers
// ============================================================================

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

function findUserMsgByContent(recorded: any[], pattern: RegExp): { index: number; content: string } | null {
  for (let i = 0; i < recorded.length; i++) {
    const m = recorded[i];
    const text = typeof m?.content === "string" ? m.content : "";
    if (m?.role === "user" && pattern.test(text)) {
      return { index: i, content: text };
    }
  }
  return null;
}

const MAX_ITER_PATTERN = /已经达到最大 ReAct 迭代次数/;
const DELEGATE_PATTERN = /delegate_task/;

// ============================================================================
// Tests
// ============================================================================

describe("AgentComponent — MaxIterationReminderPlugin integration (round 2)", () => {
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

    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-maxiter-r2-"));
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
      getContext: vi.fn(async () => ({ messages: [], checkpoint: undefined })),
    };

    mockEnv = createMockEnvironment();
    (mockEnv.getComponent as any).mockImplementation((name: string) => {
      if (name === "session") return mockSessionComponent;
      if (name === "config") return configComponent;
      return undefined;
    });

    await agentComponent.init({ env: mockEnv, options: { configComponent } });
  });

  // --------------------------------------------------------------------------
  // RED-O: Sub-agent (maxIter=3), LLM cooperates → finalText is summary.
  //   - iter 1: tool call (no reminder)
  //   - iter 2: tool call (iter===maxIter-1=2 → MaxIter reminder set)
  //     → AgentComponent flushes after tool result
  //   - iter 3 (=== maxIter): LLM sees reminder, returns text
  // --------------------------------------------------------------------------
  it("RED-O: sub-agent maxIter=3, LLM cooperates → reminder flushed at iter=2, LLM at iter=3 sees it", async () => {
    agentComponent.registerAgent("test-sub", {
      type: "sub",
      systemPrompt: "You are a sub-agent.",
      maxIterations: 3,
    });

    let llmCallCount = 0;
    const mockLLMComponent = {
      invoke: vi.fn().mockImplementation(() => {
        llmCallCount++;
        if (llmCallCount <= 2) {
          return Promise.resolve({
            output: {
              content: "",
              toolCalls: [
                { id: `tc${llmCallCount}`, function: { name: "echo_tool", arguments: "{}" } },
              ],
            },
            providerId: "openai", model: "gpt-4o", latencyMs: 50,
          });
        }
        // At iter 3: LLM sees the max-iter reminder, returns text
        return Promise.resolve({
          output: { content: "Final sub-agent summary: task complete.", toolCalls: [] },
          providerId: "openai", model: "gpt-4o", latencyMs: 50,
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
      name: "echo_tool", description: "Echo tool",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(() => Promise.resolve({ success: true, output: "ok", metadata: {} })),
    };
    agentComponent.setDefaultTools([mockTool]);

    const result = await agentComponent.run("test-sub", "test query", { sessionId: "test-session" });

    expect(result.finalText).toBe("Final sub-agent summary: task complete.");
    expect(result.finalText).not.toBe("Maximum iterations reached.");

    // The max-iter reminder was flushed
    const reminder = findUserMsgByContent(recordedMessages, MAX_ITER_PATTERN);
    expect(reminder).not.toBeNull();
    expect(reminder!.content).toContain("3");
    expect(reminder!.content).toContain("不要再调用任何工具");
  });

  // --------------------------------------------------------------------------
  // RED-P: Sub-agent (maxIter=3), LLM DOES NOT cooperate → loop exits with
  // placeholder, sub-agent STILL returns SOMETHING.
  // --------------------------------------------------------------------------
  it("RED-P: sub-agent maxIter=3, LLM ignores reminder → loop exits with placeholder text", async () => {
    agentComponent.registerAgent("test-sub", {
      type: "sub", systemPrompt: "Stubborn.", maxIterations: 3,
    });

    const mockLLMComponent = {
      invoke: vi.fn().mockImplementation(() =>
        Promise.resolve({
          output: {
            content: "",
            toolCalls: [
              { id: `tc${Math.random()}`, function: { name: "echo_tool", arguments: "{}" } },
            ],
          },
          providerId: "openai", model: "gpt-4o", latencyMs: 50,
        })
      ),
    };
    (mockEnv.getComponent as any).mockImplementation((name: string) => {
      if (name === "llm") return mockLLMComponent;
      if (name === "session") return mockSessionComponent;
      if (name === "config") return configComponent;
      return undefined;
    });
    const mockTool: any = {
      name: "echo_tool", description: "Echo tool",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(() => Promise.resolve({ success: true, output: "ok", metadata: {} })),
    };
    agentComponent.setDefaultTools([mockTool]);

    const result = await agentComponent.run("test-sub", "test query", { sessionId: "test-session" });

    // The reminder was flushed exactly once (at iter 2, the iter=maxIter-1=2)
    const reminders = recordedMessages.filter(
      (m: any) => m?.role === "user" && MAX_ITER_PATTERN.test(m.content ?? "")
    );
    expect(reminders.length).toBe(1);
    expect(result.finalText).toBeDefined();
    expect(typeof result.finalText).toBe("string");
    expect(result.finalText!.length).toBeGreaterThan(0);
  });

  // --------------------------------------------------------------------------
  // RED-Q: Multi-tool-call same iter → fake user message comes AFTER ALL
  // tool results of the same assistant(tool_calls) message. AI SDK adjacency.
  // --------------------------------------------------------------------------
  it("RED-Q: multi-tool-call at iter=maxIter-1 → fake user msg AFTER all tool results (no orphan)", async () => {
    agentComponent.registerAgent("test-sub", {
      type: "sub", systemPrompt: "x", maxIterations: 3,
    });

    let llmCallCount = 0;
    const mockLLMComponent = {
      invoke: vi.fn().mockImplementation(() => {
        llmCallCount++;
        // All iterations: LLM returns 3 tool calls (stubborn)
        return Promise.resolve({
          output: {
            content: "",
            toolCalls: [
              { id: `tc${llmCallCount}a`, function: { name: "echo_tool", arguments: "{}" } },
              { id: `tc${llmCallCount}b`, function: { name: "echo_tool", arguments: "{}" } },
              { id: `tc${llmCallCount}c`, function: { name: "echo_tool", arguments: "{}" } },
            ],
          },
          providerId: "openai", model: "gpt-4o", latencyMs: 50,
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
      name: "echo_tool", description: "Echo tool",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(() => Promise.resolve({ success: true, output: "ok", metadata: {} })),
    };
    agentComponent.setDefaultTools([mockTool]);

    await agentComponent.run("test-sub", "q", { sessionId: "s" });

    // Locate the max-iter reminder
    const reminderIdx = recordedMessages.findIndex(
      (m: any) => m?.role === "user" && MAX_ITER_PATTERN.test(m.content ?? "")
    );
    expect(reminderIdx).toBeGreaterThan(-1);

    // Find the assistant(tool_calls) message immediately preceding the reminder
    let prevAssistantIdx = -1;
    for (let i = reminderIdx - 1; i >= 0; i--) {
      if (recordedMessages[i]?.role === "assistant") {
        prevAssistantIdx = i;
        break;
      }
    }
    expect(prevAssistantIdx).toBeGreaterThan(-1);

    // ★ AI SDK adjacency: between the assistant(tool_calls) and the
    //   max-iter reminder, ONLY tool messages may appear (no user/system
    //   messages that would orphan trailing tool_results).
    for (let i = prevAssistantIdx + 1; i < reminderIdx; i++) {
      const m = recordedMessages[i];
      if (m?.role !== "tool") {
        throw new Error(
          `AI SDK adjacency violation at idx=${i}: ${m?.role} message between assistant(tool_calls) and max-iter reminder`
        );
      }
    }
  });

  // --------------------------------------------------------------------------
  // RED-R: maxIterations=1 (compact/compact-hint) → NO reminder injected.
  //   Plugin defensive skip; sub-agent runs single LLM call, returns text.
  // --------------------------------------------------------------------------
  it("RED-R: maxIterations=1 (compact/compact-hint) → defensive skip, NO reminder injected", async () => {
    agentComponent.registerAgent("compact", {
      type: "sub", systemPrompt: "Compactor.", maxIterations: 1,
    });

    let llmCallCount = 0;
    const mockLLMComponent = {
      invoke: vi.fn().mockImplementation(() => {
        llmCallCount++;
        return Promise.resolve({
          output: { content: "Summary text from compact.", toolCalls: [] },
          providerId: "openai", model: "gpt-4o", latencyMs: 50,
        });
      }),
    };
    (mockEnv.getComponent as any).mockImplementation((name: string) => {
      if (name === "llm") return mockLLMComponent;
      if (name === "session") return mockSessionComponent;
      if (name === "config") return configComponent;
      return undefined;
    });

    const result = await agentComponent.run("compact", "q", { sessionId: "s" });
    expect(llmCallCount).toBe(1);
    // NO max-iter reminder injected (defensive skip)
    const reminders = recordedMessages.filter(
      (m: any) => m?.role === "user" && MAX_ITER_PATTERN.test(m.content ?? "")
    );
    expect(reminders.length).toBe(0);
    expect(result.finalText).toBe("Summary text from compact.");
  });

  // --------------------------------------------------------------------------
  // RED-S: AutoTaskPlugin (threshold=20) + MaxIterReminder (maxIter=200)
  //   on different iters: both reminders present in messages.
  // --------------------------------------------------------------------------
  it("RED-S: AutoTaskPlugin (threshold=20) + MaxIterReminder (maxIter=200) on different iters — both present", async () => {
    agentComponent.registerAgent("default-agent", {
      type: "primary", systemPrompt: "Default.", maxIterations: 200,
    });
    agentComponent.registerPlugin(
      "default-agent",
      createAutoTaskPlugin({ threshold: 20, agentName: "default-agent" }),
    );

    let llmCallCount = 0;
    const mockLLMComponent = {
      invoke: vi.fn().mockImplementation(() => {
        llmCallCount++;
        if (llmCallCount <= 20) {
          return Promise.resolve({
            output: {
              content: "",
              toolCalls: [
                { id: `tc${llmCallCount}`, function: { name: "echo_tool", arguments: "{}" } },
              ],
            },
            providerId: "openai", model: "gpt-4o", latencyMs: 50,
          });
        }
        // At iter 21: AutoTask reminder was flushed at iter 20. LLM sees it
        // and cooperates with delegate_task.
        return Promise.resolve({
          output: { content: "I'll delegate to roy.", toolCalls: [] },
          providerId: "openai", model: "gpt-4o", latencyMs: 50,
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
      name: "echo_tool", description: "Echo tool",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(() => Promise.resolve({ success: true, output: "ok", metadata: {} })),
    };
    agentComponent.setDefaultTools([mockTool]);

    await agentComponent.run("default-agent", "q", { sessionId: "s" });

    // AutoTask reminder is present
    const delegate = findUserMsgByContent(recordedMessages, DELEGATE_PATTERN);
    expect(delegate).not.toBeNull();
    // MaxIter reminder is NOT present (we never reached iter=199)
    const maxIter = findUserMsgByContent(recordedMessages, MAX_ITER_PATTERN);
    expect(maxIter).toBeNull();
  });

  // --------------------------------------------------------------------------
  // RED-T: AutoTaskPlugin (threshold=20) + MaxIterReminder (maxIter=21) on
  //   SAME iter=20 (since 20 === maxIter-1 === threshold).
  //   Both reminders are MERGED into ONE user message; max-iter at the END.
  // --------------------------------------------------------------------------
  it("RED-T: AutoTaskPlugin (threshold=20) + MaxIterReminder (maxIter=21) on same iter=20 — merged into ONE user message, max-iter at end", async () => {
    agentComponent.registerAgent("default-agent", {
      type: "primary", systemPrompt: "Default.", maxIterations: 21,
    });
    agentComponent.registerPlugin(
      "default-agent",
      createAutoTaskPlugin({ threshold: 20, agentName: "default-agent" }),
    );

    let llmCallCount = 0;
    const mockLLMComponent = {
      invoke: vi.fn().mockImplementation(() => {
        llmCallCount++;
        if (llmCallCount <= 20) {
          return Promise.resolve({
            output: {
              content: "",
              toolCalls: [
                { id: `tc${llmCallCount}`, function: { name: "echo_tool", arguments: "{}" } },
              ],
            },
            providerId: "openai", model: "gpt-4o", latencyMs: 50,
          });
        }
        // At iter 21: BOTH reminders flushed (merged into one message).
        // LLM sees the merged message; max-iter is at the END as the final
        // instruction, so LLM cooperates with max-iter (no more tool calls,
        // just summarize).
        return Promise.resolve({
          output: { content: "Final merged reminder: stop + summarize.", toolCalls: [] },
          providerId: "openai", model: "gpt-4o", latencyMs: 50,
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
      name: "echo_tool", description: "Echo tool",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(() => Promise.resolve({ success: true, output: "ok", metadata: {} })),
    };
    agentComponent.setDefaultTools([mockTool]);

    await agentComponent.run("default-agent", "q", { sessionId: "s" });

    // Find user messages: there should be ONE merged user message (not two)
    const delegateMsgs = recordedMessages.filter(
      (m: any) => m?.role === "user" && DELEGATE_PATTERN.test(m.content ?? "")
    );
    const maxIterMsgs = recordedMessages.filter(
      (m: any) => m?.role === "user" && MAX_ITER_PATTERN.test(m.content ?? "")
    );

    // ★ BOTH reminders present (no silent overwrite)
    expect(delegateMsgs.length).toBe(1);
    expect(maxIterMsgs.length).toBe(1);
    // ★ But they are the SAME user message (merged by the shared helper)
    expect(delegateMsgs[0]).toBe(maxIterMsgs[0]);
    // ★ max-iter content is at the END (final instruction)
    const merged = maxIterMsgs[0].content as string;
    expect(merged.indexOf("不要再调用任何工具")).toBeGreaterThan(merged.indexOf("delegate_task"));
  });

  // --------------------------------------------------------------------------
  // RED-U: auto-registration — every agent gets the plugin automatically
  // --------------------------------------------------------------------------
  it("RED-U: registerAgent() auto-registers MaxIterationReminderPlugin on EVERY agent (default, sub, custom)", async () => {
    const defaultAgent = agentComponent.registerAgent("my-default", { type: "primary", maxIterations: 50 });
    const subAgent = agentComponent.registerAgent("my-sub", { type: "sub", maxIterations: 10 });
    const customAgent = agentComponent.registerAgent("my-custom", { type: "primary", maxIterations: 5 });

    for (const inst of [defaultAgent, subAgent, customAgent]) {
      const plugins = Array.from(inst.plugins.keys());
      expect(plugins).toContain("MaxIterationReminderPlugin");
    }
  });
});
