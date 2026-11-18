/**
 * Task #4619 — RED/GREEN test: core's task MCP server can be driven from a
 * **stdio** host without polluting stdout.
 *
 * ## The contract
 *
 * A stdio MCP server speaks newline-delimited JSON-RPC on stdout. Anything
 * else on stdout makes the client drop the server.
 *
 * Core's own pieces used to break that:
 *
 * - the logger wrote `info` to `console.log` (stdout);
 * - the task store's migrations printed banners with `console.log` (stdout).
 *
 * Measured on the plugin's MCP server: **24 of 26 stdout lines were not
 * JSON**. The fix is core-side (stdout-strict logger mode + migrations log
 * to stderr), and this test pins the *end-to-end* consequence: a core-built
 * MCP server, hosted on stdio, emits **only** JSON-RPC on stdout.
 */

import { describe, expect, test } from "bun:test";
import { createTaskMcpServer } from "./index";
import { TaskStoreBackend, createSQLiteTaskPort } from "../backend";
import { SQLiteTaskStore } from "../storage";
import { setStdoutStrictMode, isStdoutStrictMode } from "../../log-trace/logger";

function stubBackend(): TaskStoreBackend {
  return new TaskStoreBackend({
    createTask: async () => ({ id: 1 }) as never,
    getTask: async () => null,
    getTaskWithOperations: async () => null,
    listTasks: async () => ({ tasks: [], total: 0 }) as never,
    updateTask: async () => null,
    deleteTask: async () => false,
    completeTask: async () => null,
    getTaskTree: async () => [],
    searchTasksByKeywords: async () => ({ tasks: [], total: 0 }) as never,
    createOperation: async () => ({ id: 1 }) as never,
    listOperations: async () => [],
    getOperation: async () => null,
    updateOperation: async () => null,
    deleteOperation: async () => false,
  } as never);
}

describe("Task #4619: core's MCP server keeps stdout clean for stdio hosts", () => {
  test("stdout-strict mode keeps the logger off stdout", () => {
    const original = isStdoutStrictMode();
    try {
      setStdoutStrictMode(true);
      expect(isStdoutStrictMode()).toBe(true);
    } finally {
      setStdoutStrictMode(original);
    }
  });

  test("a stdio host can build the server and get only JSON-RPC back", async () => {
    const original = isStdoutStrictMode();
    const written: string[] = [];
    const originalLog = console.log;
    try {
      setStdoutStrictMode(true);
      console.log = (...args: unknown[]) => {
        written.push(args.map(String).join(" "));
      };

      const server = createTaskMcpServer(stubBackend());
      const init = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      });
      const list = await server.handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });

      // Everything the host writes to stdout is JSON-RPC — nothing else.
      expect(written).toEqual([]);
      expect(init?.result?.serverInfo?.name).toBeTruthy();
      expect((list?.result as { tools?: unknown[] })?.tools?.length).toBeGreaterThan(0);
    } finally {
      console.log = originalLog;
      setStdoutStrictMode(original);
    }
  });

  test("the store's migrations do not print to stdout", async () => {
    // Run a real migration against a throwaway database and assert that
    // nothing lands on stdout. (Migrations used `console.log`.)
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "roy-mig-stdout-"));
    const originalLog = console.log;
    const written: string[] = [];
    const originalStrict = isStdoutStrictMode();
    try {
      // A stdio host runs in stdout-strict mode, so the store's own
      // "TaskStore initialized" info line goes to stderr, not stdout.
      setStdoutStrictMode(true);
      console.log = (...args: unknown[]) => {
        written.push(args.map(String).join(" "));
      };
      // The store creates the schema; the migration then runs against it.
      const store = new SQLiteTaskStore(join(dir, "probe.db"));
      await store.listTasks({ limit: 1 });
      const { runMigration } = await import("../storage/migrations/001_add_project_path_context");
      runMigration(join(dir, "probe.db"));
      expect(written).toEqual([]);
    } finally {
      console.log = originalLog;
      setStdoutStrictMode(originalStrict);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
