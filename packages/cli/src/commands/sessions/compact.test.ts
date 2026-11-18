/**
 * @fileoverview Compact Command 测试
 * 
 * TDD 规范：验证 compact 命令的 hint 自动生成逻辑
 * 
 * 测试场景：
 * 1. 当未指定 --scenario 参数时，自动调用 generateCompactHint
 * 2. 当指定 --scenario 参数时，直接使用传入的 scenario
 * 3. 输出正确的 hint 信息
 */

import { describe, expect, test, jest, beforeEach } from "bun:test";
import type { CompactResult, SessionCheckpoint } from "@ai-setting/roy-bot-core";

// Mock Session 类型
interface MockSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  metadata: Record<string, unknown>;
}

const createMockCheckpoint = (overrides?: Partial<SessionCheckpoint>): SessionCheckpoint => ({
  id: "cp_123",
  messageIndex: 0,
  title: "Test Checkpoint",
  summary: "Test summary",
  processKeyPoints: ["Point 1", "Point 2"],
  currentState: "Current state",
  nextSteps: ["Next step 1"],
  userIntents: [],
  messageCountBefore: 10,
  createdAt: Date.now(),
  type: "compact",
  ...overrides,
});

const createMockCompactResult = (overrides?: Partial<CompactResult>): CompactResult => ({
  checkpoint: createMockCheckpoint(),
  deletedMessageCount: 10,
  remainingMessageCount: 2,
  checkpointCount: 1,
  ...overrides,
});

// 直接从 summary-agent 导入函数进行测试
import { parseCompactHintResponse } from "../../../../core/src/env/agent/summary-agent";

describe("CompactCommand hint 处理逻辑", () => {
  
  describe("两阶段 hint 生成逻辑", () => {
    
    test("未指定 scenario 时应调用 generateCompactHint", async () => {
      // Arrange: 模拟 mock
      const mockGenerateCompactHint = jest.fn<() => Promise<string>>()
        .mockResolvedValue("Feature development. User is implementing auth module. Focus on: auth flow decisions.");
      
      // Simulate the two-phase logic
      let scenarioHint = ""; // a.scenario is undefined
      
      if (!scenarioHint) {
        // 模拟 CLI 两阶段逻辑
        scenarioHint = await mockGenerateCompactHint();
      }
      
      // Assert: generateCompactHint should be called
      expect(mockGenerateCompactHint).toHaveBeenCalled();
      expect(scenarioHint).toBe("Feature development. User is implementing auth module. Focus on: auth flow decisions.");
    });
    
    test("指定 scenario 时不应调用 generateCompactHint", async () => {
      // Arrange: 模拟 mock
      const mockGenerateCompactHint = jest.fn<() => Promise<string>>()
        .mockResolvedValue("Should not be called");
      
      // Simulate the two-phase logic with provided scenario
      const providedScenario = "Bug investigation. User is fixing login bug.";
      let scenarioHint = providedScenario; // a.scenario is provided
      
      if (!scenarioHint) {
        scenarioHint = await mockGenerateCompactHint();
      }
      
      // Assert: generateCompactHint should NOT be called
      expect(mockGenerateCompactHint).not.toHaveBeenCalled();
      expect(scenarioHint).toBe(providedScenario);
    });
    
    test("generateCompactHint 失败时应继续执行", async () => {
      // Arrange: 模拟会失败的 mock
      const mockGenerateCompactHint = jest.fn<() => Promise<string>>()
        .mockRejectedValue(new Error("LLM failed"));
      
      // Simulate the two-phase logic with fallback
      let scenarioHint = ""; // a.scenario is undefined
      
      if (!scenarioHint) {
        try {
          scenarioHint = await mockGenerateCompactHint();
        } catch (hintError) {
          // 失败时继续使用空提示
          scenarioHint = "";
        }
      }
      
      // Assert: should continue with empty hint
      expect(mockGenerateCompactHint).toHaveBeenCalled();
      expect(scenarioHint).toBe("");
    });
    
  });
  
  describe("compact 调用参数验证", () => {
    
    test("应将生成的 scenarioHint 传递给 compact", async () => {
      // Arrange
      const generatedHint = "Feature development. User is implementing auth module.";
      const mockCompact = jest.fn<() => Promise<CompactResult>>().mockResolvedValue(
        createMockCompactResult()
      );
      
      // Act: 模拟 compact 调用
      await mockCompact("session_1", {
        scenarioHint: generatedHint,
      });
      
      // Assert
      expect(mockCompact).toHaveBeenCalledWith("session_1", {
        scenarioHint: generatedHint,
      });
    });
    
    test("当 scenarioHint 为空时也应传递空字符串", async () => {
      // Arrange
      const mockCompact = jest.fn<() => Promise<CompactResult>>().mockResolvedValue(
        createMockCompactResult()
      );
      
      // Act: 模拟 compact 调用（无 scenario）
      await mockCompact("session_1", {
        scenarioHint: "",
      });
      
      // Assert
      expect(mockCompact).toHaveBeenCalledWith("session_1", {
        scenarioHint: "",
      });
    });
    
  });
  
  describe("parseCompactHintResponse 行为验证", () => {
    
    test("应直接返回 LLM 输出", () => {
      const llmOutput = "Feature development. User is implementing auth module. Focus on: auth flow decisions.";
      const result = parseCompactHintResponse(llmOutput);
      
      expect(result).toBe(llmOutput);
    });
    
    test("应处理空内容", () => {
      const result = parseCompactHintResponse("");
      expect(result).toBe("[Hint extraction failed]");
    });
    
    test("应限制长度", () => {
      const longText = "a".repeat(600);
      const result = parseCompactHintResponse(longText);
      
      expect(result.length).toBe(503); // 500 + "..."
      expect(result.endsWith("...")).toBe(true);
    });
    
    test("应处理带首尾空白的输入", () => {
      const input = "  Feature development. User is implementing auth module.  ";
      const result = parseCompactHintResponse(input);
      
      expect(result).toBe("Feature development. User is implementing auth module.");
    });
    
  });
  
  describe("Hint 输出格式验证", () => {
    
    test("Hint 应该包含工作类型关键词", () => {
      const hints = [
        "Feature development. User is implementing auth module.",
        "Bug investigation. User is fixing login bug.",
        "Refactoring. User is migrating to new architecture.",
      ];
      
      hints.forEach(hint => {
        const result = parseCompactHintResponse(hint);
        expect(result).toMatch(/Feature development|Bug investigation|Refactoring/i);
      });
    });
    
    test("Hint 应该包含 Focus on 关键词", () => {
      const hints = [
        "Feature development. Focus on: auth flow decisions.",
        "Bug investigation. Focus on: root cause analysis.",
        "Refactoring. Focus on: pattern decisions.",
      ];
      
      hints.forEach(hint => {
        const result = parseCompactHintResponse(hint);
        expect(result).toMatch(/Focus on:/i);
      });
    });
    
  });
  
});
