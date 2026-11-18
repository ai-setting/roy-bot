import { describe, test, expect, beforeEach } from "bun:test";
import { editFileTool } from "./edit-file";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

describe("editFileTool", () => {
  const testDir = join("/tmp", `edit-test-${Date.now()}`);
  const testFile = join(testDir, "test.txt");

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
    await writeFile(testFile, "Hello, World!\nThis is a test.\nEnd of file.");
  });

  describe("parameters", () => {
    test("should validate required parameters", async () => {
      const result = await editFileTool.execute(
        { path: testFile, oldString: "Hello", newString: "Hi" },
        {}
      );
      
      expect(result.success).toBe(true);
    });

    test("should handle missing oldString gracefully", async () => {
      const result = await editFileTool.execute(
        { path: testFile, newString: "Hi" } as any,
        {}
      );
      // 会因为找不到空字符串而失败
      expect(result).toBeDefined();
    });

    test("should handle missing newString gracefully", async () => {
      const result = await editFileTool.execute(
        { path: testFile, oldString: "Hello" } as any,
        {}
      );
      // 会成功替换为空字符串
      expect(result.success).toBe(true);
    });
  });

  describe("execution", () => {
    test("should replace text in file", async () => {
      const result = await editFileTool.execute(
        { path: testFile, oldString: "Hello", newString: "Hi" },
        {}
      );
      
      expect(result.success).toBe(true);
      
      const content = await Bun.file(testFile).text();
      expect(content).toContain("Hi, World!");
      expect(content).not.toContain("Hello, World!");
    });

    test("should replace all occurrences with replaceAll", async () => {
      await writeFile(testFile, "foo bar foo baz foo");
      
      const result = await editFileTool.execute(
        { path: testFile, oldString: "foo", newString: "qux", replaceAll: true },
        {}
      );
      
      expect(result.success).toBe(true);
      
      const content = await Bun.file(testFile).text();
      expect(content).toBe("qux bar qux baz qux");
    });

    test("should replace only first occurrence without replaceAll", async () => {
      await writeFile(testFile, "foo bar foo baz foo");
      
      const result = await editFileTool.execute(
        { path: testFile, oldString: "foo", newString: "qux" },
        {}
      );
      
      expect(result.success).toBe(true);
      
      const content = await Bun.file(testFile).text();
      expect(content).toBe("qux bar foo baz foo");
    });

    test("should return error when text not found", async () => {
      const result = await editFileTool.execute(
        { path: testFile, oldString: "NonExistent", newString: "Something" },
        {}
      );
      
      expect(result.success).toBe(false);
      expect(result.error).toContain("Could not find");
    });

    test("should handle multiline replacement", async () => {
      const result = await editFileTool.execute(
        {
          path: testFile,
          oldString: "Hello, World!\nThis is a test.",
          newString: "Greetings!\nThis has been updated."
        },
        {}
      );
      
      expect(result.success).toBe(true);
      
      const content = await Bun.file(testFile).text();
      expect(content).toContain("Greetings!");
      expect(content).toContain("This has been updated.");
    });

    test("should include metadata", async () => {
      const result = await editFileTool.execute(
        { path: testFile, oldString: "Hello", newString: "Hi" },
        {}
      );
      
      expect(result.metadata?.execution_time_ms).toBeDefined();
      expect(result.metadata?.file_path).toBe(testFile);
    });
  });

  describe("metadata", () => {
    test("should have correct metadata", () => {
      expect(editFileTool.name).toBe("edit_file");
      expect(editFileTool.metadata?.category).toBe("file");
      expect(editFileTool.metadata?.tags).toContain("edit");
    });

    test("should require confirmation", () => {
      expect(editFileTool.permission?.requireConfirmation).toBe(true);
      expect(editFileTool.permission?.level).toBe("dangerous");
    });
  });
});
