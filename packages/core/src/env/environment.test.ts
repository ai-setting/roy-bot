/**
 * @fileoverview BaseEnvironment Unit Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BaseEnvironment, type BaseEnvironmentConfig } from "./environment";
import type { EnvEvent, EnvEventHandler, Action, ToolResult, Context } from "./types";

describe("BaseEnvironment", () => {
  let env: BaseEnvironment;

  beforeEach(() => {
    env = new BaseEnvironment({ name: "test-env", version: "1.0.0" });
  });

  afterEach(async () => {
    await env.stop();
  });

  describe("构造函数", () => {
    it("应该使用默认配置", () => {
      const defaultEnv = new BaseEnvironment();
      expect(defaultEnv.name).toBe("base-environment");
      expect(defaultEnv.version).toBe("1.0.0");
    });

    it("应该使用提供的配置", () => {
      expect(env.name).toBe("test-env");
      expect(env.version).toBe("1.0.0");
    });
  });

  describe("getConfig()", () => {
    it("应该返回正确的配置", () => {
      const config = env.getConfig();
      expect(config.name).toBe("test-env");
      expect(config.version).toBe("1.0.0");
      expect(config.enabled).toBe(true);
    });
  });

  describe("组件管理", () => {
    it("应该注册和获取组件", () => {
      const mockComponent = {
        name: "test-component",
        version: "1.0.0",
        hooks: {},
        getStatus: () => "created" as const,
        getConfig: () => ({ name: "test-component", version: "1.0.0", enabled: true }),
        init: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };

      env.registerComponent(mockComponent as any);
      expect(env.getComponent("test-component")).toBe(mockComponent);
      expect(env.listComponents()).toHaveLength(1);
    });

    it("应该注销组件", () => {
      const mockComponent = {
        name: "test-component",
        version: "1.0.0",
        hooks: {},
        getStatus: () => "created" as const,
        getConfig: () => ({ name: "test-component", version: "1.0.0", enabled: true }),
        init: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };

      env.registerComponent(mockComponent as any);
      env.unregisterComponent("test-component");
      expect(env.getComponent("test-component")).toBeUndefined();
      expect(env.listComponents()).toHaveLength(0);
    });

    it("获取不存在的组件应返回 undefined", () => {
      expect(env.getComponent("non-existent")).toBeUndefined();
    });
  });

  describe("handle_query", () => {
    it("应该抛出错误（AgentComponent 未注册）", async () => {
      await env.init();
      await expect(env.handle_query("hello")).rejects.toThrow("AgentComponent not found");
    });
  });

  describe("handle_action", () => {
    it("应该抛出错误（未实现）", async () => {
      await env.init();
      const action: Action = { type: "test", params: {} };
      const context: Context = {};
      await expect(env.handle_action(action, context)).rejects.toThrow("handle_action not implemented");
    });
  });

  describe("EnvEvent 机制", () => {
    it("应该订阅和取消订阅", () => {
      const handler = vi.fn();
      const unsubscribe = env.subscribe(handler);
      
      // 推送事件
      env.pushEnvEvent({
        id: "test-id",
        type: "test.event",
        timestamp: Date.now(),
        metadata: { env_name: "test" },
        payload: {},
      });
      
      expect(handler).toHaveBeenCalledTimes(1);
      
      // 取消订阅
      unsubscribe();
      
      // 再次推送事件
      env.pushEnvEvent({
        id: "test-id-2",
        type: "test.event",
        timestamp: Date.now(),
        metadata: { env_name: "test" },
        payload: {},
      });
      
      expect(handler).toHaveBeenCalledTimes(1); // 不应再调用
    });

    it("subscribeAll 应该等同于 subscribe", () => {
      const handler = vi.fn();
      const unsubscribe = env.subscribeAll(handler);
      
      env.pushEnvEvent({ id: "1", type: "any.event", timestamp: Date.now(), metadata: {}, payload: {} });
      env.pushEnvEvent({ id: "2", type: "another.event", timestamp: Date.now(), metadata: {}, payload: {} });
      
      expect(handler).toHaveBeenCalledTimes(2);
      
      unsubscribe();
    });

    it("应该订阅指定类型事件", () => {
      const handler = vi.fn();
      const unsubscribe = env.subscribeTo("specific.event", handler);
      
      // 推送指定类型事件
      env.pushEnvEvent({
        id: "test-id",
        type: "specific.event",
        timestamp: Date.now(),
        metadata: { env_name: "test" },
        payload: {},
      });
      
      // 推送其他类型事件
      env.pushEnvEvent({
        id: "test-id-2",
        type: "other.event",
        timestamp: Date.now(),
        metadata: { env_name: "test" },
        payload: {},
      });
      
      expect(handler).toHaveBeenCalledTimes(1);
      
      unsubscribe();
    });

    it("应该订阅多个类型事件", () => {
      const handler = vi.fn();
      const unsubscribe = env.subscribeTo(["event1", "event2"], handler);
      
      env.pushEnvEvent({ id: "1", type: "event1", timestamp: Date.now(), metadata: {}, payload: {} });
      env.pushEnvEvent({ id: "2", type: "event2", timestamp: Date.now(), metadata: {}, payload: {} });
      env.pushEnvEvent({ id: "3", type: "event3", timestamp: Date.now(), metadata: {}, payload: {} });
      
      expect(handler).toHaveBeenCalledTimes(2);
      
      unsubscribe();
    });

    it("pushEnvEvent 应该自动填充元信息", () => {
      const handler = vi.fn();
      env.subscribe(handler);
      
      env.pushEnvEvent({
        type: "test.event",
        payload: { data: "test" },
      } as any);
      
      const event = handler.mock.calls[0][0] as EnvEvent;
      expect(event.id).toBeDefined();
      expect(event.timestamp).toBeDefined();
      expect(event.metadata.env_name).toBe("test-env");
    });
  });

  describe("生命周期", () => {
    it("应该正确初始化", async () => {
      await env.init();
      expect(env.getStatus()).toBe("running");
    });

    it("应该正确启动", async () => {
      await env.start();
      expect(env.getStatus()).toBe("running");
    });

    it("重复启动不应报错", async () => {
      await env.start();
      await env.start();
      expect(env.getStatus()).toBe("running");
    });

    it("应该正确停止", async () => {
      await env.stop();
      expect(env.getStatus()).toBe("stopped");
    });

    it("停止后应清理事件处理器", async () => {
      const handler = vi.fn();
      env.subscribe(handler);
      
      await env.stop();
      
      // 停止后推送事件应该不触发
      env.pushEnvEvent({ id: "test", type: "test", timestamp: Date.now(), metadata: {}, payload: {} });
      
      expect(handler).not.toHaveBeenCalled();
    });
  });
});

describe("handle_query with workflow agent", () => {
  it("workflow 类型 agent 应该执行关联 workflow 并返回结果", async () => {
    const mockRegistry = {
      get: vi.fn().mockReturnValue({
        name: "weekly-report",
        type: "workflow",
        workflow: "weekly-report-workflow",
      }),
      getWorkflowName: vi.fn().mockReturnValue("weekly-report-workflow"),
      list: vi.fn().mockReturnValue([]),
      listAgentsByType: vi.fn().mockReturnValue([]),
    };

    const mockAgentComponent = {
      name: "agent",
      version: "1.0.0",
      getStatus: () => "created" as const,
      stop: vi.fn(),
      getRegistry: () => mockRegistry,
      getAgent: vi.fn(),
      registerAgent: vi.fn(),
      run: vi.fn(),
    };

    const mockWorkflowComponent = {
      name: "workflow",
      version: "1.0.0",
      getStatus: () => "created" as const,
      stop: vi.fn(),
      getService: () => ({
        getWorkflowByName: vi.fn().mockReturnValue({
          definition: { name: "weekly-report-workflow", nodes: [], edges: [] },
        }),
      }),
      workflowService: null,
      runWorkflow: vi.fn().mockResolvedValue({ output: "周报生成完成" }),
    };

    const testEnv = new BaseEnvironment({ name: "test-env", version: "1.0.0" });
    testEnv.registerComponent(mockAgentComponent as any);
    testEnv.registerComponent(mockWorkflowComponent as any);

    const result = await testEnv.handle_query("写一下本周周报", {
      agentType: "weekly-report",
    });

    expect(mockWorkflowComponent.runWorkflow).toHaveBeenCalledWith(
        { name: "weekly-report-workflow", nodes: [], edges: [] },
        { query: "写一下本周周报" },
        { context: { agentType: "weekly-report" } }
      );
    expect(result).toBe("周报生成完成");

    await testEnv.stop();
  });

  it("workflow 类型 agent 引用的 workflow 不存在时应报错", async () => {
    const mockRegistry = {
      get: vi.fn().mockReturnValue({
        name: "bad-agent",
        type: "workflow",
        workflow: "non-existent-workflow",
      }),
      getWorkflowName: vi.fn().mockReturnValue("non-existent-workflow"),
    };

    const mockAgentComponent = {
      name: "agent",
      version: "1.0.0",
      getStatus: () => "created" as const,
      stop: vi.fn(),
      getRegistry: () => mockRegistry,
    };

    const mockWorkflowComponent = {
      name: "workflow",
      version: "1.0.0",
      getStatus: () => "created" as const,
      stop: vi.fn(),
      getService: () => ({
        getWorkflowByName: vi.fn().mockReturnValue(null),
      }),
      workflowService: null,
      runWorkflow: vi.fn(),
    };

    const testEnv = new BaseEnvironment({ name: "test-env", version: "1.0.0" });
    testEnv.registerComponent(mockAgentComponent as any);
    testEnv.registerComponent(mockWorkflowComponent as any);

    await expect(testEnv.handle_query("test", { agentType: "bad-agent" }))
      .rejects.toThrow(/non-existent-workflow/i);

    await testEnv.stop();
  });

  it("WorkflowComponent 不可用时应报错", async () => {
    const mockRegistry = {
      get: vi.fn().mockReturnValue({
        name: "weekly-report",
        type: "workflow",
        workflow: "weekly-report-workflow",
      }),
    };

    const mockAgentComponent = {
      name: "agent",
      version: "1.0.0",
      getStatus: () => "created" as const,
      stop: vi.fn(),
      getRegistry: () => mockRegistry,
    };

    const testEnv = new BaseEnvironment({ name: "test-env", version: "1.0.0" });
    testEnv.registerComponent(mockAgentComponent as any);
    // 不注册 workflow component

    await expect(testEnv.handle_query("test", { agentType: "weekly-report" }))
      .rejects.toThrow(/WorkflowComponent/i);

    await testEnv.stop();
  });

  it("主/子类型 agent 应走原有 ReAct 路径，不受 workflow 分支影响", async () => {
    const mockRegistry = {
      get: vi.fn().mockReturnValue({
        name: "explorer",
        type: "sub",
      }),
    };

    const mockAgent = { name: "explorer", type: "sub" };
    const mockAgentComponent = {
      name: "agent",
      version: "1.0.0",
      getStatus: () => "created" as const,
      stop: vi.fn(),
      getRegistry: () => mockRegistry,
      getAgent: vi.fn().mockReturnValue(mockAgent),
      registerAgent: vi.fn(),
      run: vi.fn().mockResolvedValue({ finalText: "探索结果" }),
    };

    const testEnv = new BaseEnvironment({ name: "test-env", version: "1.0.0" });
    testEnv.registerComponent(mockAgentComponent as any);

    const result = await testEnv.handle_query("探索代码", { agentType: "explorer" });
    expect(result).toBe("探索结果");

    await testEnv.stop();
  });

  it("workflow failed 时应抛出错误", async () => {
    const mockRegistry = {
      get: vi.fn().mockReturnValue({
        name: "weekly-report",
        type: "workflow",
        workflow: "weekly-report-workflow",
      }),
    };

    const mockAgentComponent = {
      name: "agent",
      version: "1.0.0",
      getStatus: () => "created" as const,
      stop: vi.fn(),
      getRegistry: () => mockRegistry,
    };

    const mockWorkflowComponent = {
      name: "workflow",
      version: "1.0.0",
      getStatus: () => "created" as const,
      stop: vi.fn(),
      getService: () => ({
        getWorkflowByName: vi.fn().mockReturnValue({
          definition: { name: "weekly-report-workflow", nodes: [], edges: [] },
        }),
      }),
      runWorkflow: vi.fn().mockResolvedValue({
        status: "failed",
        error: "node execution error",
      }),
    };

    const testEnv = new BaseEnvironment({ name: "test-env", version: "1.0.0" });
    testEnv.registerComponent(mockAgentComponent as any);
    testEnv.registerComponent(mockWorkflowComponent as any);

    await expect(
      testEnv.handle_query("test", { agentType: "weekly-report" })
    ).rejects.toThrow(/node execution error/i);

    await testEnv.stop();
  });

  it("workflow paused 时应返回含 resume hint 的 JSON", async () => {
    const mockRegistry = {
      get: vi.fn().mockReturnValue({
        name: "weekly-report",
        type: "workflow",
        workflow: "weekly-report-workflow",
      }),
    };

    const mockAgentComponent = {
      name: "agent",
      version: "1.0.0",
      getStatus: () => "created" as const,
      stop: vi.fn(),
      getRegistry: () => mockRegistry,
    };

    const mockWorkflowComponent = {
      name: "workflow",
      version: "1.0.0",
      getStatus: () => "created" as const,
      stop: vi.fn(),
      getService: () => ({
        getWorkflowByName: vi.fn().mockReturnValue({
          definition: { name: "weekly-report-workflow", nodes: [], edges: [] },
        }),
      }),
      runWorkflow: vi.fn().mockResolvedValue({
        status: "paused",
        sessionId: "workflow_run-abc",
        pendingNodeId: "confirm",
        query: "Proceed?",
      }),
    };

    const testEnv = new BaseEnvironment({ name: "test-env", version: "1.0.0" });
    testEnv.registerComponent(mockAgentComponent as any);
    testEnv.registerComponent(mockWorkflowComponent as any);

    const result = await testEnv.handle_query("继续", { agentType: "weekly-report" });
    const parsed = JSON.parse(result);

    expect(parsed.status).toBe("paused");
    expect(parsed.sessionId).toBe("workflow_run-abc");
    expect(parsed.pendingNodeId).toBe("confirm");
    expect(parsed.hint).toContain("workflow_run-abc");

    await testEnv.stop();
  });

  it("workflow output 为 object 时应 JSON 序列化", async () => {
    const mockRegistry = {
      get: vi.fn().mockReturnValue({
        name: "weekly-report",
        type: "workflow",
        workflow: "weekly-report-workflow",
      }),
    };

    const mockAgentComponent = {
      name: "agent",
      version: "1.0.0",
      getStatus: () => "created" as const,
      stop: vi.fn(),
      getRegistry: () => mockRegistry,
    };

    const nodeOutput = { echo: { result: "done" } };
    const mockWorkflowComponent = {
      name: "workflow",
      version: "1.0.0",
      getStatus: () => "created" as const,
      stop: vi.fn(),
      getService: () => ({
        getWorkflowByName: vi.fn().mockReturnValue({
          definition: { name: "weekly-report-workflow", nodes: [], edges: [] },
        }),
      }),
      runWorkflow: vi.fn().mockResolvedValue({
        status: "completed",
        output: nodeOutput,
      }),
    };

    const testEnv = new BaseEnvironment({ name: "test-env", version: "1.0.0" });
    testEnv.registerComponent(mockAgentComponent as any);
    testEnv.registerComponent(mockWorkflowComponent as any);

    const result = await testEnv.handle_query("test", { agentType: "weekly-report" });
    expect(result).toBe(JSON.stringify(nodeOutput));

    await testEnv.stop();
  });
});
