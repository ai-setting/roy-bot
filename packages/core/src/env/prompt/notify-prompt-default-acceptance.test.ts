/**
 * Task #5054 改动 3：default prompt「任务成功通知」小节补兜底句
 *
 * 背景：notify prompt（event-source-handlers.ts）已补上验收指令（改动 1/2）。
 * 但 notify prompt 是**一次性**的即时指令 —— 若它因故没送达 / 被裁剪 / agent 没照做，
 * system prompt 里的「任务验收职责」章节必须能独立兜住。
 *
 * 本文件锁死 default prompt 的「1. 任务成功通知（✅ completed）」小节包含：
 *   1. 「必须实际调用 task_complete 把任务落终态」类措辞
 *   2. 「只回消息不算完成」类语义
 *   3. 「不要因为验收不通过就 task_cancel（仅限用户明令）」类语义
 *
 * ⚠️ 同时锁死 roy prompt **不含**这些验收措辞（验收权在 default agent，
 *    roy 是运动员；roy prompt 改动 = 回归）。
 */

import { describe, expect, test } from "bun:test";

import { builtInPrompts } from "./prompts-index";

/** 取 default prompt 全文。 */
function defaultPrompt(): string {
  return builtInPrompts["default"];
}

/** 截取「### 1. 任务成功通知」小节到下一个「### 」之前。 */
function completedNoticeSection(): string {
  const text = defaultPrompt();
  const start = text.indexOf("### 1. 任务成功通知");
  expect(start).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const next = rest.indexOf("\n### ");
  return next === -1 ? rest : rest.slice(0, next);
}

describe("default prompt / 任务成功通知小节（#5054 改动 3）", () => {
  test("① 包含「必须实际调用 task_complete 把任务落终态」类措辞", () => {
    const section = completedNoticeSection();
    expect(section).toMatch(/必须实际调用/);
    expect(section).toContain("task_complete");
    expect(section).toMatch(/落终态/);
  });

  test("② 包含「只回消息不算完成」类语义", () => {
    const section = completedNoticeSection();
    expect(section).toMatch(/只回消息|不算完成|只回复/);
  });

  test("③ 明确「不要因验收不通过就 task_cancel；task_cancel 仅限用户明令」", () => {
    const section = completedNoticeSection();
    // ⚠️ 旧文案是「❌ 不值得继续 / 用户要求 → task_cancel」—— 只列了 task_cancel 的
    //   正向触发条件，没有**禁止**「验收不通过就 cancel」。必须锁定否定式措辞。
    expect(section).toMatch(
      /不要[^。\n]{0,40}task_cancel|task_cancel[^。\n]{0,40}仅限/,
    );
    expect(section).toMatch(/用户明令|用户要求|用户明确/);
  });

  test("④ 保留原有验收四步指引（task_get / goals 子项）", () => {
    const section = completedNoticeSection();
    expect(section).toContain("task_get");
    expect(section).toMatch(/goals/);
  });
});

describe("roy prompt / 不含验收措辞（#5054 回归护栏）", () => {
  test("roy prompt 不含「必须实际调用」兜底句", () => {
    const roy = builtInPrompts["roy"];
    expect(roy).not.toMatch(/必须实际调用/);
  });

  test("roy prompt 不含「只回消息不算完成」兜底句", () => {
    const roy = builtInPrompts["roy"];
    expect(roy).not.toMatch(/只回消息|不算完成/);
  });
});
