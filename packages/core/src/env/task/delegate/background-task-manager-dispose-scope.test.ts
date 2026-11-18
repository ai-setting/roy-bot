/**
 * @fileoverview BackgroundTaskManager.dispose() abort-scope regression tests
 *
 * Task #4794 — Bug: CLI `act` 默认接待员 agent 委派后台子 agent 后，
 * 主 run 结束触发 cleanup（runActShutdownCleanup → envService.dispose()
 * → TaskComponent.stop() → BackgroundTaskManager.dispose()），
 * dispose() 无条件 abort 所有 abortControllers → executeWithAbort 的
 * onAbort 监听器 → agentComp.abortRun(runId, "task_signal_abort") →
 * 子 agent 在 ~3.5s 内被误杀。
 *
 * 修复：dispose(options) 增加 `skipAbortRunningTasks` 选项。
 * - act 收尾路径传 { skipAbortRunningTasks: true } → 仍在运行的
 *   后台任务不被 abort（保留 process tree 清理，防止孤儿进程）。
 * - 默认（不传）→ 行为与旧版一致（abort 全部），保证
 *   ESC cascade / 强杀等「用户主动退出」语义不变。
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { BackgroundTaskManager, BackgroundTaskEventTypes, type CreateBackgroundTaskOptions } from "./delegate-tool";

describe("BackgroundTaskManager.dispose abort-scope (Task #4794)", () => {
  let mockEnv: any;
  let mockSessionComponent: any;
  let mockAgentComponent: any;
  let publishedEvents: any[];
  let abortRunCalls: Array<{ runId: string; reason?: string }>;

  beforeEach(() => {
    publishedEvents = [];
    abortRunCalls = [];

    mockSessionComponent = {
      get: vi.fn(),
      create: vi.fn(),
      addMessage: vi.fn(),
    };

    mockAgentComponent = {
      getAgent: vi.fn(),
      registerAgent: vi.fn(),
      abortRun: vi.fn((runId: string, reason?: string) => {
        abortRunCalls.push({ runId, reason });
        return true;
      }),
    };

    mockEnv = {
      getComponent: vi.fn((name: string) => {
        if (name === "session") return mockSessionComponent;
        if (name === "agent") return mockAgentComponent;
        return undefined;
      }),
      pushEnvEvent: vi.fn((event: any) => {
        publishedEvents.push(event);
      }),
      handle_query: vi.fn(async () => {
        // 模拟一个「还在跑」的子 agent：handle_query 挂起直到被 abort
        return new Promise<string>((resolve, reject) => {
          const t = setTimeout(() => resolve("slow task done"), 10_000);
          // allow abort to reject fast
          (t as any).unref?.();
        });
      }),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  /** 创建一个仍在运行的后台任务（handle_query 挂起 10s） */
  async function createRunningTask(): Promise<{ taskId: string; manager: BackgroundTaskManager }> {
    const mockParentSession = { id: "parent-session-123" };
    const mockSubSession = {
      id: "sub-session-456",
      metadata: { subagent_type: "general" },
    };
    mockSessionComponent.get.mockResolvedValue(mockParentSession);
    mockSessionComponent.create.mockResolvedValue(mockSubSession);

    const manager = new BackgroundTaskManager(mockEnv);
    const options: CreateBackgroundTaskOptions = {
      parentSessionId: "parent-session-123",
      description: "Long-running background task",
      prompt: "Do something long",
      subagentType: "general",
    };
    const { taskId } = await manager.createTask(options);
    // 等 executeTask 真正进入 executeWithAbort（signal listener 已挂上）
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { taskId, manager };
  }

  test("RED-1: dispose() 默认行为保持 abort（用户主动退出语义不变）", async () => {
    const { taskId, manager } = await createRunningTask();

    // 默认 dispose → 应该 abort（旧行为）
    await manager.dispose();
    // executeTask 的 catch → publishBackgroundEvent 是 abort 后的微任务，
    // 给它一个 tick 落盘
    await new Promise((resolve) => setTimeout(resolve, 60));

    // dispose 会清空 tasks/terminalTasks；改用「stopped 事件已发布」判定
    const stoppedEvent = publishedEvents.find(
      (e) => e.type === BackgroundTaskEventTypes.STOPPED,
    );
    expect(stoppedEvent).toBeDefined();
    expect(stoppedEvent.payload.backgroundTaskId).toBe(taskId);
  });

  test("RED-2: dispose({skipAbortRunningTasks:true}) 不 abort 仍在运行的任务（act 收尾）", async () => {
    const { taskId, manager } = await createRunningTask();

    // dispose 前先确认任务处于 running
    const before = (manager as any).tasks.get(taskId);
    expect(before?.status).toBe("running");

    await manager.dispose({ skipAbortRunningTasks: true });

    // 关键断言：没有 stopped 事件（没被 abort 误杀）
    const stoppedEvent = publishedEvents.find(
      (e) => e.type === BackgroundTaskEventTypes.STOPPED,
    );
    expect(stoppedEvent).toBeUndefined();
  });

  test("RED-3: skipAbortRunningTasks 收尾仍清理 timers 与空 registry（不挂进程）", async () => {
    const { manager } = await createRunningTask();

    await manager.dispose({ skipAbortRunningTasks: true });

    // dispose 后 abortControllers 表被清空（防句柄泄漏）
    expect((manager as any).abortControllers.size).toBe(0);
    // progressTimers 清空
    expect((manager as any).progressTimers.size).toBe(0);
  });

  test("RED-4: skipAbortRunningTasks 时等待运行中任务完成后再返回（act 收尾不杀子 agent）", async () => {
    const { taskId, manager } = await createRunningTask();

    const start = Date.now();
    await manager.dispose({ skipAbortRunningTasks: true, waitForRunningTasks: true });
    const elapsed = Date.now() - start;

    // mockEnv.handle_query 10s 后 resolve —— dispose 必须等它完成
    expect(elapsed).toBeGreaterThanOrEqual(9000);
    // 任务被标记 completed（不是 stopped/aborted）— dispose 清空 tasks，
    // 改用 completed 事件判定（按 taskId 过滤，防跨测试事件泄漏）
    const completedEvent = publishedEvents.find(
      (e) =>
        e.type === BackgroundTaskEventTypes.COMPLETED &&
        (e.payload?.backgroundTaskId ?? e.payload?.taskId) === taskId,
    );
    expect(completedEvent).toBeDefined();
    // 没有 stopped 事件（没被 abort 误杀）
    const stoppedEvent = publishedEvents.find(
      (e) => e.type === BackgroundTaskEventTypes.STOPPED,
    );
    expect(stoppedEvent).toBeUndefined();
  }, 20_000);

  test("RED-5: waitForRunningTasks 时无运行中任务则立即返回（不挂进程）", async () => {
    const { manager } = await createRunningTask();
    // 先让任务跑完（mockEnv.handle_query 10s 太长 —— 直接改状态）
    const task = (manager as any).tasks.get((manager as any).tasks.keys().next().value);
    task.status = "completed";

    const start = Date.now();
    await manager.dispose({ skipAbortRunningTasks: true, waitForRunningTasks: true });
    expect(Date.now() - start).toBeLessThan(3000);
  });

  test("RED-6: 默认 dispose（无 options）不等待（保持旧语义）", async () => {
    const { manager } = await createRunningTask();

    const start = Date.now();
    await manager.dispose();
    expect(Date.now() - start).toBeLessThan(3000);
  });
});
