import type { WorkflowSessionMetadata } from './workflow-message';

// Re-export from workflow-message
export type { WorkflowSessionMetadata } from './workflow-message';

// Re-export AgentSessionRef from workflow-message (where it's defined)
export type { AgentSessionRef } from './workflow-message';

/**
 * 检查 SessionMetadata 是否为 Workflow 类型
 * 
 * 简化验证：只检查必要字段存在性
 * - type === 'workflow'
 * - workflowId 存在
 * - workflowName 存在
 * - status 存在且为有效值
 */
export function isWorkflowSessionMetadata(
  metadata: unknown
): metadata is WorkflowSessionMetadata {
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    !('type' in metadata) ||
    (metadata as any).type !== 'workflow'
  ) {
    return false;
  }
  
  const m = metadata as WorkflowSessionMetadata;
  
  // Check required fields exist
  if (!m.workflowId || typeof m.workflowId !== 'string') {
    return false;
  }
  if (!m.workflowName || typeof m.workflowName !== 'string') {
    return false;
  }
  if (!m.status || typeof m.status !== 'string') {
    return false;
  }
  
  // Check status is valid
  const validStatuses = ['running', 'paused', 'completed', 'failed', 'stopped'];
  if (!validStatuses.includes(m.status)) {
    return false;
  }
  
  return true;
}

/**
 * 获取 workflow session 的状态
 */
export function getWorkflowSessionStatus(
  metadata: WorkflowSessionMetadata
): 'running' | 'paused' | 'completed' | 'failed' | 'stopped' {
  return metadata.status || 'running';
}
