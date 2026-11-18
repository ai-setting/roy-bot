/**
 * @fileoverview 统一常量定义
 * 
 * 定义事件名称和错误消息常量，避免硬编码字符串
 */

/**
 * Agent 相关事件名称
 */
export const AgentEvents = {
  RUN_START: "agent.run.start",
  RUN_COMPLETE: "agent.run.complete",
  RUN_ERROR: "agent.run.error",
  TOOL_CALLED: "agent.tool.called",
  TOOL_RESULT: "agent.tool.result",
  LLM_REQUEST: "agent.llm.request",
  LLM_RESPONSE: "agent.llm.response",
  ITERATION_START: "agent.iteration.start",
  ITERATION_COMPLETE: "agent.iteration.complete",
} as const;

/**
 * Tool 相关事件名称
 */
export const ToolEvents = {
  EXECUTE_START: "tool.execute.start",
  EXECUTE_COMPLETE: "tool.execute.complete",
  EXECUTE_ERROR: "tool.execute.error",
  REGISTERED: "tool.registered",
  UNREGISTERED: "tool.unregistered",
} as const;

/**
 * Component 生命周期事件名称
 */
export const ComponentEvents = {
  INIT_START: "component.init.start",
  INIT_COMPLETE: "component.init.complete",
  START: "component.start",
  STOP: "component.stop",
} as const;

/**
 * Session 相关事件名称
 */
export const SessionEvents = {
  CREATED: "session.created",
  DELETED: "session.deleted",
  MESSAGE_ADDED: "session.message.added",
} as const;

/**
 * Agent 错误消息
 */
export const AgentErrorMessages = {
  notFound: (name: string) => `Agent not found: ${name}`,
  alreadyRunning: (name: string) => `Agent ${name} is already running`,
  notRunning: (name: string) => `Agent ${name} is not running`,
  runFailed: (name: string, reason?: string) => 
    reason ? `Agent ${name} run failed: ${reason}` : `Agent ${name} run failed`,
} as const;

/**
 * Tool 错误消息
 */
export const ToolErrorMessages = {
  notFound: (name: string) => `Tool not found: ${name}`,
  // ⚠️ 已知漂移（独立 review P2-6）：实际发出的字符串是 `Tool disabled: <name>`
  // （见 ToolComponent.execute / AgentComponent.executeTool），与本常量格式不一致。
  // 未直接改常量以避免动到已发出的（面向 LLM / 用户可见的）文案 —— 若要统一，
  // 应连同消费方一起改并跑全量测试。判定「工具不可用」请统一用下方的
  // isToolUnavailableError()（单一事实来源），不要各自硬编码字面量。
  disabled: (name: string) => `Tool ${name} is disabled`,
  executionFailed: (name: string, reason?: string) =>
    reason ? `Tool ${name} execution failed: ${reason}` : `Tool ${name} execution failed`,
  validationFailed: (name: string, reason?: string) =>
    reason ? `Tool ${name} validation failed: ${reason}` : `Tool ${name} validation failed`,

} as const;

/**
 * 「工具不可用」错误判定 —— 单一事实来源。
 *
 * 语义：工具**根本不存在**（未注册 / 被 allowedTools|deniedTools 过滤 / 被禁用），
 * 属于「prompt 承诺的工具 ≠ 实际工具表」的**配置错误**，必须显式可见
 * （2026-10-16 空 checkpoint 事故正是因为这类失败被静默吞掉）。
 *
 * 刻意**不**覆盖工具自身的运行时失败（bash exit!=0、grep 无匹配、文件不存在等），
 * 那些是正常运行时结果，标成 ERROR 会让 trace 被红色噪音淹没、反而掩盖真问题。
 *
 * 消费方：AgentComponent.executeTool / ToolComponent.execute 的 @TracedAs errorIf。
 */
export const TOOL_UNAVAILABLE_ERROR_RE = /^Tool (?:not found|disabled):/;

export function isToolUnavailableError(message: unknown): boolean {
  return typeof message === "string" && TOOL_UNAVAILABLE_ERROR_RE.test(message);
}


/**
 * LLM 错误消息
 */
export const LLMErrorMessages = {
  providerNotFound: (provider: string) => `LLM provider not found: ${provider}`,
  apiKeyMissing: (provider: string) => `API key missing for provider: ${provider}`,
  invocationFailed: (provider: string, reason?: string) =>
    reason ? `LLM ${provider} invocation failed: ${reason}` : `LLM ${provider} invocation failed`,
  timeout: (provider: string) => `LLM ${provider} invocation timeout`,
} as const;

/**
 * Component 错误消息
 */
export const ComponentErrorMessages = {
  notFound: (name: string) => `Component not found: ${name}`,
  notRegistered: (name: string) => `Component ${name} is not registered`,
  notRunning: (name: string) => `Component ${name} is not running`,
  initFailed: (name: string, reason?: string) =>
    reason ? `Component ${name} init failed: ${reason}` : `Component ${name} init failed`,
} as const;

/**
 * 检查是否是 Agent 事件
 */
export function isAgentEvent(event: string): event is typeof AgentEvents[keyof typeof AgentEvents] {
  return event.startsWith("agent.");
}

/**
 * 检查是否是 Tool 事件
 */
export function isToolEvent(event: string): event is typeof ToolEvents[keyof typeof ToolEvents] {
  return event.startsWith("tool.");
}

/**
 * 检查是否是 Component 事件
 */
export function isComponentEvent(event: string): event is typeof ComponentEvents[keyof typeof ComponentEvents] {
  return event.startsWith("component.");
}

/**
 * 检查是否是 Session 事件
 */
export function isSessionEvent(event: string): event is typeof SessionEvents[keyof typeof SessionEvents] {
  return event.startsWith("session.");
}
