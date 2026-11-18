/**
 * @fileoverview ALS EnvContext 跨事件隔离的端到端测试 (Task #4486 Phase 4)
 *
 * 问题根因（review 记录）：
 * EventSource 在 `runWithEnvContext(envContext, () => eventHandler(evt))` 中投递
 * 事件（event-source-handlers.ts:1895），但 EventHandler 是单 worker：
 * 异步链在"第一条事件"的 ALS 上启动。之后处理队列里其他 chat 的 item 时，
 * 仍处于前一条事件的 EnvContext 下。
 *
 * 影响（agent-component.ts buildRunEnvContext）：
 *   - `agentContext: parentEnvContext?.agentContext ?? {}` → 共享前一条事件的
 *     agentContext（含 currentTaskId）
 *   - `messageId: parentEnvContext?.messageId ?? ...` → 后一条事件继承前一条的消息 id
 *
 * 修复：enqueue 时快照 EnvContext，processItem 时 runWithEnvContextAsync 重入。
 * 本测试从**消费端视角**验证：两个不同 chat 的事件被处理时，各自在
 * `AgentComponent` 构建出来的 EnvContext 里看到自己的 messageId / currentTaskId。
 */

import { describe, test, expect, vi, beforeEach } from "bun:test";
import { EventHandler } from "./event-handler";
import { EventMessageFormatter, type FormattedEvent } from "./event-message-formatter";
import {
  createEnvContext,
  getEnvContext,
  runWithEnvContext,
} from "@ai-setting/roy-bot-core/env";
import { buildRunEnvContext } from "@ai-setting/roy-bot-core/env/agent/agent-component";

async function waitFor(fn: () => boolean, timeout = 3000, interval = 5): Promise<void> {
  const start = Date.now();
  while (!fn() && Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, interval));
  }
  if (!fn()) throw new Error(`waitFor timed out after ${timeout}ms`);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const formatter = new EventMessageFormatter();
const TYPE = "event-source.event.lark-cli";

function larkEvent(chatId: string, tag: string) {
  return {
    type: TYPE,
    payload: { tag },
    metadata: {
      sourceId: "test-source",
      replyChannel: { type: "lark-cli", chatId, messageId: `om_${tag}` },
    },
  };
}

function makeSessionComponent() {
  return {
    create: vi.fn().mockImplementation(async (opts: any) => ({
      id: opts?.id ?? `gen-${Math.random().toString(36).slice(2, 8)}`,
      title: opts?.title ?? "Lark Chat",
    })),
    get: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockImplementation(async (options: any) => {
      const filterChatId = options?.filter?.metadata?.chatId;
      return filterChatId ? [{ id: filterChatId, title: `Lark Chat ${filterChatId}` }] : [];
    }),
    getActiveSessionId: vi.fn().mockReturnValue(undefined),
    setActiveSession: vi.fn().mockResolvedValue(true),
  };
}

