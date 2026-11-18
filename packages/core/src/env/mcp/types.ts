/**
 * @fileoverview MCP 类型定义
 */

import { z } from "zod";

// ========== MCP Server 配置 ==========

/**
 * Local MCP Server 配置（stdio 传输）
 */
export const McpServerLocalConfigSchema = z.object({
  type: z.literal("local"),
  command: z.array(z.string()).min(1),
  /** Working directory for the MCP server process */
  cwd: z.string().optional(),
  environment: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional().default(true),
  timeout: z.number().int().positive().optional(),
});

export type McpServerLocalConfig = z.infer<typeof McpServerLocalConfigSchema>;

/**
 * Remote MCP Server 配置（HTTP 传输）
 */
export const McpServerRemoteConfigSchema = z.object({
  type: z.literal("remote"),
  url: z.string().url(),
  enabled: z.boolean().optional().default(true),
  headers: z.record(z.string(), z.string()).optional(),
  timeout: z.number().int().positive().optional(),
});

export type McpServerRemoteConfig = z.infer<typeof McpServerRemoteConfigSchema>;

/**
 * MCP Server 配置（联合类型）
 */
export const McpServerConfigSchema = z.discriminatedUnion("type", [
  McpServerLocalConfigSchema,
  McpServerRemoteConfigSchema,
]);

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

// ========== 扫描发现的服务器 ==========

/**
 * 扫描发现的 MCP 服务器信息
 */
export interface DiscoveredMcpServer {
  /** 服务器名称（目录名） */
  name: string;
  /** MCP 服务器根目录 */
  serverDir?: string;
  /** 入口脚本路径 */
  entryPath?: string;
  /** 配置文件路径 */
  configPath?: string;
  /** package.json 路径 */
  packagePath?: string;
  /** 目录中的配置 */
  directoryConfig?: Record<string, unknown>;
  /** 解析后的默认命令（兼容不同路径） */
  defaultCommand?: string[];
}

// ========== 服务器状态 ==========

/**
 * MCP 服务器状态
 */
export interface McpServerStatus {
  /** 服务器名称 */
  name: string;
  /** 连接状态 */
  status: "connecting" | "connected" | "disconnected" | "error";
  /** 错误信息 */
  error?: string;
  /** 工具数量 */
  toolsCount?: number;
}
