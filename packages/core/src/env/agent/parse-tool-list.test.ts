/**
 * @fileoverview Unit tests for parseToolList helper
 *
 * 覆盖目标 (Task #2024 follow-up)：
 * parseToolList() 必须正确处理以下 4 种输入：
 *   1. undefined / null → undefined (no filter)
 *   2. string[] → 原样返回
 *   3. string → split(',') + trim + filter empty
 *   4. 其他类型 → undefined (defensive)
 *
 * 这是 env-path substring bug 的核心防御：env 来源的 raw string 必须被 split。
 */

import { describe, it, expect } from "vitest";
import { parseToolList } from "./agent-component";

describe("parseToolList helper (Task #2024 follow-up)", () => {
  // ==========================================================================
  // undefined / null — no filter
  // ==========================================================================
  describe("undefined / null input", () => {
    it("undefined → undefined", () => {
      expect(parseToolList(undefined)).toBeUndefined();
    });

    it("null → undefined", () => {
      expect(parseToolList(null)).toBeUndefined();
    });
  });

  // ==========================================================================
  // Array input — pass through
  // ==========================================================================
  describe("Array input", () => {
    it("non-empty string array → same array", () => {
      expect(parseToolList(["tool_a", "tool_b"])).toEqual(["tool_a", "tool_b"]);
    });

    it("single-element array → same single element", () => {
      expect(parseToolList(["tool_a"])).toEqual(["tool_a"]);
    });

    it("empty array → undefined (treated as no filter)", () => {
      expect(parseToolList([])).toBeUndefined();
    });

    it("array with non-string entries → filter to only strings", () => {
      // 防御：即使 array 中混入非 string，也只保留 string 部分
      expect(parseToolList(["tool_a", 123, null, "tool_b"] as unknown[])).toEqual(["tool_a", "tool_b"]);
    });
  });

  // ==========================================================================
  // String input — split + trim + filter empty
  // ==========================================================================
  describe("String input", () => {
    it("single value 'tool_a' → ['tool_a']", () => {
      expect(parseToolList("tool_a")).toEqual(["tool_a"]);
    });

    it("comma-separated 'tool_a,tool_b' → ['tool_a', 'tool_b']", () => {
      expect(parseToolList("tool_a,tool_b")).toEqual(["tool_a", "tool_b"]);
    });

    it("with spaces 'tool_a, tool_b' → ['tool_a', 'tool_b'] (trim)", () => {
      expect(parseToolList("tool_a, tool_b")).toEqual(["tool_a", "tool_b"]);
    });

    it("trailing comma 'tool_a,tool_b,' → ['tool_a', 'tool_b'] (filter empty)", () => {
      expect(parseToolList("tool_a,tool_b,")).toEqual(["tool_a", "tool_b"]);
    });

    it("leading comma ',tool_a,tool_b' → ['tool_a', 'tool_b'] (filter empty)", () => {
      expect(parseToolList(",tool_a,tool_b")).toEqual(["tool_a", "tool_b"]);
    });

    it("only commas ',,,' → undefined (no real values)", () => {
      expect(parseToolList(",,,")).toBeUndefined();
    });

    it("only spaces ' , , ' → undefined (no real values)", () => {
      expect(parseToolList(" , , ")).toBeUndefined();
    });

    it("empty string '' → undefined", () => {
      expect(parseToolList("")).toBeUndefined();
    });

    it("only whitespace '   ' → undefined (trim then filter empty)", () => {
      expect(parseToolList("   ")).toBeUndefined();
    });

    it("real env example 'tool_a, tool_b' (with single space) → trims correctly", () => {
      // 真实场景：env 变量值可能含空格（手敲或 shell 解析）
      expect(parseToolList("tool_a, tool_b")).toEqual(["tool_a", "tool_b"]);
    });

    it("three values 'a, b, c' with spaces → ['a', 'b', 'c']", () => {
      expect(parseToolList("a, b, c")).toEqual(["a", "b", "c"]);
    });
  });

  // ==========================================================================
  // 其他类型 — 防御返回 undefined
  // ==========================================================================
  describe("Defensive: unsupported input types", () => {
    it("number → undefined", () => {
      expect(parseToolList(42)).toBeUndefined();
    });

    it("boolean → undefined", () => {
      expect(parseToolList(true)).toBeUndefined();
    });

    it("object → undefined", () => {
      expect(parseToolList({ foo: "bar" })).toBeUndefined();
    });
  });
});
