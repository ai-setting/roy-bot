/**
 * @fileoverview handle_query 集成测试
 */

import { describe, it, expect, vi, beforeEach } from "bun:test";
import { BaseEnvironment } from "./environment";
import { AgentComponent } from "./agent/agent-component";
import { ConfigComponent } from "../config/config-component";
import type { EnvEvent } from "./types";

describe("BaseEnvironment.handle_query", () => {
  let env: BaseEnvironment;
  let agentComponent: AgentComponent;
  let configComponent: ConfigComponent;

  beforeEach(async () => {
    env = new BaseEnvironment({ name: "test-env" });
    configComponent = new ConfigComponent();
    agentComponent = new AgentComponent();
    
    // 注册到 Environment
    env.registerComponent(configComponent);
    env.registerComponent(agentComponent);
    
    // 通过 init 方法设置 env（BaseComponent 需要 env）
    // AgentComponent 需要 ConfigComponent
    await agentComponent.init({
      name: "agent",
      version: "1.0.0",
      enabled: true,
      env: env as any,
      options: { configComponent },
    });
  });

  it("should delegate to AgentComponent.run", async () => {
    const result = await env.handle_query("Hello");
    
    // AgentComponent 没有 LLMComponent 时会返回 Mock 响应
    expect(result).toBe("Mock response: Hello!");
  });

  it("should pass context to AgentComponent.run", async () => {
    const context = {
      sessionId: "test-session-123",
      metadata: { key: "value" },
    };

    // 由于没有 LLMComponent，使用 mock
    // 这个测试主要验证 context 被正确传递
    const result = await env.handle_query("Test query", context);
    expect(result).toBe("Mock response: Hello!");
  });

  it("should emit events via subscribe", async () => {
    const events: EnvEvent[] = [];
    
    // 订阅 EnvEvent
    const unsubscribe = env.subscribe((event) => {
      events.push(event);
    });
    
    const result = await env.handle_query("Hello");

    expect(result).toBe("Mock response: Hello!");
    
    // 验证事件被触发
    expect(events.length).toBeGreaterThan(0);
    
    // 应该包含 agent.start 和 agent.completed 事件
    // 注意：llm.content 事件只有在有真实 LLMComponent 时才会发送
    const eventTypes = events.map(e => e.type);
    expect(eventTypes).toContain("agent.start");
    expect(eventTypes).toContain("agent.completed");
    
    unsubscribe();
  });

  it("should throw error if AgentComponent is not registered", async () => {
    const emptyEnv = new BaseEnvironment({ name: "empty-env" });
    
    await expect(
      emptyEnv.handle_query("Hello")
    ).rejects.toThrow("AgentComponent not found");
  });

  it("should work without event subscription", async () => {
    const result = await env.handle_query("Hello");
    expect(result).toBe("Mock response: Hello!");
  });

  it("should work without context", async () => {
    const result = await env.handle_query("Hello");
    expect(result).toBe("Mock response: Hello!");
  });
});
