/**
 * Session Recovery Utilities
 * 
 * Utilities for inferring the next execution point from session messages.
 * This is the core of the unified run/resume mechanism.
 * 
 * Message types:
 * - workflow.node.start: Node execution started (对应 tool-call)
 * - workflow.node.interrupt: Node waiting for user input
 * - workflow.node.end: Node execution completed (对应 tool-result)
 * - workflow.node.resume: Node resumed after user response
 */

import type { SessionMessage } from '../../session/types';
import type { AgentSessionRef } from '../types/workflow-message';
import { getWorkflowNodeIdFromMetadata } from './workflow-message-metadata';

/**
 * Represents a resume point - where to continue execution from
 */
export interface ResumePoint {
  /** Type of resume point */
  type: 'entry_node' | 'resume_node' | 'ask_user' | 'next_nodes';
  /** Node ID (for single node resume) */
  nodeId?: string;
  /** Node IDs (for multiple next nodes) */
  nodeIds?: string[];
  /** Agent sub-session ID (for agent node resume) */
  agentSessionId?: string;
  /** Input for the node */
  input?: unknown;
}

/**
 * Infer the next node to execute based on session messages
 * 
 * Decision logic:
 * - No messages → execute entry node
 * - Last = workflow.node.start → resume this node (incomplete/interrupted)
 * - Last = workflow.node.interrupt → resume this node (ask_user)
 * - Last = workflow.node.end → execute next nodes from DAG
 * - Unknown → find last start, resume it, or fallback to entry
 */
export function inferNextNode(
  messages: SessionMessage[],
  definition: {
    entryNode?: string;
    edges?: Array<{ from: string; to: string }>;
  }
): ResumePoint {
  if (messages.length === 0) {
    // First run - execute entry node
    return { type: 'entry_node', nodeId: definition.entryNode };
  }
  
  const lastMessage = messages[messages.length - 1];
  const metadata = lastMessage.metadata as Record<string, unknown>;
  
  switch (metadata?.type) {
    case 'workflow.node.start':
      // Node was interrupted (not completed)
      return {
        type: 'resume_node',
        nodeId: getWorkflowNodeIdFromMetadata(metadata),
        agentSessionId: metadata.agentSessionId as string | undefined,
      };
    
    case 'workflow.node.interrupt':
      // Ask_user or ESC interrupted
      return {
        type: 'ask_user',
        nodeId: getWorkflowNodeIdFromMetadata(metadata),
        agentSessionId: metadata.agentSessionId as string | undefined,
      };
    
    case 'workflow.node.end':
    case 'workflow.node.result':
      // Task #1977: workflow.node.end is written for BOTH successful and
      // failed nodes. The executor tags metadata.success = !error, so
      // a failed node has metadata.success === false.
      //
      // For successful nodes: advance to next nodes (existing behavior).
      // For failed nodes (timeout / error / aborted): the node is the
      // resume point — the caller (typically the workflow-runner
      // subagent via `workflow run -s <runId>`) wants to retry THIS
      // node. Returning 'next_nodes' here would lose the retry point
      // and cause the resumed run to hang (no nodes scheduled, no
      // completionPromise resolved).
      if (metadata?.success === false) {
        const failedNodeId = getWorkflowNodeIdFromMetadata(metadata);
        if (failedNodeId) {
          return {
            type: 'resume_node',
            nodeId: failedNodeId,
            agentSessionId: metadata.agentSessionId as string | undefined,
          };
        }
      }
      // Node completed successfully, get next from DAG
      return getNextNodes(getWorkflowNodeIdFromMetadata(metadata) as string, definition);
    
    default:
      // Unknown message type, try to find last start or call
      const lastStart = findLastStartMessage(messages);
      if (lastStart) {
        const startMetadata = lastStart.metadata as Record<string, unknown>;
        return {
          type: 'resume_node',
          nodeId: getWorkflowNodeIdFromMetadata(startMetadata),
          agentSessionId: startMetadata.agentSessionId as string | undefined,
        };
      }
      // Also try to find last call message
      const lastCall = findLastCallMessage(messages);
      if (lastCall) {
        const callMetadata = lastCall.metadata as Record<string, unknown>;
        return {
          type: 'resume_node',
          nodeId: getWorkflowNodeIdFromMetadata(callMetadata),
          agentSessionId: callMetadata.agentSessionId as string | undefined,
        };
      }
      // No start or call found, fallback to entry
      return { type: 'entry_node', nodeId: definition.entryNode };
  }
}

