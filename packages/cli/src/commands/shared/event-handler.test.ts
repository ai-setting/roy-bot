/**
 * @fileoverview EventHandler Test - Event Source Shared Session
 * 
 * TDD: 测试 EventHandler 的 shared session 管理功能
 * 
 * 测试场景：
 * 1. 无 sessionComponent 时向后兼容
 * 2. 第一个事件触发创建 session
 * 3. 同一批次事件复用同一个 session
 * 4. 队列清空后 session 被清除
 * 5. 新批次事件创建新 session
 * 6. stop() 时清除 session
 * 7. sessionComponent.create 失败时的错误处理
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "bun:test";
import { EventHandler } from "./event-handler";
import type { EventHandlerOptions } from "./event-handler";
import { EventMessageFormatter, type FormattedEvent, extractChatId } from "./event-message-formatter";

// ============================================================================
// Helper: 异步等待工具
// ============================================================================

/**
 * 轮询等待条件满足
 */
async function waitFor(fn: () => boolean, timeout = 2000, interval = 10): Promise<void> {
  const start = Date.now();
  while (!fn() && Date.now() - start < timeout) {
    await new Promise(r => setTimeout(r, interval));
  }
  if (!fn()) {
    throw new Error(`waitFor timed out after ${timeout}ms`);
  }
}

/**
 * 等待指定毫秒
 */
async function delay(ms: number): Promise<void> {
  await new Promise(r => setTimeout(r, ms));
}

// ============================================================================
// Mock Types & Helpers
// ============================================================================

interface MockEnvEvent {
  type: string;
  payload: unknown;
  metadata?: Record<string, unknown>;
}

interface MockSession {
  id: string;
  title: string;
}

interface MockSessionComponent {
  create: ReturnType<typeof vi.fn>;
  // Task #1766: 新增默认 mock 接口
  get?: ReturnType<typeof vi.fn>;
  getActiveSessionId?: ReturnType<typeof vi.fn>;
  setActiveSession?: ReturnType<typeof vi.fn>;
  // chat-keyed session 测试需要 list
  list?: ReturnType<typeof vi.fn>;
}

interface MockEnvironment {
  subscribeAll: ReturnType<typeof vi.fn>;
}

let sessionCreateCount = 0;
let mockSessionComponent: MockSessionComponent;
let mockEnv: MockEnvironment;

/**
 * 创建一个模拟的 EnvEvent
 */
function createMockEnvEvent(type: string = "event-source.event.test"): MockEnvEvent {
  return {
    type,
    payload: { message: `test event ${Date.now()}` },
    metadata: { sourceId: "test-source" },
  };
}

/**
 * 创建基础 EventHandler 配置
 */
function createOptions(overrides: Partial<EventHandlerOptions> = {}): EventHandlerOptions {
  return {
    env: mockEnv as any,
    eventTypes: ["event-source.event.*"],
    formatter: new EventMessageFormatter({ prefix: "[测试]" }),
    isIdle: () => true,
    onEvent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  sessionCreateCount = 0;

  mockSessionComponent = {
    create: vi.fn().mockImplementation(async (_options?: any) => {
      sessionCreateCount++;
      return {
        id: `event-session-${sessionCreateCount}`,
        title: `Event Session ${sessionCreateCount}`,
      } as MockSession;
    }),
    // Task #1766: 新增默认 mock 方法
    // - getActiveSessionId 返回 undefined → 走 fallback create 路径（向后兼容）
    // - setActiveSession 是 no-op → 不影响测试断言
    get: vi.fn().mockImplementation(async (_id: string) => {
      // 默认 mock：不返回任何 session，让 get() 查找失败以触发 fallback
      return undefined;
    }),
    getActiveSessionId: vi.fn().mockReturnValue(undefined),
    setActiveSession: vi.fn().mockResolvedValue(true),
    // chat-keyed session 测试需要 list
    // 默认返回空数组 → 走 create 路径
    list: vi.fn().mockResolvedValue([]),
  };

  mockEnv = {
    subscribeAll: vi.fn().mockReturnValue(() => {}),
  };
});

// ============================================================================
// 测试1: 无 sessionComponent 时向后兼容
// ============================================================================

describe("EventHandler - Shared Session: Backward Compat", () => {
  test("没有 sessionComponent 时，不应该创建 session，eventSessionId 为 undefined", async () => {
    const onEventWithEnv = vi.fn().mockResolvedValue(undefined);
    
    const handler = new EventHandler(createOptions({
      onEventWithEnv,
      // 不传 sessionComponent
    }));

    // 入队一个事件
    const event = createMockEnvEvent();
    const formatted = new EventMessageFormatter().formatWithEvent(event as any);
    handler.enqueue(formatted);

    // 等待处理完成
    await waitFor(() => onEventWithEnv.mock.calls.length > 0, 2000);

    // 验证：onEventWithEnv 被调用，但 eventSessionId 为 undefined
    expect(onEventWithEnv).toHaveBeenCalledTimes(1);
    const calledWith: FormattedEvent = onEventWithEnv.mock.calls[0][0];
    expect(calledWith.eventSessionId).toBeUndefined();
    
    // 验证：sessionComponent.create 没有被调用
    if (mockSessionComponent.create.mock) {
      expect(mockSessionComponent.create).not.toHaveBeenCalled();
    }

    handler.stop();
  });

  test("getActiveEventSessionId 在没有 sessionComponent 时返回 null", () => {
    const handler = new EventHandler(createOptions({
      // 不传 sessionComponent
    }));
    
    expect(handler.getActiveEventSessionId()).toBeNull();
    handler.stop();
  });
});

// ============================================================================
// 测试8: processQueue 运行期间有新事件入队（while 循环重新检查队列）
// ============================================================================

describe("EventHandler - Shared Session: Concurrent Events During Processing", () => {
  test("processQueue 处理期间新事件入队时，while 循环应拾取它们且复用同一个 session", async () => {
    const receivedSessionIds: (string | undefined)[] = [];
    let callCount = 0;
    
    // 让 onEventWithEnv 在第一次调用时入队一个新事件，模拟并发
    const onEventWithEnv = vi.fn().mockImplementation(async (fe: FormattedEvent) => {
      callCount++;
      receivedSessionIds.push(fe.eventSessionId);
      
      // 第一个事件处理完成后，入队一个新事件（模拟处理期间到达的事件）
      if (callCount === 1) {
        const extraEvent = createMockEnvEvent("event-source.event.concurrent");
        const extraFormatted = new EventMessageFormatter().formatWithEvent(extraEvent as any);
        // 直接操作内部 queue 注入新事件
        handler.enqueue(extraFormatted);
      }
    });
    
    const handler = new EventHandler(createOptions({
      sessionComponent: mockSessionComponent as any,
      onEventWithEnv,
    }));

    // 入队第一个事件（触发 processQueue）
    const event = createMockEnvEvent("event-source.event.first");
    handler.enqueue(new EventMessageFormatter().formatWithEvent(event as any));

    // 等待所有事件处理完成（2 个事件）
    await waitFor(() => onEventWithEnv.mock.calls.length >= 2, 5000);

    // 验证：两个事件都被处理
    expect(onEventWithEnv).toHaveBeenCalledTimes(2);
    
    // 验证：只创建了一个 session（while 循环复用）
    expect(mockSessionComponent.create).toHaveBeenCalledTimes(1);
    
    // 验证：两个事件的 sessionId 相同
    expect(receivedSessionIds.length).toBe(2);
    expect(receivedSessionIds[0]).toBe("event-session-1");
    expect(receivedSessionIds[1]).toBe("event-session-1");

    // 验证队列已清空
    expect(handler.isQueueEmpty()).toBe(true);

    handler.stop();
  });
});

// ============================================================================
// 测试2: 第一个事件触发创建 session
// ============================================================================

describe("EventHandler - Shared Session: Session Creation", () => {
  test("有 sessionComponent 时，第一个事件应该创建新的 active session", async () => {
    const onEventWithEnv = vi.fn().mockResolvedValue(undefined);
    
    const handler = new EventHandler(createOptions({
      sessionComponent: mockSessionComponent as any,
      onEventWithEnv,
    }));

    const event = createMockEnvEvent();
    const formatted = new EventMessageFormatter().formatWithEvent(event as any);
    handler.enqueue(formatted);

    await waitFor(() => onEventWithEnv.mock.calls.length > 0, 2000);

    // 验证 session 被创建
    expect(mockSessionComponent.create).toHaveBeenCalledTimes(1);
    
    // 验证 eventSessionId 被注入到 formattedEvent
    const calledWith: FormattedEvent = onEventWithEnv.mock.calls[0][0];
    expect(calledWith.eventSessionId).toBe("event-session-1");

    handler.stop();
  });
});

// ============================================================================
// 测试3: 同一批次事件复用同一个 session
// ============================================================================

