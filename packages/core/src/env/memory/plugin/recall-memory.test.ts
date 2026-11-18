/**
 * @fileoverview Recall Memory Tests - Simplified
 * 
 * 测试简化后的 recall_memory 工具
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { recallMemory, type MemoryPath } from "./recall-memory";

describe("RecallMemory - Simplified", () => {
  let tmpDir: string;
  let globalDir: string;
  let projectDir: string;

  const globalMemoryPath: MemoryPath = {
    type: "global",
    path: "",
  };

  const projectMemoryPath: MemoryPath = {
    type: "project",
    path: "",
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "recall-memory-test-"));

    // Create global memory directory
    globalDir = path.join(tmpDir, "global-memory");
    await fs.mkdir(globalDir, { recursive: true });
    globalMemoryPath.path = globalDir;

    // Create project memory directory
    projectDir = path.join(tmpDir, "project-memory");
    await fs.mkdir(projectDir, { recursive: true });
    projectMemoryPath.path = projectDir;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("basic recall", () => {
    it("should return empty when no memory files exist", async () => {
      const result = await recallMemory([globalMemoryPath]);
      expect(result).toBe("(No memory files found)");
    });

    it("should return memory.md content", async () => {
      await fs.writeFile(path.join(globalDir, "memory.md"), "# Global Memory\n\nTest content.", "utf-8");

      const result = await recallMemory([globalMemoryPath]);
      expect(result).toContain("# Global Memory");
      expect(result).toContain("Test content.");
    });

    it("should include scope prefix in output", async () => {
      await fs.writeFile(path.join(globalDir, "memory.md"), "# Global Memory", "utf-8");

      const result = await recallMemory([globalMemoryPath]);
      expect(result).toContain("[global]");
    });
  });

  describe("multiple memory paths", () => {
    it("should recall from multiple scopes", async () => {
      await fs.writeFile(path.join(globalDir, "memory.md"), "# Global", "utf-8");
      await fs.writeFile(path.join(projectDir, "memory.md"), "# Project", "utf-8");

      const result = await recallMemory([globalMemoryPath, projectMemoryPath]);

      expect(result).toContain("[global]");
      expect(result).toContain("# Global");
      expect(result).toContain("[project]");
      expect(result).toContain("# Project");
    });
  });

  describe("error handling", () => {
    it("should continue when one scope fails", async () => {
      // Valid global scope
      await fs.writeFile(path.join(globalDir, "memory.md"), "# Global", "utf-8");

      // Invalid project path
      const invalidPath: MemoryPath = { type: "project", path: "/nonexistent/path" };

      // Should not throw, should still return global content
      const result = await recallMemory([globalMemoryPath, invalidPath]);
      expect(result).toContain("# Global");
    });
  });

  describe("output format", () => {
    it("should separate scopes with double newlines", async () => {
      await fs.writeFile(path.join(globalDir, "memory.md"), "Global content", "utf-8");
      await fs.writeFile(path.join(projectDir, "memory.md"), "Project content", "utf-8");

      const result = await recallMemory([globalMemoryPath, projectMemoryPath]);
      // Should have sections separated
      expect(result.split("\n\n").length).toBeGreaterThanOrEqual(2);
    });
  });
});
