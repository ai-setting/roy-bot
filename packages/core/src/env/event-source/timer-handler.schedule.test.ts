/**
 * Timer Schedule Mode 测试（Task #4815）
 *
 * 覆盖方案 D：
 * 1. options.schedule 解析与校验（格式 HH:MM / prompt 必填 / 与 interval 互斥）
 * 2. 多时刻命中（fake timers）
 * 3. 同日去重（同一时刻当天只触发一次）
 * 4. 向后兼容（无 schedule 走 interval 老路径）
 * 5. trigger_session_id 注入
 * 6. schedule 模式默认不被后台运行任务挡掉
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "bun:test";
import type { EventSourceConfig, EventSourceEvent } from "./types";
import { timerHandler, TimerInstance } from "./timer-handler";
import type { BackgroundTask } from "../task/delegate/delegate-tool";

// =============================================================================
// Helper
// =============================================================================

function createScheduleConfig(
  schedule: unknown,
  overrides: Partial<EventSourceConfig> = {},
): EventSourceConfig {
  return {
    id: "daily-summary",
    name: "Daily Summary",
    type: "timer",
    enabled: true,
    options: { schedule },
    ...overrides,
  } as EventSourceConfig;
}

const SCHEDULE_3 = [
  { time: "10:00", prompt: "【早报】总结进行中任务，给出新一天主线跟进建议" },
  { time: "17:00", prompt: "【午后】进展总结；提醒休息；给后台智能体做任务交代" },
  { time: "20:00", prompt: "【晚报】一天总结" },
];

// =============================================================================
// 1. validateConfig —— schedule 校验
// =============================================================================

describe("TimerHandler.validateConfig — schedule mode", () => {
  test("应该接受合法的 schedule", () => {
    const errors = timerHandler.validateConfig(createScheduleConfig(SCHEDULE_3));
    expect(errors).toEqual([]);
  });

  test("应该拒绝 schedule 不是数组", () => {
    const errors = timerHandler.validateConfig(createScheduleConfig("10:00"));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /schedule/i.test(e))).toBe(true);
  });

  test("应该拒绝空的 schedule 数组", () => {
    const errors = timerHandler.validateConfig(createScheduleConfig([]));
    expect(errors.length).toBeGreaterThan(0);
  });

  test("应该拒绝非法 time 格式（非 HH:MM）", () => {
    const errors = timerHandler.validateConfig(
      createScheduleConfig([{ time: "25:00", prompt: "x" }]),
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /time|HH:MM/i.test(e))).toBe(true);
  });

  test("应该拒绝缺少冒号的 time", () => {
    const errors = timerHandler.validateConfig(
      createScheduleConfig([{ time: "1000", prompt: "x" }]),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  test("应该拒绝缺失的 prompt", () => {
    const errors = timerHandler.validateConfig(
      createScheduleConfig([{ time: "10:00" }]),
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /prompt/i.test(e))).toBe(true);
  });

  test("应该拒绝空白 prompt", () => {
    const errors = timerHandler.validateConfig(
      createScheduleConfig([{ time: "10:00", prompt: "   " }]),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  test("应该拒绝重复的 time（同一 schedule 里两个相同 time）", () => {
    const errors = timerHandler.validateConfig(
      createScheduleConfig([
        { time: "10:00", prompt: "早报" },
        { time: "17:00", prompt: "午后" },
        { time: "10:00", prompt: "重复的早报" },
      ]),
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /duplicate/i.test(e))).toBe(true);
  });

  test("应该拒绝全部 time 都重复的 schedule", () => {
    const errors = timerHandler.validateConfig(
      createScheduleConfig([
        { time: "10:00", prompt: "a" },
        { time: "10:00", prompt: "b" },
      ]),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  test("schedule 与 interval 同时配置应该报错（互斥）", () => {
    const errors = timerHandler.validateConfig(
      createScheduleConfig(SCHEDULE_3, { interval: 600_000 }),
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /mutually exclusive|互斥|interval/i.test(e))).toBe(true);
  });

  test("schedule 模式下不配置 interval 应该合法", () => {
    const errors = timerHandler.validateConfig(
      createScheduleConfig(SCHEDULE_3, { interval: undefined }),
    );
    expect(errors).toEqual([]);
  });

  test("无 schedule 时 interval 校验行为不变（向后兼容）", () => {
    const errors = timerHandler.validateConfig(
      createTimerConfigCompat({ interval: 600_000 }),
    );
    expect(errors).toEqual([]);
  });

  test("无 schedule 时非法 interval 仍报错（向后兼容）", () => {
    const errors = timerHandler.validateConfig(
      createTimerConfigCompat({ interval: -1 }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });
});

function createTimerConfigCompat(
  overrides: Partial<EventSourceConfig> = {},
): EventSourceConfig {
  return {
    id: "timer-1",
    name: "Test Timer",
    type: "timer",
    enabled: true,
    interval: 600_000,
    ...overrides,
  };
}

// =============================================================================
// 2. Schedule 模式命中 & 去重 & trigger_session_id
// =============================================================================

describe("TimerInstance schedule mode", () => {
  /** 可注入时钟（bun:test 的 vi 没有 setSystemTime） */
  let clock: Date;
  const nowFn = () => clock.getTime();
  const setClock = (iso: string) => {
    clock = new Date(iso);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    // 固定系统时间到 2026-11-01 09:59:00
    clock = new Date("2026-11-01T09:59:00");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("命中 schedule 时刻应该触发事件且注入该时刻的 prompt", async () => {
    const instance = new TimerInstance(createScheduleConfig(SCHEDULE_3), () => [], nowFn);
    const events: EventSourceEvent[] = [];
    instance.onEvent((e) => events.push(e));

    await instance.start();
    // 推进到 10:00
    setClock("2026-11-01T10:00:00");
    vi.advanceTimersByTime(60_000);

    expect(events.length).toBe(1);
    expect(events[0].payload.message).toBe(SCHEDULE_3[0].prompt);

    await instance.stop();
  });

  test("不同时刻应该分发不同的 prompt", async () => {
    const instance = new TimerInstance(createScheduleConfig(SCHEDULE_3), () => [], nowFn);
    const events: EventSourceEvent[] = [];
    instance.onEvent((e) => events.push(e));

    await instance.start();
    setClock("2026-11-01T17:00:00");
    vi.advanceTimersByTime(60_000);
    setClock("2026-11-01T20:00:00");
    vi.advanceTimersByTime(60_000);

    expect(events.length).toBe(2);
    expect(events[0].payload.message).toBe(SCHEDULE_3[1].prompt);
    expect(events[1].payload.message).toBe(SCHEDULE_3[2].prompt);

    await instance.stop();
  });

  test("同一时刻当天只触发一次（去重）", async () => {
    const instance = new TimerInstance(createScheduleConfig(SCHEDULE_3), () => [], nowFn);
    const handler = vi.fn();
    instance.onEvent(handler);

    await instance.start();
    setClock("2026-11-01T10:00:00");
    vi.advanceTimersByTime(60_000);
    expect(handler).toHaveBeenCalledTimes(1);

    // 同一天内多次 tick 仍不应重复触发
    vi.advanceTimersByTime(60_000);
    vi.advanceTimersByTime(60_000);
    expect(handler).toHaveBeenCalledTimes(1);

    await instance.stop();
  });

  test("跨天后同一时刻应再次触发", async () => {
    const instance = new TimerInstance(createScheduleConfig(SCHEDULE_3), () => [], nowFn);
    const handler = vi.fn();
    instance.onEvent(handler);

    await instance.start();
    setClock("2026-11-01T10:00:00");
    vi.advanceTimersByTime(60_000);
    expect(handler).toHaveBeenCalledTimes(1);

    // 次日 10:00
    setClock("2026-11-02T10:00:00");
    vi.advanceTimersByTime(60_000);
    expect(handler).toHaveBeenCalledTimes(2);

    await instance.stop();
  });

  test("非 schedule 时刻不应触发", async () => {
    const instance = new TimerInstance(createScheduleConfig(SCHEDULE_3), () => [], nowFn);
    const handler = vi.fn();
    instance.onEvent(handler);

    await instance.start();
    setClock("2026-11-01T15:30:00");
    vi.advanceTimersByTime(60_000);
    expect(handler).not.toHaveBeenCalled();

    await instance.stop();
  });

  test("事件 metadata 应该包含 trigger_session_id", async () => {
    const instance = new TimerInstance(createScheduleConfig(SCHEDULE_3), () => [], nowFn);
    const events: EventSourceEvent[] = [];
    instance.onEvent((e) => events.push(e));

    await instance.start();
    setClock("2026-11-01T10:00:00");
    vi.advanceTimersByTime(60_000);

    const meta = events[0].metadata as Record<string, unknown>;
    expect(typeof meta.trigger_session_id).toBe("string");
    expect((meta.trigger_session_id as string).length).toBeGreaterThan(0);

    await instance.stop();
  });

  test("options.sessionId 应该覆盖默认 trigger_session_id", async () => {
    const config = createScheduleConfig(SCHEDULE_3, {
      options: { schedule: SCHEDULE_3, sessionId: "my-daily-session" },
    });
    const instance = new TimerInstance(config, () => [], nowFn);
    const events: EventSourceEvent[] = [];
    instance.onEvent((e) => events.push(e));

    await instance.start();
    setClock("2026-11-01T10:00:00");
    vi.advanceTimersByTime(60_000);

    const meta = events[0].metadata as Record<string, unknown>;
    expect(meta.trigger_session_id).toBe("my-daily-session");

    await instance.stop();
  });

  test("trigger_session_id 应该跨事件稳定（同一实例）", async () => {
    const instance = new TimerInstance(createScheduleConfig(SCHEDULE_3), () => [], nowFn);
    const events: EventSourceEvent[] = [];
    instance.onEvent((e) => events.push(e));

    await instance.start();
    setClock("2026-11-01T10:00:00");
    vi.advanceTimersByTime(60_000);
    setClock("2026-11-01T17:00:00");
    vi.advanceTimersByTime(60_000);

    const m1 = events[0].metadata as Record<string, unknown>;
    const m2 = events[1].metadata as Record<string, unknown>;
    expect(m1.trigger_session_id).toBe(m2.trigger_session_id);

    await instance.stop();
  });

  test("schedule 模式默认不被运行中的后台任务挡掉", async () => {
    const runningTask = { id: "t1", status: "running" } as BackgroundTask;
    const instance = new TimerInstance(
      createScheduleConfig(SCHEDULE_3),
      () => [runningTask],
      nowFn,
    );
    const handler = vi.fn();
    instance.onEvent(handler);

    await instance.start();
    setClock("2026-11-01T10:00:00");
    vi.advanceTimersByTime(60_000);

    expect(handler).toHaveBeenCalledTimes(1);

    await instance.stop();
  });

  test("options.skipWhenRunning=true 时应被运行中的后台任务挡掉", async () => {
    const runningTask = { id: "t1", status: "running" } as BackgroundTask;
    const config = createScheduleConfig(SCHEDULE_3, {
      options: { schedule: SCHEDULE_3, skipWhenRunning: true },
    });
    const instance = new TimerInstance(config, () => [runningTask], nowFn);
    const handler = vi.fn();
    instance.onEvent(handler);

    await instance.start();
    setClock("2026-11-01T10:00:00");
    vi.advanceTimersByTime(60_000);

    expect(handler).not.toHaveBeenCalled();

    await instance.stop();
  });

  test("事件 metadata 应该带 scheduleLabel 便于识别", async () => {
    const config = createScheduleConfig(
      [{ time: "10:00", prompt: "早报", label: "morning" }],
    );
    const instance = new TimerInstance(config, () => [], nowFn);
    const events: EventSourceEvent[] = [];
    instance.onEvent((e) => events.push(e));

    await instance.start();
    setClock("2026-11-01T10:00:00");
    vi.advanceTimersByTime(60_000);

    const meta = events[0].metadata as Record<string, unknown>;
    expect(meta.scheduleLabel).toBe("morning");

    await instance.stop();
  });

  test("schedule 模式即使 config.interval 有值也固定用 30s tick（防御）", async () => {
    const config = createScheduleConfig(SCHEDULE_3, { interval: 1000 });
    const instance = new TimerInstance(config, () => [], nowFn);
    const interval = (instance as unknown as { interval: number }).interval;
    expect(interval).toBe(30_000);

    await instance.start();
    await instance.stop();
  });

  test("★ review MINOR-1 schedule 全项非法时不应退化成 interval 模式", async () => {
    // 非法 schedule（time 格式错）→ 必须保持 schedule 模式（不触发任何事件），
    //   而不是退化成 interval 模式跑默认 SelfReminder。
    const config = createScheduleConfig([{ time: "25:00", prompt: "x" }]);
    const instance = new TimerInstance(config, () => [], nowFn);
    const handler = vi.fn();
    instance.onEvent(handler);

    await instance.start();
    // 走足够多的 tick
    vi.advanceTimersByTime(10 * 60_000);
    expect(handler).not.toHaveBeenCalled();

    // interval 应为 30s（schedule 模式），而不是 interval 模式的默认 10 分钟
    const interval = (instance as unknown as { interval: number }).interval;
    expect(interval).toBe(30_000);

    await instance.stop();
  });

  test("未配置 schedule 时仍走 interval 模式（向后兼容）", async () => {
    const instance = new TimerInstance(
      createTimerConfigCompat({ interval: 1000 }),
      () => [],
      nowFn,
    );
    const handler = vi.fn();
    instance.onEvent(handler);

    await instance.start();
    vi.advanceTimersByTime(3000);
    expect(handler).toHaveBeenCalledTimes(3);

    await instance.stop();
  });

  test("去重标记不应无限增长（跨多天后清理旧 key）", async () => {    const instance = new TimerInstance(createScheduleConfig(SCHEDULE_3), () => [], nowFn);
    const handler = vi.fn();
    instance.onEvent(handler);

    await instance.start();
    // 连续 40 天，每天 10:00 触发一次
    for (let day = 1; day <= 40; day++) {
      const date = new Date(Date.UTC(2026, 10, day, 10, 0, 0));
      const iso = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}T10:00:00`;
      setClock(iso);
      vi.advanceTimersByTime(60_000);
    }

    // 40 天各触发 1 次
    expect(handler).toHaveBeenCalledTimes(40);

    // 去重标记应被清理（不随天数无限增长）
    const firedKeys = (instance as unknown as { firedKeys: Set<string> }).firedKeys;
    expect(firedKeys.size).toBeLessThanOrEqual(32);

    await instance.stop();
  });
});

// =============================================================================
// 3. 向后兼容：无 schedule 走老 interval 路径
// =============================================================================

describe("TimerInstance backward compatibility (no schedule)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("无 schedule 时应该按 interval 触发（不走 schedule 路径）", async () => {
    const instance = new TimerInstance(
      createTimerConfigCompat({ interval: 1000 }),
      () => [],
    );
    const handler = vi.fn();
    instance.onEvent(handler);

    await instance.start();
    vi.advanceTimersByTime(3000);
    expect(handler).toHaveBeenCalledTimes(3);

    await instance.stop();
  });

  test("无 schedule 时事件不应包含 trigger_session_id（保持老行为）", async () => {
    const instance = new TimerInstance(
      createTimerConfigCompat({ interval: 1000 }),
      () => [],
    );
    const events: EventSourceEvent[] = [];
    instance.onEvent((e) => events.push(e));

    await instance.start();
    vi.advanceTimersByTime(1000);

    const meta = events[0].metadata as Record<string, unknown>;
    expect(meta.trigger_session_id).toBeUndefined();

    await instance.stop();
  });

  test("无 schedule 时 options.prompt 仍然生效（老行为不变）", async () => {
    const instance = new TimerInstance(
      createTimerConfigCompat({
        interval: 1000,
        options: { prompt: "自定义提示" },
      }),
      () => [],
    );
    const events: EventSourceEvent[] = [];
    instance.onEvent((e) => events.push(e));

    await instance.start();
    vi.advanceTimersByTime(1000);

    expect(events[0].payload.message).toBe("自定义提示");

    await instance.stop();
  });
});
