/**
 * @fileoverview config 子命令类型定义
 */

/**
 * 所有支持的 Components 列表
 */
export const SUPPORTED_COMPONENTS = [
  'tool',
  'task',
  'memory',
  'session',
  'skill',
  'commands',
  'eventsource',
  'mcp',
  'agent',
  'log-trace',
  'lsp',
  'prompt',
] as const;

export type SupportedComponent = typeof SUPPORTED_COMPONENTS[number];

/**
 * Component 别名映射（用户输入 -> 内部名称）
 */
export const COMPONENT_ALIASES: Record<string, string> = {
  session: 'session',
  sessions: 'session',
  agents: 'agent',
  agent: 'agent',
  prompts: 'prompt',
  prompt: 'prompt',
};

/**
 * 获取组件的内部名称（处理别名）
 */
export function resolveComponentName(name: string): string {
  return COMPONENT_ALIASES[name] ?? name;
}

/**
 * Component 描述映射
 */
export const COMPONENT_DESCRIPTIONS: Record<string, string> = {
  tool: 'Tool Component - 工具管理',
  task: 'Task Component - 任务管理',
  memory: 'Memory Component - 记忆管理',
  session: 'Session Component - 会话管理',
  skill: 'Skill Component - 技能管理',
  commands: 'Commands Component - 命令管理',
  eventsource: 'EventSource Component - 事件源管理',
  mcp: 'MCP Component - MCP 服务器管理',
  agent: 'Agent Component - Agent 配置和循环控制',
  'log-trace': 'LogTrace Component - 日志和追踪管理',
  lsp: 'LSP Component - 语言服务器协议管理',
  prompt: 'Prompt Component - Prompt 模板管理',
};