describe("EventHandler - Shared Session: Session Reuse", () => {
  test("同一批次多个事件应该共享同一个 session", async () => {
    const receivedSessionIds: (string | undefined)[] = [];
    const onEventWithEnv = vi.fn().mockImplementation(async (fe: FormattedEvent) => {
      receivedSessionIds.push(fe.eventSessionId);
    });
    
    const handler = new EventHandler(createOptions({
      sessionComponent: mockSessionComponent as any,
      onEventWithEnv,
      eventTypes: ["event-source.event.*", "task.background.*"],
    }));

    // 入队多个事件（同一批次，在 processQueue 开始前全部入队）
    for (let i = 0; i < 3; i++) {
      const event = createMockEnvEvent(`event-source.event.batch-${i}`);
      const formatted = new EventMessageFormatter().formatWithEvent(event as any);
      handler.enqueue(formatted);
    }

    // 等待所有处理完成
    await waitFor(() => onEventWithEnv.mock.calls.length >= 3, 5000);

    // 验证：只创建了一个 session
    expect(mockSessionComponent.create).toHaveBeenCalledTimes(1);
    
    // 验证：所有事件的 sessionId 相同
    expect(receivedSessionIds.length).toBe(3);
    const firstId = receivedSessionIds[0];
    expect(firstId).toBeDefined();
    for (const id of receivedSessionIds) {
      expect(id).toBe(firstId);
    }

    handler.stop();
  });
});

// ============================================================================
// 测试4: 队列清空后 session 保持活跃（跨批次复用）
// ============================================================================
//
// 设计变更 (Task #1766): processQueue 不再 clear active session，
// 让下一批事件能跨批次复用同一个 session（与 REPL 共享）。
// stop() 仍负责清理。
// ============================================================================

describe("EventHandler - Shared Session: Session Retained Across Batches", () => {
  test("所有事件处理完成后，active session 应该被保留（跨批次复用）", async () => {
    const onEventWithEnv = vi.fn().mockResolvedValue(undefined);

    const handler = new EventHandler(createOptions({
      sessionComponent: mockSessionComponent as any,
      onEventWithEnv,
    }));

    const event = createMockEnvEvent();
    const formatted = new EventMessageFormatter().formatWithEvent(event as any);
    handler.enqueue(formatted);

    await waitFor(() => onEventWithEnv.mock.calls.length > 0, 2000);

    // 等待 processQueue 完成（isProcessing 变为 false）
    await waitFor(() => handler.isQueueEmpty() && !(handler as any).isProcessing, 2000);

    // ⚠️ 新行为：active session 在 processQueue 完成后**不被清除**，
    // 跨批次复用同一个 session（让 REPL 和 event handler 共享对话上下文）。
    expect(handler.getActiveEventSessionId()).toBe("event-session-1");

    handler.stop();
  });
});

// ============================================================================
// 测试5: 跨批次事件复用同一个 session（关键设计变更）
// ============================================================================
//
// 设计变更 (Task #1766): 之前每个批次创建一个独立 session，会丢失对话上下文。
// 新行为：跨批次复用同一个 session，第一批创建后保持 active 状态。
// ============================================================================

describe("EventHandler - Shared Session: New Session Per Batch", () => {
  test("第一批处理完后，第二批事件应该复用第一批创建的 session", async () => {
    const allSessionIds: (string | undefined)[] = [];
    const onEventWithEnv = vi.fn().mockImplementation(async (fe: FormattedEvent) => {
      allSessionIds.push(fe.eventSessionId);
    });

    const handler = new EventHandler(createOptions({
      sessionComponent: mockSessionComponent as any,
      onEventWithEnv,
    }));

    // 第一批事件
    const event1 = createMockEnvEvent("event-source.event.batch1");
    handler.enqueue(new EventMessageFormatter().formatWithEvent(event1 as any));

    // 等待第一批处理完成
    await waitFor(() => onEventWithEnv.mock.calls.length >= 1, 2000);

    // 等待 processQueue 结束
    await waitFor(() => handler.isQueueEmpty() && !(handler as any).isProcessing, 2000);

    // ⚠️ 新行为：第一批完成后 session 仍 active（跨批次复用）
    expect(handler.getActiveEventSessionId()).toBe("event-session-1");

    // 第二批事件
    const event2 = createMockEnvEvent("event-source.event.batch2");
    handler.enqueue(new EventMessageFormatter().formatWithEvent(event2 as any));

    // 等待第二批处理完成
    await waitFor(() => onEventWithEnv.mock.calls.length >= 2, 2000);

    await waitFor(() => handler.isQueueEmpty() && !(handler as any).isProcessing, 2000);

    // ⚠️ 新行为：create 只被调用 1 次（不是 2 次）
    expect(mockSessionComponent.create).toHaveBeenCalledTimes(1);

    // ⚠️ 新行为：两个 event 的 sessionId 相同
    expect(allSessionIds.length).toBe(2);
    expect(allSessionIds[0]).toBe("event-session-1");
    expect(allSessionIds[1]).toBe("event-session-1");
    expect(allSessionIds[0]).toBe(allSessionIds[1]);

    // 跨批次复用：第二批完成后 session 仍 active
    expect(handler.getActiveEventSessionId()).toBe("event-session-1");

    handler.stop();
  });
});

// ============================================================================
// 测试6: stop() 时清除 session
// ============================================================================

describe("EventHandler - Shared Session: Stop Clears Session", () => {
  test("stop() 应该清除 active session", async () => {
    const onEventWithEnv = vi.fn().mockImplementation(async () => {
      // 在处理过程中不做额外事情
    });
    
    const handler = new EventHandler(createOptions({
      sessionComponent: mockSessionComponent as any,
      onEventWithEnv,
    }));

    const event = createMockEnvEvent();
    handler.enqueue(new EventMessageFormatter().formatWithEvent(event as any));

    // 等待开始处理
    await waitFor(() => onEventWithEnv.mock.calls.length > 0, 2000);

    // 在处理过程中调用 stop
    handler.stop();

    // 验证 session 被清除
    expect(handler.getActiveEventSessionId()).toBeNull();
  });
});

// ============================================================================
// 测试7: sessionComponent.create 失败时的错误处理
// ============================================================================

describe("EventHandler - Shared Session: Error Handling", () => {
  test("sessionComponent.create 失败时，eventSessionId 为 undefined，事件仍被处理", async () => {
    const failingSessionComponent = {
      create: vi.fn().mockRejectedValue(new Error("Session creation failed")),
      // Task #1766: 新增默认 mock 方法
      get: vi.fn().mockResolvedValue(undefined),
      getActiveSessionId: vi.fn().mockReturnValue(undefined),
      setActiveSession: vi.fn().mockResolvedValue(true),
    };

    const onEventWithEnv = vi.fn().mockResolvedValue(undefined);

    const handler = new EventHandler(createOptions({
      sessionComponent: failingSessionComponent as any,
      onEventWithEnv,
    }));

    const event = createMockEnvEvent();
    handler.enqueue(new EventMessageFormatter().formatWithEvent(event as any));

    await waitFor(() => onEventWithEnv.mock.calls.length > 0, 2000);

    // 事件仍被处理，但 eventSessionId 为 undefined
    expect(onEventWithEnv).toHaveBeenCalledTimes(1);
    const calledWith: FormattedEvent = onEventWithEnv.mock.calls[0][0];
    expect(calledWith.eventSessionId).toBeUndefined();
    expect(calledWith.message).toBeDefined();

    handler.stop();
  });
});

// ============================================================================
// 测试9-13: Parent Session Reuse - 复用 trigger_session_id
// ============================================================================
//
// Bug: delegate_task 触发的任务状态通知，原本应该复用父 session，
//      但 ensureActiveSession() 无脑创建了新 session。
//
// Fix: 从 event.metadata.trigger_session_id 提取父 session ID，
//      优先调用 sessionComponent.get() 复用，找不到再 fallback create。
// ============================================================================

/**
 * 创建一个带 trigger_session_id 的 mock EnvEvent
 */
function createMockEnvEventWithTriggerSessionId(
  type: string,
  triggerSessionId: string | undefined,
): MockEnvEvent {
  return {
    type,
    payload: { message: `test event ${Date.now()}` },
    metadata: {
      sourceId: "test-source",
      trigger_session_id: triggerSessionId,
    },
  };
}

// ============================================================================
// 测试14-17: Shared Active Session with REPL - 新增核心功能 (Task #1766)
//
// Bug: 飞书/bounty IM 事件触发会创建独立 session，导致对话上下文丢失。
// Fix: sessionComponent 已有 global active session (REPL 启动时 sessionManager.init()
//      已 setActiveSession) 时，复用它而不是创建新的。
// ============================================================================

