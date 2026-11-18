/**
 * @fileoverview recordSessionMessages — batch transaction tests (Layer 3)
 *
 * Verifies that `recordSessionMessages` calls the new `sessionComponent.addMessages`
 * batch API **once** with all filtered messages, instead of N separate `addMessage`
 * calls. This is the storage-layer optimization that turns N×2 SQL statements
 * (per React iteration) into a single BEGIN/COMMIT block.
 *
 * If the store throws mid-batch, the existing try/catch in
 * `recordSessionMessages` should swallow the error (no crash, no partial
 * commit thanks to ROLLBACK at the SQLite layer).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentComponent } from "./agent-component";
import { ConfigComponent } from "../../config/config-component";
import type { SessionComponent } from "../session/session-component";
import type { ModelMessage } from "ai";
import type { Environment } from "../interface";

// ============================================================================
// Mock Helpers
// ============================================================================

function createMockSessionComponent(): SessionComponent & {
  _addMessageCalls: Array<{ sessionId: string; msg: any }>;
  _addMessagesCalls: Array<{ sessionId: string; msgs: any[] }>;
} {
  const messages = new Map<string, any[]>();
  const addMessageCalls: Array<{ sessionId: string; msg: any }> = [];
  const addMessagesCalls: Array<{ sessionId: string; msgs: any[] }> = [];

  const mock: any = {
    _messages: messages,
    _addMessageCalls: addMessageCalls,
    _addMessagesCalls: addMessagesCalls,
    addMessage: vi.fn(async (sessionId: string, msg: any) => {
      addMessageCalls.push({ sessionId, msg });
      const sessionMessages = messages.get(sessionId) ?? [];
      sessionMessages.push({
        id: `msg_${addMessageCalls.length}_${Date.now()}`,
        sessionID: sessionId,
        role: msg.role,
        content: msg.content,
        timestamp: Date.now(),
        parts: msg.parts,
        metadata: msg.metadata,
      });
      messages.set(sessionId, sessionMessages);
      return `msg_${addMessageCalls.length}`;
    }),
    addMessages: vi.fn(async (sessionId: string, msgs: any[]) => {
      addMessagesCalls.push({ sessionId, msgs });
      const sessionMessages = messages.get(sessionId) ?? [];
      const ids: string[] = [];
      for (const m of msgs) {
        const id = `msg_batch_${addMessagesCalls.length}_${sessionMessages.length}`;
        ids.push(id);
        sessionMessages.push({
          id,
          sessionID: sessionId,
          role: m.role,
          content: m.content,
          timestamp: Date.now(),
          parts: m.parts,
          metadata: m.metadata,
        });
      }
      messages.set(sessionId, sessionMessages);
      return ids;
    }),
    getMessages: vi.fn(async (sessionId: string) => messages.get(sessionId) ?? []),
    getMessageCount: vi.fn(async (sessionId: string) => messages.get(sessionId)?.length ?? 0),
  };
  return mock as any;
}

function createMockEnv(sessionComponent: SessionComponent): Environment {
  const mockConfig: any = { get: vi.fn(() => undefined) };
  return {
    name: "test-env",
    version: "1.0.0",
    getComponent: vi.fn((name: string) => {
      if (name === "session") return sessionComponent;
      if (name === "config") return mockConfig;
      return undefined;
    }),
    pushEnvEvent: vi.fn(),
    subscribeTo: vi.fn(() => () => {}),
  };
}

async function recordSessionMessages(
  agent: AgentComponent,
  sessionId: string,
  allMessages: ModelMessage[]
) {
  // @ts-ignore - accessing private method
  return agent.recordSessionMessages(sessionId, allMessages);
}

// ============================================================================
// Tests
// ============================================================================

describe("recordSessionMessages — batch API (Layer 3)", () => {
  let sessionComponent: ReturnType<typeof createMockSessionComponent>;
  let agentComponent: AgentComponent;

  beforeEach(async () => {
    vi.clearAllMocks();
    sessionComponent = createMockSessionComponent();
    agentComponent = new AgentComponent();
    const mockEnv = createMockEnv(sessionComponent);
    await agentComponent.init({
      env: mockEnv,
      options: { configComponent: new ConfigComponent() },
    });
  });

  it("calls addMessages() ONCE with all filtered messages in a single transaction", async () => {
    const allMessages: ModelMessage[] = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    ];

    await recordSessionMessages(agentComponent, "session_batch_1", allMessages);

    // Should call addMessages exactly once with the filtered batch
    expect(sessionComponent._addMessagesCalls).toHaveLength(1);
    expect(sessionComponent._addMessagesCalls[0].sessionId).toBe("session_batch_1");
    expect(sessionComponent._addMessagesCalls[0].msgs).toHaveLength(4);

    // Should NOT call addMessage individually (legacy path)
    expect(sessionComponent._addMessageCalls).toHaveLength(0);

    // All messages still persisted via the batch path
    const stored = sessionComponent._messages.get("session_batch_1") ?? [];
    expect(stored).toHaveLength(4);
  });

  it("filters out system + empty messages BEFORE batching (no wasted tx slots)", async () => {
    const allMessages: ModelMessage[] = [
      { role: "system", content: "you are a helpful assistant" },
      { role: "user", content: "" }, // empty → skipped
      { role: "user", content: "real question" },
      { role: "assistant", content: "" }, // empty → skipped
      { role: "assistant", content: "real answer" },
    ];

    await recordSessionMessages(agentComponent, "session_batch_2", allMessages);

    expect(sessionComponent._addMessagesCalls).toHaveLength(1);
    const batchedMsgs = sessionComponent._addMessagesCalls[0].msgs;
    expect(batchedMsgs).toHaveLength(2);
    expect(batchedMsgs.map((m: any) => `${m.role}:${m.content}`)).toEqual([
      "user:real question",
      "assistant:real answer",
    ]);
  });

  it("does not crash when addMessages throws — error is logged and swallowed", async () => {
    // Simulate FK violation / disk full / etc.
    sessionComponent.addMessages = vi.fn(async () => {
      throw new Error("FOREIGN KEY constraint failed");
    });

    const allMessages: ModelMessage[] = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    ];

    // Should NOT throw — recordSessionMessages wraps the call in try/catch.
    // ★ Task #4720 (DS review MINOR 3): it now returns a boolean telling the
    // caller whether the batch was actually persisted. A failed batch must
    // report `false` so the caller keeps its cursor and retries later.
    await expect(
      recordSessionMessages(agentComponent, "session_batch_fail", allMessages)
    ).resolves.toBe(false);

    // The batch was attempted once
    expect(sessionComponent.addMessages).toHaveBeenCalledTimes(1);
  });

  it("returns early when there are no messages to record (no addMessages call)", async () => {
    const allMessages: ModelMessage[] = [
      { role: "system", content: "system-only" },
      { role: "user", content: "" },
      { role: "assistant", content: "" },
    ];

    await recordSessionMessages(agentComponent, "session_batch_empty", allMessages);

    // No batch call expected — implementation should skip the call entirely
    // (or call addMessages with an empty array; either is acceptable)
    const totalCalls =
      sessionComponent._addMessagesCalls.length + sessionComponent._addMessageCalls.length;
    // If addMessages was called, it should have been with an empty array
    if (sessionComponent._addMessagesCalls.length > 0) {
      expect(sessionComponent._addMessagesCalls[0].msgs).toHaveLength(0);
    } else {
      expect(totalCalls).toBe(0);
    }
  });
});