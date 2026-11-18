import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { setToolConfigComponent } from "./tool-component";
import { ToolComponent } from "./tool-component";
import type { ToolComponentOptions } from "./tool-component";
import { ConfigComponent } from "../../config/config-component";
import { TempFileManager } from "../../utils/temp-file-manager";

// ========================================================================
// Test Suite: Tool Output Truncation + Temp File Integration
// ========================================================================

describe("Tool Output Truncation + Temp File Integration", () => {
  let toolComponent: ToolComponent;
  let configComponent: ConfigComponent;
  let tempFileManager: TempFileManager;

  beforeEach(async () => {
    toolComponent = new ToolComponent();
    configComponent = new ConfigComponent();
    await configComponent.init();
    tempFileManager = TempFileManager.getInstance();
  });

  afterEach(async () => {
    setToolConfigComponent(null);
    await tempFileManager.cleanupAll();
  });

  // ========================================================================
  // Test 1: bash large output -> temp file created with full content
  // ========================================================================
  test("bash tool with large output should create temp file and append path to output", async () => {
    await configComponent.set("tool.execution.maxOutputSize", 100);
    await toolComponent.init({
      options: { configComponent } as ToolComponentOptions,
    });

    // Execute bash command that produces 500 characters
    const result = await toolComponent.execute({
      name: "bash",
      args: { command: "seq 1 500 | tr '\\n' ',' | head -c 500", reason: "test" },
      context: {},
    });

    expect(result.success).toBe(true);
    expect(typeof result.output).toBe("string");

    // Output should be truncated
    expect(result.output).toContain("[OUTPUT TRUNCATED:");
    expect(result.metadata?.output_truncated).toBe(true);

    // Output should contain temp file path hint
    expect(result.output).toContain("📁 完整内容保存到:");
    expect(result.output).toContain("🔍 使用 read_file 工具按需读取");
    expect(result.output).toContain("roy-bot-truncation-");

    // Metadata should include truncation_temp_file
    expect(result.metadata?.truncation_temp_file).toBeTruthy();
    expect(result.metadata?.truncation_temp_file).toContain("roy-bot-truncation-");

    // The temp file should exist and have full content
    const tempFilePath = result.metadata?.truncation_temp_file as string;
    expect(fs.existsSync(tempFilePath)).toBe(true);
    const tempFileContent = await fs.promises.readFile(tempFilePath, "utf-8");
    expect(tempFileContent.length).toBe(500);
  });

  // ========================================================================
  // Test 2: read_file tool should NOT trigger temp file
  // ========================================================================
  test("read_file tool should NOT trigger temp file mechanism", async () => {
    await configComponent.set("tool.execution.maxOutputSize", 100);
    await toolComponent.init({
      options: { configComponent } as ToolComponentOptions,
    });

    // Create a large file first using bash
    const largeFilePath = path.join(process.cwd(), "test-large-file.txt");
    await fs.promises.writeFile(largeFilePath, "x".repeat(500));

    try {
      const result = await toolComponent.execute({
        name: "read_file",
        args: { path: largeFilePath, reason: "test" },
        context: {},
      });

      expect(result.success).toBe(true);

      // read_file output is also truncated
      // but should NOT have the temp file path appended
      if (result.output && result.output.includes("[OUTPUT TRUNCATED:")) {
        expect(result.output).not.toContain("📁 完整内容保存到:");
        expect(result.metadata?.truncation_temp_file).toBeUndefined();
      }
    } finally {
      await fs.promises.unlink(largeFilePath).catch(() => {});
    }
  });

  // ========================================================================
  // Test 3: small output (under limit) should NOT create temp file
  // ========================================================================
  test("small output should not create temp file", async () => {
    await configComponent.set("tool.execution.maxOutputSize", 1000);
    await toolComponent.init({
      options: { configComponent } as ToolComponentOptions,
    });

    const result = await toolComponent.execute({
      name: "bash",
      args: { command: "echo 'hello world'", reason: "test" },
      context: {},
    });

    expect(result.success).toBe(true);
    expect(result.metadata?.truncation_temp_file).toBeUndefined();
    expect(result.output).not.toContain("roy-bot-truncation-");
  });
});