/**
 * 创建一个带 getActiveSessionId / setActiveSession / get 的 mock SessionComponent
 */
function createMockSessionComponentWithGlobalActive(
  activeId: string | undefined,
  activeSession: MockSession | undefined,
  existingSessions: Record<string, MockSession> = {},
): any {
  return {
    create: vi.fn().mockImplementation(async (options?: any) => {
      // 实际场景中 create 还会被叫，仅在 fallback 时
      return { id: "new-fallback-session", title: options?.title ?? "fallback" };
    }),
    get: vi.fn().mockImplementation(async (id: string) => {
      if (activeId && id === activeId) return activeSession;
      if (existingSessions[id]) return existingSessions[id];
      return undefined;
    }),
    getActiveSessionId: vi.fn().mockReturnValue(activeId),
    setActiveSession: vi.fn().mockResolvedValue(true),
    getActiveSession: vi.fn().mockReturnValue(activeSession),
  };
}

describe("EventHandler - Shared Session with REPL", () => {
  test("[NEW 1] 复用 REPL active session: sessionComponent.getActiveSessionId() 有值 → 复用而非 create", async () => {
    const onEventWithEnv = vi.fn().mockResolvedValue(undefined);

    const activeSessionId = "event-session-active";
    const sessionComponent = createMockSessionComponentWithGlobalActive(
      activeSessionId,
      { id: activeSessionId, title: "REPL Active Session" },
    );

    const handler = new EventHandler(createOptions({
      sessionComponent: sessionComponent as any,
      onEventWithEnv,
    }));

    // 入队一个**不带** triggerSessionId 的 event
    const event = createMockEnvEvent("event-source.event.from-lark");
    handler.enqueue(new EventMessageFormatter().formatWithEvent(event as any));

    await waitFor(() => onEventWithEnv.mock.calls.length > 0, 2000);

    // 验证：sessionComponent.create 未被调用（没有 fallback 到 create）
    expect(sessionComponent.create).not.toHaveBeenCalled();

    // 验证：sessionComponent.get 被调 1 次且参数是 activeSessionId
    expect(sessionComponent.get).toHaveBeenCalledTimes(1);
    expect(sessionComponent.get).toHaveBeenCalledWith(activeSessionId);

    // 验证：返回的 eventSessionId === activeSessionId
    const calledWith: FormattedEvent = onEventWithEnv.mock.calls[0][0];
    expect(calledWith.eventSessionId).toBe(activeSessionId);

    handler.stop();
  });

  test("[NEW 2] 跨批次复用 active session: 第一批处理完后 active session 不被清除，第二批继续复用", async () => {
    const receivedSessionIds: (string | undefined)[] = [];
    const onEventWithEnv = vi.fn().mockImplementation(async (fe: FormattedEvent) => {
      receivedSessionIds.push(fe.eventSessionId);
    });

    const activeSessionId = "repl-shared-session";
    const sessionComponent = createMockSessionComponentWithGlobalActive(
      activeSessionId,
      { id: activeSessionId, title: "REPL Shared" },
    );

    const handler = new EventHandler(createOptions({
      sessionComponent: sessionComponent as any,
      onEventWithEnv,
    }));

    // 第一批事件
    const event1 = createMockEnvEvent("event-source.event.batch1");
    handler.enqueue(new EventMessageFormatter().formatWithEvent(event1 as any));

    // 等待第一批处理完成
    await waitFor(() => onEventWithEnv.mock.calls.length >= 1, 2000);
    await waitFor(() => handler.isQueueEmpty() && !(handler as any).isProcessing, 2000);

    // 验证第一批完成后 active session 不被清除
    expect(handler.getActiveEventSessionId()).not.toBeNull();
    expect(handler.getActiveEventSessionId()).toBe(activeSessionId);

    // 第二批事件
    const event2 = createMockEnvEvent("event-source.event.batch2");
    handler.enqueue(new EventMessageFormatter().formatWithEvent(event2 as any));

    // 等待第二批处理完成
    await waitFor(() => onEventWithEnv.mock.calls.length >= 2, 2000);
    await waitFor(() => handler.isQueueEmpty() && !(handler as any).isProcessing, 2000);

    // 验证：create 总共只调 0 次（fallback 没走到）
    expect(sessionComponent.create).not.toHaveBeenCalled();

    // 验证：两个 event 的 eventSessionId 相同
    expect(receivedSessionIds.length).toBe(2);
    expect(receivedSessionIds[0]).toBe(activeSessionId);
    expect(receivedSessionIds[1]).toBe(activeSessionId);

    // 验证：get 只被调用 2 次（每次 ensureActiveSession 1 次，跨批次）
    // 第一次和第二次都各自调一次 get，因为 activeEventSessionId 已被第一次设置后,
    // 第二次直接走优 1 短路，不会再调 get。
    // 实际：第二批入队时 activeEventSessionId 已为 activeSessionId → 短路返回。
    expect(sessionComponent.get).toHaveBeenCalledTimes(1);

    handler.stop();
  });

  test("[NEW 3] 优 1 优先于优 2 (getActiveSessionId): 有 triggerSessionId + global active → 优先复用父 session", async () => {
    const onEventWithEnv = vi.fn().mockResolvedValue(undefined);

    const globalActiveId = "global-active-session";
    const parentSessionId = "parent-session";

    const sessionComponent = createMockSessionComponentWithGlobalActive(
      globalActiveId,
      { id: globalActiveId, title: "Global Active" },
      {
        [parentSessionId]: { id: parentSessionId, title: "Parent" },
      },
    );

    const handler = new EventHandler(createOptions({
      sessionComponent: sessionComponent as any,
      onEventWithEnv,
    }));

    // 入队一个**带** triggerSessionId 的 event
    const event = createMockEnvEventWithTriggerSessionId(
      "event-source.event.with-parent",
      parentSessionId,
    );
    handler.enqueue(new EventMessageFormatter().formatWithEvent(event as any));

    await waitFor(() => onEventWithEnv.mock.calls.length > 0, 2000);

    // 验证：getActiveSessionId 未被调用（优 1 命中后短路，优 2 不会跑）
    expect(sessionComponent.getActiveSessionId).not.toHaveBeenCalled();

    // 验证：get 被调 1 次且参数是 parentSessionId（不是 globalActiveId）
    expect(sessionComponent.get).toHaveBeenCalledTimes(1);
    expect(sessionComponent.get).toHaveBeenCalledWith(parentSessionId);

    // 验证 eventSessionId === parentSessionId
    const calledWith: FormattedEvent = onEventWithEnv.mock.calls[0][0];
    expect(calledWith.eventSessionId).toBe(parentSessionId);

    // 验证 setActiveSession 被调用（让 REPL 也能看到父 session）
    expect(sessionComponent.setActiveSession).toHaveBeenCalledWith(parentSessionId);

    handler.stop();
  });

  test("[NEW 4] 复用父 session 时调 setActiveSession: 让 REPL 也能看到父 session（commit 29c9ac25 增强）", async () => {
    const onEventWithEnv = vi.fn().mockResolvedValue(undefined);

    const parentSessionId = "parent-session-with-setActive";

    const sessionComponent = {
      create: vi.fn().mockImplementation(async () => {
        return { id: "new-session", title: "new" };
      }),
      get: vi.fn().mockImplementation(async (id: string) => {
        if (id === parentSessionId) {
          return { id: parentSessionId, title: "Parent" };
        }
        return undefined;
      }),
      getActiveSessionId: vi.fn().mockReturnValue(undefined),
      setActiveSession: vi.fn().mockResolvedValue(true),
    };

    const handler = new EventHandler(createOptions({
      sessionComponent: sessionComponent as any,
      onEventWithEnv,
    }));

    // 入队带 triggerSessionId 的 event
    const event = createMockEnvEventWithTriggerSessionId(
      "event-source.event.task-notification",
      parentSessionId,
    );
    handler.enqueue(new EventMessageFormatter().formatWithEvent(event as any));

    await waitFor(() => onEventWithEnv.mock.calls.length > 0, 2000);

    // 验证：get 被调（查找父 session）
    expect(sessionComponent.get).toHaveBeenCalledWith(parentSessionId);

    // 验证：create 未被调用（复用父 session 成功）
    expect(sessionComponent.create).not.toHaveBeenCalled();

    // 验证：setActiveSession 被调用（commit 29c9ac25 增强：让 REPL 看到父 session）
    expect(sessionComponent.setActiveSession).toHaveBeenCalledTimes(1);
    expect(sessionComponent.setActiveSession).toHaveBeenCalledWith(parentSessionId);

    handler.stop();
  });
});

