/**
 * TDD: agent-session-metadata helpers (Task #2178)
 * 覆盖 markAgentSession{Completed,Failed,Stopped} + markAllAgentSessions{Stopped,Failed}
 */

import { describe, it, expect } from 'bun:test';
import {
  updateAgentSessionStatus,
  markAllAgentSessionsCompleted,
  markAgentSessionCompleted,
  markAgentSessionFailed,
  markAgentSessionStopped,
  markAllAgentSessionsStopped,
  markAllAgentSessionsFailed,
} from './agent-session-metadata';
import type { AgentSessionRef } from '../types/workflow-message';

const fixture = (): AgentSessionRef[] => [
  { nodeId: 'init-task', sessionId: 's1', status: 'active' },
  { nodeId: 'plan',      sessionId: 's2', status: 'paused' },
  { nodeId: 'tdd',       sessionId: 's3', status: 'active' },
  { nodeId: 'review',    sessionId: 's4', status: 'completed' },
];

describe('markAgentSessionCompleted', () => {
  it('marks target node as completed', () => {
    const out = markAgentSessionCompleted(fixture(), 'tdd');
    expect(out.find(r => r.nodeId === 'tdd')!.status).toBe('completed');
  });

  it('does not mutate input array', () => {
    const input = fixture();
    const snapshot = JSON.parse(JSON.stringify(input));
    markAgentSessionCompleted(input, 'tdd');
    expect(input).toEqual(snapshot);
  });

  it('leaves non-target nodes untouched', () => {
    const out = markAgentSessionCompleted(fixture(), 'tdd');
    expect(out.find(r => r.nodeId === 'init-task')!.status).toBe('active');
    expect(out.find(r => r.nodeId === 'plan')!.status).toBe('paused');
    expect(out.find(r => r.nodeId === 'review')!.status).toBe('completed');
  });

  it('returns empty array when input undefined', () => {
    expect(markAgentSessionCompleted(undefined, 'tdd')).toEqual([]);
  });

  it('returns input when no match', () => {
    const input = fixture();
    const out = markAgentSessionCompleted(input, 'nonexistent');
    expect(out.find(r => r.nodeId === 'init-task')!.status).toBe('active');
  });
});

describe('markAgentSessionFailed', () => {
  it('marks target node as failed', () => {
    const out = markAgentSessionFailed(fixture(), 'tdd');
    expect(out.find(r => r.nodeId === 'tdd')!.status).toBe('failed');
  });

  it('does not affect other nodes', () => {
    const out = markAgentSessionFailed(fixture(), 'tdd');
    expect(out.find(r => r.nodeId === 'init-task')!.status).toBe('active');
  });

  it('returns empty array when input undefined', () => {
    expect(markAgentSessionFailed(undefined, 'tdd')).toEqual([]);
  });
});

describe('markAgentSessionStopped', () => {
  it('marks target node as stopped', () => {
    const out = markAgentSessionStopped(fixture(), 'tdd');
    expect(out.find(r => r.nodeId === 'tdd')!.status).toBe('stopped');
  });

  it('does not affect other nodes', () => {
    const out = markAgentSessionStopped(fixture(), 'tdd');
    expect(out.find(r => r.nodeId === 'init-task')!.status).toBe('active');
  });

  it('returns empty array when input undefined', () => {
    expect(markAgentSessionStopped(undefined, 'tdd')).toEqual([]);
  });
});

describe('markAllAgentSessionsStopped', () => {
  it('marks all active and paused nodes as stopped', () => {
    const out = markAllAgentSessionsStopped(fixture());
    expect(out.find(r => r.nodeId === 'init-task')!.status).toBe('stopped');
    expect(out.find(r => r.nodeId === 'plan')!.status).toBe('stopped');
    expect(out.find(r => r.nodeId === 'tdd')!.status).toBe('stopped');
  });

  it('preserves already-terminal nodes (completed)', () => {
    const out = markAllAgentSessionsStopped(fixture());
    expect(out.find(r => r.nodeId === 'review')!.status).toBe('completed');
  });

  it('preserves already-failed nodes', () => {
    const input: AgentSessionRef[] = [
      { nodeId: 'a', sessionId: 's1', status: 'failed' },
      { nodeId: 'b', sessionId: 's2', status: 'active' },
    ];
    const out = markAllAgentSessionsStopped(input);
    expect(out.find(r => r.nodeId === 'a')!.status).toBe('failed');
    expect(out.find(r => r.nodeId === 'b')!.status).toBe('stopped');
  });

  it('preserves already-stopped nodes (idempotent)', () => {
    const input: AgentSessionRef[] = [
      { nodeId: 'a', sessionId: 's1', status: 'stopped' },
    ];
    const out = markAllAgentSessionsStopped(input);
    expect(out[0].status).toBe('stopped');
  });

  it('returns empty array when input undefined', () => {
    expect(markAllAgentSessionsStopped(undefined)).toEqual([]);
  });

  it('does not mutate input', () => {
    const input = fixture();
    const snapshot = JSON.parse(JSON.stringify(input));
    markAllAgentSessionsStopped(input);
    expect(input).toEqual(snapshot);
  });
});

describe('markAllAgentSessionsFailed', () => {
  it('marks all active and paused nodes as failed', () => {
    const out = markAllAgentSessionsFailed(fixture());
    expect(out.find(r => r.nodeId === 'init-task')!.status).toBe('failed');
    expect(out.find(r => r.nodeId === 'plan')!.status).toBe('failed');
    expect(out.find(r => r.nodeId === 'tdd')!.status).toBe('failed');
  });

  it('preserves already-terminal nodes (completed)', () => {
    const out = markAllAgentSessionsFailed(fixture());
    expect(out.find(r => r.nodeId === 'review')!.status).toBe('completed');
  });

  it('preserves already-stopped nodes (stop wins over fail)', () => {
    const input: AgentSessionRef[] = [
      { nodeId: 'a', sessionId: 's1', status: 'stopped' },
      { nodeId: 'b', sessionId: 's2', status: 'active' },
    ];
    const out = markAllAgentSessionsFailed(input);
    expect(out.find(r => r.nodeId === 'a')!.status).toBe('stopped');
    expect(out.find(r => r.nodeId === 'b')!.status).toBe('failed');
  });

  it('preserves already-failed nodes (idempotent)', () => {
    const input: AgentSessionRef[] = [
      { nodeId: 'a', sessionId: 's1', status: 'failed' },
    ];
    const out = markAllAgentSessionsFailed(input);
    expect(out[0].status).toBe('failed');
  });

  it('returns empty array when input undefined', () => {
    expect(markAllAgentSessionsFailed(undefined)).toEqual([]);
  });

  it('does not mutate input', () => {
    const input = fixture();
    const snapshot = JSON.parse(JSON.stringify(input));
    markAllAgentSessionsFailed(input);
    expect(input).toEqual(snapshot);
  });
});

describe('regression: existing helpers still work', () => {
  it('updateAgentSessionStatus still marks target', () => {
    const out = updateAgentSessionStatus(fixture(), 'plan', 'paused');
    expect(out.find(r => r.nodeId === 'plan')!.status).toBe('paused');
  });

  it('markAllAgentSessionsCompleted still works', () => {
    const out = markAllAgentSessionsCompleted(fixture());
    expect(out.find(r => r.nodeId === 'init-task')!.status).toBe('completed');
    expect(out.find(r => r.nodeId === 'plan')!.status).toBe('completed');
    expect(out.find(r => r.nodeId === 'tdd')!.status).toBe('completed');
    expect(out.find(r => r.nodeId === 'review')!.status).toBe('completed');
  });
});
