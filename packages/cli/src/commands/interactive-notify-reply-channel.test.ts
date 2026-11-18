/**
 * @fileoverview Tests for notify event replyChannel fallback (Task #3058)
 *
 * 修复：subagent notify event (task.background.*) 没有 replyChannel，导致
 * agent 处理通知后无法回复到飞书/bounty IM。
 *
 * Bug 复现链：
 *   1. 用户通过 lark IM 发消息 → lark-cli 事件 → envEvent.metadata.replyChannel 有值
 *   2. agent delegate_task 派 subagent
 *   3. subagent 完成 → publishBackgroundEvent(COMPLETED) → task.background.completed event
 *   4. task.background.completed event 的 envEvent.metadata 没有 replyChannel
 *   5. EventHandler 触发新一轮 query → handleEventMessageWithEnv
 *   6. handleEventMessageWithEnv 构造 currentAgentContext 时不注入 replyChannel
 *   7. agent 运行 → agent-component 读 envEvent.metadata.replyChannel → undefined
 *   8. agent 处理通知后试图回复，但 reply channel 缺失 → 回复丢失
 *
 * 修复策略：
 *   1. REPL 维护 lastReplyChannel 字段，记录最近一次 lark 事件的 replyChannel
 *   2. handleEventMessageWithEnv 处理事件时：
 *      - 若 envEvent.metadata.replyChannel 存在 → 更新 lastReplyChannel
 *      - 若 envEvent.metadata.replyChannel 缺失（如 task.background.*）
 *        → 用 lastReplyChannel 注入到 envEvent.metadata（深拷贝不污染原 event）
 *   3. agent-component 走原有路径 (effectiveContext.envEvent.metadata.replyChannel)
 *      即可拿到 replyChannel，agent 回复能正确路由到 IM
 *
 * RED 测试：
 *   - Test 1: lark 事件后，REPL.lastReplyChannel 被设置
 *   - Test 2: task.background.completed 事件处理时，注入 lastReplyChannel 到 envEvent.metadata
 *   - Test 3: 没有 lastReplyChannel 时，task.background 事件的 envEvent.metadata 保持不变
 *   - Test 4: lark 事件的 replyChannel 直接透传，不被覆盖
 */

import { describe, test, expect, vi, beforeEach } from "bun:test";
import { REPL } from "./run";

/**
 * 构造一个最小的 REPL mock 用于 handleEventMessageWithEnv 测试
 */
function createMockREPL() {
  const repl: any = Object.create(REPL.prototype);
  repl.isShuttingDown = false;
  repl.isExecuting = false;
  repl.rl = null;
  repl.options = {
    sessionId: "test",
    sessionTitle: "Test",
    useInk: true,
    onExecute: vi.fn().mockResolvedValue("ok"),
    onStatus: vi.fn().mockReturnValue({
      sessionId: "test",
      sessionTitle: "Test",
      messageCount: 0,
      tokenCount: 0,
    }),
    onSwitchSession: vi.fn(),
    onCompact: vi.fn(),
    onShutdown: vi.fn().mockResolvedValue(undefined),
  };
  repl.currentAgentContext = undefined;
  repl.lastUsage = null;
  repl.replMode = "ready";
  repl.statusBarCtx = { cwd: "/tmp", gitBranch: "main", model: "M3" };
  repl.sessionComponent = null;
  repl.sessionManager = null;
  repl.redrawInputArea = vi.fn();
  return repl;
}

