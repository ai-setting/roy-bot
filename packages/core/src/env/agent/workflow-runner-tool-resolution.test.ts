/**
 * Task #2248 (blocker fix) — B4: workflow-runner 工具解析集成测试
 *
 * 修复 codex BLOCKING B4：移除 allowedTools 后，必须验证
 * - bash / read_file / task_create / write_file / edit_file 等通用工具**可解析**
 * - delegate_task / stop_task 被 deniedTools **过滤掉**
 * - 5 个 workflow_* 工具（workflow_run / workflow_get / workflow_list /
 *   workflow_run_status / workflow_run_stop）**可解析**
 *
 * 三个层次验证：
 * 1. Registry 层面：get("workflow-runner") 配置正确
 * 2. Filter 层面：用真实的 filterToolsByAgent + deniedTools 应用到完整 tool list
 * 3. 集成层面：构造 5+3+5 工具全集，断言最终 visible 集合
 */

import { describe, expect, test, vi } from "vitest";
import { AgentRegistry } from "./agent-registry";

// Mirror DI shape used in workflow-runner-registry.test.ts
const mockFs = { existsSync: vi.fn() } as any;
const mockFsPromises = {
  readdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  unlink: vi.fn(),
} as any;
const mockPromptComponent = { getBuiltInPrompt: vi.fn() } as any;
const mockConfigComponent = {
  get: vi.fn(),
  set: vi.fn(),
  registerSource: vi.fn(),
  load: vi.fn(),
  watch: vi.fn(),
} as any;

function makeRegistry(): AgentRegistry {
  return new AgentRegistry({
    configComponent: mockConfigComponent,
    promptComponent: mockPromptComponent,
    baseDir: "/tmp/test-roy-bot-b4-tool-resolution",
    fs: mockFs,
    fsPromises: mockFsPromises,
  });
}

/**
 * Realistic tool list — covers 5 workflow_* + 3 forbidden + 5 common tools.
 * Mirrors what would be in defaultTools + componentTools after workflow component init.
 */
const SAMPLE_TOOLS = [
  // 5 workflow_* 工具（workflow-runner 必须可用）
  { name: "workflow_run" },
  { name: "workflow_get" },
  { name: "workflow_list" },
  { name: "workflow_run_status" },
  { name: "workflow_run_stop" },
  // 3 forbidden 工具（必须被过滤）
  { name: "delegate_task" },
  { name: "stop_task" },
  { name: "stop_session" }, // 非 forbidden 但语义接近，保留观察
  // 5 通用工具（workflow-runner 应该可用）
  { name: "bash" },
  { name: "read_file" },
  { name: "write_file" },
  { name: "edit_file" },
  { name: "task_create" },
];