/**
 * Get next nodes from DAG edges
 */
function getNextNodes(
  completedNodeId: string,
  definition: { edges?: Array<{ from: string; to: string }> }
): ResumePoint {
  if (!definition.edges) {
    return { type: 'next_nodes', nodeIds: [] };
  }
  
  const nextNodeIds = definition.edges
    .filter(edge => edge.from === completedNodeId)
    .map(edge => edge.to);
  
  return { type: 'next_nodes', nodeIds: nextNodeIds };
}

/**
 * Find the last interrupt message in the session
 */
export function findLastInterruptMessage(
  messages: SessionMessage[]
): SessionMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if ((msg.metadata as Record<string, unknown>)?.type === 'workflow.node.interrupt') {
      return msg;
    }
  }
  return null;
}

/**
 * Find the last start message in the session
 */
export function findLastStartMessage(
  messages: SessionMessage[]
): SessionMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if ((msg.metadata as Record<string, unknown>)?.type === 'workflow.node.start') {
      return msg;
    }
  }
  return null;
}

/**
 * Find the last call message (workflow.node.call) in the session
 */
export function findLastCallMessage(
  messages: SessionMessage[]
): SessionMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if ((msg.metadata as Record<string, unknown>)?.type === 'workflow.node.call') {
      return msg;
    }
  }
  return null;
}

/**
 * Parse node outputs from session messages
 *
 * Extracts outputs by matching:
 * - workflow.node.start with workflow.node.end pairs
 * - workflow.node.call with workflow.node.result pairs
 *
 * ★ Task #4604 (D3) — pair by the TERMINAL message's own node id.
 *
 * The previous implementation tracked a single `lastStartNodeId` scalar, which
 * broke whenever nodes ran concurrently (the norm: the workflow fans out build
 * nodes in parallel). With 4 interleaved starts followed by ends in completion
 * order, the scalar only ever remembered the LAST start, so:
 *
 *   start A, start B, start C, start D
 *   end C   -> mis-attributed to D
 *   end A   -> dropped (scalar already consumed)
 *   end D   -> dropped
 *
 * => nodeOutputs lost finished nodes. `--session` resume then treated those
 *    nodes as never-executed and rebuilt them (Task #4599 §5.4: 3 finished
 *    docker builds re-run, 40+ minutes wasted, produced wheels overwritten).
 *
 * The terminal message always carries its own node id (`nodeId` /
 * `workflowNodeId`), so pairing by it is both simpler and correct for:
 *   - concurrent fan-out (id from the end message),
 *   - a start with no end (node stays pending → no output),
 *   - an end with no observed start (node is done → output recorded),
 *   - retries (the last end wins, via Map.set overwrite).
 *
 * Legacy `workflow.node.call` / `workflow.node.result` pairs follow the same
 * rule, which is also what fixes cross-pairing when several calls are in
 * flight at once.
 */
