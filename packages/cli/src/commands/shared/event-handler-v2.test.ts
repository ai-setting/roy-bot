/**
 * Task #4042 ESPlugin v2 Phase 4：notify event handler 改造测试
 *
 * 覆盖：
 *   - handleEvent 检测到 task.background.* + metadata.triggerEventId → 反查 EventStore
 *   - 找不到 trigger event → fallback 到原 formatter（向后兼容）
 *   - 找到 handler + 调 buildNotifyHandlePrompt → promptText + systemHint 注入 FormattedEvent
 *   - 找不到 handler（esType 未注册） → fallback 老路径
 *   - 关键 bug fix：chatId 来自 trigger event，不是 lastReplyChannel
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventStoreImpl } from "@ai-setting/roy-bot-core/env/event-source/event-store";
import { EventHandler } from "./event-handler";
import { larkCliHandler } from "@ai-setting/roy-bot-core/env/event-source/event-source-handlers";
import type { EnvEvent } from "@ai-setting/roy-bot-core";

let tmpDir: string;
let dbPath: string;
let store: EventStoreImpl;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "event-handler-v2-test-"));
  dbPath = join(tmpDir, "events.db");
  store = new EventStoreImpl({ dbPath });
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// Mock env / session component（最小可用）
// ============================================================================

function makeMockEnv() {
  return {
    subscribeAll: (_handler: (event: EnvEvent) => void) => {
      return () => {};
    },
    subscribeTo: (_type: string, _handler: (event: EnvEvent) => void) => {
      return () => {};
    },
    pushEnvEvent: () => {},
    getComponent: () => null,
  };
}

function makeNotifyEvent(opts: {
  triggerEventId?: string;
  chatId?: string;
} = {}): EnvEvent {
  return {
    id: "evt_notify_test",
    type: "task.background.completed",
    timestamp: Date.now(),
    metadata: {
      source: "task.background",
      trigger_session_id: "parent_sess_001",
      ...(opts.triggerEventId ? { triggerEventId: opts.triggerEventId } : {}),
      ...(opts.chatId
        ? { replyChannel: { type: "lark-cli", chatId: opts.chatId, messageId: "om_xxx" } }
        : {}),
    },
    payload: {
      backgroundTaskId: "bg_001",
      subSessionId: "sub_001",
      parentSessionId: "parent_sess_001",
      status: "completed",
      result: "调研已完成",
      description: "调研 DeepSeek",
      executionTimeMs: 12000,
    },
  };
}

describe("EventHandler / ESPlugin v2 path (triggerEventId present)", () => {
  test("handles task.background.completed with triggerEventId → looks up EventStore + calls buildNotifyHandlePrompt", async () => {
    // 1. 先准备 trigger event
    const triggerId = await larkCliHandler.emitTriggerEvent(
      {
        senderId: "ou_sender_e",
        text: "请调研 deepseek",
        metadata: {
          eventType: "im.message.receive_v1",
          appId: "cli_app_e",
          chatId: "oc_chat_correct_e",
          chatType: "group",
          messageId: "om_msg_correct_e",
          messageType: "text",
          senderId: "ou_sender_e",
        },
      },
      store,
    );

    // 2. 收集 formatted event
    const captured: any[] = [];
    const env = makeMockEnv();
    const handler = new EventHandler({
      env: env as any,
      eventTypes: ["task.background.*"],
      onEventWithEnv: async (formatted) => {
        captured.push(formatted);
      },
      // ★ Phase 4 关键新参数
      eventStore: store,
      getHandlerForEsType: (esType: string) => (esType === "lark-cli" ? larkCliHandler : undefined),
    });

    // 3. 模拟收到 notify event
    await handler.handleNotifyEventForTest(makeNotifyEvent({ triggerEventId: triggerId, chatId: "oc_chat_WRONG_fallback" }));

    expect(captured.length).toBe(1);
    const formatted = captured[0];
    // 关键：chatId 应该来自 trigger event 的 oc_chat_correct_e
    expect(formatted.chatId).toBe("oc_chat_correct_e");
    // 关键：message 里包含 trigger event 的 chatId + messageId
    expect(formatted.message).toContain("oc_chat_correct_e");
    expect(formatted.message).toContain("om_msg_correct_e");
    // 关键：prompt 含 "不要 fallback" 字样
    expect(formatted.message).toContain("不要 fallback");
  });

  test("triggerEventId present but EventStore miss → fallback to formatter (backward compat)", async () => {
    const captured: any[] = [];
    const env = makeMockEnv();
    const handler = new EventHandler({
      env: env as any,
      eventTypes: ["task.background.*"],
      onEventWithEnv: async (formatted) => {
        captured.push(formatted);
      },
      eventStore: store,
      getHandlerForEsType: (esType: string) => (esType === "lark-cli" ? larkCliHandler : undefined),
    });

    await handler.handleNotifyEventForTest(makeNotifyEvent({ triggerEventId: "evt_does_not_exist", chatId: "oc_fallback_only" }));

    // 走老路径，formatter 应该渲染出 task.description
    expect(captured.length).toBe(1);
    expect(captured[0].message).toContain("调研 DeepSeek");
    // chatId 来自 replyChannel（fallback）
    expect(captured[0].chatId).toBe("oc_fallback_only");
    // 但 message 不应该包含 "不要 fallback" 字样（老路径）
    expect(captured[0].message).not.toContain("不要 fallback");
  });

  test("triggerEventId present but esType handler not registered → fallback", async () => {
    const triggerId = await store.insertTriggerEvent(
      {
        senderId: "ou_x",
        text: "x",
        metadata: { eventType: "x", chatId: "oc_x", messageId: "om_x", senderId: "ou_x" },
      },
      "unknown-es-type", // 未注册的 ES 类型
    );
    const captured: any[] = [];
    const env = makeMockEnv();
    const handler = new EventHandler({
      env: env as any,
      eventTypes: ["task.background.*"],
      onEventWithEnv: async (formatted) => {
        captured.push(formatted);
      },
      eventStore: store,
      getHandlerForEsType: (esType: string) => (esType === "lark-cli" ? larkCliHandler : undefined),
    });

    await handler.handleNotifyEventForTest(makeNotifyEvent({ triggerEventId: triggerId }));

    // 老路径
    expect(captured.length).toBe(1);
    expect(captured[0].message).toContain("调研 DeepSeek");
  });

  test("no triggerEventId in metadata → pure fallback (老路径)", async () => {
    const captured: any[] = [];
    const env = makeMockEnv();
    const handler = new EventHandler({
      env: env as any,
      eventTypes: ["task.background.*"],
      onEventWithEnv: async (formatted) => {
        captured.push(formatted);
      },
      // 注意：不传 eventStore / getHandlerForEsType
    });

    await handler.handleNotifyEventForTest(makeNotifyEvent({ chatId: "oc_legacy" }));

    expect(captured.length).toBe(1);
    expect(captured[0].chatId).toBe("oc_legacy");
    expect(captured[0].message).toContain("调研 DeepSeek");
    expect(captured[0].message).not.toContain("不要 fallback");
  });

  test("non-task.background.* event → pure formatter (no ESPlugin path)", async () => {
    const captured: any[] = [];
    const env = makeMockEnv();
    const handler = new EventHandler({
      env: env as any,
      eventTypes: ["*"],
      onEventWithEnv: async (formatted) => {
        captured.push(formatted);
      },
      eventStore: store,
      getHandlerForEsType: (esType: string) => larkCliHandler,
    });

    await handler.handleNotifyEventForTest({
      id: "evt_x",
      type: "session.created",
      timestamp: Date.now(),
      metadata: { source: "session" },
      payload: {},
    } as EnvEvent);

    expect(captured.length).toBe(1);
    expect(captured[0].message).toBeDefined();
  });
});

// ============================================================================
// Task #4042 ESPlugin v2 Phase 7 — postProcessNotifyEvent 后处理钩子
// ============================================================================

/**
 * 创建一个 mock handler，记录 postProcessNotifyEvent 调用次数 / 输入。
 * 关键：默认 buildNotifyHandlePrompt 拿真实 larkCliHandler 的实现。
 */
