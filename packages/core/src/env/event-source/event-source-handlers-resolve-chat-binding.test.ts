/**
 * @fileoverview LarkCliInstance.resolveChatTaskBinding 独立方法测试
 *
 * Task #4023 + #4025 OC track 推荐 #3/#6 改进：将 resolveChatTaskBinding
 * 提取为独立私有方法（语义更清晰）+ 用 duck-typing 替代 SessionComponent 类型断言。
 *
 * 改进点：
 * - duck-typing: getChatTaskBinding / upsertChatTaskBinding 仅作为 optional 检查
 * - 返回完整 binding 让 caller 决定用哪个字段（B 设计）vs A 当前只返回 taskId
 * - 错误捕获 / 优雅降级：event dispatch 不被 binding 查询失败阻塞
 *
 * 注意：A 已经把 resolveChatTaskBinding 提取为独立方法。这里测试**进一步强化**
 * 推荐 RED 案例（缺 binding、status !== ready 等）。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { LarkCliInstance } from "./event-source-handlers";
import type { EventSourceConfig } from "./types";
import type { EventSourceEvent, EventSourceEventHandler } from "./types";

describe("Task #4023+#4025 OC #3 — resolveChatTaskBinding 独立方法强化覆盖", () => {
  let originalEnv: Record<string, string | undefined>;
  beforeEach(() => {
    originalEnv = {
      ROY_TASK_NOTIFY_DEBUG: process.env.ROY_TASK_NOTIFY_DEBUG,
    };
  });
  afterEach(() => {
    process.env.ROY_TASK_NOTIFY_DEBUG = originalEnv.ROY_TASK_NOTIFY_DEBUG;
  });

  function makeConfig(): EventSourceConfig {
    return {
      id: "es_resolve_test",
      name: "resolve test",
      type: "lark-cli",
      enabled: true,
      command: "lark-cli --profile default event consume im.message.receive_v1 --as bot",
    };
  }

  function makeRawData(chatId: string, eventId: string): string {
    return JSON.stringify({
      type: "im.message.receive_v1",
      event_id: eventId,
      timestamp: "1790579077976",
      id: `om_msg_${eventId}`,
      message_id: `om_msg_${eventId}`,
      chat_id: chatId,
      chat_type: "group",
      message_type: "text",
      sender_id: { open_id: "ou_user_X" },
      sender_type: "user",
      content: "测试任务",
    });
  }

  it("binding.status === 'ready' 且 taskId 是数字：注入成功", async () => {
    const session = {
      getChatTaskBinding: async (_chatId: string) => ({
        chatId: _chatId,
        taskId: 12345,
        profile: "default",
        boundAt: "2026-10-09T00:00:00Z",
        status: "ready" as const,
        errorMessage: null,
        rebindCount: 0,
      }),
    };
    const config = makeConfig();
    const instance = new LarkCliInstance(config);
    instance.setEnvironment({
      getComponent: (name: string) => (name === "session" ? session : null),
    });

    const events: EventSourceEvent[] = [];
    const handler: EventSourceEventHandler = (evt: EventSourceEvent) => {
      events.push(evt);
    };
    instance.onEvent(handler);

    await (instance as any).handleEvent(
      makeRawData("oc_chat_ready", "evt_ready_001")
    );

    expect(events).toHaveLength(1);
    expect(events[0].metadata.parentTaskId).toBe(12345);
    expect(events[0].payload.parentTaskId).toBe(12345);
  });

  it("binding.status === 'creating'（尚未 ready）：不注入 parentTaskId", async () => {
    const session = {
      getChatTaskBinding: async (_chatId: string) => ({
        chatId: _chatId,
        taskId: 999,
        profile: "default",
        boundAt: "2026-10-09T00:00:00Z",
        status: "creating" as const,
        errorMessage: null,
        rebindCount: 0,
      }),
    };
    const config = makeConfig();
    const instance = new LarkCliInstance(config);
    instance.setEnvironment({
      getComponent: (name: string) => (name === "session" ? session : null),
    });

    const events: EventSourceEvent[] = [];
    const handler: EventSourceEventHandler = (evt: EventSourceEvent) => {
      events.push(evt);
    };
    instance.onEvent(handler);

    await (instance as any).handleEvent(
      makeRawData("oc_chat_creating", "evt_creating_002")
    );

    expect(events).toHaveLength(1);
    expect(events[0].metadata.parentTaskId).toBeUndefined();
    expect(events[0].payload.parentTaskId).toBeUndefined();
  });

  it("binding.status === 'failed'：不注入 parentTaskId", async () => {
    const session = {
      getChatTaskBinding: async (_chatId: string) => ({
        chatId: _chatId,
        taskId: 888,
        profile: "default",
        boundAt: "2026-10-09T00:00:00Z",
        status: "failed" as const,
        errorMessage: "建群失败",
        rebindCount: 0,
      }),
    };
    const config = makeConfig();
    const instance = new LarkCliInstance(config);
    instance.setEnvironment({
      getComponent: (name: string) => (name === "session" ? session : null),
    });

    const events: EventSourceEvent[] = [];
    const handler: EventSourceEventHandler = (evt: EventSourceEvent) => {
      events.push(evt);
    };
    instance.onEvent(handler);

    await (instance as any).handleEvent(
      makeRawData("oc_chat_failed", "evt_failed_003")
    );

    expect(events).toHaveLength(1);
    expect(events[0].metadata.parentTaskId).toBeUndefined();
  });

  it("getChatTaskBinding 抛错：graceful 不阻塞 event dispatch", async () => {
    const session = {
      getChatTaskBinding: async (_chatId: string) => {
        throw new Error("database connection lost");
      },
    };
    const config = makeConfig();
    const instance = new LarkCliInstance(config);
    instance.setEnvironment({
      getComponent: (name: string) => (name === "session" ? session : null),
    });

    const events: EventSourceEvent[] = [];
    const handler: EventSourceEventHandler = (evt: EventSourceEvent) => {
      events.push(evt);
    };
    instance.onEvent(handler);

    // 期望：不会抛错（resolveChatTaskBinding 内部 try/catch）
    await expect(
      (instance as any).handleEvent(makeRawData("oc_chat_err", "evt_err_004"))
    ).resolves.toBeUndefined();

    expect(events).toHaveLength(1);
    expect(events[0].metadata.parentTaskId).toBeUndefined();
  });

  it("sessionComponent 缺 getChatTaskBinding 方法：graceful 返回 null", async () => {
    // 空 session component — 模拟 duck-typing 失败
    const session = {} as any;
    const config = makeConfig();
    const instance = new LarkCliInstance(config);
    instance.setEnvironment({
      getComponent: (name: string) => (name === "session" ? session : null),
    });

    const events: EventSourceEvent[] = [];
    const handler: EventSourceEventHandler = (evt: EventSourceEvent) => {
      events.push(evt);
    };
    instance.onEvent(handler);

    await expect(
      (instance as any).handleEvent(makeRawData("oc_chat_no_method", "evt_nomethod_005"))
    ).resolves.toBeUndefined();

    expect(events).toHaveLength(1);
    expect(events[0].metadata.parentTaskId).toBeUndefined();
  });

  it("binding.taskId 不是数字（如字符串）：不注入", async () => {
    const session = {
      getChatTaskBinding: async (_chatId: string) => ({
        chatId: _chatId,
        taskId: "not-a-number" as any,
        profile: "default",
        boundAt: "2026-10-09T00:00:00Z",
        status: "ready" as const,
        errorMessage: null,
        rebindCount: 0,
      }),
    };
    const config = makeConfig();
    const instance = new LarkCliInstance(config);
    instance.setEnvironment({
      getComponent: (name: string) => (name === "session" ? session : null),
    });

    const events: EventSourceEvent[] = [];
    const handler: EventSourceEventHandler = (evt: EventSourceEvent) => {
      events.push(evt);
    };
    instance.onEvent(handler);

    await (instance as any).handleEvent(
      makeRawData("oc_chat_bad_taskid", "evt_bad_006")
    );

    expect(events).toHaveLength(1);
    expect(events[0].metadata.parentTaskId).toBeUndefined();
  });
});