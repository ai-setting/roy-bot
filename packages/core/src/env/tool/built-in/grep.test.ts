import { describe, test, expect, beforeEach } from "bun:test";
import { grepTool } from "./grep";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

describe("grepTool", () => {
  const testDir = join("/tmp", `grep-test-${Date.now()}`);
  const testFile1 = join(testDir, "file1.ts");
  const testFile2 = join(testDir, "file2.ts");

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
    await writeFile(testFile1, "function hello() {\n  return 'Hello';\n}\nconsole.log(hello());");
    await writeFile(testFile2, "class Greeter {\n  greet() {\n    return 'Hi';\n  }\n}");
  });

  describe("parameters", () => {
    test("should validate pattern parameter", async () => {
      const result = await grepTool.execute(
        { pattern: "hello", path: testDir, include: "*.ts" },
        {}
      );
      
      expect(result.success).toBe(true);
    });
  });

  describe("execution", () => {
    test("should find pattern in files", async () => {
      const result = await grepTool.execute(
        { pattern: "hello", path: testDir, include: "*.ts" },
        {}
      );
      
      expect(result.success).toBe(true);
      expect(result.output).toContain("file1.ts");
      expect(result.output).toContain("hello");
    });

    test("should show line numbers by default", async () => {
      const result = await grepTool.execute(
        { pattern: "function", path: testDir, include: "*.ts" },
        {}
      );
      
      expect(result.success).toBe(true);
      expect(result.output).toContain(":1:");
    });

    test("should hide line numbers when disabled", async () => {
      const result = await grepTool.execute(
        { pattern: "function", path: testDir, include: "*.ts", showLineNumbers: false },
        {}
      );
      
      expect(result.success).toBe(true);
      expect(result.output).not.toContain(":1:");
    });

    test("should be case sensitive by default", async () => {
      const result = await grepTool.execute(
        { pattern: "Hello", path: testDir, include: "*.ts" },
        {}
      );
      
      expect(result.success).toBe(true);
      expect(result.output).toContain("Hello");
    });

    test("should be case insensitive when specified", async () => {
      const result = await grepTool.execute(
        { pattern: "hello", path: testDir, include: "*.ts", caseSensitive: false },
        {}
      );
      
      expect(result.success).toBe(true);
      expect(result.output).toContain("Hello");
    });

    test("should respect maxResults limit", async () => {
      await writeFile(join(testDir, "file3.ts"), "hello\nhello\nhello\nhello\nhello");
      
      const result = await grepTool.execute(
        { pattern: "hello", path: testDir, include: "*.ts", maxResults: 2 },
        {}
      );
      
      expect(result.success).toBe(true);
      const matches = result.output.split("\n").filter(m => m.includes("hello"));
      expect(matches.length).toBeLessThanOrEqual(2);
    });

    test("should return no matches message", async () => {
      const result = await grepTool.execute(
        { pattern: "nonexistent", path: testDir, include: "*.ts" },
        {}
      );
      
      expect(result.success).toBe(true);
      expect(result.output).toContain("(no matches found)");
    });

    test("should include metadata", async () => {
      const result = await grepTool.execute(
        { pattern: "hello", path: testDir, include: "*.ts" },
        {}
      );
      
      expect(result.metadata?.execution_time_ms).toBeDefined();
      expect(result.metadata?.matches_count).toBeDefined();
      expect(result.metadata?.files_searched).toBeDefined();
    });
  });

  describe("metadata", () => {
    test("should have correct metadata", () => {
      expect(grepTool.name).toBe("grep");
      expect(grepTool.metadata?.category).toBe("file");
      expect(grepTool.metadata?.tags).toContain("search");
    });
  });
});
