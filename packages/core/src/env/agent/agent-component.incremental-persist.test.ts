/**
 * @fileoverview TDD tests — incremental session persistence during long ReAct loops
 *
 * Bug (Task #4720, 2026-10-30):
 *   delegate_task sub-agent sessions showed message_count=0 for up to 30+ min
 *   while the bg process reported "running". Root cause:
 *   recordSessionMessages() is only called AFTER the whole ReAct while-loop
 *   finishes (agent-component.ts ~line 2221). A long-running sub-agent
 *   (85 iterations / 30 min) accumulates all messages in memory
 *   (hookCtx.messages) and nothing is visible in sessions.db until the loop
 *   ends (or the task is stopped/aborted).
 *
 * Fix A (this file):
 *   Persist newly-added messages INCREMENTALLY at the end of every ReAct
 *   iteration (not only after the loop). The final post-loop call remains as
 *   a safety net for messages pushed after the last iteration (e.g. final
 *   assistant text, error-path tool results).
 *
 * Expected behavior after fix:
 *   - run() with N tool-call iterations → sessionComponent.addMessages called
 *     at least N times (one per iteration), not just once at the end.
 *   - Each incremental batch contains exactly the messages produced by that
 *     iteration (no duplicates, no loss).
 *   - persistSession: false → still zero calls (unchanged).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentComponent } from "./agent-component";
import type { Environment } from "../interface";
import { ConfigComponent } from "../../config/config-component";
import { z } from "zod";

// ============================================================================
// Mock helpers
// ============================================================================

function contentDerivedId(sessionId: string, msg: any): string {
  // Deterministic id from (role, content, toolCallId) so that writing the
  // SAME logical message twice yields the SAME id — a duplicate write then
  // shows up as a duplicated id, which the uniqueness assertion detects.
  const parts = [
    msg.role ?? "",
    typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? ""),
    msg.toolCallId ?? msg.tool_call_id ?? "",
  ];
  let hash = 0;
  const raw = `${sessionId}::${parts.join("::")}`;
  for (let i = 0; i < raw.length; i++) {
    hash = (hash * 31 + raw.charCodeAt(i)) | 0;
  }
  return `msg_${hash >>> 0}`;
}

function createMockSessionComponent() {
  const messages = new Map<string, any[]>();
  const addMessagesCalls: Array<{ sessionId: string; msgs: any[] }> = [];
  const mock: any = {
    _messages: messages,
    _addMessagesCalls: addMessagesCalls,
    // ★ Task #4720 (DS review round-2 MINOR 1): ids are derived from the
    // message CONTENT, not from a counter. With a counter (`msg_${arr.length}`)
    // every write gets a fresh id, so an "id uniqueness" assertion could never
    // detect a duplicated write. Content-derived ids make a re-persisted
    // batch produce the SAME id — which the uniqueness assertion can catch.
    addMessage: vi.fn(async (sessionId: string, msg: any) => {
      const arr = messages.get(sessionId) ?? [];
      const id = contentDerivedId(sessionId, msg);
      arr.push({ id, sessionID: sessionId, ...msg });
      messages.set(sessionId, arr);
      return id;
    }),
    addMessages: vi.fn(async (sessionId: string, msgs: any[]) => {
      addMessagesCalls.push({ sessionId, msgs });
      const arr = messages.get(sessionId) ?? [];
      const ids: string[] = [];
      for (const m of msgs) {
        const id = contentDerivedId(sessionId, m);
        ids.push(id);
        arr.push({ id, sessionID: sessionId, ...m });
      }
      messages.set(sessionId, arr);
      return ids;
    }),
    getMessages: vi.fn(async (sessionId: string) => messages.get(sessionId) ?? []),
    getMessageCount: vi.fn(async (sessionId: string) => messages.get(sessionId)?.length ?? 0),
    getContext: vi.fn(async (sessionId: string) => ({
      messages: messages.get(sessionId) ?? [],
      checkpoint: undefined,
    })),
  };
  return mock;
}

function createMockEnvironment(components: Record<string, any>): Environment {
  return {
    name: "test-env",
    version: "1.0.0",
    getConfig: vi.fn(() => ({ name: "test-env", version: "1.0.0", enabled: true })),
    registerComponent: vi.fn(),
    unregisterComponent: vi.fn(),
    getComponent: vi.fn((name: string) => components[name]),
    listComponents: vi.fn(() => Object.keys(components)),
    handle_query: vi.fn(),
    handle_action: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    subscribeTo: vi.fn(() => () => {}),
    subscribeAll: vi.fn(() => () => {}),
    pushEnvEvent: vi.fn(),
  } as unknown as Environment;
}

// ============================================================================
// Tests
// ============================================================================

describe("incremental session persistence during ReAct loop (Task #4720)", () => {
  let agentComponent: AgentComponent;
  let mockEnv: Environment;
  let configComponent: ConfigComponent;
  let mockSessionComponent: any;
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    const fsSync = await import("fs");
    const path = await import("path");
    const os = await import("os");
    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-incr-persist-"));
    configComponent = new ConfigComponent();
    configComponent.setXdgDataHome(tempDir);
    await configComponent.set("agent.configDir", tempDir + "/agents");
    fsSync.mkdirSync(tempDir + "/agents", { recursive: true });

    mockSessionComponent = createMockSessionComponent();
    mockEnv = createMockEnvironment({
      config: configComponent,
      session: mockSessionComponent,
    });
    agentComponent = new AgentComponent();
    await agentComponent.init({ env: mockEnv, options: { configComponent } } as any);
  });

  afterEach(() => {
    const fsSync = require("fs");
    try {
      fsSync.rmSync(tempDir, { recursive: true });
    } catch {}
  });

  it("multi-iteration run persists messages after EACH iteration (not only at loop end)", async () => {
    agentComponent.registerAgent("test-agent", {
      type: "primary",
      systemPrompt: "You are a helpful assistant.",
      maxIterations: 5,
    });

    // LLM: first 2 calls return tool calls, 3rd returns final text.
    let llmCallCount = 0;
    const mockLLMComponent = {
      invoke: vi.fn(() => {
        llmCallCount++;
        if (llmCallCount <= 2) {
          return Promise.resolve({
            output: {
              content: "",
              toolCalls: [
                {
                  id: `call_${llmCallCount}`,
                  function: { name: "probe_tool", arguments: "{}" },
                },
              ],
            },
          });
        }
        return Promise.resolve({
          output: { content: "final answer", toolCalls: [] },
        });
      }),
    };

    const mockProbeTool: any = {
      name: "probe_tool",
      description: "probe tool",
      parameters: z.object({}),
      execute: vi.fn(async () => ({
        success: true,
        output: "probe ok",
        metadata: { execution_time_ms: 0 },
      })),
    };
    agentComponent.setDefaultTools([mockProbeTool]);

    (mockEnv.getComponent as any).mockImplementation((name: string) => {
      if (name === "llm") return mockLLMComponent;
      if (name === "session") return mockSessionComponent;
      if (name === "config") return configComponent;
      return undefined;
    });

    const result = await agentComponent.run("test-agent", "do the probe", {
      sessionId: "sess_incr",
    });

    expect(result.iterations).toBe(3);

    // RED assertion: with the bug, addMessages is called exactly ONCE
    // (after the loop). After the fix it must be called once per iteration
    // that produced messages (≥ 2: iteration1 + iteration2; iteration3's
    // final text may be covered by the post-loop safety net).
    const calls = mockSessionComponent._addMessagesCalls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // Every batch must be non-empty — proves each call carried real content
    // (a tautological/empty batch would not prove incremental flushing).
    for (const c of calls) {
      expect(c.msgs.length).toBeGreaterThan(0);
    }

    // No duplicates: no message id may be written twice across batches.
    // (DS review MINOR 2: comparing stored.length to the summed batch sizes is
    //  tautological — the mock writes one row per message it is handed. Assert
    //  on id uniqueness instead, which actually catches a re-persisted batch.)
    const stored = mockSessionComponent._messages.get("sess_incr") ?? [];
    const storedIds = stored.map((m: any) => m.id);
    expect(new Set(storedIds).size).toBe(storedIds.length);

    // All expected roles are present exactly once
    const userCount = stored.filter((m: any) => m.role === "user").length;
    const assistantToolCallCount = stored.filter(
      (m: any) => m.role === "assistant"
    ).length;
    const toolCount = stored.filter((m: any) => m.role === "tool").length;
    expect(userCount).toBe(1); // initial query
    // 2 assistant-with-tool-call messages + 1 final text assistant message
    expect(assistantToolCallCount).toBe(3);
    expect(toolCount).toBe(2); // 2 tool results
  });

  it("persistence failure does NOT advance the cursor — failed batch is retried (Task #4720, DS review MINOR 3)", async () => {
    agentComponent.registerAgent("test-agent-fail", {
      type: "primary",
      systemPrompt: "You are a helpful assistant.",
      maxIterations: 4,
    });

    let llmCallCount = 0;
    const mockLLMComponent = {
      invoke: vi.fn(() => {
        llmCallCount++;
        if (llmCallCount <= 2) {
          return Promise.resolve({
            output: {
              content: "",
              toolCalls: [
                {
                  id: `call_${llmCallCount}`,
                  function: { name: "probe_tool_f", arguments: "{}" },
                },
              ],
            },
          });
        }
        return Promise.resolve({
          output: { content: "final answer", toolCalls: [] },
        });
      }),
    };

    const mockProbeTool: any = {
      name: "probe_tool_f",
      description: "probe tool f",
      parameters: z.object({}),
      execute: vi.fn(async () => ({
        success: true,
        output: "probe ok",
        metadata: { execution_time_ms: 0 },
      })),
    };
    agentComponent.setDefaultTools([mockProbeTool]);

    (mockEnv.getComponent as any).mockImplementation((name: string) => {
      if (name === "llm") return mockLLMComponent;
      if (name === "session") return mockSessionComponent;
      if (name === "config") return configComponent;
      return undefined;
    });

    // First persistence attempt fails (simulates SQLITE_BUSY / FK violation).
    let failNext = true;
    const originalAddMessages = mockSessionComponent.addMessages;
    mockSessionComponent.addMessages = vi.fn(async (sessionId: string, msgs: any[]) => {
      if (failNext) {
        failNext = false;
        // Record the failed attempt too, so the test can assert that THIS
        // exact batch is retried later (not just "some later batch exists").
        mockSessionComponent._addMessagesCalls.push({
          sessionId,
          msgs,
          failed: true,
        });
        throw new Error("FOREIGN KEY constraint failed");
      }
      return originalAddMessages(sessionId, msgs);
    });

    await agentComponent.run("test-agent-fail", "do the probe", {
      sessionId: "sess_incr_fail",
    });

    const calls = mockSessionComponent._addMessagesCalls;
    // calls[0] is the failed attempt (recorded by the mock above)
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect((calls[0] as any).failed).toBe(true);

    // The FAILED batch must be RETRIED verbatim in a later batch. Without the
    // cursor fix those messages would be silently dropped (cursor advanced
    // even though nothing was written).
    // Compare by role+content — role alone is too coarse (several messages
    // share the same role).
    const key = (m: any) => `${m.role}::${JSON.stringify(m.content)}`;
    const failedKeys = calls[0].msgs.map(key);
    expect(failedKeys.length).toBeGreaterThan(0);

    const laterKeys = new Set<string>();
    for (const c of calls.slice(1)) {
      for (const m of c.msgs) laterKeys.add(key(m));
    }
    for (const k of failedKeys) {
      expect(laterKeys.has(k)).toBe(true);
    }

    // And nothing may be duplicated: every stored id is unique.
    // (ids are content-derived, so a re-written batch WOULD collide.)
    const stored = mockSessionComponent._messages.get("sess_incr_fail") ?? [];
    const ids = stored.map((m: any) => m.id);
    expect(new Set(ids).size).toBe(ids.length);

    // ★ DS review round-2 MINOR 2: exact role counts. The id-uniqueness
    // assertion alone cannot catch "retried AND duplicated at the same time".
    const userCount = stored.filter((m: any) => m.role === "user").length;
    const assistantCount = stored.filter((m: any) => m.role === "assistant").length;
    const toolCount = stored.filter((m: any) => m.role === "tool").length;
    expect(userCount).toBe(1); // initial query only
    expect(assistantCount).toBe(3); // 2 tool-call turns + 1 final text
    expect(toolCount).toBe(2); // 2 tool results
  });

  it("persistSession: false → still zero addMessages calls (unchanged behavior)", async () => {
    agentComponent.registerAgent("test-agent-2", {
      type: "primary",
      systemPrompt: "You are a helpful assistant.",
      maxIterations: 3,
    });

    let llmCallCount = 0;
    const mockLLMComponent = {
      invoke: vi.fn(() => {
        llmCallCount++;
        if (llmCallCount < 2) {
          return Promise.resolve({
            output: {
              content: "",
              toolCalls: [
                {
                  id: `call_${llmCallCount}`,
                  function: { name: "probe_tool2", arguments: "{}" },
                },
              ],
            },
          });
        }
        return Promise.resolve({
          output: { content: "done", toolCalls: [] },
        });
      }),
    };

    const mockProbeTool: any = {
      name: "probe_tool2",
      description: "probe tool 2",
      parameters: z.object({}),
      execute: vi.fn(async () => ({
        success: true,
        output: "ok",
        metadata: { execution_time_ms: 0 },
      })),
    };
    agentComponent.setDefaultTools([mockProbeTool]);

    (mockEnv.getComponent as any).mockImplementation((name: string) => {
      if (name === "llm") return mockLLMComponent;
      if (name === "session") return mockSessionComponent;
      if (name === "config") return configComponent;
      return undefined;
    });

    await agentComponent.run("test-agent-2", "no persist", {
      sessionId: "sess_nopersist",
      persistSession: false,
    } as any);

    expect(mockSessionComponent.addMessages).not.toHaveBeenCalled();
    expect(mockSessionComponent._addMessagesCalls.length).toBe(0);
  });
});
