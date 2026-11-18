/**
 * Task #2164 (Phase 4 TDD, RED phase) — `builtInPrompts['default']` migration.
 *
 * 验收要点:
 * - receptionist agent 的 default prompt 必须提及 workflow-runner (新中介名)
 * - 必须给出 delegate_task 示例, 用 subagent_type='workflow-runner'
 * - roy agent prompt 完全不动 (合规铁律: 必须 0 改动)
 * - 5 个 legacy yaml 名称必须在 default prompt 中作为兼容 alias 列出
 *
 * 与 reference #2146 的差异:
 * - reference 在 review 期间才修这些; beta 一次性按 plan 改完, 更彻底覆盖 5 个 alias.
 */
import { describe, expect, test } from "vitest";
import { builtInPrompts } from "./prompts-index";

describe("builtInPrompts['default'] migration (Task #2164)", () => {
  const defaultPrompt = builtInPrompts["default"];

  test("mentions 'workflow-runner' as sub-agent for workflow execution", () => {
    expect(defaultPrompt).toContain("workflow-runner");
  });

  test("lists all 5 legacy yaml aliases as compatibility names", () => {
    expect(defaultPrompt).toContain("strict-task-agent");
    expect(defaultPrompt).toContain("code-review");
    expect(defaultPrompt).toContain("bench-agent-host");
    expect(defaultPrompt).toContain("workspace-analyzer");
    expect(defaultPrompt).toContain("test-workflow-agent");
  });

  test("contains delegate_task example using subagent_type='workflow-runner'", () => {
    expect(defaultPrompt).toMatch(/subagent_type.*workflow-runner/);
  });
});

describe("builtInPrompts['default'] subagent 工作模式铁律 (Task #2486)", () => {
  const defaultPrompt = builtInPrompts["default"];

  test("default prompt 必须说明'选了 subagent 后必须遵循该 subagent 的工作模式'", () => {
    // 关键铁律: 选了某个 subagent 后，不能用自己的方式硬塞任务
    expect(defaultPrompt).toMatch(/subagent.*工作模式|sub-agent.*工作模式|遵循.*subagent/i);
  });

  test("🥈 Workflow runner 段必须展示模式 A — 传具体 workflow_name", () => {
    // 模式 A 模板必须含 delegate_task + subagent_type=workflow-runner + 提到具体 workflow
    const runnerStart = defaultPrompt.indexOf("### 🥈 Workflow runner");
    const creatorStart = defaultPrompt.indexOf("### 🥉 Workflow creator");
    expect(runnerStart).toBeGreaterThan(-1);
    expect(creatorStart).toBeGreaterThan(runnerStart);
    const section = defaultPrompt.slice(runnerStart, creatorStart);

    expect(section).toMatch(/subagent_type=["']workflow-runner["']/);
    // 模式 A: prompt 里指定具体 workflow 名
    expect(section).toMatch(/prompt.*workflow\s+\w+/);
  });

  test("🥈 Workflow runner 段必须展示模式 B — search-first 兜底", () => {
    const runnerStart = defaultPrompt.indexOf("### 🥈 Workflow runner");
    const creatorStart = defaultPrompt.indexOf("### 🥉 Workflow creator");
    expect(runnerStart).toBeGreaterThan(-1);
    expect(creatorStart).toBeGreaterThan(runnerStart);
    const section = defaultPrompt.slice(runnerStart, creatorStart);

    // 模式 B: prompt 指示 sub-agent 先 search-first
    expect(section).toMatch(/workflow_search|workflow_list|workflow_get|workflow tag list/);
    expect(section).toMatch(/search-first|搜索|自行.*选定|自行.*选择/);
  });

  test("## Workflow 操作指南 段必须明确 workflow_name 必传/search-first 二选一", () => {
    const guideStart = defaultPrompt.indexOf("## Workflow 操作指南");
    expect(guideStart).toBeGreaterThan(-1);
    const section = defaultPrompt.slice(guideStart, guideStart + 3000);

    expect(section).toMatch(/workflow\s*name|workflow\s*名/);
    // 提到 search-first 替代模板
    expect(section).toMatch(/search-first|搜索/);
  });
});

describe("builtInPrompts['roy'] is NOT touched (Task #2164 铁律)", () => {
  const royPrompt = builtInPrompts["roy"];

  test("roy prompt exists and is non-empty", () => {
    expect(royPrompt).toBeDefined();
    expect(royPrompt.length).toBeGreaterThan(100);
  });

  test("roy prompt does NOT contain 'workflow-runner' (must stay 0-changed)", () => {
    // 验收铁律: roy prompt 必须 0 改动, 不能因为 beta 重构引入新关键词
    expect(royPrompt).not.toContain("workflow-runner");
  });

  test("roy prompt still mentions legacy workflow names (compatibility preserved)", () => {
    // 在 roy prompt 中, 旧 workflow 名 作为兼容性标识仍存在
    expect(royPrompt).toMatch(/strict-task-agent|workflow-agent|workflow/);
  });
});

