/**
 * @fileoverview Task MCP Server — roy's task tools over MCP, reusable by any host.
 *
 * Task #4619 —「代码逻辑都在 roy-bot，插件只是薄的一层」的核心交付之一。
 *
 * ## 为什么 core 需要这个模块
 *
 * `roy-bot-core` 之前**只有 MCP client**（`packages/core/src/env/mcp/*`），
 * 没有任何 server。结果每一个「MCP 说话」的宿主都得自己写一个 server，
 * 而 server 之上还得自己实现一遍 task 语义 —— 于是出现了
 * `roy-plugin-for-agent/claude/mcp/roy-task-mcp-server.mjs`（281 行）+
 * `claude/mcp/bridge.mjs`（482 行裸 SQL）这套复刻。
 *
 * 本模块把「MCP 传输 + 工具装配」收进 core：
 *
 * ```
 *   宿主（Claude Code / Codex / opencode / …）
 *     └─ 只做一件事：new TaskMcpServer(backend) 并把 stdin/stdout 接上
 *          └─ 工具定义、JSON Schema、语义、错误封装  ← 全在 core
 * ```
 *
 * 语义本身来自 `TaskBackend`（= `TaskStoreBackend`），工具描述与参数 schema
 * 来自 core 自己的工具工厂（`createTaskTool` / `treeTasksTool` / …），
 * **不是**手抄的副本。
 *
 * ## 依赖注入
 *
 * 宿主提供 `TaskBackend`（`@ai-setting/roy-bot-core/env/task/backend`）：
 *
 * - 想读 roy 自己的库 → `createSQLiteTaskPort()` + `TaskStoreBackend`
 * - 想用自己的库     → 实现 `TaskPersistencePort` + `TaskStoreBackend`
 * - 已有 sidecar 词表 → `createRoySidecarTaskPort(store, vocabulary)`
 *
 * 三种都拿到**完全相同**的语义与工具面。
 */

import { zodToJsonSchema } from "zod-to-json-schema";
import {
  createTaskTool,
  getTaskTool,
  listTasksTool,
  searchTasksTool,
  treeTasksTool,
  updateTaskTool,
  completeTaskTool,
  preCompleteTaskTool,
} from "../tools";
import { createOperationTool, listOperationsTool } from "../tools/operation";
import type { TaskBackend } from "../backend/types";

// ============================================================================
// Types
// ============================================================================

/** The task tools exposed over MCP. */
export const TASK_MCP_TOOL_NAMES = [
  "task_create",
  "task_tree",
  "task_get",
  "task_list",
  "task_search",
  "task_update",
  "task_complete",
  // Task #5073/#5078 — 两阶段验收：executor 提交待验证
  "task_pre_complete",
  "task_operation_create",
  "task_operation_list",
] as const;

export type TaskMcpToolName = (typeof TASK_MCP_TOOL_NAMES)[number];

/** An MCP tool definition (JSON Schema document — MCP requires JSON Schema). */
export interface TaskMcpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** JSON-RPC error codes used by this server. */
export const TASK_MCP_JSON_RPC_ERRORS = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
});

/**
 * MCP protocol versions this server understands.
 *
 * ⚠️ Task #4622 — `2025-11-25` was **missing** here.
 *
 * Task #4619 moved this contract into core but copied the list without the
 * newest entry. That regressed the handshake in two ways:
 *
 * 1. `@modelcontextprotocol/sdk@1.29.0` (this repo's own dependency)
 *    declares `LATEST_PROTOCOL_VERSION = '2025-11-25'` — a modern client
 *    asks for exactly that version.
 * 2. The **already published** plugin (`@ai-setting/roy-task-plugin@0.6.1`)
 *    listed `2025-11-25` first and used it as its `DEFAULT_PROTOCOL_VERSION`.
 *
 * So core without it silently *downgraded* the negotiated version relative
 * to the plugin release users already run. The list must stay a superset of
 * the SDK's own list, newest first.
 */
