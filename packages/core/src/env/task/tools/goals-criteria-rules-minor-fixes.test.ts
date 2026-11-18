/**
 * @fileoverview Task #4833 — 交叉验证 MINOR-1/2/3 修复的断言测试
 *
 * DS review (Task #4833) 判定 ⚠️ PASS WITH MINOR，3 条 MINOR：
 *   MINOR-1: complete-tool.ts:41 残留旧文案「honestly note the discrepancy in
 *            your final report」，与「不许无视」形成第三个软出口 → 需删除/改写
 *   MINOR-2: UpdateTaskToolSchema.goals_and_expected_deliverables 无 describe，
 *            task_update 续期路径拿不到编号子项指引 → 需补 describe
 *   MINOR-3: create-tool.ts 的 MUST 对 longterm/cycle 类型无豁免，
 *            语义冲突（longterm/cycle 不走 complete 验收）→ 需加限定词
 */

import { describe, it, expect } from "bun:test";
import { createTaskTool } from "./create-tool";
import { TASK_COMPLETE_DESCRIPTION } from "./complete-tool";
import { CreateTaskToolSchema, UpdateTaskToolSchema } from "./task-types";
import type { TaskComponent } from "../task-component";

const mockTaskComponent = {
  createTask: async () => ({
    id: 1,
    title: "mock",
    description: "",
    status: "active" as const,
    priority: "medium" as const,
    type: "normal" as const,
    tags: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    progress: 0,
  }),
} as unknown as TaskComponent;

describe("MINOR-1: complete-tool 不应留「只在报告里说明差异」软出口", () => {
  it("不应再出现 'honestly note the discrepancy in your final report' 作为替代动作", () => {
    expect(TASK_COMPLETE_DESCRIPTION).not.toContain(
      "honestly note the discrepancy in your final report",
    );
  });

  it("旧软出口若保留，必须改写为「必须落到 task_operation_create 记录里」", () => {
    // 若原文案被改写而非删除，须显式要求落到操作记录，不能只在报告里提一句
    const hasLegacy = TASK_COMPLETE_DESCRIPTION.includes("discrepancy");
    if (hasLegacy) {
      expect(TASK_COMPLETE_DESCRIPTION).toMatch(/task_operation_create/);
      expect(TASK_COMPLETE_DESCRIPTION).toMatch(
        /must land in the operation record|必须落到操作记录里/i,
      );
      // 不能只说「在最终报告里说明差异」
      expect(TASK_COMPLETE_DESCRIPTION).not.toMatch(
        /discrepancy in your final report/i,
      );
    }
    // 无论如何都要保留「二选一」的硬规则
    expect(TASK_COMPLETE_DESCRIPTION).toMatch(/Never ignore it|不允许无视/i);
  });
});

describe("MINOR-2: UpdateTaskToolSchema 的 goals 参数应有 describe（续期路径）", () => {
  // ⚠️ UpdateTaskToolSchema 经 withLegacyTaskId → z.preprocess 包装成
  // ZodEffects，`.shape` 不在顶层，需解包 `_def.schema.shape`。
  const unwrapShape = (schema: unknown): Record<string, any> => {
    const anyS = schema as any;
    if (anyS?.shape) return anyS.shape;
    return anyS?._def?.schema?.shape ?? {};
  };

  it("task_update 的 goals 参数应有非空 describe", () => {
    const shape = unwrapShape(UpdateTaskToolSchema);
    expect(shape.goals_and_expected_deliverables).toBeDefined();
    const describeText =
      shape.goals_and_expected_deliverables.description || "";
    expect(describeText.length).toBeGreaterThan(0);
  });

  it("task_update 的 goals describe 应指向编号子项规则", () => {
    const shape = unwrapShape(UpdateTaskToolSchema);
    const describeText =
      shape.goals_and_expected_deliverables.description || "";
    expect(describeText).toMatch(/编号子项|numbered sub-?items?/i);
  });
});

describe("MINOR-3: create-tool 的 MUST 应对 longterm/cycle 有豁免", () => {
  it("description 应区分 normal 与 longterm/cycle 的强制程度", () => {
    const tool = createTaskTool(mockTaskComponent);
    const desc = tool.description || "";
    // 必须提到 longterm / cycle 的差异化处理
    expect(desc).toMatch(/longterm/i);
    expect(desc).toMatch(/cycle/i);
    // 且要说明对 longterm/cycle 是「建议」而非「MUST」
    expect(desc).toMatch(/建议|strongly recommend|should/i);
  });

  it("对 normal 类型的约束仍应保留（不能把 MUST 整体削弱）", () => {
    const tool = createTaskTool(mockTaskComponent);
    const desc = tool.description || "";
    expect(desc).toMatch(/MUST|must/i);
  });
});