describe("EventHandler - Parent Session Reuse", () => {
  test("[RED 1] 复用父 session: event.metadata.trigger_session_id 指向已存在的 parent session → 复用而非新建", async () => {
    const parentSessionId = "parent-session-existing-1";
    const onEventWithEnv = vi.fn().mockResolvedValue(undefined);

    // sessionComponent.get 返回已存在的 parent session
    const sessionComponentWithGet = {
      create: vi.fn().mockImplementation(async () => {
        return { id: "new-session-should-not-be-used", title: "new" };
      }),
      get: vi.fn().mockImplementation(async (id: string) => {
        if (id === parentSessionId) {
          return { id: parentSessionId, title: "Parent Session" };
        }
        return undefined;
      }),
      // Task #1766: 新增 setActiveSession / getActiveSessionId 方法
      // (父 session 复用时 EventHandler 会调 setActiveSession 让 REPL 也能看到)
      getActiveSessionId: vi.fn().mockReturnValue(undefined),
      setActiveSession: vi.fn().mockResolvedValue(true),
    };

    const handler = new EventHandler(createOptions({
      sessionComponent: sessionComponentWithGet as any,
      onEventWithEnv,
    }));

    // 入队带 trigger_session_id 的事件
    const event = createMockEnvEventWithTriggerSessionId(
      "event-source.event.with-trigger",
      parentSessionId,
    );
    const formatter = new EventMessageFormatter();
    handler.enqueue(formatter.formatWithEvent(event as any));

    await waitFor(() => onEventWithEnv.mock.calls.length > 0, 2000);

    // 验证：sessionComponent.get 被调用，且使用了 trigger_session_id
    expect(sessionComponentWithGet.get).toHaveBeenCalledTimes(1);
    expect(sessionComponentWithGet.get).toHaveBeenCalledWith(parentSessionId);

    // 验证：sessionComponent.create 未被调用（不应该创建新 session）
    expect(sessionComponentWithGet.create).not.toHaveBeenCalled();

    // 验证：eventSessionId 应该是父 session ID
    const calledWith: FormattedEvent = onEventWithEnv.mock.calls[0][0];
    expect(calledWith.eventSessionId).toBe(parentSessionId);

    handler.stop();
  });

  test("[RED 2] fallback 1: event 没有 trigger_session_id → 走原 create 路径", async () => {
    const onEventWithEnv = vi.fn().mockResolvedValue(undefined);

    const sessionComponentWithGet = {
      create: vi.fn().mockImplementation(async () => {
        return { id: "event-session-fallback-1", title: "Fallback" };
      }),
      get: vi.fn().mockResolvedValue(undefined),
      // Task #1766: 新增
      getActiveSessionId: vi.fn().mockReturnValue(undefined),
      setActiveSession: vi.fn().mockResolvedValue(true),
    };

    const handler = new EventHandler(createOptions({
      sessionComponent: sessionComponentWithGet as any,
      onEventWithEnv,
    }));

    // 入队一个没有 trigger_session_id 的事件
    const event = createMockEnvEvent(); // 默认无 trigger_session_id
    handler.enqueue(new EventMessageFormatter().formatWithEvent(event as any));

    await waitFor(() => onEventWithEnv.mock.calls.length > 0, 2000);

    // 验证：get 不应该被调用（因为没传 trigger_session_id）
    expect(sessionComponentWithGet.get).not.toHaveBeenCalled();

    // 验证：create 应该被调用（fallback 行为）
    expect(sessionComponentWithGet.create).toHaveBeenCalledTimes(1);

    // 验证：eventSessionId 是新创建的 session ID
    const calledWith: FormattedEvent = onEventWithEnv.mock.calls[0][0];
    expect(calledWith.eventSessionId).toBe("event-session-fallback-1");

    handler.stop();
  });

  test("[RED 3] fallback 2: trigger_session_id 指向不存在的 session → fallback create（不抛错）", async () => {
    const onEventWithEnv = vi.fn().mockResolvedValue(undefined);

    const sessionComponentWithGet = {
      create: vi.fn().mockImplementation(async () => {
        return { id: "event-session-fallback-2", title: "Fallback 2" };
      }),
      get: vi.fn().mockResolvedValue(undefined), // parent session 找不到
      // Task #1766: 新增
      getActiveSessionId: vi.fn().mockReturnValue(undefined),
      setActiveSession: vi.fn().mockResolvedValue(true),
    };

    const handler = new EventHandler(createOptions({
      sessionComponent: sessionComponentWithGet as any,
      onEventWithEnv,
    }));

    // 入队一个 trigger_session_id 指向不存在 session 的事件
    const event = createMockEnvEventWithTriggerSessionId(
      "event-source.event.missing-parent",
      "non-existent-parent-id",
    );
    handler.enqueue(new EventMessageFormatter().formatWithEvent(event as any));

    await waitFor(() => onEventWithEnv.mock.calls.length > 0, 2000);

    // 验证：get 被调用过（尝试查找）
    expect(sessionComponentWithGet.get).toHaveBeenCalledTimes(1);
    expect(sessionComponentWithGet.get).toHaveBeenCalledWith("non-existent-parent-id");

    // 验证：create 被调用（fallback，因为父 session 找不到）
    expect(sessionComponentWithGet.create).toHaveBeenCalledTimes(1);

    // 验证：eventSessionId 是新创建的 session ID（不是 trigger_session_id）
    const calledWith: FormattedEvent = onEventWithEnv.mock.calls[0][0];
    expect(calledWith.eventSessionId).toBe("event-session-fallback-2");
    expect(calledWith.eventSessionId).not.toBe("non-existent-parent-id");

    handler.stop();
  });

  test("[RED 4] 同一批事件共享父 session: 多事件 triggerSessionId 相同 → 只调一次 get，不调 create", async () => {
    const parentSessionId = "parent-session-shared";
    const receivedSessionIds: (string | undefined)[] = [];

    const onEventWithEnv = vi.fn().mockImplementation(async (fe: FormattedEvent) => {
      receivedSessionIds.push(fe.eventSessionId);
    });

    const sessionComponentWithGet = {
      create: vi.fn().mockImplementation(async () => {
        return { id: "new-should-not-be-used", title: "new" };
      }),
      get: vi.fn().mockImplementation(async (id: string) => {
        if (id === parentSessionId) {
          return { id: parentSessionId, title: "Parent" };
        }
        return undefined;
      }),
      // Task #1766: 新增
      getActiveSessionId: vi.fn().mockReturnValue(undefined),
      setActiveSession: vi.fn().mockResolvedValue(true),
    };

    const handler = new EventHandler(createOptions({
      sessionComponent: sessionComponentWithGet as any,
      onEventWithEnv,
      eventTypes: ["event-source.event.*", "task.background.*"],
    }));

    // 入队多个带相同 trigger_session_id 的事件（同一批）
    for (let i = 0; i < 3; i++) {
      const event = createMockEnvEventWithTriggerSessionId(
        `event-source.event.batch-${i}`,
        parentSessionId,
      );
      handler.enqueue(new EventMessageFormatter().formatWithEvent(event as any));
    }

    // 等待所有事件处理完成
    await waitFor(() => onEventWithEnv.mock.calls.length >= 3, 5000);

    // 验证：get 只被调用 1 次
    expect(sessionComponentWithGet.get).toHaveBeenCalledTimes(1);
    expect(sessionComponentWithGet.get).toHaveBeenCalledWith(parentSessionId);

    // 验证：create 未被调用
    expect(sessionComponentWithGet.create).not.toHaveBeenCalled();

    // 验证：所有事件共享同一个父 session ID
    expect(receivedSessionIds.length).toBe(3);
    for (const id of receivedSessionIds) {
      expect(id).toBe(parentSessionId);
    }

    handler.stop();
  });

  test("[跨-chat 隔离] 不同 triggerSessionId 的第二批解析到自己的父 session（不再被优 1 劫持）", async () => {
    const parentSession1 = "parent-batch-1";
    const parentSession2 = "parent-batch-2";
    const receivedSessionIds: (string | undefined)[] = [];

    const onEventWithEnv = vi.fn().mockImplementation(async (fe: FormattedEvent) => {
      receivedSessionIds.push(fe.eventSessionId);
    });

    const sessionComponentWithGet = {
      create: vi.fn().mockImplementation(async () => {
        return { id: "new-should-not-be-used", title: "new" };
      }),
      get: vi.fn().mockImplementation(async (id: string) => {
        if (id === parentSession1) return { id: parentSession1, title: "P1" };
        if (id === parentSession2) return { id: parentSession2, title: "P2" };
        return undefined;
      }),
      // Task #1766: 新增
      getActiveSessionId: vi.fn().mockReturnValue(undefined),
      setActiveSession: vi.fn().mockResolvedValue(true),
    };

    const handler = new EventHandler(createOptions({
      sessionComponent: sessionComponentWithGet as any,
      onEventWithEnv,
    }));

    // 第一批：triggerSessionId = parentSession1
    const event1 = createMockEnvEventWithTriggerSessionId(
      "event-source.event.batch1-1",
      parentSession1,
    );
    handler.enqueue(new EventMessageFormatter().formatWithEvent(event1 as any));

    // 等待第一批完成
    await waitFor(() => onEventWithEnv.mock.calls.length >= 1, 2000);
    await waitFor(() => handler.isQueueEmpty() && !(handler as any).isProcessing, 2000);

    // 验证第一批的 session ID
    expect(receivedSessionIds[0]).toBe(parentSession1);
    expect(sessionComponentWithGet.get).toHaveBeenCalledTimes(1);
    expect(sessionComponentWithGet.create).not.toHaveBeenCalled();

    // 第二批：triggerSessionId = parentSession2
    // ★ Bug fix (#4038/#4035 跨 chat 污染)：第二批带不同的 triggerSessionId 时，
    //   不能命中优 1 复用 parentSession1，必须按自己的 triggerSessionId 解析到
    //   parentSession2（否则 #3996 的通知会被塞进 #3993 的会话）。
    const event2 = createMockEnvEventWithTriggerSessionId(
      "event-source.event.batch2-1",
      parentSession2,
    );
    handler.enqueue(new EventMessageFormatter().formatWithEvent(event2 as any));

    // 等待第二批完成
    await waitFor(() => onEventWithEnv.mock.calls.length >= 2, 2000);
    await waitFor(() => handler.isQueueEmpty() && !(handler as any).isProcessing, 2000);

    // 修复后：第二批解析到自己的父 session（parentSession2）
    expect(receivedSessionIds[1]).toBe(parentSession2);
    expect(receivedSessionIds[0]).not.toBe(receivedSessionIds[1]);

    // 验证：get 被调用 2 次（两批各自按 triggerSessionId 解析）
    expect(sessionComponentWithGet.get).toHaveBeenCalledTimes(2);

    // 验证：create 始终未被调用
    expect(sessionComponentWithGet.create).not.toHaveBeenCalled();

    handler.stop();
  });

  test("[跨-chat 隔离] 同一 triggerSessionId 跨批次复用同一 session；父 session 缺失时只 create 一次（P0-1 回归）", async () => {
    const trigger = "parent-missing-1";
    const receivedSessionIds: (string | undefined)[] = [];
    const onEventWithEnv = vi.fn().mockImplementation(async (fe: FormattedEvent) => {
      receivedSessionIds.push(fe.eventSessionId);
    });

    const sessionComponent = {
      create: vi.fn().mockImplementation(async (opts: any) => ({
        id: opts?.id ?? "created-uuid-1",
        title: opts?.title ?? "Event Session",
      })),
      // 父 session 永远找不到 → 走优 4 create
      get: vi.fn().mockResolvedValue(undefined),
      getActiveSessionId: vi.fn().mockReturnValue(undefined),
      setActiveSession: vi.fn().mockResolvedValue(true),
    };

    const handler = new EventHandler(createOptions({
      sessionComponent: sessionComponent as any,
      onEventWithEnv,
    }));

    // 两批事件，triggerSessionId 相同
    for (let i = 0; i < 2; i++) {
      handler.enqueue(new EventMessageFormatter().formatWithEvent(
        createMockEnvEventWithTriggerSessionId(`task.background.progress`, trigger) as any,
      ));
      await waitFor(() => onEventWithEnv.mock.calls.length >= i + 1, 2000);
      await waitFor(() => handler.isQueueEmpty() && !(handler as any).isProcessing, 2000);
    }

    // 两批复用同一（create 出来的）session，而不是每批都 create 新 session
    expect(receivedSessionIds[0]).toBe(receivedSessionIds[1]);
    expect(sessionComponent.create).toHaveBeenCalledTimes(1);

    handler.stop();
  });
});

