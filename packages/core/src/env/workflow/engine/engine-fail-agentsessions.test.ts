/**
 * TDD: WorkflowEngine.failWorkflow() — must propagate status to agentSessions (Task #2178 BUG-B)
 */

import { describe, it, expect, beforeEach, vi } from 'bun:test';
import { WorkflowEngine } from './engine';
import { NodeRegistry } from './node-registry';

const buildActiveSession = (overrides: Record<string, any> = {}) => ({
  sessionId: 'wf_fail_agentsessions_test',
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
  runId: 'wf_fail_agentsessions_test',
  ...overrides,
});

describe('WorkflowEngine.failWorkflow() — agentSessions propagation (BUG-B)', () => {
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

  it('marks all active/paused agent sessions as failed when failWorkflow() is called', async () => {
    const sessionId = 'wf_fail_agentsessions_test';
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

    await (engine as any).failWorkflow(sessionState, new Error('something exploded'));

    const updateCall = mockSessionComponent.update.mock.calls.find(
      ([_id, payload]: any[]) => payload?.metadata?.status === 'failed'
    );
    expect(updateCall).toBeDefined();
    const updated = updateCall![1].metadata.agentSessions;
    expect(updated.find((r: any) => r.nodeId === 'init-task')!.status).toBe('completed');
    expect(updated.find((r: any) => r.nodeId === 'plan')!.status).toBe('failed');
    expect(updated.find((r: any) => r.nodeId === 'tdd')!.status).toBe('failed');
  });

  it('preserves already-stopped nodes (stop wins over fail)', async () => {
    const sessionId = 'wf_fail_preserve_stopped';
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

    await (engine as any).failWorkflow(sessionState, new Error('fail'));

    const updateCall = mockSessionComponent.update.mock.calls.find(
      ([_id, payload]: any[]) => payload?.metadata?.status === 'failed'
    );
    const updated = updateCall![1].metadata.agentSessions;
    expect(updated.find((r: any) => r.nodeId === 'a')!.status).toBe('stopped');
    expect(updated.find((r: any) => r.nodeId === 'b')!.status).toBe('failed');
  });

  it('preserves already-failed nodes (idempotent)', async () => {
    const sessionId = 'wf_fail_idempotent';
    const agentSessions = [
      { nodeId: 'a', sessionId: 's1', status: 'failed' as const },
      { nodeId: 'b', sessionId: 's2', status: 'active' as const },
    ];
    mockSessionComponent.get.mockResolvedValue({
      id: sessionId,
      metadata: { status: 'running', agentSessions },
    });

    const sessionState = buildActiveSession({ sessionId });
    (engine as any).activeSessions.set(sessionId, sessionState);

    await (engine as any).failWorkflow(sessionState, new Error('fail'));

    const updateCall = mockSessionComponent.update.mock.calls.find(
      ([_id, payload]: any[]) => payload?.metadata?.status === 'failed'
    );
    const updated = updateCall![1].metadata.agentSessions;
    expect(updated.find((r: any) => r.nodeId === 'a')!.status).toBe('failed');
    expect(updated.find((r: any) => r.nodeId === 'b')!.status).toBe('failed');
  });

  it('handles undefined agentSessions gracefully', async () => {
    const sessionId = 'wf_fail_no_agent';
    mockSessionComponent.get.mockResolvedValue({
      id: sessionId,
      metadata: { status: 'running' },
    });

    const sessionState = buildActiveSession({ sessionId });
    (engine as any).activeSessions.set(sessionId, sessionState);

    await (engine as any).failWorkflow(sessionState, new Error('fail'));

    const updateCall = mockSessionComponent.update.mock.calls.find(
      ([_id, payload]: any[]) => payload?.metadata?.status === 'failed'
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1].metadata.agentSessions).toEqual([]);
  });
});