import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod";
import { setToolConfigComponent, getMaxOutputSize } from "./tool-component";
import { ToolComponent } from "./tool-component";
import type { ToolComponentOptions } from "./tool-component";
import { ConfigComponent } from "../../config/config-component";

// ========================================================================
// Test Suite: Output Truncation Integration
// ========================================================================

describe("Tool Output Truncation Integration", () => {
  let toolComponent: ToolComponent;
  let configComponent: ConfigComponent;

  beforeEach(async () => {
    toolComponent = new ToolComponent();
    configComponent = new ConfigComponent();
    await configComponent.init();
  });

  afterEach(() => {
    setToolConfigComponent(null);
  });

  test("should truncate large output when executing bash tool", async () => {
    // Set maxOutputSize to 100 characters
    await configComponent.set("tool.execution.maxOutputSize", 100);

    // Initialize tool component with config
    await toolComponent.init({
      options: {
        configComponent,
      } as ToolComponentOptions,
    });

    // Execute bash command that produces large output (500 characters)
    const result = await toolComponent.execute({
      name: "bash",
      args: { command: "seq 1 500 | tr '\\n' ',' | head -c 500", reason: "test" },
      context: {},
    });

    // Output should be truncated
    expect(result.success).toBe(true);
    expect(typeof result.output).toBe("string");
    expect(result.output.length).toBeLessThan(500);
    expect(result.output).toContain("[OUTPUT TRUNCATED:");
    
    // Metadata should be set
    expect(result.metadata?.output_truncated).toBe(true);
    expect(result.metadata?.original_output_size).toBe(500);
    expect(result.metadata?.truncated_output_size).toBe(100);
  });

  test("should not truncate when output is under limit", async () => {
    // Set maxOutputSize to 1000 characters
    await configComponent.set("tool.execution.maxOutputSize", 1000);

    await toolComponent.init({
      options: {
        configComponent,
      } as ToolComponentOptions,
    });

    // Execute bash command that produces small output
    const result = await toolComponent.execute({
      name: "bash",
      args: { command: "echo 'hello world'", reason: "test" },
      context: {},
    });

    expect(result.success).toBe(true);
    expect(result.metadata?.output_truncated).toBeUndefined();
  });

  test("should not truncate when maxOutputSize is 0 (disabled)", async () => {
    // Disable truncation
    await configComponent.set("tool.execution.maxOutputSize", 0);

    await toolComponent.init({
      options: {
        configComponent,
      } as ToolComponentOptions,
    });

    // Execute bash command that produces output
    const result = await toolComponent.execute({
      name: "bash",
      args: { command: "seq 1 1000 | tr '\\n' ',' | head -c 2000", reason: "test" },
      context: {},
    });

    expect(result.success).toBe(true);
    expect(result.metadata?.output_truncated).toBeUndefined();
  });

  // ========================================================================
  // ToolMetadata.skipTruncation — Central ToolComponent Path (RED #2-#4)
  // ========================================================================
  describe("ToolMetadata.skipTruncation (central ToolComponent path)", () => {
    /**
     * Build a tool that returns a fixed-length string with the supplied
     * metadata flag. We register the tool via `register()` rather than
     * relying on built-ins so we control the metadata exactly.
     */
    function createLargeOutputTool(name: string, skipFlag: boolean | undefined, payload: string) {
      return {
        name,
        description: "returns a huge string for truncation tests",
        parameters: z.object({}),
        metadata: skipFlag === undefined ? undefined : { skipTruncation: skipFlag },
        execute: async () => ({
          success: true as const,
          output: payload,
          metadata: { execution_time_ms: 0 },
        }),
      } as any;
    }

    test("preserves 100KB string output when metadata.skipTruncation is true", async () => {
      // Cap the truncation limit to 5KB so any opt-in preservation stands out.
      await configComponent.set("tool.execution.maxOutputSize", 5120);
      await toolComponent.init({
        options: {
          configComponent,
        } as ToolComponentOptions,
      });

      const fullOutput = "X".repeat(100_000);
      toolComponent.register(createLargeOutputTool("skip-tool-true", true, fullOutput));

      const result = await toolComponent.execute({
        name: "skip-tool-true",
        args: { reason: "test" },
        context: {},
      });

      // The opt-in tool must preserve the full string and never annotate truncation.
      expect(result.success).toBe(true);
      expect(result.output).toBe(fullOutput);
      expect(result.metadata?.output_truncated).toBeUndefined();
      expect(result.metadata?.original_output_size).toBeUndefined();
      expect(result.metadata?.truncated_output_size).toBeUndefined();
      expect(result.metadata?.truncation_temp_file).toBeUndefined();
      // Sanity: the output contains no truncation marker anywhere.
      expect(result.output as string).not.toContain("[OUTPUT TRUNCATED:");
    });

    test("does not write a temp file when metadata.skipTruncation is true", async () => {
      // Spy on TempFileManager.writeTempFile to ensure the opt-in short-circuit
      // never reaches the temp-file fallback for opt-out tools.
      const { TempFileManager } = await import("../../utils/temp-file-manager");
      const writeSpy = vi.spyOn(TempFileManager.getInstance(), "writeTempFile");

      await configComponent.set("tool.execution.maxOutputSize", 5120);
      await toolComponent.init({
        options: {
          configComponent,
        } as ToolComponentOptions,
      });

      const fullOutput = "Y".repeat(80_000);
      toolComponent.register(createLargeOutputTool("skip-tool-no-temp", true, fullOutput));

      const result = await toolComponent.execute({
        name: "skip-tool-no-temp",
        args: { reason: "test" },
        context: {},
      });

      expect(result.success).toBe(true);
      expect(result.output).toBe(fullOutput);
      expect(result.metadata?.truncation_temp_file).toBeUndefined();
      expect(writeSpy).not.toHaveBeenCalled();
      writeSpy.mockRestore();
    });

    test.each([
      ["explicit false", false],
      ["undefined", undefined],
    ] as const)("retains default truncation for %s metadata", async (_label, flag) => {
      // Tools that do not opt in (false or unset) must continue to see the
      // default 5KB cap and truncation notice, preserving backward compatibility.
      await configComponent.set("tool.execution.maxOutputSize", 5120);
      await toolComponent.init({
        options: {
          configComponent,
        } as ToolComponentOptions,
      });

      const fullOutput = "Z".repeat(10_000);
      toolComponent.register(createLargeOutputTool(`default-${String(flag)}`, flag, fullOutput));

      const result = await toolComponent.execute({
        name: `default-${String(flag)}`,
        args: { reason: "test" },
        context: {},
      });

      expect(result.output as string).toContain("[OUTPUT TRUNCATED:");
      expect(result.metadata?.output_truncated).toBe(true);
      expect(result.metadata?.original_output_size).toBe(10_000);
    });
  });
});