describe("REPL - notify event replyChannel fallback (Task #3058)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test 1: lark 事件后，REPL.lastReplyChannel 被设置
  // -------------------------------------------------------------------------
  test("lark event: lastReplyChannel should be updated from envEvent.metadata.replyChannel", async () => {
    const repl = createMockREPL();
    const replyChannel = {
      type: "lark-cli",
      chatId: "oc_test_chat",
      messageId: "om_test_msg",
      profile: "default",
    };

    const formattedEvent = {
      message: "[lark-cli] user message",
      envEvent: {
        type: "event-source.event.lark-cli",
        metadata: {
          source: "event-source",
          sourceId: "id_test",
          replyChannel,
        },
      },
      eventSessionId: "evt-1",
    };

    await (REPL.prototype as any).handleEventMessageWithEnv.call(repl, formattedEvent);

    // ★ lark 事件后 lastReplyChannel 应该有值
    expect(repl.lastReplyChannel).toEqual(replyChannel);
  });

  // -------------------------------------------------------------------------
  // Test 2: task.background.completed 事件，注入 lastReplyChannel 到 envEvent.metadata
  // -------------------------------------------------------------------------
  test("task.background.completed event: should inject lastReplyChannel into envEvent.metadata", async () => {
    const repl = createMockREPL();

    // 先设置 lastReplyChannel（模拟之前有过 lark 事件）
    const priorReplyChannel = {
      type: "lark-cli",
      chatId: "oc_prior_chat",
      messageId: "om_prior_msg",
      profile: "default",
    };
    repl.lastReplyChannel = priorReplyChannel;

    // 模拟 task.background.completed 事件（没有 replyChannel）
    const bgEvent = {
      type: "task.background.completed",
      metadata: {
        source: "task.background",
        trigger_session_id: "parent-session",
        // 注意：没有 replyChannel
      },
      payload: {
        backgroundTaskId: "process_test_1",
        description: "test task",
        result: "done",
      },
    };

    const formattedEvent = {
      message: "[通知] ✅ 后台任务「test task」已完成",
      envEvent: bgEvent,
      eventSessionId: "evt-bg-1",
    };

    await (REPL.prototype as any).handleEventMessageWithEnv.call(repl, formattedEvent);

    // ★ 关键断言：onExecute 必须收到带 replyChannel 的 envEvent
    const callArgs = repl.options.onExecute.mock.calls[0];
    const agentContext = callArgs[2];
    expect(agentContext.envEvent.metadata.replyChannel).toEqual(priorReplyChannel);

    // ★ 原 envEvent 不能被污染（深拷贝）
    expect(bgEvent.metadata.replyChannel).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test 3: 没有 lastReplyChannel 时，task.background 事件的 envEvent.metadata 保持不变
  // -------------------------------------------------------------------------
  test("task.background event with no lastReplyChannel: envEvent.metadata unchanged", async () => {
    const repl = createMockREPL();
    // lastReplyChannel 是 undefined

    const bgEvent = {
      type: "task.background.completed",
      metadata: {
        source: "task.background",
        trigger_session_id: "parent-session",
      },
      payload: {
        backgroundTaskId: "process_test_1",
        description: "test task",
        result: "done",
      },
    };

    const formattedEvent = {
      message: "[通知] test",
      envEvent: bgEvent,
      eventSessionId: "evt-bg-1",
    };

    await (REPL.prototype as any).handleEventMessageWithEnv.call(repl, formattedEvent);

    const callArgs = repl.options.onExecute.mock.calls[0];
    const agentContext = callArgs[2];
    // 没有 lastReplyChannel 时不应该注入不存在的 replyChannel
    expect(agentContext.envEvent.metadata.replyChannel).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test 4: lark 事件的 replyChannel 直接透传，不被 lastReplyChannel 覆盖
  // -------------------------------------------------------------------------
  test("lark event: envEvent.metadata.replyChannel passed through unchanged", async () => {
    const repl = createMockREPL();

    // 先设置一个不同的 lastReplyChannel
    const priorReplyChannel = {
      type: "lark-cli",
      chatId: "oc_prior",
      messageId: "om_prior",
    };
    repl.lastReplyChannel = priorReplyChannel;

    // 新 lark 事件有自己的 replyChannel
    const newReplyChannel = {
      type: "lark-cli",
      chatId: "oc_new",
      messageId: "om_new",
    };

    const formattedEvent = {
      message: "[lark-cli] new user message",
      envEvent: {
        type: "event-source.event.lark-cli",
        metadata: {
          source: "event-source",
          replyChannel: newReplyChannel,
        },
      },
      eventSessionId: "evt-1",
    };

    await (REPL.prototype as any).handleEventMessageWithEnv.call(repl, formattedEvent);

    const callArgs = repl.options.onExecute.mock.calls[0];
    const agentContext = callArgs[2];
    // ★ 用新事件的 replyChannel，而不是 lastReplyChannel
    expect(agentContext.envEvent.metadata.replyChannel).toEqual(newReplyChannel);
    expect(agentContext.envEvent.metadata.replyChannel).not.toEqual(priorReplyChannel);

    // ★ lastReplyChannel 也应该更新为新值
    expect(repl.lastReplyChannel).toEqual(newReplyChannel);
  });

  // -------------------------------------------------------------------------
  // Test 5: 多个 task.background 事件都使用同一个 lastReplyChannel
  // -------------------------------------------------------------------------
  test("multiple task.background events: all share lastReplyChannel", async () => {
    const repl = createMockREPL();
    const replyChannel = {
      type: "lark-cli",
      chatId: "oc_chat",
      messageId: "om_msg",
    };

    // 先来一个 lark 事件
    await (REPL.prototype as any).handleEventMessageWithEnv.call(repl, {
      message: "[lark-cli] msg1",
      envEvent: {
        type: "event-source.event.lark-cli",
        metadata: { replyChannel },
      },
      eventSessionId: "evt-1",
    });

    expect(repl.options.onExecute).toHaveBeenCalledTimes(1);

    // 然后 3 个 task.background 事件
    for (let i = 0; i < 3; i++) {
      await (REPL.prototype as any).handleEventMessageWithEnv.call(repl, {
        message: `[通知] task ${i} done`,
        envEvent: {
          type: "task.background.completed",
          metadata: { source: "task.background" },
          payload: { backgroundTaskId: `process_${i}` },
        },
        eventSessionId: `evt-bg-${i}`,
      });
    }

    expect(repl.options.onExecute).toHaveBeenCalledTimes(4);

    // ★ 后 3 个 onExecute 调用的 agentContext.envEvent.metadata.replyChannel 都应该是同一个
    for (let i = 1; i < 4; i++) {
      const callArgs = repl.options.onExecute.mock.calls[i];
      const agentContext = callArgs[2];
      expect(agentContext.envEvent.metadata.replyChannel).toEqual(replyChannel);
    }
  });
});

// ============================================================================
// #4108 P1-a: per-chatId replyChannel cache（多群并发隔离）
// ============================================================================

describe("REPL - #4108 P1-a: per-chatId replyChannel cache (cross-chat isolation)", () => {
  const makeRc = (chatId: string) => ({
    type: "lark-cli",
    chatId,
    messageId: `om_${chatId}`,
  });

  async function larkEvent(repl: any, chatId: string) {
    await (REPL.prototype as any).handleEventMessageWithEnv.call(repl, {
      message: `[lark-cli] ${chatId}`,
      envEvent: {
        type: "event-source.event.lark-cli",
        metadata: { replyChannel: makeRc(chatId) },
      },
      eventSessionId: `evt-${chatId}`,
    });
  }

  test("background event tagged with chatId uses THAT chat's cached channel (not last-write-wins)", async () => {
    const repl = createMockREPL();
    await larkEvent(repl, "oc_A");
    await larkEvent(repl, "oc_B"); // 后到，全局 last 变成 B

    // 针对 chat A 的 background 通知（formattedEvent.chatId = oc_A）
    await (REPL.prototype as any).handleEventMessageWithEnv.call(repl, {
      message: "[通知] bg A",
      chatId: "oc_A",
      envEvent: {
        type: "task.background.completed",
        metadata: { source: "task.background" },
        payload: { backgroundTaskId: "p1" },
      },
      eventSessionId: "evt-bg-A",
    });

    const agentContext = repl.options.onExecute.mock.calls.at(-1)[2];
    expect(agentContext.envEvent.metadata.replyChannel?.chatId).toBe("oc_A");
    expect(agentContext.envEvent.metadata.replyChannel?.chatId).not.toBe("oc_B");
  });

  test("background event without chatId falls back to global lastReplyChannel", async () => {
    const repl = createMockREPL();
    await larkEvent(repl, "oc_A");
    await larkEvent(repl, "oc_B");

    await (REPL.prototype as any).handleEventMessageWithEnv.call(repl, {
      message: "[通知] bg no-chat",
      envEvent: {
        type: "task.background.completed",
        metadata: { source: "task.background" },
        payload: { backgroundTaskId: "p2" },
      },
      eventSessionId: "evt-bg-none",
    });

    const agentContext = repl.options.onExecute.mock.calls.at(-1)[2];
    // 无 chatId 时沿用旧语义（全局 last-write-wins）
    expect(agentContext.envEvent.metadata.replyChannel?.chatId).toBe("oc_B");
  });
});