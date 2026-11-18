/**
 * @fileoverview AgentComponent + ReminderPlugin 集成测试
 * 
 * 验证 ReminderPlugin 真正集成到 AgentComponent 的 before.llm hook 中
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentComponent } from "./agent-component";
import { ConfigComponent } from "../../config/config-component";
import type { Environment } from "../interface";
import type { HookContext, Plugin } from "./types";

// ============================================================================
// Mock Environment
// ============================================================================

function createMockEnvironment() {
  let llmInvokeCount = 0;
  
  const mockLLMComponent = {
    name: "llm",
    version: "1.0.0",
    invoke: vi.fn().mockImplementation(() => {
      llmInvokeCount++;
      // 第一次调用返回 toolCalls（继续迭代），第二次返回 stop（结束）
      if (llmInvokeCount < 2) {
        return Promise.resolve({
          output: {
            content: "",
            finishReason: "tool-calls",
            toolCalls: [
              {
                id: "call_1",
                function: { name: "test_tool", arguments: "{}" },
              },
            ],
          },
        });
      } else {
        return Promise.resolve({
          output: {
            content: "Final response",
            finishReason: "stop",
          },
        });
      }
    }),
  };

  const mockEnv: Environment = {
    name: "test-env",
    version: "1.0.0",
    getConfig: vi.fn(() => ({ name: "test-env", version: "1.0.0", enabled: true })),
    registerComponent: vi.fn(),
    unregisterComponent: vi.fn(),
    getComponent: vi.fn((name: string) => {
      if (name === "config") return configComponent;
      if (name === "llm") return mockLLMComponent;
      return undefined;
    }),
    hasComponent: vi.fn((name: string) => name === "config" || name === "llm"),
    listComponents: vi.fn(() => ["config", "llm"]),
    handle_query: vi.fn(),
    handle_action: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    subscribeTo: vi.fn(() => () => {}),
    subscribeAll: vi.fn(() => () => {}),
    pushEnvEvent: vi.fn(),
  };

  return { mockEnv, mockLLMComponent };
}

// ============================================================================
// Tests
// ============================================================================

describe("AgentComponent + ReminderPlugin Integration", () => {
  let agentComponent: AgentComponent;
  let configComponent: ConfigComponent;
  let mockEnv: ReturnType<typeof createMockEnvironment>["mockEnv"];
  let mockLLMComponent: ReturnType<typeof createMockEnvironment>["mockLLMComponent"];

  beforeEach(() => {
    vi.clearAllMocks();
    agentComponent = new AgentComponent();
    configComponent = new ConfigComponent();
    const env = createMockEnvironment();
    mockEnv = env.mockEnv;
    mockLLMComponent = env.mockLLMComponent;
  });

  describe("ReminderPlugin hook integration", () => {
    it("ReminderPlugin 应该在每次 before.llm hook 时被调用", async () => {
      await agentComponent.init({ env: mockEnv, options: { configComponent } });
      agentComponent.registerAgent("test-agent", { type: "primary" });

      // 创建并注册 ReminderPlugin
      const reminderPlugin: Plugin = {
        name: "ReminderPlugin",
        version: "1.0.0",
        hooks: [{ point: "agent:before.llm", priority: 100 }],
        execute: vi.fn().mockResolvedValue({ continue: true }),
      };
      agentComponent.registerPlugin("test-agent", reminderPlugin);

      // Mock 工具
      const mockTool = {
        name: "test_tool",
        description: "Test tool",
        execute: vi.fn().mockResolvedValue({ success: true, output: "tool result" }),
      };
      agentComponent.setDefaultTools([mockTool as any]);

      await agentComponent.run("test-agent", "Test query");

      // 验证：ReminderPlugin 被调用了 2 次（2 次 LLM 调用）
      expect(reminderPlugin.execute).toHaveBeenCalledTimes(2);
    });

    it("ReminderPlugin 应该能访问 iteration 和 maxIterations 信息", async () => {
      const capturedContexts: HookContext[] = [];

      await agentComponent.init({ env: mockEnv, options: { configComponent } });
      agentComponent.registerAgent("test-agent", { type: "primary", maxIterations: 5 });

      const plugin: Plugin = {
        name: "ContextInspector",
        version: "1.0.0",
        hooks: [{ point: "agent:before.llm" }],
        execute: vi.fn().mockImplementation(async (ctx: HookContext) => {
          capturedContexts.push(ctx);
          return { continue: true };
        }),
      };
      agentComponent.registerPlugin("test-agent", plugin);

      await agentComponent.run("test-agent", "Test");

      // 验证：捕获了 hook 调用
      expect(capturedContexts.length).toBeGreaterThan(0);

      // 验证：每次 hook 调用都能正确获取 iteration 和 maxIterations
      for (const ctx of capturedContexts) {
        expect(typeof ctx.iteration).toBe("number");
        expect(typeof ctx.maxIterations).toBe("number");
        expect(ctx.maxIterations).toBe(5);
      }
    });

    it("当 iteration === maxIterations 时，hook 应该检测到是最后一次迭代", async () => {
      const isLastIterationTracker: boolean[] = [];

      await agentComponent.init({ env: mockEnv, options: { configComponent } });
      // 设置 maxIterations = 1，确保只运行 1 次
      agentComponent.registerAgent("test-agent", { type: "primary", maxIterations: 1 });

      const plugin: Plugin = {
        name: "LastCheck",
        version: "1.0.0",
        hooks: [{ point: "agent:before.llm" }],
        execute: vi.fn().mockImplementation(async (ctx: HookContext) => {
          const isLast = ctx.iteration >= ctx.maxIterations;
          isLastIterationTracker.push(isLast);
          return { continue: true };
        }),
      };
      agentComponent.registerPlugin("test-agent", plugin);

      await agentComponent.run("test-agent", "Test");

      // 验证：1 次 hook 调用，且是最后一次
      expect(isLastIterationTracker).toEqual([true]);
    });

    it("ReminderPlugin 应该能修改 messages 数组注入提醒", async () => {
      await agentComponent.init({ env: mockEnv, options: { configComponent } });
      agentComponent.registerAgent("test-agent", { type: "primary", maxIterations: 1 });

      const plugin: Plugin = {
        name: "MessageInjector",
        version: "1.0.0",
        hooks: [{ point: "agent:before.llm" }],
        execute: vi.fn().mockImplementation(async (ctx: HookContext) => {
          if (ctx.iteration >= ctx.maxIterations) {
            ctx.messages.push({
              role: "user",
              content: "INJECTED_REMINDER_MESSAGE",
            } as any);
          }
          return { continue: true };
        }),
      };
      agentComponent.registerPlugin("test-agent", plugin);

      await agentComponent.run("test-agent", "Test");

      // 验证：plugin 被调用了 1 次
      expect(plugin.execute).toHaveBeenCalledTimes(1);

      // 验证：LLM 被调用时，messages 中包含了注入的消息
      const llmCall = mockLLMComponent.invoke.mock.calls[0][0];
      const messages = llmCall.messages;

      // 检查是否有注入的消息
      const injectedMessage = messages.find(
        (m: any) => typeof m.content === "string" && m.content.includes("INJECTED_REMINDER_MESSAGE")
      );
      expect(injectedMessage).toBeDefined();
    });
  });

  describe("maxIterations 在 ReAct 循环中的行为", () => {
    it("应该正确计算最后一次迭代的 iteration 值", async () => {
      const iterations: number[] = [];

      await agentComponent.init({ env: mockEnv, options: { configComponent } });
      agentComponent.registerAgent("test-agent", { type: "primary", maxIterations: 3 });

      const plugin: Plugin = {
        name: "IterationTracker",
        version: "1.0.0",
        hooks: [{ point: "agent:before.llm" }],
        execute: vi.fn().mockImplementation(async (ctx: HookContext) => {
          iterations.push(ctx.iteration);
          return { continue: true };
        }),
      };
      agentComponent.registerPlugin("test-agent", plugin);

      await agentComponent.run("test-agent", "Test");

      // 验证：捕获了正确的迭代次数
      // 第一次 LLM 调用返回 toolCalls → 第二次调用 → 第二次返回 stop
      expect(iterations.length).toBe(2);
      expect(iterations[0]).toBe(1);
      expect(iterations[1]).toBe(2);

      // 验证：最后一次迭代时 iteration === maxIterations - 1（因为只运行了 2 次）
      expect(iterations[1]).toBeLessThan(3);
    });
  });
});
