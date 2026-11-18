/**
 * Task #2164 (Phase 4 TDD) — RED phase coverage for `AgentRegistry.registerWorkflowRunner`.
 *
 * 这些测试必须在 GREEN 实现之前失败，因为:
 * - `registerWorkflowRunner` 方法在 main 分支上不存在（当前只有 `registerWorkflowAgent()`)。
 * - 替换语义：type 从 `primary` → `sub`，新增 `deniedTools`、`systemPromptRef`、`maxIterations`。
 * - `maxIterations: 30` 必须被显式锁住（防止 #2151 M3 "silent removal" 再次发生）。
 */
import { describe, expect, test, vi } from "vitest";
import { AgentRegistry } from "./agent-registry";

// Mirrors the DI shape used in packages/core/src/env/agent/agent-registry.test.ts
const mockFs = {
  existsSync: vi.fn(),
} as any;
const mockFsPromises = {
  readdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  unlink: vi.fn(),
} as any;
const mockPromptComponent = {
  getBuiltInPrompt: vi.fn(),
} as any;
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
    baseDir: "/tmp/test-roy-bot-workflow-runner-registry",
    fs: mockFs,
    fsPromises: mockFsPromises,
  });
}

describe("AgentRegistry.registerWorkflowRunner (Task #2164)", () => {
  test("registers agent with name 'workflow-runner'", () => {
    const reg = makeRegistry();
    reg.registerWorkflowRunner();
    expect(reg.get("workflow-runner")).toBeDefined();
  });

  test("registers as type='sub' (NOT primary mediator — closes #2151 M1 semantics)", () => {
    const reg = makeRegistry();
    reg.registerWorkflowRunner();
    const agent = reg.get("workflow-runner")!;
    expect(agent.type).toBe("sub");
  });

  test("has systemPromptRef='workflow-runner'", () => {
    const reg = makeRegistry();
    reg.registerWorkflowRunner();
    const agent = reg.get("workflow-runner")!;
    expect(agent.systemPromptRef).toBe("workflow-runner");
  });

  test("allowedTools is UNDEFINED (Task #2247 — Roy-style toolset, no whitelist)", () => {
    const reg = makeRegistry();
    reg.registerWorkflowRunner();
    const agent = reg.get("workflow-runner")!;
    // Task #2247: 移除 allowedTools 白名单。Roy 风格：除 deniedTools 外全部工具可用。
    // workflow_* 工具通过 prompt 引导使用，不强制白名单。
    expect(agent.allowedTools).toBeUndefined();
  });

  test("workflow-runner denies delegate_task and stop_task (no recursion)", () => {
    const reg = makeRegistry();
    reg.registerWorkflowRunner();
    const agent = reg.get("workflow-runner")!;
    expect(agent.deniedTools).toContain("delegate_task");
    expect(agent.deniedTools).toContain("stop_task");
  });

  test("maxIterations is locked at 30 (Task #2151 M3 finding prevention)", () => {
    const reg = makeRegistry();
    reg.registerWorkflowRunner();
    expect(reg.get("workflow-runner")!.maxIterations).toBe(30);
  });

  test("registering twice is idempotent", () => {
    const reg = makeRegistry();
    reg.registerWorkflowRunner();
    reg.registerWorkflowRunner(); // should not throw
    expect(reg.get("workflow-runner")).toBeDefined();
  });

  test("old registerWorkflowAgent method is REMOVED (not just renamed)", () => {
    const reg = makeRegistry();
    expect((reg as any).registerWorkflowAgent).toBeUndefined();
  });

  test("Task #2251: description identifies prompt-driven takeover without a runtime controller", () => {
    const reg = makeRegistry();
    reg.registerWorkflowRunner();
    const agent = reg.get("workflow-runner")!;
    expect(agent.description).toMatch(/prompt/i);
    expect(agent.description).not.toMatch(new RegExp("WorkflowRunnerFallback" + "Controller|fallback-controller"));
  });
});

describe("AgentRegistry.registerWorkflowRunner description contract (Task #2486)", () => {
  function getDescription(): string {
    const reg = makeRegistry();
    reg.registerWorkflowRunner();
    return reg.get("workflow-runner")!.description ?? "";
  }

  test("Task #2486: description 必须含 'workflow_name' 或 'workflow name'", () => {
    const desc = getDescription();
    expect(desc).toMatch(/workflow_name|workflow name/);
  });

  test("Task #2486: description 必须含 'search' 或 '搜索' 关键词 (search-first 兜底)", () => {
    const desc = getDescription();
    expect(desc).toMatch(/search|搜索|search-first/);
  });

  test("Task #2486: description 必须含 '指定' 或 'select' 关键词 (explicit 指定 workflow 名)", () => {
    const desc = getDescription();
    expect(desc).toMatch(/指定|select/);
  });

  test("Task #2486: description 必须禁止 '盲猜' / '绕过' / '跳过 schema 验证'", () => {
    const desc = getDescription();
    // 至少 1 个禁止词命中
    expect(desc).toMatch(/盲猜|绕过|跳过.*schema|跳过.*验证/);
  });
});
