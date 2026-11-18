/**
 * @fileoverview Human-in-Loop (HIL) types for workflow
 * 
 * This module contains types and utilities for human-in-loop functionality:
 * - NodeInterruptEvent: Event when a node needs human input
 * - WorkflowAskUserEvent: Event when the workflow needs human confirmation
 * - AskUserError: Error thrown when a node requests user input
 */

import type { BaseEvent } from './event';

// ==================== Event Types ====================

/**
 * Node 中断事件 - 节点等待用户输入
 */
export interface NodeInterruptEvent extends BaseEvent {
  type: 'node.interrupt';
  node_id: string;
  node_type: string;
  query: string;
  /** Agent sub-session ID (for agent nodes that need resume) */
  agent_session_id?: string;
}

/**
 * Workflow Ask User 事件 - Workflow 等待用户输入
 */
export interface WorkflowAskUserEvent extends BaseEvent {
  type: 'workflow.ask-user';
  session_id: string;
  node_id: string;
  node_type: string;
  query: string;
}

/**
 * 创建 NodeInterruptEvent
 */
export function createNodeInterruptEvent(
  runId: string,
  nodeId: string,
  nodeType: string,
  query: string,
  agentSessionId?: string
): NodeInterruptEvent {
  return {
    type: 'node.interrupt',
    run_id: runId,
    timestamp: Date.now(),
    node_id: nodeId,
    node_type: nodeType,
    query,
    ...(agentSessionId ? { agent_session_id: agentSessionId } : {}),
  };
}

/**
 * 创建 WorkflowAskUserEvent
 */
export function createWorkflowAskUserEvent(
  runId: string,
  sessionId: string,
  nodeId: string,
  nodeType: string,
  query: string
): WorkflowAskUserEvent {
  return {
    type: 'workflow.ask-user',
    run_id: runId,
    timestamp: Date.now(),
    session_id: sessionId,
    node_id: nodeId,
    node_type: nodeType,
    query,
  };
}

// ==================== AskUserError ====================

/**
 * AskUserError - 当节点调用 askUser() 时抛出
 */
export class AskUserError extends Error {
  readonly type = 'ask-user';
  readonly name = 'AskUserError';

  constructor(
    public readonly runId: string,
    public readonly sessionId: string,
    public readonly nodeId: string,
    public readonly nodeType: string,
    public readonly query: string,
    public readonly agentSessionId?: string,
    public readonly timestamp: number = Date.now(),
    /**
     * ★ Task #4983 — 问题**是否已经投递到用户渠道**。
     *
     * 语义：`true` = 工具层已经把问题正文发到 IM 渠道（用户已看到），
     *      `false` / 缺省 = **没投成** ⇒ CLI 层应当兜底补投。
     *
     * 为什么需要：core 的 ask_user 工具层是**主修**（抛错前投递），
     * 但它依赖 EnvContext 里有 replyChannel —— 拿不到就投不了。
     * CLI 层（query-executor）是**兜底**。两层靠这个标记**互斥**，
     * 避免用户收到两条同样的问题。
     */
    public readonly delivered: boolean = false,
  ) {
    super(`[${nodeType}:${nodeId}] Ask user: ${query}`);
  }
  
  /**
   * 转换为 WorkflowAskUserEvent
   */
  toEvent(): WorkflowAskUserEvent {
    return {
      type: 'workflow.ask-user',
      run_id: this.runId,
      timestamp: this.timestamp,
      session_id: this.sessionId,
      node_id: this.nodeId,
      node_type: this.nodeType,
      query: this.query,
    };
  }
}
