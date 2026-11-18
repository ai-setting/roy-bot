/**
 * @fileoverview Memory Plugin Agent 集成测试 (Simplified)
 * 
 * 简化后的 Memory Agent 集成测试
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import path from "path";
import fs from "fs/promises";
import os from "os";
import type {
  MemoryAgentInput,
  MemoryAgentResult,
  ProjectSummary,
} from "./memory-agent";
import {
  buildProjectInput,
  buildGlobalInput,
  applyMemoryResult,
  generateProjectSummary,
} from "./memory-agent";

describe("buildProjectInput", () => {
  let testDir: string;
  let projectDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `memory-agent-test-${Date.now()}`);
    projectDir = path.join(testDir, "project-a");
    await fs.mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it("should build input for project scope", async () => {
    const input = await buildProjectInput({
      projectPath: projectDir,
      currentMemoryMd: "# Project Memory\n\nTest content",
      messages: [
        { role: "user", content: "Hello" } as any,
      ],
    });

    expect(input.scope).toBe("project");
    expect(input.baseDir).toContain(".roy/memory");
    expect(input.currentMemoryMd).toContain("Project Memory");
    expect(input.messages.length).toBe(1);
  });
});

describe("buildGlobalInput", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `memory-agent-test-${Date.now()}`);
    await fs.mkdir(path.join(testDir, "memory"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it("should build input for global scope with project summaries", async () => {
    const projectSummaries: ProjectSummary[] = [
      {
        projectPath: "/path/to/project-a",
        projectName: "project-a",
        lastUpdated: Date.now(),
        summary: "Project A summary",
        shortSummary: "A",
        memoryMdPath: "/path/to/project-a/.roy/memory/memory.md",
      },
    ];

    const input = buildGlobalInput({
      baseDir: testDir,
      currentMemoryMd: "# Global Memory",
      messages: [],
      projectSummaries,
    });

    expect(input.scope).toBe("global");
    expect(input.baseDir).toBe(testDir);
    expect(input.projectSummaries).toHaveLength(1);
    expect(input.projectSummaries![0].projectName).toBe("project-a");
  });
});

describe("applyMemoryResult", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `memory-agent-test-${Date.now()}`);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it("should write memory.md content", async () => {
    const result: MemoryAgentResult = {
      scope: "project",
      memoryMdContent: "# Updated Memory\n\nNew content",
      hasUpdates: true,
    };

    await applyMemoryResult(result, testDir);

    const memoryPath = path.join(testDir, "memory.md");
    const content = await fs.readFile(memoryPath, "utf-8");
    expect(content).toContain("Updated Memory");
  });
});

describe("generateProjectSummary", () => {
  it("should generate summary with required fields", () => {
    const summary = generateProjectSummary({
      projectPath: "/path/to/project",
      projectName: "test-project",
      memoryMdContent: "# Test Project\n\nSome important content here.",
      memoryMdPath: "/path/to/project/.roy/memory/memory.md",
    });

    expect(summary.projectPath).toBe("/path/to/project");
    expect(summary.projectName).toBe("test-project");
    expect(summary.lastUpdated).toBeGreaterThan(0);
    expect(summary.summary).toBeTruthy();
    expect(summary.shortSummary).toBeTruthy();
    expect(summary.memoryMdPath).toBe("/path/to/project/.roy/memory/memory.md");
  });

  it("should generate short summary from memory content", () => {
    const summary = generateProjectSummary({
      projectPath: "/path/to/project",
      projectName: "test",
      memoryMdContent: "# Test Project\n\nThis is a long description of what the project does with many more details.",
      memoryMdPath: "/path/memory.md",
    });

    // Short summary should be shorter or equal to full summary
    expect(summary.shortSummary.length).toBeLessThanOrEqual(summary.summary.length);
  });
});
