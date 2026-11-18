/**
 * @fileoverview Session Component 配置注册
 * 
 * 使用 ConfigComponent.registerComponent() 机制统一管理配置
 */

import type { ComponentRegistration } from "../../config/config-component";

/**
 * Session Component 默认配置值
 * 
 * 注意：键使用完整格式（带 "session." 前缀），在 registerConfig 中手动设置
 */
export const SESSION_DEFAULTS: Record<string, unknown> = {
  "session.defaultDirectory": "/tmp",
  "session.defaultTitleTemplate": "Session - {date}",
  "session.maxMessages": 100,
  "session.compactionThreshold": 80,
  "session.autoCompact": true,
  "session.storage.type": "sqlite",
  "session.storage.dbPath": undefined, // 由 SessionComponent 使用 getDefaultSessionDbPath() 设置动态默认值
  "session.checkpoint.enabled": false,
  "session.contextLimit": 100000,
  "session.maxSessions": 100,
  // ★ Task #4933：两阶段压缩（compact-hint / compact）统一使用的模型。
  //   未设置（undefined）→ 跟随 agent 定义 / 默认模型链（旧行为）
  //   设置后 → 以 run option（AgentContext.model）注入，
  //   覆盖 agent yaml 里的 model 字段（run option 优先级最高）。
  "session.compactModel": undefined,
};

/**
 * Session Component 配置注册常量
 * 
 * 定义了所有 Session 相关的配置项和来源
 */
export const SESSION_CONFIG_REGISTRATION: ComponentRegistration = {
  name: "session",
  
  sources: [
    { type: "env", envPrefix: "SESSION", priority: 20, watch: false },
  ],
  
  keys: [
    { key: "session.defaultDirectory", sources: ["env", "file"] },
    { key: "session.defaultTitleTemplate", sources: ["env", "file"] },
    { key: "session.maxMessages", sources: ["env", "file"] },
    { key: "session.compactionThreshold", sources: ["env", "file"] },
    { key: "session.autoCompact", sources: ["env", "file"] },
    { key: "session.storage.type", sources: ["env", "file"] },
    { key: "session.storage.dbPath", sources: ["env", "file"] },
    { key: "session.checkpoint.enabled", sources: ["env", "file"] },
    { key: "session.contextLimit", sources: ["env", "file"] },
    { key: "session.maxSessions", sources: ["env", "file"] },
    { key: "session.compactModel", sources: ["env", "file"] },
  ],
  // 注意：不使用 defaults 字段，默认值在 registerConfig 中手动 set
};
