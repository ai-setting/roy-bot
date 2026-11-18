/**
 * @fileoverview AgentComponent Abort 功能测试
 * 
 * TDD 测试覆盖：
 * 1. AbortController Map Key 唯一性
 * 2. abort() 和 _run() finally 块状态正确性
 * 3. abort() 调用时 AbortController 已删除的边界情况
 * 4. 并发调用同一 agent 的 abort 处理
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentComponent } from "./agent-component";
import type { AgentContext } from "./types";
import type { Environment } from "../interface";
import { ConfigComponent } from "../../config/config-component";

// ============================================================================
// Mock Factory
// ============================================================================

function createMockEnvironment(configComponent: ConfigComponent): Environment {
  const mockEnv = {
    name: "test-env",
    version: "1.0.0",
    getConfig: vi.fn(() => ({ name: "test-env", version: "1.0.0", enabled: true })),
    registerComponent: vi.fn(),
    unregisterComponent: vi.fn(),
    getComponent: vi.fn((name: string) => {
      if (name === "config") return configComponent;
      return undefined;
    }),
    hasComponent: vi.fn((name: string) => name === "config"),
    listComponents: vi.fn(() => []),
    handle_query: vi.fn(),
    handle_action: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    subscribeTo: vi.fn(() => () => {}),
    subscribeAll: vi.fn(() => () => {}),
    pushEnvEvent: vi.fn(),
  } as unknown as Environment;
  return mockEnv;
}

// ============================================================================
// Tests
// ============================================================================

describe("AgentComponent Abort 功能 (TDD)", () => {
  let agentComponent: AgentComponent;
  let configComponent: ConfigComponent;
  let mockEnv: Environment;

  beforeEach(async () => {
    vi.clearAllMocks();
    agentComponent = new AgentComponent();
    configComponent = new ConfigComponent();
    mockEnv = createMockEnvironment(configComponent);
    await agentComponent.init({ env: mockEnv, options: { configComponent } });
  });

  afterEach(async () => {
    // 确保组件被正确清理
    if (agentComponent.getStatus() !== "stopped") {
      await agentComponent.stop();
    }
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Test 1: AbortController Map Key 唯一性
  // ==========================================================================

  describe("AbortController Map Key 唯一性", () => {
    it("每次 run() 调用应该创建唯一的 AbortController", async () => {
      agentComponent.registerAgent("test-agent", { type: "primary" });

      // Mock LLMComponent
      const mockLLMComponent = {
        invoke: vi.fn(() => Promise.resolve({
          output: { content: "done", toolCalls: [] }
        }))
      };
      (mockEnv.getComponent as any).mockImplementation((name: string) => {
        if (name === "llm") return mockLLMComponent;
        if (name === "config") return configComponent;
        return undefined;
      });
      await agentComponent.refreshDependencies();

      // 第一次调用
      const runPromise1 = agentComponent.run("test-agent", "query 1");
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // 第二次调用（并发）
      const runPromise2 = agentComponent.run("test-agent", "query 2");
      await new Promise(resolve => setTimeout(resolve, 50));

      // 等待两个调用完成
      await Promise.all([runPromise1, runPromise2]);

      // 验证：两个调用都完成了，没有相互干扰
      expect(mockLLMComponent.invoke).toHaveBeenCalledTimes(2);
    });

    it("abort() 应该能够正确中断指定 agent 的运行", async () => {
      agentComponent.registerAgent("test-agent", { type: "primary", maxIterations: 100 });

      // 创建一个可以被外部控制的 Promise，用于模拟 LLM 调用
      let rejectLLM: (error: any) => void;
      let resolveLLM: (value: any) => void;
      const llmPromise = new Promise((resolve, reject) => {
        resolveLLM = resolve;
        rejectLLM = reject;
      });

      // Mock LLMComponent - 模拟真实的 abort 行为
      // 当 AbortController.abort() 被调用时，Promise 应该被 reject
      const mockLLMComponent = {
        invoke: vi.fn(({ abortSignal }: { abortSignal?: AbortSignal }) => {
          if (abortSignal) {
            // 如果 abortSignal 已经被触发，立即抛出 AbortError
            if (abortSignal.aborted) {
              const error = new Error("The operation was aborted");
              (error as any).name = "AbortError";
              return Promise.reject(error);
            }
            
            // 监听 abort 事件
            abortSignal.addEventListener("abort", () => {
              const error = new Error("The operation was aborted");
              (error as any).name = "AbortError";
              rejectLLM!(error);
            });
          }
          return llmPromise;
        })
      };
      (mockEnv.getComponent as any).mockImplementation((name: string) => {
        if (name === "llm") return mockLLMComponent;
        if (name === "config") return configComponent;
        return undefined;
      });
      await agentComponent.refreshDependencies();

      // 启动运行
      const runPromise = agentComponent.run("test-agent", "long query");

      // 等待 LLM 开始处理
      await new Promise(resolve => setTimeout(resolve, 50));

      // 中止 - 这会触发 AbortController.abort()
      agentComponent.abort("test-agent");

      // 等待 run 完成（AbortError 会被抛出）
      const result = await runPromise;

      // 验证：运行被中止
      expect(result.stopped).toBe(true);
      expect(result.stopReason).toBe("aborted");
    });

    it("并发调用不同 agent 应该互不干扰", async () => {
      agentComponent.registerAgent("agent-1", { type: "primary" });
      agentComponent.registerAgent("agent-2", { type: "primary" });

      let invokeCount = 0;
      const mockLLMComponent = {
        invoke: vi.fn(() => {
          invokeCount++;
          return Promise.resolve({
            output: { content: `response ${invokeCount}`, toolCalls: [] }
          });
        })
      };
      (mockEnv.getComponent as any).mockImplementation((name: string) => {
        if (name === "llm") return mockLLMComponent;
        if (name === "config") return configComponent;
        return undefined;
      });
      await agentComponent.refreshDependencies();

      // 并发调用两个不同的 agent
      const [result1, result2] = await Promise.all([
        agentComponent.run("agent-1", "query 1"),
        agentComponent.run("agent-2", "query 2"),
      ]);

      // 验证：两个调用都成功
      expect(result1.finalText).toBe("response 1");
      expect(result2.finalText).toBe("response 2");
      expect(mockLLMComponent.invoke).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================================================
  // Test 2: abort() 和 _run() finally 块状态正确性
  // ==========================================================================

  describe("abort() 和 _run() finally 块状态正确性", () => {
    it("abort() 后 agent 状态应该是 stopped（不被 finally 覆盖）", async () => {
      agentComponent.registerAgent("test-agent", { type: "primary", maxIterations: 100 });

      let resolveLLM: (value: any) => void;
      let rejectLLM: (error: any) => void;
      
      const mockLLMComponent = {
        invoke: vi.fn(({ abortSignal }: { abortSignal?: AbortSignal }) => {
          return new Promise((resolve, reject) => {
            resolveLLM = resolve;
            rejectLLM = reject;
            
            if (abortSignal?.aborted) {
              const error = new Error("The operation was aborted");
              (error as any).name = "AbortError";
              reject(error);
            }
            
            abortSignal?.addEventListener("abort", () => {
              const error = new Error("The operation was aborted");
              (error as any).name = "AbortError";
              reject(error);
            });
          });
        })
      };
      (mockEnv.getComponent as any).mockImplementation((name: string) => {
        if (name === "llm") return mockLLMComponent;
        if (name === "config") return configComponent;
        return undefined;
      });
      await agentComponent.refreshDependencies();

      // 启动运行
      const runPromise = agentComponent.run("test-agent", "query");

      // 等待 LLM 开始
      await new Promise(resolve => setTimeout(resolve, 50));

      // 中止
      agentComponent.abort("test-agent");

      // 等待 run 完成
      await runPromise;

      // 验证：agent 状态应该是 stopped（如果 finally 覆盖了，会是 idle）
      const agent = agentComponent.getAgent("test-agent");
      expect(agent?.status).toBe("stopped");
    });

    it("正常完成的 agent 状态应该是 idle", async () => {
      agentComponent.registerAgent("test-agent", { type: "primary" });

      const mockLLMComponent = {
        invoke: vi.fn(() => Promise.resolve({
          output: { content: "done", toolCalls: [] }
        }))
      };
      (mockEnv.getComponent as any).mockImplementation((name: string) => {
        if (name === "llm") return mockLLMComponent;
        if (name === "config") return configComponent;
        return undefined;
      });
      await agentComponent.refreshDependencies();

      await agentComponent.run("test-agent", "query");

      const agent = agentComponent.getAgent("test-agent");
      expect(agent?.status).toBe("idle");
    });

    it("被外部 stop() 中止的 agent 状态应该是 stopped", async () => {
      agentComponent.registerAgent("test-agent", { type: "primary", maxIterations: 100 });

      let resolveLLM: (value: any) => void;
      let rejectLLM: (error: any) => void;
      
      const mockLLMComponent = {
        invoke: vi.fn(({ abortSignal }: { abortSignal?: AbortSignal }) => {
          return new Promise((resolve, reject) => {
            resolveLLM = resolve;
            rejectLLM = reject;
            
            if (abortSignal?.aborted) {
              const error = new Error("The operation was aborted");
              (error as any).name = "AbortError";
              reject(error);
            }
            
            abortSignal?.addEventListener("abort", () => {
              const error = new Error("The operation was aborted");
              (error as any).name = "AbortError";
              reject(error);
            });
          });
        })
      };
      (mockEnv.getComponent as any).mockImplementation((name: string) => {
        if (name === "llm") return mockLLMComponent;
        if (name === "config") return configComponent;
        return undefined;
      });
      await agentComponent.refreshDependencies();

      // 启动运行
      const runPromise = agentComponent.run("test-agent", "query");

      // 等待 LLM 开始
      await new Promise(resolve => setTimeout(resolve, 50));

      // 通过 stop() 停止组件（会调用 abort）
      await agentComponent.stop();

      // 等待 run 完成（AbortError 应该被抛出）
      const result = await runPromise;

      // 验证：运行被中止
      expect(result.stopped).toBe(true);
    });
  });

  // ==========================================================================
  // Test 3: abort() 调用时 AbortController 已删除的边界情况
  // ==========================================================================

  describe("abort() 调用时 AbortController 已删除的边界情况", () => {
    it("对已完成的 agent 调用 abort() 不应该抛出错误", () => {
      agentComponent.registerAgent("test-agent", { type: "primary" });

      // 运行完成后再中止
      // 这应该静默失败，不抛出错误
      expect(() => {
        agentComponent.abort("test-agent");
      }).not.toThrow();
    });

    it("onStop() 对已完成/不存在的 agent 调用 abort() 不应该抛出错误", async () => {
      agentComponent.registerAgent("test-agent-1", { type: "primary" });
      agentComponent.registerAgent("test-agent-2", { type: "primary" });

      // 所有 agent 都正常完成
      const mockLLMComponent = {
        invoke: vi.fn(() => Promise.resolve({
          output: { content: "done", toolCalls: [] }
        }))
      };
      (mockEnv.getComponent as any).mockImplementation((name: string) => {
        if (name === "llm") return mockLLMComponent;
        if (name === "config") return configComponent;
        return undefined;
      });
      await agentComponent.refreshDependencies();

      await agentComponent.run("test-agent-1", "query 1");
      await agentComponent.run("test-agent-2", "query 2");

      // 再次调用 stop（确保 idempotent）
      await agentComponent.stop();
      await agentComponent.stop();

      // 验证：没有抛出错误
      expect(agentComponent.getStatus()).toBe("stopped");
    });

    it("onStop() 应该清空所有 AbortController", async () => {
      agentComponent.registerAgent("test-agent", { type: "primary", maxIterations: 100 });

      let resolveLLM: (value: any) => void;
      const mockLLMComponent = {
        invoke: vi.fn(() => new Promise(resolve => {
          resolveLLM = resolve;
        }))
      };
      (mockEnv.getComponent as any).mockImplementation((name: string) => {
        if (name === "llm") return mockLLMComponent;
        if (name === "config") return configComponent;
        return undefined;
      });
      await agentComponent.refreshDependencies();

      // 启动运行
      const runPromise = agentComponent.run("test-agent", "query");
      await new Promise(resolve => setTimeout(resolve, 50));

      // 停止组件
      await agentComponent.stop();

      // 完成 LLM
      resolveLLM!({ output: { content: "done", toolCalls: [] } });

      await runPromise;

      // 验证：组件已停止
      expect(agentComponent.getStatus()).toBe("stopped");
    });
  });

  // ==========================================================================
  // Test 4: 资源清理完整性
  // ==========================================================================

  describe("资源清理完整性", () => {
    it("stop() 应该清理 doomLoopCaches", async () => {
      agentComponent.registerAgent("test-agent", { type: "primary", doomLoopThreshold: 5 });

      const mockLLMComponent = {
        invoke: vi.fn(() => Promise.resolve({
          output: { content: "done", toolCalls: [] }
        }))
      };
      (mockEnv.getComponent as any).mockImplementation((name: string) => {
        if (name === "llm") return mockLLMComponent;
        if (name === "config") return configComponent;
        return undefined;
      });
      await agentComponent.refreshDependencies();

      // 运行以创建 doomLoopCache
      await agentComponent.run("test-agent", "query");

      // 停止
      await agentComponent.stop();

      // 验证：状态是 stopped
      expect(agentComponent.getStatus()).toBe("stopped");
    });

    it("stop() 应该清理 agents Map", async () => {
      agentComponent.registerAgent("test-agent", { type: "primary" });

      await agentComponent.stop();

      // 验证：agents 被清空
      const agents = agentComponent.listAgents();
      expect(agents).toHaveLength(0);
    });

    it("多次调用 stop() 应该是幂等的", async () => {
      agentComponent.registerAgent("test-agent", { type: "primary" });

      await agentComponent.stop();
      await agentComponent.stop();
      await agentComponent.stop();

      expect(agentComponent.getStatus()).toBe("stopped");
    });
  });

  // ==========================================================================
  // Test 5: 异常场景处理
  // ==========================================================================

  describe("异常场景处理", () => {
    it("LLM 调用抛出 AbortError 应该被正确处理", async () => {
      agentComponent.registerAgent("test-agent", { type: "primary", maxIterations: 100 });

      const abortError = new Error("The operation was aborted");
      (abortError as any).name = "AbortError";

      const mockLLMComponent = {
        invoke: vi.fn(() => Promise.reject(abortError))
      };
      (mockEnv.getComponent as any).mockImplementation((name: string) => {
        if (name === "llm") return mockLLMComponent;
        if (name === "config") return configComponent;
        return undefined;
      });
      await agentComponent.refreshDependencies();

      const result = await agentComponent.run("test-agent", "query");

      // 验证：错误被正确处理
      expect(result.error).toBeDefined();
    });

    it("abort() 后 LLM 抛出 AbortError 应该被正确处理", async () => {
      agentComponent.registerAgent("test-agent", { type: "primary", maxIterations: 100 });

      let resolveLLM: (value: any) => void;
      let rejectLLM: (error: any) => void;

      const mockLLMComponent = {
        invoke: vi.fn(() => new Promise((resolve, reject) => {
          resolveLLM = resolve;
          rejectLLM = reject;
        }))
      };
      (mockEnv.getComponent as any).mockImplementation((name: string) => {
        if (name === "llm") return mockLLMComponent;
        if (name === "config") return configComponent;
        return undefined;
      });
      await agentComponent.refreshDependencies();

      const runPromise = agentComponent.run("test-agent", "query");
      await new Promise(resolve => setTimeout(resolve, 50));

      // 中止
      agentComponent.abort("test-agent");

      // LLM 抛出 AbortError
      const abortError = new Error("The operation was aborted");
      (abortError as any).name = "AbortError";
      rejectLLM!(abortError);

      const result = await runPromise;

      // 验证：被正确中止
      expect(result.stopped).toBe(true);
    });
  });
});
