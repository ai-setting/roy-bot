/**
 * @fileoverview MCP Component 配置注册
 * 
 * 使用 ConfigComponent.registerComponent() 机制统一管理配置
 */

import path from "path";
import os from "os";
import type { ComponentRegistration } from "../../config/config-component";

/**
 * MCP Component 默认配置值
 * 
 * 注意：这些默认值需要在 McpComponent.registerConfig() 中
 * 通过 configComponent.set() 设置到 ConfigComponent
 */
export const MCP_DEFAULTS: Record<string, unknown> = {
  "mcp.enabled": true,
  "mcp.timeout": 30000,
  "mcp.mcpPaths": [
    {
      type: "user",
      path: path.join(os.homedir(), ".config", "roy-bot", "mcp"),
    },
    {
      type: "project",
      path: ".roy/mcp",
    },
  ],
};

/**
 * MCP Component 配置注册常量
 * 
 * 定义了所有 MCP 相关的配置项和来源
 */
export const MCP_CONFIG_REGISTRATION: ComponentRegistration = {
  name: "mcp",
  
  sources: [
    { type: "env", envPrefix: "MCP", priority: 20, watch: false },
  ],
  
  keys: [
    { key: "mcp.enabled", sources: ["memory", "env", "file"] },
    { key: "mcp.timeout", sources: ["memory", "env", "file"] },
    { key: "mcp.mcpPaths", sources: ["memory", "env", "file"] },
    { key: "mcp.servers", sources: ["memory", "env", "file"] },
  ],
};
