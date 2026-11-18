/**
 * @fileoverview Task #4834 — F3: task_complete 验收文案同源一致性测试
 *
 * 背景（reports/goals-criteria-rules-e2e-rebase.md §遗留 F3）：
 *   prompts-index.ts（default prompt 生命周期图）的 COMPLETE 步骤
 *   只写 "Verify all goals_and_expected_deliverables are met"，
 *   与工具描述（TASK_COMPLETE_DESCRIPTION 的「按子项逐条验收 +
 *   [TASK_COMPLETION_HINT] 核实义务」）**不同源** —— 文案漂移
 *   会稀释工具描述的遵循度。
 *
 * 修复方式：同源常量（completion-copy.ts 的
 * TASK_COMPLETE_ACCEPTANCE）—— 工具描述与 default prompt 都
 * 引用同一常量，本测试守住「两处文案一致」不被未来改动打破。
 */

import { describe, it, expect } from "bun:test";
import { builtInPrompts } from "../../prompt/prompts-index";
import { TASK_COMPLETE_DESCRIPTION } from "./complete-tool";
import { UpdateTaskToolSchema } from "./task-types";
import { TASK_COMPLETE_ACCEPTANCE } from "./completion-copy";

describe("Task #4834 — F3: COMPLETE 文案同源", () => {
  const { itemByItem, hintAnchor, verifyDuty } = TASK_COMPLETE_ACCEPTANCE;

  it("同源常量本身非空（锚点模块完整性）", () => {
    expect(itemByItem).toContain("逐条");
    expect(hintAnchor).toBe("TASK_COMPLETION_HINT");
    expect(verifyDuty).toContain("核实");
  });

  it("工具描述（TASK_COMPLETE_DESCRIPTION）含同源短语", () => {
    expect(TASK_COMPLETE_DESCRIPTION).toContain(itemByItem);
    expect(TASK_COMPLETE_DESCRIPTION).toContain(`[${hintAnchor}]`);
    expect(TASK_COMPLETE_DESCRIPTION).toContain(verifyDuty);
  });

  it("default prompt 的 COMPLETE 步骤含同源短语（与工具描述一致）", () => {
    const prompt = builtInPrompts["default"] || "";
    // COMPLETE 步骤必须与工具描述同源：逐条验收 + hint 锚点 + 核实义务
    expect(prompt).toContain(itemByItem);
    expect(prompt).toContain(`[${hintAnchor}]`);
    expect(prompt).toContain(verifyDuty);
  });

  it("update 工具 goals describe 仍含逐条验收措辞（回归护栏）", () => {
    // withLegacyTaskId 是 z.preprocess 包装 —— 真实 shape 在 _def.schema
    const inner: any =
      (UpdateTaskToolSchema as any)._def?.schema ?? UpdateTaskToolSchema;
    const shape = inner.shape ?? {};
    const describeText =
      shape.goals_and_expected_deliverables?.description || "";
    expect(describeText).toContain("逐条验收");
  });
});
