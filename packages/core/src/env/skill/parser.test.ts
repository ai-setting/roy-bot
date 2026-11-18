import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import { parseFrontmatter, parseSkillFile } from "./parser";
import type { SkillSource } from "./types";

describe("parser", () => {
  const testDir = path.join(__dirname, "__test_temp__");

  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("parseFrontmatter", () => {
    it("should parse simple frontmatter with quoted values", () => {
      const text = `name: brainstorming
description: "Use before any creative work..."`;
      
      const result = parseFrontmatter(text);
      
      expect(result.name).toBe("brainstorming");
      expect(result.description).toBe("Use before any creative work...");
    });

    it("should parse frontmatter with unquoted values", () => {
      const text = `name: tdd
description: Use when implementing features`;
      
      const result = parseFrontmatter(text);
      
      expect(result.name).toBe("tdd");
      expect(result.description).toBe("Use when implementing features");
    });

    it("should handle empty text", () => {
      const result = parseFrontmatter("");
      
      expect(Object.keys(result).length).toBe(0);
    });
  });

  describe("parseSkillFile", () => {
    it("should parse valid SKILL.md file", async () => {
      const filePath = path.join(testDir, "test-skill.md");
      const content = `---
name: test-skill
description: A test skill for unit testing
---
# Test Skill

This is the skill content.`;
      
      await fs.writeFile(filePath, content);
      const result = await parseSkillFile(filePath, "user");
      
      expect(result).not.toBeNull();
      expect(result!.name).toBe("test-skill");
      expect(result!.description).toBe("A test skill for unit testing");
      expect(result!.source).toBe("user");
      expect(result!.content).toContain("# Test Skill");
      expect(result!.content).not.toContain("---");
    });

    it("should return null for missing frontmatter", async () => {
      const filePath = path.join(testDir, "no-frontmatter.md");
      const content = `# No Frontmatter

This file has no frontmatter.`;
      
      await fs.writeFile(filePath, content);
      const result = await parseSkillFile(filePath, "user");
      
      expect(result).toBeNull();
    });

    it("should return null for missing name", async () => {
      const filePath = path.join(testDir, "no-name.md");
      const content = `---
description: Has description but no name
---
Content`;
      
      await fs.writeFile(filePath, content);
      const result = await parseSkillFile(filePath, "user");
      
      expect(result).toBeNull();
    });

    it("should return null for missing description", async () => {
      const filePath = path.join(testDir, "no-description.md");
      const content = `---
name: skill-without-description
---
Content`;
      
      await fs.writeFile(filePath, content);
      const result = await parseSkillFile(filePath, "user");
      
      expect(result).toBeNull();
    });

    it("should handle non-existent file", async () => {
      const result = await parseSkillFile("/non/existent/path.md", "user");
      
      expect(result).toBeNull();
    });
  });
});
