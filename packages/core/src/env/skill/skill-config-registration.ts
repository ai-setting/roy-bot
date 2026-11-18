/**
 * @fileoverview Skill Component 配置注册
 * 
 * 使用 ConfigComponent.registerComponent() 机制统一管理配置
 */

import path from "path";
import os from "os";
import type { ComponentRegistration } from "../../config/config-component";

/**
 * Skill Component 默认配置值
 * 
 * 注意：键使用完整格式（带 "skill." 前缀），在 registerConfig 中手动设置
 */
export const SKILL_DEFAULTS: Record<string, unknown> = {
  "skill.skillPaths": [
    { type: "user", path: path.join(os.homedir(), ".config", "roy-bot", "skills") },
    { type: "project", path: ".roy/skills" },
  ],
  "skill.recursive": true,
  "skill.cacheEnabled": true,
};

/**
 * Skill Component 配置注册常量
 * 
 * 定义了所有 Skill 相关的配置项和来源
 */
export const SKILL_CONFIG_REGISTRATION: ComponentRegistration = {
  name: "skill",
  
  sources: [
    { type: "env", envPrefix: "SKILL", priority: 20, watch: false },
  ],
  
  keys: [
    { key: "skill.skillPaths", sources: ["env", "file"] },
    { key: "skill.recursive", sources: ["env", "file"] },
    { key: "skill.cacheEnabled", sources: ["env", "file"] },
  ],
  // 注意：不使用 defaults 字段，默认值在 registerConfig 中手动 set
};
