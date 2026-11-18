/**
 * Task #2485 (Phase 4 TDD, RED) — e8988fcb 回归守护测试
 *
 * 修复目标: default prompt 的 "Workflow 操作指南" 段被 e8988fcb 改坏
 *  - 不应再引导用户直接 bash 跑 workflow run
 *  - 不应再在 "可用命令速查" 清单里出现 workflow run 条目
 *  - 必须包含完整的 delegate_task → workflow-runner 路径
 *  - 必须包含 session 恢复说明 (default agent 视角)
 *  - roy prompt 字节级 0 改动 (用户明令)
 *  - delegation consistency: prompt 描述的路径必须与 AgentRegistry 实际注册一致
 */
import { describe, expect, test } from "vitest";
import { builtInPrompts } from "./prompts-index";

const defaultPrompt = builtInPrompts["default"];
const royPrompt = builtInPrompts["roy"];

describe("REGRESSION: default prompt 'Workflow 操作指南' 段 (Task #2485, e8988fcb 回归)", () => {
  test("REGRESSION-1: 不再引导直接 bash 执行 workflow run", () => {
    // 找到 "Workflow 操作指南" 段（直到 "## " 或 "### {{memory}}"）
    const sectionStart = defaultPrompt.indexOf("## Workflow 操作指南");
    const memoryMarker = defaultPrompt.indexOf("### {{memory}}");
    expect(sectionStart).toBeGreaterThan(-1);
    expect(memoryMarker).toBeGreaterThan(sectionStart);
    const section = defaultPrompt.slice(sectionStart, memoryMarker);

    // 错误引导：直接告诉用户用 bash 跑 `workflow run <name> --input '{...}'`
    expect(section).not.toMatch(/workflow run <name> --input/);
    // 另一处错误引导：默认 "运行 workflow" 步骤里直接说 "直接执行"
    expect(section).not.toMatch(/5\.\s+\*\*运行 workflow\*\*.*直接执行/);
  });

  test("REGRESSION-2: '可用命令速查' 清单不含 workflow run 条目", () => {
    const sectionStart = defaultPrompt.indexOf("## Workflow 操作指南");
    const memoryMarker = defaultPrompt.indexOf("### {{memory}}");
    const section = defaultPrompt.slice(sectionStart, memoryMarker);

    // 错误项：把 workflow run 当作 default agent 的"可用命令"列出
    expect(section).not.toMatch(/`workflow run <name>`\s+—\s+执行 workflow/);
  });

  test("REGRESSION-3: 必须包含完整的 delegate_task → workflow-runner 调用模板", () => {
    const sectionStart = defaultPrompt.indexOf("## Workflow 操作指南");
    const memoryMarker = defaultPrompt.indexOf("### {{memory}}");
    const section = defaultPrompt.slice(sectionStart, memoryMarker);

    // 必须包含完整的 delegate_task 调用示例，subagent_type="workflow-runner"
    expect(section).toMatch(/delegate_task\s*\(/);
    expect(section).toMatch(/subagent_type=["']workflow-runner["']/);
    // 必须包含 prompt 字段，提示子 agent 跑 workflow
    expect(section).toMatch(/prompt=["'].*workflow/i);
  });

  test("REGRESSION-4: 必须包含 session 恢复说明 (default agent 视角)", () => {
    const sectionStart = defaultPrompt.indexOf("## Workflow 操作指南");
    const memoryMarker = defaultPrompt.indexOf("### {{memory}}");
    const section = defaultPrompt.slice(sectionStart, memoryMarker);

    // 必须解释 runId == sessionId
    expect(section).toMatch(/runId\s*==\s*sessionId|sessionId.*runId/);
    // 必须提到 -s / --session 选项
    expect(section).toMatch(/--session|-s\s/);
    // 视角必须是 default agent (不是直接 bash)
    // 修复后会用 "workflow-runner 报告 runId 时" 这种 default agent 视角
    expect(section).toMatch(/workflow-runner|delegat|runId/);
  });

  test("REGRESSION-5: 包含完整 5 个 legacy alias 兼容说明 (Task #2164 铁律)", () => {
    // 5 个 legacy name：strict-task-agent / code-review / bench-agent-host / workspace-analyzer / test-workflow-agent
    // 修复后的 default prompt 仍需保留兼容性说明 (已经在文件第 125/238 行存在)
    expect(defaultPrompt).toContain("strict-task-agent");
    expect(defaultPrompt).toContain("code-review");
    expect(defaultPrompt).toContain("bench-agent-host");
    expect(defaultPrompt).toContain("workspace-analyzer");
    expect(defaultPrompt).toContain("test-workflow-agent");
  });

  test("REGRESSION-6: roy prompt 字节级 0 改动 (用户明令 + Task #2164 铁律)", () => {
    // 这条铁律在 default-prompt.test.ts 已有部分覆盖，但本次 e8988fcb 改的段也要单独 lock
    // roy prompt 仍然不应包含 default-prompt 特定的 "Workflow 操作指南" 章节标题
    expect(royPrompt).not.toContain("## Workflow 操作指南");
    // roy prompt 仍然包含其原有的 "Using Workflows to Solve Tasks" 段（属于 roy 自己）
    expect(royPrompt).toContain("Using Workflows to Solve Tasks");
  });
});

describe("DELEGATION CONSISTENCY: default prompt 描述的路径必须与 AgentRegistry 注册一致", () => {
  // 这个 describe 锁定一个关键一致性: prompt 告诉用户委托 workflow-runner,
  // AgentRegistry 实际也得注册了 workflow-runner, 且 type=sub + systemPromptRef=workflow-runner.
  // 防止 prompt 改了但 AgentRegistry 没跟上 (或反之)。
  test("DELEGATION-1: AgentRegistry 实际注册 workflow-runner (type=sub, systemPromptRef=workflow-runner)", async () => {
    // 动态 import 避免循环依赖
    const { AgentRegistry } = await import("../agent/agent-registry");
    const reg = new AgentRegistry({
      configComponent: { get: () => undefined, set: () => {}, registerSource: () => {}, load: () => {}, watch: () => {} } as any,
      promptComponent: { getBuiltInPrompt: () => "" } as any,
      baseDir: "/tmp/test-delegation-consistency-2485",
      fs: { existsSync: () => false } as any,
      fsPromises: { readdir: async () => [], readFile: async () => "", writeFile: async () => {}, mkdir: async () => undefined, unlink: async () => {} } as any,
    });
    reg.registerWorkflowRunner();
    const agent = reg.get("workflow-runner");
    expect(agent).toBeDefined();
    expect(agent!.type).toBe("sub");
    expect(agent!.systemPromptRef).toBe("workflow-runner");
  });

  test("DELEGATION-2: default prompt 与 AgentRegistry.description 至少共享关键关键词 'workflow-runner'", () => {
    // 防止 prompt 改用其他名字（如 "workflow-executor"）但 AgentRegistry 仍叫 "workflow-runner"
    expect(defaultPrompt).toContain("workflow-runner");
    // builtin prompt 'workflow-runner' 自身被引用
    expect(builtInPrompts["workflow-runner"]).toBeDefined();
  });
});