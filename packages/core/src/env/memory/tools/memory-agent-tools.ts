/**
 * @fileoverview Memory Agent Tools
 * 
 * Memory Agent 使用的工具：
 * - search_sessions: 搜索会话历史
 * - get_session: 获取指定会话
 * - write_memory: 写入记忆文件
 * - bash: 执行 Shell 命令（用于探索项目结构）
 * - read_file: 读取文件内容（用于阅读文档）
 */

import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../../tool/types";
import { readFileTool, bashTool } from "../../tool/built-in";

// ============================================================================
// Tool Input Schemas
// ============================================================================

/**
 * search_sessions 输入参数
 */
export const SearchSessionsSchema = z.object({
  query: z.string().describe("搜索关键词"),
  session_id: z.string().optional().describe("可选：限制特定 session"),
  limit: z.number().optional().default(10).describe("返回数量限制"),
});

export type SearchSessionsParams = z.infer<typeof SearchSessionsSchema>;

/**
 * get_session 输入参数
 */
export const GetSessionSchema = z.object({
  session_id: z.string().describe("Session ID"),
});

export type GetSessionParams = z.infer<typeof GetSessionSchema>;

/**
 * write_memory 输入参数
 */
export const WriteMemorySchema = z.object({
  scope: z.enum(["project", "global"]).describe("作用域"),
  content: z.string().describe("新的记忆内容（Markdown 格式）"),
});

export type WriteMemoryParams = z.infer<typeof WriteMemorySchema>;

// ============================================================================
// Component Interfaces
// ============================================================================

/**
 * Session Component 接口（需要 searchSessions, getSession 方法）
 */
export interface MemoryAgentSessionComponent {
  /**
   * 列出所有会话（用于 search_sessions）
   */
  list(options?: any): Promise<any[]>;
  /**
   * 获取会话上下文（包含消息）
   */
  getContext(sessionId: string, options?: any): Promise<any>;
  /**
   * 搜索会话（通过 grep 命令）
   */
  searchSessions(query: string, options?: { session_id?: string; limit?: number }): Promise<any[]>;
  /**
   * 获取单个会话
   */
  getSession(sessionId: string): Promise<any | null>;
}

/**
 * Memory Component 接口（需要 recallMemory, recordMemory 方法）
 */
export interface MemoryAgentMemoryComponent {
  recallMemory(scope?: "project" | "global"): Promise<string | null>;
  recordMemory(params: { mode: string; content: string; scope?: string }): Promise<void>;
}

/**
 * Config Component 接口
 */
export interface MemoryAgentConfigComponent {
  get(key: string): unknown;
}

// ============================================================================
// Tool Factory
// ============================================================================

/**
 * Memory Agent 工具工厂
 */
export function createMemoryAgentTools(deps: {
  sessionComponent: MemoryAgentSessionComponent;
  memoryComponent: MemoryAgentMemoryComponent;
  configComponent?: MemoryAgentConfigComponent;
}): {
  searchSessions: Tool;
  getSession: Tool;
  writeMemory: Tool;
  bash: Tool;
  read_file: Tool;
} {
  // ============================================================================
  // search_sessions tool
  // ============================================================================
  const searchSessions: Tool = {
    name: "search_sessions",
    description: "搜索会话历史，返回匹配的会话摘要列表",
    parameters: SearchSessionsSchema as unknown as Tool["parameters"],
    execute: async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
      try {
        const params = SearchSessionsSchema.parse(args);

        const results = await deps.sessionComponent.searchSessions(params.query, {
          session_id: params.session_id,
          limit: params.limit,
        });

        return {
          success: true,
          output: JSON.stringify(results, null, 2),
          metadata: {
            execution_time_ms: 0,
            count: results.length,
          },
        };
      } catch (error) {
        return {
          success: false,
          output: "",
          error: error instanceof Error ? error.message : String(error),
          metadata: { execution_time_ms: 0 },
        };
      }
    },
  };

  // ============================================================================
  // get_session tool
  // ============================================================================
  const getSession: Tool = {
    name: "get_session",
    description: "获取指定会话的完整内容",
    parameters: GetSessionSchema as unknown as Tool["parameters"],
    execute: async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
      try {
        const params = GetSessionSchema.parse(args);

        const session = await deps.sessionComponent.getSession(params.session_id);

        if (!session) {
          return {
            success: false,
            output: "",
            error: `Session not found: ${params.session_id}`,
            metadata: { execution_time_ms: 0 },
          };
        }

        return {
          success: true,
          output: JSON.stringify(session, null, 2),
          metadata: {
            execution_time_ms: 0,
            session_id: session.sessionId,
          },
        };
      } catch (error) {
        return {
          success: false,
          output: "",
          error: error instanceof Error ? error.message : String(error),
          metadata: { execution_time_ms: 0 },
        };
      }
    },
  };

  // ============================================================================
  // write_memory tool
  // ============================================================================
  const writeMemory: Tool = {
    name: "write_memory",
    description: "写入记忆文件（覆盖模式）",
    parameters: WriteMemorySchema as unknown as Tool["parameters"],
    execute: async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
      try {
        const params = WriteMemorySchema.parse(args);

        await deps.memoryComponent.recordMemory({
          mode: "overwrite",
          content: params.content,
          scope: params.scope,
        });

        return {
          success: true,
          output: `Memory updated successfully (${params.scope})`,
          metadata: {
            execution_time_ms: 0,
            scope: params.scope,
          },
        };
      } catch (error) {
        return {
          success: false,
          output: "",
          error: error instanceof Error ? error.message : String(error),
          metadata: { execution_time_ms: 0 },
        };
      }
    },
  };

  return {
    searchSessions,
    getSession,
    writeMemory,
    bash: bashTool,
    read_file: readFileTool,
  };
}