// ============================================================================
// 测试: Chat-Keyed Session（飞书 chat_id 作为 session 隔离键）
// ============================================================================
// 用途：跟飞书 robot 私聊会触发任务创建, 每个任务会建独立飞书群聊,
//       在对应群聊里聊天时 EventHandler 会找到/创建该群聊对应的 session,
//       让推进任务对话和 bot 私聊互不干扰（不同群聊 → 不同 session）。
//
// 优先级（新增优 2, 在 triggerSessionId 之前）：
// - queue 中第一个有 chatId 的事件 → ensureChatSession(chatId)
//   - 找到已有 session（list filter by metadata.chatId + type='lark-chat'）→ 复用
//   - 没找到 → create({ id: chatId, metadata: { chatId, type: 'lark-chat' } })
// - 找/建失败 → fallback 到优 3 (triggerSessionId)
// - 关键：chat-keyed session 不调 setActiveSession（避免污染 REPL global active）
// ============================================================================

/**
 * 创建一个带 chatId 的 mock EnvEvent（飞书事件）
 */
function createMockEnvEventWithChatId(
  type: string,
  chatId: string | undefined,
  triggerSessionId?: string,
): MockEnvEvent {
  return {
    type,
    payload: { message: `test event ${Date.now()}` },
    metadata: {
      sourceId: "test-source",
      replyChannel: chatId
        ? { type: "lark-cli", chatId, messageId: "om_test" }
        : undefined,
      trigger_session_id: triggerSessionId,
    },
  };
}

