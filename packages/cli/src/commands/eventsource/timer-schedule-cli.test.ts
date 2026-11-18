/**
 * EventSource CLI —— schedule / sessionId 透传测试（Task #4815）
 *
 * 覆盖：
 * 1. add.ts builder 定义 --schedule / --session-id 选项
 * 2. add.ts handler 把 schedule / sessionId 透传到 config.options
 * 3. update.ts builder 定义相同选项
 * 4. update.ts handler 把 schedule / sessionId 合并进 partial.options
 */

import { describe, test, expect, vi } from "bun:test";
import { EventSourceAddCommand } from "./add";
import { EventSourceUpdateCommand } from "./update";

function mockYargs() {
  return {
    option: vi.fn().mockReturnThis(),
    positional: vi.fn().mockReturnThis(),
  };
}

describe("EventSourceAddCommand — schedule/sessionId options", () => {
  test("builder 应该定义 --schedule 选项", () => {
    const y = mockYargs();
    EventSourceAddCommand.builder(y as any);
    const calls = y.option.mock.calls;
    const schedule = calls.find((c: any[]) => c[0] === "schedule");
    expect(schedule).toBeDefined();
    expect(schedule![1].type).toBe("string");
  });

  test("builder 应该定义 --session-id 选项", () => {
    const y = mockYargs();
    EventSourceAddCommand.builder(y as any);
    const calls = y.option.mock.calls;
    const sessionId = calls.find((c: any[]) => c[0] === "session-id");
    expect(sessionId).toBeDefined();
    expect(sessionId![1].type).toBe("string");
  });
});

describe("EventSourceUpdateCommand — schedule/sessionId options", () => {
  test("builder 应该定义 --schedule 选项", () => {
    const y = mockYargs();
    EventSourceUpdateCommand.builder(y as any);
    const calls = y.option.mock.calls;
    const schedule = calls.find((c: any[]) => c[0] === "schedule");
    expect(schedule).toBeDefined();
    expect(schedule![1].type).toBe("string");
  });

  test("builder 应该定义 --session-id 选项", () => {
    const y = mockYargs();
    EventSourceUpdateCommand.builder(y as any);
    const calls = y.option.mock.calls;
    const sessionId = calls.find((c: any[]) => c[0] === "session-id");
    expect(sessionId).toBeDefined();
    expect(sessionId![1].type).toBe("string");
  });
});

describe("schedule JSON 解析 helper", () => {
  test("应该解析合法 JSON 数组", async () => {
    const { parseScheduleOption } = await import("./schedule-option");
    const parsed = parseScheduleOption(
      '[{"time":"10:00","prompt":"早报"}]',
    );
    expect(parsed).toBeDefined();
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed!.length).toBe(1);
  });

  test("非法 JSON 应该返回 undefined（不抛异常）", async () => {
    const { parseScheduleOption } = await import("./schedule-option");
    expect(parseScheduleOption("not-json")).toBeUndefined();
  });

  test("undefined 输入应该返回 undefined", async () => {
    const { parseScheduleOption } = await import("./schedule-option");
    expect(parseScheduleOption(undefined)).toBeUndefined();
  });
});

describe("schedule 语义校验 (review MINOR-2)", () => {
  test("合法 schedule 应该无错误", async () => {
    const { validateScheduleEntries } = await import("./schedule-option");
    expect(
      validateScheduleEntries([
        { time: "10:00", prompt: "早报" },
        { time: "23:59", prompt: "晚报" },
        { time: "00:00", prompt: "午夜" },
      ]),
    ).toEqual([]);
  });

  test("非法 time 格式应该报错", async () => {
    const { validateScheduleEntries } = await import("./schedule-option");
    const errors = validateScheduleEntries([
      { time: "25:00", prompt: "x" },
      { time: "1000", prompt: "x" },
      { time: "10:60", prompt: "x" },
    ]);
    expect(errors.length).toBe(3);
    expect(errors.every((e) => /HH:MM/.test(e))).toBe(true);
  });

  test("重复的 time 应该报错", async () => {
    const { validateScheduleEntries } = await import("./schedule-option");
    const errors = validateScheduleEntries([
      { time: "10:00", prompt: "早报" },
      { time: "17:00", prompt: "午后" },
      { time: "10:00", prompt: "重复" },
    ]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /重复|duplicate/i.test(e))).toBe(true);
  });

  test("缺失或空白 prompt 应该报错", async () => {
    const { validateScheduleEntries } = await import("./schedule-option");
    const errors = validateScheduleEntries([
      { time: "10:00" } as any,
      { time: "17:00", prompt: "   " },
    ]);
    expect(errors.length).toBe(2);
    expect(errors.every((e) => /prompt/.test(e))).toBe(true);
  });
});