export const TASK_MCP_SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
]);

export const TASK_MCP_DEFAULT_PROTOCOL_VERSION = "2025-11-25";

export interface TaskMcpServerOptions {
  /** Server name reported in `initialize`. */
  name?: string;
  /** Server version reported in `initialize`. */
  version?: string;
  /** Session id stamped on created tasks / operations. */
  sessionId?: string;
  /** Working directory reported to tools that want one. */
  workdir?: string;
}

/** A JSON-RPC request as it arrives on the wire. */
export interface TaskMcpRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** A JSON-RPC response. `null` means "no response" (notification). */
export interface TaskMcpResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

/** The server handle a host drives. */
export interface TaskMcpServer {
  /**
   * Handle one JSON-RPC request. Returns `null` for notifications.
   *
   * Async because tool execution is async — a host that speaks JSON-RPC over
   * stdio awaits this before writing the response.
   */
  handleRequest(request: TaskMcpRequest): Promise<TaskMcpResponse | null>;
  /** The tool surface this server exposes. */
  listTools(): TaskMcpToolDefinition[];
  /** Invoke a tool by name (throws on unknown tool). */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

// ============================================================================
// Tool surface — derived from core's own tool factories
// ============================================================================

/**
 * The core tool factories, in the order they should be advertised.
 *
 * ⚠️ The factories are typed as `(taskComponent: TaskComponent) => Tool`, but
 * they only ever **duck-type** the 14 `TaskBackend` methods (see
 * `backend/types.ts` for the contract and why). Binding a `TaskBackend` is
 * therefore supported — that is exactly what `roy-bridge` already does.
 */
const TASK_TOOL_FACTORIES = [
  createTaskTool,
  treeTasksTool,
  getTaskTool,
  listTasksTool,
  searchTasksTool,
  updateTaskTool,
  completeTaskTool,
  // Task #5073/#5078 — 两阶段验收：executor 提交待验证（status=to_validate）
  preCompleteTaskTool,
  createOperationTool,
  listOperationsTool,
] as unknown as ReadonlyArray<(backend: TaskBackend) => {
  name: string;
  description: string;
  parameters?: unknown;
  execute: (args: unknown, ctx: Record<string, unknown>) => Promise<unknown>;
}>;

/**
 * Convert a zod schema (v3) into a JSON Schema document.
 *
 * MCP requires a **JSON Schema document**, not a zod object. roy's
 * `task_operation_create` / `task_operation_list` use `ZodEffects`
 * (preprocess + transform), so the inner schema is unwrapped first.
 *
 * Fault-isolated: a conversion failure degrades to `{}` (the tool advertises
 * no parameters) rather than breaking server startup.
 */
export function toJsonSchemaDocument(parameters: unknown): Record<string, unknown> {
  const p = parameters as { shape?: unknown; _def?: { schema?: unknown } } | null;
  if (!p) return {};
  const target = p.shape ? p : (p._def?.schema ?? p);
  try {
    const doc = zodToJsonSchema(target as never, {
      target: "jsonSchema7",
      $refStrategy: "none",
      effectStrategy: "input",
    }) as Record<string, unknown>;
    const { $schema: _ignored, ...rest } = doc;
    return { type: "object", properties: {}, ...rest };
  } catch {
    return { type: "object", properties: {} };
  }
}

/**
 * Build the MCP tool definitions for a backend.
 *
 * The descriptions and parameter schemas come from **core's own tool
 * factories** — a host never has to hand-write them.
 */
export function createTaskMcpToolDefinitions(backend: TaskBackend): TaskMcpToolDefinition[] {
  return TASK_TOOL_FACTORIES.map((factory) => {
    const tool = factory(backend);
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: toJsonSchemaDocument(tool.parameters),
    };
  });
}

// ============================================================================
// Server
// ============================================================================

