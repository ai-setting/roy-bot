/**
 * @fileoverview Memory File Tests - TDD
 * 
 * Tests for recordMemory and recallMemory functionality
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import path from "path";
import fs from "fs/promises";
import os from "os";
import { MemoryComponent } from "./memory-component";
import { ConfigComponent } from "../../config/config-component";

describe("MemoryFile - recordMemory & recallMemory", () => {
  let memoryComponent: MemoryComponent;
  let configComponent: ConfigComponent;
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `memory-file-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    configComponent = new ConfigComponent();
    memoryComponent = new MemoryComponent();
    await memoryComponent.init({
      options: {
        configComponent,
        config: {
          memoryPaths: [{ type: "user", path: testDir }],
          recursive: true,
          cacheEnabled: false,
        },
      },
    });
  });

  afterEach(async () => {
    try {
      await memoryComponent.stop();
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("recordMemory", () => {
    it("should overwrite file with new content", async () => {
      // 首次写入
      await memoryComponent.recordMemory({
        mode: "overwrite",
        content: "# First memory\n\nInitial content",
        title: "First Memory",
      });

      // 覆盖写入
      const result = await memoryComponent.recordMemory({
        mode: "overwrite",
        content: "# Second memory\n\nOverwritten content",
        title: "Second Memory",
      });

      expect(result).not.toBeNull();
      expect(result!.action).toBe("overwrite");

      // 验证文件内容
      const fileContent = await fs.readFile(path.join(testDir, "memory.md"), "utf-8");
      expect(fileContent).toContain("Second memory");
      expect(fileContent).not.toContain("First memory");
    });

    it("should append content to end of file", async () => {
      // 首次写入
      await memoryComponent.recordMemory({
        mode: "overwrite",
        content: "# Initial\n\nFirst paragraph",
      });

      // 追加内容
      const result = await memoryComponent.recordMemory({
        mode: "append",
        content: "## Second paragraph\n\nAppended content",
      });

      expect(result).not.toBeNull();
      expect(result!.action).toBe("append");

      // 验证文件内容
      const fileContent = await fs.readFile(path.join(testDir, "memory.md"), "utf-8");
      expect(fileContent).toContain("First paragraph");
      expect(fileContent).toContain("Appended content");
    });

    it("should prepend content to beginning of file", async () => {
      // 首次写入
      await memoryComponent.recordMemory({
        mode: "overwrite",
        content: "# Existing\n\nOriginal content",
      });

      // 头部插入
      const result = await memoryComponent.recordMemory({
        mode: "prepend",
        content: "# New Header\n\nPrepended content\n\n---\n",
      });

      expect(result).not.toBeNull();
      expect(result!.action).toBe("prepend");

      // 验证文件内容
      const fileContent = await fs.readFile(path.join(testDir, "memory.md"), "utf-8");
      expect(fileContent).toContain("Prepended content");
      expect(fileContent).toContain("Original content");
      // 头部插入的内容应该在前面
      expect(fileContent.indexOf("Prepended content")).toBeLessThan(
        fileContent.indexOf("Original content")
      );
    });

    it("should delete memory file", async () => {
      // 先创建文件
      await memoryComponent.recordMemory({
        mode: "overwrite",
        content: "# To be deleted",
      });

      // 删除文件
      const result = await memoryComponent.recordMemory({
        mode: "delete",
      });

      expect(result).not.toBeNull();
      expect(result!.action).toBe("delete");

      // 验证文件不存在
      const exists = await fs.access(path.join(testDir, "memory.md")).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });

    it("should create file if not exists for non-delete modes", async () => {
      const result = await memoryComponent.recordMemory({
        mode: "append",
        content: "# New file content",
      });

      expect(result).not.toBeNull();
      expect(result!.action).toBe("created");

      // 验证文件存在
      const fileContent = await fs.readFile(path.join(testDir, "memory.md"), "utf-8");
      expect(fileContent).toContain("New file content");
    });

    it("should use custom filename when provided", async () => {
      const result = await memoryComponent.recordMemory({
        mode: "overwrite",
        content: "# Custom file",
        filename: "custom-memory.md",
      });

      expect(result!.path).toContain("custom-memory.md");

      // 验证自定义文件名
      const fileContent = await fs.readFile(path.join(testDir, "custom-memory.md"), "utf-8");
      expect(fileContent).toContain("Custom file");
    });

    it("should include title as section header when provided", async () => {
      await memoryComponent.recordMemory({
        mode: "overwrite",
        content: "## Important Info\n\nSome content here",
        title: "Important Info",
      });

      const fileContent = await fs.readFile(path.join(testDir, "memory.md"), "utf-8");
      expect(fileContent).toContain("## Important Info");
    });
  });

  describe("recallMemory", () => {
    it("should return empty string when no memory files exist", async () => {
      const result = await memoryComponent.recallMemory();
      expect(result).toBe("");
    });

    it("should recall memory.md content", async () => {
      await memoryComponent.recordMemory({
        mode: "overwrite",
        content: "# Test Memory\n\nThis is test content",
      });

      const result = await memoryComponent.recallMemory();
      expect(result).toContain("Test Memory");
      expect(result).toContain("This is test content");
    });

    it("should format output with filename as header", async () => {
      await memoryComponent.recordMemory({
        mode: "overwrite",
        content: "# Memory Content",
        filename: "memory.md",
      });

      const result = await memoryComponent.recallMemory();
      expect(result).toContain("## [user] memory.md");
      expect(result).toContain("Memory Content");
    });

    it("should include all memory files from all paths", async () => {
      // 创建第二个 memory path
      const testDir2 = path.join(os.tmpdir(), `memory-file-test2-${Date.now()}`);
      await fs.mkdir(testDir2, { recursive: true });

      // 先在 testDir 写入 memory.md
      await memoryComponent.recordMemory({
        mode: "overwrite",
        content: "# User Memory",
      });

      // 更新配置添加第二个路径，project 放前面作为主要路径
      await memoryComponent.updateMemoryPaths([
        { type: "project", path: testDir2 },
        { type: "user", path: testDir },
      ]);

      // 在 project 路径写入 memory.md
      await memoryComponent.recordMemory({
        mode: "overwrite",
        content: "# Project Memory",
        filename: "memory.md",
      });

      const result = await memoryComponent.recallMemory();

      // 清理第二个目录
      await fs.rm(testDir2, { recursive: true, force: true });

      // 从所有路径读取，所以两个文件都应该存在
      expect(result).toContain("## [project] memory.md");
      expect(result).toContain("## [user] memory.md");
      expect(result).toContain("User Memory");
      expect(result).toContain("Project Memory");
    });

    it("should skip non-existent memory files gracefully", async () => {
      // 只配置一个路径
      const result = await memoryComponent.recallMemory();
      expect(result).toBe("");
    });
  });

  describe("integration with ConfigComponent", () => {
    it("should use memory.memoryFile config for filename", async () => {
      // 设置自定义 memoryFile 配置
      await configComponent.set("memory.memoryFile", "my-memory.md");

      const result = await memoryComponent.recordMemory({
        mode: "overwrite",
        content: "# Custom Config Memory",
      });

      expect(result!.path).toContain("my-memory.md");

      // 验证读取也使用该配置
      const fileContent = await fs.readFile(path.join(testDir, "my-memory.md"), "utf-8");
      expect(fileContent).toContain("Custom Config Memory");
    });
  });
});
