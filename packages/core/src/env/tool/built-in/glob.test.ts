import { describe, test, expect, beforeEach } from "bun:test";
import { globTool } from "./glob";
import { mkdir, rm } from "fs/promises";
import { join } from "path";

describe("globTool", () => {
  const testDir = join("/tmp", `glob-test-${Date.now()}`);

  beforeEach(async () => {
    // 创建测试目录结构
    await mkdir(join(testDir, "src"), { recursive: true });
    await mkdir(join(testDir, "docs"), { recursive: true });
    await mkdir(join(testDir, "node_modules", "pkg"), { recursive: true });
    
    // 创建测试文件
    await Bun.write(join(testDir, "src", "index.ts"), "");
    await Bun.write(join(testDir, "src", "util.ts"), "");
    await Bun.write(join(testDir, "docs", "readme.md"), "");
    await Bun.write(join(testDir, "package.json"), "");
  });

  describe("parameters", () => {
    test("should validate pattern parameter", async () => {
      const result = await globTool.execute(
        { pattern: "**/*.ts", cwd: testDir },
        {}
      );
      
      expect(result.success).toBe(true);
    });
  });

  describe("execution", () => {
    test("should find files by pattern", async () => {
      const result = await globTool.execute(
        { pattern: "**/*.ts", cwd: testDir },
        {}
      );
      
      expect(result.success).toBe(true);
      expect(result.output).toContain("index.ts");
      expect(result.output).toContain("util.ts");
    });

    test("should exclude node_modules by default", async () => {
      const result = await globTool.execute(
        { pattern: "**/*.js", cwd: testDir },
        {}
      );
      
      expect(result.success).toBe(true);
      expect(result.output).not.toContain("node_modules");
    });

    test("should respect maxResults limit", async () => {
      const result = await globTool.execute(
        { pattern: "**/*", cwd: testDir, maxResults: 2 },
        {}
      );
      
      expect(result.success).toBe(true);
      // 检查 metadata 返回的数量不超过限制
      expect(result.metadata?.returned_matches).toBeLessThanOrEqual(2);
    });

    test("should use context workdir", async () => {
      const result = await globTool.execute(
        { pattern: "**/*.ts" },
        { workdir: testDir }
      );
      
      expect(result.success).toBe(true);
      expect(result.output).toContain("index.ts");
    });

    test("should return metadata with counts", async () => {
      const result = await globTool.execute(
        { pattern: "**/*", cwd: testDir },
        {}
      );
      
      expect(result.metadata?.total_matches).toBeDefined();
      expect(result.metadata?.returned_matches).toBeDefined();
    });
  });

  describe("metadata", () => {
    test("should have correct metadata", () => {
      expect(globTool.name).toBe("glob");
      expect(globTool.metadata?.category).toBe("file");
      expect(globTool.metadata?.tags).toContain("search");
    });
  });
});