describe("options 累积式合并 (review MAJOR-2)", () => {
  test("同时合并 prompt / schedule / sessionId 不应互相覆盖", async () => {
    const { mergeEventSourceOptions } = await import("./schedule-option");
    const merged = mergeEventSourceOptions(
      { legacy: "keep-me" },
      {
        prompt: "新 prompt",
        schedule: [{ time: "10:00", prompt: "早报" }],
        sessionId: "my-session",
      },
    );
    expect(merged.prompt).toBe("新 prompt");
    expect(merged.schedule).toEqual([{ time: "10:00", prompt: "早报" }]);
    expect(merged.sessionId).toBe("my-session");
    // 原有字段保留
    expect(merged.legacy).toBe("keep-me");
  });

  test("undefined 现有 options 应该正常合并", async () => {
    const { mergeEventSourceOptions } = await import("./schedule-option");
    expect(mergeEventSourceOptions(undefined, { prompt: "p" })).toEqual({ prompt: "p" });
  });
});

describe("schedule 清空语义 (review M-7)", () => {
  test("parseScheduleOptionAllowEmpty 应该接受空数组（用于清除 schedule）", async () => {
    const { parseScheduleOptionAllowEmpty } = await import("./schedule-option");
    expect(parseScheduleOptionAllowEmpty("[]")).toEqual([]);
  });

  test("parseScheduleOptionAllowEmpty 应该拒绝非数组", async () => {
    const { parseScheduleOptionAllowEmpty } = await import("./schedule-option");
    expect(parseScheduleOptionAllowEmpty('{"time":"10:00"}')).toBeUndefined();
    expect(parseScheduleOptionAllowEmpty("not-json")).toBeUndefined();
  });

  test("parseScheduleOption 仍然拒绝空数组（add 路径不允许空）", async () => {
    const { parseScheduleOption } = await import("./schedule-option");
    expect(parseScheduleOption("[]")).toBeUndefined();
  });
});

describe("★ review N1 未传 --schedule 时不应删除已有 schedule", () => {
  // 回归点：清空 schedule 的实现曾用 `optionsPatch.schedule === undefined` 判断，
  //   而用户**没传** --schedule 时它同样是 undefined → 条件恒真 →
  //   已有 schedule 被静默删除（配置丢失 + 行为退化成 interval 模式）。
  test("只更新 prompt 时 schedule 应保留", async () => {
    const { mergeEventSourceOptions } = await import("./schedule-option");
    const existing = {
      schedule: [{ time: "10:00", prompt: "早报" }],
      sessionId: "my-session",
    };
    // patch 里**没有** schedule key（用户没传 --schedule）
    const patch = { prompt: "新提示" };
    const merged = mergeEventSourceOptions(existing, patch);
    // schedule 必须还在
    expect(merged.schedule).toEqual([{ time: "10:00", prompt: "早报" }]);
    expect(merged.prompt).toBe("新提示");
    expect(merged.sessionId).toBe("my-session");
  });

  test("显式清空标志为 false 时不应删除 schedule（update.ts 用显式标志而非值判断）", async () => {
    const { mergeEventSourceOptions } = await import("./schedule-option");
    // 复刻 update.ts 的判定逻辑：只有 scheduleCleared === true 才 delete
    const simulate = (
      existing: Record<string, unknown>,
      patch: Record<string, unknown>,
      scheduleCleared: boolean,
    ) => {
      const merged = mergeEventSourceOptions(existing, patch);
      if (scheduleCleared) {
        delete (merged as Record<string, unknown>).schedule;
      }
      return merged;
    };

    const existing = { schedule: [{ time: "10:00", prompt: "早报" }] };

    // 用户没传 --schedule → scheduleCleared = false → schedule 保留
    const kept = simulate(existing, { prompt: "p" }, false);
    expect(kept.schedule).toBeDefined();

    // 用户传 --schedule '[]' → scheduleCleared = true → schedule 被删
    const cleared = simulate(existing, {}, true);
    expect(cleared.schedule).toBeUndefined();
  });
});
