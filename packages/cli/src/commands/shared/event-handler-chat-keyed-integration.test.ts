/**
 * @fileoverview EventHandler Chat-Keyed Session 集成测试（真 SessionComponent + MemoryStore）
 *
 * 目的：mock-based 测试已经覆盖了 ensureActiveSession 的所有优先级，
 *       这里用真实 SessionComponent 验证：
 *       - 不同 chat_id 跨批次真的会被分到不同 session (DB 里有两条记录)
 *       - 同一 chat_id 跨批次真的共享同一 session (不重复创建)
 *       - 飞书消息落到对应 chat session 后，REPL global active session 不受影响
 *
 * 运行：
 *   bun test packages/cli/src/commands/shared/event-handler-chat-keyed-integration.test.ts
 */

import { describe, test, expect } from "bun:test";
import { EventHandler } from "./event-handler";
import { EventMessageFormatter, type FormattedEvent } from "./event-message-formatter";
import { SessionComponent } from "@ai-setting/roy-bot-core";
import { MemorySessionStore } from "@ai-setting/roy-bot-core";

// ============================================================================
// Helpers
// ============================================================================

function createMockEnvEvent(
  type: string,
  chatId: string,
): {
  id: string;
  type: string;
  metadata: { replyChannel: { type: string; chatId: string; messageId: string } };
} {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    type,
    metadata: {
      replyChannel: { type: "lark-cli", chatId, messageId: "om_test" },
    },
  };
}

/**
 * 轮询等待条件满足
 */
async function waitFor(fn: () => boolean, timeout = 2000, interval = 10): Promise<void> {
  const start = Date.now();
  while (!fn() && Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, interval));
  }
  if (!fn()) {
    throw new Error(`waitFor timed out after ${timeout}ms`);
  }
}

// ============================================================================
// Tests
// ============================================================================

