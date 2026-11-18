import { describe, test, expect, afterEach, vi } from "vitest";
import { z } from "zod";
import { setToolConfigComponent, truncateOutputInline } from "./tool-component";
import type { Tool, ToolResult } from "./types";

/**
 * Tests for the inline truncation helper used by the three bypass paths
 * (extraTools, fallback path, and workflow tool-node). Tests in this
 * file intentionally use real helper implementations rather than mocks
 * to keep the truncation contract honest.
 */
describe("TruncateOutputInline (bypass path coverage)", () => {
  afterEach(() => {
    setToolConfigComponent(null);
  });

  describe("basic behavior", () => {
    test("returns the original result when output is under limit and not a string", () => {
      const input: ToolResult = {
        success: true,
        output: { ok: true },
        metadata: { execution_time_ms: 5 },
      };
      const result = truncateOutputInline(input, 5120);
      // Non-string outputs are passed through unchanged.
      expect(result.output).toEqual({ ok: true });
      expect(result.metadata?.execution_time_ms).toBe(5);
      expect(result.metadata?.output_truncated).toBeUndefined();
    });

    test("does not mutate when output string fits within limit", () => {
      const input: ToolResult = {
        success: true,
        output: "short output",
        metadata: { execution_time_ms: 7 },
      };
      const result = truncateOutputInline(input, 5120);
      expect(result.output).toBe("short output");
      expect(result.metadata?.output_truncated).toBeUndefined();
    });

    test("truncates a string output that exceeds the limit", () => {
      const huge = "x".repeat(8000);
      const input: ToolResult = {
        success: true,
        output: huge,
        metadata: { execution_time_ms: 9 },
      };
      const result = truncateOutputInline(input, 1024);
      expect(typeof result.output).toBe("string");
      const truncated = result.output as string;
      expect(truncated.length).toBeLessThan(huge.length);
      expect(truncated).toContain("[OUTPUT TRUNCATED:");
      expect(result.metadata?.output_truncated).toBe(true);
      expect(result.metadata?.original_output_size).toBe(8000);
      expect(result.metadata?.truncated_output_size).toBe(1024);
    });

    test("preserves prior metadata fields while adding truncation metadata", () => {
      const input: ToolResult = {
        success: true,
        output: "y".repeat(2000),
        metadata: { execution_time_ms: 42 },
      };
      const result = truncateOutputInline(input, 100);
      expect(result.metadata?.execution_time_ms).toBe(42);
      expect(result.metadata?.output_truncated).toBe(true);
      expect(result.metadata?.original_output_size).toBe(2000);
    });

    test("skips truncation when limit is 0 (disabled)", () => {
      const huge = "z".repeat(8000);
      const input: ToolResult = {
        success: true,
        output: huge,
        metadata: { execution_time_ms: 1 },
      };
      const result = truncateOutputInline(input, 0);
      expect(result.output).toBe(huge);
      expect(result.metadata?.output_truncated).toBeUndefined();
    });

    test("handles error results with string error messages", () => {
      const bigError = "boom ".repeat(5000);
      const input: ToolResult = {
        success: false,
        output: "",
        error: bigError,
        metadata: { execution_time_ms: 3 },
      };
      const result = truncateOutputInline(input, 100);
      expect(result.success).toBe(false);
      expect((result.error as string).length).toBeLessThan(bigError.length);
      expect(result.error as string).toContain("[OUTPUT TRUNCATED:");
    });

    test("seeds execution_time_ms when source had no metadata", () => {
      const input: ToolResult = { success: true, output: "" };
      const result = truncateOutputInline(input, 10);
      expect(result.metadata?.execution_time_ms).toBe(0);
    });
  });

  describe("config component integration", () => {
    test("reads global maxOutputSize via config component when supplied", () => {
      setToolConfigComponent({
        get: vi.fn((key: string) =>
          key === "tool.execution.maxOutputSize" ? 64 : undefined
        ),
      } as any);

      const input: ToolResult = {
        success: true,
        output: "w".repeat(2000),
      };
      const result = truncateOutputInline(input);
      expect(result.metadata?.truncated_output_size).toBe(64);
    });

    test("falls back to default 5120 when no config is registered", () => {
      setToolConfigComponent(null);
      const input: ToolResult = {
        success: true,
        output: "v".repeat(8000),
      };
      const result = truncateOutputInline(input);
      expect(result.metadata?.truncated_output_size).toBe(5120);
    });
  });

  describe("per-tool override (forward compatible API)", () => {
    test("overrideMaxSize applies only when maxSize is not provided", () => {
      setToolConfigComponent(null);
      const huge = "p".repeat(60_000);
      const input: ToolResult = { success: true, output: huge, metadata: { execution_time_ms: 1 } };

      // Calling without an explicit maxSize: overrideMaxSize picks the cap.
      const withOverride = truncateOutputInline(input, undefined, 50_000);
      expect(withOverride.metadata?.output_truncated).toBe(true);
      expect(withOverride.metadata?.truncated_output_size).toBe(50_000);

      // Calling with an explicit maxSize: overrideMaxSize is ignored.
      const withExplicit = truncateOutputInline(input, 5_120, 50_000);
      expect(withExplicit.metadata?.truncated_output_size).toBe(5_120);
    });

    test("named tool (e.g. grep) gets its per-tool override cap when toolName is supplied", () => {
      setToolConfigComponent(null);
      // 30KB output: over the 5KB default but under the grep 50KB override.
      const input: ToolResult = {
        success: true,
        output: "x".repeat(30_000),
        metadata: { execution_time_ms: 1 },
      };

      // No toolName: honors the global default (5KB), so 30KB is truncated to 5120.
      const withoutName = truncateOutputInline(input);
      expect(withoutName.metadata?.truncated_output_size).toBe(5120);

      // With grep toolName: per-tool override (50KB) allows 30KB through untouched.
      const withGrep = truncateOutputInline(input, undefined, undefined, "grep");
      expect(withGrep.metadata?.output_truncated).toBeUndefined();
      expect((withGrep.output as string).length).toBe(30_000);
    });

    test("explicit maxSize takes precedence over the per-tool override", () => {
      setToolConfigComponent(null);
      const input: ToolResult = {
        success: true,
        output: "x".repeat(60_000),
        metadata: { execution_time_ms: 1 },
      };

      // Even with grep toolName, an explicit maxSize wins.
      const explicit = truncateOutputInline(input, 100, undefined, "grep");
      expect(explicit.metadata?.truncated_output_size).toBe(100);
    });

    test("read_file named tool honors its 200KB per-tool override", () => {
      setToolConfigComponent(null);
      // 100KB output: over the 5KB default but under the read_file 200KB
      // override.
      const input: ToolResult = {
        success: true,
        output: "x".repeat(100_000),
        metadata: { execution_time_ms: 1 },
      };

      const result = truncateOutputInline(input, undefined, undefined, "read_file");
      expect(result.metadata?.output_truncated).toBeUndefined();
      expect((result.output as string).length).toBe(100_000);
    });

    test("50KB output on grep IS truncated at the 50KB boundary", () => {
      setToolConfigComponent(null);
      // 60KB > 50KB grep cap, so it must truncate.
      const huge = "x".repeat(60_000);
      const input: ToolResult = {
        success: true,
        output: huge,
        metadata: { execution_time_ms: 1 },
      };

      const result = truncateOutputInline(input, undefined, undefined, "grep");
      expect(result.metadata?.output_truncated).toBe(true);
      expect(result.metadata?.truncated_output_size).toBe(51_200);
    });
  });

  // ========================================================================
  // skipTruncation metadata (RED #5 — inline helper short-circuit)
  // ========================================================================
  describe("skipTruncation metadata propagation", () => {
    const noParamsSchema = z.object({});

    test("preserves output when the supplied tool opts out of truncation", () => {
      // Author declares `metadata.skipTruncation = true`. The Agent bypass
      // paths must hand the tool's metadata to `truncateOutputInline` so the
      // 5KB cap is skipped for full-content tools (e.g. workflow_get).
      setToolConfigComponent(null);
      const fullOutput = "I".repeat(100_000);
      const tool: Tool = {
        name: "inline-skip",
        description: "inline skip test",
        parameters: noParamsSchema,
        metadata: { skipTruncation: true },
        execute: vi.fn(async () => ({ success: true, output: fullOutput })),
      };

      const result = truncateOutputInline(
        { success: true, output: fullOutput, metadata: { execution_time_ms: 1 } },
        undefined,
        undefined,
        tool.name,
        tool,
      );

      expect(result.output).toBe(fullOutput);
      expect(result.metadata?.output_truncated).toBeUndefined();
      expect(result.metadata?.original_output_size).toBeUndefined();
      expect(result.metadata?.truncated_output_size).toBeUndefined();
    });

    test("preserves error string when the supplied tool opts out of truncation", () => {
      // The inline helper trims `error` (not just `output`). The opt-in must
      // cover both, so a huge stack-trace still reaches the LLM untouched.
      setToolConfigComponent(null);
      const bigError = "E".repeat(20_000);
      const tool: Tool = {
        name: "inline-skip-error",
        description: "skip test on error path",
        parameters: noParamsSchema,
        metadata: { skipTruncation: true },
        execute: vi.fn(async () => ({ success: false, output: "", error: bigError })),
      };

      const result = truncateOutputInline(
        {
          success: false,
          output: "",
          error: bigError,
          metadata: { execution_time_ms: 1 },
        },
        undefined,
        undefined,
        tool.name,
        tool,
      );

      expect(result.error).toBe(bigError);
      expect(result.metadata?.output_truncated).toBeUndefined();
    });

    test("falls back to default 5KB cap when no tool is supplied", () => {
      // The 5th parameter is optional — omitting it preserves existing call
      // sites that only know the tool name. The 100KB output must truncate.
      setToolConfigComponent(null);
      const huge = "F".repeat(100_000);

      const result = truncateOutputInline(
        { success: true, output: huge, metadata: { execution_time_ms: 1 } },
        undefined,
        undefined,
        "no-tool-supplied",
      );

      expect(result.metadata?.output_truncated).toBe(true);
      expect(result.metadata?.truncated_output_size).toBe(5120);
    });
  });
});
