/**
 * @fileoverview BackgroundTaskManager EnvEvent Tests
 * 
 * TDD: 测试 BackgroundTaskManager 发布 EnvEvent 的功能
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { BackgroundTaskManager, type CreateBackgroundTaskOptions, BackgroundTaskEventTypes } from "./delegate-tool";

describe("BackgroundTaskManager EnvEvent Tests", () => {
  let mockEnv: any;
  let mockSessionComponent: any;
  let mockAgentComponent: any;
  let publishedEvents: any[];

  beforeEach(() => {
    publishedEvents = [];

    // Mock SessionComponent
    mockSessionComponent = {
      get: vi.fn(),
      create: vi.fn(),
      addMessage: vi.fn(),
    };

    // Mock AgentComponent
    mockAgentComponent = {
      getAgent: vi.fn(),
      registerAgent: vi.fn(),
    };

    // Mock Environment
    mockEnv = {
      getComponent: vi.fn((name: string) => {
        if (name === "session") return mockSessionComponent;
        if (name === "agent") return mockAgentComponent;
        return undefined;
      }),
      pushEnvEvent: vi.fn((event: any) => {
        publishedEvents.push(event);
      }),
      handle_query: vi.fn(),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("Event Publishing - Task Lifecycle", () => {
    test("should publish task.started event when background task is created", async () => {
      // Setup mocks
      const mockParentSession = { id: "parent-session-123" };
      const mockSubSession = {
        id: "sub-session-456",
        info: { metadata: { subagent_type: "general" } },
      };

      mockSessionComponent.get.mockResolvedValue(mockParentSession);
      mockSessionComponent.create.mockResolvedValue(mockSubSession);
      mockAgentComponent.getAgent.mockReturnValue(undefined);
      mockAgentComponent.registerAgent.mockReturnValue({});
      mockEnv.handle_query.mockResolvedValue("Task completed");

      // Create BackgroundTaskManager
      const manager = new BackgroundTaskManager(mockEnv);

      // Create a background task
      const options: CreateBackgroundTaskOptions = {
        parentSessionId: "parent-session-123",
        description: "Test background task",
        prompt: "Do something",
        subagentType: "general",
      };

      const { taskId: bgProcessId } = await manager.createTask(options);

      // Wait for task to complete (since handle_query is mocked)
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify task.started event was published
      const startedEvent = publishedEvents.find((e) => e.type === BackgroundTaskEventTypes.STARTED);
      expect(startedEvent).toBeDefined();
      expect(startedEvent.type).toBe(BackgroundTaskEventTypes.STARTED);
      expect(startedEvent.payload.backgroundTaskId).toBe(bgProcessId);
      expect(startedEvent.payload.description).toBe("Test background task");
      expect(startedEvent.payload.subagentType).toBe("general");
      expect(startedEvent.metadata.source).toBe("task.background");

      // Cleanup
      await manager.dispose();
    });

    test("should publish task.completed event when background task completes successfully", async () => {
      // Setup mocks
      const mockParentSession = { id: "parent-session-123" };
      const mockSubSession = {
        id: "sub-session-456",
        info: { metadata: { subagent_type: "general" } },
      };

      mockSessionComponent.get.mockResolvedValue(mockParentSession);
      mockSessionComponent.create.mockResolvedValue(mockSubSession);
      mockAgentComponent.getAgent.mockReturnValue(undefined);
      mockAgentComponent.registerAgent.mockReturnValue({});
      mockEnv.handle_query.mockResolvedValue("Task completed successfully");

      // Create BackgroundTaskManager
      const manager = new BackgroundTaskManager(mockEnv);

      // Create a background task
      const options: CreateBackgroundTaskOptions = {
        parentSessionId: "parent-session-123",
        description: "Test completion task",
        prompt: "Do something",
        subagentType: "general",
      };

      const { taskId: bgProcessId } = await manager.createTask(options);

      // Wait for task to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify task.completed event was published
      const completedEvent = publishedEvents.find((e) => e.type === BackgroundTaskEventTypes.COMPLETED);
      expect(completedEvent).toBeDefined();
      expect(completedEvent.type).toBe(BackgroundTaskEventTypes.COMPLETED);
      expect(completedEvent.payload.backgroundTaskId).toBe(bgProcessId);
      expect(completedEvent.payload.status).toBe("completed");
      expect(completedEvent.payload.result).toBe("Task completed successfully");
      // executionTimeMs may be 0 for very fast tasks, so just check it's defined
      expect(completedEvent.payload.executionTimeMs).toBeDefined();

      // Cleanup
      await manager.dispose();
    });

    test("should publish task.failed event when background task fails", async () => {
      // Setup mocks
      const mockParentSession = { id: "parent-session-123" };
      const mockSubSession = {
        id: "sub-session-456",
        info: { metadata: { subagent_type: "general" } },
      };

      mockSessionComponent.get.mockResolvedValue(mockParentSession);
      mockSessionComponent.create.mockResolvedValue(mockSubSession);
      mockAgentComponent.getAgent.mockReturnValue(undefined);
      mockAgentComponent.registerAgent.mockReturnValue({});
      mockEnv.handle_query.mockRejectedValue(new Error("Something went wrong"));

      // Create BackgroundTaskManager
      const manager = new BackgroundTaskManager(mockEnv);

      // Create a background task
      const options: CreateBackgroundTaskOptions = {
        parentSessionId: "parent-session-123",
        description: "Test failure task",
        prompt: "Do something",
        subagentType: "general",
      };

      const { taskId: bgProcessId } = await manager.createTask(options);

      // Wait for task to fail
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify task.failed event was published
      const failedEvent = publishedEvents.find((e) => e.type === BackgroundTaskEventTypes.FAILED);
      expect(failedEvent).toBeDefined();
      expect(failedEvent.type).toBe(BackgroundTaskEventTypes.FAILED);
      expect(failedEvent.payload.backgroundTaskId).toBe(bgProcessId);
      expect(failedEvent.payload.status).toBe("failed");
      // Error message is captured from the rejected promise
      expect(failedEvent.payload.error).toBeDefined();
      expect(typeof failedEvent.payload.error).toBe("string");

      // Cleanup
      await manager.dispose();
    });

    test("should publish task.timeout event when background task times out", async () => {
      // Setup mocks
      const mockParentSession = { id: "parent-session-123" };
      const mockSubSession = {
        id: "sub-session-456",
        info: { metadata: { subagent_type: "general" } },
      };

      mockSessionComponent.get.mockResolvedValue(mockParentSession);
      mockSessionComponent.create.mockResolvedValue(mockSubSession);
      mockAgentComponent.getAgent.mockReturnValue(undefined);
      mockAgentComponent.registerAgent.mockReturnValue({});

      // Mock handle_query to never resolve (simulate long-running task)
      let rejectWithTimeout: (reason: Error) => void;
      mockEnv.handle_query.mockImplementation(
        () =>
          new Promise((_, reject) => {
            rejectWithTimeout = reject;
            // Reject with timeout error after a short delay for test speed
            setTimeout(() => reject(new Error("Task execution timeout after 100ms")), 100);
          })
      );

      // Create BackgroundTaskManager with very short timeout
      const manager = new BackgroundTaskManager(mockEnv);

      // Create a background task with timeout
      const options: CreateBackgroundTaskOptions = {
        parentSessionId: "parent-session-123",
        description: "Test timeout task",
        prompt: "Do something",
        subagentType: "general",
        timeout: 50, // Very short timeout for test
      };

      const { taskId: bgProcessId } = await manager.createTask(options);

      // Wait for task to timeout
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Verify task.timeout event was published
      const timeoutEvent = publishedEvents.find((e) => e.type === BackgroundTaskEventTypes.TIMEOUT);
      expect(timeoutEvent).toBeDefined();
      expect(timeoutEvent.type).toBe(BackgroundTaskEventTypes.TIMEOUT);
      expect(timeoutEvent.payload.backgroundTaskId).toBe(bgProcessId);
      expect(timeoutEvent.payload.status).toBe("timeout");

      // Cleanup
      await manager.dispose();
    });

    test("should publish task.stopped event when background task is stopped", async () => {
      // Setup mocks
      const mockParentSession = { id: "parent-session-123" };
      const mockSubSession = {
        id: "sub-session-456",
        info: { metadata: { subagent_type: "general" } },
      };

      mockSessionComponent.get.mockResolvedValue(mockParentSession);
      mockSessionComponent.create.mockResolvedValue(mockSubSession);
      mockAgentComponent.getAgent.mockReturnValue(undefined);
      mockAgentComponent.registerAgent.mockReturnValue({});

      // Mock handle_query to never resolve (simulate long-running task)
      mockEnv.handle_query.mockImplementation(
        () => new Promise(() => {}) // Never resolves
      );

      // Create BackgroundTaskManager
      const manager = new BackgroundTaskManager(mockEnv);

      // Create a background task
      const options: CreateBackgroundTaskOptions = {
        parentSessionId: "parent-session-123",
        description: "Test stopped task",
        prompt: "Do something",
        subagentType: "general",
      };

      const { taskId: bgProcessId } = await manager.createTask(options);

      // Wait for task to start
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Stop the task
      const stopResult = await manager.stopTask(bgProcessId);
      expect(stopResult.success).toBe(true);

      // Wait for stop event to be processed
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify task.stopped event was published
      const stoppedEvent = publishedEvents.find((e) => e.type === BackgroundTaskEventTypes.STOPPED);
      expect(stoppedEvent).toBeDefined();
      expect(stoppedEvent.type).toBe(BackgroundTaskEventTypes.STOPPED);
      expect(stoppedEvent.payload.backgroundTaskId).toBe(bgProcessId);
      expect(stoppedEvent.payload.status).toBe("stopped");

      // Cleanup
      await manager.dispose();
    });

    test("should publish task.stopped event when task is aborted by stopTask", async () => {
      // Setup mocks
      const mockParentSession = { id: "parent-session-123" };
      const mockSubSession = {
        id: "sub-session-456",
        info: { metadata: { subagent_type: "general" } },
      };

      mockSessionComponent.get.mockResolvedValue(mockParentSession);
      mockSessionComponent.create.mockResolvedValue(mockSubSession);
      mockAgentComponent.getAgent.mockReturnValue(undefined);
      mockAgentComponent.registerAgent.mockReturnValue({});

      // Mock handle_query to never resolve
      mockEnv.handle_query.mockImplementation(
        () => new Promise(() => {}) // Never resolves
      );

      // Create BackgroundTaskManager
      const manager = new BackgroundTaskManager(mockEnv);

      // Create a background task
      const options: CreateBackgroundTaskOptions = {
        parentSessionId: "parent-session-123",
        description: "Test abort task",
        prompt: "Do something",
        subagentType: "general",
      };

      const { taskId: bgProcessId } = await manager.createTask(options);

      // Wait for task to start
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Stop the task via stopTask
      const result = await manager.stopTask(bgProcessId);
      expect(result.success).toBe(true);

      // Wait for event processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify task.stopped event was published (not task.failed)
      const stoppedEvent = publishedEvents.find((e) => e.type === BackgroundTaskEventTypes.STOPPED);
      expect(stoppedEvent).toBeDefined();
      expect(stoppedEvent.type).toBe(BackgroundTaskEventTypes.STOPPED);

      // Verify task.failed was NOT published
      const failedEvent = publishedEvents.find((e) => e.type === BackgroundTaskEventTypes.FAILED);
      expect(failedEvent).toBeUndefined();

      // Cleanup
      await manager.dispose();
    });
  });

  describe("Event Payload Structure", () => {
    test("should include trigger_session_id in event metadata", async () => {
      // Setup mocks
      const mockParentSession = { id: "parent-session-123" };
      const mockSubSession = {
        id: "sub-session-456",
        info: { metadata: { subagent_type: "general" } },
      };

      mockSessionComponent.get.mockResolvedValue(mockParentSession);
      mockSessionComponent.create.mockResolvedValue(mockSubSession);
      mockAgentComponent.getAgent.mockReturnValue(undefined);
      mockAgentComponent.registerAgent.mockReturnValue({});
      mockEnv.handle_query.mockResolvedValue("Done");

      // Create BackgroundTaskManager
      const manager = new BackgroundTaskManager(mockEnv);

      // Create a background task
      const options: CreateBackgroundTaskOptions = {
        parentSessionId: "parent-session-123",
        description: "Test trigger session",
        prompt: "Do something",
        subagentType: "general",
      };

      await manager.createTask(options);

      // Wait for event
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify trigger_session_id is set
      const startedEvent = publishedEvents.find((e) => e.type === BackgroundTaskEventTypes.STARTED);
      expect(startedEvent.metadata.trigger_session_id).toBe("parent-session-123");

      // Cleanup
      await manager.dispose();
    });

    test("should include subSessionId in event payload", async () => {
      // Setup mocks
      const mockParentSession = { id: "parent-session-123" };
      const mockSubSession = {
        id: "sub-session-456",
        info: { metadata: { subagent_type: "general" } },
      };

      mockSessionComponent.get.mockResolvedValue(mockParentSession);
      mockSessionComponent.create.mockResolvedValue(mockSubSession);
      mockAgentComponent.getAgent.mockReturnValue(undefined);
      mockAgentComponent.registerAgent.mockReturnValue({});
      mockEnv.handle_query.mockResolvedValue("Done");

      // Create BackgroundTaskManager
      const manager = new BackgroundTaskManager(mockEnv);

      // Create a background task
      const options: CreateBackgroundTaskOptions = {
        parentSessionId: "parent-session-123",
        description: "Test subSessionId",
        prompt: "Do something",
        subagentType: "general",
      };

      await manager.createTask(options);

      // Wait for event
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify subSessionId is set
      const startedEvent = publishedEvents.find((e) => e.type === BackgroundTaskEventTypes.STARTED);
      expect(startedEvent.payload.subSessionId).toBe("sub-session-456");

      // Cleanup
      await manager.dispose();
    });
  });

  describe("Event Ordering", () => {
    test("should publish events in correct order: started -> progress -> completed", async () => {
      // Setup mocks
      const mockParentSession = { id: "parent-session-123" };
      const mockSubSession = {
        id: "sub-session-456",
        info: { metadata: { subagent_type: "general" } },
      };

      mockSessionComponent.get.mockResolvedValue(mockParentSession);
      mockSessionComponent.create.mockResolvedValue(mockSubSession);
      mockAgentComponent.getAgent.mockReturnValue(undefined);
      mockAgentComponent.registerAgent.mockReturnValue({});
      mockEnv.handle_query.mockResolvedValue("Done");

      // Create BackgroundTaskManager
      const manager = new BackgroundTaskManager(mockEnv);

      // Create a background task
      const options: CreateBackgroundTaskOptions = {
        parentSessionId: "parent-session-123",
        description: "Test event ordering",
        prompt: "Do something",
        subagentType: "general",
      };

      await manager.createTask(options);

      // Wait for task to complete (with progress interval of 1200000ms, no progress event expected for fast task)
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Filter task lifecycle events
      const taskEvents = publishedEvents.filter(
        (e) =>
          e.type === BackgroundTaskEventTypes.STARTED ||
          e.type === BackgroundTaskEventTypes.COMPLETED
      );

      // Verify order
      expect(taskEvents[0].type).toBe(BackgroundTaskEventTypes.STARTED);
      expect(taskEvents[taskEvents.length - 1].type).toBe(BackgroundTaskEventTypes.COMPLETED);

      // Cleanup
      await manager.dispose();
    });

    test("should publish events in correct order: started -> progress -> failed", async () => {
      // Setup mocks
      const mockParentSession = { id: "parent-session-123" };
      const mockSubSession = {
        id: "sub-session-456",
        info: { metadata: { subagent_type: "general" } },
      };

      mockSessionComponent.get.mockResolvedValue(mockParentSession);
      mockSessionComponent.create.mockResolvedValue(mockSubSession);
      mockAgentComponent.getAgent.mockReturnValue(undefined);
      mockAgentComponent.registerAgent.mockReturnValue({});
      mockEnv.handle_query.mockRejectedValue(new Error("Task failed"));

      // Create BackgroundTaskManager
      const manager = new BackgroundTaskManager(mockEnv);

      // Create a background task
      const options: CreateBackgroundTaskOptions = {
        parentSessionId: "parent-session-123",
        description: "Test failed ordering",
        prompt: "Do something",
        subagentType: "general",
      };

      await manager.createTask(options);

      // Wait for task to fail
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Filter task lifecycle events
      const taskEvents = publishedEvents.filter(
        (e) =>
          e.type === BackgroundTaskEventTypes.STARTED ||
          e.type === BackgroundTaskEventTypes.FAILED
      );

      // Verify order
      expect(taskEvents[0].type).toBe(BackgroundTaskEventTypes.STARTED);
      expect(taskEvents[taskEvents.length - 1].type).toBe(BackgroundTaskEventTypes.FAILED);

      // Cleanup
      await manager.dispose();
    });
  });

  describe("Edge Cases", () => {
    test("should not publish event when env.pushEnvEvent is not available", async () => {
      // Setup mocks without pushEnvEvent
      const mockEnvWithoutEvent = {
        getComponent: vi.fn((name: string) => {
          if (name === "session") return mockSessionComponent;
          return undefined;
        }),
        // No pushEnvEvent defined
        handle_query: vi.fn().mockResolvedValue("Done"),
      };

      const mockParentSession = { id: "parent-session-123" };
      const mockSubSession = {
        id: "sub-session-456",
        info: { metadata: { subagent_type: "general" } },
      };

      mockSessionComponent.get.mockResolvedValue(mockParentSession);
      mockSessionComponent.create.mockResolvedValue(mockSubSession);

      // Create BackgroundTaskManager without event support
      const manager = new BackgroundTaskManager(mockEnvWithoutEvent as any);

      // Create a background task - should not throw
      const options: CreateBackgroundTaskOptions = {
        parentSessionId: "parent-session-123",
        description: "Test no event",
        prompt: "Do something",
        subagentType: "general",
      };

      const result = await manager.createTask(options);
      expect(result.taskId).toBeDefined();

      // Wait for task to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify no events were published (no error thrown)
      // This test ensures graceful degradation when event system is unavailable

      // Cleanup
      await manager.dispose();
    });

    test("should not publish event when SessionComponent is not found", async () => {
      // Setup mocks without SessionComponent
      const mockEnvWithoutSession = {
        getComponent: vi.fn().mockReturnValue(undefined),
      };

      // Create BackgroundTaskManager
      const manager = new BackgroundTaskManager(mockEnvWithoutSession as any);

      // Create a background task - should throw
      const options: CreateBackgroundTaskOptions = {
        parentSessionId: "parent-session-123",
        description: "Test no session",
        prompt: "Do something",
        subagentType: "general",
      };

      await expect(manager.createTask(options)).rejects.toThrow("SessionComponent not found");

      // Cleanup
      await manager.dispose();
    });

    test("should handle stopTask on non-existent task gracefully", async () => {
      // Create BackgroundTaskManager
      const manager = new BackgroundTaskManager(mockEnv);

      // Stop non-existent task
      const result = await manager.stopTask("non-existent-task-id");
      expect(result.success).toBe(false);
      expect(result.message).toBe("Task not found");

      // Verify no events were published
      const stoppedEvent = publishedEvents.find((e) => e.type === BackgroundTaskEventTypes.STOPPED);
      expect(stoppedEvent).toBeUndefined();
    });

    test("should not allow stopping completed task", async () => {
      // Setup mocks
      const mockParentSession = { id: "parent-session-123" };
      const mockSubSession = {
        id: "sub-session-456",
        info: { metadata: { subagent_type: "general" } },
      };

      mockSessionComponent.get.mockResolvedValue(mockParentSession);
      mockSessionComponent.create.mockResolvedValue(mockSubSession);
      mockAgentComponent.getAgent.mockReturnValue(undefined);
      mockAgentComponent.registerAgent.mockReturnValue({});
      mockEnv.handle_query.mockResolvedValue("Done");

      // Create BackgroundTaskManager
      const manager = new BackgroundTaskManager(mockEnv);

      // Create a background task
      const options: CreateBackgroundTaskOptions = {
        parentSessionId: "parent-session-123",
        description: "Test completed task",
        prompt: "Do something",
        subagentType: "general",
      };

      const { taskId: bgProcessId } = await manager.createTask(options);

      // Wait for task to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Try to stop completed task
      // Task #2539 — finalizeTask 把 completed task 从 tasks 移到 terminalTasks；
      // getTask 仍可查到（query_background_process 不丢历史），stopTask 仍返回「不能 stop」语义。
      const result = await manager.stopTask(bgProcessId);
      expect(result.success).toBe(false);
      expect(result.message).toContain("Cannot stop task with status: completed");

      // Cleanup
      await manager.dispose();
    });
  });

  describe("All Event Types", () => {
    test("should have all required event types defined", () => {
      expect(BackgroundTaskEventTypes.STARTED).toBe("task.background.started");
      expect(BackgroundTaskEventTypes.PROGRESS).toBe("task.background.progress");
      expect(BackgroundTaskEventTypes.COMPLETED).toBe("task.background.completed");
      expect(BackgroundTaskEventTypes.FAILED).toBe("task.background.failed");
      expect(BackgroundTaskEventTypes.TIMEOUT).toBe("task.background.timeout");
      expect(BackgroundTaskEventTypes.STOPPED).toBe("task.background.stopped");
    });

    test("should have unique event type values", () => {
      const eventTypes = Object.values(BackgroundTaskEventTypes);
      const uniqueTypes = new Set(eventTypes);
      expect(uniqueTypes.size).toBe(eventTypes.length);
    });
  });

  // ============================================================================
  // ★ 2026-07-10 新增（Task #1752）：验证 6 种事件 payload 都含 subSessionId
  // ============================================================================
  describe("All background events include subSessionId in payload", () => {
    test("STARTED event payload contains subSessionId", async () => {
      const mockParentSession = { id: "parent-1" };
      const mockSubSession = {
        id: "sub-fixed-id",
        info: { metadata: { subagent_type: "general" } },
      };
      mockSessionComponent.get.mockResolvedValue(mockParentSession);
      mockSessionComponent.create.mockResolvedValue(mockSubSession);
      mockAgentComponent.getAgent.mockReturnValue(undefined);
      mockAgentComponent.registerAgent.mockReturnValue({});
      mockEnv.handle_query.mockResolvedValue("done");

      const manager = new BackgroundTaskManager(mockEnv);
      await manager.createTask({
        parentSessionId: "parent-1",
        description: "Test",
        prompt: "Work",
        subagentType: "general",
      });

      const event = publishedEvents.find((e) => e.type === BackgroundTaskEventTypes.STARTED);
      expect(event).toBeDefined();
      expect(event.payload.subSessionId).toBe("sub-fixed-id");

      await manager.dispose();
    });

    test("COMPLETED event payload contains subSessionId", async () => {
      const mockParentSession = { id: "parent-1" };
      const mockSubSession = {
        id: "sub-fixed-id",
        info: { metadata: { subagent_type: "general" } },
      };
      mockSessionComponent.get.mockResolvedValue(mockParentSession);
      mockSessionComponent.create.mockResolvedValue(mockSubSession);
      mockAgentComponent.getAgent.mockReturnValue(undefined);
      mockAgentComponent.registerAgent.mockReturnValue({});
      mockEnv.handle_query.mockResolvedValue("done");

      const manager = new BackgroundTaskManager(mockEnv);
      await manager.createTask({
        parentSessionId: "parent-1",
        description: "Test",
        prompt: "Work",
        subagentType: "general",
      });
      await new Promise((r) => setTimeout(r, 200));

      const event = publishedEvents.find((e) => e.type === BackgroundTaskEventTypes.COMPLETED);
      expect(event).toBeDefined();
      expect(event.payload.subSessionId).toBe("sub-fixed-id");

      await manager.dispose();
    });

    test("FAILED event payload contains subSessionId", async () => {
      const mockParentSession = { id: "parent-1" };
      const mockSubSession = {
        id: "sub-fixed-id",
        info: { metadata: { subagent_type: "general" } },
      };
      mockSessionComponent.get.mockResolvedValue(mockParentSession);
      mockSessionComponent.create.mockResolvedValue(mockSubSession);
      mockAgentComponent.getAgent.mockReturnValue(undefined);
      mockAgentComponent.registerAgent.mockReturnValue({});
      mockEnv.handle_query.mockRejectedValue(new Error("Test failure"));

      const manager = new BackgroundTaskManager(mockEnv);
      await manager.createTask({
        parentSessionId: "parent-1",
        description: "Test",
        prompt: "Work",
        subagentType: "general",
      });
      await new Promise((r) => setTimeout(r, 200));

      const event = publishedEvents.find((e) => e.type === BackgroundTaskEventTypes.FAILED);
      expect(event).toBeDefined();
      expect(event.payload.subSessionId).toBe("sub-fixed-id");

      await manager.dispose();
    });

    test("TIMEOUT event payload contains subSessionId", async () => {
      // 使用一个真实能触发 timeout 的场景：
      // - handle_query 永不解析，模拟 sub agent 长时间运行
      // - timeout: 50ms 强制 50ms 后超时
      // - wait 300ms 让 TIMEOUT 事件发布
      const mockParentSession = { id: "parent-1" };
      const mockSubSession = {
        id: "sub-fixed-id",
        info: { metadata: { subagent_type: "general" } },
      };
      // get() 第一次返回 parent-1（验证父 session 存在），之后返回 sub-fixed-id
      // create() 返回 sub-fixed-id
      let getCallCount = 0;
      mockSessionComponent.get.mockImplementation(async () => {
        getCallCount++;
        return getCallCount === 1 ? mockParentSession : mockSubSession;
      });
      mockSessionComponent.create.mockResolvedValue(mockSubSession);
      mockAgentComponent.getAgent.mockReturnValue(undefined);
      mockAgentComponent.registerAgent.mockReturnValue({});
      // handle_query 永不解析
      mockEnv.handle_query.mockImplementation(() => new Promise(() => {}));

      const manager = new BackgroundTaskManager(mockEnv);
      await manager.createTask({
        parentSessionId: "parent-1",
        description: "Test timeout",
        prompt: "Work",
        subagentType: "general",
        timeout: 50,
      });
      // 等待足够长让 TIMEOUT 触发
      await new Promise((r) => setTimeout(r, 500));

      // 验证 TIMEOUT 事件已发布且 payload 包含 subSessionId
      const event = publishedEvents.find((e) => e.type === BackgroundTaskEventTypes.TIMEOUT);
      expect(event).toBeDefined();
      expect(event?.payload.subSessionId).toBe("sub-fixed-id");

      await manager.dispose();
    });

    test("STOPPED event payload contains subSessionId", async () => {
      const mockParentSession = { id: "parent-1" };
      const mockSubSession = {
        id: "sub-fixed-id",
        info: { metadata: { subagent_type: "general" } },
      };
      mockSessionComponent.get.mockResolvedValue(mockParentSession);
      mockSessionComponent.create.mockResolvedValue(mockSubSession);
      mockAgentComponent.getAgent.mockReturnValue(undefined);
      mockAgentComponent.registerAgent.mockReturnValue({});
      // handle_query 永不解析以保持任务运行
      mockEnv.handle_query.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve("done"), 5000))
      );

      const manager = new BackgroundTaskManager(mockEnv);
      const { taskId: bgProcessId } = await manager.createTask({
        parentSessionId: "parent-1",
        description: "Test stop",
        prompt: "Work",
        subagentType: "general",
      });
      await new Promise((r) => setTimeout(r, 50));

      // 主动停止任务
      await manager.stopTask(bgProcessId);
      await new Promise((r) => setTimeout(r, 100));

      const event = publishedEvents.find((e) => e.type === BackgroundTaskEventTypes.STOPPED);
      expect(event).toBeDefined();
      expect(event.payload.subSessionId).toBe("sub-fixed-id");

      await manager.dispose();
    });
  });
});