export function parseNodeOutputs(
  messages: SessionMessage[]
): Map<string, unknown> {
  const outputs = new Map<string, unknown>();
  // Nodes whose execution we have observed starting (start or call).
  // Used ONLY to preserve the legacy contract for `workflow.node.result`:
  // a result with no preceding call is treated as stale and ignored
  // (see session-recovery-simplified.test.ts "should ignore orphaned results").
  const startedNodes = new Set<string>();

  for (const msg of messages) {
    const metadata = msg.metadata as Record<string, unknown>;
    const msgType = metadata?.type as string;

    if (msgType === 'workflow.node.start' || msgType === 'workflow.node.call') {
      const startedId = getWorkflowNodeIdFromMetadata(metadata);
      if (startedId) {
        startedNodes.add(startedId);
      }
      continue;
    }

    if (msgType !== 'workflow.node.end' && msgType !== 'workflow.node.result') {
      continue;
    }

    const nodeId = getWorkflowNodeIdFromMetadata(metadata);
    if (!nodeId) {
      // No node id -> cannot attribute this output. Ignore rather than
      // guessing (guessing was the root of the original bug).
      continue;
    }

    // Asymmetry is deliberate:
    //  - `workflow.node.end` is written by the executor for EVERY terminal
    //    node state (success or failure) and is the authoritative "this node
    //    is done" signal — the same signal `inferNextNode` uses to pick a
    //    resume point. If the matching start is missing (compacted or
    //    truncated session), the node is still done, and dropping it would
    //    resurrect the D3 over-execution bug.
    //  - `workflow.node.result` is the legacy tool-result shape and keeps its
    //    historical "must follow a call" contract, so stale results from an
    //    unrelated context are still ignored.
    if (msgType === 'workflow.node.result' && !startedNodes.has(nodeId)) {
      continue;
    }

    outputs.set(nodeId, extractNodeOutputValue(msg));
  }

  return outputs;
}

/**
 * Extract the real node output from a terminal message.
 *
 * ★ Task #4604 (F1) — prefer the structured part over the display summary.
 *
 * `Executor.writeNodeEnd()` stores two representations on the same message:
 *   - `content`  : `summarizeResult(...)`, a human summary
 *                  (`"✅ build-ta-cp312: wheel_path, tag, build_id (812345ms)"`
 *                   for objects; a 100-char-plus-`...` truncation for strings)
 *   - `parts[0]` : a `workflow-node-end` part carrying the *real* `output`.
 *
 * Reading `content` therefore loses data: object outputs degrade to a bare key
 * list and long strings get truncated, so a resumed run's downstream
 * `{{nodes.X.output.field}}` templates resolve to `undefined`. That defect is
 * pre-existing (identical on main), but the D3-a pairing fix makes *more* nodes
 * take this restore path, which is why it is addressed here.
 *
 * `parts` is persisted by the SQLite session store and returned by
 * `getMessages()`, so the structured form is available on resume.
 *
 * Fallbacks keep old sessions working:
 *   1. `parts` with a defined `output`  → the real value (even when `null`/`''`)
 *   2. legacy: `JSON.parse(content)`
 *   3. legacy: raw `content`
 */
function extractNodeOutputValue(msg: SessionMessage): unknown {
  const parts = msg.parts as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(parts)) {
    const part = parts.find(
      (p) => p && p['type'] === 'workflow-node-end' && 'output' in p
    );
    // `'output' in p` (not a truthiness check) so an explicit `undefined`/`null`
    // result still falls through to the legacy content path.
    if (part && part['output'] !== undefined) {
      return part['output'];
    }
  }

  try {
    return JSON.parse(msg.content as string);
  } catch {
    return msg.content;
  }
}

/**
 * Check if session has pending ask_user interrupt
 */
export function hasPendingAskUser(messages: SessionMessage[]): boolean {
  if (messages.length === 0) return false;
  
  const lastMessage = messages[messages.length - 1];
  const metadata = lastMessage.metadata as Record<string, unknown>;
  
  return metadata?.type === 'workflow.node.interrupt';
}

/**
 * Get agent session ID from last interrupt message
 */
export function getAgentSessionIdFromInterrupt(
  messages: SessionMessage[]
): string | null {
  const lastInterrupt = findLastInterruptMessage(messages);
  if (!lastInterrupt) return null;
  
  const metadata = lastInterrupt.metadata as Record<string, unknown>;
  return (metadata?.agentSessionId as string) || null;
}

// ============================================================================
// Agent session resolution (metadata fallback)
// ============================================================================

/**
 * Resolve agent sub-session ID for a pending node.
 * Prefers explicit agentSessionId from messages; falls back to workflow metadata.agentSessions.
 */
export function resolveAgentSessionId(
  nodeId: string | undefined,
  agentSessionId: string | undefined,
  agentSessions?: AgentSessionRef[]
): string | undefined {
  if (agentSessionId) {
    return agentSessionId;
  }
  if (!nodeId || !agentSessions?.length) {
    return undefined;
  }
  return agentSessions.find((ref) => ref.nodeId === nodeId)?.sessionId;
}

