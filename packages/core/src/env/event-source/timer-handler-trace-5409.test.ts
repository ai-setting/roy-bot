/**
 * @fileoverview Task #5409 — timer tick 只在实际 fire 事件时留 trace
 *
 * ## 缺陷（实测）
 *
 * `tick()` / `tickSchedule()` 入口原本带 `@TracedAs`，于是**什么都没做的空转
 * tick 也会落一条 span**。生产实测：`debug trace --list` 里 22 条全是
 * `timer.tick`，严格 30 秒一条、全部 0ms/ok —— 每天约 2880 条无价值 trace，
 * 是 traces.db 膨胀的增量来源之一。
 *
 * ## 本文件锁定的不变量（方案 A）
 *
 * 1. 跳过路径（有 running 任务 / getRunningTasks 抛错 / 时刻不命中 /
 *    当日去重）→ **零 span**
 * 2. 真正 fire SelfReminder → **恰好 1 条** `timer.tick.fire` span
 * 3. 该 span 带 mode 属性（interval / schedule），可区分触发来源
 * 4. `timer.tick` / `timer.tickSchedule` / `timer.buildSelfReminderEvent`
 *    这些「入口级」span 名**不再出现**（噪音源已摘除）
 * 5. 跳过/触发的可观测性由进程内计数器 `getTickStats()` 保留（timer 仍活着）
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  OTelTracerProvider,
  setTracerProvider,
  resetTracerProvider,
} from "../log-trace/opentelemetry/tracer-provider";
import { SQLiteSpanStorage } from "../log-trace/span-storage";
import type { Span } from "../log-trace/types";

import { TimerInstance } from "./timer-handler";
import type { TimerTickStats } from "./timer-handler";
import type { EventSourceConfig, EventSourceEvent } from "./types";
import type { BackgroundTask } from "../task/delegate/delegate-tool";

// ============================================================================
// Harness
// ============================================================================

let tempDir: string;
let storage: SQLiteSpanStorage;
let provider: OTelTracerProvider;

beforeEach(async () => {
  resetTracerProvider();
  tempDir = mkdtempSync(join(tmpdir(), "timer-trace-5409-"));
  storage = new SQLiteSpanStorage(join(tempDir, "traces.db"));
  provider = new OTelTracerProvider(storage);
  await provider.initialize();
  setTracerProvider(provider);
});

afterEach(() => {
  resetTracerProvider();
  if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

function flatten(spans: Span[]): Span[] {
  const out: Span[] = [];
  const walk = (n: Span) => {
    out.push(n);
    if (n.children) for (const c of n.children) walk(c);
  };
  for (const s of spans) walk(s);
  return out;
}

/** 收集本次测试落库的全部 span */
function allSpans(): Span[] {
  const out: Span[] = [];
  for (const t of storage.listTraces(1000)) {
    out.push(...flatten(storage.findByTraceId(t.traceId)));
  }
  return out;
}

const flush = () => new Promise((r) => setTimeout(r, 60));

function intervalConfig(overrides: Partial<EventSourceConfig> = {}): EventSourceConfig {
  return {
    id: "timer-5409",
    name: "timer trace test",
    type: "timer",
    enabled: true,
    interval: 600_000,
    ...overrides,
  } as EventSourceConfig;
}

function runningTask(): BackgroundTask {
  return { id: "bg-5409", status: "running" } as unknown as BackgroundTask;
}

function makeInstance(opts: {
  config?: EventSourceConfig;
  getRunningTasks?: () => BackgroundTask[];
  now?: () => number;
}): { instance: TimerInstance; fired: EventSourceEvent[] } {
  const instance = new TimerInstance(
    opts.config ?? intervalConfig(),
    opts.getRunningTasks ?? (() => []),
    opts.now,
  );
  const fired: EventSourceEvent[] = [];
  instance.onEvent((evt) => {
    fired.push(evt as EventSourceEvent);
  });
  return { instance, fired };
}

/** 直接驱动私有 tick（测试内部逻辑，不依赖真实 setInterval） */
function tickOf(instance: TimerInstance): void {
  (instance as unknown as { tick: () => void }).tick();
}

/** 只取两个核心计数字段（skippedSinceLastFire 在专门用例中单独断言） */
function firedAndSkipped(instance: TimerInstance): { firedTicks: number; skippedTicks: number } {
  const s = statsOf(instance);
  return { firedTicks: s.firedTicks, skippedTicks: s.skippedTicks };
}

function statsOf(instance: TimerInstance): TimerTickStats {
  return (
    instance as unknown as { getTickStats: () => TimerTickStats }
  ).getTickStats();
}

// ============================================================================
// 1. 跳过路径 → 零 span（本次修复的核心）
// ============================================================================

describe("Task #5409: 空转 tick 不再产生 trace", () => {
  test("有 running 任务 → tick 跳过，零 span、零事件、skippedTicks++", async () => {
    const { instance, fired } = makeInstance({ getRunningTasks: () => [runningTask()] });

    tickOf(instance);
    await flush();

    expect(fired.length).toBe(0);
    expect(allSpans()).toEqual([]);
    expect(firedAndSkipped(instance)).toEqual({ firedTicks: 0, skippedTicks: 1 });
  });

  test("getRunningTasks 抛错 → 安全跳过，零 span、skippedTicks++", async () => {
    const { instance, fired } = makeInstance({
      getRunningTasks: () => {
        throw new Error("boom");
      },
    });

    tickOf(instance);
    await flush();

    expect(fired.length).toBe(0);
    expect(allSpans()).toEqual([]);
    expect(statsOf(instance).skippedTicks).toBe(1);
    expect(statsOf(instance).firedTicks).toBe(0);
  });

  test("连续 3 次空转 → 仍然零 span（不会累积噪音）", async () => {
    const { instance } = makeInstance({ getRunningTasks: () => [runningTask()] });

    tickOf(instance);
    tickOf(instance);
    tickOf(instance);
    await flush();

    expect(allSpans()).toEqual([]);
    expect(statsOf(instance).skippedTicks).toBe(3);
  });
});

