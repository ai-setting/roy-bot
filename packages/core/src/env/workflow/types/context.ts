/**
 * askUser 选项
 */
export interface AskUserOptions {
  options?: string[];
  required_confirm?: boolean;
}

/**
 * 从 Session 恢复的运行时状态
 */
export interface RuntimeState {
  sessionId: string;
  nodeOutputs: Map<string, unknown>;
  pendingNodeId: string | null;
  waitingForUser: boolean;
  agentSessionId?: string;
}
