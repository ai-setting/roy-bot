import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { setToolConfigComponent, getMaxOutputSize, truncateOutput } from "./tool-component";
import type { ToolComponent } from "./tool-component";
import type { ToolResultMetadata, ToolMetadata } from "./types";

// ========================================================================
// Test Suite: Tool Output Truncation
// ========================================================================

describe("Tool Output Truncation", () => {
  // ========================================================================
  // getMaxOutputSize Tests
  // ========================================================================
  describe("getMaxOutputSize", () => {
    afterEach(() => {
      setToolConfigComponent(null);
    });

    test("should return default value 5120 when no config", () => {
      setToolConfigComponent(null);
      expect(getMaxOutputSize()).toBe(5120);
    });

    test("should read maxOutputSize from config component", () => {
      const mockConfig = {
        get: vi.fn((key: string) => {
          if (key === "tool.execution.maxOutputSize") return 50000;
          return undefined;
        }),
      };
      setToolConfigComponent(mockConfig as any);
      expect(getMaxOutputSize()).toBe(50000);
    });

    test("should return default for invalid config (string)", () => {
      const mockConfig = {
        get: vi.fn(() => "invalid"),
      };
      setToolConfigComponent(mockConfig as any);
      expect(getMaxOutputSize()).toBe(5120);
    });

    test("should return default for invalid config (negative)", () => {
      const mockConfig = {
        get: vi.fn(() => -100),
      };
      setToolConfigComponent(mockConfig as any);
      expect(getMaxOutputSize()).toBe(5120);
    });

    test("should return 0 when config is 0 (disabled)", () => {
      const mockConfig = {
        get: vi.fn(() => 0),
      };
      setToolConfigComponent(mockConfig as any);
      expect(getMaxOutputSize()).toBe(0);
    });
  });

  // ========================================================================
  // truncateOutput Tests
  // ========================================================================
  describe("truncateOutput", () => {
    test("should not truncate when under limit", () => {
      const result = truncateOutput("short output", 1000);
      expect(result.output).toBe("short output");
      expect(result.metadata.output_truncated).toBeUndefined();
      expect(result.metadata.original_output_size).toBeUndefined();
    });

    test("should not truncate when exactly at limit", () => {
      const output = "exactly 10";
      const result = truncateOutput(output, 10);
      expect(result.output).toBe(output);
      expect(result.metadata.output_truncated).toBeUndefined();
    });

    test("should truncate when over limit", () => {
      const longOutput = "a".repeat(1000);
      const result = truncateOutput(longOutput, 100);

      expect(result.output.length).toBeLessThan(1000);
      expect(result.output).toContain("[OUTPUT TRUNCATED:");
      expect(result.output).toContain("1000 → 100");
      expect(result.metadata.output_truncated).toBe(true);
      expect(result.metadata.original_output_size).toBe(1000);
      expect(result.metadata.truncated_output_size).toBe(100);
    });

    test("should not truncate when maxSize is 0 (disabled)", () => {
      const longOutput = "a".repeat(1000);
      const result = truncateOutput(longOutput, 0);
      expect(result.output).toBe(longOutput);
      expect(result.metadata.output_truncated).toBeUndefined();
    });

    test("should include helpful message in truncation notice", () => {
      const longOutput = "x".repeat(500);
      const result = truncateOutput(longOutput, 50);

      expect(result.output).toContain("characters");
      expect(result.output).toContain("Use offset/limit parameters or pipe to file");
    });

    test("should handle empty string", () => {
      const result = truncateOutput("", 100);
      expect(result.output).toBe("");
      expect(result.metadata.output_truncated).toBeUndefined();
    });

    test("should handle single character over limit", () => {
      const result = truncateOutput("a", 0);
      expect(result.output).toBe("a");
      expect(result.metadata.output_truncated).toBeUndefined();
    });
  });

  // ========================================================================
  // ToolResultMetadata Truncation Fields Tests
  // ========================================================================
  describe("ToolResultMetadata truncation fields", () => {
    test("should accept output_truncated field", () => {
      const metadata: ToolResultMetadata = {
        execution_time_ms: 100,
        output_truncated: true,
      };
      expect(metadata.output_truncated).toBe(true);
    });

    test("should accept original_output_size field", () => {
      const metadata: ToolResultMetadata = {
        execution_time_ms: 100,
        original_output_size: 5000,
      };
      expect(metadata.original_output_size).toBe(5000);
    });

    test("should accept truncated_output_size field", () => {
      const metadata: ToolResultMetadata = {
        execution_time_ms: 100,
        truncated_output_size: 1000,
      };
      expect(metadata.truncated_output_size).toBe(1000);
    });

    test("should accept all truncation fields together", () => {
      const metadata: ToolResultMetadata = {
        execution_time_ms: 100,
        output_truncated: true,
        original_output_size: 5000,
        truncated_output_size: 1000,
      };
      expect(metadata.output_truncated).toBe(true);
      expect(metadata.original_output_size).toBe(5000);
      expect(metadata.truncated_output_size).toBe(1000);
    });
  });

  // ========================================================================
  // ToolMetadata.skipTruncation Contract (RED #1 — type-level opt-in flag)
  // ========================================================================
  describe("ToolMetadata.skipTruncation", () => {
    test("accepts an explicit truncation opt-out flag", () => {
      // Author declares their tool returns metadata that must be returned in full.
      // The central ToolComponent path must honor this opt-in.
      const metadata: ToolMetadata = { skipTruncation: true };
      expect(metadata.skipTruncation).toBe(true);
    });

    test("omitting skipTruncation keeps the default truncation behavior", () => {
      // Authors who do not opt in must continue to see default truncation.
      const metadata: ToolMetadata = { category: "metadata" };
      expect(metadata.skipTruncation).toBeUndefined();
    });

    test("explicit false keeps the default truncation behavior", () => {
      const metadata: ToolMetadata = { skipTruncation: false };
      expect(metadata.skipTruncation).toBe(false);
    });
  });
});
