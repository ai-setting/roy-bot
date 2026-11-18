import type { AgentSessionRef } from '../types/workflow-message';

/**
 * Update a single agent session's status by nodeId.
 * Returns a new array; does not mutate input. Returns empty array if input is undefined/empty.
 */
export function updateAgentSessionStatus(
  agentSessions: AgentSessionRef[] | undefined,
  nodeId: string,
  status: AgentSessionRef['status']
): AgentSessionRef[] {
  if (!agentSessions?.length) {
    return agentSessions ?? [];
  }
  return agentSessions.map((ref) =>
    ref.nodeId === nodeId ? { ...ref, status } : ref
  );
}

/**
 * Mark a single node's agent session as 'completed'.
 * Convenience wrapper over updateAgentSessionStatus for symmetry with Failed/Stopped.
 */
export function markAgentSessionCompleted(
  agentSessions: AgentSessionRef[] | undefined,
  nodeId: string
): AgentSessionRef[] {
  return updateAgentSessionStatus(agentSessions, nodeId, 'completed');
}

/**
 * Register (or refresh) a node's agent sub-session reference.
 *
 * Replaces an existing entry for the same `nodeId` (refresh + reset to
 * 'active') or appends a new one. Returns a new array; does not mutate input.
 *
 * Task #4412 C1: this used to be inline in `AgentNode.createAgentSubSession()`
 * operating directly on the metadata it had just read, which loses entries when
 * sibling agent nodes register concurrently. Extracted here so the engine can
 * run it *inside* its serialized metadata queue (where the array it receives is
 * guaranteed to be the current one).
 */
export function upsertAgentSession(
  agentSessions: AgentSessionRef[] | undefined,
  nodeId: string,
  agentSessionId: string
): AgentSessionRef[] {
  const next: AgentSessionRef = {
    nodeId,
    sessionId: agentSessionId,
    status: 'active',
    createdAt: Date.now(),
  };
  const list = agentSessions ?? [];
  const existingIndex = list.findIndex((ref) => ref.nodeId === nodeId);
  if (existingIndex >= 0) {
    return list.map((ref, index) =>
      index === existingIndex ? { ...next } : ref
    );
  }
  return [...list, next];
}

/**
 * Mark a single node's agent session as 'failed'.
 */
export function markAgentSessionFailed(
  agentSessions: AgentSessionRef[] | undefined,
  nodeId: string
): AgentSessionRef[] {
  return updateAgentSessionStatus(agentSessions, nodeId, 'failed');
}

/**
 * Mark a single node's agent session as 'stopped'.
 */
export function markAgentSessionStopped(
  agentSessions: AgentSessionRef[] | undefined,
  nodeId: string
): AgentSessionRef[] {
  return updateAgentSessionStatus(agentSessions, nodeId, 'stopped');
}

/**
 * Mark ALL non-terminal (active/paused) agent sessions as 'completed'.
 * Already-terminal sessions (completed/failed/stopped) are preserved.
 * Used by WorkflowEngine.completeWorkflow().
 */
export function markAllAgentSessionsCompleted(
  agentSessions: AgentSessionRef[] | undefined
): AgentSessionRef[] {
  return mapNonTerminal(agentSessions, 'completed');
}

/**
 * Mark ALL non-terminal (active/paused) agent sessions as 'stopped'.
 * Used by WorkflowEngine.stop() — distinguishes a graceful stop from a failure.
 */
export function markAllAgentSessionsStopped(
  agentSessions: AgentSessionRef[] | undefined
): AgentSessionRef[] {
  return mapNonTerminal(agentSessions, 'stopped');
}

/**
 * Mark ALL non-terminal (active/paused) agent sessions as 'failed'.
 * Used by WorkflowEngine.failWorkflow().
 */
export function markAllAgentSessionsFailed(
  agentSessions: AgentSessionRef[] | undefined
): AgentSessionRef[] {
  return mapNonTerminal(agentSessions, 'failed');
}

/**
 * Internal: map only active/paused entries to a new terminal status.
 * Preserves already-terminal entries (completed/failed/stopped) unchanged.
 */
function mapNonTerminal(
  agentSessions: AgentSessionRef[] | undefined,
  terminalStatus: 'completed' | 'failed' | 'stopped'
): AgentSessionRef[] {
  if (!agentSessions?.length) {
    return agentSessions ?? [];
  }
  return agentSessions.map((ref) =>
    ref.status === 'active' || ref.status === 'paused'
      ? { ...ref, status: terminalStatus }
      : ref
  );
}
