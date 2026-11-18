/**
 * @fileoverview Tool Component 配置注册
 * 
 * 使用 ConfigComponent.registerComponent() 机制统一管理配置
 */

import type { ComponentRegistration } from "../../config/config-component";

/**
 * Tool Component 默认配置值
 * 
 * 注意：键使用完整格式（带 "tool." 前缀），在 registerConfig 中手动设置
 */
export const TOOL_DEFAULTS: Record<string, unknown> = {
  "tool.toolsDir": ".roy/tools",
  "tool.builtInTools.enabled": true,
  "tool.builtInTools.loadAll": true,
  "tool.sandbox.enabled": false,
  "tool.sandbox.type": "native",
  "tool.execution.timeout": 30000,
  "tool.execution.maxConcurrency": 5,
  "tool.execution.maxOutputSize": 5120, // 5KB
  // ★ Task #5422：工具 reason 入参逃生开关（默认开启 = 必填）
  "tool.reason.required": true,
};

/**
 * Tool Component 配置注册常量
 * 
 * 定义了所有 Tool 相关的配置项和来源
 */
export const TOOL_CONFIG_REGISTRATION: ComponentRegistration = {
  name: "tool",
  
  sources: [
    { type: "env", envPrefix: "TOOL", priority: 20, watch: false },
  ],
  
  keys: [
    { key: "tool.toolsDir", sources: ["env", "file"] },
    { key: "tool.builtInTools.enabled", sources: ["env", "file"] },
    { key: "tool.builtInTools.loadAll", sources: ["env", "file"] },
    { key: "tool.sandbox.enabled", sources: ["env", "file"] },
    { key: "tool.sandbox.type", sources: ["env", "file"] },
    { key: "tool.execution.timeout", sources: ["env", "file"] },
    { key: "tool.execution.maxConcurrency", sources: ["env", "file"] },
    { key: "tool.execution.maxOutputSize", sources: ["env", "file"] },
    { key: "tool.reason.required", sources: ["env", "file"] },
  ],
  // 注意：不使用 defaults 字段，默认值在 registerConfig 中手动 set
};
