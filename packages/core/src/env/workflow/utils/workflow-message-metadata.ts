/**
 * Shared helpers for workflow session message metadata.
 * Ensures nodeId / workflowNodeId and _workflowNodeMetadata are consistent.
 */

export type WorkflowNodeMessageType =
  | 'workflow.node.start'
  | 'workflow.node.end'
  | 'workflow.node.interrupt'
  | 'workflow.node.resume'
  | 'workflow.node.call'
  | 'workflow.node.result';

/**
 * Resolve node id from message metadata (supports nodeId and workflowNodeId).
 */
export function getWorkflowNodeIdFromMetadata(
  metadata: Record<string, unknown> | undefined | null
): string | undefined {
  if (!metadata) {
    return undefined;
  }
  const nodeId = metadata.nodeId as string | undefined;
  const workflowNodeId = metadata.workflowNodeId as string | undefined;
  return nodeId ?? workflowNodeId;
}

/**
 * Build base workflow node message metadata with nodeId aliases.
 */
export function buildWorkflowNodeMetadata(
  type: WorkflowNodeMessageType,
  nodeId: string,
  nodeType: string,
  extra?: Record<string, unknown>
): Record<string, unknown> {
  return {
    _workflowNodeMetadata: true,
    type,
    nodeId,
    workflowNodeId: nodeId,
    workflowNodeType: nodeType,
    ...extra,
  };
}

/**
 * Patch agentSessionId onto an existing metadata object and optional parts.
 */
export function patchAgentSessionIdOnMessage(
  metadata: Record<string, unknown> | undefined,
  parts: unknown[] | undefined,
  agentSessionId: string
): { metadata: Record<string, unknown>; parts?: unknown[] } {
  const nextMetadata = {
    ...(metadata ?? {}),
    agentSessionId,
  };

  if (!parts?.length) {
    return { metadata: nextMetadata, parts };
  }

  const nextParts = parts.map((part) => {
    if (part && typeof part === 'object' && 'nodeId' in (part as object)) {
      return { ...(part as Record<string, unknown>), agentSessionId };
    }
    return part;
  });

  return { metadata: nextMetadata, parts: nextParts };
}
