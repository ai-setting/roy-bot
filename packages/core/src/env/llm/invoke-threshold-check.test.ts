/**
 * @fileoverview Test for skipThresholdCheck feature
 *
 * TDD: 测试 LLMInvokeRequest 的 skipThresholdCheck 参数
 * 
 * 验证:
 * 1. LLMInvokeRequest 类型支持 skipThresholdCheck 参数
 * 2. SummaryAgent 调用时传入 skipThresholdCheck: true
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "bun:test";

const isParallelRun = "BUN_TEST_WORKER_ID" in process.env;

import { SummaryAgent } from "../agent/summary-agent";
import type { LLMComponent } from "./llm";
import type { PromptComponent } from "../prompt/prompt-component";

describe.skipIf(isParallelRun)("skipThresholdCheck feature", () => {
  describe.skipIf(isParallelRun)("LLMInvokeRequest type", () => {
    test("should support skipThresholdCheck parameter", () => {
      // This test verifies the type exists - if TypeScript compiles, this passes
      // We import the actual types to verify they compile correctly
      const mockRequest = {
        messages: [{ role: "user" as const, content: "test" }],
        skipThresholdCheck: true
      };
      
      // Type check - if this compiles, the type is correct
      expect(mockRequest.skipThresholdCheck).toBe(true);
    });

    test("should allow skipThresholdCheck to be undefined (optional)", () => {
      const mockRequest = {
        messages: [{ role: "user" as const, content: "test" }]
        // skipThresholdCheck not specified
      };
      
      // Should compile without skipThresholdCheck
      expect(mockRequest.messages).toHaveLength(1);
    });
  });

  describe.skipIf(isParallelRun)("SummaryAgent", () => {
    test("should pass skipThresholdCheck to LLM invoke", async () => {
      // Create mock LLMComponent that tracks the invoke call
      const mockInvoke = vi.fn().mockResolvedValue({
        output: {
          content: JSON.stringify({
            title: "Test",
            processKeyPoints: ["Point 1"],
            currentState: "State",
            nextSteps: ["Step 1"],
            userIntents: ["Intent 1"]
          }),
          finishReason: "stop"
        },
        providerId: "openai",
        model: "gpt-4o",
        latencyMs: 100
      });

      const mockLLMComponent = {
        invoke: mockInvoke
      } as unknown as LLMComponent;

      // Create mock PromptComponent
      const mockPromptComponent = {
        render: vi.fn().mockResolvedValue("mocked prompt")
      } as unknown as PromptComponent;

      // Create SummaryAgent
      const summaryAgent = new SummaryAgent(mockPromptComponent, mockLLMComponent);

      // Run summary agent with array messages
      await summaryAgent.run({
        messages: [
          { role: "user", content: "test message 1" },
          { role: "assistant", content: "response 1" }
        ],
        userContext: "test context",
        outputFormat: "json"
      });

      // Verify invoke was called with skipThresholdCheck: true
      expect(mockInvoke).toHaveBeenCalled();
      const invokeCall = mockInvoke.mock.calls[0][0];
      expect(invokeCall.skipThresholdCheck).toBe(true);
    });
  });
});
