/**
 * @fileoverview Prompt Component 配置注册
 * 
 * 使用 ConfigComponent.registerComponent() 机制统一管理配置
 */

import type { ComponentRegistration } from "../../config/config-component";

/**
 * Prompt Component 默认配置值
 * 
 * 注意：键使用完整格式（带 "prompt." 前缀），在 registerConfig 中手动设置
 */
export const PROMPT_DEFAULTS: Record<string, unknown> = {
  "prompt.defaultName": "default",
  "prompt.variablePrefix": "{{",
  "prompt.variableSuffix": "}}",
  "prompt.configDir": "",
};

/**
 * Prompt Component 配置注册常量
 * 
 * 定义了所有 Prompt 相关的配置项和来源
 */
export const PROMPT_CONFIG_REGISTRATION: ComponentRegistration = {
  name: "prompt",
  
  sources: [
    { type: "env", envPrefix: "PROMPT", priority: 20, watch: false },
  ],
  
  keys: [
    { key: "prompt.promptPaths", sources: ["env", "file"] },
    { key: "prompt.configDir", sources: ["env", "file"] },
    { key: "prompt.defaultName", sources: ["env", "file"] },
    { key: "prompt.variablePrefix", sources: ["env", "file"] },
    { key: "prompt.variableSuffix", sources: ["env", "file"] },
  ],
  // 注意：不使用 defaults 字段，默认值在 registerConfig 中手动 set
};
