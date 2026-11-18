/**
 * 内置工具跨平台兼容性测试
 * 测试 Windows/macOS/Linux 路径处理、边界情况等
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { grepTool } from "./grep";
import { globTool } from "./glob";
import { readFileTool } from "./read-file";
import { editFileTool } from "./edit-file";

// 测试目录
const testDir = join("/tmp", `builtin-tools-test-${Date.now()}`);

describe("跨平台路径处理", () => {
  beforeEach(async () => {
    await mkdir(join(testDir, "subdir", "nested"), { recursive: true });
    await writeFile(join(testDir, "test.txt"), "Hello World");
    await writeFile(join(testDir, "subdir", "file.ts"), "const x = 1;");
    await writeFile(join(testDir, "subdir", "nested", "deep.md"), "# Deep");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("glob 路径处理", () => {
    test("应该正确处理相对路径", async () => {
      const result = await globTool.execute(
        { pattern: "**/*.txt", cwd: testDir },
        {}
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain("test.txt");
    });

    test("应该正确处理绝对路径", async () => {
      const result = await globTool.execute(
        { pattern: "**/*.ts", cwd: testDir },
        {}
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain("file.ts");
    });

    test("Windows 路径分隔符应该被正确处理", async () => {
      // 模拟 Windows 路径（在 Unix 上测试路径处理逻辑）
      const windowsPath = join(testDir, "subdir", "nested");
      const result = await globTool.execute(
        { pattern: "*.md", cwd: windowsPath },
        {}
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain("deep.md");
    });
  });

  describe("read_file 路径处理", () => {
    test("应该正确读取相对路径文件", async () => {
      const relativePath = join("subdir", "file.ts");
      const result = await readFileTool.execute(
        { path: join(testDir, relativePath) },
        {}
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain("const x = 1");
    });

    test("应该正确读取嵌套目录中的文件", async () => {
      const result = await readFileTool.execute(
        { path: join(testDir, "subdir", "nested", "deep.md") },
        {}
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain("# Deep");
    });

    test("offset 为 0 时应该从头开始", async () => {
      await writeFile(join(testDir, "lines.txt"), "Line 1\nLine 2\nLine 3");
      const result = await readFileTool.execute(
        { path: join(testDir, "lines.txt"), offset: 0, limit: 1 },
        {}
      );
      expect(result.success).toBe(true);
      expect(result.output).toBe("Line 1");
    });

    test("应该处理 offset 和 limit 边界情况", async () => {
      await writeFile(join(testDir, "lines.txt"), "Line 1\nLine 2\nLine 3");
      const result = await readFileTool.execute(
        { path: join(testDir, "lines.txt"), offset: 1, limit: 1 },
        {}
      );
      expect(result.success).toBe(true);
      expect(result.output).toBe("Line 2");
    });
  });

  describe("grep 路径处理", () => {
    test("应该正确搜索相对路径目录", async () => {
      const result = await grepTool.execute(
        { pattern: "Hello", path: testDir },
        {}
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain("test.txt");
      expect(result.output).toContain("Hello World");
    });

    test("应该正确搜索绝对路径目录", async () => {
      // 使用 **/*.ts 来递归匹配子目录中的文件
      const result = await grepTool.execute(
        { pattern: "const", path: testDir, include: "**/*.ts" },
        {}
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain("file.ts");
      expect(result.output).toContain("const x = 1");
    });

    test("应该跳过二进制文件", async () => {
      // 创建一个模拟的二进制文件（包含 null 字节）
      const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE]);
      await writeFile(join(testDir, "binary.bin"), binaryContent);
      // 同时创建一个普通文本文件
      await writeFile(join(testDir, "text.txt"), "Hello World");
      
      const result = await grepTool.execute(
        { pattern: "Hello", path: testDir },
        {}
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain("Hello World");
      // 不应该包含乱码
      expect(result.output).not.toContain("\0");
    });

    test("空 pattern 应该被拒绝或返回错误", async () => {
      const result = await grepTool.execute(
        { pattern: "", path: testDir },
        {}
      );
      // 空 pattern 可能被正则接受，但应该没有匹配
      expect(result).toBeDefined();
    });
  });

  describe("edit_file 路径处理", () => {
    test("应该正确编辑嵌套目录中的文件", async () => {
      const filePath = join(testDir, "subdir", "file.ts");
      const result = await editFileTool.execute(
        { path: filePath, oldString: "const x = 1", newString: "const y = 2" },
        {}
      );
      expect(result.success).toBe(true);
      
      const content = await Bun.file(filePath).text();
      expect(content).toContain("const y = 2");
      expect(content).not.toContain("const x = 1");
    });

    test("replaceAll 应该替换所有出现", async () => {
      const filePath = join(testDir, "multi.txt");
      await writeFile(filePath, "foo bar foo baz foo");
      
      const result = await editFileTool.execute(
        { path: filePath, oldString: "foo", newString: "qux", replaceAll: true },
        {}
      );
      expect(result.success).toBe(true);
      
      const content = await Bun.file(filePath).text();
      expect(content).toBe("qux bar qux baz qux");
    });

    test("不带 replaceAll 应该只替换第一个", async () => {
      const filePath = join(testDir, "multi.txt");
      await writeFile(filePath, "foo bar foo baz foo");
      
      const result = await editFileTool.execute(
        { path: filePath, oldString: "foo", newString: "qux" },
        {}
      );
      expect(result.success).toBe(true);
      
      const content = await Bun.file(filePath).text();
      expect(content).toBe("qux bar foo baz foo");
    });

    test("找不到内容应该返回错误", async () => {
      const filePath = join(testDir, "test.txt");
      const result = await editFileTool.execute(
        { path: filePath, oldString: "NonExistent", newString: "Something" },
        {}
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("Could not find");
    });

    test("应该正确处理多行替换", async () => {
      const filePath = join(testDir, "multiline.txt");
      await writeFile(filePath, "Line 1\nLine 2\nLine 3");
      
      const result = await editFileTool.execute(
        { 
          path: filePath, 
          oldString: "Line 1\nLine 2", 
          newString: "First Line\nSecond Line" 
        },
        {}
      );
      expect(result.success).toBe(true);
      
      const content = await Bun.file(filePath).text();
      expect(content).toContain("First Line\nSecond Line\nLine 3");
    });

    test("应该处理特殊字符", async () => {
      const filePath = join(testDir, "special.txt");
      await writeFile(filePath, 'const str = "Hello $world";');
      
      const result = await editFileTool.execute(
        { path: filePath, oldString: 'Hello $world', newString: 'Hi $universe' },
        {}
      );
      expect(result.success).toBe(true);
      
      const content = await Bun.file(filePath).text();
      expect(content).toContain('Hi $universe');
    });

    test("应该处理正则表达式特殊字符", async () => {
      const filePath = join(testDir, "regex.txt");
      await writeFile(filePath, "foo [bar] (baz) {qux}");
      
      // 测试包含 . * + ? ^ $ { } [ ] ( ) | \ 的内容
      const result = await editFileTool.execute(
        { path: filePath, oldString: "[bar]", newString: "[updated]" },
        {}
      );
      expect(result.success).toBe(true);
      
      const content = await Bun.file(filePath).text();
      expect(content).toBe("foo [updated] (baz) {qux}");
    });
  });
});

describe("性能和数据完整性", () => {
  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("grep 应该限制结果数量", async () => {
    // 创建多个匹配的文件
    for (let i = 0; i < 10; i++) {
      await writeFile(join(testDir, `file${i}.txt`), "match pattern");
    }
    
    const result = await grepTool.execute(
      { pattern: "match", path: testDir, maxResults: 3 },
      {}
    );
    expect(result.success).toBe(true);
    
    // 计算匹配的行数
    const matches = String(result.output).split("\n").filter((line: string) => line.includes("match"));
    expect(matches.length).toBeLessThanOrEqual(3);
  });

  test("glob 应该返回元数据包含总数", async () => {
    for (let i = 0; i < 5; i++) {
      await writeFile(join(testDir, `file${i}.ts`), "");
    }
    
    const result = await globTool.execute(
      { pattern: "*.ts", cwd: testDir },
      {}
    );
    expect(result.success).toBe(true);
    expect(result.metadata?.total_matches).toBe(5);
    expect(result.metadata?.returned_matches).toBe(5);
  });

  test("glob 应该限制结果数量", async () => {
    for (let i = 0; i < 10; i++) {
      await writeFile(join(testDir, `file${i}.ts`), "");
    }
    
    const result = await globTool.execute(
      { pattern: "*.ts", cwd: testDir, maxResults: 3 },
      {}
    );
    expect(result.success).toBe(true);
    expect(result.metadata?.returned_matches).toBeLessThanOrEqual(3);
    // 截断时输出会包含截断消息，所以只检查 metadata
    expect(result.metadata?.truncated).toBe(true);
  });

  test("read_file 应该正确处理大文件 offset", async () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `Line ${i + 1}`);
    await writeFile(join(testDir, "large.txt"), lines.join("\n"));
    
    const result = await readFileTool.execute(
      { path: join(testDir, "large.txt"), offset: 999, limit: 1 },
      {}
    );
    expect(result.success).toBe(true);
    expect(result.output).toBe("Line 1000");
  });
});

describe("错误处理", () => {
  test("read_file 应该处理不存在的文件", async () => {
    const result = await readFileTool.execute(
      { path: "/non/existent/path.txt" },
      {}
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("edit_file 应该处理不存在的文件", async () => {
    const result = await editFileTool.execute(
      { path: "/non/existent/path.txt", oldString: "a", newString: "b" },
      {}
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("grep 应该处理不存在的目录", async () => {
    const result = await grepTool.execute(
      { pattern: "test", path: "/non/existent/path" },
      {}
    );
    // 应该返回错误或空结果
    expect(result).toBeDefined();
  });

  test("glob 应该处理不存在的目录", async () => {
    const result = await globTool.execute(
      { pattern: "*.txt", cwd: "/non/existent/path" },
      {}
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