/** Negotiate a protocol version, falling back to our default. */
export function negotiateTaskMcpProtocolVersion(requested?: string): string {
  if (requested && TASK_MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
    return requested;
  }
  return TASK_MCP_DEFAULT_PROTOCOL_VERSION;
}

function toolErrorText(message: string): Record<string, unknown> {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

/**
 * Create a task MCP server bound to a `TaskBackend`.
 *
 * The returned handle is transport-agnostic: the host decides how bytes get
 * in and out (stdio for Claude Code, an HTTP/SSE transport, a socket, …).
 */
export function createTaskMcpServer(
  backend: TaskBackend,
  options: TaskMcpServerOptions = {},
): TaskMcpServer {
  const name = options.name ?? "roy-task";
  const version = options.version ?? "1.0.0";
  const toolDefs = createTaskMcpToolDefinitions(backend);
  const byName = new Map(toolDefs.map((d) => [d.name, d]));

  const callTool = async (toolName: string, args: Record<string, unknown>): Promise<unknown> => {
    const factory = TASK_TOOL_FACTORIES.find((f) => f(backend).name === toolName);
    if (!factory) {
      throw new Error(`unknown tool: ${toolName}`);
    }
    const tool = factory(backend);
    const ctx: Record<string, unknown> = {
      session_id: options.sessionId ?? "unknown",
      workdir: options.workdir,
    };
    const result = await tool.execute(args ?? {}, ctx);
    // Core tools return `{ success, output?, error? }`.
    const r = result as { success?: boolean; output?: unknown; error?: string };
    if (r && r.success === false) {
      throw new Error(r.error ?? `tool "${toolName}" failed`);
    }
    return r && "output" in r ? r.output : result;
  };

  const handleRequest = async (request: TaskMcpRequest): Promise<TaskMcpResponse | null> => {
    const { id, method, params } = request;

    // Notifications have no id and must not be answered.
    if (id === undefined || id === null) {
      return null;
    }

    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: negotiateTaskMcpProtocolVersion(
              typeof requested === "string" ? requested : undefined,
            ),
            capabilities: { tools: {} },
            serverInfo: { name, version },
          },
        };
      }

      /**
       * `server/discover` — Claude Code 2.1.285's pre-handshake probe.
       *
       * A server that answers `-32601 Method not found` is treated by
       * 2.1.285 as **failed to connect** and the whole MCP server is dropped.
       * (Measured by the plugin before this module existed.)
       */
      case "server/discover": {
        const meta = params?._meta as Record<string, unknown> | undefined;
        const requested = meta?.["io.modelcontextprotocol/protocolVersion"];
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: negotiateTaskMcpProtocolVersion(
              typeof requested === "string" ? requested : undefined,
            ),
            capabilities: { tools: {} },
            serverInfo: { name, version },
          },
        };
      }

      case "ping":
        return { jsonrpc: "2.0", id, result: {} };

      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: toolDefs } };

      case "tools/call": {
        const toolName = params?.name;
        const args = (params?.arguments as Record<string, unknown>) || {};
        if (typeof toolName !== "string") {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: TASK_MCP_JSON_RPC_ERRORS.INVALID_PARAMS,
              message: "tools/call requires a tool name",
            },
          };
        }
        if (!byName.has(toolName)) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: TASK_MCP_JSON_RPC_ERRORS.INVALID_PARAMS,
              message: `unknown tool: ${toolName}`,
            },
          };
        }
        // A tool failure is a **tool-level** error (isError), not a protocol
        // error — the host can still show the message to the model.
        try {
          const value = await callTool(toolName, args);
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify(value ?? null, null, 2) }],
            },
          };
        } catch (err) {
          const message =
            err instanceof Error ? err.message : `tool "${toolName}" failed: ${String(err)}`;
          return {
            jsonrpc: "2.0",
            id,
            result: toolErrorText(message),
          };
        }
      }

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: TASK_MCP_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
            message: `method not found: ${method}`,
          },
        };
    }
  };

  return {
    handleRequest,
    listTools: () => toolDefs,
    callTool,
  };
}
