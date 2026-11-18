/**
 * @fileoverview CreateTaskTool description 卫生检查
 *
 * 验证 task_create 工具的 description（注入到 LLM 的提示词）中：
 * - 不应硬编码具体的 parent_task_id（如 619）
 * - 不应硬编码具体的项目绝对路径
 * - 应使用占位符或通用描述供不同部署使用
 * - 应指引 LLM 在调用前先 task_tree(depth=1) 决策 parent_task_id
 *
 * 这是修复 Code Review v2 报告 C2 (user message 硬编码路径与 parent_task_id) 的回归保护。
 */

import { describe, it, expect } from "bun:test";
import { createTaskTool } from "./create-tool";
import type { TaskComponent } from "../task-component";

describe("createTaskTool description hygiene", () => {
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

  it("description should not hardcode a specific parent_task_id number", () => {
    const tool = createTaskTool(mockTaskComponent);
    expect(tool.description).toBeDefined();
    // 硬编码具体 ID（如 #619 / 619）会让所有部署沿用同一 parent task，
    // 跨项目/重置过 root task 的用户会建到错误位置或污染线上任务表。
    expect(tool.description).not.toMatch(/parent_task_id\s*=\s*619\b/);
    expect(tool.description).not.toMatch(/root task #619\b/);
    expect(tool.description).not.toMatch(/root task #\d+\b/);
  });

  it("description should not hardcode a specific absolute project_path", () => {
    const tool = createTaskTool(mockTaskComponent);
    expect(tool.description).toBeDefined();
    // 硬编码具体项目路径（如 ~/work/...）会污染其他部署的提示词
    expect(tool.description).not.toMatch(/\/home\/[a-z_]+/);
    expect(tool.description).not.toMatch(/roy_world/);
    expect(tool.description).not.toMatch(/roy-bot\/?$/m);
  });

  it("description should instruct LLM to call task_tree before task_create", () => {
    // Task #2075 — we enhanced the description so the LLM first calls
    // task_tree(depth=1) and then decides parent_task_id via the
    // 3-path decision tree. Verify the new guidance is present.
    const tool = createTaskTool(mockTaskComponent);
    expect(tool.description).toBeDefined();
    expect(tool.description).toMatch(/task_tree/);
    expect(tool.description).toMatch(/depth\s*[:=]\s*1/);
    expect(tool.description).toMatch(/parent_task_id/);
    // Three decision paths
    expect(tool.description).toMatch(/Path A/);
    expect(tool.description).toMatch(/Path B/);
    expect(tool.description).toMatch(/Path C/);
    // Tree hygiene principles
    expect(tool.description).toMatch(/≤\s*10/); // root width cap
    expect(tool.description).toMatch(/≤\s*5/);  // depth cap
  });

  it("description should REQUIRE the agent to read and verify the TASK_CREATE_HINT", () => {
    // Task #4697 — 上一轮真端到端（#4687 用例 D）证明：hint 文案自称
    // 「仅供参考」+ roy prompt 无 hint 政策指引 → agent 只转述给用户等确认。
    // 这里把 tool description 从「may suggest ... read it」升级为
    // 「MUST read and verify ... Never ignore it」，给 agent 一条明确的
    // 行为契约：**必须核实，且必须表态（采纳或说明不采纳的理由）**。
    const tool = createTaskTool(mockTaskComponent);
    expect(tool.description).toBeDefined();
    expect(tool.description).toContain("[TASK_CREATE_HINT]");
    expect(tool.description).toMatch(/\bMUST\b/);
    expect(tool.description).toMatch(/verify/i);
    expect(tool.description).toMatch(/task_get/);
    expect(tool.description).toMatch(/task_update/);
    expect(tool.description).toMatch(/Never ignore it/i);
    // 必须保留「不采纳」出口 —— hint 是提示不是拦截
    expect(tool.description).toMatch(/why not adopted|not adopted/i);
    // 旧措辞已废弃
    expect(tool.description).not.toMatch(/may suggest/);
  });
});
