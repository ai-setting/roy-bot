/**
 * Timer EventSource Handler 测试套件
 *
 * 覆盖：
 * 1. TimerHandler 单元测试（type、validateConfig、createInstance）
 * 2. TimerInstance 生命周期测试（start/stop/getStatus）
 * 3. 定时触发事件测试（fake timers）
 * 4. Rule-based 检查测试（mock BackgroundTaskManager）
 * 5. SelfReminder 事件格式测试
 * 6. SessionId 一致性测试
 * 7. 集成测试
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "bun:test";
import type {
  EventSourceConfig,
  EventSourceEvent,
} from "./types";
import { timerHandler, TimerInstance } from "./timer-handler";
import type { BackgroundTask } from "../task/delegate/delegate-tool";

// =============================================================================
// Helper: 创建默认 timer 配置
// =============================================================================

function createTimerConfig(overrides: Partial<EventSourceConfig> = {}): EventSourceConfig {
  return {
    id: "timer-1",
    name: "Test Timer",
    type: "timer",
    enabled: true,
    interval: 600_000, // 10 minutes
    ...overrides,
  };
}

// =============================================================================
// 1. TimerHandler 单元测试
// =============================================================================

describe("TimerHandler", () => {
  test("type 应该是 'timer'", () => {
    expect(timerHandler.type).toBe("timer");
  });

  test("validateConfig 应该接受有效的 interval 配置", () => {
    const errors = timerHandler.validateConfig(createTimerConfig({ interval: 600_000 }));
    expect(errors).toEqual([]);
  });

  test("validateConfig 应该接受最小合法 interval", () => {
    const errors = timerHandler.validateConfig(createTimerConfig({ interval: 1 }));
    expect(errors).toEqual([]);
  });

  test("validateConfig 应该拒绝 interval <= 0", () => {
    const errors = timerHandler.validateConfig(createTimerConfig({ interval: 0 }));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /interval/i.test(e))).toBe(true);
  });

  test("validateConfig 应该拒绝负数 interval", () => {
    const errors = timerHandler.validateConfig(createTimerConfig({ interval: -100 }));
    expect(errors.length).toBeGreaterThan(0);
  });

  test("validateConfig 应该拒绝非数字 interval", () => {
    const errors = timerHandler.validateConfig(
      createTimerConfig({ interval: "abc" as unknown as number }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  test("validateConfig 应该在 interval 缺失时使用默认值（不报错）", () => {
    const errors = timerHandler.validateConfig(createTimerConfig({ interval: undefined }));
    expect(errors).toEqual([]);
  });

  test("createInstance 应该返回 TimerInstance", () => {
    const instance = timerHandler.createInstance(createTimerConfig());
    expect(instance).toBeDefined();
    expect(typeof instance.start).toBe("function");
    expect(typeof instance.stop).toBe("function");
    expect(typeof instance.getStatus).toBe("function");
    expect(typeof instance.onEvent).toBe("function");
    expect(typeof instance.offEvent).toBe("function");
  });

  test("createInstance 应该创建 TimerInstance 实例", () => {
    const instance = timerHandler.createInstance(createTimerConfig());
    expect(instance).toBeInstanceOf(TimerInstance);
  });
});

// =============================================================================
// 2. TimerInstance 生命周期测试
// =============================================================================

describe("TimerInstance lifecycle", () => {
  let instance: TimerInstance;

  beforeEach(() => {
    instance = new TimerInstance(createTimerConfig({ interval: 1000 }));
  });

  afterEach(async () => {
    if (instance.getStatus() === "running") {
      await instance.stop();
    }
  });

  test("初始状态应该是 'created'", () => {
    expect(instance.getStatus()).toBe("created");
  });

  test("start 后状态应该是 'running'", async () => {
    await instance.start();
    expect(instance.getStatus()).toBe("running");
  });

  test("stop 后状态应该是 'stopped'", async () => {
    await instance.start();
    await instance.stop();
    expect(instance.getStatus()).toBe("stopped");
  });

  test("重复 start 应该是幂等的", async () => {
    await instance.start();
    await instance.start();
    expect(instance.getStatus()).toBe("running");
  });

  test("未启动时 stop 应该安全", async () => {
    await instance.stop();
    expect(instance.getStatus()).toBe("stopped");
  });

  test("onEvent 应该注册事件处理器", () => {
    const handler = vi.fn();
    instance.onEvent(handler);
    // 无异常即通过
  });

  test("offEvent 应该取消事件处理器", () => {
    const handler = vi.fn();
    instance.onEvent(handler);
    instance.offEvent();
    // 无异常即通过
  });
});

// =============================================================================
// 3-6. 合并所有 fake timer 测试到一个 describe 块
//    (bun:test 的 vi.useFakeTimers 跨 describe 块有隔离问题)
// =============================================================================

describe("TimerInstance with fake timers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // === 定时触发事件测试 ===

  test("interval 到期时应该触发事件", async () => {
    const instance = new TimerInstance(
      createTimerConfig({ interval: 1000 }),
      () => [],
    );
    const handler = vi.fn();
    instance.onEvent(handler);

    await instance.start();
    expect(handler).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(handler).toHaveBeenCalledTimes(1);

    await instance.stop();
  });

  test("多次 interval 应该多次触发事件", async () => {
    const instance = new TimerInstance(
      createTimerConfig({ interval: 500 }),
      () => [],
    );
    const handler = vi.fn();
    instance.onEvent(handler);

    await instance.start();
    vi.advanceTimersByTime(2500);
    expect(handler).toHaveBeenCalledTimes(5);

    await instance.stop();
  });

  test("stop 后不应再触发事件", async () => {
    const instance = new TimerInstance(
      createTimerConfig({ interval: 1000 }),
      () => [],
    );
    const handler = vi.fn();
    instance.onEvent(handler);

    await instance.start();
    vi.advanceTimersByTime(1000);
    expect(handler).toHaveBeenCalledTimes(1);

    await instance.stop();
    vi.advanceTimersByTime(5000);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("没有注册 handler 时不应抛错", async () => {
    const instance = new TimerInstance(
      createTimerConfig({ interval: 1000 }),
      () => [],
    );
    await instance.start();
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    await instance.stop();
  });

  // === Rule-based 检查测试 ===

  test("有运行中任务时不应触发事件", async () => {
    const runningTask: Partial<BackgroundTask> = {
      id: "task-1",
      status: "running",
      description: "running task",
    };
    const getRunningTasks = () => [runningTask as BackgroundTask];

    const instance = new TimerInstance(
      createTimerConfig({ interval: 1000 }),
      getRunningTasks,
    );
    const handler = vi.fn();
    instance.onEvent(handler);

    await instance.start();
    vi.advanceTimersByTime(3000);
    expect(handler).not.toHaveBeenCalled();

    await instance.stop();
  });

  test("无运行中任务时应该触发事件", async () => {
    const getRunningTasks = () => [] as BackgroundTask[];

    const instance = new TimerInstance(
      createTimerConfig({ interval: 1000 }),
      getRunningTasks,
    );
    const handler = vi.fn();
    instance.onEvent(handler);

    await instance.start();
    vi.advanceTimersByTime(1000);
    expect(handler).toHaveBeenCalledTimes(1);

    await instance.stop();
  });

  test("只有已完成任务时应该触发事件", async () => {
    const completedTask: Partial<BackgroundTask> = {
      id: "task-1",
      status: "completed",
    };
    const failedTask: Partial<BackgroundTask> = {
      id: "task-2",
      status: "failed",
    };
    const getRunningTasks = () => [completedTask, failedTask] as BackgroundTask[];

    const instance = new TimerInstance(
      createTimerConfig({ interval: 1000 }),
      getRunningTasks,
    );
    const handler = vi.fn();
    instance.onEvent(handler);

    await instance.start();
    vi.advanceTimersByTime(1000);
    expect(handler).toHaveBeenCalledTimes(1);

    await instance.stop();
  });

  test("混合状态时（有 running + 已完成）不应触发事件", async () => {
    const tasks: Partial<BackgroundTask>[] = [
      { id: "task-1", status: "running" },
      { id: "task-2", status: "completed" },
      { id: "task-3", status: "pending" },
    ];
    const getRunningTasks = () => tasks as BackgroundTask[];

    const instance = new TimerInstance(
      createTimerConfig({ interval: 1000 }),
      getRunningTasks,
    );
    const handler = vi.fn();
    instance.onEvent(handler);

    await instance.start();
    vi.advanceTimersByTime(2000);
    expect(handler).not.toHaveBeenCalled();

    await instance.stop();
  });

  test("getRunningTasks 抛错时应安全跳过（不触发事件、不崩溃）", async () => {
    const getRunningTasks = () => {
      throw new Error("manager unavailable");
    };

    const instance = new TimerInstance(
      createTimerConfig({ interval: 1000 }),
      getRunningTasks,
    );
    const handler = vi.fn();
    instance.onEvent(handler);

    await instance.start();
    expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
    expect(handler).not.toHaveBeenCalled();

    await instance.stop();
  });

  // === SelfReminder 事件格式测试 ===

  test("事件 type 应该是 'event-source.event.timer'", async () => {
    const instance = new TimerInstance(
      createTimerConfig({ interval: 1000 }),
      () => [],
    );
    let captured: EventSourceEvent | undefined;
    instance.onEvent((evt) => {
      captured = evt;
    });

    await instance.start();
    vi.advanceTimersByTime(1000);
    await instance.stop();

    expect(captured).toBeDefined();
    expect(captured!.type).toBe("event-source.event.timer");
  });

  test("payload.sourceId 应该匹配 config.id", async () => {
    const config = createTimerConfig({ id: "my-timer-42", interval: 1000 });
    const instance = new TimerInstance(config, () => []);
    let captured: EventSourceEvent | undefined;
    instance.onEvent((evt) => {
      captured = evt;
    });

    await instance.start();
    vi.advanceTimersByTime(1000);
    await instance.stop();

    expect(captured).toBeDefined();
    expect(captured!.payload.sourceId).toBe("my-timer-42");
  });

  test("payload.sourceType 应该是 'timer'", async () => {
    const instance = new TimerInstance(createTimerConfig({ interval: 1000 }), () => []);
    let captured: EventSourceEvent | undefined;
    instance.onEvent((evt) => {
      captured = evt;
    });

    await instance.start();
    vi.advanceTimersByTime(1000);
    await instance.stop();

    expect(captured).toBeDefined();
    expect(captured!.payload.sourceType).toBe("timer");
  });

  test("payload.message 应该包含 Self-Reminder 提示文本", async () => {
    const instance = new TimerInstance(createTimerConfig({ interval: 1000 }), () => []);
    let captured: EventSourceEvent | undefined;
    instance.onEvent((evt) => {
      captured = evt;
    });

    await instance.start();
    vi.advanceTimersByTime(1000);
    await instance.stop();

    expect(captured).toBeDefined();
    const msg = captured!.payload.message;
    expect(msg).toContain("Timer Self-Reminder");
    expect(msg).toContain("task");
    expect(msg).toMatch(/分析|工作目标|任务/i);
  });

  test("配置了自定义 prompt 时，事件 message 应为自定义内容", async () => {
    const customPrompt = "请分析今日股票市场走势，筛选出具有投资价值的标的";
    const instance = new TimerInstance(
      createTimerConfig({ interval: 1000, options: { prompt: customPrompt } }),
      () => [],
    );
    let captured: EventSourceEvent | undefined;
    instance.onEvent((evt) => {
      captured = evt;
    });

    await instance.start();
    vi.advanceTimersByTime(1000);
    await instance.stop();

    expect(captured).toBeDefined();
    expect(captured!.payload.message).toBe(customPrompt);
    expect(captured!.payload.message).not.toContain("Timer Self-Reminder");
  });

  test("未配置 prompt 时，事件 message 应为默认 SELF_REMINDER_MESSAGE", async () => {
    const instance = new TimerInstance(
      createTimerConfig({ interval: 1000, options: {} }),
      () => [],
    );
    let captured: EventSourceEvent | undefined;
    instance.onEvent((evt) => {
      captured = evt;
    });

    await instance.start();
    vi.advanceTimersByTime(1000);
    await instance.stop();

    expect(captured).toBeDefined();
    expect(captured!.payload.message).toContain("Timer Self-Reminder");
    expect(captured!.payload.message).toContain("task");
  });

  test("payload.metadata 应该包含 eventType/sourceId/sourceType/timestamp", async () => {
    const config = createTimerConfig({ id: "timer-meta", interval: 1000 });
    const instance = new TimerInstance(config, () => []);
    let captured: EventSourceEvent | undefined;
    instance.onEvent((evt) => {
      captured = evt;
    });

    const before = Date.now();
    await instance.start();
    vi.advanceTimersByTime(1000);
    const after = Date.now();
    await instance.stop();

    expect(captured).toBeDefined();
    const meta = captured!.payload.metadata;
    expect(meta.eventType).toBe("timer.selfReminder");
    expect(meta.sourceId).toBe("timer-meta");
    expect(meta.sourceType).toBe("timer");
    expect(typeof meta.timestamp).toBe("number");
    expect(meta.timestamp).toBeGreaterThanOrEqual(before);
    expect(meta.timestamp).toBeLessThanOrEqual(after);
  });

  test("payload.timestamp 应该是数字时间戳", async () => {
    const instance = new TimerInstance(createTimerConfig({ interval: 1000 }), () => []);
    let captured: EventSourceEvent | undefined;
    instance.onEvent((evt) => {
      captured = evt;
    });

    await instance.start();
    vi.advanceTimersByTime(1000);
    await instance.stop();

    expect(captured).toBeDefined();
    expect(typeof captured!.payload.timestamp).toBe("number");
    expect(captured!.payload.timestamp).toBeGreaterThan(0);
  });

  test("event.id 应该唯一且包含 sourceId", async () => {
    const instance = new TimerInstance(createTimerConfig({ id: "t1", interval: 1000 }), () => []);
    const ids: string[] = [];
    instance.onEvent((evt) => {
      ids.push(evt.id);
    });

    await instance.start();
    vi.advanceTimersByTime(3000);
    await instance.stop();

    expect(ids.length).toBe(3);
    for (const id of ids) {
      expect(id).toContain("t1");
    }
    expect(new Set(ids).size).toBe(3);
  });

  // === SessionId 一致性测试 ===

  test("同一实例的多次事件应使用相同 sessionId", async () => {
    const instance = new TimerInstance(createTimerConfig({ id: "sess-1", interval: 1000 }), () => []);
    const sessionIds: string[] = [];
    instance.onEvent((evt) => {
      const sid = (evt.metadata?.sessionId as string | undefined) ?? "";
      sessionIds.push(sid);
    });

    await instance.start();
    vi.advanceTimersByTime(5000);
    await instance.stop();

    expect(sessionIds.length).toBeGreaterThan(1);
    const first = sessionIds[0];
    expect(first).toBeTruthy();
    for (const sid of sessionIds) {
      expect(sid).toBe(first);
    }
  });

  test("sessionId 应该包含 sourceId 信息", async () => {
    const instance = new TimerInstance(createTimerConfig({ id: "my-timer", interval: 1000 }), () => []);
    let sessionId = "";
    instance.onEvent((evt) => {
      sessionId = (evt.metadata?.sessionId as string) ?? "";
    });

    await instance.start();
    vi.advanceTimersByTime(1000);
    await instance.stop();

    expect(sessionId).toContain("my-timer");
  });

  test("不同实例的 sessionId 应该不同", async () => {
    const inst1 = new TimerInstance(createTimerConfig({ id: "timer-A", interval: 1000 }), () => []);
    const inst2 = new TimerInstance(createTimerConfig({ id: "timer-B", interval: 1000 }), () => []);

    let sid1 = "";
    let sid2 = "";
    inst1.onEvent((evt) => {
      sid1 = (evt.metadata?.sessionId as string) ?? "";
    });
    inst2.onEvent((evt) => {
      sid2 = (evt.metadata?.sessionId as string) ?? "";
    });

    await inst1.start();
    await inst2.start();
    vi.advanceTimersByTime(1000);
    await inst1.stop();
    await inst2.stop();

    expect(sid1).toBeTruthy();
    expect(sid2).toBeTruthy();
    expect(sid1).not.toBe(sid2);
  });
});

// =============================================================================
// 7. 集成测试：通过 timerHandler.createInstance 走完整链路
// =============================================================================

describe("TimerHandler integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("通过 handler.createInstance 创建的实例应能正常触发事件", async () => {
    const config = createTimerConfig({
      interval: 1000,
      options: {
        getBackgroundTaskManager: () => ({
          listTasks: () => [],
        }),
      },
    });

    const instance = timerHandler.createInstance(config);
    const handler = vi.fn();
    instance.onEvent(handler);

    await instance.start();
    vi.advanceTimersByTime(2000);
    expect(handler).toHaveBeenCalledTimes(2);

    await instance.stop();
  });

  test("未提供 getBackgroundTaskManager 时应默认无运行中任务（触发事件）", async () => {
    const config = createTimerConfig({ interval: 1000, options: {} });
    const instance = timerHandler.createInstance(config);
    const handler = vi.fn();
    instance.onEvent(handler);

    await instance.start();
    vi.advanceTimersByTime(1000);
    expect(handler).toHaveBeenCalledTimes(1);

    await instance.stop();
  });
});
