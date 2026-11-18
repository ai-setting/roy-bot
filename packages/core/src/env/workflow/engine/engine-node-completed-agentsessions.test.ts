/**
 * TDD: WorkflowEngine node.completed / node.failed event handlers — must update single-node status (Task #2178 BUG-C / BUG-D)
 */

import { describe, it, expect, beforeEach, vi } from 'bun:test';
import { WorkflowEngine } from './engine';
import { NodeRegistry } from './node-registry';
import type { WorkflowEvent } from '../types/event';

const buildActiveSession = (overrides: Record<string, any> = {}) => ({
  sessionId: 'wf_node_event_test',
  status: 'running',
  startedAt: new Date(),
  abortController: new AbortController(),
  executor: { cancelAll: vi.fn() },
  eventBus: {
    publish: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
    clear: vi.fn(),
  },
  workflowHistory: [],
  nodeOutputs: new Map(),
  scheduler: { markFailed: vi.fn() },
  resolveCompleted: vi.fn(),
  rejectCompleted: vi.fn(),
  runId: 'wf_node_event_test',
  ...overrides,
});

/**
 * Helper: register the engine's event handlers for the given sessionState,
 * then return the handler that was registered for the named event.
 */
async function setupEngineAndGetHandler(
  engine: WorkflowEngine,
  sessionState: any,
  eventName: 'node.completed' | 'node.failed'
): Promise<(event: WorkflowEvent) => Promise<void>> {
  // Call setupEventHandlers directly so we don't need a full workflow config
  await (engine as any).setupEventHandlers(sessionState);
  // Find the handler registered for the event
  const calls = (sessionState.eventBus.on as any).mock.calls;
  const entry = calls.find((c: any[]) => c[0] === eventName);
  if (!entry) {
    throw new Error(`No handler registered for ${eventName}`);
  }
  return entry[1] as (event: WorkflowEvent) => Promise<void>;
}

