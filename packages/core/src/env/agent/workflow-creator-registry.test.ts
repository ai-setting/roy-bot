/**
 * Task #2194 (Phase 4 TDD) — RED phase coverage for `AgentRegistry.registerWorkflowCreator`.
 *
 * workflow-creator 是与 workflow-runner / workflow-extract 同层的 sub 类型子代理，
 * 但有 6 个 workflow_* 工具白名单（vs workflow-runner 的 5 个 vs workflow-extract 的 4 个）。
 * 它是**多轮对话式**协作（vs workflow-extract 的 one-shot 自动提取）。
 *
 * 这些测试必须在 GREEN 实现之前失败，因为:
 * - `registerWorkflowCreator` 方法在 main 分支上不存在
 * - 6 个工具白名单（包含 workflow_search 和 workflow_tag_list，是 workflow-extract 没有的）
 * - deniedTools=[delegate_task, stop_task] 防止嵌套委托
 * - maxIterations=30 显式锁定
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
    baseDir: "/tmp/test-roy-bot-workflow-creator-registry",
    fs: mockFs,
    fsPromises: mockFsPromises,
  });
}

describe("AgentRegistry.registerWorkflowCreator (Task #2194)", () => {
  test("registers agent with name 'workflow-creator'", () => {
    const reg = makeRegistry();
    reg.registerWorkflowCreator();
    expect(reg.get("workflow-creator")).toBeDefined();
  });

  test("registers as type='sub' (peer of workflow-runner / workflow-extract)", () => {
    const reg = makeRegistry();
    reg.registerWorkflowCreator();
    const agent = reg.get("workflow-creator")!;
    expect(agent.type).toBe("sub");
  });

  test("has systemPromptRef='workflow-creator'", () => {
    const reg = makeRegistry();
    reg.registerWorkflowCreator();
    const agent = reg.get("workflow-creator")!;
    expect(agent.systemPromptRef).toBe("workflow-creator");
  });

  test("allowedTools = 6 个 workflow_* + 4 个自验工具 (strict whitelist)", () => {
    const reg = makeRegistry();
    reg.registerWorkflowCreator();
    const agent = reg.get("workflow-creator")!;
    // 6 个设计/注册工具：list / get / search / tag_list / validate / add
    // ★ 2026-10-16（Task #4263）：增补 4 个「构建后自验」工具 ——
    //   bash（契约真实性校验）/ read_file（核对脚本输出标记）/
    //   workflow_run（冒烟真跑，DoD 硬门槛）/ workflow_run_status（轮询终态）。
    //   依据：曾交付假阳性 workflow（脚本名拼接错 / 回退脚本空跑 / 硬编码汇总骗过聚合，
    //   0/0/0 报 PASS），根因是「只有 DAG 结构校验，缺少语义校验 + 端到端真跑」。
    //   注意这组工具是修好 delegate 身份 bug（4430815b）之后才真正生效的 ——
    //   此前 sub-agent 一律降级 general、白名单从未被应用。
    expect(agent.allowedTools).toEqual(
      expect.arrayContaining([
        "workflow_list",
        "workflow_get",
        "workflow_search",
        "workflow_tag_list",
        "workflow_validate",
        "workflow_add",
      ]),
    );
    // 6 设计 + 4 自验 = 10
    expect(agent.allowedTools).toHaveLength(10);
  });

  test("deniedTools includes delegate_task and stop_task (no recursion)", () => {
    const reg = makeRegistry();
    reg.registerWorkflowCreator();
    const agent = reg.get("workflow-creator")!;
    expect(agent.deniedTools).toContain("delegate_task");
    expect(agent.deniedTools).toContain("stop_task");
  });

  test("maxIterations is locked at 60 (multi-turn + 冒烟回环修复)", () => {
    const reg = makeRegistry();
    reg.registerWorkflowCreator();
    // ★ 2026-10-16：30 → 60。阶段 4.5 契约校验 + 阶段 5.5 冒烟真跑 + 失败后
    // 回阶段 4 改 YAML 重跑的回环，需要更多轮次（Task #4263 §4.2 建议）。
    expect(reg.get("workflow-creator")!.maxIterations).toBe(60);
  });

  test("registering twice is idempotent", () => {
    const reg = makeRegistry();
    reg.registerWorkflowCreator();
    reg.registerWorkflowCreator(); // should not throw
    expect(reg.get("workflow-creator")).toBeDefined();
  });

  test("workflow-creator coexists with workflow-runner and workflow-extract (3 sub-agents)", () => {
    const reg = makeRegistry();
    reg.registerWorkflowRunner();
    reg.registerWorkflowExtractAgent();
    reg.registerWorkflowCreator();
    // 3 个 workflow 相关 sub-agent 都应注册
    expect(reg.get("workflow-runner")).toBeDefined();
    expect(reg.get("workflow-extract")).toBeDefined();
    expect(reg.get("workflow-creator")).toBeDefined();
    // 都是 type=sub
    expect(reg.get("workflow-creator")!.type).toBe("sub");
    expect(reg.get("workflow-runner")!.type).toBe("sub");
    expect(reg.get("workflow-extract")!.type).toBe("sub");
  });
});