describe("EventHandler - Chat-Keyed Session 集成测试 (真 SessionComponent)", () => {
  test("INT 1: 两个不同 chat_id → 两个不同 session (DB 里有两条)", async () => {
    // 1. 构造真实 SessionComponent + MemoryStore
    const store = new MemorySessionStore();
    const component = new SessionComponent();
    (component as any).store = store;

    const chatA = "oc_integration_alpha";
    const chatB = "oc_integration_beta";

    // 记录每个事件收到的 eventSessionId
    const receivedSessionIds: { chat: string; sessionId: string | undefined }[] = [];
    const onEventWithEnv = async (fe: FormattedEvent) => {
      // 反查 chat_id：envEvent.metadata.replyChannel.chatId
      const cid = (fe.envEvent.metadata?.replyChannel as { chatId?: string })?.chatId;
      receivedSessionIds.push({ chat: cid ?? "?", sessionId: fe.eventSessionId });
    };

    const handler = new EventHandler({
      env: { subscribeAll: () => () => {} } as any,
      eventTypes: ["event-source.event.*"],
      onEventWithEnv,
      formatter: new EventMessageFormatter(),
      isIdle: () => true,
      sessionComponent: component as any,
    });

    // 2. 批次 1: chatA 事件
    const formatter = new EventMessageFormatter();
    handler.enqueue(formatter.formatWithEvent(createMockEnvEvent("event-source.event.lark-cli", chatA) as any));

    await waitFor(() => receivedSessionIds.length >= 1, 2000);
    await waitFor(() => handler.isQueueEmpty() && !(handler as any).isProcessing, 2000);

    // 3. 批次 2: chatB 事件
    handler.enqueue(formatter.formatWithEvent(createMockEnvEvent("event-source.event.lark-cli", chatB) as any));

    await waitFor(() => receivedSessionIds.length >= 2, 2000);
    await waitFor(() => handler.isQueueEmpty() && !(handler as any).isProcessing, 2000);

    // 4. 验证：两个事件分别用不同 session
    expect(receivedSessionIds[0].chat).toBe(chatA);
    expect(receivedSessionIds[1].chat).toBe(chatB);
    expect(receivedSessionIds[0].sessionId).toBeDefined();
    expect(receivedSessionIds[1].sessionId).toBeDefined();
    expect(receivedSessionIds[0].sessionId).not.toBe(receivedSessionIds[1].sessionId);
    expect(receivedSessionIds[0].sessionId).toBe(chatA);
    expect(receivedSessionIds[1].sessionId).toBe(chatB);

    // 5. 验证 DB 里有 2 条 session 记录，metadata 都正确
    const allSessions = await component.list({ limit: 100 });
    expect(allSessions.length).toBe(2);

    const sessionA = await component.get(chatA);
    const sessionB = await component.get(chatB);
    expect(sessionA).toBeDefined();
    expect(sessionB).toBeDefined();
    expect(sessionA?.metadata?.chatId).toBe(chatA);
    expect(sessionA?.metadata?.type).toBe("lark-chat");
    expect(sessionB?.metadata?.chatId).toBe(chatB);
    expect(sessionB?.metadata?.type).toBe("lark-chat");

    // 6. 验证 list filter 能反查到 chat-keyed session
    const foundA = await component.list({ filter: { metadata: { chatId: chatA, type: "lark-chat" } } });
    expect(foundA.length).toBe(1);
    expect(foundA[0].id).toBe(chatA);

    const foundB = await component.list({ filter: { metadata: { chatId: chatB, type: "lark-chat" } } });
    expect(foundB.length).toBe(1);
    expect(foundB[0].id).toBe(chatB);

    // 7. 验证 chat-keyed session 不污染 REPL global active
    expect(component.getActiveSessionId?.()).toBeUndefined();

    handler.stop();
  });

  test("INT 2: 同一 chat_id 跨批次 → 共享同一 session (不重复创建)", async () => {
    const store = new MemorySessionStore();
    const component = new SessionComponent();
    (component as any).store = store;
    const chat = "oc_integration_shared";

    const receivedSessionIds: (string | undefined)[] = [];
    const onEventWithEnv = async (fe: FormattedEvent) => {
      receivedSessionIds.push(fe.eventSessionId);
    };

    const handler = new EventHandler({
      env: { subscribeAll: () => () => {} } as any,
      eventTypes: ["event-source.event.*"],
      onEventWithEnv,
      formatter: new EventMessageFormatter(),
      isIdle: () => true,
      sessionComponent: component as any,
    });

    const formatter = new EventMessageFormatter();

    // 批次 1
    handler.enqueue(formatter.formatWithEvent(createMockEnvEvent("event-source.event.lark-cli", chat) as any));
    await waitFor(() => receivedSessionIds.length >= 1, 2000);
    await waitFor(() => handler.isQueueEmpty() && !(handler as any).isProcessing, 2000);

    // 批次 2 (同 chat)
    handler.enqueue(formatter.formatWithEvent(createMockEnvEvent("event-source.event.lark-cli", chat) as any));
    await waitFor(() => receivedSessionIds.length >= 2, 2000);
    await waitFor(() => handler.isQueueEmpty() && !(handler as any).isProcessing, 2000);

    // 批次 3 (同 chat)
    handler.enqueue(formatter.formatWithEvent(createMockEnvEvent("event-source.event.lark-cli", chat) as any));
    await waitFor(() => receivedSessionIds.length >= 3, 2000);
    await waitFor(() => handler.isQueueEmpty() && !(handler as any).isProcessing, 2000);

    // 验证：3 个事件都用同一 session
    expect(receivedSessionIds[0]).toBe(chat);
    expect(receivedSessionIds[1]).toBe(chat);
    expect(receivedSessionIds[2]).toBe(chat);
    expect(receivedSessionIds[0]).toBe(receivedSessionIds[1]);
    expect(receivedSessionIds[1]).toBe(receivedSessionIds[2]);

    // 验证：DB 里只有 1 条 session (没重复创建)
    const allSessions = await component.list({ limit: 100 });
    expect(allSessions.length).toBe(1);
    expect(allSessions[0].id).toBe(chat);

    handler.stop();
  });

  test("INT 3: REPL 设置了 global active session, 飞书 chat 事件不应该污染它", async () => {
    const store = new MemorySessionStore();
    const component = new SessionComponent();
    (component as any).store = store;

    // 1. 模拟 REPL 启动：创建一个 REPL session 并设为 global active
    const replSession = await component.create({ title: "REPL Active" });
    await component.setActiveSession(replSession.id);

    const chat = "oc_integration_isolation";
    const receivedSessionIds: (string | undefined)[] = [];
    const onEventWithEnv = async (fe: FormattedEvent) => {
      receivedSessionIds.push(fe.eventSessionId);
    };

    const handler = new EventHandler({
      env: { subscribeAll: () => () => {} } as any,
      eventTypes: ["event-source.event.*"],
      onEventWithEnv,
      formatter: new EventMessageFormatter(),
      isIdle: () => true,
      sessionComponent: component as any,
    });

    // 2. 飞书 chat 事件
    const formatter = new EventMessageFormatter();
    handler.enqueue(formatter.formatWithEvent(createMockEnvEvent("event-source.event.lark-cli", chat) as any));
    await waitFor(() => receivedSessionIds.length >= 1, 2000);
    await waitFor(() => handler.isQueueEmpty() && !(handler as any).isProcessing, 2000);

    // 验证：chat 事件用 chat-keyed session（不是 REPL session）
    expect(receivedSessionIds[0]).toBe(chat);
    expect(receivedSessionIds[0]).not.toBe(replSession.id);

    // 验证：REPL global active session 没被改写（★ 隔离保证）
    expect(component.getActiveSessionId?.()).toBe(replSession.id);

    // 验证：DB 里现在有 2 条 session
    const allSessions = await component.list({ limit: 100 });
    expect(allSessions.length).toBe(2);

    handler.stop();
  });

  test("INT 4: 同一批多 chat_id → 各自独立 session (按 item 解析, 修复跨 chat 污染)", async () => {
    // 修复: processQueue 现在按每个 item 自身的 chatId 解析 session,
    // 同一批次内不同 chat 不再复用第一个 chat 的 session。
    const store = new MemorySessionStore();
    const component = new SessionComponent();
    (component as any).store = store;

    const chatA = "oc_int_batch_alpha";
    const chatB = "oc_int_batch_beta";
    const receivedSessionIds: (string | undefined)[] = [];
    const onEventWithEnv = async (fe: FormattedEvent) => {
      receivedSessionIds.push(fe.eventSessionId);
    };

    const handler = new EventHandler({
      env: { subscribeAll: () => () => {} } as any,
      eventTypes: ["event-source.event.*"],
      onEventWithEnv,
      formatter: new EventMessageFormatter(),
      isIdle: () => true,
      sessionComponent: component as any,
    });

    const formatter = new EventMessageFormatter();

    // 同批次入队 chatA 和 chatB
    handler.enqueue(formatter.formatWithEvent(createMockEnvEvent("event-source.event.lark-cli", chatA) as any));
    handler.enqueue(formatter.formatWithEvent(createMockEnvEvent("event-source.event.lark-cli", chatB) as any));

    await waitFor(() => receivedSessionIds.length >= 2, 2000);
    await waitFor(() => handler.isQueueEmpty() && !(handler as any).isProcessing, 2000);

    // 修复后行为：两个事件各自用自己 chat 的 session
    expect(receivedSessionIds[0]).toBe(chatA);
    expect(receivedSessionIds[1]).toBe(chatB);
    expect(receivedSessionIds[0]).not.toBe(receivedSessionIds[1]);

    // DB 里有 2 条 session 记录
    const allSessions = await component.list({ limit: 100 });
    expect(allSessions.length).toBe(2);

    handler.stop();
  });

  test("INT 4b: 批次处理期间到达的另一 chat 消息 → 用其自身 session (跨 chat 污染回归)", async () => {
    // 复现真实 bug (chat_id=oc_4b6f 群消息落入 oc_539fbff session):
    // chatA 的 agent turn 尚在运行 (onEventWithEnv await 未 resolve) 时 chatB 入队,
    // 旧代码整个 drain loop 复用 chatA 的 sessionId → chatB 落入 chatA session。
    const store = new MemorySessionStore();
    const component = new SessionComponent();
    (component as any).store = store;

    const chatA = "oc_during_alpha";
    const chatB = "oc_during_beta";
    const received: { chat: string; sessionId: string | undefined }[] = [];

    let releaseFirst: () => void = () => {};
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let callIndex = 0;

    const formatter = new EventMessageFormatter();
    let handler: EventHandler;

    const onEventWithEnv = async (fe: FormattedEvent) => {
      const cid = (fe.envEvent.metadata?.replyChannel as { chatId?: string })?.chatId ?? "?";
      received.push({ chat: cid, sessionId: fe.eventSessionId });
      callIndex++;
      if (callIndex === 1) {
        // 模拟 chatA 的 agent turn 很长: 期间 chatB 入队
        handler.enqueue(formatter.formatWithEvent(
          createMockEnvEvent("event-source.event.lark-cli", chatB) as any,
        ));
        await firstBlocked;
      }
    };

    handler = new EventHandler({
      env: { subscribeAll: () => () => {} } as any,
      eventTypes: ["event-source.event.*"],
      onEventWithEnv,
      formatter: new EventMessageFormatter(),
      isIdle: () => true,
      sessionComponent: component as any,
    });

    handler.enqueue(formatter.formatWithEvent(createMockEnvEvent("event-source.event.lark-cli", chatA) as any));

    // ★ Task #4486: per-session lane 化后，chatB 不再"排队等 chatA 结束"，
    //   而是立刻进入自己的 lane 并行启动。所以这里等 chatB 的 onEventWithEnv
    //   已进入（received.length >= 2）即证明它没被 chatA 阻塞。
    await waitFor(() => received.length >= 2, 2000);
    releaseFirst();

    await waitFor(() => received.length >= 2, 2000);
    await waitFor(() => handler.isQueueEmpty() && !(handler as any).isProcessing, 2000);

    const a = received.find((r) => r.chat === chatA);
    const b = received.find((r) => r.chat === chatB);
    expect(a?.sessionId).toBe(chatA);
    expect(b?.sessionId).toBe(chatB);
    expect(a?.sessionId).not.toBe(b?.sessionId);

    handler.stop();
  });

  test("INT 5: 模拟跨 chat 真实流程 - bot 私聊 + worker 任务群聊 互不干扰", async () => {
    // 模拟用户的真实场景:
    // 1. 用户跟 bot 私聊 (oc_bot_chat) 触发任务创建
    // 2. 任务创建独立飞书群聊 (oc_task_chat)
    // 3. 在 oc_task_chat 里继续聊 → 应使用 task chat 自己的 session
    const store = new MemorySessionStore();
    const component = new SessionComponent();
    (component as any).store = store;

    const ocBotChat = "oc_bot_chat";        // 跟 robot 私聊
    const ocTaskChat = "oc_task_chat";      // 任务子群聊

    const receivedSessionIds: { chat: string; sessionId: string | undefined }[] = [];
    const onEventWithEnv = async (fe: FormattedEvent) => {
      const cid = (fe.envEvent.metadata?.replyChannel as { chatId?: string })?.chatId;
      receivedSessionIds.push({ chat: cid ?? "?", sessionId: fe.eventSessionId });
    };

    const handler = new EventHandler({
      env: { subscribeAll: () => () => {} } as any,
      eventTypes: ["event-source.event.*"],
      onEventWithEnv,
      formatter: new EventMessageFormatter(),
      isIdle: () => true,
      sessionComponent: component as any,
    });

    const formatter = new EventMessageFormatter();

    // 批次 1: 跟 bot 私聊 - "委托roy新建一个任务"
    handler.enqueue(formatter.formatWithEvent(createMockEnvEvent("event-source.event.lark-cli", ocBotChat) as any));
    await waitFor(() => receivedSessionIds.length >= 1, 2000);
    await waitFor(() => handler.isQueueEmpty() && !(handler as any).isProcessing, 2000);

    // 批次 2: bot 在任务子群聊里推进任务 - "任务进度更新"
    handler.enqueue(formatter.formatWithEvent(createMockEnvEvent("event-source.event.lark-cli", ocTaskChat) as any));
    await waitFor(() => receivedSessionIds.length >= 2, 2000);
    await waitFor(() => handler.isQueueEmpty() && !(handler as any).isProcessing, 2000);

    // 批次 3: 又回到 bot 私聊 - "任务完成了"
    handler.enqueue(formatter.formatWithEvent(createMockEnvEvent("event-source.event.lark-cli", ocBotChat) as any));
    await waitFor(() => receivedSessionIds.length >= 3, 2000);
    await waitFor(() => handler.isQueueEmpty() && !(handler as any).isProcessing, 2000);

    // 批次 4: 又在任务子群聊里 - "下一步计划"
    handler.enqueue(formatter.formatWithEvent(createMockEnvEvent("event-source.event.lark-cli", ocTaskChat) as any));
    await waitFor(() => receivedSessionIds.length >= 4, 2000);
    await waitFor(() => handler.isQueueEmpty() && !(handler as any).isProcessing, 2000);

    // 验证：bot 私聊用 oc_bot_chat session, 任务子群聊用 oc_task_chat session
    expect(receivedSessionIds[0].chat).toBe(ocBotChat);
    expect(receivedSessionIds[0].sessionId).toBe(ocBotChat);

    expect(receivedSessionIds[1].chat).toBe(ocTaskChat);
    expect(receivedSessionIds[1].sessionId).toBe(ocTaskChat);

    expect(receivedSessionIds[2].chat).toBe(ocBotChat);
    expect(receivedSessionIds[2].sessionId).toBe(ocBotChat); // 回到 bot 私聊 = bot session

    expect(receivedSessionIds[3].chat).toBe(ocTaskChat);
    expect(receivedSessionIds[3].sessionId).toBe(ocTaskChat); // 回到任务子群聊 = task session

    // ★ 核心隔离验证：bot 和 task 的对话内容互不干扰
    expect(receivedSessionIds[0].sessionId).not.toBe(receivedSessionIds[1].sessionId);

    // 验证：DB 里只有 2 条 session (没重复创建)
    const allSessions = await component.list({ limit: 100 });
    expect(allSessions.length).toBe(2);

    // 验证：每条 session 的 metadata 正确
    const botSession = await component.get(ocBotChat);
    const taskSession = await component.get(ocTaskChat);
    expect(botSession?.metadata?.chatId).toBe(ocBotChat);
    expect(taskSession?.metadata?.chatId).toBe(ocTaskChat);
    expect(botSession?.title).toBe(`Lark Chat ${ocBotChat}`);
    expect(taskSession?.title).toBe(`Lark Chat ${ocTaskChat}`);

    handler.stop();
  });
});
