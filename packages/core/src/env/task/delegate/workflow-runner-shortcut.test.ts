/**
 * Task #2164 (Phase 4 TDD, RED phase) — `BackgroundTaskManager.resolveEntryAgent()`
 * single-layer canonicalization.
 *
 * 核心 divergence vs reference #2146:
 * - reference 在 `createDelegateTool().execute()` 调用 `detectWorkflowShortcut()` + 在
 *   `handleBackgroundTask()` 二次规范化。两层 rewriting。
 * - beta 只在 `resolveEntryAgent()` 一次处理 5 个 legacy yaml name → "workflow-runner"，
 *   handleBackgroundTask() 直接消费 entryAgent 结果不做二次检测。
 *
 * 这个测试文件 RED 阶段应该失败，因为:
 * - resolveEntryAgent 当前不识别 5 个 legacy yaml name（仅识别 workflow 类型 agent），
 * - 也不暴露 lastOriginalWorkflowName 状态给 caller。
 */
import { describe, expect, test, beforeEach, vi } from "vitest";
import {
  BackgroundTaskManager,
  handleBackgroundTask,
  WORKFLOW_COMPAT_ALIASES,
} from "./delegate-tool";
import type { AgentComponent } from "../../agent";
import type { AgentRegistry } from "../../agent/agent-registry";

/**
 * 构造一个 mock AgentComponent, 让 registry 只包含 workflow-runner。
 */
function makeAgentComponentWithWorkflowRunner(): AgentComponent {
  const registry = {
    get: vi.fn((name: string) => {
      if (name === "workflow-runner") {
        return {
          name: "workflow-runner",
          type: "sub",
          systemPromptRef: "workflow-runner",
          deniedTools: ["delegate_task", "stop_task"],
          maxIterations: 30,
        };
      }
      return undefined;
    }),
    getAllEntries: vi.fn(() => []),
  } as unknown as AgentRegistry;

  const agentComponent = {
    getRegistry: vi.fn(() => registry),
  } as unknown as AgentComponent;

  return agentComponent;
}

/**
 * 构造一个 mock AgentComponent, 让 registry 包含一个 workflow-type agent
 * 带 explicit entryAgent + workflow-runner。
 */
function makeAgentComponentWithWorkflowAgent(): AgentComponent {
  const registry = {
    get: vi.fn((name: string) => {
      if (name === "weekly-report") {
        return {
          name: "weekly-report",
          type: "workflow",
          workflow: "weekly-report-workflow",
          entryAgent: "workflow-runner",
        };
      }
      if (name === "workflow-runner") {
        return {
          name: "workflow-runner",
          type: "sub",
          systemPromptRef: "workflow-runner",
          deniedTools: [],
          maxIterations: 30,
        };
      }
      return undefined;
    }),
  } as unknown as AgentRegistry;

  const agentComponent = {
    getRegistry: vi.fn(() => registry),
  } as unknown as AgentComponent;

  return agentComponent;
}

function makeManager(agentComponent?: AgentComponent): BackgroundTaskManager {
  const env = {
    getComponent: (name: string) =>
      name === "agent" ? agentComponent : undefined,
    pushEnvEvent: () => {},
  };
  return new BackgroundTaskManager(env);
}