function makeMockHandler(opts: {
  postProcessNotifyEvent?: (...args: any[]) => Promise<void>;
} = {}) {
  const calls: { method: string; args: any[] }[] = [];
  return {
    calls,
    type: "lark-cli",
    validateConfig: () => [],
    createInstance: () => ({}),
    emitTriggerEvent: larkCliHandler.emitTriggerEvent!.bind(larkCliHandler),
    replyMessage: larkCliHandler.replyMessage!.bind(larkCliHandler),
    extractReplyContext: larkCliHandler.extractReplyContext!.bind(larkCliHandler),
    buildNotifyHandlePrompt: larkCliHandler.buildNotifyHandlePrompt!.bind(larkCliHandler),
    postProcessNotifyEvent: async (...args: any[]) => {
      calls.push({ method: "postProcessNotifyEvent", args });
      if (opts.postProcessNotifyEvent) {
        return opts.postProcessNotifyEvent(...args);
      }
    },
  } as any;
}

describe("EventHandler / Phase 7 postProcessNotifyEvent integration", () => {
  test("invokes handler.postProcessNotifyEvent after buildNotifyHandlePrompt with formattedPrompt", async () => {
    // 1. 准备 trigger event
    const triggerId = await larkCliHandler.emitTriggerEvent(
      {
        senderId: "ou_sender_p7",
        text: "请调研",
        metadata: {
          eventType: "im.message.receive_v1",
          appId: "cli_app_p7",
          chatId: "oc_chat_p7",
          chatType: "group",
          messageId: "om_msg_p7",
          messageType: "text",
          senderId: "ou_sender_p7",
        },
      },
      store,
    );

    // 2. mock handler
    const mockHandler = makeMockHandler();

    // 3. 跑 EventHandler
    const captured: any[] = [];
    const env = makeMockEnv();
    const handler = new EventHandler({
      env: env as any,
      eventTypes: ["task.background.*"],
      onEventWithEnv: async (formatted) => {
        captured.push(formatted);
      },
      eventStore: store,
      getHandlerForEsType: () => mockHandler,
    });

    // ★ 关键：payload.associatedTaskId 必须有值，否则 notifyEvent.taskId=undefined
    await handler.handleNotifyEventForTest({
      ...makeNotifyEvent({ triggerEventId: triggerId }),
      payload: {
        backgroundTaskId: "bg_p7_001",
        subSessionId: "sub_p7_001",
        parentSessionId: "parent_p7_001",
        status: "completed",
        result: "调研已完成",
        description: "调研 DeepSeek",
        associatedTaskId: 4042,
      },
    });

    // ★ 等 setTimeout(0) 的 hook 跑完
    await new Promise((resolve) => setTimeout(resolve, 10));

    // 4. 断言 postProcessNotifyEvent 被调 1 次
    const ppCalls = mockHandler.calls.filter((c) => c.method === "postProcessNotifyEvent");
    expect(ppCalls.length).toBe(1);
    const ppInput = ppCalls[0].args[0];
    expect(ppInput.notifyEvent.taskId).toBe(4042);
    expect(ppInput.triggerEvent.eventId).toBe(triggerId);
    expect(ppInput.formattedPrompt).toContain("Notify Event"); // buildNotifyHandlePrompt 真实输出
  });

  test("does NOT invoke postProcessNotifyEvent when handler doesn't implement it", async () => {
    // mock handler 没 postProcessNotifyEvent
    const mockHandler = {
      type: "lark-cli",
      validateConfig: () => [],
      createInstance: () => ({}),
      emitTriggerEvent: larkCliHandler.emitTriggerEvent!.bind(larkCliHandler),
      replyMessage: larkCliHandler.replyMessage!.bind(larkCliHandler),
      extractReplyContext: larkCliHandler.extractReplyContext!.bind(larkCliHandler),
      buildNotifyHandlePrompt: larkCliHandler.buildNotifyHandlePrompt!.bind(larkCliHandler),
      // 故意不定义 postProcessNotifyEvent
    } as any;

    const triggerId = await larkCliHandler.emitTriggerEvent(
      {
        senderId: "ou_sender_p7b",
        text: "请调研",
        metadata: {
          eventType: "im.message.receive_v1",
          appId: "cli_app_p7b",
          chatId: "oc_chat_p7b",
          chatType: "group",
          messageId: "om_msg_p7b",
          messageType: "text",
          senderId: "ou_sender_p7b",
        },
      },
      store,
    );

    const captured: any[] = [];
    const handler = new EventHandler({
      env: makeMockEnv() as any,
      eventTypes: ["task.background.*"],
      onEventWithEnv: async (f) => {
        captured.push(f);
      },
      eventStore: store,
      getHandlerForEsType: () => mockHandler,
    });

    // 不抛异常，老路径正常
    await handler.handleNotifyEventForTest(makeNotifyEvent({ triggerEventId: triggerId }));
    // 等一下，确认 hook 真的没被调
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(captured.length).toBe(1);
  });

  test("postProcessNotifyEvent failure does NOT block main agent processing (fire-and-forget)", async () => {
    const triggerId = await larkCliHandler.emitTriggerEvent(
      {
        senderId: "ou_sender_p7c",
        text: "请调研",
        metadata: {
          eventType: "im.message.receive_v1",
          appId: "cli_app_p7c",
          chatId: "oc_chat_p7c",
          chatType: "group",
          messageId: "om_msg_p7c",
          messageType: "text",
          senderId: "ou_sender_p7c",
        },
      },
      store,
    );

    // mock handler postProcessNotifyEvent 抛异常
    const mockHandler = makeMockHandler({
      postProcessNotifyEvent: async () => {
        throw new Error("lark-cli totally down");
      },
    });

    const captured: any[] = [];
    const handler = new EventHandler({
      env: makeMockEnv() as any,
      eventTypes: ["task.background.*"],
      onEventWithEnv: async (f) => {
        captured.push(f);
      },
      eventStore: store,
      getHandlerForEsType: () => mockHandler,
    });

    // 必须 resolve（不抛）
    await expect(
      handler.handleNotifyEventForTest(makeNotifyEvent({ triggerEventId: triggerId })),
    ).resolves.toBeUndefined();
    // 等 hook 跑完（会吞掉异常）
    await new Promise((resolve) => setTimeout(resolve, 10));
    // 主 agent 仍然收到 formatted event
    expect(captured.length).toBe(1);
    expect(captured[0].message).toContain("Notify Event");
  });

  test("does NOT invoke postProcessNotifyEvent for non-task.background events", async () => {
    const mockHandler = makeMockHandler();

    const handler = new EventHandler({
      env: makeMockEnv() as any,
      eventTypes: ["*"],
      onEventWithEnv: async () => {},
      eventStore: store,
      getHandlerForEsType: () => mockHandler,
    });

    await handler.handleNotifyEventForTest({
      id: "evt_x",
      type: "session.created",
      timestamp: Date.now(),
      metadata: { source: "session" },
      payload: {},
    } as EnvEvent);

    // 等一下确认 hook 没被调
    await new Promise((resolve) => setTimeout(resolve, 10));
    const ppCalls = mockHandler.calls.filter((c) => c.method === "postProcessNotifyEvent");
    expect(ppCalls.length).toBe(0);
  });

  // ==========================================================================
  // ★ Bug #4035/#4038/#4039 修复：resolvedChatIds 来自权威 task↔chat 绑定
  // ==========================================================================

  /** env whose task component returns a scripted getTask */
  function makeEnvWithTask(
    getTask: (id: number) => Promise<
      { context?: string; parent_task_id?: number | null } | undefined
    >,
  ) {
    const env = makeMockEnv();
    (env as any).getComponent = (name: string) =>
      name === "task" ? { getTask } : null;
    return env;
  }

  async function emitTrigger(chatId: string) {
    return larkCliHandler.emitTriggerEvent(
      {
        senderId: "ou_sender_exact",
        text: "请调研",
        metadata: {
          eventType: "im.message.receive_v1",
          appId: "cli_app_exact",
          chatId,
          chatType: "group",
          messageId: "om_msg_exact",
          messageType: "text",
          senderId: "ou_sender_exact",
        },
      },
      store,
    );
  }

  function notifyEventWithTask(triggerEventId: string, associatedTaskId: number) {
    return {
      ...makeNotifyEvent({ triggerEventId }),
      payload: {
        backgroundTaskId: "bg_exact",
        subSessionId: "sub_exact",
        parentSessionId: "parent_exact",
        status: "completed",
        result: "已完成",
        description: "调研 DeepSeek",
        associatedTaskId,
      },
    } as EnvEvent;
  }

  /** 等 fire-and-forget 的 postProcessNotifyEvent hook 跑完（含 setTimeout 内解析）。 */
  async function waitForPpCalls(mockHandler: any, n = 1): Promise<any[]> {
    const deadline = Date.now() + 1500;
    const read = () =>
      mockHandler.calls.filter((c: any) => c.method === "postProcessNotifyEvent");
    while (Date.now() < deadline) {
      if (read().length >= n) return read();
      await new Promise((r) => setTimeout(r, 5));
    }
    return read();
  }

  function makeHandlerWithEnv(env: any, mockHandler: any) {
    return new EventHandler({
      env: env as any,
      eventTypes: ["task.background.*"],
      onEventWithEnv: async () => {},
      eventStore: store,
      getHandlerForEsType: () => mockHandler,
    });
  }

  test("resolves resolvedChatIds from task.context.larkPerTaskChatId (NOT trigger chat)", async () => {
    const triggerId = await emitTrigger("oc_trigger_chat");
    const mockHandler = makeMockHandler();
    const env = makeEnvWithTask(async (id) =>
      id === 4042
        ? {
            context: JSON.stringify({ larkPerTaskChatId: "oc_task_group_4035" }),
            parent_task_id: null,
          }
        : undefined,
    );
    const handler = makeHandlerWithEnv(env, mockHandler);

    await handler.handleNotifyEventForTest(notifyEventWithTask(triggerId, 4042));
    const ppCalls = await waitForPpCalls(mockHandler);

    expect(ppCalls.length).toBe(1);
    // 精确投递到 task 群，而不是 trigger chat（oc_trigger_chat）
    expect(ppCalls[0].args[0].resolvedChatIds).toEqual(["oc_task_group_4035"]);
  });

  test("walks up parent_task_id to find the per-task group (sub-task has no own group)", async () => {
    const triggerId = await emitTrigger("oc_trigger_chat");
    const mockHandler = makeMockHandler();
    const env = makeEnvWithTask(async (id) => {
      if (id === 5000) return { context: "{}", parent_task_id: 4000 };
      if (id === 4000)
        return {
          context: JSON.stringify({ larkPerTaskChatId: "oc_parent_group" }),
          parent_task_id: null,
        };
      return undefined;
    });
    const handler = makeHandlerWithEnv(env, mockHandler);

    await handler.handleNotifyEventForTest(notifyEventWithTask(triggerId, 5000));
    const ppCalls = await waitForPpCalls(mockHandler);

    expect(ppCalls[0].args[0].resolvedChatIds).toEqual(["oc_parent_group"]);
  });

  test("resolvedChatIds=[] when task has no binding (no fuzzy fallback in production path)", async () => {
    const triggerId = await emitTrigger("oc_trigger_chat");
    const mockHandler = makeMockHandler();
    const env = makeEnvWithTask(async () => ({ context: "{}", parent_task_id: null }));
    const handler = makeHandlerWithEnv(env, mockHandler);

    await handler.handleNotifyEventForTest(notifyEventWithTask(triggerId, 4042));
    const ppCalls = await waitForPpCalls(mockHandler);

    expect(ppCalls[0].args[0].resolvedChatIds).toEqual([]);
  });

  test("resolvedChatIds=[] when no task component available", async () => {
    const triggerId = await emitTrigger("oc_trigger_chat");
    const mockHandler = makeMockHandler();
    // makeMockEnv().getComponent → null
    const handler = makeHandlerWithEnv(makeMockEnv(), mockHandler);

    await handler.handleNotifyEventForTest(notifyEventWithTask(triggerId, 4042));
    const ppCalls = await waitForPpCalls(mockHandler);

    expect(ppCalls[0].args[0].resolvedChatIds).toEqual([]);
  });

  // ---- 边界回归（review 补充）----

  test("cycle in parent_task_id → seen guard prevents infinite loop, returns []", async () => {
    const triggerId = await emitTrigger("oc_trigger_chat");
    const mockHandler = makeMockHandler();
    const env = makeEnvWithTask(async (id) => {
      if (id === 7001) return { context: "{}", parent_task_id: 7002 };
      if (id === 7002) return { context: "{}", parent_task_id: 7001 };
      return undefined;
    });
    const handler = makeHandlerWithEnv(env, mockHandler);

    await handler.handleNotifyEventForTest(notifyEventWithTask(triggerId, 7001));
    const ppCalls = await waitForPpCalls(mockHandler);

    expect(ppCalls[0].args[0].resolvedChatIds).toEqual([]);
  });

  test("depth > 8 → bounded walk stops, returns [] (no infinite loop)", async () => {
    const triggerId = await emitTrigger("oc_trigger_chat");
    const mockHandler = makeMockHandler();
    // 8001 → 8002 → ... → 8010，仅最深（8010）有绑定，超过 8 层 → 解析不到
    const env = makeEnvWithTask(async (id) => {
      if (id >= 8001 && id <= 8009) return { context: "{}", parent_task_id: id + 1 };
      if (id === 8010)
        return {
          context: JSON.stringify({ larkPerTaskChatId: "oc_too_deep" }),
          parent_task_id: null,
        };
      return undefined;
    });
    const handler = makeHandlerWithEnv(env, mockHandler);

    await handler.handleNotifyEventForTest(notifyEventWithTask(triggerId, 8001));
    const ppCalls = await waitForPpCalls(mockHandler);

    expect(ppCalls[0].args[0].resolvedChatIds).toEqual([]);
  });

  test("getTask throws → graceful, returns [] (does not propagate)", async () => {
    const triggerId = await emitTrigger("oc_trigger_chat");
    const mockHandler = makeMockHandler();
    const env = makeEnvWithTask(async () => {
      throw new Error("db down");
    });
    const handler = makeHandlerWithEnv(env, mockHandler);

    await handler.handleNotifyEventForTest(notifyEventWithTask(triggerId, 4042));
    const ppCalls = await waitForPpCalls(mockHandler);

    expect(ppCalls[0].args[0].resolvedChatIds).toEqual([]);
  });

  test("invalid context JSON / non-string larkPerTaskChatId → returns []", async () => {
    const triggerId = await emitTrigger("oc_trigger_chat");
    const mockHandler = makeMockHandler();
    const env = makeEnvWithTask(async () => ({
      context: "{ not valid json",
      parent_task_id: null,
    }));
    const handler = makeHandlerWithEnv(env, mockHandler);

    await handler.handleNotifyEventForTest(notifyEventWithTask(triggerId, 4042));
    const ppCalls = await waitForPpCalls(mockHandler);

    expect(ppCalls[0].args[0].resolvedChatIds).toEqual([]);
  });

  test("non-string larkPerTaskChatId (number) → ignored, returns []", async () => {
    const triggerId = await emitTrigger("oc_trigger_chat");
    const mockHandler = makeMockHandler();
    const env = makeEnvWithTask(async () => ({
      context: JSON.stringify({ larkPerTaskChatId: 12345 }),
      parent_task_id: null,
    }));
    const handler = makeHandlerWithEnv(env, mockHandler);

    await handler.handleNotifyEventForTest(notifyEventWithTask(triggerId, 4042));
    const ppCalls = await waitForPpCalls(mockHandler);

    expect(ppCalls[0].args[0].resolvedChatIds).toEqual([]);
  });

  test("parent_task_id=0 is treated as root (no infinite spin), returns []", async () => {
    const triggerId = await emitTrigger("oc_trigger_chat");
    const mockHandler = makeMockHandler();
    const env = makeEnvWithTask(async () => ({
      context: "{}",
      parent_task_id: 0,
    }));
    const handler = makeHandlerWithEnv(env, mockHandler);

    await handler.handleNotifyEventForTest(notifyEventWithTask(triggerId, 4042));
    const ppCalls = await waitForPpCalls(mockHandler);

    expect(ppCalls[0].args[0].resolvedChatIds).toEqual([]);
  });
});

