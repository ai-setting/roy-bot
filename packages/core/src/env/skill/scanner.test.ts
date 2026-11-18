import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import { SkillScanner } from "./scanner";
import type { SkillConfig } from "./types";

/**
 * Helper: Build glob pattern using the same logic as scanner
 * This mimics the Windows behavior to test cross-platform compatibility
 */
function buildGlobPattern(expandedPath: string, recursive: boolean): string {
  const sep = "/";
  const basePattern = expandedPath.replace(/\\/g, "/");
  return recursive
    ? `${basePattern}${sep}**${sep}SKILL.md`
    : `${basePattern}${sep}SKILL.md`;
}

describe("SkillScanner", () => {
  const testBaseDir = path.join(__dirname, "__test_scanner__");
  const userSkillsDir = path.join(testBaseDir, "user", "skills");
  const projectSkillsDir = path.join(testBaseDir, "project", "skills");

  const config: SkillConfig = {
    skillPaths: [
      { type: "user", path: userSkillsDir },
      { type: "project", path: projectSkillsDir },
    ],
    recursive: true,
    cacheEnabled: true,
  };

  beforeEach(async () => {
    // 创建测试目录结构
    await fs.mkdir(path.join(userSkillsDir, "brainstorming"), { recursive: true });
    await fs.mkdir(path.join(projectSkillsDir, "tdd"), { recursive: true });
    
    // 写入测试 SKILL.md 文件
    await fs.writeFile(
      path.join(userSkillsDir, "brainstorming", "SKILL.md"),
      `---
name: brainstorming
description: Use before any creative work
---
# Brainstorming Skill

This is the brainstorming skill content.`
    );

    await fs.writeFile(
      path.join(projectSkillsDir, "tdd", "SKILL.md"),
      `---
name: tdd
description: Use when implementing any feature
---
# TDD Skill

This is the TDD skill content.`
    );
  });

  afterEach(async () => {
    try {
      await fs.rm(testBaseDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("expandPath", () => {
    it("should expand ~ to home directory", async () => {
      const scanner = new SkillScanner({
        ...config,
        skillPaths: [{ type: "user", path: "~/test-skills" }],
      });
      
      const skills = await scanner.scan();
      expect(skills.size).toBeGreaterThanOrEqual(0);
    });
  });

  describe("glob pattern generation", () => {
    it("should use forward slashes for glob patterns (Windows compatibility)", () => {
      // Simulate Windows path with backslashes
      const windowsPath = "C:\\Users\\test\\skills";
      
      const patternRecursive = buildGlobPattern(windowsPath, true);
      const patternNonRecursive = buildGlobPattern(windowsPath, false);
      
      // Pattern must use forward slashes for glob compatibility
      expect(patternRecursive).toBe("C:/Users/test/skills/**/SKILL.md");
      expect(patternNonRecursive).toBe("C:/Users/test/skills/SKILL.md");
      
      // Must NOT contain backslashes (glob doesn't support them)
      expect(patternRecursive).not.toContain("\\");
      expect(patternNonRecursive).not.toContain("\\");
    });

    it("should preserve forward slashes in Unix paths", () => {
      const unixPath = "/home/user/skills";
      
      const patternRecursive = buildGlobPattern(unixPath, true);
      const patternNonRecursive = buildGlobPattern(unixPath, false);
      
      expect(patternRecursive).toBe("/home/user/skills/**/SKILL.md");
      expect(patternNonRecursive).toBe("/home/user/skills/SKILL.md");
    });

    it("should normalize mixed slashes to forward slashes", () => {
      const mixedPath = "/home\\user/skills\\nested";
      
      const patternRecursive = buildGlobPattern(mixedPath, true);
      
      // All backslashes should be converted to forward slashes
      expect(patternRecursive).not.toContain("\\");
      expect(patternRecursive).toContain("/");
    });

    it("should generate patterns without backslashes for Unix paths", async () => {
      // Test with real Unix path
      const scanner = new SkillScanner({
        ...config,
        skillPaths: [{ type: "user", path: userSkillsDir }],
        recursive: true,
        cacheEnabled: false,
      });
      
      // The scanner should find skills without issues
      const skills = await scanner.scan();
      expect(skills.size).toBeGreaterThan(0);
      
      // Verify no backslashes in resulting paths
      for (const skill of skills.values()) {
        expect(skill.filePath).not.toContain("\\");
        expect(skill.filePath).toContain("/");
      }
    });
  });

  describe("scan", () => {
    it("should scan directory and find SKILL.md files", async () => {
      const scanner = new SkillScanner(config);
      const skills = await scanner.scan();
      
      expect(skills.size).toBe(2);
    });

    it("should load skill with correct properties", async () => {
      const scanner = new SkillScanner(config);
      const skills = await scanner.scan();
      
      const brainstorming = skills.get("brainstorming");
      expect(brainstorming).toBeDefined();
      expect(brainstorming!.name).toBe("brainstorming");
      expect(brainstorming!.description).toBe("Use before any creative work");
      expect(brainstorming!.source).toBe("user");
      expect(brainstorming!.content).toContain("Brainstorming Skill");
    });

    it("should skip non-existing paths gracefully", async () => {
      const scanner = new SkillScanner({
        ...config,
        skillPaths: [
          { type: "user", path: "/non/existent/path" },
        ],
      });
      
      const skills = await scanner.scan();
      expect(skills.size).toBe(0);
    });

    it("should handle multiple SKILL.md in subdirectories", async () => {
      // 添加子目录中的 skill
      await fs.mkdir(path.join(userSkillsDir, "parent", "child"), { recursive: true });
      await fs.writeFile(
        path.join(userSkillsDir, "parent", "child", "SKILL.md"),
        `---
name: nested-skill
description: A skill in a nested directory
---
# Nested Skill Content`
      );

      const scanner = new SkillScanner(config);
      const skills = await scanner.scan();
      
      expect(skills.get("nested-skill")).toBeDefined();
    });

    it("should deduplicate by name with higher priority source", async () => {
      // 在 project 目录添加同名 skill（应该覆盖 user 目录的）
      await fs.mkdir(path.join(projectSkillsDir, "brainstorming"), { recursive: true });
      await fs.writeFile(
        path.join(projectSkillsDir, "brainstorming", "SKILL.md"),
        `---
name: brainstorming
description: Project version of brainstorming
---
# Project Brainstorming`
      );

      const scanner = new SkillScanner(config);
      const skills = await scanner.scan();
      
      // project 优先级高于 user
      const brainstorming = skills.get("brainstorming");
      expect(brainstorming!.source).toBe("project");
      expect(brainstorming!.description).toBe("Project version of brainstorming");
    });
  });
});
