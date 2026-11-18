/**
 * @fileoverview Tests for session-id validation helper (TDD for Issue #8)
 *
 * Verifies that `isValidSessionId` accepts well-formed session ids and
 * rejects everything else — including the empty string, overly long strings,
 * control characters, shell metacharacters, and non-strings.
 */

import { describe, it, expect } from "bun:test";
import {
  isValidSessionId,
  MIN_SESSION_ID_LENGTH,
  MAX_SESSION_ID_LENGTH,
} from "./session-id";

describe("isValidSessionId (Issue #8 — ROY_PARENT_SESSION_ID validation)", () => {
  describe("accepts well-formed ids", () => {
    it("accepts a session_ prefixed UUID", () => {
      expect(isValidSessionId("session_abc12345-1234-1234-1234-1234567890ab")).toBe(true);
    });

    it("accepts a run_ prefixed id", () => {
      expect(isValidSessionId("run_1234567890_1_xyz")).toBe(true);
    });

    it("accepts an agent_ prefixed id", () => {
      expect(isValidSessionId("agent_test-node_1234567890")).toBe(true);
    });

    it("accepts ids at the length boundaries", () => {
      const minLen = "x".repeat(MIN_SESSION_ID_LENGTH);
      const maxLen = "x".repeat(MAX_SESSION_ID_LENGTH);
      expect(isValidSessionId(minLen)).toBe(true);
      expect(isValidSessionId(maxLen)).toBe(true);
    });
  });

  describe("rejects malformed ids", () => {
    it("rejects empty string", () => {
      expect(isValidSessionId("")).toBe(false);
    });

    it("rejects null and undefined", () => {
      expect(isValidSessionId(null)).toBe(false);
      expect(isValidSessionId(undefined)).toBe(false);
    });

    it("rejects too-short ids", () => {
      expect(isValidSessionId("a")).toBe(false);
      expect(isValidSessionId("abc1234")).toBe(false); // 7 chars
    });

    it("rejects too-long ids", () => {
      const tooLong = "x".repeat(MAX_SESSION_ID_LENGTH + 1);
      expect(isValidSessionId(tooLong)).toBe(false);
    });

    it("rejects strings with spaces", () => {
      expect(isValidSessionId("session_abc 12345678")).toBe(false);
      expect(isValidSessionId(" session_abc123")).toBe(false);
      expect(isValidSessionId("session_abc123 ")).toBe(false);
    });

    it("rejects strings with control characters", () => {
      expect(isValidSessionId("session_abc\x0012345")).toBe(false);
      expect(isValidSessionId("session_abc\n12345")).toBe(false);
      expect(isValidSessionId("session_abc\t12345")).toBe(false);
    });

    it("rejects shell metacharacters", () => {
      expect(isValidSessionId("session_abc;rm -rf")).toBe(false);
      expect(isValidSessionId("session_abc&whoami")).toBe(false);
      expect(isValidSessionId("session_abc`whoami`")).toBe(false);
      expect(isValidSessionId("session_abc$(whoami)")).toBe(false);
      expect(isValidSessionId("session_abc|whoami")).toBe(false);
    });

    it("rejects path separators and dots", () => {
      expect(isValidSessionId("../../etc/passwd")).toBe(false);
      expect(isValidSessionId("session_abc.123")).toBe(false);
      expect(isValidSessionId("session_abc/123")).toBe(false);
    });

    it("rejects non-string inputs", () => {
      expect(isValidSessionId(123456789)).toBe(false);
      expect(isValidSessionId({ id: "session_abc12345678" })).toBe(false);
      expect(isValidSessionId(["session_abc12345678"])).toBe(false);
      expect(isValidSessionId(true)).toBe(false);
    });
  });
});