// ============================================================================
// Bug A (#4105) — 假"完成了"通知修复：
//   只有终态 task.background.* 事件才走 v2 notify 路径；
//   started / progress 中间态回落老 formatter（"已启动"/"还在进行中"）。
// ============================================================================

describe("EventHandler / Bug A: only terminal task.background.* use v2 notify path", () => {
  function makeTypedNotify(type: string, triggerEventId?: string): EnvEvent {
    return {
      id: `evt_${type}`,
      type,
      timestamp: Date.now(),
      metadata: {
        source: "task.background",
        trigger_session_id: "parent_sess_A",
        ...(triggerEventId ? { triggerEventId } : {}),
      },
      payload: {
        backgroundTaskId: "bg_A",
        subSessionId: "sub_A",
        parentSessionId: "parent_sess_A",
        status: type === "task.background.completed" ? "completed" : "running",
        result: type === "task.background.completed" ? "调研已完成" : undefined,
        description: "调研 DeepSeek",
        subagentType: "general",
      },
    } as EnvEvent;
  }

  async function emitTriggerA() {
    return larkCliHandler.emitTriggerEvent(
      {
        senderId: "ou_sender_A",
        text: "请调研",
        metadata: {
          eventType: "im.message.receive_v1",
          chatId: "oc_chat_A",
          chatType: "group",
          messageId: "om_msg_A",
          messageType: "text",
          senderId: "ou_sender_A",
        },
      },
      store,
    );
  }

  function makeHandlerA(captured: any[]) {
    return new EventHandler({
      env: makeMockEnv() as any,
      eventTypes: ["task.background.*"],
      onEventWithEnv: async (f) => {
        captured.push(f);
      },
      eventStore: store,
      getHandlerForEsType: (esType: string) =>
        esType === "lark-cli" ? larkCliHandler : undefined,
    });
  }

  test("started + triggerEventId → 老 formatter『已启动』，不渲染『完成了』", async () => {
    const triggerId = await emitTriggerA();
    const captured: any[] = [];
    await makeHandlerA(captured).handleNotifyEventForTest(
      makeTypedNotify("task.background.started", triggerId),
    );
    expect(captured.length).toBe(1);
    expect(captured[0].message).toContain("已启动");
    expect(captured[0].message).not.toContain("Sub-agent 完成了");
    expect(captured[0].message).not.toContain("不要 fallback");
  });

  test("progress + triggerEventId → 老 formatter『还在进行中』，不渲染『完成了』", async () => {
    const triggerId = await emitTriggerA();
    const captured: any[] = [];
    await makeHandlerA(captured).handleNotifyEventForTest(
      makeTypedNotify("task.background.progress", triggerId),
    );
    expect(captured.length).toBe(1);
    expect(captured[0].message).toContain("还在进行中");
    expect(captured[0].message).not.toContain("Sub-agent 完成了");
    expect(captured[0].message).not.toContain("不要 fallback");
  });

  test("completed + triggerEventId → 仍走 v2（含『完成了』+ chatId 指引）", async () => {
    const triggerId = await emitTriggerA();
    const captured: any[] = [];
    await makeHandlerA(captured).handleNotifyEventForTest(
      makeTypedNotify("task.background.completed", triggerId),
    );
    expect(captured.length).toBe(1);
    expect(captured[0].message).toContain("完成了");
    expect(captured[0].message).toContain("不要 fallback");
    expect(captured[0].chatId).toBe("oc_chat_A");
  });

  test("ask_user + triggerEventId → 老 formatter（保留 query），不渲染『完成了』", async () => {
    const triggerId = await emitTriggerA();
    const captured: any[] = [];
    const ev = makeTypedNotify("task.background.ask_user", triggerId);
    (ev.payload as any).query = "要选 A 还是 B？";
    (ev.payload as any).hints = ["请用 ask_user 工具展示问题"];
    await makeHandlerA(captured).handleNotifyEventForTest(ev);
    expect(captured.length).toBe(1);
    expect(captured[0].message).toContain("请求用户输入");
    expect(captured[0].message).toContain("要选 A 还是 B？");
    expect(captured[0].message).not.toContain("Sub-agent 完成了");
  });
});