describe("EventHandler - Chat-Keyed Session (飞书 chat_id → session 隔离)", () => {
  test("[CHAT 1] 新 chat_id 第一次出现 → list 返回空 → create({ id: chatId, metadata: { chatId, type: 'lark-chat' } })", async () => {
    const onEventWithEnv = vi.fn().mockResolvedValue(undefined);
    const chatId = "oc_chat_first_meet";

    // list 返回空 → 触发 create
    const sessionComponent = {
      create: vi.fn().mockImplementation(async (opts: any) => {
        return { id: opts?.id ?? "auto-generated", title: opts?.title ?? "Lark Chat" };
      }),
      get: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]), // 没找到已有 session
      getActiveSessionId: vi.fn().mockReturnValue(undefined),
      setActiveSession: vi.fn().mockResolvedValue(true),
    };

    const handler = new EventHandler(createOptions({
      sessionComponent: sessionComponent as any,
      onEventWithEnv,
    }));

    const event = createMockEnvEventWithChatId("event-source.event.lark-cli", chatId);
    handler.enqueue(new EventMessageFormatter().formatWithEvent(event as any));

    await waitFor(() => onEventWithEnv.mock.calls.length > 0, 2000);

    // 验证：list 被调用，过滤 metadata.chatId + type='lark-chat'
    expect(sessionComponent.list).toHaveBeenCalledTimes(1);
    expect(sessionComponent.list).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: expect.objectContaining({
          metadata: expect.objectContaining({
            chatId,
            type: "lark-chat",
          }),
        }),
      }),
    );

    // 验证：create 被调用，id = chatId
    expect(sessionComponent.create).toHaveBeenCalledTimes(1);
    expect(sessionComponent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: chatId,
        metadata: expect.objectContaining({
          chatId,
          type: "lark-chat",
        }),
      }),
    );

    // 验证：eventSessionId === chatId（session id 直接用 chat_id）
    const calledWith: FormattedEvent = onEventWithEnv.mock.calls[0][0];
    expect(calledWith.eventSessionId).toBe(chatId);

    // ★ 关键：chat-keyed session 不应调 setActiveSession（避免污染 REPL）
    expect(sessionComponent.setActiveSession).not.toHaveBeenCalled();

    handler.stop();
  });

  test("[CHAT 2] 已存在 chat-keyed session → list 命中 → 直接复用, 不调 create", async () => {
    const onEventWithEnv = vi.fn().mockResolvedValue(undefined);
    const chatId = "oc_chat_existing";
    const existingSessionId = chatId; // 用 chatId 作为 session id

    // list 返回已有 session
    const sessionComponent = {
      create: vi.fn().mockImplementation(async () => {
        throw new Error("should not be called when existing session found");
      }),
      get: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([
        { id: existingSessionId, title: "Lark Chat oc_chat_existing" },
      ]),
      getActiveSessionId: vi.fn().mockReturnValue(undefined),
      setActiveSession: vi.fn().mockResolvedValue(true),
    };

    const handler = new EventHandler(createOptions({
      sessionComponent: sessionComponent as any,
      onEventWithEnv,
    }));

    const event = createMockEnvEventWithChatId("event-source.event.lark-cli", chatId);
    handler.enqueue(new EventMessageFormatter().formatWithEvent(event as any));

    await waitFor(() => onEventWithEnv.mock.calls.length > 0, 2000);

    // 验证：list 被调用（查 chat-keyed session）
    expect(sessionComponent.list).toHaveBeenCalledTimes(1);

    // 验证：create 未被调用（复用已有 session）
    expect(sessionComponent.create).not.toHaveBeenCalled();

    // 验证：eventSessionId === existingSessionId
    const calledWith: FormattedEvent = onEventWithEnv.mock.calls[0][0];
    expect(calledWith.eventSessionId).toBe(existingSessionId);

    // ★ 验证：get() / setActiveSession 未被调用（chat-keyed 路径不触发）
    expect(sessionComponent.get).not.toHaveBeenCalled();
    expect(sessionComponent.setActiveSession).not.toHaveBeenCalled();

    handler.stop();
  });

  test("[CHAT 3] 不同 chat_id 在不同批次 → 不同 session（核心隔离语义）", async () => {
    const onEventWithEnv = vi.fn().mockResolvedValue(undefined);
    const chatA = "oc_group_alpha";
    const chatB = "oc_group_beta";
    const receivedSessionIds: (string | undefined)[] = [];

    // 为不同 chatId 返回不同 session（list 用 chatId 区分）
    const sessionComponent = {
      create: vi.fn().mockImplementation(async (opts: any) => {
        return { id: opts?.id ?? `gen-${Math.random()}`, title: opts?.title ?? "Lark Chat" };
      }),
      get: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockImplementation(async (options: any) => {
        const filterChatId = options?.filter?.metadata?.chatId;
        if (filterChatId) {
          return [{ id: filterChatId, title: `Lark Chat ${filterChatId}` }];
        }
        return [];
      }),
      getActiveSessionId: vi.fn().mockReturnValue(undefined),
      setActiveSession: vi.fn().mockResolvedValue(true),
    };

    onEventWithEnv.mockImplementation(async (fe: FormattedEvent) => {
      receivedSessionIds.push(fe.eventSessionId);
    });

    const handler = new EventHandler(createOptions({
      sessionComponent: sessionComponent as any,
      onEventWithEnv,
    }));

    // 第一批：chatA
    handler.enqueue(new EventMessageFormatter().formatWithEvent(
      createMockEnvEventWithChatId("event-source.event.lark-cli", chatA) as any,
    ));

    await waitFor(() => onEventWithEnv.mock.calls.length >= 1, 2000);
    await waitFor(() => handler.isQueueEmpty() && !(handler as any).isProcessing, 2000);

    // 验证第一批
    expect(receivedSessionIds[0]).toBe(chatA);

    // 第二批：chatB
    handler.enqueue(new EventMessageFormatter().formatWithEvent(
      createMockEnvEventWithChatId("event-source.event.lark-cli", chatB) as any,
    ));

    await waitFor(() => onEventWithEnv.mock.calls.length >= 2, 2000);
    await waitFor(() => handler.isQueueEmpty() && !(handler as any).isProcessing, 2000);

    // ★ 核心验证：第二批应使用 chatB 对应的 session（不同 chat → 不同 session）
    expect(receivedSessionIds[1]).toBe(chatB);
    expect(receivedSessionIds[0]).not.toBe(receivedSessionIds[1]);
    expect(receivedSessionIds[0]).toBe(chatA);
    expect(receivedSessionIds[1]).toBe(chatB);

    // ★ 验证：chat-keyed session 不污染 REPL global active
    expect(sessionComponent.setActiveSession).not.toHaveBeenCalled();

    handler.stop();
  });

  test("[CHAT 3b] task.background.* notify event 自带 metadata.replyChannel → 各回各 chat session（#4038/#4035 e2e）", async () => {
    const onEventWithEnv = vi.fn().mockResolvedValue(undefined);
    const chatA = "oc_3996";
    const chatB = "oc_3993";
    const receivedSessionIds: (string | undefined)[] = [];

    const sessionComponent = {
      create: vi.fn().mockImplementation(async (opts: any) => {
        return { id: opts?.id ?? `gen-${Math.random()}`, title: opts?.title ?? "Lark Chat" };
      }),
      get: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockImplementation(async (options: any) => {
        const filterChatId = options?.filter?.metadata?.chatId;
        return filterChatId ? [{ id: filterChatId, title: `Lark Chat ${filterChatId}` }] : [];
      }),
      getActiveSessionId: vi.fn().mockReturnValue(undefined),
      setActiveSession: vi.fn().mockResolvedValue(true),
    };
    onEventWithEnv.mockImplementation(async (fe: FormattedEvent) => {
      receivedSessionIds.push(fe.eventSessionId);
    });

    const handler = new EventHandler(createOptions({
      sessionComponent: sessionComponent as any,
      onEventWithEnv,
    }));

    // task.background.completed 带 metadata.replyChannel（本修复后 BackgroundTaskManager 会写）
    handler.enqueue(new EventMessageFormatter().formatWithEvent(
      createMockEnvEventWithChatId("task.background.completed", chatA) as any,
    ));
    await waitFor(() => onEventWithEnv.mock.calls.length >= 1, 2000);
    await waitFor(() => handler.isQueueEmpty() && !(handler as any).isProcessing, 2000);
    expect(receivedSessionIds[0]).toBe(chatA);

    // 第二个 task 的通知（不同 chat）不能被第一个 chat 的 session 劫持
    handler.enqueue(new EventMessageFormatter().formatWithEvent(
      createMockEnvEventWithChatId("task.background.completed", chatB) as any,
    ));
    await waitFor(() => onEventWithEnv.mock.calls.length >= 2, 2000);
    await waitFor(() => handler.isQueueEmpty() && !(handler as any).isProcessing, 2000);
    expect(receivedSessionIds[1]).toBe(chatB);
    expect(receivedSessionIds[0]).not.toBe(receivedSessionIds[1]);

    handler.stop();
  });

  test("[CHAT 4] 优 2 (chatId) 优先于优 3 (triggerSessionId): 同时有 chatId + triggerSessionId → 用 chatId", async () => {
    const onEventWithEnv = vi.fn().mockResolvedValue(undefined);
    const chatId = "oc_chat_with_parent";
    const parentSessionId = "parent-session-ignored";

    const sessionComponent = {
      create: vi.fn().mockImplementation(async (opts: any) => {
        return { id: opts?.id ?? "auto", title: opts?.title ?? "Lark Chat" };
      }),
      get: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]), // chat-keyed 没找到
      getActiveSessionId: vi.fn().mockReturnValue(undefined),
      setActiveSession: vi.fn().mockResolvedValue(true),
    };

    const handler = new EventHandler(createOptions({
      sessionComponent: sessionComponent as any,
      onEventWithEnv,
    }));

    // 同时传 chatId + triggerSessionId
    const event = createMockEnvEventWithChatId(
      "event-source.event.lark-cli",
      chatId,
      parentSessionId,
    );
    handler.enqueue(new EventMessageFormatter().formatWithEvent(event as any));

    await waitFor(() => onEventWithEnv.mock.calls.length > 0, 2000);

    // 验证：chat-keyed 路径被走（list 被调，create 用 chatId）
    expect(sessionComponent.list).toHaveBeenCalledTimes(1);
    expect(sessionComponent.create).toHaveBeenCalledTimes(1);

    // 验证：triggerSessionId 路径未被走（get 未被调）
    expect(sessionComponent.get).not.toHaveBeenCalled();

    // 验证：eventSessionId === chatId（不是 parentSessionId）
    const calledWith: FormattedEvent = onEventWithEnv.mock.calls[0][0];
    expect(calledWith.eventSessionId).toBe(chatId);
    expect(calledWith.eventSessionId).not.toBe(parentSessionId);

    handler.stop();
  });

  test("[CHAT 5] create 失败（id 冲突）→ get(chatId) fallback → 复用已有 session", async () => {
    const onEventWithEnv = vi.fn().mockResolvedValue(undefined);
    const chatId = "oc_chat_id_conflict";

    const sessionComponent = {
      create: vi.fn().mockRejectedValue(new Error("UNIQUE constraint failed: session.id")),
      get: vi.fn().mockImplementation(async (id: string) => {
        if (id === chatId) {
          return { id: chatId, title: "Recovered from get()" };
        }
        return undefined;
      }),
      list: vi.fn().mockResolvedValue([]), // 模拟 list 找不到（已发生的事）
      getActiveSessionId: vi.fn().mockReturnValue(undefined),
      setActiveSession: vi.fn().mockResolvedValue(true),
    };

    const handler = new EventHandler(createOptions({
      sessionComponent: sessionComponent as any,
      onEventWithEnv,
    }));

    const event = createMockEnvEventWithChatId("event-source.event.lark-cli", chatId);
    handler.enqueue(new EventMessageFormatter().formatWithEvent(event as any));

    await waitFor(() => onEventWithEnv.mock.calls.length > 0, 2000);

    // 验证：list → create (失败) → get(chatId) 都按顺序触发
    expect(sessionComponent.list).toHaveBeenCalledTimes(1);
    expect(sessionComponent.create).toHaveBeenCalledTimes(1);
    expect(sessionComponent.get).toHaveBeenCalledTimes(1);
    expect(sessionComponent.get).toHaveBeenCalledWith(chatId);

    // 验证：eventSessionId === chatId（get fallback 成功）
    const calledWith: FormattedEvent = onEventWithEnv.mock.calls[0][0];
    expect(calledWith.eventSessionId).toBe(chatId);

    handler.stop();
  });

  test("[CHAT 6] chat-keyed session 创建/查找都失败 → fallback 到优 3 (triggerSessionId)", async () => {
    const onEventWithEnv = vi.fn().mockResolvedValue(undefined);
    const chatId = "oc_chat_fail_path";
    const parentSessionId = "parent-session-fallback";

    const sessionComponent = {
      create: vi.fn().mockRejectedValue(new Error("chat session create failed")),
      get: vi.fn().mockImplementation(async (id: string) => {
        if (id === parentSessionId) {
          return { id: parentSessionId, title: "Parent Fallback" };
        }
        return undefined;
      }),
      list: vi.fn().mockResolvedValue([]), // 模拟 chat-keyed 路径全部失败
      getActiveSessionId: vi.fn().mockReturnValue(undefined),
      setActiveSession: vi.fn().mockResolvedValue(true),
    };

    const handler = new EventHandler(createOptions({
      sessionComponent: sessionComponent as any,
      onEventWithEnv,
    }));

    const event = createMockEnvEventWithChatId(
      "event-source.event.lark-cli",
      chatId,
      parentSessionId,
    );
    handler.enqueue(new EventMessageFormatter().formatWithEvent(event as any));

    await waitFor(() => onEventWithEnv.mock.calls.length > 0, 2000);

    // 验证：chat-keyed 路径被尝试（list → create failed → get(chatId) failed）
    expect(sessionComponent.list).toHaveBeenCalledTimes(1);
    expect(sessionComponent.create).toHaveBeenCalledTimes(1);

    // 验证：fallback 到 triggerSessionId 路径（get 被调）
    expect(sessionComponent.get).toHaveBeenCalledWith(parentSessionId);

    // 验证：最终用 parentSessionId（fallback 成功）
    const calledWith: FormattedEvent = onEventWithEnv.mock.calls[0][0];
    expect(calledWith.eventSessionId).toBe(parentSessionId);

    handler.stop();
  });

  test("[CHAT 7] 同一 chat_id 同一批多事件 → 共享同一个 session (list 只查一次, create 只调一次)", async () => {
    const onEventWithEnv = vi.fn().mockResolvedValue(undefined);
    const chatId = "oc_chat_burst";
    const receivedSessionIds: (string | undefined)[] = [];

    onEventWithEnv.mockImplementation(async (fe: FormattedEvent) => {
      receivedSessionIds.push(fe.eventSessionId);
    });

    const sessionComponent = {
      create: vi.fn().mockImplementation(async (opts: any) => {
        return { id: opts?.id ?? "auto", title: opts?.title ?? "Lark Chat" };
      }),
      get: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      getActiveSessionId: vi.fn().mockReturnValue(undefined),
      setActiveSession: vi.fn().mockResolvedValue(true),
    };

    const handler = new EventHandler(createOptions({
      sessionComponent: sessionComponent as any,
      onEventWithEnv,
      eventTypes: ["event-source.event.*"],
    }));

    // 入队 3 个相同 chatId 的事件
    for (let i = 0; i < 3; i++) {
      const event = createMockEnvEventWithChatId(`event-source.event.burst-${i}`, chatId);
      handler.enqueue(new EventMessageFormatter().formatWithEvent(event as any));
    }

    await waitFor(() => onEventWithEnv.mock.calls.length >= 3, 2000);
    await waitFor(() => handler.isQueueEmpty() && !(handler as any).isProcessing, 2000);

    // 验证：3 个事件都用同一个 session
    expect(receivedSessionIds.length).toBe(3);
    for (const id of receivedSessionIds) {
      expect(id).toBe(chatId);
    }

    // 验证：list 只被调一次（优 1 短路，第二/三个事件直接复用）
    expect(sessionComponent.list).toHaveBeenCalledTimes(1);
    // create 也只调一次
    expect(sessionComponent.create).toHaveBeenCalledTimes(1);

    handler.stop();
  });
});

