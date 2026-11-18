/**
 * @fileoverview MCP Component 配置
 */

import path from "path";
import os from "os";
import { z } from "zod";

// 前向声明，避免循环依赖
import type { ConfigComponent } from "../../config/config-component";

// ========== 配置类型 ==========

/**
 * MCP 路径配置
 */
export interface McpPath {
  /** 来源类型 */
  type: "user" | "project" | "custom";
  /** 路径 */
  path: string;
}

/**
 * McpPath Schema
 */
export const McpPathSchema = z.object({
  type: z.enum(["user", "project", "custom"]),
  path: z.string(),
});

/**
 * McpComponent 配置
 */
export interface McpComponentConfig {
  /** 扫描路径列表 */
  mcpPaths: McpPath[];
  /** 显式配置的服务器 */
  servers?: Record<string, z.infer<typeof import("./types.js").McpServerConfigSchema>>;
  /** 默认超时（毫秒） */
  timeout?: number;
  /** 是否启用 */
  enabled?: boolean;
}

/**
 * McpComponent 配置 Schema
 */
export const McpComponentConfigSchema = z.object({
  mcpPaths: z.array(McpPathSchema),
  servers: z.record(z.string(), z.any()).optional(),
  timeout: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
});

/**
 * McpComponentOptions（通过 options 传递）
 */
export interface McpComponentOptions {
  /** ConfigComponent 实例（必填） */
  configComponent: ConfigComponent;
  /** 配置文件相对路径 */
  configPath?: string;
  /** 环境变量前缀 */
  envPrefix?: string;
  /** 直接传入的配置对象（最高优先级） */
  config?: Partial<McpComponentConfig>;
}

// ========== 默认配置 ==========

/**
 * 默认 MCP 配置
 */
export const DEFAULT_MCP_CONFIG: McpComponentConfig = {
  mcpPaths: [
    {
      type: "user",
      path: path.join(os.homedir(), ".config", "roy-bot", "mcp"),
    },
    {
      type: "project",
      path: ".roy/mcp",
    },
  ],
  timeout: 30000,
  enabled: true,
};

// ========== 配置 Keys ==========

/**
 * 配置 Key 列表（用于 ConfigComponent 注册）
 */
export const MCP_CONFIG_KEYS = [
  "mcp.enabled",
  "mcp.timeout",
  "mcp.mcpPaths",
  "mcp.servers",
] as const;

/**
 * 路径类型优先级
 */
export const MCP_PATH_PRIORITY: Record<string, number> = {
  user: 1,
  project: 2,
  custom: 3,
};

/**
 * 获取路径优先级
 */
export function getMcpPathPriority(type: string): number {
  return MCP_PATH_PRIORITY[type] ?? 0;
}
