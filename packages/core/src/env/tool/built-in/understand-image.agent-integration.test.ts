/**
 * @fileoverview AgentComponent.refreshDependencies() → understand_image provider 注入测试
 *
 * 验证 AgentComponent 在 refreshDependencies() 时，如果 env 中存在 LLMComponent，
 * 会自动注入 understand_image 工具的 LLM provider。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  resetUnderstandImageLLMProvider,
  getUnderstandImageLLMProvider,
  understandImageTool,
} from "./understand-image";
import { AgentComponent } from "../../agent/agent-component";
import { ConfigComponent } from "../../../config/config-component";

describe("AgentComponent.refreshDependencies() — understand_image provider injection", () => {
  beforeEach(() => {
    resetUnderstandImageLLMProvider();
  });

  afterEach(() => {
    resetUnderstandImageLLMProvider();
  });

  test("should inject provider when env has LLMComponent", async () => {
    const agentComponent = new AgentComponent();
    const configComponent = new ConfigComponent();

    // Mock LLMComponent
    const mockLLMInvoke = async () => ({
      output: { content: "mocked LLM response", toolCalls: [] },
    });

    const mockEnv = {
      getComponent: (name: string) => {
        if (name === "llm") return { invoke: mockLLMInvoke };
        if (name === "config") return configComponent;
        return undefined;
      },
    } as any;

    await agentComponent.init({
      env: mockEnv,
      options: { configComponent },
    } as any);

    // init() 不会自动触发 refreshDependencies — 这是 EnvironmentService
    // 在 env.start() 之后才会做的事。这里显式调用以模拟生产路径。
    await agentComponent.refreshDependencies();

    // ★ 此时 provider 应已被注入
    expect(getUnderstandImageLLMProvider()).not.toBeNull();

    // 验证：调用 understand_image 工具时，provider 被实际使用
    const result = await understandImageTool.execute(
      { prompt: "describe", image_source: "https://example.com/test.jpg" },
      {}
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe("mocked LLM response");
  });

  test("should not crash when env has no LLMComponent", async () => {
    const agentComponent = new AgentComponent();
    const configComponent = new ConfigComponent();

    const mockEnv = {
      getComponent: (name: string) => {
        if (name === "config") return configComponent;
        return undefined;  // No LLMComponent
      },
    } as any;

    await agentComponent.init({
      env: mockEnv,
      options: { configComponent },
    } as any);

    // ★ provider 应保持 null（init 不会注入，但 refreshDependencies 也不报错）
    expect(getUnderstandImageLLMProvider()).toBeNull();

    // 工具应返回 "no provider" 错误（不抛异常）
    const result = await understandImageTool.execute(
      { prompt: "describe", image_source: "https://example.com/test.jpg" },
      {}
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("LLM provider");
  });
});