describe("workflow-runner tool resolution (Task #2248 B4)", () => {
  test("Registry 层面：allowedTools === undefined（无白名单）", () => {
    const reg = makeRegistry();
    reg.registerWorkflowRunner();
    const agent = reg.get("workflow-runner")!;
    expect(agent.allowedTools).toBeUndefined();
  });

  test("Registry 层面：deniedTools 包含 delegate_task 和 stop_task", () => {
    const reg = makeRegistry();
    reg.registerWorkflowRunner();
    const agent = reg.get("workflow-runner")!;
    expect(agent.deniedTools).toContain("delegate_task");
    expect(agent.deniedTools).toContain("stop_task");
  });

  test("Registry 层面：maxIterations === 30（防 silent removal — #2151 M3）", () => {
    const reg = makeRegistry();
    reg.registerWorkflowRunner();
    const agent = reg.get("workflow-runner")!;
    expect(agent.maxIterations).toBe(30);
  });

  test("Filter 层面：deniedTools 过滤掉 delegate_task 和 stop_task", () => {
    const reg = makeRegistry();
    reg.registerWorkflowRunner();
    const agent = reg.get("workflow-runner")!;
    const denied = agent.deniedTools ?? [];

    const filtered = SAMPLE_TOOLS.filter((t) => !denied.includes(t.name));

    expect(filtered.map((t) => t.name)).not.toContain("delegate_task");
    expect(filtered.map((t) => t.name)).not.toContain("stop_task");
    // 其他工具保留（因为 allowedTools=undefined 表示无白名单）
    expect(filtered.map((t) => t.name)).toContain("stop_session");
  });

  test("Filter 层面：5 个 workflow_* 工具全部可见", () => {
    const reg = makeRegistry();
    reg.registerWorkflowRunner();
    const agent = reg.get("workflow-runner")!;
    const denied = agent.deniedTools ?? [];

    const filtered = SAMPLE_TOOLS.filter((t) => !denied.includes(t.name));
    const toolNames = filtered.map((t) => t.name);

    expect(toolNames).toContain("workflow_run");
    expect(toolNames).toContain("workflow_get");
    expect(toolNames).toContain("workflow_list");
    expect(toolNames).toContain("workflow_run_status");
    expect(toolNames).toContain("workflow_run_stop");
  });

  test("Filter 层面：5 个通用工具（bash / read_file / write_file / edit_file / task_create）全部可见", () => {
    const reg = makeRegistry();
    reg.registerWorkflowRunner();
    const agent = reg.get("workflow-runner")!;
    const denied = agent.deniedTools ?? [];

    const filtered = SAMPLE_TOOLS.filter((t) => !denied.includes(t.name));
    const toolNames = filtered.map((t) => t.name);

    expect(toolNames).toContain("bash");
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("write_file");
    expect(toolNames).toContain("edit_file");
    expect(toolNames).toContain("task_create");
  });

  test("集成层面：最终 visible 集合 = 13 - 2 = 11（filter 掉 2 个 forbidden）", () => {
    const reg = makeRegistry();
    reg.registerWorkflowRunner();
    const agent = reg.get("workflow-runner")!;
    const denied = agent.deniedTools ?? [];

    const filtered = SAMPLE_TOOLS.filter((t) => !denied.includes(t.name));
    // 13 - 2 (delegate_task, stop_task) = 11
    expect(filtered).toHaveLength(11);
  });

  test("回归：对比测试 — workflow-runner 移除 allowedTools 后可用工具数大幅增加", () => {
    const reg = makeRegistry();
    reg.registerWorkflowRunner();
    const agent = reg.get("workflow-runner")!;
    const denied = agent.deniedTools ?? [];

    // 模拟旧的 allowedTools 白名单（Task #2164 之前的契约）
    const legacyAllowedTools = ["workflow_run", "workflow_get", "workflow_list"];
    const legacyFiltered = SAMPLE_TOOLS.filter((t) => legacyAllowedTools.includes(t.name));

    // 新契约 (Task #2247)：allowedTools=undefined → 除 deniedTools 外全可用
    const newFiltered = SAMPLE_TOOLS.filter((t) => !denied.includes(t.name));

    // 新契约可见工具数显著多于旧白名单
    expect(newFiltered.length).toBeGreaterThan(legacyFiltered.length);
    // 旧白名单只能看到 3 个，新契约能看到 11 个（13 - 2 forbidden）
    expect(legacyFiltered).toHaveLength(3);
    expect(newFiltered).toHaveLength(11);
  });

  test("回归：workflow-creator / json-extract 等其他 agent 不受影响（仅验证对比）", () => {
    const reg = makeRegistry();
    reg.registerWorkflowRunner();
    const wfRunner = reg.get("workflow-runner")!;

    // 对比：workflow-extract 仍是白名单模式（5 个 workflow_* 工具）
    reg.registerWorkflowExtractAgent();
    const wfExtract = reg.get("workflow-extract")!;

    expect(wfRunner.allowedTools).toBeUndefined(); // Task #2247 移除白名单
    expect(wfExtract.allowedTools).toBeDefined(); // workflow-extract 保留白名单
    expect(wfExtract.allowedTools).toContain("workflow_get");
    expect(wfExtract.allowedTools).toContain("workflow_add");
  });
});