/**
 * @fileoverview RED probe B1 — WorkflowEngine.createSession must honor a
 * caller-reserved runId (Task #2106 verification)
 *
 * Background:
 *   The current WorkflowEngine.createSession implementation always calls
 *   `this.generateRunId()` to synthesize a runId, ignoring any value the
 *   caller may have passed via RunOptions.runId. This breaks the contract
 *   that runId === sessionId is a single string that the calling tool can
 *   pre-allocate for status / stop / resume operations.
 *
 *   After GREEN-B, createSession must:
 *     - Accept an optional `runId` in RunOptions
 *     - Use that runId (without re-formatting) as both the sessionId and
 *       metadata.runId
 *     - Fire onSessionCreated with the same runId
 *
 * Expected before repair: FAIL (engine generates a fresh runId)
 * Expected after repair:  PASS
 */

import { describe, it, expect, vi, beforeEach } from "bun:test";
import { WorkflowEngine } from "./engine";
import { NodeRegistry } from "./node-registry";
import type { RunOptions } from "../types/run";

function createMockNodeRegistry(): NodeRegistry {
  const mockGetNodeConfig = vi.fn();
  const mockCreateExecutorContext = vi.fn();
  return {
    getNodeConfig: mockGetNodeConfig,
    createExecutorContext: mockCreateExecutorContext,
  } as unknown as NodeRegistry;
}

function createMockSessionComponent() {
  const sessions = new Map<string, any>();
  const messages = new Map<string, any[]>();

  return {
    sessions,
    messages,
    create: vi.fn(async (session: any) => {
      sessions.set(session.id, { ...session, metadata: session.metadata || {} });
      messages.set(session.id, []);
      return session;
    }),
    get: vi.fn(async (sessionId: string) => sessions.get(sessionId) || null),
    update: vi.fn(async (sessionId: string, updates: any) => {
      const session = sessions.get(sessionId);
      if (session) Object.assign(session, updates);
      return session;
    }),
    addMessage: vi.fn(async (sessionId: string, message: any) => {
      const msgs = messages.get(sessionId) || [];
      msgs.push(message);
      messages.set(sessionId, msgs);
      return message;
    }),
    getMessages: vi.fn(async (sessionId: string) => messages.get(sessionId) || []),
    clear: vi.fn(() => {
      sessions.clear();
      messages.clear();
    }),
  };
}

describe("RED probe B1 — WorkflowEngine.createSession honors reserved runId", () => {
  let engine: WorkflowEngine;
  let mockSessionComponent: ReturnType<typeof createMockSessionComponent>;

  beforeEach(() => {
    const mockRegistry = createMockNodeRegistry();
    mockSessionComponent = createMockSessionComponent();
    engine = new WorkflowEngine(mockRegistry, mockSessionComponent as any);
  });

  it("uses the caller-reserved runId as the sessionId, metadata.runId, and callback argument", async () => {
    const reserved = "workflow_2106_reserved_1";
    const callback = vi.fn();
    const workflow: any = {
      name: "Reserved-RunId-Test",
      version: "1.0",
      nodes: [],
      config: { maxIterations: 100, loopEnabled: false },
      entry: "n1",
      inputs: {},
      outputs: [],
    };

    const sessionId = await engine.createSession(workflow, {
      runId: reserved,
      onSessionCreated: callback,
    } as unknown as RunOptions);

    expect(sessionId).toBe(reserved);
    expect(callback).toHaveBeenCalledWith(reserved);
    const persisted = await mockSessionComponent.get(reserved);
    expect(persisted).not.toBeNull();
    expect(persisted?.metadata?.runId).toBe(reserved);
  });

  it("does not regenerate runId when caller-provided one is already workflow_-prefixed", async () => {
    const reserved = "workflow_2106_reserved_2";
    const workflow: any = {
      name: "Reserved-RunId-Prefixed",
      version: "1.0",
      nodes: [],
      config: { maxIterations: 100, loopEnabled: false },
      entry: "n1",
      inputs: {},
      outputs: [],
    };

    const sessionId = await engine.createSession(workflow, { runId: reserved } as unknown as RunOptions);

    expect(sessionId).toBe(reserved);
    const persisted = await mockSessionComponent.get(reserved);
    expect(persisted?.metadata?.runId).toBe(reserved);
  });
});