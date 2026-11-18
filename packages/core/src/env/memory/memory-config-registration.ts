/**
 * @fileoverview Memory Component 配置注册
 * 
 * 使用 ConfigComponent.registerComponent() 机制统一管理配置
 */

import path from "path";
import os from "os";
import type { ComponentRegistration } from "../../config/config-component";

/**
 * Memory Component 默认配置值
 * 
 * 注意：键使用完整格式（带 "memory." 前缀），在 registerConfig 中手动设置
 */
export const MEMORY_DEFAULTS: Record<string, unknown> = {
  "memory.recursive": true,
  "memory.cacheEnabled": true,
  "memory.cacheTTL": 300000, // 5 分钟
  "memory.memoryFile": "memory.md", // 默认记忆文件名
  // memoryPaths 的默认值（统一在 ConfigComponent 中管理）
  "memory.memoryPaths": [
    { type: "global", path: path.join(os.homedir(), ".config", "roy-bot", "memory") },
    { type: "project", path: ".roy/memory" },
  ],
};

/**
 * Memory Component 配置注册常量
 * 
 * 定义了所有 Memory 相关的配置项和来源
 */
export const MEMORY_CONFIG_REGISTRATION: ComponentRegistration = {
  name: "memory",
  
  sources: [
    { type: "env", envPrefix: "MEMORY", priority: 20, watch: false },
  ],
  
  keys: [
    { key: "memory.recursive", sources: ["env", "file"] },
    { key: "memory.cacheEnabled", sources: ["env", "file"] },
    { key: "memory.cacheTTL", sources: ["env", "file"] },
    { key: "memory.memoryPaths", sources: ["env", "file"] },
    { key: "memory.memoryFile", sources: ["env", "file"] },
  ],
  // 注意：不使用 defaults 字段，默认值在 registerConfig 中手动 set
};
