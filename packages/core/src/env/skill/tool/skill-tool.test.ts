import { describe, it, expect } from "vitest";
import { buildSkillDescription, createSkillTool } from "./skill-tool";
import type { SkillListItem } from "../types";

describe("skill-tool", () => {
  describe("buildSkillDescription", () => {
    it("should build description with skill list", () => {
      const items: SkillListItem[] = [
        { name: "brainstorming", description: "Use before creative work", source: "user" },
        { name: "tdd", description: "Use before implementing features", source: "project" },
      ];
      
      const result = buildSkillDescription(items);
      
      expect(result).toContain("Load a skill by name");
      expect(result).toContain("brainstorming");
      expect(result).toContain("Use before creative work");
      expect(result).toContain("tdd");
      expect(result).toContain("Use before implementing features");
      expect(result).toContain("skill' parameter");
    });

    it("should handle empty list", () => {
      const result = buildSkillDescription([]);
      
      expect(result).toContain("No skills available");
    });

    it("should format skills with markdown bold", () => {
      const items: SkillListItem[] = [
        { name: "test", description: "A test skill", source: "user" },
      ];
      
      const result = buildSkillDescription(items);
      
      expect(result).toContain("**test**");
    });
  });

  describe("SkillTool", () => {
    it("should return skill content for valid skill name", async () => {
      const mockGetSkillList = () => [
        { name: "brainstorming", description: "Test", source: "user" as const }
      ];
      const mockGetSkill = (name: string) => {
        if (name === "brainstorming") {
          return { content: "# Brainstorming\n\nTest content" };
        }
        return undefined;
      };
      
      const tool = createSkillTool(mockGetSkillList, mockGetSkill);
      
      const result = await tool.execute({ skill: "brainstorming" }, {} as any);
      
      expect(result.success).toBe(true);
      expect(result.output).toContain("Brainstorming");
    });

    it("should return error for invalid skill name", async () => {
      const mockGetSkillList = () => [
        { name: "brainstorming", description: "Test", source: "user" as const }
      ];
      const mockGetSkill = () => undefined;
      
      const tool = createSkillTool(mockGetSkillList, mockGetSkill);
      
      const result = await tool.execute({ skill: "non-existent" }, {} as any);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain("Skill not found");
    });

    it("should have correct tool name", () => {
      const tool = createSkillTool(() => [], () => undefined);
      
      expect(tool.name).toBe("skill");
    });

    it("should have skill parameter", () => {
      const tool = createSkillTool(() => [], () => undefined);
      
      expect(tool.parameters.shape).toBeDefined();
    });

    it("should generate description from skill list", () => {
      const items: SkillListItem[] = [
        { name: "brainstorming", description: "Test brainstorming", source: "user" as const },
        { name: "tdd", description: "Test TDD", source: "project" as const },
      ];
      
      const tool = createSkillTool(() => items, () => undefined);
      
      expect(tool.description).toContain("brainstorming");
      expect(tool.description).toContain("Test brainstorming");
      expect(tool.description).toContain("tdd");
      expect(tool.description).toContain("Test TDD");
    });
  });
});
