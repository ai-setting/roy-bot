/**
 * @fileoverview Task MCP Server — public entry point.
 *
 * Task #4619 — 让「roy 拥有全部逻辑，插件只是薄的一层」在 MCP 侧成立。
 *
 * ```ts
 * import { createTaskMcpServer } from "@ai-setting/roy-bot-core/env/task/mcp";
 * import { TaskStoreBackend, createSQLiteTaskPort } from "@ai-setting/roy-bot-core/env/task/backend";
 *
 * const server = createTaskMcpServer(new TaskStoreBackend(createSQLiteTaskPort()));
 * ```
 *
 * 宿主只负责「把字节接上」；工具清单、JSON Schema、task 语义、错误封装
 * 全在 core。
 */

export {
  createTaskMcpServer,
  createTaskMcpToolDefinitions,
  negotiateTaskMcpProtocolVersion,
  toJsonSchemaDocument,
  TASK_MCP_TOOL_NAMES,
  TASK_MCP_SUPPORTED_PROTOCOL_VERSIONS,
  TASK_MCP_DEFAULT_PROTOCOL_VERSION,
  TASK_MCP_JSON_RPC_ERRORS,
  type TaskMcpToolName,
  type TaskMcpToolDefinition,
  type TaskMcpServerOptions,
  type TaskMcpServer,
  type TaskMcpRequest,
  type TaskMcpResponse,
} from "./task-mcp-server";
