/** AgentComponent 最小接口，用于 --agent 校验 */
export interface ActAgentLookup {
  getAgent(name: string): { name: string } | undefined;
}

/** handle_query 路由 agent 时使用的 context 字段（agentType 值为 agent 名称） */
export interface ActAgentContext {
  agentType: string;
}

/**
 * 校验 act/interactive --agent 指定的 agent 是否已注册
 */
export function validateActAgent(
  agentComponent: ActAgentLookup | undefined,
  agentName: string | undefined
): { valid: true } | { valid: false; message: string } {
  if (!agentName || agentName === "default") {
    return { valid: true };
  }
  if (!agentComponent?.getAgent(agentName)) {
    return {
      valid: false,
      message: `Agent "${agentName}" 不存在`,
    };
  }
  return { valid: true };
}

/**
 * 构建传给 handle_query 的 agent context 片段
 * 未指定或为 default 时返回 undefined
 */
export function buildActAgentContext(
  agentName: string | undefined
): ActAgentContext | undefined {
  if (!agentName || agentName === "default") {
    return undefined;
  }
  return { agentType: agentName };
}

/**
 * 判断 handle_query 返回值是否为 workflow agent 的 HIL 暂停结果（JSON）
 */
export function isWorkflowPausedActResult(result: string): boolean {
  try {
    const parsed = JSON.parse(result) as { status?: string };
    return parsed.status === "paused";
  } catch {
    return false;
  }
}
