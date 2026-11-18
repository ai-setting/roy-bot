/**
 * @fileoverview Tests for safeParseToolArgs utility function
 */
import { describe, test, expect } from "bun:test";
import { safeParseToolArgs } from "./tool-args-parser";

describe("safeParseToolArgs", () => {
  // ============ Normal object input ============
  test("should return object as-is when input is already an object", () => {
    const input = { key: "value", num: 42 };
    const result = safeParseToolArgs(input);
    expect(result).toBe(input); // Same reference
    expect(result).toEqual({ key: "value", num: 42 });
  });

  test("should return empty object for null input", () => {
    const result = safeParseToolArgs(null);
    expect(result).toEqual({});
  });

  // ============ Normal JSON string ============
  test("should parse a normal JSON string", () => {
    const result = safeParseToolArgs('{"cmd": "ls", "path": "/tmp"}');
    expect(result).toEqual({ cmd: "ls", path: "/tmp" });
  });

  test("should parse a JSON string with nested objects", () => {
    const result = safeParseToolArgs('{"user": {"name": "Alice", "age": 30}}');
    expect(result).toEqual({ user: { name: "Alice", age: 30 } });
  });

  test("should parse a JSON string with arrays", () => {
    const result = safeParseToolArgs('{"items": [1, 2, 3]}');
    expect(result).toEqual({ items: [1, 2, 3] });
  });

  test("should parse an empty JSON object string", () => {
    const result = safeParseToolArgs("{}");
    expect(result).toEqual({});
  });

  // ============ Double-stringified JSON ============
  test("should recursively parse double-stringified JSON", () => {
    // Simulate: LLM returns a JSON string whose value is another JSON string
    const inner = JSON.stringify({ cmd: "ls", path: "/tmp" });
    const outer = JSON.stringify(inner); // '"{\\"cmd\\":\\"ls\\",\\"path\\":\\"/tmp\\"}"'
    const result = safeParseToolArgs(outer);
    expect(result).toEqual({ cmd: "ls", path: "/tmp" });
  });

  test("should handle triple-stringified JSON", () => {
    const inner = JSON.stringify({ key: "value" });
    const middle = JSON.stringify(inner);
    const outer = JSON.stringify(middle);
    const result = safeParseToolArgs(outer);
    expect(result).toEqual({ key: "value" });
  });

  // ============ Invalid JSON string ============
  test("should return empty object for invalid JSON string (no _raw leak)", () => {
    const result = safeParseToolArgs("{invalid json}");
    expect(result).toEqual({});
    // Critical: no _raw property should leak
    expect(result).not.toHaveProperty("_raw");
  });

  test("should return empty object for malformed JSON", () => {
    const result = safeParseToolArgs("not-json-at-all");
    expect(result).toEqual({});
    expect(result).not.toHaveProperty("_raw");
  });

  test("should return empty object for empty string", () => {
    const result = safeParseToolArgs("");
    expect(result).toEqual({});
    expect(result).not.toHaveProperty("_raw");
  });

  // ============ Primitive inputs ============
  test("should return empty object for number input", () => {
    const result = safeParseToolArgs(42);
    expect(result).toEqual({});
  });

  test("should return empty object for boolean input", () => {
    const result = safeParseToolArgs(true);
    expect(result).toEqual({});
  });

  test("should return empty object for undefined input", () => {
    const result = safeParseToolArgs(undefined);
    expect(result).toEqual({});
  });

  // ============ Real-world scenarios ============
  test("should handle real-world MiniMax double-stringify scenario", () => {
    // MiniMax sometimes returns arguments as a string that is itself a JSON string
    // e.g., '{"task_id": 410, "action_type": "milestone"}' gets double-stringified
    const innerArgs = JSON.stringify({ task_id: 410, action_type: "milestone", action_title: "Test" });
    const doubleStringified = JSON.stringify(innerArgs);
    const result = safeParseToolArgs(doubleStringified);
    expect(result).toEqual({ task_id: 410, action_type: "milestone", action_title: "Test" });
    expect(result).not.toHaveProperty("_raw");
  });

  test("should handle already-parsed object from session storage", () => {
    // When reading from session storage, arguments is already an object
    const result = safeParseToolArgs({ task_id: 410, action_type: "milestone" });
    expect(result).toEqual({ task_id: 410, action_type: "milestone" });
  });

  test("should handle legacy string arguments from session data", () => {
    // Legacy session data may have arguments as a JSON string
    const result = safeParseToolArgs('{"cmd": "ls"}');
    expect(result).toEqual({ cmd: "ls" });
    expect(result).not.toHaveProperty("_raw");
  });

  test("should handle corrupted string arguments gracefully", () => {
    // Corrupted string that can't be parsed
    const result = safeParseToolArgs('{"task_id": 410, "action_type": "');
    expect(result).toEqual({});
    expect(result).not.toHaveProperty("_raw");
  });

  // ============ Array input (should not be treated as object) ============
  test("should return empty object for JSON array string", () => {
    // Tool arguments should be objects, not arrays
    const result = safeParseToolArgs('["a", "b", "c"]');
    expect(result).toEqual({});
    expect(result).not.toHaveProperty("_raw");
  });

  test("should return empty object for actual array input", () => {
    // If someone passes an array directly (shouldn't happen, but be safe)
    const result = safeParseToolArgs([1, 2, 3]);
    expect(result).toEqual({});
  });
});
