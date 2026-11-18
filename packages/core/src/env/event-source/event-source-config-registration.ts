/**
 * @fileoverview EventSource Component 配置注册
 * 
 * 使用 ConfigComponent.registerComponent() 机制统一管理配置
 */

import type { ComponentRegistration } from "../../config/config-component";

/**
 * EventSource Component 默认配置值
 * 
 * 注意：键使用完整格式（带 "event-source." 前缀），在 registerConfig 中手动设置
 */
export const EVENT_SOURCE_DEFAULTS: Record<string, unknown> = {
  "event-source.enabled": true,
  "event-source.persistenceEnabled": true,
};

/**
 * EventSource Component 配置注册常量
 * 
 * 定义了所有 EventSource 相关的配置项和来源
 */
export const EVENT_SOURCE_CONFIG_REGISTRATION: ComponentRegistration = {
  name: "event-source",
  
  sources: [
    { type: "env", envPrefix: "EVENT_SOURCE", priority: 20, watch: false },
  ],
  
  keys: [
    { key: "event-source.enabled", sources: ["env", "file"] },
    { key: "event-source.persistenceEnabled", sources: ["env", "file"] },
    { key: "event-source.configPath", sources: ["env", "file"] },
  ],
  // 注意：不使用 defaults 字段，默认值在 registerConfig 中手动 set
};
