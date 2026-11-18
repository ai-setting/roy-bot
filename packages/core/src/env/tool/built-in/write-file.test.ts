import { describe, test, expect, beforeEach } from "bun:test";
import { writeFileTool } from "./write-file";
import { readFile, mkdir, rm } from "fs/promises";
import { join } from "path";

describe("writeFileTool", () => {
  const testDir = join("/tmp", `write-test-${Date.now()}`);
  const testFile = join(testDir, "output.txt");
  const nestedFile = join(testDir, "nested", "dir", "output.txt");

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  describe("parameters", () => {
    test("should validate path and content", async () => {
      const result = await writeFileTool.execute(
        { path: testFile, content: "test content" },
        {}
      );
      
      expect(result.success).toBe(true);
    });

    test("should handle missing path gracefully", async () => {
      const result = await writeFileTool.execute({ content: "test" } as any, {});
      // 会因为文件系统错误而失败
      expect(result.success).toBe(false);
    });

    test("should handle empty content gracefully", async () => {
      const result = await writeFileTool.execute({ path: testFile, content: "" }, {});
      // 空内容应该能成功写入
      expect(result.success).toBe(true);
    });
  });

  describe("execution", () => {
    test("should write file content", async () => {
      const content = "Hello, World!";
      const result = await writeFileTool.execute(
        { path: testFile, content },
        {}
      );
      
      expect(result.success).toBe(true);
      
      // 验证文件内容
      const written = await readFile(testFile, "utf-8");
      expect(written).toBe(content);
    });

    test("should create parent directories with createDirs", async () => {
      const result = await writeFileTool.execute(
        { path: nestedFile, content: "nested content", createDirs: true },
        {}
      );
      
      expect(result.success).toBe(true);
      
      const written = await readFile(nestedFile, "utf-8");
      expect(written).toBe("nested content");
    });

    test("should append with append flag", async () => {
      await writeFileTool.execute(
        { path: testFile, content: "Line 1" },
        {}
      );
      
      await writeFileTool.execute(
        { path: testFile, content: "Line 2", append: true },
        {}
      );
      
      const content = await readFile(testFile, "utf-8");
      expect(content).toBe("Line 1Line 2");
    });

    test("should overwrite without append flag", async () => {
      await writeFileTool.execute(
        { path: testFile, content: "Original" },
        {}
      );
      
      await writeFileTool.execute(
        { path: testFile, content: "Overwritten" },
        {}
      );
      
      const content = await readFile(testFile, "utf-8");
      expect(content).toBe("Overwritten");
    });

    test("should include metadata", async () => {
      const result = await writeFileTool.execute(
        { path: testFile, content: "test" },
        {}
      );
      
      expect(result.metadata?.execution_time_ms).toBeDefined();
      expect(result.metadata?.output_size).toBe(4);
      expect(result.metadata?.file_path).toBe(testFile);
    });
  });

  describe("metadata", () => {
    test("should have correct metadata", () => {
      expect(writeFileTool.name).toBe("write_file");
      expect(writeFileTool.metadata?.category).toBe("file");
      expect(writeFileTool.metadata?.tags).toContain("write");
    });

    test("should require confirmation", () => {
      expect(writeFileTool.permission?.requireConfirmation).toBe(true);
      expect(writeFileTool.permission?.level).toBe("dangerous");
    });
  });
});
