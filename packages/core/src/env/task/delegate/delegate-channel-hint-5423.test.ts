/**
 * @fileoverview Task #5423 — delegate_task sub-agent prompt 注入「渠道特性提示」。
 *
 * ## 背景
 *
 * delegate_task 起的 sub-agent 的 prompt 里没有渠道特性提示：
 * 用户在飞书发「帮我写调研文档」→ 主 agent delegate 给 sub-agent
 * → sub-agent 不知道渠道 → 产出物落本地路径（`/tmp/x.md`）而非飞书云盘，
 * 飞书用户根本打不开。
 *
 * ## 本文件锁定三件事
 *
 * 1. 纯函数 `buildDelegateChannelHint(channelType)` 的渠道分支
 *    （lark → 飞书云盘 / wecom → 企微文档 / 未知或缺失 → undefined 不注入）
 * 2. 端到端：飞书渠道触发 delegate_task → **sub-agent 收到的 prompt 含「飞书云盘」**
 * 3. 端到端：无渠道（CLI / REPL / timer）→ prompt **不含**任何渠道提示段
 *
 * 端到端断言对象是 `env.handle_query` 收到的 prompt（即 sub-agent 的 user 消息），
 * 与 delegate-tool-prompt-dedup.test.ts 同一采集口径。
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createDelegateTool } from "./delegate-tool";
import { buildDelegateChannelHint } from "./delegate-channel-hint";
import { runWithEnvContextAsync } from "../../context";
import type { Tool } from "../../tool/types";

// ============================================================================
// 1. 纯函数分支
// ============================================================================

describe("Task #5423 — buildDelegateChannelHint 渠道分支", () => {
  test("lark-cli 渠道 → 提示段含「飞书云盘」+ docs +create 命令", () => {
    const hint = buildDelegateChannelHint("lark-cli");
    expect(hint).toBeDefined();
    expect(hint).toContain("飞书云盘");
    expect(hint).toContain("lark-cli docs +create");
    // 通用措辞：不要把本地路径当交付物
    expect(hint).toContain("本地");
  });

  test("wecom-cli 渠道 → 提示段含「企业微信」+ 企微文档命令，且不含飞书云盘", () => {
    const hint = buildDelegateChannelHint("wecom-cli");
    expect(hint).toBeDefined();
    expect(hint).toContain("企业微信");
    expect(hint).toContain("wecom-cli doc create");
    expect(hint).not.toContain("飞书云盘");
  });

  test("变体渠道（lark-chat / wecom-ws）也命中（CV MAJOR-1 核实：生产存在这些 type）", () => {
    expect(buildDelegateChannelHint("lark-chat")).toContain("飞书云盘");
    expect(buildDelegateChannelHint("wecom-ws")).toContain("企业微信");
  });

  test("无渠道 / 未知渠道 → 不注入（undefined）", () => {
    expect(buildDelegateChannelHint(undefined)).toBeUndefined();
    expect(buildDelegateChannelHint("")).toBeUndefined();
    expect(buildDelegateChannelHint("cli")).toBeUndefined();
  });

  test("提示段长度受控（system/user prompt 预算，≤ 900 字符）", () => {
    for (const ch of ["lark-cli", "wecom-cli"]) {
      const hint = buildDelegateChannelHint(ch)!;
      expect(hint.length).toBeLessThanOrEqual(900);
    }
  });
});

// ============================================================================
// 2. 端到端：delegate prompt 注入
// ============================================================================

/**
 * Metadata-propagating in-memory session component（真实 Session 扁平形状）。
 */
function makeSessionComponent() {
  const store = new Map<string, any>();
  let counter = 0;
  return {
    get: vi.fn(async (id: string) => {
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
      };
      store.set(session.id, session);
      return session;
    }),
    update: vi.fn(async (id: string, patch: any) => {
      const s = store.get(id);
      if (s && patch?.metadata) s.metadata = { ...s.metadata, ...patch.metadata };
      return s;
    }),
    addMessage: vi.fn(),
  };
}

function makeHarness(opts: { handleQuery: ReturnType<typeof vi.fn> }) {
  const basePrompt = "You are TestAgent. Complete the task: {task_description}";
  const registryObj: any = {
    get: vi.fn((id: string) =>
      id === "custom-agent"
        ? { name: "custom-agent", type: "sub", description: "t", systemPrompt: basePrompt }
        : undefined,
    ),
    hasAgent: vi.fn((id: string) => id === "custom-agent"),
    getSystemPrompt: async (id: string) => (id === "custom-agent" ? basePrompt : undefined),
    list: () => [],
  };
  const mockAgentComponent = {
    getAgent: vi.fn(() => undefined),
    registerAgent: vi.fn((name: string, cfg: any) => ({ name, config: cfg })),
    getRegistry: vi.fn(() => registryObj),
  };
  const sessionComponent = makeSessionComponent();
  const mockTaskComponent: any = {
    getTagService: () => ({
      listTags: vi.fn().mockResolvedValue([]),
      findSimilarTasks: vi.fn().mockResolvedValue([]),
    }),
    env: {
      getComponent: (name: string) => {
        if (name === "session") return sessionComponent;
        if (name === "agent") return mockAgentComponent;
        return undefined;
      },
      handle_query: opts.handleQuery,
      pushEnvEvent: vi.fn(),
    },
  };
  const tool = createDelegateTool(mockTaskComponent) as Tool;
  mockTaskComponent.backgroundTaskManager = (mockTaskComponent as any)._backgroundTaskManager;
  return { tool, mockTaskComponent };
}