describe("EventHandler - Cross-Chat Session Isolation (Bug Fix: 优 3/4/5 设置的 activeEventSessionId 不能污染飞书新 batch)", () => {
  /**
   * Bug 场景（重现自 trace session_fd5f0f1f-e524-40bb-93a3-a2198205089e）:
   * 1. 第一个 batch: 非 lark 事件 (无 chatId, 有 triggerSessionId)
   *    → 优 3 命中: activeEventSessionId = X, 但 activeEventSessionChatId 保持 null
   * 2. 第二个 batch: lark 事件 from chatA (有 chatId)
   *    → 旧代码: 优 1 直接 return X (chat-switch 检测不全, 因为 activeEventSessionChatId === null)
   *    → 修复后: 优 1 检测到 needsChatKeyed 但 active 非 chat-keyed, 清空 → 优 2 建 chatA 的 session
   * 3. 第三个 batch: lark 事件 from chatB (有 chatId, 不同 chat)
   *    → 优 1: active 是 chatA-keyed, 与 chatB 不同 → 清空 → 优 2 建 chatB 的 session
   *
   * 预期: 每个 chat 都有自己的 session, 不会出现"两个 chat 共享一个非 chat-keyed session"
   */

  // 用例 1: triggerSessionId 在前 → 飞书 chatId 在后（不同 chat），不能污染
  test("[CROSS-CHAT 1] triggerSessionId batch → lark chatA batch → lark chatB batch: chatA/chatB 各自独立 session, 不会被 trigger session 污染", async () => {
    const onEventWithEnv = vi.fn().mockResolvedValue(undefined);
    const chatA = "oc_chat_A_isolation_test";
    const chatB = "oc_chat_B_isolation_test";
    const triggerSessionId = "session_trigger_parent";

    // Mock: 飞书 chat session 通过 list+create 路径建
    //     + trigger session 通过 get 路径复用
    const sessionComponent = {
      create: vi.fn().mockImplementation(async (opts: any) => {
        // chat-keyed create: id = chatId
        if (opts?.id === chatA) return { id: chatA, title: "Lark Chat A" };
        if (opts?.id === chatB) return { id: chatB, title: "Lark Chat B" };
        return { id: opts?.id ?? `auto-${Date.now()}`, title: opts?.title ?? "auto" };
      }),
      get: vi.fn().mockImplementation(async (id: string) => {
        if (id === triggerSessionId) return { id: triggerSessionId, title: "Parent Trigger" };
        return undefined;
      }),
      list: vi.fn().mockResolvedValue([]), // 每次都查不到
      getActiveSessionId: vi.fn().mockReturnValue(undefined),
      setActiveSession: vi.fn().mockResolvedValue(true),
    };

    const handler = new EventHandler(createOptions({
      sessionComponent: sessionComponent as any,
      onEventWithEnv,
    }));

    const receivedSessionIds: (string | undefined)[] = [];
    onEventWithEnv.mockImplementation(async (fe: FormattedEvent) => {
      receivedSessionIds.push(fe.eventSessionId);
    });

    // 第一批: 非 lark 事件, triggerSessionId (无 chatId)
    const triggerEvent = createMockEnvEventWithTriggerSessionId(
      "task.background.completed",
      triggerSessionId,
    );
    handler.enqueue(new EventMessageFormatter().formatWithEvent(triggerEvent as any));

    // 等待第一批处理完, 确保 activeEventSessionId = triggerSessionId
    await waitFor(() => onEventWithEnv.mock.calls.length >= 1, 2000);
    await waitFor(() => handler.isQueueEmpty() && !(handler as any).isProcessing, 2000);

    // 第二批: lark chatA
    const chatAEvent = createMockEnvEventWithChatId(
      "event-source.event.lark-cli",
      chatA,
    );
    handler.enqueue(new EventMessageFormatter().formatWithEvent(chatAEvent as any));

    // 等待第二批处理完, 确保 activeEventSessionId = chatA
    await waitFor(() => onEventWithEnv.mock.calls.length >= 2, 2000);
    await waitFor(() => handler.isQueueEmpty() && !(handler as any).isProcessing, 2000);

    // 第三批: lark chatB
    const chatBEvent = createMockEnvEventWithChatId(
      "event-source.event.lark-cli",
      chatB,
    );
    handler.enqueue(new EventMessageFormatter().formatWithEvent(chatBEvent as any));

    await waitFor(() => onEventWithEnv.mock.calls.length >= 3, 2000);
    await waitFor(() => handler.isQueueEmpty() && !(handler as any).isProcessing, 2000);

    // 验证: 3 个事件每个都用自己合适的 session
    expect(receivedSessionIds.length).toBe(3);
    expect(receivedSessionIds[0]).toBe(triggerSessionId); // 第一批: trigger session
    expect(receivedSessionIds[1]).toBe(chatA);             // 第二批: chatA-keyed
    expect(receivedSessionIds[2]).toBe(chatB);             // 第三批: chatB-keyed

    // 验证: 没有飞 book 的对话被路由到 triggerSessionId
    expect(receivedSessionIds[1]).not.toBe(triggerSessionId);
    expect(receivedSessionIds[2]).not.toBe(triggerSessionId);
    // 验证: chatA 和 chatB 的 session 互不相同
    expect(receivedSessionIds[1]).not.toBe(receivedSessionIds[2]);

    // 验证: chatA 和 chatB 都触发了 chat-keyed list+create 路径
    // (因为第一个 trigger session 把 activeEventSessionId 设了非 chat-keyed 的,
    //  第二/三批必须走优 2 (list+create) 才能拿到正确的 chat-keyed session)
    expect(sessionComponent.list).toHaveBeenCalledTimes(2); // chatA 一次, chatB 一次
    expect(sessionComponent.create).toHaveBeenCalledTimes(2);

    handler.stop();
  });

  // 用例 2: global active session 在前 → 飞书 chatId 在后, 不能污染
  test("[CROSS-CHAT 2] global active session batch → lark chatId batch: 飞书 chat 不能被路由到 global active", async () => {
    const onEventWithEnv = vi.fn().mockResolvedValue(undefined);
    const globalActiveId = "session_global_active_repl";
    const chatId = "oc_chat_global_active_isolation";

    const sessionComponent = createMockSessionComponentWithGlobalActive(
      globalActiveId,
      { id: globalActiveId, title: "Global Active REPL" },
      {},
    );
    // 加 list 用于 chat-keyed 路径
    (sessionComponent as any).list = vi.fn().mockResolvedValue([]);
    // 让 create 用 chatId 作为 id
    (sessionComponent as any).create = vi.fn().mockImplementation(async (opts: any) => {
      if (opts?.id === chatId) return { id: chatId, title: "Lark Chat" };
      return { id: opts?.id ?? `auto-${Date.now()}`, title: opts?.title ?? "auto" };
    });

    const handler = new EventHandler(createOptions({
      sessionComponent: sessionComponent as any,
      onEventWithEnv,
    }));

    const receivedSessionIds: (string | undefined)[] = [];
    onEventWithEnv.mockImplementation(async (fe: FormattedEvent) => {
      receivedSessionIds.push(fe.eventSessionId);
    });

    // 第一批: 非 lark 事件, 没有 triggerSessionId, 落到优 4 (global active)
    const nonLarkEvent = createMockEnvEvent("event-source.event.bounty");
    handler.enqueue(new EventMessageFormatter().formatWithEvent(nonLarkEvent as any));

    await waitFor(() => onEventWithEnv.mock.calls.length >= 1, 2000);
    await waitFor(() => handler.isQueueEmpty() && !(handler as any).isProcessing, 2000);

    // 第二批: lark 事件 from chatId
    const chatEvent = createMockEnvEventWithChatId(
      "event-source.event.lark-cli",
      chatId,
    );
    handler.enqueue(new EventMessageFormatter().formatWithEvent(chatEvent as any));

    await waitFor(() => onEventWithEnv.mock.calls.length >= 2, 2000);
    await waitFor(() => handler.isQueueEmpty() && !(handler as any).isProcessing, 2000);

    // 验证: 第一批用 globalActiveId (优 4)
    expect(receivedSessionIds[0]).toBe(globalActiveId);
    // 验证: 第二批必须用 chatId-keyed session (不能复用 global active)
    expect(receivedSessionIds[1]).toBe(chatId);
    expect(receivedSessionIds[1]).not.toBe(globalActiveId);

    handler.stop();
  });

  // 用例 3: 同一个 chat 连续两批 → 复用 chat-keyed session (回归保护)
  test("[CROSS-CHAT 3] 同一 chat 跨批次 → 仍是同一个 chat-keyed session (ensureChatSession 幂等)", async () => {
    const onEventWithEnv = vi.fn().mockResolvedValue(undefined);
    const chatId = "oc_chat_same_chat_reuse";
    let createCount = 0;

    const sessionComponent = {
      create: vi.fn().mockImplementation(async (opts: any) => {
        createCount++;
        if (opts?.id === chatId) return { id: chatId, title: "Lark Chat" };
        return { id: opts?.id ?? `auto-${Date.now()}` };
      }),
      get: vi.fn().mockResolvedValue(undefined),
      // 第一批返回空 (触发 create), 之后返回已有 session (find, 不 create)
      list: vi.fn().mockImplementation(async () => {
        if (createCount === 0) return [];
        return [{ id: chatId, title: "Lark Chat" }];
      }),
      getActiveSessionId: vi.fn().mockReturnValue(undefined),
      setActiveSession: vi.fn().mockResolvedValue(true),
    };

    const handler = new EventHandler(createOptions({
      sessionComponent: sessionComponent as any,
      onEventWithEnv,
    }));

    const receivedSessionIds: (string | undefined)[] = [];
    onEventWithEnv.mockImplementation(async (fe: FormattedEvent) => {
      receivedSessionIds.push(fe.eventSessionId);
    });

    // 第一批
    handler.enqueue(new EventMessageFormatter().formatWithEvent(
      createMockEnvEventWithChatId("event-source.event.lark-cli", chatId) as any,
    ));
    await waitFor(() => onEventWithEnv.mock.calls.length >= 1, 2000);
    await waitFor(() => handler.isQueueEmpty() && !(handler as any).isProcessing, 2000);

    // 第二批 (同一 chat)
    handler.enqueue(new EventMessageFormatter().formatWithEvent(
      createMockEnvEventWithChatId("event-source.event.lark-cli", chatId) as any,
    ));
    await waitFor(() => onEventWithEnv.mock.calls.length >= 2, 2000);
    await waitFor(() => handler.isQueueEmpty() && !(handler as any).isProcessing, 2000);

    // 验证: 两次都是 chatId-keyed session (ensureChatSession 幂等, 不论是否走缓存)
    expect(receivedSessionIds[0]).toBe(chatId);
    expect(receivedSessionIds[1]).toBe(chatId);

    // 验证: 只 create 了一次 (第一批), 第二批 list 找到已有 session
    expect(sessionComponent.create).toHaveBeenCalledTimes(1);

    handler.stop();
  });
});