describe("BackgroundTaskManager.resolveEntryAgent — single-layer compat canonicalization (Task #2164)", () => {
  test("WORKFLOW_COMPAT_ALIASES contains the 5 legacy yaml names", () => {
    expect(WORKFLOW_COMPAT_ALIASES).toBeDefined();
    expect(WORKFLOW_COMPAT_ALIASES.has("strict-task-agent")).toBe(true);
    expect(WORKFLOW_COMPAT_ALIASES.has("code-review")).toBe(true);
    expect(WORKFLOW_COMPAT_ALIASES.has("bench-agent-host")).toBe(true);
    expect(WORKFLOW_COMPAT_ALIASES.has("workspace-analyzer")).toBe(true);
    expect(WORKFLOW_COMPAT_ALIASES.has("test-workflow-agent")).toBe(true);
  });

  describe("5 legacy yaml names — each resolves to 'workflow-runner'", () => {
    for (const alias of [
      "strict-task-agent",
      "code-review",
      "bench-agent-host",
      "workspace-analyzer",
      "test-workflow-agent",
    ]) {
      test(`resolveEntryAgent('${alias}') returns 'workflow-runner'`, () => {
        const mgr = makeManager(makeAgentComponentWithWorkflowRunner());
        expect(mgr.resolveEntryAgent(alias)).toBe("workflow-runner");
      });
    }
  });

  test("non-compat names like 'general' pass through (return undefined)", () => {
    const mgr = makeManager(makeAgentComponentWithWorkflowRunner());
    expect(mgr.resolveEntryAgent("general")).toBeUndefined();
    expect(mgr.resolveEntryAgent("roy")).toBeUndefined();
    expect(mgr.resolveEntryAgent("explore")).toBeUndefined();
  });

  test("workflow-type agent with explicit entryAgent returns that entryAgent", () => {
    const mgr = makeManager(makeAgentComponentWithWorkflowAgent());
    expect(mgr.resolveEntryAgent("weekly-report")).toBe("workflow-runner");
  });

  test("workflow-type agent without entryAgent returns DEFAULT_WORKFLOW_ENTRY_AGENT (workflow-runner)", () => {
    const registry = {
      get: vi.fn((name: string) => {
        if (name === "weekly-report-no-entry")
          return {
            name: "weekly-report-no-entry",
            type: "workflow",
            workflow: "weekly-workflow",
            // entryAgent 不设置
          };
        return undefined;
      }),
    } as unknown as AgentRegistry;
    const agentComponent = {
      getRegistry: vi.fn(() => registry),
    } as unknown as AgentComponent;
    const mgr = makeManager(agentComponent);
    expect(mgr.resolveEntryAgent("weekly-report-no-entry")).toBe(
      "workflow-runner",
    );
  });
});

/**
 * handleBackgroundTask 集成测试: 验证 single-layer 后, caller 直接消费 entryAgent
 * 就能拿到正确的 originalWorkflowName, 不需要二次检测。
 */
describe("handleBackgroundTask — single-layer routing (Task #2164)", () => {
  let createTaskSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createTaskSpy = vi.fn(async (_opts: any) => ({
      taskId: "bg_123",
      subSessionId: "sub_456",
    }));
  });

  test("compat alias 'strict-task-agent' → actualSubagentType=workflow-runner, originalWorkflowName=strict-task-agent, prompt wrapped", async () => {
    const mgr = makeManager(makeAgentComponentWithWorkflowRunner());
    (mgr as any).createTask = createTaskSpy;

    const out = await handleBackgroundTask(
      mgr,
      "parent_session_id",
      "run strict-task-agent",
      "do task X",
      "strict-task-agent",
      600000,
    );

    expect(out.success).toBe(true);
    const captured = createTaskSpy.mock.calls[0][0];
    expect(captured.subagentType).toBe("workflow-runner");
    expect(captured.originalWorkflowName).toBe("strict-task-agent");
    // prompt must be wrapped (contains <workflow_name>strict-task-agent</workflow_name>)
    expect(captured.prompt).toContain("<workflow_name>strict-task-agent</workflow_name>");
    expect(captured.prompt).toContain("do task X");
  });

  test("non-shortcut 'general' → passes through unchanged (no originalWorkflowName, prompt not wrapped)", async () => {
    const mgr = makeManager(makeAgentComponentWithWorkflowRunner());
    (mgr as any).createTask = createTaskSpy;

    await handleBackgroundTask(
      mgr,
      "parent_session_id",
      "research task",
      "research X",
      "general",
      600000,
    );

    const captured = createTaskSpy.mock.calls[0][0];
    expect(captured.subagentType).toBe("general");
    expect(captured.originalWorkflowName).toBeUndefined();
    expect(captured.prompt).toBe("research X");
  });
});
