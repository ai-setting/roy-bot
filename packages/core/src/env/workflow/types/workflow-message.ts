import { z } from 'zod';

// ==================== Workflow Message Roles ====================

/**
 * Workflow 节点执行消息角色类型
 * 
 * 设计原则：
 * - workflow.node.start: 对应 tool-call，节点开始执行
 * - workflow.node.interrupt: 节点中断等待用户输入
 * - workflow.node.end: 对应 tool-result，节点执行结束
 * - workflow.node.resume: 用户响应后恢复节点执行
 */
export const WorkflowMessageRoleSchema = z.enum([
  'workflow.node.start',
  'workflow.node.interrupt', 
  'workflow.node.end',
  'workflow.node.resume'
]);
export type WorkflowMessageRole = z.infer<typeof WorkflowMessageRoleSchema>;

// ==================== Message Parts ====================

/**
 * workflow.node.start 消息 part
 * 对应 tool-call，节点开始执行
 */
export interface WorkflowNodeStartPart {
  type: 'workflow-node-start';
  nodeId: string;
  nodeType: string;
  input?: unknown;
  startTime: number;
  /** Agent session ID (only for agent nodes) */
  agentSessionId?: string;
}

/**
 * workflow.node.interrupt 消息 part
 * 节点中断等待用户输入
 */
export interface WorkflowNodeInterruptPart {
  type: 'workflow-node-interrupt';
  nodeId: string;
  nodeType: string;
  query: string;
  timestamp: number;
  /** Agent session ID (only for agent nodes) - 用于恢复 agent 子会话 */
  agentSessionId?: string;
}

/**
 * workflow.node.end 消息 part
 * 对应 tool-result，节点执行结束
 */
export interface WorkflowNodeEndPart {
  type: 'workflow-node-end';
  nodeId: string;
  nodeType: string;
  output?: unknown;
  error?: string;
  durationMs: number;
  /** Agent session ID (only for agent nodes) */
  agentSessionId?: string;
}

/**
 * workflow.node.resume 消息 part
 * 用户响应后恢复节点执行
 */
export interface WorkflowNodeResumePart {
  type: 'workflow-node-resume';
  nodeId: string;
  response: string;
  timestamp: number;
  /** Agent session ID (only for agent nodes) */
  agentSessionId?: string;
}

/**
 * workflow 消息 part 联合类型
 */
export type WorkflowMessagePart = 
  | WorkflowNodeStartPart 
  | WorkflowNodeInterruptPart 
  | WorkflowNodeEndPart 
  | WorkflowNodeResumePart;

// ==================== Session Metadata ====================

/**
 * Workflow Session 元数据（简化版）
 *
 * 简化原则：只保留必要字段，其他信息从 messages 推断
 *
 * 设计原则（Task #1837）：
 * - sessionId 直接作为 runId 使用（runId 天然带 workflow_ 前缀）
 * - Session.metadata.status 跟踪运行状态
 * - Session.messages 按时间顺序记录节点执行状态
 * - Next node 从 messages 推断（最后一条消息决定恢复点）
 */
export interface WorkflowSessionMetadata {
  type: 'workflow';
  /** Used to load workflow definition */
  workflowId: string;
  /** Display name */
  workflowName: string;
  /** Workflow 版本 (可选) */
  workflowVersion?: string;
  /** Execution status */
  status: 'running' | 'paused' | 'completed' | 'failed' | 'stopped';
  /** Run id — Task #1837: equals sessionId exactly. Kept for backward compat with older session records. */
  runId?: string;
  /** Workflow input (fresh + resume merged) */
  input?: unknown;
  /** Timestamps and lifecycle */
  startedAt?: number;
  completedAt?: number;
  failedAt?: number;
  durationMs?: number;
  /** Final workflow output summary */
  output?: Record<string, unknown>;
  /** Pause/resume hints */
  pendingNodeId?: string;
  pauseReason?: 'ask_user' | string;
  /** Agent sub-session refs */
  agentSessions?: AgentSessionRef[];
  
  /** Allow additional properties for metadata extension */
  [key: string]: unknown;
}

/**
 * Agent Session 引用（存储在 workflow session metadata 中）
 */
export interface AgentSessionRef {
  nodeId: string;
  sessionId: string;
  /**
   * Agent session 状态
   * - 'active': 节点正在执行
   * - 'paused': 节点因 ask_user 中断暂停（可恢复）
   * - 'completed': 节点成功完成
   * - 'failed': 节点执行失败
   * - 'stopped': 节点因 workflow.stop() 强制终止
   */
  status: 'active' | 'paused' | 'completed' | 'failed' | 'stopped';
  createdAt?: number;
}

// ==================== Message Metadata ====================

/**
 * workflow.node.start 消息元数据
 * 对应 tool-call
 */
export interface WorkflowNodeStartMetadata {
  type: 'workflow.node.start';
  /** Canonical node id (alias of workflowNodeId) */
  nodeId: string;
  workflowNodeId: string;
  workflowNodeType: string;
  /** Agent session ID (only for agent nodes) */
  agentSessionId?: string;
}

/**
 * workflow.node.interrupt 消息元数据
 */
export interface WorkflowNodeInterruptMetadata {
  type: 'workflow.node.interrupt';
  nodeId: string;
  workflowNodeId: string;
  workflowNodeType: string;
  query: string;
  /** Agent session ID (only for agent nodes) */
  agentSessionId?: string;
  timestamp?: number;
}

/**
 * workflow.node.end 消息元数据
 * 对应 tool-result
 */
export interface WorkflowNodeEndMetadata {
  type: 'workflow.node.end';
  nodeId: string;
  workflowNodeId: string;
  workflowNodeType: string;
  success: boolean;
  agentSessionId?: string;
}

/**
 * workflow.node.resume 消息元数据
 */
export interface WorkflowNodeResumeMetadata {
  type: 'workflow.node.resume';
  nodeId: string;
  workflowNodeId: string;
  workflowNodeType: string;
  response: string;
  /** Agent session ID (only for agent nodes) */
  agentSessionId?: string;
  timestamp?: number;
}

/**
 * workflow 消息元数据联合类型
 */
export type WorkflowMessageMetadata = 
  | WorkflowNodeStartMetadata 
  | WorkflowNodeInterruptMetadata 
  | WorkflowNodeEndMetadata 
  | WorkflowNodeResumeMetadata;

// ==================== Agent Session Info ====================

/**
 * Agent Session 信息（存储在 workflow message metadata 中）
 */
export interface AgentSessionInfo {
  /** Agent session ID */
  sessionId: string;
  /** Node ID */
  nodeId: string;
  /** 创建时间 */
  createdAt: number;
}

// ==================== Re-export HIL types ====================

// Re-export Human-in-Loop types and utilities
export {
  AskUserError,
  createNodeInterruptEvent,
  createWorkflowAskUserEvent,
} from './workflow-hil';

export type {
  NodeInterruptEvent,
  WorkflowAskUserEvent,
} from './workflow-hil';