describe("EventMessageFormatter - extractChatId", () => {
  test("extractChatId: 从 event.metadata.replyChannel.chatId 提取", () => {
    const event = {
      id: "evt-1",
      type: "event-source.event.lark-cli",
      metadata: {
        replyChannel: { type: "lark-cli", chatId: "oc_metadata_path" },
      },
    } as any;
    expect(extractChatId(event)).toBe("oc_metadata_path");
  });

  test("extractChatId: 从 event.payload.replyChannel.chatId 提取（fallback）", () => {
    const event = {
      id: "evt-1",
      type: "event-source.event.lark-cli",
      metadata: {},
      payload: {
        replyChannel: { type: "lark-cli", chatId: "oc_payload_path" },
      },
    } as any;
    expect(extractChatId(event)).toBe("oc_payload_path");
  });

  test("extractChatId: metadata 路径优先于 payload 路径", () => {
    const event = {
      id: "evt-1",
      type: "event-source.event.lark-cli",
      metadata: {
        replyChannel: { type: "lark-cli", chatId: "oc_meta_wins" },
      },
      payload: {
        replyChannel: { type: "lark-cli", chatId: "oc_payload_loses" },
      },
    } as any;
    expect(extractChatId(event)).toBe("oc_meta_wins");
  });

  test("extractChatId: replyChannel 不存在 → undefined", () => {
    const event = {
      id: "evt-1",
      type: "event-source.event.test",
      metadata: {},
      payload: {},
    } as any;
    expect(extractChatId(event)).toBeUndefined();
  });

  test("extractChatId: chatId 是空字符串 → undefined", () => {
    const event = {
      id: "evt-1",
      type: "event-source.event.test",
      metadata: { replyChannel: { type: "lark-cli", chatId: "" } },
      payload: {},
    } as any;
    expect(extractChatId(event)).toBeUndefined();
  });

  test("formatWithEvent 应该把 chatId 写入 FormattedEvent", () => {
    const event = {
      id: "evt-1",
      type: "event-source.event.lark-cli",
      metadata: {
        replyChannel: { type: "lark-cli", chatId: "oc_test_chat" },
      },
    } as any;
    const formatted = new EventMessageFormatter().formatWithEvent(event);
    expect(formatted.chatId).toBe("oc_test_chat");
  });
});
