/**
 * @fileoverview Agent Component Module
 * 
 * 导出 AgentComponent 及其相关类型
 */

export { AgentComponent, AgentComponentConfigSchema, type AgentComponentConfig } from "./agent-component";
export { SummaryAgent } from "./summary-agent";  // (new)
export * from "./types";
export type { LLMOutput } from "../llm/types";
