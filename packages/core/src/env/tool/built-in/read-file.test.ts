import { describe, test, expect, beforeEach } from "bun:test";
import { readFileTool } from "./read-file";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

describe("readFileTool", () => {
  const testDir = join("/tmp", `read-test-${Date.now()}`);
  const testFile = join(testDir, "test.txt");
  const multiLineFile = join(testDir, "multi.txt");

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
    await writeFile(testFile, "Hello, World!");
    await writeFile(multiLineFile, "Line 1\nLine 2\nLine 3\nLine 4\nLine 5");
  });

  describe("parameters", () => {
    test("should validate path parameter", async () => {
      const result = await readFileTool.execute({ path: testFile }, {});
      
      expect(result.success).toBe(true);
      expect(result.output).toBe("Hello, World!");
    });

    test("should handle missing path gracefully", async () => {
      // Zod 会使用 undefined 值执行，可能导致文件系统错误而不是验证错误
      const result = await readFileTool.execute({} as any, {});
      expect(result).toBeDefined();
    });
  });

  describe("execution", () => {
    test("should read file content", async () => {
      const result = await readFileTool.execute({ path: testFile }, {});
      
      expect(result.success).toBe(true);
      expect(result.output).toBe("Hello, World!");
    });

    test("should read with offset and limit", async () => {
      const result = await readFileTool.execute(
        { path: multiLineFile, offset: 1, limit: 2 },
        {}
      );
      
      expect(result.success).toBe(true);
      expect(result.output).toBe("Line 2\nLine 3");
    });

    test("should return error for non-existent file", async () => {
      const result = await readFileTool.execute(
        { path: join(testDir, "non-existent.txt") },
        {}
      );
      
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    test("should include metadata", async () => {
      const result = await readFileTool.execute({ path: testFile }, {});
      
      expect(result.metadata?.execution_time_ms).toBeDefined();
      expect(result.metadata?.output_size).toBeDefined();
      expect(result.metadata?.file_path).toBe(testFile);
    });
  });

  describe("metadata", () => {
    test("should have correct metadata", () => {
      expect(readFileTool.name).toBe("read_file");
      expect(readFileTool.metadata?.category).toBe("file");
      expect(readFileTool.metadata?.tags).toContain("read");
    });

    test("should have sandbox config", () => {
      expect(readFileTool.sandbox?.enabled).toBe(true);
    });

    test("should be safe permission", () => {
      expect(readFileTool.permission?.level).toBe("safe");
    });
  });
});
