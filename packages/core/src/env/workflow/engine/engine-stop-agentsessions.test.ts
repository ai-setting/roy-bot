/**
 * TDD: WorkflowEngine.stop() — must propagate status to agentSessions (Task #2178 BUG-A)
 */

import { describe, it, expect, beforeEach, vi } from 'bun:test';
import { WorkflowEngine } from './engine';
import { NodeRegistry } from './node-registry';

const buildActiveSession = (overrides: Record<string, any> = {}) => ({
  sessionId: 'wf_stop_agentsessions_test',
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
  runId: 'wf_stop_agentsessions_test',
  ...overrides,
});

describe('WorkflowEngine.stop() — agentSessions propagation (BUG-A)', () => {
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

  it('marks all active/paused agent sessions as stopped when stop() is called', async () => {
    const sessionId = 'wf_stop_agentsessions_test';
    const agentSessions = [
      { nodeId: 'init-task', sessionId: 'sub1', status: 'completed' as const },
      { nodeId: 'plan',      sessionId: 'sub2', status: 'active' as const },
      { nodeId: 'tdd',       sessionId: 'sub3', status: 'paused' as const },
    ];
    mockSessionComponent.get.mockResolvedValue({
      id: sessionId,
      metadata: { status: 'running', agentSessions },
    });

    const sessionState = buildActiveSession();
    (engine as any).activeSessions.set(sessionId, sessionState);

    await engine.stop(sessionId, 'user-stopped');

    const updateCall = mockSessionComponent.update.mock.calls.find(
      ([_id, payload]: any[]) => payload?.metadata?.status === 'stopped'
    );
    expect(updateCall).toBeDefined();
    const updated = updateCall![1].metadata.agentSessions;
    expect(updated.find((r: any) => r.nodeId === 'init-task')!.status).toBe('completed');
    expect(updated.find((r: any) => r.nodeId === 'plan')!.status).toBe('stopped');
    expect(updated.find((r: any) => r.nodeId === 'tdd')!.status).toBe('stopped');
  });

  it('preserves already-stopped nodes (idempotent)', async () => {
    const sessionId = 'wf_stop_idempotent';
    const agentSessions = [
      { nodeId: 'a', sessionId: 's1', status: 'stopped' as const },
      { nodeId: 'b', sessionId: 's2', status: 'active' as const },
    ];
    mockSessionComponent.get.mockResolvedValue({
      id: sessionId,
      metadata: { status: 'running', agentSessions },
    });

    const sessionState = buildActiveSession({ sessionId });
    (engine as any).activeSessions.set(sessionId, sessionState);

    await engine.stop(sessionId);

    const updateCall = mockSessionComponent.update.mock.calls.find(
      ([_id, payload]: any[]) => payload?.metadata?.status === 'stopped'
    );
    const updated = updateCall![1].metadata.agentSessions;
    expect(updated.find((r: any) => r.nodeId === 'a')!.status).toBe('stopped');
    expect(updated.find((r: any) => r.nodeId === 'b')!.status).toBe('stopped');
  });

  it('handles undefined agentSessions gracefully', async () => {
    const sessionId = 'wf_stop_no_agent';
    mockSessionComponent.get.mockResolvedValue({
      id: sessionId,
      metadata: { status: 'running' }, // no agentSessions
    });

    const sessionState = buildActiveSession({ sessionId });
    (engine as any).activeSessions.set(sessionId, sessionState);

    await engine.stop(sessionId);

    const updateCall = mockSessionComponent.update.mock.calls.find(
      ([_id, payload]: any[]) => payload?.metadata?.status === 'stopped'
    );
    expect(updateCall).toBeDefined();
    // agentSessions is empty array when input was undefined
    expect(updateCall![1].metadata.agentSessions).toEqual([]);
  });

  it('offline stop (no active session) still marks agentSessions via update fallback', async () => {
    const sessionId = 'wf_stop_offline';
    const agentSessions = [
      { nodeId: 'a', sessionId: 's1', status: 'active' as const },
      { nodeId: 'b', sessionId: 's2', status: 'paused' as const },
    ];
    mockSessionComponent.get.mockResolvedValue({
      id: sessionId,
      metadata: { status: 'running', agentSessions },
    });
    // No activeSessions entry — engine falls through to DB update path

    await engine.stop(sessionId);

    const updateCall = mockSessionComponent.update.mock.calls[0];
    expect(updateCall).toBeDefined();
    expect(updateCall[1].metadata.status).toBe('stopped');
    const updated = updateCall[1].metadata.agentSessions;
    expect(updated.find((r: any) => r.nodeId === 'a')!.status).toBe('stopped');
    expect(updated.find((r: any) => r.nodeId === 'b')!.status).toBe('stopped');
  });

  // User-reported scenario from Task #2178:
  // workflow_1784508256666_fallback_hry0kq observed
  //   agentSessions[0] = init-task (active, after node.completed)
  //   agentSessions[1] = plan      (paused, ask_user pause)
  //   → after stop(), expected: init-task=completed, plan=stopped
  it('reproduces user-reported scenario: init-task=completed + plan=paused → after stop() = completed + stopped', async () => {
    const sessionId = 'wf_user_repro_stop';
    const agentSessions = [
      { nodeId: 'init-task', sessionId: 'sub_init', status: 'completed' as const },
      { nodeId: 'plan',      sessionId: 'sub_plan', status: 'paused' as const },
    ];
    mockSessionComponent.get.mockResolvedValue({
      id: sessionId,
      metadata: { status: 'running', agentSessions },
    });

    const sessionState = buildActiveSession({ sessionId });
    (engine as any).activeSessions.set(sessionId, sessionState);

    await engine.stop(sessionId);

    const updateCall = mockSessionComponent.update.mock.calls.find(
      ([_id, payload]: any[]) => payload?.metadata?.status === 'stopped'
    );
    expect(updateCall).toBeDefined();
    const updated = updateCall![1].metadata.agentSessions;
    expect(updated.find((r: any) => r.nodeId === 'init-task')!.status).toBe('completed');
    expect(updated.find((r: any) => r.nodeId === 'plan')!.status).toBe('stopped');
  });
});
