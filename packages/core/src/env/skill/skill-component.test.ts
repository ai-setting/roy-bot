import { describe, it, expect, beforeEach, vi } from "bun:test";
import { SkillComponent } from "./skill-component";
import { ConfigComponent } from "../../config/config-component";
import type { ComponentConfig } from "../component";

describe("SkillComponent", () => {
  let component: SkillComponent;
  let configComponent: ConfigComponent;
  let mockToolComponent: any;

  beforeEach(() => {
    configComponent = new ConfigComponent();
    component = new SkillComponent();
    
    // 创建 mock ToolComponent
    mockToolComponent = {
      register: vi.fn(),
      unregister: vi.fn(),
    };
  });

  describe("init", () => {
    it("should initialize with default config", async () => {
      await component.init({
        options: {
          configComponent,
        },
      } as ComponentConfig);
      
      expect(component.getStatus()).toBe("running");
    });

    it("should use custom config when provided", async () => {
      await component.init({
        options: {
          configComponent,
          config: {
            recursive: false,
          },
        },
      } as ComponentConfig);
      
      expect(component.getStatus()).toBe("running");
    });
  });

  describe("start", () => {
    it("should register SkillTool to ToolComponent", async () => {
      // 创建一个假的 env
      const mockEnv = {
        getComponent: vi.fn((name: string) => {
          if (name === "tool") return mockToolComponent;
          return null;
        }),
      };
      
      await component.init({
        options: {
          configComponent,
        },
      } as ComponentConfig);
      (component as any).env = mockEnv;
      
      // Mock scanner
      const mockScanner = {
        scan: vi.fn().mockResolvedValue(new Map()),
      };
      (component as any).scanner = mockScanner;
      
      await component.start();
      
      expect(mockToolComponent.register).toHaveBeenCalled();
    });

    it("should handle missing ToolComponent gracefully", async () => {
      const mockEnv = {
        getComponent: vi.fn(() => null),
      };
      
      await component.init({
        options: {
          configComponent,
        },
      } as ComponentConfig);
      (component as any).env = mockEnv;
      
      const mockScanner = {
        scan: vi.fn().mockResolvedValue(new Map()),
      };
      (component as any).scanner = mockScanner;
      
      await component.start();
      
      expect(mockToolComponent.register).not.toHaveBeenCalled();
    });
  });

  describe("getSkill", () => {
    it("should return undefined for unknown skill", () => {
      (component as any).skillsMap = new Map();
      
      const result = component.getSkill("non-existent");
      
      expect(result).toBeUndefined();
    });
  });

  describe("getSkillList", () => {
    it("should return empty array when no skills", () => {
      (component as any).skillsMap = new Map();
      
      const result = component.getSkillList();
      
      expect(result).toEqual([]);
    });

    it("should return skills as list items", () => {
      (component as any).skillsMap = new Map([
        ["brainstorming", {
          name: "brainstorming",
          description: "Test",
          source: "user",
          filePath: "/test/path.md",
          content: "# Test",
          loadedAt: Date.now(),
        }],
      ]);
      
      const result = component.getSkillList();
      
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("brainstorming");
      expect(result[0].description).toBe("Test");
      expect(result[0].source).toBe("user");
    });
  });

  describe("hasSkill", () => {
    it("should return true for existing skill", () => {
      (component as any).skillsMap = new Map([["brainstorming", {} as any]]);
      
      expect(component.hasSkill("brainstorming")).toBe(true);
    });

    it("should return false for non-existing skill", () => {
      (component as any).skillsMap = new Map();
      
      expect(component.hasSkill("non-existent")).toBe(false);
    });
  });

  describe("getAllSkills", () => {
    it("should return empty array when no skills", () => {
      (component as any).skillsMap = new Map();
      
      const result = component.getAllSkills();
      
      expect(result).toEqual([]);
    });

    it("should return all skills as array", () => {
      const skill1 = { name: "brainstorming", description: "Test", source: "user", filePath: "/1", content: "#1", loadedAt: 1 };
      const skill2 = { name: "tdd", description: "Test2", source: "project", filePath: "/2", content: "#2", loadedAt: 2 };
      (component as any).skillsMap = new Map([["brainstorming", skill1], ["tdd", skill2]]);
      
      const result = component.getAllSkills();
      
      expect(result).toHaveLength(2);
    });
  });

  describe("reload", () => {
    it("should unregister and re-register SkillTool", async () => {
      const mockEnv = {
        getComponent: vi.fn(() => mockToolComponent),
      };
      
      await component.init({
        options: {
          configComponent,
        },
      } as ComponentConfig);
      (component as any).env = mockEnv;
      (component as any).toolComponent = mockToolComponent;
      
      const mockScanner = {
        scan: vi.fn().mockResolvedValue(new Map()),
      };
      (component as any).scanner = mockScanner;
      (component as any).skillsMap = new Map();
      
      await component.reload();
      
      expect(mockToolComponent.unregister).toHaveBeenCalledWith("skill");
      expect(mockToolComponent.register).toHaveBeenCalled();
    });

    it("should throw error when ToolComponent not available", async () => {
      const mockEnv = {
        getComponent: vi.fn(() => null),
      };
      
      await component.init({
        options: {
          configComponent,
        },
      } as ComponentConfig);
      (component as any).env = mockEnv;
      (component as any).toolComponent = undefined;
      
      await expect(component.reload()).rejects.toThrow("ToolComponent not available");
    });
  });

  describe("stop", () => {
    it("should unregister tool on stop", async () => {
      const mockEnv = {
        getComponent: vi.fn(() => mockToolComponent),
      };
      
      await component.init({
        options: {
          configComponent,
        },
      } as ComponentConfig);
      (component as any).env = mockEnv;
      (component as any).toolComponent = mockToolComponent;
      
      await component.stop();
      
      expect(mockToolComponent.unregister).toHaveBeenCalledWith("skill");
    });
  });
});
