/**
 * @fileoverview MemoryAgent Test Suite - Simplified
 * 
 * TDD 测试用例 - 验证简化后的 MemoryAgent 设计
 * 
 * 简化设计：
 * - 移除了 DraftManager
 * - 只保留核心的 memory.md 操作
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  createMemoryAgent,
  formatMemoryInput,
  parseMemoryAgentOutput,
  createEmptyResult,
  buildProjectInput,
  buildGlobalInput,
  applyMemoryResult,
  generateProjectSummary,
  type MemoryAgentInput,
} from "./memory-agent";

describe("MemoryAgent - Simplified Design", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-agent-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("createMemoryAgent", () => {
    test("should create agent with project scope", () => {
      const config = createMemoryAgent("project");
      expect(config.name).toContain("memory-agent-project");
      expect(config.systemPrompt).toContain("项目级 Memory Agent");
      expect(config.maxIterations).toBe(5);
    });

    test("should create agent with global scope", () => {
      const config = createMemoryAgent("global");
      expect(config.name).toContain("memory-agent-global");
      expect(config.systemPrompt).toContain("全局 Memory Agent");
      expect(config.maxIterations).toBe(5);
    });
  });

  describe("formatMemoryInput", () => {
    test("should format project scope input", () => {
      const input: MemoryAgentInput = {
        scope: "project",
        baseDir: tmpDir,
        currentMemoryMd: "# 项目记忆\n\n一些记忆内容",
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi there!" },
        ],
      };

      const formatted = formatMemoryInput(input);
      expect(formatted).toContain("project scope");
      expect(formatted).toContain("项目记忆");
      expect(formatted).toContain("Hello");
      expect(formatted).toContain("Hi there!");
    });

    test("should format global scope input with project summaries", () => {
      const input: MemoryAgentInput = {
        scope: "global",
        baseDir: tmpDir,
        currentMemoryMd: "# 全局记忆",
        messages: [],
        projectSummaries: [
          {
            projectPath: "/path/to/project",
            projectName: "test-project",
            lastUpdated: Date.now(),
            summary: "A test project",
            shortSummary: "Test project",
            memoryMdPath: "/path/to/project/.roy/memory/memory.md",
          },
        ],
      };

      const formatted = formatMemoryInput(input);
      expect(formatted).toContain("global scope");
      expect(formatted).toContain("test-project");
      expect(formatted).toContain("A test project");
    });
  });

  describe("parseMemoryAgentOutput", () => {
    test("should parse JSON output", () => {
      const output = JSON.stringify({
        memoryMdContent: "# 新记忆\n\n内容",
        hasUpdates: true,
      });

      const result = parseMemoryAgentOutput(output, "project");
      expect(result.memoryMdContent).toBe("# 新记忆\n\n内容");
      expect(result.hasUpdates).toBe(true);
      expect(result.scope).toBe("project");
    });

    test("should parse JSON with project summary", () => {
      const output = JSON.stringify({
        memoryMdContent: "# 记忆",
        hasUpdates: true,
        projectSummary: {
          projectPath: "/path",
          projectName: "test",
          lastUpdated: Date.now(),
          summary: "Summary",
          shortSummary: "Sum",
          memoryMdPath: "/path/memory.md",
        },
      });

      const result = parseMemoryAgentOutput(output, "project");
      expect(result.projectSummary).toBeDefined();
      expect(result.projectSummary!.projectName).toBe("test");
    });
  });

  describe("createEmptyResult", () => {
    test("should create empty result for project scope", () => {
      const result = createEmptyResult("project");
      expect(result.scope).toBe("project");
      expect(result.memoryMdContent).toBe("");
      expect(result.hasUpdates).toBe(false);
      expect(result.projectSummary).toBeUndefined();
    });

    test("should create empty result for global scope", () => {
      const result = createEmptyResult("global");
      expect(result.scope).toBe("global");
      expect(result.memoryMdContent).toBe("");
      expect(result.hasUpdates).toBe(false);
    });
  });

  describe("applyMemoryResult", () => {
    test("should create memory.md file", async () => {
      const result = {
        scope: "project" as const,
        memoryMdContent: "# 项目记忆\n\n测试内容",
        hasUpdates: true,
      };

      await applyMemoryResult(result, tmpDir);

      const memoryMdPath = path.join(tmpDir, "memory.md");
      const content = await fs.readFile(memoryMdPath, "utf-8");
      expect(content).toBe("# 项目记忆\n\n测试内容");
    });

    test("should update existing memory.md", async () => {
      // Create initial file
      const memoryMdPath = path.join(tmpDir, "memory.md");
      await fs.writeFile(memoryMdPath, "# 旧内容", "utf-8");

      const result = {
        scope: "project" as const,
        memoryMdContent: "# 新内容\n\n更新后的记忆",
        hasUpdates: true,
      };

      await applyMemoryResult(result, tmpDir);

      const content = await fs.readFile(memoryMdPath, "utf-8");
      expect(content).toBe("# 新内容\n\n更新后的记忆");
    });
  });

  describe("generateProjectSummary", () => {
    test("should generate summary with required fields", () => {
      const summary = generateProjectSummary({
        projectPath: "/path/to/project",
        projectName: "my-project",
        memoryMdContent: "# 我的项目\n\n这是一个测试项目",
        memoryMdPath: "/path/to/project/.roy/memory/memory.md",
      });

      expect(summary.projectPath).toBe("/path/to/project");
      expect(summary.projectName).toBe("my-project");
      expect(summary.lastUpdated).toBeGreaterThan(0);
      expect(summary.memoryMdPath).toBe("/path/to/project/.roy/memory/memory.md");
    });

    test("should extract first paragraph as summary", () => {
      const summary = generateProjectSummary({
        projectPath: "/path",
        projectName: "test",
        memoryMdContent: "# 第一段\n\n这是第一段的内容。\n\n# 第二段\n\n这是第二段。",
        memoryMdPath: "/path/memory.md",
      });

      // 移除标题前缀后，只包含第一段（第一行）
      expect(summary.summary).toContain("第一段");
      // 不包含内容，因为只取了第一段的第一行
    });

    test("should truncate short summary to 50 chars", () => {
      const longContent = "这是一个非常长的描述，包含很多内容需要被截断才能符合要求。";
      const summary = generateProjectSummary({
        projectPath: "/path",
        projectName: "test",
        memoryMdContent: `# 标题\n\n${longContent}`,
        memoryMdPath: "/path/memory.md",
      });

      expect(summary.shortSummary.length).toBeLessThanOrEqual(53); // 50 + "..."
    });
  });

  describe("buildProjectInput", () => {
    test("should build project input", async () => {
      const input = await buildProjectInput({
        projectPath: tmpDir,
        currentMemoryMd: "# 测试",
        messages: [],
      });

      expect(input.scope).toBe("project");
      expect(input.baseDir).toContain(".roy/memory");
      expect(input.currentMemoryMd).toBe("# 测试");
    });
  });

  describe("buildGlobalInput", () => {
    test("should build global input", () => {
      const input = buildGlobalInput({
        baseDir: tmpDir,
        currentMemoryMd: "# 全局",
        messages: [],
      });

      expect(input.scope).toBe("global");
      expect(input.baseDir).toBe(tmpDir);
      expect(input.currentMemoryMd).toBe("# 全局");
    });
  });
});