describe('WorkflowEngine node.completed handler — single-node status (BUG-C)', () => {
  let mockSessionComponent: any;
  let engine: WorkflowEngine;

  beforeEach(() => {
    mockSessionComponent = {
      update: vi.fn().mockResolvedValue(true),
      get: vi.fn(),
      getMessages: vi.fn().mockResolvedValue([]),
    };
    engine = new WorkflowEngine(new NodeRegistry(), mockSessionComponent as any);
  });

  it('marks the completed node as completed in agentSessions', async () => {
    const sessionId = 'wf_node_completed_test';
    const agentSessions = [
      { nodeId: 'init-task', sessionId: 'sub1', status: 'active' as const },
      { nodeId: 'plan',      sessionId: 'sub2', status: 'active' as const },
    ];
    mockSessionComponent.get.mockResolvedValue({
      id: sessionId,
      metadata: { status: 'running', agentSessions },
    });

    const sessionState = buildActiveSession({ sessionId });
    (engine as any).activeSessions.set(sessionId, sessionState);
    const handler = await setupEngineAndGetHandler(engine, sessionState, 'node.completed');

    const fakeEvent = {
      type: 'node.completed',
      run_id: 'wf_node_completed_test',
      node_id: 'init-task',
      output: {},
      duration_ms: 100,
      timestamp: Date.now(),
    } as unknown as WorkflowEvent;

    await handler(fakeEvent);

    // After handler runs, sessionComponent.update should have been called with updated agentSessions
    const updateCall = mockSessionComponent.update.mock.calls.find(
      ([_id, payload]: any[]) => payload?.metadata?.agentSessions !== undefined
    );
    expect(updateCall).toBeDefined();
    const updated = updateCall![1].metadata.agentSessions;
    expect(updated.find((r: any) => r.nodeId === 'init-task')!.status).toBe('completed');
    expect(updated.find((r: any) => r.nodeId === 'plan')!.status).toBe('active');
  });

  it('leaves other nodes untouched when one node completes', async () => {
    const sessionId = 'wf_node_completed_other';
    const agentSessions = [
      { nodeId: 'a', sessionId: 's1', status: 'active' as const },
      { nodeId: 'b', sessionId: 's2', status: 'paused' as const },
      { nodeId: 'c', sessionId: 's3', status: 'completed' as const },
    ];
    mockSessionComponent.get.mockResolvedValue({
      id: sessionId,
      metadata: { status: 'running', agentSessions },
    });

    const sessionState = buildActiveSession({ sessionId });
    (engine as any).activeSessions.set(sessionId, sessionState);
    const handler = await setupEngineAndGetHandler(engine, sessionState, 'node.completed');

    const fakeEvent = {
      type: 'node.completed',
      run_id: sessionId,
      node_id: 'a',
      output: {},
      duration_ms: 50,
      timestamp: Date.now(),
    } as unknown as WorkflowEvent;

    await handler(fakeEvent);

    const updateCall = mockSessionComponent.update.mock.calls.find(
      ([_id, payload]: any[]) => payload?.metadata?.agentSessions !== undefined
    );
    const updated = updateCall![1].metadata.agentSessions;
    expect(updated.find((r: any) => r.nodeId === 'a')!.status).toBe('completed');
    // b stays paused, c stays completed
    expect(updated.find((r: any) => r.nodeId === 'b')!.status).toBe('paused');
    expect(updated.find((r: any) => r.nodeId === 'c')!.status).toBe('completed');
  });

  it('preserves already-completed node (idempotent)', async () => {
    const sessionId = 'wf_node_completed_idempotent';
    const agentSessions = [
      { nodeId: 'a', sessionId: 's1', status: 'completed' as const },
    ];
    mockSessionComponent.get.mockResolvedValue({
      id: sessionId,
      metadata: { status: 'running', agentSessions },
    });

    const sessionState = buildActiveSession({ sessionId });
    (engine as any).activeSessions.set(sessionId, sessionState);
    const handler = await setupEngineAndGetHandler(engine, sessionState, 'node.completed');

    const fakeEvent = {
      type: 'node.completed',
      run_id: sessionId,
      node_id: 'a',
      output: {},
      duration_ms: 10,
      timestamp: Date.now(),
    } as unknown as WorkflowEvent;

    await handler(fakeEvent);

    const updateCall = mockSessionComponent.update.mock.calls.find(
      ([_id, payload]: any[]) => payload?.metadata?.agentSessions !== undefined
    );
    const updated = updateCall![1].metadata.agentSessions;
    expect(updated.find((r: any) => r.nodeId === 'a')!.status).toBe('completed');
  });

  it('handles missing agentSessions gracefully', async () => {
    const sessionId = 'wf_node_completed_no_agent';
    mockSessionComponent.get.mockResolvedValue({
      id: sessionId,
      metadata: { status: 'running' },
    });

    const sessionState = buildActiveSession({ sessionId });
    (engine as any).activeSessions.set(sessionId, sessionState);
    const handler = await setupEngineAndGetHandler(engine, sessionState, 'node.completed');

    const fakeEvent = {
      type: 'node.completed',
      run_id: sessionId,
      node_id: 'a',
      output: {},
      duration_ms: 10,
      timestamp: Date.now(),
    } as unknown as WorkflowEvent;

    // Should not throw
    await handler(fakeEvent);
    // agentSessions should be created as empty array (no entries to update)
    const updateCall = mockSessionComponent.update.mock.calls.find(
      ([_id, payload]: any[]) => payload?.metadata?.agentSessions !== undefined
    );
    expect(updateCall![1].metadata.agentSessions).toEqual([]);
  });
});

// =========================================================================
// BUG-D: WorkflowEngine node.failed handler — single-node status
// =========================================================================

