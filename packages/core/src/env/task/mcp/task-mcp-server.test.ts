/**
 * Task #4619 — RED test: core must own a reusable **task MCP server**.
 *
 * Before this change:
 * - `roy-bot-core` had **no MCP server** at all — only an MCP *client*
 *   (`packages/core/src/env/mcp/*`).
 * - The `roy-plugin-for-agent` project therefore had to hand-roll one in
 *   `claude/mcp/roy-task-mcp-server.mjs` (281 lines) plus a **second**
 *   re-implementation of the task semantics in `claude/mcp/bridge.mjs`
 *   (482 lines of raw SQL against the roy task store).
 *
 * The point of this module is that *any* MCP-speaking host (Claude Code,
 * Codex, opencode, a future VS Code extension) can get roy's task tools over
 * MCP **without re-implementing the semantics** — it just binds a
 * `TaskBackend` and gets the tool surface for free.
 */

import { describe, expect, test } from "bun:test";
import {
  createTaskMcpServer,
  createTaskMcpToolDefinitions,
  TASK_MCP_TOOL_NAMES,
  type TaskMcpServerOptions,
  type TaskMcpToolDefinition,
} from "./index";
import type { TaskBackend } from "../backend/types";

// ── A minimal in-memory TaskBackend stub ──────────────────────────────────
// Only the methods the tool surface touches are stubbed; the tests below
// assert the *shape* of the public surface, not the semantics (those are
// already covered by `backend/task-store-backend.test.ts`).

function makeStubBackend(): TaskBackend {
  const noop = async () => null;
  return {
    createTask: async () => ({ id: 1 }) as never,
    getTask: noop as never,
    getTaskWithOperations: noop as never,
    listTasks: async () => ({ tasks: [], total: 0 }) as never,
    updateTask: noop as never,
    deleteTask: async () => false,
    completeTask: noop as never,
    getTaskTree: async () => [],
    searchTasksByKeywords: async () => ({ tasks: [], total: 0 }) as never,
    createOperation: async () => ({ id: 1 }) as never,
    listOperations: async () => [],
    getOperation: noop as never,
    updateOperation: noop as never,
    deleteOperation: async () => false,
  } as unknown as TaskBackend;
}

describe("Task #4619: core owns a reusable task MCP server", () => {
  test("the tool-name list covers the task lifecycle", () => {
    // These are the tools the plugin's hand-rolled MCP server exposes.
    for (const name of [
      "task_tree",
      "task_create",
      "task_get",
      "task_list",
      "task_update",
      "task_complete",
      "task_search",
      "task_operation_create",
    ]) {
      expect(TASK_MCP_TOOL_NAMES).toContain(name as never);
    }
  });

  test("tool definitions are derived from core's own tool factories", () => {
    const defs: TaskMcpToolDefinition[] = createTaskMcpToolDefinitions(makeStubBackend());
    expect(defs.length).toBeGreaterThanOrEqual(8);

    const names = defs.map((d) => d.name);
    expect(names).toContain("task_create");
    expect(names).toContain("task_tree");

    for (const def of defs) {
      expect(typeof def.name).toBe("string");
      expect(typeof def.description).toBe("string");
      expect(def.description.length).toBeGreaterThan(0);
      // JSON Schema document (not a zod object) — MCP requires JSON Schema.
      expect(typeof def.inputSchema).toBe("object");
      expect((def.inputSchema as { type?: string }).type).toBe("object");
    }
  });

  test("server exposes initialize / tools/list / tools/call handling", async () => {
    const server = createTaskMcpServer(makeStubBackend());

    // initialize
    const init = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(init).not.toBeNull();
    expect(init?.result?.serverInfo?.name).toBeTruthy();
    expect(init?.result?.protocolVersion).toBeTruthy();

    // tools/list
    const list = await server.handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (list?.result as { tools?: unknown[] } | undefined)?.tools;
    expect(Array.isArray(tools)).toBe(true);
    expect((tools as unknown[]).length).toBeGreaterThanOrEqual(8);

    // tools/call — a real call must go through the backend, not the server.
    const call = await server.handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "task_get", arguments: { task_id: 1 } },
    });
    expect(call).not.toBeNull();
    expect(call?.error).toBeUndefined();
    expect(Array.isArray(call?.result?.content)).toBe(true);
  });

  test("tools/call with an unknown tool returns an error, not a crash", async () => {
    const server = createTaskMcpServer(makeStubBackend());
    const call = await server.handleRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "task_does_not_exist", arguments: {} },
    });
    expect(call?.error).toBeDefined();
    expect(call?.error?.code).toBe(-32602);
  });

  test("a failing backend surfaces as a tool error, never an exception", async () => {
    const backend = makeStubBackend();
    // Task #4619 (M-2): `task_get` now defaults to `include_operations:
    // true`, so the tool calls `getTaskWithOperations` — that is the method
    // that has to fail. Overriding only `getTask` would leave the failing
    // path untouched and the test would assert on the wrong branch.
    backend.getTaskWithOperations = async () => {
      throw new Error("db exploded");
    };
    const server = createTaskMcpServer(backend);
    const call = await server.handleRequest({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "task_get", arguments: { task_id: 1 } },
    });
    expect(call?.error).toBeUndefined(); // tool-level error, not protocol error
    const text = (call?.result?.content as { text?: string }[] | undefined)?.[0]?.text ?? "";
    expect(text).toContain("db exploded");
  });

  test("a failing backend surfaces as a tool error on the lean path too", async () => {
    // The opt-out (`include_operations: false`) must fail the same way —
    // otherwise one of the two paths would throw an exception out of the
    // MCP handler instead of turning it into a tool-level error.
    const backend = makeStubBackend();
    backend.getTask = async () => {
      throw new Error("db exploded");
    };
    const server = createTaskMcpServer(backend);
    const call = await server.handleRequest({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "task_get", arguments: { task_id: 1, include_operations: false } },
    });
    expect(call?.error).toBeUndefined();
    const text = (call?.result?.content as { text?: string }[] | undefined)?.[0]?.text ?? "";
    expect(text).toContain("db exploded");
  });

  test("notifications (no id) get no response", async () => {
    const server = createTaskMcpServer(makeStubBackend());
    expect(await server.handleRequest({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });

  test("server name / version are configurable", async () => {
    const opts: TaskMcpServerOptions = {
      name: "my-task-server",
      version: "9.9.9",
    };
    const server = createTaskMcpServer(makeStubBackend(), opts);
    const init = await server.handleRequest({ jsonrpc: "2.0", id: 6, method: "initialize" });
    expect(init?.result?.serverInfo?.name).toBe("my-task-server");
    expect(init?.result?.serverInfo?.version).toBe("9.9.9");
  });
});
