/**
 * @fileoverview Task #5179 v2 — delegate user 消息永不嵌 basePrompt
 *
 * 用户明令（2026-11-08 13:55）：像 default 智能体一样——调用 LLM 时
 * 再构建 system prompt。落库的 user 消息只含任务指令，永不嵌
 * agent prompt（basePrompt）。
 *
 * 身份设定走运行时注入：ensureSubAgentRegistered 把 basePrompt 注册为
 * agent 的 systemPrompt，AgentComponent.buildMessages 每次 run 单独
 * 构建 system role 消息（不落库）；recordSessionMessages 跳过 system。
 *
 * 断言对象：handle_query 收到的 prompt（即落库的 user 消息内容）。
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createDelegateTool } from "./delegate-tool";
import type { Tool } from "../../tool/types";

const BASE_PROMPT = [
  "You are TestAgent, a specialized sub-agent.",
  "UNIQUE_BASE_PROMPT_MARKER_5179",
  "Complete the task: {task_description}",
].join("\n");

/**
 * Metadata-propagating in-memory session component（真实 Session 扁平形状）。
 */
function makeSessionComponent() {
  const store = new Map<string, any>();
  let counter = 0;
  return {
    _store: store,
    get: vi.fn(async (id: string) => {
      // parent session 也返回（createTask 需要校验 parent 存在）
      if (!store.has(id)) {
        store.set(id, {
          id,
          title: id,
          directory: "/tmp",
          parentSessionId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messageCount: 0,
          metadata: {},
          addMessage: vi.fn(),
        });
      }
      return store.get(id);
    }),
    create: vi.fn(async (opts: any) => {
      counter++;
      const session = {
        id: `sub-session-${counter}`,
        title: opts.title ?? `sub-session-${counter}`,
        directory: "/tmp",
        parentSessionId: opts.parentSessionId ?? null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messageCount: 0,
        metadata: opts.metadata || {},
        addMessage: vi.fn(),
      };
      store.set(session.id, session);
      return session;
    }),
    update: vi.fn(async (id: string, patch: any) => {
      const s = store.get(id);
      if (s && patch?.metadata) {
        s.metadata = { ...s.metadata, ...patch.metadata };
      }
      return s;
    }),
    addMessage: vi.fn(),
  };
}

function makeHarness(opts: {
  basePrompt: string;
  sessionComponent: ReturnType<typeof makeSessionComponent>;
  handleQuery: ReturnType<typeof vi.fn>;
}) {
  const registryObj: any = {
    get: vi.fn((id: string) =>
      id === "custom-agent"
        ? {
            name: "custom-agent",
            type: "sub",
            description: "Custom registry agent for dedup test",
            systemPrompt: opts.basePrompt,
          }
        : undefined
    ),
    hasAgent: vi.fn((id: string) => id === "custom-agent"),
    getSystemPrompt: async (id: string) =>
      id === "custom-agent" ? opts.basePrompt : undefined,
    list: () => [],
  };
  const mockAgentComponent = {
    getAgent: vi.fn(() => undefined),
    registerAgent: vi.fn((name: string, cfg: any) => ({ name, config: cfg })),
    // ★ 单例 registry 对象：getRegistry() 每次返回同一引用，
    //   测试内变异（如 T3 注册 workflow agent）对后续调用可见。
    getRegistry: vi.fn(() => registryObj),
  };
  const mockTaskComponent: any = {
    getTagService: () => ({
      listTags: vi.fn().mockResolvedValue([]),
      findSimilarTasks: vi.fn().mockResolvedValue([]),
    }),
    env: {
      getComponent: (name: string) => {
        if (name === "session") return opts.sessionComponent;
        if (name === "agent") return mockAgentComponent;
        return undefined;
      },
      handle_query: opts.handleQuery,
      pushEnvEvent: vi.fn(),
    },
  };
  const tool = createDelegateTool(mockTaskComponent) as Tool;
  // createDelegateTool 会把 BackgroundTaskManager 挂到 taskComponent 上
  mockTaskComponent.backgroundTaskManager =
    (mockTaskComponent as any)._backgroundTaskManager;
  return { tool, mockTaskComponent };
}

async function waitForTaskCompletion(
  mockTaskComponent: any,
  bgProcessId: string
) {
  const manager = mockTaskComponent.backgroundTaskManager;
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      const t = manager.getTask(bgProcessId);
      if (t && (t.status === "completed" || t.status === "failed")) {
        clearInterval(check);
        resolve();
      }
    }, 10);
    setTimeout(() => {
      clearInterval(check);
      resolve();
    }, 5000);
  });
}