export function enrichResumeInfoWithAgentSessions(
  resumeInfo: ResumeInfo,
  agentSessions?: AgentSessionRef[]
): ResumeInfo {
  return {
    ...resumeInfo,
    agentSessionId: resolveAgentSessionId(
      resumeInfo.pendingNodeId,
      resumeInfo.agentSessionId,
      agentSessions
    ),
  };
}

export function enrichResumePointWithAgentSessions(
  resumePoint: ResumePoint,
  agentSessions?: AgentSessionRef[]
): ResumePoint {
  return {
    ...resumePoint,
    agentSessionId: resolveAgentSessionId(
      resumePoint.nodeId,
      resumePoint.agentSessionId,
      agentSessions
    ),
  };
}

// ============================================================================
// New: Complete Resume Info Extraction
// ============================================================================

/**
 * Complete resume information extracted from session messages
 */
export interface ResumeInfo {
  /** Pending node ID (if any node was interrupted) */
  pendingNodeId: string | undefined;
  /** Agent sub-session ID for the pending node */
  agentSessionId: string | undefined;
  /** Whether there is a pending interrupt (ask_user) */
  hasInterrupt: boolean;
  /** Node outputs from completed nodes */
  nodeOutputs: Map<string, unknown>;
  /** Last interrupt message content (query) */
  lastInterruptQuery?: string;
}

/**
 * Extract complete resume information from session messages
 * 
 * This function consolidates the logic that was previously scattered across
 * engine.ts and other places. It extracts all information needed to resume
 * a workflow from its session messages.
 * 
 * The key insight is:
 * - If the last message is an interrupt, use its metadata for resume
 * - No need for complex userResponse distinction
 * - agentSessionId comes from interrupt message metadata
 * - userQuery comes from the input provided during resume
 * 
 * @param messages - Session messages to analyze
 * @returns Complete resume information
 */
export function extractResumeInfo(messages: SessionMessage[]): ResumeInfo {
  const nodeOutputs = parseNodeOutputs(messages);
  let pendingNodeId: string | undefined;
  let agentSessionId: string | undefined;
  let hasInterrupt = false;
  let lastInterruptQuery: string | undefined;
  
  for (const msg of messages) {
    const metadata = msg.metadata as Record<string, unknown>;
    
    if (metadata?.type === 'workflow.node.start' || metadata?.type === 'workflow.node.call') {
      // Track the current node being executed (both start and call indicate pending node)
      pendingNodeId = getWorkflowNodeIdFromMetadata(metadata);
      // Also get agentSessionId from start/call if present
      if (metadata?.agentSessionId && !agentSessionId) {
        agentSessionId = metadata.agentSessionId as string;
      }
    } else if (metadata?.type === 'workflow.node.end' || metadata?.type === 'workflow.node.result') {
      // Node completed (end) or result received - clear pending state
      // For end: definitely completed
      // For result: this is the result for the last node, it's complete
      pendingNodeId = undefined;
      agentSessionId = undefined; // Reset agentSessionId since node completed
    } else if (metadata?.type === 'workflow.node.interrupt') {
      // Interrupt means we need to resume this node
      pendingNodeId = getWorkflowNodeIdFromMetadata(metadata);
      agentSessionId = metadata.agentSessionId as string | undefined;
      hasInterrupt = true;
      lastInterruptQuery = msg.content as string;
    }
  }
  
  return {
    pendingNodeId,
    agentSessionId,
    hasInterrupt,
    nodeOutputs,
    lastInterruptQuery,
  };
}

/**
 * Split ephemeral resume userQuery from durable workflow input.
 * userQuery is only valid for the node being resumed and must not persist
 * in workflowInput for subsequent nodes.
 */
export function stripEphemeralResumeInput(
  input?: Record<string, unknown>
): { workflowInput?: Record<string, unknown>; userQuery?: unknown } {
  if (!input) {
    return {};
  }

  const { userQuery, ...rest } = input;
  const workflowInput = Object.keys(rest).length > 0 ? rest : undefined;

  return {
    workflowInput,
    userQuery,
  };
}