describe('WorkflowEngine node.failed handler — single-node status (BUG-D)', () => {
  let mockSessionComponent: any;
  let engine: WorkflowEngine;

  beforeEach(() => {
    mockSessionComponent = {
      update: vi.fn().mockResolvedValue(true),
      get: vi.fn(),
      getMessages: vi.fn().mockResolvedValue([]),
    };
    engine = new WorkflowEngine(new NodeRegistry(), mockSessionComponent as any);
  });

  it('marks the failed node as failed before bulk markAllAgentSessionsFailed runs', async () => {
    const sessionId = 'wf_node_failed_test';
    const agentSessions = [
      { nodeId: 'init-task', sessionId: 'sub1', status: 'active' as const },
      { nodeId: 'plan',      sessionId: 'sub2', status: 'active' as const },
      { nodeId: 'tdd',       sessionId: 'sub3', status: 'paused' as const },
    ];
    mockSessionComponent.get.mockResolvedValue({
      id: sessionId,
      metadata: { status: 'running', agentSessions },
    });

    const sessionState = buildActiveSession({ sessionId });
    (engine as any).activeSessions.set(sessionId, sessionState);
    const handler = await setupEngineAndGetHandler(engine, sessionState, 'node.failed');

    const fakeEvent = {
      type: 'node.failed',
      run_id: sessionId,
      node_id: 'tdd',
      error: { message: 'tdd failed' },
      timestamp: Date.now(),
    } as unknown as WorkflowEvent;

    await handler(fakeEvent);

    // Look for the per-node mark first (single-node, non-bulk):
    // the failing node 'tdd' should be marked 'failed' specifically.
    // The first update call after a node.failed event should reflect the
    // per-node mark. Then failWorkflow runs and calls update again with bulk mark.
    const updateCalls = mockSessionComponent.update.mock.calls;
    expect(updateCalls.length).toBeGreaterThanOrEqual(2);

    // First update: per-node mark for 'tdd' (other nodes remain in their original state)
    const firstAgentCall = updateCalls.find(
      ([_id, payload]: any[]) => Array.isArray(payload?.metadata?.agentSessions)
    );
    expect(firstAgentCall).toBeDefined();
    const firstAgentSessions = firstAgentCall![1].metadata.agentSessions;
    const tdd = firstAgentSessions.find((r: any) => r.nodeId === 'tdd');
    expect(tdd?.status).toBe('failed');

    // Last update: bulk markAllAgentSessionsFailed via failWorkflow
    const finalUpdate = updateCalls[updateCalls.length - 1];
    expect(finalUpdate[1].metadata.status).toBe('failed');
    const finalAgentSessions = finalUpdate[1].metadata.agentSessions;
    expect(finalAgentSessions.find((r: any) => r.nodeId === 'init-task')!.status).toBe('failed');
    expect(finalAgentSessions.find((r: any) => r.nodeId === 'plan')!.status).toBe('failed');
    expect(finalAgentSessions.find((r: any) => r.nodeId === 'tdd')!.status).toBe('failed');
  });

  it('preserves completed nodes when a different node fails', async () => {
    const sessionId = 'wf_node_failed_preserve_completed';
    const agentSessions = [
      { nodeId: 'init-task', sessionId: 'sub1', status: 'completed' as const },
      { nodeId: 'plan',      sessionId: 'sub2', status: 'active' as const },
    ];
    mockSessionComponent.get.mockResolvedValue({
      id: sessionId,
      metadata: { status: 'running', agentSessions },
    });

    const sessionState = buildActiveSession({ sessionId });
    (engine as any).activeSessions.set(sessionId, sessionState);
    const handler = await setupEngineAndGetHandler(engine, sessionState, 'node.failed');

    const fakeEvent = {
      type: 'node.failed',
      run_id: sessionId,
      node_id: 'plan',
      error: { message: 'plan failed' },
      timestamp: Date.now(),
    } as unknown as WorkflowEvent;

    await handler(fakeEvent);

    const updateCalls = mockSessionComponent.update.mock.calls;
    const finalUpdate = updateCalls[updateCalls.length - 1];
    const finalAgentSessions = finalUpdate[1].metadata.agentSessions;
    // completed stays completed, plan becomes failed
    expect(finalAgentSessions.find((r: any) => r.nodeId === 'init-task')!.status).toBe('completed');
    expect(finalAgentSessions.find((r: any) => r.nodeId === 'plan')!.status).toBe('failed');
  });

  it('handles missing agentSessions gracefully (does not throw)', async () => {
    const sessionId = 'wf_node_failed_no_agent';
    mockSessionComponent.get.mockResolvedValue({
      id: sessionId,
      metadata: { status: 'running' },
    });

    const sessionState = buildActiveSession({ sessionId });
    (engine as any).activeSessions.set(sessionId, sessionState);
    const handler = await setupEngineAndGetHandler(engine, sessionState, 'node.failed');

    const fakeEvent = {
      type: 'node.failed',
      run_id: sessionId,
      node_id: 'a',
      error: { message: 'fail' },
      timestamp: Date.now(),
    } as unknown as WorkflowEvent;

    // Should not throw
    await handler(fakeEvent);

    const updateCalls = mockSessionComponent.update.mock.calls;
    const finalUpdate = updateCalls[updateCalls.length - 1];
    expect(finalUpdate[1].metadata.status).toBe('failed');
    expect(finalUpdate[1].metadata.agentSessions).toEqual([]);
  });
});