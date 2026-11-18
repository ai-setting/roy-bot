/**
 * @fileoverview delegate_task Tool Tests
 * 
 * TDD: 红色阶段 - 编写失败的测试（当前 test 应失败，反映了 delegate_task 和 stop_task
 * 使用不同 BackgroundTaskManager 实例的问题）
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import type { TaskComponent } from "../task-component";
import type { Tool, ToolContext, ToolResult } from "../../tool/types";

// Mock the tool factory
// Actual implementation will be imported after RED phase
const createDelegateTool = async (taskComponent: TaskComponent): Promise<Tool> => {
  const module = await import("./delegate-tool");
  return module.createDelegateTool(taskComponent);
};

// Import BackgroundTaskManager for testing
const getBackgroundTaskManager = async (taskComponent: any) => {
  const module = await import("./delegate-tool");
  // Access the backgroundTaskManager from the tool
  return (taskComponent as any)._backgroundTaskManager;
};

describe("delegate_task Tool", () => {
  let mockTaskComponent: any;
  let tool: Tool;
  let mockSessionComponent: any;
  let mockAgentComponent: any;

  beforeEach(async () => {
    // Mock SessionComponent with proper structure
    mockSessionComponent = {
      get: vi.fn(),
      create: vi.fn(),
      addMessage: vi.fn(),
    };

    // Mock AgentComponent with getAgent method (required by ensureSubAgentRegistered)
    mockAgentComponent = {
      getAgent: vi.fn((name: string) => {
        // Return undefined to trigger registration path
        return undefined;
      }),
      registerAgent: vi.fn((name: string, config: any) => ({
        name,
        config,
        status: "idle",
        plugins: new Map(),
      })),
      abort: vi.fn(),
      abortRun: vi.fn(() => true),
    };

    // Mock TaskComponent
    mockTaskComponent = {
      createTask: vi.fn(),
      updateTask: vi.fn(),
      createOperation: vi.fn(),
      getTask: vi.fn(),
      listTasks: vi.fn(),
      listOperations: vi.fn(),
      getTagService: vi.fn().mockReturnValue({
        listTags: vi.fn().mockResolvedValue([]),
        findSimilarTasks: vi.fn().mockResolvedValue([]),
      }),
      env: {
        getComponent: vi.fn((name: string) => {
          if (name === "session") return mockSessionComponent;
          if (name === "agent") return mockAgentComponent;
          if (name === "task") return mockTaskComponent; // Return self for task component access
          return { registerTool: vi.fn() };
        }),
        handle_query: vi.fn(),
        // Mock logger for BackgroundTaskManager
        logger: {
          error: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          debug: vi.fn(),
        },
      },
    };
    
    // Store references for test setup
    (mockTaskComponent as any).mockSessionComponent = mockSessionComponent;
    (mockTaskComponent as any).mockAgentComponent = mockAgentComponent;
    
    tool = await createDelegateTool(mockTaskComponent);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("Tool Definition", () => {
    test("should have correct tool name", () => {
      expect(tool.name).toBe("delegate_task");
    });

    test("should have description with subagent types", () => {
      expect(tool.description).toContain("delegate");
      expect(tool.description).toContain("subagent");
    });

    test("should include custom registry agents in Available agent types", async () => {
      const { AgentRegistry } = await import("../../agent/agent-registry");
      const registry = new AgentRegistry({
        configComponent: { get: vi.fn() } as any,
        baseDir: "/tmp/delegate-tool-test",
      });
      registry.register({
        name: "registry-test",
        type: "sub",
        description: "Registry-backed delegate subagent",
      });

      mockAgentComponent.getRegistry = vi.fn(() => registry);
      tool = await createDelegateTool(mockTaskComponent);

      expect(tool.description).toContain(
        "- registry-test: Registry-backed delegate subagent"
      );
    });

    test("should have parameters schema", () => {
      expect(tool.parameters).toBeDefined();
      expect(tool.parameters.shape).toBeDefined();
    });

    test("should have description field in parameters", () => {
      const shape = tool.parameters.shape;
      expect(shape.description).toBeDefined();
    });

    test("should have prompt field in parameters", () => {
      const shape = tool.parameters.shape;
      expect(shape.prompt).toBeDefined();
    });

    test("should have subagent_type field in parameters", () => {
      const shape = tool.parameters.shape;
      expect(shape.subagent_type).toBeDefined();
    });

    test("should NOT have background field in parameters (always background)", () => {
      const shape = tool.parameters.shape;
      expect(shape.background).toBeUndefined();
    });

    test("should NOT have task_id field in parameters", () => {
      const shape = tool.parameters.shape;
      expect(shape.task_id).toBeUndefined();
    });

    test("should NOT mention task_id in tool description (no longer returned)", () => {
      expect(tool.description).not.toContain("**task_id**");
    });

    test("should NOT have cleanup field in parameters", () => {
      const shape = tool.parameters.shape;
      expect(shape.cleanup).toBeUndefined();
    });

    test("should have similar_task_ids field in parameters", () => {
      const shape = tool.parameters.shape;
      expect(shape.similar_task_ids).toBeDefined();
    });

    test("should require similar_task_ids (no default)", () => {
      const shape = tool.parameters.shape;
      // similar_task_ids should not have a default value
      expect(shape.similar_task_ids._def.defaultValue).toBeUndefined();
      // Parsing without similar_task_ids should throw
      expect(() => {
        tool.parameters.parse({
          description: "Test",
          prompt: "Do something",
          subagent_type: "general",
        });
      }).toThrow();
    });

    test("should validate similar_task_ids max 3 items", () => {
      // Valid: 3 items
      const parse3 = tool.parameters.parse({
        description: "Test",
        prompt: "Do something",
        subagent_type: "general",
        similar_task_ids: [1, 2, 3],
      });
      expect(parse3.similar_task_ids).toEqual([1, 2, 3]);

      // Invalid: 4 items should throw
      expect(() => {
        tool.parameters.parse({
          description: "Test",
          prompt: "Do something",
          subagent_type: "general",
          similar_task_ids: [1, 2, 3, 4],
        });
      }).toThrow();
    });

    test("should accept valid similar_task_ids", () => {
      // Empty array
      const empty = tool.parameters.parse({
        description: "Test",
        prompt: "Do something",
        subagent_type: "general",
        similar_task_ids: [],
      });
      expect(empty.similar_task_ids).toEqual([]);

      // Single ID
      const single = tool.parameters.parse({
        description: "Test",
        prompt: "Do something",
        subagent_type: "general",
        similar_task_ids: [5],
      });
      expect(single.similar_task_ids).toEqual([5]);

      // Two IDs
      const two = tool.parameters.parse({
        description: "Test",
        prompt: "Do something",
        subagent_type: "general",
        similar_task_ids: [10, 20],
      });
      expect(two.similar_task_ids).toEqual([10, 20]);

      // Three IDs (max)
      const three = tool.parameters.parse({
        description: "Test",
        prompt: "Do something",
        subagent_type: "general",
        similar_task_ids: [100, 200, 300],
      });
      expect(three.similar_task_ids).toEqual([100, 200, 300]);
    });

    test("should inject similar tasks reference into prompt when similar_task_ids provided", async () => {
      const mockContext: ToolContext = {
        session_id: "test-session-123",
      };

      const mockParentSession = { id: "test-session-123" };
      const mockSubSession = {
        id: "sub-session-456",
        addMessage: vi.fn(),
        info: {
          metadata: {
            task_id: 999,
            task_description: "Test task",
            subagent_type: "general",
          },
        },
      };

      // Mock similar tasks
      const mockSimilarTask1 = {
        id: 1,
        title: "Similar Task One",
        description: "A similar task for reference",
        status: "completed" as const,
        priority: "medium" as const,
        type: "normal" as const,
        progress: 100,
        current_status: "Done",
        goals_and_expected_deliverables: "Expected deliverables for task 1",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-02T00:00:00.000Z",
        project_path: "/test",
        context: '{"type":"general"}',
      };

      const mockSimilarTask2 = {
        id: 2,
        title: "Similar Task Two",
        description: "Another similar task",
        status: "active" as const,
        priority: "high" as const,
        type: "normal" as const,
        progress: 50,
        current_status: "In progress",
        goals_and_expected_deliverables: "Expected deliverables for task 2",
        createdAt: "2025-02-01T00:00:00.000Z",
        updatedAt: "2025-02-03T00:00:00.000Z",
        project_path: "/test",
        context: '{"type":"general"}',
      };

      const mockOperations1 = [
        {
          id: 101,
          taskId: 1,
          sessionId: "session-1",
          actionType: "milestone" as const,
          actionTitle: "Design completed",
          actionDescription: "Architecture design approved",
          timestamp: "2025-01-01T12:00:00.000Z",
        },
        {
          id: 102,
          taskId: 1,
          sessionId: "session-1",
          actionType: "progress" as const,
          actionTitle: "Implemented core functionality",
          actionDescription: "Core features implemented",
          timestamp: "2025-01-01T14:00:00.000Z",
        },
      ];

      const mockOperations2 = [
        {
          id: 201,
          taskId: 2,
          sessionId: "session-2",
          actionType: "progress" as const,
          actionTitle: "Started implementation",
          actionDescription: "Began work on task 2",
          timestamp: "2025-02-02T10:00:00.000Z",
        },
      ];

      // Mock TaskComponent to return similar tasks and operations
      mockTaskComponent.getTask
        .mockResolvedValueOnce(mockSimilarTask1)
        .mockResolvedValueOnce(mockSimilarTask2);

      mockTaskComponent.listOperations
        .mockResolvedValueOnce(mockOperations1)
        .mockResolvedValueOnce(mockOperations2);

      // Mock session component
      const mockSessionComponent = (mockTaskComponent as any).mockSessionComponent;
      mockSessionComponent.get
        .mockResolvedValueOnce(mockParentSession)
        .mockResolvedValueOnce(mockSubSession);
      mockSessionComponent.create.mockResolvedValue(mockSubSession);

      // Mock handle_query to return success
      mockTaskComponent.env.handle_query.mockResolvedValue("Task completed");

      const { BackgroundTaskManager } = await import("./delegate-tool");
      mockTaskComponent.backgroundTaskManager = new BackgroundTaskManager(mockTaskComponent.env);
      tool = await createDelegateTool(mockTaskComponent);

      const result = await tool.execute(
        {
          description: "Test similar tasks",
          prompt: "Do something with similar tasks context",
          subagent_type: "general",
          similar_task_ids: [1, 2],
        },
        mockContext
      );

      expect(result.success).toBe(true);

      // Wait for background task to complete
      const manager = mockTaskComponent.backgroundTaskManager;
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          const t = manager.getTask(result.metadata?.bgProcessId);
          if (t && t.status === "completed") {
            clearInterval(check);
            resolve();
          }
        }, 10);
        setTimeout(() => { clearInterval(check); resolve(); }, 3000);
      });

      // Verify that getTask was called for both similar task IDs
      expect(mockTaskComponent.getTask).toHaveBeenCalledWith(1);
      expect(mockTaskComponent.getTask).toHaveBeenCalledWith(2);

      // Verify that listOperations was called for both similar task IDs
      expect(mockTaskComponent.listOperations).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 1 })
      );
      expect(mockTaskComponent.listOperations).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 2 })
      );

      // Verify that the prompt passed to handle_query contains Similar Tasks Reference
      const queryArg = mockTaskComponent.env.handle_query.mock.calls[0][0];
      expect(queryArg).toContain("Similar Tasks Reference");
      expect(queryArg).toContain("Similar Task One");
      expect(queryArg).toContain("Similar Task Two");
      expect(queryArg).toContain("Design completed");
      expect(queryArg).toContain("Started implementation");
    });
  });

  describe("Background Execution (only mode)", () => {
    test("should always execute in background (no background param accepted)", async () => {
      const mockContext: ToolContext = {
        session_id: "test-session-123",
      };

      // Mock parent session for get
      const mockParentSession = {
        id: "test-session-123",
      };

      // Mock sub-agent session
      const mockSubSession = {
        id: "sub-session-456",
        addMessage: vi.fn(),
      };

      // Mock for createTask
      const createdTask = {
        id: 999,
        title: "Test task",
        status: "active",
      };
      mockTaskComponent.createTask.mockResolvedValue(createdTask);
      mockTaskComponent.createOperation.mockResolvedValue({});

      const mockSessionComponent = (mockTaskComponent as any).mockSessionComponent;
      mockSessionComponent.get.mockResolvedValue(mockParentSession);
      mockSessionComponent.create.mockResolvedValue(mockSubSession);
      mockTaskComponent.env.handle_query.mockResolvedValue("Task completed");

      // ★ 不传 background 参数，应该也走后台
      const result = await tool.execute(
        {
          description: "Test task",
          prompt: "Do something",
          subagent_type: "general",
          similar_task_ids: [],
        },
        mockContext
      );

      expect(result.success).toBe(true);
      expect(result.metadata?.background).toBe(true);
      expect(result.metadata?.status).toBe("accepted");
      expect(result.metadata?.sessionId).toBe(mockSubSession.id);
    });

    test("should return error for unknown subagent_type", async () => {
      const mockContext: ToolContext = {
        session_id: "test-session-123",
      };

      const result = await tool.execute(
        {
          description: "Test task",
          prompt: "Do something",
          subagent_type: "unknown_type",
          similar_task_ids: [],
        },
        mockContext
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown subagent type");
    });

    test("should use default subagent_type as general", async () => {
      const mockContext: ToolContext = {
        session_id: "test-session-123",
      };

      const mockParentSession = {
        id: "test-session-123",
      };

      const mockSubSession = {
        id: "sub-session-456",
        addMessage: vi.fn(),
      };

      // Mock for createTask (background mode always creates task)
      const createdTask = {
        id: 999,
        title: "Test task",
        status: "active",
      };
      mockTaskComponent.createTask.mockResolvedValue(createdTask);
      mockTaskComponent.createOperation.mockResolvedValue({});

      const mockSessionComponent = (mockTaskComponent as any).mockSessionComponent;
      mockSessionComponent.get.mockResolvedValue(mockParentSession);
      mockSessionComponent.create.mockResolvedValue(mockSubSession);
      mockTaskComponent.env.handle_query.mockResolvedValue("Task completed");

      const result = await tool.execute(
        {
          description: "Test task",
          prompt: "Do something",
          subagent_type: "general",
          similar_task_ids: [],
        },
        mockContext
      );

      expect(result.success).toBe(true);
      // ★ 应该走后台路径
      expect(result.metadata?.background).toBe(true);
    });
  });

  describe("Background Execution", () => {
    test("should execute in background when background=true", async () => {
      const mockContext: ToolContext = {
        session_id: "test-session-123",
      };

      const mockParentSession = {
        id: "test-session-123",
      };

      const mockSubSession = {
        id: "sub-session-456",
        addMessage: vi.fn(),
      };

      // Mock for createTask
      const createdTask = {
        id: 999,
        title: "Background task",
        status: "active",
      };
      mockTaskComponent.createTask.mockResolvedValue(createdTask);
      mockTaskComponent.createOperation.mockResolvedValue({});

      // Mock session component
      const mockSessionComponent = (mockTaskComponent as any).mockSessionComponent;
      mockSessionComponent.get.mockResolvedValue(mockParentSession);
      mockSessionComponent.create.mockResolvedValue(mockSubSession);

      const result = await tool.execute(
        {
          description: "Background task",
          prompt: "Do something in background",
          subagent_type: "general",
          similar_task_ids: [],
        },
        mockContext
      );

      expect(result.success).toBe(true);
      expect(result.metadata?.background).toBe(true);
      expect(result.metadata?.status).toBe("accepted");
    });
  });

  describe("Error Handling", () => {
    test("should return error for unknown subagent_type", async () => {
      const mockContext: ToolContext = {
        session_id: "test-session-123",
      };

      const result = await tool.execute(
        {
          description: "Test task",
          prompt: "Do something",
          subagent_type: "unknown_type",
          similar_task_ids: [],
        },
        mockContext
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown subagent type");
    });
  });

  describe("BackgroundTaskManager SessionComponent Access", () => {
    test("should correctly pass env to BackgroundTaskManager", async () => {
      // This test verifies that the env object is correctly passed to BackgroundTaskManager
      // so that it can access SessionComponent via env.getComponent("session")
      
      const mockContext: ToolContext = {
        session_id: "test-session-123",
      };

      const mockParentSession = { id: "test-session-123" };
      const mockSubSession = {
        id: "sub-session-456",
        info: { metadata: { subagent_type: "general" } },
        addMessage: vi.fn(),
      };

      const mockSessionComponent = (mockTaskComponent as any).mockSessionComponent;
      
      // Mock session component methods
      mockSessionComponent.get.mockResolvedValue(mockParentSession);
      mockSessionComponent.create.mockResolvedValue(mockSubSession);
      mockTaskComponent.env.handle_query.mockResolvedValue("Background task result");

      // Create task
      const createdTask = {
        id: 999,
        title: "Background task",
        status: "active",
      };
      mockTaskComponent.createTask.mockResolvedValue(createdTask);
      mockTaskComponent.createOperation.mockResolvedValue({});

      const result = await tool.execute(
        {
          description: "Background task",
          prompt: "Do something in background",
          subagent_type: "general",
          similar_task_ids: [],
        },
        mockContext
      );

      // Verify that getComponent was called with "session"
      expect(mockTaskComponent.env.getComponent).toHaveBeenCalledWith("session");

      // Verify the task was created successfully
      expect(result.success).toBe(true);
      expect(result.metadata?.background).toBe(true);
    });
  });

  describe("Background Task Events", () => {
    test("should publish task.background.started event when background task is created", async () => {
      const mockContext: ToolContext = {
        session_id: "test-session-123",
      };

      const mockParentSession = { id: "test-session-123" };
      const mockSubSession = {
        id: "sub-session-456",
        addMessage: vi.fn(),
      };

      // Track published events
      const publishedEvents: any[] = [];
      mockTaskComponent.env.pushEnvEvent = vi.fn((event: any) => {
        publishedEvents.push(event);
      });

      // Mock for createTask
      const createdTask = {
        id: 999,
        title: "Background task",
        status: "active",
      };
      mockTaskComponent.createTask.mockResolvedValue(createdTask);
      mockTaskComponent.createOperation.mockResolvedValue({});

      // Mock session component
      const mockSessionComponent = (mockTaskComponent as any).mockSessionComponent;
      mockSessionComponent.get.mockResolvedValue(mockParentSession);
      mockSessionComponent.create.mockResolvedValue(mockSubSession);

      const result = await tool.execute(
        {
          description: "Test background task",
          prompt: "Do something",
          subagent_type: "general",
          similar_task_ids: [],
        },
        mockContext
      );

      expect(result.success).toBe(true);
      
      // Verify task.background.started event was published
      const startedEvent = publishedEvents.find(e => e.type === "task.background.started");
      expect(startedEvent).toBeDefined();
      expect(startedEvent.payload.backgroundTaskId).toBeDefined();
      expect(startedEvent.payload.subSessionId).toBe(mockSubSession.id);
      expect(startedEvent.payload.parentSessionId).toBe("test-session-123");
      expect(startedEvent.payload.description).toBe("Test background task");
      expect(startedEvent.payload.subagentType).toBe("general");
      expect(startedEvent.metadata.source).toBe("task.background");
    });

    test("should publish task.background.completed event when background task succeeds", async () => {
      const mockContext: ToolContext = {
        session_id: "test-session-123",
      };

      const mockParentSession = { id: "test-session-123" };
      const mockSubSession = {
        id: "sub-session-456",
        addMessage: vi.fn(),
      };

      // Track published events
      const publishedEvents: any[] = [];
      mockTaskComponent.env.pushEnvEvent = vi.fn((event: any) => {
        publishedEvents.push(event);
      });

      // Mock for createTask
      const createdTask = {
        id: 999,
        title: "Background task",
        status: "active",
      };
      mockTaskComponent.createTask.mockResolvedValue(createdTask);
      mockTaskComponent.createOperation.mockResolvedValue({});

      // Mock session component
      const mockSessionComponent = (mockTaskComponent as any).mockSessionComponent;
      mockSessionComponent.get
        .mockResolvedValueOnce(mockParentSession)  // Parent session
        .mockResolvedValueOnce(mockSubSession);    // Sub session
      mockSessionComponent.create.mockResolvedValue(mockSubSession);

      // Mock handle_query to resolve successfully
      mockTaskComponent.env.handle_query.mockResolvedValue("Task completed successfully");

      const result = await tool.execute(
        {
          description: "Test background task",
          prompt: "Do something",
          subagent_type: "general",
          similar_task_ids: [],
        },
        mockContext
      );

      expect(result.success).toBe(true);
      
      // Get the backgroundTaskManager and wait for task to complete
      const backgroundTaskManager = (mockTaskComponent as any)._backgroundTaskManager;
      const bgProcessId = result.metadata?.bgProcessId;
      
      // Wait for the async task to complete (poll until the task is completed)
      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          const task = backgroundTaskManager.getTask(bgProcessId);
          if (task && task.status === "completed") {
            clearInterval(checkInterval);
            resolve();
          }
        }, 10);
        // Timeout after 2 seconds
        setTimeout(() => {
          clearInterval(checkInterval);
          resolve();
        }, 2000);
      });
      
      // Verify task.background.completed event was published
      const completedEvent = publishedEvents.find(e => e.type === "task.background.completed");
      expect(completedEvent).toBeDefined();
      expect(completedEvent.payload.status).toBe("completed");
      expect(completedEvent.payload.result).toBe("Task completed successfully");
      expect(completedEvent.payload.executionTimeMs).toBeGreaterThanOrEqual(0);
      expect(completedEvent.metadata.source).toBe("task.background");
    });

    test("should publish task.background.failed event when background task fails", async () => {
      const mockContext: ToolContext = {
        session_id: "test-session-123",
      };

      const mockParentSession = { id: "test-session-123" };
      const mockSubSession = {
        id: "sub-session-456",
        addMessage: vi.fn(),
      };

      // Track published events
      const publishedEvents: any[] = [];
      mockTaskComponent.env.pushEnvEvent = vi.fn((event: any) => {
        publishedEvents.push(event);
      });

      // Mock for createTask
      const createdTask = {
        id: 999,
        title: "Background task",
        status: "active",
      };
      mockTaskComponent.createTask.mockResolvedValue(createdTask);
      mockTaskComponent.createOperation.mockResolvedValue({});

      // Mock session component
      const mockSessionComponent = (mockTaskComponent as any).mockSessionComponent;
      mockSessionComponent.get
        .mockResolvedValueOnce(mockParentSession)  // Parent session
        .mockResolvedValueOnce(mockSubSession);    // Sub session
      mockSessionComponent.create.mockResolvedValue(mockSubSession);

      // Mock handle_query to reject with error
      mockTaskComponent.env.handle_query.mockRejectedValue(new Error("Something went wrong"));

      const result = await tool.execute(
        {
          description: "Test background task",
          prompt: "Do something",
          subagent_type: "general",
          similar_task_ids: [],
        },
        mockContext
      );

      // The tool should still return success since background execution is fire-and-forget
      expect(result.success).toBe(true);
      
      // Get the backgroundTaskManager and wait for task to fail
      const backgroundTaskManager = (mockTaskComponent as any)._backgroundTaskManager;
      const bgProcessId = result.metadata?.bgProcessId;
      
      // Wait for the async task to fail
      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          const task = backgroundTaskManager.getTask(bgProcessId);
          if (task && (task.status === "failed" || task.status === "stopped")) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 10);
        // Timeout after 2 seconds
        setTimeout(() => {
          clearInterval(checkInterval);
          resolve();
        }, 2000);
      });
      
      // Verify task.background.failed event was published
      const failedEvent = publishedEvents.find(e => e.type === "task.background.failed");
      expect(failedEvent).toBeDefined();
      expect(failedEvent.payload.status).toBe("failed");
      expect(failedEvent.payload.error).toBeDefined();
      expect(failedEvent.metadata.source).toBe("task.background");
    });

    /**
     * Task #3136 + #3146 — sub-agent ask_user cascade
     *
     * 当 delegate_task 触发的 sub-agent 内部调用 ask_user tool 时，
     * BackgroundTaskManager.executeTask 的 catch 块应识别 AskUserError，
     * 将 task 状态置为 awaiting-user，并发布 task.background.ask_user 事件
     * （而不是走 failed 路径）。CLI EventHandler 收到事件后向用户提问，
     * 用户答复后由主 agent 通过 delegate_task(sub_session_id) 复用
     * sub-session 续传（无需 BackgroundTaskManager 提供 resume function）。
     */
    test("should publish task.background.ask_user event when sub-agent triggers ask_user", async () => {
      const mockContext: ToolContext = {
        session_id: "test-session-parent",
      };

      const mockParentSession = { id: "test-session-parent" };
      const mockSubSession = {
        id: "sub-session-askuser",
        addMessage: vi.fn(),
      };

      // Track published events
      const publishedEvents: any[] = [];
      mockTaskComponent.env.pushEnvEvent = vi.fn((event: any) => {
        publishedEvents.push(event);
      });

      mockTaskComponent.createTask.mockResolvedValue({ id: 1000, title: "BG", status: "active" });
      mockTaskComponent.createOperation.mockResolvedValue({});

      const mockSessionComponent = (mockTaskComponent as any).mockSessionComponent;
      mockSessionComponent.get
        .mockResolvedValueOnce(mockParentSession)
        .mockResolvedValueOnce(mockSubSession);
      mockSessionComponent.create.mockResolvedValue(mockSubSession);

      // Mock handle_query to throw an AskUserError-encoded error string
      // (this is the actual error format produced by agent-component.ts:1981)
      const askUserQuery = "Should I deploy to production? (选项: Yes, No)";
      const askUserErrorInfo = {
        query: askUserQuery,
        sessionId: "sub-session-askuser",
        nodeId: "agent-1",
        nodeType: "agent",
      };
      const askUserErrorString = `__ASK_USER_ERROR__:${JSON.stringify(askUserErrorInfo)}`;
      mockTaskComponent.env.handle_query.mockRejectedValue(new Error(askUserErrorString));

      const result = await tool.execute(
        {
          description: "Sub-agent task that asks user",
          prompt: "Should we deploy?",
          subagent_type: "general",
          similar_task_ids: [],
        },
        mockContext
      );

      expect(result.success).toBe(true);

      const backgroundTaskManager = (mockTaskComponent as any)._backgroundTaskManager;
      const bgProcessId = result.metadata?.bgProcessId;

      // Wait for the async task to reach awaiting-user status
      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          const task = backgroundTaskManager.getTask(bgProcessId);
          if (task && task.status === "awaiting-user") {
            clearInterval(checkInterval);
            resolve();
          }
        }, 5);
        setTimeout(() => {
          clearInterval(checkInterval);
          resolve();
        }, 5000);
      });

      const task = backgroundTaskManager.getTask(bgProcessId);
      expect(task.status).toBe("awaiting-user");
      // Task should NOT be marked as failed
      expect(task.status).not.toBe("failed");

      // Verify task.background.ask_user event was published (NOT task.background.failed)
      const askUserEvent = publishedEvents.find(e => e.type === "task.background.ask_user");
      expect(askUserEvent).toBeDefined();
      expect(askUserEvent.type).toBe("task.background.ask_user");
      expect(askUserEvent.payload.backgroundTaskId).toBe(bgProcessId);
      expect(askUserEvent.payload.subSessionId).toBe("sub-session-askuser");
      expect(askUserEvent.payload.parentSessionId).toBe("test-session-parent");
      expect(askUserEvent.payload.query).toBe(askUserQuery);
      expect(askUserEvent.payload.sessionId).toBe("sub-session-askuser");
      expect(askUserEvent.payload.nodeId).toBe("agent-1");
      expect(askUserEvent.payload.nodeType).toBe("agent");
      expect(askUserEvent.payload.error).toBe(askUserErrorString);
      expect(askUserEvent.metadata.source).toBe("task.background");

      // Task #3147 — hints 是 rule-based 提示数组（事件自带）由 BackgroundTaskManager
      // 填充，formatter 只渲染，handler 端零特殊化。
      expect(Array.isArray(askUserEvent.payload.hints)).toBe(true);
      expect(askUserEvent.payload.hints.length).toBeGreaterThan(0);
      expect(askUserEvent.payload.hints.join("\n")).toContain("delegate_task");
      expect(askUserEvent.payload.hints.join("\n")).toContain("sub_session_id");
      expect(askUserEvent.payload.hints.join("\n")).not.toContain("existingSubSessionId");
      expect(askUserEvent.payload.hints.join("\n")).toContain("sub-session-askuser");

      // Should NOT have published task.background.failed
      const failedEvent = publishedEvents.find(e => e.type === "task.background.failed");
      expect(failedEvent).toBeUndefined();
    });

    test("should publish task.background.stopped event when stopTask is called", async () => {
      const mockContext: ToolContext = {
        session_id: "test-session-123",
      };

      const mockParentSession = { id: "test-session-123" };
      const mockSubSession = {
        id: "sub-session-456",
        addMessage: vi.fn(),
      };

      // Track published events
      const publishedEvents: any[] = [];
      mockTaskComponent.env.pushEnvEvent = vi.fn((event: any) => {
        publishedEvents.push(event);
      });

      // Mock for createTask
      const createdTask = {
        id: 999,
        title: "Background task",
        status: "active",
      };
      mockTaskComponent.createTask.mockResolvedValue(createdTask);
      mockTaskComponent.createOperation.mockResolvedValue({});

      // Mock session component
      const mockSessionComponent = (mockTaskComponent as any).mockSessionComponent;
      mockSessionComponent.get
        .mockResolvedValueOnce(mockParentSession)  // Parent session
        .mockResolvedValueOnce(mockSubSession);    // Sub session
      mockSessionComponent.create.mockResolvedValue(mockSubSession);

      // Mock handle_query to never resolve (simulating long-running task)
      mockTaskComponent.env.handle_query.mockImplementation(() => new Promise(() => {}));

      // Execute background task
      const result = await tool.execute(
        {
          description: "Long running task",
          prompt: "Do something",
          subagent_type: "general",
          similar_task_ids: [],
        },
        mockContext
      );

      expect(result.success).toBe(true);
      
      // Get the backgroundTaskManager
      const backgroundTaskManager = (mockTaskComponent as any)._backgroundTaskManager;
      expect(backgroundTaskManager).toBeDefined();

      // Get the background task ID from the result
      const bgProcessId = result.metadata?.bgProcessId;
      expect(bgProcessId).toBeDefined();

      // Stop the task
      const stopResult = await backgroundTaskManager.stopTask(bgProcessId);
      expect(stopResult.success).toBe(true);

      // Verify task.background.stopped event was published
      const stoppedEvent = publishedEvents.find(e => e.type === "task.background.stopped");
      expect(stoppedEvent).toBeDefined();
      expect(stoppedEvent.payload.status).toBe("stopped");
      expect(stoppedEvent.payload.error).toContain("stopped");
      expect(stoppedEvent.metadata.source).toBe("task.background");
    });
  });

  describe("delegate_task + stop_task Integration", () => {
    test("GREEN: stop_task should find and stop a task created by delegate_task (shared BackgroundTaskManager)", async () => {
      const mockContext: ToolContext = {
        session_id: "test-session-123",
      };

      const mockParentSession = { id: "test-session-123" };
      const mockSubSession = {
        id: "sub-session-456",
        addMessage: vi.fn(),
      };

      // Track published events
      const publishedEvents: any[] = [];
      mockTaskComponent.env.pushEnvEvent = vi.fn((event: any) => {
        publishedEvents.push(event);
      });

      // Mock session component
      const mockSessionComponent = (mockTaskComponent as any).mockSessionComponent;
      mockSessionComponent.get.mockResolvedValue(mockParentSession);
      mockSessionComponent.create.mockResolvedValue(mockSubSession);

      // ★ 设置 TaskComponent 的 backgroundTaskManager（模拟生产环境）
      //    createDelegateTool 会复用这个实例，createStopTool 也会用同一个
      const { BackgroundTaskManager } = await import("./delegate-tool");
      mockTaskComponent.backgroundTaskManager = new BackgroundTaskManager(mockTaskComponent.env);

      // Re-create tool so it picks up the shared backgroundTaskManager
      tool = await createDelegateTool(mockTaskComponent);

      // Use delegate_task to create a background task
      const delegateResult = await tool.execute(
        {
          description: "Integration test task",
          prompt: "Do something",
          subagent_type: "general",
          similar_task_ids: [],
        },
        mockContext
      );

      expect(delegateResult.success).toBe(true);
      const bgProcessId = delegateResult.metadata?.bgProcessId;
      expect(bgProcessId).toBeDefined();

      // ★ 用同一个 shared BackgroundTaskManager 创建 stop_task
      const { createStopTool } = await import("./stop-tool");
      const stopTool = createStopTool(mockTaskComponent.backgroundTaskManager);

      // Attempt to stop the task — should succeed because same manager
      const stopResult = await stopTool.execute(
        { task_id: bgProcessId },
        mockContext
      );

      expect(stopResult.success).toBe(true);
      expect(stopResult.output).toContain("Task stopped successfully");
    });

    test("REGRESSION: stop_task should NOT find task when using a different BackgroundTaskManager", async () => {
      const mockContext: ToolContext = {
        session_id: "test-session-123",
      };

      const mockParentSession = { id: "test-session-123" };
      const mockSubSession = {
        id: "sub-session-456",
        addMessage: vi.fn(),
      };

      // Mock session component
      const mockSessionComponent = (mockTaskComponent as any).mockSessionComponent;
      mockSessionComponent.get.mockResolvedValue(mockParentSession);
      mockSessionComponent.create.mockResolvedValue(mockSubSession);

      // Use delegate_task (will create internal BackgroundTaskManager)
      const delegateResult = await tool.execute(
        {
          description: "Regression test task",
          prompt: "Do something",
          subagent_type: "general",
          similar_task_ids: [],
        },
        mockContext
      );

      expect(delegateResult.success).toBe(true);
      const bgProcessId = delegateResult.metadata?.bgProcessId;
      expect(bgProcessId).toBeDefined();

      // ★ 用不同实例 → 找不到 task
      const { BackgroundTaskManager } = await import("./delegate-tool");
      const isolatedManager = new BackgroundTaskManager(mockTaskComponent.env);
      const { createStopTool } = await import("./stop-tool");
      const stopTool = createStopTool(isolatedManager);

      const stopResult = await stopTool.execute(
        { task_id: bgProcessId },
        mockContext
      );

      expect(stopResult.success).toBe(false);
      expect(stopResult.output).toContain("Task not found");
    });
  });

  describe("associatedTaskId from ALS EnvContext", () => {
    test("completed event should include associatedTaskId from getCurrentTaskId", async () => {
      // 模拟 ALS 环境：子 agent 通过 setCurrentTaskId 设置了 task_id
      const { runWithEnvContextAsync, setCurrentTaskId } = await import("../../context");

      await runWithEnvContextAsync({
        envEvent: { type: "test" },
        sourceId: "test",
        userId: "",
        agentContext: {},
      }, async () => {
        // 模拟子 agent 创建了 task #627
        setCurrentTaskId(627);

        const mockContext: ToolContext = {
          session_id: "test-session-123",
        };

        const mockParentSession = { id: "test-session-123" };
        const mockSubSession = {
          id: "sub-session-456",
          addMessage: vi.fn(),
        };

        // Track published events
        const publishedEvents: any[] = [];
        mockTaskComponent.env.pushEnvEvent = vi.fn((event: any) => {
          publishedEvents.push(event);
        });

        // Mock session component
        const mockSessionComponent = (mockTaskComponent as any).mockSessionComponent;
        mockSessionComponent.get
          .mockResolvedValueOnce(mockParentSession)  // createTask
          .mockResolvedValueOnce(mockSubSession);    // executeTask
        mockSessionComponent.create.mockResolvedValue(mockSubSession);

        // Mock handle_query to resolve quickly
        mockTaskComponent.env.handle_query.mockResolvedValue("Done with Task #627");

        // 使用 shared BackgroundTaskManager
        const { BackgroundTaskManager } = await import("./delegate-tool");
        mockTaskComponent.backgroundTaskManager = new BackgroundTaskManager(mockTaskComponent.env);
        tool = await createDelegateTool(mockTaskComponent);

        const delegateResult = await tool.execute(
          { description: "Test ALS task", prompt: "Do something", subagent_type: "general", similar_task_ids: [] },
          mockContext
        );

        expect(delegateResult.success).toBe(true);
        const bgProcessId = delegateResult.metadata?.bgProcessId;

        // Wait for background task to complete
        const manager = mockTaskComponent.backgroundTaskManager;
        await new Promise<void>((resolve) => {
          const check = setInterval(() => {
            const t = manager.getTask(bgProcessId);
            if (t && t.status === "completed") {
              clearInterval(check);
              resolve();
            }
          }, 10);
          setTimeout(() => { clearInterval(check); resolve(); }, 2000);
        });

        // Verify completed event includes associatedTaskId from ALS
        const completedEvent = publishedEvents.find(
          (e: any) => e.type === "task.background.completed"
        );
        expect(completedEvent).toBeDefined();
        expect(completedEvent.payload.associatedTaskId).toBe(627);
      });
    });

    test("timeout event should include associatedTaskId from getCurrentTaskId", async () => {
      // 模拟 ALS 环境：子 agent 通过 setCurrentTaskId 设置了 task_id
      const { runWithEnvContextAsync, setCurrentTaskId } = await import("../../context");

      await runWithEnvContextAsync({
        envEvent: { type: "test" },
        sourceId: "test",
        userId: "",
        agentContext: {},
      }, async () => {
        // 模拟子 agent 创建了 task #999
        setCurrentTaskId(999);

        const mockContext: ToolContext = {
          session_id: "test-session-123",
        };

        const mockParentSession = { id: "test-session-123" };
        const mockSubSession = {
          id: "sub-session-456",
          addMessage: vi.fn(),
        };

        // Track published events
        const publishedEvents: any[] = [];
        mockTaskComponent.env.pushEnvEvent = vi.fn((event: any) => {
          publishedEvents.push(event);
        });

        // Mock session component
        const mockSessionComponent = (mockTaskComponent as any).mockSessionComponent;
        mockSessionComponent.get
          .mockResolvedValueOnce(mockParentSession)  // createTask
          .mockResolvedValueOnce(mockSubSession);    // executeTask
        mockSessionComponent.create.mockResolvedValue(mockSubSession);

        // Mock handle_query to simulate a long-running task that doesn't respond before timeout
        mockTaskComponent.env.handle_query.mockImplementation(
          () => new Promise(() => {}) // Never resolves
        );

        // 使用 shared BackgroundTaskManager
        const { BackgroundTaskManager } = await import("./delegate-tool");
        mockTaskComponent.backgroundTaskManager = new BackgroundTaskManager(mockTaskComponent.env);
        tool = await createDelegateTool(mockTaskComponent);

        const delegateResult = await tool.execute(
          { description: "Test timeout ALS task", prompt: "Do something that times out", subagent_type: "general", timeout: 50, similar_task_ids: [] },
          mockContext
        );

        expect(delegateResult.success).toBe(true);
        const bgProcessId = delegateResult.metadata?.bgProcessId;

        // Wait for background task to timeout
        const manager = mockTaskComponent.backgroundTaskManager;
        await new Promise<void>((resolve) => {
          const check = setInterval(() => {
            const t = manager.getTask(bgProcessId);
            if (t && t.status === "timeout") {
              clearInterval(check);
              resolve();
            }
          }, 10);
          setTimeout(() => { clearInterval(check); resolve(); }, 3000);
        });

        // Verify timeout event includes associatedTaskId from ALS
        const timeoutEvent = publishedEvents.find(
          (e: any) => e.type === "task.background.timeout"
        );
        expect(timeoutEvent).toBeDefined();
        expect(timeoutEvent.payload.associatedTaskId).toBe(999);
      });
    });

    test("timeout should abort the sub-agent via agentComponent.abort", async () => {
      // 模拟 ALS 环境
      const { runWithEnvContextAsync } = await import("../../context");

      await runWithEnvContextAsync({
        envEvent: { type: "test" },
        sourceId: "test",
        userId: "",
        agentContext: {},
      }, async () => {
        const mockContext: ToolContext = {
          session_id: "test-session-123",
        };

        const mockParentSession = { id: "test-session-123" };
        const mockSubSession = {
          id: "sub-session-456",
          addMessage: vi.fn(),
        };

        const publishedEvents: any[] = [];
        mockTaskComponent.env.pushEnvEvent = vi.fn((event: any) => {
          publishedEvents.push(event);
        });

        const mockSessionComponent = (mockTaskComponent as any).mockSessionComponent;
        mockSessionComponent.get
          .mockResolvedValueOnce(mockParentSession)
          .mockResolvedValueOnce(mockSubSession);
        mockSessionComponent.create.mockResolvedValue(mockSubSession);

        // Mock handle_query to never resolve (simulate long-running task)
        mockTaskComponent.env.handle_query.mockImplementation(
          () => new Promise(() => {})
        );

        // Clear abort mock call history
        mockAgentComponent.abort.mockClear();

        const { BackgroundTaskManager } = await import("./delegate-tool");
        mockTaskComponent.backgroundTaskManager = new BackgroundTaskManager(mockTaskComponent.env);
        tool = await createDelegateTool(mockTaskComponent);

        const delegateResult = await tool.execute(
          { description: "Test abort on timeout", prompt: "Do something long", subagent_type: "general", timeout: 50, similar_task_ids: [] },
          mockContext
        );

        expect(delegateResult.success).toBe(true);
        const bgProcessId = delegateResult.metadata?.bgProcessId;

        // Wait for background task to timeout
        const manager = mockTaskComponent.backgroundTaskManager;
        await new Promise<void>((resolve) => {
          const check = setInterval(() => {
            const t = manager.getTask(bgProcessId);
            if (t && t.status === "timeout") {
              clearInterval(check);
              resolve();
            }
          }, 10);
          setTimeout(() => { clearInterval(check); resolve(); }, 3000);
        });

        // Task #2590 follow-up — timeout path no longer calls
        // agentComponent.abort(subagentType) (which silently killed every
        // concurrent same-type sub-agent). Instead it should:
        //   1. abort the task's own AbortController (via the abortTask callback)
        //   2. issue a run-scoped agentComponent.abortRun(task.runId) as a
        //      fallback for the sub-agent run only — not peer runs.
        expect(mockAgentComponent.abort).not.toHaveBeenCalledWith("general");
        expect(mockAgentComponent.abortRun).toHaveBeenCalledWith(
          expect.stringMatching(/^general:bg_/),
          "task_timeout",
        );
      });
    });

    test("progress event should include associatedTaskId from getCurrentTaskId", async () => {
      // 模拟 ALS 环境：子 agent 通过 setCurrentTaskId 设置了 task_id
      const { runWithEnvContextAsync, setCurrentTaskId } = await import("../../context");

      await runWithEnvContextAsync({
        envEvent: { type: "test" },
        sourceId: "test",
        userId: "",
        agentContext: {},
      }, async () => {
        // 模拟子 agent 创建了 task #555
        setCurrentTaskId(555);

        const mockContext: ToolContext = {
          session_id: "test-session-123",
        };

        const mockParentSession = { id: "test-session-123" };
        const mockSubSession = {
          id: "sub-session-456",
          addMessage: vi.fn(),
        };

        // Track published events
        const publishedEvents: any[] = [];
        const originalPushEnvEvent = mockTaskComponent.env.pushEnvEvent;
        mockTaskComponent.env.pushEnvEvent = vi.fn((event: any) => {
          publishedEvents.push(event);
        });

        // Mock session component
        const mockSessionComponent = (mockTaskComponent as any).mockSessionComponent;
        mockSessionComponent.get
          .mockResolvedValueOnce(mockParentSession)  // createTask
          .mockResolvedValueOnce(mockSubSession);    // executeTask
        mockSessionComponent.create.mockResolvedValue(mockSubSession);

        // Mock handle_query to never resolve (simulate long-running task)
        mockTaskComponent.env.handle_query.mockImplementation(
          () => new Promise(() => {}) // Never resolves
        );

        // 使用 fake timers 来控制进度定时器
        vi.useFakeTimers();

        const { BackgroundTaskManager, PROGRESS_INTERVAL } = await import("./delegate-tool");
        mockTaskComponent.backgroundTaskManager = new BackgroundTaskManager(mockTaskComponent.env);
        tool = await createDelegateTool(mockTaskComponent);

        const delegateResult = await tool.execute(
          { description: "Test progress ALS task", prompt: "Do something long", subagent_type: "general", similar_task_ids: [] },
          mockContext
        );

        expect(delegateResult.success).toBe(true);

        // 等待微任务队列执行完毕（executeTask 异步启动，设置 running 状态和 interval）
        await new Promise<void>((resolve) => resolve());

        // 前进时间以触发 progress interval 回调（用真实常量，别硬编码）
        vi.advanceTimersByTime(PROGRESS_INTERVAL + 100);

        // 恢复真实定时器
        vi.useRealTimers();

        // ✅ GREEN: 验证 progress event 包含 associatedTaskId
        const progressEvents = publishedEvents.filter(
          (e: any) => e.type === "task.background.progress"
        );
        expect(progressEvents.length).toBeGreaterThan(0);
        expect(progressEvents[0].payload.associatedTaskId).toBe(555);

        // 恢复 pushEnvEvent
        mockTaskComponent.env.pushEnvEvent = originalPushEnvEvent;

        // 清理：停止后台任务
        const manager = mockTaskComponent.backgroundTaskManager;
        await manager.stopTask(delegateResult.metadata?.bgProcessId);
      });
    });
  });

  // ==========================================================================
  // TDD RED: entry-agent routing for workflow type subagents
  // ==========================================================================
  // When delegate_task is called with a workflow type subagent, it should
  // route the request through an entry-agent (default: "workflow-runner" — Task #2164)
  // instead of executing the workflow directly.
  //
  // Design: .roy/design/2026-06-29-workflow-subagent-entry-agent-design.md
  describe("entry-agent routing for workflow type subagents", () => {
    /**
     * Helper: build a mock session component that propagates the metadata
     * passed to create() into the session returned by get(). This is needed
     * because the production code stores subagent_type in the sub-session's
     * metadata via create(), then reads it back via get() in executeWithAbort.
     *
     * ★ 2026-10-16 修正（此前本桩与生产代码「同形同错」）：
     *   原桩返回 `{ id, addMessage, info: { metadata } }` —— **凭空造了一个
     *   `.info` 包装层**，与生产代码里那条同样的错误假设（`subSession.info?.metadata`）
     *   完全一致，所以测试永远绿、永远抓不到「sub-agent 一律降级为 general」。
     *   `Session` 实际是**扁平对象**（session/types.ts）：metadata 就在顶层。
     *   现在桩按真实形状返回，保证测试能真实约束生产行为。
     */
    function makeMetadataPropagatingSessionComponent() {
      const sessionStore = new Map<string, any>();
      let sessionCounter = 0;
      const component = {
        _store: sessionStore,
        get: vi.fn(async (id: string) => sessionStore.get(id)),
        create: vi.fn(async (opts: any) => {
          sessionCounter++;
          // 真实 Session 形状：metadata 在顶层（无 .info 包装）
          const session = {
            id: `sub-session-entry-${sessionCounter}`,
            title: `sub-session-entry-${sessionCounter}`,
            directory: "/tmp",
            parentSessionId: opts.parentSessionId ?? null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messageCount: 0,
            metadata: opts.metadata || {},
            addMessage: vi.fn(),
          };
          sessionStore.set(session.id, session);
          return session;
        }),
        addMessage: vi.fn(),
      };
      return component;
    }

    test("workflow type subagent should be routed to entry-agent instead of executed directly", async () => {
      const { AgentRegistry } = await import("../../agent/agent-registry");
      const registry = new AgentRegistry({
        configComponent: { get: vi.fn() } as any,
        baseDir: "/tmp/delegate-entry-agent-test",
      });
      // Register a workflow type agent (no entryAgent override → default)
      registry.register({
        name: "test-workflow-subagent",
        type: "workflow",
        workflow: "test-workflow",
        description: "A test workflow type subagent",
      });

      mockAgentComponent.getRegistry = vi.fn(() => registry);

      // Replace session component with metadata-propagating mock
      const metadataSession = makeMetadataPropagatingSessionComponent();
      const parentSessionId = "test-session-entry-1";
      metadataSession.get.mockImplementation(async (id: string) => {
        // Return parent session if requested
        if (id === parentSessionId) return { id: parentSessionId };
        // Otherwise look up in store (for sub-sessions created by create())
        return (metadataSession as any)._store.get(id);
      });
      (mockTaskComponent as any).mockSessionComponent = metadataSession;
      mockTaskComponent.env.getComponent = vi.fn((name: string) => {
        if (name === "session") return metadataSession;
        if (name === "agent") return mockAgentComponent;
        if (name === "task") return mockTaskComponent;
        return { registerTool: vi.fn() };
      });

      const localTool = await createDelegateTool(mockTaskComponent);

      const mockContext: ToolContext = {
        session_id: parentSessionId,
      };

      mockTaskComponent.env.handle_query.mockResolvedValue("ok");

      const result = await localTool.execute(
        {
          description: "Run workflow via entry agent",
          prompt: "do workflow work",
          subagent_type: "test-workflow-subagent",
          similar_task_ids: [],
        },
        mockContext
      );

      expect(result.success).toBe(true);

      // Wait for the async task to start
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      // The handle_query call should have been invoked with agentType="workflow-runner" (Task #2164)
      const handleQueryCalls = mockTaskComponent.env.handle_query.mock.calls;
      expect(handleQueryCalls.length).toBeGreaterThan(0);

      const lastCall = handleQueryCalls[handleQueryCalls.length - 1];
      const callArgs = lastCall[1];
      expect(callArgs.agentType).toBe("workflow-runner");
      expect(callArgs.agentType).not.toBe("test-workflow-subagent");
    });

    test("non-workflow type subagent should keep original behavior (not routed to entry-agent)", async () => {
      const { AgentRegistry } = await import("../../agent/agent-registry");
      const registry = new AgentRegistry({
        configComponent: { get: vi.fn() } as any,
        baseDir: "/tmp/delegate-entry-agent-test-2",
      });
      registry.register({
        name: "regular-subagent",
        type: "sub",
        description: "A regular subagent",
      });

      mockAgentComponent.getRegistry = vi.fn(() => registry);

      const metadataSession = makeMetadataPropagatingSessionComponent();
      const parentSessionId = "test-session-entry-2";
      metadataSession.get.mockImplementation(async (id: string) => {
        if (id === parentSessionId) return { id: parentSessionId };
        return (metadataSession as any)._store.get(id);
      });
      (mockTaskComponent as any).mockSessionComponent = metadataSession;
      mockTaskComponent.env.getComponent = vi.fn((name: string) => {
        if (name === "session") return metadataSession;
        if (name === "agent") return mockAgentComponent;
        if (name === "task") return mockTaskComponent;
        return { registerTool: vi.fn() };
      });

      const localTool = await createDelegateTool(mockTaskComponent);

      const mockContext: ToolContext = {
        session_id: parentSessionId,
      };
      mockTaskComponent.env.handle_query.mockResolvedValue("ok");

      const result = await localTool.execute(
        {
          description: "Regular subagent work",
          prompt: "do regular work",
          subagent_type: "regular-subagent",
          similar_task_ids: [],
        },
        mockContext
      );

      expect(result.success).toBe(true);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      const handleQueryCalls = mockTaskComponent.env.handle_query.mock.calls;
      expect(handleQueryCalls.length).toBeGreaterThan(0);
      const lastCall = handleQueryCalls[handleQueryCalls.length - 1];
      expect(lastCall[1].agentType).toBe("regular-subagent");
      expect(lastCall[1].agentType).not.toBe("workflow-runner");
    });

    test("custom entryAgent override should be respected", async () => {
      const { AgentRegistry } = await import("../../agent/agent-registry");
      const registry = new AgentRegistry({
        configComponent: { get: vi.fn() } as any,
        baseDir: "/tmp/delegate-entry-agent-test-3",
      });
      registry.register({
        name: "custom-workflow-subagent",
        type: "workflow",
        workflow: "custom-workflow",
        entryAgent: "my-custom-entry",
        description: "Custom entry agent",
      });

      mockAgentComponent.getRegistry = vi.fn(() => registry);

      const metadataSession = makeMetadataPropagatingSessionComponent();
      const parentSessionId = "test-session-entry-3";
      metadataSession.get.mockImplementation(async (id: string) => {
        if (id === parentSessionId) return { id: parentSessionId };
        return (metadataSession as any)._store.get(id);
      });
      (mockTaskComponent as any).mockSessionComponent = metadataSession;
      mockTaskComponent.env.getComponent = vi.fn((name: string) => {
        if (name === "session") return metadataSession;
        if (name === "agent") return mockAgentComponent;
        if (name === "task") return mockTaskComponent;
        return { registerTool: vi.fn() };
      });

      const localTool = await createDelegateTool(mockTaskComponent);

      const mockContext: ToolContext = {
        session_id: parentSessionId,
      };
      mockTaskComponent.env.handle_query.mockResolvedValue("ok");

      const result = await localTool.execute(
        {
          description: "Custom entry routing",
          prompt: "do custom entry work",
          subagent_type: "custom-workflow-subagent",
          similar_task_ids: [],
        },
        mockContext
      );

      expect(result.success).toBe(true);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      const handleQueryCalls = mockTaskComponent.env.handle_query.mock.calls;
      const lastCall = handleQueryCalls[handleQueryCalls.length - 1];
      // Custom entry agent is used, NOT the default "workflow-runner" (Task #2164)
      expect(lastCall[1].agentType).toBe("my-custom-entry");
    });

    test("original workflow name should be passed in the prompt to the entry-agent", async () => {
      const { AgentRegistry } = await import("../../agent/agent-registry");
      const registry = new AgentRegistry({
        configComponent: { get: vi.fn() } as any,
        baseDir: "/tmp/delegate-entry-agent-test-4",
      });
      registry.register({
        name: "weekly-report-subagent",
        type: "workflow",
        workflow: "weekly-report-workflow",
        description: "Weekly report workflow subagent",
      });

      mockAgentComponent.getRegistry = vi.fn(() => registry);

      const metadataSession = makeMetadataPropagatingSessionComponent();
      const parentSessionId = "test-session-entry-4";
      metadataSession.get.mockImplementation(async (id: string) => {
        if (id === parentSessionId) return { id: parentSessionId };
        return (metadataSession as any)._store.get(id);
      });
      (mockTaskComponent as any).mockSessionComponent = metadataSession;
      mockTaskComponent.env.getComponent = vi.fn((name: string) => {
        if (name === "session") return metadataSession;
        if (name === "agent") return mockAgentComponent;
        if (name === "task") return mockTaskComponent;
        return { registerTool: vi.fn() };
      });

      const localTool = await createDelegateTool(mockTaskComponent);

      const mockContext: ToolContext = {
        session_id: parentSessionId,
      };
      mockTaskComponent.env.handle_query.mockResolvedValue("ok");

      await localTool.execute(
        {
          description: "Weekly report",
          prompt: "Generate the weekly report",
          subagent_type: "weekly-report-subagent",
          similar_task_ids: [],
        },
        mockContext
      );

      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      // The prompt passed to handle_query should mention the workflow name
      // so the entry-agent knows which workflow to run
      const handleQueryCalls = mockTaskComponent.env.handle_query.mock.calls;
      expect(handleQueryCalls.length).toBeGreaterThan(0);
      const lastCall = handleQueryCalls[handleQueryCalls.length - 1];
      const promptText = String(lastCall[0] || "");
      expect(promptText).toContain("weekly-report-subagent");
      // Should contain the original user prompt
      expect(promptText).toContain("Generate the weekly report");
    });
    test("🔴 回归：sub-session metadata 里的 subagent_type 必须真正生效（此前一律静默降级 general）", async () => {
      // 这条测试补上了此前**完全缺失**的断言：
      //   全仓 23 文件/64 处虽然都用了 metadata 传播桩，但**没有任何一条**
      //   断言「解析出的 subagentType == 传入值」—— 所以「sub-agent 一律降级为
      //   general」这个 bug 长期全绿。（实测：仅修正桩形状、不回退生产修复，
      //   该文件仍 37 pass，证明既有测试根本抓不到。）
      const metadataSession = makeMetadataPropagatingSessionComponent();
      const parentSessionId = "test-subtype-resolution-1";
      metadataSession.get.mockImplementation(async (id: string) => {
        if (id === parentSessionId) return { id: parentSessionId };
        return (metadataSession as any)._store.get(id);
      });
      (mockTaskComponent as any).mockSessionComponent = metadataSession;
      mockTaskComponent.env.getComponent = vi.fn((name: string) => {
        if (name === "session") return metadataSession;
        if (name === "agent") return mockAgentComponent;
        if (name === "task") return mockTaskComponent;
        return { registerTool: vi.fn() };
      });
      // 走普通 sub agent 路径（不做 workflow entry-agent 路由）。
      // 用真实 AgentRegistry（与同文件其余测试一致）——createDelegateTool 会调
      // listKnownSubagentDescriptions()，薄桩会崩。
      const { AgentRegistry } = await import("../../agent/agent-registry");
      const registry = new AgentRegistry({
        configComponent: { get: vi.fn() } as any,
        baseDir: "/tmp/delegate-subtype-resolution-test",
      });
      registry.register({
        name: "workflow-creator",
        type: "sub",
        description: "Workflow 构建子智能体",
      });
      mockAgentComponent.getRegistry = vi.fn(() => registry);

      const localTool = await createDelegateTool(mockTaskComponent);
      const mockContext: ToolContext = { session_id: parentSessionId };
      mockTaskComponent.env.handle_query.mockResolvedValue("ok");

      const result = await localTool.execute(
        {
          description: "subtype resolution",
          prompt: "design a workflow",
          subagent_type: "workflow-creator",
          similar_task_ids: [],
        },
        mockContext
      );
      expect(result.success).toBe(true);
      await new Promise<void>((r) => setTimeout(r, 50));

      const calls = mockTaskComponent.env.handle_query.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const ctx = calls[calls.length - 1][1] as any;
      // 关键断言：解析结果必须是传入的 subagent_type，而不是被静默降级的 "general"
      expect(ctx.agentType).toBe("workflow-creator");
      expect(ctx.agentType).not.toBe("general");
    });
  });
});
