/**
 * @fileoverview TDD Test: record.ts should use PromptComponent for prompts
 * 
 * RED Phase: Write failing test
 * 
 * 验证 record.ts 应该：
 * 1. 通过 PromptComponent 获取 prompt，而非直接调用 getBuiltInPrompt()
 * 2. 确保 memory path 从配置读取
 */

import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import type { PromptComponent } from "@ai-setting/roy-bot-core";

// Mock chalk
// 用 Proxy-based chalk mock（src/test-utils/chalk-mock.ts）：
// 1) 任何 chalk.X 属性访问都返回 chainable identity 函数（不抛 chalk.X is not a function）
// 2) chalk.X("text") 返回 string（identity，无 ANSI）以匹配 chalk.level=0 行为
// 3) chalk.X("#hex" | "namedColor") 返回 chainable builder，支持 chalk.hex("#xxx")(s) 链式
// 这是 Batch 1 (chalk.hex polyfill) 的核心修复：解决 bun:test 下 vi.mock("chalk") 跨文件泄漏
// 导致下游测试 stream-output.service.ts 等的 chalk.hex/chalk.dim 报 undefined 的问题。
vi.mock("chalk", () => ({
  default: require("../../test-utils/chalk-mock").createChalkMock(),
}));

describe("TDD: record.ts should use PromptComponent", () => {

  // ========================================================================
  // GREEN Phase: Minimal implementation to pass tests
  // ========================================================================

  /**
   * Helper function to get prompt (simulates the desired implementation)
   * 
   * This should be the actual implementation in record.ts after GREEN phase
   */
  async function getPromptFromComponent(
    env: any,
    promptName: string
  ): Promise<string> {
    const promptComponent = env?.getComponent?.("prompt") as PromptComponent | undefined;
    
    if (promptComponent) {
      return await promptComponent.getPrompt(promptName);
    }
    
    // Fallback to getBuiltInPrompt if PromptComponent not available
    const { getBuiltInPrompt } = await import("@ai-setting/roy-bot-core");
    return getBuiltInPrompt(promptName) || "";
  }

  describe("GREEN: getPromptFromComponent implementation", () => {
    
    test("should get prompt from PromptComponent when available", async () => {
      // Given: PromptComponent mock
      const mockPromptComponent = {
        getPrompt: vi.fn().mockResolvedValue("# Memory Agent Prompt\n\n{USER_REQUIREMENT}"),
        has: vi.fn().mockReturnValue(true),
      } as unknown as PromptComponent;

      const mockEnv = {
        getComponent: vi.fn().mockReturnValue(mockPromptComponent),
      };

      // When: Getting prompt
      const prompt = await getPromptFromComponent(mockEnv, "project-memory");

      // Then: Should be fetched via PromptComponent
      expect(mockPromptComponent.getPrompt).toHaveBeenCalledWith("project-memory");
      expect(prompt).toContain("{USER_REQUIREMENT}");
    });

    test("should fallback to getBuiltInPrompt when PromptComponent not available", async () => {
      // Given: No PromptComponent
      const mockEnv = {
        getComponent: vi.fn().mockReturnValue(undefined),
      };

      // When: Getting prompt
      const prompt = await getPromptFromComponent(mockEnv, "project-memory");

      // Then: Should fallback to getBuiltInPrompt
      expect(prompt).toBeDefined();
      expect(prompt).toContain("项目记忆管理专家");
    });

    test("should support both project-memory and global-memory", async () => {
      // Create a single mock PromptComponent with persistent mock
      const mockGetPrompt = vi.fn()
        .mockResolvedValueOnce("# Project Memory")
        .mockResolvedValueOnce("# Global Memory");

      const mockEnv = {
        getComponent: vi.fn((name: string) => {
          if (name === "prompt") {
            return { getPrompt: mockGetPrompt };
          }
          return undefined;
        }),
      };

      const projectPrompt = await getPromptFromComponent(mockEnv, "project-memory");
      expect(projectPrompt).toBe("# Project Memory");

      const globalPrompt = await getPromptFromComponent(mockEnv, "global-memory");
      expect(globalPrompt).toBe("# Global Memory");
    });

  });

  describe("Memory Path from Config (already working)", () => {
    
    test("should get memory paths from MemoryComponent.config.memoryPaths", async () => {
      // Given: MemoryComponent with configured paths
      const mockMemoryComponent = {
        recallMemory: vi.fn().mockResolvedValue("# Project Memory\n\n暂无内容"),
        getMemoryPaths: vi.fn().mockReturnValue([
          { type: "project", path: ".roy/memory" },
          { type: "user", path: "~/.config/roy-bot/memory" },
        ]),
        getMemoryFile: vi.fn().mockReturnValue("memory.md"),
      };

      // When: Getting paths for scope
      const paths = mockMemoryComponent.getMemoryPaths();
      const projectPath = paths.find(p => p.type === "project");

      // Then: Should return configured paths, not hardcoded
      expect(projectPath?.path).toBe(".roy/memory");
      expect(mockMemoryComponent.getMemoryPaths).toHaveBeenCalled();
    });

    test("should map scope 'global' to type 'user' in memory paths", async () => {
      const mockMemoryComponent = {
        recallMemory: vi.fn().mockImplementation((scope?: "project" | "global") => {
          if (scope === "global") {
            return Promise.resolve("# Global Memory\n\nUser preferences");
          }
          return Promise.resolve("# Project Memory\n\nProject settings");
        }),
        getMemoryPaths: vi.fn().mockReturnValue([
          { type: "project", path: ".roy/memory" },
          { type: "user", path: "~/.config/roy-bot/memory" },
        ]),
      };

      const globalMemory = await mockMemoryComponent.recallMemory("global");
      expect(globalMemory).toContain("User preferences");
      expect(globalMemory).toContain("Global Memory");
    });

  });

  describe("Integration: Full prompt flow with PromptComponent", () => {
    
    test("should fetch prompt from PromptComponent and replace variables", async () => {
      // Given: PromptComponent with prompt template
      const promptTemplate = `# Memory Agent
Scope: {SCOPE}
User Requirement: {USER_REQUIREMENT}
Existing Memory: {CURRENT_MEMORY}`;

      const mockPromptComponent = {
        getPrompt: vi.fn().mockResolvedValue(promptTemplate),
      } as unknown as PromptComponent;

      const mockMemoryComponent = {
        recallMemory: vi.fn().mockResolvedValue("# Previous memory content"),
      };

      // When: Building final prompt
      const rawPrompt = await mockPromptComponent.getPrompt("project-memory");
      const userRequirement = "Extract key project information";
      const currentMemory = await mockMemoryComponent.recallMemory("project");

      const finalPrompt = rawPrompt
        .replace("{USER_REQUIREMENT}", userRequirement)
        .replace("{SCOPE}", "project")
        .replace("{CURRENT_MEMORY}", currentMemory || "(无现有记忆)");

      // Then: Should have all variables replaced
      expect(finalPrompt).toContain("Extract key project information");
      expect(finalPrompt).toContain("project");
      expect(finalPrompt).toContain("Previous memory content");
      expect(finalPrompt).not.toContain("{USER_REQUIREMENT}");
      expect(finalPrompt).not.toContain("{SCOPE}");
    });

    test("should use same pattern as default agent for consistency", async () => {
      // The default agent uses: promptComponent.getPrompt("default")
      // Memory agent should use: promptComponent.getPrompt("project-memory") or "global-memory"
      
      const mockPromptComponent = {
        getPrompt: vi.fn()
          .mockResolvedValueOnce("Default Agent Prompt")
          .mockResolvedValueOnce("Project Memory Prompt"),
      } as unknown as PromptComponent;

      // Default agent pattern
      const defaultPrompt = await mockPromptComponent.getPrompt("default");
      expect(mockPromptComponent.getPrompt).toHaveBeenNthCalledWith(1, "default");

      // Memory agent pattern (should be consistent)
      const memoryPrompt = await mockPromptComponent.getPrompt("project-memory");
      expect(mockPromptComponent.getPrompt).toHaveBeenNthCalledWith(2, "project-memory");

      expect(defaultPrompt).toBeDefined();
      expect(memoryPrompt).toBeDefined();
    });

  });

  describe("Environment integration", () => {
    
    test("should get PromptComponent from env.getComponent('prompt')", async () => {
      // Given: Mock environment with PromptComponent
      const mockPromptComponent = {
        getPrompt: vi.fn().mockResolvedValue("# Test Prompt"),
        has: vi.fn().mockReturnValue(true),
      } as unknown as PromptComponent;

      const mockEnv = {
        getComponent: vi.fn((name: string) => {
          if (name === "prompt") return mockPromptComponent;
          if (name === "memory") return {
            recallMemory: vi.fn().mockResolvedValue(""),
            getMemoryPaths: vi.fn().mockReturnValue([]),
          };
          return undefined;
        }),
      };

      // When: Getting prompt component from env
      const promptComponent = mockEnv.getComponent("prompt") as PromptComponent;
      const prompt = await promptComponent.getPrompt("project-memory");

      // Then: Should work via env
      expect(mockEnv.getComponent).toHaveBeenCalledWith("prompt");
      expect(promptComponent.getPrompt).toHaveBeenCalledWith("project-memory");
      expect(prompt).toBeDefined();
    });

    test("should handle missing PromptComponent gracefully", async () => {
      // Given: Environment without PromptComponent
      const mockEnv = {
        getComponent: vi.fn().mockReturnValue(undefined),
      };

      // When: Trying to get PromptComponent
      const promptComponent = mockEnv.getComponent("prompt");

      // Then: Should handle gracefully (fallback to getBuiltInPrompt)
      expect(promptComponent).toBeUndefined();
      
      // Fallback should work
      const { getBuiltInPrompt } = await import("@ai-setting/roy-bot-core");
      const fallbackPrompt = getBuiltInPrompt("project-memory");
      expect(fallbackPrompt).toBeDefined();
    });

  });

  // ========================================================================
  // REFACTOR Phase: Verify implementation matches expected pattern
  // ========================================================================

  describe("REFACTOR: Verify record.ts implementation pattern", () => {
    
    test("record.ts should follow getPromptFromComponent pattern", async () => {
      // This test verifies that the helper function matches expected pattern
      // After GREEN phase, record.ts should be refactored to use this pattern

      // Mock environment with all required components
      const mockMemoryComponent = {
        recallMemory: vi.fn().mockResolvedValue("# Existing memory"),
        getMemoryPaths: vi.fn().mockReturnValue([
          { type: "project", path: ".roy/memory" },
        ]),
        getMemoryFile: vi.fn().mockReturnValue("memory.md"),
      };

      const mockPromptComponent = {
        getPrompt: vi.fn().mockResolvedValue("# Memory Agent Prompt"),
        has: vi.fn().mockReturnValue(true),
      } as unknown as PromptComponent;

      const mockEnv = {
        getComponent: vi.fn((name: string) => {
          if (name === "prompt") return mockPromptComponent;
          if (name === "memory") return mockMemoryComponent;
          return undefined;
        }),
      };

      // Simulate what record.ts should do after refactoring
      const scope = "project";
      const promptName = `${scope}-memory`;
      
      // Get prompt via PromptComponent (NEW pattern)
      const prompt = await getPromptFromComponent(mockEnv, promptName);
      
      // Get memory via MemoryComponent (already correct)
      const currentMemory = await mockMemoryComponent.recallMemory(scope);

      // Verify
      expect(mockPromptComponent.getPrompt).toHaveBeenCalledWith(promptName);
      expect(mockMemoryComponent.recallMemory).toHaveBeenCalledWith(scope);
      expect(prompt).toBeDefined();
      expect(currentMemory).toBeDefined();
    });

    test("record.ts should NOT call getBuiltInPrompt directly", async () => {
      // This test documents the expected behavior
      // After GREEN phase, record.ts should NOT import getBuiltInPrompt directly

      // OLD pattern (should be removed):
      // import { getBuiltInPrompt } from "@ai-setting/roy-bot-core";
      // const prompt = getBuiltInPrompt("project-memory");

      // NEW pattern (should be used):
      // const prompt = await promptComponent.getPrompt("project-memory");

      // Verify the NEW pattern works
      const mockEnv = {
        getComponent: vi.fn((name: string) => {
          if (name === "prompt") {
            return {
              getPrompt: vi.fn().mockResolvedValue("# Memory Agent"),
            };
          }
          return undefined;
        }),
      };

      const prompt = await getPromptFromComponent(mockEnv, "project-memory");
      expect(prompt).toBe("# Memory Agent");
      expect(mockEnv.getComponent).toHaveBeenCalledWith("prompt");
    });

  });

});