describe("Task #5179 v2 — delegate user 消息永不嵌 basePrompt", () => {
  let sessionComponent: ReturnType<typeof makeSessionComponent>;
  let handleQuery: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessionComponent = makeSessionComponent();
    handleQuery = vi.fn().mockResolvedValue("Task completed");
  });

  afterEach(async () => {
    vi.clearAllMocks();
  });

  test("T1: 首次委派 → user 消息只含任务指令，不嵌 basePrompt", async () => {
    const h = makeHarness({ basePrompt: BASE_PROMPT, sessionComponent, handleQuery });
    const result = await h.tool.execute(
      {
        description: "first delegation",
        prompt: "Do the first thing",
        subagent_type: "custom-agent",
        similar_task_ids: [],
      },
      { session_id: "parent-1" } as any
    );
    expect(result.success).toBe(true);
    await waitForTaskCompletion(h.mockTaskComponent, result.metadata?.bgProcessId);

    const promptSent = handleQuery.mock.calls[0][0] as string;
    // ★ 核心：user 消息永不嵌 basePrompt
    expect(promptSent).not.toContain("UNIQUE_BASE_PROMPT_MARKER_5179");
    // 任务指令完整保留
    expect(promptSent).toContain("Do the first thing");
    expect(promptSent).toContain("# Session Info");
    expect(promptSent).toContain("task_description: first delegation");
    // sub-agent 身份注册仍发生（systemPrompt → 运行时 system role）
    const agentComponent = (h.mockTaskComponent.env.getComponent as any)("agent");
    const regCall = agentComponent.registerAgent.mock.calls.find(
      (c: any[]) => c[0] === "custom-agent"
    );
    expect(regCall).toBeDefined();
    expect(regCall[1].systemPrompt).toContain("UNIQUE_BASE_PROMPT_MARKER_5179");
  });

  test("T2: 同 session 续跑 → user 消息同样只含任务指令", async () => {
    const h = makeHarness({ basePrompt: BASE_PROMPT, sessionComponent, handleQuery });
    const r1 = await h.tool.execute(
      {
        description: "first delegation",
        prompt: "Do the first thing",
        subagent_type: "custom-agent",
        similar_task_ids: [],
      },
      { session_id: "parent-1" } as any
    );
    await waitForTaskCompletion(h.mockTaskComponent, r1.metadata?.bgProcessId);
    const subSessionId = r1.metadata?.sessionId;

    handleQuery.mockClear();
    const r2 = await h.tool.execute(
      {
        description: "continuation",
        prompt: "Continue with the second step",
        subagent_type: "custom-agent",
        similar_task_ids: [],
        sub_session_id: subSessionId,
      },
      { session_id: "parent-1" } as any
    );
    expect(r2.success).toBe(true);
    await waitForTaskCompletion(h.mockTaskComponent, r2.metadata?.bgProcessId);

    expect(handleQuery.mock.calls.length).toBeGreaterThan(0);
    const promptSent2 = handleQuery.mock.calls[0][0] as string;
    expect(promptSent2).not.toContain("UNIQUE_BASE_PROMPT_MARKER_5179");
    expect(promptSent2).toContain("Continue with the second step");
  });

  test("T3: workflow agent 路径不受影响（传原始 prompt）", async () => {
    const h = makeHarness({ basePrompt: BASE_PROMPT, sessionComponent, handleQuery });
    const agentComponent = (h.mockTaskComponent.env.getComponent as any)("agent");
    // 注册 workflow 类型 agent（走 entry-agent 路由）
    const registry = agentComponent.getRegistry();
    const originalGet = registry.get.bind(registry);
    registry.get = vi.fn((id: string) => {
      if (id === "wf-agent")
        return { name: "wf-agent", type: "workflow", workflow: "wf-1" };
      return originalGet(id);
    });
    registry.hasAgent = vi.fn((id: string) => id === "custom-agent" || id === "wf-agent");

    const result = await h.tool.execute(
      {
        description: "workflow delegation",
        prompt: "Run the workflow",
        subagent_type: "wf-agent",
        similar_task_ids: [],
      },
      { session_id: "parent-1" } as any
    );
    expect(result.success).toBe(true);
    await waitForTaskCompletion(h.mockTaskComponent, result.metadata?.bgProcessId);

    // entry-agent 路由后的 prompt 不含 basePrompt
    const promptSent = handleQuery.mock.calls[0][0] as string;
    expect(promptSent).not.toContain("UNIQUE_BASE_PROMPT_MARKER_5179");
  });

  test("T4: basePrompt 变更 → 运行时注入自动跟随（无需迁移）", async () => {
    const h = makeHarness({ basePrompt: BASE_PROMPT, sessionComponent, handleQuery });
    await h.tool.execute(
      {
        description: "first delegation",
        prompt: "Do the first thing",
        subagent_type: "custom-agent",
        similar_task_ids: [],
      },
      { session_id: "parent-1" } as any
    );

    // prompt 变更后再次委派（新 session）→ 注册的 systemPrompt 是新内容
    const changedPrompt = BASE_PROMPT.replace(
      "UNIQUE_BASE_PROMPT_MARKER_5179",
      "CHANGED_BASE_PROMPT_MARKER_5179_V2"
    );
    const h2 = makeHarness({
      basePrompt: changedPrompt,
      sessionComponent,
      handleQuery,
    });
    await h2.tool.execute(
      {
        description: "second delegation",
        prompt: "Do the second thing",
        subagent_type: "custom-agent",
        similar_task_ids: [],
      },
      { session_id: "parent-1" } as any
    );

    const agentComponent = (h2.mockTaskComponent.env.getComponent as any)("agent");
    const regCall = agentComponent.registerAgent.mock.calls.find(
      (c: any[]) => c[0] === "custom-agent"
    );
    expect(regCall[1].systemPrompt).toContain("CHANGED_BASE_PROMPT_MARKER_5179_V2");
  });
});