// ============================================================================
// 2. 真正 fire → 恰好 1 条 fire span
// ============================================================================

describe("Task #5409: 命中并 fire 时只留 1 条 trace", () => {
  test("无 running 任务 → fire 1 次，恰好 1 条 span 且名为 timer.tick.fire", async () => {
    const { instance, fired } = makeInstance({ getRunningTasks: () => [] });

    tickOf(instance);
    await flush();

    expect(fired.length).toBe(1);

    const spans = allSpans();
    expect(spans.length).toBe(1);
    expect(spans[0].name).toBe("timer.tick.fire");
    expect(spans[0].attributes["mode"]).toBe("interval");
    // MINOR-1：sourceId 必须真的写进 span（JSDoc 与实现一致）
    expect(spans[0].attributes["sourceId"]).toBe("timer-5409");
    expect(firedAndSkipped(instance)).toEqual({ firedTicks: 1, skippedTicks: 0 });
  });

  test("旧的入口级 span 名不再出现（噪音源已摘除）", async () => {
    const { instance } = makeInstance({ getRunningTasks: () => [] });

    tickOf(instance);
    await flush();

    const names = allSpans().map((s) => s.name);
    expect(names).not.toContain("timer.tick");
    expect(names).not.toContain("timer.tickSchedule");
    expect(names).not.toContain("timer.buildSelfReminderEvent");
  });

  test("fire span 上带 skippedSinceLastFire，一眼看出「空转了多少次才触发」", async () => {
    let running = [runningTask()];
    const { instance } = makeInstance({ getRunningTasks: () => running });

    tickOf(instance);
    tickOf(instance);
    running = [];
    tickOf(instance);
    await flush();

    const spans = allSpans();
    expect(spans.length).toBe(1);
    expect(spans[0].attributes["skippedSinceLastFire"]).toBe(2);
    // fire 后归零
    expect(statsOf(instance).skippedSinceLastFire).toBe(0);
  });

  test("先空转 2 次再 fire 1 次 → 只有 1 条 trace（前两次零 trace）", async () => {
    let running = [runningTask()];
    const { instance, fired } = makeInstance({ getRunningTasks: () => running });

    tickOf(instance);
    tickOf(instance);
    running = []; // 后台任务结束
    tickOf(instance);
    await flush();

    expect(fired.length).toBe(1);
    const spans = allSpans();
    expect(spans.length).toBe(1);
    expect(firedAndSkipped(instance)).toEqual({ firedTicks: 1, skippedTicks: 2 });
  });
});

// ============================================================================
// 3. schedule 模式同样处理
// ============================================================================

describe("Task #5409: schedule 模式只在实际命中时留 trace", () => {
  const scheduleConfig = (): EventSourceConfig =>
    intervalConfig({
      id: "daily-summary-5409",
      options: { schedule: [{ time: "10:00", prompt: "【早报】总结进行中任务", label: "早报" }] },
    });

  const at = (hh: number, mm: number) => () => new Date(2026, 0, 15, hh, mm, 5).getTime();

  test("时刻不命中 → 零 span、skippedTicks++", async () => {
    const { instance, fired } = makeInstance({
      config: scheduleConfig(),
      getRunningTasks: () => [],
      now: at(9, 59),
    });

    tickOf(instance);
    await flush();

    expect(fired.length).toBe(0);
    expect(allSpans()).toEqual([]);
    expect(firedAndSkipped(instance)).toEqual({ firedTicks: 0, skippedTicks: 1 });
  });

  test("时刻命中 → 恰好 1 条 fire span，mode=schedule 且带 scheduleTime", async () => {
    const { instance, fired } = makeInstance({
      config: scheduleConfig(),
      getRunningTasks: () => [],
      now: at(10, 0),
    });

    tickOf(instance);
    await flush();

    expect(fired.length).toBe(1);
    const spans = allSpans();
    expect(spans.length).toBe(1);
    expect(spans[0].name).toBe("timer.tick.fire");
    expect(spans[0].attributes["mode"]).toBe("schedule");
    expect(spans[0].attributes["sourceId"]).toBe("daily-summary-5409");
    expect(spans[0].attributes["scheduleTime"]).toBe("10:00");
    expect(spans[0].attributes["scheduleLabel"]).toBe("早报");
    expect(firedAndSkipped(instance)).toEqual({ firedTicks: 1, skippedTicks: 0 });
  });

  test("同一时刻重复 tick（当日去重）→ 第 2 次零 span", async () => {
    const { instance, fired } = makeInstance({
      config: scheduleConfig(),
      getRunningTasks: () => [],
      now: at(10, 0),
    });

    tickOf(instance);
    await flush();
    const afterFirst = allSpans().length;
    expect(afterFirst).toBe(1);

    tickOf(instance);
    await flush();

    expect(allSpans().length).toBe(afterFirst); // 未新增
    expect(fired.length).toBe(1);
    expect(firedAndSkipped(instance)).toEqual({ firedTicks: 1, skippedTicks: 1 });
  });
});
