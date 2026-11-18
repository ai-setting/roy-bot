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
describe("AgentComponent — meta-protocol: tool_call/tool_result ordering", () => {
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

    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-meta-"));
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

  it("RED: when after.tool hook sets toAddFakeUserMessage, user msg is pushed AFTER tool result (preserves tool_call/tool_result adjacency)", async () => {
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
          return Promise.resolve({
            output: {
              content: "I'll use a tool first",
              toolCalls: [
                { id: "tc1", function: { name: "echo_tool", arguments: "{}" } },
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
        Promise.resolve({
          success: true,
          output: "tool_result_value",
          metadata: { execution_time_ms: 10 },
        })
      ),
    };
    agentComponent.setDefaultTools([mockTool]);

    await agentComponent.run("test-agent", "test query", { sessionId: "test-session" });

    function hasToolCallParts(msg: any): boolean {
      if (!msg) return false;
      if (msg.parts && Array.isArray(msg.parts)) {
        return msg.parts.some((p: any) => p?.type === "tool-call");
      }
      if (msg.content && Array.isArray(msg.content)) {
        return msg.content.some((p: any) => p?.type === "tool-call");
      }
      return false;
    }

    let lastAssistantHadToolCalls = false;
    let foundOrphanedTool = false;
    let toolFollowedByNonTool = false;
    let lastAssistantIndex = -1;
    let lastToolIndex = -1;

    for (let i = 0; i < recordedMessages.length; i++) {
      const msg = recordedMessages[i];
      if (!msg) continue;
      if (msg.role === "assistant") {
        lastAssistantHadToolCalls = hasToolCallParts(msg);
        lastAssistantIndex = i;
      } else if (msg.role === "tool") {
        if (!lastAssistantHadToolCalls) {
          foundOrphanedTool = true;
        }
        lastToolIndex = i;
        lastAssistantHadToolCalls = false;
      } else if (msg.role === "user") {
        // If a user message comes between assistant(tool_calls) and tool(result),
        // this breaks tool_call/tool_result adjacency.
        // Specifically: the assistant(tool_calls) must be IMMEDIATELY followed by tool(result),
        // no user message in between.
        if (
          lastAssistantHadToolCalls === false &&
          lastAssistantIndex > lastToolIndex
        ) {
          // assistant without tool-calls already seen after last tool, OK
        }
        lastAssistantHadToolCalls = false;
      }
    }

    // Verify that after the tool result, the user reminder was pushed
    // (the meta-protocol user message)
    const userReminders = recordedMessages.filter(
      (m: any) =>
        m?.role === "user" &&
        typeof m?.content === "string" &&
        (m.content.includes("delegate_task") || m.content.includes("roy"))
    );
    expect(userReminders.length).toBeGreaterThanOrEqual(1);

    // Verify that NO tool message is preceded by user message (which would mean
    // the wrong order [assistant, user, tool])
    let userBeforeTool = false;
    for (let i = 1; i < recordedMessages.length; i++) {
      const prev = recordedMessages[i - 1];
      const cur = recordedMessages[i];
      if (cur?.role === "tool" && prev?.role === "user") {
        userBeforeTool = true;
      }
    }
    expect(userBeforeTool).toBe(false);

    expect(foundOrphanedTool).toBe(false);
  });

  // =====================================================================
  // RED tests for Task #2170: multi-tool-call user-reminder placement bug
  // Bug: when LLM returns multiple tool-calls in one iteration AND
  // AutoTaskPlugin triggers the user reminder, the reminder is currently
  // inserted BETWEEN tool-results (because meta-protocol consume runs
  // inside the for-loop), breaking AI SDK v6's strict adjacency rule.
  // =====================================================================

  it("RED #2170: multi-tool-call iteration MUST place user reminder AFTER ALL tool-results (not between them)", async () => {
    agentComponent.registerAgent("multi-tool-agent", {
      type: "primary",
      systemPrompt: "You are a test assistant.",
      maxIterations: 5,
    });
    const plugin = createAutoTaskPlugin({ threshold: 1, agentName: "multi-tool-agent" });
    agentComponent.registerPlugin("multi-tool-agent", plugin);

    let llmCallCount = 0;
    const mockLLMComponent = {
      invoke: vi.fn().mockImplementation(() => {
        llmCallCount++;
        if (llmCallCount === 1) {
          // LLM returns THREE tool calls in one iteration
          return Promise.resolve({
            output: {
              content: "I'll use three tools in parallel",
              toolCalls: [
                { id: "tc_A", function: { name: "echo_tool", arguments: "{}" } },
                { id: "tc_B", function: { name: "echo_tool", arguments: "{}" } },
                { id: "tc_C", function: { name: "echo_tool", arguments: "{}" } },
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
        Promise.resolve({
          success: true,
          output: "tool_result_value",
          metadata: { execution_time_ms: 10 },
        })
      ),
    };
    agentComponent.setDefaultTools([mockTool]);

    await agentComponent.run("multi-tool-agent", "test query", { sessionId: "multi-tool-session" });

    // Core assertion 1: messages order MUST be
    // [assistant(tool_calls), tool(A), tool(B), tool(C), user(reminder)]
    // i.e. NO reminder between tool results.
    let lastToolIdx = -1;
    let userAfterLastTool = false;
    let userBetweenTools = false;

    for (let i = 0; i < recordedMessages.length; i++) {
      const msg = recordedMessages[i];
      if (!msg) continue;
      if (msg?.role === "tool") {
        // detect reminder between two tool messages
        if (i + 1 < recordedMessages.length && recordedMessages[i + 1]?.role === "user") {
          const nextUser = recordedMessages[i + 1];
          const isReminder = typeof nextUser?.content === "string" && nextUser.content.includes("delegate_task");
          if (isReminder && lastToolIdx !== -1 && i > lastToolIdx + 1) {
            userBetweenTools = true;
          }
        }
        lastToolIdx = i;
      } else if (msg?.role === "user" && typeof msg?.content === "string" && msg.content.includes("delegate_task")) {
        if (lastToolIdx > 0 && i === lastToolIdx + 1) {
          userAfterLastTool = true;
        }
      }
    }

    expect(userBetweenTools).toBe(false); // ❌ bug: reminder shouldn't appear between tool-results
    expect(userAfterLastTool).toBe(true);  // ✅ reminder must follow the LAST tool-result

    // Core assertion 2: exactly 3 tool messages (one per tool_call)
    const toolMessages = recordedMessages.filter((m: any) => m?.role === "tool");
    expect(toolMessages.length).toBe(3);

    // Core assertion 3: exactly 1 user reminder (plugin dedup works in multi-batch)
    const userReminders = recordedMessages.filter(
      (m: any) =>
        m?.role === "user" &&
        typeof m?.content === "string" &&
        m.content.includes("delegate_task")
    );
    expect(userReminders.length).toBe(1);

    // Core assertion 4: every tool message must follow assistant(tool_calls) or another tool
    // i.e. NO tool message may be preceded by a user message (orphan check)
    for (let i = 0; i < recordedMessages.length; i++) {
      const msg = recordedMessages[i];
      if (msg?.role === "tool" && i > 0) {
        const prev = recordedMessages[i - 1];
        const prevIsAssistant = prev?.role === "assistant";
        const prevIsTool = prev?.role === "tool";
        expect(prevIsAssistant || prevIsTool).toBe(true);
      }
    }
  });

  it("RED #2170 (regression): single tool-call iteration still places user reminder AFTER tool-result", async () => {
    agentComponent.registerAgent("single-tool-agent", {
      type: "primary",
      systemPrompt: "You are a test assistant.",
      maxIterations: 5,
    });
    const plugin = createAutoTaskPlugin({ threshold: 1, agentName: "single-tool-agent" });
    agentComponent.registerPlugin("single-tool-agent", plugin);

    let llmCallCount = 0;
    const mockLLMComponent = {
      invoke: vi.fn().mockImplementation(() => {
        llmCallCount++;
        if (llmCallCount === 1) {
          return Promise.resolve({
            output: {
              content: "I'll use a tool",
              toolCalls: [
                { id: "tc_single", function: { name: "echo_tool", arguments: "{}" } },
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
        Promise.resolve({
          success: true,
          output: "result",
          metadata: { execution_time_ms: 10 },
        })
      ),
    };
    agentComponent.setDefaultTools([mockTool]);

    await agentComponent.run("single-tool-agent", "test", { sessionId: "single-tool-session" });

    const userReminders = recordedMessages.filter(
      (m: any) =>
        m?.role === "user" &&
        typeof m?.content === "string" &&
        m.content.includes("delegate_task")
    );
    expect(userReminders.length).toBe(1);

    // Single tool-call: reminder must immediately follow the tool result
    const lastToolIdx = recordedMessages.map((m: any) => m?.role).lastIndexOf("tool");
    expect(lastToolIdx).toBeGreaterThanOrEqual(0);
    expect(recordedMessages[lastToolIdx + 1]?.role).toBe("user");
    expect(recordedMessages[lastToolIdx + 1]?.content).toContain("delegate_task");
  });

  it("RED #2170 (dedup): plugin lastProcessedTraceId ensures reminder fires ONCE across multiple iterations with multi-batch", async () => {
    agentComponent.registerAgent("dedup-agent", {
      type: "primary",
      systemPrompt: "You are a test assistant.",
      maxIterations: 5,
    });
    const plugin = createAutoTaskPlugin({ threshold: 1, agentName: "dedup-agent" });
    agentComponent.registerPlugin("dedup-agent", plugin);

    let llmCallCount = 0;
    const mockLLMComponent = {
      invoke: vi.fn().mockImplementation(() => {
        llmCallCount++;
        // Each LLM call returns 2 tool-calls (multi-batch per iteration)
        if (llmCallCount <= 3) {
          return Promise.resolve({
            output: {
              content: `Iteration ${llmCallCount} tool batch`,
              toolCalls: [
                { id: `tc_${llmCallCount}_A`, function: { name: "echo_tool", arguments: "{}" } },
                { id: `tc_${llmCallCount}_B`, function: { name: "echo_tool", arguments: "{}" } },
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
        Promise.resolve({
          success: true,
          output: "result",
          metadata: { execution_time_ms: 10 },
        })
      ),
    };
    agentComponent.setDefaultTools([mockTool]);

    await agentComponent.run("dedup-agent", "test", { sessionId: "dedup-session-A" });

    // 3 iterations × 2 tool-call/iter = 6 tool messages
    const toolMessages = recordedMessages.filter((m: any) => m?.role === "tool");
    expect(toolMessages.length).toBe(6);

    // But user reminder appears EXACTLY ONCE (plugin uses traceId dedup)
    const userReminders = recordedMessages.filter(
      (m: any) =>
        m?.role === "user" &&
        typeof m?.content === "string" &&
        m.content.includes("delegate_task")
    );
    expect(userReminders.length).toBe(1);

    // Critical: every tool message must be preceded by assistant(tool_calls) or tool — never by user.
    let orphanTool = 0;
    for (let i = 0; i < recordedMessages.length; i++) {
      const msg = recordedMessages[i];
      if (msg?.role === "tool" && i > 0) {
        const prev = recordedMessages[i - 1];
        if (prev?.role === "user") orphanTool++;
      }
    }
    expect(orphanTool).toBe(0);
  });
});