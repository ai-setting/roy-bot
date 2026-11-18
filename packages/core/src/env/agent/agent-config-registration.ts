/**
 * @fileoverview Agent Component 配置注册
 * 
 * 使用 ConfigComponent.registerComponent() 机制统一管理配置
 */

import type { ComponentRegistration } from "../../config/config-component";

/**
 * Agent Component 默认配置值
 * 
 * 注意：键使用完整格式（带 "agent." 前缀），在 registerConfig 中手动设置
 */
export const AGENT_DEFAULTS: Record<string, unknown> = {
  "agent.defaultAgent.maxIterations": 200,
  "agent.defaultAgent.temperature": 0,
  "agent.defaultAgent.timeout": 300000,
  "agent.defaultAgent.streaming": false,
  "agent.defaultAgent.filterHistory": false,
};

/**
 * Agent Component 配置注册常量
 * 
 * 定义了所有 Agent 相关的配置项和来源
 */
export const AGENT_CONFIG_REGISTRATION: ComponentRegistration = {
  name: "agent",
  
  sources: [
    { type: "env", envPrefix: "AGENT", priority: 20, watch: false },
  ],
  
  keys: [
    { key: "agent.defaultAgent.model", sources: ["env", "file"] },
    { key: "agent.defaultAgent.maxIterations", sources: ["env", "file"] },
    { key: "agent.defaultAgent.temperature", sources: ["env", "file"] },
    { key: "agent.defaultAgent.timeout", sources: ["env", "file"] },
    { key: "agent.defaultAgent.systemPrompt", sources: ["env", "file"] },
    { key: "agent.defaultAgent.streaming", sources: ["env", "file"] },
    { key: "agent.defaultAgent.tools", sources: ["env", "file"] },
    { key: "agent.defaultAgent.allowedTools", sources: ["env", "file"] },
    { key: "agent.defaultAgent.deniedTools", sources: ["env", "file"] },
    { key: "agent.defaultAgent.maxErrorRetries", sources: ["env", "file"] },
    { key: "agent.defaultAgent.filterHistory", sources: ["env", "file"] },
  ],
  // 注意：不使用 defaults 字段，默认值在 registerConfig 中手动 set
};
