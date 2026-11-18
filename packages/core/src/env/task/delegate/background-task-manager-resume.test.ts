/**
 * @fileoverview BackgroundTaskManager.createTask Resume Mode Tests
 *
 * TDD: 测试 createTask 接收 existingSubSessionId 时进入复用模式
 * 复用模式：跳过 sessionComponent.create()，改为 get() 校验后复用 sub session
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { BackgroundTaskManager, type CreateBackgroundTaskOptions } from "./delegate-tool";

describe("BackgroundTaskManager.createTask - existingSubSessionId resume mode", () => {
  let mockEnv: any;
  let mockSessionComponent: any;
  let mockAgentComponent: any;

  beforeEach(() => {
    mockSessionComponent = {
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      addMessage: vi.fn(),
    };
    mockAgentComponent = {
      getAgent: vi.fn().mockReturnValue(undefined),
      registerAgent: vi.fn().mockReturnValue({}),
      getRegistry: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(undefined) }),
    };
    mockEnv = {
      getComponent: vi.fn((name: string) => {
        if (name === "session") return mockSessionComponent;
        if (name === "agent") return mockAgentComponent;
        return undefined;
      }),
      pushEnvEvent: vi.fn(),
      handle_query: vi.fn().mockResolvedValue("done"),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("should reuse existing sub session when existingSubSessionId is provided and valid", async () => {
    const mockParentSession = { id: "parent-1" };
    const mockExistingSubSession = {
      id: "existing-sub-1",
      info: { metadata: { created_by: "subagent", subagent_type: "general" } },
    };

    mockSessionComponent.get.mockImplementation(async (id: string) => {
      if (id === "parent-1") return mockParentSession;
      if (id === "existing-sub-1") return mockExistingSubSession;
      return undefined;
    });

    const manager = new BackgroundTaskManager(mockEnv);
    const result = await manager.createTask({
      parentSessionId: "parent-1",
      description: "Resume",
      prompt: "Continue",
      subagentType: "general",
      existingSubSessionId: "existing-sub-1",
    });

    // ★ 关键断言：create() 未被调用
    expect(mockSessionComponent.create).not.toHaveBeenCalled();
    // 复用的 subSessionId 应与传入的 ID 一致
    expect(result.subSessionId).toBe("existing-sub-1");

    await manager.dispose();
  });

  test("should throw error when existingSubSessionId not found", async () => {
    mockSessionComponent.get.mockImplementation(async (id: string) => {
      if (id === "parent-1") return { id: "parent-1" };
      return undefined; // existing-sub-1 不存在
    });

    const manager = new BackgroundTaskManager(mockEnv);

    await expect(
      manager.createTask({
        parentSessionId: "parent-1",
        description: "Resume",
        prompt: "Continue",
        subagentType: "general",
        existingSubSessionId: "missing-sub",
      })
    ).rejects.toThrow("Sub session not found for resume: missing-sub");

    await manager.dispose();
  });

  test("should create new sub session when existingSubSessionId not provided (backward compat)", async () => {
    const mockParentSession = { id: "parent-1" };
    const mockNewSession = { id: "new-sub-1", info: { metadata: {} } };

    mockSessionComponent.get.mockResolvedValue(mockParentSession);
    mockSessionComponent.create.mockResolvedValue(mockNewSession);

    const manager = new BackgroundTaskManager(mockEnv);
    const result = await manager.createTask({
      parentSessionId: "parent-1",
      description: "New task",
      prompt: "Do work",
      subagentType: "general",
    });

    expect(mockSessionComponent.create).toHaveBeenCalledTimes(1);
    expect(result.subSessionId).toBe("new-sub-1");

    await manager.dispose();
  });

  test("should warn but not throw when reused session is not a sub-agent session", async () => {
    const mockParentSession = { id: "parent-1" };
    const mockNonSubSession = {
      id: "not-sub-1",
      info: { metadata: { created_by: "user" } }, // 不是 subagent
    };

    mockSessionComponent.get.mockImplementation(async (id: string) => {
      if (id === "parent-1") return mockParentSession;
      if (id === "not-sub-1") return mockNonSubSession;
      return undefined;
    });

    const manager = new BackgroundTaskManager(mockEnv);
    const result = await manager.createTask({
      parentSessionId: "parent-1",
      description: "Try reuse",
      prompt: "Continue",
      subagentType: "general",
      existingSubSessionId: "not-sub-1",
    });

    // ★ 软校验：warn 但仍复用
    expect(result.subSessionId).toBe("not-sub-1");
    expect(mockSessionComponent.create).not.toHaveBeenCalled();

    await manager.dispose();
  });

  test("should mark reused session with metadata.reused_sub_session=true", async () => {
    const mockParentSession = { id: "parent-1" };
    const mockExistingSubSession = {
      id: "existing-sub-1",
      info: { metadata: { created_by: "subagent", subagent_type: "general" } },
    };
    mockSessionComponent.update = vi.fn().mockResolvedValue(true);
    mockSessionComponent.get.mockImplementation(async (id: string) => {
      if (id === "parent-1") return mockParentSession;
      if (id === "existing-sub-1") return mockExistingSubSession;
      return undefined;
    });

    const manager = new BackgroundTaskManager(mockEnv);
    await manager.createTask({
      parentSessionId: "parent-1",
      description: "Resume with metadata",
      prompt: "Continue",
      subagentType: "general",
      existingSubSessionId: "existing-sub-1",
    });

    // ★ 验证 metadata 标记被更新
    expect(mockSessionComponent.update).toHaveBeenCalledWith(
      "existing-sub-1",
      expect.objectContaining({
        metadata: expect.objectContaining({
          reused_sub_session: true,
          reused_at: expect.any(Number),
        }),
      })
    );

    await manager.dispose();
  });
});