async function waitForCompletion(mockTaskComponent: any, bgProcessId: string) {
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

describe("Task #5423 — delegate prompt 渠道特性提示注入（端到端）", () => {
  let handleQuery: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    handleQuery = vi.fn().mockResolvedValue("done");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("E1: 飞书渠道触发 → sub-agent prompt 含「飞书云盘」提示", async () => {
    const h = makeHarness({ handleQuery });
    await runWithEnvContextAsync(
      {
        envEvent: {},
        replyChannel: {
          type: "lark-cli",
          appId: "cli_tongzhuli",
          chatId: "oc_5423",
          messageId: "om_5423",
        },
      } as any,
      async () => {
        const r = await h.tool.execute(
          {
            description: "调研报告",
            prompt: "写一份调研文档",
            subagent_type: "custom-agent",
            similar_task_ids: [],
          } as any,
          { session_id: "parent-5423" } as any,
        );
        expect(r.success).toBe(true);
        await waitForCompletion(h.mockTaskComponent, r.metadata?.bgProcessId);
      },
    );

    const promptSent = handleQuery.mock.calls[0][0] as string;
    // 原始任务指令与 Session Info 都还在（不破坏既有结构）
    expect(promptSent).toContain("# Session Info");
    expect(promptSent).toContain("写一份调研文档");
    // ★ 核心断言：渠道特性提示已注入
    expect(promptSent).toContain("飞书云盘");
    expect(promptSent).toContain("lark-cli docs +create");
    // 不应混入企微提示
    expect(promptSent).not.toContain("wecom-cli doc create");
  });

  test("E2: 企微渠道触发 → sub-agent prompt 含企微文档提示", async () => {
    const h = makeHarness({ handleQuery });
    await runWithEnvContextAsync(
      {
        envEvent: {},
        replyChannel: {
          type: "wecom-cli",
          chatId: "zhangsan",
          messageId: "msg_5423",
        },
      } as any,
      async () => {
        const r = await h.tool.execute(
          {
            description: "企微调研报告",
            prompt: "写一份调研文档",
            subagent_type: "custom-agent",
            similar_task_ids: [],
          } as any,
          { session_id: "parent-5423-wecom" } as any,
        );
        expect(r.success).toBe(true);
        await waitForCompletion(h.mockTaskComponent, r.metadata?.bgProcessId);
      },
    );

    const promptSent = handleQuery.mock.calls[0][0] as string;
    expect(promptSent).toContain("企业微信");
    expect(promptSent).toContain("wecom-cli doc create");
    expect(promptSent).not.toContain("飞书云盘");
  });

  test("E4: ALS 有 replyChannel 但 type 未知 → 仍不注入（CV MINOR-1）", async () => {
    const h = makeHarness({ handleQuery });
    await runWithEnvContextAsync(
      {
        envEvent: {},
        replyChannel: { type: "unknown-thing", chatId: "c1", messageId: "m1" },
      } as any,
      async () => {
        const r = await h.tool.execute(
          {
            description: "unknown channel task",
            prompt: "写一份调研文档",
            subagent_type: "custom-agent",
            similar_task_ids: [],
          } as any,
          { session_id: "parent-5423-unknown" } as any,
        );
        expect(r.success).toBe(true);
        await waitForCompletion(h.mockTaskComponent, r.metadata?.bgProcessId);
      },
    );

    const promptSent = handleQuery.mock.calls[0][0] as string;
    expect(promptSent).toContain("写一份调研文档");
    expect(promptSent).not.toContain("飞书云盘");
    expect(promptSent).not.toContain("企业微信");
    expect(promptSent).not.toContain("渠道交付提示");
  });

  test("E3: 无渠道（CLI / REPL / timer）→ 不注入任何渠道提示段", async () => {
    const h = makeHarness({ handleQuery });
    const r = await h.tool.execute(
      {
        description: "cli task",
        prompt: "写一份调研文档",
        subagent_type: "custom-agent",
        similar_task_ids: [],
      } as any,
      { session_id: "parent-5423-cli" } as any,
    );
    expect(r.success).toBe(true);
    await waitForCompletion(h.mockTaskComponent, r.metadata?.bgProcessId);

    const promptSent = handleQuery.mock.calls[0][0] as string;
    expect(promptSent).toContain("写一份调研文档");
    // ★ 无渠道 = 一个字都不多写
    expect(promptSent).not.toContain("飞书云盘");
    expect(promptSent).not.toContain("企业微信");
    expect(promptSent).not.toContain("渠道交付提示");
  });
});
