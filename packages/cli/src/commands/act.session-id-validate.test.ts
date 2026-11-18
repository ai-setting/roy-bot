/**
 * @fileoverview act.ts session-id validation tests
 *
 * Task #2843 v2: `roy-bot act` now accepts any well-formed user-provided
 * sessionId (e.g. `ts_session_<uuid>` minted by task-show) and creates a
 * new session with that id on first use. Malformed ids are rejected with
 * a warning and the CLI falls back to a randomly generated id.
 *
 * The validation regex lives inline in `act.ts` (and is mirrored by
 * `server.ts#handleChatStart` for the same reason). These tests pin
 * the format boundary so both sides stay in lock-step.
 *
 * ## Cases
 *
 *   Case 1 — valid `ts_session_<uuid>` → accepted
 *   Case 2 — valid `task-<id>`         → accepted
 *   Case 3 — empty string              → rejected
 *   Case 4 — id with spaces            → rejected
 *   Case 5 — id with semicolon (shell) → rejected
 *   Case 6 — id with slash             → rejected
 *   Case 7 — id with dot               → rejected
 *   Case 8 — id length 129             → rejected (max 128)
 *   Case 9 — id length 128             → accepted
 *   Case 10 — id with hyphen + digits  → accepted
 */

import { describe, test, expect } from "bun:test";

/**
 * Mirrors the regex baked into act.ts (and server.ts#handleChatStart).
 * If you change the regex, change BOTH call sites and update these
 * tests. The duplicate is intentional — neither side depends on the
 * other at runtime, but the validator contract is shared.
 */
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

function isValidTaskShowSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

describe("act #2843 v2: sessionId validation (shared contract)", () => {
  test("Case 1: ts_session_<uuid> is accepted", () => {
    expect(isValidTaskShowSessionId("ts_session_8c4c3ced3a8749daa475f0bd35344d57")).toBe(true);
  });

  test("Case 2: task-<id> is accepted", () => {
    expect(isValidTaskShowSessionId("task-12345")).toBe(true);
  });

  test("Case 3: empty string is rejected", () => {
    expect(isValidTaskShowSessionId("")).toBe(false);
  });

  test("Case 4: id with spaces is rejected", () => {
    expect(isValidTaskShowSessionId("bad id")).toBe(false);
    expect(isValidTaskShowSessionId(" session")).toBe(false);
    expect(isValidTaskShowSessionId("session ")).toBe(false);
  });

  test("Case 5: id with semicolon (shell-injection vector) is rejected", () => {
    expect(isValidTaskShowSessionId("bad;id")).toBe(false);
    expect(isValidTaskShowSessionId("a;b")).toBe(false);
  });

  test("Case 6: id with slash is rejected", () => {
    expect(isValidTaskShowSessionId("path/to/x")).toBe(false);
    expect(isValidTaskShowSessionId("a/b")).toBe(false);
  });

  test("Case 7: id with dot is rejected", () => {
    expect(isValidTaskShowSessionId("dot.in.id")).toBe(false);
  });

  test("Case 8: id of length 129 is rejected (boundary)", () => {
    const id = "a".repeat(129);
    expect(isValidTaskShowSessionId(id)).toBe(false);
  });

  test("Case 9: id of length 128 is accepted (boundary)", () => {
    const id = "a".repeat(128);
    expect(isValidTaskShowSessionId(id)).toBe(true);
  });

  test("Case 10: hyphen + digits is accepted", () => {
    expect(isValidTaskShowSessionId("a-b-c-1-2-3")).toBe(true);
  });
});