describe("Task #4486 Phase 4: ALS EnvContext 跨事件隔离", () => {
  let sessionComponent: ReturnType<typeof makeSessionComponent>;

  beforeEach(() => {
    sessionComponent = makeSessionComponent();
  });

  test("并发两事件各自在 AgentComponent 视角看到自己的 messageId / currentTaskId", async () => {
    /** 模拟 agent-component._run 里构建 EnvContext 时看到的东西 */
    const seen: Array<{
      tag: string;
      builtMessageId?: string;
      builtTaskId?: number;
      builtSessionId?: string;
    }> = [];

    const onEventWithEnv = vi.fn().mockImplementation(async (fe: FormattedEvent) => {
      const tag = (fe.envEvent.payload as { tag: string }).tag;
      // 让异步链跨几个 tick，暴露"共享 ALS"的问题
      await delay(15);

      // 模拟 consume 端：AgentComponent 用 effectiveContext + parentEnvContext 构建
      const parentEnvContext = getEnvContext();
      const built = buildRunEnvContext({
        effectiveContext: {
          sessionId: fe.eventSessionId!,
          // 消费端不显式传 messageId → 依赖 parent ALS 继承（这正是 bug 路径）
          metadata: {},
        } as any,
        parentEnvContext,
        envBoundParentTaskId: undefined,
      });

      seen.push({
        tag,
        builtMessageId: built.messageId,
        builtTaskId: built.agentContext?.currentTaskId,
        builtSessionId: built.sessionId,
      });
      await delay(15);
    });

    const handler = new EventHandler({
      env: { subscribeAll: () => () => {} } as any,
      eventTypes: [TYPE],
      formatter,
      isIdle: () => true, // 全局永远空闲 —— 证明隔离不是靠串行兜的
      onEventWithEnv,
      sessionComponent: sessionComponent as any,
    });

    // 模拟 EventSource 投递（生产路径：runWithEnvContext + 同步 enqueue）
    const dispatch = (chatId: string, tag: string, messageId: string, taskId: number) => {
      const ctx = createEnvContext({
        envEvent: larkEvent(chatId, tag) as any,
        sourceId: "test-source",
        userId: "ou_test",
        messageId,
      });
      ctx.agentContext = { currentTaskId: taskId };
      runWithEnvContext(ctx, () => {
        handler.enqueue(formatter.formatWithEvent(larkEvent(chatId, tag) as any));
      });
    };

    dispatch("oc_A", "A", "om_AAA", 7001);
    dispatch("oc_B", "B", "om_BBB", 7002);

    await waitFor(() => seen.length >= 2, 4000);

    const a = seen.find((s) => s.tag === "A")!;
    const b = seen.find((s) => s.tag === "B")!;

    // ★ 核心：各自继承自己的 messageId（不串成前一条）
    expect(a.builtMessageId).toBe("om_AAA");
    expect(b.builtMessageId).toBe("om_BBB");

    // ★ 各自看到自己的 currentTaskId（agentContext 不共享前一条的槽）
    expect(a.builtTaskId).toBe(7001);
    expect(b.builtTaskId).toBe(7002);

    // session 路由仍然各自正确
    expect(a.builtSessionId).toBe("oc_A");
    expect(b.builtSessionId).toBe("oc_B");

    handler.stop();
  });

  test("事件逐个到达（非并发）时也不串味（回归旧 bug 场景）", async () => {
    const seen: Array<{ tag: string; messageId?: string }> = [];
    const onEventWithEnv = vi.fn().mockImplementation(async (fe: FormattedEvent) => {
      const tag = (fe.envEvent.payload as { tag: string }).tag;
      await delay(10);
      seen.push({ tag, messageId: getEnvContext()?.messageId });
    });

    const handler = new EventHandler({
      env: { subscribeAll: () => () => {} } as any,
      eventTypes: [TYPE],
      formatter,
      isIdle: () => true,
      onEventWithEnv,
      sessionComponent: sessionComponent as any,
      maxConcurrentSessions: 1, // 强制串行，复现旧单 worker 场景
    });

    const dispatch = (chatId: string, tag: string, messageId: string) => {
      const ctx = createEnvContext({
        envEvent: larkEvent(chatId, tag) as any,
        sourceId: "test-source",
        userId: "ou_test",
        messageId,
      });
      runWithEnvContext(ctx, () => {
        handler.enqueue(formatter.formatWithEvent(larkEvent(chatId, tag) as any));
      });
    };

    dispatch("oc_1", "e1", "om_1");
    dispatch("oc_2", "e2", "om_2");

    await waitFor(() => seen.length >= 2, 4000);

    expect(seen.find((s) => s.tag === "e1")?.messageId).toBe("om_1");
    expect(seen.find((s) => s.tag === "e2")?.messageId).toBe("om_2");

    handler.stop();
  });

  test("入队时无 EnvContext → 处理时 ALS 为空（不继承任何前一条）", async () => {
    const seen: Array<{ tag: string; hasCtx: boolean }> = [];
    const onEventWithEnv = vi.fn().mockImplementation(async (fe: FormattedEvent) => {
      const tag = (fe.envEvent.payload as { tag: string }).tag;
      seen.push({ tag, hasCtx: getEnvContext() !== undefined });
    });

    const handler = new EventHandler({
      env: { subscribeAll: () => () => {} } as any,
      eventTypes: [TYPE],
      formatter,
      isIdle: () => true,
      onEventWithEnv,
      sessionComponent: sessionComponent as any,
    });

    // 第一条带 ctx
    const ctx = createEnvContext({
      envEvent: larkEvent("oc_x", "x") as any,
      sourceId: "test-source",
      userId: "ou_test",
      messageId: "om_X",
    });
    runWithEnvContext(ctx, () => {
      handler.enqueue(formatter.formatWithEvent(larkEvent("oc_x", "x") as any));
    });
    // 第二条不带 ctx（直接在 ALS 外入队）
    handler.enqueue(formatter.formatWithEvent(larkEvent("oc_y", "y") as any));

    await waitFor(() => seen.length >= 2, 4000);

    const x = seen.find((s) => s.tag === "x")!;
    const y = seen.find((s) => s.tag === "y")!;
    expect(x.hasCtx).toBe(true);
    // ★ y 没快照到 ctx → 处理时 ALS 必须是空（不能继承 x 的）
    expect(y.hasCtx).toBe(false);

    handler.stop();
  });
});
