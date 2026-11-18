/**
 * Task #4619 — RED test: a **stdio MCP server** must not have anything but
 * JSON-RPC on stdout.
 *
 * ## The bug this pins
 *
 * Core's logger writes `info` to `console.log` — i.e. **stdout** — and the
 * task store's migrations print with `console.log` too.
 *
 * That is fine for `roy-bot act` (stdout is a human-facing stream). It is
 * **fatal** for an MCP server: the MCP stdio transport is newline-delimited
 * JSON-RPC on stdout, and a single stray line makes the client drop the
 * server. Claude Code reports it as
 * `mcp_servers: [{"name":"plugin:roy-task:roy-task","status":"failed"}]`.
 *
 * Measured on the plugin's own MCP server after it was thinned to call
 * core's `createTaskMcpServer` (Task #4619): **24 of 26 stdout lines were
 * not JSON** — the 5 migration banners plus core's `[INFO] …` trace lines.
 * The two JSON-RPC responses were the only valid lines.
 *
 * ## The fix
 *
 * Core must provide a **supported way** to send its diagnostics to stderr
 * (or nowhere), so a stdio host can guarantee a clean stdout.
 *
 * Two mechanisms, both in core:
 *
 * 1. `setQuietMode(true)` — already exists: logs go to the log file only,
 *    nothing reaches the console. That is the right switch for an MCP
 *    server, but it also silences **stderr**, which is where a server's
 *    diagnostics belong.
 * 2. A **stdout-strict** mode: `info`/`debug` go to stderr instead of
 *    stdout, while `warn`/`error` keep going to stderr too. stdout is then
 *    reserved for the protocol.
 *
 * This test pins mechanism (2), because it is the one that keeps the
 * diagnostics useful.
 */

import { describe, expect, test } from "bun:test";
import {
  setQuietMode,
  isQuietMode,
  setStdoutStrictMode,
  isStdoutStrictMode,
} from "./logger";

describe("Task #4619: core's logger can keep stdout clean for a stdio host", () => {
  test("quiet mode is available (logs go to the file only)", () => {
    const original = isQuietMode();
    try {
      setQuietMode(true);
      expect(isQuietMode()).toBe(true);
    } finally {
      setQuietMode(original);
    }
  });

  test("stdout-strict mode is available and toggles", () => {
    const original = isStdoutStrictMode();
    try {
      setStdoutStrictMode(true);
      expect(isStdoutStrictMode()).toBe(true);
      setStdoutStrictMode(false);
      expect(isStdoutStrictMode()).toBe(false);
    } finally {
      setStdoutStrictMode(original);
    }
  });

  test("in stdout-strict mode, an info log does NOT reach stdout", () => {
    const originalQuiet = isQuietMode();
    const originalStrict = isStdoutStrictMode();
    const written: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    try {
      setQuietMode(false);
      setStdoutStrictMode(true);
      console.log = (...args: unknown[]) => {
        written.push(args.map(String).join(" "));
      };
      console.error = () => {
        /* stderr sink — ignored on purpose */
      };

      // Import lazily so the logger picks up the current mode.
      const { createLogger } = require("./logger") as {
        createLogger: (prefix: string) => { info: (m: string) => void };
      };
      createLogger("task:stdio-probe").info("this must not hit stdout");

      expect(written).toEqual([]);
    } finally {
      console.log = originalLog;
      console.error = originalError;
      setQuietMode(originalQuiet);
      setStdoutStrictMode(originalStrict);
    }
  });
});
