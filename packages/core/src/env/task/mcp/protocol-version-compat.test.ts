/**
 * Task #4622 — RED test: core must keep accepting the MCP protocol version
 * `2025-11-25`.
 *
 * ## Why this test exists
 *
 * Task #4619 moved the MCP wire contract into core
 * (`TASK_MCP_SUPPORTED_PROTOCOL_VERSIONS`). When it did, the list was
 * copied **without** the newest entry — `2025-11-25` — so the list only
 * started at `2025-06-18`.
 *
 * That matters because:
 *
 * 1. The MCP SDK this repo depends on (`@modelcontextprotocol/sdk@1.29.0`)
 *    declares:
 *
 *        export const LATEST_PROTOCOL_VERSION = '2025-11-25';
 *
 *    A modern client asks for exactly that.
 *
 * 2. The **previously published** plugin (`@ai-setting/roy-task-plugin@0.6.1`)
 *    listed `2025-11-25` as its **first** supported version and used it as
 *    its `DEFAULT_PROTOCOL_VERSION`:
 *
 *        export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
 *          "2025-11-25",
 *          "2025-06-18",
 *          ...
 *        ]);
 *        export const DEFAULT_PROTOCOL_VERSION = "2025-11-25";
 *
 *    So core 1.7.61 + plugin 0.7.0 would **regress** the negotiated
 *    protocol version relative to the plugin release users already run.
 *
 * This was flagged as MINOR-3 in the Task #4619 cross-validation, but it is
 * release-relevant: shipping it would silently downgrade the handshake.
 */

import { describe, expect, test } from "bun:test";
import {
  TASK_MCP_SUPPORTED_PROTOCOL_VERSIONS,
  TASK_MCP_DEFAULT_PROTOCOL_VERSION,
  negotiateTaskMcpProtocolVersion,
} from "./index";

describe("Task #4622: core keeps the newest MCP protocol version", () => {
  test("'2025-11-25' is in the supported list (the MCP SDK's LATEST)", () => {
    expect(TASK_MCP_SUPPORTED_PROTOCOL_VERSIONS).toContain("2025-11-25");
  });

  test("'2025-11-25' is the first entry (newest first, like the SDK)", () => {
    expect(TASK_MCP_SUPPORTED_PROTOCOL_VERSIONS[0]).toBe("2025-11-25");
  });

  test("the previously supported versions are still supported", () => {
    for (const v of ["2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"]) {
      expect(TASK_MCP_SUPPORTED_PROTOCOL_VERSIONS).toContain(v);
    }
  });

  test("a client asking for '2025-11-25' gets it echoed back", () => {
    expect(negotiateTaskMcpProtocolVersion("2025-11-25")).toBe("2025-11-25");
  });

  test("the default is '2025-11-25' (matches the published plugin 0.6.1)", () => {
    expect(TASK_MCP_DEFAULT_PROTOCOL_VERSION).toBe("2025-11-25");
  });

  test("an unknown version still falls back to the default", () => {
    expect(negotiateTaskMcpProtocolVersion("1999-01-01")).toBe(
      TASK_MCP_DEFAULT_PROTOCOL_VERSION,
    );
  });
});
