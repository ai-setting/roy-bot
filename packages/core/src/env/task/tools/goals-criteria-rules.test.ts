/**
 * @fileoverview Task #4791 — goals 子项拆分规则 + complete 验收描述 断言测试
 *
 * 用户指令：在 task create 工具的描述和 goals 栏位说明中添加子项拆分规则；
 * task complete 工具描述中说「根据子项进行验收」。
 *
 * 规则来源（Task #4768 实验结论）：
 *   goals 应写成**可逐条验收的编号子项**，每条是一个可判的
 *   交付/动作，避免一句话模糊目标 —— completion hook 才能逐条
 *   对照操作记录链验收。
 *   四原子形态参考：文件断言 / 进程断言 / 测试断言 / 状态断言。
 */

import { describe, it, expect } from "bun:test";
import { createTaskTool } from "./create-tool";
import { TASK_COMPLETE_DESCRIPTION } from "./complete-tool";
import { CreateTaskToolSchema } from "./task-types";
import type { TaskComponent } from "../task-component";

// Mock minimal TaskComponent for type compat
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

describe("task_create goals 子项拆分规则 (Task #4791)", () => {
  it("description 应包含 goals 编号子项拆分规则", () => {
    const tool = createTaskTool(mockTaskComponent);
    expect(tool.description).toBeDefined();
    // 核心规则：goals 写成可逐条验收的编号子项
    expect(tool.description).toMatch(/编号子项|numbered sub-?items/i);
    // 规则动机：completion hook 逐条对照验收
    expect(tool.description).toMatch(/逐条验收|item-?by-?item/i);
  });

  it("description 应包含四原子形态参考（#4768）", () => {
    const tool = createTaskTool(mockTaskComponent);
    expect(tool.description).toContain("文件断言");
    expect(tool.description).toContain("进程断言");
    expect(tool.description).toContain("测试断言");
    expect(tool.description).toContain("状态断言");
  });

  it("description 应包含反模式警告（一句话模糊目标）", () => {
    const tool = createTaskTool(mockTaskComponent);
    // 反模式：一句话模糊目标 → hook 无法逐条对照
    expect(tool.description).toMatch(/模糊|vague/i);
  });

  it("schema 的 goals 参数 describe 应同步包含拆分规则", () => {
    const shape = CreateTaskToolSchema.shape;
    expect(shape.goals_and_expected_deliverables).toBeDefined();
    const describeText =
      shape.goals_and_expected_deliverables.description || "";
    expect(describeText).toMatch(/编号子项|numbered sub-?items/i);
    expect(describeText).toContain("文件断言");
  });
});

describe("task_complete 按子项验收描述 (Task #4791)", () => {
  it("description 应说明 completion hook 按 goals 子项逐条验收", () => {
    expect(TASK_COMPLETE_DESCRIPTION).toBeDefined();
    expect(TASK_COMPLETE_DESCRIPTION).toMatch(/子项|sub-?items?/i);
    expect(TASK_COMPLETE_DESCRIPTION).toMatch(/逐条|item-?by-?item/i);
  });

  it("description 应包含 hint 核实义务文案（与 create 侧一致）", () => {
    expect(TASK_COMPLETE_DESCRIPTION).toContain("TASK_COMPLETION_HINT");
    expect(TASK_COMPLETE_DESCRIPTION).toMatch(/核实|verify/i);
    // 二选一：重开继续 / 说明理由
    expect(TASK_COMPLETE_DESCRIPTION).toMatch(/重开|reopen/i);
    expect(TASK_COMPLETE_DESCRIPTION).toMatch(/说明理由|state why/i);
    // 不允许无视
    expect(TASK_COMPLETE_DESCRIPTION).toMatch(/Never ignore it|不允许无视/i);
  });
});
