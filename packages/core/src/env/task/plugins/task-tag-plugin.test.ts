/**
 * @fileoverview TaskTagPlugin Tests (TDD)
 * 
 * 测试 TaskTagPlugin 的核心功能：
 * 1. 继承 BasePlugin
 * 2. delegateBefore Hook 注入类似任务信息
 * 3. operationAfterCreate Hook 提取 Workflow
 */

import { describe, test, expect, vi, beforeEach } from "bun:test";
import { TaskTagPlugin } from "./task-tag-plugin";
import { BasePlugin, type PluginEnv } from "../../plugin/types";
import { TaskHookPoints } from "../hooks";
import type { TaskDelegateContext } from "../hooks/contexts";
import type { HookContext } from "../../hook/types";

// Mock logger
vi.mock("../../log-trace/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ========================================================================
// Tests
// ========================================================================

describe("TaskTagPlugin", () => {
  let plugin: TaskTagPlugin;
  let mockEnv: PluginEnv;
  let mockGetTask: ReturnType<typeof vi.fn>;
  let mockFindSimilar: ReturnType<typeof vi.fn>;
  
  beforeEach(() => {
    plugin = new TaskTagPlugin();
    
    mockGetTask = vi.fn();
    mockFindSimilar = vi.fn();
    
    const mockTagService = {
      findSimilarTasksByKeywords: mockFindSimilar,
    };
    
    const mockTaskComponent = {
      getTask: mockGetTask,
      getTagService: () => mockTagService,
      createOperation: vi.fn(),
      listOperations: vi.fn(),
    };
    
    const mockAgentComponent = {
      registerAgent: vi.fn(),
      invokeAgent: vi.fn(),
    };
    
    // 创建 PluginEnv
    mockEnv = {
      getComponent: vi.fn((name: string) => {
        if (name === "task") return mockTaskComponent;
        if (name === "agent") return mockAgentComponent;
        return null;
      }),
      registerAgent: vi.fn(),
      registerTool: vi.fn(),
      registerHook: vi.fn(),
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    };
  });
  
  // ========================================================================
  // BasePlugin Interface Tests
  // ========================================================================
  
  test("should extend BasePlugin", () => {
    expect(plugin instanceof BasePlugin).toBe(true);
  });
  
  test("should have correct name", () => {
    expect(plugin.name).toBe("task-tag");
  });
  
  // ========================================================================
  // Init Tests
  // ========================================================================
  
  test("should register delegateBefore hook on init", () => {
    plugin.init(mockEnv);
    
    expect(mockEnv.registerHook).toHaveBeenCalledWith(
      expect.objectContaining({
        point: TaskHookPoints.DELEGATE_BEFORE,
        priority: 20,
      })
    );
  });
  
  test("should register operationAfterCreate hook on init", () => {
    plugin.init(mockEnv);
    
    expect(mockEnv.registerHook).toHaveBeenCalledWith(
      expect.objectContaining({
        point: TaskHookPoints.OPERATION_AFTER_CREATE,
        priority: 10,
      })
    );
  });
  
  test("should NOT register workflow-extract agent dynamically (built-in)", () => {
    plugin.init(mockEnv);

    // workflow-extract is now a built-in agent, registered via AgentRegistry
    // in AgentComponent.initialize() — NOT by this plugin
    expect(mockEnv.registerAgent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        name: "workflow-extract",
      })
    );
  });
  
  // ========================================================================
  // delegateBefore Hook Tests
  // ========================================================================
  
  test("should inject similar tasks into prompt", async () => {
    plugin.init(mockEnv);
    
    const currentTask = {
      id: 1,
      title: "Fix login bug",
      tags: ["bug"],
      goals_and_expected_deliverables: "Fix the login issue",
    };
    
    const similarTasks = [
      { id: 2, title: "Fix password reset bug" },
      { id: 3, title: "Add authentication" },
    ];
    
    mockGetTask.mockResolvedValue(currentTask);
    mockFindSimilar.mockResolvedValue(similarTasks);
    
    const delegateContext: TaskDelegateContext = {
      taskId: 1,
      prompt: "Test prompt",
      subagentType: "general",

    };
    
    const hookCtx: HookContext = {
      component: { name: "task", version: "1.0.0" },
      data: delegateContext,
      metadata: {},
      phase: "before",
      hookPoint: TaskHookPoints.DELEGATE_BEFORE,
    };
    
    // 找到 delegateBefore hook 并执行
    const registerCalls = (mockEnv.registerHook as any).mock.calls;
    const delegateHookCall = registerCalls.find(
      (call: any) => call[0].point === TaskHookPoints.DELEGATE_BEFORE
    );
    const delegateHookHandler = delegateHookCall[0].handler;
    
    await delegateHookHandler(hookCtx);
    
    // 验证 prompt 被修改
    expect(delegateContext.prompt).toContain("## 🔍 类似任务参考");
    expect(delegateContext.prompt).toContain("Task #2");
    expect(delegateContext.prompt).toContain("Task #3");
    expect(delegateContext.prompt).toContain("## 用户指令");
  });
  
  test("should skip if no taskId", async () => {
    plugin.init(mockEnv);
    
    const delegateContext: TaskDelegateContext = {
      taskId: undefined,
      prompt: "Test prompt",
      subagentType: "general",

    };
    
    const hookCtx: HookContext = {
      component: { name: "task", version: "1.0.0" },
      data: delegateContext,
      metadata: {},
      phase: "before",
      hookPoint: TaskHookPoints.DELEGATE_BEFORE,
    };
    
    const registerCalls = (mockEnv.registerHook as any).mock.calls;
    const delegateHookCall = registerCalls.find(
      (call: any) => call[0].point === TaskHookPoints.DELEGATE_BEFORE
    );
    const delegateHookHandler = delegateHookCall[0].handler;
    
    await delegateHookHandler(hookCtx);
    
    // 验证 prompt 未被修改
    expect(delegateContext.prompt).toBe("Test prompt");
  });
  
  test("should skip if no similar tasks found", async () => {
    plugin.init(mockEnv);
    
    mockGetTask.mockResolvedValue({
      id: 1,
      title: "Fix login bug",
      tags: ["bug"],
    });
    mockFindSimilar.mockResolvedValue([]);
    
    const delegateContext: TaskDelegateContext = {
      taskId: 1,
      prompt: "Test prompt",
      subagentType: "general",

    };
    
    const hookCtx: HookContext = {
      component: { name: "task", version: "1.0.0" },
      data: delegateContext,
      metadata: {},
      phase: "before",
      hookPoint: TaskHookPoints.DELEGATE_BEFORE,
    };
    
    const registerCalls = (mockEnv.registerHook as any).mock.calls;
    const delegateHookCall = registerCalls.find(
      (call: any) => call[0].point === TaskHookPoints.DELEGATE_BEFORE
    );
    const delegateHookHandler = delegateHookCall[0].handler;
    
    await delegateHookHandler(hookCtx);
    
    // 验证 prompt 未被修改
    expect(delegateContext.prompt).toBe("Test prompt");
  });
  
  // ========================================================================
  // operationAfterCreate Hook Tests
  // ========================================================================
  
  test("should skip if operation actionType is not completed", async () => {
    plugin.init(mockEnv);
    
    const hookCtx: HookContext = {
      component: { name: "task", version: "1.0.0" },
      data: {
        operation: {
          id: 1,
          taskId: 1,
          actionType: "progress", // 不是 completed
          sessionId: "test-session",
        },
      },
      metadata: {},
      phase: "after",
      hookPoint: TaskHookPoints.OPERATION_AFTER_CREATE,
    };
    
    // 找到 operationAfterCreate hook 并执行
    const registerCalls = (mockEnv.registerHook as any).mock.calls;
    const hookCall = registerCalls.find(
      (call: any) => call[0].point === TaskHookPoints.OPERATION_AFTER_CREATE
    );
    const hookHandler = hookCall[0].handler;
    
    // 不应抛出错误
    await expect(hookHandler(hookCtx)).resolves.toBeUndefined();
  });
  
  // ========================================================================
  // Dispose Tests
  // ========================================================================
  
  test("should cleanup on dispose", () => {
    plugin.init(mockEnv);
    plugin.dispose();
    
    // 验证 dispose 不抛出错误
    expect(true).toBe(true);
  });
});
