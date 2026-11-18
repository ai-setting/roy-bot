import { afterEach, describe, expect, test, vi } from "vitest";
import {
  BackgroundTaskEventTypes,
  BackgroundTaskManager,
  PROGRESS_INTERVAL,
  type BackgroundTask,
} from "./delegate-tool";

/**
 * Task #4888 — progress 心跳间隔口径锁定（10 min → 20 min 回滚）。
 *
 * 背景：Task #4720 把 `PROGRESS_INTERVAL` 从 20 分钟（1200000ms）下调到
 * 10 分钟（600000ms）。用户反馈 10 分钟太频繁（每条心跳都会占用飞书 lane
 * 并触发一次额外 agent run），要求回滚到 20 分钟。
 *
 * 这个文件把「20 分钟」这件事**双重锁定**：
 *   1. 常量语义：PROGRESS_INTERVAL === 1_200_000
 *   2. 真实行为：用 fake timers 驱动**真实的** startProgressReporter，
 *      断言 20 分钟前一条心跳都不发、到 20 分钟整点发且只发一条。
 *
 * 只断言常量是「同义反复」式的弱测试（把常量改成别的值它也能通过，
 * 只要测试里引用的是同一个符号）；行为断言才是承重的 —— 它证明
 * 「生产代码的 setInterval 真的按 20 分钟节奏走」。
 */
describe("PROGRESS_INTERVAL (progress heartbeat interval)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("常量值是 20 分钟（1_200_000ms），不是 10 分钟", () => {
    // 语义：20 分钟 = 20 * 60 * 1000
    expect(PROGRESS_INTERVAL).toBe(20 * 60 * 1000);
    expect(PROGRESS_INTERVAL).toBe(1_200_000);

    // 反向护栏：明确排除 #4720 期间的 10 分钟口径，避免无声回退
    expect(PROGRESS_INTERVAL).not.toBe(600_000);
  });

  test("真实 reporter 在 20 分钟前不发心跳、到 20 分钟整点发且只发一条", () => {
    vi.useFakeTimers();

    const publishedEvents: any[] = [];
    const manager = new BackgroundTaskManager({
      pushEnvEvent: (event: any) => publishedEvents.push(event),
    });

    const task: BackgroundTask = {
      id: "process_progress_interval_20min",
      subSessionId: "sub-interval",
      parentSessionId: "parent-interval",
      description: "progress interval cadence test",
      subagentType: "roy",
      status: "running",
      createdAt: Date.now(),
      startedAt: Date.now(),
      lastUpdatedAt: Date.now(),
    };

    // 绕开无关的 session/agent 执行链，只驱动 progress reporter 本身
    (manager as any).tasks.set(task.id, task);
    (manager as any).startProgressReporter(task.id, task.parentSessionId);

    const progressEvents = () =>
      publishedEvents.filter(
        (event) => event.type === BackgroundTaskEventTypes.PROGRESS,
      );

    // ★ 承重断言：走完「旧的 10 分钟口径 + 1ms」仍然一条都不该有。
    //   这里**故意硬编码** 10 分钟 —— 如果哪天有人把间隔又调回 10 分钟，
    //   这条会立刻变红，而只引用 PROGRESS_INTERVAL 的断言是抓不到的。
    const OLD_TEN_MIN_INTERVAL = 600_000;
    vi.advanceTimersByTime(OLD_TEN_MIN_INTERVAL + 1);
    expect(progressEvents()).toHaveLength(0);

    // 再走到「差 1ms 到 20 分钟」—— 依然一条心跳都不该有。
    // 用绝对目标时刻反推步长（而不是手算差值），这样即使未来把间隔调成
    // 小于 10 分钟也不会算出负数步长：max(0, ...) 兜底后由上面的常量断言先报错。
    const ALMOST_ONE_INTERVAL = Math.max(0, PROGRESS_INTERVAL - OLD_TEN_MIN_INTERVAL - 1 - 1);
    vi.advanceTimersByTime(ALMOST_ONE_INTERVAL);
    expect(progressEvents()).toHaveLength(0);

    // 补上那 1ms，正好到 20 分钟整点 —— 恰好 1 条
    vi.advanceTimersByTime(1);
    expect(progressEvents()).toHaveLength(1);

    // 再走一个完整周期 —— 累计 2 条（严格按 20 分钟节奏，不多不少）
    vi.advanceTimersByTime(PROGRESS_INTERVAL);
    expect(progressEvents()).toHaveLength(2);

    (manager as any).stopProgressReporter(task.id);
  });
});
