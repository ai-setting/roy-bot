/**
 * @fileoverview Task #4552 (A1) — started/progress payload 必须带 startedAt / timeoutMs
 *
 * ## 为什么必须补这两个字段
 *
 * A1 把 telemetry 降级成一条纯 IM 提示，文案要回答用户**两个**问题：
 *   1. 「跑了多久了」 → 需要 startedAt
 *   2. 「什么时候该有结论」 → 需要 startedAt + timeoutMs（算绝对超时时间）
 *
 * 没有 (2) 就复现不了 goals 第 5 项要修的那个认知错位：用户 16:40 以为
 * 「超时了该有结论」，实际任务 timeout=5h、到 17:23 才超时。
 *
 * 而 `delegate-tool.ts` 的两个 payload 类型此前**都没有**这两个字段，
 * 事件携带的 payload 自然也没有 → 文案只能永远降级（没有「预计 xx:xx 超时」）。
 *
 * ## 本文件锁定
 *
 * - started payload 带 startedAt + timeoutMs（即便是"刚创建"）
 * - progress payload 带 startedAt + timeoutMs
 * - 两者一致（同一个 task 的两次通知绝不能给出不同的超时时刻）
 * - 尊重调用方传入的 timeout（不是永远 DEFAULT_TIMEOUT）
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "bun:test";
import {
  BackgroundTaskManager,
  BackgroundTaskEventTypes,
  DEFAULT_TIMEOUT,
  PROGRESS_INTERVAL,
  type CreateBackgroundTaskOptions,
} from "./delegate-tool";

describe("Task #4552 A1 — telemetry payload 必须带超时可见性字段", () => {
  let published: any[];
  let mockEnv: any;
  let mockSessionComponent: any;

  beforeEach(() => {
    vi.useFakeTimers();
    published = [];
    mockSessionComponent = {
      get: vi.fn().mockResolvedValue({ id: "parent-1" }),
      create: vi.fn().mockResolvedValue({
        id: "sub-1",
        info: { metadata: { subagent_type: "general" } },
      }),
      addMessage: vi.fn(),
    };
    mockEnv = {
      getComponent: vi.fn((name: string) =>
        name === "session" ? mockSessionComponent : undefined,
      ),
      pushEnvEvent: (e: any) => published.push(e),
      handle_query: vi.fn().mockResolvedValue("done"),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function createWithTimeout(timeout?: number) {
    const manager = new BackgroundTaskManager(mockEnv);
    const opts: CreateBackgroundTaskOptions = {
      parentSessionId: "parent-1",
      description: "调研 airport 本体生成",
      prompt: "do it",
      subagentType: "general",
      ...(timeout !== undefined ? { timeout } : {}),
    };
    const { taskId } = await manager.createTask(opts);
    return { manager, taskId };
  }

  test("started payload 带 startedAt + timeoutMs（默认 timeout）", async () => {
    const { manager } = await createWithTimeout();
    const ev = published.find((e) => e.type === BackgroundTaskEventTypes.STARTED);

    expect(ev).toBeDefined();
    expect(typeof ev.payload.startedAt).toBe("number");
    expect(ev.payload.startedAt).toBeGreaterThan(0);
    expect(ev.payload.timeoutMs).toBe(DEFAULT_TIMEOUT);

    await manager.dispose();
  });

  test("started payload 尊重调用方 timeout（不是永远 DEFAULT_TIMEOUT）", async () => {
    const fiveHours = 5 * 3600 * 1000;
    const { manager } = await createWithTimeout(fiveHours);
    const ev = published.find((e) => e.type === BackgroundTaskEventTypes.STARTED);

    expect(ev.payload.timeoutMs).toBe(fiveHours);

    await manager.dispose();
  });

  /**
   * ★ 这两条用**真实** startProgressReporter 驱动（不是自己伪造 payload）。
   *
   * PROGRESS_INTERVAL 是模块常量（当前 20 分钟，见 Task #4888），测试不能真等
   * → 用 fake timers 推进虚拟时间，让真实 setInterval 回调跑一次，断言它
   * **自己**产出的 payload 形态。伪造 payload 只能证明「我传的字段被透传」，
   * 证明不了「生产代码会填这两个字段」—— 那种测试是假通过。
   *
   * ⚠️ 这里推进的量必须取 **真实常量** PROGRESS_INTERVAL，不要硬编码
   * 1200001 —— 硬编码会在下次调整间隔时静默失配（#4720 就把 20 分钟改成
   * 10 分钟，当时硬编码的 1_200_001 依然「碰巧能过」，掩盖了口径漂移）。
   */
  async function createRunningTask(fiveHours: number) {
    // handle_query 永不 resolve → task 保持 running，reporter 才会继续发心跳
    mockEnv.handle_query = vi.fn(() => new Promise(() => {}));
    const manager = new BackgroundTaskManager(mockEnv);
    const { taskId } = await manager.createTask({
      parentSessionId: "parent-1",
      description: "调研 airport 本体生成",
      prompt: "do it",
      subagentType: "general",
      timeout: fiveHours,
    });
    return { manager, taskId };
  }

  test("progress payload（真实 reporter 产出）带 startedAt + timeoutMs", async () => {
    const fiveHours = 5 * 3600 * 1000;
    const { manager } = await createRunningTask(fiveHours);

    // 让真实的 setInterval 回调跑一次（取真实常量，避免下次改间隔失配）
    vi.advanceTimersByTime(PROGRESS_INTERVAL + 1);
    // 回调里有 getCurrentTaskId 等同步逻辑，给它一个微任务窗口
    await Promise.resolve();

    const progressEvents = published.filter(
      (e) => e.type === BackgroundTaskEventTypes.PROGRESS,
    );
    expect(progressEvents.length).toBeGreaterThanOrEqual(1);

    const payload = progressEvents[0].payload;
    expect(typeof payload.startedAt).toBe("number");
    expect(payload.startedAt).toBeGreaterThan(0);
    expect(payload.timeoutMs).toBe(fiveHours);

    await manager.dispose();
  });

  test("started 与 progress 给出同一个绝对超时时刻", async () => {
    const fiveHours = 5 * 3600 * 1000;
    const { manager } = await createRunningTask(fiveHours);

    const started = published.find((e) => e.type === BackgroundTaskEventTypes.STARTED);
    expect(started).toBeDefined();
    // ★ 必须先断言字段存在：undefined + undefined = NaN，而 Object.is(NaN,NaN)
    //   为 true → 只比总和的写法在字段缺失时会**假通过**（本条初版就踩了）。
    expect(typeof started.payload.startedAt).toBe("number");
    expect(typeof started.payload.timeoutMs).toBe("number");
    const startedTimeoutAt = started.payload.startedAt + started.payload.timeoutMs;

    vi.advanceTimersByTime(PROGRESS_INTERVAL + 1);
    await Promise.resolve();

    const progress = published.find((e) => e.type === BackgroundTaskEventTypes.PROGRESS);
    expect(progress).toBeDefined();
    expect(typeof progress.payload.startedAt).toBe("number");
    expect(typeof progress.payload.timeoutMs).toBe("number");
    expect(progress.payload.startedAt + progress.payload.timeoutMs).toBe(startedTimeoutAt);

    await manager.dispose();
  });
});
